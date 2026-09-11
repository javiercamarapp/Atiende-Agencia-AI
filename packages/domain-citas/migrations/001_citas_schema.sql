-- Esquema `citas.*` — mapeo de las tablas reales de negocio de
-- `citas-reservaciones/supabase/migrations/*` (schema `public`) al modelo de
-- tenancy de `core` (`core.organization`/`core.property`) de
-- packages/db/migrations/0001_core_schema.sql. Requiere: 0001_core_schema.sql ya
-- aplicada. Ver diseño Fase 1 §2/§3 para el mapeo completo tabla por tabla.
--
-- Un negocio de citas YA NO es una tabla `tenants` aislada con su propio concepto de
-- tenant (como en el origen) — es una fila de `core.organization` con
-- `vertical='citas'`; una sucursal es una fila de `core.property`. `tenants.vertical`
-- (el RUBRO real: médico/dental/barbería/...) NO se sobrecarga sobre
-- `core.organization.vertical` (el discriminador de las 5 verticales de la
-- plataforma) — se guarda aparte en `citas.tenant_config.rubro`.
--
-- citas es la primera vertical con sucursales cuyo timezone es relevante para el
-- CÁLCULO de negocio (qué slots son válidos, qué hora ve el cliente) — no solo
-- cosmético. `core.property` no tiene una columna timezone; se agrega aquí, en
-- `citas.property_config`, no en core.property mismo (packages/db solo concentra lo
-- verdaderamente compartido entre las 5 verticales; el timezone por property no lo
-- necesita ninguna otra vertical todavía).

create schema if not exists citas;

-- tenants (origen) -> core.organization + tenant_config (específico de citas: rubro
-- real, timezone por defecto de la organización, teléfono de notificación urgente).
create table citas.tenant_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  rubro text not null default 'otro'
    check (rubro in ('medico', 'dental', 'barberia', 'salon', 'spa', 'veterinaria', 'restaurante', 'psicologo', 'gimnasio', 'farmacia', 'escuela', 'seguros', 'mecanico', 'otro')),
  default_timezone text not null default 'America/Mexico_City',
  owner_notification_phone text check (owner_notification_phone is null or length(owner_notification_phone) between 1 and 32),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- branches (origen) -> core.property (genérico) + property_config (específico de
-- citas: el timezone, que sí cambia qué horarios son válidos — ver comentario de
-- archivo). Un tenant de una sola ubicación no necesita ninguna fila aquí: el
-- fallback es citas.tenant_config.default_timezone.
create table citas.property_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  timezone text not null default 'America/Mexico_City'
);

-- providers (el profesional/mesa con calendario propio — genérico, no "doctor").
create table citas.providers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete set null,
  display_name text not null,
  role_label text not null default 'Proveedor',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index providers_organization_idx on citas.providers (organization_id);
create index providers_property_idx on citas.providers (property_id);

-- services (tipo de cita, con duración + buffers antes/después).
create table citas.services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  name text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  buffer_minutes_before integer not null default 0 check (buffer_minutes_before >= 0),
  buffer_minutes_after integer not null default 0 check (buffer_minutes_after >= 0),
  price_cents integer check (price_cents is null or price_cents >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index services_organization_idx on citas.services (organization_id);

-- Qué proveedores ofrecen qué servicios.
create table citas.provider_services (
  provider_id uuid not null references citas.providers(id) on delete cascade,
  service_id uuid not null references citas.services(id) on delete cascade,
  primary key (provider_id, service_id)
);

-- availability_rules (horario recurrente por proveedor) + availability_overrides
-- (excepciones puntuales).
create table citas.availability_rules (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references citas.providers(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6), -- 0 = domingo
  start_time time not null,
  end_time time not null check (end_time > start_time),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index availability_rules_provider_idx on citas.availability_rules (provider_id, day_of_week);

create table citas.availability_overrides (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references citas.providers(id) on delete cascade,
  override_date date not null,
  is_closed boolean not null default true,
  start_time time,
  end_time time,
  reason text,
  created_at timestamptz not null default now(),
  check (is_closed or (start_time is not null and end_time is not null and end_time > start_time)),
  unique (provider_id, override_date)
);
create index availability_overrides_provider_date_idx on citas.availability_overrides (provider_id, override_date);

-- customers (memoria por teléfono, igual criterio que restaurantes).
create table citas.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  full_name text not null,
  phone text not null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone)
);
create index customers_organization_idx on citas.customers (organization_id);

-- appointments (fuente de verdad real). Sincronización a Google Calendar queda
-- fuera de Fase 1 (ver diseño §6) — no se portan columnas google_event_id/
-- google_sync_* porque ningún flujo en scope las necesita todavía.
create table citas.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete set null,
  provider_id uuid not null references citas.providers(id) on delete restrict,
  service_id uuid not null references citas.services(id) on delete restrict,
  customer_id uuid not null references citas.customers(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'completed', 'cancelled', 'no_show')),
  source text not null default 'manual'
    check (source in ('voice', 'whatsapp', 'web', 'manual')),
  notes text,
  dedupe_fingerprint text check (dedupe_fingerprint is null or dedupe_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[0-9a-f]{64}$'),
  reminder_24h_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Ningún proveedor puede tener dos citas activas que se traslapen en el tiempo —
  -- a nivel de base de datos, no solo validado en la aplicación (capa 1 de
  -- anti-doble-reserva, ver diseño Fase 1 §0.7/§5.1). Las citas canceladas o
  -- no-show no bloquean el horario.
  exclude using gist (
    provider_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('pending', 'confirmed', 'completed'))
);
create unique index appointments_org_idempotency_key_uidx
  on citas.appointments (organization_id, idempotency_key)
  where idempotency_key is not null;
create index appointments_org_fingerprint_created_idx
  on citas.appointments (organization_id, dedupe_fingerprint, created_at desc)
  where dedupe_fingerprint is not null;
create index appointments_org_starts_idx on citas.appointments (organization_id, starts_at);
create index appointments_provider_starts_idx on citas.appointments (provider_id, starts_at);
create index appointments_customer_idx on citas.appointments (customer_id);

-- appointment_audit_events — auditoría append-only real del ciclo de vida de una
-- cita (reagendos). Solo `service_role` inserta (vía reschedule_appointment_idempotent,
-- ver 002); el staff solo puede leer.
create table citas.appointment_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  appointment_id uuid not null references citas.appointments(id) on delete cascade,
  event_type text not null check (event_type in ('rescheduled')),
  actor_channel text not null check (actor_channel in ('voice', 'whatsapp', 'web', 'manual', 'panel')),
  actor_note text check (actor_note is null or length(actor_note) <= 2000),
  previous_data jsonb not null,
  new_data jsonb not null,
  created_at timestamptz not null default now()
);
create index appointment_audit_events_org_appointment_idx
  on citas.appointment_audit_events (organization_id, appointment_id, created_at desc);

-- ============================================================================
-- Row Level Security
-- ============================================================================

alter table citas.tenant_config enable row level security;
alter table citas.property_config enable row level security;
alter table citas.providers enable row level security;
alter table citas.services enable row level security;
alter table citas.provider_services enable row level security;
alter table citas.availability_rules enable row level security;
alter table citas.availability_overrides enable row level security;
alter table citas.customers enable row level security;
alter table citas.appointments enable row level security;
alter table citas.appointment_audit_events enable row level security;

-- Catálogo de horario/servicios es de lectura pública (un futuro widget de
-- reservación público lo necesitaría, mismo criterio que restaurantes con su
-- catálogo) — nunca PII de clientes/citas.
create policy "cualquiera puede ver proveedores activos" on citas.providers for select using (is_active);
create policy "cualquiera puede ver servicios activos" on citas.services for select using (is_active);
create policy "cualquiera puede ver provider_services" on citas.provider_services for select using (true);
create policy "cualquiera puede ver reglas de disponibilidad" on citas.availability_rules for select using (true);
create policy "cualquiera puede ver overrides de disponibilidad" on citas.availability_overrides for select using (true);

create policy "staff gestiona tenant_config de su organización" on citas.tenant_config for all
  using (exists (select 1 from core.membership m where m.organization_id = tenant_config.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = tenant_config.organization_id and m.user_id = auth.uid()));
create policy "staff gestiona property_config de su organización" on citas.property_config for all
  using (exists (select 1 from core.membership m where m.organization_id = property_config.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = property_config.organization_id and m.user_id = auth.uid()));
create policy "staff gestiona proveedores de su organización" on citas.providers for all
  using (exists (select 1 from core.membership m where m.organization_id = providers.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = providers.organization_id and m.user_id = auth.uid()));
create policy "staff gestiona servicios de su organización" on citas.services for all
  using (exists (select 1 from core.membership m where m.organization_id = services.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = services.organization_id and m.user_id = auth.uid()));

-- PII (customers/appointments) — solo staff de la organización dueña, nunca policy
-- pública de SELECT (igual que restaurantes: estas tablas solo se tocan vía las
-- rutas "de sistema" sin auth.uid(), con sesión abierta vía
-- TenancyEngine.withAppSession({ userId: null }, ...), ver diseño Fase 1 §3.1).
create policy "staff ve clientes de su organización" on citas.customers for select
  using (exists (select 1 from core.membership m where m.organization_id = customers.organization_id and m.user_id = auth.uid()));
create policy "staff ve citas de su organización" on citas.appointments for select
  using (exists (select 1 from core.membership m where m.organization_id = appointments.organization_id and m.user_id = auth.uid()));
create policy "staff ve auditoría de citas de su organización" on citas.appointment_audit_events for select
  using (exists (select 1 from core.membership m where m.organization_id = appointment_audit_events.organization_id and m.user_id = auth.uid()));

revoke all on all tables in schema citas from public, anon;
grant select on citas.providers, citas.services, citas.provider_services, citas.availability_rules, citas.availability_overrides to anon, authenticated;
grant select on citas.tenant_config, citas.property_config, citas.customers, citas.appointments, citas.appointment_audit_events to authenticated;
grant select, insert, update, delete on all tables in schema citas to service_role;
