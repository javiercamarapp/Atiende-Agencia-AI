-- Superadmin "CFO" -- SA-43: contrato por cliente (organizacion). Registro de las condiciones
-- comerciales que SI se pactan con cada cliente: base mensual, tarifa por sucursal con sucursales
-- incluidas, bolsa de minutos de voz, tarifa de excedente, instalacion, descuentos (porcentual y
-- fijo), moneda, vigencia y quien lo cambio. Hoy nada de esto vive en la base: la plataforma solo
-- conoce asientos (core.organization_billing.seats) y el catalogo de planes (0028).
--
--   A) core.customer_contract_version  -- UNA fila por version de un contrato. INMUTABLE: es a la
--                                         vez el historial y la bitacora append-only (version,
--                                         quien, cuando, motivo). Un cambio de condiciones es una
--                                         version nueva, nunca un UPDATE.
--   B) Guard de insercion              -- vigencias traslapadas rechazadas en la BASE (no solo en
--                                         la funcion): versiones crecientes por contrato y ningun
--                                         traslape entre contratos de una misma organizacion.
--   C) Funciones de superadmin         -- crear contrato, enmendar (version nueva), listar historial
--                                         y leer los insumos de la facturacion estimada del mes.
--
-- Requiere: 0001 (core.organization/property/staff_user), 0010/0012 (core.is_platform_superadmin),
-- 0025/0034 (core.superadmin_require_caller, con el corte al rol `finanzas`) y 0028
-- (core.usage_cost_event, solo para los minutos de voz del mes).
--
-- Esta migracion NO cobra, NO envia, NO toca Stripe ni core.organization_billing, y NO siembra
-- ningun contrato (los precios de un cliente real los captura el superadmin desde la pantalla).
-- El contrato es un registro interno: de el sale la facturacion ESTIMADA (calculo puro en
-- packages/billing/src/contrato.ts), no una factura.
--
-- Justificacion de seguridad (cada GRANT/policy/funcion trae su razon):
--   * core.customer_contract_version: RLS habilitado SIN policy y REVOKE ALL a public, anon y
--     authenticated. Razon: son condiciones comerciales confidenciales de cada cliente; ningun rol
--     de la aplicacion las lee ni escribe directo, solo las funciones definer de abajo (corren
--     como el dueño, no sujeto a RLS) tras validar caller y cada valor. Por eso NO hay GRANT a
--     nivel columna: no hay ninguna columna accesible por rol alguno (un GRANT por columna solo
--     tendria sentido si algun rol escribiera algunas columnas directo; ninguno lo hace). Nada
--     se otorga a anon. Un tenant, aunque sea owner de su organizacion, NO puede leer su propio
--     contrato por esta via: es informacion de la plataforma.
--   * Sin llaves foraneas: organization_id y created_by son uuid planos. Razon: un FK con
--     ON DELETE CASCADE/SET NULL provocaria un DELETE/UPDATE sobre filas inmutables y el trigger
--     de bloqueo rechazaria el borrado de la organizacion o de la cuenta del staff; la historia
--     financiera debe sobrevivir a ambos (misma decision que core.cfo_access_log, 0034). La
--     existencia de la organizacion la valida la funcion de alta.
--   * Inmutabilidad: triggers que rechazan UPDATE, DELETE y TRUNCATE (0A000) incluso para el
--     dueño. Las funciones de trigger llevan set search_path fijo (pg_catalog/core, pg_temp).
--   * core.superadmin_create_contract y core.superadmin_amend_contract: security definer, set
--     search_path = core, pg_temp, `revoke all ... from public, anon` y grant execute solo a
--     `authenticated`. Exigen core.superadmin_require_caller (auth.uid() = p_caller_id Y
--     superadmin real Y NO restringido al rol `finanzas`, de solo lectura). Motivo obligatorio
--     (20-500 caracteres) que queda en la version. La ruta del API ademas exige step-up MFA.
--   * core.list_customer_contracts_for_superadmin y core.get_contract_billing_inputs_for_superadmin:
--     security definer, search_path fijo, contrato de CERO FILAS para quien no es el superadmin
--     autenticado (nunca un error que confirme si hay datos), grant a authenticated, no a anon.
--     Son lecturas: el rol `finanzas` (solo lectura) las puede usar, y el API registra cada
--     consulta en core.cfo_access_log (0034).
--   * Todos los montos son enteros (centavos MXN) con CHECK de rango; la moneda esta fijada a MXN
--     por CHECK (cualquier otra moneda exigiria una migracion explicita).

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Versiones de contrato (historial inmutable)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.customer_contract_version (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  -- Linea de versiones de UN contrato. La version 1 usa su propio id como contract_id.
  contract_id uuid not null,
  organization_id uuid not null,
  version integer not null check (version >= 1),
  -- Inclusivos. `vigente_hasta` es el fin del CONTRATO (se copia en cada version); null = sin fin.
  vigente_desde date not null,
  vigente_hasta date,
  moneda text not null default 'MXN' check (moneda = 'MXN'),
  base_centavos bigint not null check (base_centavos between 0 and 100000000000),
  por_sucursal_centavos bigint not null check (por_sucursal_centavos between 0 and 100000000000),
  sucursales_incluidas integer not null check (sucursales_incluidas between 0 and 100000),
  bolsa_minutos integer not null check (bolsa_minutos between 0 and 100000000),
  excedente_centavos_minuto bigint not null check (excedente_centavos_minuto between 0 and 100000000000),
  instalacion_centavos bigint not null check (instalacion_centavos between 0 and 100000000000),
  -- Puntos base (100 = 1 %), sobre el recurrente bruto; el fijo se resta despues.
  descuento_bp integer not null check (descuento_bp between 0 and 10000),
  descuento_fijo_centavos bigint not null check (descuento_fijo_centavos between 0 and 100000000000),
  motivo text not null check (char_length(btrim(motivo)) between 20 and 500),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint customer_contract_version_vigencia_chk check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  constraint customer_contract_version_unica unique (contract_id, version)
);
create unique index customer_contract_version_seq_uidx on core.customer_contract_version (seq);
create index customer_contract_version_org_idx on core.customer_contract_version (organization_id, vigente_desde desc);
alter table core.customer_contract_version enable row level security;
revoke all on core.customer_contract_version from public, anon, authenticated;

create or replace function core.customer_contract_version_block_mutation()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'customer_contract_version_append_only: % no esta permitido sobre %', tg_op, tg_table_name using errcode = '0A000';
end;
$$;
-- Las funciones de trigger no son invocables por nadie mas (el disparo no exige EXECUTE al llamador).
revoke all on function core.customer_contract_version_block_mutation() from public, anon, authenticated;
create trigger customer_contract_version_block_update_trg before update on core.customer_contract_version
  for each row execute function core.customer_contract_version_block_mutation();
create trigger customer_contract_version_block_delete_trg before delete on core.customer_contract_version
  for each row execute function core.customer_contract_version_block_mutation();
create trigger customer_contract_version_block_truncate_trg before truncate on core.customer_contract_version
  for each statement execute function core.customer_contract_version_block_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Guard de insercion: versiones crecientes y vigencias traslapadas rechazadas en la base
-- ═══════════════════════════════════════════════════════════════════════════
-- Se serializa por organizacion con un candado de asesor transaccional: dos altas simultaneas del
-- mismo cliente no pueden colarse una por la otra.
create or replace function core.customer_contract_version_guard()
returns trigger language plpgsql set search_path = core, pg_temp as $$
declare
  v_prev record;
  v_primer_desde date;
begin
  perform pg_advisory_xact_lock(hashtextextended('customer_contract:' || new.organization_id::text, 0));

  if new.version = 1 then
    if new.contract_id <> new.id then
      raise exception 'customer_contract_version: la version 1 usa su propio id como contract_id' using errcode = '22023';
    end if;
    v_primer_desde := new.vigente_desde;
  else
    select v.* into v_prev
    from core.customer_contract_version v
    where v.contract_id = new.contract_id
    order by v.version desc
    limit 1;
    if not found or v_prev.version <> new.version - 1 or v_prev.organization_id <> new.organization_id then
      raise exception 'customer_contract_version: la version debe ser la siguiente del mismo contrato y organizacion' using errcode = '22023';
    end if;
    if new.vigente_desde <= v_prev.vigente_desde then
      raise exception 'customer_contract_version: vigente_desde debe ser posterior al de la version anterior' using errcode = '22023';
    end if;
    if v_prev.vigente_hasta is not null and new.vigente_desde > v_prev.vigente_hasta then
      raise exception 'customer_contract_version: una enmienda no puede comenzar despues del fin del contrato' using errcode = '22023';
    end if;
    select min(v.vigente_desde) into v_primer_desde from core.customer_contract_version v where v.contract_id = new.contract_id;
  end if;

  -- El tramo total de un contrato va de su primera version al fin que dicta su ULTIMA version.
  if exists (
    select 1
    from (
      select o.contract_id, min(o.vigente_desde) as desde, (array_agg(o.vigente_hasta order by o.version desc))[1] as hasta
      from core.customer_contract_version o
      where o.organization_id = new.organization_id and o.contract_id <> new.contract_id
      group by o.contract_id
    ) s
    where daterange(s.desde, s.hasta, '[]') && daterange(v_primer_desde, new.vigente_hasta, '[]')
  ) then
    raise exception 'customer_contract_version: las vigencias de dos contratos de la misma organizacion no pueden traslaparse' using errcode = '23P01';
  end if;
  return new;
end;
$$;
revoke all on function core.customer_contract_version_guard() from public, anon, authenticated;
create trigger customer_contract_version_guard_trg before insert on core.customer_contract_version
  for each row execute function core.customer_contract_version_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Funciones de superadmin
-- ═══════════════════════════════════════════════════════════════════════════
-- Validacion comun de terminos (22023 con mensaje legible; los CHECK de la tabla son la segunda barrera).
create or replace function core.contract_validate_terms(
  p_fn text, p_desde date, p_hasta date, p_base bigint, p_por_sucursal bigint, p_sucursales_incluidas integer,
  p_bolsa_minutos integer, p_excedente bigint, p_instalacion bigint, p_descuento_bp integer, p_descuento_fijo bigint, p_motivo text
) returns void language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p_desde is null then
    raise exception '%: vigente_desde es obligatorio', p_fn using errcode = '22023';
  end if;
  if p_hasta is not null and p_hasta < p_desde then
    raise exception '%: vigente_hasta no puede ser anterior a vigente_desde', p_fn using errcode = '22023';
  end if;
  if p_base is null or p_base < 0 or p_base > 100000000000
     or p_por_sucursal is null or p_por_sucursal < 0 or p_por_sucursal > 100000000000
     or p_excedente is null or p_excedente < 0 or p_excedente > 100000000000
     or p_instalacion is null or p_instalacion < 0 or p_instalacion > 100000000000
     or p_descuento_fijo is null or p_descuento_fijo < 0 or p_descuento_fijo > 100000000000 then
    raise exception '%: los montos (centavos MXN) deben ser enteros entre 0 y 100000000000', p_fn using errcode = '22023';
  end if;
  if p_sucursales_incluidas is null or p_sucursales_incluidas < 0 or p_sucursales_incluidas > 100000 then
    raise exception '%: sucursales_incluidas debe estar entre 0 y 100000', p_fn using errcode = '22023';
  end if;
  if p_bolsa_minutos is null or p_bolsa_minutos < 0 or p_bolsa_minutos > 100000000 then
    raise exception '%: bolsa_minutos debe estar entre 0 y 100000000', p_fn using errcode = '22023';
  end if;
  if p_descuento_bp is null or p_descuento_bp < 0 or p_descuento_bp > 10000 then
    raise exception '%: descuento_bp debe estar entre 0 y 10000 (puntos base)', p_fn using errcode = '22023';
  end if;
  if p_motivo is null or char_length(btrim(p_motivo)) < 20 or char_length(btrim(p_motivo)) > 500 then
    raise exception '%: motivo obligatorio (20-500 caracteres)', p_fn using errcode = '22023';
  end if;
end;
$$;
-- Helper interno: solo lo invocan, como dueño, las funciones de abajo. Sin acceso directo.
revoke all on function core.contract_validate_terms(text, date, date, bigint, bigint, integer, integer, bigint, bigint, integer, bigint, text) from public, anon, authenticated;

-- Alta del contrato de una organizacion (version 1). Devuelve el contract_id.
create or replace function core.superadmin_create_contract(
  p_caller_id uuid, p_organization_id uuid, p_vigente_desde date, p_vigente_hasta date,
  p_base_centavos bigint, p_por_sucursal_centavos bigint, p_sucursales_incluidas integer, p_bolsa_minutos integer,
  p_excedente_centavos_minuto bigint, p_instalacion_centavos bigint, p_descuento_bp integer, p_descuento_fijo_centavos bigint,
  p_motivo text
) returns uuid language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_create_contract');
  if p_organization_id is null or not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'superadmin_create_contract: la organizacion no existe' using errcode = 'P0002';
  end if;
  perform core.contract_validate_terms('superadmin_create_contract', p_vigente_desde, p_vigente_hasta, p_base_centavos, p_por_sucursal_centavos,
    p_sucursales_incluidas, p_bolsa_minutos, p_excedente_centavos_minuto, p_instalacion_centavos, p_descuento_bp, p_descuento_fijo_centavos, p_motivo);
  insert into core.customer_contract_version (
    id, contract_id, organization_id, version, vigente_desde, vigente_hasta, base_centavos, por_sucursal_centavos, sucursales_incluidas,
    bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by
  ) values (
    v_id, v_id, p_organization_id, 1, p_vigente_desde, p_vigente_hasta, p_base_centavos, p_por_sucursal_centavos, p_sucursales_incluidas,
    p_bolsa_minutos, p_excedente_centavos_minuto, p_instalacion_centavos, p_descuento_bp, p_descuento_fijo_centavos, btrim(p_motivo), p_caller_id
  );
  return v_id;
end;
$$;
revoke all on function core.superadmin_create_contract(uuid, uuid, date, date, bigint, bigint, integer, integer, bigint, bigint, integer, bigint, text) from public, anon;
grant execute on function core.superadmin_create_contract(uuid, uuid, date, date, bigint, bigint, integer, integer, bigint, bigint, integer, bigint, text) to authenticated;

-- Enmienda: version nueva (n+1) del mismo contrato, vigente desde `p_vigente_desde`. Devuelve el numero de version.
-- No puede editar el pasado: la fecha de inicio no puede ser anterior al primer dia del mes en curso (hora de
-- Mexico), para no reescribir en silencio un mes que ya se estimo o se cerro.
create or replace function core.superadmin_amend_contract(
  p_caller_id uuid, p_contract_id uuid, p_vigente_desde date, p_vigente_hasta date,
  p_base_centavos bigint, p_por_sucursal_centavos bigint, p_sucursales_incluidas integer, p_bolsa_minutos integer,
  p_excedente_centavos_minuto bigint, p_instalacion_centavos bigint, p_descuento_bp integer, p_descuento_fijo_centavos bigint,
  p_motivo text
) returns integer language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_ultima core.customer_contract_version;
  v_org uuid;
  v_inicio_mes date := date_trunc('month', (now() at time zone 'America/Mexico_City'))::date;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_amend_contract');
  select v.organization_id into v_org from core.customer_contract_version v where v.contract_id = p_contract_id limit 1;
  if v_org is null then
    raise exception 'superadmin_amend_contract: el contrato no existe' using errcode = 'P0002';
  end if;
  -- Mismo candado que el guard de insercion: la "ultima version" que se lee aqui no cambia bajo nuestros pies.
  perform pg_advisory_xact_lock(hashtextextended('customer_contract:' || v_org::text, 0));
  select v.* into v_ultima from core.customer_contract_version v where v.contract_id = p_contract_id order by v.version desc limit 1;

  perform core.contract_validate_terms('superadmin_amend_contract', p_vigente_desde, p_vigente_hasta, p_base_centavos, p_por_sucursal_centavos,
    p_sucursales_incluidas, p_bolsa_minutos, p_excedente_centavos_minuto, p_instalacion_centavos, p_descuento_bp, p_descuento_fijo_centavos, p_motivo);
  if p_vigente_desde < v_inicio_mes then
    raise exception 'superadmin_amend_contract: una enmienda no puede comenzar antes del primer dia del mes en curso (%)', v_inicio_mes using errcode = '22023';
  end if;
  if v_ultima.base_centavos = p_base_centavos and v_ultima.por_sucursal_centavos = p_por_sucursal_centavos
     and v_ultima.sucursales_incluidas = p_sucursales_incluidas and v_ultima.bolsa_minutos = p_bolsa_minutos
     and v_ultima.excedente_centavos_minuto = p_excedente_centavos_minuto and v_ultima.instalacion_centavos = p_instalacion_centavos
     and v_ultima.descuento_bp = p_descuento_bp and v_ultima.descuento_fijo_centavos = p_descuento_fijo_centavos
     and v_ultima.vigente_hasta is not distinct from p_vigente_hasta then
    raise exception 'superadmin_amend_contract: la enmienda no cambia ninguna condicion' using errcode = '22023';
  end if;

  insert into core.customer_contract_version (
    contract_id, organization_id, version, vigente_desde, vigente_hasta, base_centavos, por_sucursal_centavos, sucursales_incluidas,
    bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by
  ) values (
    p_contract_id, v_org, v_ultima.version + 1, p_vigente_desde, p_vigente_hasta, p_base_centavos, p_por_sucursal_centavos, p_sucursales_incluidas,
    p_bolsa_minutos, p_excedente_centavos_minuto, p_instalacion_centavos, p_descuento_bp, p_descuento_fijo_centavos, btrim(p_motivo), p_caller_id
  );
  return v_ultima.version + 1;
end;
$$;
revoke all on function core.superadmin_amend_contract(uuid, uuid, date, date, bigint, bigint, integer, integer, bigint, bigint, integer, bigint, text) from public, anon;
grant execute on function core.superadmin_amend_contract(uuid, uuid, date, date, bigint, bigint, integer, integer, bigint, bigint, integer, bigint, text) to authenticated;

-- Historial de versiones (de una organizacion, o de todas), la mas reciente primero. Cero filas si no es superadmin.
create or replace function core.list_customer_contracts_for_superadmin(p_caller_id uuid, p_organization_id uuid default null, p_limit integer default 200)
returns table (
  id uuid, contract_id uuid, organization_id uuid, organization_name text, version integer,
  vigente_desde date, vigente_hasta date, moneda text, base_centavos bigint, por_sucursal_centavos bigint,
  sucursales_incluidas integer, bolsa_minutos integer, excedente_centavos_minuto bigint, instalacion_centavos bigint,
  descuento_bp integer, descuento_fijo_centavos bigint, motivo text, created_by uuid, created_by_email text, created_at timestamptz
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select v.id, v.contract_id, v.organization_id, o.name::text, v.version,
           v.vigente_desde, v.vigente_hasta, v.moneda, v.base_centavos, v.por_sucursal_centavos,
           v.sucursales_incluidas, v.bolsa_minutos, v.excedente_centavos_minuto, v.instalacion_centavos,
           v.descuento_bp, v.descuento_fijo_centavos, v.motivo, v.created_by, u.email::text, v.created_at
    from core.customer_contract_version v
    left join core.organization o on o.id = v.organization_id
    left join core.staff_user u on u.id = v.created_by
    where p_organization_id is null or v.organization_id = p_organization_id
    order by v.seq desc
    limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;
revoke all on function core.list_customer_contracts_for_superadmin(uuid, uuid, integer) from public, anon;
grant execute on function core.list_customer_contracts_for_superadmin(uuid, uuid, integer) to authenticated;

-- Insumos de la facturacion estimada de un mes: sucursales activas HOY y minutos de voz del mes (enteros,
-- redondeados hacia arriba). `eventos_voz` = cuantos eventos de voz respaldan la cifra: con 0 eventos los minutos
-- NO estan medidos (el API lo trata como "no disponible", nunca como 0 inventado). Una fila, o cero filas si el
-- caller no es el superadmin autenticado o la organizacion no existe.
create or replace function core.get_contract_billing_inputs_for_superadmin(p_caller_id uuid, p_organization_id uuid, p_month date)
returns table (sucursales_activas integer, minutos_voz bigint, eventos_voz bigint)
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_from date;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_month is null or p_organization_id is null or not exists (select 1 from core.organization o where o.id = p_organization_id) then
    return;
  end if;
  v_from := date_trunc('month', p_month::timestamp)::date;
  return query
    select
      (select count(*)::integer from core.property p where p.organization_id = p_organization_id and p.status = 'active'),
      coalesce(ceil(sum(case x.unidad when 'minuto' then x.cantidad when 'segundo' then x.cantidad / 60 else 0 end)), 0)::bigint,
      count(*)::bigint
    from core.usage_cost_event x
    where x.organization_id = p_organization_id
      and x.categoria = 'voz'
      and x.occurred_at >= v_from::timestamptz
      and x.occurred_at < (v_from + interval '1 month')::timestamptz;
end;
$$;
revoke all on function core.get_contract_billing_inputs_for_superadmin(uuid, uuid, date) from public, anon;
grant execute on function core.get_contract_billing_inputs_for_superadmin(uuid, uuid, date) to authenticated;
