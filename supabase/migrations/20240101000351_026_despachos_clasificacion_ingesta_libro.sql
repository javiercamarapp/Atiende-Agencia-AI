-- D-P3-13/14/18/22/23 (paridad3, "del XML a la póliza sin manos") -- SQL de la clasificación contable al ingerir, las pólizas del periodo, la llave
-- del UUID por cliente, la marca de rechazo de una revisión y el autoaceptado del portal.
--
-- Qué hace (todo aditivo salvo la llave del UUID, que se RELAJA, y la marca de rechazo, que se rellena para lo ya rechazado):
--   1. `invoice_classification`: amplía los CHECK de `categoria` (las categorías finas del catálogo de mapeos de bookkeeping + `otros`) y de `method`
--      (`reglas`, `claveprodserv`, `correccion`); columnas `property_id`, `razon`, `cuenta`, `empate`; las escrituras pasan por funciones.
--   2. `clasificacion_correccion`: correcciones del despacho por RFC emisor (y ClaveProdServ opcional) -> categoría y cuenta, con autor y fecha.
--   3. `invoice.excluido_por_revision`: un trigger la marca cuando una revisión se RECHAZA; los agregados la excluyen (TypeScript).
--   4. Llave única del UUID: de `(organization_id, folio_fiscal)` a `(property_id, folio_fiscal)`. Un CFDI entre dos clientes del mismo despacho entra
--      a los dos. La llave nueva es MÁS laxa que la vieja (toda pareja (property, folio) única ya lo era por organización), así que no hay duplicados
--      posibles al crearla.
--   5. `property_config`: `clasificacion_umbral_confianza` (0.5 a 1, 0.7 por omisión; el piso duro de 0.5 vive también aquí) y `portal_autoaceptar_validos`.
--   6. `invoice_direccion_recalcular`: recalcula `direccion` de los CFDI `indeterminado` cuando se captura/edita la ficha del cliente.
--   7. Pólizas del periodo: el núcleo `libro_poliza_insertar` se parte en un núcleo sin guard (`libro_poliza_insertar_nucleo`, sin EXECUTE para nadie) y la
--      función con guard de siempre; `system_polizas_periodo_candidatos` y `system_poliza_cfdi_registrar` (solo sistema) alimentan el cron.
--   8. Portal: `portal_cliente_cfdi_listar` (el cliente ve sus CFDI), `system_portal_ingesta_contexto` y `system_portal_cfdi_aceptar` (autoaceptado).
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-ingesta-libro/assertions.sql):
--   * Ningún GRANT a anon. `invoice_classification` pierde el INSERT directo de `authenticated` (la policy de 001 dejaba a cualquier miembro de la
--     organización escribir clasificaciones de CUALQUIER property): ahora se escribe solo con `invoice_clasificar`/`invoice_categoria_corregir`
--     (definer, rol admin/contador + acceso a la property + el CFDI debe ser de esa property) y se lee por property (`core.has_property_access`).
--   * `clasificacion_correccion`: RLS + solo `select` a authenticated; escritura solo por `clasificacion_correccion_guardar/_eliminar` (definer,
--     `despachos.cartera_puede_escribir`); tope de 1000 por cliente; RFC y ClaveProdServ validados por CHECK.
--   * Toda función definer lleva `set search_path` fijo y `revoke ... from public, anon`. Las de staff exigen `auth.uid()` no nulo y permiso sobre la
--     property; las `system_*` exigen `auth.uid() is null`; el núcleo de pólizas no tiene EXECUTE para nadie.
--   * `system_poliza_cfdi_registrar`: un CFDI cancelado, excluido por revisión, con revisión pendiente o ya contabilizado NO genera póliza; un periodo
--     cerrado se omite (no se escribe). El actor queda como NULL (`creado_por`), señal de póliza del sistema.
--   * `system_portal_cfdi_aceptar`: solo si el documento está `recibido`, es XML de CFDI, la property tiene la bandera encendida EN LA BASE, el UUID no
--     existe en esa property y el periodo no está cerrado; la property y la organización las deriva la base del documento (el llamador no elige).
--   * `portal_cliente_cfdi_listar`: sesión de sistema + token vigente; devuelve SOLO los CFDI de la property del enlace.
--
-- Compatibilidad con la base sin migrar: el TypeScript captura 42883/42P01/42703 en SAVEPOINT y cae al camino anterior o a "no disponible aún".
-- Se puede aplicar antes o después del código.

-- ---------------------------------------------------------------------------
-- 1. invoice_classification
-- ---------------------------------------------------------------------------
alter table despachos.invoice_classification drop constraint if exists invoice_classification_categoria_check;
alter table despachos.invoice_classification add constraint invoice_classification_categoria_check check (categoria in (
  'gasto_operativo', 'activo_fijo', 'inversion', 'honorarios', 'nomina', 'sin_clasificar',
  'servicios_profesionales', 'renta_oficina', 'materia_prima', 'publicidad', 'honorarios_legales', 'comision_bancaria', 'intereses_bancarios',
  'arrendamiento', 'seguros', 'telefonia', 'transporte', 'equipo_computo', 'mantenimiento', 'papeleria', 'venta_servicios', 'venta_mercancia', 'otros'));
alter table despachos.invoice_classification drop constraint if exists invoice_classification_method_check;
alter table despachos.invoice_classification add constraint invoice_classification_method_check
  check (method in ('manual', 'heuristica_claveprodserv', 'reglas', 'claveprodserv', 'correccion'));

alter table despachos.invoice_classification
  add column if not exists property_id uuid references core.property(id) on delete cascade,
  add column if not exists razon text check (razon is null or char_length(razon) <= 300),
  add column if not exists cuenta text check (cuenta is null or cuenta ~ '^[0-9]{4,10}$'),
  add column if not exists empate boolean not null default false;
update despachos.invoice_classification c set property_id = i.property_id from despachos.invoice i where i.id = c.invoice_id and c.property_id is null;
alter table despachos.invoice_classification alter column property_id set not null;
-- La clasificación no puede apuntar al CFDI de OTRA property u organización aunque se mienta en property_id.
alter table despachos.invoice_classification drop constraint if exists invoice_classification_invoice_compuesta_fk;
alter table despachos.invoice_classification add constraint invoice_classification_invoice_compuesta_fk
  foreign key (invoice_id, organization_id, property_id) references despachos.invoice (id, organization_id, property_id) on delete cascade;
create index if not exists invoice_classification_invoice_fecha_idx on despachos.invoice_classification (invoice_id, created_at desc);

-- Lectura por property (antes: toda la organización). Escritura: solo por las funciones de abajo.
drop policy if exists "staff ve clasificaciones de invoices de su organización" on despachos.invoice_classification;
drop policy if exists "staff inserta clasificaciones de su organización" on despachos.invoice_classification;
create policy "staff ve clasificaciones de CFDI de su property" on despachos.invoice_classification for select
  using (core.has_property_access(auth.uid(), property_id));
revoke insert on despachos.invoice_classification from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Correcciones por RFC
-- ---------------------------------------------------------------------------
create table despachos.clasificacion_correccion (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  rfc_emisor text not null check (rfc_emisor ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  clave_prod_serv text check (clave_prod_serv is null or clave_prod_serv ~ '^[0-9]{8}$'),
  categoria text not null check (categoria in (
    'servicios_profesionales', 'renta_oficina', 'materia_prima', 'publicidad', 'honorarios_legales', 'comision_bancaria', 'intereses_bancarios', 'nomina',
    'arrendamiento', 'seguros', 'telefonia', 'transporte', 'equipo_computo', 'mantenimiento', 'papeleria', 'venta_servicios', 'venta_mercancia', 'otros')),
  cuenta text check (cuenta is null or cuenta ~ '^[0-9]{4,10}$'),
  autor_id uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index clasificacion_correccion_clave_uk on despachos.clasificacion_correccion (property_id, rfc_emisor, coalesce(clave_prod_serv, ''));
create index clasificacion_correccion_org_idx on despachos.clasificacion_correccion (organization_id);
alter table despachos.clasificacion_correccion enable row level security;
revoke all on despachos.clasificacion_correccion from public, anon, authenticated;
create policy "staff ve las correcciones de clasificacion de su property" on despachos.clasificacion_correccion for select
  using (core.has_property_access(auth.uid(), property_id));
grant select on despachos.clasificacion_correccion to authenticated;
grant select, insert, update, delete on despachos.clasificacion_correccion to service_role;

-- Clasifica un CFDI: SIEMPRE una fila nueva (nunca update silencioso). Quien llama es el staff de la ingesta (admin/contador).
create or replace function despachos.invoice_clasificar(
  p_property_id uuid, p_invoice_id uuid, p_categoria text, p_confianza numeric, p_method text, p_razon text, p_cuenta text, p_empate boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'invoice_clasificar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_method is null or p_method not in ('manual', 'reglas', 'claveprodserv', 'correccion') then
    raise exception 'invoice_clasificar: método inválido' using errcode = '22023';
  end if;
  select i.organization_id into v_org from despachos.invoice i where i.id = p_invoice_id and i.property_id = p_property_id;
  if v_org is null then
    raise exception 'invoice_clasificar: CFDI no encontrado' using errcode = 'P0002';
  end if;
  insert into despachos.invoice_classification (invoice_id, organization_id, property_id, categoria, confianza, method, classified_by, razon, cuenta, empate)
  values (p_invoice_id, v_org, p_property_id, p_categoria, case when p_method = 'manual' then 1 else p_confianza end, p_method, auth.uid(),
          nullif(btrim(coalesce(p_razon, '')), ''), nullif(btrim(coalesce(p_cuenta, '')), ''), coalesce(p_empate, false))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function despachos.invoice_clasificar(uuid, uuid, text, numeric, text, text, text, boolean) from public, anon;
grant execute on function despachos.invoice_clasificar(uuid, uuid, text, numeric, text, text, text, boolean) to authenticated;

-- Corrección humana de la categoría de UN CFDI (fila nueva, method 'manual', confianza 1) y, si se pide, la regla por RFC emisor para los siguientes.
create or replace function despachos.invoice_categoria_corregir(p_property_id uuid, p_invoice_id uuid, p_categoria text, p_cuenta text, p_guardar_regla boolean)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_rfc text;
  v_id uuid;
  v_cuenta text := nullif(btrim(coalesce(p_cuenta, '')), '');
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'invoice_categoria_corregir: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select i.organization_id, upper(btrim(i.rfc_emisor)) into v_org, v_rfc from despachos.invoice i where i.id = p_invoice_id and i.property_id = p_property_id for share;
  if v_org is null then
    raise exception 'invoice_categoria_corregir: CFDI no encontrado' using errcode = 'P0002';
  end if;
  insert into despachos.invoice_classification (invoice_id, organization_id, property_id, categoria, confianza, method, classified_by, razon, cuenta, empate)
  values (p_invoice_id, v_org, p_property_id, p_categoria, 1, 'manual', auth.uid(), 'Corrección humana', v_cuenta, false)
  returning id into v_id;
  if coalesce(p_guardar_regla, false) then
    perform despachos.clasificacion_correccion_guardar(p_property_id, v_rfc, null, p_categoria, v_cuenta);
  end if;
  return v_id;
end;
$$;
revoke all on function despachos.invoice_categoria_corregir(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function despachos.invoice_categoria_corregir(uuid, uuid, text, text, boolean) to authenticated;

create or replace function despachos.clasificacion_correccion_guardar(p_property_id uuid, p_rfc text, p_clave_prod_serv text, p_categoria text, p_cuenta text)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_id uuid;
  v_rfc text := upper(btrim(coalesce(p_rfc, '')));
  v_cp text := nullif(btrim(coalesce(p_clave_prod_serv, '')), '');
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'clasificacion_correccion_guardar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'clasificacion_correccion_guardar: la property no es de despachos' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.clasificacion_correccion:' || p_property_id::text, 0));
  if not exists (select 1 from despachos.clasificacion_correccion c where c.property_id = p_property_id and c.rfc_emisor = v_rfc and coalesce(c.clave_prod_serv, '') = coalesce(v_cp, ''))
     and (select count(*) from despachos.clasificacion_correccion c where c.property_id = p_property_id) >= 1000 then
    raise exception 'clasificacion_correccion_guardar: máximo 1000 correcciones por cliente' using errcode = '54000';
  end if;
  insert into despachos.clasificacion_correccion (organization_id, property_id, rfc_emisor, clave_prod_serv, categoria, cuenta, autor_id)
  values (v_org, p_property_id, v_rfc, v_cp, p_categoria, nullif(btrim(coalesce(p_cuenta, '')), ''), auth.uid())
  on conflict (property_id, rfc_emisor, coalesce(clave_prod_serv, '')) do update
    set categoria = excluded.categoria, cuenta = excluded.cuenta, autor_id = excluded.autor_id, updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function despachos.clasificacion_correccion_guardar(uuid, text, text, text, text) from public, anon;
grant execute on function despachos.clasificacion_correccion_guardar(uuid, text, text, text, text) to authenticated;

create or replace function despachos.clasificacion_correccion_eliminar(p_property_id uuid, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'clasificacion_correccion_eliminar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  delete from despachos.clasificacion_correccion where id = p_id and property_id = p_property_id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function despachos.clasificacion_correccion_eliminar(uuid, uuid) from public, anon;
grant execute on function despachos.clasificacion_correccion_eliminar(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Rechazo de una revisión -> el CFDI queda excluido
-- ---------------------------------------------------------------------------
alter table despachos.invoice add column if not exists excluido_por_revision boolean not null default false;

create or replace function despachos.invoice_review_marcar_exclusion()
returns trigger
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
begin
  if new.status = 'rechazado' and old.status = 'pendiente' then
    update despachos.invoice set excluido_por_revision = true where id = new.invoice_id and property_id = new.property_id;
  end if;
  return new;
end;
$$;
revoke all on function despachos.invoice_review_marcar_exclusion() from public, anon, authenticated;
drop trigger if exists invoice_review_exclusion on despachos.invoice_review;
create trigger invoice_review_exclusion after update of status on despachos.invoice_review
  for each row execute function despachos.invoice_review_marcar_exclusion();

-- Lo ya rechazado antes de esta migración también deja de contar en los agregados (era el defecto: rechazar no tenía efecto).
update despachos.invoice i set excluido_por_revision = true
  from despachos.invoice_review r where r.invoice_id = i.id and r.status = 'rechazado' and not i.excluido_por_revision;

-- ---------------------------------------------------------------------------
-- 4. UUID único por cliente
-- ---------------------------------------------------------------------------
alter table despachos.invoice add constraint invoice_property_folio_fiscal_uk unique (property_id, folio_fiscal);
alter table despachos.invoice drop constraint if exists invoice_organization_id_folio_fiscal_key;

-- ---------------------------------------------------------------------------
-- 5. Configuración por cliente
-- ---------------------------------------------------------------------------
alter table despachos.property_config
  add column if not exists clasificacion_umbral_confianza numeric(4, 3) not null default 0.700
    check (clasificacion_umbral_confianza >= 0.500 and clasificacion_umbral_confianza <= 1.000),
  add column if not exists portal_autoaceptar_validos boolean not null default true;

-- ---------------------------------------------------------------------------
-- 6. Dirección de los CFDI indeterminados al capturar la ficha
-- ---------------------------------------------------------------------------
create or replace function despachos.invoice_direccion_recalcular(p_property_id uuid)
returns integer
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_rfc text;
  v_n integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'invoice_direccion_recalcular: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select upper(btrim(f.rfc)) into v_rfc from despachos.cliente_ficha f where f.property_id = p_property_id;
  if v_rfc is null or v_rfc = '' then
    return 0;
  end if;
  update despachos.invoice i
     set direccion = case when upper(btrim(i.rfc_emisor)) = v_rfc then 'emitido' else 'recibido' end
   where i.property_id = p_property_id
     and i.direccion = 'indeterminado'
     and (upper(btrim(i.rfc_emisor)) = v_rfc or upper(btrim(i.rfc_receptor)) = v_rfc);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function despachos.invoice_direccion_recalcular(uuid) from public, anon;
grant execute on function despachos.invoice_direccion_recalcular(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Pólizas del periodo (cron de sistema)
-- ---------------------------------------------------------------------------
-- El cuerpo de `libro_poliza_insertar` (020) pasa a un núcleo SIN guard de sesión y con el actor explícito. El núcleo no tiene EXECUTE para nadie
-- (solo lo llaman las funciones definer de abajo, mismo owner); `libro_poliza_insertar` conserva el guard de siempre y delega con `auth.uid()`.
create or replace function despachos.libro_poliza_insertar_nucleo(
  p_property_id uuid,
  p_organization_id uuid,
  p_tipo text,
  p_fecha date,
  p_concepto text,
  p_origen text,
  p_invoice_id uuid,
  p_reversa_de uuid,
  p_movimientos jsonb,
  p_creado_por uuid
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
  if p_property_id is null or not exists (select 1 from core.property pr where pr.id = p_property_id and pr.organization_id = p_organization_id and pr.vertical = 'despachos') then
    raise exception 'libro_poliza_insertar: la property no es de despachos' using errcode = '42501';
  end if;
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
  values (p_organization_id, p_property_id, v_ejercicio, v_mes, p_tipo, v_folio, p_fecha, v_concepto, p_origen, p_invoice_id, p_reversa_de, v_debe, p_creado_por)
  returning id into v_poliza;
  insert into despachos.libro_movimiento (poliza_id, organization_id, property_id, linea, cuenta, concepto, debe_centavos, haber_centavos)
  select v_poliza, p_organization_id, p_property_id, e.ord::int, btrim(e.elem->>'cuenta'), coalesce(btrim(e.elem->>'concepto'), ''),
         coalesce((e.elem->>'debe')::bigint, 0), coalesce((e.elem->>'haber')::bigint, 0)
  from jsonb_array_elements(p_movimientos) with ordinality as e(elem, ord);
  return query select v_poliza, v_folio;
end;
$$;
revoke all on function despachos.libro_poliza_insertar_nucleo(uuid, uuid, text, date, text, text, uuid, uuid, jsonb, uuid) from public, anon, authenticated;

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
begin
  if auth.uid() is null or p_property_id is null or not despachos.cartera_puede_escribir(p_property_id)
     or not exists (select 1 from core.property pr where pr.id = p_property_id and pr.organization_id = p_organization_id and pr.vertical = 'despachos') then
    raise exception 'libro_poliza_insertar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  return query select * from despachos.libro_poliza_insertar_nucleo(p_property_id, p_organization_id, p_tipo, p_fecha, p_concepto, p_origen, p_invoice_id, p_reversa_de, p_movimientos, auth.uid());
end;
$$;
revoke all on function despachos.libro_poliza_insertar(uuid, uuid, text, date, text, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- Solo sistema: CFDI del periodo que SÍ se pueden contabilizar solos: clasificados con confianza suficiente (o por una persona), sin revisión pendiente, no cancelados ni excluidos, sin póliza
-- vigente, con sentido emitido/recibido y de una property activa con periodo no cerrado. Devuelve lo necesario para armar la póliza en TypeScript
-- (sin nombres ni RFC de terceros). Tope duro de 500 por llamada.
create or replace function despachos.system_polizas_periodo_candidatos(p_desde date, p_hasta date, p_limit integer)
returns table (
  out_organization_id uuid,
  out_property_id uuid,
  out_invoice_id uuid,
  out_folio_fiscal text,
  out_tipo text,
  out_direccion text,
  out_fecha date,
  out_moneda text,
  out_estado_sat text,
  out_subtotal_centavos bigint,
  out_descuento_centavos bigint,
  out_total_centavos bigint,
  out_iva_trasladado_centavos bigint,
  out_isr_retenido_centavos bigint,
  out_iva_retenido_centavos bigint,
  out_ieps_centavos bigint,
  out_categoria text,
  out_cuenta text
)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_polizas_periodo_candidatos es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 400 or p_limit is null or p_limit < 1 then
    raise exception 'system_polizas_periodo_candidatos: ventana o límite inválidos' using errcode = '22023';
  end if;
  return query
    select i.organization_id, i.property_id, i.id, i.folio_fiscal::text, i.tipo, i.direccion, i.fecha, i.moneda, i.estado_sat,
           i.subtotal_centavos, i.descuento_centavos, i.total_centavos, i.iva_trasladado_centavos, i.isr_retenido_centavos, i.iva_retenido_centavos, i.ieps_centavos,
           c.categoria, c.cuenta
    from despachos.invoice i
    join core.property p on p.id = i.property_id and p.status = 'active' and p.vertical = 'despachos'
    join lateral (
      select ic.categoria, ic.cuenta, ic.confianza, ic.method, ic.empate
      from despachos.invoice_classification ic where ic.invoice_id = i.id order by ic.created_at desc, ic.id desc limit 1
    ) c on true
    where i.fecha between p_desde and p_hasta
      -- Solo lo que pasa la compuerta de la clasificación (la misma de la ingesta): hecha por una persona (manual/corrección), o sin empate y con
      -- confianza >= max(piso 0.5, umbral del cliente). Una clasificación dudosa nunca se contabiliza sola.
      and not c.empate
      and (c.method in ('manual', 'correccion')
           or c.confianza >= greatest(0.5, coalesce((select pc.clasificacion_umbral_confianza from despachos.property_config pc where pc.property_id = i.property_id), 0.7)))
      and i.tipo = 'I'
      and i.direccion in ('emitido', 'recibido')
      and i.estado_sat <> 'cancelado'
      and not i.excluido_por_revision
      -- Solo lo que la póliza automática puede armar sin inventar (las mismas condiciones de `construirPolizaDesdeCfdi`): pesos, sin retenciones ni IEPS,
      -- con centavos y total = base + IVA, y una categoría que tenga cuenta de gasto (para lo recibido; lo emitido no depende de la categoría).
      -- Así un CFDI que el staff debe registrar a mano no ocupa el cupo de cada corrida.
      and coalesce(i.moneda, 'MXN') = 'MXN'
      and i.subtotal_centavos is not null and i.total_centavos is not null
      and coalesce(i.isr_retenido_centavos, 0) = 0 and coalesce(i.iva_retenido_centavos, 0) = 0 and coalesce(i.ieps_centavos, 0) = 0
      and i.subtotal_centavos - coalesce(i.descuento_centavos, 0) > 0
      and i.subtotal_centavos - coalesce(i.descuento_centavos, 0) + coalesce(i.iva_trasladado_centavos, 0) = i.total_centavos
      and (i.direccion = 'emitido' or c.categoria not in ('venta_servicios', 'venta_mercancia', 'sin_clasificar', 'activo_fijo', 'inversion', 'nomina'))
      and not exists (select 1 from despachos.invoice_review r where r.invoice_id = i.id and r.status = 'pendiente')
      and not exists (select 1 from despachos.libro_poliza lp where lp.property_id = i.property_id and lp.invoice_id = i.id and not lp.reversada)
      and not exists (select 1 from despachos.periodo_cierre pc where pc.property_id = i.property_id and pc.anio = extract(year from i.fecha)::int and pc.mes = extract(month from i.fecha)::int and pc.status = 'closed')
    order by i.fecha asc, i.created_at asc, i.id asc
    limit least(p_limit, 500);
end;
$$;
revoke all on function despachos.system_polizas_periodo_candidatos(date, date, integer) from public, anon;
grant execute on function despachos.system_polizas_periodo_candidatos(date, date, integer) to authenticated;

-- Solo sistema: registra la póliza (ya armada en TypeScript, en centavos) de UN CFDI. Idempotente: devuelve el estado en vez de fallar por lo esperable
-- (ya contabilizado, cancelado, excluido, con revisión pendiente, periodo cerrado, sin catálogo). Si el cliente no tiene catálogo y se manda uno base, lo siembra.
create or replace function despachos.system_poliza_cfdi_registrar(
  p_property_id uuid, p_invoice_id uuid, p_tipo text, p_fecha date, p_concepto text, p_movimientos jsonb, p_catalogo jsonb
)
returns table (out_estado text, out_poliza_id uuid, out_folio integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_estado_sat text;
  v_excluido boolean;
  v_poliza uuid;
  v_folio integer;
begin
  if auth.uid() is not null then
    raise exception 'system_poliza_cfdi_registrar es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos' and p.status = 'active';
  if v_org is null then
    raise exception 'system_poliza_cfdi_registrar: la property no es un cliente activo de despachos' using errcode = '42501';
  end if;
  select i.estado_sat, i.excluido_por_revision into v_estado_sat, v_excluido
    from despachos.invoice i where i.id = p_invoice_id and i.property_id = p_property_id for share;
  if v_estado_sat is null then
    raise exception 'system_poliza_cfdi_registrar: CFDI no encontrado' using errcode = 'P0002';
  end if;
  if v_estado_sat = 'cancelado' then
    return query select 'cancelado'::text, null::uuid, null::integer; return;
  end if;
  if v_excluido then
    return query select 'excluido'::text, null::uuid, null::integer; return;
  end if;
  if exists (select 1 from despachos.invoice_review r where r.invoice_id = p_invoice_id and r.status = 'pendiente') then
    return query select 'revision_pendiente'::text, null::uuid, null::integer; return;
  end if;
  if p_fecha is null then
    raise exception 'system_poliza_cfdi_registrar: la póliza requiere fecha' using errcode = '22023';
  end if;
  if exists (select 1 from despachos.periodo_cierre pc where pc.property_id = p_property_id and pc.anio = extract(year from p_fecha)::int and pc.mes = extract(month from p_fecha)::int and pc.status = 'closed') then
    return query select 'periodo_cerrado'::text, null::uuid, null::integer; return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.libro_poliza_cfdi:' || p_invoice_id::text, 0));
  if exists (select 1 from despachos.libro_poliza lp where lp.property_id = p_property_id and lp.invoice_id = p_invoice_id and not lp.reversada) then
    return query select 'ya_tenia_poliza'::text, null::uuid, null::integer; return;
  end if;
  if not exists (select 1 from despachos.libro_cuenta c where c.property_id = p_property_id) then
    if p_catalogo is null or jsonb_typeof(p_catalogo) <> 'array' or jsonb_array_length(p_catalogo) = 0 then
      return query select 'sin_catalogo'::text, null::uuid, null::integer; return;
    end if;
    if jsonb_array_length(p_catalogo) > 2000 then
      raise exception 'system_poliza_cfdi_registrar: el catálogo base excede 2000 cuentas' using errcode = '54000';
    end if;
    insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza)
    select p_property_id, v_org, btrim(x.codigo), btrim(x.descripcion), x.naturaleza
    from jsonb_to_recordset(p_catalogo) as x(codigo text, descripcion text, naturaleza text)
    on conflict (property_id, codigo) do nothing;
  end if;
  select * into v_poliza, v_folio from despachos.libro_poliza_insertar_nucleo(p_property_id, v_org, p_tipo, p_fecha, p_concepto, 'cfdi', p_invoice_id, null, p_movimientos, null);
  return query select 'creada'::text, v_poliza, v_folio;
end;
$$;
revoke all on function despachos.system_poliza_cfdi_registrar(uuid, uuid, text, date, text, jsonb, jsonb) from public, anon;
grant execute on function despachos.system_poliza_cfdi_registrar(uuid, uuid, text, date, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Portal: el cliente ve sus CFDI y autoaceptado de los válidos
-- ---------------------------------------------------------------------------
-- El cliente (token vigente, sesión de sistema) ve SOLO los CFDI de la property de su enlace: hasta 500, los más recientes primero. Devuelve también la
-- organización y la property del enlace (ids, no datos de nadie) para que la API deje la bitácora de la lectura/exportación (D-38).
create or replace function despachos.portal_cliente_cfdi_listar(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
begin
  if auth.uid() is not null then
    raise exception 'portal_cliente_cfdi_listar: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  v := despachos.portal_cliente_enlace_resolver(p_token_hash);
  return jsonb_build_object(
    'organization_id', v.organization_id,
    'property_id', v.property_id,
    'cfdi', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'folio_fiscal', x.folio_fiscal, 'tipo', x.tipo, 'direccion', x.direccion, 'fecha', x.fecha,
               'rfc_emisor', x.rfc_emisor, 'rfc_receptor', x.rfc_receptor, 'emisor_nombre', x.emisor_nombre,
               'total_centavos', x.total_centavos, 'estado_sat', x.estado_sat, 'excluido', x.excluido_por_revision)
             order by x.fecha desc, x.created_at desc)
      from (
        select i.id, i.folio_fiscal, i.tipo, i.direccion, i.fecha, i.rfc_emisor, i.rfc_receptor, i.emisor_nombre,
               coalesce(i.total_centavos, round(i.total * 100)::bigint) as total_centavos, i.estado_sat, i.excluido_por_revision, i.created_at
        from despachos.invoice i where i.property_id = v.property_id order by i.fecha desc, i.created_at desc limit 500
      ) x
    ), '[]'::jsonb));
end;
$$;
revoke all on function despachos.portal_cliente_cfdi_listar(text) from public, anon;
grant execute on function despachos.portal_cliente_cfdi_listar(text) to authenticated;

-- Solo sistema: contexto para decidir el autoaceptado de UN documento recibido (todo lo que el TypeScript no puede leer por RLS en sesión de sistema).
create or replace function despachos.system_portal_ingesta_contexto(p_documento_id uuid, p_folio uuid, p_fecha date, p_rfc_emisor text)
returns jsonb
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  d despachos.portal_cliente_documento;
  v_cfg despachos.property_config;
  v_ficha text;
  v_efos text;
begin
  if auth.uid() is not null then
    raise exception 'system_portal_ingesta_contexto es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select * into d from despachos.portal_cliente_documento x where x.id = p_documento_id;
  if not found then
    raise exception 'system_portal_ingesta_contexto: documento no encontrado' using errcode = 'P0002';
  end if;
  select * into v_cfg from despachos.property_config c where c.property_id = d.property_id;
  select upper(btrim(f.rfc)) into v_ficha from despachos.cliente_ficha f where f.property_id = d.property_id;
  select c.situacion into v_efos from despachos.efos_contribuyente c
    where c.periodo = (select max(i.periodo) from despachos.efos_ingesta i) and c.rfc = upper(btrim(coalesce(p_rfc_emisor, '')))
    order by c.situacion limit 1;
  return jsonb_build_object(
    'organization_id', d.organization_id,
    'property_id', d.property_id,
    'documento_estado', d.estado,
    'documento_tipo', d.tipo,
    'autoaceptar', coalesce(v_cfg.portal_autoaceptar_validos, true),
    'umbral', coalesce(v_cfg.clasificacion_umbral_confianza, 0.7),
    'ficha_rfc', v_ficha,
    'existe', exists (select 1 from despachos.invoice i where i.property_id = d.property_id and i.folio_fiscal = p_folio),
    'periodo_cerrado', p_fecha is not null and exists (select 1 from despachos.periodo_cierre pc where pc.property_id = d.property_id and pc.anio = extract(year from p_fecha)::int and pc.mes = extract(month from p_fecha)::int and pc.status = 'closed'),
    'efos_situacion', v_efos,
    'efos_lista_disponible', exists (select 1 from despachos.efos_ingesta),
    'correcciones', coalesce((
      select jsonb_agg(jsonb_build_object('rfc_emisor', c.rfc_emisor, 'clave_prod_serv', c.clave_prod_serv, 'categoria', c.categoria, 'cuenta', c.cuenta))
      from despachos.clasificacion_correccion c where c.property_id = d.property_id and c.rfc_emisor = upper(btrim(coalesce(p_rfc_emisor, '')))
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function despachos.system_portal_ingesta_contexto(uuid, uuid, date, text) from public, anon;
grant execute on function despachos.system_portal_ingesta_contexto(uuid, uuid, date, text) to authenticated;

-- Solo sistema: ingiere el CFDI de un documento del portal y lo marca aceptado (resuelto_por NULL = el sistema). La property y la organización salen del
-- documento. Devuelve 'aceptado', 'ya_existia' (el UUID ya estaba en esa property: se acepta como existente), o el motivo por el que se deja al staff.
create or replace function despachos.system_portal_cfdi_aceptar(p_documento_id uuid, p_invoice jsonb, p_impuestos jsonb, p_clasificacion jsonb)
returns table (out_estado text, out_invoice_id uuid)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  d despachos.portal_cliente_documento;
  v_autoaceptar boolean;
  v_folio uuid;
  v_fecha date;
  v_existente uuid;
  v_invoice uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_portal_cfdi_aceptar es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select * into d from despachos.portal_cliente_documento x where x.id = p_documento_id for update;
  if not found then
    raise exception 'system_portal_cfdi_aceptar: documento no encontrado' using errcode = 'P0002';
  end if;
  if d.estado <> 'recibido' or d.tipo <> 'cfdi_xml' then
    return query select 'no_aplica'::text, null::uuid; return;
  end if;
  select coalesce((select c.portal_autoaceptar_validos from despachos.property_config c where c.property_id = d.property_id), true) into v_autoaceptar;
  if not v_autoaceptar then
    return query select 'autoaceptar_apagado'::text, null::uuid; return;
  end if;
  v_folio := (p_invoice->>'folio_fiscal')::uuid;
  v_fecha := (p_invoice->>'fecha')::date;
  select i.id into v_existente from despachos.invoice i where i.property_id = d.property_id and i.folio_fiscal = v_folio;
  if v_existente is not null then
    update despachos.portal_cliente_documento set estado = 'aceptado', invoice_id = v_existente, resuelto_en = now(), resuelto_por = null, motivo = 'Ya existía'
     where id = d.id and estado = 'recibido';
    return query select 'ya_existia'::text, v_existente; return;
  end if;
  if exists (select 1 from despachos.periodo_cierre pc where pc.property_id = d.property_id and pc.anio = extract(year from v_fecha)::int and pc.mes = extract(month from v_fecha)::int and pc.status = 'closed') then
    return query select 'periodo_cerrado'::text, null::uuid; return;
  end if;

  insert into despachos.invoice (
    organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, emisor_nombre, subtotal, total, iva, descuento, categoria, valido, issues, warnings,
    requires_human_review, diot, fecha, direccion, metodo_pago, forma_pago, uso_cfdi, moneda, tipo_cambio, subtotal_centavos, descuento_centavos, total_centavos,
    iva_trasladado_centavos, isr_retenido_centavos, iva_retenido_centavos, ieps_centavos)
  select d.organization_id, d.property_id, x.folio_fiscal, x.tipo, x.rfc_emisor, x.rfc_receptor, x.emisor_nombre, x.subtotal, x.total, x.iva, coalesce(x.descuento, 0),
         'sin_clasificar', x.valido, coalesce(x.issues, '[]'::jsonb), coalesce(x.warnings, '[]'::jsonb), coalesce(x.requires_human_review, false),
         coalesce(x.diot, '{"proveedoresReportables": [], "reportable": false}'::jsonb), x.fecha,
         case
           when upper(btrim((select f.rfc from despachos.cliente_ficha f where f.property_id = d.property_id))) = upper(btrim(x.rfc_emisor)) then 'emitido'
           when upper(btrim((select f.rfc from despachos.cliente_ficha f where f.property_id = d.property_id))) = upper(btrim(x.rfc_receptor)) then 'recibido'
           else 'indeterminado'
         end,
         x.metodo_pago, x.forma_pago, x.uso_cfdi, x.moneda, x.tipo_cambio, x.subtotal_centavos, x.descuento_centavos, x.total_centavos,
         x.iva_trasladado_centavos, x.isr_retenido_centavos, x.iva_retenido_centavos, x.ieps_centavos
  from jsonb_to_record(p_invoice) as x(
    folio_fiscal uuid, tipo text, rfc_emisor text, rfc_receptor text, emisor_nombre text, subtotal numeric, total numeric, iva numeric, descuento numeric,
    valido boolean, issues jsonb, warnings jsonb, requires_human_review boolean, diot jsonb, fecha date, metodo_pago text, forma_pago text, uso_cfdi text,
    moneda text, tipo_cambio numeric, subtotal_centavos bigint, descuento_centavos bigint, total_centavos bigint, iva_trasladado_centavos bigint,
    isr_retenido_centavos bigint, iva_retenido_centavos bigint, ieps_centavos bigint)
  returning id into v_invoice;

  if p_impuestos is not null and jsonb_typeof(p_impuestos) = 'array' then
    insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos)
    select v_invoice, d.organization_id, d.property_id, t.naturaleza, t.impuesto, t.tipo_factor, t.tasa_o_cuota, t.base_centavos, t.importe_centavos
    from jsonb_to_recordset(p_impuestos) as t(naturaleza text, impuesto text, tipo_factor text, tasa_o_cuota numeric, base_centavos bigint, importe_centavos bigint)
    limit 50;
  end if;
  if p_clasificacion is not null and jsonb_typeof(p_clasificacion) = 'object' then
    insert into despachos.invoice_classification (invoice_id, organization_id, property_id, categoria, confianza, method, classified_by, razon, cuenta, empate)
    values (v_invoice, d.organization_id, d.property_id, p_clasificacion->>'categoria', (p_clasificacion->>'confianza')::numeric, p_clasificacion->>'method', null,
            nullif(btrim(coalesce(p_clasificacion->>'razon', '')), ''), nullif(btrim(coalesce(p_clasificacion->>'cuenta', '')), ''), coalesce((p_clasificacion->>'empate')::boolean, false));
  end if;
  update despachos.portal_cliente_documento set estado = 'aceptado', invoice_id = v_invoice, resuelto_en = now(), resuelto_por = null, motivo = 'Aceptado automáticamente'
   where id = d.id and estado = 'recibido';
  return query select 'aceptado'::text, v_invoice;
end;
$$;
revoke all on function despachos.system_portal_cfdi_aceptar(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function despachos.system_portal_cfdi_aceptar(uuid, jsonb, jsonb, jsonb) to authenticated;
