-- H-42 (P1) hoteles -- MOTOR DE RESERVAS DIRECTO PUBLICO (web, sin login): disponibilidad, cotizacion con guardia de precio,
-- hold con anticipo opcional, confirmacion, estado y cancelacion por token. Alimenta el KPI "room-nights directas".
--
-- Principio de diseno (igual que 037): la base es la autoridad. La API publica corre en sesion de SISTEMA (auth.uid() is null) y NUNCA
-- manda un precio: el total vigente se recalcula aqui (agent_quote_core) y el hold solo se crea si coincide con lo que el huesped vio.
-- Reutiliza 037 (booking_hold / booking_hold_event / agent_stay_options / agent_quote_core / agent_validate_stay / expiracion y
-- liberacion de inventario bajo el MISMO advisory lock): un hold web retiene inventario SIN sobreventa, asi que dos confirmaciones por
-- la ultima habitacion se serializan y la segunda falla con sin_disponibilidad. El staff ve los holds web en la misma cola de holds.
--
-- Requiere: 001, 005 (reservation, cancellation_policy), 029, 030, 035, 036, 037. Expand-only: agrega columnas con default o nulas, un
-- valor al CHECK de canal y funciones nuevas; no cambia el comportamiento de WhatsApp/voz. Las dos funciones de 037 que se reemplazan
-- (booking_policy_of y booking_hold_confirm) conservan su firma y su comportamiento previo para los holds que no son web.
--
-- REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: el TypeScript que llama a estas columnas/funciones captura 42P01/42883/42703 dentro de
-- un SAVEPOINT y degrada a "no disponible aun" (503 honesto o lista vacia), nunca a un 500.

-- ---------------------------------------------------------------------------
-- 1) Canal 'web' y datos de la reserva directa en el hold.
--    Seguridad: ninguna columna nueva tiene GRANT para authenticated (solo SELECT de tabla, ya existente por RLS de staff). Las escribe
--    unicamente las funciones definer de abajo. El CHECK de coherencia impide un hold web sin correo ni consentimiento del aviso.
-- ---------------------------------------------------------------------------
alter table hoteles.booking_hold drop constraint if exists booking_hold_channel_check;
alter table hoteles.booking_hold add constraint booking_hold_channel_check check (channel in ('whatsapp', 'voz', 'web'));

alter table hoteles.booking_hold
  add column guest_email text check (guest_email is null or char_length(guest_email) between 5 and 254),
  add column consent_notice_version text check (consent_notice_version is null or char_length(consent_notice_version) between 1 and 60),
  add column consented_at timestamptz,
  -- Anticipo (centavos) que exige la politica del hotel para el canal web; 0 = sin anticipo (queda para aprobacion humana).
  add column deposit_cents bigint not null default 0 check (deposit_cents >= 0),
  -- no_requerido: sin anticipo. pendiente: esperando pago. capturado: cobrado por la pasarela (payment_ref = id del PaymentIntent).
  -- fallido: la pasarela rechazo el intento (se puede reintentar). manual: el staff confirmo el pago fuera de la plataforma.
  add column payment_status text not null default 'no_requerido' check (payment_status in ('no_requerido', 'pendiente', 'capturado', 'fallido', 'manual')),
  add column payment_ref text check (payment_ref is null or char_length(payment_ref) between 1 and 200),
  add column canceled_at timestamptz,
  add column cancel_penalty_cents bigint check (cancel_penalty_cents is null or cancel_penalty_cents >= 0),
  add column refund_cents bigint check (refund_cents is null or refund_cents >= 0),
  add column refund_status text check (refund_status is null or refund_status in ('no_aplica', 'solicitado', 'procesado')),
  add constraint booking_hold_deposit_le_total check (deposit_cents <= total_cents),
  add constraint booking_hold_web_requires_contact_and_consent check (channel <> 'web' or (guest_email is not null and consent_notice_version is not null and consented_at is not null));

-- Politica del canal web por hotel. Fail-closed: sin opt-in explicito (web_enabled) NO hay reservas web; el anticipo es un porcentaje
-- del total (0 = sin anticipo, el hold queda para aprobacion humana). Escritura por COLUMNA y solo owner/gm (RLS de 037).
alter table hoteles.booking_agent_policy
  add column web_enabled boolean not null default false,
  add column web_deposit_pct numeric(5, 4) not null default 0 check (web_deposit_pct >= 0 and web_deposit_pct <= 1);
grant insert (web_enabled, web_deposit_pct) on hoteles.booking_agent_policy to authenticated;
grant update (web_enabled, web_deposit_pct) on hoteles.booking_agent_policy to authenticated;

-- Canal de origen de la reserva (KPI room-nights directas). Nulo = reserva anterior a esta migracion o creada por el staff.
-- Sin GRANT de escritura para authenticated: solo lo fijan las funciones definer (hold web confirmado).
alter table hoteles.reservation
  add column channel text check (channel is null or channel in ('directo_web', 'whatsapp', 'voz', 'recepcion'));
create index reservation_property_channel_idx on hoteles.reservation (property_id, channel, check_in_date) where channel is not null;
-- Seguridad (defensa en profundidad): 005 otorgo INSERT a nivel TABLA a authenticated; con la columna nueva eso dejaria al staff con rol de
-- reservas FIJAR el canal 'directo_web' desde el cliente y falsear el KPI. Se reemplaza por INSERT por COLUMNA con TODAS las columnas
-- existentes salvo `channel` (UPDATE ya es por columna desde 005/018 y no incluye `channel`). El canal solo lo fijan las funciones definer.
revoke insert on hoteles.reservation from authenticated;
grant insert (id, organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, created_at, updated_at, canceled_at,
              cancellation_penalty_amount, total_amount, idempotency_key, room_id) on hoteles.reservation to authenticated;

-- Politica efectiva: ahora tambien rellena los defaults del canal web (sin fila => web deshabilitado). Misma firma que 037.
create or replace function hoteles.booking_policy_of(p_property_id uuid)
returns hoteles.booking_agent_policy language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  p hoteles.booking_agent_policy;
begin
  select * into p from hoteles.booking_agent_policy where property_id = p_property_id;
  if not found then
    p.property_id := p_property_id;
    p.holds_enabled := false;
    p.mode := 'aprobacion_humana';
    p.hold_ttl_minutes := 120;
    p.max_nights := 14;
    p.max_guests := 6;
    p.max_advance_days := 365;
    p.max_active_holds := 40;
    p.web_enabled := false;
    p.web_deposit_pct := 0;
  end if;
  return p;
end;
$$;

-- Confirmacion del STAFF (037) con el canal de origen: un hold web confirmado por una persona tambien cuenta como room-night directa.
-- Mismo comportamiento que 037 para whatsapp/voz (channel queda nulo). Si el hold web exigia anticipo y nadie lo cobro por la
-- pasarela, queda 'manual' (el staff lo confirmo fuera de la plataforma).
create or replace function hoteles.booking_hold_confirm(p_hold_id uuid)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  h hoteles.booking_hold := hoteles.booking_hold_lock(p_hold_id);
  v_res uuid;
begin
  if h.status not in ('aprobado', 'pendiente_pago') then
    raise exception 'solo un hold aprobado o pendiente de pago se confirma (estado: %)', h.status using errcode = '55000';
  end if;
  if h.expires_at <= now() then
    perform hoteles.booking_hold_expire_core(h.property_id, now());
    select * into h from hoteles.booking_hold where id = p_hold_id;
    return h;
  end if;
  insert into hoteles.reservation (organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount, idempotency_key, channel)
  values (h.organization_id, h.property_id, h.room_type_id, h.check_in_date, h.check_out_date, 'confirmada', h.net_cents::numeric / 100, 'hold-' || h.id::text,
          case h.channel when 'web' then 'directo_web' else null end)
  on conflict (property_id, idempotency_key) where idempotency_key is not null do update set updated_at = hoteles.reservation.updated_at
  returning id into v_res;
  update hoteles.booking_hold set status = 'confirmado', reservation_id = v_res, decided_by = coalesce(decided_by, auth.uid()),
         decided_at = coalesce(decided_at, now()),
         payment_status = case when h.channel = 'web' and h.deposit_cents > 0 and h.payment_status <> 'capturado' then 'manual' else h.payment_status end
   where id = h.id returning * into h;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'confirmado', jsonb_build_object('reservaId', v_res));
  return h;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Funciones del canal web (SOLO sesion de sistema: auth.uid() is null). Nunca confian en un precio, un rol ni un reloj del cliente.
-- ---------------------------------------------------------------------------
-- Politica publica del hotel para el canal web: si esta habilitado, que anticipo pide y los terminos de cancelacion vigentes (para mostrarlos ANTES
-- de reservar). No expone topes internos (max_active_holds) ni datos de huespedes.
create or replace function hoteles.web_booking_policy(p_property_id uuid)
returns table (web_enabled boolean, holds_enabled boolean, web_deposit_pct numeric, hold_ttl_minutes integer, max_nights integer, max_guests integer, max_advance_days integer,
               free_until_hours integer, penalty_pct numeric)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  pol hoteles.booking_agent_policy;
  cp hoteles.cancellation_policy;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (reserva publica) consulta la politica' using errcode = '42501';
  end if;
  if not exists (select 1 from core.property pr where pr.id = p_property_id and pr.vertical = 'hoteles') then
    raise exception 'property no encontrada' using errcode = 'P0002';
  end if;
  pol := hoteles.booking_policy_of(p_property_id);
  select * into cp from hoteles.cancellation_policy where property_id = p_property_id;
  return query select pol.web_enabled, pol.holds_enabled, pol.web_deposit_pct, pol.hold_ttl_minutes, pol.max_nights, pol.max_guests, pol.max_advance_days,
                      cp.free_until_hours, cp.penalty_pct;
end;
$$;

-- Crea (o devuelve, por la misma llave de idempotencia) el hold del canal web. A diferencia de booking_hold_create de 037 NO hace dedupe
-- por telefono/tipo/fechas con otra llave: un token publico nunca debe poder apuntar al hold de otra persona. La proteccion contra
-- acaparamiento es el tope de holds abiertos por telefono, por correo y por hotel.
create or replace function hoteles.web_booking_hold_create(
  p_property_id uuid, p_room_type_id uuid, p_check_in date, p_check_out date, p_guests integer, p_guest_name text,
  p_contact_phone text, p_contact_email text, p_idempotency_key text, p_expected_total_cents bigint, p_consent_notice_version text,
  p_now timestamptz default null
) returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  pol hoteles.booking_agent_policy;
  v_org uuid;
  v_max_occ integer;
  v_nights integer;
  q record;
  h hoteles.booking_hold;
  v_name text := nullif(btrim(coalesce(p_guest_name, '')), '');
  v_phone text := btrim(coalesce(p_contact_phone, ''));
  v_email text := lower(btrim(coalesce(p_contact_email, '')));
  v_consent text := nullif(btrim(coalesce(p_consent_notice_version, '')), '');
  v_deposit bigint;
  d date;
  a hoteles.availability;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (reserva publica) crea holds web' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id and vertical = 'hoteles';
  if v_org is null then
    raise exception 'property no encontrada' using errcode = 'P0002';
  end if;
  pol := hoteles.booking_policy_of(p_property_id);
  if not pol.holds_enabled or not pol.web_enabled then
    raise exception 'web_deshabilitado: el hotel no habilito la reserva directa en linea' using errcode = '55000';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 120
     or char_length(v_phone) not between 4 and 32 or v_name is null or char_length(v_name) > 120
     or char_length(v_email) not between 5 and 254 or v_email !~ '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'parametros_invalidos: llave, nombre, telefono o correo fuera de rango' using errcode = '22023';
  end if;
  if v_consent is null or char_length(v_consent) > 60 then
    raise exception 'consentimiento_requerido: falta la version del aviso de privacidad aceptado' using errcode = '22023';
  end if;

  -- Idempotencia: una sola retencion por (property, llave), tambien ante concurrencia de la MISMA llave.
  perform pg_advisory_xact_lock(hashtextextended('booking_hold:' || p_property_id::text || ':' || p_idempotency_key, 0));
  select * into h from hoteles.booking_hold where property_id = p_property_id and idempotency_key = p_idempotency_key;
  if found then
    if h.channel <> 'web' or h.room_type_id is distinct from p_room_type_id or h.check_in_date is distinct from p_check_in
       or h.check_out_date is distinct from p_check_out or h.contact_phone is distinct from v_phone then
      raise exception 'idempotencia_conflicto: la llave ya se uso con otros parametros' using errcode = '22023';
    end if;
    return h;
  end if;

  v_nights := hoteles.agent_validate_stay(p_property_id, p_check_in, p_check_out, v_now);
  select max_occupancy into v_max_occ from hoteles.room_type where id = p_room_type_id and property_id = p_property_id;
  if not found then
    raise exception 'tipo_habitacion_invalido: no pertenece a la property' using errcode = 'P0002';
  end if;
  if p_guests is null or p_guests < 1 or p_guests > least(pol.max_guests, v_max_occ) then
    raise exception 'huespedes_invalidos: de 1 a % huespedes para este tipo', least(pol.max_guests, v_max_occ) using errcode = '22023';
  end if;

  perform hoteles.booking_hold_expire_core(p_property_id, v_now);
  if (select count(*) from hoteles.booking_hold where property_id = p_property_id and status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado')) >= pol.max_active_holds then
    raise exception 'limite_holds_activos: demasiados holds abiertos en el hotel' using errcode = '55000';
  end if;
  if (select count(*) from hoteles.booking_hold where property_id = p_property_id and status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado')
        and (contact_phone = v_phone or guest_email = v_email)) >= 2 then
    raise exception 'limite_holds_contacto: ya tiene 2 pre-reservas abiertas' using errcode = '55000';
  end if;

  select * into q from hoteles.agent_quote_core(p_property_id, p_room_type_id, p_check_in, p_check_out);
  if q.status <> 'ok' then
    raise exception 'cotizacion_no_disponible: %', q.status using errcode = '22023';
  end if;
  if p_expected_total_cents is distinct from q.total_cents then
    raise exception 'precio_cambio: el total vigente es % centavos', q.total_cents using errcode = '22023';
  end if;

  -- Retencion todo-o-nada SIN sobreventa, orden determinista por noche (misma que 037: no hay interbloqueo entre holds).
  for d in select g::date from generate_series(p_check_in, p_check_out - 1, interval '1 day') g order by 1 loop
    perform hoteles.lock_availability(p_property_id, p_room_type_id, d);
    select * into a from hoteles.availability av where av.property_id = p_property_id and av.room_type_id = p_room_type_id and av.date = d for update;
    if not found or a.booked_rooms + 1 > a.total_rooms then
      raise exception 'sin_disponibilidad: no hay habitaciones libres para room_type=%, fecha=%', p_room_type_id, d using errcode = 'P0001';
    end if;
    update hoteles.availability set booked_rooms = booked_rooms + 1, updated_at = now() where id = a.id;
  end loop;

  -- Anticipo = porcentaje del total, half-up, nunca mayor al total. Con anticipo el hold espera el pago; sin anticipo espera a una persona.
  v_deposit := least(floor(q.total_cents * pol.web_deposit_pct + 0.5)::bigint, q.total_cents);
  insert into hoteles.booking_hold (organization_id, property_id, room_type_id, check_in_date, check_out_date, nights, guests, channel, guest_name,
    contact_phone, idempotency_key, net_cents, iva_cents, ish_cents, total_cents, nightly, mode, status, expires_at,
    guest_email, consent_notice_version, consented_at, deposit_cents, payment_status)
  values (v_org, p_property_id, p_room_type_id, p_check_in, p_check_out, v_nights, p_guests, 'web', v_name,
    v_phone, p_idempotency_key, q.net_cents, q.iva_cents, q.ish_cents, q.total_cents, q.nightly,
    case when v_deposit > 0 then 'link_pago' else 'aprobacion_humana' end,
    case when v_deposit > 0 then 'pendiente_pago' else 'pendiente_aprobacion' end,
    v_now + make_interval(mins => pol.hold_ttl_minutes),
    v_email, v_consent, v_now, v_deposit, case when v_deposit > 0 then 'pendiente' else 'no_requerido' end)
  returning * into h;
  perform hoteles.booking_hold_log(v_org, p_property_id, h.id, 'creado',
    jsonb_build_object('canal', 'web', 'modo', h.mode, 'totalCentavos', h.total_cents, 'anticipoCentavos', h.deposit_cents, 'noches', h.nights, 'expira', h.expires_at,
                       'avisoVersion', v_consent));
  return h;
end;
$$;

-- Lectura de un hold WEB por id (el id sale de un token firmado por la API; aqui ademas se exige property y canal). Vence primero los
-- holds abiertos de la property, igual que 037. No existe el hold, no es web o es de otra property => P0002 (la misma respuesta).
create or replace function hoteles.web_booking_get(p_property_id uuid, p_hold_id uuid, p_now timestamptz default null)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  h hoteles.booking_hold;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (reserva publica) consulta' using errcode = '42501';
  end if;
  perform hoteles.booking_hold_expire_core(p_property_id, v_now);
  select * into h from hoteles.booking_hold where id = p_hold_id and property_id = p_property_id and channel = 'web';
  if not found then
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  return h;
end;
$$;

-- Contexto de presentacion de un hold web: nombre del tipo, estado de la reserva y terminos de cancelacion vigentes. Sin datos de otros huespedes.
create or replace function hoteles.web_booking_context(p_property_id uuid, p_hold_id uuid)
returns table (room_type_name text, reservation_status text, free_until_hours integer, penalty_pct numeric, property_name text)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (reserva publica) consulta' using errcode = '42501';
  end if;
  return query
    select rt.name, r.status::text, cp.free_until_hours, cp.penalty_pct, pr.name
      from hoteles.booking_hold h
      join hoteles.room_type rt on rt.id = h.room_type_id
      join core.property pr on pr.id = h.property_id
      left join hoteles.reservation r on r.id = h.reservation_id
      left join hoteles.cancellation_policy cp on cp.property_id = h.property_id
     where h.id = p_hold_id and h.property_id = p_property_id and h.channel = 'web';
end;
$$;

-- Registra el resultado del cobro (la pasarela corre en la API, nunca aqui). capturado: convierte el hold en reserva confirmada con canal
-- 'directo_web' (el inventario ya estaba retenido por el hold: no se vuelve a reservar). fallido/pendiente: solo actualiza el estado de pago.
-- Idempotente: un hold ya confirmado se devuelve igual.
create or replace function hoteles.web_booking_record_payment(p_property_id uuid, p_hold_id uuid, p_status text, p_ref text, p_now timestamptz default null)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  h hoteles.booking_hold;
  v_res uuid;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (reserva publica) registra pagos' using errcode = '42501';
  end if;
  if p_status not in ('capturado', 'fallido', 'pendiente') or (p_ref is not null and char_length(p_ref) not between 1 and 200) then
    raise exception 'parametros_invalidos: estado de pago o referencia invalidos' using errcode = '22023';
  end if;
  select * into h from hoteles.booking_hold where id = p_hold_id and property_id = p_property_id and channel = 'web' for update;
  if not found then
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  if h.status = 'confirmado' then
    return h;
  end if;
  if h.status <> 'pendiente_pago' then
    raise exception 'estado_no_valido: el hold esta en estado %', h.status using errcode = '55000';
  end if;
  if h.expires_at <= v_now then
    perform hoteles.booking_hold_expire_core(h.property_id, v_now);
    select * into h from hoteles.booking_hold where id = p_hold_id;
    return h;
  end if;
  if p_status <> 'capturado' then
    update hoteles.booking_hold set payment_status = p_status, payment_ref = coalesce(p_ref, payment_ref) where id = h.id returning * into h;
    perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'pago_' || p_status, '{}'::jsonb);
    return h;
  end if;
  insert into hoteles.reservation (organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount, idempotency_key, channel)
  values (h.organization_id, h.property_id, h.room_type_id, h.check_in_date, h.check_out_date, 'confirmada', h.net_cents::numeric / 100, 'hold-' || h.id::text, 'directo_web')
  on conflict (property_id, idempotency_key) where idempotency_key is not null do update set updated_at = hoteles.reservation.updated_at
  returning id into v_res;
  update hoteles.booking_hold set status = 'confirmado', reservation_id = v_res, decided_at = v_now, payment_status = 'capturado', payment_ref = p_ref
   where id = h.id returning * into h;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'confirmado_web_pago', jsonb_build_object('reservaId', v_res, 'anticipoCentavos', h.deposit_cents));
  return h;
end;
$$;

-- Cancelacion por el huesped (token). Hold abierto: libera el inventario y lo marca cancelado (sin penalidad: nunca se capturo dinero).
-- Hold confirmado: aplica cancellation_policy del hotel (misma regla que la cancelacion del staff: sin ventana libre configurada no hay
-- penalidad; las horas se miden contra la fecha de llegada a las 00:00 UTC), libera TODAS las noches y cancela la reserva. La penalidad se
-- calcula sobre el TOTAL cotizado al huesped; el reembolso es lo cobrado menos la penalidad y queda 'solicitado' hasta que la API lo procese
-- o el staff lo atienda. Idempotente: un hold ya cancelado se devuelve igual. Una reserva ya en check-in o posterior NO se cancela aqui.
create or replace function hoteles.web_booking_cancel(p_property_id uuid, p_hold_id uuid, p_now timestamptz default null)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  h hoteles.booking_hold;
  cp hoteles.cancellation_policy;
  v_hours numeric;
  v_pct numeric := 0;
  v_penalty bigint := 0;
  v_paid bigint;
  v_refund bigint;
  v_claimed uuid;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (reserva publica) cancela' using errcode = '42501';
  end if;
  perform hoteles.booking_hold_expire_core(p_property_id, v_now);
  select * into h from hoteles.booking_hold where id = p_hold_id and property_id = p_property_id and channel = 'web' for update;
  if not found then
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  if h.canceled_at is not null or h.status = 'cancelado' then
    return h;
  end if;
  if h.status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado') then
    perform hoteles.booking_hold_release_inventory(h);
    update hoteles.booking_hold set status = 'cancelado', canceled_at = v_now, cancel_penalty_cents = 0, refund_cents = 0, refund_status = 'no_aplica'
     where id = h.id returning * into h;
    perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'cancelado_por_huesped_web', '{}'::jsonb);
    return h;
  end if;
  if h.status <> 'confirmado' then
    raise exception 'estado_no_cancelable: la reserva esta en estado %', h.status using errcode = '55000';
  end if;

  select * into cp from hoteles.cancellation_policy where property_id = h.property_id;
  if found then
    v_hours := extract(epoch from ((h.check_in_date::timestamp at time zone 'UTC') - v_now)) / 3600.0;
    if v_hours < cp.free_until_hours then
      v_pct := cp.penalty_pct;
    end if;
  end if;
  v_penalty := floor(h.total_cents * v_pct + 0.5)::bigint;
  v_paid := case when h.payment_status in ('capturado', 'manual') then h.deposit_cents else 0 end;
  v_refund := greatest(v_paid - v_penalty, 0);

  -- Reclamo atomico de la reserva: solo quien gana libera inventario (un doble clic nunca libera dos veces).
  perform set_config('hoteles.actor_user_id', '', true);
  update hoteles.reservation set status = 'cancelada', canceled_at = v_now, cancellation_penalty_amount = v_penalty::numeric / 100
   where id = h.reservation_id and status = 'confirmada' returning id into v_claimed;
  if v_claimed is null then
    raise exception 'estado_no_cancelable: la reserva ya no admite cancelacion en linea' using errcode = '55000';
  end if;
  perform hoteles.booking_hold_release_inventory(h);
  update hoteles.booking_hold set canceled_at = v_now, cancel_penalty_cents = v_penalty, refund_cents = v_refund,
         refund_status = case when v_refund > 0 then 'solicitado' else 'no_aplica' end
   where id = h.id returning * into h;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'cancelado_por_huesped_web',
    jsonb_build_object('penalidadCentavos', v_penalty, 'reembolsoCentavos', v_refund, 'horasAnticipacion', round(coalesce(v_hours, 0), 2)));
  return h;
end;
$$;

-- Marca el reembolso como procesado por la pasarela (lo llama la API tras un refund exitoso). Solo un reembolso 'solicitado'.
create or replace function hoteles.web_booking_mark_refunded(p_property_id uuid, p_hold_id uuid, p_ref text)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  h hoteles.booking_hold;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (reserva publica) registra reembolsos' using errcode = '42501';
  end if;
  select * into h from hoteles.booking_hold where id = p_hold_id and property_id = p_property_id and channel = 'web' for update;
  if not found then
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  if h.refund_status = 'procesado' then
    return h;
  end if;
  if h.refund_status is distinct from 'solicitado' or p_ref is null or char_length(p_ref) not between 1 and 200 then
    raise exception 'estado_no_valido: no hay un reembolso solicitado' using errcode = '55000';
  end if;
  update hoteles.booking_hold set refund_status = 'procesado' where id = h.id returning * into h;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'reembolso_procesado', jsonb_build_object('referencia', p_ref));
  return h;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) GRANT. Misma convencion que 037: la sesion de sistema de la API corre como authenticated con auth.uid() null, por eso estas
--    funciones llevan EXECUTE para authenticated y service_role y se protegen con el guard auth.uid() is null (un staff con sesion real
--    recibe 42501). Nada para anon ni public.
-- ---------------------------------------------------------------------------
revoke all on function hoteles.web_booking_policy(uuid) from public, anon;
revoke all on function hoteles.web_booking_hold_create(uuid, uuid, date, date, integer, text, text, text, text, bigint, text, timestamptz) from public, anon;
revoke all on function hoteles.web_booking_get(uuid, uuid, timestamptz) from public, anon;
revoke all on function hoteles.web_booking_context(uuid, uuid) from public, anon;
revoke all on function hoteles.web_booking_record_payment(uuid, uuid, text, text, timestamptz) from public, anon;
revoke all on function hoteles.web_booking_cancel(uuid, uuid, timestamptz) from public, anon;
revoke all on function hoteles.web_booking_mark_refunded(uuid, uuid, text) from public, anon;
revoke all on function hoteles.booking_policy_of(uuid) from public, anon, authenticated;
revoke all on function hoteles.booking_hold_confirm(uuid) from public, anon;

grant execute on function hoteles.web_booking_policy(uuid) to authenticated, service_role;
grant execute on function hoteles.web_booking_hold_create(uuid, uuid, date, date, integer, text, text, text, text, bigint, text, timestamptz) to authenticated, service_role;
grant execute on function hoteles.web_booking_get(uuid, uuid, timestamptz) to authenticated, service_role;
grant execute on function hoteles.web_booking_context(uuid, uuid) to authenticated, service_role;
grant execute on function hoteles.web_booking_record_payment(uuid, uuid, text, text, timestamptz) to authenticated, service_role;
grant execute on function hoteles.web_booking_cancel(uuid, uuid, timestamptz) to authenticated, service_role;
grant execute on function hoteles.web_booking_mark_refunded(uuid, uuid, text) to authenticated, service_role;
grant execute on function hoteles.booking_hold_confirm(uuid) to authenticated, service_role;
