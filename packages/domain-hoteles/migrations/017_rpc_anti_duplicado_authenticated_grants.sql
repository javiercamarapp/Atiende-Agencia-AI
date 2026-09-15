-- Hallazgo de auditoría (severidad CRÍTICA/ALTA, "21 RPC anti-duplicado sin GRANT
-- EXECUTE para authenticated en citas/hoteles/restaurantes") -- misma causa raíz y
-- mismo remedio que
-- `packages/domain-citas/migrations/015_rpc_anti_duplicado_authenticated_grants.sql`
-- (ver su cabecera para el detalle completo: `withAppSession` SIEMPRE conecta como
-- `authenticated`, `service_role` nunca se aprovisiona contra Postgres real) --
-- aplicado a las 6 funciones equivalentes de hoteles (todas creadas en
-- `004_voz_whatsapp_fase2.sql`, todas `security definer`, todas con
-- `revoke all ... from ... authenticated; grant execute ... to service_role;` y
-- SIN GRANT a `authenticated` de vuelta).
--
-- Verificado con `grep -rn` sobre `apps/api/src/routes/verticals/hoteles`: las 6
-- SOLO se llaman desde `whatsapp.ts`/`voice-tools.ts`, siempre dentro de
-- `deps.engine.withAppSession({ userId: null }, ...)` -- el webhook de WhatsApp y
-- las rutas del agente de voz (guardadas por `x-atiende-tool-secret`, nunca por
-- `authMiddleware`) -- ninguna ruta de staff real (JWT) las invoca. Mismo criterio
-- que la migración 015 de citas: la verificación interna repuesta es
-- "auth.uid() is null" a secas.

create or replace function hoteles.whatsapp_append_turn(
  p_property_id uuid,
  p_organization_id uuid,
  p_phone text,
  p_new_messages jsonb,
  p_status text default null,
  p_fnb_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = hoteles
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

  insert into hoteles.whatsapp_conversations (
    organization_id, property_id, phone, messages, status, fnb_order_id
  )
  values (
    p_organization_id,
    p_property_id,
    p_phone,
    p_new_messages,
    coalesce(p_status, 'active'),
    p_fnb_order_id
  )
  on conflict (property_id, phone) do update
  set messages = whatsapp_conversations.messages || excluded.messages,
      status = coalesce(p_status, whatsapp_conversations.status),
      fnb_order_id = coalesce(p_fnb_order_id, whatsapp_conversations.fnb_order_id),
      updated_at = now()
  returning messages into v_messages;

  return v_messages;
end;
$$;

grant execute on function hoteles.whatsapp_append_turn(uuid, uuid, text, jsonb, text, uuid) to authenticated;

create or replace function hoteles.append_whatsapp_user_message_once(
  p_property_id uuid,
  p_organization_id uuid,
  p_message_id text,
  p_phone text,
  p_new_message jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = hoteles
as $$
begin
  if auth.uid() is not null then
    raise exception 'append_whatsapp_user_message_once es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return hoteles.whatsapp_append_turn(p_property_id, p_organization_id, p_phone, jsonb_build_array(p_new_message));
end;
$$;

grant execute on function hoteles.append_whatsapp_user_message_once(uuid, uuid, text, text, jsonb) to authenticated;

create or replace function hoteles.claim_whatsapp_message(
  p_property_id uuid,
  p_message_id text,
  p_phone_hash text
) returns boolean
language plpgsql
security definer
set search_path = hoteles
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

  insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash)
  values (p_message_id, p_property_id, p_phone_hash)
  on conflict (message_id) do update
    set status = 'processing',
        attempts = whatsapp_inbound_events.attempts + 1,
        claimed_at = now(),
        last_error_class = null
  where whatsapp_inbound_events.property_id = excluded.property_id
    and (
      whatsapp_inbound_events.status = 'failed'
      or (whatsapp_inbound_events.status = 'processing' and whatsapp_inbound_events.claimed_at < now() - interval '5 minutes')
    );
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

grant execute on function hoteles.claim_whatsapp_message(uuid, text, text) to authenticated;

create or replace function hoteles.claim_whatsapp_conversation(
  p_property_id uuid,
  p_phone_hash text,
  p_message_id text,
  p_lease_seconds integer default 120
) returns boolean
language plpgsql
security definer
set search_path = hoteles
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
  insert into hoteles.whatsapp_conversation_leases(property_id, phone_hash, owner_message_id, locked_until)
  values (p_property_id, p_phone_hash, p_message_id, now() + make_interval(secs => p_lease_seconds))
  on conflict (property_id, phone_hash) do update
    set owner_message_id = excluded.owner_message_id,
        locked_until = excluded.locked_until
  where whatsapp_conversation_leases.locked_until < now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

grant execute on function hoteles.claim_whatsapp_conversation(uuid, text, text, integer) to authenticated;

create or replace function hoteles.finish_whatsapp_message(
  p_property_id uuid,
  p_message_id text,
  p_phone_hash text,
  p_status text,
  p_error_class text default null
) returns void
language plpgsql
security definer
set search_path = hoteles
as $$
begin
  if auth.uid() is not null then
    raise exception 'finish_whatsapp_message es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_status not in ('processed', 'failed') then raise exception 'invalid status'; end if;
  update hoteles.whatsapp_inbound_events
  set status = p_status,
      processed_at = case when p_status = 'processed' then now() else null end,
      last_error_class = left(p_error_class, 120)
  where message_id = p_message_id and property_id = p_property_id and phone_hash = p_phone_hash;
  delete from hoteles.whatsapp_conversation_leases
  where property_id = p_property_id and phone_hash = p_phone_hash and owner_message_id = p_message_id;
end;
$$;

grant execute on function hoteles.finish_whatsapp_message(uuid, text, text, text, text) to authenticated;

create or replace function hoteles.consume_api_rate_limit(
  p_scope text, p_actor_hash text, p_max_requests integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = hoteles as $$
declare v_allowed boolean;
begin
  if auth.uid() is not null then
    raise exception 'consume_api_rate_limit es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_scope is null or p_actor_hash is null or p_max_requests < 1 or p_window_seconds < 1 then return false; end if;
  if length(p_scope) not between 1 and 120 or p_actor_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  if random() < 0.01 then
    delete from hoteles.api_rate_limits where window_started_at < now() - interval '7 days';
  end if;
  insert into hoteles.api_rate_limits(scope, actor_hash, window_started_at, request_count)
  values (p_scope, p_actor_hash, now(), 1)
  on conflict (scope, actor_hash) do update set
    request_count = case when now() - api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then 1 else api_rate_limits.request_count + 1 end,
    window_started_at = case when now() - api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then now() else api_rate_limits.window_started_at end
  returning request_count <= p_max_requests into v_allowed;
  return coalesce(v_allowed, false);
end; $$;

grant execute on function hoteles.consume_api_rate_limit(text, text, integer, integer) to authenticated;
