-- Aplica DESPUES de las migraciones reales (los schemas de vertical no existen todavia cuando corre bootstrap.sql). Ver el comentario de cabecera de
-- bootstrap.sql: en Supabase real esto lo hace la plataforma al exponer un schema via PostgREST, no una migracion de este repo.
grant usage on schema citas, hoteles, restaurantes, despachos, licitaciones, rentas, core to authenticated, anon;
