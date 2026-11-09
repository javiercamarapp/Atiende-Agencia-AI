-- 0102_whatsapp_agente_techo.sql — Ola 4 (H1): techo duro de gasto por organización para el agente de WhatsApp.
--
-- Hallazgo (costo/disponibilidad): el tope mensual de LLM de la organización (core.llm_org_budget, 0010/0047) cubre TODO el LLM y
-- corta en seco al 100 %; el agente de WhatsApp no tenía un techo propio ni un aviso previo, y su costo de Meta (core.usage_cost_event,
-- categoría 'whatsapp') no contaba contra ningún tope.
--
-- Esta migración agrega SOLO la base de datos:
--   A) core.whatsapp_agente_techo: política por organización (techo mensual en micro-USD, acción 'avisar' | 'avisar_y_cortar',
--      porcentaje de corte 100..300). Sin fila = política de omisión que manda el API (hoy: 100 USD, avisar al 100 %, cortar al 120 %;
--      decisión final pendiente de Javier, ver docs/COSTOS-AGENTE-WHATSAPP.md).
--   B) core.whatsapp_agente_techo_evento: historial append-only de cada cambio (quién, qué, cuándo).
--   C) core.whatsapp_agente_techo_estado_for_system(org, techo_omision, ahora): SOLO SISTEMA. Gasto del mes (zona America/Merida) del
--      agente = core.llm_usage_daily de los roles 'restaurantes:whatsapp_agent' y 'restaurantes:whatsapp_agent_escalated' + costo de
--      WhatsApp de core.usage_cost_event; y la política vigente.
--   D) core.superadmin_set_whatsapp_agente_techo(caller, org, techo, accion, corte_pct): superadmin real, caller-bound y no restringido;
--      techo nulo borra la fila (vuelve a la omisión). Valida la lista cerrada de acciones y el rango del corte.
--
-- Justificación de seguridad:
--   * Tablas A y B: RLS habilitada SIN policy y REVOKE ALL a public, anon, authenticated y service_role: nadie las lee ni escribe
--     directo; solo C (lectura) y D (escritura), ambas security definer. Sin GRANT a nivel columna porque no hay acceso directo.
--   * C: security definer, search_path fijo, REVOKE de public y anon, GRANT EXECUTE a authenticated (rol de la sesión de sistema del
--     API) y guarda `auth.uid() is not null` -> 42501: un usuario no puede leer el gasto de OTRA organización pasando su id.
--   * D: core.superadmin_require_caller (auth.uid() = p_caller_id, superadmin vigente, no restringido a finanzas); un owner no puede
--     subir su propio techo. Cada cambio queda en B.
--   * Ninguna fila de cliente ni PII: solo montos agregados.
-- Rollback: `drop function core.superadmin_set_whatsapp_agente_techo(uuid, uuid, bigint, text, integer);`
--   `drop function core.whatsapp_agente_techo_estado_for_system(uuid, bigint, timestamptz);`
--   `drop table core.whatsapp_agente_techo_evento; drop table core.whatsapp_agente_techo;` (el API cae a "sin_medir" y atiende).

-- A) Política por organización
create table core.whatsapp_agente_techo (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  techo_mensual_micro_usd bigint not null check (techo_mensual_micro_usd > 0),
  accion text not null default 'avisar_y_cortar' check (accion in ('avisar', 'avisar_y_cortar')),
  corte_pct integer not null default 120 check (corte_pct between 100 and 300),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);
alter table core.whatsapp_agente_techo enable row level security;
revoke all on core.whatsapp_agente_techo from public, anon, authenticated, service_role;

-- B) Historial de cambios
create table core.whatsapp_agente_techo_evento (
  seq bigint generated always as identity primary key,
  organization_id uuid not null references core.organization(id) on delete cascade,
  actor_user_id uuid references core.staff_user(id) on delete set null,
  techo_mensual_micro_usd bigint,
  accion text,
  corte_pct integer,
  ocurrido_en timestamptz not null default now()
);
alter table core.whatsapp_agente_techo_evento enable row level security;
revoke all on core.whatsapp_agente_techo_evento from public, anon, authenticated, service_role;

-- C) Estado del techo (solo sistema)
create or replace function core.whatsapp_agente_techo_estado_for_system(
  p_organization_id uuid,
  p_techo_omision_micro_usd bigint,
  p_ahora timestamptz default now()
)
returns table (gasto_micro_usd bigint, techo_micro_usd bigint, accion text, corte_pct integer, periodo text)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare
  v_local timestamp := coalesce(p_ahora, now()) at time zone 'America/Merida';
  v_ini_dia date := date_trunc('month', v_local)::date;
  v_fin_dia date := (date_trunc('month', v_local) + interval '1 month')::date;
  v_ini timestamptz := date_trunc('month', v_local) at time zone 'America/Merida';
  v_fin timestamptz := (date_trunc('month', v_local) + interval '1 month') at time zone 'America/Merida';
  v_llm bigint;
  v_wa bigint;
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_agente_techo_estado_for_system es solo de sistema' using errcode = '42501';
  end if;
  if p_techo_omision_micro_usd is null or p_techo_omision_micro_usd <= 0 then
    raise exception 'whatsapp_agente_techo_estado_for_system: techo de omision invalido' using errcode = '22023';
  end if;
  select coalesce(sum(u.cost_micro_usd), 0)::bigint into v_llm
    from core.llm_usage_daily u
   where u.organization_id = p_organization_id
     and u.role in ('restaurantes:whatsapp_agent', 'restaurantes:whatsapp_agent_escalated')
     and u.usage_date >= v_ini_dia and u.usage_date < v_fin_dia;
  select coalesce(sum(e.costo_micro_usd), 0)::bigint into v_wa
    from core.usage_cost_event e
   where e.organization_id = p_organization_id and e.categoria = 'whatsapp'
     and e.occurred_at >= v_ini and e.occurred_at < v_fin;
  return query
    select v_llm + v_wa,
           coalesce(t.techo_mensual_micro_usd, p_techo_omision_micro_usd),
           coalesce(t.accion, 'avisar_y_cortar'),
           coalesce(t.corte_pct, 120),
           to_char(v_local, 'YYYY-MM')
      from (select 1) uno
      left join core.whatsapp_agente_techo t on t.organization_id = p_organization_id;
end;
$$;
revoke all on function core.whatsapp_agente_techo_estado_for_system(uuid, bigint, timestamptz) from public, anon;
grant execute on function core.whatsapp_agente_techo_estado_for_system(uuid, bigint, timestamptz) to authenticated;

-- D) Configurar (superadmin)
create or replace function core.superadmin_set_whatsapp_agente_techo(
  p_caller_id uuid,
  p_organization_id uuid,
  p_techo_micro_usd bigint,
  p_accion text,
  p_corte_pct integer
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_whatsapp_agente_techo');
  if not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'superadmin_set_whatsapp_agente_techo: organizacion inexistente' using errcode = '22023';
  end if;
  if p_techo_micro_usd is null then
    delete from core.whatsapp_agente_techo where organization_id = p_organization_id;
  else
    if p_techo_micro_usd <= 0 then
      raise exception 'superadmin_set_whatsapp_agente_techo: el techo debe ser positivo' using errcode = '22023';
    end if;
    if coalesce(p_accion, 'avisar_y_cortar') not in ('avisar', 'avisar_y_cortar') then
      raise exception 'superadmin_set_whatsapp_agente_techo: accion invalida' using errcode = '22023';
    end if;
    if coalesce(p_corte_pct, 120) not between 100 and 300 then
      raise exception 'superadmin_set_whatsapp_agente_techo: el corte va de 100 a 300 por ciento' using errcode = '22023';
    end if;
    insert into core.whatsapp_agente_techo (organization_id, techo_mensual_micro_usd, accion, corte_pct, updated_at, updated_by)
    values (p_organization_id, p_techo_micro_usd, coalesce(p_accion, 'avisar_y_cortar'), coalesce(p_corte_pct, 120), now(), p_caller_id)
    on conflict (organization_id) do update
      set techo_mensual_micro_usd = excluded.techo_mensual_micro_usd, accion = excluded.accion, corte_pct = excluded.corte_pct,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;
  insert into core.whatsapp_agente_techo_evento (organization_id, actor_user_id, techo_mensual_micro_usd, accion, corte_pct)
  values (p_organization_id, p_caller_id, p_techo_micro_usd, case when p_techo_micro_usd is null then null else coalesce(p_accion, 'avisar_y_cortar') end,
          case when p_techo_micro_usd is null then null else coalesce(p_corte_pct, 120) end);
end;
$$;
revoke all on function core.superadmin_set_whatsapp_agente_techo(uuid, uuid, bigint, text, integer) from public, anon;
grant execute on function core.superadmin_set_whatsapp_agente_techo(uuid, uuid, bigint, text, integer) to authenticated;
