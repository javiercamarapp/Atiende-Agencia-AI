# verify-licitaciones-sala-guerra-junta

Verifica contra Postgres real la migracion
`packages/domain-licitaciones/migrations/029_sala_de_guerra_y_junta_aclaraciones.sql`
(espejo `supabase/migrations/20240101000224_029_...`): sala de guerra por convocatoria
(`war_room_item`, `war_room_entry`) y preguntas de la junta de aclaraciones
(`junta_aclaraciones`, `junta_question`, `junta_question_reminder`).

Cubre: positivo, negativo, cross-tenant, anon, GRANT por columna (el cliente no escribe sellos
ni `status` en el INSERT), maquina de estados y sellos del trigger (aprobar exige rol de decision),
bitacora append-only, funcion de solo-sistema de recordatorios (`auth.uid()` NULL; autenticado y
anon rechazados) y degradacion a la base SIN migrar con SAVEPOINT.

- Manual: `scripts/verify-licitaciones-sala-guerra-junta/run.sh` (requiere initdb/pg_ctl/psql).
- CI: `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo (bootstrap + post-migrations + assertions).
