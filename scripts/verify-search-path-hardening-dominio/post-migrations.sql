-- Aplica DESPUES de las migraciones reales: en Supabase real el USAGE de schema
-- lo pone la plataforma al exponer un schema via PostgREST, no una migracion de
-- este repo (ver bootstrap.sql). Aqui solo hace falta que las funciones y las
-- tablas de bitacora se puedan ejercitar como `service_role` / `anon` sin que un
-- "permission denied for schema" incidental enmascare el resultado que se
-- verifica (el trigger de bloqueo append-only, el search_path fijado).
grant usage on schema core, citas, hoteles, restaurantes, licitaciones, rentas
  to authenticated, anon, service_role;
