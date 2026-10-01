-- C-02 (citas) — solicitudes de derechos ARCO (acceso, rectificación, cancelación,
-- oposición) con plazos, estados y bitácora propia, recibidas desde el agente de
-- WhatsApp (fast-path determinista, ver packages/domain-citas/src/arco-intent.ts) y
-- seguidas desde el panel. Documentación operativa, NO asesoría legal: los plazos
-- de abajo son una referencia operativa conservadora (días de CALENDARIO, nunca
-- más largos que los días hábiles que cita la LFPDPPP vigente); el responsable
-- debe validar su aviso de privacidad y su procedimiento con su asesor jurídico.
--
-- Qué agrega:
--   1. citas.data_rights_requests -- una fila por solicitud. Nace en
--      'pendiente_confirmacion' (el titular todavía no confirmó desde SU número) y
--      solo al confirmar ('recibida') corren los plazos: respuesta a 20 días y
--      ejecución a 15 días más (response_due_at / execution_due_at).
--   2. citas.data_rights_events -- bitácora append-only de cada cambio (registro,
--      confirmación, cambio de estado por staff, expiración). Sin PII adicional.
--   3. Tres funciones security definer: dos de SOLO-SISTEMA (webhook de WhatsApp,
--      sin usuario: guard `auth.uid() is null`) y una de STAFF owner/admin.
--
-- Identidad del titular: el agente solo actúa sobre el número de WhatsApp que
-- escribe (Meta lo autentica). La fila guarda ESE teléfono; nunca recibe un
-- teléfono distinto como parámetro desde el texto del mensaje, así que una persona
-- no puede abrir una solicitud sobre los datos de otra. La confirmación exige una
-- frase explícita desde el mismo número ("CONFIRMO"), no un "sí" ambiguo.
-- El agente NUNCA devuelve datos personales por chat: 'acceso' se atiende por staff
-- desde el panel una vez verificada la identidad del titular.
--
-- Compatibilidad con la base sin migrar: el código TypeScript captura 42883/42P01/
-- 42703 con SAVEPOINT y cae al camino anterior (agente LLM) -- esta migración
-- NO se aplica automáticamente al mergear.
--
-- Requiere: 0001_core_schema.sql (core.organization, core.staff_user,
-- core.membership) y 001_citas_schema.sql (schema citas).

-- ---------------------------------------------------------------------------
-- 1) citas.data_rights_requests
-- ---------------------------------------------------------------------------
create table citas.data_rights_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  -- Teléfono del titular tal como lo autentica el canal (E.164 normalizado por el
  -- caller). Nunca viene de texto libre del mensaje.
  customer_phone text not null check (char_length(customer_phone) between 1 and 64),
  right_type text not null check (right_type in ('acceso', 'rectificacion', 'cancelacion', 'oposicion')),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'voice')),
  status text not null default 'pendiente_confirmacion'
    check (status in ('pendiente_confirmacion', 'recibida', 'en_proceso', 'bloqueada', 'resuelta', 'rechazada', 'cancelada_titular', 'expirada')),
  -- Extracto ya redactado (tarjetas/cvv) del mensaje del titular; acotado.
  detail text check (detail is null or char_length(detail) <= 300),
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  -- Plazos de referencia (calendario): respuesta 20 días y ejecución 15 días más,
  -- contados desde la confirmación del titular.
  response_due_at timestamptz,
  execution_due_at timestamptz,
  resolved_at timestamptz,
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 1000),
  handled_by uuid references core.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  seq bigint generated always as identity,
  -- Los plazos solo existen para solicitudes ya confirmadas por el titular.
  constraint data_rights_requests_plazos_check check (
    status in ('pendiente_confirmacion', 'cancelada_titular', 'expirada')
    or (confirmed_at is not null and response_due_at is not null and execution_due_at is not null)
  )
);

-- Una sola solicitud ABIERTA por (organización, teléfono, derecho): idempotencia
-- ante reintentos de Meta y ante un titular que insiste.
create unique index data_rights_requests_open_uniq
  on citas.data_rights_requests (organization_id, customer_phone, right_type)
  where status in ('pendiente_confirmacion', 'recibida', 'en_proceso', 'bloqueada');
create index data_rights_requests_org_created_idx
  on citas.data_rights_requests (organization_id, created_at desc, seq desc);
create index data_rights_requests_org_status_due_idx
  on citas.data_rights_requests (organization_id, status, response_due_at);

alter table citas.data_rights_requests enable row level security;

-- Lectura: SOLO owner/admin de la organización (contiene teléfonos de titulares).
-- Un rol 'staff' de agenda no necesita ver solicitudes de privacidad.
create policy "owner/admin lee las solicitudes ARCO de su organizacion" on citas.data_rights_requests for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = data_rights_requests.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

-- Sin GRANT de INSERT/UPDATE/DELETE para nadie y sin policy de escritura: toda
-- escritura pasa por las funciones security definer de abajo (deny-by-default).
-- SELECT por COLUMNA explícita (no a nivel tabla): una columna agregada en el
-- futuro NO queda expuesta por accidente.
revoke all on citas.data_rights_requests from public, anon, authenticated, service_role;
grant select (id, organization_id, customer_phone, right_type, channel, status, detail, requested_at, confirmed_at, response_due_at, execution_due_at, resolved_at, resolution_note, handled_by, created_at, updated_at, seq)
  on citas.data_rights_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 2) citas.data_rights_events -- bitácora append-only
-- ---------------------------------------------------------------------------
create table citas.data_rights_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  request_id uuid not null references citas.data_rights_requests(id) on delete restrict,
  -- NULL cuando el actor es el titular o el sistema (sin usuario de staff).
  actor_user_id uuid references core.staff_user(id) on delete restrict,
  actor_kind text not null check (actor_kind in ('titular', 'sistema', 'staff')),
  event text not null check (event in ('registrada', 'confirmada', 'cancelada_por_titular', 'expirada', 'cambio_estado')),
  from_status text,
  to_status text,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  seq bigint generated always as identity
);
create index data_rights_events_request_idx on citas.data_rights_events (request_id, created_at, seq);
create index data_rights_events_org_idx on citas.data_rights_events (organization_id, created_at desc, seq desc);

alter table citas.data_rights_events enable row level security;

create policy "owner/admin lee la bitacora ARCO de su organizacion" on citas.data_rights_events for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = data_rights_events.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

revoke all on citas.data_rights_events from public, anon, authenticated, service_role;
grant select (id, organization_id, request_id, actor_user_id, actor_kind, event, from_status, to_status, note, created_at, seq)
  on citas.data_rights_events to authenticated;

create or replace function citas.data_rights_events_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'citas_data_rights_events_append_only: % no está permitido sobre citas.data_rights_events', tg_op
    using errcode = '0A000';
end;
$$;

create trigger citas_data_rights_events_block_update_trg
  before update on citas.data_rights_events
  for each row execute function citas.data_rights_events_block_mutation();
create trigger citas_data_rights_events_block_delete_trg
  before delete on citas.data_rights_events
  for each row execute function citas.data_rights_events_block_mutation();

-- ---------------------------------------------------------------------------
-- 3a) citas.system_register_data_rights_request -- SOLO SISTEMA.
--     Lo invoca el webhook de WhatsApp (sin usuario: auth.uid() is null). Justificación:
--     security definer porque la sesión de sistema no tiene policy de escritura;
--     search_path fijo; revoke de public/anon; el guard `auth.uid() is null`
--     impide que un usuario autenticado la use para sembrar solicitudes ajenas.
--     Idempotente: devuelve la solicitud abierta existente del mismo derecho.
-- ---------------------------------------------------------------------------
create or replace function citas.system_register_data_rights_request(
  p_organization_id uuid,
  p_customer_phone text,
  p_right_type text,
  p_channel text,
  p_detail text
)
returns table (out_id uuid, out_status text, out_already_open boolean, out_response_due_at timestamptz)
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_row citas.data_rights_requests%rowtype;
  v_stale record;
begin
  if auth.uid() is not null then
    raise exception 'system_register_data_rights_request es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception 'system_register_data_rights_request: teléfono requerido' using errcode = '22023';
  end if;

  -- Una confirmación pendiente de más de 24 h caduca (el titular no respondió).
  for v_stale in
    update citas.data_rights_requests r
       set status = 'expirada', updated_at = now()
     where r.organization_id = p_organization_id
       and r.customer_phone = p_customer_phone
       and r.status = 'pendiente_confirmacion'
       and r.created_at < now() - interval '24 hours'
    returning r.id
  loop
    insert into citas.data_rights_events (organization_id, request_id, actor_kind, event, from_status, to_status)
    values (p_organization_id, v_stale.id, 'sistema', 'expirada', 'pendiente_confirmacion', 'expirada');
  end loop;

  select * into v_row
    from citas.data_rights_requests r
   where r.organization_id = p_organization_id
     and r.customer_phone = p_customer_phone
     and r.right_type = p_right_type
     and r.status in ('pendiente_confirmacion', 'recibida', 'en_proceso', 'bloqueada');
  if found then
    return query select v_row.id, v_row.status, true, v_row.response_due_at;
    return;
  end if;

  begin
    insert into citas.data_rights_requests (organization_id, customer_phone, right_type, channel, detail)
    values (p_organization_id, p_customer_phone, p_right_type, coalesce(p_channel, 'whatsapp'), left(p_detail, 300))
    returning * into v_row;
  exception when unique_violation then
    -- Carrera con un reintento simultáneo: la otra transacción ya la creó.
    select * into v_row
      from citas.data_rights_requests r
     where r.organization_id = p_organization_id
       and r.customer_phone = p_customer_phone
       and r.right_type = p_right_type
       and r.status in ('pendiente_confirmacion', 'recibida', 'en_proceso', 'bloqueada');
    return query select v_row.id, v_row.status, true, v_row.response_due_at;
    return;
  end;

  insert into citas.data_rights_events (organization_id, request_id, actor_kind, event, to_status)
  values (p_organization_id, v_row.id, 'titular', 'registrada', 'pendiente_confirmacion');

  return query select v_row.id, v_row.status, false, v_row.response_due_at;
end;
$$;

revoke all on function citas.system_register_data_rights_request(uuid, text, text, text, text) from public, anon, authenticated;
-- La sesión de sistema del motor corre con el rol `authenticated` y auth.uid() NULL
-- (mismo patrón que 020/021); el guard de arriba es la barrera real.
grant execute on function citas.system_register_data_rights_request(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3b) citas.system_resolve_data_rights_confirmation -- SOLO SISTEMA.
--     El titular responde desde el MISMO número: confirma (arrancan los plazos) o
--     retira la solicitud. Sin solicitud pendiente vigente (<24 h) devuelve 0 filas.
-- ---------------------------------------------------------------------------
create or replace function citas.system_resolve_data_rights_confirmation(
  p_organization_id uuid,
  p_customer_phone text,
  p_confirm boolean
)
returns table (out_id uuid, out_right_type text, out_status text, out_response_due_at timestamptz, out_execution_due_at timestamptz)
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_row citas.data_rights_requests%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'system_resolve_data_rights_confirmation es solo para la sesión de sistema' using errcode = '42501';
  end if;

  select * into v_row
    from citas.data_rights_requests r
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
    update citas.data_rights_requests
       set status = 'recibida',
           confirmed_at = now(),
           response_due_at = now() + interval '20 days',
           execution_due_at = now() + interval '35 days',
           updated_at = now()
     where id = v_row.id
    returning * into v_row;
    insert into citas.data_rights_events (organization_id, request_id, actor_kind, event, from_status, to_status)
    values (p_organization_id, v_row.id, 'titular', 'confirmada', 'pendiente_confirmacion', 'recibida');
  else
    update citas.data_rights_requests
       set status = 'cancelada_titular', updated_at = now()
     where id = v_row.id
    returning * into v_row;
    insert into citas.data_rights_events (organization_id, request_id, actor_kind, event, from_status, to_status)
    values (p_organization_id, v_row.id, 'titular', 'cancelada_por_titular', 'pendiente_confirmacion', 'cancelada_titular');
  end if;

  return query select v_row.id, v_row.right_type, v_row.status, v_row.response_due_at, v_row.execution_due_at;
end;
$$;

revoke all on function citas.system_resolve_data_rights_confirmation(uuid, text, boolean) from public, anon, authenticated;
grant execute on function citas.system_resolve_data_rights_confirmation(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 3c) citas.update_data_rights_request_status -- STAFF owner/admin.
--     El actor sale SIEMPRE de auth.uid(). Valida membership y rol (owner/admin),
--     que la solicitud pertenezca a la organización (cross-tenant), y la
--     transición de estado. 'bloqueada' solo aplica a 'cancelacion' (bloqueo de
--     los datos mientras corre el plazo de conservación, antes de la supresión).
--     'rechazada' exige un motivo.
--       errcode 28000 sin sesión; 42501 sin rol; P0002 no existe; 55000 transición
--       inválida; 22023 parámetro inválido.
-- ---------------------------------------------------------------------------
create or replace function citas.update_data_rights_request_status(
  p_organization_id uuid,
  p_request_id uuid,
  p_new_status text,
  p_note text
)
returns table (out_id uuid, out_status text)
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_row citas.data_rights_requests%rowtype;
  v_from text;
  v_ok boolean;
begin
  if v_actor is null then
    raise exception 'citas.update_data_rights_request_status: requiere un actor autenticado' using errcode = '28000';
  end if;

  select m.vertical_role into v_role
    from core.membership m
   where m.organization_id = p_organization_id and m.user_id = v_actor;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'citas.update_data_rights_request_status: solo owner/admin de la organizacion' using errcode = '42501';
  end if;

  if p_new_status is null or p_new_status not in ('en_proceso', 'bloqueada', 'resuelta', 'rechazada') then
    raise exception 'citas.update_data_rights_request_status: estado destino invalido' using errcode = '22023';
  end if;
  if p_new_status = 'rechazada' and (p_note is null or btrim(p_note) = '') then
    raise exception 'citas.update_data_rights_request_status: rechazar exige un motivo' using errcode = '22023';
  end if;

  select * into v_row
    from citas.data_rights_requests r
   where r.id = p_request_id and r.organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'citas.update_data_rights_request_status: solicitud no encontrada' using errcode = 'P0002';
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
    raise exception 'citas.update_data_rights_request_status: transicion % -> % no permitida', v_from, p_new_status using errcode = '55000';
  end if;

  update citas.data_rights_requests
     set status = p_new_status,
         handled_by = v_actor,
         resolution_note = case when p_new_status in ('resuelta', 'rechazada') then left(p_note, 1000) else resolution_note end,
         resolved_at = case when p_new_status in ('resuelta', 'rechazada') then now() else resolved_at end,
         updated_at = now()
   where id = v_row.id;

  insert into citas.data_rights_events (organization_id, request_id, actor_user_id, actor_kind, event, from_status, to_status, note)
  values (p_organization_id, v_row.id, v_actor, 'staff', 'cambio_estado', v_from, p_new_status, left(p_note, 500));

  return query select v_row.id, p_new_status;
end;
$$;

revoke all on function citas.update_data_rights_request_status(uuid, uuid, text, text) from public, anon;
grant execute on function citas.update_data_rights_request_status(uuid, uuid, text, text) to authenticated;
