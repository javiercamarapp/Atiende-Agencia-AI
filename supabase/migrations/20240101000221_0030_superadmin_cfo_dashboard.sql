-- Superadmin "CFO" -- SA-01 (dashboard ejecutivo), SA-05 (MRR/ARR por vertical y cliente,
-- NRR) y SA-36 (alertas proactivas). Compone lo que ya existe (0028: core.plan,
-- core.organization_plan, core.usage_cost_event, core.fx_rate; 0010: llm_usage_daily y
-- llm_org_budget; 0009: organization_billing) sin duplicar tablas de costo ni de plan.
--
--   A) core.billing_snapshot_monthly -- foto mensual del ingreso esperado por organizacion
--                                        (base del NRR: sin historia no hay expansion,
--                                        contraccion ni churn).
--   B) core.cfo_org_rows(p_month)    -- cuerpo UNICO de lectura (interno, sin GRANT): una fila
--                                        por organizacion con costo del mes, plan, limites,
--                                        cobranza y tipo de cambio vigente.
--   C) Envoltorios: lectura del superadmin (caller-bound), lectura del cron de alertas
--      (solo-sistema) y escritura del snapshot (solo-sistema) + lectura de snapshots.
--
-- Requiere: 0001, 0009 (organization_billing), 0010 (llm_usage_daily, llm_org_budget,
-- default_llm_org_monthly_cap_micro_usd), 0012 (core.is_platform_superadmin) y 0028.
--
-- No cobra nada, no cambia planes ni topes y no toca Stripe: todo es lectura + una foto
-- mensual de solo-sistema.
--
-- Justificacion de seguridad (cada GRANT/policy/funcion trae su razon):
--   * core.billing_snapshot_monthly: RLS habilitado SIN policy y REVOKE ALL a public, anon y
--     authenticated. Razon: el ingreso por cliente es dato financiero de la plataforma; ningun
--     rol de la aplicacion lo lee ni lo escribe directo, solo las funciones definer de abajo.
--     Sin GRANT por columna porque no hay ninguna columna accesible por rol alguno.
--   * core.cfo_org_rows: security definer con search_path fijo, REVOKE de public/anon/
--     authenticated. Razon: sin GRANT no es invocable por ningun cliente; solo la ejecutan los
--     dos envoltorios (que corren como el dueño) tras validar al llamador. Evita copiar la
--     consulta dos veces (una copia podria divergir y mostrar cifras distintas al
--     dashboard y a la alerta).
--   * core.get_cfo_dashboard_for_superadmin: exige auth.uid() = p_caller_id y delega en
--     core.is_platform_superadmin; si no es superadmin devuelve CERO filas (mismo criterio que
--     get_cost_margin_report_for_superadmin). GRANT a authenticated, no a anon.
--   * core.get_cfo_alert_inputs_for_system y core.snapshot_billing_monthly_for_system:
--     solo-sistema (auth.uid() is null, 42501 en caso contrario). Razon: las ejecuta un cron sin
--     usuario; una sesion con usuario no puede ni leer el ingreso de todas las organizaciones por
--     esta via ni fabricar una foto. El snapshot solo admite el mes en curso: la historia ya
--     cerrada no se reescribe.
--   * core.list_billing_snapshots_for_superadmin: caller-bound igual que el dashboard.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Foto mensual del ingreso esperado
-- ═══════════════════════════════════════════════════════════════════════════
create table core.billing_snapshot_monthly (
  organization_id uuid not null references core.organization(id) on delete cascade,
  mes date not null check (mes = date_trunc('month', mes)::date),
  vertical text not null check (vertical in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos')),
  org_status text not null,
  plan_id text,
  billing_status text,
  billing_seats integer check (billing_seats is null or billing_seats >= 0),
  sucursales_activas integer not null check (sucursales_activas >= 0),
  -- Centavos MXN enteros. NULL = no se sabe (sin plan o plan sin precio): jamas 0.
  mrr_mxn_centavos bigint check (mrr_mxn_centavos is null or mrr_mxn_centavos >= 0),
  mrr_razon text check (mrr_razon is null or mrr_razon in ('sin_plan','precio_no_configurado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, mes),
  check ((mrr_mxn_centavos is null) = (mrr_razon is not null))
);
alter table core.billing_snapshot_monthly enable row level security;
revoke all on core.billing_snapshot_monthly from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Cuerpo unico de lectura (interno)
-- ═══════════════════════════════════════════════════════════════════════════
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
begin
  v_from := date_trunc('month', coalesce(p_month, current_date))::date;
  v_to := (v_from + interval '1 month')::date;
  -- Mismo criterio que elegirTipoCambio (apps/api/src/routes/superadmin-costos.ts): el mas
  -- reciente con fecha <= fin de mes (o <= hoy si es el mes en curso). Sin tipo de cambio, NULL.
  v_tope := case when v_from = date_trunc('month', current_date)::date then current_date else (v_to - 1) end;
  select f.mxn_por_usd, f.fecha, f.fuente into v_fx_rate, v_fx_fecha, v_fx_fuente
    from core.fx_rate f where f.fecha <= v_tope order by f.fecha desc limit 1;
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
    order by o.name, o.id;
end;
$$;
revoke all on function core.cfo_org_rows(date) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Envoltorios
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.get_cfo_dashboard_for_superadmin(p_caller_id uuid, p_month date default null)
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
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select * from core.cfo_org_rows(p_month);
end;
$$;
revoke all on function core.get_cfo_dashboard_for_superadmin(uuid, date) from public, anon;
grant execute on function core.get_cfo_dashboard_for_superadmin(uuid, date) to authenticated;

create or replace function core.get_cfo_alert_inputs_for_system(p_month date default null)
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
begin
  if auth.uid() is not null then
    raise exception 'get_cfo_alert_inputs_for_system: solo sesion de sistema' using errcode = '42501';
  end if;
  return query select * from core.cfo_org_rows(p_month);
end;
$$;
revoke all on function core.get_cfo_alert_inputs_for_system(date) from public, anon;
grant execute on function core.get_cfo_alert_inputs_for_system(date) to authenticated;

-- Foto del mes EN CURSO (idempotente: la corrida diaria del cron la deja en su ultimo valor del
-- mes). Misma formula que calcularIngresoEsperado (packages/billing/src/cost-margin.ts):
--   plan sin precio alguno -> NULL con razon; asientos facturables = seats de Stripe si la
--   suscripcion esta 'activa' con seats > 0, si no sucursales activas - asientos incluidos.
create or replace function core.snapshot_billing_monthly_for_system()
returns integer
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_mes date := date_trunc('month', current_date)::date;
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'snapshot_billing_monthly_for_system: solo sesion de sistema' using errcode = '42501';
  end if;
  insert into core.billing_snapshot_monthly (
    organization_id, mes, vertical, org_status, plan_id, billing_status, billing_seats, sucursales_activas,
    mrr_mxn_centavos, mrr_razon, updated_at
  )
  select r.organization_id, v_mes, r.vertical, r.org_status, r.plan_id, r.billing_status, r.billing_seats, r.sucursales_activas,
    case
      when r.plan_id is null then null
      when r.precio_base_mxn_centavos is null and r.precio_asiento_mxn_centavos is null then null
      else coalesce(r.precio_base_mxn_centavos, 0)
        + (case when r.billing_status = 'activa' and coalesce(r.billing_seats, 0) > 0 then r.billing_seats
                else greatest(r.sucursales_activas - coalesce(r.asientos_incluidos, 0), 0) end)::bigint
          * coalesce(r.precio_asiento_mxn_centavos, 0)
    end,
    case
      when r.plan_id is null then 'sin_plan'
      when r.precio_base_mxn_centavos is null and r.precio_asiento_mxn_centavos is null then 'precio_no_configurado'
      else null
    end,
    now()
  from core.cfo_org_rows(v_mes) r
  on conflict (organization_id, mes) do update set
    vertical = excluded.vertical, org_status = excluded.org_status, plan_id = excluded.plan_id,
    billing_status = excluded.billing_status, billing_seats = excluded.billing_seats,
    sucursales_activas = excluded.sucursales_activas, mrr_mxn_centavos = excluded.mrr_mxn_centavos,
    mrr_razon = excluded.mrr_razon, updated_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function core.snapshot_billing_monthly_for_system() from public, anon;
grant execute on function core.snapshot_billing_monthly_for_system() to authenticated;

create or replace function core.list_billing_snapshots_for_superadmin(p_caller_id uuid, p_desde date, p_hasta date)
returns table (
  organization_id uuid, mes date, vertical text, org_status text, plan_id text, billing_status text,
  mrr_mxn_centavos bigint, mrr_razon text
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select s.organization_id, s.mes, s.vertical, s.org_status, s.plan_id, s.billing_status, s.mrr_mxn_centavos, s.mrr_razon
    from core.billing_snapshot_monthly s
    where s.mes >= date_trunc('month', p_desde)::date and s.mes <= date_trunc('month', p_hasta)::date
    order by s.mes, s.organization_id
    limit 20000;
end;
$$;
revoke all on function core.list_billing_snapshots_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.list_billing_snapshots_for_superadmin(uuid, date, date) to authenticated;
