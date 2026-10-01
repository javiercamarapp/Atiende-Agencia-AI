# verify-restaurantes-agente-config-callbacks

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/033_agente_config_historial_y_callbacks_estado.sql`
(espejo: `supabase/migrations/20240101000230_033_agente_config_historial_y_callbacks_estado.sql`).

- Parte A (R-10): columnas nuevas de `restaurantes.whatsapp_agent_config` (CHECK de longitud y de motivos desactivables,
  version optimista) y la tabla append-only `whatsapp_agent_config_history` (rol, cross-tenant, `anon`, actor falsificado,
  UPDATE/DELETE sin GRANT, version duplicada).
- Parte B (R-12): estado/asignacion de `restaurantes.callback_requests` (trigger de coherencia con `resolved`),
  `callback_actualizar` (tomar/asignar/liberar/resolver/reabrir: rol, cross-tenant, persona ajena, `anon`, sesion de sistema),
  `callbacks_sucursal_estado`, integracion con `callback_registrar_intento` de 028, y los escenarios de "base sin migrar"
  (42883 y 42703 recuperados con SAVEPOINT real).

- Manual: `scripts/verify-restaurantes-agente-config-callbacks/run.sh`.
- CI: lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de archivos que los demas `verify-*`).
