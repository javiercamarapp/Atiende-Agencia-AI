-- Esquema `hoteles.*` — mapeo de las tablas reales de negocio de `hoteles/schema.sql`
-- (schema `public`) al modelo de tenancy de `core` (`core.organization`/
-- `core.property`) de packages/db/migrations/0001_core_schema.sql. Requiere:
-- 0001_core_schema.sql ya aplicada. Ver diseño Fase 1 §1 para el mapeo completo
-- tabla por tabla y la justificación de cada decisión (en particular: por qué la
-- tabla `hotel` del origen NO se porta — `core.property.vertical='hoteles'` ya cubre
-- exactamente lo que esa tabla resolvía).
--
-- Alcance de Fase 1 (§3.3 del diseño): solo lo necesario para sostener los 3 flujos
-- elegidos (folios/cargos, guardia de alergias F&B, motor de cotización). La máquina
-- de estados completa de reservas, housekeeping, night-audit, CFDI, etc. quedan fuera
-- — `hoteles.reservation` aquí es el mínimo que exige la FK de `folio` y las columnas
-- que lee `loadFolioGuestIdentity` (`full_name`, `phone` de `hoteles.guest`).

create schema if not exists hoteles;

-- ---------------------------------------------------------------------------
-- Inventario mínimo (soporta rate_plan/quotes y la FK de reservation->room_type).
-- ---------------------------------------------------------------------------
create table hoteles.room_type (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  name text not null,
  max_occupancy integer not null default 2 check (max_occupancy > 0),
  created_at timestamptz not null default now(),
  unique (property_id, name)
);
create index room_type_property_idx on hoteles.room_type (property_id);

create table hoteles.room (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id) on delete restrict,
  code text not null,
  status text not null default 'disponible'
    check (status in ('disponible', 'ocupada', 'sucia', 'fuera_de_servicio', 'mantenimiento')),
  created_at timestamptz not null default now(),
  unique (property_id, code)
);
create index room_property_idx on hoteles.room (property_id);
create index room_room_type_idx on hoteles.room (room_type_id);

-- Fuente de verdad REAL de precio/reglas por noche que consulta el motor de
-- cotización (quote.ts) — una fila real por noche, jamás inventada (REQ-REV-001).
create table hoteles.rate_plan (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id) on delete cascade,
  date date not null,
  price numeric(12, 2) not null check (price >= 0),
  currency text not null default 'MXN',
  min_stay integer not null default 1 check (min_stay > 0),
  closed_to_arrival boolean not null default false,
  closed_to_departure boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_type_id, date)
);
create index rate_plan_property_date_idx on hoteles.rate_plan (property_id, date);

-- ---------------------------------------------------------------------------
-- Huésped/reserva — mínimo necesario como FK de folio + lo que lee
-- loadFolioGuestIdentity (REQ-AB-012).
-- ---------------------------------------------------------------------------
create table hoteles.guest (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now()
);
create index guest_property_idx on hoteles.guest (property_id);

create table hoteles.reservation (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  room_type_id uuid references hoteles.room_type(id) on delete restrict,
  guest_id uuid references hoteles.guest(id) on delete set null,
  check_in_date date not null,
  check_out_date date not null check (check_out_date > check_in_date),
  status text not null default 'confirmada',
  created_at timestamptz not null default now()
);
create index reservation_property_idx on hoteles.reservation (property_id);

-- ---------------------------------------------------------------------------
-- Folio/charge/payment — H5, motor determinista en @atiende/domain-hoteles
-- (folioEngine.ts). concept/reverso/transferencia/discount ya incluidos desde el
-- origen (a diferencia de hoteles, que los agregó por ALTER en 0030 sobre un esquema
-- ya viejo) porque este es un esquema nuevo, no una migración expand-only sobre
-- historia previa.
-- ---------------------------------------------------------------------------
create table hoteles.folio (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  reservation_id uuid not null references hoteles.reservation(id) on delete restrict,
  status text not null default 'abierto' check (status in ('abierto', 'cerrado')),
  label text not null default 'Principal',
  is_primary boolean not null default true,
  closed_at timestamptz,
  close_reason text check (close_reason in ('saldo_cero', 'cuenta_por_cobrar')),
  ar_approved_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index folio_property_idx on hoteles.folio (property_id);
create index folio_reservation_idx on hoteles.folio (reservation_id);
create unique index folio_reservation_primary_idx on hoteles.folio (reservation_id) where is_primary;

create table hoteles.charge (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  folio_id uuid not null references hoteles.folio(id) on delete cascade,
  description text not null,
  amount numeric(12, 2) not null,
  tax_amount numeric(12, 2) not null default 0,
  concept text not null default 'otro'
    check (concept in ('hospedaje', 'ab', 'extras', 'ajuste', 'propina', 'descuento', 'reverso', 'otro')),
  -- Solo poblado para concept='hospedaje' (posteo de night-audit) — soporta el índice
  -- único parcial anti-doble-captura de abajo.
  stay_date date,
  reverses_charge_id uuid references hoteles.charge(id) on delete set null,
  transferred_from_charge_id uuid references hoteles.charge(id) on delete set null,
  discount_authorized_by uuid references core.staff_user(id) on delete set null,
  -- Nunca se hace UPDATE/DELETE de un cargo real: un reverso inserta una fila nueva y
  -- marca esta columna en el original vía hoteles.mark_charge_reversed() (REQ-REC-004).
  reversed_by uuid references hoteles.charge(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint charge_amount_check check (amount >= 0 or concept in ('descuento', 'reverso')),
  constraint charge_tax_amount_check check (tax_amount >= 0 or concept = 'reverso')
);
create index charge_folio_idx on hoteles.charge (folio_id);
create index charge_property_idx on hoteles.charge (property_id);

-- REQ-AB-012 (guardia anti-doble-captura): el night-audit nunca postea dos veces el
-- cargo de hospedaje de la misma noche del mismo folio. Port literal del índice único
-- parcial real de hoteles/supabase/migrations/0030_folio_engine.sql
-- (`charge_folio_stay_date_hospedaje_idx`). Los reversos de un cargo de hospedaje no
-- llevan `stay_date` (se documentan con `reverses_charge_id`), así que el índice
-- parcial no los bloquea.
create unique index charge_folio_stay_date_hospedaje_idx
  on hoteles.charge (folio_id, stay_date)
  where concept = 'hospedaje' and stay_date is not null and reverses_charge_id is null;

create table hoteles.payment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  folio_id uuid not null references hoteles.folio(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  method text not null check (method in ('efectivo', 'transferencia', 'tarjeta')),
  status text not null default 'capturado'
    check (status in ('pendiente', 'autorizado', 'capturado', 'fallido', 'reembolsado', 'expirado')),
  external_ref text,
  -- Referencia OPACA de token de pago — NUNCA un PAN (REQ-REC-008/H19-005). El CHECK
  -- es la última línea de defensa, no la única (la ruta HTTP ya exige un tokenPago
  -- opaco antes de llamar PaymentsPort.charge()).
  token_ref text,
  created_at timestamptz not null default now(),
  constraint payment_token_ref_not_pan check (token_ref is null or token_ref !~ '^[0-9]{12,19}$')
);
create index payment_folio_idx on hoteles.payment (folio_id);
create index payment_property_idx on hoteles.payment (property_id);

-- ---------------------------------------------------------------------------
-- Configuración fiscal/descuento por property (REQ-REV-001/REQ-BO-001).
-- ---------------------------------------------------------------------------
create table hoteles.tax_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  iva_rate numeric(6, 4) not null default 0.16 check (iva_rate >= 0 and iva_rate <= 1),
  ish_rate numeric(6, 4) not null default 0.03 check (ish_rate >= 0 and ish_rate <= 1),
  discount_threshold numeric(12, 2) not null default 500 check (discount_threshold >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- F&B (REQ-AB-004, flujo 2) — guardia de alergias. Los dos CHECK de consistencia son
-- port literal del origen: nunca queda un estado inconsistente entre
-- allergy_declared/allergy_declared_via, ni entre kitchen_confirmed_by/_at, ni se
-- puede persistir "seguridad asegurada" sin confirmación de cocina previa.
-- ---------------------------------------------------------------------------
create table hoteles.fnb_order (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  room_id uuid references hoteles.room(id) on delete set null,
  items jsonb not null default '[]'::jsonb,
  notes text,
  allergy_declared boolean not null default false,
  -- 'estructurado' = el huésped/staff marcó el campo explícito; 'texto_libre' /
  -- 'texto_libre_no_reconocido' = la red de seguridad de resolveAllergyDeclared() lo
  -- detectó (o no pudo descartarlo) en una nota libre.
  allergy_declared_via text check (allergy_declared_via in ('estructurado', 'texto_libre', 'texto_libre_no_reconocido')),
  kitchen_confirmed_by uuid references core.staff_user(id) on delete set null,
  kitchen_confirmed_at timestamptz,
  kitchen_confirmation_note text,
  -- Auditoría de la ÚNICA acción que "asegura" al huésped que el platillo es seguro —
  -- si esta columna nunca se llena para un pedido, es evidencia estructural de que el
  -- sistema nunca emitió esa afirmación.
  safety_assurance_sent_by uuid references core.staff_user(id) on delete set null,
  safety_assurance_sent_at timestamptz,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (allergy_declared = (allergy_declared_via is not null)),
  check ((kitchen_confirmed_by is null) = (kitchen_confirmed_at is null)),
  check (safety_assurance_sent_at is null or not allergy_declared or kitchen_confirmed_at is not null)
);
create index fnb_order_property_idx on hoteles.fnb_order (property_id);

-- ---------------------------------------------------------------------------
-- Idempotencia (transversal a folios y F&B) — NO se re-crea a nivel `core` (ese
-- mecanismo es genérico de plataforma, pero cada vertical mantiene su propia tabla en
-- su propio schema, mismo patrón que domain-restaurantes con
-- `restaurantes.api_rate_limits`/`orders.idempotency_key` inline). Scope real usado:
-- charge.create/charge.discount/charge.reverse/charge.transfer/folio.split/
-- payment.create (ver diseño Fase 1 §1).
-- ---------------------------------------------------------------------------
create table hoteles.idempotency_key (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  scope text not null check (length(scope) between 1 and 60),
  key text not null check (length(key) between 1 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  unique (organization_id, scope, key)
);
create index idempotency_key_org_scope_idx on hoteles.idempotency_key (organization_id, scope);

-- ---------------------------------------------------------------------------
-- RLS — nunca se re-implementa `hotel_staff` propio: la autoridad de membership es
-- SIEMPRE `core.membership`. `hoteles.can_access_money()` es un subconjunto de roles
-- FINOS (no de plataforma), así que vive en este schema, no en `core` (ver diseño
-- Fase 1 §2).
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_access_money(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant')
  )
$$;

alter table hoteles.room_type enable row level security;
alter table hoteles.room enable row level security;
alter table hoteles.rate_plan enable row level security;
alter table hoteles.guest enable row level security;
alter table hoteles.reservation enable row level security;
alter table hoteles.folio enable row level security;
alter table hoteles.charge enable row level security;
alter table hoteles.payment enable row level security;
alter table hoteles.tax_config enable row level security;
alter table hoteles.fnb_order enable row level security;
alter table hoteles.idempotency_key enable row level security;

-- Inventario/tarifas: cualquier miembro del staff de la property puede leer (el motor
-- de cotización corre bajo la sesión del staff que cotiza, ver quotes.ts); gestión de
-- catálogo (insert/update) queda fuera de Fase 1 (no hay ruta que la ejerza todavía),
-- así que solo se otorga SELECT vía policy — INSERT/UPDATE quedan solo para
-- service_role (seed/migraciones), igual que hoy documenta domain-restaurantes para
-- sus tablas de catálogo administradas fuera de esta fase.
create policy "staff ve tipos de habitación de su property" on hoteles.room_type for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve habitaciones de su property" on hoteles.room for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve tarifas de su property" on hoteles.rate_plan for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve huéspedes de su property" on hoteles.guest for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve reservas de su property" on hoteles.reservation for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve configuración fiscal de su property" on hoteles.tax_config for select
  using (core.has_property_access(auth.uid(), property_id));

-- Dinero: folio/charge/payment — SOLO roles de `hoteles.can_access_money()`, jamás
-- housekeeping/maintenance (verificado explícitamente en el diseño §2, mismo criterio
-- que el origen).
create policy "dinero: staff con acceso ve folios" on hoteles.folio for select
  using (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso crea/actualiza folios" on hoteles.folio for insert
  with check (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso actualiza folios" on hoteles.folio for update
  using (hoteles.can_access_money(property_id)) with check (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso ve cargos" on hoteles.charge for select
  using (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso inserta cargos" on hoteles.charge for insert
  with check (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso actualiza cargos" on hoteles.charge for update
  using (hoteles.can_access_money(property_id)) with check (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso ve pagos" on hoteles.payment for select
  using (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso inserta pagos" on hoteles.payment for insert
  with check (hoteles.can_access_money(property_id));

-- F&B: cualquier miembro del staff de la property puede leer; tomar/confirmar/
-- asegurar se filtra por rol FINO en la capa de aplicación (assertVerticalRole con
-- TOMAR_PEDIDO_ROLES/CONFIRMAR_COCINA_ROLES), igual que folios delega el filtrado
-- fino al handler — la RLS aquí es la capa de "perteneces a esta property", no la de
-- "tu rol específico puede confirmar cocina".
create policy "staff ve pedidos de f&b de su property" on hoteles.fnb_order for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff crea pedidos de f&b de su property" on hoteles.fnb_order for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza pedidos de f&b de su property" on hoteles.fnb_order for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve sus llaves de idempotencia" on hoteles.idempotency_key for select
  using (
    exists (select 1 from core.membership m where m.organization_id = idempotency_key.organization_id and m.user_id = auth.uid())
  );
create policy "staff inserta llaves de idempotencia de su organización" on hoteles.idempotency_key for insert
  with check (
    exists (select 1 from core.membership m where m.organization_id = idempotency_key.organization_id and m.user_id = auth.uid())
  );
create policy "staff actualiza llaves de idempotencia de su organización" on hoteles.idempotency_key for update
  using (exists (select 1 from core.membership m where m.organization_id = idempotency_key.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = idempotency_key.organization_id and m.user_id = auth.uid()));

revoke all on all tables in schema hoteles from public, anon;
grant select on hoteles.room_type, hoteles.room, hoteles.rate_plan, hoteles.guest, hoteles.reservation, hoteles.tax_config to authenticated;
grant select, insert, update on hoteles.folio to authenticated;
grant select, insert, update on hoteles.charge to authenticated;
grant select, insert on hoteles.payment to authenticated;
grant select, insert, update on hoteles.fnb_order to authenticated;
grant select, insert, update on hoteles.idempotency_key to authenticated;
grant select, insert, update, delete on all tables in schema hoteles to service_role;
