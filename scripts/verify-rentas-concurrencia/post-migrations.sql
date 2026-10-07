-- Aplica DESPUES de las migraciones reales (los schemas de vertical no existen cuando corre bootstrap.sql). En Supabase real esto lo hace la
-- plataforma al exponer un schema; aqui solo lo que esta verificacion ejercita.
grant usage on schema rentas, core to authenticated, anon;
