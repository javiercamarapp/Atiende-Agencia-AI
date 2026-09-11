-- Esquema mínimo de pricing básico (diseño Fase 1 §2.4, flujo 2) — precio base por
-- unidad, temporadas, descuentos por duración (umbrales estándar 7/28 noches
-- confirmados con fuente primaria), min-stay dinámico por rango/día de check-in, y
-- reglas por canal (markup). Todo en centavos (bigint), consistente con
-- @atiende/domain-rentas::pricing (motor puro, sin float). Requiere:
-- 001_rentas_schema.sql ya aplicada.
--
-- Fuera de fase (diseño §6): el CRUD de escritura de estas tablas (POST tarifa-base,
-- temporadas, descuentos-duracion, min-stay, reglas-canal) — se siembran por
-- fixture/migración para poder ejercitar la cotización; el endpoint de escritura es
-- Fase 2. Por eso la RLS de este archivo solo otorga SELECT a `authenticated`.

create table rentas.tarifa_base (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  precio_noche_centavos bigint not null check (precio_noche_centavos >= 0),
  moneda char(3) not null check (moneda ~ '^[A-Z]{3}$'),
  vigente_desde date not null default current_date,
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  unique (unidad_id, vigente_desde)
);
create index tarifa_base_unidad_idx on rentas.tarifa_base (unidad_id);

create table rentas.tarifa_temporada (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  nombre text not null,
  fecha_inicio date not null,
  fecha_fin date not null,
  precio_noche_centavos bigint not null check (precio_noche_centavos >= 0),
  moneda char(3) not null check (moneda ~ '^[A-Z]{3}$'),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  constraint tarifa_temporada_rango_valido check (fecha_inicio < fecha_fin)
);
create index tarifa_temporada_unidad_idx on rentas.tarifa_temporada (unidad_id);

create table rentas.tarifa_descuento_duracion (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  noches_minimas integer not null check (noches_minimas > 0),
  porcentaje_descuento_basis_points integer not null check (porcentaje_descuento_basis_points between 0 and 10000),
  fuente text not null,
  creado_en timestamptz not null default now(),
  unique (unidad_id, noches_minimas)
);
create index tarifa_descuento_duracion_unidad_idx on rentas.tarifa_descuento_duracion (unidad_id);

create table rentas.tarifa_min_stay (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  fecha_inicio date not null,
  fecha_fin date not null,
  dia_semana_checkin integer check (dia_semana_checkin between 0 and 6),
  noches_minimas integer not null check (noches_minimas > 0),
  creado_en timestamptz not null default now(),
  constraint tarifa_min_stay_rango_valido check (fecha_inicio < fecha_fin)
);
create index tarifa_min_stay_unidad_idx on rentas.tarifa_min_stay (unidad_id);

-- Markup por canal, INACTIVO por defecto — activarlo es una decisión explícita del
-- tenant, nunca implícita al crear la fila.
create table rentas.tarifa_regla_canal (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  markup_basis_points integer not null default 0 check (markup_basis_points >= 0),
  activo boolean not null default false,
  creado_en timestamptz not null default now(),
  unique (unidad_id, canal_id)
);
create index tarifa_regla_canal_unidad_idx on rentas.tarifa_regla_canal (unidad_id);

alter table rentas.tarifa_base enable row level security;
alter table rentas.tarifa_temporada enable row level security;
alter table rentas.tarifa_descuento_duracion enable row level security;
alter table rentas.tarifa_min_stay enable row level security;
alter table rentas.tarifa_regla_canal enable row level security;

create policy "staff ve tarifa_base de su property" on rentas.tarifa_base for select using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve tarifa_temporada de su property" on rentas.tarifa_temporada for select using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve tarifa_descuento_duracion de su property" on rentas.tarifa_descuento_duracion for select using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve tarifa_min_stay de su property" on rentas.tarifa_min_stay for select using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve tarifa_regla_canal de su property" on rentas.tarifa_regla_canal for select using (core.has_property_access(auth.uid(), property_id));

revoke all on rentas.tarifa_base, rentas.tarifa_temporada, rentas.tarifa_descuento_duracion, rentas.tarifa_min_stay, rentas.tarifa_regla_canal from public, anon;
grant select on rentas.tarifa_base, rentas.tarifa_temporada, rentas.tarifa_descuento_duracion, rentas.tarifa_min_stay, rentas.tarifa_regla_canal to authenticated;
grant select, insert, update, delete on rentas.tarifa_base, rentas.tarifa_temporada, rentas.tarifa_descuento_duracion, rentas.tarifa_min_stay, rentas.tarifa_regla_canal to service_role;
