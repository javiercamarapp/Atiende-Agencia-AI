# verify-restaurantes-ciclo-pedido

Verificacion contra Postgres real de las migraciones `packages/domain-restaurantes/migrations/170_pedido_aceptacion_rechazo_y_entrega.sql`,
`171_encuesta_post_entrega.sql` y `172_recordatorios_pedido_sin_aceptar.sql` (espejos `supabase/migrations/20240101000470` a `472`).

Cubre: aceptar con tiempo prometido (rango, idempotencia, cajero si, chofer/otra sucursal/otra organizacion/anon no, conflicto de estado), rechazar con
motivo de lista cerrada (el motivo queda en el historial; el cajero no), entrega de la sucursal con hora real (ni futura, ni anterior a la salida), tiempos
reales vs prometidos, encuesta (apagada por omision, una sola vez por pedido, ventana y candidatas solo de sistema, respuesta 1 a 5, comentario unico,
baja, sin telefono en las tablas, sin escritura directa) y recordatorios (numero segun edad, configuracion solo owner/admin, solo sistema los candidatos).

Convencion del gate: cada escenario devuelve UN entero (`..._deberia_ser_N`) o usa `public.t_esperar_error(sql, sqlstate)`.

- Manual: `scripts/verify-restaurantes-ciclo-pedido/run.sh` (requiere `initdb`/`pg_ctl`/`psql`; NO hay Postgres en la Mac de desarrollo).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs`.
