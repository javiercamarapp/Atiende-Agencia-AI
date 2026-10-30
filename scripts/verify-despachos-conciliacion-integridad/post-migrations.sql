-- Aplica DESPUÉS de las migraciones reales (los schemas de vertical no existen todavía
-- cuando corre bootstrap.sql). En Supabase real esto lo hace la plataforma al exponer un
-- schema; no es una migración de este repo. Mismo patrón que
-- scripts/verify-audit-log-orden-total-f2/post-migrations.sql.
grant usage on schema despachos, core to authenticated, anon;
