# verify-restaurantes-operacion-despacho

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/090_pedidos_salio_listo_captura_perfil_operativo.sql` y
`092_despacho_entrega_atomicos.sql` (espejos `supabase/migrations/20240101000403_...` y `...000405_...`): panel movil del operador.

Cubre: `despachar_pedido` (efecto en la fila, doble llamada = un evento y `ya_aplicado`, reasignacion sin tocar `salio_at`), `marcar_listo`,
`marcar_entrega` (solo el chofer asignado, idempotente, monto), `deshacer_entrega` (ventana de 60 s, forzado por encargado, borrado del aviso
pendiente en la outbox), el perfil operativo (`staff_perfil_operativo_guardar`, `operador_puede`: el cajero no despacha ni cancela) y los CHECK de
las columnas nuevas. Rechazos: cajero, chofer, staff de otra sucursal, sesion de sistema, anon, cross-tenant (P0404), recoger (P0422), estado
cambiado (P0409), fuera de ventana (P0410), argumentos invalidos (22023).

- Manual: `scripts/verify-restaurantes-operacion-despacho/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
