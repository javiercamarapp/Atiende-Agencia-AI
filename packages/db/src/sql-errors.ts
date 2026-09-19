// Utilidades compartidas para reconocer SQLSTATEs del driver `pg` -- antes de
// este archivo, `isUndefinedFunctionError` estaba triplicada (copia-pegada,
// no importada) en `postgres-core-repository.ts`, `apps/api/src/resumen-
// diario/agregador.ts` y `apps/api/src/routes/internal/superadmin-
// mantenimiento.ts`, cada una con su propio comentario "mismo criterio que
// la otra copia". Un módulo compartido evita que las tres diverjan con el
// tiempo (p. ej. si una de las tres decide, sin querer, validar SQLSTATE de
// forma distinta a las demás).

/** SQLSTATE 42883 (`undefined_function`) -- lo que Postgres real lanza cuando
 *  una función `security definer` referenciada todavía no existe (migración
 *  pendiente de aplicar a la base real, ver la REGLA DURA de compatibilidad
 *  del repo). El driver `pg` (usado por `ManagedPostgresEngine`, ver
 *  `managed-postgres-engine.ts`) propaga el error crudo con `.code` = el
 *  SQLSTATE.
 *
 *  NOTA (hallazgo no-bloqueante #3 de la auditoría a1, aún abierto): Postgres
 *  también usa 42883 para "operator does not exist" y para una función
 *  interna faltante llamada DENTRO de una función que sí existe -- este
 *  chequeo, por código solo, no distingue esos casos de "la función de nivel
 *  superior no existe". Un bug real dentro de una función `_for_system` hoy
 *  se enmascararía igual como "migración pendiente". Los llamadores de esta
 *  función deben seguir documentando ese hueco hasta que se resuelva (p. ej.
 *  validando también que el mensaje del error mencione la función sondeada). */
export function isUndefinedFunctionError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "42883";
}
