-- D-24 + D-25 -- Libro contable persistido (catálogo de cuentas por cliente, pólizas con folio, balanza derivada) y
-- pagos provisionales de ISR/IVA (CFDI cobrados/pagados por flujo de efectivo, pagos del complemento de pago 2.0
-- persistidos y papel de trabajo por periodo).
--
-- Modelo (todo en CENTAVOS ENTEROS, bigint; sin llamadas al SAT ni a un PAC):
--   * `despachos.libro_cuenta`      -- catálogo de cuentas POR CLIENTE (property): código, descripción y naturaleza
--                                       (D deudora / A acreedora). La naturaleza de una cuenta con movimientos no cambia.
--   * `despachos.libro_poliza`      -- encabezado de póliza (ingreso / egreso / diario) con folio consecutivo por
--                                       (cliente, ejercicio, mes, tipo), fecha, origen (manual / cfdi / reversa) y liga
--                                       opcional al CFDI que la originó. Una póliza NO se edita ni se borra: se corrige con
--                                       una póliza de reversa (`libro_poliza_reversar`).
--   * `despachos.libro_movimiento`  -- partidas (debe XOR haber) de cada póliza. La suma del debe = suma del haber la
--                                       exige la función de registro; una póliza descuadrada nunca se guarda.
--   * `despachos.libro_balanza(...)`-- balanza de comprobación DERIVADA (función de solo lectura, invoker: aplica RLS).
--   * `despachos.pago_cfdi`         -- pagos de CFDI con método PPD tomados del complemento de pago (REP 2.0): fecha de
--                                       pago, importe pagado, base e IVA proporcionales, ligados a la factura pagada.
--   * `despachos.pago_provisional`  -- papel de trabajo del pago provisional ISR/IVA de un mes: resultado calculado por el
--                                       servidor, parámetros usados, estado (borrador / presentado) y monto pagado.
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-libro-pagos-provisionales/assertions.sql):
--   1. Las 5 tablas: RLS habilitado, REVOKE de todo a public/anon/authenticated y SOLO `select` a `authenticated` con la
--      policy `core.has_property_access(auth.uid(), property_id)` -- justificación: el staff debe poder leer el libro, los
--      pagos y los papeles de SUS clientes y nada más; ninguna tabla guarda secretos, así que el GRANT es de lectura por
--      tabla completa. NO hay INSERT/UPDATE/DELETE directos para `authenticated`: toda escritura pasa por las funciones
--      de abajo, que validan rol, formato, periodo cerrado, cuadre y topes (por eso no hace falta GRANT por columna: no se
--      concede ninguna escritura). Sin `using (true)` ni GRANT a anon. `service_role` conserva acceso total (cron/soporte).
--      Las llaves foráneas COMPUESTAS (id, organization_id, property_id) impiden apuntar una partida, un pago o una póliza
--      a la póliza/factura de OTRA property u organización aunque se mienta en las columnas de tenant (cross-tenant).
--   2. Todas las funciones de escritura son `security definer` con `set search_path = despachos, pg_temp`, `revoke all ...
--      from public` y EXECUTE solo a `authenticated`; exigen `auth.uid()` no nulo y reutilizan
--      `despachos.cartera_puede_escribir(property)` (migración 018): acceso a la property + rol admin/contador en la
--      organización de vertical despachos de ESA property. Un contador de otra organización recibe 42501.
--   3. Periodo cerrado: una póliza (o su reversa) fechada en un mes con `despachos.periodo_cierre.status = 'closed'` se
--      rechaza con 55000. Una póliza de reversa se fecha en el mes en que se registra la corrección.
--   4. Folio: asignado por la función bajo `pg_advisory_xact_lock` (dos altas simultáneas no repiten folio) y protegido
--      además por UNIQUE (property_id, ejercicio, mes, tipo, folio).
--   5. `despachos.libro_balanza` es SECURITY INVOKER a propósito: no necesita saltarse RLS, así que un staff nunca ve la
--      balanza de otro cliente. Solo EXECUTE a `authenticated`.
--   6. `despachos.system_pagos_provisionales_por_vencer` es solo-sistema (`auth.uid() is null`, 42501 si no): devuelve
--      únicamente organization_id + conteo (sin nombres, RFC ni montos) para el aviso in-app de la campana; el cron corre
--      como sesión de sistema (userId null) y no tiene acceso de lectura por RLS a ninguna property.
--   7. Ninguna función llama a la red; los importes de un pago de REP los calcula el servidor desde la factura persistida y
--      la función rechaza sobrepagos (suma de pagos > total del CFDI) y pagos sobre CFDI cancelados o no PPD.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume esto captura 42883/42P01/42703 dentro de SAVEPOINT
-- (runWithSavepointFallback) y responde "no disponible aún" (lista vacía + estado); nunca un 500. Esta migración se
-- puede aplicar antes o después del código.

-- ---------------------------------------------------------------------------
-- Catálogo de cuentas por cliente.
-- ---------------------------------------------------------------------------
create table despachos.libro_cuenta (
  property_id uuid not null references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  codigo text not null check (codigo ~ '^[0-9]{4,10}$'),
  descripcion text not null check (char_length(descripcion) between 1 and 200),
  naturaleza text not null check (naturaleza in ('D', 'A')),
  created_at timestamptz not null default now(),
  primary key (property_id, codigo)
);
create index libro_cuenta_org_idx on despachos.libro_cuenta (organization_id);

-- ---------------------------------------------------------------------------
-- Pólizas y partidas.
-- ---------------------------------------------------------------------------
create table despachos.libro_poliza (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  ejercicio integer not null check (ejercicio between 2014 and 2099),
  mes integer not null check (mes between 1 and 12),
  tipo text not null check (tipo in ('ingreso', 'egreso', 'diario')),
  folio integer not null check (folio >= 1),
  fecha date not null,
  concepto text not null check (char_length(concepto) between 1 and 300),
  origen text not null check (origen in ('manual', 'cfdi', 'reversa')),
  invoice_id uuid,
  reversa_de uuid references despachos.libro_poliza (id),
  reversada boolean not null default false,
  total_centavos bigint not null check (total_centavos > 0),
  creado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, organization_id, property_id),
  unique (property_id, ejercicio, mes, tipo, folio),
  foreign key (invoice_id, organization_id, property_id)
    references despachos.invoice (id, organization_id, property_id),
  check ((origen = 'cfdi') = (invoice_id is not null)),
  check ((origen = 'reversa') = (reversa_de is not null)),
  check (extract(year from fecha)::int = ejercicio and extract(month from fecha)::int = mes)
);
-- Un CFDI tiene a lo más UNA póliza vigente (una reversada libera al CFDI para volver a contabilizarse).
create unique index libro_poliza_cfdi_vigente_uk on despachos.libro_poliza (property_id, invoice_id)
  where invoice_id is not null and not reversada;
create index libro_poliza_periodo_idx on despachos.libro_poliza (property_id, ejercicio, mes);

create table despachos.libro_movimiento (
  id uuid primary key default gen_random_uuid(),
  poliza_id uuid not null,
  organization_id uuid not null,
  property_id uuid not null,
  linea integer not null check (linea >= 1),
  cuenta text not null,
  concepto text not null default '' check (char_length(concepto) <= 300),
  debe_centavos bigint not null default 0 check (debe_centavos >= 0),
  haber_centavos bigint not null default 0 check (haber_centavos >= 0),
  check ((debe_centavos > 0) <> (haber_centavos > 0)),
  unique (poliza_id, linea),
  foreign key (poliza_id, organization_id, property_id)
    references despachos.libro_poliza (id, organization_id, property_id) on delete cascade,
  foreign key (property_id, cuenta) references despachos.libro_cuenta (property_id, codigo)
);
create index libro_movimiento_cuenta_idx on despachos.libro_movimiento (property_id, cuenta);

-- ---------------------------------------------------------------------------
-- Pagos de CFDI PPD tomados del complemento de pago 2.0 (REP).
-- ---------------------------------------------------------------------------
create table despachos.pago_cfdi (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  invoice_id uuid not null,
  folio_fiscal_rep text not null check (folio_fiscal_rep ~ '^[0-9A-Fa-f-]{36}$'),
  pago_index integer not null check (pago_index >= 0),
  fecha_pago date not null,
  flujo text not null check (flujo in ('trasladado', 'acreditable')),
  num_parcialidad integer check (num_parcialidad is null or num_parcialidad >= 1),
  importe_pagado_centavos bigint not null check (importe_pagado_centavos > 0),
  base_centavos bigint not null check (base_centavos >= 0),
  iva_centavos bigint not null check (iva_centavos >= 0),
  iva_retenido_centavos bigint not null default 0 check (iva_retenido_centavos >= 0),
  creado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (invoice_id, organization_id, property_id)
    references despachos.invoice (id, organization_id, property_id) on delete cascade,
  unique (property_id, folio_fiscal_rep, pago_index, invoice_id)
);
create index pago_cfdi_periodo_idx on despachos.pago_cfdi (property_id, fecha_pago);
create index pago_cfdi_invoice_idx on despachos.pago_cfdi (invoice_id);

-- ---------------------------------------------------------------------------
-- Papel de trabajo del pago provisional.
-- ---------------------------------------------------------------------------
create table despachos.pago_provisional (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  ejercicio integer not null check (ejercicio between 2014 and 2099),
  mes integer not null check (mes between 1 and 12),
  impuesto text not null check (impuesto in ('ISR', 'IVA')),
  regimen text not null check (regimen ~ '^[0-9]{3}$'),
  base_centavos bigint not null check (base_centavos >= 0),
  determinado_centavos bigint not null check (determinado_centavos >= 0),
  acreditable_centavos bigint not null check (acreditable_centavos >= 0),
  a_cargo_centavos bigint not null check (a_cargo_centavos >= 0),
  a_favor_centavos bigint not null check (a_favor_centavos >= 0),
  check (a_cargo_centavos = 0 or a_favor_centavos = 0),
  parametros jsonb not null default '{}'::jsonb check (jsonb_typeof(parametros) = 'object' and pg_column_size(parametros) <= 8192),
  advertencias integer not null default 0 check (advertencias >= 0),
  estado text not null default 'borrador' check (estado in ('borrador', 'presentado')),
  monto_pagado_centavos bigint check (monto_pagado_centavos is null or monto_pagado_centavos >= 0),
  fecha_presentacion date,
  creado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, ejercicio, mes, impuesto),
  check ((estado = 'presentado') = (fecha_presentacion is not null))
);
create index pago_provisional_org_idx on despachos.pago_provisional (organization_id);

-- ---------------------------------------------------------------------------
-- RLS + GRANT: solo lectura para el staff de la property; escribir = funciones definer.
-- ---------------------------------------------------------------------------
alter table despachos.libro_cuenta enable row level security;
alter table despachos.libro_poliza enable row level security;
alter table despachos.libro_movimiento enable row level security;
alter table despachos.pago_cfdi enable row level security;
alter table despachos.pago_provisional enable row level security;

revoke all on despachos.libro_cuenta, despachos.libro_poliza, despachos.libro_movimiento, despachos.pago_cfdi, despachos.pago_provisional
  from public, anon, authenticated;

create policy "staff ve el catalogo de cuentas de sus clientes" on despachos.libro_cuenta for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve las polizas de sus clientes" on despachos.libro_poliza for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve las partidas de sus clientes" on despachos.libro_movimiento for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve los pagos de CFDI de sus clientes" on despachos.pago_cfdi for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve los pagos provisionales de sus clientes" on despachos.pago_provisional for select
  using (core.has_property_access(auth.uid(), property_id));

grant select on despachos.libro_cuenta, despachos.libro_poliza, despachos.libro_movimiento, despachos.pago_cfdi, despachos.pago_provisional
  to authenticated;
grant select, insert, update, delete on despachos.libro_cuenta, despachos.libro_poliza, despachos.libro_movimiento, despachos.pago_cfdi, despachos.pago_provisional
  to service_role;

-- ---------------------------------------------------------------------------
-- Funciones del libro.
-- ---------------------------------------------------------------------------

-- Siembra idempotente del catálogo de un cliente: [{codigo, descripcion, naturaleza}, ...]. Lo que ya existe no se toca.
create or replace function despachos.libro_catalogo_sembrar(p_property_id uuid, p_cuentas jsonb)
returns integer
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_insertadas integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'libro_catalogo_sembrar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'libro_catalogo_sembrar: la property no es de despachos' using errcode = '42501';
  end if;
  if p_cuentas is null or jsonb_typeof(p_cuentas) <> 'array' or jsonb_array_length(p_cuentas) < 1 or jsonb_array_length(p_cuentas) > 500 then
    raise exception 'libro_catalogo_sembrar: se esperan de 1 a 500 cuentas' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.libro_cuenta:' || p_property_id::text, 0));
  insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza)
  select p_property_id, v_org, btrim(c.codigo), btrim(c.descripcion), c.naturaleza
  from jsonb_to_recordset(p_cuentas) as c(codigo text, descripcion text, naturaleza text)
  on conflict (property_id, codigo) do nothing;
  get diagnostics v_insertadas = row_count;
  return v_insertadas;
exception
  when check_violation or invalid_text_representation or datatype_mismatch then
    raise exception 'libro_catalogo_sembrar: cuenta inválida (código de 4 a 10 dígitos, descripción y naturaleza D/A)' using errcode = '22023';
end;
$$;
revoke all on function despachos.libro_catalogo_sembrar(uuid, jsonb) from public;
grant execute on function despachos.libro_catalogo_sembrar(uuid, jsonb) to authenticated;

-- Alta o cambio de descripción de UNA cuenta. La naturaleza no cambia si la cuenta ya tiene partidas.
create or replace function despachos.libro_cuenta_guardar(p_property_id uuid, p_codigo text, p_descripcion text, p_naturaleza text)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_codigo text := btrim(coalesce(p_codigo, ''));
  v_desc text := btrim(coalesce(p_descripcion, ''));
  v_actual text;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'libro_cuenta_guardar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'libro_cuenta_guardar: la property no es de despachos' using errcode = '42501';
  end if;
  if v_codigo !~ '^[0-9]{4,10}$' or char_length(v_desc) < 1 or char_length(v_desc) > 200 or p_naturaleza is null or p_naturaleza not in ('D', 'A') then
    raise exception 'libro_cuenta_guardar: código de 4 a 10 dígitos, descripción de 1 a 200 caracteres y naturaleza D/A' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.libro_cuenta:' || p_property_id::text, 0));
  if (select count(*) from despachos.libro_cuenta c where c.property_id = p_property_id) >= 2000
     and not exists (select 1 from despachos.libro_cuenta c where c.property_id = p_property_id and c.codigo = v_codigo) then
    raise exception 'libro_cuenta_guardar: máximo 2000 cuentas por cliente' using errcode = '54000';
  end if;
  select c.naturaleza into v_actual from despachos.libro_cuenta c where c.property_id = p_property_id and c.codigo = v_codigo;
  if v_actual is null then
    insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values (p_property_id, v_org, v_codigo, v_desc, p_naturaleza);
  else
    if v_actual <> p_naturaleza and exists (select 1 from despachos.libro_movimiento m where m.property_id = p_property_id and m.cuenta = v_codigo) then
      raise exception 'libro_cuenta_guardar: una cuenta con partidas no cambia de naturaleza' using errcode = '22023';
    end if;
    update despachos.libro_cuenta set descripcion = v_desc, naturaleza = p_naturaleza where property_id = p_property_id and codigo = v_codigo;
  end if;
end;
$$;
revoke all on function despachos.libro_cuenta_guardar(uuid, text, text, text) from public;
grant execute on function despachos.libro_cuenta_guardar(uuid, text, text, text) to authenticated;

-- Núcleo compartido por el registro y la reversa: valida cuadre/cuentas/periodo, asigna folio e inserta. NO se expone
-- (revoke de public, sin GRANT): solo lo llaman las dos funciones públicas de abajo, que ya validaron rol y property.
create or replace function despachos.libro_poliza_insertar(
  p_property_id uuid,
  p_organization_id uuid,
  p_tipo text,
  p_fecha date,
  p_concepto text,
  p_origen text,
  p_invoice_id uuid,
  p_reversa_de uuid,
  p_movimientos jsonb
)
returns table (out_poliza_id uuid, out_folio integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_ejercicio integer;
  v_mes integer;
  v_debe bigint;
  v_haber bigint;
  v_n integer;
  v_malas integer;
  v_sin_cuenta integer;
  v_folio integer;
  v_poliza uuid;
  v_concepto text := btrim(coalesce(p_concepto, ''));
begin
  if p_tipo is null or p_tipo not in ('ingreso', 'egreso', 'diario') then
    raise exception 'libro_poliza: tipo de póliza inválido' using errcode = '22023';
  end if;
  if p_fecha is null then
    raise exception 'libro_poliza: la póliza requiere fecha' using errcode = '22023';
  end if;
  if char_length(v_concepto) < 1 or char_length(v_concepto) > 300 then
    raise exception 'libro_poliza: concepto de 1 a 300 caracteres' using errcode = '22023';
  end if;
  if p_movimientos is null or jsonb_typeof(p_movimientos) <> 'array' then
    raise exception 'libro_poliza: se esperan las partidas como arreglo' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_movimientos);
  if v_n < 2 or v_n > 200 then
    raise exception 'libro_poliza: una póliza lleva de 2 a 200 partidas' using errcode = '22023';
  end if;
  v_ejercicio := extract(year from p_fecha)::int;
  v_mes := extract(month from p_fecha)::int;
  if v_ejercicio < 2014 or v_ejercicio > 2099 then
    raise exception 'libro_poliza: ejercicio fuera de rango' using errcode = '22023';
  end if;
  if exists (select 1 from despachos.periodo_cierre pc where pc.property_id = p_property_id and pc.anio = v_ejercicio and pc.mes = v_mes and pc.status = 'closed') then
    raise exception 'libro_poliza: el periodo %-% está cerrado', v_ejercicio, lpad(v_mes::text, 2, '0') using errcode = '55000';
  end if;

  begin
    select coalesce(sum(m.debe), 0), coalesce(sum(m.haber), 0),
           count(*) filter (where m.debe < 0 or m.haber < 0 or (m.debe > 0) = (m.haber > 0)),
           count(*) filter (where not exists (select 1 from despachos.libro_cuenta c where c.property_id = p_property_id and c.codigo = m.cuenta))
      into v_debe, v_haber, v_malas, v_sin_cuenta
    from (select btrim(x.cuenta) as cuenta, coalesce(x.debe, 0) as debe, coalesce(x.haber, 0) as haber
          from jsonb_to_recordset(p_movimientos) as x(cuenta text, concepto text, debe bigint, haber bigint)) m;
  exception when invalid_text_representation or numeric_value_out_of_range or datatype_mismatch then
    raise exception 'libro_poliza: las partidas deben traer cuenta y montos enteros en centavos' using errcode = '22023';
  end;
  if v_malas > 0 then
    raise exception 'libro_poliza: cada partida lleva debe o haber (nunca ambos ni cero ni negativos)' using errcode = '22023';
  end if;
  if v_debe <> v_haber then
    raise exception 'libro_poliza: póliza descuadrada (debe % y haber % centavos)', v_debe, v_haber using errcode = '22023';
  end if;
  if v_sin_cuenta > 0 then
    raise exception 'libro_poliza: hay cuentas que no existen en el catálogo del cliente' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('despachos.libro_poliza:' || p_property_id::text || ':' || v_ejercicio::text || ':' || v_mes::text || ':' || p_tipo, 0));
  select coalesce(max(p.folio), 0) + 1 into v_folio from despachos.libro_poliza p
    where p.property_id = p_property_id and p.ejercicio = v_ejercicio and p.mes = v_mes and p.tipo = p_tipo;
  if v_folio > 5000 then
    raise exception 'libro_poliza: máximo 5000 pólizas por tipo y mes' using errcode = '54000';
  end if;

  insert into despachos.libro_poliza (organization_id, property_id, ejercicio, mes, tipo, folio, fecha, concepto, origen, invoice_id, reversa_de, total_centavos, creado_por)
  values (p_organization_id, p_property_id, v_ejercicio, v_mes, p_tipo, v_folio, p_fecha, v_concepto, p_origen, p_invoice_id, p_reversa_de, v_debe, auth.uid())
  returning id into v_poliza;
  insert into despachos.libro_movimiento (poliza_id, organization_id, property_id, linea, cuenta, concepto, debe_centavos, haber_centavos)
  select v_poliza, p_organization_id, p_property_id, (row_number() over ())::int, btrim(x.cuenta), coalesce(btrim(x.concepto), ''), coalesce(x.debe, 0), coalesce(x.haber, 0)
  from jsonb_to_recordset(p_movimientos) as x(cuenta text, concepto text, debe bigint, haber bigint);
  return query select v_poliza, v_folio;
end;
$$;
revoke all on function despachos.libro_poliza_insertar(uuid, uuid, text, date, text, text, uuid, uuid, jsonb) from public;

-- Registro de una póliza (manual, o la de un CFDI persistido). Partidas: [{cuenta, concepto, debe, haber}] en centavos.
create or replace function despachos.libro_poliza_registrar(
  p_property_id uuid,
  p_tipo text,
  p_fecha date,
  p_concepto text,
  p_movimientos jsonb,
  p_invoice_id uuid default null
)
returns table (out_poliza_id uuid, out_folio integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_estado_sat text;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'libro_poliza_registrar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'libro_poliza_registrar: la property no es de despachos' using errcode = '42501';
  end if;
  if p_invoice_id is not null then
    select i.estado_sat into v_estado_sat from despachos.invoice i where i.id = p_invoice_id and i.property_id = p_property_id for share;
    if v_estado_sat is null then
      raise exception 'libro_poliza_registrar: CFDI no encontrado' using errcode = 'P0002';
    end if;
    if v_estado_sat = 'cancelado' then
      raise exception 'libro_poliza_registrar: un CFDI cancelado ante el SAT no se contabiliza' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('despachos.libro_poliza_cfdi:' || p_invoice_id::text, 0));
    if exists (select 1 from despachos.libro_poliza lp where lp.property_id = p_property_id and lp.invoice_id = p_invoice_id and not lp.reversada) then
      raise exception 'libro_poliza_registrar: el CFDI ya tiene una póliza vigente' using errcode = '23505';
    end if;
  end if;
  return query select * from despachos.libro_poliza_insertar(
    p_property_id, v_org, p_tipo, p_fecha, p_concepto, case when p_invoice_id is null then 'manual' else 'cfdi' end, p_invoice_id, null, p_movimientos);
end;
$$;
revoke all on function despachos.libro_poliza_registrar(uuid, text, date, text, jsonb, uuid) from public;
grant execute on function despachos.libro_poliza_registrar(uuid, text, date, text, jsonb, uuid) to authenticated;

-- Reversa: crea una póliza de diario con las partidas invertidas (debe <-> haber) y marca la original como reversada.
-- La original no se modifica en importes; el libro nunca pierde historia.
create or replace function despachos.libro_poliza_reversar(p_poliza_id uuid, p_fecha date, p_concepto text)
returns table (out_poliza_id uuid, out_folio integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_prop uuid;
  v_org uuid;
  v_origen text;
  v_reversada boolean;
  v_movs jsonb;
begin
  select lp.property_id, lp.organization_id, lp.origen, lp.reversada into v_prop, v_org, v_origen, v_reversada
  from despachos.libro_poliza lp where lp.id = p_poliza_id for update;
  if v_prop is null or auth.uid() is null or not despachos.cartera_puede_escribir(v_prop) then
    -- misma respuesta para "no existe" y "no es tuya": no confirma pólizas ajenas.
    raise exception 'libro_poliza_reversar: póliza no encontrada o sin permiso' using errcode = '42501';
  end if;
  if v_origen = 'reversa' then
    raise exception 'libro_poliza_reversar: una póliza de reversa no se revierte; registra una póliza nueva' using errcode = '22023';
  end if;
  if v_reversada then
    raise exception 'libro_poliza_reversar: la póliza ya fue revertida' using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object('cuenta', m.cuenta, 'concepto', m.concepto, 'debe', m.haber_centavos, 'haber', m.debe_centavos) order by m.linea)
    into v_movs from despachos.libro_movimiento m where m.poliza_id = p_poliza_id;
  return query select * from despachos.libro_poliza_insertar(v_prop, v_org, 'diario', p_fecha, p_concepto, 'reversa', null, p_poliza_id, v_movs);
  update despachos.libro_poliza set reversada = true where id = p_poliza_id;
end;
$$;
revoke all on function despachos.libro_poliza_reversar(uuid, date, text) from public;
grant execute on function despachos.libro_poliza_reversar(uuid, date, text) to authenticated;

-- Balanza de comprobación derivada (centavos). Saldo inicial: cuentas de balance (1, 2, 3) acumulan TODO lo anterior al
-- mes; cuentas de resultados (4 en adelante) solo desde enero del ejercicio (no hay póliza de cierre de ejercicio).
-- SECURITY INVOKER: RLS del staff decide qué property puede ver.
create or replace function despachos.libro_balanza(p_property_id uuid, p_ejercicio integer, p_mes integer)
returns table (
  out_cuenta text,
  out_descripcion text,
  out_naturaleza text,
  out_saldo_inicial_centavos bigint,
  out_debe_centavos bigint,
  out_haber_centavos bigint,
  out_saldo_final_centavos bigint
)
language sql
stable
security invoker
set search_path = despachos, pg_temp
as $$
  with mov as (
    select m.cuenta, p.ejercicio, p.mes, m.debe_centavos, m.haber_centavos
    from despachos.libro_movimiento m
    join despachos.libro_poliza p on p.id = m.poliza_id
    where m.property_id = p_property_id
      and (p.ejercicio < p_ejercicio or (p.ejercicio = p_ejercicio and p.mes <= p_mes))
  ), agg as (
    select
      mov.cuenta,
      coalesce(sum(case when (mov.ejercicio = p_ejercicio and mov.mes = p_mes) then mov.debe_centavos else 0 end), 0)::bigint as debe,
      coalesce(sum(case when (mov.ejercicio = p_ejercicio and mov.mes = p_mes) then mov.haber_centavos else 0 end), 0)::bigint as haber,
      coalesce(sum(case when (mov.ejercicio = p_ejercicio and mov.mes < p_mes)
                          or (mov.ejercicio < p_ejercicio and left(mov.cuenta, 1) in ('1', '2', '3')) then mov.debe_centavos else 0 end), 0)::bigint as debe_ini,
      coalesce(sum(case when (mov.ejercicio = p_ejercicio and mov.mes < p_mes)
                          or (mov.ejercicio < p_ejercicio and left(mov.cuenta, 1) in ('1', '2', '3')) then mov.haber_centavos else 0 end), 0)::bigint as haber_ini
    from mov
    group by mov.cuenta
  )
  select a.cuenta, c.descripcion, c.naturaleza,
         (case when c.naturaleza = 'D' then a.debe_ini - a.haber_ini else a.haber_ini - a.debe_ini end)::bigint,
         a.debe, a.haber,
         (case when c.naturaleza = 'D' then a.debe_ini - a.haber_ini + a.debe - a.haber else a.haber_ini - a.debe_ini + a.haber - a.debe end)::bigint
  from agg a
  join despachos.libro_cuenta c on c.property_id = p_property_id and c.codigo = a.cuenta
  where (a.debe <> 0 or a.haber <> 0 or a.debe_ini <> 0 or a.haber_ini <> 0)
  order by a.cuenta;
$$;
revoke all on function despachos.libro_balanza(uuid, integer, integer) from public;
grant execute on function despachos.libro_balanza(uuid, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Pagos de REP persistidos.
-- ---------------------------------------------------------------------------
create or replace function despachos.pago_cfdi_registrar(
  p_property_id uuid,
  p_invoice_id uuid,
  p_folio_fiscal_rep text,
  p_pago_index integer,
  p_fecha_pago date,
  p_flujo text,
  p_num_parcialidad integer,
  p_importe_pagado_centavos bigint,
  p_base_centavos bigint,
  p_iva_centavos bigint,
  p_iva_retenido_centavos bigint
)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_metodo text;
  v_moneda text;
  v_direccion text;
  v_estado_sat text;
  v_total bigint;
  v_subtotal bigint;
  v_pagado bigint;
  v_insertadas integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'pago_cfdi_registrar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_flujo is null or p_flujo not in ('trasladado', 'acreditable')
     or p_importe_pagado_centavos is null or p_importe_pagado_centavos <= 0
     or p_base_centavos is null or p_base_centavos < 0 or p_iva_centavos is null or p_iva_centavos < 0
     or coalesce(p_iva_retenido_centavos, 0) < 0 or p_fecha_pago is null or p_pago_index is null or p_pago_index < 0
     or p_folio_fiscal_rep is null or p_folio_fiscal_rep !~ '^[0-9A-Fa-f-]{36}$' then
    raise exception 'pago_cfdi_registrar: datos del pago inválidos' using errcode = '22023';
  end if;
  select i.organization_id, i.metodo_pago, i.moneda, i.direccion, i.estado_sat, i.total_centavos, i.subtotal_centavos
    into v_org, v_metodo, v_moneda, v_direccion, v_estado_sat, v_total, v_subtotal
  from despachos.invoice i where i.id = p_invoice_id and i.property_id = p_property_id for update;
  if v_org is null then
    raise exception 'pago_cfdi_registrar: CFDI no encontrado' using errcode = 'P0002';
  end if;
  if v_metodo is distinct from 'PPD' then
    raise exception 'pago_cfdi_registrar: solo un CFDI con método de pago PPD se paga con complemento' using errcode = '22023';
  end if;
  if coalesce(v_moneda, 'MXN') <> 'MXN' then
    raise exception 'pago_cfdi_registrar: solo se registran pagos de CFDI en pesos mexicanos' using errcode = '22023';
  end if;
  if v_estado_sat in ('cancelado', 'no_encontrado') then
    raise exception 'pago_cfdi_registrar: el CFDI está cancelado o no existe ante el SAT' using errcode = '22023';
  end if;
  if (p_flujo = 'trasladado' and v_direccion is distinct from 'emitido') or (p_flujo = 'acreditable' and v_direccion is distinct from 'recibido') then
    raise exception 'pago_cfdi_registrar: el flujo no corresponde al sentido del CFDI (emitido/recibido)' using errcode = '22023';
  end if;
  if v_total is null or v_subtotal is null or p_base_centavos > v_subtotal or p_iva_centavos > v_total then
    raise exception 'pago_cfdi_registrar: la base o el IVA exceden los montos del CFDI' using errcode = '22023';
  end if;
  select coalesce(sum(pc.importe_pagado_centavos), 0) into v_pagado from despachos.pago_cfdi pc
    where pc.invoice_id = p_invoice_id
      and not (pc.folio_fiscal_rep = p_folio_fiscal_rep and pc.pago_index = p_pago_index);
  if v_pagado + p_importe_pagado_centavos > v_total then
    raise exception 'pago_cfdi_registrar: los pagos suman más que el total del CFDI' using errcode = '22023';
  end if;
  insert into despachos.pago_cfdi (organization_id, property_id, invoice_id, folio_fiscal_rep, pago_index, fecha_pago, flujo, num_parcialidad,
                                    importe_pagado_centavos, base_centavos, iva_centavos, iva_retenido_centavos, creado_por)
  values (v_org, p_property_id, p_invoice_id, lower(p_folio_fiscal_rep), p_pago_index, p_fecha_pago, p_flujo, p_num_parcialidad,
          p_importe_pagado_centavos, p_base_centavos, p_iva_centavos, coalesce(p_iva_retenido_centavos, 0), auth.uid())
  on conflict (property_id, folio_fiscal_rep, pago_index, invoice_id) do nothing;
  get diagnostics v_insertadas = row_count;
  return v_insertadas = 1;
end;
$$;
revoke all on function despachos.pago_cfdi_registrar(uuid, uuid, text, integer, date, text, integer, bigint, bigint, bigint, bigint) from public;
grant execute on function despachos.pago_cfdi_registrar(uuid, uuid, text, integer, date, text, integer, bigint, bigint, bigint, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Papel de trabajo del pago provisional.
-- ---------------------------------------------------------------------------
create or replace function despachos.pago_provisional_guardar(
  p_property_id uuid,
  p_ejercicio integer,
  p_mes integer,
  p_impuesto text,
  p_regimen text,
  p_base_centavos bigint,
  p_determinado_centavos bigint,
  p_acreditable_centavos bigint,
  p_a_cargo_centavos bigint,
  p_a_favor_centavos bigint,
  p_parametros jsonb,
  p_advertencias integer
)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_estado text;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'pago_provisional_guardar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'pago_provisional_guardar: la property no es de despachos' using errcode = '42501';
  end if;
  if p_ejercicio is null or p_ejercicio not between 2014 and 2099 or p_mes is null or p_mes not between 1 and 12
     or p_impuesto is null or p_impuesto not in ('ISR', 'IVA') or p_regimen is null or p_regimen !~ '^[0-9]{3}$'
     or coalesce(p_base_centavos, -1) < 0 or coalesce(p_determinado_centavos, -1) < 0 or coalesce(p_acreditable_centavos, -1) < 0
     or coalesce(p_a_cargo_centavos, -1) < 0 or coalesce(p_a_favor_centavos, -1) < 0
     or (p_a_cargo_centavos > 0 and p_a_favor_centavos > 0)
     or p_parametros is null or jsonb_typeof(p_parametros) <> 'object' or coalesce(p_advertencias, -1) < 0 then
    raise exception 'pago_provisional_guardar: datos del papel de trabajo inválidos' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.pago_provisional:' || p_property_id::text || ':' || p_ejercicio::text || ':' || p_mes::text || ':' || p_impuesto, 0));
  select pp.estado into v_estado from despachos.pago_provisional pp
    where pp.property_id = p_property_id and pp.ejercicio = p_ejercicio and pp.mes = p_mes and pp.impuesto = p_impuesto;
  if v_estado = 'presentado' then
    raise exception 'pago_provisional_guardar: el pago provisional ya fue presentado; no se recalcula' using errcode = '55000';
  end if;
  insert into despachos.pago_provisional (organization_id, property_id, ejercicio, mes, impuesto, regimen, base_centavos, determinado_centavos,
                                           acreditable_centavos, a_cargo_centavos, a_favor_centavos, parametros, advertencias, creado_por)
  values (v_org, p_property_id, p_ejercicio, p_mes, p_impuesto, p_regimen, p_base_centavos, p_determinado_centavos,
          p_acreditable_centavos, p_a_cargo_centavos, p_a_favor_centavos, p_parametros, p_advertencias, auth.uid())
  on conflict (property_id, ejercicio, mes, impuesto) do update
    set regimen = excluded.regimen, base_centavos = excluded.base_centavos, determinado_centavos = excluded.determinado_centavos,
        acreditable_centavos = excluded.acreditable_centavos, a_cargo_centavos = excluded.a_cargo_centavos, a_favor_centavos = excluded.a_favor_centavos,
        parametros = excluded.parametros, advertencias = excluded.advertencias, updated_at = now();
end;
$$;
revoke all on function despachos.pago_provisional_guardar(uuid, integer, integer, text, text, bigint, bigint, bigint, bigint, bigint, jsonb, integer) from public;
grant execute on function despachos.pago_provisional_guardar(uuid, integer, integer, text, text, bigint, bigint, bigint, bigint, bigint, jsonb, integer) to authenticated;

-- Marca el papel como presentado (monto efectivamente pagado y fecha) y cierra el vencimiento del calendario fiscal del
-- mismo periodo (si existe). Presentar no recalcula: lo guardado es lo que se presentó.
create or replace function despachos.pago_provisional_presentar(
  p_property_id uuid,
  p_ejercicio integer,
  p_mes integer,
  p_impuesto text,
  p_monto_pagado_centavos bigint,
  p_fecha_presentacion date
)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado text;
  v_periodo text;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'pago_provisional_presentar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_monto_pagado_centavos is null or p_monto_pagado_centavos < 0 or p_fecha_presentacion is null or p_impuesto is null or p_impuesto not in ('ISR', 'IVA') then
    raise exception 'pago_provisional_presentar: monto y fecha de presentación inválidos' using errcode = '22023';
  end if;
  select pp.estado into v_estado from despachos.pago_provisional pp
    where pp.property_id = p_property_id and pp.ejercicio = p_ejercicio and pp.mes = p_mes and pp.impuesto = p_impuesto for update;
  if v_estado is null then
    raise exception 'pago_provisional_presentar: no hay papel de trabajo guardado para ese periodo' using errcode = 'P0002';
  end if;
  if v_estado = 'presentado' then
    raise exception 'pago_provisional_presentar: el pago provisional ya fue presentado' using errcode = '55000';
  end if;
  update despachos.pago_provisional
    set estado = 'presentado', monto_pagado_centavos = p_monto_pagado_centavos, fecha_presentacion = p_fecha_presentacion, updated_at = now()
    where property_id = p_property_id and ejercicio = p_ejercicio and mes = p_mes and impuesto = p_impuesto;
  v_periodo := p_ejercicio::text || '-' || lpad(p_mes::text, 2, '0');
  update despachos.fiscal_deadline
    set estado = 'completado', fecha_presentacion = p_fecha_presentacion
    where property_id = p_property_id and tipo = p_impuesto and periodo = v_periodo and estado <> 'completado';
end;
$$;
revoke all on function despachos.pago_provisional_presentar(uuid, integer, integer, text, bigint, date) from public;
grant execute on function despachos.pago_provisional_presentar(uuid, integer, integer, text, bigint, date) to authenticated;

-- Solo-sistema: cuántas obligaciones de pago provisional (ISR/IVA) por organización vencen dentro de `p_dias` días (o ya
-- vencieron en la ventana) y todavía no tienen un papel PRESENTADO. Devuelve solo organización + conteo: sin RFC, nombres
-- ni montos (el texto de la notificación es de catálogo y no lleva PII).
create or replace function despachos.system_pagos_provisionales_por_vencer(p_hoy date, p_dias integer)
returns table (out_organization_id uuid, out_cantidad integer)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_pagos_provisionales_por_vencer es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_hoy is null or p_dias is null or p_dias < 0 or p_dias > 31 then
    raise exception 'system_pagos_provisionales_por_vencer: fecha o ventana inválida' using errcode = '22023';
  end if;
  return query
    select d.organization_id, count(*)::integer
    from despachos.fiscal_deadline d
    join core.property p on p.id = d.property_id and p.status = 'active'
    where d.tipo in ('ISR', 'IVA')
      and d.estado <> 'completado'
      and d.fecha_limite between p_hoy and p_hoy + p_dias
      and not exists (
        select 1 from despachos.pago_provisional pp
        where pp.property_id = d.property_id and pp.impuesto = d.tipo and pp.estado = 'presentado'
          and pp.ejercicio::text || '-' || lpad(pp.mes::text, 2, '0') = d.periodo
      )
    group by d.organization_id;
end;
$$;
revoke all on function despachos.system_pagos_provisionales_por_vencer(date, integer) from public;
grant execute on function despachos.system_pagos_provisionales_por_vencer(date, integer) to authenticated;
