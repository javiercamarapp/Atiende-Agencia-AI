-- Port de: appointment_waitlist + claim_waitlist_notification_slot
-- (20260908050000_vertical_config_and_agenda_agents.sql), api_rate_limits +
-- consume_api_rate_limit (20260908010000_appointment_engine.sql), y las piezas
-- mínimas de canal WhatsApp que el Flujo 3 (recordatorio) necesita:
-- tenant_whatsapp_config -> citas.whatsapp_config, messaging_outbox ->
-- citas.messaging_outbox + enqueue_messaging_outbox (20260908020000_whatsapp_channel.sql).
--
-- Fuera de alcance de Fase 1 (ver diseño §6): el dispatcher que drena
-- messaging_outbox hacia Graph API real (claim_messaging_outbox_batch/
-- complete_messaging_outbox) — aquí solo se porta ENCOLAR, suficiente para que los 3
-- flujos elegidos completen su pipeline sin bloquear la respuesta al caller.

-- ============================================================================
-- citas.whatsapp_config — mínimo real que resolveActiveWhatsAppPhoneNumberId
-- necesita (qué número de WhatsApp Business real usa este negocio).
-- ============================================================================

create table citas.whatsapp_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  phone_number_id text not null unique check (length(phone_number_id) between 1 and 40),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table citas.whatsapp_config enable row level security;
create policy "staff gestiona whatsapp_config de su organización" on citas.whatsapp_config for all
  using (exists (select 1 from core.membership m where m.organization_id = whatsapp_config.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = whatsapp_config.organization_id and m.user_id = auth.uid()));
revoke all on citas.whatsapp_config from public, anon;
grant select, insert, update, delete on citas.whatsapp_config to authenticated, service_role;

-- ============================================================================
-- citas.messaging_outbox — efectos externos versionados (envío real de WhatsApp/
-- email). El webhook/ruta responde rápido y encola; un dispatcher (fuera de Fase 1)
-- haría el envío real con reintento/backoff.
-- ============================================================================

create table citas.messaging_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'email')),
  event_type text not null check (length(event_type) between 1 and 80),
  dedupe_key text not null check (length(dedupe_key) between 1 and 255),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed', 'dead')),
  created_at timestamptz not null default now(),
  unique (organization_id, channel, dedupe_key)
);
create index messaging_outbox_dispatch_idx on citas.messaging_outbox (status, created_at);
alter table citas.messaging_outbox enable row level security;
revoke all on citas.messaging_outbox from public, anon, authenticated;
grant select, insert, update on citas.messaging_outbox to service_role;

create or replace function citas.enqueue_messaging_outbox(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = citas as $$
declare v_id uuid;
begin
  if p_channel not in ('whatsapp', 'email') then raise exception 'invalid outbox channel'; end if;
  insert into citas.messaging_outbox(organization_id, channel, event_type, dedupe_key, payload)
  values (p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload)
  on conflict (organization_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from citas.messaging_outbox
    where organization_id = p_organization_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;

revoke all on function citas.enqueue_messaging_outbox(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function citas.enqueue_messaging_outbox(uuid, text, text, text, jsonb) to service_role;

-- ============================================================================
-- appointment_waitlist — lista de espera real con preferencias estructuradas.
-- `preferred_*` en null significa "sin preferencia, cualquiera me sirve".
-- ============================================================================

create table citas.appointment_waitlist (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_phone text not null check (length(customer_phone) between 1 and 64),
  customer_name text,
  service_id uuid references citas.services(id) on delete set null,
  provider_id uuid references citas.providers(id) on delete set null,
  preferred_date_from date,
  preferred_date_to date check (
    preferred_date_from is null or preferred_date_to is null or preferred_date_to >= preferred_date_from
  ),
  preferred_time_window text not null default 'any'
    check (preferred_time_window in ('morning', 'afternoon', 'evening', 'any')),
  status text not null default 'active'
    check (status in ('active', 'notified', 'fulfilled', 'cancelled', 'expired')),
  notified_count integer not null default 0 check (notified_count >= 0),
  last_notified_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index appointment_waitlist_org_active_idx
  on citas.appointment_waitlist (organization_id, created_at)
  where status = 'active';

alter table citas.appointment_waitlist enable row level security;
create policy "staff gestiona lista de espera de su organización" on citas.appointment_waitlist for all
  using (exists (select 1 from core.membership m where m.organization_id = appointment_waitlist.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = appointment_waitlist.organization_id and m.user_id = auth.uid()));
revoke all on citas.appointment_waitlist from public, anon;
grant select, insert, update, delete on citas.appointment_waitlist to authenticated, service_role;

-- Incremento atómico con tope — rate-limit real de "máximo N notificaciones por
-- cliente" a nivel de base de datos, nunca una condición de carrera
-- leída-luego-escrita desde la aplicación. NUNCA cambia `status` a 'notified' (ver
-- comentario real del origen: eso rompería la 2ª/3ª notificación dentro del tope).
create or replace function citas.claim_waitlist_notification_slot(
  p_waitlist_id uuid,
  p_max_notifications integer default 3
) returns citas.appointment_waitlist
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_row citas.appointment_waitlist;
begin
  if p_waitlist_id is null or p_max_notifications < 1 then
    return null;
  end if;

  update citas.appointment_waitlist
  set notified_count = notified_count + 1,
      last_notified_at = now()
  where id = p_waitlist_id
    and status = 'active'
    and notified_count < p_max_notifications
  returning * into v_row;

  return v_row; -- null si ya no estaba 'active' o ya llegó al tope
end;
$$;

revoke all on function citas.claim_waitlist_notification_slot(uuid, integer) from public, anon, authenticated;
grant execute on function citas.claim_waitlist_notification_slot(uuid, integer) to service_role;

-- ============================================================================
-- Rate limiting real por scope+actor (mismo contrato que
-- domain-restaurantes/domain-hoteles) — usado por las rutas de este vertical que
-- reciben tráfico del agente de voz/WhatsApp sin JWT.
-- ============================================================================

create table citas.api_rate_limits (
  scope text not null check (length(scope) between 1 and 120),
  actor_hash text not null check (actor_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (scope, actor_hash)
);
alter table citas.api_rate_limits enable row level security;
revoke all on citas.api_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on citas.api_rate_limits to service_role;

create or replace function citas.consume_api_rate_limit(
  p_scope text, p_actor_hash text, p_max_requests integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = citas as $$
declare v_allowed boolean;
begin
  if p_scope is null or p_actor_hash is null or p_max_requests < 1 or p_window_seconds < 1 then return false; end if;
  if length(p_scope) not between 1 and 120 or p_actor_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  if random() < 0.01 then
    delete from citas.api_rate_limits where window_started_at < now() - interval '7 days';
  end if;
  insert into citas.api_rate_limits(scope, actor_hash, window_started_at, request_count)
  values (p_scope, p_actor_hash, now(), 1)
  on conflict (scope, actor_hash) do update set
    request_count = case when now() - api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then 1 else api_rate_limits.request_count + 1 end,
    window_started_at = case when now() - api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then now() else api_rate_limits.window_started_at end
  returning request_count <= p_max_requests into v_allowed;
  return coalesce(v_allowed, false);
end; $$;
revoke all on function citas.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function citas.consume_api_rate_limit(text, text, integer, integer) to service_role;
