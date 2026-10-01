-- L-05 (licitaciones): avisos por WhatsApp (plazos / convocatorias / fallos) y
-- decision go / no-go por boton interactivo, con opt-in verificado, token de un
-- solo uso con hash y expiracion, idempotencia, bitacora y outbox. Requiere:
-- 001..029 (tablas `licitaciones.tender`, `go_no_go_decision`, helpers
-- `can_access_org` / `can_decide_org` / `can_go_no_go_org`).
--
-- Que agrega (todo acotado a la organizacion; sin `using (true)`; ningun GRANT
-- a anon):
--   1. `whatsapp_contact`      -- telefono de cada usuario de staff + consentimiento
--                                  (pendiente -> activo solo por mensaje ENTRANTE del
--                                  propio numero; activo -> baja por BAJA/panel).
--   2. `whatsapp_action_token` -- token de un solo uso (solo se guarda su SHA-256),
--                                  ligado a usuario + organizacion + convocatoria +
--                                  accion + telefono, con expiracion.
--   3. `whatsapp_outbox`       -- cola de salida (mismo patron que
--                                  `hoteles.messaging_outbox`, migracion 008 de hoteles).
--   4. `whatsapp_event_log`    -- bitacora append-only (opt-in/out, tokens, decisiones).
--
-- Esta migracion NO envia nada: el envio real vive en @atiende/whatsapp-gateway y
-- lo dispara el cron / el webhook; ni la CI ni los tests tocan Graph API.
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript que consume estas
-- tablas/funciones captura 42P01/42703/42883 dentro de un SAVEPOINT y degrada a
-- "no disponible aun" (ver `whatsapp-repository.ts`). Orden de despliegue: esta
-- migracion puede aplicarse antes o despues del codigo.
--
-- Nota sobre roles: `withAppSession` abre SIEMPRE el rol `authenticated`; la
-- sesion de sistema es `authenticated` con `auth.uid() is null`. Por eso las
-- funciones de solo-sistema se otorgan a `authenticated` y se protegen DENTRO
-- con `auth.uid() is null` (mismo criterio que la migracion 020).

-- ---------------------------------------------------------------------------
-- 1) whatsapp_contact
-- ---------------------------------------------------------------------------
create table licitaciones.whatsapp_contact (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  user_id uuid not null references core.staff_user(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status text not null default 'pendiente' check (status in ('pendiente', 'activo', 'baja')),
  notify_plazos boolean not null default true,
  notify_convocatorias boolean not null default true,
  notify_fallos boolean not null default true,
  notify_decisiones boolean not null default true,
  consent_requested_at timestamptz,
  opted_in_at timestamptz,
  opted_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index licitaciones_whatsapp_contact_phone_idx on licitaciones.whatsapp_contact (phone_e164);

-- Seguridad del trigger: cambiar el telefono invalida el consentimiento (el nuevo
-- numero debe demostrar que es del usuario contestando SI). Corre como el rol que
-- invoca: asignar NEW.* en un trigger no pasa por los GRANT por columna, asi que
-- authenticated no necesita (ni tiene) UPDATE sobre `status`.
create or replace function licitaciones.whatsapp_contact_before_update()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  if new.phone_e164 is distinct from old.phone_e164 then
    new.status := 'pendiente';
    new.opted_in_at := null;
    new.consent_requested_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger whatsapp_contact_before_update before update on licitaciones.whatsapp_contact
  for each row execute function licitaciones.whatsapp_contact_before_update();

alter table licitaciones.whatsapp_contact enable row level security;
-- Seguridad: el telefono es dato personal -- cada usuario ve y edita SOLO su fila
-- (minimo necesario); ni owner/admin leen telefonos ajenos desde el panel.
create policy "contacto: el usuario ve su propia fila" on licitaciones.whatsapp_contact
  for select using (user_id = auth.uid() and licitaciones.can_access_org(organization_id));
create policy "contacto: el usuario registra su propia fila" on licitaciones.whatsapp_contact
  for insert with check (user_id = auth.uid() and licitaciones.can_access_org(organization_id) and status = 'pendiente');
create policy "contacto: el usuario edita su propia fila" on licitaciones.whatsapp_contact
  for update using (user_id = auth.uid() and licitaciones.can_access_org(organization_id))
  with check (user_id = auth.uid() and licitaciones.can_access_org(organization_id));

revoke all on licitaciones.whatsapp_contact from public, anon;
-- GRANT por columna: `status`, `opted_in_at`, `opted_out_at`, `consent_requested_at`
-- NUNCA son escribibles por el cliente (solo por las funciones definer de abajo y
-- el trigger); si lo fueran, cualquiera podria auto-activarse sin probar el numero.
grant select on licitaciones.whatsapp_contact to authenticated;
grant insert (organization_id, user_id, phone_e164, notify_plazos, notify_convocatorias, notify_fallos, notify_decisiones)
  on licitaciones.whatsapp_contact to authenticated;
grant update (phone_e164, notify_plazos, notify_convocatorias, notify_fallos, notify_decisiones)
  on licitaciones.whatsapp_contact to authenticated;
grant select, insert, update on licitaciones.whatsapp_contact to service_role;

-- ---------------------------------------------------------------------------
-- 2) whatsapp_action_token
-- ---------------------------------------------------------------------------
create table licitaciones.whatsapp_action_token (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  user_id uuid not null references core.staff_user(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  action text not null check (action in ('go', 'no_go')),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Solo el SHA-256 hex del token: la base nunca guarda el secreto que viaja por WhatsApp.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_message_id text check (consumed_message_id is null or length(consumed_message_id) between 1 and 255),
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((consumed_at is null) = (consumed_message_id is null))
);
create index licitaciones_whatsapp_action_token_vigente_idx
  on licitaciones.whatsapp_action_token (user_id, tender_id) where consumed_at is null;

alter table licitaciones.whatsapp_action_token enable row level security;
-- Sin ninguna policy ni GRANT para authenticated/anon: solo se toca via funciones definer.
revoke all on licitaciones.whatsapp_action_token from public, anon, authenticated;
grant select, insert, update on licitaciones.whatsapp_action_token to service_role;

-- ---------------------------------------------------------------------------
-- 3) whatsapp_outbox (patron hoteles.messaging_outbox)
-- ---------------------------------------------------------------------------
create table licitaciones.whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
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
  unique (organization_id, dedupe_key)
);
create index licitaciones_whatsapp_outbox_claim_idx
  on licitaciones.whatsapp_outbox (status, next_attempt_at) where status in ('pending', 'processing');
alter table licitaciones.whatsapp_outbox enable row level security;
revoke all on licitaciones.whatsapp_outbox from public, anon, authenticated;
grant select, insert, update on licitaciones.whatsapp_outbox to service_role;

-- ---------------------------------------------------------------------------
-- 4) whatsapp_event_log (append-only)
-- ---------------------------------------------------------------------------
create table licitaciones.whatsapp_event_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  user_id uuid references core.staff_user(id) on delete set null,
  tender_id uuid references licitaciones.tender(id) on delete set null,
  event text not null check (length(event) between 1 and 60),
  detail text check (detail is null or length(detail) <= 300),
  message_id text check (message_id is null or length(message_id) <= 255),
  created_at timestamptz not null default now()
);
create index licitaciones_whatsapp_event_log_org_idx on licitaciones.whatsapp_event_log (organization_id, created_at desc);
alter table licitaciones.whatsapp_event_log enable row level security;
-- Seguridad: la bitacora la ven los roles de decision de la organizacion; nadie la
-- escribe desde el cliente (sin INSERT/UPDATE/DELETE para authenticated): solo las
-- funciones definer de este archivo.
create policy "bitacora whatsapp: roles de decision la leen" on licitaciones.whatsapp_event_log
  for select using (licitaciones.can_decide_org(organization_id));
revoke all on licitaciones.whatsapp_event_log from public, anon;
grant select on licitaciones.whatsapp_event_log to authenticated;
grant select, insert on licitaciones.whatsapp_event_log to service_role;

-- ---------------------------------------------------------------------------
-- 5) Funciones de USUARIO (auth.uid() obligatorio, solo su propia fila)
-- ---------------------------------------------------------------------------

-- Pide el mensaje de confirmacion de opt-in (o lo reenvia tras una baja). Seguridad:
-- definer porque encola en una tabla sin acceso para authenticated; solo actua sobre
-- la fila del propio llamador; el dedupe por hora acota el spam al numero.
create or replace function licitaciones.whatsapp_request_consent(p_organization_id uuid)
returns boolean language plpgsql security definer set search_path = licitaciones, core, pg_temp as $$
declare c licitaciones.whatsapp_contact;
begin
  if auth.uid() is null then
    raise exception 'whatsapp_request_consent requiere un usuario autenticado' using errcode = '42501';
  end if;
  select * into c from licitaciones.whatsapp_contact
    where organization_id = p_organization_id and user_id = auth.uid() for update;
  if not found or not licitaciones.can_access_org(p_organization_id) then return false; end if;
  update licitaciones.whatsapp_contact
    set status = 'pendiente', consent_requested_at = now(), opted_out_at = null
    where id = c.id;
  insert into licitaciones.whatsapp_outbox (organization_id, event_type, dedupe_key, payload)
  values (
    p_organization_id, 'consent_request',
    'consent:' || c.id::text || ':' || to_char(now() at time zone 'utc', 'YYYYMMDDHH24'),
    jsonb_build_object('to', c.phone_e164, 'body',
      'Atiende Licitaciones: para recibir avisos y decisiones por WhatsApp responde SI. Si no fuiste tu, ignora este mensaje. Para dejar de recibirlos responde BAJA en cualquier momento.')
  ) on conflict (organization_id, dedupe_key) do nothing;
  insert into licitaciones.whatsapp_event_log (organization_id, user_id, event) values (p_organization_id, auth.uid(), 'consentimiento_solicitado');
  return true;
end;
$$;

create or replace function licitaciones.whatsapp_opt_out_self(p_organization_id uuid)
returns boolean language plpgsql security definer set search_path = licitaciones, core, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'whatsapp_opt_out_self requiere un usuario autenticado' using errcode = '42501';
  end if;
  update licitaciones.whatsapp_contact
    set status = 'baja', opted_out_at = now()
    where organization_id = p_organization_id and user_id = auth.uid() and status <> 'baja'
    returning id into v_id;
  if v_id is null then return false; end if;
  insert into licitaciones.whatsapp_event_log (organization_id, user_id, event, detail) values (p_organization_id, auth.uid(), 'baja', 'panel');
  return true;
end;
$$;

-- Consume el token de UNA decision en la MISMA transaccion en la que la capa de
-- aplicacion inserta `go_no_go_decision` (sesion con auth.uid() = el usuario del
-- token). Seguridad: (a) auth.uid() debe ser el dueno del token -- el token de otro
-- usuario responde "no_encontrado" (sin oraculo); (b) `for update` serializa los
-- reintentos: un solo ganador; (c) revalida contacto activo, telefono remitente
-- identico al del token y rol vigente; (d) un rechazo NO consume el token.
create or replace function licitaciones.whatsapp_consume_action_token(
  p_token_hash text, p_sender_phone text, p_message_id text
) returns table(resultado text, convocatoria_id uuid, accion text)
language plpgsql security definer set search_path = licitaciones, core, pg_temp as $$
declare t licitaciones.whatsapp_action_token; c licitaciones.whatsapp_contact;
begin
  if auth.uid() is null then
    raise exception 'whatsapp_consume_action_token requiere un usuario autenticado' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_message_id is null or length(p_message_id) not between 1 and 255 then
    return query select 'no_encontrado'::text, null::uuid, null::text; return;
  end if;
  select * into t from licitaciones.whatsapp_action_token w where w.token_hash = p_token_hash for update;
  if not found or t.user_id <> auth.uid() then
    return query select 'no_encontrado'::text, null::uuid, null::text; return;
  end if;
  if t.consumed_at is not null then
    if t.consumed_message_id = p_message_id then
      return query select 'duplicado'::text, t.tender_id, t.action; return;
    end if;
    insert into licitaciones.whatsapp_event_log (organization_id, user_id, tender_id, event, message_id)
      values (t.organization_id, t.user_id, t.tender_id, 'token_rechazado_reutilizado', p_message_id);
    return query select 'ya_usado'::text, t.tender_id, t.action; return;
  end if;
  if t.expires_at <= now() then
    insert into licitaciones.whatsapp_event_log (organization_id, user_id, tender_id, event, message_id)
      values (t.organization_id, t.user_id, t.tender_id, 'token_rechazado_expirado', p_message_id);
    return query select 'expirado'::text, t.tender_id, t.action; return;
  end if;
  select * into c from licitaciones.whatsapp_contact where organization_id = t.organization_id and user_id = t.user_id;
  if not found or c.status <> 'activo' then
    insert into licitaciones.whatsapp_event_log (organization_id, user_id, tender_id, event, message_id)
      values (t.organization_id, t.user_id, t.tender_id, 'token_rechazado_contacto_inactivo', p_message_id);
    return query select 'contacto_inactivo'::text, t.tender_id, t.action; return;
  end if;
  if c.phone_e164 <> t.phone_e164 or t.phone_e164 <> p_sender_phone then
    insert into licitaciones.whatsapp_event_log (organization_id, user_id, tender_id, event, message_id)
      values (t.organization_id, t.user_id, t.tender_id, 'token_rechazado_telefono_distinto', p_message_id);
    return query select 'telefono_distinto'::text, t.tender_id, t.action; return;
  end if;
  if not licitaciones.can_go_no_go_org(t.organization_id) then
    insert into licitaciones.whatsapp_event_log (organization_id, user_id, tender_id, event, message_id)
      values (t.organization_id, t.user_id, t.tender_id, 'token_rechazado_rol', p_message_id);
    return query select 'rol_insuficiente'::text, t.tender_id, t.action; return;
  end if;
  update licitaciones.whatsapp_action_token set consumed_at = now(), consumed_message_id = p_message_id where id = t.id;
  insert into licitaciones.whatsapp_event_log (organization_id, user_id, tender_id, event, detail, message_id)
    values (t.organization_id, t.user_id, t.tender_id, 'decision_por_whatsapp', t.action, p_message_id);
  return query select 'ok'::text, t.tender_id, t.action;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Funciones de SISTEMA (auth.uid() is null)
-- ---------------------------------------------------------------------------

-- Quien es el dueno de un token (para abrir la sesion de ESE usuario). El hash es un
-- secreto de 256 bits: conocerlo equivale a haber recibido el mensaje.
create or replace function licitaciones.system_whatsapp_token_owner(p_token_hash text)
returns table(organization_id uuid, user_id uuid)
language plpgsql stable security definer set search_path = licitaciones, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_whatsapp_token_owner es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query select w.organization_id, w.user_id from licitaciones.whatsapp_action_token w where w.token_hash = p_token_hash;
end;
$$;

-- Contactos activos de una organizacion para un tema; `decisiones` ademas exige
-- rol go/no-go VIGENTE (membresia actual) -- nunca se pide una decision a quien ya
-- no tiene permiso para tomarla.
create or replace function licitaciones.system_whatsapp_active_contacts(p_organization_id uuid, p_topic text)
returns table(user_id uuid, phone_e164 text)
language plpgsql stable security definer set search_path = licitaciones, core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_whatsapp_active_contacts es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_topic not in ('plazos', 'convocatorias', 'fallos', 'decisiones') then
    raise exception 'tema de aviso invalido: %', p_topic;
  end if;
  return query
    select c.user_id, c.phone_e164
    from licitaciones.whatsapp_contact c
    join core.membership m on m.organization_id = c.organization_id and m.user_id = c.user_id
    where c.organization_id = p_organization_id
      and c.status = 'activo'
      and (case p_topic
             when 'plazos' then c.notify_plazos
             when 'convocatorias' then c.notify_convocatorias
             when 'fallos' then c.notify_fallos
             else c.notify_decisiones and m.vertical_role in ('owner', 'admin', 'analyst', 'reviewer')
           end)
    order by c.created_at, c.id;
end;
$$;

-- Emite un token para una decision. Devuelve NULL si ya hay uno vigente sin usar para
-- el mismo usuario y convocatoria (idempotente: no se duplica la solicitud).
create or replace function licitaciones.system_issue_whatsapp_action_token(
  p_organization_id uuid, p_user_id uuid, p_tender_id uuid, p_action text, p_token_hash text, p_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path = licitaciones, core, pg_temp as $$
declare c licitaciones.whatsapp_contact; v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_issue_whatsapp_action_token es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_action not in ('go', 'no_go') then raise exception 'accion invalida'; end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '7 days' then raise exception 'expiracion fuera de rango (maximo 7 dias)'; end if;
  if not exists (select 1 from licitaciones.tender t where t.id = p_tender_id and t.organization_id = p_organization_id) then
    raise exception 'convocatoria ajena a la organizacion';
  end if;
  if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = p_user_id
                 and m.vertical_role in ('owner', 'admin', 'analyst', 'reviewer')) then
    raise exception 'el usuario no tiene rol go/no-go';
  end if;
  select * into c from licitaciones.whatsapp_contact where organization_id = p_organization_id and user_id = p_user_id;
  if not found or c.status <> 'activo' then raise exception 'contacto de WhatsApp no activo'; end if;
  insert into licitaciones.whatsapp_action_token (organization_id, user_id, tender_id, action, phone_e164, token_hash, expires_at)
  values (p_organization_id, p_user_id, p_tender_id, p_action, c.phone_e164, p_token_hash, p_expires_at)
  returning id into v_id;
  insert into licitaciones.whatsapp_event_log (organization_id, user_id, tender_id, event, detail)
    values (p_organization_id, p_user_id, p_tender_id, 'token_emitido', p_action);
  return v_id;
end;
$$;

-- Opt-in: SOLO un mensaje entrante del propio numero (atestiguado por la firma de
-- Meta) pasa pendiente -> activo. Una baja explicita NO se revierte con un SI suelto:
-- el usuario debe volver a pedirlo desde el panel.
create or replace function licitaciones.system_whatsapp_confirm_opt_in(p_phone text)
returns integer language plpgsql security definer set search_path = licitaciones, pg_temp as $$
declare n integer;
begin
  if auth.uid() is not null then
    raise exception 'system_whatsapp_confirm_opt_in es solo para la sesión de sistema' using errcode = '42501';
  end if;
  with upd as (
    update licitaciones.whatsapp_contact set status = 'activo', opted_in_at = now()
    where phone_e164 = p_phone and status = 'pendiente' and consent_requested_at is not null
    returning organization_id, user_id
  ), lg as (
    insert into licitaciones.whatsapp_event_log (organization_id, user_id, event, detail)
    select organization_id, user_id, 'opt_in', 'mensaje entrante' from upd
  )
  select count(*) into n from upd;
  return n;
end;
$$;

create or replace function licitaciones.system_whatsapp_opt_out(p_phone text)
returns integer language plpgsql security definer set search_path = licitaciones, pg_temp as $$
declare n integer;
begin
  if auth.uid() is not null then
    raise exception 'system_whatsapp_opt_out es solo para la sesión de sistema' using errcode = '42501';
  end if;
  with upd as (
    update licitaciones.whatsapp_contact set status = 'baja', opted_out_at = now()
    where phone_e164 = p_phone and status <> 'baja'
    returning organization_id, user_id
  ), lg as (
    insert into licitaciones.whatsapp_event_log (organization_id, user_id, event, detail)
    select organization_id, user_id, 'baja', 'mensaje entrante' from upd
  )
  select count(*) into n from upd;
  return n;
end;
$$;

-- Outbox: encolar (idempotente por dedupe_key), reclamar con lease, cerrar.
create or replace function licitaciones.system_enqueue_whatsapp_outbox(
  p_organization_id uuid, p_event_type text, p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = licitaciones, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_enqueue_whatsapp_outbox es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload) <> 'object' or not (p_payload ? 'to') or not (p_payload ? 'body') then
    raise exception 'payload de outbox invalido';
  end if;
  insert into licitaciones.whatsapp_outbox (organization_id, event_type, dedupe_key, payload)
  values (p_organization_id, p_event_type, p_dedupe_key, p_payload)
  on conflict (organization_id, dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function licitaciones.claim_whatsapp_outbox_batch(p_limit integer, p_lease_seconds integer default 120)
returns setof licitaciones.whatsapp_outbox
language plpgsql security definer set search_path = licitaciones, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_whatsapp_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'invalid claim limit'; end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid lease seconds'; end if;
  return query
    update licitaciones.whatsapp_outbox
    set status = 'processing', claimed_at = now()
    where id in (
      select id from licitaciones.whatsapp_outbox
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and claimed_at < now() - make_interval(secs => p_lease_seconds))
      order by created_at
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

-- Al cerrar (enviado o muerto) se BORRA `buttons` del payload: el token en claro solo
-- vive en la cola mientras el mensaje esta pendiente.
create or replace function licitaciones.complete_whatsapp_outbox_sent(p_id uuid) returns void
language plpgsql security definer set search_path = licitaciones, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_whatsapp_outbox_sent es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update licitaciones.whatsapp_outbox set status = 'sent', sent_at = now(), payload = payload - 'buttons'
  where id = p_id and status = 'processing';
end;
$$;

create or replace function licitaciones.complete_whatsapp_outbox_retry(
  p_id uuid, p_attempts integer, p_error_class text, p_next_attempt_at timestamptz
) returns void language plpgsql security definer set search_path = licitaciones, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_whatsapp_outbox_retry es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update licitaciones.whatsapp_outbox
  set status = 'pending', attempts = p_attempts, last_error_class = left(p_error_class, 120), next_attempt_at = p_next_attempt_at, claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

create or replace function licitaciones.complete_whatsapp_outbox_dead(p_id uuid, p_attempts integer, p_error_class text) returns void
language plpgsql security definer set search_path = licitaciones, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_whatsapp_outbox_dead es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update licitaciones.whatsapp_outbox
  set status = 'dead', attempts = p_attempts, last_error_class = left(p_error_class, 120), claimed_at = null, payload = payload - 'buttons'
  where id = p_id and status = 'processing';
end;
$$;

-- GRANT EXECUTE: nada para public/anon. Usuario: authenticated. Sistema: authenticated
-- (guard interno auth.uid() is null) y service_role.
revoke all on function licitaciones.whatsapp_contact_before_update() from public, anon;
revoke all on function licitaciones.whatsapp_request_consent(uuid) from public, anon;
revoke all on function licitaciones.whatsapp_opt_out_self(uuid) from public, anon;
revoke all on function licitaciones.whatsapp_consume_action_token(text, text, text) from public, anon;
revoke all on function licitaciones.system_whatsapp_token_owner(text) from public, anon;
revoke all on function licitaciones.system_whatsapp_active_contacts(uuid, text) from public, anon;
revoke all on function licitaciones.system_issue_whatsapp_action_token(uuid, uuid, uuid, text, text, timestamptz) from public, anon;
revoke all on function licitaciones.system_whatsapp_confirm_opt_in(text) from public, anon;
revoke all on function licitaciones.system_whatsapp_opt_out(text) from public, anon;
revoke all on function licitaciones.system_enqueue_whatsapp_outbox(uuid, text, text, jsonb) from public, anon;
revoke all on function licitaciones.claim_whatsapp_outbox_batch(integer, integer) from public, anon;
revoke all on function licitaciones.complete_whatsapp_outbox_sent(uuid) from public, anon;
revoke all on function licitaciones.complete_whatsapp_outbox_retry(uuid, integer, text, timestamptz) from public, anon;
revoke all on function licitaciones.complete_whatsapp_outbox_dead(uuid, integer, text) from public, anon;
grant execute on function licitaciones.whatsapp_request_consent(uuid) to authenticated, service_role;
grant execute on function licitaciones.whatsapp_opt_out_self(uuid) to authenticated, service_role;
grant execute on function licitaciones.whatsapp_consume_action_token(text, text, text) to authenticated, service_role;
grant execute on function licitaciones.system_whatsapp_token_owner(text) to authenticated, service_role;
grant execute on function licitaciones.system_whatsapp_active_contacts(uuid, text) to authenticated, service_role;
grant execute on function licitaciones.system_issue_whatsapp_action_token(uuid, uuid, uuid, text, text, timestamptz) to authenticated, service_role;
grant execute on function licitaciones.system_whatsapp_confirm_opt_in(text) to authenticated, service_role;
grant execute on function licitaciones.system_whatsapp_opt_out(text) to authenticated, service_role;
grant execute on function licitaciones.system_enqueue_whatsapp_outbox(uuid, text, text, jsonb) to authenticated, service_role;
grant execute on function licitaciones.claim_whatsapp_outbox_batch(integer, integer) to authenticated, service_role;
grant execute on function licitaciones.complete_whatsapp_outbox_sent(uuid) to authenticated, service_role;
grant execute on function licitaciones.complete_whatsapp_outbox_retry(uuid, integer, text, timestamptz) to authenticated, service_role;
grant execute on function licitaciones.complete_whatsapp_outbox_dead(uuid, integer, text) to authenticated, service_role;
