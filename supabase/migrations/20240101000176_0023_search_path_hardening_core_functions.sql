-- FASE 2 (integridad) — endurecimiento de `search_path` para 4 funciones de
-- `core` que quedaron SIN `set search_path` fijo (WARN "Function Search Path
-- Mutable" de `get_advisors` tipo `security`, tras aplicar las migraciones a
-- la base real el 20-sep-2026): un caller que manipule su propio
-- `search_path` de sesión podría, en teoría, hacer que la función resuelva un
-- objeto de otro esquema con el mismo nombre en vez del que espera (defensa
-- en profundidad — ninguna de las 4 referencia un objeto sin calificar en su
-- cuerpo hoy, así que esto no es un hueco explotado, pero cierra la
-- superficie para cualquier cambio futuro del cuerpo que sí lo haga).
--
-- `get_advisors` reportó 3 de hoy: `core.default_llm_org_monthly_cap_micro_usd`
-- (0010_llm_usage_budget_schema.sql), `core.impersonation_block_mutation`
-- (0020_superadmin_impersonacion.sql) y `core.authz_audit_log_block_mutation`
-- (0021_superadmin_authz_audit_log.sql). Verificado con
-- `grep -rniE 'create (or replace )?function' packages/db/migrations` +
-- revisión manual de cada bloque: existe una 4a función del mismo patrón que
-- el advisor no listó como "nueva de hoy" (es más vieja) pero comparte el
-- mismo hueco — `core.set_property_vertical` (0001_core_schema.sql), trigger
-- `before insert or update of organization_id on core.property` — se incluye
-- aquí por el mismo criterio.
--
-- Cambio QUIRÚRGICO: cada `create or replace function` de abajo es
-- BYTE-IDÉNTICO a su última definición real (mismo cuerpo, misma firma,
-- mismos permisos — ninguna de las 4 tenía un GRANT/REVOKE explícito propio,
-- así que ninguno se toca) más UNA sola cláusula nueva: `set search_path =
-- core, pg_temp` (mismo patrón que el resto de funciones `security definer`
-- de este archivo y de este paquete, que ya lo hacían bien). Ninguna de las 4
-- es `security definer` y esta migración no la vuelve una — no era parte del
-- hallazgo del advisor ni de esta tarea, y cambiarlo sería alterar
-- comportamiento fuera del alcance de un fix de `search_path`.
--
-- Compatibilidad con la base sin migrar: las 4 funciones YA EXISTEN (esto es
-- `create or replace`, nunca `create`) — el código TypeScript que las invoca
-- (directo o vía trigger) sigue funcionando idéntico con o sin esta migración
-- aplicada, no hace falta ningún fallback de SQLSTATE 42883/42P01/42703.

-- `core.set_property_vertical` — trigger `before insert/update` sobre
-- `core.property`, copia `organization.vertical` a la fila. Cuerpo idéntico a
-- 0001_core_schema.sql:50-56, solo se agrega `set search_path`.
create or replace function core.set_property_vertical()
returns trigger
language plpgsql
set search_path = core, pg_temp
as $$
begin
  select o.vertical into new.vertical from core.organization o where o.id = new.organization_id;
  return new;
end;
$$;

-- `core.default_llm_org_monthly_cap_micro_usd` — constante pura (tope por
-- defecto de $100 USD/mes en micro-USD) para una organización sin fila propia
-- en `llm_org_budget`. Cuerpo idéntico a
-- 0010_llm_usage_budget_schema.sql:170-176, solo se agrega `set search_path`.
create or replace function core.default_llm_org_monthly_cap_micro_usd()
returns bigint
language sql
immutable
set search_path = core, pg_temp
as $$
  select 100000000::bigint;
$$;

-- `core.impersonation_block_mutation` — trigger `before update/delete` sobre
-- `core.impersonation_session` (bitácora append-only). Cuerpo idéntico a
-- 0020_superadmin_impersonacion.sql:121-129, solo se agrega `set search_path`.
create or replace function core.impersonation_block_mutation()
returns trigger
language plpgsql
set search_path = core, pg_temp
as $$
begin
  raise exception 'impersonation_append_only: % no está permitido sobre %', tg_op, tg_table_name
    using errcode = '0A000';
end;
$$;

-- `core.authz_audit_log_block_mutation` — trigger `before update/delete`
-- sobre `core.authz_audit_log` (bitácora append-only). Cuerpo idéntico a
-- 0021_superadmin_authz_audit_log.sql:139-147, solo se agrega `set search_path`.
create or replace function core.authz_audit_log_block_mutation()
returns trigger
language plpgsql
set search_path = core, pg_temp
as $$
begin
  raise exception 'authz_audit_log_append_only: % no está permitido sobre core.authz_audit_log', tg_op
    using errcode = '0A000';
end;
$$;
