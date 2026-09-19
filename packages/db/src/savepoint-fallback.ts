// runWithSavepointFallback — corrector prioritario (auditoría a1, hallazgos CRITICO
// "citas pierde reservas en silencio" y ALTO "invitar/administrar staff sigue roto
// contra la base sin migrar"). CAUSA RAÍZ COMÚN que ambos hallazgos comparten: el
// patrón ya establecido en este repo ("capturar un SQLSTATE de función/tabla/columna
// inexistente y caer al camino anterior a la migración pendiente", ver PR #149 —
// `postgres-core-repository.ts::isUndefinedFunctionError`) NO alcanza dentro de la
// transacción única de un request (`ManagedPostgresEngine.withAppSession`,
// `managed-postgres-engine.ts` ~137-153 — un solo `begin ... commit`, `rollback` solo
// en el `catch` de TODO el callback) ni dentro de un lote (`syncPendingAppointments
// MultiProvider`, `calendar-sync.ts`).
//
// Postgres real dentro de un bloque de transacción: CUALQUIER error dentro de ese
// bloque lo deja "abortado" — la SIGUIENTE consulta (el propio fallback) falla con
// SQLSTATE 25P02 ("current transaction is aborted, commands ignored until end of
// transaction block"), y un `COMMIT` sobre una transacción abortada NO lanza error:
// Postgres lo trata como un ROLLBACK implícito y devuelve el tag de comando
// `ROLLBACK` en vez de `COMMIT` — así que el handler HTTP responde 201/200 con TODO
// lo escrito en el request revertido en silencio. Un `try/catch` simple alrededor del
// SQLSTATE NUNCA alcanza para recuperarse dentro de esa misma transacción: hace falta
// `SAVEPOINT` antes del intento primario y `ROLLBACK TO SAVEPOINT` (que SÍ está
// exento del bloqueo de "transacción abortada") antes de intentar el camino de
// respaldo. Mismo patrón ya usado a mano en
// `domain-citas/src/postgres-repository.ts::upsertCustomer` (`sp_upsert_customer_
// race`) y en `domain-restaurantes` — este helper es la versión reutilizable, para no
// repetir a mano el SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE en cada sitio nuevo.
//
// Uso — DOS formas:
//   1. Fallback real por código SQLSTATE específico (ej. 23514/42883): `isRecoverable`
//      solo devuelve `true` para esos códigos; `fallback` corre la consulta
//      alternativa (a la base SIN migrar). Cualquier otro error se repropaga tal
//      cual — este helper nunca enmascara un fallo real, igual que el patrón que ya
//      documenta `postgres-core-repository.ts`.
//   2. Aislamiento de una operación dentro de un lote (una fila "venenosa" no debe
//      revertir las filas ya procesadas de la MISMA transacción): `isRecoverable`
//      devuelve `true` siempre y `fallback` vuelve a lanzar el mismo error DESPUÉS
//      de que el `ROLLBACK TO SAVEPOINT` ya dejó la sesión utilizable para la
//      siguiente fila — ver `calendar-sync.ts::syncPendingAppointmentsMultiProvider`.
import type { TenantDbSession } from "@atiende/core-tenancy";

let savepointCounter = 0;

/** Nombre único por llamada -- evita colisión si el mismo helper se usa dos veces
 *  anidado (nunca debería, pero un nombre fijo compartido sería frágil) dentro de la
 *  MISMA transacción/request. Los nombres de SAVEPOINT de Postgres son identificadores
 *  SQL normales -- deben empezar con letra/guión bajo, nunca con un dígito. */
function uniqueSavepointName(): string {
  savepointCounter += 1;
  return `sp_fallback_${Date.now().toString(36)}_${savepointCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

function pgErrorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code as string | undefined : undefined;
}

/** SQLSTATE 25P01 -- "no hay transacción activa" -- es lo que Postgres real lanza si
 *  se intenta `SAVEPOINT` FUERA de un bloque de transacción (ej. una sesión que
 *  ejecuta cada consulta en su propio auto-commit implícito, como `ManagedPostgresEngine
 *  .admin`, ver managed-postgres-engine.ts). Nunca debería pasar en los dos sitios que
 *  usan este helper hoy (ambos corren siempre dentro de `withAppSession`, ver
 *  `core-auth/src/middleware.ts::dbSession`), pero el contrato de `TenantDbSession` no
 *  lo garantiza a nivel de tipos -- se maneja explícito en vez de asumirlo.
 */
function isNoActiveTransactionError(err: unknown): boolean {
  return pgErrorCode(err) === "25P01";
}

export interface SavepointFallbackOptions<T> {
  /** La sesión real (dentro de la transacción del request/lote actual). */
  readonly session: TenantDbSession;
  /** Camino primario -- el que asume que la migración ya se aplicó (o la operación
   *  normal cuyo error no debe tumbar el resto del lote). */
  readonly primary: () => Promise<T>;
  /** `true` si este error debe degradar al `fallback` (ej. `err.code === "23514"`).
   *  `false` (o cualquier código no reconocido) se repropaga tal cual DESPUÉS de dejar
   *  la sesión utilizable de nuevo -- nunca enmascara un fallo real. */
  readonly isRecoverable: (err: unknown) => boolean;
  /** Camino de respaldo -- corre con la sesión YA recuperada (`ROLLBACK TO SAVEPOINT`
   *  ya ejecutado). Puede simplemente re-lanzar `err` (caso "aislar una fila
   *  venenosa del lote", ver cabecera de archivo) o ejecutar una consulta alternativa
   *  real (caso "degradar a la base sin migrar"). */
  readonly fallback: (err: unknown) => Promise<T>;
  /** Override del nombre del SAVEPOINT -- casi nunca hace falta (el default ya es
   *  único por llamada); existe para que un caller con varios SAVEPOINT en la misma
   *  operación pueda darles nombres legibles en logs/tests. */
  readonly savepointName?: string;
}

/**
 * Corre `primary` protegido por un `SAVEPOINT`. Si lanza un error que `isRecoverable`
 * acepta, hace `ROLLBACK TO SAVEPOINT` + `RELEASE SAVEPOINT` (deja la sesión/
 * transacción utilizable de nuevo, a diferencia de un `try/catch` sin SAVEPOINT, que
 * deja la transacción "abortada" -- SQLSTATE 25P02 en cualquier consulta posterior) y
 * corre `fallback`. Cualquier otro error se repropaga tal cual, también DESPUÉS de
 * recuperar la sesión con el mismo `ROLLBACK TO SAVEPOINT` -- para que un `catch`
 * exterior que siga usando la MISMA sesión (ej. el loop de un lote) no la encuentre
 * abortada.
 *
 * Sin transacción abierta (`SAVEPOINT` lanza 25P01, ver `isNoActiveTransactionError`):
 * no hay nada que proteger ni que revertir (cada consulta ya es su propio auto-commit)
 * -- corre `primary`/`fallback` directo, sin ningún `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`.
 */
export async function runWithSavepointFallback<T>(opts: SavepointFallbackOptions<T>): Promise<T> {
  const { session, primary, isRecoverable, fallback } = opts;
  const savepointName = opts.savepointName ?? uniqueSavepointName();

  let savepointActive = true;
  try {
    await session.exec(`SAVEPOINT ${savepointName}`);
  } catch (savepointErr) {
    if (!isNoActiveTransactionError(savepointErr)) throw savepointErr;
    savepointActive = false;
  }

  try {
    const result = await primary();
    if (savepointActive) await session.exec(`RELEASE SAVEPOINT ${savepointName}`);
    return result;
  } catch (err) {
    if (savepointActive) {
      await session.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await session.exec(`RELEASE SAVEPOINT ${savepointName}`);
    }
    if (!isRecoverable(err)) throw err;
    return fallback(err);
  }
}
