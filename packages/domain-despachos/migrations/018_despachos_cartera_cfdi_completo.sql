-- D-21 + D-22 -- Cartera de clientes del despacho (ficha de contribuyente por property) y modelo CFDI
-- completo persistido (emitido vs recibido, forma/método de pago, uso, moneda/tipo de cambio, montos
-- en centavos enteros, impuestos desglosados y estado ante el SAT).
--
-- Modelo:
--   * `despachos.cliente_ficha`     -- UNA ficha fiscal por property (cada cliente del despacho es una
--                                       property de `core`): RFC (estructura + fecha de nacimiento/
--                                       constitución válida; los genéricos XAXX/XEXX se rechazan), razón
--                                       social, régimen(es) fiscal(es) (c_RegimenFiscal, 3 dígitos), CP
--                                       fiscal, periodicidad de pagos provisionales y responsable (staff).
--                                       `tipo_persona` se DERIVA del largo del RFC (12 = moral, 13 = física).
--   * `despachos.invoice` (ALTER)   -- columnas nuevas, todas NULLABLES salvo `estado_sat`: `direccion`
--                                       (emitido/recibido/indeterminado, se resuelve en la API comparando el
--                                       RFC de la ficha contra emisor/receptor), `metodo_pago`, `forma_pago`,
--                                       `uso_cfdi`, `moneda`, `tipo_cambio`, montos en centavos (bigint),
--                                       `estado_sat` y `estado_sat_verificado_en`. Las columnas numeric(14,2)
--                                       históricas NO se tocan (siguen siendo la fuente de los reportes
--                                       existentes); los centavos se rellenan para las filas previas.
--   * `despachos.invoice_impuesto`  -- impuestos desglosados por comprobante (traslado/retención, ISR 001 /
--                                       IVA 002 / IEPS 003, Tasa/Cuota/Exento, base e importe en centavos).
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-cartera-cfdi/assertions.sql):
--   1. `cliente_ficha` e `invoice_impuesto`: RLS habilitado, REVOKE de todo a public/anon/authenticated y
--      después SOLO `select` a `authenticated` con policy `core.has_property_access(auth.uid(), property_id)`
--      -- justificación: el staff debe poder listar las fichas/impuestos de SUS clientes y nada más; la ficha
--      no tiene columnas secretas, así que el GRANT es por tabla completa de lectura. NO hay INSERT/UPDATE/
--      DELETE directos sobre `cliente_ficha`: toda escritura pasa por las funciones de abajo (que validan rol,
--      formato y topes). No hay `using (true)` ni GRANT a anon.
--      `invoice_impuesto` SÍ concede `insert` a nivel COLUMNA (lista explícita, sin `id`) porque la ingesta
--      de CFDI corre como staff dentro de la misma transacción que `insert into despachos.invoice` (mismo
--      patrón que la política de insert de `invoice`, migración 001); su policy de insert exige acceso a la
--      property y la llave foránea COMPUESTA (invoice_id, organization_id, property_id) -> invoice(id,
--      organization_id, property_id) impide apuntar un impuesto a la factura de OTRA property u organización
--      (cross-tenant) aunque se mienta en property_id. Sin UPDATE ni DELETE: un desglose ya persistido no se
--      reescribe.
--   2. `cliente_alta` (security definer, set search_path fijo, revoke de public, EXECUTE solo a
--      `authenticated`): exige `auth.uid()` no nulo (42501) y una membresía de la organización de
--      vertical despachos con `property_ids is null` (alcance de TODA la organización: crear un cliente es
--      una operación de organización) y `vertical_role` admin/contador. Crea la property (la columna `vertical`
--      la fija el trigger de core) y la ficha en una sola transacción. Tope de 500 clientes por organización
--      (54000) con advisory lock para que dos altas simultáneas no lo rebasen. RFC duplicado en la misma
--      organización -> 23505. Una organización suspendida no da de alta.
--   3. `cliente_ficha_guardar` (definer, mismo blindaje): property de vertical despachos, acceso a la property
--      (`core.has_property_access`), rol admin/contador en la organización DE ESA property, y el RFC de una
--      ficha existente NO se cambia (22023): cambiarlo reclasificaría emitidos/recibidos ya persistidos.
--      Valida formato (RFC, régimen, CP, periodicidad) y que el responsable sea staff de la misma
--      organización (un responsable de otra organización se rechaza con 22023).
--   4. `invoice_estado_sat_registrar` (definer): rol admin/contador + acceso a la property + la factura debe
--      pertenecer a esa property (P0002 si no existe en ella: no confirma ni niega facturas ajenas). Es la
--      única escritura sobre `invoice.estado_sat*` (no se concede UPDATE sobre invoice). Un CFDI 'cancelado'
--      no regresa a otro estado (22023).
--   5. Ninguna función llama a red ni al SAT; el estado SAT lo captura un humano o, más adelante, un job.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume esto captura 42883/42P01/42703 dentro de
-- SAVEPOINT (runWithSavepointFallback) y cae al camino anterior (insert de invoice sin columnas nuevas, cartera
-- "no disponible aún" con la lista de properties); nunca a un 500. Esta migración se puede aplicar antes o
-- después del código.

create table despachos.cliente_ficha (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  rfc text not null check (
    rfc ~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{3}$'
    and rfc not in ('XAXX010101000', 'XEXX010101000')
  ),
  tipo_persona text generated always as (case when char_length(rfc) = 12 then 'moral' else 'fisica' end) stored,
  razon_social text not null check (char_length(razon_social) between 1 and 250),
  regimenes_fiscales text[] not null check (
    cardinality(regimenes_fiscales) between 1 and 10
    and array_position(regimenes_fiscales, null) is null
    and array_to_string(regimenes_fiscales, ',') ~ '^[0-9]{3}(,[0-9]{3})*$'
  ),
  cp_fiscal text not null check (cp_fiscal ~ '^[0-9]{5}$'),
  periodicidad text not null default 'mensual' check (periodicidad in ('mensual', 'bimestral')),
  responsable_id uuid references core.staff_user(id) on delete set null,
  creado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, rfc)
);
create index cliente_ficha_org_idx on despachos.cliente_ficha (organization_id);

alter table despachos.cliente_ficha enable row level security;
revoke all on despachos.cliente_ficha from public, anon, authenticated;
create policy "staff ve la ficha de sus clientes" on despachos.cliente_ficha for select
  using (core.has_property_access(auth.uid(), property_id));
grant select on despachos.cliente_ficha to authenticated;
grant select, insert, update, delete on despachos.cliente_ficha to service_role;

-- ---------------------------------------------------------------------------
-- CFDI completo: columnas nuevas de despachos.invoice.
-- ---------------------------------------------------------------------------
alter table despachos.invoice
  add column direccion text check (direccion in ('emitido', 'recibido', 'indeterminado')),
  add column metodo_pago text check (metodo_pago in ('PUE', 'PPD')),
  add column forma_pago text check (forma_pago ~ '^[0-9]{2}$'),
  add column uso_cfdi text check (uso_cfdi ~ '^[A-Z0-9]{3,4}$'),
  add column moneda text check (moneda ~ '^[A-Z]{3}$'),
  add column tipo_cambio numeric(18, 6) check (tipo_cambio is null or tipo_cambio > 0),
  add column subtotal_centavos bigint check (subtotal_centavos is null or subtotal_centavos >= 0),
  add column descuento_centavos bigint check (descuento_centavos is null or descuento_centavos >= 0),
  add column total_centavos bigint,
  add column iva_trasladado_centavos bigint check (iva_trasladado_centavos is null or iva_trasladado_centavos >= 0),
  add column isr_retenido_centavos bigint check (isr_retenido_centavos is null or isr_retenido_centavos >= 0),
  add column iva_retenido_centavos bigint check (iva_retenido_centavos is null or iva_retenido_centavos >= 0),
  add column ieps_centavos bigint check (ieps_centavos is null or ieps_centavos >= 0),
  add column estado_sat text not null default 'pendiente' check (estado_sat in ('pendiente', 'vigente', 'cancelado', 'no_encontrado')),
  add column estado_sat_verificado_en timestamptz;

-- Llave compuesta que usa la FK de invoice_impuesto (id ya es PK: la unicidad es trivial).
alter table despachos.invoice add constraint invoice_id_org_property_uk unique (id, organization_id, property_id);

create index invoice_direccion_fecha_idx on despachos.invoice (property_id, direccion, fecha);

-- Relleno de los centavos de las filas previas, derivado EXACTAMENTE de las columnas numeric(14,2)
-- históricas (round half away from zero, que con 2 decimales es exacto). Las columnas de retenciones/IEPS
-- no existían: quedan NULL (desconocido), jamás 0.
update despachos.invoice
set subtotal_centavos = round(subtotal * 100)::bigint,
    descuento_centavos = round(descuento * 100)::bigint,
    total_centavos = round(total * 100)::bigint,
    iva_trasladado_centavos = case when iva is null then null else round(iva * 100)::bigint end
where subtotal_centavos is null;

-- ---------------------------------------------------------------------------
-- Impuestos desglosados.
-- ---------------------------------------------------------------------------
create table despachos.invoice_impuesto (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null,
  organization_id uuid not null,
  property_id uuid not null,
  naturaleza text not null check (naturaleza in ('traslado', 'retencion')),
  impuesto text not null check (impuesto in ('001', '002', '003')),
  tipo_factor text not null check (tipo_factor in ('Tasa', 'Cuota', 'Exento')),
  tasa_o_cuota numeric(12, 6) check (tasa_o_cuota is null or tasa_o_cuota >= 0),
  base_centavos bigint check (base_centavos is null or base_centavos >= 0),
  importe_centavos bigint check (importe_centavos is null or importe_centavos >= 0),
  foreign key (invoice_id, organization_id, property_id)
    references despachos.invoice (id, organization_id, property_id) on delete cascade,
  check (
    (tipo_factor = 'Exento' and tasa_o_cuota is null and importe_centavos is null)
    or (tipo_factor <> 'Exento' and tasa_o_cuota is not null and importe_centavos is not null)
  ),
  check (naturaleza = 'traslado' or tipo_factor <> 'Exento')
);
create unique index invoice_impuesto_clave_uk on despachos.invoice_impuesto
  (invoice_id, naturaleza, impuesto, tipo_factor, coalesce(tasa_o_cuota, -1));
create index invoice_impuesto_property_idx on despachos.invoice_impuesto (property_id);

alter table despachos.invoice_impuesto enable row level security;
revoke all on despachos.invoice_impuesto from public, anon, authenticated;
create policy "staff ve los impuestos de sus clientes" on despachos.invoice_impuesto for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta impuestos de sus clientes" on despachos.invoice_impuesto for insert
  with check (core.has_property_access(auth.uid(), property_id));
grant select on despachos.invoice_impuesto to authenticated;
grant insert (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos)
  on despachos.invoice_impuesto to authenticated;
grant select, insert, update, delete on despachos.invoice_impuesto to service_role;

-- ---------------------------------------------------------------------------
-- Funciones.
-- ---------------------------------------------------------------------------

-- Rol de despachos con permiso de escritura sobre la cartera/CFDI en la organización de una property.
-- Solo la invocan las funciones definer de abajo (revoke de public): no se expone al cliente.
create or replace function despachos.cartera_puede_escribir(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = despachos, pg_temp
as $$
  select auth.uid() is not null
    and core.has_property_access(auth.uid(), p_property_id)
    and exists (
      select 1
      from core.property p
      join core.organization o on o.id = p.organization_id
      join core.membership m on m.organization_id = p.organization_id and m.user_id = auth.uid()
      where p.id = p_property_id
        and o.vertical = 'despachos'
        and m.vertical_role in ('admin', 'contador')
    );
$$;
revoke all on function despachos.cartera_puede_escribir(uuid) from public;

-- Alta/edición de la ficha de una property de despachos YA existente (cliente creado antes de esta
-- migración, o recién creado por cliente_alta). El RFC de una ficha existente no cambia.
create or replace function despachos.cliente_ficha_guardar(
  p_property_id uuid,
  p_rfc text,
  p_razon_social text,
  p_regimenes text[],
  p_cp_fiscal text,
  p_periodicidad text,
  p_responsable_id uuid
)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_rfc text;
  v_razon text;
  v_regimenes text[];
  v_actual text;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'cliente_ficha_guardar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'cliente_ficha_guardar: la property no es de despachos' using errcode = '42501';
  end if;

  v_rfc := upper(btrim(coalesce(p_rfc, '')));
  if v_rfc !~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{3}$' or v_rfc in ('XAXX010101000', 'XEXX010101000') then
    raise exception 'cliente_ficha_guardar: RFC inválido (se esperan 12 o 13 caracteres con fecha válida; los genéricos no son un cliente)' using errcode = '22023';
  end if;
  v_razon := btrim(coalesce(p_razon_social, ''));
  if char_length(v_razon) < 1 or char_length(v_razon) > 250 then
    raise exception 'cliente_ficha_guardar: razón social de 1 a 250 caracteres' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct btrim(r) order by btrim(r)), '{}') into v_regimenes from unnest(coalesce(p_regimenes, '{}')) as r;
  if cardinality(v_regimenes) < 1 or cardinality(v_regimenes) > 10 or array_to_string(v_regimenes, ',') !~ '^[0-9]{3}(,[0-9]{3})*$' then
    raise exception 'cliente_ficha_guardar: de 1 a 10 regímenes fiscales de 3 dígitos' using errcode = '22023';
  end if;
  if p_cp_fiscal is null or p_cp_fiscal !~ '^[0-9]{5}$' then
    raise exception 'cliente_ficha_guardar: el código postal fiscal son 5 dígitos' using errcode = '22023';
  end if;
  if p_periodicidad is null or p_periodicidad not in ('mensual', 'bimestral') then
    raise exception 'cliente_ficha_guardar: periodicidad mensual o bimestral' using errcode = '22023';
  end if;
  if p_responsable_id is not null
     and not exists (select 1 from core.membership m where m.user_id = p_responsable_id and m.organization_id = v_org) then
    raise exception 'cliente_ficha_guardar: el responsable debe ser staff de esta organización' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('despachos.cliente_ficha:' || p_property_id::text, 0));
  select f.rfc into v_actual from despachos.cliente_ficha f where f.property_id = p_property_id;
  if v_actual is null then
    insert into despachos.cliente_ficha (property_id, organization_id, rfc, razon_social, regimenes_fiscales, cp_fiscal, periodicidad, responsable_id, creado_por)
    values (p_property_id, v_org, v_rfc, v_razon, v_regimenes, p_cp_fiscal, p_periodicidad, p_responsable_id, auth.uid());
  else
    if v_actual <> v_rfc then
      raise exception 'cliente_ficha_guardar: el RFC de un cliente ya registrado no se modifica' using errcode = '22023';
    end if;
    update despachos.cliente_ficha
    set razon_social = v_razon, regimenes_fiscales = v_regimenes, cp_fiscal = p_cp_fiscal,
        periodicidad = p_periodicidad, responsable_id = p_responsable_id, updated_at = now()
    where property_id = p_property_id;
  end if;
end;
$$;
revoke all on function despachos.cliente_ficha_guardar(uuid, text, text, text[], text, text, uuid) from public;
grant execute on function despachos.cliente_ficha_guardar(uuid, text, text, text[], text, text, uuid) to authenticated;

-- Alta de un cliente NUEVO: crea la property de despachos y su ficha en una sola transacción.
create or replace function despachos.cliente_alta(
  p_organization_id uuid,
  p_nombre text,
  p_rfc text,
  p_razon_social text,
  p_regimenes text[],
  p_cp_fiscal text,
  p_periodicidad text,
  p_responsable_id uuid
)
returns table (out_property_id uuid)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_nombre text;
  v_property uuid;
  v_estado text;
begin
  if auth.uid() is null then
    raise exception 'cliente_alta: se requiere un staff autenticado' using errcode = '42501';
  end if;
  select o.status into v_estado
  from core.organization o
  join core.membership m on m.organization_id = o.id and m.user_id = auth.uid()
  where o.id = p_organization_id
    and o.vertical = 'despachos'
    and m.property_ids is null
    and m.vertical_role in ('admin', 'contador');
  if v_estado is null then
    raise exception 'cliente_alta: sin permiso para dar de alta clientes en esta organización' using errcode = '42501';
  end if;
  if v_estado = 'suspended' then
    raise exception 'cliente_alta: la organización está suspendida' using errcode = '42501';
  end if;
  v_nombre := btrim(coalesce(p_nombre, ''));
  if char_length(v_nombre) < 1 or char_length(v_nombre) > 120 then
    raise exception 'cliente_alta: nombre de 1 a 120 caracteres' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('despachos.cliente_alta:' || p_organization_id::text, 0));
  if (select count(*) from core.property p where p.organization_id = p_organization_id and p.vertical = 'despachos') >= 500 then
    raise exception 'cliente_alta: máximo 500 clientes por organización' using errcode = '54000';
  end if;

  insert into core.property (organization_id, name) values (p_organization_id, v_nombre) returning id into v_property;
  perform despachos.cliente_ficha_guardar(v_property, p_rfc, p_razon_social, p_regimenes, p_cp_fiscal, p_periodicidad, p_responsable_id);
  return query select v_property;
end;
$$;
revoke all on function despachos.cliente_alta(uuid, text, text, text, text[], text, text, uuid) from public;
grant execute on function despachos.cliente_alta(uuid, text, text, text, text[], text, text, uuid) to authenticated;

-- Estado del CFDI ante el SAT, capturado por el staff (la consulta automática es otro ítem).
create or replace function despachos.invoice_estado_sat_registrar(p_property_id uuid, p_invoice_id uuid, p_estado text)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_actual text;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'invoice_estado_sat_registrar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_estado is null or p_estado not in ('pendiente', 'vigente', 'cancelado', 'no_encontrado') then
    raise exception 'invoice_estado_sat_registrar: estado inválido' using errcode = '22023';
  end if;
  select i.estado_sat into v_actual from despachos.invoice i where i.id = p_invoice_id and i.property_id = p_property_id for update;
  if v_actual is null then
    raise exception 'invoice_estado_sat_registrar: CFDI no encontrado' using errcode = 'P0002';
  end if;
  if v_actual = 'cancelado' and p_estado <> 'cancelado' then
    raise exception 'invoice_estado_sat_registrar: un CFDI cancelado no cambia de estado' using errcode = '22023';
  end if;
  update despachos.invoice set estado_sat = p_estado, estado_sat_verificado_en = now() where id = p_invoice_id;
end;
$$;
revoke all on function despachos.invoice_estado_sat_registrar(uuid, uuid, text) from public;
grant execute on function despachos.invoice_estado_sat_registrar(uuid, uuid, text) to authenticated;
