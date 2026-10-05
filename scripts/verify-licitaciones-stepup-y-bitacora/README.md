# verify-licitaciones-stepup-y-bitacora

Verificacion contra Postgres REAL (RLS, GRANT, funciones `security definer` y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/038_licitaciones_stepup_un_solo_uso_y_bitacora_escrituras.sql`
(L-P3-12 step-up de un solo uso; L-P3-17 bitacora append-only de escrituras con antes/despues y correlacion).

`assertions.sql` (15 escenarios, una conexion cada uno) cubre: un `jti` se consume una vez y el reuso devuelve false; jti
distintos se consumen cada uno; no se consume a nombre de otro usuario, ni sin membresia (cross-tenant), ni sin sesion ni como
anon (42501); ningun rol de aplicacion lee, inserta ni borra `core.step_up_consumption` directo; la purga es solo de sistema y
solo borra consumos vencidos; un writer anota una escritura y solo owner/admin la leen (antes, despues, actor, correlacion); no se
anota a nombre de otro actor, sin rol de escritura ni en otra organizacion; UPDATE/DELETE/INSERT directos sobre `audit_trail`
fallan para authenticated y service_role; anon y otro tenant no la leen; la sesion de sistema anota sin actor; formato de
`correlation_id` y tamano de antes/despues; paginacion por llave y traza ordenada por correlacion; herencia de la correlacion de una convocatoria sin leer la bitacora (cross-tenant y anon, 42501).

`concurrencia.sh` (DOS conexiones simultaneas): una sesion retiene el consumo sin confirmar y se comprueba en `pg_stat_activity`
que la otra ESPERA un Lock; al confirmar la segunda recibe false, al revertir (la accion fallo) obtiene true; despues 10 rondas con
"pistola de salida": exactamente una pasa.

- Gate de CI de `assertions.sql`: automatico (`scripts/verify-real-postgres-ci/run-gate.mjs`).
- Gate de CI de `concurrencia.sh`: job `stepup-concurrencia-gate` de `.github/workflows/postgres-real-gate.yml`.
- A mano contra un Postgres local efimero: `run.sh` y `concurrencia.sh` de este directorio.
