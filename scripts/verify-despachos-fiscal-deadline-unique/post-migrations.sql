-- Aplica DESPUÉS de las migraciones reales (los schemas de vertical no existen
-- todavía cuando corre bootstrap.sql). Ver el comentario de cabecera de
-- bootstrap.sql: en Supabase real esto lo hace la plataforma al exponer un schema
-- vía PostgREST, no una migración de este repo. Mismo patrón EXACTO que
-- scripts/verify-despachos-fechas-postgres-real/post-migrations.sql.
grant usage on schema despachos, core to authenticated, anon;

-- Este verify corre sus escenarios bajo `service_role` a propósito (mismo criterio
-- que verify-despachos-fechas-postgres-real) -- lo que verifica es el SQL real de
-- `createDeadline`/el índice `unique`, no autorización de staff (eso ya lo cubre
-- verify-outbox-grants con el mismo patrón de sesión de staff real).
grant usage on schema despachos to service_role;
grant select, insert, update on despachos.fiscal_deadline to service_role;
