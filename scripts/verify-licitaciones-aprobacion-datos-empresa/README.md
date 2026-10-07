# verify-licitaciones-aprobacion-datos-empresa

Verificacion contra Postgres REAL (RLS, triggers, GRANT por columna, funcion `security definer` y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/036_licitaciones_aprobacion_datos_empresa.sql` (L-P3-01/02: aprobacion real de
tarifas, documentos, capacidades, experiencia y firmantes; REQ-044/064, WI-04, DB-03).

`assertions.sql` (22 escenarios, una conexion cada uno) cubre: el writer crea y el dato nace pendiente con `proposed_by`
fijado por el trigger; no puede insertar ni actualizar `approval_status`, `proposed_by` ni `approved_by` (42501 por columna) en
ninguno de los cinco recursos; el owner (otra persona) aprueba y queda `approved_by`/`approved_at` y una fila de bitacora; el
AUTOR no decide su propio dato; writer/reviewer no deciden, el analyst decide documentos pero NO tarifas, el admin si; la sesion
debe coincidir con `p_caller_id`; DB-03 (editar precio, vigencia o etiqueta de un dato aprobado lo regresa a pendiente en la
misma sentencia; un UPDATE sin cambio real no); segunda decision = `conflict`, id inexistente = `not_found`, valores invalidos
22023; cross-tenant (decidir, leer e insertar en otra organizacion); bitacora append-only; anon y sin sesion; service_role
conserva el acceso; la lectura de la propia organizacion sigue intacta.

`concurrencia.sh` (DOS conexiones simultaneas): una sesion retiene la decision sin confirmar y se comprueba en
`pg_stat_activity` que la otra ESPERA un Lock; al confirmar la segunda ve `conflict`, al revertir gana; despues 10 rondas con
"pistola de salida" (advisory lock): exactamente un `ok` y un `conflict`, una sola fila de bitacora.

- Gate de CI de `assertions.sql` (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- Gate de CI de `concurrencia.sh`: job `datos-empresa-concurrencia-gate` de `.github/workflows/postgres-real-gate.yml`.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-aprobacion-datos-empresa/run.sh` y `.../concurrencia.sh`.
