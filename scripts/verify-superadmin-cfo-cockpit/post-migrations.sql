-- Aplica DESPUÉS de las migraciones reales (el schema `core` ya existe desde
-- packages/db/migrations/0001_core_schema.sql, mucho antes que esta
-- verificación). Ver el comentario de cabecera de bootstrap.sql: en Supabase
-- real esto lo hace la plataforma al exponer un schema vía PostgREST
-- (`supabase/config.toml::api.schemas`, que SÍ incluye `core`), no una
-- migración de este repo.
grant usage on schema core to authenticated, anon;
-- `service_role` en Supabase real tiene acceso amplio de infraestructura
-- (bypassa RLS, y en la práctica también USAGE de todo schema expuesto) --
-- se otorga aquí explícitamente para que los escenarios 15/16/17 de
-- assertions.sql (UPDATE/DELETE bloqueados "incluso para service_role")
-- prueben de verdad el TRIGGER de bloqueo de mutación (0A000), no un
-- "permission denied for schema" incidental que enmascararía si el trigger
-- realmente funciona.
grant usage on schema core to service_role;
