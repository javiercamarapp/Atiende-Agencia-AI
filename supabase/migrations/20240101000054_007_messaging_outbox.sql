-- restaurantes.messaging_outbox — restaurantes NO traía NINGÚN concepto de
-- outbox (a diferencia de domain-citas, que ya lo tenía desde su Fase 1,
-- migrations/003_waitlist_and_rate_limit.sql): `outcome.reply` del turn handler de
-- WhatsApp (whatsapp/inbound.ts) solo se guardaba en
-- `whatsapp_conversations.messages`, nunca se encolaba para envío real. Este
-- archivo agrega la MISMA tabla/funciones que citas (mismo shape de fila,
-- claim-con-lease-reclamable), partición por `organization_id` — igual eje que el
-- resto de tablas de WhatsApp de este dominio.
--
-- El envío real vía Graph API vive en @atiende/whatsapp-gateway (TS) — este
-- archivo solo resuelve encolar/reclamar/cerrar filas.

create table restaurantes.messaging_outbox (
  id uuid primary key default gen_random_uuid(),
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
  last_error_class text check (last_error_class is null or length(last_error_class) <= 120),
  created_at timestamptz not null default now(),
  unique (organization_id, channel, dedupe_key)
);
create index messaging_outbox_claim_idx
  on restaurantes.messaging_outbox (channel, status, next_attempt_at)
  where status in ('pending', 'processing');
alter table restaurantes.messaging_outbox enable row level security;
revoke all on restaurantes.messaging_outbox from public, anon, authenticated;
grant select, insert, update on restaurantes.messaging_outbox to service_role;

create or replace function restaurantes.enqueue_messaging_outbox(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = restaurantes as $$
declare v_id uuid;
begin
  if p_channel not in ('whatsapp', 'email') then raise exception 'invalid outbox channel'; end if;
  insert into restaurantes.messaging_outbox(organization_id, channel, event_type, dedupe_key, payload)
  values (p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload)
  on conflict (organization_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from restaurantes.messaging_outbox
    where organization_id = p_organization_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;

-- Reclama hasta p_limit mensajes de WhatsApp pendientes de envío, atómico vía
-- FOR UPDATE SKIP LOCKED — mismo idioma que citas.claim_messaging_outbox_batch.
create or replace function restaurantes.claim_messaging_outbox_batch(
  p_limit integer, p_lease_seconds integer default 120
) returns setof restaurantes.messaging_outbox
language plpgsql security definer set search_path = restaurantes as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'invalid claim limit'; end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid lease seconds'; end if;

  return query
    update restaurantes.messaging_outbox
    set status = 'processing', claimed_at = now()
    where id in (
      select id from restaurantes.messaging_outbox
      where channel = 'whatsapp'
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and claimed_at < now() - make_interval(secs => p_lease_seconds))
        )
      order by created_at
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

create or replace function restaurantes.complete_messaging_outbox_sent(p_id uuid) returns void
language plpgsql security definer set search_path = restaurantes as $$
begin
  update restaurantes.messaging_outbox set status = 'sent', sent_at = now()
  where id = p_id and status = 'processing';
end;
$$;

create or replace function restaurantes.complete_messaging_outbox_retry(
  p_id uuid, p_attempts integer, p_error_class text, p_next_attempt_at timestamptz
) returns void
language plpgsql security definer set search_path = restaurantes as $$
begin
  update restaurantes.messaging_outbox
  set status = 'pending', attempts = p_attempts, last_error_class = left(p_error_class, 120), next_attempt_at = p_next_attempt_at, claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

create or replace function restaurantes.complete_messaging_outbox_dead(
  p_id uuid, p_attempts integer, p_error_class text
) returns void
language plpgsql security definer set search_path = restaurantes as $$
begin
  update restaurantes.messaging_outbox
  set status = 'dead', attempts = p_attempts, last_error_class = left(p_error_class, 120), claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

revoke all on function restaurantes.enqueue_messaging_outbox(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function restaurantes.claim_messaging_outbox_batch(integer, integer) from public, anon, authenticated;
revoke all on function restaurantes.complete_messaging_outbox_sent(uuid) from public, anon, authenticated;
revoke all on function restaurantes.complete_messaging_outbox_retry(uuid, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function restaurantes.complete_messaging_outbox_dead(uuid, integer, text) from public, anon, authenticated;
grant execute on function restaurantes.enqueue_messaging_outbox(uuid, text, text, text, jsonb) to service_role;
grant execute on function restaurantes.claim_messaging_outbox_batch(integer, integer) to service_role;
grant execute on function restaurantes.complete_messaging_outbox_sent(uuid) to service_role;
grant execute on function restaurantes.complete_messaging_outbox_retry(uuid, integer, text, timestamptz) to service_role;
grant execute on function restaurantes.complete_messaging_outbox_dead(uuid, integer, text) to service_role;
