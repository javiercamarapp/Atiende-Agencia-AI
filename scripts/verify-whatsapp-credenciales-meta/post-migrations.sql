-- Aplica DESPUES de las migraciones reales: en Supabase real el USAGE de los schemas expuestos lo da la plataforma, no una migracion.
grant usage on schema core to authenticated, anon, service_role;
grant usage on schema restaurantes to authenticated, anon, service_role;
