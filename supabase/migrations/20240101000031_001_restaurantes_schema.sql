-- Esquema `restaurantes.*` — mapeo de las tablas reales de negocio de
-- `restaurantes/supabase/migrations/*` (schema `public`) al modelo de tenancy de
-- `core` (`core.organization`/`core.property`) de packages/db/migrations/0001_core_schema.sql.
-- Requiere: 0001_core_schema.sql ya aplicada.
--
-- Un restaurante YA NO es una tabla `restaurants` aislada con su propio concepto de
-- tenant (como en el origen) — es una fila de `core.organization` con
-- `vertical='restaurantes'`; una sucursal es una fila de `core.property` (+ su detalle
-- de negocio en `restaurantes.branch_detail`). Ver diseño Fase 1 §1 para el mapeo
-- completo tabla por tabla y la justificación de cada decisión.

create schema if not exists restaurantes;

-- branches (origen) -> core.property (genérico) + branch_detail (específico de
-- restaurantes: slug/phone/address/lat/lng/display_order, que core.property no tiene).
create table restaurantes.branch_detail (
  property_id uuid primary key references core.property(id) on delete cascade,
  slug text not null,
  phone text,
  address text,
  lat numeric,
  lng numeric,
  display_order integer not null default 0,
  -- El slug es único DENTRO de la organización (dos restaurantes distintos pueden
  -- tener ambos una sucursal "centro"), nunca global — a diferencia de
  -- core.organization.slug, que sí es público/global.
  organization_id uuid not null references core.organization(id) on delete cascade,
  unique (organization_id, slug)
);

create table restaurantes.categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  name text not null,
  slug text not null,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table restaurantes.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  category_id uuid references restaurantes.categories(id) on delete set null,
  name text not null,
  description text,
  price numeric(10, 2) not null,
  image_url text,
  is_popular boolean not null default false,
  is_available boolean not null default true,
  display_order integer not null default 0,
  -- Columna sembrada a mano el 4-sep-2026 en el origen (ver
  -- 20260904020000_products_search_keywords.sql) — la que hace que "pizza"
  -- encuentre "Quesobich de Queso". Se preserva tal cual.
  search_keywords text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_org_idx on restaurantes.products(organization_id);

-- Fuente de verdad REAL de precio/disponibilidad por sucursal — los precios sí
-- varían de verdad entre sucursales (verificado en el origen, 20260903020000). Esta
-- tabla, no `products.price`, es lo que consulta quoteOrder/searchProducts.
create table restaurantes.branch_products (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references core.property(id) on delete cascade,
  product_id uuid not null references restaurantes.products(id) on delete cascade,
  price numeric(10, 2) not null,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, product_id)
);

-- Memoria de cliente por-organización (no por-sucursal, a propósito: un mismo
-- cliente puede pedir a varias sucursales del mismo restaurante y su memoria es
-- una sola). UNIQUE(organization_id, phone) preservado del origen.
create table restaurantes.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone text not null,
  name text,
  order_count integer not null default 0,
  last_order_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone)
);

create table restaurantes.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  label text,
  address text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (customer_id, address)
);

create table restaurantes.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id),
  customer_id uuid references restaurantes.customers(id),
  customer_name text not null,
  customer_phone text not null,
  customer_address text,
  -- Nombre de sucursal desnormalizado, preservado por compatibilidad de UI (igual
  -- que `orders.branch` en el origen).
  branch text,
  total numeric(10, 2) not null,
  status text not null default 'pending'
    check (status in ('pending', 'preparando', 'en_camino', 'entregado', 'cancelado', 'completado', 'problema')),
  items jsonb not null,
  source text not null default 'web' check (source in ('web', 'voice', 'whatsapp', 'admin')),
  notes text,
  payment_method text check (payment_method is null or payment_method in ('efectivo', 'tarjeta')),
  call_transcript text,
  call_recording_url text,
  dedupe_fingerprint text check (dedupe_fingerprint is null or dedupe_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[0-9a-f]{64}$'),
  order_number bigserial,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create unique index orders_org_idempotency_key_uidx
  on restaurantes.orders(organization_id, idempotency_key)
  where idempotency_key is not null;
create index orders_org_fingerprint_created_idx
  on restaurantes.orders(organization_id, dedupe_fingerprint, created_at desc)
  where dedupe_fingerprint is not null;
create index orders_customer_idx on restaurantes.orders(customer_id, created_at desc);

create table restaurantes.callback_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete set null,
  customer_name text not null,
  customer_phone text not null,
  reason text,
  message text,
  source text not null default 'voice' check (source in ('voice', 'whatsapp', 'web', 'admin')),
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

create table restaurantes.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone text not null,
  property_id uuid references core.property(id),
  messages jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  order_id uuid references restaurantes.orders(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone)
);

-- Dedupe de entrega at-least-once de Meta, por message_id.
create table restaurantes.whatsapp_inbound_events (
  message_id text primary key check (length(message_id) between 1 and 255),
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  claimed_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_class text check (last_error_class is null or length(last_error_class) <= 120)
);

-- Lease de 120s para serializar mensajes casi-simultáneos del mismo teléfono.
create table restaurantes.whatsapp_conversation_leases (
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  owner_message_id text not null check (length(owner_message_id) between 1 and 255),
  locked_until timestamptz not null,
  primary key (organization_id, phone_hash)
);

-- NUEVO en Fase 1 (no existía en el origen: un solo tenant real no necesitaba
-- rutear por número de destino). Resuelve qué organización es dueña de un
-- `phone_number_id` de Meta Cloud API para el webhook multi-tenant (ver diseño
-- Fase 1 §4.3). Decisión de diseño explícita para Fase 1: una sola Meta App
-- compartida por la plataforma; `phone_number_id` solo rutea, el `app_secret` de
-- plataforma (Vault/env, nunca en esta tabla) verifica todas las firmas.
create table restaurantes.whatsapp_channel_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  phone_number_id text not null unique,
  created_at timestamptz not null default now()
);

-- Rate limiting genérico (por scope+actor_hash) — candidato a promoción a núcleo
-- compartido cuando otra vertical lo necesite igual; se queda en domain-restaurantes
-- por ahora para no tocar core-tenancy/core-auth fuera de esta fase.
create table restaurantes.api_rate_limits (
  scope text not null check (length(scope) between 1 and 120),
  actor_hash text not null check (actor_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (scope, actor_hash)
);

alter table restaurantes.branch_detail enable row level security;
alter table restaurantes.categories enable row level security;
alter table restaurantes.products enable row level security;
alter table restaurantes.branch_products enable row level security;
alter table restaurantes.customers enable row level security;
alter table restaurantes.customer_addresses enable row level security;
alter table restaurantes.orders enable row level security;
alter table restaurantes.callback_requests enable row level security;
alter table restaurantes.whatsapp_conversations enable row level security;
alter table restaurantes.whatsapp_inbound_events enable row level security;
alter table restaurantes.whatsapp_conversation_leases enable row level security;
alter table restaurantes.whatsapp_channel_config enable row level security;
alter table restaurantes.api_rate_limits enable row level security;

-- Catálogo (categorías/productos/branch_products) es público de lectura — el
-- checkout web anónimo necesita verlo, igual que hoy (policy "Anyone can view
-- branch products" del origen).
create policy "cualquiera puede ver categorías" on restaurantes.categories for select using (true);
create policy "cualquiera puede ver productos" on restaurantes.products for select using (true);
create policy "cualquiera puede ver branch_products" on restaurantes.branch_products for select using (true);
create policy "cualquiera puede ver detalle de sucursal" on restaurantes.branch_detail for select using (true);

-- Staff de la organización dueña puede gestionar su catálogo (MANAGER_ROLES:
-- owner/admin/staff — ver domain-restaurantes/src/roles.ts).
create policy "staff gestiona categorías de su organización" on restaurantes.categories for all
  using (exists (select 1 from core.membership m where m.organization_id = categories.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = categories.organization_id and m.user_id = auth.uid()));
create policy "staff gestiona productos de su organización" on restaurantes.products for all
  using (exists (select 1 from core.membership m where m.organization_id = products.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = products.organization_id and m.user_id = auth.uid()));

-- PII (customers/orders/whatsapp_conversations) — solo staff de la organización
-- dueña, nunca policy pública de SELECT (igual que el origen: estas tablas solo se
-- tocan vía las rutas "de sistema" sin auth.uid(), con sesión abierta vía
-- TenancyEngine.withAppSession({ userId: null }, ...), ver diseño Fase 1 §3).
create policy "staff ve clientes de su organización" on restaurantes.customers for select
  using (exists (select 1 from core.membership m where m.organization_id = customers.organization_id and m.user_id = auth.uid()));
create policy "staff ve direcciones de sus clientes" on restaurantes.customer_addresses for select
  using (exists (
    select 1 from restaurantes.customers c
    join core.membership m on m.organization_id = c.organization_id
    where c.id = customer_addresses.customer_id and m.user_id = auth.uid()
  ));
create policy "staff ve pedidos de su organización" on restaurantes.orders for select
  using (exists (select 1 from core.membership m where m.organization_id = orders.organization_id and m.user_id = auth.uid()));
create policy "staff ve solicitudes de contacto de su organización" on restaurantes.callback_requests for select
  using (exists (select 1 from core.membership m where m.organization_id = callback_requests.organization_id and m.user_id = auth.uid()));
create policy "staff ve conversaciones de whatsapp de su organización" on restaurantes.whatsapp_conversations for select
  using (exists (select 1 from core.membership m where m.organization_id = whatsapp_conversations.organization_id and m.user_id = auth.uid()));

revoke all on all tables in schema restaurantes from public, anon;
grant select on restaurantes.categories, restaurantes.products, restaurantes.branch_products, restaurantes.branch_detail to anon, authenticated;
grant select on restaurantes.customers, restaurantes.customer_addresses, restaurantes.orders, restaurantes.callback_requests, restaurantes.whatsapp_conversations
  to authenticated;
grant select, insert, update, delete on all tables in schema restaurantes to service_role;
