-- Aplica DESPUÉS de las 91 migraciones reales (los schemas de vertical no existen
-- todavía cuando corre bootstrap.sql). Ver el comentario de cabecera de
-- bootstrap.sql: en Supabase real esto lo hace la plataforma al exponer un schema
-- vía PostgREST, no una migración de este repo.
grant usage on schema citas, hoteles, restaurantes, despachos, licitaciones, rentas, core to authenticated, anon;

-- Este verify tambien comprueba que service_role (mantenimiento) conserva el acceso a las tablas de datos de empresa; en Supabase
-- real la plataforma le da USAGE del schema (mismo criterio que arriba para authenticated/anon).
grant usage on schema licitaciones, core to service_role;
