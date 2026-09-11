// Contrato estructural mínimo que necesita la capa de aplicación transaccional — port
// literal de rentas/packages/domain/src/aplicacion/ejecutor.ts. Deliberadamente no
// importa nada de infraestructura: `TenantDbSession` de @atiende/core-tenancy satisface
// esta forma sin necesidad de un adaptador dedicado (TS structural typing), igual que
// el `pg`/PGlite del origen — packages/domain-rentas/src no depende en tiempo de
// ejecución de ningún motor concreto de base de datos.
export interface FilaSql {
  [columna: string]: unknown;
}

export interface EjecutorTransaccional {
  query<T extends FilaSql = FilaSql>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  exec(sql: string): Promise<void>;
}

/**
 * Serializa, por `unidad_id`, las transacciones concurrentes que van a intentar
 * insertar/actualizar `rentas.ocupacion`. Sin esto, dos transacciones que insertan
 * filas realmente solapadas AL MISMO TIEMPO pueden terminar en un deadlock
 * (`SQLSTATE 40P01`) en vez de una violación limpia del EXCLUDE (`23P01`) —
 * comportamiento documentado de PostgreSQL: una inserción espera a que termine
 * cualquier transacción concurrente aún no confirmada cuya fila potencialmente
 * conflictúe, y si dos transacciones se esperan mutuamente, el detector de deadlocks
 * aborta una de las dos. El advisory lock convierte esa carrera en una cola
 * estrictamente ordenada por unidad: la segunda transacción espera a que la primera
 * termine (commit o rollback) antes de intentar su propio INSERT/UPDATE, así que
 * cuando sí conflictúa, conflictúa contra una fila YA confirmada —
 * exclusion_violation limpio, nunca deadlock. Unidades distintas nunca se bloquean
 * entre sí.
 */
export async function bloquearUnidadEnTransaccion(ejecutor: EjecutorTransaccional, unidadId: string): Promise<void> {
  await ejecutor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [unidadId]);
}

/** `true` si el error es una violación del EXCLUDE de `rentas.ocupacion` (SQLSTATE
 * `23P01`, `exclusion_violation`). Tanto `pg` como cualquier motor Postgres-compatible
 * exponen `.code` con el SQLSTATE de cinco caracteres. */
export function esViolacionExclusion(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23P01";
}
