-- Aplica DESPUÉS de las migraciones reales (los schemas de vertical no existen
-- todavía cuando corre bootstrap.sql). Ver el comentario de cabecera de
-- bootstrap.sql: en Supabase real esto lo hace la plataforma al exponer un schema
-- vía PostgREST, no una migración de este repo. Mismo criterio que
-- scripts/verify-outbox-grants/post-migrations.sql — solo los 3 schemas que este
-- verify realmente ejercita (hoteles, citas, rentas, ver README.md).
grant usage on schema hoteles, citas, rentas, core to authenticated, anon;
