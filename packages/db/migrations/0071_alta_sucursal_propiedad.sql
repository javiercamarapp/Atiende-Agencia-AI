-- Onboarding P0: alta de sucursal / propiedad desde el producto (dueño o superadmin) para restaurantes, citas, hoteles y licitaciones.
--
-- Problema (investigacion A §0.3/§1.5-1/§2.5-2/§3.5-3, B §4.5-2): el alta de organizacion del superadmin (0038) solo crea
-- core.organization, y core.property solo tiene GRANT para service_role. Restaurantes, citas, hoteles y licitaciones no tenian ningun
-- camino para crear su primera sucursal/propiedad: el shell quedaba en «no tiene ninguna sucursal configurada» y el primer paso del
-- onboarding era imposible sin SQL. (Despachos y rentas ya tienen el suyo: despachos.cliente_alta y rentas.crear_propiedad, que piden
-- datos propios de su vertical -- ficha fiscal, moneda -- y no se tocan.)
--
-- Que agrega (aditivo, schema core):
--   A) core.propiedad_alta_log: bitacora append-only de cada alta (quien, origen dueño/superadmin, motivo del superadmin). Sin PII.
--   B) core.crear_propiedad_interna(...): cuerpo comun (validaciones, tope, insercion en core.property y en la tabla de detalle que cada
--      vertical lee para listar sus sucursales, bitacora). Sin EXECUTE para nadie: solo la invocan, como dueño, C y D.
--   C) core.crear_propiedad_organizacion(p_org_slug, p_vertical, p_nombre, p_zona_horaria): el dueño/administrador de la organizacion.
--   D) core.superadmin_crear_propiedad(p_caller_id, p_organization_id, p_nombre, p_zona_horaria, p_motivo): el superadmin (alta asistida).
--
-- Reglas: nombre de 2 a 120 caracteres, unico (sin distinguir mayusculas) dentro de la organizacion (23505); zona horaria IANA real si se
-- indica (22023); tope por organizacion: licitaciones 1 (su shell usa una sola propiedad), demas 50 (54000); organizacion suspendida no
-- (42501); despachos y rentas se rechazan con 22023 (tienen su propio camino). Detalle por vertical:
--   restaurantes -> restaurantes.branch_detail (slug derivado del nombre, unico en la organizacion; orden al final; zona_horaria);
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
  actor_user_id   uuid not null,
  motivo          text,
  created_at      timestamptz not null default now()
);
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
  v_tope := case v_org.vertical when 'licitaciones' then 1 else 50 end;
  if (select count(*) from core.property p where p.organization_id = p_organization_id) >= v_tope then
    raise exception 'crear_propiedad: la organizacion ya tiene el maximo de % sucursales/propiedades', v_tope using errcode = '54000';
  end if;
  if exists (select 1 from core.property p where p.organization_id = p_organization_id and lower(p.name) = lower(v_nombre)) then
    raise exception 'crear_propiedad: ya existe una sucursal/propiedad con ese nombre' using errcode = '23505';
  end if;

  insert into core.property (organization_id, name, status) values (p_organization_id, v_nombre, 'active') returning id into v_property;

  if v_org.vertical = 'restaurantes' then
    v_base := left(btrim(regexp_replace(lower(translate(v_nombre, 'ÁÉÍÓÚÜÑáéíóúüñ', 'aeiouunaeiouun')), '[^a-z0-9]+', '-', 'g'), '-'), 60);
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

  insert into core.propiedad_alta_log (organization_id, property_id, vertical, origen, actor_user_id, motivo)
  values (p_organization_id, v_property, v_org.vertical, p_origen, p_actor, p_motivo);

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
