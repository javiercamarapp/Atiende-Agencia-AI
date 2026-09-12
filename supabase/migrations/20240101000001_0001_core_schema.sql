-- Esquema `core` — prerequisito bloqueante de cualquier vertical.
--
-- `@atiende/core-tenancy` y `@atiende/core-auth` ya asumen (en comentarios y en las
-- queries reales de `core-auth/src/middleware.ts::requirePropertyMembership`) las
-- tablas `core.organization`, `core.property`, `core.membership` y una función
-- `core.has_property_access` — ninguna existía como SQL ejecutable antes de esta
-- migración (ver docs/REQUISITOS.md §0: "packages/db: no hay motor de conexión... ni
-- una sola migración SQL escrita"). Generaliza el par real `hotel_staff`/`location`/
-- `org_id` que ya opera en producción en `hoteles/packages/db/migrations/
-- 0001_extensions_and_auth.sql` — no es un modelo nuevo inventado desde cero.
--
-- Numeración: bloque 0000-0099 reservado para el núcleo (ver packages/db/README.md).
-- El bloque 0100-0199 (restaurantes) vive en packages/domain-restaurantes/migrations/,
-- no aquí — mismo patrón que packages/core-conversation/migrations/001_*.sql, que ya
-- mantiene sus migraciones dentro de su propio paquete en vez de un packages/db
-- centralizado para todo. packages/db solo concentra lo verdaderamente compartido
-- entre las 5 verticales.

create extension if not exists pgcrypto;

create schema if not exists core;

create table core.organization (
  id uuid primary key default gen_random_uuid(),
  vertical text not null check (vertical in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos')),
  name text not null,
  -- Identificador público estable para rutas de checkout/webhook sin autenticar
  -- (ej. POST /v1/restaurantes/:orgSlug/orders) — no estaba en el contrato TS
  -- original de core-tenancy (Organization no lo expone todavía porque ninguna
  -- vertical con rutas públicas se había migrado); se añade aquí porque
  -- domain-restaurantes lo necesita de verdad para resolver el tenant desde una
  -- URL pública (ver diseño Fase 1 §4.1) y cualquier otra vertical con checkout
  -- público lo reutilizará igual.
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'),
  status text not null default 'trial' check (status in ('trial','active','suspended')),
  created_at timestamptz not null default now()
);

create table core.property (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Desnormalizado de organization.vertical, evita join en cada RLS check (ver
  -- comentario en core-tenancy/src/types.ts). Se mantiene en sync con un trigger,
  -- nunca se escribe directo desde domain-<vertical>.
  vertical text not null check (vertical in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos')),
  name text not null,
  status text not null default 'active' check (status in ('active','inactive'))
);

create or replace function core.set_property_vertical()
returns trigger language plpgsql as $$
begin
  select o.vertical into new.vertical from core.organization o where o.id = new.organization_id;
  return new;
end;
$$;

create trigger property_vertical_sync
before insert or update of organization_id on core.property
for each row execute function core.set_property_vertical();

-- Credenciales de staff: vive en `core` porque el JWT propio (@atiende/core-auth) es
-- para TODAS las verticales (decisión ya tomada) — domain-<vertical> NUNCA tiene su
-- propia tabla de login. Mismo mecanismo de hash que ya usa hoteles en producción:
-- scrypt vía node:crypto (ver packages/db/src/password.ts, ported literal de
-- hoteles/packages/db/src/password.ts).
create table core.staff_user (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text,
  full_name text not null,
  created_via text not null default 'invite' check (created_via in ('seed','invite','registro_autoservicio','google')),
  email_verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table core.membership (
  user_id uuid not null references core.staff_user(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- null = acceso a TODAS las properties de la organización (equivalente a
  -- owner/admin de plataforma); un array acota el alcance. Ver
  -- core-tenancy/src/session.ts::hasPropertyAccess, la misma regla en TS.
  property_ids uuid[],
  platform_role text not null check (platform_role in ('owner','admin','member','viewer')),
  -- Opaco para core-tenancy/core-auth; cada domain-<vertical> define su propio enum
  -- real (ver packages/domain-restaurantes/src/roles.ts para RESTAURANTES_ROLES).
  vertical_role text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, organization_id)
);

-- Referenciada por nombre en el comentario de core-tenancy/src/session.ts
-- ("política RLS estándar del núcleo") y usada por
-- core-auth/src/middleware.ts::requirePropertyMembership (join equivalente en TS).
-- Se expone también como función SQL reutilizable directamente en policies RLS de
-- cualquier domain-<vertical> (ver packages/domain-restaurantes/migrations, tablas
-- con policy "select using (core.has_property_access(auth.uid(), property_id))").
create or replace function core.has_property_access(p_user_id uuid, p_property_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = p_user_id and p.id = p_property_id
      and (m.property_ids is null or p_property_id = any(m.property_ids))
  )
$$;

alter table core.organization enable row level security;
alter table core.property enable row level security;
alter table core.staff_user enable row level security;
alter table core.membership enable row level security;

-- Políticas mínimas: un staff autenticado (auth.uid()) puede ver su propia
-- organización/properties/membership. Escritura de gestión (crear org, invitar
-- staff) queda para las rutas núcleo con service-role/rol elevado — fuera del
-- alcance de esta migración de esquema, igual que en hoteles (políticas de
-- escritura administrativa viven en migraciones posteriores, no en el DDL base).
create policy "staff ve su propia organización"
  on core.organization for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = core.organization.id and m.user_id = auth.uid()
    )
  );

create policy "staff ve properties de su organización"
  on core.property for select
  using (core.has_property_access(auth.uid(), core.property.id));

create policy "staff ve su propia membership"
  on core.membership for select
  using (user_id = auth.uid());

create policy "staff ve su propio registro"
  on core.staff_user for select
  using (id = auth.uid());

revoke all on core.organization, core.property, core.staff_user, core.membership from public, anon;
grant select on core.organization, core.property, core.membership to authenticated;
grant select on core.staff_user to authenticated;
grant select, insert, update, delete on core.organization, core.property, core.staff_user, core.membership to service_role;
