// r4-fix-crons-transaccion-por-unidad -- soporte de pruebas COMPARTIDO por los 3
// specs que reproducen el hallazgo de auditoría a1b #1 (ALTA)/#2 (MEDIA):
// "night-audit/cobranza-reminders/alert-notifications envolvían el barrido de
// TODAS las unidades en una sola transacción (`withAppSession`) con try/catch
// POR unidad sin SAVEPOINT -- un error SQL real en una unidad deja la
// transacción ABORTADA (Postgres 25P02); las unidades siguientes fallan en
// cascada con ESE error engañoso, y el COMMIT final -- sobre una transacción
// abortada -- devuelve el tag `ROLLBACK` SIN lanzar, revirtiendo en silencio
// TODO el barrido, incluidas las unidades que sí habían cerrado bien".
//
// Los repositorios en memoria (`InMemoryHotelesRepository`/
// `InMemoryDespachosRepository`/`InMemoryLicitacionesRepository`) NO son
// transaccionales -- por eso ninguna prueba existente veía este bug (ver
// auditoria-a1b-resultado.json, hallazgo #1, punto 7: "el InMemoryTenancyEngine
// no es transaccional"). Este archivo construye, ENCIMA de esos mismos
// repositorios reales (nunca un doble de interfaz reducida -- así las pruebas
// ejercitan el código de producción real, `runNightAuditSweep`/
// `runCobranzaReminderSweep`/`runAlertNotificationSweep`, sin reimplementar su
// lógica), un motor fake que SÍ modela las 2 piezas que importan de una
// transacción Postgres real:
//
//   1. Aislamiento — cada `withRepo(fn)` toma una foto del estado (los campos
//      `Map`/`Array` del repo, que es donde vive TODO el estado de negocio de
//      estos repos -- ver sus constructores) ANTES de correr `fn`; si `fn`
//      lanza, el estado se RESTAURA a esa foto (simula ROLLBACK real); si `fn`
//      resuelve, el estado mutado queda (simula COMMIT real). Con el fix
//      (`withRepo` invocado UNA VEZ POR unidad), esto aísla cada unidad de
//      verdad.
//   2. Contagio de aborto — `makeAbortSimulatingRepo` envuelve el repo en un
//      Proxy: cuando el método designado como "el que falla" se invoca, marca
//      la sesión ABORTADA y lanza; CUALQUIER llamada posterior a CUALQUIER
//      método de ESA MISMA sesión también lanza (simula 25P02, "current
//      transaction is aborted"). Esto reproduce el patrón exacto del bug
//      original: con una sola transacción compartida para TODO el barrido (el
//      código pre-fix), la unidad que falla haría que TODAS las unidades
//      posteriores fallen también con el error engañoso -- exactamente lo que
//      `runXxxSweep` original, aun con su try/catch por unidad, no podía
//      evitar porque el aborto vive en la transacción de Postgres, no en el
//      control de flujo de JavaScript.
//
// Qué NO intenta modelar (fuera de alcance para un fake honesto): aislamiento
// de lectura entre sesiones CONCURRENTES (MVCC real), locks, ni SAVEPOINT (el
// fix elegido es "una transacción por unidad", no SAVEPOINT dentro de una
// compartida -- ver `fix` de auditoria-a1b-resultado.json #1/#2). La prueba
// "antes" de cada spec reconstruye el patrón PRE-fix manualmente (una sola
// `withRepo` para todo el barrido, con el try/catch por unidad que el código
// real tenía) precisamente porque ese código ya NO existe tras el fix -- ver
// el comentario de cada spec para la referencia exacta al commit/diff que lo
// quitó.

/** Cualquiera de los 3 repos en memoria de este monorepo: todo su estado de
 *  negocio vive en campos `Map`/`Array` de instancia (ver sus constructores en
 *  `packages/domain-{hoteles,despachos,licitaciones}/src/in-memory-repository.ts`).
 *  Campos que NO son `Map`/`Array` (p. ej. un `KeyedMutex`, un `storageDir`
 *  string) se dejan TAL CUAL -- ninguno de los 3 sweeps bajo prueba los toca. */
function cloneMapDeep(map: Map<unknown, unknown>): Map<unknown, unknown> {
  const out = new Map<unknown, unknown>();
  for (const [k, v] of map) {
    out.set(structuredClone(k), v instanceof Map ? cloneMapDeep(v) : structuredClone(v));
  }
  return out;
}

function snapshotRepoState(repo: object): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(repo)) {
    if (value instanceof Map) snap[key] = cloneMapDeep(value);
    else if (Array.isArray(value)) snap[key] = structuredClone(value);
  }
  return snap;
}

function restoreRepoState(repo: object, snap: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(snap)) {
    (repo as Record<string, unknown>)[key] = value;
  }
}

/**
 * El motor "DESPUÉS del fix": cada llamada a `withRepo` es su PROPIA
 * transacción -- foto antes, restaura si `fn` lanza, conserva si `fn`
 * resuelve. Esto es exactamente lo que `deps.engine.withAppSession({userId:
 * null}, (db) => fn(xRepo(db)))` hace en producción para CADA invocación de
 * `withRepo` que el sweep corregido ahora hace por unidad.
 */
export function makePerCallTransactionalWithRepo<TRepo extends object>(repo: TRepo): <T>(fn: (repo: TRepo) => Promise<T>) => Promise<T> {
  return async (fn) => {
    const before = snapshotRepoState(repo);
    try {
      return await fn(repo);
    } catch (err) {
      restoreRepoState(repo, before);
      throw err;
    }
  };
}

/**
 * El motor "ANTES del fix": UNA sola sesión compartida para TODA la función
 * `fn` (el patrón que `runNightAuditSweep`/`runCobranzaReminderSweep`/
 * `runAlertNotificationSweep` tenían antes de r4-fix-crons-transaccion-por-unidad
 * -- un `try`/`catch` POR unidad, pero las TODAS comparten la misma
 * transacción). El código viejo NUNCA relanza (su catch por unidad se traga
 * el error y sigue con la próxima), así que `fn` siempre RESUELVE
 * normalmente -- exactamente como en producción, donde el handler JS nunca
 * ve una excepción. Lo que decide si el estado se queda o se revierte NO es
 * si `fn` lanzó (nunca lanza), sino `isAborted()`: si en cualquier punto de
 * la ejecución la sesión se marcó abortada (`makeAbortSimulatingRepo`),
 * "COMMIT" se comporta como el COMMIT real de Postgres sobre una transacción
 * abortada -- devuelve el tag ROLLBACK SIN lanzar, así que este helper
 * restaura el estado a como estaba ANTES de `fn`, en silencio, sin que el
 * resultado que `fn` devolvió refleje ese hecho.
 */
export async function simulateSingleSharedTransaction<TRepo extends object, T>(repo: TRepo, isAborted: () => boolean, fn: () => Promise<T>): Promise<T> {
  const before = snapshotRepoState(repo);
  const result = await fn();
  if (isAborted()) restoreRepoState(repo, before);
  return result;
}

/**
 * Envuelve `repo` en un Proxy que simula el "contagio de aborto" de una
 * transacción Postgres real: la primera vez que `shouldFail(methodName, args)`
 * devuelve `true`, esa llamada lanza `failureMessage` Y marca la sesión
 * abortada -- CUALQUIER llamada posterior (a cualquier método, de cualquier
 * unidad que comparta esta MISMA sesión) lanza el error 25P02 simulado, nunca
 * ejecuta el método real. `reset()` limpia el aborto -- úsalo entre unidades
 * cuando el test simula el patrón YA CORREGIDO (una transacción por unidad:
 * cada unidad obtiene una sesión fresca, así que el aborto de la unidad B
 * nunca debe alcanzar a la unidad C).
 */
export function makeAbortSimulatingRepo<TRepo extends object>(repo: TRepo, shouldFail: (methodName: string, args: unknown[]) => boolean, failureMessage: string): { proxy: TRepo; isAborted: () => boolean; reset: () => void } {
  let aborted = false;
  const proxy = new Proxy(repo, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver) as unknown;
      if (typeof orig !== "function") return orig;
      return (...args: unknown[]) => {
        if (aborted) {
          return Promise.reject(new Error(`current transaction is aborted, commands ignored until end of transaction block (25P02 simulado; disparado por: ${failureMessage})`));
        }
        if (shouldFail(String(prop), args)) {
          aborted = true;
          return Promise.reject(new Error(failureMessage));
        }
        return (orig as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as TRepo;
  return {
    proxy,
    isAborted: () => aborted,
    reset: () => {
      aborted = false;
    },
  };
}
