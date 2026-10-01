# verify-restaurantes-agente-config

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/029_whatsapp_agent_config.sql`
(espejo: `supabase/migrations/20240101000216_029_whatsapp_agent_config.sql`): tabla
`restaurantes.whatsapp_agent_config` (perfil del agente de WhatsApp por organizacion y por sucursal).

Cubre positivo (owner/admin, upsert con el SQL exacto del repositorio para organizacion y sucursal), rol
insuficiente (staff), cross-tenant (property ajena, organizacion ajena, UPDATE de otra organizacion = 0 filas),
`anon` (SELECT e INSERT), GRANT por columna (`organization_id`/`property_id` no se mueven), sin DELETE, CHECKs
(perfil, longitudes), unicidad por indice parcial, lectura de sistema sin usuario (webhook de WhatsApp), la
precedencia sucursal > organizacion del lector, filas apagadas (`enabled = false`) y el escenario "base sin
migrar" (el SQL real del lector falla con 42P01 y el SAVEPOINT recupera la transaccion).

- Manual: `scripts/verify-restaurantes-agente-config/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
