-- Suscripción SaaS PROPIA de Atiende a sus organizaciones clientes (auditoría de
-- 22 rubros, hallazgo P1 #6, primera mitad: "checkout+webhook de Stripe para la
-- suscripción SaaS propia de Atiende — implementado y probado, solo falta la
-- ruta"). Deliberadamente en `core` (no en un domain-<vertical>): la suscripción
-- es de PLATAFORMA, cruza las 6 verticales -- mismo criterio que
-- `core.organization`/`core.platform_superadmin`, nunca una tabla de negocio de
-- un solo vertical.
--
-- `packages/billing` (motor de reglas puras: `tenant-verification.ts`
-- (verificación cross-tenant del webhook), `ledger.ts` (dedupe+orden
-- anti-reordenamiento), `per-seat.ts`, `rails/stripe-rail.ts`) YA estaba probado
-- end-to-end (`packages/billing/tests/webhook-integration.spec.ts`) pero SIN
-- NINGÚN lugar real donde persistir su estado -- esta migración +
-- `core.organization_billing`/`core.billing_webhook_event`/
-- `core.billing_entity_order` son ese lugar. Ver `apps/api/src/routes/billing.ts`
-- para las 2 rutas HTTP que consumen esto (`POST /billing/checkout`,
-- `POST /billing/webhook`).
--
-- Distinto de `hoteles.payments`/`StripeHotelesPaymentsPort` (esa integración
-- cobra al HUÉSPED final de un folio, PaymentIntents) -- esta es la suscripción
-- que Atiende le cobra a la ORGANIZACIÓN cliente por usar la plataforma
-- (Checkout Sessions per-seat). Ambas pueden compartir la MISMA cuenta real de
-- Stripe (un solo STRIPE_SECRET_KEY, ver `apps/api/src/env.ts`) sin conflicto --
-- dos productos distintos de la misma cuenta.

create table core.organization_billing (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  price_id text,
  seats integer not null default 0 check (seats >= 0),
  status text not null default 'sin_suscripcion' check (status in ('sin_suscripcion','activa','pago_pendiente','cancelada')),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Ledger anti-duplicado de `packages/billing/src/ledger.ts::aplicarConLedger` --
-- dedupe ATÓMICO por id de evento de Stripe (`insert ... on conflict do
-- nothing`, exactamente lo que `LedgerStore.marcarVisto` exige en su
-- comentario: "un INSERT con restricción única, o equivalente"). Un proveedor de
-- pagos reintenta el MISMO evento con semántica at-least-once -- sin esto, un
-- reintento de `invoice.paid`/`checkout.session.completed` reaplicaría el efecto.
create table core.billing_webhook_event (
  event_id text primary key,
  processed_at timestamptz not null default now()
);

-- Orden por ENTIDAD (customer id de Stripe) -- concepto DISTINTO del dedupe de
-- arriba: Stripe NO promete que los eventos lleguen en el orden en que
-- ocurrieron (ver el comentario de cabecera de `packages/billing/src/ledger.ts`
-- para el caso real que esto cierra -- una cancelación de hoy no debe perderse
-- contra el reintento de un `.updated` viejo que llega después).
create table core.billing_entity_order (
  entity_id text primary key,
  last_applied_created_unix bigint not null
);

alter table core.organization_billing enable row level security;
alter table core.billing_webhook_event enable row level security;
alter table core.billing_entity_order enable row level security;

-- Sin policies de SELECT/INSERT/UPDATE directas para `authenticated`: TODO el
-- acceso pasa por las funciones `security definer` de abajo -- mismo criterio
-- que `core.platform_superadmin`/`core.prospecto` (ver
-- `20240101000112_0010_platform_superadmin.sql`/
-- `20240101000114_0012_superadmin_prospectos.sql`). El checkout necesita validar
-- DENTRO de la función que el caller administra esa organización, y el webhook
-- corre en sesión de sistema (`auth.uid()` null -- no hay membership propia que
-- una policy `= auth.uid()` pudiera usar de todas formas).
revoke all on core.organization_billing, core.billing_webhook_event, core.billing_entity_order from public, anon, authenticated;

-- Info de billing de una organización + su owner_email (primer 'owner' por
-- antigüedad de membership) -- reutilizada tanto por el checkout (resolver si ya
-- existe un customer de Stripe) como por el webhook (verificación cross-tenant,
-- ver `packages/billing/src/tenant-verification.ts::TenantConocido`). `left
-- join` porque una organización nueva no tiene fila en `organization_billing`
-- todavía (nunca se inserta una fila "vacía" al crear la organización).
create or replace function core.get_organization_billing_info(p_organization_id uuid)
returns table (
  organization_id uuid,
  vertical text,
  owner_email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  price_id text,
  seats integer,
  status text,
  current_period_end timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    o.id,
    o.vertical,
    (
      select su.email from core.membership m
      join core.staff_user su on su.id = m.user_id
      where m.organization_id = o.id and m.platform_role = 'owner'
      order by m.created_at asc
      limit 1
    ),
    b.stripe_customer_id,
    b.stripe_subscription_id,
    b.price_id,
    coalesce(b.seats, 0),
    coalesce(b.status, 'sin_suscripcion'),
    b.current_period_end
  from core.organization o
  left join core.organization_billing b on b.organization_id = o.id
  where o.id = p_organization_id;
$$;

revoke all on function core.get_organization_billing_info(uuid) from public;
-- Nunca expuesta directo a `authenticated` -- solo la llaman las 2 funciones de
-- abajo (una valida autoridad de checkout, la otra corre en sesión de sistema
-- del webhook), mismo criterio que `core.has_property_access` (función interna
-- reutilizada, no una superficie propia).

-- Checkout: valida DENTRO de la función que el caller (`p_caller_id`, la sesión
-- de sistema de `deps.coreRepo` no tiene `auth.uid()` real, ver
-- `apps/api/src/production/core-repository.ts`) es owner/admin de la
-- organización o superadmin de plataforma -- mismo criterio que
-- `core.list_prospectos_for_superadmin` (nunca confía en un chequeo hecho solo
-- en TS). Lanza (SQLSTATE P0001) si la organización no existe o si no tiene
-- autoridad -- ninguno de los dos es sensible de ocultar aquí (a diferencia de
-- `staff_invite`: el propio caller YA sabe si administra esa organización, así
-- que un mensaje real no le filtra nada a un atacante que no la administra).
create or replace function core.get_organization_billing_for_checkout(p_caller_id uuid, p_organization_id uuid)
returns table (
  organization_id uuid,
  vertical text,
  owner_email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  price_id text,
  seats integer,
  status text,
  current_period_end timestamptz
)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if not exists (select 1 from core.organization where id = p_organization_id) then
    raise exception 'La organización % no existe.', p_organization_id;
  end if;
  if not exists (
    select 1 from core.membership
    where organization_id = p_organization_id and user_id = p_caller_id and platform_role in ('owner','admin')
  ) and not core.is_platform_superadmin(p_caller_id) then
    raise exception 'No tienes autoridad para administrar el billing de esta organización.';
  end if;
  return query select * from core.get_organization_billing_info(p_organization_id);
end;
$$;

revoke all on function core.get_organization_billing_for_checkout(uuid, uuid) from public;
grant execute on function core.get_organization_billing_for_checkout(uuid, uuid) to authenticated;

-- Webhook: sin caller que autorizar (la firma HMAC de Stripe, verificada en la
-- app ANTES de llegar aquí, ya prueba que el evento es real -- ver
-- `packages/billing/src/rails/stripe-rail.ts::verificarFirmaWebhookStripe` y el
-- comentario de cabecera de `packages/billing/src/types.ts::EventoWebhook`).
-- `null` si la organización no existe (el webhook la descarta con un ack 200,
-- nunca reintenta un evento que nunca podrá resolver).
create or replace function core.get_organization_billing_for_webhook(p_organization_id uuid)
returns table (
  organization_id uuid,
  vertical text,
  owner_email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  price_id text,
  seats integer,
  status text,
  current_period_end timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select * from core.get_organization_billing_info(p_organization_id);
$$;

revoke all on function core.get_organization_billing_for_webhook(uuid) from public;
grant execute on function core.get_organization_billing_for_webhook(uuid) to authenticated;

-- Fija (nunca acumula) el estado de billing de una organización -- mismo
-- criterio que documenta `packages/billing/src/ledger.ts`: los handlers de este
-- dominio FIJAN estado a partir del evento más reciente aplicado (el propio
-- ledger, ya resuelto en TS antes de llamar aquí, es lo que garantiza que
-- "más reciente aplicado" sea real y no un reintento fuera de orden).
create or replace function core.upsert_organization_billing(
  p_organization_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_price_id text,
  p_seats integer,
  p_status text,
  p_current_period_end timestamptz
)
returns void
language sql
security definer
set search_path = core, pg_temp
as $$
  insert into core.organization_billing (
    organization_id, stripe_customer_id, stripe_subscription_id, price_id, seats, status, current_period_end, updated_at
  )
  values (
    p_organization_id, p_stripe_customer_id, p_stripe_subscription_id, p_price_id, p_seats, p_status, p_current_period_end, now()
  )
  on conflict (organization_id) do update set
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    price_id = excluded.price_id,
    seats = excluded.seats,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    updated_at = now();
$$;

revoke all on function core.upsert_organization_billing(uuid, text, text, text, integer, text, timestamptz) from public;
grant execute on function core.upsert_organization_billing(uuid, text, text, text, integer, text, timestamptz) to authenticated;

-- Dedupe atómico por evento -- ver el comentario de cabecera de
-- `core.billing_webhook_event` arriba. `true` = evento nuevo (nunca visto),
-- `false` = ya se había marcado (reintento del proveedor).
create or replace function core.mark_billing_webhook_event_seen(p_event_id text)
returns boolean
language sql
security definer
set search_path = core, pg_temp
as $$
  with ins as (
    insert into core.billing_webhook_event (event_id) values (p_event_id)
    on conflict (event_id) do nothing
    returning event_id
  )
  select exists (select 1 from ins);
$$;

revoke all on function core.mark_billing_webhook_event_seen(text) from public;
grant execute on function core.mark_billing_webhook_event_seen(text) to authenticated;

create or replace function core.get_billing_entity_order(p_entity_id text)
returns bigint
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select last_applied_created_unix from core.billing_entity_order where entity_id = p_entity_id;
$$;

revoke all on function core.get_billing_entity_order(text) from public;
grant execute on function core.get_billing_entity_order(text) to authenticated;

create or replace function core.seal_billing_entity_order(p_entity_id text, p_created_unix bigint)
returns void
language sql
security definer
set search_path = core, pg_temp
as $$
  insert into core.billing_entity_order (entity_id, last_applied_created_unix)
  values (p_entity_id, p_created_unix)
  on conflict (entity_id) do update set last_applied_created_unix = excluded.last_applied_created_unix;
$$;

revoke all on function core.seal_billing_entity_order(text, bigint) from public;
grant execute on function core.seal_billing_entity_order(text, bigint) to authenticated;
