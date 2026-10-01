-- Aplica DESPUÉS de las migraciones reales (el schema `core` ya existe desde
-- packages/db/migrations/0001_core_schema.sql, mucho antes que esta
-- verificación). Ver el comentario de cabecera de bootstrap.sql: en Supabase
-- real esto lo hace la plataforma al exponer un schema vía PostgREST
-- (`supabase/config.toml::api.schemas`, que SÍ incluye `core`), no una
-- migración de este repo.
grant usage on schema core to authenticated, anon;
