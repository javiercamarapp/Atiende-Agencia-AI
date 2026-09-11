-- Fase 2 hoteles (diseño §1-§3) — Server Tools de voz (ElevenLabs) + agente de
-- WhatsApp con LLM real. Ningún dominio de voz/WhatsApp existía en Fase 1 (a
-- diferencia de restaurantes, que ya traía whatsapp_conversations/
-- whatsapp_channel_config/api_rate_limits desde su propia Fase 1) — todo lo de
-- este archivo es superficie nueva, mismas formas que
-- domain-restaurantes/migrations/001_restaurantes_schema.sql +
-- 004_whatsapp_atomic_append_and_rate_limit.sql, adaptadas a hoteles.
--
-- Catálogo reducido a propósito (diseño §5.2): solo 2 tools comparten voz y
-- WhatsApp — crear_ticket_huesped_fnb (reutiliza hoteles.fnb_order, REQ-AB-004
-- sin excepción) y registrar_contacto_no_operativo. `registrar_evento_roi` y
-- las tools de housekeeping/mantenimiento/plantillas de WhatsApp del origen NO
-- se portan en esta fase — no tienen dominio construido en atiende-fusion.

-- ---------------------------------------------------------------------------
-- Secreto de voz POR PROPERTY (diseño §1/§5.1) — divergencia deliberada del
-- patrón de secreto compartido de plataforma que usa restaurantes: el origen
-- real de hoteles trata el aislamiento por tenant como el eje de seguridad
-- central de este vertical (`hotel_voice_agent_config`, rotable, con
-- `enabled`). Nunca se guarda en texto plano en logs de aplicación — mismo
-- criterio que cualquier secreto de integración.
-- ---------------------------------------------------------------------------
create table hoteles.voice_agent_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  tool_webhook_secret text not null check (length(tool_webhook_secret) between 16 and 200),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- WhatsApp — canal por PROPERTY (no por organización, a diferencia de
-- restaurantes): un número real de Meta Cloud API atiende UNA property, así
-- que el agente nunca necesita resolver "sucursal más cercana" (diseño §2.2).
-- ---------------------------------------------------------------------------
create table hoteles.whatsapp_channel_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone_number_id text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table hoteles.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  phone text not null,
  messages jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  fnb_order_id uuid references hoteles.fnb_order(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, phone)
);

-- Dedupe de entrega at-least-once de Meta, por message_id — port literal del
-- mecanismo de restaurantes.
create table hoteles.whatsapp_inbound_events (
  message_id text primary key check (length(message_id) between 1 and 255),
  property_id uuid not null references core.property(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  claimed_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_class text check (last_error_class is null or length(last_error_class) <= 120)
);

-- Lease de 120s para serializar mensajes casi-simultáneos del mismo teléfono.
create table hoteles.whatsapp_conversation_leases (
  property_id uuid not null references core.property(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  owner_message_id text not null check (length(owner_message_id) between 1 and 255),
  locked_until timestamptz not null,
  primary key (property_id, phone_hash)
);

-- Rate limiting genérico (scope+actor_hash) — segunda copia real del mismo
-- mecanismo que restaurantes.api_rate_limits (diseño §4: flag explícita de
-- duplicación aceptada por ahora, candidata a promoción a paquete compartido
-- cuando una tercera vertical lo necesite igual).
create table hoteles.api_rate_limits (
  scope text not null check (length(scope) between 1 and 120),
  actor_hash text not null check (actor_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (scope, actor_hash)
);

-- `registrar_contacto_no_operativo` (voz + WhatsApp) — mismo rol que
-- restaurantes.callback_requests: deriva a un humano cualquier mensaje que NO
-- sea una petición operativa de F&B.
create table hoteles.contacto_no_operativo (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  guest_phone text,
  guest_name text,
  reason text not null check (length(reason) between 1 and 500),
  message text,
  source text not null check (source in ('voice', 'whatsapp')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Funciones atómicas — port literal de
-- domain-restaurantes/migrations/004_whatsapp_atomic_append_and_rate_limit.sql,
-- solo cambia `organization_id` -> `property_id` como clave de partición (ver
-- comentario arriba: 1 número = 1 property en hoteles).
-- ---------------------------------------------------------------------------
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
  return hoteles.whatsapp_append_turn(p_property_id, p_organization_id, p_phone, jsonb_build_array(p_new_message));
end;
$$;

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

create or replace function hoteles.consume_api_rate_limit(
  p_scope text, p_actor_hash text, p_max_requests integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = hoteles as $$
declare v_allowed boolean;
begin
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

revoke all on function hoteles.claim_whatsapp_message(uuid, text, text) from public, anon, authenticated;
revoke all on function hoteles.claim_whatsapp_conversation(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function hoteles.finish_whatsapp_message(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function hoteles.whatsapp_append_turn(uuid, uuid, text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function hoteles.append_whatsapp_user_message_once(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function hoteles.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function hoteles.claim_whatsapp_message(uuid, text, text) to service_role;
grant execute on function hoteles.claim_whatsapp_conversation(uuid, text, text, integer) to service_role;
grant execute on function hoteles.finish_whatsapp_message(uuid, text, text, text, text) to service_role;
grant execute on function hoteles.whatsapp_append_turn(uuid, uuid, text, jsonb, text, uuid) to service_role;
grant execute on function hoteles.append_whatsapp_user_message_once(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function hoteles.consume_api_rate_limit(text, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- RLS — staff de la property puede LEER su config/conversaciones/contactos;
-- las escrituras de los canales sin sesión de staff (voz/WhatsApp) corren bajo
-- `service_role` (mismas rutas HTTP sin `authMiddleware`, ver diseño §1/§2.2),
-- igual criterio que restaurantes documenta para sus tablas de sistema.
-- Rotar el secreto de voz SÍ requiere sesión de staff ADMIN (owner/gm) — se
-- filtra en la capa de aplicación (`assertVerticalRole(ADMIN_ROLES)`), la RLS
-- aquí solo exige pertenecer a la property.
-- ---------------------------------------------------------------------------
alter table hoteles.voice_agent_config enable row level security;
alter table hoteles.whatsapp_channel_config enable row level security;
alter table hoteles.whatsapp_conversations enable row level security;
alter table hoteles.whatsapp_inbound_events enable row level security;
alter table hoteles.whatsapp_conversation_leases enable row level security;
alter table hoteles.api_rate_limits enable row level security;
alter table hoteles.contacto_no_operativo enable row level security;

create policy "staff admin ve/gestiona el secreto de voz de su property" on hoteles.voice_agent_config for all
  using (core.has_property_access(auth.uid(), property_id))
  with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve la config de whatsapp de su property" on hoteles.whatsapp_channel_config for select
  using (core.has_property_access(auth.uid(), property_id));

create policy "staff ve conversaciones de whatsapp de su property" on hoteles.whatsapp_conversations for select
  using (core.has_property_access(auth.uid(), property_id));

create policy "staff ve contactos no operativos de su property" on hoteles.contacto_no_operativo for select
  using (core.has_property_access(auth.uid(), property_id));

revoke all on hoteles.voice_agent_config, hoteles.whatsapp_channel_config, hoteles.whatsapp_conversations,
  hoteles.whatsapp_inbound_events, hoteles.whatsapp_conversation_leases, hoteles.api_rate_limits,
  hoteles.contacto_no_operativo
  from public, anon;
grant select, update on hoteles.voice_agent_config to authenticated;
grant select on hoteles.whatsapp_channel_config, hoteles.whatsapp_conversations, hoteles.contacto_no_operativo to authenticated;
grant select, insert, update, delete on hoteles.voice_agent_config, hoteles.whatsapp_channel_config,
  hoteles.whatsapp_conversations, hoteles.whatsapp_inbound_events, hoteles.whatsapp_conversation_leases,
  hoteles.api_rate_limits, hoteles.contacto_no_operativo
  to service_role;
