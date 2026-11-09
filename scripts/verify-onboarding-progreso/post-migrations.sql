-- Aplica DESPUES de las migraciones reales (ver bootstrap.sql): USAGE del schema core que en Supabase real pone la plataforma.
grant usage on schema core to authenticated, anon;
