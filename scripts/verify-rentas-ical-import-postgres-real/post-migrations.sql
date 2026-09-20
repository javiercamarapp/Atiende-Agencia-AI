-- Aplica DESPUÉS de las migraciones reales (los schemas de vertical no existen
-- todavía cuando corre bootstrap.sql). En Supabase real esto lo hace la plataforma al
-- exponer un schema vía PostgREST, no una migración de este repo. IDÉNTICO a
-- scripts/verify-rentas-cron-rls/post-migrations.sql.
grant usage on schema citas, hoteles, restaurantes, despachos, licitaciones, rentas, core to authenticated, anon;
