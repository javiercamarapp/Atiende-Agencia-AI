-- H-01 (P0) — BOVEDA DE IDENTIDAD + REGISTRO MIGRATORIO + PURGA CON DOBLE CONTROL.
--
-- Modelo: el documento de identidad del huesped (nombre completo, numero de
-- documento, fecha de nacimiento, MRZ, etc.) se cifra EN LA APLICACION (AES-256-GCM,
-- la llave vive solo en el entorno de la API, nunca en la base) y esta migracion solo
-- guarda el sobre cifrado (`payload_enc`) mas metadatos NO sensibles para operar
-- (tipo de documento, ultimos 4, nacionalidad, retencion). La base nunca ve el texto
-- plano ni la llave: un volcado de la tabla no revela identidades.
--
-- Superficie de la migracion:
--   hoteles.identity_vault            bóveda (sobre cifrado + metadatos)
--   hoteles.identity_access_log       bitacora append-only de captura/revelacion/purga
--   hoteles.identity_purge_request    solicitud de purga con DOBLE CONTROL
--   hoteles.migratory_registration    registro migratorio por reserva/huesped
--   funciones: reveal_identity, verify_identity, request_identity_purge,
--              decide_identity_purge, purge_expired_identities (+ helpers de rol).
--
-- REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: mergear despliega el codigo
-- de inmediato y esta migracion NO se aplica sola a la base real (docs/DEPLOY.md). Todo
-- el TypeScript que toca estos objetos captura SQLSTATE 42883/42P01/42703 con
-- `runWithSavepointFallback` y degrada a "no disponible aun" (lista vacia / 503),
-- nunca a un 500 ni a romper un flujo existente.
--
-- Requiere: 001_hoteles_schema.sql (core.property, core.staff_user, hoteles.guest,
-- hoteles.reservation), 005_reservas_estado.sql (hoteles.can_manage_reservations),
-- 018_admin_catalogo_alta.sql (hoteles.can_manage_catalog).

-- ---------------------------------------------------------------------------
-- Helpers de rol (misma forma que can_manage_catalog/can_manage_reservations).
-- Justificacion: separar "capturar/ver metadatos" (owner/gm/frontdesk/reservations,
-- front-of-house) de "REVELAR el documento" (owner/gm/frontdesk: quien verifica en
-- mostrador; reservations puede capturar pero no leer en claro) y de las decisiones
-- ADMINISTRATIVAS (purga, bitacora: owner/gm via can_manage_catalog, ya existente).
-- Son security definer con search_path fijo; se revoca de public y se otorga solo a
-- authenticated (las policies RLS se evaluan con ese rol).
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_reveal_identity(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk')
  )
$$;
revoke all on function hoteles.can_reveal_identity(uuid) from public, anon;
grant execute on function hoteles.can_reveal_identity(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1) hoteles.identity_vault
-- ---------------------------------------------------------------------------
create table hoteles.identity_vault (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  guest_id uuid not null references hoteles.guest(id) on delete cascade,
  reservation_id uuid references hoteles.reservation(id) on delete set null,
  document_type text not null check (document_type in ('ine', 'pasaporte', 'licencia_conducir', 'forma_migratoria', 'otro')),
  -- ISO 3166-1 alfa-3 (MEX, USA...). Necesaria para el registro migratorio y NO es
  -- el documento; se anula al purgar.
  nationality text check (nationality is null or nationality ~ '^[A-Z]{3}$'),
  document_last4 text check (document_last4 is null or length(document_last4) between 1 and 4),
  -- Sobre cifrado `v<version>.<iv>.<tag>.<ciphertext>` (base64url, AES-256-GCM, AAD
  -- ligada a id+property). El CHECK de formato impide que alguien inserte JSON o texto
  -- plano por error: una cadena con llaves/comillas/espacios no cumple el patron.
  payload_enc text check (payload_enc is null or (length(payload_enc) <= 8192 and payload_enc ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,}$')),
  key_version smallint not null default 1 check (key_version > 0),
  status text not null default 'activo' check (status in ('activo', 'purgado')),
  retention_until date not null,
  verified_at timestamptz,
  verified_by uuid references core.staff_user(id),
  captured_by uuid references core.staff_user(id),
  created_at timestamptz not null default now(),
  purged_at timestamptz,
  -- Estado coherente: activo = sobre presente; purgado = TODO dato personal anulado.
  check (
    (status = 'activo' and payload_enc is not null and purged_at is null)
    or (status = 'purgado' and payload_enc is null and document_last4 is null and nationality is null and purged_at is not null)
  )
);
create index identity_vault_property_idx on hoteles.identity_vault (property_id, created_at desc);
create index identity_vault_guest_idx on hoteles.identity_vault (guest_id);
create index identity_vault_retention_idx on hoteles.identity_vault (property_id, retention_until) where status = 'activo';

-- ---------------------------------------------------------------------------
-- 2) hoteles.identity_access_log (append-only)
-- ---------------------------------------------------------------------------
create table hoteles.identity_access_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  vault_id uuid not null references hoteles.identity_vault(id) on delete cascade,
  -- NULL = sesion de sistema (purga por vencimiento de retencion).
  actor_user_id uuid references core.staff_user(id),
  action text not null check (action in ('captura', 'verificacion', 'revelacion', 'purga_solicitada', 'purga_aprobada', 'purga_rechazada', 'purga_por_retencion')),
  reason text check (reason is null or length(reason) <= 300),
  created_at timestamptz not null default now()
);
create index identity_access_log_vault_idx on hoteles.identity_access_log (vault_id, created_at desc);
create index identity_access_log_property_idx on hoteles.identity_access_log (property_id, created_at desc);

-- Inmutabilidad: una fila de bitacora jamas se modifica (ni por service_role).
create or replace function hoteles.identity_access_log_immutable()
returns trigger language plpgsql set search_path = hoteles, pg_temp as $$
begin
  raise exception 'identity_access_log es append-only' using errcode = '42501';
end;
$$;
create trigger identity_access_log_no_update_trg
  before update on hoteles.identity_access_log
  for each row execute function hoteles.identity_access_log_immutable();

-- ---------------------------------------------------------------------------
-- 3) hoteles.identity_purge_request (doble control)
-- ---------------------------------------------------------------------------
create table hoteles.identity_purge_request (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  vault_id uuid not null references hoteles.identity_vault(id) on delete cascade,
  requested_by uuid not null references core.staff_user(id),
  reason text not null check (length(reason) between 10 and 300),
  status text not null default 'pendiente' check (status in ('pendiente', 'ejecutada', 'rechazada')),
  decided_by uuid references core.staff_user(id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 300),
  created_at timestamptz not null default now(),
  -- DOBLE CONTROL a nivel de datos: quien decide nunca es quien solicito. Ni una
  -- funcion defectuosa ni un service_role pueden registrar una auto-aprobacion.
  check (decided_by is null or decided_by <> requested_by),
  check ((status = 'pendiente' and decided_at is null) or (status <> 'pendiente' and decided_at is not null))
);
create unique index identity_purge_request_one_pending_idx on hoteles.identity_purge_request (vault_id) where status = 'pendiente';
create index identity_purge_request_property_idx on hoteles.identity_purge_request (property_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 4) hoteles.migratory_registration
-- Registro por reserva/huesped extranjero. NO contiene el documento (vive cifrado en
-- la boveda): solo referencia, nacionalidad, fechas y la constancia que el hotel
-- obtiene al reportar. Este modelo NO envia nada al INM: registra el estado y la
-- referencia capturada por el staff.
-- ---------------------------------------------------------------------------
create table hoteles.migratory_registration (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  reservation_id uuid not null references hoteles.reservation(id) on delete cascade,
  guest_id uuid not null references hoteles.guest(id) on delete cascade,
  vault_id uuid references hoteles.identity_vault(id) on delete set null,
  nationality text check (nationality is null or nationality ~ '^[A-Z]{3}$'),
  arrival_date date not null,
  departure_date date not null check (departure_date > arrival_date),
  status text not null default 'pendiente' check (status in ('pendiente', 'reportado')),
  constancia_ref text check (constancia_ref is null or length(btrim(constancia_ref)) between 1 and 120),
  reported_at timestamptz,
  reported_by uuid references core.staff_user(id),
  created_by uuid references core.staff_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reservation_id, guest_id),
  check (
    (status = 'pendiente' and reported_at is null and constancia_ref is null)
    or (status = 'reportado' and reported_at is not null and constancia_ref is not null)
  )
);
create index migratory_registration_property_idx on hoteles.migratory_registration (property_id, status, arrival_date);

-- ---------------------------------------------------------------------------
-- Triggers de guarda (security definer, search_path fijo). Defensa en profundidad:
-- el GRANT de columna ya deja fuera lo sensible; estos triggers son la segunda capa.
-- ---------------------------------------------------------------------------
-- Boveda: deriva organization_id de core.property (nunca del cliente), exige que el
-- huesped/reserva sean de la MISMA property (cross-tenant), sella captured_by y
-- fuerza el estado inicial. En UPDATE: ids/ligas inmutables y el sobre solo puede
-- pasar a NULL al purgar (nadie reescribe un sobre ya guardado).
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
  return new;
end;
$$;
revoke all on function hoteles.identity_vault_guard() from public, anon;

create trigger identity_vault_guard_trg
  before insert or update on hoteles.identity_vault
  for each row execute function hoteles.identity_vault_guard();

-- Bitacora de captura: AFTER INSERT (la FK a la boveda exige que la fila ya exista).
create or replace function hoteles.identity_vault_log_capture()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action)
  values (new.organization_id, new.property_id, new.id, auth.uid(), 'captura');
  return new;
end;
$$;
revoke all on function hoteles.identity_vault_log_capture() from public, anon;

create trigger identity_vault_log_capture_trg
  after insert on hoteles.identity_vault
  for each row execute function hoteles.identity_vault_log_capture();

-- Registro migratorio: deriva organization_id, valida que huesped/reserva/boveda sean
-- de la property, copia fechas de la RESERVA (no confia en el cliente) y nacionalidad
-- de la boveda; sella reported_*; el estado 'reportado' no retrocede.
create or replace function hoteles.migratory_registration_guard()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_res record;
  v_guest_property uuid;
  v_vault record;
begin
  if TG_OP = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
    end if;
    select property_id, check_in_date, check_out_date into v_res from hoteles.reservation where id = new.reservation_id;
    if v_res.property_id is distinct from new.property_id then
      raise exception 'reserva_invalida: la reserva no pertenece a la property' using errcode = '23503';
    end if;
    select property_id into v_guest_property from hoteles.guest where id = new.guest_id;
    if v_guest_property is distinct from new.property_id then
      raise exception 'guest_invalido: el huesped no pertenece a la property' using errcode = '23503';
    end if;
    if new.vault_id is not null then
      select property_id, guest_id, nationality into v_vault from hoteles.identity_vault where id = new.vault_id;
      if v_vault.property_id is distinct from new.property_id or v_vault.guest_id is distinct from new.guest_id then
        raise exception 'identidad_invalida: la identidad no corresponde a la property/huesped' using errcode = '23503';
      end if;
      new.nationality := v_vault.nationality;
    end if;
    new.organization_id := v_org;
    new.arrival_date := v_res.check_in_date;
    new.departure_date := v_res.check_out_date;
    new.status := 'pendiente';
    new.constancia_ref := null;
    new.reported_at := null;
    new.reported_by := null;
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE
  new.organization_id := old.organization_id;
  new.property_id := old.property_id;
  new.reservation_id := old.reservation_id;
  new.guest_id := old.guest_id;
  new.vault_id := old.vault_id;
  new.nationality := old.nationality;
  new.arrival_date := old.arrival_date;
  new.departure_date := old.departure_date;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if old.status = 'reportado' then
    raise exception 'registro_migratorio: un registro ya reportado no se modifica' using errcode = '42501';
  end if;
  if new.status = 'reportado' then
    new.reported_at := now();
    new.reported_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function hoteles.migratory_registration_guard() from public, anon;

create trigger migratory_registration_guard_trg
  before insert or update on hoteles.migratory_registration
  for each row execute function hoteles.migratory_registration_guard();

-- ---------------------------------------------------------------------------
-- RLS + GRANT
-- ---------------------------------------------------------------------------
alter table hoteles.identity_vault enable row level security;
alter table hoteles.identity_access_log enable row level security;
alter table hoteles.identity_purge_request enable row level security;
alter table hoteles.migratory_registration enable row level security;

-- Boveda. SELECT: front-of-house de la property (can_manage_reservations: owner/gm/
-- frontdesk/reservations) ve METADATOS; el sobre cifrado queda fuera del GRANT de
-- columna (solo reveal_identity lo entrega, y deja huella). INSERT: mismo rol que da de
-- alta huespedes/reservas. SIN policy ni GRANT de UPDATE/DELETE para authenticated: la
-- verificacion y la purga pasan solo por las funciones de abajo.
create policy "identidad: front-of-house ve metadatos de la boveda" on hoteles.identity_vault for select
  using (hoteles.can_manage_reservations(property_id));
create policy "identidad: front-of-house captura en la boveda" on hoteles.identity_vault for insert
  with check (hoteles.can_manage_reservations(property_id));

revoke all on hoteles.identity_vault from public, anon;
grant select (id, organization_id, property_id, guest_id, reservation_id, document_type, nationality, document_last4,
              key_version, status, retention_until, verified_at, verified_by, captured_by, created_at, purged_at)
  on hoteles.identity_vault to authenticated;
-- INSERT a nivel columna: solo lo que la captura real escribe. organization_id/status/
-- captured_by/verified_*/purged_at/created_at los fija el trigger.
grant insert (id, property_id, guest_id, reservation_id, document_type, nationality, document_last4, payload_enc, key_version, retention_until)
  on hoteles.identity_vault to authenticated;
grant select, insert on hoteles.identity_vault to service_role;

-- Bitacora. SELECT solo owner/gm (can_manage_catalog): quien accedio a que identidad es
-- informacion de auditoria, no operativa. Sin GRANT de escritura para authenticated:
-- las filas las inserta solo codigo security definer.
create policy "identidad: owner/gm leen la bitacora de accesos" on hoteles.identity_access_log for select
  using (hoteles.can_manage_catalog(property_id));
revoke all on hoteles.identity_access_log from public, anon;
grant select on hoteles.identity_access_log to authenticated;
grant select, insert on hoteles.identity_access_log to service_role;

-- Solicitudes de purga. SELECT owner/gm; escritura solo via request_/decide_identity_purge.
create policy "identidad: owner/gm leen solicitudes de purga" on hoteles.identity_purge_request for select
  using (hoteles.can_manage_catalog(property_id));
revoke all on hoteles.identity_purge_request from public, anon;
grant select on hoteles.identity_purge_request to authenticated;
grant select, insert on hoteles.identity_purge_request to service_role;

-- Registro migratorio. Front-of-house (can_manage_reservations) lo ve, lo crea y lo
-- marca como reportado. GRANT de columna: INSERT solo referencias (el trigger deriva
-- org/fechas/nacionalidad/estado); UPDATE solo status + constancia_ref.
create policy "migratorio: front-of-house ve el registro" on hoteles.migratory_registration for select
  using (hoteles.can_manage_reservations(property_id));
create policy "migratorio: front-of-house crea el registro" on hoteles.migratory_registration for insert
  with check (hoteles.can_manage_reservations(property_id));
create policy "migratorio: front-of-house marca como reportado" on hoteles.migratory_registration for update
  using (hoteles.can_manage_reservations(property_id)) with check (hoteles.can_manage_reservations(property_id));
revoke all on hoteles.migratory_registration from public, anon;
grant select on hoteles.migratory_registration to authenticated;
grant insert (property_id, reservation_id, guest_id, vault_id, nationality) on hoteles.migratory_registration to authenticated;
grant update (status, constancia_ref) on hoteles.migratory_registration to authenticated;
grant select, insert, update on hoteles.migratory_registration to service_role;

-- ---------------------------------------------------------------------------
-- Funciones (security definer, search_path fijo, revoke de public/anon).
-- ---------------------------------------------------------------------------

-- verify_identity: marca la identidad como verificada por el staff que la reviso en
-- mostrador (owner/gm/frontdesk). Es la unica via de escribir verified_*: authenticated
-- no tiene UPDATE sobre la boveda. Deja huella en la bitacora.
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
  if v_status <> 'activo' then
    raise exception 'identidad_purgada: no se puede verificar una identidad purgada' using errcode = 'P0001';
  end if;
  update hoteles.identity_vault set verified_at = now(), verified_by = auth.uid() where id = p_vault_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action)
  values (v_org, v_prop, p_vault_id, auth.uid(), 'verificacion');
end;
$$;
revoke all on function hoteles.verify_identity(uuid) from public, anon;
grant execute on function hoteles.verify_identity(uuid) to authenticated;

-- reveal_identity: UNICA via de leer el sobre cifrado. Autoriza (owner/gm/frontdesk de
-- ESA property; cualquier otro caso, incluido cross-tenant o id inexistente, responde el
-- mismo 42501 para no servir de oraculo de existencia), exige un motivo, y registra el
-- acceso en la MISMA transaccion que la lectura (si la transaccion revierte, no se
-- entrego nada; si se entrego, queda la huella).
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
  if v_status <> 'activo' or v_payload is null then
    raise exception 'identidad_purgada: la identidad ya fue purgada' using errcode = 'P0001';
  end if;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_org, v_prop, p_vault_id, auth.uid(), 'revelacion', v_reason);
  return query select v_payload, v_kv;
end;
$$;
revoke all on function hoteles.reveal_identity(uuid, text) from public, anon;
grant execute on function hoteles.reveal_identity(uuid, text) to authenticated;

-- request_identity_purge: owner/gm solicitan la purga de UNA identidad (ej. ARCO de
-- cancelacion o cierre anticipado). No purga nada: solo abre la solicitud.
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
revoke all on function hoteles.request_identity_purge(uuid, text) from public, anon;
grant execute on function hoteles.request_identity_purge(uuid, text) to authenticated;

-- decide_identity_purge: DOBLE CONTROL. Otro owner/gm (NUNCA quien solicito) aprueba o
-- rechaza. Aprobar ejecuta la purga atomicamente: anula sobre, ultimos 4 y
-- nacionalidad. El CHECK (decided_by <> requested_by) de la tabla es la segunda capa.
create or replace function hoteles.decide_identity_purge(p_request_id uuid, p_approve boolean, p_note text)
returns text language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_req hoteles.identity_purge_request%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
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
    update hoteles.identity_vault
       set payload_enc = null, document_last4 = null, nationality = null, status = 'purgado', purged_at = now()
     where id = v_req.vault_id and status = 'activo';
    update hoteles.identity_purge_request
       set status = 'ejecutada', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
     where id = p_request_id;
    insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
    values (v_req.organization_id, v_req.property_id, v_req.vault_id, auth.uid(), 'purga_aprobada', v_note);
    return 'ejecutada';
  end if;

  update hoteles.identity_purge_request
     set status = 'rechazada', decided_by = auth.uid(), decided_at = now(), decision_note = v_note
   where id = p_request_id;
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
  values (v_req.organization_id, v_req.property_id, v_req.vault_id, auth.uid(), 'purga_rechazada', v_note);
  return 'rechazada';
end;
$$;
revoke all on function hoteles.decide_identity_purge(uuid, boolean, text) from public, anon;
grant execute on function hoteles.decide_identity_purge(uuid, boolean, text) to authenticated;

-- purge_expired_identities: SOLO sistema (auth.uid() is null, el cron). Purga las
-- identidades activas de UNA property cuya retencion vencio antes de p_today (la fecha
-- de negocio la calcula la aplicacion con la zona horaria de la property). Una property
-- por llamada = una transaccion por unidad en el barrido. Cierra tambien las
-- solicitudes pendientes de esas identidades. Devuelve cuantas purgo.
create or replace function hoteles.purge_expired_identities(p_property_id uuid, p_today date)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_count integer;
begin
  if auth.uid() is not null then
    raise exception 'purge_expired_identities: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  with purged as (
    update hoteles.identity_vault
       set payload_enc = null, document_last4 = null, nationality = null, status = 'purgado', purged_at = now()
     where property_id = p_property_id and status = 'activo' and retention_until < p_today
    returning id, organization_id, property_id
  ), closed as (
    update hoteles.identity_purge_request r
       set status = 'ejecutada', decided_at = now(), decision_note = 'purga por vencimiento de retencion'
      from purged p where r.vault_id = p.id and r.status = 'pendiente'
    returning r.id
  ), logged as (
    insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action, reason)
    select organization_id, property_id, id, null, 'purga_por_retencion', 'retencion vencida' from purged
    returning 1
  )
  select count(*)::integer into v_count from purged;
  return v_count;
end;
$$;
revoke all on function hoteles.purge_expired_identities(uuid, date) from public, anon;
grant execute on function hoteles.purge_expired_identities(uuid, date) to authenticated;
