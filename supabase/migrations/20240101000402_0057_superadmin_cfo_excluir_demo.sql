-- 0057: el dashboard CFO de plataforma deja de contar las organizaciones DEMO.
--
-- Problema: core.cfo_org_rows (0030) lee TODAS las filas de core.organization. Las demos
-- (`demo-<vertical>` que crea core.ensure_demo_access_for_superadmin y las marcadas en
-- restaurantes.demo_organization) contaban como organizaciones, sucursales activas, cobranza,
-- NRR/GRR y, si se les asignaba plan, MRR: cifras falsas frente a un prospecto o al CFO.
--
-- Cambio: SOLO se redefine core.cfo_org_rows (create or replace, misma firma y mismas columnas);
-- los envoltorios (dashboard, entradas de alertas, foto mensual) la heredan sin tocarse.
-- Demo = id en restaurantes.demo_organization o slug `demo-%` (mismo criterio que
-- get_consola_organizaciones_for_superadmin, 0042). Si la tabla de restaurantes no existe o no es
-- legible, se cae al criterio por slug (begin/exception, sin 500).
--
-- Seguridad: sin cambio de superficie. Sigue siendo security definer con search_path fijo
-- (core, pg_temp) y revoke all de public/anon/authenticated (solo la llaman los envoltorios, que
-- exigen auth.uid() = p_caller_id superadmin, o sistema). No hay GRANT nuevo ni policy nueva. La
-- lectura de restaurantes.demo_organization ocurre dentro del definer; no se expone a nadie.
-- Las filas de historia ya guardadas en core.billing_snapshot_monthly no se reescriben (inmutables).
-- Base sin migrar: este archivo no cambia nada hasta que Javier lo aplica; el TypeScript no cambia.
-- Verificador: scripts/verify-superadmin-cfo-excluir-demo/.

create or replace function core.cfo_org_rows(p_month date)
returns table (
  organization_id uuid, organization_name text, organization_slug text, vertical text, org_status text,
  plan_id text, plan_nombre text, precio_base_mxn_centavos bigint, precio_asiento_mxn_centavos bigint, asientos_incluidos integer,
  billing_status text, billing_seats integer, billing_period_end timestamptz, sucursales_activas integer,
  llm_micro_usd bigint, voz_micro_usd bigint, whatsapp_micro_usd bigint, telefonia_micro_usd bigint, otros_micro_usd bigint,
  eventos_total bigint, eventos_estimados bigint, minutos_voz numeric, mensajes numeric,
  llm_cap_micro_usd bigint, llm_alert_pct numeric, limites jsonb,
  mxn_por_usd numeric, fx_fecha date, fx_fuente text
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_from date;
  v_to date;
  v_tope date;
  v_fx_rate numeric;
  v_fx_fecha date;
  v_fx_fuente text;
  v_demo_ids uuid[] := '{}';
begin
  v_from := date_trunc('month', coalesce(p_month, current_date))::date;
  v_to := (v_from + interval '1 month')::date;
  -- Mismo criterio que elegirTipoCambio (apps/api/src/routes/superadmin-costos.ts): el mas
  -- reciente con fecha <= fin de mes (o <= hoy si es el mes en curso). Sin tipo de cambio, NULL.
  v_tope := case when v_from = date_trunc('month', current_date)::date then current_date else (v_to - 1) end;
  select f.mxn_por_usd, f.fecha, f.fuente into v_fx_rate, v_fx_fecha, v_fx_fuente
    from core.fx_rate f where f.fecha <= v_tope order by f.fecha desc limit 1;
  begin
    select coalesce(array_agg(d.organization_id), '{}') into v_demo_ids from restaurantes.demo_organization d;
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_demo_ids := '{}';
  end;
  return query
    select o.id, o.name, o.slug, o.vertical, o.status,
      pl.id, pl.nombre, pl.precio_base_mxn_centavos, pl.precio_asiento_mxn_centavos, pl.asientos_incluidos,
      ob.status, ob.seats, ob.current_period_end, coalesce(pc.n, 0)::integer,
      coalesce(l.cost, 0)::bigint,
      coalesce(e.voz, 0)::bigint, coalesce(e.whatsapp, 0)::bigint, coalesce(e.telefonia, 0)::bigint, coalesce(e.otros, 0)::bigint,
      coalesce(e.total, 0)::bigint, coalesce(e.estimados, 0)::bigint,
      coalesce(e.minutos_voz, 0)::numeric, coalesce(e.mensajes, 0)::numeric,
      coalesce(b.monthly_cap_micro_usd, core.default_llm_org_monthly_cap_micro_usd())::bigint,
      coalesce(b.alert_threshold_pct, 80)::numeric,
      coalesce((select jsonb_agg(jsonb_build_object('metrica', pm.metrica, 'limite', pm.limite, 'accion', pm.accion_al_exceder) order by pm.metrica)
                from core.plan_limit pm where pm.plan_id = pl.id), '[]'::jsonb),
      v_fx_rate, v_fx_fecha, v_fx_fuente
    from core.organization o
    left join core.organization_plan op on op.organization_id = o.id
    left join core.plan pl on pl.id = op.plan_id
    left join core.organization_billing ob on ob.organization_id = o.id
    left join core.llm_org_budget b on b.organization_id = o.id
    left join lateral (
      select count(*) as n from core.property p where p.organization_id = o.id and p.status = 'active'
    ) pc on true
    left join lateral (
      select sum(u.cost_micro_usd) as cost
      from core.llm_usage_daily u
      where u.organization_id = o.id and u.usage_date >= v_from and u.usage_date < v_to
    ) l on true
    left join lateral (
      select
        sum(x.costo_micro_usd) filter (where x.categoria = 'voz') as voz,
        sum(x.costo_micro_usd) filter (where x.categoria = 'whatsapp') as whatsapp,
        sum(x.costo_micro_usd) filter (where x.categoria = 'telefonia') as telefonia,
        sum(x.costo_micro_usd) filter (where x.categoria in ('sms', 'email', 'storage')) as otros,
        count(*) as total,
        count(*) filter (where x.costo_estimado) as estimados,
        sum(case x.unidad when 'minuto' then x.cantidad when 'segundo' then x.cantidad / 60 else 0 end) filter (where x.categoria = 'voz') as minutos_voz,
        sum(x.cantidad) filter (where x.categoria = 'whatsapp' and x.unidad = 'mensaje') as mensajes
      from core.usage_cost_event x
      where x.organization_id = o.id and x.occurred_at >= v_from::timestamptz and x.occurred_at < v_to::timestamptz
    ) e on true
    where not (o.id = any (v_demo_ids) or o.slug like 'demo-%')
    order by o.name, o.id;
end;
$$;
revoke all on function core.cfo_org_rows(date) from public, anon, authenticated;
