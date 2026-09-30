# verify-restaurantes-voz

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/025_voz_config_conversaciones.sql`
(espejo: `supabase/migrations/20240101000198_025_*.sql`): `branch_voice_config` (config de voz por sucursal),
`voice_preview_sessions`, `voice_conversation`, `voice_turn` y las funciones de solo-sistema
`voz_iniciar_conversacion`, `voz_registrar_turno`, `voz_cerrar_conversacion`, `voz_consumir_preview`.

Cubre positivo, rol insuficiente, cross-tenant, `anon`, GRANT por columna, CHECKs, idempotencia, costo/duracion
calculados por la base y el escenario "base sin migrar" (el SQL real que emite el repositorio falla con
42P01/42883 y el SAVEPOINT recupera la transaccion).

- Manual: `scripts/verify-restaurantes-voz/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
