-- Esquema `rentas.*` — mapeo de las tablas reales de negocio de `rentas/schema.sql`
-- (renta vacacional / property management) al modelo de tenancy de `core`
-- (`core.organization`/`core.property`) de packages/db/migrations/0001_core_schema.sql.
-- Requiere: 0001_core_schema.sql ya aplicada. Ver diseño Fase 1 §2 para el mapeo
-- completo tabla por tabla y la justificación de cada decisión.
--
-- Corrección clave de tenancy (diseño §1-#5): el modelo real de origen tiene 3
-- niveles (tenant -> propiedad -> unidad), no 2. `core.property` = `propiedad` (el
-- nivel donde ya se hace `requirePropertyMembership` en el resto del monorepo, y
-- donde la RLS real del repo origen aísla), `rentas.unidad` es una tabla hija con
-- `property_id` — exactamente el mismo patrón que `hoteles.room` cuelga de
-- `hoteles.room_type`/`property_id`. `owner` (dueño real del inmueble) se modela
-- como entidad de negocio propia de `rentas.*`, NUNCA como staff (no encaja en
-- `core.membership`, que es siempre 1 organización — ver diseño §2.1); el portal de
-- propietario queda fuera de fase (diseño §6).
--
-- Alcance de Fase 1 (diseño §3.3): solo lo necesario para sostener los 3 flujos
-- elegidos (anti-doble-reserva de calendario, cotización, movimiento financiero). El
-- esquema completo de `rentas.ocupacion` (incluida `capa='bloqueo'`) SÍ se porta
-- aunque `crearBloqueo` no se exponga por HTTP todavía, porque la propia
-- `capa='bloqueo'` participa de las guardias de "capa cruzada" de los 3 flujos
-- elegidos (una reserva directa que aterriza sobre un bloqueo ya existente debe
-- poder detectarse).

create schema if not exists rentas;

-- ---------------------------------------------------------------------------
-- Perfil de organización / configuración de property (diseño §2.1).
-- ---------------------------------------------------------------------------
create table rentas.organization_perfil (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  -- 'anfitrion' | 'empresa_gestora' — origen: tenant.tipo.
  tipo text not null default 'anfitrion' check (tipo in ('anfitrion', 'empresa_gestora'))
);

create table rentas.property_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- IANA obligatoria (D-013 del origen); la validación de CONTENIDO real (que sea una
  -- zona horaria IANA existente) vive en la capa de aplicación, no en este CHECK —
  -- distintos motores Postgres pueden traer catálogos tzdata ligeramente distintos.
  zona_horaria text not null check (zona_horaria <> ''),
  -- "Multi-tenant con moneda de reporte fija por propiedad" (diseño §1-#4) — NUNCA
  -- conversión de tipo de cambio, a diferencia de hoteles/REQ-RES-015.
  moneda char(3) not null default 'MXN' check (moneda ~ '^[A-Z]{3}$')
);

-- ---------------------------------------------------------------------------
-- Owner (propietario real del inmueble) — actor de negocio propio de rentas, NUNCA
-- staff. Portal de propietario fuera de fase.
-- ---------------------------------------------------------------------------
create table rentas.owner (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  created_at timestamptz not null default now()
);

-- N:M owner <-> organización gestora (origen: owner_empresa_gestora, migración 0134 —
-- un owner puede estar gestionado por más de una empresa gestora).
create table rentas.owner_organization (
  owner_id uuid not null references rentas.owner(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, organization_id)
);
create index owner_organization_organization_id_idx on rentas.owner_organization (organization_id);

-- ---------------------------------------------------------------------------
-- Catálogo de canales — global, compartido entre organizaciones (igual que el
-- origen: catálogo pequeño, no tenant-scoped, sin RLS).
-- ---------------------------------------------------------------------------
create table rentas.canal (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  nombre text not null,
  created_at timestamptz not null default now()
);
insert into rentas.canal (codigo, nombre) values
  ('airbnb', 'Airbnb'),
  ('vrbo', 'Vrbo'),
  ('booking', 'Booking.com'),
  ('manual', 'Reserva directa / bloqueo manual interno');

-- ---------------------------------------------------------------------------
-- Unidad (listing individual rentable) — hija de core.property, nunca su propia fila
-- core.property.
-- ---------------------------------------------------------------------------
create table rentas.unidad (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  owner_id uuid references rentas.owner(id) on delete set null,
  name text not null,
  duracion_minima_noches integer not null default 1 check (duracion_minima_noches >= 1),
  created_at timestamptz not null default now(),
  unique (property_id, name)
);
create index unidad_property_idx on rentas.unidad (property_id);
create index unidad_owner_idx on rentas.unidad (owner_id);

-- ---------------------------------------------------------------------------
-- Huésped mínimo: deliberadamente mínimo, nunca un CRM de huéspedes (D-014 del
-- origen). A diferencia del origen (`huesped_minimo` sin tenant_id, corregido en su
-- migración 0093 tras un IDOR real), se construye con el scoping correcto desde el
-- día uno.
-- ---------------------------------------------------------------------------
create table rentas.guest_minimo (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  nombre text,
  contacto text,
  created_at timestamptz not null default now()
);
create index guest_minimo_property_idx on rentas.guest_minimo (property_id);

-- ---------------------------------------------------------------------------
-- Ocupación (el corazón de la Fase 1) — tabla única con discriminador `capa`, port
-- LITERAL del EXCLUDE real del origen (corrección BC1 de su propia auditoría), sin
-- relajar ninguna condición.
-- ---------------------------------------------------------------------------
create table rentas.ocupacion (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  rango daterange not null,
  capa text not null check (capa in ('reserva', 'bloqueo')),
  razon text not null check (razon in ('RESERVA_CANAL', 'BLOQUEO_PROPIETARIO', 'MANTENIMIENTO', 'BUFFER_LIMPIEZA')),
  canal_origen_id uuid references rentas.canal(id),
  external_id text,
  estado text not null default 'confirmado' check (estado in ('confirmado', 'provisional', 'cancelado', 'conflicto_pendiente')),
  bloqueante boolean not null default true,
  huesped_minimo_id uuid references rentas.guest_minimo(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Rango semiabierto [check_in, check_out) forzado, nunca vacío.
  constraint ocupacion_rango_no_vacio check (not isempty(rango)),
  constraint ocupacion_rango_semiabierto check (lower_inc(rango) and not upper_inc(rango)),
  -- capa y razon deben ser consistentes: RESERVA_CANAL es la única razón de
  -- capa='reserva'; las otras tres son exclusivas de capa='bloqueo'.
  constraint ocupacion_capa_razon_coherente check (
    (capa = 'reserva' and razon = 'RESERVA_CANAL')
    or (capa = 'bloqueo' and razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO', 'BUFFER_LIMPIEZA'))
  )
);

create index ocupacion_unidad_idx on rentas.ocupacion (unidad_id);
create index ocupacion_property_idx on rentas.ocupacion (property_id);
create index ocupacion_rango_idx on rentas.ocupacion using gist (rango);

-- El EXCLUDE corre SOLO sobre capa='reserva' con estado<>'cancelado' y
-- bloqueante=true (reservas confirmadas y holds que sí cierran la noche). Bloqueos de
-- propietario/mantenimiento/buffer (capa='bloqueo') NUNCA participan del EXCLUDE — su
-- INSERT nunca es rechazado por la base de datos, sin importar el solape; el
-- conflicto entre capas se detecta en la capa de aplicación (@atiende/domain-rentas)
-- y se registra en `rentas.conflicto_calendario`, nunca se resuelve cancelando la
-- reserva de mayor precedencia.
alter table rentas.ocupacion
  add constraint ocupacion_sin_solape
  exclude using gist (
    unidad_id with =,
    rango with &&
  ) where (capa = 'reserva' and estado <> 'cancelado' and bloqueante);

-- ---------------------------------------------------------------------------
-- Conflicto de calendario — alertas para revisión humana, nunca cancelación
-- automática (REQ-000 del origen).
-- ---------------------------------------------------------------------------
create table rentas.conflicto_calendario (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  ocupacion_a_id uuid not null references rentas.ocupacion(id) on delete cascade,
  ocupacion_b_id uuid references rentas.ocupacion(id) on delete cascade,
  tipo text not null check (tipo in ('capa_cruzada', 'overbooking_confirmado')),
  detectado_en timestamptz not null default now(),
  resuelto_en timestamptz,
  resuelto_por uuid references core.staff_user(id) on delete set null
);
create index conflicto_calendario_unidad_idx on rentas.conflicto_calendario (unidad_id);
create index conflicto_calendario_sin_resolver_idx on rentas.conflicto_calendario (detectado_en) where resuelto_en is null;

-- ---------------------------------------------------------------------------
-- RLS — nunca se re-implementa un `hotel_staff`/`tenant_id` propio: la autoridad de
-- membership es SIEMPRE `core.membership`, vía `core.has_property_access`.
-- ---------------------------------------------------------------------------
alter table rentas.organization_perfil enable row level security;
alter table rentas.property_config enable row level security;
alter table rentas.owner enable row level security;
alter table rentas.owner_organization enable row level security;
alter table rentas.unidad enable row level security;
alter table rentas.guest_minimo enable row level security;
alter table rentas.ocupacion enable row level security;
alter table rentas.conflicto_calendario enable row level security;

create policy "staff ve el perfil de su organización" on rentas.organization_perfil for select
  using (exists (select 1 from core.membership m where m.organization_id = organization_perfil.organization_id and m.user_id = auth.uid()));

create policy "staff ve la configuración de su property" on rentas.property_config for select
  using (core.has_property_access(auth.uid(), property_id));

create policy "staff ve owners de su organización" on rentas.owner for select
  using (
    exists (
      select 1 from rentas.owner_organization oo
      join core.membership m on m.organization_id = oo.organization_id
      where oo.owner_id = owner.id and m.user_id = auth.uid()
    )
  );

create policy "staff ve el vínculo owner-organización de su organización" on rentas.owner_organization for select
  using (exists (select 1 from core.membership m where m.organization_id = owner_organization.organization_id and m.user_id = auth.uid()));

create policy "staff ve unidades de su property" on rentas.unidad for select
  using (core.has_property_access(auth.uid(), property_id));

create policy "staff ve huéspedes mínimos de su property" on rentas.guest_minimo for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta huéspedes mínimos de su property" on rentas.guest_minimo for insert
  with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve ocupaciones de su property" on rentas.ocupacion for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta ocupaciones de su property" on rentas.ocupacion for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza ocupaciones de su property" on rentas.ocupacion for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve conflictos de su property" on rentas.conflicto_calendario for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta conflictos de su property" on rentas.conflicto_calendario for insert
  with check (core.has_property_access(auth.uid(), property_id));

revoke all on all tables in schema rentas from public, anon;
grant select on rentas.organization_perfil, rentas.property_config, rentas.owner, rentas.owner_organization, rentas.unidad, rentas.canal to authenticated;
grant select, insert on rentas.guest_minimo to authenticated;
grant select, insert, update on rentas.ocupacion to authenticated;
grant select, insert on rentas.conflicto_calendario to authenticated;
grant select, insert, update, delete on all tables in schema rentas to service_role;
