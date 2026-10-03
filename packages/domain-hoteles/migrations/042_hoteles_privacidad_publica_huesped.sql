-- H-30 (P1) -- SUPERFICIE PUBLICA DE PRIVACIDAD DEL HUESPED: aviso vigente por hotel sin login, solicitud ARCO
-- publica con verificacion por codigo de un solo uso, exportacion de datos del huesped (staff) y consulta
-- "mis datos" por enlace firmado (el titular, tras resolverse su ARCO de acceso).
--
-- Requiere: 032 (aviso, arco_request, privacy_event_log, identity_consent), 038 (guest_note) y 014
-- (hoteles.messaging_outbox con canal email). NO edita 032: solo amplia tres CHECKs y agrega objetos nuevos.
--
-- Modelo de seguridad (cada pieza lleva su justificacion):
--   * Superficie PUBLICA = sin sesion de usuario. La API abre una sesion de SISTEMA (auth.uid() es nulo) y SOLO
--     puede llamar las funciones "public_*"/"arco_access_context"/"arco_access_snapshot", que exigen
--     auth.uid() is null: un usuario autenticado de otro tenant no las alcanza por PostgREST con su JWT, y `anon`
--     no tiene EXECUTE sobre ninguna (revoke de public/anon). Ninguna tabla recibe GRANT a anon.
--   * Las tablas nuevas no tienen GRANT ni policy para clientes: todo pasa por funciones security definer con
--     search_path fijo (sin using (true)).
--   * Verificacion: la API manda a la base un HMAC-SHA256 del codigo (llave del servidor) y la base solo compara ese
--     hash (no guarda el codigo en arco_public_verification); expira, tiene 5 intentos y es de un solo uso (used_at).
--     Matiz: el correo con el codigo (y el de 'mis datos' con su token) viaja en claro en el payload de
--     hoteles.messaging_outbox, que solo lee service_role (008); no es legible por clientes.
--   * La exportacion del staff y la bitacora son UNA sola funcion definer: no existe un camino que exporte sin
--     dejar huella en privacy_event_log. El documento de identidad nunca sale: solo id, tipo, estado y vigencia.

-- ---------------------------------------------------------------------------
-- 0) Ampliar tres CHECKs de 032 (nombres autogenerados: se localizan por definicion).
--    - arco_request.channel += 'publico' (origen de la solicitud hecha por el titular sin login).
--    - arco_request.status  += 'pendiente_verificacion' (aun no es una solicitud recibida: no corre plazo ni
--      aparece al staff hasta que el titular verifica su correo). Ninguna funcion de 032 la avanza
--      (advance_arco_request exige recibida/en_revision/procedente).
--    - privacy_event_log.subject_type += 'exportacion'.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select conname from pg_constraint
            where conrelid = 'hoteles.arco_request'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%mostrador%' loop
    execute format('alter table hoteles.arco_request drop constraint %I', r.conname);
  end loop;
  for r in select conname from pg_constraint
            where conrelid = 'hoteles.arco_request'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%en_revision%' and pg_get_constraintdef(oid) ilike '%improcedente%'
              and pg_get_constraintdef(oid) not ilike '%decided_on%' loop
    execute format('alter table hoteles.arco_request drop constraint %I', r.conname);
  end loop;
  for r in select conname from pg_constraint
            where conrelid = 'hoteles.privacy_event_log'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%acceso_excepcional%' loop
    execute format('alter table hoteles.privacy_event_log drop constraint %I', r.conname);
  end loop;
end $$;

alter table hoteles.arco_request
  add constraint arco_request_channel_check check (channel in ('mostrador', 'correo', 'whatsapp', 'web', 'telefono', 'otro', 'publico'));
alter table hoteles.arco_request
  add constraint arco_request_status_check check (status in ('pendiente_verificacion', 'recibida', 'en_revision', 'procedente', 'improcedente', 'ejecutada'));
alter table hoteles.privacy_event_log
  add constraint privacy_event_log_subject_type_check check (subject_type in ('arco', 'incidente', 'retencion_legal', 'aviso', 'consentimiento', 'configuracion', 'acceso_excepcional', 'exportacion'));

-- Una solicitud publica sin verificar tiene datos personales (nombre y correo): indice parcial para el tope por
-- contacto y para la limpieza oportunista de las no verificadas.
create index arco_request_pending_verification_idx
  on hoteles.arco_request (property_id, lower(requester_contact), created_at)
  where status = 'pendiente_verificacion';

-- ---------------------------------------------------------------------------
-- 1) Verificacion por codigo de un solo uso. SIN GRANT ni policy a clientes (RLS activa): solo funciones definer.
-- ---------------------------------------------------------------------------
create table hoteles.arco_public_verification (
  request_id uuid primary key references hoteles.arco_request(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  -- HMAC-SHA256 hex (64) del codigo, calculado por la API con la llave del servidor. Nunca el codigo.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table hoteles.arco_public_verification enable row level security;
revoke all on hoteles.arco_public_verification from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Aviso vigente por hotel (lectura publica). SOLO sistema. Devuelve el texto publico del aviso y nada mas:
--    sin ids de personas, sin quien lo publico, sin hash interno.
-- ---------------------------------------------------------------------------
create or replace function hoteles.public_privacy_notices(p_org_slug text)
returns table (
  out_org_name text, out_property_id uuid, out_property_name text, out_notice_id uuid, out_version text,
  out_simplified_text text, out_integral_url text, out_mandatory text[], out_optional text[], out_published_at timestamptz)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'public_privacy_notices: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return query
    select o.name, p.id, p.name, n.id, n.version, n.simplified_text, n.integral_url, n.mandatory_purposes, n.optional_purposes, n.published_at
      from core.organization o
      join core.property p on p.organization_id = o.id and p.status = 'active'
      left join hoteles.privacy_notice n on n.property_id = p.id and n.is_current
     where o.slug = p_org_slug and o.vertical = 'hoteles'
     order by p.name, p.id;
end;
$$;
revoke all on function hoteles.public_privacy_notices(text) from public, anon;
grant execute on function hoteles.public_privacy_notices(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Alta publica de una solicitud ARCO (pendiente de verificacion) + correo con el codigo en la cola existente.
--    SOLO sistema. El id lo genera la API (el HMAC del codigo lo liga a el). Devuelve el id (referencia opaca) o NULL si se alcanzo el tope por contacto: la API responde
--    igual en ambos casos (sin enumeracion). Limpieza oportunista: borra las no verificadas con mas de 7 dias.
-- ---------------------------------------------------------------------------
create or replace function hoteles.public_arco_submit(
  p_request_id uuid, p_property_id uuid, p_right_type text, p_name text, p_contact text, p_description text,
  p_code_hash text, p_ttl_seconds integer, p_email jsonb, p_today date)
returns uuid language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_id uuid := p_request_id;
  v_contact text := lower(btrim(coalesce(p_contact, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_utc_today date := (now() at time zone 'utc')::date;
  v_pending integer;
begin
  if auth.uid() is not null then
    raise exception 'public_arco_submit: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if v_id is null then
    raise exception 'referencia_invalida' using errcode = '22023';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.status = 'active' and p.vertical = 'hoteles';
  if v_org is null then
    raise exception 'property no disponible' using errcode = '42501';
  end if;
  if p_right_type not in ('acceso', 'rectificacion', 'cancelacion', 'oposicion') then
    raise exception 'derecho_invalido' using errcode = '22023';
  end if;
  if length(v_name) < 2 or length(v_name) > 200 then
    raise exception 'nombre_invalido' using errcode = '22023';
  end if;
  if length(v_contact) > 200 or v_contact !~ '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'contacto_invalido' using errcode = '22023';
  end if;
  if v_desc is not null and length(v_desc) > 1000 then
    raise exception 'descripcion_invalida' using errcode = '22023';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_ttl_seconds is null or p_ttl_seconds not between 300 and 3600 then
    raise exception 'codigo_invalido' using errcode = '22023';
  end if;
  if p_today is null or abs(p_today - v_utc_today) > 1 then
    raise exception 'fecha_invalida' using errcode = '22023';
  end if;

  -- Limpieza de datos personales de solicitudes que nunca se verificaron (minimizacion): 7 dias.
  delete from hoteles.arco_request r
   where r.property_id = p_property_id and r.status = 'pendiente_verificacion' and r.created_at < now() - interval '7 days';

  -- Tope por contacto: 3 solicitudes sin verificar en 24 h por property. Se descarta en silencio (NULL).
  select count(*) into v_pending from hoteles.arco_request r
   where r.property_id = p_property_id and r.status = 'pendiente_verificacion'
     and lower(r.requester_contact) = v_contact and r.created_at > now() - interval '24 hours';
  if v_pending >= 3 then
    return null;
  end if;

  insert into hoteles.arco_request (id, organization_id, property_id, folio, right_type, requester_name, requester_contact, channel, description,
                                    received_on, response_due_on, status)
  values (v_id, v_org, p_property_id, 'ARCO-' || to_char(p_today, 'YYYYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 6)),
          p_right_type, v_name, v_contact, 'publico', v_desc, p_today, p_today + 20, 'pendiente_verificacion');
  insert into hoteles.arco_public_verification (request_id, organization_id, property_id, code_hash, expires_at)
  values (v_id, v_org, p_property_id, p_code_hash, now() + make_interval(secs => p_ttl_seconds));
  if p_email is not null then
    perform hoteles.enqueue_messaging_outbox(p_property_id, v_org, 'email', 'arco.codigo_verificacion', 'arco-codigo:' || v_id::text, p_email);
  end if;
  perform hoteles.privacy_log_event(v_org, p_property_id, 'arco', v_id, 'solicitud_publica_creada', 'pendiente de verificacion (' || p_right_type || ')');
  return v_id;
end;
$$;
revoke all on function hoteles.public_arco_submit(uuid, uuid, text, text, text, text, text, integer, jsonb, date) from public, anon;
grant execute on function hoteles.public_arco_submit(uuid, uuid, text, text, text, text, text, integer, jsonb, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Verificacion del codigo. SOLO sistema. Un intento fallido suma al contador (se persiste: la funcion no lanza);
--    al 5o intento queda agotado. Exito: la solicitud pasa a 'recibida' y el plazo de respuesta corre desde hoy
--    (recepcion = fecha de verificacion en la zona horaria de la property; 20 dias NATURALES, el computo conservador de
--    032). Un solo uso.
--    out_result: ok | invalido | expirado | agotado | usado (la API responde lo mismo para todo lo que no sea ok).
-- ---------------------------------------------------------------------------
create or replace function hoteles.public_arco_verify(p_request_id uuid, p_code_hash text, p_today date)
returns table (out_result text, out_organization_id uuid, out_property_id uuid, out_folio text)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v hoteles.arco_public_verification%rowtype;
  v_req hoteles.arco_request%rowtype;
  v_utc_today date := (now() at time zone 'utc')::date;
  v_today date;
begin
  if auth.uid() is not null then
    raise exception 'public_arco_verify: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_today is not null and abs(p_today - v_utc_today) > 1 then
    raise exception 'fecha_invalida' using errcode = '22023';
  end if;
  select * into v from hoteles.arco_public_verification where request_id = p_request_id for update;
  if not found then
    return query select 'invalido'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  select * into v_req from hoteles.arco_request where id = p_request_id for update;
  if v.used_at is not null or v_req.status <> 'pendiente_verificacion' then
    return query select 'usado'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  if v.expires_at <= now() then
    return query select 'expirado'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  if v.attempts >= 5 then
    return query select 'agotado'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_code_hash <> v.code_hash then
    update hoteles.arco_public_verification set attempts = attempts + 1 where request_id = p_request_id;
    return query select 'invalido'::text, null::uuid, null::uuid, null::text;
    return;
  end if;
  -- Fecha de negocio: la que manda la API o, si es NULL, la de la zona horaria de la property (default Mexico).
  v_today := coalesce(p_today, (now() at time zone coalesce((select c.timezone from hoteles.property_config c where c.property_id = v_req.property_id), 'America/Mexico_City'))::date);
  update hoteles.arco_public_verification set used_at = now() where request_id = p_request_id;
  update hoteles.arco_request
     set status = 'recibida', received_on = v_today, response_due_on = v_today + 20, updated_at = now()
   where id = p_request_id;
  perform hoteles.privacy_log_event(v_req.organization_id, v_req.property_id, 'arco', p_request_id, 'solicitud_publica_verificada', v_req.folio || ' (' || v_req.right_type || ')');
  return query select 'ok'::text, v_req.organization_id, v_req.property_id, v_req.folio;
end;
$$;
revoke all on function hoteles.public_arco_verify(uuid, text, date) from public, anon;
grant execute on function hoteles.public_arco_verify(uuid, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Snapshot de datos del huesped (INTERNO: no invocable por clientes). Un solo constructor para la exportacion del
--    staff y para "mis datos". p_scope 'staff' incluye notas internas y solicitudes de contacto; 'titular' solo
--    perfil, estancias, consentimientos e identidad (estado). El documento de identidad NUNCA sale: de la boveda
--    solo id, tipo, estado, verificada y vigencia (ni los ultimos digitos ni el sobre cifrado).
-- ---------------------------------------------------------------------------
create or replace function hoteles.guest_data_snapshot(p_property_id uuid, p_guest_id uuid, p_scope text)
returns jsonb language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_guest hoteles.guest%rowtype;
  v_key text;
  v_out jsonb;
begin
  select * into v_guest from hoteles.guest where id = p_guest_id and property_id = p_property_id;
  if not found then
    return null;
  end if;
  v_key := nullif(right(regexp_replace(coalesce(v_guest.phone, ''), '[^0-9]', '', 'g'), 10), '');
  v_out := jsonb_build_object(
    'perfil', jsonb_build_object('id', v_guest.id, 'nombre', v_guest.full_name, 'correo', v_guest.email, 'telefono', v_guest.phone, 'creadoEn', v_guest.created_at),
    'estancias', coalesce((
      select jsonb_agg(jsonb_build_object('reservaId', r.id, 'estado', r.status, 'entrada', r.check_in_date, 'salida', r.check_out_date,
                                          'tipoHabitacion', rt.name, 'habitacion', rm.code, 'total', r.total_amount) order by r.check_in_date desc, r.created_at desc)
        from hoteles.reservation r
        left join hoteles.room_type rt on rt.id = r.room_type_id
        left join hoteles.room rm on rm.id = r.room_id
       where r.property_id = p_property_id and r.guest_id = p_guest_id), '[]'::jsonb),
    'consentimientos', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'versionAviso', c.notice_version, 'finalidadesOpcionales', c.accepted_optional, 'canal', c.channel,
                                          'consentidoEn', c.consented_at, 'revocadoEn', c.revoked_at) order by c.consented_at desc)
        from hoteles.identity_consent c where c.property_id = p_property_id and c.guest_id = p_guest_id), '[]'::jsonb),
    'identidad', coalesce((
      select jsonb_agg(jsonb_build_object('id', v.id, 'tipoDocumento', v.document_type, 'estado', v.status, 'verificada', v.verified_at is not null,
                                          'conservarHasta', v.retention_until) order by v.created_at desc)
        from hoteles.identity_vault v where v.property_id = p_property_id and v.guest_id = p_guest_id), '[]'::jsonb));
  if p_scope = 'staff' then
    v_out := v_out || jsonb_build_object(
      'notas', coalesce((
        select jsonb_agg(jsonb_build_object('id', n.id, 'tipo', n.kind, 'texto', n.body, 'creadaEn', n.created_at, 'archivadaEn', n.archived_at) order by n.created_at desc)
          from hoteles.guest_note n where n.property_id = p_property_id and n.guest_id = p_guest_id), '[]'::jsonb),
      'solicitudesContacto', case when v_key is null then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('id', k.id, 'motivo', k.reason, 'origen', k.source, 'mensaje', k.message, 'creadaEn', k.created_at) order by k.created_at desc)
          from hoteles.contacto_no_operativo k
         where k.property_id = p_property_id and k.guest_phone is not null and right(regexp_replace(k.guest_phone, '[^0-9]', '', 'g'), 10) = v_key), '[]'::jsonb) end,
      'conversaciones', case when v_key is null then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('id', w.id, 'estado', w.status, 'actualizadaEn', w.updated_at, 'mensajes', w.messages) order by w.updated_at desc)
          from hoteles.whatsapp_conversations w
         where w.property_id = p_property_id and right(regexp_replace(w.phone, '[^0-9]', '', 'g'), 10) = v_key), '[]'::jsonb) end);
  end if;
  return v_out;
end;
$$;
revoke all on function hoteles.guest_data_snapshot(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Exportacion del staff: owner/gm (can_manage_catalog, igual que el resto de privacidad). Autoriza, construye el
--    documento y deja huella en privacy_event_log en la MISMA funcion: no hay exportacion sin bitacora.
--    p_format solo se registra (json|csv); el formato lo renderiza la API.
-- ---------------------------------------------------------------------------
create or replace function hoteles.export_guest_data(p_property_id uuid, p_guest_id uuid, p_format text)
returns jsonb language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_doc jsonb;
begin
  if auth.uid() is null then
    raise exception 'export_guest_data: requiere sesion de staff' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null or not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'property no disponible' using errcode = '42501';
  end if;
  if p_format not in ('json', 'csv') then
    raise exception 'formato_invalido' using errcode = '22023';
  end if;
  v_doc := hoteles.guest_data_snapshot(p_property_id, p_guest_id, 'staff');
  if v_doc is null then
    raise exception 'huesped no disponible' using errcode = '23503';
  end if;
  perform hoteles.privacy_log_event(v_org, p_property_id, 'exportacion', p_guest_id, 'exportar_datos_huesped', 'formato ' || p_format);
  return v_doc;
end;
$$;
revoke all on function hoteles.export_guest_data(uuid, uuid, text) from public, anon;
grant execute on function hoteles.export_guest_data(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Emision del enlace "mis datos": owner/gm sobre una solicitud de ACCESO ya procedente o ejecutada (los estados a
--    los que solo se llega desde 'recibida', es decir, tras la verificacion del titular o su alta en mostrador).
--    Liga el huesped a la solicitud (un huesped de la misma property; no se puede reasignar) y deja huella.
-- ---------------------------------------------------------------------------
create or replace function hoteles.arco_access_grant(p_request_id uuid, p_guest_id uuid)
returns table (out_organization_id uuid, out_property_id uuid, out_folio text, out_contact text, out_org_slug text, out_org_name text)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_req hoteles.arco_request%rowtype;
  v_guest_prop uuid;
begin
  if auth.uid() is null then
    raise exception 'arco_access_grant: requiere sesion de staff' using errcode = '42501';
  end if;
  select * into v_req from hoteles.arco_request where id = p_request_id for update;
  if not found or not hoteles.can_manage_catalog(v_req.property_id) then
    raise exception 'solicitud no disponible' using errcode = '42501';
  end if;
  if v_req.right_type <> 'acceso' or v_req.status not in ('procedente', 'ejecutada') then
    raise exception 'estado_invalido: el enlace solo se emite para una solicitud de acceso procedente' using errcode = 'P0001';
  end if;
  select property_id into v_guest_prop from hoteles.guest where id = p_guest_id;
  if v_guest_prop is distinct from v_req.property_id then
    raise exception 'guest_invalido: el huesped no pertenece a la property' using errcode = '23503';
  end if;
  if v_req.guest_id is not null and v_req.guest_id <> p_guest_id then
    raise exception 'guest_invalido: la solicitud ya esta ligada a otro huesped' using errcode = '23503';
  end if;
  if v_req.guest_id is null then
    update hoteles.arco_request set guest_id = p_guest_id, updated_at = now() where id = p_request_id;
  end if;
  perform hoteles.privacy_log_event(v_req.organization_id, v_req.property_id, 'arco', p_request_id, 'enlace_mis_datos_emitido', v_req.folio);
  return query select v_req.organization_id, v_req.property_id, v_req.folio, v_req.requester_contact, o.slug, o.name from core.organization o where o.id = v_req.organization_id;
end;
$$;
revoke all on function hoteles.arco_access_grant(uuid, uuid) from public, anon;
grant execute on function hoteles.arco_access_grant(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Consulta "mis datos" (titular, por enlace firmado que la API valida ANTES de llegar aqui). SOLO sistema.
--    Revalida en la base que la solicitud pertenezca al hotel del slug, siga siendo de acceso, procedente/ejecutada y ligada a
--    un huesped; si no, devuelve NULL (la API responde igual que con un token invalido). Cada consulta deja huella.
--    Solo alcance 'titular': sin notas internas, sin conversaciones.
-- ---------------------------------------------------------------------------
create or replace function hoteles.arco_access_snapshot(p_request_id uuid, p_org_slug text)
returns jsonb language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_req hoteles.arco_request%rowtype;
  v_doc jsonb;
begin
  if auth.uid() is not null then
    raise exception 'arco_access_snapshot: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  select r.* into v_req from hoteles.arco_request r join core.organization o on o.id = r.organization_id and o.slug = p_org_slug where r.id = p_request_id;
  if not found or v_req.right_type <> 'acceso' or v_req.status not in ('procedente', 'ejecutada') or v_req.guest_id is null then
    return null;
  end if;
  v_doc := hoteles.guest_data_snapshot(v_req.property_id, v_req.guest_id, 'titular');
  if v_doc is null then
    return null;
  end if;
  perform hoteles.privacy_log_event(v_req.organization_id, v_req.property_id, 'arco', p_request_id, 'mis_datos_consultado', v_req.folio);
  return v_doc || jsonb_build_object('folio', v_req.folio, 'solicitudId', v_req.id);
end;
$$;
revoke all on function hoteles.arco_access_snapshot(uuid, text) from public, anon;
grant execute on function hoteles.arco_access_snapshot(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Nota (core._arco_union): el estado nuevo 'pendiente_verificacion' de hoteles se clasifica como 'por_confirmar' en la
--    vista ARCO consolidada, pero NO en esta migracion: la ultima definicion de la funcion vive en 20240101000278
--    (rentas 028, que agrega rentas a la union) y ya esta aplicada en la base real, donde 277 llega despues y fuera de
--    orden; redefinirla aqui la dejaria pisada por 278 o, aplicada fuera de orden, quitaria la rama de rentas.
--    El cambio vive en la migracion posterior 20240101000294 (rentas 031). Entre 277 y 294 una solicitud
--    'pendiente_verificacion' saldria como 'resuelta' en core.org_list_arco_requests y core.platform_list_arco_requests,
--    por eso 294 debe aplicarse junto con 277.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 9) hoteles.extend_arco_request(): rechaza prorrogar una solicitud 'pendiente_verificacion'. Defensa en profundidad:
--     el plazo real empieza al verificar (public_arco_verify lo recalcula), asi que prorrogar antes gastaba la unica
--     prorroga sin efecto. Mismo cuerpo, permisos y GRANT que en 032; solo se agrega ese rechazo.
-- ---------------------------------------------------------------------------
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
  if v_req.status = 'pendiente_verificacion' then
    raise exception 'estado_invalido: la solicitud aun no esta verificada por el titular' using errcode = 'P0001';
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
