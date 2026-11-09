-- 0085: CFO de la plataforma (cockpit del superadmin) -- supuestos de costo unitario, capturas
-- mensuales del dueño y USO por cliente y mes.
--
-- Compone lo que ya existe sin duplicarlo:
--   * ingreso por plan y foto mensual de MRR: core.cfo_org_rows / core.billing_snapshot_monthly (0030, 0057);
--   * costo medido: core.llm_usage_daily (0010) y core.usage_cost_event (0028);
--   * infraestructura compartida: core.infra_cost_monthly (0032);
--   * tipo de cambio: core.fx_rate (0028);
--   * medidor FACTURABLE de restaurantes (minutos de voz y conversaciones de WhatsApp): la funcion
--     restaurantes.uso_facturable_mes del carril «precios y cobro» (PR #771, migracion 200). Si esa funcion
--     todavia no existe en la base, sus dos columnas salen NULL («sin medidor de cobro»), nunca 0.
--
-- Que agrega:
--   A) core.cfo_supuesto          -- costo unitario configurable (USD por minuto de voz por proveedor, USD de LLM
--                                    por conversacion de WhatsApp...) y umbrales de las alertas. Una fila SOBRESCRIBE
--                                    el valor medido que trae el codigo (packages/billing/src/cockpit/supuestos.ts).
--   B) core.cfo_captura_mensual   -- lo que solo el dueño sabe: gastos fijos, gasto de marketing, saldo de caja y
--                                    presupuesto (ingreso y costo) por mes.
--   C) core.cfo_cockpit_log       -- bitacora append-only de cada cambio de A y B.
--   D) core.cfo_uso_rows          -- cuerpo UNICO (interno) del uso por organizacion y mes: llamadas, segundos de voz
--                                    por proveedor, pedidos por canal, conversaciones y minutos facturables, costo
--                                    medido de LLM y de eventos, y el plan vigente.
--   E) Envoltorios: superadmin (caller-bound) y sistema (cron de alertas).
--
-- Requiere: 0001, 0010, 0012 (core.is_platform_superadmin), 0025/0034 (core.superadmin_require_caller), 0028, 0030.
--
-- No cobra nada, no cambia planes ni topes y no toca Stripe.
--
-- Justificacion de seguridad (cada GRANT/policy/funcion trae su razon):
--   * core.cfo_supuesto, core.cfo_captura_mensual y core.cfo_cockpit_log: RLS habilitado SIN policy y REVOKE ALL a
--     public, anon y authenticated. Razon: son datos financieros internos de la plataforma; ningun rol de la
--     aplicacion los lee ni escribe directo, solo las funciones definer de abajo. Sin GRANT por columna porque no
--     hay columna accesible por rol alguno.
--   * core.cfo_cockpit_log es append-only: un trigger rechaza UPDATE y DELETE (0A000) incluso para el dueño. Sin
--     llaves foraneas (actor_user_id es un uuid plano) para que borrar una cuenta no choque con el trigger.
--   * core.superadmin_set_cfo_supuesto y core.superadmin_set_cfo_captura: security definer, search_path fijo, REVOKE
--     de public/anon, GRANT EXECUTE a authenticated (el back office entra con la sesion del superadmin, sin
--     service_role). La puerta real esta DENTRO: core.superadmin_require_caller exige auth.uid() = p_caller_id,
--     superadmin de plataforma y que NO sea el rol restringido `finanzas` (solo lectura). La ruta del API ademas
--     exige step-up. Claves, tipos, rangos y meses se validan aqui (22023), no solo en la API.
--   * core.list_cfo_supuestos_for_superadmin, core.list_cfo_capturas_for_superadmin y
--     core.get_cfo_uso_for_superadmin: contrato de lectura de las *_for_superadmin: auth.uid() = p_caller_id y
--     core.is_platform_superadmin; si no, CERO filas (nunca un error que confirme si hay datos). GRANT a
--     authenticated, no a anon. El rol `finanzas` SI lee (es una zona de solo lectura para el).
--   * core.list_cfo_supuestos_for_system y core.get_cfo_uso_for_system: solo-sistema (auth.uid() is null, si no
--     42501): las usa el cron de alertas, que corre sin usuario. GRANT a authenticated porque la conexion del cron
--     usa ese rol sin claims; la sesion de un usuario real recibe 42501.
--   * core.cfo_uso_rows: security definer con search_path fijo y REVOKE de public/anon/authenticated: solo la
--     ejecutan los envoltorios (como el dueño) tras validar al llamador. Lee tablas internas de restaurantes
--     (voice_conversation, orders) SOLO en agregado: ningun telefono, hash, nombre ni id de llamada sale de aqui.
--     Las organizaciones demo se excluyen con el mismo criterio que 0057.
--
-- Rollback (manual, en orden; las capturas y supuestos se pierden):
--   drop function if exists core.get_cfo_uso_for_system(date, date);
--   drop function if exists core.get_cfo_uso_for_superadmin(uuid, date, date);
--   drop function if exists core.cfo_uso_rows(uuid, date, date);
--   drop function if exists core.list_cfo_capturas_for_superadmin(uuid, date, date);
--   drop function if exists core.superadmin_set_cfo_captura(uuid, date, text, text, bigint, text);
--   drop function if exists core.list_cfo_supuestos_for_system();
--   drop function if exists core.list_cfo_supuestos_for_superadmin(uuid);
--   drop function if exists core.superadmin_set_cfo_supuesto(uuid, text, text, numeric, text, text);
--   drop function if exists core.cfo_cockpit_log_write(uuid, text, jsonb);
--   drop table if exists core.cfo_cockpit_log;
--   drop function if exists core.cfo_cockpit_log_block_mutation();
--   drop table if exists core.cfo_captura_mensual;
--   drop table if exists core.cfo_supuesto;

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Supuestos (costo unitario y umbrales)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cfo_supuesto (
  clave text not null check (clave in (
    'voz_usd_minuto', 'telefonia_usd_minuto', 'llm_usd_conversacion_wa', 'whatsapp_usd_conversacion',
    'umbral_margen_pct', 'umbral_pool_pct', 'umbral_pico_costo_pct', 'umbral_fx_pct', 'ltv_meses_tope'
  )),
  -- '*' = cualquier proveedor. Solo voz y telefonia distinguen proveedor (el de restaurantes.voice_conversation).
  proveedor text not null default '*' check (proveedor ~ '^(\*|[a-z0-9][a-z0-9.-]{0,40})$'),
  valor numeric(16, 6) not null check (valor >= 0 and valor <= 1000000),
  fuente text not null check (char_length(btrim(fuente)) between 3 and 200),
  nota text check (nota is null or char_length(nota) <= 300),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (clave, proveedor),
  check (proveedor = '*' or clave in ('voz_usd_minuto', 'telefonia_usd_minuto'))
);
alter table core.cfo_supuesto enable row level security;
revoke all on core.cfo_supuesto from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Capturas mensuales del dueño
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cfo_captura_mensual (
  id uuid primary key default gen_random_uuid(),
  mes date not null check (mes = date_trunc('month', mes)::date),
  tipo text not null check (tipo in ('gasto_fijo', 'marketing', 'saldo_caja', 'presupuesto_ingreso', 'presupuesto_costo')),
  concepto text not null check (char_length(btrim(concepto)) between 2 and 80),
  -- Centavos MXN enteros, nunca float. 0 es valido (corregir una captura).
  monto_mxn_centavos bigint not null check (monto_mxn_centavos >= 0 and monto_mxn_centavos <= 100000000000),
  nota text check (nota is null or char_length(nota) <= 300),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index cfo_captura_mensual_uidx on core.cfo_captura_mensual (mes, tipo, lower(btrim(concepto)));
alter table core.cfo_captura_mensual enable row level security;
revoke all on core.cfo_captura_mensual from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Bitacora append-only
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cfo_cockpit_log (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  actor_user_id uuid not null,
  evento text not null check (evento in ('supuesto_set', 'supuesto_borrado', 'captura_set', 'captura_borrada')),
  detalle jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index cfo_cockpit_log_seq_idx on core.cfo_cockpit_log (seq desc);
create or replace function core.cfo_cockpit_log_block_mutation()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  raise exception 'cfo_cockpit_log_append_only: % no esta permitido sobre %', tg_op, tg_table_name using errcode = '0A000';
end;
$$;
create trigger cfo_cockpit_log_block_update_trg before update on core.cfo_cockpit_log
  for each row execute function core.cfo_cockpit_log_block_mutation();
create trigger cfo_cockpit_log_block_delete_trg before delete on core.cfo_cockpit_log
  for each row execute function core.cfo_cockpit_log_block_mutation();
alter table core.cfo_cockpit_log enable row level security;
revoke all on core.cfo_cockpit_log from public, anon, authenticated;

-- Escritura interna de la bitacora (solo la invocan, como dueño, las funciones de escritura de abajo).
create or replace function core.cfo_cockpit_log_write(p_actor uuid, p_evento text, p_detalle jsonb)
returns void language sql security definer set search_path = core, pg_temp as $$
  insert into core.cfo_cockpit_log (actor_user_id, evento, detalle) values (p_actor, p_evento, coalesce(p_detalle, '{}'::jsonb));
$$;
revoke all on function core.cfo_cockpit_log_write(uuid, text, jsonb) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Escritura (superadmin no restringido)
-- ═══════════════════════════════════════════════════════════════════════════
-- p_valor NULL = borrar la fila (se vuelve al valor medido del codigo).
create or replace function core.superadmin_set_cfo_supuesto(
  p_caller_id uuid, p_clave text, p_proveedor text, p_valor numeric, p_fuente text, p_nota text default null
)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_prov text := coalesce(nullif(btrim(p_proveedor), ''), '*');
  v_n integer;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_cfo_supuesto');
  if p_clave is null or p_clave not in (
    'voz_usd_minuto', 'telefonia_usd_minuto', 'llm_usd_conversacion_wa', 'whatsapp_usd_conversacion',
    'umbral_margen_pct', 'umbral_pool_pct', 'umbral_pico_costo_pct', 'umbral_fx_pct', 'ltv_meses_tope'
  ) then
    raise exception 'superadmin_set_cfo_supuesto: clave desconocida' using errcode = '22023';
  end if;
  if v_prov <> '*' and p_clave not in ('voz_usd_minuto', 'telefonia_usd_minuto') then
    raise exception 'superadmin_set_cfo_supuesto: solo voz y telefonia distinguen proveedor' using errcode = '22023';
  end if;
  if p_valor is null then
    delete from core.cfo_supuesto s where s.clave = p_clave and s.proveedor = v_prov;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      perform core.cfo_cockpit_log_write(p_caller_id, 'supuesto_borrado', jsonb_build_object('clave', p_clave, 'proveedor', v_prov));
    end if;
    return;
  end if;
  if p_valor < 0 or p_valor > 1000000 then
    raise exception 'superadmin_set_cfo_supuesto: valor fuera de rango' using errcode = '22023';
  end if;
  if p_clave in ('umbral_margen_pct', 'umbral_pool_pct', 'umbral_pico_costo_pct', 'umbral_fx_pct') and p_valor > 1000 then
    raise exception 'superadmin_set_cfo_supuesto: un umbral es un porcentaje entre 0 y 1000' using errcode = '22023';
  end if;
  if p_fuente is null or char_length(btrim(p_fuente)) not between 3 and 200 then
    raise exception 'superadmin_set_cfo_supuesto: indica la fuente del valor (3 a 200 caracteres)' using errcode = '22023';
  end if;
  if p_nota is not null and char_length(p_nota) > 300 then
    raise exception 'superadmin_set_cfo_supuesto: nota demasiado larga' using errcode = '22023';
  end if;
  insert into core.cfo_supuesto (clave, proveedor, valor, fuente, nota, updated_by, updated_at)
  values (p_clave, v_prov, p_valor, btrim(p_fuente), p_nota, p_caller_id, now())
  on conflict (clave, proveedor) do update set
    valor = excluded.valor, fuente = excluded.fuente, nota = excluded.nota, updated_by = excluded.updated_by, updated_at = now();
  perform core.cfo_cockpit_log_write(p_caller_id, 'supuesto_set',
    jsonb_build_object('clave', p_clave, 'proveedor', v_prov, 'valor', p_valor, 'fuente', btrim(p_fuente)));
end;
$$;
revoke all on function core.superadmin_set_cfo_supuesto(uuid, text, text, numeric, text, text) from public, anon;
grant execute on function core.superadmin_set_cfo_supuesto(uuid, text, text, numeric, text, text) to authenticated;

-- p_monto NULL = borrar el concepto. Meses futuros solo para presupuesto (un gasto o un saldo adelantado moveria
-- el burn de un mes que aun no ocurre); meses pasados si (cierre tardio).
create or replace function core.superadmin_set_cfo_captura(
  p_caller_id uuid, p_mes date, p_tipo text, p_concepto text, p_monto_mxn_centavos bigint, p_nota text default null
)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_mes date;
  v_concepto text := btrim(coalesce(p_concepto, ''));
  v_n integer;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_cfo_captura');
  if p_mes is null then
    raise exception 'superadmin_set_cfo_captura: indica el mes' using errcode = '22023';
  end if;
  v_mes := date_trunc('month', p_mes)::date;
  if p_tipo is null or p_tipo not in ('gasto_fijo', 'marketing', 'saldo_caja', 'presupuesto_ingreso', 'presupuesto_costo') then
    raise exception 'superadmin_set_cfo_captura: tipo desconocido' using errcode = '22023';
  end if;
  if p_tipo not like 'presupuesto_%' and v_mes > date_trunc('month', current_date)::date then
    raise exception 'superadmin_set_cfo_captura: solo el presupuesto admite meses futuros' using errcode = '22023';
  end if;
  if v_mes > (date_trunc('month', current_date) + interval '24 months')::date or v_mes < date '2020-01-01' then
    raise exception 'superadmin_set_cfo_captura: mes fuera de rango' using errcode = '22023';
  end if;
  if char_length(v_concepto) not between 2 and 80 then
    raise exception 'superadmin_set_cfo_captura: concepto de 2 a 80 caracteres' using errcode = '22023';
  end if;
  if p_monto_mxn_centavos is null then
    delete from core.cfo_captura_mensual c where c.mes = v_mes and c.tipo = p_tipo and lower(btrim(c.concepto)) = lower(v_concepto);
    get diagnostics v_n = row_count;
    if v_n > 0 then
      perform core.cfo_cockpit_log_write(p_caller_id, 'captura_borrada', jsonb_build_object('mes', v_mes, 'tipo', p_tipo, 'concepto', v_concepto));
    end if;
    return;
  end if;
  if p_monto_mxn_centavos < 0 or p_monto_mxn_centavos > 100000000000 then
    raise exception 'superadmin_set_cfo_captura: monto fuera de rango' using errcode = '22023';
  end if;
  if p_nota is not null and char_length(p_nota) > 300 then
    raise exception 'superadmin_set_cfo_captura: nota demasiado larga' using errcode = '22023';
  end if;
  insert into core.cfo_captura_mensual (mes, tipo, concepto, monto_mxn_centavos, nota, updated_by)
  values (v_mes, p_tipo, v_concepto, p_monto_mxn_centavos, p_nota, p_caller_id)
  on conflict (mes, tipo, lower(btrim(concepto))) do update set
    concepto = excluded.concepto, monto_mxn_centavos = excluded.monto_mxn_centavos, nota = excluded.nota,
    updated_by = excluded.updated_by, updated_at = now();
  perform core.cfo_cockpit_log_write(p_caller_id, 'captura_set',
    jsonb_build_object('mes', v_mes, 'tipo', p_tipo, 'concepto', v_concepto, 'monto_mxn_centavos', p_monto_mxn_centavos));
end;
$$;
revoke all on function core.superadmin_set_cfo_captura(uuid, date, text, text, bigint, text) from public, anon;
grant execute on function core.superadmin_set_cfo_captura(uuid, date, text, text, bigint, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Lectura de supuestos y capturas
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_cfo_supuestos_for_superadmin(p_caller_id uuid)
returns table (clave text, proveedor text, valor numeric, fuente text, nota text, updated_at timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select s.clave, s.proveedor, s.valor, s.fuente, s.nota, s.updated_at from core.cfo_supuesto s order by s.clave, s.proveedor;
end;
$$;
revoke all on function core.list_cfo_supuestos_for_superadmin(uuid) from public, anon;
grant execute on function core.list_cfo_supuestos_for_superadmin(uuid) to authenticated;

create or replace function core.list_cfo_supuestos_for_system()
returns table (clave text, proveedor text, valor numeric, fuente text, nota text, updated_at timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'list_cfo_supuestos_for_system: solo sesion de sistema' using errcode = '42501';
  end if;
  return query select s.clave, s.proveedor, s.valor, s.fuente, s.nota, s.updated_at from core.cfo_supuesto s order by s.clave, s.proveedor;
end;
$$;
revoke all on function core.list_cfo_supuestos_for_system() from public, anon;
grant execute on function core.list_cfo_supuestos_for_system() to authenticated;

create or replace function core.list_cfo_capturas_for_superadmin(p_caller_id uuid, p_desde date, p_hasta date)
returns table (mes date, tipo text, concepto text, monto_mxn_centavos bigint, nota text, updated_at timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select c.mes, c.tipo, c.concepto, c.monto_mxn_centavos, c.nota, c.updated_at
    from core.cfo_captura_mensual c
    where c.mes >= date_trunc('month', p_desde)::date and c.mes <= date_trunc('month', p_hasta)::date
    order by c.mes, c.tipo, c.concepto
    limit 5000;
end;
$$;
revoke all on function core.list_cfo_capturas_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.list_cfo_capturas_for_superadmin(uuid, date, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Uso por organizacion y mes (interno)
-- ═══════════════════════════════════════════════════════════════════════════
-- p_caller_id: el superadmin ya validado por el envoltorio (o NULL en sesion de sistema). Se pasa tal cual a
-- restaurantes.uso_facturable_mes, que hace su propio caller binding.
-- Rango maximo: 24 meses. Una fila por organizacion NO demo y mes del rango.
create or replace function core.cfo_uso_rows(p_caller_id uuid, p_desde date, p_hasta date)
returns table (
  organization_id uuid, mes date, vertical text,
  llm_micro_usd bigint, eventos_micro_usd bigint,
  llamadas integer, segundos_voz bigint, segundos_por_proveedor jsonb,
  pedidos integer, pedidos_voz integer, pedidos_whatsapp integer,
  conversaciones_wa integer, minutos_facturables bigint,
  plan jsonb
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_desde date := date_trunc('month', p_desde)::date;
  v_hasta date := date_trunc('month', p_hasta)::date;
  v_demo_ids uuid[] := '{}';
  v_hay_voz boolean := to_regclass('restaurantes.voice_conversation') is not null;
  v_hay_pedidos boolean := to_regclass('restaurantes.orders') is not null;
  v_hay_medidor boolean := to_regprocedure('restaurantes.uso_facturable_mes(uuid,uuid,date)') is not null;
  r record;
  v_desde_ts timestamptz;
  v_hasta_ts timestamptz;
  v_uso jsonb;
begin
  if v_desde is null or v_hasta is null or v_hasta < v_desde or v_hasta > (v_desde + interval '23 months')::date then
    raise exception 'cfo_uso_rows: rango invalido (maximo 24 meses)' using errcode = '22023';
  end if;
  begin
    select coalesce(array_agg(d.organization_id), '{}') into v_demo_ids from restaurantes.demo_organization d;
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_demo_ids := '{}';
  end;
  for r in
    select o.id as org_id, o.vertical as org_vertical, o.timezone as tz, m.mes::date as m_mes,
      (select to_jsonb(pl) from core.organization_plan op join core.plan pl on pl.id = op.plan_id where op.organization_id = o.id) as plan_json
    from core.organization o
    cross join generate_series(v_desde, v_hasta, interval '1 month') as m(mes)
    where not (o.id = any (v_demo_ids) or o.slug like 'demo-%')
    order by o.id, m.mes
  loop
    organization_id := r.org_id;
    mes := r.m_mes;
    vertical := r.org_vertical;
    plan := r.plan_json;
    select coalesce(sum(u.cost_micro_usd), 0)::bigint into llm_micro_usd
      from core.llm_usage_daily u
      where u.organization_id = r.org_id and u.usage_date >= r.m_mes and u.usage_date < (r.m_mes + interval '1 month')::date;
    select coalesce(sum(x.costo_micro_usd), 0)::bigint into eventos_micro_usd
      from core.usage_cost_event x
      where x.organization_id = r.org_id and x.occurred_at >= r.m_mes::timestamptz and x.occurred_at < (r.m_mes + interval '1 month')::timestamptz;

    llamadas := null; segundos_voz := null; segundos_por_proveedor := null;
    pedidos := null; pedidos_voz := null; pedidos_whatsapp := null;
    conversaciones_wa := null; minutos_facturables := null;
    if r.org_vertical = 'restaurantes' then
      -- Mes calendario en la zona horaria del negocio (mismo criterio que el medidor de cobro).
      v_desde_ts := r.m_mes::timestamp at time zone coalesce(r.tz, 'America/Mexico_City');
      v_hasta_ts := (r.m_mes + interval '1 month')::timestamp at time zone coalesce(r.tz, 'America/Mexico_City');
      if v_hay_voz then
        -- Llamadas reales cerradas (sin previews ni llamadas en curso), igual que el medidor de cobro.
        select coalesce(sum(t.n), 0)::integer, coalesce(sum(t.s), 0)::bigint,
               coalesce(jsonb_object_agg(t.proveedor, t.s) filter (where t.proveedor is not null), '{}'::jsonb)
          into llamadas, segundos_voz, segundos_por_proveedor
        from (
          select vc.proveedor, sum(vc.duration_s)::bigint as s, count(*) as n
          from restaurantes.voice_conversation vc
          where vc.organization_id = r.org_id and vc.canal = 'llamada' and vc.duration_s is not null
            and vc.started_at >= v_desde_ts and vc.started_at < v_hasta_ts
          group by vc.proveedor
        ) t;
      end if;
      if v_hay_pedidos then
        select count(*)::integer, (count(*) filter (where o2.source = 'voice'))::integer, (count(*) filter (where o2.source = 'whatsapp'))::integer
          into pedidos, pedidos_voz, pedidos_whatsapp
        from restaurantes.orders o2
        where o2.organization_id = r.org_id and o2.status <> 'cancelado'
          and o2.created_at >= v_desde_ts and o2.created_at < v_hasta_ts;
      end if;
      if v_hay_medidor then
        begin
          v_uso := restaurantes.uso_facturable_mes(p_caller_id, r.org_id, r.m_mes);
          if v_uso is not null then
            conversaciones_wa := (v_uso ->> 'conversacionesWa')::integer;
            minutos_facturables := (v_uso ->> 'minutosVoz')::bigint;
          end if;
        exception when undefined_function or undefined_table or undefined_column then
          conversaciones_wa := null;
          minutos_facturables := null;
        end;
      end if;
    end if;
    return next;
  end loop;
end;
$$;
revoke all on function core.cfo_uso_rows(uuid, date, date) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Envoltorios
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.get_cfo_uso_for_superadmin(p_caller_id uuid, p_desde date, p_hasta date)
returns table (
  organization_id uuid, mes date, vertical text,
  llm_micro_usd bigint, eventos_micro_usd bigint,
  llamadas integer, segundos_voz bigint, segundos_por_proveedor jsonb,
  pedidos integer, pedidos_voz integer, pedidos_whatsapp integer,
  conversaciones_wa integer, minutos_facturables bigint,
  plan jsonb
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select * from core.cfo_uso_rows(p_caller_id, p_desde, p_hasta);
end;
$$;
revoke all on function core.get_cfo_uso_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.get_cfo_uso_for_superadmin(uuid, date, date) to authenticated;

create or replace function core.get_cfo_uso_for_system(p_desde date, p_hasta date)
returns table (
  organization_id uuid, mes date, vertical text,
  llm_micro_usd bigint, eventos_micro_usd bigint,
  llamadas integer, segundos_voz bigint, segundos_por_proveedor jsonb,
  pedidos integer, pedidos_voz integer, pedidos_whatsapp integer,
  conversaciones_wa integer, minutos_facturables bigint,
  plan jsonb
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'get_cfo_uso_for_system: solo sesion de sistema' using errcode = '42501';
  end if;
  return query select * from core.cfo_uso_rows(null, p_desde, p_hasta);
end;
$$;
revoke all on function core.get_cfo_uso_for_system(date, date) from public, anon;
grant execute on function core.get_cfo_uso_for_system(date, date) to authenticated;
