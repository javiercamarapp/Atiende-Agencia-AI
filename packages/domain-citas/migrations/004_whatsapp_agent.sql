-- Fase 2 §2.6 — plomería mínima de WhatsApp que Fase 1 de citas NO construyó
-- (a diferencia de restaurantes/hoteles, que ya traían el seam de WhatsApp listo
-- desde su Fase 1). Port literal de
-- domain-restaurantes/migrations/004_whatsapp_atomic_append_and_rate_limit.sql,
-- con una diferencia deliberada: NO se porta `whatsapp_conversation_leases` ni
-- `claim_whatsapp_conversation` — la serialización de mensajes casi-simultáneos
-- del mismo teléfono se resuelve con @atiende/core-conversation::withConversationLock
-- (ver diseño Fase 2 §2.6-b y packages/domain-citas/src/whatsapp/inbound.ts), no
-- con un tercer motor de lock bespoke por vertical. `citas.consume_api_rate_limit`
-- ya existe desde 003_waitlist_and_rate_limit.sql — no se repite aquí.

create table citas.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone text not null,
  property_id uuid references core.property(id),
  messages jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  appointment_id uuid references citas.appointments(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, phone)
);

-- Dedupe de entrega at-least-once de Meta, por message_id.
create table citas.whatsapp_inbound_events (
  message_id text primary key check (length(message_id) between 1 and 255),
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  claimed_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_class text check (last_error_class is null or length(last_error_class) <= 120)
);

create or replace function citas.whatsapp_append_turn(
  p_organization_id uuid,
  p_phone text,
  p_new_messages jsonb,
  p_status text default null,
  p_appointment_id uuid default null,
  p_property_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_messages jsonb;
begin
  if p_phone is null or btrim(p_phone) = '' or jsonb_typeof(p_new_messages) <> 'array' then
    raise exception 'invalid whatsapp turn';
  end if;

  insert into citas.whatsapp_conversations (
    organization_id, phone, messages, status, appointment_id, property_id
  )
  values (
    p_organization_id,
    p_phone,
    p_new_messages,
    coalesce(p_status, 'active'),
    p_appointment_id,
    p_property_id
  )
  on conflict (organization_id, phone) do update
  set messages = whatsapp_conversations.messages || excluded.messages,
      status = coalesce(p_status, whatsapp_conversations.status),
      appointment_id = coalesce(p_appointment_id, whatsapp_conversations.appointment_id),
      property_id = coalesce(p_property_id, whatsapp_conversations.property_id),
      updated_at = now()
  returning messages into v_messages;

  return v_messages;
end;
$$;

-- append_whatsapp_user_message_once: variante de whatsapp_append_turn dedicada al
-- mensaje del usuario entrante — se llama primero (así queda a salvo aunque el turn
-- handler tarde o falle), antes de generar la respuesta.
create or replace function citas.append_whatsapp_user_message_once(
  p_organization_id uuid,
  p_message_id text,
  p_phone text,
  p_new_message jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
begin
  return citas.whatsapp_append_turn(p_organization_id, p_phone, jsonb_build_array(p_new_message));
end;
$$;

create or replace function citas.claim_whatsapp_message(
  p_organization_id uuid,
  p_message_id text,
  p_phone_hash text
) returns boolean
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_count integer;
begin
  if p_message_id is null or length(p_message_id) not between 1 and 255 or p_phone_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into citas.whatsapp_inbound_events(message_id, organization_id, phone_hash)
  values (p_message_id, p_organization_id, p_phone_hash)
  on conflict (message_id) do update
    set status = 'processing',
        attempts = whatsapp_inbound_events.attempts + 1,
        claimed_at = now(),
        last_error_class = null
  where whatsapp_inbound_events.organization_id = excluded.organization_id
    and (
      whatsapp_inbound_events.status = 'failed'
      or (whatsapp_inbound_events.status = 'processing' and whatsapp_inbound_events.claimed_at < now() - interval '5 minutes')
    );
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function citas.finish_whatsapp_message(
  p_organization_id uuid,
  p_message_id text,
  p_phone_hash text,
  p_status text,
  p_error_class text default null
) returns void
language plpgsql
security definer
set search_path = citas
as $$
begin
  if p_status not in ('processed', 'failed') then raise exception 'invalid status'; end if;
  update citas.whatsapp_inbound_events
  set status = p_status,
      processed_at = case when p_status = 'processed' then now() else null end,
      last_error_class = left(p_error_class, 120)
  where message_id = p_message_id and organization_id = p_organization_id and phone_hash = p_phone_hash;
end;
$$;

revoke all on function citas.claim_whatsapp_message(uuid, text, text) from public, anon, authenticated;
revoke all on function citas.finish_whatsapp_message(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function citas.whatsapp_append_turn(uuid, text, jsonb, text, uuid, uuid) from public, anon, authenticated;
revoke all on function citas.append_whatsapp_user_message_once(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function citas.claim_whatsapp_message(uuid, text, text) to service_role;
grant execute on function citas.finish_whatsapp_message(uuid, text, text, text, text) to service_role;
grant execute on function citas.whatsapp_append_turn(uuid, text, jsonb, text, uuid, uuid) to service_role;
grant execute on function citas.append_whatsapp_user_message_once(uuid, text, text, jsonb) to service_role;

alter table citas.whatsapp_conversations enable row level security;
alter table citas.whatsapp_inbound_events enable row level security;

create policy "staff ve conversaciones de whatsapp de su organización" on citas.whatsapp_conversations for select
  using (exists (select 1 from core.membership m where m.organization_id = whatsapp_conversations.organization_id and m.user_id = auth.uid()));

revoke all on citas.whatsapp_conversations, citas.whatsapp_inbound_events from public, anon;
grant select on citas.whatsapp_conversations to authenticated;
grant select, insert, update, delete on citas.whatsapp_conversations, citas.whatsapp_inbound_events to service_role;
