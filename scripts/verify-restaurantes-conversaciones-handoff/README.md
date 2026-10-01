# verify-restaurantes-conversaciones-handoff

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/027_conversaciones_handoff_turnos.sql`
(espejo: `supabase/migrations/20240101000212_027_*.sql`): turnos de personal por sucursal (`branch_shift`,
`branch_shift_member`), `conversation_handoff`, `conversation_note`, `callback_attempt`, la bandeja unificada
`bandeja_conversaciones` y las funciones de staff (`handoff_tomar/devolver/cerrar/agregar_nota/responder_whatsapp`,
`callback_registrar_intento`) y de solo-sistema (`handoff_solicitar`, `handoff_whatsapp_estado`).

Cubre positivo, rol insuficiente, cross-tenant, alcance por sucursal (`membership.property_ids`), `anon`, GRANT por
columna, toma concurrente (55006), idempotencia, CHECKs, lectura de transcripcion de voz solo para quien tomo la
llamada y el escenario "base sin migrar" (42P01/42883 + SAVEPOINT). Los rechazos se afirman con un bloque `DO` que exige
el SQLSTATE exacto.

- Manual: `scripts/verify-restaurantes-conversaciones-handoff/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
