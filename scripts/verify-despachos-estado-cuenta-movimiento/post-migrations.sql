-- Aplica DESPUÉS de las migraciones reales (los schemas de vertical no existen todavía
-- cuando corre bootstrap.sql). En Supabase real esto lo hace la plataforma al exponer un
-- schema vía PostgREST, no una migración de este repo. Mismo patrón que
-- scripts/verify-despachos-fiscal-deadline-unique/post-migrations.sql.
grant usage on schema despachos, core to authenticated, anon;
grant usage on schema despachos, core to service_role;
-- `core.membership`/`core.property` los lee la propia policy de INSERT de la tabla bajo
-- el rol del staff (RLS propia de cada tabla los filtra), igual que en Supabase real.
grant select on core.membership, core.property to authenticated;
