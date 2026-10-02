# verify-licitaciones-doble-aprobacion

Verificacion contra Postgres REAL (RLS, trigger, indice unico y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/033_expediente_doble_aprobacion.sql` (L-26 / REQ-044: doble
aprobacion del expediente, tecnico-legal 1/2 y economica 2/2, por dos personas distintas).

Cubre: camino feliz con dos personas; la misma persona no completa el 2/2 en ningun orden (trigger,
SQLSTATE 23514); la economica exige la tecnico-legal vigente para el MISMO hash; la etapa no se puede
registrar a nombre de otra persona (RLS); writer sin rol de decision; cross-tenant (escritura y lectura);
anon; una sola vigente por etapa (indice unico); la etapa solo existe en el alcance expediente;
compatibilidad con aprobaciones de seccion y con la aprobacion unica legada; repeticion del 2/2 tras un
cambio de insumos; y la decision de datos previos (invalidar con historial).

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-doble-aprobacion/run.sh`.
