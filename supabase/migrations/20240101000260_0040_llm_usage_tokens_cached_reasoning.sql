-- MOD-10 (seguimientos del gateway OpenRouter, PR #291): guardar los tokens de cache y de razonamiento
-- que el proveedor ya reporta (`tokensCached`/`tokensReasoning` en el resultado del LlmProvider) y
-- admitir en `core.llm_usage_daily` los roles que no pertenecen a una de las 6 verticales.
--
--   1. `tokens_cached` / `tokens_reasoning` (bigint, default 0, >= 0) en `core.llm_usage_daily`. Los
--      modelos con razonamiento (Luna, DeepSeek, Sonnet) cobran los tokens de razonamiento como salida y
--      los de cache de entrada a tarifa menor: sin estas columnas el desglose de costo por modelo no se
--      puede explicar. Son aditivas con default 0: las filas existentes quedan en 0.
--   2. CHECK de `vertical`: el nombre derivado del rol (`deriveVerticalFromRole`) ahora tambien puede ser
--      `superadmin` (rol `superadmin:copiloto`), `plataforma` (enrutador, compuerta, titulos,
--      compactacion, resumen diario) o `reportes` (analisis y redaccion de reportes). Antes, el registro
--      de uso de esos roles violaba el CHECK y se perdia en silencio (el registro es best-effort).
--   3. `core.record_llm_usage` pasa de 10 a 12 parametros; los dos nuevos tienen `default 0`, asi que una
--      llamada de 10 argumentos (el codigo anterior a esta migracion) sigue funcionando igual.
--
-- Justificacion de seguridad (todo lo que cambia):
--   * Sin tablas, GRANT ni policies nuevos. `core.llm_usage_daily` conserva RLS activa y SIN ningun GRANT
--     a anon/authenticated (acceso solo por funciones security definer, ver 0010).
--   * `core.record_llm_usage` se recrea con el MISMO contrato de seguridad que 0010: `security definer`,
--     `set search_path = core, pg_temp`, exige `auth.uid() is null` (solo sesion de sistema; sin ese guard
--     cualquier sesion `authenticated` podia inflar el gasto de otra organizacion por RPC directo),
--     `revoke ... from public` y `grant execute ... to authenticated` (no existe `service_role`
--     aprovisionado en este monorepo). No hay `grant` a `anon`.
--   * Los valores nuevos se normalizan con `greatest(0, coalesce(..., 0))`: un cliente no puede restar
--     tokens acumulados con valores negativos ni romper el INSERT con NULL.
--   * Se hace `drop function` de la firma de 10 argumentos antes de crear la de 12: dejar ambas sobrecargas
--     dejaria dos puertas con el mismo guard que mantener y una llamada ambigua posible.

alter table core.llm_usage_daily
  add column if not exists tokens_cached bigint not null default 0 check (tokens_cached >= 0),
  add column if not exists tokens_reasoning bigint not null default 0 check (tokens_reasoning >= 0);

alter table core.llm_usage_daily drop constraint if exists llm_usage_daily_vertical_check;
alter table core.llm_usage_daily add constraint llm_usage_daily_vertical_check
  check (vertical = any (array['hoteles','restaurantes','rentas','licitaciones','citas','despachos','superadmin','plataforma','reportes']));

drop function if exists core.record_llm_usage(uuid, text, text, text, text, text, bigint, bigint, bigint, boolean);

create or replace function core.record_llm_usage(
  p_organization_id uuid,
  p_vertical text,
  p_role text,
  p_provider_id text,
  p_model text,
  p_lane text,
  p_tokens_in bigint,
  p_tokens_out bigint,
  p_cost_micro_usd bigint,
  p_fallback_used boolean,
  p_tokens_cached bigint default 0,
  p_tokens_reasoning bigint default 0
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'record_llm_usage es solo para la sesión de sistema' using errcode = '42501';
  end if;

  insert into core.llm_usage_daily (
    organization_id, usage_date, vertical, role, provider_id, model, lane,
    tokens_in, tokens_out, cost_micro_usd, call_count, fallback_call_count,
    tokens_cached, tokens_reasoning
  )
  values (
    p_organization_id, current_date, p_vertical, p_role, p_provider_id, p_model, p_lane,
    greatest(0, p_tokens_in), greatest(0, p_tokens_out), greatest(0, p_cost_micro_usd), 1,
    case when p_fallback_used then 1 else 0 end,
    greatest(0, coalesce(p_tokens_cached, 0)), greatest(0, coalesce(p_tokens_reasoning, 0))
  )
  on conflict (organization_id, usage_date, vertical, role, provider_id, model, lane)
  do update set
    tokens_in = core.llm_usage_daily.tokens_in + excluded.tokens_in,
    tokens_out = core.llm_usage_daily.tokens_out + excluded.tokens_out,
    cost_micro_usd = core.llm_usage_daily.cost_micro_usd + excluded.cost_micro_usd,
    call_count = core.llm_usage_daily.call_count + 1,
    fallback_call_count = core.llm_usage_daily.fallback_call_count + excluded.fallback_call_count,
    tokens_cached = core.llm_usage_daily.tokens_cached + excluded.tokens_cached,
    tokens_reasoning = core.llm_usage_daily.tokens_reasoning + excluded.tokens_reasoning,
    updated_at = now();
end;
$$;

revoke all on function core.record_llm_usage(uuid, text, text, text, text, text, bigint, bigint, bigint, boolean, bigint, bigint) from public;
grant execute on function core.record_llm_usage(uuid, text, text, text, text, text, bigint, bigint, bigint, boolean, bigint, bigint) to authenticated;
