-- Mismo criterio que scripts/verify-outbox-grants/post-migrations.sql -- en
-- Supabase real esto lo hace la plataforma al exponer un schema vía PostgREST, no
-- una migración de este repo.
grant usage on schema citas, core to authenticated, anon;
