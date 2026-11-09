-- 0103: planes MEDIDOS (cobro) -- cuota fija o precio por sucursal, minutos de voz y conversaciones de WhatsApp
-- incluidos, excedente por unidad, tope de uso justo, cuota de alta, IVA y plan A LA MEDIDA de una sola organizacion.
--
-- Por que: el plan sembrado de restaurantes (0028: 799 MXN por agente de voz) no cubre el costo medido (voz ~85 % del
-- costo; ver docs/COBRO-PLANES-MEDIDOS.md). El precio tiene que vivir en DATOS que el superadmin captura, nunca en el
-- codigo: esta migracion NO siembra ningun precio. Los planes existentes quedan intactos (`modelo_cobro = 'por_asiento'`).
--
-- Que agrega:
--   A) columnas de tarifa en core.plan (todas aditivas, con default neutro);
--   B) dos triggers de integridad para el plan a la medida (`organizacion_exclusiva_id`): solo se asigna a SU
--      organizacion y no se puede reatar a otra mientras este asignado;
--   C) core.superadmin_set_plan_tarifa (superadmin, con bitacora) y core.plan_tarifa_for_org (lectura de la tarifa
--      vigente de una organizacion: miembro de la organizacion, superadmin o sesion de sistema).
--
-- Seguridad:
--   * core.plan sigue sin GRANT a nadie (0028): todo pasa por funciones `security definer` con search_path fijo.
--   * superadmin_set_plan_tarifa exige auth.uid() = p_caller_id y superadmin (core.superadmin_require_caller).
--   * plan_tarifa_for_org: con sesion de usuario exige caller binding y membresia o superadmin (otra org -> null, nunca
--     datos ajenos); sin sesion (auth.uid() is null) es la lectura de sistema que usa el webhook de cobro.
--   * Ningun GRANT a anon.
--
-- Rollback (manual, en orden; la tarifa capturada se pierde):
--   drop function if exists core.plan_tarifa_for_org(uuid, uuid);
--   drop function if exists core.superadmin_set_plan_tarifa(uuid, text, jsonb);
--   drop function if exists core.list_plan_tarifas_for_superadmin(uuid);
--   drop function if exists core.plan_tarifa_json(core.plan);
--   drop trigger if exists organization_plan_exclusiva_trg on core.organization_plan;
--   drop trigger if exists plan_exclusiva_reatar_trg on core.plan;
--   drop function if exists core.organization_plan_exclusiva_check();
--   drop function if exists core.plan_exclusiva_reatar_check();
--   alter table core.plan drop column if exists modelo_cobro, drop column if exists precio_sucursal_mxn_centavos,
--     drop column if exists sucursales_incluidas, drop column if exists minutos_voz_incluidos,
--     drop column if exists minutos_voz_incluidos_por_sucursal, drop column if exists precio_minuto_voz_excedente_mxn_centavos,
--     drop column if exists conversaciones_wa_incluidas, drop column if exists conversaciones_wa_incluidas_por_sucursal,
--     drop column if exists precio_conversacion_wa_excedente_mxn_centavos, drop column if exists uso_justo_pct,
--     drop column if exists cuota_alta_mxn_centavos, drop column if exists tasa_iva_bp,
--     drop column if exists organizacion_exclusiva_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Tarifa en el plan
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.plan
  -- 'por_asiento' = el modelo de 0028 (precio_base + precio_asiento * asientos); 'medido' = este.
  add column modelo_cobro text not null default 'por_asiento' constraint plan_modelo_cobro_chk check (modelo_cobro in ('por_asiento', 'medido')),
  -- Centavos MXN por sucursal ACTIVA arriba de las incluidas. NULL = no se cobra por sucursal.
  add column precio_sucursal_mxn_centavos bigint constraint plan_precio_sucursal_chk check (precio_sucursal_mxn_centavos is null or precio_sucursal_mxn_centavos >= 0),
  add column sucursales_incluidas integer not null default 0 constraint plan_sucursales_incluidas_chk check (sucursales_incluidas between 0 and 10000),
  -- Minutos incluidos al mes = minutos_voz_incluidos + minutos_voz_incluidos_por_sucursal * sucursales cobradas.
  add column minutos_voz_incluidos integer not null default 0 constraint plan_minutos_incluidos_chk check (minutos_voz_incluidos between 0 and 100000000),
  add column minutos_voz_incluidos_por_sucursal integer not null default 0 constraint plan_minutos_por_sucursal_chk check (minutos_voz_incluidos_por_sucursal between 0 and 1000000),
  -- NULL = el excedente NO se cobra (solo se avisa).
  add column precio_minuto_voz_excedente_mxn_centavos bigint constraint plan_precio_minuto_chk check (precio_minuto_voz_excedente_mxn_centavos is null or precio_minuto_voz_excedente_mxn_centavos >= 0),
  add column conversaciones_wa_incluidas integer not null default 0 constraint plan_conv_incluidas_chk check (conversaciones_wa_incluidas between 0 and 100000000),
  add column conversaciones_wa_incluidas_por_sucursal integer not null default 0 constraint plan_conv_por_sucursal_chk check (conversaciones_wa_incluidas_por_sucursal between 0 and 1000000),
  add column precio_conversacion_wa_excedente_mxn_centavos bigint constraint plan_precio_conv_chk check (precio_conversacion_wa_excedente_mxn_centavos is null or precio_conversacion_wa_excedente_mxn_centavos >= 0),
  -- Tope de uso justo en % de lo incluido (150 = hasta 1.5x). Arriba del tope el excedente NO se cobra solo: se avisa y
  -- se renegocia. NULL = sin tope.
  add column uso_justo_pct integer constraint plan_uso_justo_chk check (uso_justo_pct is null or uso_justo_pct between 100 and 1000),
  -- Cuota de alta (una sola vez, primera factura). NULL o 0 = sin cuota.
  add column cuota_alta_mxn_centavos bigint constraint plan_cuota_alta_chk check (cuota_alta_mxn_centavos is null or cuota_alta_mxn_centavos >= 0),
  -- IVA en puntos base (1600 = 16 %). Se traslada en la factura; el precio del plan es SIN IVA.
  add column tasa_iva_bp integer not null default 1600 constraint plan_tasa_iva_chk check (tasa_iva_bp between 0 and 10000),
  -- Plan a la medida: solo asignable a esta organizacion. NULL = plan de lista.
  add column organizacion_exclusiva_id uuid references core.organization(id) on delete restrict;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Integridad del plan a la medida (defensa en la BASE, no solo en la funcion de asignacion)
-- ═══════════════════════════════════════════════════════════════════════════
-- Trigger de integridad (sin security definer: corre con los privilegios de quien escribe, que hoy solo son las
-- funciones security definer de 0028; lee core.plan, que esas funciones ya pueden leer).
create or replace function core.organization_plan_exclusiva_check()
returns trigger language plpgsql set search_path = core, pg_temp as $$
declare
  v_exclusiva uuid;
begin
  select pl.organizacion_exclusiva_id into v_exclusiva from core.plan pl where pl.id = new.plan_id;
  if v_exclusiva is not null and v_exclusiva <> new.organization_id then
    raise exception 'organization_plan: el plan % es a la medida de otra organizacion', new.plan_id using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger organization_plan_exclusiva_trg before insert or update of plan_id, organization_id on core.organization_plan
  for each row execute function core.organization_plan_exclusiva_check();

create or replace function core.plan_exclusiva_reatar_check()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  if new.organizacion_exclusiva_id is not null
     and new.organizacion_exclusiva_id is distinct from old.organizacion_exclusiva_id
     and exists (select 1 from core.organization_plan op where op.plan_id = new.id and op.organization_id <> new.organizacion_exclusiva_id) then
    raise exception 'plan: no se puede volver a la medida de una organizacion un plan asignado a otras' using errcode = '55006';
  end if;
  return new;
end;
$$;
create trigger plan_exclusiva_reatar_trg before update of organizacion_exclusiva_id on core.plan
  for each row execute function core.plan_exclusiva_reatar_check();

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Funciones
-- ═══════════════════════════════════════════════════════════════════════════
-- Forma JSON unica de la tarifa (la misma para superadmin, organizacion y sistema).
create or replace function core.plan_tarifa_json(p_plan core.plan)
returns jsonb language sql stable set search_path = core, pg_temp as $$
  select jsonb_build_object(
    'planId', p_plan.id,
    'nombre', p_plan.nombre,
    'vertical', p_plan.vertical,
    'activo', p_plan.activo,
    'modeloCobro', p_plan.modelo_cobro,
    'cuotaFijaCentavos', p_plan.precio_base_mxn_centavos,
    'precioSucursalCentavos', p_plan.precio_sucursal_mxn_centavos,
    'sucursalesIncluidas', p_plan.sucursales_incluidas,
    'minutosVozIncluidos', p_plan.minutos_voz_incluidos,
    'minutosVozIncluidosPorSucursal', p_plan.minutos_voz_incluidos_por_sucursal,
    'precioMinutoVozExcedenteCentavos', p_plan.precio_minuto_voz_excedente_mxn_centavos,
    'conversacionesWaIncluidas', p_plan.conversaciones_wa_incluidas,
    'conversacionesWaIncluidasPorSucursal', p_plan.conversaciones_wa_incluidas_por_sucursal,
    'precioConversacionWaExcedenteCentavos', p_plan.precio_conversacion_wa_excedente_mxn_centavos,
    'usoJustoPct', p_plan.uso_justo_pct,
    'cuotaAltaCentavos', p_plan.cuota_alta_mxn_centavos,
    'tasaIvaBp', p_plan.tasa_iva_bp,
    'organizacionExclusivaId', p_plan.organizacion_exclusiva_id
  );
$$;
-- Helper interno: solo lo invocan, como DUEÑO, las funciones de abajo.
revoke all on function core.plan_tarifa_json(core.plan) from public, anon, authenticated;

-- Superadmin: fija la tarifa de un plan YA existente (nombre/vertical/cuota fija siguen en superadmin_upsert_plan).
-- `p_tarifa` solo acepta las claves de abajo; una clave ausente conserva el valor actual. Seguridad: caller binding +
-- superadmin (superadmin_require_caller), bitacora append-only `plan_upserted` con la tarifa completa.
create or replace function core.superadmin_set_plan_tarifa(p_caller_id uuid, p_plan_id text, p_tarifa jsonb)
returns jsonb language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_plan core.plan;
  v_permitidas constant text[] := array[
    'modeloCobro', 'precioSucursalCentavos', 'sucursalesIncluidas', 'minutosVozIncluidos', 'minutosVozIncluidosPorSucursal',
    'precioMinutoVozExcedenteCentavos', 'conversacionesWaIncluidas', 'conversacionesWaIncluidasPorSucursal',
    'precioConversacionWaExcedenteCentavos', 'usoJustoPct', 'cuotaAltaCentavos', 'tasaIvaBp', 'organizacionExclusivaId'
  ];
  v_clave text;
  v_org_vertical text;
  v_exclusiva uuid;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_plan_tarifa');
  if p_tarifa is null or jsonb_typeof(p_tarifa) <> 'object' then
    raise exception 'superadmin_set_plan_tarifa: la tarifa debe ser un objeto' using errcode = '22023';
  end if;
  for v_clave in select jsonb_object_keys(p_tarifa) loop
    if not (v_clave = any (v_permitidas)) then
      raise exception 'superadmin_set_plan_tarifa: clave desconocida %', v_clave using errcode = '22023';
    end if;
    if v_clave not in ('modeloCobro', 'organizacionExclusivaId')
       and jsonb_typeof(p_tarifa -> v_clave) not in ('number', 'null') then
      raise exception 'superadmin_set_plan_tarifa: % debe ser un entero o null', v_clave using errcode = '22023';
    end if;
    if jsonb_typeof(p_tarifa -> v_clave) = 'number' and (p_tarifa ->> v_clave)::numeric <> trunc((p_tarifa ->> v_clave)::numeric) then
      raise exception 'superadmin_set_plan_tarifa: % debe ser entero (centavos, minutos o conversaciones)', v_clave using errcode = '22023';
    end if;
  end loop;

  if p_tarifa ? 'modeloCobro' and coalesce(p_tarifa ->> 'modeloCobro', '') not in ('por_asiento', 'medido') then
    raise exception 'superadmin_set_plan_tarifa: modeloCobro debe ser por_asiento o medido' using errcode = '22023';
  end if;
  if p_tarifa ? 'organizacionExclusivaId' and jsonb_typeof(p_tarifa -> 'organizacionExclusivaId') not in ('string', 'null') then
    raise exception 'superadmin_set_plan_tarifa: organizacionExclusivaId debe ser un uuid o null' using errcode = '22023';
  end if;

  select * into v_plan from core.plan pl where pl.id = p_plan_id for update;
  if not found then
    raise exception 'superadmin_set_plan_tarifa: el plan no existe' using errcode = 'P0002';
  end if;

  v_exclusiva := case when p_tarifa ? 'organizacionExclusivaId' then nullif(p_tarifa ->> 'organizacionExclusivaId', '')::uuid else v_plan.organizacion_exclusiva_id end;
  if v_exclusiva is not null then
    select o.vertical into v_org_vertical from core.organization o where o.id = v_exclusiva;
    if v_org_vertical is null then
      raise exception 'superadmin_set_plan_tarifa: la organizacion del plan a la medida no existe' using errcode = 'P0002';
    end if;
    if v_org_vertical <> v_plan.vertical then
      raise exception 'superadmin_set_plan_tarifa: la organizacion es de otra vertical' using errcode = '22023';
    end if;
  end if;

  update core.plan pl set
    modelo_cobro = case when p_tarifa ? 'modeloCobro' then p_tarifa ->> 'modeloCobro' else pl.modelo_cobro end,
    precio_sucursal_mxn_centavos = case when p_tarifa ? 'precioSucursalCentavos' then (p_tarifa ->> 'precioSucursalCentavos')::bigint else pl.precio_sucursal_mxn_centavos end,
    sucursales_incluidas = case when p_tarifa ? 'sucursalesIncluidas' then coalesce((p_tarifa ->> 'sucursalesIncluidas')::integer, 0) else pl.sucursales_incluidas end,
    minutos_voz_incluidos = case when p_tarifa ? 'minutosVozIncluidos' then coalesce((p_tarifa ->> 'minutosVozIncluidos')::integer, 0) else pl.minutos_voz_incluidos end,
    minutos_voz_incluidos_por_sucursal = case when p_tarifa ? 'minutosVozIncluidosPorSucursal' then coalesce((p_tarifa ->> 'minutosVozIncluidosPorSucursal')::integer, 0) else pl.minutos_voz_incluidos_por_sucursal end,
    precio_minuto_voz_excedente_mxn_centavos = case when p_tarifa ? 'precioMinutoVozExcedenteCentavos' then (p_tarifa ->> 'precioMinutoVozExcedenteCentavos')::bigint else pl.precio_minuto_voz_excedente_mxn_centavos end,
    conversaciones_wa_incluidas = case when p_tarifa ? 'conversacionesWaIncluidas' then coalesce((p_tarifa ->> 'conversacionesWaIncluidas')::integer, 0) else pl.conversaciones_wa_incluidas end,
    conversaciones_wa_incluidas_por_sucursal = case when p_tarifa ? 'conversacionesWaIncluidasPorSucursal' then coalesce((p_tarifa ->> 'conversacionesWaIncluidasPorSucursal')::integer, 0) else pl.conversaciones_wa_incluidas_por_sucursal end,
    precio_conversacion_wa_excedente_mxn_centavos = case when p_tarifa ? 'precioConversacionWaExcedenteCentavos' then (p_tarifa ->> 'precioConversacionWaExcedenteCentavos')::bigint else pl.precio_conversacion_wa_excedente_mxn_centavos end,
    uso_justo_pct = case when p_tarifa ? 'usoJustoPct' then (p_tarifa ->> 'usoJustoPct')::integer else pl.uso_justo_pct end,
    cuota_alta_mxn_centavos = case when p_tarifa ? 'cuotaAltaCentavos' then (p_tarifa ->> 'cuotaAltaCentavos')::bigint else pl.cuota_alta_mxn_centavos end,
    tasa_iva_bp = case when p_tarifa ? 'tasaIvaBp' then coalesce((p_tarifa ->> 'tasaIvaBp')::integer, 1600) else pl.tasa_iva_bp end,
    organizacion_exclusiva_id = v_exclusiva,
    updated_at = now(),
    updated_by = p_caller_id
  where pl.id = p_plan_id
  returning * into v_plan;

  perform core.plan_audit_write('plan_upserted', p_caller_id, v_exclusiva, p_plan_id, jsonb_build_object('tarifa', core.plan_tarifa_json(v_plan)));
  return core.plan_tarifa_json(v_plan);
end;
$$;
revoke all on function core.superadmin_set_plan_tarifa(uuid, text, jsonb) from public, anon;
-- authenticated: el control real es superadmin_require_caller (caller binding + superadmin).
grant execute on function core.superadmin_set_plan_tarifa(uuid, text, jsonb) to authenticated;

-- Superadmin: tarifas de todo el catalogo (la pantalla de Planes las muestra junto a list_plans_for_superadmin).
-- Seguridad: caller binding + superadmin; cualquier otro -> 0 filas (mismo criterio que list_plans_for_superadmin).
create or replace function core.list_plan_tarifas_for_superadmin(p_caller_id uuid)
returns setof jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select core.plan_tarifa_json(pl) from core.plan pl order by pl.vertical, pl.id;
end;
$$;
revoke all on function core.list_plan_tarifas_for_superadmin(uuid) from public, anon;
grant execute on function core.list_plan_tarifas_for_superadmin(uuid) to authenticated;

-- Tarifa vigente de UNA organizacion + sucursales activas (lo que se cobra por sucursal).
--   * Sesion de usuario: auth.uid() = p_caller_id y (miembro de la organizacion o superadmin); si no -> null.
--   * Sesion de sistema (auth.uid() is null): el webhook de cobro y el calculo de excedente. p_caller_id se ignora.
-- Organizacion sin plan -> jsonb con 'plan' null (honesto: no hay tarifa, no se inventa).
create or replace function core.plan_tarifa_for_org(p_caller_id uuid, p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_plan core.plan;
  v_org record;
  v_sucursales integer;
begin
  if auth.uid() is not null then
    if auth.uid() <> p_caller_id then
      raise exception 'plan_tarifa_for_org: caller binding invalido' using errcode = '42501';
    end if;
    if not (
      exists (select 1 from core.membership m where m.user_id = p_caller_id and m.organization_id = p_organization_id)
      or core.is_platform_superadmin(p_caller_id)
    ) then
      return null;
    end if;
  end if;
  select o.id, o.vertical, o.timezone into v_org from core.organization o where o.id = p_organization_id;
  if v_org.id is null then
    return null;
  end if;
  select count(*)::integer into v_sucursales from core.property p where p.organization_id = p_organization_id and p.status = 'active';
  select pl.* into v_plan from core.organization_plan op join core.plan pl on pl.id = op.plan_id where op.organization_id = p_organization_id;
  return jsonb_build_object(
    'organizationId', p_organization_id,
    'vertical', v_org.vertical,
    'zonaHoraria', v_org.timezone,
    'sucursalesActivas', v_sucursales,
    'plan', case when v_plan.id is null then null else core.plan_tarifa_json(v_plan) end
  );
end;
$$;
revoke all on function core.plan_tarifa_for_org(uuid, uuid) from public, anon;
grant execute on function core.plan_tarifa_for_org(uuid, uuid) to authenticated;
