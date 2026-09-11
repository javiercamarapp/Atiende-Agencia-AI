-- Ported de restaurantes/supabase/migrations/20260902020000_whatsapp_conversations.sql,
-- 20260904054000_whatsapp_inbound_delivery.sql y 20260904052000_api_rate_limits.sql.
-- Cambia únicamente: schema `public.*` -> `restaurantes.*`, `restaurant_id` ->
-- `organization_id`. La plomería determinista (append atómico vía `messages ||
-- nuevos` con row lock de Postgres, dedupe de mensaje at-least-once, lease de
-- conversación, rate limiting por scope+actor_hash) NO se rediseña — ya está resuelta
-- correctamente en el origen.

create or replace function restaurantes.whatsapp_append_turn(
  p_organization_id uuid,
  p_phone text,
  p_new_messages jsonb,
  p_status text default null,
  p_order_id uuid default null,
  p_property_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_messages jsonb;
begin
  if p_phone is null or btrim(p_phone) = '' or jsonb_typeof(p_new_messages) <> 'array' then
    raise exception 'invalid whatsapp turn';
  end if;

  insert into restaurantes.whatsapp_conversations (
    organization_id, phone, messages, status, order_id, property_id
  )
  values (
    p_organization_id,
    p_phone,
    p_new_messages,
    coalesce(p_status, 'active'),
    p_order_id,
    p_property_id
  )
  on conflict (organization_id, phone) do update
  set messages = whatsapp_conversations.messages || excluded.messages,
      status = coalesce(p_status, whatsapp_conversations.status),
      order_id = coalesce(p_order_id, whatsapp_conversations.order_id),
      property_id = coalesce(p_property_id, whatsapp_conversations.property_id),
      updated_at = now()
  returning messages into v_messages;

  return v_messages;
end;
$$;

-- append_whatsapp_user_message_once: variante de whatsapp_append_turn dedicada al
-- mensaje del usuario entrante — se llama primero (así queda a salvo aunque el turn
-- handler tarde o falle), antes de generar la respuesta.
create or replace function restaurantes.append_whatsapp_user_message_once(
  p_organization_id uuid,
  p_message_id text,
  p_phone text,
  p_new_message jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes
as $$
begin
  return restaurantes.whatsapp_append_turn(p_organization_id, p_phone, jsonb_build_array(p_new_message));
end;
$$;

create table if not exists restaurantes.whatsapp_inbound_events (
  message_id text primary key check (length(message_id) between 1 and 255),
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  claimed_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_class text check (last_error_class is null or length(last_error_class) <= 120)
);

create or replace function restaurantes.claim_whatsapp_message(
  p_organization_id uuid,
  p_message_id text,
  p_phone_hash text
) returns boolean
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_count integer;
begin
  if p_message_id is null or length(p_message_id) not between 1 and 255 or p_phone_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into restaurantes.whatsapp_inbound_events(message_id, organization_id, phone_hash)
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

create or replace function restaurantes.claim_whatsapp_conversation(
  p_organization_id uuid,
  p_phone_hash text,
  p_message_id text,
  p_lease_seconds integer default 120
) returns boolean
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_count integer;
begin
  if p_phone_hash !~ '^[0-9a-f]{64}$' or length(p_message_id) not between 1 and 255 or p_lease_seconds not between 1 and 300 then
    return false;
  end if;
  insert into restaurantes.whatsapp_conversation_leases(organization_id, phone_hash, owner_message_id, locked_until)
  values (p_organization_id, p_phone_hash, p_message_id, now() + make_interval(secs => p_lease_seconds))
  on conflict (organization_id, phone_hash) do update
    set owner_message_id = excluded.owner_message_id,
        locked_until = excluded.locked_until
  where whatsapp_conversation_leases.locked_until < now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function restaurantes.finish_whatsapp_message(
  p_organization_id uuid,
  p_message_id text,
  p_phone_hash text,
  p_status text,
  p_error_class text default null
) returns void
language plpgsql
security definer
set search_path = restaurantes
as $$
begin
  if p_status not in ('processed', 'failed') then raise exception 'invalid status'; end if;
  update restaurantes.whatsapp_inbound_events
  set status = p_status,
      processed_at = case when p_status = 'processed' then now() else null end,
      last_error_class = left(p_error_class, 120)
  where message_id = p_message_id and organization_id = p_organization_id and phone_hash = p_phone_hash;
  delete from restaurantes.whatsapp_conversation_leases
  where organization_id = p_organization_id and phone_hash = p_phone_hash and owner_message_id = p_message_id;
end;
$$;

revoke all on function restaurantes.claim_whatsapp_message(uuid, text, text) from public, anon, authenticated;
revoke all on function restaurantes.claim_whatsapp_conversation(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function restaurantes.finish_whatsapp_message(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function restaurantes.whatsapp_append_turn(uuid, text, jsonb, text, uuid, uuid) from public, anon, authenticated;
revoke all on function restaurantes.append_whatsapp_user_message_once(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function restaurantes.claim_whatsapp_message(uuid, text, text) to service_role;
grant execute on function restaurantes.claim_whatsapp_conversation(uuid, text, text, integer) to service_role;
grant execute on function restaurantes.finish_whatsapp_message(uuid, text, text, text, text) to service_role;
grant execute on function restaurantes.whatsapp_append_turn(uuid, text, jsonb, text, uuid, uuid) to service_role;
grant execute on function restaurantes.append_whatsapp_user_message_once(uuid, text, text, jsonb) to service_role;

create or replace function restaurantes.consume_api_rate_limit(
  p_scope text, p_actor_hash text, p_max_requests integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = restaurantes as $$
declare v_allowed boolean;
begin
  if p_scope is null or p_actor_hash is null or p_max_requests < 1 or p_window_seconds < 1 then return false; end if;
  if length(p_scope) not between 1 and 120 or p_actor_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  if random() < 0.01 then
    delete from restaurantes.api_rate_limits where window_started_at < now() - interval '7 days';
  end if;
  insert into restaurantes.api_rate_limits(scope, actor_hash, window_started_at, request_count)
  values (p_scope, p_actor_hash, now(), 1)
  on conflict (scope, actor_hash) do update set
    request_count = case when now() - api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then 1 else api_rate_limits.request_count + 1 end,
    window_started_at = case when now() - api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then now() else api_rate_limits.window_started_at end
  returning request_count <= p_max_requests into v_allowed;
  return coalesce(v_allowed, false);
end; $$;
revoke all on function restaurantes.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function restaurantes.consume_api_rate_limit(text, text, integer, integer) to service_role;
