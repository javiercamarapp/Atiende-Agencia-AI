-- Aplica DESPUÉS de las migraciones reales (los schemas de vertical no existen
-- todavía cuando corre bootstrap.sql). Ver el comentario de cabecera de
-- bootstrap.sql: en Supabase real esto lo hace la plataforma al exponer un schema
-- vía PostgREST, no una migración de este repo.
grant usage on schema citas, hoteles, restaurantes, despachos, licitaciones, rentas, core to authenticated, anon;

-- Este verify (mismo criterio que verify-despachos-fechas-postgres-real/, a
-- diferencia de verify-outbox-grants/verify-rentas-cron-rls, que ejercen RLS/GRANT
-- reales bajo `authenticated`) corre sus escenarios bajo `service_role` a
-- propósito -- lo que verifica es que el SQL de cada repositorio YA NO llama
-- `current_date` (usa el parámetro de "día de negocio" que TypeScript resuelve con
-- `hoyFechaNegocio()`), no autorización. En Supabase real `service_role` tiene
-- acceso irrestricto de plataforma; el mock local (bootstrap.sql) solo le da
-- `bypassrls`, así que hace falta completar el GRANT de tabla aquí, limitado a lo
-- que este verify necesita.
grant usage on schema hoteles, rentas, licitaciones to service_role;
grant select, insert on hoteles.reservation to service_role;
grant select, insert on rentas.unidad, rentas.tarifa_base, rentas.ocupacion, rentas.tarea_operativa to service_role;
grant select, insert on licitaciones.approved_rate to service_role;
