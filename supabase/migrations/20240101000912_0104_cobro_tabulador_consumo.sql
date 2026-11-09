-- 0104: TABULADOR por sucursal, cuota de alta por sucursal, costos unitarios para el margen y reclamo de avisos de bolsa.
-- Requiere 0103 (tarifa medida en core.plan).
--
-- Que agrega:
--   A) core.plan_tramo_sucursal: el precio por sucursal depende del TOTAL de sucursales activas de la cuenta (escalon por
--      volumen, no tramos acumulados): con 7 sucursales y un tramo 6-9, las 7 pagan el precio del tramo 6-9. Un tramo con
--      precio NULL es «a cotizar» (la factura no se calcula sola: se asigna un plan a la medida). Sin tramos, rige
--      core.plan.precio_sucursal_mxn_centavos (0103).
--   B) core.plan.cuota_alta_por_sucursal_mxn_centavos (alta por sucursal, una vez; ademas de la cuota de alta fija de 0103).
--   C) core.cobro_costo_unitario: costo por minuto de voz, por conversacion de WhatsApp, fijo mensual por sucursal, fijo
--      mensual por organizacion y comision de tarjeta (porcentaje y fijo; el IVA de la comision se suma aparte), en MXN, capturado por el superadmin (el margen por organizacion sale de aqui; ningun costo vive en el codigo).
--   D) core.cobro_aviso_bolsa: reclamo idempotente de los avisos de bolsa (80 %, 100 % y uso justo) por organizacion, mes,
--      metrica y umbral: el aviso sale UNA vez aunque el cron corra varias veces.
--   E) core.plan_tarifa_json redefinida (misma firma) para incluir tramos y la cuota de alta por sucursal, y
--      core.superadmin_cobro_organizaciones: organizaciones con plan medido para la vista de superadmin.
--
-- Seguridad:
--   * Tablas nuevas con RLS habilitado SIN policy y REVOKE ALL a public/anon/authenticated: solo se tocan por funciones
--     security definer con search_path fijo.
--   * Escrituras de superadmin: core.superadmin_require_caller (caller binding + superadmin, excluye el rol finanzas) y
--     bitacora append-only core.plan_audit_log.
--   * core.cobro_reclamar_aviso_bolsa: SOLO sistema (auth.uid() is null).
--   * Lecturas de superadmin: caller binding + superadmin; cualquier otro -> 0 filas.
--   * Ningun GRANT a anon.
--
-- Rollback (manual, en orden):
--   drop function if exists core.superadmin_cobro_organizaciones(uuid);
--   drop function if exists core.cobro_reclamar_aviso_bolsa(uuid, date, text, integer);
--   drop function if exists core.superadmin_set_cobro_costo_unitario(uuid, text, numeric, text);
--   drop function if exists core.cobro_costos_unitarios(uuid);
--   drop function if exists core.superadmin_set_plan_tramos(uuid, text, jsonb);
--   drop function if exists core.superadmin_set_plan_cuota_alta_sucursal(uuid, text, bigint);
--   drop table if exists core.cobro_aviso_bolsa, core.cobro_costo_unitario, core.plan_tramo_sucursal;
--   alter table core.plan drop column if exists cuota_alta_por_sucursal_mxn_centavos;
--   -- y volver a crear core.plan_tarifa_json con el cuerpo de 0103.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Tabulador
-- ═══════════════════════════════════════════════════════════════════════════
create table core.plan_tramo_sucursal (
  plan_id text not null references core.plan(id) on delete cascade,
  desde_sucursales integer not null check (desde_sucursales between 1 and 100000),
  -- NULL = sin limite superior («20 o mas»).
  hasta_sucursales integer check (hasta_sucursales is null or hasta_sucursales >= desde_sucursales),
  -- NULL = a cotizar.
  precio_sucursal_mxn_centavos bigint check (precio_sucursal_mxn_centavos is null or precio_sucursal_mxn_centavos >= 0),
  -- Bolsa por sucursal PROPIA del tramo (para sostener el margen en tramos baratos). NULL = la del plan (0103).
  minutos_voz_incluidos_por_sucursal integer check (minutos_voz_incluidos_por_sucursal is null or minutos_voz_incluidos_por_sucursal between 0 and 1000000),
  conversaciones_wa_incluidas_por_sucursal integer check (conversaciones_wa_incluidas_por_sucursal is null or conversaciones_wa_incluidas_por_sucursal between 0 and 1000000),
  primary key (plan_id, desde_sucursales)
);
alter table core.plan_tramo_sucursal enable row level security;
revoke all on core.plan_tramo_sucursal from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Cuota de alta por sucursal
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.plan
  add column cuota_alta_por_sucursal_mxn_centavos bigint constraint plan_cuota_alta_sucursal_chk check (cuota_alta_por_sucursal_mxn_centavos is null or cuota_alta_por_sucursal_mxn_centavos >= 0);

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Costos unitarios (para el margen)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cobro_costo_unitario (
  clave text primary key check (clave in ('minuto_voz', 'conversacion_wa', 'fijo_mensual_sucursal', 'numero_voz_mensual_sucursal', 'fijo_mensual_organizacion', 'comision_tarjeta_pct', 'comision_tarjeta_fijo_mxn')),
  costo_mxn numeric(14, 4) not null check (costo_mxn >= 0 and costo_mxn < 10000000),
  fuente text not null check (char_length(btrim(fuente)) between 3 and 200),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table core.cobro_costo_unitario enable row level security;
revoke all on core.cobro_costo_unitario from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Reclamo de avisos de bolsa
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cobro_aviso_bolsa (
  organization_id uuid not null references core.organization(id) on delete cascade,
  periodo date not null check (extract(day from periodo) = 1),
  metrica text not null check (metrica in ('minutos_voz', 'conversaciones_wa')),
  umbral integer not null check (umbral in (80, 100, 150)),
  reclamado_en timestamptz not null default now(),
  primary key (organization_id, periodo, metrica, umbral)
);
alter table core.cobro_aviso_bolsa enable row level security;
revoke all on core.cobro_aviso_bolsa from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Funciones
-- ═══════════════════════════════════════════════════════════════════════════
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
    'cuotaAltaPorSucursalCentavos', p_plan.cuota_alta_por_sucursal_mxn_centavos,
    'tasaIvaBp', p_plan.tasa_iva_bp,
    'organizacionExclusivaId', p_plan.organizacion_exclusiva_id,
    'tramosSucursal', coalesce((
      select jsonb_agg(jsonb_build_object('desde', t.desde_sucursales, 'hasta', t.hasta_sucursales, 'precioCentavos', t.precio_sucursal_mxn_centavos,
        'minutosVozIncluidosPorSucursal', t.minutos_voz_incluidos_por_sucursal, 'conversacionesWaIncluidasPorSucursal', t.conversaciones_wa_incluidas_por_sucursal) order by t.desde_sucursales)
      from core.plan_tramo_sucursal t where t.plan_id = p_plan.id
    ), '[]'::jsonb)
  );
$$;
revoke all on function core.plan_tarifa_json(core.plan) from public, anon, authenticated;

-- Superadmin: reemplaza TODO el tabulador de un plan en una sola operacion (atomica). `p_tramos` = arreglo de
-- {desde, hasta|null, precioCentavos|null, minutosVozIncluidosPorSucursal?|null, conversacionesWaIncluidasPorSucursal?|null}; deben ser contiguos desde 1, sin huecos ni traslapes, y solo el ultimo puede
-- quedar abierto (hasta null). Arreglo vacio = quitar el tabulador. Cuota de alta por sucursal opcional en el mismo paso.
create or replace function core.superadmin_set_plan_tramos(p_caller_id uuid, p_plan_id text, p_tramos jsonb)
returns jsonb language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_plan core.plan;
  v_tramo jsonb;
  v_esperado integer := 1;
  v_n integer;
  v_i integer := 0;
  v_desde integer;
  v_hasta integer;
  v_precio bigint;
  v_min integer;
  v_conv integer;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_plan_tramos');
  if p_tramos is null or jsonb_typeof(p_tramos) <> 'array' then
    raise exception 'superadmin_set_plan_tramos: los tramos deben ser un arreglo' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_tramos);
  if v_n > 20 then
    raise exception 'superadmin_set_plan_tramos: maximo 20 tramos' using errcode = '22023';
  end if;
  select * into v_plan from core.plan pl where pl.id = p_plan_id for update;
  if not found then
    raise exception 'superadmin_set_plan_tramos: el plan no existe' using errcode = 'P0002';
  end if;

  delete from core.plan_tramo_sucursal t where t.plan_id = p_plan_id;
  for v_tramo in select value from jsonb_array_elements(p_tramos) loop
    v_i := v_i + 1;
    if jsonb_typeof(v_tramo) <> 'object' or jsonb_typeof(v_tramo -> 'desde') <> 'number'
       or coalesce(jsonb_typeof(v_tramo -> 'hasta'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(v_tramo -> 'precioCentavos'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(v_tramo -> 'minutosVozIncluidosPorSucursal'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(v_tramo -> 'conversacionesWaIncluidasPorSucursal'), 'null') not in ('number', 'null') then
      raise exception 'superadmin_set_plan_tramos: tramo % con forma invalida', v_i using errcode = '22023';
    end if;
    if (v_tramo ->> 'desde')::numeric <> trunc((v_tramo ->> 'desde')::numeric)
       or (v_tramo ? 'hasta' and jsonb_typeof(v_tramo -> 'hasta') = 'number' and (v_tramo ->> 'hasta')::numeric <> trunc((v_tramo ->> 'hasta')::numeric))
       or (jsonb_typeof(v_tramo -> 'precioCentavos') = 'number' and (v_tramo ->> 'precioCentavos')::numeric <> trunc((v_tramo ->> 'precioCentavos')::numeric))
       or (jsonb_typeof(v_tramo -> 'minutosVozIncluidosPorSucursal') = 'number' and (v_tramo ->> 'minutosVozIncluidosPorSucursal')::numeric <> trunc((v_tramo ->> 'minutosVozIncluidosPorSucursal')::numeric))
       or (jsonb_typeof(v_tramo -> 'conversacionesWaIncluidasPorSucursal') = 'number' and (v_tramo ->> 'conversacionesWaIncluidasPorSucursal')::numeric <> trunc((v_tramo ->> 'conversacionesWaIncluidasPorSucursal')::numeric)) then
      raise exception 'superadmin_set_plan_tramos: tramo % debe usar enteros (sucursales y centavos)', v_i using errcode = '22023';
    end if;
    v_desde := (v_tramo ->> 'desde')::integer;
    v_hasta := (v_tramo ->> 'hasta')::integer;
    v_precio := (v_tramo ->> 'precioCentavos')::bigint;
    v_min := (v_tramo ->> 'minutosVozIncluidosPorSucursal')::integer;
    v_conv := (v_tramo ->> 'conversacionesWaIncluidasPorSucursal')::integer;
    if v_desde <> v_esperado then
      raise exception 'superadmin_set_plan_tramos: el tramo % debe empezar en % sucursales (sin huecos ni traslapes)', v_i, v_esperado using errcode = '22023';
    end if;
    if v_hasta is null and v_i < v_n then
      raise exception 'superadmin_set_plan_tramos: solo el ultimo tramo puede quedar abierto' using errcode = '22023';
    end if;
    insert into core.plan_tramo_sucursal (plan_id, desde_sucursales, hasta_sucursales, precio_sucursal_mxn_centavos,
      minutos_voz_incluidos_por_sucursal, conversaciones_wa_incluidas_por_sucursal)
    values (p_plan_id, v_desde, v_hasta, v_precio, v_min, v_conv);
    v_esperado := coalesce(v_hasta, 0) + 1;
  end loop;

  update core.plan pl set updated_at = now(), updated_by = p_caller_id where pl.id = p_plan_id returning * into v_plan;
  perform core.plan_audit_write('plan_upserted', p_caller_id, v_plan.organizacion_exclusiva_id, p_plan_id, jsonb_build_object('tramos', p_tramos));
  return core.plan_tarifa_json(v_plan);
end;
$$;
revoke all on function core.superadmin_set_plan_tramos(uuid, text, jsonb) from public, anon;
grant execute on function core.superadmin_set_plan_tramos(uuid, text, jsonb) to authenticated;

-- 0103 aceptaba solo sus claves; la cuota de alta por sucursal se fija con esta funcion (misma regla de superadmin).
create or replace function core.superadmin_set_plan_cuota_alta_sucursal(p_caller_id uuid, p_plan_id text, p_centavos bigint)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_plan_cuota_alta_sucursal');
  update core.plan pl set cuota_alta_por_sucursal_mxn_centavos = p_centavos, updated_at = now(), updated_by = p_caller_id where pl.id = p_plan_id;
  if not found then
    raise exception 'superadmin_set_plan_cuota_alta_sucursal: el plan no existe' using errcode = 'P0002';
  end if;
  perform core.plan_audit_write('plan_upserted', p_caller_id, null, p_plan_id, jsonb_build_object('cuota_alta_por_sucursal_mxn_centavos', p_centavos));
end;
$$;
revoke all on function core.superadmin_set_plan_cuota_alta_sucursal(uuid, text, bigint) from public, anon;
grant execute on function core.superadmin_set_plan_cuota_alta_sucursal(uuid, text, bigint) to authenticated;

-- Superadmin: costos unitarios vigentes (lectura). Caller binding + superadmin; cualquier otro -> 0 filas.
create or replace function core.cobro_costos_unitarios(p_caller_id uuid)
returns table (clave text, costo_mxn numeric, fuente text, updated_at timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select c.clave, c.costo_mxn, c.fuente, c.updated_at from core.cobro_costo_unitario c order by c.clave;
end;
$$;
revoke all on function core.cobro_costos_unitarios(uuid) from public, anon;
grant execute on function core.cobro_costos_unitarios(uuid) to authenticated;

create or replace function core.superadmin_set_cobro_costo_unitario(p_caller_id uuid, p_clave text, p_costo_mxn numeric, p_fuente text)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_cobro_costo_unitario');
  if p_clave is null or p_clave not in ('minuto_voz', 'conversacion_wa', 'fijo_mensual_sucursal', 'numero_voz_mensual_sucursal', 'fijo_mensual_organizacion', 'comision_tarjeta_pct', 'comision_tarjeta_fijo_mxn') then
    raise exception 'superadmin_set_cobro_costo_unitario: clave invalida' using errcode = '22023';
  end if;
  if p_costo_mxn is null or p_costo_mxn < 0 then
    raise exception 'superadmin_set_cobro_costo_unitario: el costo debe ser >= 0' using errcode = '22023';
  end if;
  if p_fuente is null or char_length(btrim(p_fuente)) < 3 then
    raise exception 'superadmin_set_cobro_costo_unitario: indica la fuente del costo (minimo 3 caracteres)' using errcode = '22023';
  end if;
  insert into core.cobro_costo_unitario (clave, costo_mxn, fuente, updated_by)
  values (p_clave, round(p_costo_mxn, 4), btrim(p_fuente), p_caller_id)
  on conflict (clave) do update set costo_mxn = excluded.costo_mxn, fuente = excluded.fuente, updated_by = excluded.updated_by, updated_at = now();
  perform core.plan_audit_write('plan_upserted', p_caller_id, null, null, jsonb_build_object('costo_unitario', p_clave, 'costo_mxn', round(p_costo_mxn, 4), 'fuente', btrim(p_fuente)));
end;
$$;
revoke all on function core.superadmin_set_cobro_costo_unitario(uuid, text, numeric, text) from public, anon;
grant execute on function core.superadmin_set_cobro_costo_unitario(uuid, text, numeric, text) to authenticated;

-- SOLO sistema: reclama un aviso de bolsa. true = este llamador lo emite; false = ya se habia emitido.
create or replace function core.cobro_reclamar_aviso_bolsa(p_organization_id uuid, p_periodo date, p_metrica text, p_umbral integer)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_insertadas integer;
begin
  if auth.uid() is not null then
    raise exception 'cobro_reclamar_aviso_bolsa: solo sesion de sistema' using errcode = '42501';
  end if;
  insert into core.cobro_aviso_bolsa (organization_id, periodo, metrica, umbral)
  values (p_organization_id, date_trunc('month', p_periodo)::date, p_metrica, p_umbral)
  on conflict do nothing;
  get diagnostics v_insertadas = row_count;
  return v_insertadas = 1;
end;
$$;
revoke all on function core.cobro_reclamar_aviso_bolsa(uuid, date, text, integer) from public, anon;
-- authenticated: la funcion rechaza toda sesion de usuario (auth.uid() not null); el cron la llama sin usuario.
grant execute on function core.cobro_reclamar_aviso_bolsa(uuid, date, text, integer) to authenticated;

-- Organizaciones con plan MEDIDO (no suspendidas). Superadmin: caller binding + superadmin. Sistema (auth.uid() is null): el cron
-- de avisos de bolsa recorre la misma lista. Cualquier otro usuario -> 0 filas.
create or replace function core.superadmin_cobro_organizaciones(p_caller_id uuid)
returns table (organization_id uuid, nombre text, slug text, vertical text, zona_horaria text, sucursales_activas integer, tarifa jsonb)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null and (auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id)) then
    return;
  end if;
  return query
    select o.id, o.name, o.slug, o.vertical, o.timezone,
      (select count(*)::integer from core.property p where p.organization_id = o.id and p.status = 'active'),
      core.plan_tarifa_json(pl)
    from core.organization o
    join core.organization_plan op on op.organization_id = o.id
    join core.plan pl on pl.id = op.plan_id
    where pl.modelo_cobro = 'medido' and o.status <> 'suspended'
    order by o.name;
end;
$$;
revoke all on function core.superadmin_cobro_organizaciones(uuid) from public, anon;
grant execute on function core.superadmin_cobro_organizaciones(uuid) to authenticated;
