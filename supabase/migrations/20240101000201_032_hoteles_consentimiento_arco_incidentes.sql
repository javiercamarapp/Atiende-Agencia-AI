-- H-02 (P0) — CONSENTIMIENTO + AVISO DE PRIVACIDAD + ARCO + BLOQUEO PREVIO A LA PURGA +
-- RETENCION LEGAL POR INCIDENTE + REGISTRO DE VULNERACIONES.
--
-- AVISO: esto es una implementacion tecnica de las decisiones de producto descritas en
-- el informe de investigacion (atiende-loop/expertos/retencion-identidad-hoteles-mx.md,
-- borrador SIN valor de asesoria legal). Los plazos, la forma del consentimiento, el
-- computo de dias (naturales vs habiles), la prorroga y el aviso de vulneraciones los debe
-- CONFIRMAR UN ABOGADO antes de presentarse al hotel como cumplimiento. Ver
-- packages/domain-hoteles/README.md ("Privacidad: un abogado debe confirmar").
--
-- Se apoya en la boveda de identidad de 031 (NO se edita 031; esta migracion la extiende):
--   * Estado nuevo 'bloqueada' en hoteles.identity_vault: la identidad vencida (o con purga
--     aprobada, o con ARCO de cancelacion procedente) NO se purga de golpe: pasa por una
--     ventana de bloqueo (por defecto 7 dias, editable 3-30 por property) SIN acceso
--     operativo. Solo hay acceso excepcional con doble control y motivo. Despues de la
--     ventana -- y solo si no hay retencion legal activa -- se purga. A nivel de datos
--     (trigger) una identidad solo puede pasar a 'purgado' desde 'bloqueada' con la ventana
--     vencida y sin retencion legal activa: ni un service_role ni una funcion defectuosa
--     pueden saltarse el bloqueo.
--   * hoteles.privacy_notice / identity_consent: bitacora de consentimientos (fecha-hora,
--     version del aviso, finalidades obligatorias vs opcionales, canal, quien capturo).
--   * hoteles.arco_request: solicitudes ARCO con plazos (20 dias + 15 para ejecutar,
--     prorroga documentada una vez) y bitacora.
--   * hoteles.legal_hold: retencion legal por incidente (folio + autorizacion) que impide
--     purgar mientras dure el caso.
--   * hoteles.privacy_incident: registro de vulneraciones con estados y recordatorio de
--     notificar al titular (el sistema NO envia nada: solo registra).
--   * hoteles.privacy_event_log: bitacora append-only de todo lo anterior.
--
-- REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: mergear despliega el codigo de
-- inmediato y esta migracion NO se aplica sola a la base real (docs/DEPLOY.md). Todo el
-- TypeScript que toca estos objetos captura SQLSTATE 42883/42P01/42703 con
-- `runWithSavepointFallback` y degrada a "no disponible aun" (lista vacia / 503) o al
-- camino anterior (barrido de purga de 031), nunca a un 500 ni a romper un flujo vigente.
--
-- Requiere: 031_hoteles_boveda_identidad.sql (hoteles.identity_vault/identity_access_log/
-- identity_purge_request, can_reveal_identity), 005 (can_manage_reservations) y 018
-- (can_manage_catalog).

-- ---------------------------------------------------------------------------
-- 0) Reemplazo de CHECKs de 031 (nombres autogenerados: se localizan por definicion).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select conname from pg_constraint
            where conrelid = 'hoteles.identity_vault'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%purgado%' loop
    execute format('alter table hoteles.identity_vault drop constraint %I', r.conname);
  end loop;
  for r in select conname from pg_constraint
            where conrelid = 'hoteles.identity_access_log'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%purga_por_retencion%' loop
    execute format('alter table hoteles.identity_access_log drop constraint %I', r.conname);
  end loop;
  for r in select conname from pg_constraint
            where conrelid = 'hoteles.identity_purge_request'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%ejecutada%' loop
    execute format('alter table hoteles.identity_purge_request drop constraint %I', r.conname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1) Boveda: estado 'bloqueada' + columnas de bloqueo.
-- ---------------------------------------------------------------------------
alter table hoteles.identity_vault
  add column blocked_at timestamptz,
  add column blocked_until timestamptz,
  add column block_window_days smallint check (block_window_days is null or block_window_days between 3 and 30),
  add column block_reason text check (block_reason is null or block_reason in ('retencion_vencida', 'solicitud_purga', 'arco', 'manual')),
  add column blocked_by uuid references core.staff_user(id);

alter table hoteles.identity_vault
  add constraint identity_vault_status_check check (status in ('activo', 'bloqueada', 'purgado'));
-- Estado coherente: activo = sobre presente y sin bloqueo; bloqueada = sobre presente (se
-- conserva identificado, sin tratamiento, hasta vencer la ventana) y TODOS los datos del
-- bloqueo; purgado = TODO dato personal anulado (el rastro del bloqueo se conserva).
alter table hoteles.identity_vault
  add constraint identity_vault_estado_coherente check (
    (status = 'activo' and payload_enc is not null and purged_at is null and blocked_at is null)
    or (status = 'bloqueada' and payload_enc is not null and purged_at is null and blocked_at is not null
        and blocked_until is not null and block_window_days is not null and block_reason is not null)
    or (status = 'purgado' and payload_enc is null and document_last4 is null and nationality is null and purged_at is not null)
  );
create index identity_vault_blocked_idx on hoteles.identity_vault (property_id, blocked_until) where status = 'bloqueada';

-- Justificacion de seguridad del GRANT: son metadatos de operacion (cuando se bloqueo, hasta
-- cuando, por que); NO incluyen el sobre cifrado. El SELECT sigue limitado por la policy de
-- 031 (front-of-house de la property).
grant select (blocked_at, blocked_until, block_window_days, block_reason, blocked_by) on hoteles.identity_vault to authenticated;

alter table hoteles.identity_access_log
  add constraint identity_access_log_action_check check (action in (
    'captura', 'verificacion', 'revelacion', 'purga_solicitada', 'purga_aprobada', 'purga_rechazada', 'purga_por_retencion',
    'bloqueo', 'purga_por_bloqueo_vencido',
    'acceso_excepcional_solicitado', 'acceso_excepcional_aprobado', 'acceso_excepcional_rechazado', 'acceso_excepcional_revelacion',
    'retencion_legal_aplicada', 'retencion_legal_liberada'));

-- 'en_bloqueo' = purga aprobada con doble control: la identidad esta bloqueada y se purgara al
-- vencer la ventana (la solicitud pasa a 'ejecutada' cuando la purga ocurre).
alter table hoteles.identity_purge_request
  add constraint identity_purge_request_status_check check (status in ('pendiente', 'ejecutada', 'rechazada', 'en_bloqueo'));

-- ---------------------------------------------------------------------------
-- 2) Bitacora append-only de privacidad (ARCO, incidentes, retencion legal, aviso,
--    consentimientos, configuracion). Sin GRANT de escritura: solo codigo security definer.
-- ---------------------------------------------------------------------------
create table hoteles.privacy_event_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  subject_type text not null check (subject_type in ('arco', 'incidente', 'retencion_legal', 'aviso', 'consentimiento', 'configuracion', 'acceso_excepcional')),
  subject_id uuid,
  -- NULL = sesion de sistema.
  actor_user_id uuid references core.staff_user(id),
  action text not null check (length(action) between 1 and 60),
  note text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now()
);
create index privacy_event_log_subject_idx on hoteles.privacy_event_log (property_id, subject_type, subject_id, created_at desc);

create or replace function hoteles.privacy_event_log_immutable()
returns trigger language plpgsql set search_path = hoteles, pg_temp as $$
begin
  raise exception 'privacy_event_log es append-only' using errcode = '42501';
end;
$$;
create trigger privacy_event_log_no_update_trg
  before update on hoteles.privacy_event_log
  for each row execute function hoteles.privacy_event_log_immutable();

-- Helper interno: unico punto que inserta en la bitacora. No es invocable por clientes.
create or replace function hoteles.privacy_log_event(p_org uuid, p_property uuid, p_subject_type text, p_subject_id uuid, p_action text, p_note text)
returns void language sql security definer set search_path = core, hoteles, pg_temp as $$
  insert into hoteles.privacy_event_log (organization_id, property_id, subject_type, subject_id, actor_user_id, action, note)
  values (p_org, p_property, p_subject_type, p_subject_id, auth.uid(), p_action, p_note)
$$;
revoke all on function hoteles.privacy_log_event(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Configuracion: ventana de bloqueo por property (default 7 dias, editable 3-30).
-- ---------------------------------------------------------------------------
create table hoteles.privacy_settings (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  block_window_days smallint not null default 7 check (block_window_days between 3 and 30),
  updated_by uuid references core.staff_user(id),
  updated_at timestamptz not null default now()
);

create or replace function hoteles.identity_block_window(p_property_id uuid)
returns smallint language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select coalesce((select block_window_days from hoteles.privacy_settings where property_id = p_property_id), 7::smallint)
$$;
revoke all on function hoteles.identity_block_window(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Aviso de privacidad versionado + bitacora de consentimientos.
-- ---------------------------------------------------------------------------
create table hoteles.privacy_notice (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  version text not null check (length(btrim(version)) between 1 and 40),
  -- Aviso simplificado (se muestra en el punto de captura) y enlace al integral.
  simplified_text text not null check (length(btrim(simplified_text)) between 20 and 2000),
  integral_url text check (integral_url is null or (length(integral_url) <= 500 and integral_url ~ '^https://')),
  mandatory_purposes text[] not null check (cardinality(mandatory_purposes) between 1 and 10),
  optional_purposes text[] not null default '{}' check (cardinality(optional_purposes) <= 10),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  is_current boolean not null default true,
  published_by uuid references core.staff_user(id),
  published_at timestamptz not null default now(),
  unique (property_id, version)
);
create unique index privacy_notice_one_current_idx on hoteles.privacy_notice (property_id) where is_current;

-- Un aviso publicado es evidencia: solo puede dejar de ser el vigente.
create or replace function hoteles.privacy_notice_guard()
returns trigger language plpgsql set search_path = hoteles, pg_temp as $$
begin
  if (new.id, new.organization_id, new.property_id, new.version, new.simplified_text, new.integral_url,
      new.mandatory_purposes, new.optional_purposes, new.content_sha256, new.published_by, new.published_at)
     is distinct from
     (old.id, old.organization_id, old.property_id, old.version, old.simplified_text, old.integral_url,
      old.mandatory_purposes, old.optional_purposes, old.content_sha256, old.published_by, old.published_at) then
    raise exception 'privacy_notice: un aviso publicado es inmutable; publica una version nueva' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger privacy_notice_guard_trg
  before update on hoteles.privacy_notice
  for each row execute function hoteles.privacy_notice_guard();

create table hoteles.identity_consent (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  guest_id uuid not null references hoteles.guest(id) on delete cascade,
  -- Liga a la captura de identidad (nullable: el consentimiento puede registrarse sin
  -- documento, y la liga se anula si la identidad se borra).
  vault_id uuid references hoteles.identity_vault(id) on delete set null,
  notice_id uuid not null references hoteles.privacy_notice(id),
  -- Version del aviso ACEPTADO, copiada por el trigger desde el aviso (no la manda el cliente).
  notice_version text not null,
  accepted_mandatory text[] not null check (cardinality(accepted_mandatory) >= 1),
  accepted_optional text[] not null default '{}',
  channel text not null check (channel in ('mostrador', 'tableta', 'qr', 'whatsapp', 'web', 'telefono', 'otro')),
  evidence_method text not null check (evidence_method in ('aviso_simplificado_mostrado', 'casilla_electronica', 'firma_electronica', 'firma_autografa', 'mecanismo_autenticacion')),
  -- Datos sensibles (p. ej. biometricos, salud): consentimiento EXPRESO Y POR ESCRITO (firma
  -- autografa/electronica o mecanismo de autenticacion), nunca solo "aviso mostrado".
  sensitive_data boolean not null default false,
  consented_at timestamptz not null default now(),
  captured_by uuid references core.staff_user(id),
  revoked_at timestamptz,
  revoked_by uuid references core.staff_user(id),
  revoke_reason text check (revoke_reason is null or length(revoke_reason) between 10 and 300),
  check (not sensitive_data or evidence_method in ('firma_electronica', 'firma_autografa', 'mecanismo_autenticacion')),
  check ((revoked_at is null and revoked_by is null and revoke_reason is null) or (revoked_at is not null and revoked_by is not null and revoke_reason is not null))
);
create index identity_consent_guest_idx on hoteles.identity_consent (guest_id, consented_at desc);
create index identity_consent_vault_idx on hoteles.identity_consent (vault_id) where vault_id is not null;
create index identity_consent_property_idx on hoteles.identity_consent (property_id, consented_at desc);

-- Guarda del ledger (security definer, search_path fijo). INSERT: deriva organization_id de
-- core.property, exige huesped/identidad/aviso de la MISMA property (cross-tenant), copia la
-- version del aviso, exige que se acepten TODAS las finalidades obligatorias del aviso y que
-- las opcionales sean un subconjunto de las del aviso, y sella captured_by/consented_at.
-- UPDATE: solo la revocacion (una vez); todo lo demas es inmutable (es evidencia).
create or replace function hoteles.identity_consent_guard()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_guest_property uuid;
  v_notice record;
  v_vault record;
begin
  if TG_OP = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
    end if;
    select property_id into v_guest_property from hoteles.guest where id = new.guest_id;
    if v_guest_property is distinct from new.property_id then
      raise exception 'guest_invalido: el huesped no pertenece a la property' using errcode = '23503';
    end if;
    select property_id, version, mandatory_purposes, optional_purposes into v_notice from hoteles.privacy_notice where id = new.notice_id;
    if v_notice.property_id is distinct from new.property_id then
      raise exception 'aviso_invalido: el aviso no pertenece a la property' using errcode = '23503';
    end if;
    if new.vault_id is not null then
      select property_id, guest_id into v_vault from hoteles.identity_vault where id = new.vault_id;
      if v_vault.property_id is distinct from new.property_id or v_vault.guest_id is distinct from new.guest_id then
        raise exception 'identidad_invalida: la identidad no corresponde a la property/huesped' using errcode = '23503';
      end if;
    end if;
    if not (new.accepted_mandatory @> v_notice.mandatory_purposes and new.accepted_mandatory <@ v_notice.mandatory_purposes) then
      raise exception 'finalidades_obligatorias: se deben aceptar exactamente las finalidades obligatorias del aviso' using errcode = '22023';
    end if;
    if not (new.accepted_optional <@ v_notice.optional_purposes) then
      raise exception 'finalidades_opcionales: hay finalidades que no estan en el aviso' using errcode = '22023';
    end if;
    new.organization_id := v_org;
    new.notice_version := v_notice.version;
    new.captured_by := auth.uid();
    new.consented_at := now();
    new.revoked_at := null;
    new.revoked_by := null;
    new.revoke_reason := null;
    return new;
  end if;

  -- UPDATE
  if old.revoked_at is not null then
    raise exception 'consentimiento_revocado: un consentimiento revocado es inmutable' using errcode = '42501';
  end if;
  if (new.id, new.organization_id, new.property_id, new.guest_id, new.vault_id, new.notice_id, new.notice_version,
      new.accepted_mandatory, new.accepted_optional, new.channel, new.evidence_method, new.sensitive_data, new.consented_at, new.captured_by)
     is distinct from
     (old.id, old.organization_id, old.property_id, old.guest_id, old.vault_id, old.notice_id, old.notice_version,
      old.accepted_mandatory, old.accepted_optional, old.channel, old.evidence_method, old.sensitive_data, old.consented_at, old.captured_by) then
    raise exception 'identity_consent: el ledger es append-only; solo se puede revocar' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function hoteles.identity_consent_guard() from public, anon;
create trigger identity_consent_guard_trg
  before insert or update on hoteles.identity_consent
  for each row execute function hoteles.identity_consent_guard();

-- ---------------------------------------------------------------------------
-- 5) Incidentes / vulneraciones (registro; el sistema NO notifica a nadie).
-- ---------------------------------------------------------------------------
create table hoteles.privacy_incident (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  folio text not null check (length(folio) between 3 and 60),
  incident_type text not null check (incident_type in ('acceso_no_autorizado', 'perdida_robo', 'alteracion', 'divulgacion', 'otro')),
  severity text not null check (severity in ('baja', 'media', 'alta')),
  title text not null check (length(btrim(title)) between 3 and 120),
  description text not null check (length(btrim(description)) between 10 and 1000),
  detected_at timestamptz not null,
  affected_count integer check (affected_count is null or affected_count >= 0),
  -- Art. 19 LFPDPPP: vulneraciones que afecten de forma significativa derechos patrimoniales o
  -- morales se notifican al titular de forma inmediata. Esta bandera la decide el staff (con
  -- su abogado); activa el recordatorio. NO dispara ningun envio.
  significant_risk boolean not null default false,
  status text not null default 'detectada' check (status in ('detectada', 'contenida', 'cerrada')),
  contained_at timestamptz,
  notified_at timestamptz,
  notified_by uuid references core.staff_user(id),
  notification_channel text check (notification_channel is null or length(btrim(notification_channel)) between 2 and 60),
  notification_ref text check (notification_ref is null or length(btrim(notification_ref)) between 1 and 200),
  no_notification_reason text check (no_notification_reason is null or length(btrim(no_notification_reason)) between 10 and 300),
  closed_at timestamptz,
  closed_by uuid references core.staff_user(id),
  closing_note text check (closing_note is null or length(btrim(closing_note)) between 10 and 300),
  reported_by uuid references core.staff_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, folio),
  check ((status = 'cerrada') = (closed_at is not null)),
  check (status <> 'contenida' or contained_at is not null),
  check ((notified_at is null) = (notified_by is null))
);
create index privacy_incident_property_idx on hoteles.privacy_incident (property_id, status, detected_at desc);

-- ---------------------------------------------------------------------------
-- 6) Retencion legal ("legal hold"): impide purgar una identidad mientras dure el caso.
-- ---------------------------------------------------------------------------
create table hoteles.legal_hold (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  vault_id uuid not null references hoteles.identity_vault(id) on delete cascade,
  incident_id uuid references hoteles.privacy_incident(id) on delete set null,
  -- Folio del caso (carpeta de investigacion, expediente, folio interno de incidente).
  folio text not null check (length(btrim(folio)) between 3 and 60),
  reason text not null check (length(btrim(reason)) between 10 and 300),
  -- Quien/que autoriza la retencion (oficio, area juridica, direccion). Texto libre, obligatorio.
  authorization_ref text not null check (length(btrim(authorization_ref)) between 3 and 200),
  status text not null default 'activa' check (status in ('activa', 'liberada')),
  placed_by uuid not null references core.staff_user(id),
  placed_at timestamptz not null default now(),
  -- Revision anual obligatoria del hold (fecha limite para revisarlo).
  review_due_on date not null,
  released_by uuid references core.staff_user(id),
  released_at timestamptz,
  release_note text check (release_note is null or length(btrim(release_note)) between 10 and 300),
  check ((status = 'activa' and released_at is null and released_by is null) or (status = 'liberada' and released_at is not null and released_by is not null and release_note is not null))
);
create unique index legal_hold_one_active_per_case_idx on hoteles.legal_hold (property_id, folio, vault_id) where status = 'activa';
create index legal_hold_vault_active_idx on hoteles.legal_hold (vault_id) where status = 'activa';
create index legal_hold_property_idx on hoteles.legal_hold (property_id, status, placed_at desc);

-- ---------------------------------------------------------------------------
-- 7) Solicitudes ARCO (acceso, rectificacion, cancelacion, oposicion).
-- ---------------------------------------------------------------------------
create table hoteles.arco_request (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  folio text not null check (length(folio) between 3 and 60),
  right_type text not null check (right_type in ('acceso', 'rectificacion', 'cancelacion', 'oposicion')),
  guest_id uuid references hoteles.guest(id) on delete set null,
  vault_id uuid references hoteles.identity_vault(id) on delete set null,
  requester_name text not null check (length(btrim(requester_name)) between 2 and 200),
  requester_contact text check (requester_contact is null or length(btrim(requester_contact)) between 3 and 200),
  channel text not null check (channel in ('mostrador', 'correo', 'whatsapp', 'web', 'telefono', 'otro')),
  description text check (description is null or length(description) <= 1000),
  received_on date not null,
  -- Plazos (dias NATURALES, el computo mas conservador; habiles vs naturales lo confirma un
  -- abogado): respuesta = recepcion + 20; ejecucion = decision de procedencia + 15.
  response_due_on date not null,
  execution_due_on date,
  status text not null default 'recibida' check (status in ('recibida', 'en_revision', 'procedente', 'improcedente', 'ejecutada')),
  decided_on date,
  decision_note text check (decision_note is null or length(decision_note) <= 300),
  -- Prorroga: una sola vez, por igual plazo que la fase abierta, con motivo documentado.
  extension_phase text check (extension_phase is null or extension_phase in ('respuesta', 'ejecucion')),
  extension_reason text check (extension_reason is null or length(btrim(extension_reason)) between 10 and 300),
  extended_at timestamptz,
  extended_by uuid references core.staff_user(id),
  executed_at timestamptz,
  created_by uuid references core.staff_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, folio),
  check ((extension_phase is null and extension_reason is null and extended_at is null and extended_by is null)
      or (extension_phase is not null and extension_reason is not null and extended_at is not null and extended_by is not null)),
  check (response_due_on >= received_on),
  check (status not in ('procedente', 'ejecutada') or (decided_on is not null and execution_due_on is not null)),
  check ((status = 'ejecutada') = (executed_at is not null))
);
create index arco_request_property_idx on hoteles.arco_request (property_id, status, response_due_on);

-- ---------------------------------------------------------------------------
-- 8) Acceso excepcional a una identidad BLOQUEADA (doble control + motivo + un solo uso).
-- ---------------------------------------------------------------------------
create table hoteles.identity_blocked_access_request (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  vault_id uuid not null references hoteles.identity_vault(id) on delete cascade,
  requested_by uuid not null references core.staff_user(id),
  reason text not null check (length(btrim(reason)) between 10 and 300),
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobada', 'rechazada', 'usada')),
  decided_by uuid references core.staff_user(id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 300),
  -- La aprobacion caduca (2 horas) y se consume al revelar (un solo uso).
  expires_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  -- DOBLE CONTROL a nivel de datos: quien decide nunca es quien solicito.
  check (decided_by is null or decided_by <> requested_by),
  check ((status = 'pendiente' and decided_at is null) or (status <> 'pendiente' and decided_at is not null)),
  check (status not in ('aprobada', 'usada') or expires_at is not null),
  check ((status = 'usada') = (used_at is not null))
);
create unique index identity_blocked_access_one_open_idx on hoteles.identity_blocked_access_request (vault_id) where status in ('pendiente', 'aprobada');
create index identity_blocked_access_property_idx on hoteles.identity_blocked_access_request (property_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 9) Guarda de la boveda (reemplaza la de 031): ademas de lo anterior,
--    - la purga SOLO es posible desde 'bloqueada' con la ventana vencida y sin retencion
--      legal activa (defensa en profundidad: las funciones ya lo cumplen);
--    - el bloqueo no se revierte ni se reescribe.
-- ---------------------------------------------------------------------------
create or replace function hoteles.identity_vault_guard()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_guest_property uuid;
  v_res_property uuid;
begin
  if TG_OP = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
    end if;
    select property_id into v_guest_property from hoteles.guest where id = new.guest_id;
    if v_guest_property is distinct from new.property_id then
      raise exception 'guest_invalido: el huesped no pertenece a la property' using errcode = '23503';
    end if;
    if new.reservation_id is not null then
      select property_id into v_res_property from hoteles.reservation where id = new.reservation_id;
      if v_res_property is distinct from new.property_id then
        raise exception 'reserva_invalida: la reserva no pertenece a la property' using errcode = '23503';
      end if;
    end if;
    new.organization_id := v_org;
    new.status := 'activo';
    new.captured_by := auth.uid();
    new.verified_at := null;
    new.verified_by := null;
    new.purged_at := null;
    new.blocked_at := null;
    new.blocked_until := null;
    new.block_window_days := null;
    new.block_reason := null;
    new.blocked_by := null;
    new.created_at := now();
    return new;
  end if;

  -- UPDATE
  if old.status = 'purgado' then
    raise exception 'identidad_purgada: una identidad purgada es inmutable' using errcode = '42501';
  end if;
  if new.id <> old.id or new.organization_id <> old.organization_id or new.property_id <> old.property_id
     or new.guest_id <> old.guest_id or new.captured_by is distinct from old.captured_by then
    raise exception 'identity_vault: ids y ligas son inmutables' using errcode = '42501';
  end if;
  if new.payload_enc is distinct from old.payload_enc and not (new.status = 'purgado' and new.payload_enc is null) then
    raise exception 'identity_vault: el sobre cifrado no se reescribe, solo se anula al purgar' using errcode = '42501';
  end if;
  if old.status = 'bloqueada' and new.status = 'activo' then
    raise exception 'identidad_bloqueada: el bloqueo no se revierte' using errcode = '42501';
  end if;
  if old.status = 'bloqueada' and new.status = 'bloqueada'
     and (new.blocked_at is distinct from old.blocked_at or new.blocked_until is distinct from old.blocked_until
          or new.block_window_days is distinct from old.block_window_days or new.block_reason is distinct from old.block_reason
          or new.blocked_by is distinct from old.blocked_by) then
    raise exception 'identidad_bloqueada: los datos del bloqueo no se reescriben' using errcode = '42501';
  end if;
  if new.status = 'purgado' then
    if old.status <> 'bloqueada' then
      raise exception 'purga_sin_bloqueo: una identidad solo se purga despues de su ventana de bloqueo' using errcode = '42501';
    end if;
    if old.blocked_until > now() then
      raise exception 'bloqueo_vigente: la ventana de bloqueo aun no vence' using errcode = '42501';
    end if;
    if exists (select 1 from hoteles.legal_hold h where h.vault_id = old.id and h.status = 'activa') then
      raise exception 'retencion_legal: la identidad tiene una retencion legal activa' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) RLS + GRANT (todas las tablas nuevas)
-- ---------------------------------------------------------------------------
alter table hoteles.privacy_event_log enable row level security;
alter table hoteles.privacy_settings enable row level security;
alter table hoteles.privacy_notice enable row level security;
alter table hoteles.identity_consent enable row level security;
alter table hoteles.privacy_incident enable row level security;
alter table hoteles.legal_hold enable row level security;
alter table hoteles.arco_request enable row level security;
alter table hoteles.identity_blocked_access_request enable row level security;

-- Bitacora, ajustes, incidentes, retenciones legales, ARCO y accesos excepcionales: SELECT
-- solo owner/gm (can_manage_catalog): contienen datos de titulares y de auditoria, no son
-- operativos. Sin GRANT/policy de escritura para authenticated: se escribe solo via funciones
-- security definer (validan rol, property y reglas de negocio).
create policy "privacidad: owner/gm leen la bitacora" on hoteles.privacy_event_log for select using (hoteles.can_manage_catalog(property_id));
create policy "privacidad: owner/gm leen los ajustes" on hoteles.privacy_settings for select using (hoteles.can_manage_catalog(property_id));
create policy "privacidad: owner/gm leen incidentes" on hoteles.privacy_incident for select using (hoteles.can_manage_catalog(property_id));
create policy "privacidad: owner/gm leen retenciones legales" on hoteles.legal_hold for select using (hoteles.can_manage_catalog(property_id));
create policy "privacidad: owner/gm leen solicitudes ARCO" on hoteles.arco_request for select using (hoteles.can_manage_catalog(property_id));
create policy "privacidad: owner/gm leen accesos excepcionales" on hoteles.identity_blocked_access_request for select using (hoteles.can_manage_catalog(property_id));

-- Aviso de privacidad: front-of-house lo lee (lo muestra en el punto de captura); se publica
-- solo con publish_privacy_notice (owner/gm).
create policy "privacidad: front-of-house lee el aviso" on hoteles.privacy_notice for select using (hoteles.can_manage_reservations(property_id));

-- Ledger de consentimientos: front-of-house (quien captura la identidad) lo lee y lo inserta.
-- SIN UPDATE/DELETE para authenticated: la revocacion pasa por revoke_identity_consent.
create policy "consentimiento: front-of-house lee el ledger" on hoteles.identity_consent for select using (hoteles.can_manage_reservations(property_id));
create policy "consentimiento: front-of-house registra consentimientos" on hoteles.identity_consent for insert with check (hoteles.can_manage_reservations(property_id));

revoke all on hoteles.privacy_event_log from public, anon;
revoke all on hoteles.privacy_settings from public, anon;
revoke all on hoteles.privacy_notice from public, anon;
revoke all on hoteles.identity_consent from public, anon;
revoke all on hoteles.privacy_incident from public, anon;
revoke all on hoteles.legal_hold from public, anon;
revoke all on hoteles.arco_request from public, anon;
revoke all on hoteles.identity_blocked_access_request from public, anon;

grant select on hoteles.privacy_event_log, hoteles.privacy_settings, hoteles.privacy_notice, hoteles.privacy_incident,
  hoteles.legal_hold, hoteles.arco_request, hoteles.identity_blocked_access_request to authenticated;
grant select on hoteles.identity_consent to authenticated;
-- INSERT a nivel columna: solo lo que la captura real escribe. organization_id,
-- notice_version, captured_by, consented_at y revoked_* los fija el trigger.
grant insert (id, property_id, guest_id, vault_id, notice_id, accepted_mandatory, accepted_optional, channel, evidence_method, sensitive_data)
  on hoteles.identity_consent to authenticated;
grant select on hoteles.privacy_event_log, hoteles.privacy_settings, hoteles.privacy_notice, hoteles.identity_consent, hoteles.privacy_incident,
  hoteles.legal_hold, hoteles.arco_request, hoteles.identity_blocked_access_request to service_role;

-- ---------------------------------------------------------------------------
-- 11) Funciones (security definer, search_path fijo, revoke de public/anon, execute a
--     authenticated; la autoridad es auth.uid() de la sesion, nunca un parametro).
-- ---------------------------------------------------------------------------

-- Bloqueo interno (NO invocable por clientes): pasa una identidad ACTIVA a 'bloqueada' con la
-- ventana de la property. Devuelve true si bloqueo. Lo usan el barrido, la aprobacion de
-- purga, ARCO de cancelacion y block_identity.
create or replace function hoteles.block_identity_internal(p_vault_id uuid, p_reason text, p_actor uuid, p_note text)
returns boolean language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_vault record;
  v_window smallint;
begin
  select id, organization_id, property_id, status into v_vault from hoteles.identity_vault where id = p_vault_id for update;
  if not found or v_vault.status <> 'activo' then
    return false;
  end if;
  v_window := hoteles.identity_block_window(v_vault.property_id);
  update hoteles.identity_vault
     set status = 'bloqueada', blocked_at = now(), blocked_until = now() + make_interval(days => v_window),
         block_window_days = v_window, block_reason = p_reason, blocked_by = p_actor
   where id = p_vault_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_vault.organization_id, v_vault.property_id, p_vault_id, p_actor, 'bloqueo', left(coalesce(p_note, p_reason), 300));
  return true;
end;
$$;
revoke all on function hoteles.block_identity_internal(uuid, text, uuid, text) from public, anon, authenticated;

-- block_identity: owner/gm bloquean a mano UNA identidad activa (p. ej. incidente, ARCO).
create or replace function hoteles.block_identity(p_vault_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_prop uuid;
  v_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null then
    raise exception 'block_identity: requiere sesion de staff' using errcode = '42501';
  end if;
  select property_id, status into v_prop, v_status from hoteles.identity_vault where id = p_vault_id;
  if v_prop is null or not hoteles.can_manage_catalog(v_prop) then
    raise exception 'identidad no disponible' using errcode = '42501';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'motivo_invalido: el motivo debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  if v_status = 'purgado' then
    raise exception 'identidad_purgada: la identidad ya fue purgada' using errcode = 'P0001';
  end if;
  if v_status = 'bloqueada' then
    raise exception 'identidad_bloqueada: la identidad ya esta bloqueada' using errcode = 'P0001';
  end if;
  perform hoteles.block_identity_internal(p_vault_id, 'manual', auth.uid(), v_reason);
end;
$$;
revoke all on function hoteles.block_identity(uuid, text) from public, anon;
grant execute on function hoteles.block_identity(uuid, text) to authenticated;

-- set_identity_block_window: owner/gm fijan la ventana (3-30 dias) de SU property. Queda en la
-- bitacora quien la cambio y de que valor a que valor.
create or replace function hoteles.set_identity_block_window(p_property_id uuid, p_days integer)
returns void language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_old smallint;
begin
  if auth.uid() is null then
    raise exception 'set_identity_block_window: requiere sesion de staff' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'property no disponible' using errcode = '42501';
  end if;
  if p_days is null or p_days < 3 or p_days > 30 then
    raise exception 'ventana_invalida: la ventana de bloqueo debe estar entre 3 y 30 dias' using errcode = '22023';
  end if;
  v_old := hoteles.identity_block_window(p_property_id);
  insert into hoteles.privacy_settings (property_id, organization_id, block_window_days, updated_by, updated_at)
  values (p_property_id, v_org, p_days, auth.uid(), now())
  on conflict (property_id) do update set block_window_days = excluded.block_window_days, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform hoteles.privacy_log_event(v_org, p_property_id, 'configuracion', p_property_id, 'ventana_bloqueo', 'de ' || v_old || ' a ' || p_days || ' dias');
end;
$$;
revoke all on function hoteles.set_identity_block_window(uuid, integer) from public, anon;
grant execute on function hoteles.set_identity_block_window(uuid, integer) to authenticated;

-- publish_privacy_notice: owner/gm publican una version NUEVA del aviso (la anterior deja de
-- ser la vigente pero se conserva: los consentimientos apuntan a la version que aceptaron).
create or replace function hoteles.publish_privacy_notice(
  p_property_id uuid, p_version text, p_simplified_text text, p_mandatory text[], p_optional text[], p_integral_url text, p_content_sha256 text)
returns uuid language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_id uuid;
  v_version text := btrim(coalesce(p_version, ''));
  v_optional text[] := coalesce(p_optional, '{}');
begin
  if auth.uid() is null then
    raise exception 'publish_privacy_notice: requiere sesion de staff' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'property no disponible' using errcode = '42501';
  end if;
  if length(v_version) < 1 or length(v_version) > 40 then
    raise exception 'version_invalida: la version debe tener entre 1 y 40 caracteres' using errcode = '22023';
  end if;
  if p_mandatory is null or cardinality(p_mandatory) < 1 or cardinality(p_mandatory) > 10 or cardinality(v_optional) > 10 then
    raise exception 'finalidades_invalidas: 1 a 10 obligatorias y hasta 10 opcionales' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_mandatory || v_optional) x where x is null or length(btrim(x)) not between 3 and 120) then
    raise exception 'finalidades_invalidas: cada finalidad debe tener entre 3 y 120 caracteres' using errcode = '22023';
  end if;
  if p_mandatory && v_optional then
    raise exception 'finalidades_invalidas: una finalidad no puede ser obligatoria y opcional a la vez' using errcode = '22023';
  end if;
  update hoteles.privacy_notice set is_current = false where property_id = p_property_id and is_current;
  insert into hoteles.privacy_notice (organization_id, property_id, version, simplified_text, integral_url, mandatory_purposes, optional_purposes, content_sha256, published_by)
  values (v_org, p_property_id, v_version, p_simplified_text, nullif(btrim(coalesce(p_integral_url, '')), ''), p_mandatory, v_optional, nullif(btrim(coalesce(p_content_sha256, '')), ''), auth.uid())
  returning id into v_id;
  perform hoteles.privacy_log_event(v_org, p_property_id, 'aviso', v_id, 'aviso_publicado', 'version ' || v_version);
  return v_id;
end;
$$;
revoke all on function hoteles.publish_privacy_notice(uuid, text, text, text[], text[], text, text) from public, anon;
grant execute on function hoteles.publish_privacy_notice(uuid, text, text, text[], text[], text, text) to authenticated;

-- revoke_identity_consent: front-of-house registra la revocacion pedida por el titular (art. 7,
-- el consentimiento es revocable). Se conserva la fila (evidencia); solo se sella la revocacion.
create or replace function hoteles.revoke_identity_consent(p_consent_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_c record;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null then
    raise exception 'revoke_identity_consent: requiere sesion de staff' using errcode = '42501';
  end if;
  select id, organization_id, property_id, revoked_at into v_c from hoteles.identity_consent where id = p_consent_id for update;
  if not found or not hoteles.can_manage_reservations(v_c.property_id) then
    raise exception 'consentimiento no disponible' using errcode = '42501';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'motivo_invalido: el motivo debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  if v_c.revoked_at is not null then
    raise exception 'consentimiento_revocado: el consentimiento ya fue revocado' using errcode = 'P0001';
  end if;
  update hoteles.identity_consent set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = v_reason where id = p_consent_id;
  perform hoteles.privacy_log_event(v_c.organization_id, v_c.property_id, 'consentimiento', p_consent_id, 'consentimiento_revocado', v_reason);
end;
$$;
revoke all on function hoteles.revoke_identity_consent(uuid, text) from public, anon;
grant execute on function hoteles.revoke_identity_consent(uuid, text) to authenticated;

-- ---- Retencion legal ----

create or replace function hoteles.place_legal_hold(p_vault_id uuid, p_folio text, p_reason text, p_authorization_ref text, p_incident_id uuid)
returns uuid language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_prop uuid;
  v_status text;
  v_inc_prop uuid;
  v_folio text := btrim(coalesce(p_folio, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_auth text := btrim(coalesce(p_authorization_ref, ''));
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'place_legal_hold: requiere sesion de staff' using errcode = '42501';
  end if;
  select organization_id, property_id, status into v_org, v_prop, v_status from hoteles.identity_vault where id = p_vault_id;
  if v_prop is null or not hoteles.can_manage_catalog(v_prop) then
    raise exception 'identidad no disponible' using errcode = '42501';
  end if;
  if length(v_folio) < 3 or length(v_folio) > 60 then
    raise exception 'folio_invalido: el folio del caso debe tener entre 3 y 60 caracteres' using errcode = '22023';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'motivo_invalido: el motivo debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  if length(v_auth) < 3 or length(v_auth) > 200 then
    raise exception 'autorizacion_invalida: indica quien autoriza la retencion (3 a 200 caracteres)' using errcode = '22023';
  end if;
  if v_status = 'purgado' then
    raise exception 'identidad_purgada: la identidad ya fue purgada; no hay nada que retener' using errcode = 'P0001';
  end if;
  if p_incident_id is not null then
    select property_id into v_inc_prop from hoteles.privacy_incident where id = p_incident_id;
    if v_inc_prop is distinct from v_prop then
      raise exception 'incidente_invalido: el incidente no pertenece a la property' using errcode = '23503';
    end if;
  end if;
  insert into hoteles.legal_hold (organization_id, property_id, vault_id, incident_id, folio, reason, authorization_ref, placed_by, review_due_on)
  values (v_org, v_prop, p_vault_id, p_incident_id, v_folio, v_reason, v_auth, auth.uid(), ((now() at time zone 'utc')::date + 365))
  returning id into v_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_org, v_prop, p_vault_id, auth.uid(), 'retencion_legal_aplicada', 'folio ' || v_folio);
  perform hoteles.privacy_log_event(v_org, v_prop, 'retencion_legal', v_id, 'retencion_aplicada', 'folio ' || v_folio);
  return v_id;
end;
$$;
revoke all on function hoteles.place_legal_hold(uuid, text, text, text, uuid) from public, anon;
grant execute on function hoteles.place_legal_hold(uuid, text, text, text, uuid) to authenticated;

create or replace function hoteles.release_legal_hold(p_hold_id uuid, p_note text)
returns void language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_h record;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if auth.uid() is null then
    raise exception 'release_legal_hold: requiere sesion de staff' using errcode = '42501';
  end if;
  select * into v_h from hoteles.legal_hold where id = p_hold_id for update;
  if not found or not hoteles.can_manage_catalog(v_h.property_id) then
    raise exception 'retencion no disponible' using errcode = '42501';
  end if;
  if length(v_note) < 10 or length(v_note) > 300 then
    raise exception 'nota_invalida: la nota de liberacion debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  if v_h.status <> 'activa' then
    raise exception 'retencion_liberada: la retencion ya fue liberada' using errcode = 'P0001';
  end if;
  update hoteles.legal_hold set status = 'liberada', released_by = auth.uid(), released_at = now(), release_note = v_note where id = p_hold_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_h.organization_id, v_h.property_id, v_h.vault_id, auth.uid(), 'retencion_legal_liberada', 'folio ' || v_h.folio);
  perform hoteles.privacy_log_event(v_h.organization_id, v_h.property_id, 'retencion_legal', p_hold_id, 'retencion_liberada', v_note);
end;
$$;
revoke all on function hoteles.release_legal_hold(uuid, text) from public, anon;
grant execute on function hoteles.release_legal_hold(uuid, text) to authenticated;

-- ---- Incidentes / vulneraciones ----

-- report_privacy_incident: cualquier front-of-house (can_manage_reservations) PUEDE REPORTAR (lo
-- que ve el personal en el momento); owner/gm los gestionan y leen.
create or replace function hoteles.report_privacy_incident(
  p_property_id uuid, p_incident_type text, p_severity text, p_title text, p_description text,
  p_detected_at timestamptz, p_affected_count integer, p_significant_risk boolean)
returns uuid language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_id uuid := gen_random_uuid();
  v_folio text;
begin
  if auth.uid() is null then
    raise exception 'report_privacy_incident: requiere sesion de staff' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null or not hoteles.can_manage_reservations(p_property_id) then
    raise exception 'property no disponible' using errcode = '42501';
  end if;
  if p_detected_at is null or p_detected_at > now() + interval '5 minutes' then
    raise exception 'fecha_invalida: la fecha de deteccion no puede estar en el futuro' using errcode = '22023';
  end if;
  v_folio := 'INC-' || to_char(p_detected_at at time zone 'utc', 'YYYYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 6));
  insert into hoteles.privacy_incident (id, organization_id, property_id, folio, incident_type, severity, title, description, detected_at, affected_count, significant_risk, reported_by)
  values (v_id, v_org, p_property_id, v_folio, p_incident_type, p_severity, btrim(coalesce(p_title, '')), btrim(coalesce(p_description, '')), p_detected_at, p_affected_count, coalesce(p_significant_risk, false), auth.uid());
  perform hoteles.privacy_log_event(v_org, p_property_id, 'incidente', v_id, 'incidente_reportado', v_folio);
  return v_id;
end;
$$;
revoke all on function hoteles.report_privacy_incident(uuid, text, text, text, text, timestamptz, integer, boolean) from public, anon;
grant execute on function hoteles.report_privacy_incident(uuid, text, text, text, text, timestamptz, integer, boolean) to authenticated;

-- update_privacy_incident: owner/gm. Acciones: 'contener', 'registrar_notificacion' (SOLO
-- registra que el titular fue notificado, canal y constancia; el sistema no envia nada),
-- 'cerrar' (si hay riesgo significativo exige notificacion registrada o el motivo de no
-- notificar).
create or replace function hoteles.update_privacy_incident(p_incident_id uuid, p_action text, p_note text, p_channel text, p_ref text)
returns text language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_i hoteles.privacy_incident%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if auth.uid() is null then
    raise exception 'update_privacy_incident: requiere sesion de staff' using errcode = '42501';
  end if;
  select * into v_i from hoteles.privacy_incident where id = p_incident_id for update;
  if not found or not hoteles.can_manage_catalog(v_i.property_id) then
    raise exception 'incidente no disponible' using errcode = '42501';
  end if;
  if v_i.status = 'cerrada' then
    raise exception 'incidente_cerrado: el incidente ya esta cerrado' using errcode = 'P0001';
  end if;

  if p_action = 'contener' then
    if v_i.status <> 'detectada' then
      raise exception 'estado_invalido: solo un incidente detectado se puede marcar como contenido' using errcode = 'P0001';
    end if;
    if length(v_note) > 300 then
      raise exception 'nota_invalida: maximo 300 caracteres' using errcode = '22023';
    end if;
    update hoteles.privacy_incident set status = 'contenida', contained_at = now(), updated_at = now() where id = p_incident_id;
    perform hoteles.privacy_log_event(v_i.organization_id, v_i.property_id, 'incidente', p_incident_id, 'incidente_contenido', nullif(v_note, ''));
    return 'contenida';
  elsif p_action = 'registrar_notificacion' then
    if v_i.notified_at is not null then
      raise exception 'estado_invalido: la notificacion al titular ya fue registrada' using errcode = 'P0001';
    end if;
    if length(btrim(coalesce(p_channel, ''))) < 2 or length(btrim(coalesce(p_channel, ''))) > 60
       or length(btrim(coalesce(p_ref, ''))) < 1 or length(btrim(coalesce(p_ref, ''))) > 200 then
      raise exception 'notificacion_invalida: indica el canal (2-60) y la constancia o referencia (1-200)' using errcode = '22023';
    end if;
    update hoteles.privacy_incident
       set notified_at = now(), notified_by = auth.uid(), notification_channel = btrim(p_channel), notification_ref = btrim(p_ref), updated_at = now()
     where id = p_incident_id;
    perform hoteles.privacy_log_event(v_i.organization_id, v_i.property_id, 'incidente', p_incident_id, 'titular_notificado', 'canal ' || btrim(p_channel));
    return v_i.status;
  elsif p_action = 'cerrar' then
    if length(v_note) < 10 or length(v_note) > 300 then
      raise exception 'nota_invalida: la nota de cierre debe tener entre 10 y 300 caracteres' using errcode = '22023';
    end if;
    if v_i.significant_risk and v_i.notified_at is null
       and length(btrim(coalesce(p_ref, ''))) < 10 then
      raise exception 'notificacion_pendiente: con riesgo significativo registra la notificacion al titular o el motivo de no notificar (10 a 300 caracteres)' using errcode = 'P0001';
    end if;
    update hoteles.privacy_incident
       set status = 'cerrada', closed_at = now(), closed_by = auth.uid(), closing_note = v_note, updated_at = now(),
           no_notification_reason = case when v_i.significant_risk and v_i.notified_at is null then left(btrim(p_ref), 300) else null end
     where id = p_incident_id;
    perform hoteles.privacy_log_event(v_i.organization_id, v_i.property_id, 'incidente', p_incident_id, 'incidente_cerrado', v_note);
    return 'cerrada';
  end if;
  raise exception 'accion_invalida: contener, registrar_notificacion o cerrar' using errcode = '22023';
end;
$$;
revoke all on function hoteles.update_privacy_incident(uuid, text, text, text, text) from public, anon;
grant execute on function hoteles.update_privacy_incident(uuid, text, text, text, text) to authenticated;

-- ---- ARCO ----

create or replace function hoteles.open_arco_request(
  p_property_id uuid, p_right_type text, p_requester_name text, p_requester_contact text, p_channel text,
  p_description text, p_received_on date, p_guest_id uuid, p_vault_id uuid)
returns uuid language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_id uuid := gen_random_uuid();
  v_guest_prop uuid;
  v_vault record;
  v_utc_today date := (now() at time zone 'utc')::date;
  v_folio text;
begin
  if auth.uid() is null then
    raise exception 'open_arco_request: requiere sesion de staff' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'property no disponible' using errcode = '42501';
  end if;
  if p_received_on is null or p_received_on > v_utc_today + 1 or p_received_on < v_utc_today - 365 then
    raise exception 'fecha_invalida: la fecha de recepcion debe estar entre hace 365 dias y hoy' using errcode = '22023';
  end if;
  if p_guest_id is not null then
    select property_id into v_guest_prop from hoteles.guest where id = p_guest_id;
    if v_guest_prop is distinct from p_property_id then
      raise exception 'guest_invalido: el huesped no pertenece a la property' using errcode = '23503';
    end if;
  end if;
  if p_vault_id is not null then
    select property_id, guest_id into v_vault from hoteles.identity_vault where id = p_vault_id;
    if v_vault.property_id is distinct from p_property_id or (p_guest_id is not null and v_vault.guest_id is distinct from p_guest_id) then
      raise exception 'identidad_invalida: la identidad no corresponde a la property/huesped' using errcode = '23503';
    end if;
  end if;
  v_folio := 'ARCO-' || to_char(p_received_on, 'YYYYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 6));
  insert into hoteles.arco_request (id, organization_id, property_id, folio, right_type, guest_id, vault_id, requester_name, requester_contact, channel, description, received_on, response_due_on, created_by)
  values (v_id, v_org, p_property_id, v_folio, p_right_type, p_guest_id, p_vault_id, btrim(coalesce(p_requester_name, '')), nullif(btrim(coalesce(p_requester_contact, '')), ''),
          p_channel, nullif(btrim(coalesce(p_description, '')), ''), p_received_on, p_received_on + 20, auth.uid());
  perform hoteles.privacy_log_event(v_org, p_property_id, 'arco', v_id, 'solicitud_recibida', v_folio || ' (' || p_right_type || ')');
  return v_id;
end;
$$;
revoke all on function hoteles.open_arco_request(uuid, text, text, text, text, text, date, uuid, uuid) from public, anon;
grant execute on function hoteles.open_arco_request(uuid, text, text, text, text, text, date, uuid, uuid) to authenticated;

-- advance_arco_request: owner/gm. recibida -> en_revision/procedente/improcedente;
-- en_revision -> procedente/improcedente; procedente -> ejecutada. `p_today` es la fecha de
-- negocio calculada por la aplicacion (zona horaria de la property); se acota a +-1 dia de la
-- fecha UTC del servidor. Toda decision exige nota. Una cancelacion PROCEDENTE bloquea la
-- identidad ligada (o las activas del huesped): la supresion posterior pasa por la ventana de
-- bloqueo y NO ocurre si hay retencion legal activa (art. 25 fr. III: obligaciones legales).
create or replace function hoteles.advance_arco_request(p_request_id uuid, p_to text, p_note text, p_today date)
returns text language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_req hoteles.arco_request%rowtype;
  v_note text := btrim(coalesce(p_note, ''));
  v_ok boolean;
  v_vault record;
  v_blocked integer := 0;
begin
  if auth.uid() is null then
    raise exception 'advance_arco_request: requiere sesion de staff' using errcode = '42501';
  end if;
  select * into v_req from hoteles.arco_request where id = p_request_id for update;
  if not found or not hoteles.can_manage_catalog(v_req.property_id) then
    raise exception 'solicitud no disponible' using errcode = '42501';
  end if;
  if p_today is null or abs(p_today - (now() at time zone 'utc')::date) > 1 then
    raise exception 'fecha_invalida: la fecha de negocio no coincide con la fecha del servidor' using errcode = '22023';
  end if;
  if length(v_note) < 10 or length(v_note) > 300 then
    raise exception 'nota_invalida: la nota debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  v_ok := (v_req.status = 'recibida' and p_to in ('en_revision', 'procedente', 'improcedente'))
       or (v_req.status = 'en_revision' and p_to in ('procedente', 'improcedente'))
       or (v_req.status = 'procedente' and p_to = 'ejecutada');
  if not v_ok then
    raise exception 'estado_invalido: no se puede pasar de % a %', v_req.status, p_to using errcode = 'P0001';
  end if;

  if p_to = 'en_revision' then
    update hoteles.arco_request set status = 'en_revision', decision_note = v_note, updated_at = now() where id = p_request_id;
  elsif p_to = 'procedente' then
    update hoteles.arco_request
       set status = 'procedente', decided_on = p_today, execution_due_on = p_today + 15, decision_note = v_note, updated_at = now()
     where id = p_request_id;
    if v_req.right_type = 'cancelacion' then
      for v_vault in
        select id from hoteles.identity_vault
         where property_id = v_req.property_id and status = 'activo'
           and (id = v_req.vault_id or (v_req.vault_id is null and v_req.guest_id is not null and guest_id = v_req.guest_id))
      loop
        if hoteles.block_identity_internal(v_vault.id, 'arco', auth.uid(), 'ARCO cancelacion ' || v_req.folio) then
          v_blocked := v_blocked + 1;
        end if;
      end loop;
    end if;
  elsif p_to = 'improcedente' then
    update hoteles.arco_request set status = 'improcedente', decided_on = p_today, decision_note = v_note, updated_at = now() where id = p_request_id;
  else
    update hoteles.arco_request set status = 'ejecutada', executed_at = now(), decision_note = v_note, updated_at = now() where id = p_request_id;
  end if;
  perform hoteles.privacy_log_event(v_req.organization_id, v_req.property_id, 'arco', p_request_id, 'arco_' || p_to,
    left(v_note || case when v_blocked > 0 then ' [identidades bloqueadas: ' || v_blocked || ']' else '' end, 300));
  return p_to;
end;
$$;
revoke all on function hoteles.advance_arco_request(uuid, text, text, date) from public, anon;
grant execute on function hoteles.advance_arco_request(uuid, text, text, date) to authenticated;

-- extend_arco_request: prorroga UNA sola vez, por igual plazo que la fase abierta (respuesta:
-- +20 dias; ejecucion: +15), con motivo documentado. Interpretacion a confirmar por un abogado.
create or replace function hoteles.extend_arco_request(p_request_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_req hoteles.arco_request%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null then
    raise exception 'extend_arco_request: requiere sesion de staff' using errcode = '42501';
  end if;
  select * into v_req from hoteles.arco_request where id = p_request_id for update;
  if not found or not hoteles.can_manage_catalog(v_req.property_id) then
    raise exception 'solicitud no disponible' using errcode = '42501';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'motivo_invalido: el motivo de la prorroga debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  if v_req.status in ('improcedente', 'ejecutada') then
    raise exception 'estado_invalido: la solicitud ya esta resuelta' using errcode = 'P0001';
  end if;
  if v_req.extended_at is not null then
    raise exception 'prorroga_agotada: la prorroga solo se puede usar una vez' using errcode = 'P0001';
  end if;
  if v_req.status = 'procedente' then
    update hoteles.arco_request
       set execution_due_on = execution_due_on + 15, extension_phase = 'ejecucion', extension_reason = v_reason, extended_at = now(), extended_by = auth.uid(), updated_at = now()
     where id = p_request_id;
  else
    update hoteles.arco_request
       set response_due_on = response_due_on + 20, extension_phase = 'respuesta', extension_reason = v_reason, extended_at = now(), extended_by = auth.uid(), updated_at = now()
     where id = p_request_id;
  end if;
  perform hoteles.privacy_log_event(v_req.organization_id, v_req.property_id, 'arco', p_request_id, 'arco_prorroga', v_reason);
end;
$$;
revoke all on function hoteles.extend_arco_request(uuid, text) from public, anon;
grant execute on function hoteles.extend_arco_request(uuid, text) to authenticated;

-- ---- Acceso excepcional a identidades bloqueadas (doble control) ----

create or replace function hoteles.request_blocked_access(p_vault_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_prop uuid;
  v_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'request_blocked_access: requiere sesion de staff' using errcode = '42501';
  end if;
  select organization_id, property_id, status into v_org, v_prop, v_status from hoteles.identity_vault where id = p_vault_id;
  if v_prop is null or not hoteles.can_manage_catalog(v_prop) then
    raise exception 'identidad no disponible' using errcode = '42501';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'motivo_invalido: el motivo debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  if v_status = 'purgado' then
    raise exception 'identidad_purgada: la identidad ya fue purgada' using errcode = 'P0001';
  end if;
  if v_status <> 'bloqueada' then
    raise exception 'identidad_no_bloqueada: solo las identidades bloqueadas usan acceso excepcional (las activas se revelan con el flujo normal)' using errcode = 'P0001';
  end if;
  insert into hoteles.identity_blocked_access_request (organization_id, property_id, vault_id, requested_by, reason)
  values (v_org, v_prop, p_vault_id, auth.uid(), v_reason)
  returning id into v_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_org, v_prop, p_vault_id, auth.uid(), 'acceso_excepcional_solicitado', v_reason);
  perform hoteles.privacy_log_event(v_org, v_prop, 'acceso_excepcional', v_id, 'acceso_excepcional_solicitado', v_reason);
  return v_id;
end;
$$;
revoke all on function hoteles.request_blocked_access(uuid, text) from public, anon;
grant execute on function hoteles.request_blocked_access(uuid, text) to authenticated;

create or replace function hoteles.decide_blocked_access(p_request_id uuid, p_approve boolean, p_note text)
returns text language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_req hoteles.identity_blocked_access_request%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null then
    raise exception 'decide_blocked_access: requiere sesion de staff' using errcode = '42501';
  end if;
  select * into v_req from hoteles.identity_blocked_access_request where id = p_request_id for update;
  if not found or not hoteles.can_manage_catalog(v_req.property_id) then
    raise exception 'solicitud no disponible' using errcode = '42501';
  end if;
  if v_req.status <> 'pendiente' then
    raise exception 'solicitud_resuelta: la solicitud ya fue resuelta' using errcode = 'P0001';
  end if;
  if v_req.requested_by = auth.uid() then
    raise exception 'doble_control: quien solicita el acceso excepcional no puede aprobarlo ni rechazarlo' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 300 then
    raise exception 'nota_invalida: maximo 300 caracteres' using errcode = '22023';
  end if;
  if p_approve then
    update hoteles.identity_blocked_access_request
       set status = 'aprobada', decided_by = auth.uid(), decided_at = now(), decision_note = v_note, expires_at = now() + interval '2 hours'
     where id = p_request_id;
    insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
    values (v_req.organization_id, v_req.property_id, v_req.vault_id, auth.uid(), 'acceso_excepcional_aprobado', v_note);
    perform hoteles.privacy_log_event(v_req.organization_id, v_req.property_id, 'acceso_excepcional', p_request_id, 'acceso_excepcional_aprobado', v_note);
    return 'aprobada';
  end if;
  update hoteles.identity_blocked_access_request
     set status = 'rechazada', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
   where id = p_request_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_req.organization_id, v_req.property_id, v_req.vault_id, auth.uid(), 'acceso_excepcional_rechazado', v_note);
  perform hoteles.privacy_log_event(v_req.organization_id, v_req.property_id, 'acceso_excepcional', p_request_id, 'acceso_excepcional_rechazado', v_note);
  return 'rechazada';
end;
$$;
revoke all on function hoteles.decide_blocked_access(uuid, boolean, text) from public, anon;
grant execute on function hoteles.decide_blocked_access(uuid, boolean, text) to authenticated;

-- reveal_blocked_identity: UNICA via de leer el sobre de una identidad BLOQUEADA. Exige una
-- aprobacion vigente (no caducada, no usada) DE QUIEN LLAMA (otra persona la aprobo), la
-- consume (un solo uso) y deja huella en la misma transaccion. Cualquier otro caso responde
-- el mismo 42501 (sin oraculo de existencia).
create or replace function hoteles.reveal_blocked_identity(p_request_id uuid)
returns table (out_payload_enc text, out_key_version smallint)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_req hoteles.identity_blocked_access_request%rowtype;
  v_payload text;
  v_kv smallint;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'reveal_blocked_identity: requiere sesion de staff' using errcode = '42501';
  end if;
  select * into v_req from hoteles.identity_blocked_access_request where id = p_request_id for update;
  if not found or v_req.requested_by <> auth.uid() or not hoteles.can_manage_catalog(v_req.property_id) then
    raise exception 'acceso no disponible' using errcode = '42501';
  end if;
  if v_req.status <> 'aprobada' or v_req.expires_at <= now() then
    raise exception 'acceso_no_vigente: la aprobacion no esta vigente (pendiente, rechazada, usada o caducada)' using errcode = 'P0001';
  end if;
  select payload_enc, key_version, status into v_payload, v_kv, v_status from hoteles.identity_vault where id = v_req.vault_id;
  if v_status <> 'bloqueada' or v_payload is null then
    raise exception 'identidad_purgada: la identidad ya fue purgada' using errcode = 'P0001';
  end if;
  update hoteles.identity_blocked_access_request set status = 'usada', used_at = now() where id = p_request_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_req.organization_id, v_req.property_id, v_req.vault_id, auth.uid(), 'acceso_excepcional_revelacion', v_req.reason);
  perform hoteles.privacy_log_event(v_req.organization_id, v_req.property_id, 'acceso_excepcional', p_request_id, 'acceso_excepcional_revelacion', v_req.reason);
  return query select v_payload, v_kv;
end;
$$;
revoke all on function hoteles.reveal_blocked_identity(uuid) from public, anon;
grant execute on function hoteles.reveal_blocked_identity(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 12) Funciones de 031 REDEFINIDAS para el estado 'bloqueada' (mismas firmas).
-- ---------------------------------------------------------------------------

-- verify_identity: una identidad bloqueada no se verifica (no hay acceso operativo).
create or replace function hoteles.verify_identity(p_vault_id uuid)
returns void language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_prop uuid;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'verify_identity: requiere sesion de staff' using errcode = '42501';
  end if;
  select iv.organization_id, iv.property_id, iv.status into v_org, v_prop, v_status
    from hoteles.identity_vault iv where iv.id = p_vault_id;
  if v_prop is null or not hoteles.can_reveal_identity(v_prop) then
    raise exception 'identidad no disponible' using errcode = '42501';
  end if;
  if v_status = 'bloqueada' then
    raise exception 'identidad_bloqueada: la identidad esta bloqueada y no tiene acceso operativo' using errcode = 'P0001';
  end if;
  if v_status <> 'activo' then
    raise exception 'identidad_purgada: no se puede verificar una identidad purgada' using errcode = 'P0001';
  end if;
  update hoteles.identity_vault set verified_at = now(), verified_by = auth.uid() where id = p_vault_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action)
  values (v_org, v_prop, p_vault_id, auth.uid(), 'verificacion');
end;
$$;

-- reveal_identity: una identidad bloqueada NO se revela por el flujo normal (solo por
-- reveal_blocked_identity, con doble control).
create or replace function hoteles.reveal_identity(p_vault_id uuid, p_reason text)
returns table (out_payload_enc text, out_key_version smallint)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_prop uuid;
  v_status text;
  v_payload text;
  v_kv smallint;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null then
    raise exception 'reveal_identity: requiere sesion de staff' using errcode = '42501';
  end if;
  select iv.organization_id, iv.property_id, iv.status, iv.payload_enc, iv.key_version
    into v_org, v_prop, v_status, v_payload, v_kv
    from hoteles.identity_vault iv where iv.id = p_vault_id;
  if v_prop is null or not hoteles.can_reveal_identity(v_prop) then
    raise exception 'identidad no disponible' using errcode = '42501';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'motivo_invalido: el motivo debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  if v_status = 'bloqueada' then
    raise exception 'identidad_bloqueada: la identidad esta bloqueada; solo hay acceso excepcional con doble control' using errcode = 'P0001';
  end if;
  if v_status <> 'activo' or v_payload is null then
    raise exception 'identidad_purgada: la identidad ya fue purgada' using errcode = 'P0001';
  end if;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_org, v_prop, p_vault_id, auth.uid(), 'revelacion', v_reason);
  return query select v_payload, v_kv;
end;
$$;

-- request_identity_purge: solo identidades ACTIVAS (una bloqueada ya va camino a la purga).
create or replace function hoteles.request_identity_purge(p_vault_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_prop uuid;
  v_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'request_identity_purge: requiere sesion de staff' using errcode = '42501';
  end if;
  select iv.organization_id, iv.property_id, iv.status into v_org, v_prop, v_status
    from hoteles.identity_vault iv where iv.id = p_vault_id;
  if v_prop is null or not hoteles.can_manage_catalog(v_prop) then
    raise exception 'identidad no disponible' using errcode = '42501';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'motivo_invalido: el motivo debe tener entre 10 y 300 caracteres' using errcode = '22023';
  end if;
  if v_status = 'bloqueada' then
    raise exception 'identidad_bloqueada: la identidad ya esta bloqueada y se purgara al vencer su ventana' using errcode = 'P0001';
  end if;
  if v_status <> 'activo' then
    raise exception 'identidad_purgada: la identidad ya fue purgada' using errcode = 'P0001';
  end if;
  insert into hoteles.identity_purge_request (organization_id, property_id, vault_id, requested_by, reason)
  values (v_org, v_prop, p_vault_id, auth.uid(), v_reason)
  returning id into v_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_org, v_prop, p_vault_id, auth.uid(), 'purga_solicitada', v_reason);
  return v_id;
end;
$$;

-- decide_identity_purge: DOBLE CONTROL (otro owner/gm, nunca quien solicito). APROBAR ya NO
-- purga: BLOQUEA la identidad (ventana de la property) y la solicitud queda 'en_bloqueo'; la
-- purga ocurre en el barrido al vencer la ventana y solo sin retencion legal activa.
create or replace function hoteles.decide_identity_purge(p_request_id uuid, p_approve boolean, p_note text)
returns text language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_req hoteles.identity_purge_request%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_vstatus text;
  v_new text;
begin
  if auth.uid() is null then
    raise exception 'decide_identity_purge: requiere sesion de staff' using errcode = '42501';
  end if;
  select * into v_req from hoteles.identity_purge_request where id = p_request_id for update;
  if not found or not hoteles.can_manage_catalog(v_req.property_id) then
    raise exception 'solicitud no disponible' using errcode = '42501';
  end if;
  if v_req.status <> 'pendiente' then
    raise exception 'solicitud_resuelta: la solicitud ya fue resuelta' using errcode = 'P0001';
  end if;
  if v_req.requested_by = auth.uid() then
    raise exception 'doble_control: quien solicita la purga no puede aprobarla ni rechazarla' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 300 then
    raise exception 'nota_invalida: maximo 300 caracteres' using errcode = '22023';
  end if;

  if p_approve then
    select status into v_vstatus from hoteles.identity_vault where id = v_req.vault_id for update;
    if v_vstatus = 'activo' then
      perform hoteles.block_identity_internal(v_req.vault_id, 'solicitud_purga', auth.uid(), coalesce(v_note, v_req.reason));
    end if;
    v_new := case when v_vstatus = 'purgado' then 'ejecutada' else 'en_bloqueo' end;
    update hoteles.identity_purge_request
       set status = v_new, decided_by = auth.uid(), decided_at = now(), decision_note = v_note
     where id = p_request_id;
    insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
    values (v_req.organization_id, v_req.property_id, v_req.vault_id, auth.uid(), 'purga_aprobada', v_note);
    return v_new;
  end if;

  update hoteles.identity_purge_request
     set status = 'rechazada', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
   where id = p_request_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_req.organization_id, v_req.property_id, v_req.vault_id, auth.uid(), 'purga_rechazada', v_note);
  return 'rechazada';
end;
$$;

-- purge_expired_identities: SOLO sistema (auth.uid() is null). Ahora SOLO purga identidades
-- BLOQUEADAS cuya ventana ya vencio y que no tienen retencion legal activa; ya no purga
-- identidades activas por fecha (eso lo hace el bloqueo en sweep_identity_retention). El
-- parametro `p_today` se conserva por compatibilidad de firma y no se usa. Cierra las
-- solicitudes de purga ('pendiente'/'en_bloqueo') de esas identidades. Devuelve cuantas purgo.
create or replace function hoteles.purge_expired_identities(p_property_id uuid, p_today date)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_count integer;
begin
  if auth.uid() is not null then
    raise exception 'purge_expired_identities: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  with purged as (
    update hoteles.identity_vault v
       set payload_enc = null, document_last4 = null, nationality = null, status = 'purgado', purged_at = now()
     where v.property_id = p_property_id and v.status = 'bloqueada' and v.blocked_until <= now()
       and not exists (select 1 from hoteles.legal_hold h where h.vault_id = v.id and h.status = 'activa')
    returning v.id, v.organization_id, v.property_id
  ), closed as (
    update hoteles.identity_purge_request r
       set status = 'ejecutada', decided_at = coalesce(r.decided_at, now()), decision_note = coalesce(r.decision_note, 'purga al vencer la ventana de bloqueo')
      from purged p where r.vault_id = p.id and r.status in ('pendiente', 'en_bloqueo')
    returning r.id
  ), logged as (
    insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
    select organization_id, property_id, id, null, 'purga_por_bloqueo_vencido', 'ventana de bloqueo vencida' from purged
    returning 1
  )
  select count(*)::integer into v_count from purged;
  return v_count;
end;
$$;

-- sweep_identity_retention: SOLO sistema (cron). Una property por llamada (una transaccion por
-- unidad). Paso 1: bloquea las identidades ACTIVAS con retencion vencida (retention_until <
-- p_today, fecha de negocio de la property). Paso 2: purga las bloqueadas con ventana vencida
-- y sin retencion legal. Devuelve cuantas bloqueo y cuantas purgo.
create or replace function hoteles.sweep_identity_retention(p_property_id uuid, p_today date)
returns table (out_blocked integer, out_purged integer)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  r record;
  v_blocked integer := 0;
  v_purged integer;
begin
  if auth.uid() is not null then
    raise exception 'sweep_identity_retention: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  for r in select id from hoteles.identity_vault where property_id = p_property_id and status = 'activo' and retention_until < p_today loop
    if hoteles.block_identity_internal(r.id, 'retencion_vencida', null, 'retencion vencida') then
      v_blocked := v_blocked + 1;
    end if;
  end loop;
  v_purged := hoteles.purge_expired_identities(p_property_id, p_today);
  return query select v_blocked, v_purged;
end;
$$;
revoke all on function hoteles.sweep_identity_retention(uuid, date) from public, anon;
grant execute on function hoteles.sweep_identity_retention(uuid, date) to authenticated;
