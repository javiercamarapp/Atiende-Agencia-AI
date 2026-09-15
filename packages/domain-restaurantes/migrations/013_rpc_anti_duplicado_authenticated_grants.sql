-- Hallazgo de auditoría (severidad CRÍTICA/ALTA, "21 RPC anti-duplicado sin GRANT
-- EXECUTE para authenticated en citas/hoteles/restaurantes") -- misma causa raíz y
-- mismo remedio que
-- `packages/domain-citas/migrations/015_rpc_anti_duplicado_authenticated_grants.sql`
-- (ver su cabecera para el detalle completo) aplicado a las 7 funciones
-- equivalentes de restaurantes: las 6 de WhatsApp/rate-limit
-- (`004_whatsapp_atomic_append_and_rate_limit.sql`) + `create_order_idempotent`
-- (`003_create_order_idempotent.sql`, redefinida sin cambiar GRANTs en
-- `011_email_outbox_dispatch.sql`) -- las 7 son `security definer` con
-- `revoke all ... from ... authenticated; grant execute ... to service_role;` y
-- SIN GRANT a `authenticated` de vuelta.
--
-- Verificado con `grep -rn` sobre `apps/api/src/routes/verticals/restaurantes`:
-- `public.ts::POST .../orders` (create_order_idempotent, también desde
-- `whatsapp/llm-turn-handler.ts` vía el agente), `whatsapp.ts`, `voice-tools.ts`
-- SIEMPRE abren `deps.engine.withAppSession({ userId: null }, ...)` -- checkout
-- web anónimo, webhook de WhatsApp y tools del agente de voz, ninguno con
-- `authMiddleware`/`auth.uid()` real. Mismo criterio que citas/hoteles: la
-- verificación interna repuesta es "auth.uid() is null" a secas.

create or replace function restaurantes.create_order_idempotent(
  p_order jsonb,
  p_dedupe_fingerprint text,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_order restaurantes.orders;
  v_organization_id uuid := (p_order->>'organization_id')::uuid;
  v_customer_id uuid := (p_order->>'customer_id')::uuid;
begin
  if auth.uid() is not null then
    raise exception 'create_order_idempotent es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_dedupe_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid idempotency input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_organization_id::text || ':' || coalesce(p_idempotency_key, p_dedupe_fingerprint),
    0
  ));

  if p_idempotency_key is not null then
    select * into v_order from restaurantes.orders
    where organization_id = v_organization_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_order.id is not null and v_order.dedupe_fingerprint is distinct from p_dedupe_fingerprint then
      raise sqlstate 'PT409' using message = 'idempotency key was already used with a different order payload';
    end if;
  else
    select * into v_order from restaurantes.orders
    where organization_id = v_organization_id
      and dedupe_fingerprint = p_dedupe_fingerprint
      and status = 'pending'
      and created_at >= now() - interval '5 minutes'
    order by created_at desc
    limit 1;
  end if;

  if v_order.id is not null then return to_jsonb(v_order); end if;

  insert into restaurantes.orders(
    customer_name, customer_phone, customer_address, customer_email, customer_id,
    organization_id, branch, property_id, total, status, items, source,
    call_transcript, call_recording_url, notes, payment_method,
    dedupe_fingerprint, idempotency_key
  ) values (
    p_order->>'customer_name', p_order->>'customer_phone', nullif(p_order->>'customer_address', ''), nullif(p_order->>'customer_email', ''), v_customer_id,
    v_organization_id, p_order->>'branch', (p_order->>'property_id')::uuid,
    (p_order->>'total')::numeric, 'pending', p_order->'items', p_order->>'source',
    nullif(p_order->>'call_transcript', ''), nullif(p_order->>'call_recording_url', ''),
    nullif(p_order->>'notes', ''), nullif(p_order->>'payment_method', ''),
    p_dedupe_fingerprint, p_idempotency_key
  ) returning * into v_order;

  update restaurantes.customers
  set order_count = order_count + 1, last_order_at = now()
  where id = v_customer_id and organization_id = v_organization_id;

  return to_jsonb(v_order);
end;
$$;

grant execute on function restaurantes.create_order_idempotent(jsonb, text, text) to authenticated;

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
  if auth.uid() is not null then
    raise exception 'whatsapp_append_turn es solo para la sesión de sistema' using errcode = '42501';
  end if;

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

grant execute on function restaurantes.whatsapp_append_turn(uuid, text, jsonb, text, uuid, uuid) to authenticated;

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
  if auth.uid() is not null then
    raise exception 'append_whatsapp_user_message_once es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return restaurantes.whatsapp_append_turn(p_organization_id, p_phone, jsonb_build_array(p_new_message));
end;
$$;

grant execute on function restaurantes.append_whatsapp_user_message_once(uuid, text, text, jsonb) to authenticated;

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
  if auth.uid() is not null then
    raise exception 'claim_whatsapp_message es solo para la sesión de sistema' using errcode = '42501';
  end if;

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

grant execute on function restaurantes.claim_whatsapp_message(uuid, text, text) to authenticated;

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
  if auth.uid() is not null then
    raise exception 'claim_whatsapp_conversation es solo para la sesión de sistema' using errcode = '42501';
  end if;

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

grant execute on function restaurantes.claim_whatsapp_conversation(uuid, text, text, integer) to authenticated;

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
  if auth.uid() is not null then
    raise exception 'finish_whatsapp_message es solo para la sesión de sistema' using errcode = '42501';
  end if;

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

grant execute on function restaurantes.finish_whatsapp_message(uuid, text, text, text, text) to authenticated;

create or replace function restaurantes.consume_api_rate_limit(
  p_scope text, p_actor_hash text, p_max_requests integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = restaurantes as $$
declare v_allowed boolean;
begin
  if auth.uid() is not null then
    raise exception 'consume_api_rate_limit es solo para la sesión de sistema' using errcode = '42501';
  end if;

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

grant execute on function restaurantes.consume_api_rate_limit(text, text, integer, integer) to authenticated;
