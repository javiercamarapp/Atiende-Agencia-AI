-- 0102_whatsapp_agente_techo.sql — Ola 4 (H1): gasto del agente de WhatsApp por organización: avisos por umbral y corte opcional.
--
-- Hallazgo (costo): el agente de WhatsApp no tenía medición propia de gasto (LLM del agente + costo de Meta) ni aviso al dueño o al
-- superadmin cuando el gasto crece. El tope mensual de LLM de la organización (core.llm_org_budget, 0010/0047) es otra cosa y no cambia.
--
-- Decisión de Omar (9-nov-2026): «no hay techo, es lo que necesite PM o el cliente». Por omisión NO se corta nunca; solo se AVISA al
-- cruzar umbrales informativos. El corte existe únicamente si un superadmin lo configura explícitamente para una organización.
--
-- Esta migración agrega SOLO la base de datos:
--   A) core.whatsapp_agente_techo: configuración por organización. `umbrales_aviso_micro_usd` (null = umbrales de omisión del API) y
--      `corte_micro_usd` (null = nunca corta). Sin fila = omisión: avisos con los umbrales del API y sin corte.
--   B) core.whatsapp_agente_techo_evento: historial append-only de cada cambio (quién, qué, cuándo).
--   C) core.whatsapp_agente_techo_estado_for_system(org, ahora): SOLO SISTEMA. Gasto del mes (zona America/Merida) = core.llm_usage_daily
--      de los roles 'restaurantes:whatsapp_agent' y 'restaurantes:whatsapp_agent_escalated' + core.usage_cost_event categoría 'whatsapp';
--      la configuración (o null) y el slug de la organización (código para el aviso al superadmin, no PII).
--   D) core.superadmin_set_whatsapp_agente_techo(caller, org, umbrales, corte): superadmin real, caller-bound y no restringido; ambos nulos
--      borran la fila (vuelve a la omisión, sin corte).
--
-- Justificación de seguridad:
--   * Tablas A y B: RLS habilitada SIN policy y REVOKE ALL a public, anon, authenticated y service_role: nadie las lee ni escribe
--     directo; solo C (lectura) y D (escritura), ambas security definer. Sin GRANT a nivel columna porque no hay acceso directo.
--   * C: security definer, search_path fijo, REVOKE de public y anon, GRANT EXECUTE a authenticated (rol de la sesión de sistema del
--     API) y guarda `auth.uid() is not null` -> 42501: un usuario no puede leer el gasto de OTRA organización pasando su id.
--   * D: core.superadmin_require_caller (auth.uid() = p_caller_id, superadmin vigente, no restringido a finanzas); un owner no puede
--     quitarse ni ponerse un corte. Cada cambio queda en B.
--   * Ninguna fila de cliente ni PII: solo montos agregados y el slug.
-- Rollback: `drop function core.superadmin_set_whatsapp_agente_techo(uuid, uuid, bigint[], bigint);`
--   `drop function core.whatsapp_agente_techo_estado_for_system(uuid, timestamptz);`
--   `drop table core.whatsapp_agente_techo_evento; drop table core.whatsapp_agente_techo;` (el API cae a "sin_medir" y atiende).

-- A) Configuración por organización
create table core.whatsapp_agente_techo (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  umbrales_aviso_micro_usd bigint[] check (umbrales_aviso_micro_usd is null or (cardinality(umbrales_aviso_micro_usd) between 1 and 10 and 0 < all (umbrales_aviso_micro_usd))),
  corte_micro_usd bigint check (corte_micro_usd is null or corte_micro_usd > 0),
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
  umbrales_aviso_micro_usd bigint[],
  corte_micro_usd bigint,
  ocurrido_en timestamptz not null default now()
);
alter table core.whatsapp_agente_techo_evento enable row level security;
revoke all on core.whatsapp_agente_techo_evento from public, anon, authenticated, service_role;

-- C) Estado del gasto (solo sistema)
create or replace function core.whatsapp_agente_techo_estado_for_system(
  p_organization_id uuid,
  p_ahora timestamptz default now()
)
returns table (gasto_micro_usd bigint, umbrales_aviso_micro_usd bigint[], corte_micro_usd bigint, periodo text, slug text)
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
    select v_llm + v_wa, t.umbrales_aviso_micro_usd, t.corte_micro_usd, to_char(v_local, 'YYYY-MM'), o.slug::text
      from core.organization o
      left join core.whatsapp_agente_techo t on t.organization_id = o.id
     where o.id = p_organization_id;
end;
$$;
revoke all on function core.whatsapp_agente_techo_estado_for_system(uuid, timestamptz) from public, anon;
grant execute on function core.whatsapp_agente_techo_estado_for_system(uuid, timestamptz) to authenticated;

-- D) Configurar (superadmin)
create or replace function core.superadmin_set_whatsapp_agente_techo(
  p_caller_id uuid,
  p_organization_id uuid,
  p_umbrales_aviso_micro_usd bigint[],
  p_corte_micro_usd bigint
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
  if p_umbrales_aviso_micro_usd is not null
     and (cardinality(p_umbrales_aviso_micro_usd) not between 1 and 10 or not (0 < all (p_umbrales_aviso_micro_usd))) then
    raise exception 'superadmin_set_whatsapp_agente_techo: de 1 a 10 umbrales, todos positivos' using errcode = '22023';
  end if;
  if p_corte_micro_usd is not null and p_corte_micro_usd <= 0 then
    raise exception 'superadmin_set_whatsapp_agente_techo: el corte debe ser positivo' using errcode = '22023';
  end if;
  if p_umbrales_aviso_micro_usd is null and p_corte_micro_usd is null then
    delete from core.whatsapp_agente_techo where organization_id = p_organization_id;
  else
    insert into core.whatsapp_agente_techo (organization_id, umbrales_aviso_micro_usd, corte_micro_usd, updated_at, updated_by)
    values (p_organization_id, p_umbrales_aviso_micro_usd, p_corte_micro_usd, now(), p_caller_id)
    on conflict (organization_id) do update
      set umbrales_aviso_micro_usd = excluded.umbrales_aviso_micro_usd, corte_micro_usd = excluded.corte_micro_usd,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;
  insert into core.whatsapp_agente_techo_evento (organization_id, actor_user_id, umbrales_aviso_micro_usd, corte_micro_usd)
  values (p_organization_id, p_caller_id, p_umbrales_aviso_micro_usd, p_corte_micro_usd);
end;
$$;
revoke all on function core.superadmin_set_whatsapp_agente_techo(uuid, uuid, bigint[], bigint) from public, anon;
grant execute on function core.superadmin_set_whatsapp_agente_techo(uuid, uuid, bigint[], bigint) to authenticated;
