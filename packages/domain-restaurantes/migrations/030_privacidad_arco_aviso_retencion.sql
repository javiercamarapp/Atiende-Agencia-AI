-- PM PR-9 (restaurantes) -- privacidad antes de usar telefonos reales: derechos ARCO con plazos y
-- bitacora, aviso de privacidad simplificado con evidencia de entrega, consentimiento de
-- grabacion de la llamada y retencion/minimizacion parametrizable de conversaciones y
-- transcripciones. Documentacion operativa, NO asesoria legal: los plazos son una referencia
-- conservadora (dias de CALENDARIO, nunca mas largos que los dias habiles que cita la LFPDPPP
-- vigente); el responsable debe validar su aviso de privacidad y su procedimiento con su
-- asesor juridico. Mismo patron que citas 024_citas_data_rights.sql (PR #220).
--
-- Que agrega (todo NUEVO; nada se aplica al mergear -- el codigo TypeScript degrada con
-- SAVEPOINT ante 42883/42P01/42703):
--   1. restaurantes.data_rights_requests / data_rights_events -- solicitudes ARCO (acceso,
--      rectificacion, cancelacion, oposicion) por WhatsApp o voz, con plazos (20 + 15 dias desde
--      que el titular confirma) y bitacora append-only.
--   2. restaurantes.privacy_config -- parametros por organizacion: responsable, URL del aviso integral, version
--      del aviso, dias de retencion de conversaciones de WhatsApp, dias de retencion de
--      transcripciones de voz y si la grabacion exige consentimiento.
--   3. restaurantes.privacy_notice_deliveries -- evidencia de que el aviso simplificado se entrego
--      (una fila por telefono-hash, canal y version). El telefono se guarda como sha256.
--   4. restaurantes.voice_conversation.recording_consent -- consentimiento de grabacion de la llamada.
--   5. Funciones security definer (todas con search_path fijo y revoke de public/anon).
--
-- Compatibilidad: ninguna columna ni funcion existente cambia de contrato salvo
-- voz_registrar_turno (ver 5f), que SOLO deja de persistir texto cuando no hay consentimiento
-- de grabacion; contra una base sin esta migracion todo sigue como antes.
--
-- Requiere: 0001_core_schema.sql (core.*), 001_restaurantes_schema.sql y 025_voz_config_conversaciones.sql.

-- ---------------------------------------------------------------------------
-- 1) restaurantes.data_rights_requests
-- ---------------------------------------------------------------------------
create table restaurantes.data_rights_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  -- Telefono del titular tal como lo autentica el canal (E.164 normalizado por el caller).
  -- Nunca viene de texto libre del mensaje.
  customer_phone text not null check (char_length(customer_phone) between 1 and 64),
  right_type text not null check (right_type in ('acceso', 'rectificacion', 'cancelacion', 'oposicion')),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'voice')),
  -- Con que se verifico la identidad: el numero que escribe por WhatsApp lo autentica Meta;
  -- el identificador de llamada puede falsearse, asi que el staff debe verificar al titular por
  -- otra via ANTES de responder (el panel lo muestra).
  identity_basis text not null default 'whatsapp_numero' check (identity_basis in ('whatsapp_numero', 'llamada_identificador')),
  status text not null default 'pendiente_confirmacion'
    check (status in ('pendiente_confirmacion', 'recibida', 'en_proceso', 'bloqueada', 'resuelta', 'rechazada', 'cancelada_titular', 'expirada')),
  detail text check (detail is null or char_length(detail) <= 300),
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  response_due_at timestamptz,
  execution_due_at timestamptz,
  resolved_at timestamptz,
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 1000),
  handled_by uuid references core.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  seq bigint generated always as identity,
  constraint restaurantes_data_rights_requests_plazos_check check (
    status in ('pendiente_confirmacion', 'cancelada_titular', 'expirada')
    or (confirmed_at is not null and response_due_at is not null and execution_due_at is not null)
  )
);

create unique index restaurantes_data_rights_requests_open_uniq
  on restaurantes.data_rights_requests (organization_id, customer_phone, right_type)
  where status in ('pendiente_confirmacion', 'recibida', 'en_proceso', 'bloqueada');
create index restaurantes_data_rights_requests_org_created_idx
  on restaurantes.data_rights_requests (organization_id, created_at desc, seq desc);
create index restaurantes_data_rights_requests_org_status_due_idx
  on restaurantes.data_rights_requests (organization_id, status, response_due_at);

alter table restaurantes.data_rights_requests enable row level security;

-- Lectura: SOLO owner/admin de la organizacion (contiene telefonos de titulares).
create policy "owner/admin lee las solicitudes ARCO de su organizacion" on restaurantes.data_rights_requests for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = data_rights_requests.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

-- Sin GRANT de INSERT/UPDATE/DELETE para nadie y sin policy de escritura: toda escritura pasa
-- por las funciones security definer de abajo (deny-by-default). SELECT por COLUMNA explicita:
-- una columna agregada en el futuro NO queda expuesta por accidente.
revoke all on restaurantes.data_rights_requests from public, anon, authenticated, service_role;
grant select (id, organization_id, customer_phone, right_type, channel, identity_basis, status, detail, requested_at, confirmed_at, response_due_at, execution_due_at, resolved_at, resolution_note, handled_by, created_at, updated_at, seq)
  on restaurantes.data_rights_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 2) restaurantes.data_rights_events -- bitacora append-only
-- ---------------------------------------------------------------------------
create table restaurantes.data_rights_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  request_id uuid not null references restaurantes.data_rights_requests(id) on delete restrict,
  actor_user_id uuid references core.staff_user(id) on delete restrict,
  actor_kind text not null check (actor_kind in ('titular', 'sistema', 'staff')),
  event text not null check (event in ('registrada', 'confirmada', 'cancelada_por_titular', 'expirada', 'cambio_estado')),
  from_status text,
  to_status text,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  seq bigint generated always as identity
);
create index restaurantes_data_rights_events_request_idx on restaurantes.data_rights_events (request_id, created_at, seq);
create index restaurantes_data_rights_events_org_idx on restaurantes.data_rights_events (organization_id, created_at desc, seq desc);

alter table restaurantes.data_rights_events enable row level security;

create policy "owner/admin lee la bitacora ARCO de su organizacion" on restaurantes.data_rights_events for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = data_rights_events.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

revoke all on restaurantes.data_rights_events from public, anon, authenticated, service_role;
grant select (id, organization_id, request_id, actor_user_id, actor_kind, event, from_status, to_status, note, created_at, seq)
  on restaurantes.data_rights_events to authenticated;

create or replace function restaurantes.data_rights_events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'restaurantes_data_rights_events_append_only: % no esta permitido sobre restaurantes.data_rights_events', tg_op
    using errcode = '0A000';
end;
$$;

create trigger restaurantes_data_rights_events_block_update_trg
  before update on restaurantes.data_rights_events
  for each row execute function restaurantes.data_rights_events_block_mutation();
create trigger restaurantes_data_rights_events_block_delete_trg
  before delete on restaurantes.data_rights_events
  for each row execute function restaurantes.data_rights_events_block_mutation();

-- ---------------------------------------------------------------------------
-- 3a) restaurantes.system_register_data_rights_request -- SOLO SISTEMA.
--     Lo invocan el webhook de WhatsApp y el servicio de voz (sin usuario: auth.uid() is null).
--     Justificacion: security definer porque la sesion de sistema no tiene policy de escritura;
--     search_path fijo; revoke de public/anon; el guard `auth.uid() is null` impide que un
--     usuario autenticado la use para sembrar solicitudes ajenas. Idempotente: devuelve la
--     solicitud abierta existente del mismo derecho. El canal fija como se verifico la identidad.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.system_register_data_rights_request(
  p_organization_id uuid,
  p_customer_phone text,
  p_right_type text,
  p_channel text,
  p_detail text
)
returns table (out_id uuid, out_status text, out_already_open boolean, out_response_due_at timestamptz)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_row restaurantes.data_rights_requests%rowtype;
  v_stale record;
  v_channel text := coalesce(p_channel, 'whatsapp');
begin
  if auth.uid() is not null then
    raise exception 'system_register_data_rights_request es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception 'system_register_data_rights_request: telefono requerido' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'system_register_data_rights_request: organizacion inexistente' using errcode = '42501';
  end if;

  -- Una confirmacion pendiente de mas de 24 h caduca (el titular no respondio).
  for v_stale in
    update restaurantes.data_rights_requests r
       set status = 'expirada', updated_at = now()
     where r.organization_id = p_organization_id
       and r.customer_phone = p_customer_phone
       and r.status = 'pendiente_confirmacion'
       and r.created_at < now() - interval '24 hours'
    returning r.id
  loop
    insert into restaurantes.data_rights_events (organization_id, request_id, actor_kind, event, from_status, to_status)
    values (p_organization_id, v_stale.id, 'sistema', 'expirada', 'pendiente_confirmacion', 'expirada');
  end loop;

  select * into v_row
    from restaurantes.data_rights_requests r
   where r.organization_id = p_organization_id
     and r.customer_phone = p_customer_phone
     and r.right_type = p_right_type
     and r.status in ('pendiente_confirmacion', 'recibida', 'en_proceso', 'bloqueada');
  if found then
    return query select v_row.id, v_row.status, true, v_row.response_due_at;
    return;
  end if;

  begin
    insert into restaurantes.data_rights_requests (organization_id, customer_phone, right_type, channel, identity_basis, detail)
    values (
      p_organization_id, p_customer_phone, p_right_type, v_channel,
      case when v_channel = 'voice' then 'llamada_identificador' else 'whatsapp_numero' end,
      left(p_detail, 300)
    )
    returning * into v_row;
  exception when unique_violation then
    select * into v_row
      from restaurantes.data_rights_requests r
     where r.organization_id = p_organization_id
       and r.customer_phone = p_customer_phone
       and r.right_type = p_right_type
       and r.status in ('pendiente_confirmacion', 'recibida', 'en_proceso', 'bloqueada');
    return query select v_row.id, v_row.status, true, v_row.response_due_at;
    return;
  end;

  insert into restaurantes.data_rights_events (organization_id, request_id, actor_kind, event, to_status)
  values (p_organization_id, v_row.id, 'titular', 'registrada', 'pendiente_confirmacion');

  return query select v_row.id, v_row.status, false, v_row.response_due_at;
end;
$$;

revoke all on function restaurantes.system_register_data_rights_request(uuid, text, text, text, text) from public, anon;
-- La sesion de sistema del motor corre con el rol `authenticated` y auth.uid() NULL (mismo
-- patron que citas 024 y voz 025); el guard de arriba es la barrera real.
grant execute on function restaurantes.system_register_data_rights_request(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3b) restaurantes.system_resolve_data_rights_confirmation -- SOLO SISTEMA.
--     El titular responde desde el MISMO numero: confirma (arrancan los plazos) o retira la
--     solicitud. Sin solicitud pendiente vigente (<24 h) devuelve 0 filas.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.system_resolve_data_rights_confirmation(
  p_organization_id uuid,
  p_customer_phone text,
  p_confirm boolean
)
returns table (out_id uuid, out_right_type text, out_status text, out_response_due_at timestamptz, out_execution_due_at timestamptz)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_row restaurantes.data_rights_requests%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'system_resolve_data_rights_confirmation es solo para la sesion de sistema' using errcode = '42501';
  end if;

  select * into v_row
    from restaurantes.data_rights_requests r
   where r.organization_id = p_organization_id
     and r.customer_phone = p_customer_phone
     and r.status = 'pendiente_confirmacion'
     and r.created_at >= now() - interval '24 hours'
   order by r.created_at desc, r.seq desc
   limit 1
   for update;
  if not found then
    return;
  end if;

  if p_confirm then
    update restaurantes.data_rights_requests
       set status = 'recibida',
           confirmed_at = now(),
           response_due_at = now() + interval '20 days',
           execution_due_at = now() + interval '35 days',
           updated_at = now()
     where id = v_row.id
    returning * into v_row;
    insert into restaurantes.data_rights_events (organization_id, request_id, actor_kind, event, from_status, to_status)
    values (p_organization_id, v_row.id, 'titular', 'confirmada', 'pendiente_confirmacion', 'recibida');
  else
    update restaurantes.data_rights_requests
       set status = 'cancelada_titular', updated_at = now()
     where id = v_row.id
    returning * into v_row;
    insert into restaurantes.data_rights_events (organization_id, request_id, actor_kind, event, from_status, to_status)
    values (p_organization_id, v_row.id, 'titular', 'cancelada_por_titular', 'pendiente_confirmacion', 'cancelada_titular');
  end if;

  return query select v_row.id, v_row.right_type, v_row.status, v_row.response_due_at, v_row.execution_due_at;
end;
$$;

revoke all on function restaurantes.system_resolve_data_rights_confirmation(uuid, text, boolean) from public, anon;
grant execute on function restaurantes.system_resolve_data_rights_confirmation(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 3c) restaurantes.update_data_rights_request_status -- STAFF owner/admin.
--     El actor sale SIEMPRE de auth.uid(). Valida membership y rol (owner/admin), que la
--     solicitud pertenezca a la organizacion (cross-tenant) y la transicion de estado.
--     'bloqueada' solo aplica a 'cancelacion' (bloqueo de los datos mientras corre el plazo de
--     conservacion, antes de la supresion). 'rechazada' exige un motivo.
--       28000 sin sesion; 42501 sin rol; P0002 no existe; 55000 transicion invalida;
--       22023 parametro invalido.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.update_data_rights_request_status(
  p_organization_id uuid,
  p_request_id uuid,
  p_new_status text,
  p_note text
)
returns table (out_id uuid, out_status text)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_row restaurantes.data_rights_requests%rowtype;
  v_from text;
  v_ok boolean;
begin
  if v_actor is null then
    raise exception 'restaurantes.update_data_rights_request_status: requiere un actor autenticado' using errcode = '28000';
  end if;

  select m.vertical_role into v_role
    from core.membership m
   where m.organization_id = p_organization_id and m.user_id = v_actor;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'restaurantes.update_data_rights_request_status: solo owner/admin de la organizacion' using errcode = '42501';
  end if;

  if p_new_status is null or p_new_status not in ('en_proceso', 'bloqueada', 'resuelta', 'rechazada') then
    raise exception 'restaurantes.update_data_rights_request_status: estado destino invalido' using errcode = '22023';
  end if;
  if p_new_status = 'rechazada' and (p_note is null or btrim(p_note) = '') then
    raise exception 'restaurantes.update_data_rights_request_status: rechazar exige un motivo' using errcode = '22023';
  end if;

  select * into v_row
    from restaurantes.data_rights_requests r
   where r.id = p_request_id and r.organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'restaurantes.update_data_rights_request_status: solicitud no encontrada' using errcode = 'P0002';
  end if;

  v_from := v_row.status;
  v_ok := case
    when v_from = 'recibida' then p_new_status in ('en_proceso', 'bloqueada', 'resuelta', 'rechazada')
    when v_from = 'en_proceso' then p_new_status in ('bloqueada', 'resuelta', 'rechazada')
    when v_from = 'bloqueada' then p_new_status in ('resuelta', 'rechazada')
    else false
  end;
  if p_new_status = 'bloqueada' and v_row.right_type <> 'cancelacion' then
    v_ok := false;
  end if;
  if not v_ok then
    raise exception 'restaurantes.update_data_rights_request_status: transicion % -> % no permitida', v_from, p_new_status using errcode = '55000';
  end if;

  update restaurantes.data_rights_requests
     set status = p_new_status,
         handled_by = v_actor,
         resolution_note = case when p_new_status in ('resuelta', 'rechazada') then left(p_note, 1000) else resolution_note end,
         resolved_at = case when p_new_status in ('resuelta', 'rechazada') then now() else resolved_at end,
         updated_at = now()
   where id = v_row.id;

  insert into restaurantes.data_rights_events (organization_id, request_id, actor_user_id, actor_kind, event, from_status, to_status, note)
  values (p_organization_id, v_row.id, v_actor, 'staff', 'cambio_estado', v_from, p_new_status, left(p_note, 500));

  return query select v_row.id, p_new_status;
end;
$$;

revoke all on function restaurantes.update_data_rights_request_status(uuid, uuid, text, text) from public, anon;
grant execute on function restaurantes.update_data_rights_request_status(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) restaurantes.privacy_config -- parametros por organizacion
--    Una fila por organizacion; sin fila rigen los valores por defecto de la aplicacion
--    (aviso v1, conversaciones 180 dias, transcripciones de voz 30 dias, consentimiento
--    de grabacion exigido). Minimizacion: el agente ElevenLabs anterior retenia sin limite;
--    aqui TODO plazo es finito y acotado.
-- ---------------------------------------------------------------------------
create table restaurantes.privacy_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  -- Nombre del responsable del tratamiento que se nombra en el aviso simplificado (razon social o
  -- nombre comercial); NULL = el aviso dice "el restaurante".
  responsible_name text check (responsible_name is null or char_length(responsible_name) between 1 and 200),
  -- URL del aviso de privacidad integral que se enlaza en el aviso simplificado.
  notice_url text check (notice_url is null or (notice_url ~ '^https://[^[:space:]]+$' and char_length(notice_url) <= 500)),
  -- Subir la version vuelve a mostrar el aviso simplificado a cada titular una vez mas.
  notice_version text not null default 'v1' check (notice_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  conversation_retention_days integer not null default 180 check (conversation_retention_days between 30 and 1095),
  -- 0 = no se persiste ninguna transcripcion de voz.
  voice_retention_days integer not null default 30 check (voice_retention_days between 0 and 365),
  recording_consent_required boolean not null default true,
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table restaurantes.privacy_config enable row level security;

-- Lectura: owner/admin, o sesion de SISTEMA (`auth.uid() is null`: el webhook y el servicio de
-- voz deben leer la URL del aviso y los plazos; mismo escape hatch que branch_voice_config en 025).
create policy "owner/admin o sistema lee la config de privacidad" on restaurantes.privacy_config for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = privacy_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

-- Sin GRANT ni policy de escritura: solo `update_privacy_config` (definer) escribe.
revoke all on restaurantes.privacy_config from public, anon, authenticated, service_role;
grant select (organization_id, responsible_name, notice_url, notice_version, conversation_retention_days, voice_retention_days, recording_consent_required, updated_by, updated_at)
  on restaurantes.privacy_config to authenticated;

-- 4b) restaurantes.update_privacy_config -- STAFF owner/admin. Upsert; el actor sale de auth.uid().
create or replace function restaurantes.update_privacy_config(
  p_organization_id uuid,
  p_responsible_name text,
  p_notice_url text,
  p_notice_version text,
  p_conversation_retention_days integer,
  p_voice_retention_days integer,
  p_recording_consent_required boolean
)
returns table (out_organization_id uuid)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
begin
  if v_actor is null then
    raise exception 'restaurantes.update_privacy_config: requiere un actor autenticado' using errcode = '28000';
  end if;
  select m.vertical_role into v_role
    from core.membership m
   where m.organization_id = p_organization_id and m.user_id = v_actor;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'restaurantes.update_privacy_config: solo owner/admin de la organizacion' using errcode = '42501';
  end if;

  insert into restaurantes.privacy_config as c (
    organization_id, responsible_name, notice_url, notice_version, conversation_retention_days, voice_retention_days, recording_consent_required, updated_by, updated_at
  ) values (
    p_organization_id, nullif(btrim(p_responsible_name), ''), nullif(btrim(p_notice_url), ''), coalesce(p_notice_version, 'v1'),
    coalesce(p_conversation_retention_days, 180), coalesce(p_voice_retention_days, 30),
    coalesce(p_recording_consent_required, true), v_actor, now()
  )
  on conflict (organization_id) do update set
    responsible_name = excluded.responsible_name,
    notice_url = excluded.notice_url,
    notice_version = excluded.notice_version,
    conversation_retention_days = excluded.conversation_retention_days,
    voice_retention_days = excluded.voice_retention_days,
    recording_consent_required = excluded.recording_consent_required,
    updated_by = excluded.updated_by,
    updated_at = now();

  return query select p_organization_id;
end;
$$;

revoke all on function restaurantes.update_privacy_config(uuid, text, text, text, integer, integer, boolean) from public, anon;
grant execute on function restaurantes.update_privacy_config(uuid, text, text, text, integer, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Aviso simplificado: evidencia de entrega
-- ---------------------------------------------------------------------------
create table restaurantes.privacy_notice_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- sha256 hexadecimal del telefono: no se guarda el telefono en claro (minimizacion).
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  channel text not null check (channel in ('whatsapp', 'voice')),
  notice_version text not null check (notice_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  delivered_at timestamptz not null default now(),
  unique (organization_id, phone_hash, channel, notice_version)
);
create index restaurantes_privacy_notice_deliveries_org_idx on restaurantes.privacy_notice_deliveries (organization_id, delivered_at desc);

alter table restaurantes.privacy_notice_deliveries enable row level security;

create policy "owner/admin lee la evidencia de aviso de privacidad" on restaurantes.privacy_notice_deliveries for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = privacy_notice_deliveries.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

revoke all on restaurantes.privacy_notice_deliveries from public, anon, authenticated, service_role;
grant select (id, organization_id, phone_hash, channel, notice_version, delivered_at)
  on restaurantes.privacy_notice_deliveries to authenticated;

-- 5a) restaurantes.system_claim_privacy_notice -- SOLO SISTEMA. Devuelve TRUE solo la PRIMERA
--     vez que se entrega esa version del aviso a ese telefono por ese canal (atomico por el
--     UNIQUE: dos mensajes simultaneos no duplican el aviso). security definer porque la sesion
--     de sistema no tiene INSERT; guard `auth.uid() is null`; search_path fijo.
create or replace function restaurantes.system_claim_privacy_notice(
  p_organization_id uuid,
  p_phone_hash text,
  p_channel text,
  p_notice_version text
)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_claim_privacy_notice es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'system_claim_privacy_notice: organizacion inexistente' using errcode = '42501';
  end if;
  insert into restaurantes.privacy_notice_deliveries (organization_id, phone_hash, channel, notice_version)
  values (p_organization_id, p_phone_hash, p_channel, p_notice_version)
  on conflict (organization_id, phone_hash, channel, notice_version) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function restaurantes.system_claim_privacy_notice(uuid, text, text, text) from public, anon;
grant execute on function restaurantes.system_claim_privacy_notice(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5b) Consentimiento de grabacion de la llamada
--     'pendiente' (aun no se pregunto/contesto) | 'otorgado' | 'negado'.
-- ---------------------------------------------------------------------------
alter table restaurantes.voice_conversation
  add column recording_consent text not null default 'pendiente'
    check (recording_consent in ('pendiente', 'otorgado', 'negado'));

-- 5c) restaurantes.system_set_voice_recording_consent -- SOLO SISTEMA. Valida que la
--     conversacion pertenezca a la organizacion y siga abierta. Al NEGAR se borran de inmediato
--     los turnos ya guardados de esa llamada (la llamada se atiende sin grabar). Un
--     consentimiento ya negado no puede volver a otorgarse dentro de la misma llamada.
create or replace function restaurantes.system_set_voice_recording_consent(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_consent boolean
)
returns text
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_current text;
  v_new text := case when p_consent then 'otorgado' else 'negado' end;
begin
  if auth.uid() is not null then
    raise exception 'system_set_voice_recording_consent es solo para la sesion de sistema' using errcode = '42501';
  end if;
  select c.recording_consent into v_current
    from restaurantes.voice_conversation c
   where c.id = p_conversation_id and c.organization_id = p_organization_id and c.ended_at is null
   for update;
  if not found then
    raise exception 'conversacion inexistente, ajena o ya cerrada' using errcode = '42501';
  end if;
  if v_current = 'negado' then
    return v_current;
  end if;
  update restaurantes.voice_conversation set recording_consent = v_new where id = p_conversation_id;
  if v_new = 'negado' then
    delete from restaurantes.voice_turn where conversation_id = p_conversation_id and organization_id = p_organization_id;
  end if;
  return v_new;
end;
$$;

revoke all on function restaurantes.system_set_voice_recording_consent(uuid, uuid, boolean) from public, anon;
grant execute on function restaurantes.system_set_voice_recording_consent(uuid, uuid, boolean) to authenticated;

-- 5f) restaurantes.voz_registrar_turno -- misma firma y mismas validaciones que en 025, MAS: no
--     persiste texto si (a) la retencion de voz de la organizacion es 0 dias, o (b) la
--     organizacion exige consentimiento de grabacion (por defecto, si) y la llamada no tiene
--     'otorgado'. Devuelve false (no insertado) en esos casos: el servicio de voz sigue
--     atendiendo la llamada, solo no se guarda la transcripcion. Los grants de 025 se conservan
--     (create or replace no los toca).
create or replace function restaurantes.voz_registrar_turno(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_seq integer,
  p_rol text,
  p_texto text,
  p_duracion_ms integer,
  p_latencia_ms integer,
  p_costo_micro_usd bigint
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
  v_consent text;
  v_required boolean;
  v_retention integer;
begin
  if auth.uid() is not null then
    raise exception 'voz_registrar_turno es solo de sistema' using errcode = '42501';
  end if;
  select c.recording_consent into v_consent
    from restaurantes.voice_conversation c
   where c.id = p_conversation_id and c.organization_id = p_organization_id and c.ended_at is null;
  if not found then
    raise exception 'conversacion inexistente, ajena o ya cerrada' using errcode = '42501';
  end if;
  select pc.recording_consent_required, pc.voice_retention_days into v_required, v_retention
    from restaurantes.privacy_config pc where pc.organization_id = p_organization_id;
  v_required := coalesce(v_required, true);
  v_retention := coalesce(v_retention, 30);
  if v_retention = 0 or v_consent = 'negado' or (v_required and v_consent <> 'otorgado') then
    return false;
  end if;
  insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto, duracion_ms, latencia_ms, costo_estimado_micro_usd)
    values (p_conversation_id, p_organization_id, p_seq, p_rol, left(p_texto, 4000), p_duracion_ms, p_latencia_ms, coalesce(p_costo_micro_usd, 0))
    on conflict (conversation_id, seq) do nothing
    returning id into v_id;
  return v_id is not null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Retencion / minimizacion -- restaurantes.system_purge_expired_privacy_data
--    SOLO SISTEMA (cron interno). Por lote acotado:
--      * vacia `messages` de las conversaciones de WhatsApp cuya ultima actividad supera los
--        dias de retencion de SU organizacion (la fila y su vinculo al pedido se conservan);
--      * borra los turnos (transcripcion) de las llamadas mas antiguas que la retencion de voz
--        y anula `caller_hash` de esas llamadas.
--    NO toca a un titular con una solicitud ARCO abierta (recibida/en_proceso/bloqueada): su
--    evidencia se conserva hasta resolverla. Devuelve los conteos.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.system_purge_expired_privacy_data(p_limit integer default 500)
returns table (out_conversations_cleared integer, out_voice_turns_deleted integer, out_voice_calls_anonymized integer)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_conv integer := 0;
  v_turns integer := 0;
  v_calls integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'system_purge_expired_privacy_data es solo para la sesion de sistema' using errcode = '42501';
  end if;

  with victims as (
    select w.id
      from restaurantes.whatsapp_conversations w
      left join restaurantes.privacy_config pc on pc.organization_id = w.organization_id
     where w.messages <> '[]'::jsonb
       and w.updated_at < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
       and not exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = w.organization_id and r.customer_phone = w.phone
            and r.status in ('recibida', 'en_proceso', 'bloqueada')
       )
     order by w.updated_at
     limit v_limit
  ), cleared as (
    update restaurantes.whatsapp_conversations w
       set messages = '[]'::jsonb
      from victims v
     where w.id = v.id
    returning 1
  )
  select count(*) into v_conv from cleared;

  with old_calls as (
    select c.id
      from restaurantes.voice_conversation c
      left join restaurantes.privacy_config pc on pc.organization_id = c.organization_id
     where (c.ended_at is not null or c.started_at < now() - interval '1 day')
       and c.started_at < now() - make_interval(days => coalesce(pc.voice_retention_days, 30))
       and (
         exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id)
         or c.caller_hash is not null
       )
       and not exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = c.organization_id
            and r.status in ('recibida', 'en_proceso', 'bloqueada')
            and c.caller_hash = encode(sha256(convert_to(regexp_replace(r.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex')
       )
     order by c.started_at
     limit v_limit
  ), del_turns as (
    delete from restaurantes.voice_turn t using old_calls o where t.conversation_id = o.id returning 1
  ), anon as (
    update restaurantes.voice_conversation c set caller_hash = null
      from old_calls o where c.id = o.id and c.caller_hash is not null returning 1
  )
  select (select count(*) from del_turns), (select count(*) from anon) into v_turns, v_calls;

  return query select v_conv, v_turns, v_calls;
end;
$$;

revoke all on function restaurantes.system_purge_expired_privacy_data(integer) from public, anon;
grant execute on function restaurantes.system_purge_expired_privacy_data(integer) to authenticated;
