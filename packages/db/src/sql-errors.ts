// Utilidades compartidas para reconocer SQLSTATEs del driver `pg` -- antes de
// este archivo, `isUndefinedFunctionError` estaba triplicada (copia-pegada,
// no importada) en `postgres-core-repository.ts`, `apps/api/src/resumen-
// diario/agregador.ts` y `apps/api/src/routes/internal/superadmin-
// mantenimiento.ts`, cada una con su propio comentario "mismo criterio que
// la otra copia". Un módulo compartido evita que las tres diverjan con el
// tiempo (p. ej. si una de las tres decide, sin querer, validar SQLSTATE de
// forma distinta a las demás).
//
// ENDURECIDO (revisores del 19-sep, hallazgo antes documentado aquí mismo
// como "no-bloqueante #3, aún abierto"): Postgres real usa SQLSTATE 42883
// (`undefined_function`) para DOS casos MUY distintos:
//   1. "function core.foo(uuid, text) does not exist" -- la función/rutina de
//      nivel superior NO existe -- el caso NORMAL de "migración pendiente"
//      que este helper existe para detectar.
//   2. "operator does not exist: uuid = text" -- comparar/operar tipos
//      incompatibles -- un BUG REAL de tipos en la consulta, NUNCA "falta
//      aplicar una migración". Un guard que trate cualquier 42883 como
//      "migración pendiente" ENMASCARA este caso como si fuera el primero.
// El mensaje que Postgres adjunta al error es la ÚNICA señal disponible para
// distinguir ambos casos por código (verificado contra Postgres real,
// 19-sep-2026: `select core.foo();` -> "function core.foo() does not exist";
// `select '<uuid>'::uuid = 'x'::text;` -> "operator does not exist: uuid =
// text" -- mismo SQLSTATE 42883 en los dos, mensaje muy distinto). Ver
// `scripts/verify-superadmin-resumen/assertions.sql` para la demostración
// reproducible contra Postgres real de este mismo hallazgo.
function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function errorMessage(err: unknown): string {
  return err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : "";
}

/** Mensaje real que Postgres antepone SOLO cuando la función/rutina de nivel
 *  superior no existe -- nunca para "operator does not exist" (ver cabecera
 *  del archivo). `\S+\(.*\)` acepta el nombre calificado por schema
 *  (`core.foo`) y cualquier lista de tipos de argumento. */
const UNDEFINED_FUNCTION_MESSAGE_RE = /^function\s+\S+\(.*\)\s+does not exist/i;

/** SQLSTATE 42883 (`undefined_function`) -- lo que Postgres real lanza cuando
 *  una función `security definer` referenciada todavía no existe (migración
 *  pendiente de aplicar a la base real, ver la REGLA DURA de compatibilidad
 *  del repo). El driver `pg` (usado por `ManagedPostgresEngine`, ver
 *  `managed-postgres-engine.ts`) propaga el error crudo con `.code` = el
 *  SQLSTATE.
 *
 *  `code === "42883"` SOLO no basta (ver cabecera del archivo) -- este helper
 *  además exige que el MENSAJE tenga la forma "function ... does not exist"
 *  (nunca "operator does not exist: ..."), y opcionalmente que mencione el
 *  NOMBRE exacto de la función que el llamador sondeó (`expectedFunctionName`
 *  -- p. ej. `"core.get_daily_ops_summary_for_superadmin"`), para el caso
 *  todavía más angosto de una función INTERNA distinta, llamada dentro de la
 *  que sí existe, que también dispararía 42883 con "function ... does not
 *  exist" pero mencionando OTRO nombre -- ese caso es un bug real, no
 *  "migración pendiente" de la función de nivel superior que el llamador
 *  esperaba. Sin `expectedFunctionName`, cualquier "function ... does not
 *  exist" cuenta (comportamiento previo, para los llamadores que no conocen
 *  o no necesitan ese nivel de precisión). */
export function isUndefinedFunctionError(err: unknown, expectedFunctionName?: string): boolean {
  if (errorCode(err) !== "42883") return false;
  const message = errorMessage(err);
  if (!UNDEFINED_FUNCTION_MESSAGE_RE.test(message)) return false;
  if (expectedFunctionName && !message.includes(expectedFunctionName)) return false;
  return true;
}

/** SQLSTATE 42P01 (`undefined_table`) -- la tabla/vista referenciada todavía
 *  no existe. A diferencia de 42883, Postgres nunca reutiliza este código
 *  para otro significado -- no hace falta revisar el mensaje. */
export function isUndefinedTableError(err: unknown): boolean {
  return errorCode(err) === "42P01";
}

/** SQLSTATE 42703 (`undefined_column`) -- la columna referenciada todavía no
 *  existe. Mismo criterio que `isUndefinedTableError`: sin ambigüedad de
 *  mensaje que revisar. */
export function isUndefinedColumnError(err: unknown): boolean {
  return errorCode(err) === "42703";
}

/** Clasificación compartida de "migración pendiente" -- el trío de SQLSTATE
 *  que este monorepo ya usa en varios puertos para degradar a un vacío
 *  honesto contra la base real sin migrar (ver `authz-audit-repository.ts`/
 *  `impersonation-repository.ts`/`domain-rentas/postgres-repository.ts`,
 *  cada uno con su propia copia local -- este helper es la versión
 *  endurecida y reutilizable, mismo motivo que `isUndefinedFunctionError`
 *  arriba). `expectedFunctionName` se reenvía tal cual a
 *  `isUndefinedFunctionError` -- sin efecto sobre 42P01/42703 (no aplica,
 *  esos dos SQLSTATE no tienen el problema de ambigüedad de 42883). */
export function isMigrationPendingError(err: unknown, expectedFunctionName?: string): boolean {
  return isUndefinedFunctionError(err, expectedFunctionName) || isUndefinedTableError(err) || isUndefinedColumnError(err);
}
