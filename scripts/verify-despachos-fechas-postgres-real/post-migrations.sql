-- Aplica DESPUÉS de las migraciones reales (los schemas de vertical no existen
-- todavía cuando corre bootstrap.sql). Ver el comentario de cabecera de
-- bootstrap.sql: en Supabase real esto lo hace la plataforma al exponer un schema
-- vía PostgREST, no una migración de este repo.
grant usage on schema citas, hoteles, restaurantes, despachos, licitaciones, rentas, core to authenticated, anon;

-- Este verify (a diferencia de verify-outbox-grants/verify-rentas-cron-rls, que
-- ejercen RLS/GRANT reales bajo `authenticated`) corre sus escenarios bajo
-- `service_role` a propósito -- lo que verifica es la VALIDEZ SQL de
-- FISCAL_DEADLINE_COLUMNS/RECEIVABLE_COLUMNS (columnas explícitas + `::text`), no
-- autorización. En Supabase real, `service_role` tiene acceso irrestricto a nivel de
-- base de datos (además de `bypassrls`) porque la plataforma lo provisiona así; este
-- mock local solo le da `bypassrls` (bootstrap.sql) -- aquí se completa con los GRANT
-- de tabla que la plataforma real ya le da, limitados a lo que este verify necesita
-- (despachos: fiscal_deadline/receivable/invoice).
grant usage on schema despachos to service_role;
grant select, insert, update on despachos.fiscal_deadline, despachos.receivable, despachos.invoice to service_role;
