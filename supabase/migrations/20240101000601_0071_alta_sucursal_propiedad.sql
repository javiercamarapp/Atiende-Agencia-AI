-- Onboarding P0: alta de sucursal / propiedad desde el producto (dueño o superadmin) para restaurantes, citas, hoteles y licitaciones.
--
-- Problema (investigacion A §0.3/§1.5-1/§2.5-2/§3.5-3, B §4.5-2): el alta de organizacion del superadmin (0038) solo crea
-- core.organization, y core.property solo tiene GRANT para service_role. Restaurantes, citas, hoteles y licitaciones no tenian ningun
-- camino para crear su primera sucursal/propiedad: el shell quedaba en «no tiene ninguna sucursal configurada» y el primer paso del
-- onboarding era imposible sin SQL. (Despachos y rentas ya tienen el suyo: despachos.cliente_alta y rentas.crear_propiedad, que piden
-- datos propios de su vertical -- ficha fiscal, moneda -- y no se tocan.)
--
-- Que agrega (aditivo, schema core):
--   A) core.propiedad_alta_log: bitacora append-only de cada alta y de cada activacion (quien, origen dueño/superadmin, accion
--      alta/activacion, motivo del superadmin). Sin PII.
--   T) core.propiedad_tope_por_organizacion(p_vertical): UNICA fuente del tope de sucursales/propiedades por organizacion. TOPE TEMPORAL
--      HASTA LIGARLO AL PLAN: licitaciones 1 (su shell usa una sola propiedad), demas 50. El espejo en TypeScript es
--      TOPE_PROPIEDADES_POR_ORGANIZACION (packages/db/src/alta-propiedad-repository.ts); si cambia uno, cambia el otro.
--   B) core.crear_propiedad_interna(...): cuerpo comun (validaciones, tope, insercion en core.property y en la tabla de detalle que cada
--      vertical lee para listar sus sucursales, bitacora). Sin EXECUTE para nadie: solo la invocan, como dueño, C y D.
--   C) core.crear_propiedad_organizacion(p_org_slug, p_vertical, p_nombre, p_zona_horaria): el dueño/administrador de la organizacion.
--   D) core.superadmin_crear_propiedad(p_caller_id, p_organization_id, p_nombre, p_zona_horaria, p_motivo): el superadmin (alta asistida).
--   P) core.propiedad_pasos_activacion(p_property_id): pasos obligatorios de configuracion de UNA sucursal/propiedad (interno).
--   E) core.activar_propiedad_organizacion(p_org_slug, p_vertical, p_property_id): el dueño/administrador activa EXPLICITAMENTE una
--      sucursal/propiedad dada de alta por este camino, solo si P no tiene pasos pendientes.
--
-- LA SUCURSAL NACE INACTIVA (status = 'inactive'): sin menu, horario ni cobertura no debe recibir pedidos. Lo que ya filtra por
-- core.property.status = 'active' (y por eso no la ofrece mientras este inactiva): restaurantes.nearest_branch_by_colonia (077),
-- listBranchesForOrganization y findBranch + prepareCreateOrder/quote/agent-tools (que rechazan una sucursal inactiva), y
-- listPropertiesForOrganization de citas, hoteles y licitaciones. Pasos obligatorios para activar (P), tomados del checklist de
-- onboarding de cada vertical (packages/domain-*/src/onboarding.ts y core.org_onboarding_pasos de 0052):
--   restaurantes -> menu (>= 1 producto disponible en branch_products), horario (branch_policy.horario no vacio) y cobertura de entrega
--                   (>= 1 colonia en branch_delivery_zone; no aplica si branch_policy.acepta_domicilio = false, solo recoger);
--   citas        -> servicio activo, proveedor activo de la sucursal (o de todas) que ofrece un servicio activo, y su horario semanal;
--   hoteles      -> habitaciones (>= 1 hoteles.room de la propiedad) y tarifas vigentes (>= 1 hoteles.rate_plan de hoy en adelante);
--   licitaciones -> ninguno (una sola propiedad, sin catalogo): la activacion explicita pasa directo.
-- Si la tabla de un paso no existe todavia en la base (vertical sin migrar) el paso cuenta como PENDIENTE (falla cerrado), nunca hecho.
-- Solo se activan sucursales con fila 'alta' en la bitacora: las que la plataforma dejo inactivas a proposito (ej. de temporada) no las
-- reactiva el dueño por aqui (42501).
--
-- Reglas: nombre de 2 a 120 caracteres, unico (sin distinguir mayusculas) dentro de la organizacion (23505); zona horaria IANA real si se
-- indica (22023); tope por organizacion de T (54000); organizacion suspendida no (42501); despachos y rentas se rechazan con 22023 (tienen
-- su propio camino). Detalle por vertical:
--   restaurantes -> restaurantes.branch_detail (slug derivado del nombre, unico en la organizacion, nunca empieza ni termina en '-';
--                   orden al final; zona_horaria);
--   citas        -> citas.property_config (zona horaria, por omision America/Mexico_City como su DEFAULT);
--   hoteles      -> hoteles.property_config (zona horaria o null = default de plataforma);
--   licitaciones -> solo core.property.
--
-- Justificacion de seguridad:
--   * A: RLS habilitada; SELECT a authenticated solo para owner/admin (platform_role) de la organizacion; sin GRANT de escritura a nadie
--     (ni a anon): solo B escribe.
--   * B: security definer, `set search_path = core, pg_temp`, tablas calificadas, `revoke all from public, anon, authenticated`.
--   * C: security definer, search_path fijo, revoke de public/anon, execute a authenticated. Exige auth.uid() (sesion de sistema o anon:
--     42501) y membresia del caller en ESA organizacion con platform_role owner/admin y alcance de toda la organizacion
--     (property_ids null); staff acotado, otra organizacion o miembro/visor: 42501. La organizacion se resuelve por slug Y vertical.
--   * D: security definer, search_path fijo, revoke de public/anon, execute a authenticated; abre con core.superadmin_require_caller
--     (auth.uid() = p_caller_id y superadmin real, 0025); motivo >= 20 caracteres.
--   * T: funcion SQL pura (immutable), search_path fijo, `revoke all from public, anon, authenticated`: solo la usan B y quien la lea en
--     la migracion; no expone datos.
--   * P: security definer (lee tablas de dominio con RLS por sucursal sin depender de la membresia del caller), `set search_path = core,
--     pg_temp`, tablas calificadas, `revoke all from public, anon, authenticated`: solo la invoca E, despues de autorizar.
--   * E: security definer, search_path fijo, revoke de public/anon, execute a authenticated. Mismo control que C: auth.uid() obligatorio
--     (sistema/anon: 42501) y membresia owner/admin con alcance de toda la organizacion (resuelta por slug Y vertical); la propiedad debe
--     ser de ESA organizacion (si no, P0002, igual que inexistente: no revela propiedades ajenas). Fila bloqueada (for update) para que dos
--     activaciones simultaneas no escriban dos veces la bitacora. Pasos pendientes: 55000 con la lista en DETAIL. Idempotente: una
--     sucursal ya activa devuelve ok sin nueva fila en la bitacora.
--   * Ninguna acepta SQL dinamico. El actor de la bitacora es auth.uid(), nunca un parametro.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Bitacora
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.propiedad_alta_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id     uuid not null references core.property(id) on delete cascade,
  vertical        text not null,
  origen          text not null check (origen in ('dueno', 'superadmin')),
  accion          text not null default 'alta' check (accion in ('alta', 'activacion')),
  actor_user_id   uuid not null,
  motivo          text,
  created_at      timestamptz not null default now()
);
-- Por si la tabla ya existia de una corrida previa de esta misma migracion sin la columna (idempotencia).
alter table core.propiedad_alta_log add column if not exists accion text not null default 'alta' check (accion in ('alta', 'activacion'));
create index if not exists propiedad_alta_log_property_idx on core.propiedad_alta_log (property_id, accion);
create index if not exists propiedad_alta_log_org_idx on core.propiedad_alta_log (organization_id, created_at desc);
alter table core.propiedad_alta_log enable row level security;
revoke all on core.propiedad_alta_log from public, anon, authenticated;
drop policy if exists propiedad_alta_log_select_owner_admin on core.propiedad_alta_log;
create policy propiedad_alta_log_select_owner_admin on core.propiedad_alta_log
  for select to authenticated
  using (exists (
    select 1 from core.membership m
    where m.organization_id = propiedad_alta_log.organization_id and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin')
  ));
grant select on core.propiedad_alta_log to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- T) Tope de sucursales/propiedades por organizacion: TOPE TEMPORAL HASTA LIGARLO AL PLAN
-- ═══════════════════════════════════════════════════════════════════════════
-- Unica definicion en SQL; la usa B. Espejo en TS: TOPE_PROPIEDADES_POR_ORGANIZACION (packages/db/src/alta-propiedad-repository.ts).
create or replace function core.propiedad_tope_por_organizacion(p_vertical text)
returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_vertical when 'licitaciones' then 1 else 50 end;
$$;
comment on function core.propiedad_tope_por_organizacion(text) is
  'Tope temporal de sucursales/propiedades por organizacion hasta ligarlo al plan (licitaciones 1, demas 50). Espejo TS: TOPE_PROPIEDADES_POR_ORGANIZACION.';
revoke all on function core.propiedad_tope_por_organizacion(text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Cuerpo comun (interno)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.crear_propiedad_interna(
  p_organization_id uuid,
  p_nombre text,
  p_zona_horaria text,
  p_actor uuid,
  p_origen text,
  p_motivo text
)
returns table (out_property_id uuid, out_slug text)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_org core.organization%rowtype;
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_zona text := nullif(btrim(coalesce(p_zona_horaria, '')), '');
  v_tope integer;
  v_property uuid;
  v_base text;
  v_slug text;
  v_n integer := 1;
begin
  select * into v_org from core.organization o where o.id = p_organization_id;
  if v_org.id is null then
    raise exception 'crear_propiedad: organizacion no encontrada' using errcode = 'P0002';
  end if;
  if v_org.status = 'suspended' then
    raise exception 'crear_propiedad: la organizacion esta suspendida' using errcode = '42501';
  end if;
  if v_org.vertical in ('despachos', 'rentas') then
    raise exception 'crear_propiedad: % tiene su propio alta (despachos: cartera de clientes; rentas: catalogo de propiedades)', v_org.vertical using errcode = '22023';
  end if;
  if v_org.vertical not in ('restaurantes', 'citas', 'hoteles', 'licitaciones') then
    raise exception 'crear_propiedad: vertical no soportada' using errcode = '22023';
  end if;
  if char_length(v_nombre) < 2 or char_length(v_nombre) > 120 then
    raise exception 'crear_propiedad: el nombre debe tener entre 2 y 120 caracteres' using errcode = '22023';
  end if;
  if v_zona is not null and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_zona) then
    raise exception 'crear_propiedad: zona horaria IANA invalida' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('core.crear_propiedad:' || p_organization_id::text, 0));
  v_tope := core.propiedad_tope_por_organizacion(v_org.vertical);
  if (select count(*) from core.property p where p.organization_id = p_organization_id) >= v_tope then
    raise exception 'crear_propiedad: la organizacion ya tiene el maximo de % sucursales/propiedades', v_tope using errcode = '54000';
  end if;
  if exists (select 1 from core.property p where p.organization_id = p_organization_id and lower(p.name) = lower(v_nombre)) then
    raise exception 'crear_propiedad: ya existe una sucursal/propiedad con ese nombre' using errcode = '23505';
  end if;

  -- Nace INACTIVA: no recibe pedidos ni aparece al cliente hasta que el dueño la active con E (pasos de P completos).
  insert into core.property (organization_id, name, status) values (p_organization_id, v_nombre, 'inactive') returning id into v_property;

  if v_org.vertical = 'restaurantes' then
    -- btrim DESPUES de left: el corte a 60 puede caer justo en un '-' (el slug nunca empieza ni termina en '-').
    v_base := btrim(left(btrim(regexp_replace(lower(translate(v_nombre, 'ÁÉÍÓÚÜÑáéíóúüñ', 'aeiouunaeiouun')), '[^a-z0-9]+', '-', 'g'), '-'), 60), '-');
    if v_base is null or v_base = '' then
      v_base := 'sucursal';
    end if;
    v_slug := v_base;
    while exists (select 1 from restaurantes.branch_detail bd where bd.organization_id = p_organization_id and bd.slug = v_slug) loop
      v_n := v_n + 1;
      v_slug := v_base || '-' || v_n;
    end loop;
    insert into restaurantes.branch_detail (property_id, organization_id, slug, display_order, zona_horaria)
    values (v_property, p_organization_id, v_slug,
            coalesce((select max(bd.display_order) + 1 from restaurantes.branch_detail bd where bd.organization_id = p_organization_id), 0),
            v_zona);
  elsif v_org.vertical = 'citas' then
    insert into citas.property_config (property_id, organization_id, timezone)
    values (v_property, p_organization_id, coalesce(v_zona, 'America/Mexico_City'));
  elsif v_org.vertical = 'hoteles' then
    insert into hoteles.property_config (property_id, organization_id, timezone) values (v_property, p_organization_id, v_zona);
  end if;

  insert into core.propiedad_alta_log (organization_id, property_id, vertical, origen, accion, actor_user_id, motivo)
  values (p_organization_id, v_property, v_org.vertical, p_origen, 'alta', p_actor, p_motivo);

  return query select v_property, v_slug;
end;
$$;
revoke all on function core.crear_propiedad_interna(uuid, text, text, uuid, text, text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Alta por el dueño / administrador de la organizacion
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.crear_propiedad_organizacion(p_org_slug text, p_vertical text, p_nombre text, p_zona_horaria text default null)
returns table (out_property_id uuid, out_slug text)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'crear_propiedad_organizacion: requiere un usuario autenticado' using errcode = '42501';
  end if;
  select o.id into v_org from core.organization o where o.slug = p_org_slug and o.vertical = p_vertical;
  if v_org is null then
    raise exception 'crear_propiedad_organizacion: organizacion no encontrada' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.organization_id = v_org and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin') and m.property_ids is null
  ) then
    raise exception 'crear_propiedad_organizacion: solo el dueño o un administrador de toda la organizacion' using errcode = '42501';
  end if;
  return query select * from core.crear_propiedad_interna(v_org, p_nombre, p_zona_horaria, auth.uid(), 'dueno', null);
end;
$$;
revoke all on function core.crear_propiedad_organizacion(text, text, text, text) from public, anon;
grant execute on function core.crear_propiedad_organizacion(text, text, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Alta asistida por el superadmin
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_crear_propiedad(p_caller_id uuid, p_organization_id uuid, p_nombre text, p_zona_horaria text, p_motivo text)
returns table (out_property_id uuid, out_slug text)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_crear_propiedad');
  if char_length(v_motivo) < 20 or char_length(v_motivo) > 500 then
    raise exception 'superadmin_crear_propiedad: motivo obligatorio (20 a 500 caracteres)' using errcode = '22023';
  end if;
  return query select * from core.crear_propiedad_interna(p_organization_id, p_nombre, p_zona_horaria, p_caller_id, 'superadmin', v_motivo);
end;
$$;
revoke all on function core.superadmin_crear_propiedad(uuid, uuid, text, text, text) from public, anon;
grant execute on function core.superadmin_crear_propiedad(uuid, uuid, text, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- P) Pasos obligatorios para activar UNA sucursal/propiedad (interno)
-- ═══════════════════════════════════════════════════════════════════════════
-- Mismo criterio que los puntos obligatorios del checklist de cada vertical (ver cabecera). Una tabla que todavia no existe en la base
-- (42P01/42703) deja el paso PENDIENTE: nunca se activa una sucursal por falta de migracion. Lee columnas posteriores (horario de 023,
-- acepta_domicilio de 057) via to_jsonb(fila) para no romper contra una base sin esas columnas.
create or replace function core.propiedad_pasos_activacion(p_property_id uuid)
returns table (orden integer, paso text, titulo text, hecho boolean)
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_org uuid;
  v_vertical text;
  v_ok boolean;
  v_domicilio boolean;
  v_politica jsonb;
begin
  select p.organization_id, o.vertical into v_org, v_vertical
  from core.property p join core.organization o on o.id = p.organization_id
  where p.id = p_property_id;
  if v_org is null then
    return;
  end if;

  if v_vertical = 'restaurantes' then
    v_ok := false;
    begin
      select exists (select 1 from restaurantes.branch_products bp where bp.property_id = p_property_id and bp.is_available) into v_ok;
    exception when undefined_table or undefined_column then
      v_ok := false;
    end;
    return query select 1, 'menu'::text, 'Menú: al menos un producto disponible en la sucursal'::text, coalesce(v_ok, false);

    v_politica := null;
    begin
      select to_jsonb(bp) into v_politica from restaurantes.branch_policy bp where bp.property_id = p_property_id;
    exception when undefined_table or undefined_column then
      v_politica := null;
    end;
    v_ok := v_politica is not null
      and jsonb_typeof(v_politica -> 'horario') = 'array'
      and jsonb_array_length(v_politica -> 'horario') > 0;
    return query select 2, 'horario'::text, 'Horario de la sucursal'::text, coalesce(v_ok, false);

    -- Solo recoger (acepta_domicilio = false, 057): la cobertura de entrega no aplica. Sin la columna o sin politica: si reparte.
    v_domicilio := coalesce((v_politica ->> 'acepta_domicilio')::boolean, true);
    if v_domicilio then
      v_ok := false;
      begin
        select exists (select 1 from restaurantes.branch_delivery_zone z where z.property_id = p_property_id) into v_ok;
      exception when undefined_table or undefined_column then
        v_ok := false;
      end;
    else
      v_ok := true;
    end if;
    return query select 3, 'zona_de_entrega'::text, 'Cobertura de entrega: al menos una colonia (o sucursal solo para recoger)'::text, coalesce(v_ok, false);

  elsif v_vertical = 'citas' then
    v_ok := false;
    begin
      select exists (select 1 from citas.services s where s.organization_id = v_org and s.is_active) into v_ok;
    exception when undefined_table or undefined_column then
      v_ok := false;
    end;
    return query select 1, 'servicio'::text, 'Al menos un servicio activo'::text, coalesce(v_ok, false);

    -- Un proveedor sin sucursal (property_id null) atiende en todas: mismo criterio que la Agenda y el checklist de citas.
    v_ok := false;
    begin
      select exists (
        select 1 from citas.providers pr
        join citas.provider_services ps on ps.provider_id = pr.id
        join citas.services s on s.id = ps.service_id and s.is_active
        where pr.organization_id = v_org and pr.is_active and (pr.property_id = p_property_id or pr.property_id is null)
      ) into v_ok;
    exception when undefined_table or undefined_column then
      v_ok := false;
    end;
    return query select 2, 'proveedor'::text, 'Un proveedor activo de la sucursal que ofrece un servicio activo'::text, coalesce(v_ok, false);

    v_ok := false;
    begin
      select exists (
        select 1 from citas.providers pr
        join citas.provider_services ps on ps.provider_id = pr.id
        join citas.services s on s.id = ps.service_id and s.is_active
        join citas.availability_rules ar on ar.provider_id = pr.id and ar.is_active
        where pr.organization_id = v_org and pr.is_active and (pr.property_id = p_property_id or pr.property_id is null)
      ) into v_ok;
    exception when undefined_table or undefined_column then
      v_ok := false;
    end;
    return query select 3, 'horario'::text, 'Horario semanal de ese proveedor'::text, coalesce(v_ok, false);

  elsif v_vertical = 'hoteles' then
    v_ok := false;
    begin
      select exists (select 1 from hoteles.room r where r.property_id = p_property_id) into v_ok;
    exception when undefined_table or undefined_column then
      v_ok := false;
    end;
    return query select 1, 'habitaciones'::text, 'Al menos una habitación dada de alta'::text, coalesce(v_ok, false);

    v_ok := false;
    begin
      select exists (select 1 from hoteles.rate_plan rp where rp.property_id = p_property_id and rp.date >= current_date) into v_ok;
    exception when undefined_table or undefined_column then
      v_ok := false;
    end;
    return query select 2, 'tarifas'::text, 'Tarifas vigentes (de hoy en adelante)'::text, coalesce(v_ok, false);
  end if;
  -- licitaciones: sin pasos obligatorios.
end;
$$;
revoke all on function core.propiedad_pasos_activacion(uuid) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Activacion explicita por el dueño / administrador de la organizacion
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.activar_propiedad_organizacion(p_org_slug text, p_vertical text, p_property_id uuid)
returns table (out_property_id uuid, out_status text, out_ya_estaba_activa boolean)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_org core.organization%rowtype;
  v_status text;
  v_pasos text[];
  v_titulos text[];
begin
  if auth.uid() is null then
    raise exception 'activar_propiedad_organizacion: requiere un usuario autenticado' using errcode = '42501';
  end if;
  select * into v_org from core.organization o where o.slug = p_org_slug and o.vertical = p_vertical;
  if v_org.id is null then
    raise exception 'activar_propiedad_organizacion: organizacion no encontrada' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.organization_id = v_org.id and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin') and m.property_ids is null
  ) then
    raise exception 'activar_propiedad_organizacion: solo el dueño o un administrador de toda la organizacion' using errcode = '42501';
  end if;
  if v_org.status = 'suspended' then
    raise exception 'activar_propiedad_organizacion: la organizacion esta suspendida' using errcode = '42501';
  end if;

  select p.status into v_status from core.property p where p.id = p_property_id and p.organization_id = v_org.id for update;
  if v_status is null then
    raise exception 'activar_propiedad_organizacion: sucursal/propiedad no encontrada' using errcode = 'P0002';
  end if;
  if not exists (select 1 from core.propiedad_alta_log l where l.property_id = p_property_id and l.accion = 'alta') then
    raise exception 'activar_propiedad_organizacion: esta sucursal/propiedad no se dio de alta desde el producto; su activacion la hace la plataforma' using errcode = '42501';
  end if;
  if v_status = 'active' then
    return query select p_property_id, 'active'::text, true;
    return;
  end if;

  select array_agg(x.paso order by x.orden), array_agg(x.titulo order by x.orden) into v_pasos, v_titulos
  from core.propiedad_pasos_activacion(p_property_id) x
  where not x.hecho;
  if v_pasos is not null then
    raise exception 'activar_propiedad_organizacion: faltan pasos obligatorios antes de activar: %', array_to_string(v_titulos, '; ')
      using errcode = '55000', detail = array_to_string(v_pasos, ',');
  end if;

  update core.property set status = 'active' where id = p_property_id;
  insert into core.propiedad_alta_log (organization_id, property_id, vertical, origen, accion, actor_user_id, motivo)
  values (v_org.id, p_property_id, v_org.vertical, 'dueno', 'activacion', auth.uid(), null);

  return query select p_property_id, 'active'::text, false;
end;
$$;
revoke all on function core.activar_propiedad_organizacion(text, text, uuid) from public, anon;
grant execute on function core.activar_propiedad_organizacion(text, text, uuid) to authenticated;
