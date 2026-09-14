-- Fase 9 rentas -- correo transaccional real al huésped (confirmación de reserva +
-- recordatorio de check-in), ver packages/domain-rentas/src/reserva-email-notifications.ts,
-- src/email-dispatch.ts, src/checkin-reminders.ts. Requiere: 001_rentas_schema.sql ya
-- aplicada (rentas.ocupacion, rentas.guest_minimo, core.property/core.organization).
--
-- GAP QUE ESTA FASE CIERRA (ver apps/api/src/routes/verticals/rentas/reservas.ts,
-- comentario "el envío de correo de confirmación al huésped ... se difiere a Fase 2"):
-- rentas NUNCA tuvo ningún concepto de outbox (a diferencia de domain-citas, que lo
-- trae desde su propia Fase 1, y de domain-hoteles/domain-restaurantes, que lo
-- adoptaron en fases posteriores para el canal `whatsapp`) -- esta migración agrega
-- `rentas.messaging_outbox`, MISMO shape de fila que `hoteles.messaging_outbox`
-- (008_messaging_outbox.sql: partición por `property_id`, no por `organization_id` --
-- aquí aplica el mismo criterio, rentas es property-scoped igual que hoteles), MÁS las
-- dos funciones de drenado de correo `email` acotadas (`claim_email_outbox_batch`/
-- `complete_email_outbox_job`) que domain-citas agregó en su propia
-- 009_email_outbox_dispatch.sql -- aquí van en un solo archivo (`attempts`/`last_error`
-- desde el día uno, sin necesidad de la migración de dos pasos que tuvo citas por
-- razones históricas).
--
-- El canal `whatsapp` del CHECK queda declarado por CONSISTENCIA de esquema con
-- hoteles/citas/restaurantes (una futura fase de mensajería saliente real por
-- WhatsApp podría reusar la misma tabla) -- esta fase NO agrega ningún claim/dispatch
-- de `channel='whatsapp'` (fuera de alcance, ver docs de la fase).
--
-- Además: `rentas.ocupacion.recordatorio_checkin_enviado_en` -- mismo criterio que
-- `citas.appointments.reminder_24h_sent_at`, belt-and-suspenders sobre el dedupe_key
-- real de `messaging_outbox` (evita que el cron de recordatorio vuelva a escanear/
-- reencolar una reserva ya notificada en cada corrida dentro de la ventana de 24-48h).

alter table rentas.ocupacion add column recordatorio_checkin_enviado_en timestamptz;

create table rentas.messaging_outbox (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'email')),
  event_type text not null check (length(event_type) between 1 and 80),
  dedupe_key text not null check (length(dedupe_key) between 1 and 255),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (property_id, channel, dedupe_key)
);
create index messaging_outbox_claim_idx
  on rentas.messaging_outbox (channel, status, next_attempt_at)
  where status in ('pending', 'processing');

alter table rentas.messaging_outbox enable row level security;
-- Nunca visible/escribible desde el panel de staff (authenticated) -- solo el
-- dispatcher de sistema (sesión `userId: null`, mismo criterio que
-- ical-sync-cron.ts/mensajeria-borradores.ts) toca esta tabla, vía service_role.
revoke all on rentas.messaging_outbox from public, anon, authenticated;
grant select, insert, update on rentas.messaging_outbox to service_role;

create or replace function rentas.enqueue_messaging_outbox(
  p_property_id uuid, p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = rentas as $$
declare v_id uuid;
begin
  if p_channel not in ('whatsapp', 'email') then raise exception 'invalid outbox channel'; end if;
  insert into rentas.messaging_outbox(property_id, organization_id, channel, event_type, dedupe_key, payload)
  values (p_property_id, p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload)
  on conflict (property_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from rentas.messaging_outbox
    where property_id = p_property_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;

-- Reclama hasta p_limit jobs `channel='email'` pendientes/fallidos con
-- `attempts < 5` -- mismo tope real que domain-citas::MAX_EMAIL_DISPATCH_ATTEMPTS.
create or replace function rentas.claim_email_outbox_batch(p_limit integer default 25)
returns setof rentas.messaging_outbox
language sql security definer set search_path = rentas as $$
  update rentas.messaging_outbox
  set status = 'processing', attempts = attempts + 1
  where id in (
    select id from rentas.messaging_outbox
    where channel = 'email'
      and status in ('pending', 'failed')
      and attempts < 5
    order by created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
$$;

create or replace function rentas.complete_email_outbox_job(
  p_id uuid, p_status text, p_error text default null
) returns void language plpgsql security definer set search_path = rentas as $$
begin
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update rentas.messaging_outbox
  set status = p_status, last_error = left(p_error, 500)
  where id = p_id and channel = 'email';
end;
$$;

revoke all on function rentas.enqueue_messaging_outbox(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function rentas.claim_email_outbox_batch(integer) from public, anon, authenticated;
revoke all on function rentas.complete_email_outbox_job(uuid, text, text) from public, anon, authenticated;
grant execute on function rentas.enqueue_messaging_outbox(uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function rentas.claim_email_outbox_batch(integer) to service_role;
grant execute on function rentas.complete_email_outbox_job(uuid, text, text) to service_role;
