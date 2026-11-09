-- 0106: Stripe ligado al plan (lista permitida de precios), reporte de uso medido, cobranza de pagos fallidos y gancho de
-- CFDI de la suscripcion. Requiere 0103-0105.
--
-- A) core.plan_stripe_precio: LISTA PERMITIDA de precios de Stripe por plan y componente. El checkout y la suscripcion por
--    SPEI solo usan precios de aqui (antes `priceId` llegaba como texto libre). Componentes:
--      cuota_fija (cantidad 1), sucursal (cantidad = sucursales activas), alta (pago unico en la primera factura),
--      minuto_voz_excedente y conversacion_wa_excedente (precios MEDIDOS de Stripe con su `meter_event_name`).
-- B) core.cobro_uso_reportado: cuanto excedente ya se reporto a Stripe por organizacion, periodo y metrica. El reporte diario
--    manda solo la diferencia (idempotente y sin doble cobro aunque el cron corra dos veces).
-- C) core.cobranza_estado + core.cobranza_registrar_evento: maquina de cobranza (al_corriente -> aviso -> gracia ->
--    pausa_sugerida). La PAUSA nunca es automatica: la decide un humano (mismo criterio que suspender en 0072).
-- D) core.cfdi_suscripcion_solicitud: cola de CFDI de ingreso por cada factura pagada. Sin PAC configurado queda
--    'pendiente_pac' (no se timbra nada sin credenciales).
--
-- Seguridad: tablas con RLS sin policy y REVOKE ALL a public/anon/authenticated. Escrituras de superadmin con
-- superadmin_require_caller + bitacora; funciones de sistema (webhook, cron) exigen auth.uid() is null; lecturas caller-bound
-- (miembro o superadmin; otro -> null). Ningun GRANT a anon.
--
-- Rollback (manual):
--   drop function if exists core.cfdi_suscripcion_pendientes(uuid, integer);
--   drop function if exists core.cfdi_suscripcion_encolar(uuid, text, bigint, bigint, text);
--   drop function if exists core.cobranza_de_organizacion(uuid, uuid);
--   drop function if exists core.cobranza_registrar_evento(uuid, text, text, integer, bigint);
--   drop function if exists core.cobro_uso_reportar(uuid, date, text, bigint);
--   drop function if exists core.plan_stripe_precios_para_org(uuid, uuid);
--   drop function if exists core.superadmin_set_plan_stripe_precio(uuid, text, text, text, text);
--   drop table if exists core.cfdi_suscripcion_solicitud, core.cobranza_estado, core.cobro_uso_reportado, core.plan_stripe_precio;

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Lista permitida de precios de Stripe
-- ═══════════════════════════════════════════════════════════════════════════
create table core.plan_stripe_precio (
  plan_id text not null references core.plan(id) on delete cascade,
  componente text not null check (componente in ('cuota_fija', 'sucursal', 'alta', 'minuto_voz_excedente', 'conversacion_wa_excedente')),
  stripe_price_id text not null unique check (stripe_price_id ~ '^price_[A-Za-z0-9]{8,64}$'),
  -- Solo precios medidos: nombre del evento del meter de Stripe al que se reporta el uso.
  meter_event_name text check (meter_event_name is null or meter_event_name ~ '^[a-z][a-z0-9_]{2,99}$'),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  primary key (plan_id, componente),
  constraint plan_stripe_precio_medido_chk check ((componente in ('minuto_voz_excedente', 'conversacion_wa_excedente')) = (meter_event_name is not null))
);
alter table core.plan_stripe_precio enable row level security;
revoke all on core.plan_stripe_precio from public, anon, authenticated;

-- Superadmin: fija (o quita con p_price_id null) el precio de Stripe de un componente. La API ya valido el precio contra Stripe
-- (recurrente/activo/MXN/> 0 o pago unico para `alta`); aqui se exige superadmin y queda en bitacora.
create or replace function core.superadmin_set_plan_stripe_precio(p_caller_id uuid, p_plan_id text, p_componente text, p_price_id text, p_meter_event_name text)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_plan_stripe_precio');
  if not exists (select 1 from core.plan pl where pl.id = p_plan_id) then
    raise exception 'superadmin_set_plan_stripe_precio: el plan no existe' using errcode = 'P0002';
  end if;
  if p_price_id is null then
    delete from core.plan_stripe_precio sp where sp.plan_id = p_plan_id and sp.componente = p_componente;
  else
    insert into core.plan_stripe_precio (plan_id, componente, stripe_price_id, meter_event_name, creado_por)
    values (p_plan_id, p_componente, p_price_id, p_meter_event_name, p_caller_id)
    on conflict (plan_id, componente) do update set stripe_price_id = excluded.stripe_price_id, meter_event_name = excluded.meter_event_name,
      creado_por = excluded.creado_por, creado_en = now();
  end if;
  perform core.plan_audit_write('plan_upserted', p_caller_id, null, p_plan_id, jsonb_build_object('stripe_precio', jsonb_build_object(
    'componente', p_componente, 'price_id', p_price_id, 'meter_event_name', p_meter_event_name)));
end;
$$;
revoke all on function core.superadmin_set_plan_stripe_precio(uuid, text, text, text, text) from public, anon;
grant execute on function core.superadmin_set_plan_stripe_precio(uuid, text, text, text, text) to authenticated;

-- Precios permitidos del plan de UNA organizacion (+ sucursales activas). Usuario: caller binding + miembro o superadmin
-- (otro -> null). Sistema: el reporte de uso y el webhook.
create or replace function core.plan_stripe_precios_para_org(p_caller_id uuid, p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_plan text;
begin
  if auth.uid() is not null then
    if auth.uid() <> p_caller_id then
      raise exception 'plan_stripe_precios_para_org: caller binding invalido' using errcode = '42501';
    end if;
    if not (exists (select 1 from core.membership m where m.user_id = p_caller_id and m.organization_id = p_organization_id) or core.is_platform_superadmin(p_caller_id)) then
      return null;
    end if;
  end if;
  select op.plan_id into v_plan from core.organization_plan op where op.organization_id = p_organization_id;
  return jsonb_build_object(
    'organizationId', p_organization_id,
    'planId', v_plan,
    'sucursalesActivas', (select count(*) from core.property p where p.organization_id = p_organization_id and p.status = 'active'),
    'precios', coalesce((select jsonb_agg(jsonb_build_object('componente', sp.componente, 'priceId', sp.stripe_price_id, 'meterEventName', sp.meter_event_name) order by sp.componente)
                         from core.plan_stripe_precio sp where sp.plan_id = v_plan), '[]'::jsonb)
  );
end;
$$;
revoke all on function core.plan_stripe_precios_para_org(uuid, uuid) from public, anon;
grant execute on function core.plan_stripe_precios_para_org(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Uso reportado a Stripe
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cobro_uso_reportado (
  organization_id uuid not null references core.organization(id) on delete cascade,
  periodo date not null check (extract(day from periodo) = 1),
  metrica text not null check (metrica in ('minuto_voz', 'conversacion_wa')),
  unidades bigint not null check (unidades >= 0),
  actualizado_en timestamptz not null default now(),
  primary key (organization_id, periodo, metrica)
);
alter table core.cobro_uso_reportado enable row level security;
revoke all on core.cobro_uso_reportado from public, anon, authenticated;

-- SOLO sistema: el excedente cobrable acumulado del periodo es `p_unidades_totales`; devuelve cuanto FALTA reportar (>= 0) y
-- deja anotado el nuevo total. Nunca baja (un total menor no "devuelve" uso ya reportado).
create or replace function core.cobro_uso_reportar(p_organization_id uuid, p_periodo date, p_metrica text, p_unidades_totales bigint)
returns bigint language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_previo bigint;
begin
  if auth.uid() is not null then
    raise exception 'cobro_uso_reportar: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_unidades_totales is null or p_unidades_totales < 0 then
    raise exception 'cobro_uso_reportar: unidades invalidas' using errcode = '22023';
  end if;
  select r.unidades into v_previo from core.cobro_uso_reportado r
  where r.organization_id = p_organization_id and r.periodo = date_trunc('month', p_periodo)::date and r.metrica = p_metrica for update;
  if v_previo is null then
    insert into core.cobro_uso_reportado (organization_id, periodo, metrica, unidades) values (p_organization_id, date_trunc('month', p_periodo)::date, p_metrica, p_unidades_totales);
    return p_unidades_totales;
  end if;
  if p_unidades_totales <= v_previo then
    return 0;
  end if;
  update core.cobro_uso_reportado r set unidades = p_unidades_totales, actualizado_en = now()
  where r.organization_id = p_organization_id and r.periodo = date_trunc('month', p_periodo)::date and r.metrica = p_metrica;
  return p_unidades_totales - v_previo;
end;
$$;
revoke all on function core.cobro_uso_reportar(uuid, date, text, bigint) from public, anon;
grant execute on function core.cobro_uso_reportar(uuid, date, text, bigint) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Cobranza
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cobranza_estado (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  estado text not null check (estado in ('al_corriente', 'aviso', 'gracia', 'pausa_sugerida')),
  intentos_fallidos integer not null default 0 check (intentos_fallidos >= 0),
  factura_id text check (factura_id is null or factura_id ~ '^in_[A-Za-z0-9]{8,64}$'),
  monto_pendiente_centavos bigint check (monto_pendiente_centavos is null or monto_pendiente_centavos >= 0),
  primer_fallo_en timestamptz,
  actualizado_en timestamptz not null default now()
);
alter table core.cobranza_estado enable row level security;
revoke all on core.cobranza_estado from public, anon, authenticated;

-- SOLO sistema (webhook). p_evento: 'pago_fallido' | 'pagada'. Reglas: 1er fallo -> aviso; 2o -> gracia; 3o o 7 dias desde
-- el primer fallo -> pausa_sugerida. 'pagada' -> al_corriente. Devuelve el estado anterior y el nuevo.
create or replace function core.cobranza_registrar_evento(p_organization_id uuid, p_evento text, p_factura_id text, p_intento integer, p_monto_centavos bigint)
returns jsonb language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_prev core.cobranza_estado;
  v_estado text;
  v_intentos integer;
  v_primer timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'cobranza_registrar_evento: solo sesion de sistema' using errcode = '42501';
  end if;
  if p_evento not in ('pago_fallido', 'pagada') then
    raise exception 'cobranza_registrar_evento: evento invalido' using errcode = '22023';
  end if;
  select * into v_prev from core.cobranza_estado c where c.organization_id = p_organization_id for update;
  if p_evento = 'pagada' then
    v_estado := 'al_corriente'; v_intentos := 0; v_primer := null;
  else
    v_intentos := greatest(coalesce(v_prev.intentos_fallidos, 0) + 1, coalesce(p_intento, 0));
    v_primer := coalesce(v_prev.primer_fallo_en, now());
    v_estado := case
      when v_intentos >= 3 or now() - v_primer >= interval '7 days' then 'pausa_sugerida'
      when v_intentos = 2 then 'gracia'
      else 'aviso' end;
  end if;
  insert into core.cobranza_estado (organization_id, estado, intentos_fallidos, factura_id, monto_pendiente_centavos, primer_fallo_en)
  values (p_organization_id, v_estado, v_intentos, p_factura_id, case when p_evento = 'pagada' then null else p_monto_centavos end, v_primer)
  on conflict (organization_id) do update set estado = excluded.estado, intentos_fallidos = excluded.intentos_fallidos, factura_id = excluded.factura_id,
    monto_pendiente_centavos = excluded.monto_pendiente_centavos, primer_fallo_en = excluded.primer_fallo_en, actualizado_en = now();
  return jsonb_build_object('anterior', coalesce(v_prev.estado, 'al_corriente'), 'nuevo', v_estado, 'intentos', v_intentos);
end;
$$;
revoke all on function core.cobranza_registrar_evento(uuid, text, text, integer, bigint) from public, anon;
grant execute on function core.cobranza_registrar_evento(uuid, text, text, integer, bigint) to authenticated;

-- Estado de cobranza de una organizacion: miembro o superadmin (otro -> null).
create or replace function core.cobranza_de_organizacion(p_caller_id uuid, p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v core.cobranza_estado;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'cobranza_de_organizacion: caller binding invalido' using errcode = '42501';
  end if;
  if not (exists (select 1 from core.membership m where m.user_id = p_caller_id and m.organization_id = p_organization_id) or core.is_platform_superadmin(p_caller_id)) then
    return null;
  end if;
  select * into v from core.cobranza_estado c where c.organization_id = p_organization_id;
  return jsonb_build_object('estado', coalesce(v.estado, 'al_corriente'), 'intentosFallidos', coalesce(v.intentos_fallidos, 0),
    'montoPendienteCentavos', v.monto_pendiente_centavos, 'primerFalloEn', v.primer_fallo_en);
end;
$$;
revoke all on function core.cobranza_de_organizacion(uuid, uuid) from public, anon;
grant execute on function core.cobranza_de_organizacion(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) CFDI de la suscripcion (cola; el timbrado real depende del PAC)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cfdi_suscripcion_solicitud (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  stripe_invoice_id text not null unique check (stripe_invoice_id ~ '^in_[A-Za-z0-9]{8,64}$'),
  subtotal_centavos bigint not null check (subtotal_centavos >= 0),
  iva_centavos bigint not null check (iva_centavos >= 0),
  estado text not null default 'pendiente_pac' check (estado in ('pendiente_pac', 'timbrado', 'error')),
  uuid_fiscal text,
  detalle text check (detalle is null or char_length(detalle) <= 500),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
alter table core.cfdi_suscripcion_solicitud enable row level security;
revoke all on core.cfdi_suscripcion_solicitud from public, anon, authenticated;

-- SOLO sistema (webhook invoice.paid): encola una vez por factura (idempotente por stripe_invoice_id).
create or replace function core.cfdi_suscripcion_encolar(p_organization_id uuid, p_stripe_invoice_id text, p_subtotal_centavos bigint, p_iva_centavos bigint, p_detalle text)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'cfdi_suscripcion_encolar: solo sesion de sistema' using errcode = '42501';
  end if;
  insert into core.cfdi_suscripcion_solicitud (organization_id, stripe_invoice_id, subtotal_centavos, iva_centavos, detalle)
  values (p_organization_id, p_stripe_invoice_id, p_subtotal_centavos, p_iva_centavos, left(p_detalle, 500))
  on conflict (stripe_invoice_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;
revoke all on function core.cfdi_suscripcion_encolar(uuid, text, bigint, bigint, text) from public, anon;
grant execute on function core.cfdi_suscripcion_encolar(uuid, text, bigint, bigint, text) to authenticated;

-- Superadmin: CFDI pendientes (caller binding + superadmin; otro -> 0 filas).
create or replace function core.cfdi_suscripcion_pendientes(p_caller_id uuid, p_limit integer default 100)
returns setof jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select jsonb_build_object('id', s.id, 'organizationId', s.organization_id, 'stripeInvoiceId', s.stripe_invoice_id, 'subtotalCentavos', s.subtotal_centavos,
      'ivaCentavos', s.iva_centavos, 'estado', s.estado, 'detalle', s.detalle, 'creadoEn', s.creado_en)
    from core.cfdi_suscripcion_solicitud s where s.estado <> 'timbrado' order by s.creado_en desc limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;
revoke all on function core.cfdi_suscripcion_pendientes(uuid, integer) from public, anon;
grant execute on function core.cfdi_suscripcion_pendientes(uuid, integer) to authenticated;
