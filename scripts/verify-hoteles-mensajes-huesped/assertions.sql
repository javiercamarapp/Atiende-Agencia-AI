-- H-P3-03 (paridad3) -- MENSAJES AUTOMATICOS AL HUESPED DE HOTELES. Verifica contra Postgres REAL (nunca el mirror en memoria, que
-- jamas aplica RLS/GRANT/CHECK/triggers) que packages/domain-hoteles/migrations/046_hoteles_mensajes_huesped.sql cierra lo que dice
-- cerrar: candidatos derivados del estado real (holds, reservas, lista de espera) con zona horaria y ventana de gracia de 24 h,
-- configuracion por evento con RLS/GRANT por columna, idempotencia de la marca de envio, funciones de solo sistema (42501 para staff
-- y anon), historial con el estado del outbox, cross-tenant, y la retencion de conversaciones (vacia el texto, conserva la fila,
-- respeta la retencion legal y la ARCO abierta). La idempotencia CONCURRENTE (dos conexiones a la vez) la cubre ./run.sh.
-- Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI, auto-descubierto).
--
-- Convencion (igual que verify-hoteles-conversaciones): public.verify_expect_error(sql, sqlstate) exige el SQLSTATE exacto,
-- public.verify_assert(cond, msg) falla el escenario si cond no es cierto, public.verify_as(sub) fija authenticated con auth.uid() =
-- sub (sub vacio = SESION DE SISTEMA), public.verify_anon() y public.verify_su(). Fechas fijas de 2031 y p_ahora explicito.
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.verify_expect_error(p_sql text, p_sqlstate text) returns void
language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception 'esperaba SQLSTATE %, obtuve % (%) en: %', p_sqlstate, v_state, v_msg, p_sql;
    end if;
    return;
  end;
  raise exception 'esperaba SQLSTATE % pero la sentencia no fallo: %', p_sqlstate, p_sql;
end;
$$;
grant execute on function public.verify_expect_error(text, text) to public;

create or replace function public.verify_assert(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'asercion fallida: %', p_msg;
  end if;
end;
$$;
grant execute on function public.verify_assert(boolean, text) to public;

create or replace function public.verify_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
end;
$$;
create or replace function public.verify_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
create or replace function public.verify_su() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant execute on function public.verify_as(text), public.verify_anon(), public.verify_su() to public;



-- ---------------------------------------------------------------------------------------------------------------
-- Fixtures persistentes (superusuario). Dos hoteles (A y B). En A: 2 propiedades de zona distinta no hacen falta; B va en Tokio.
-- ---------------------------------------------------------------------------------------------------------------
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-mh'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-mh')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a05', 'housekeeping-a@example.com', 'Housekeeping A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;
insert into hoteles.whatsapp_channel_config (property_id, organization_id, phone_number_id, enabled) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '10000000000001', true)
on conflict do nothing;
-- Hotel B en Tokio (UTC+9): el instante de disparo de pre_llegada cae 15 h antes que el de Ciudad de Mexico (UTC-6).
insert into hoteles.property_config (property_id, organization_id, timezone) values
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'Asia/Tokyo')
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble')
on conflict do nothing;
insert into hoteles.guest (id, organization_id, property_id, full_name, email, phone) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Ana Torres', 'ana@example.com', '5511112222'),
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Beto Sin Contacto', null, null),
  ('00000000-0000-0000-0000-0000000c0004', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Carla B', 'carla@example.com', '5533334444')
on conflict do nothing;

-- Reservas: R1 confirmada creada hace 2 h (reserva.confirmada), R2 confirmada con llegada 4-jul (pre_llegada), R3 cerrada con salida
-- 2-jul (post_estancia), R4 cancelada (nunca), R5 de la reserva que nace del hold H3 (no duplica), R6 de B con llegada 4-jul.
-- p_ahora de TODO el archivo = 2031-07-02 20:00 UTC.
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount, created_at) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0001', '2031-08-10', '2031-08-12', 'confirmada', 2000, '2031-07-02 18:00:00+00'),
  ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0001', '2031-07-04', '2031-07-06', 'confirmada', 2000, '2031-06-01 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0001', '2031-06-29', '2031-07-02', 'cerrada', 3000, '2031-06-01 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000e0004', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0001', '2031-07-04', '2031-07-06', 'cancelada', 2000, '2031-07-02 18:00:00+00'),
  ('00000000-0000-0000-0000-0000000e0005', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0001', '2031-09-01', '2031-09-03', 'confirmada', 2000, '2031-07-02 19:00:00+00'),
  ('00000000-0000-0000-0000-0000000e0006', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-0000000c0004', '2031-07-04', '2031-07-06', 'confirmada', 2000, '2031-06-01 10:00:00+00'),
  ('00000000-0000-0000-0000-0000000e0007', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0002', '2031-07-04', '2031-07-06', 'confirmada', 2000, '2031-06-01 10:00:00+00')
on conflict do nothing;

-- Holds: H1 aprobado (decidido 19:00), H2 rechazado (19:30), H3 confirmado (reserva R5, correo de Ana), H4 expirado, H5 aprobado hace 3 dias
-- (fuera de la ventana), H6 pendiente (no es candidato), H7 de B aprobado.
insert into hoteles.booking_hold (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, nights, guests, channel, guest_name, contact_phone, idempotency_key, net_cents, iva_cents, ish_cents, total_cents, nightly, mode, status, expires_at, decided_at, decision_reason, reservation_id, updated_at) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-09-10', '2031-09-12', 2, 2, 'whatsapp', 'Ana', '+5215511112222', 'hold-mh-000001', 100000, 16000, 3000, 119000, '[]'::jsonb, 'aprobacion_humana', 'aprobado', '2031-07-03 19:00:00+00', '2031-07-02 19:00:00+00', 'ok', null, '2031-07-02 19:00:00+00'),
  ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-09-10', '2031-09-12', 2, 2, 'whatsapp', 'Beto', '+5215599990000', 'hold-mh-000002', 100000, 16000, 3000, 119000, '[]'::jsonb, 'aprobacion_humana', 'rechazado', '2031-07-03 19:00:00+00', '2031-07-02 19:30:00+00', 'sin cupo', null, '2031-07-02 19:30:00+00'),
  ('00000000-0000-0000-0000-0000000f1003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-09-01', '2031-09-03', 2, 2, 'whatsapp', 'Ana', '+5215511112222', 'hold-mh-000003', 100000, 16000, 3000, 119000, '[]'::jsonb, 'aprobacion_humana', 'confirmado', '2031-07-03 19:00:00+00', '2031-07-02 19:00:00+00', 'ok', '00000000-0000-0000-0000-0000000e0005', '2031-07-02 19:10:00+00'),
  ('00000000-0000-0000-0000-0000000f1004', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-09-10', '2031-09-12', 2, 2, 'voz', null, '+5215588887777', 'hold-mh-000004', 100000, 16000, 3000, 119000, '[]'::jsonb, 'aprobacion_humana', 'expirado', '2031-07-02 18:30:00+00', null, null, null, '2031-07-02 18:45:00+00'),
  ('00000000-0000-0000-0000-0000000f1005', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-09-10', '2031-09-12', 2, 2, 'whatsapp', 'Viejo', '+5215500000001', 'hold-mh-000005', 100000, 16000, 3000, 119000, '[]'::jsonb, 'aprobacion_humana', 'aprobado', '2031-06-30 19:00:00+00', '2031-06-29 19:00:00+00', 'ok', null, '2031-06-29 19:00:00+00'),
  ('00000000-0000-0000-0000-0000000f1006', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-09-10', '2031-09-12', 2, 2, 'whatsapp', 'Pendiente', '+5215500000002', 'hold-mh-000006', 100000, 16000, 3000, 119000, '[]'::jsonb, 'aprobacion_humana', 'pendiente_aprobacion', '2031-07-03 19:00:00+00', null, null, null, '2031-07-02 19:00:00+00'),
  ('00000000-0000-0000-0000-0000000f1007', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000d0004', '2031-09-10', '2031-09-12', 2, 2, 'whatsapp', 'Carla', '+5215533334444', 'hold-mh-000007', 100000, 16000, 3000, 119000, '[]'::jsonb, 'aprobacion_humana', 'aprobado', '2031-07-03 19:00:00+00', '2031-07-02 19:00:00+00', 'ok', null, '2031-07-02 19:00:00+00')
on conflict do nothing;

-- Lista de espera: W1 activa que se OFRECE ahora (la base sella offered_at = now()); W2 activa (no es candidata).
insert into hoteles.waitlist_entry (id, property_id, room_type_id, check_in_date, check_out_date, guests, guest_name, contact_phone, contact_email) values
  ('00000000-0000-0000-0000-0000000ab001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-10-10', '2031-10-12', 2, 'Dora Espera', '5577778888', 'dora@example.com'),
  ('00000000-0000-0000-0000-0000000ab002', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-10-10', '2031-10-12', 2, 'Eli Espera', null, 'eli@example.com')
on conflict do nothing;
update hoteles.waitlist_entry set status = 'ofrecida', offer_expires_at = now() + interval '1 day' where id = '00000000-0000-0000-0000-0000000ab001' and status = 'activa';

create or replace function public.verify_cand(p_evento text, p_ahora timestamptz default '2031-07-02 20:00:00+00') returns integer language sql security definer as $$
  select count(*)::integer from hoteles.sistema_candidatos_mensajes_huesped(p_ahora, 500) c where c.evento = p_evento
$$;
-- La lista de espera usa now() real (la base sella offered_at): su p_ahora es un minuto despues de ahora.
create or replace function public.verify_cand_now(p_evento text) returns integer language sql security definer as $$
  select count(*)::integer from hoteles.sistema_candidatos_mensajes_huesped(now() + interval '1 minute', 500) c where c.evento = p_evento
$$;
create or replace function public.verify_envio_n(p_property uuid) returns integer language sql security definer as $$
  select count(*)::integer from hoteles.mensaje_huesped_envio where property_id = p_property
$$;
create or replace function public.verify_outbox_mh_n(p_property uuid) returns integer language sql security definer as $$
  select count(*)::integer from hoteles.messaging_outbox where property_id = p_property and event_type like 'mh.%'
$$;
grant execute on function public.verify_cand(text, timestamptz), public.verify_cand_now(text), public.verify_envio_n(uuid), public.verify_outbox_mh_n(uuid) to public;

-- =============================================================================
-- (a) Candidatos derivados del estado real
-- =============================================================================

\echo '=== 1. los holds decididos, la reserva nueva y la oferta de lista de espera son candidatos; lo viejo, lo pendiente y lo cancelado no ==='
begin;
select public.verify_as('');
select public.verify_assert(public.verify_cand('hold.aprobado') = 2, 'aprobado: H1 (A) y H7 (B); H5 de hace 3 dias queda fuera');
select public.verify_assert(public.verify_cand('hold.rechazado') = 1, 'rechazado: H2');
select public.verify_assert(public.verify_cand('hold.confirmado') = 1, 'confirmado: H3');
select public.verify_assert(public.verify_cand('hold.vencido') = 1, 'vencido: H4');
select public.verify_assert(public.verify_cand('reserva.confirmada') = 1, 'solo R1: R4 esta cancelada, R5 nace de un hold, R6/R7 son viejas');
select public.verify_assert(public.verify_cand_now('lista_espera.ofrecida') = 1, 'solo W1 (ofrecida); W2 sigue activa');
select public.verify_assert(public.verify_cand('pre_llegada') = 0, 'pre_llegada esta APAGADA por omision');
select public.verify_assert(public.verify_cand('post_estancia') = 0, 'post_estancia esta APAGADA por omision');
select count(*) as sin_efectos_deberia_ser_0 from hoteles.mensaje_huesped_envio;
rollback;

\echo '=== 2. el candidato trae los datos correctos: contacto, canal, ventana de envio, correo del huesped del hold confirmado y ultimo entrante ==='
begin;
select public.verify_su();
insert into hoteles.whatsapp_inbound_events (message_id, property_id, phone_hash, status, claimed_at)
values ('wamid-mh-1', '00000000-0000-0000-0000-0000000a1a01', encode(sha256(convert_to('+5215511112222', 'UTF8')), 'hex'), 'processed', '2031-07-02 18:00:00+00');
select public.verify_as('');
select public.verify_assert((select c.telefono = '+5215511112222' and c.huesped_nombre = 'Ana' and c.total_centavos = 119000 and c.whatsapp_habilitado and c.phone_number_id = '10000000000001'
  and c.ventana_inicio = '08:00:00' and c.ventana_fin = '21:00:00' and c.zona_horaria = 'America/Mexico_City' and c.org_slug = 'hotel-a-mh' and c.propiedad_nombre = 'Hotel A - Property 1'
  and c.ultima_entrada_en = '2031-07-02 18:00:00+00'
  from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000f1001') c), 'campos del candidato H1');
select public.verify_assert((select c.correo = 'ana@example.com' from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, null, '00000000-0000-0000-0000-0000000f1003') c), 'el hold confirmado toma el correo del huesped de su reserva');
select public.verify_assert((select c.correo is null and c.ultima_entrada_en is null from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, null, '00000000-0000-0000-0000-0000000f1002') c), 'H2 sin correo ni entrante');
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, '00000000-0000-0000-0000-0000000b1b01')) = 1, 'acotar por propiedad: solo H7 de B');
select 1 as ok_campos;
rollback;

\echo '=== 3. ventana de envio de agent_guardrail: se refleja en el candidato ==='
begin;
select public.verify_su();
insert into hoteles.agent_guardrail (property_id, organization_id, send_window_start, send_window_end) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '09:30', '18:00');
select public.verify_as('');
select public.verify_assert((select c.ventana_inicio = '09:30:00' and c.ventana_fin = '18:00:00' from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, null, '00000000-0000-0000-0000-0000000f1001') c), 'ventana configurada');
select 1 as ok_ventana;
rollback;

-- =============================================================================
-- (b) Eventos con tiempo: pre_llegada y post_estancia, zona horaria, horas configurables
-- =============================================================================

\echo '=== 4. pre_llegada: encendida por gerencia, 48 h antes de las 00:00 de la zona de la propiedad (Mexico UTC-6 vs Tokio UTC+9) ==='
begin;
select public.verify_su();
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values
  ('00000000-0000-0000-0000-0000000a1a01', 'pre_llegada', true),
  ('00000000-0000-0000-0000-0000000b1b01', 'pre_llegada', true);
select public.verify_as('');
-- A (Mexico): llegada 4-jul 00:00 -6 h = 4-jul 06:00 UTC; menos 48 h = 2-jul 06:00 UTC: en ventana a las 20:00 UTC del 2-jul (R2 y R7).
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01') where evento = 'pre_llegada') = 2, 'Mexico: R2 y R7 en ventana');
-- B (Tokio): 4-jul 00:00 +9 h = 3-jul 15:00 UTC; menos 48 h = 1-jul 15:00 UTC: ya paso hace 29 h -> FUERA de la ventana de gracia.
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, '00000000-0000-0000-0000-0000000b1b01') where evento = 'pre_llegada') = 0, 'Tokio: ya paso la ventana de 24 h');
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 05:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01') where evento = 'pre_llegada') = 0, 'Mexico: antes del disparo (05:00 UTC) todavia no');
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-01 20:00:00+00', 500, '00000000-0000-0000-0000-0000000b1b01') where evento = 'pre_llegada') = 1, 'Tokio: el 1-jul 20:00 UTC si esta en ventana');
select 1 as ok_zona;
rollback;

\echo '=== 5. pre_llegada con horas_antes configuradas (24 h) mueve el disparo; la R4 cancelada nunca ==='
begin;
select public.verify_su();
insert into hoteles.mensaje_huesped_config (property_id, evento, activo, horas_antes) values ('00000000-0000-0000-0000-0000000a1a01', 'pre_llegada', true, 24);
select public.verify_as('');
-- 24 h antes: disparo = 3-jul 06:00 UTC. A las 20:00 UTC del 2-jul todavia no; el 3-jul 08:00 UTC si.
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01') where evento = 'pre_llegada') = 0, 'con 24 h todavia no');
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-03 08:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01') where evento = 'pre_llegada') = 2, 'con 24 h, el 3-jul 08:00 UTC si (R2 y R7; R4 esta cancelada)');
select 1 as ok_horas;
rollback;

\echo '=== 6. post_estancia: encendida, el dia del check-out a las 12:00 locales; solo reservas en check_out o cerrada ==='
begin;
select public.verify_su();
insert into hoteles.mensaje_huesped_config (property_id, evento, activo, resena_url) values ('00000000-0000-0000-0000-0000000a1a01', 'post_estancia', true, 'https://g.page/r/ejemplo/review');
select public.verify_as('');
-- R3 sale el 2-jul: 12:00 locales (-6) = 18:00 UTC. A las 20:00 UTC esta en ventana; a las 17:00 UTC todavia no.
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01') where evento = 'post_estancia') = 1, 'R3 en ventana');
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 17:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01') where evento = 'post_estancia') = 0, 'antes de las 12:00 locales todavia no');
select public.verify_assert((select count(*) from hoteles.sistema_candidatos_mensajes_huesped('2031-07-04 00:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01') where evento = 'post_estancia') = 0, 'pasadas 24 h ya no se manda un agradecimiento viejo');
select public.verify_assert((select c.resena_url = 'https://g.page/r/ejemplo/review' from hoteles.sistema_candidatos_mensajes_huesped('2031-07-02 20:00:00+00', 500, '00000000-0000-0000-0000-0000000a1a01') c where c.evento = 'post_estancia'), 'el candidato trae el enlace de resena configurado');
select 1 as ok_post;
rollback;

\echo '=== 7. un evento apagado por gerencia no es candidato (hold.aprobado activo=false) ==='
begin;
select public.verify_su();
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', false);
select public.verify_as('');
select public.verify_assert(public.verify_cand('hold.aprobado') = 1, 'solo queda H7 de B');
select 1 as ok_apagado;
rollback;

-- =============================================================================
-- (c) Emitir: idempotencia y validaciones
-- =============================================================================

\echo '=== 8. emitir: una sola marca por (referencia, evento); la segunda devuelve NULL y no duplica ni la bitacora ni el outbox ==='
begin;
select public.verify_as('');
select public.verify_assert(hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', 'whatsapp', null, 'mh.hold.aprobado', 'mh:hold.aprobado:f1001:whatsapp',
  '{"to":"+5215511112222","phone_number_id":"10000000000001","body":"texto","transaccional":true}'::jsonb) is not null, 'primera emision devuelve el id');
select public.verify_assert(hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', 'whatsapp', null, 'mh.hold.aprobado', 'mh:hold.aprobado:f1001:whatsapp',
  '{"to":"+5215511112222","phone_number_id":"10000000000001","body":"otro texto","transaccional":true}'::jsonb) is null, 'segunda emision devuelve NULL');
select public.verify_assert(hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', 'email', null, 'mh.hold.aprobado', 'mh:hold.aprobado:f1001:email',
  '{"to":"x@example.com","subject":"s","html":"h","text":"t"}'::jsonb) is null, 'ni siquiera por otro canal: la marca es por (referencia, evento)');
select public.verify_su();
select public.verify_assert(public.verify_envio_n('00000000-0000-0000-0000-0000000a1a01') = 1, 'una sola fila de bitacora');
select public.verify_assert(public.verify_outbox_mh_n('00000000-0000-0000-0000-0000000a1a01') = 1, 'un solo mensaje en el outbox');
select public.verify_assert((select e.estado = 'encolado' and e.canal = 'whatsapp' and e.outbox_id is not null from hoteles.mensaje_huesped_envio e where e.ref_id = '00000000-0000-0000-0000-0000000f1001'), 'queda ligada al outbox');
select public.verify_as('');
select public.verify_assert(public.verify_cand('hold.aprobado') = 1, 'H1 ya no es candidato; queda H7 de B');
select 1 as ok_idem;
rollback;

\echo '=== 9. emitir "no enviado" con motivo: no toca el outbox y tambien cierra el candidato ==='
begin;
select public.verify_as('');
select public.verify_assert(hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.rechazado', 'hold', '00000000-0000-0000-0000-0000000f1002', null, 'sin_contacto', null, null, null) is not null, 'marca no_enviado');
select public.verify_su();
select public.verify_assert((select e.estado = 'no_enviado' and e.motivo = 'sin_contacto' and e.canal is null and e.outbox_id is null from hoteles.mensaje_huesped_envio e where e.ref_id = '00000000-0000-0000-0000-0000000f1002'), 'estado y motivo');
select public.verify_assert(public.verify_outbox_mh_n('00000000-0000-0000-0000-0000000a1a01') = 0, 'sin outbox');
select public.verify_as('');
select public.verify_assert(public.verify_cand('hold.rechazado') = 0, 'ya no es candidato');
select 1 as ok_no_enviado;
rollback;

\echo '=== 9b. reserva.confirmada por correo: se marca SIN encolar (la cubre el correo transaccional de la reserva) ==='
begin;
select public.verify_as('');
select public.verify_assert(hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'reserva.confirmada', 'reserva', '00000000-0000-0000-0000-0000000e0001', 'email', null, null, null, null) is not null, 'marca con canal email y sin payload');
select public.verify_su();
select public.verify_assert((select e.estado = 'encolado' and e.canal = 'email' and e.outbox_id is null from hoteles.mensaje_huesped_envio e where e.ref_id = '00000000-0000-0000-0000-0000000e0001'), 'estado encolado, canal email, sin outbox');
select public.verify_assert(public.verify_outbox_mh_n('00000000-0000-0000-0000-0000000a1a01') = 0, 'nada en el outbox');
select public.verify_as('');
select public.verify_assert(public.verify_cand('reserva.confirmada') = 0, 'cierra el candidato');
select 1 as ok_correo_cubierto;
rollback;

\echo '=== 10. emitir valida: canal y motivo a la vez, evento invalido, payload invalido (22023); y los CHECK de la bitacora (23514) ==='
begin;
select public.verify_as('');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', 'whatsapp', 'sin_contacto', 'x', 'k', '{}'::jsonb)$q$, '22023');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', null, null, null, null, null)$q$, '22023');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'inventado', 'hold', '00000000-0000-0000-0000-0000000f1001', null, 'sin_contacto', null, null, null)$q$, '22023');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'reserva', '00000000-0000-0000-0000-0000000f1001', null, 'sin_contacto', null, null, null)$q$, '23514');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', 'sms', null, 'x', 'k', '{}'::jsonb)$q$, '22023');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', 'whatsapp', null, 'x', 'k', '[]'::jsonb)$q$, '22023');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', null, 'motivo_inventado', null, null, null)$q$, '23514');
select public.verify_assert(hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-00000000dead', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', null, 'sin_contacto', null, null, null) is null, 'una propiedad inexistente no escribe nada');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', 'email', null, null, null, null)$q$, '22023');
select 1 as ok_validaciones;
rollback;

-- =============================================================================
-- (d) Solo sistema, roles, cross-tenant, anon
-- =============================================================================

\echo '=== 11. un usuario real (aun owner) y anon NO pueden llamar a las funciones de solo sistema (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select * from hoteles.sistema_candidatos_mensajes_huesped(now(), 10)$q$, '42501');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', null, 'sin_contacto', null, null, null)$q$, '42501');
select public.verify_expect_error($q$select hoteles.sistema_slug_aviso('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.system_run_retention_conversaciones('00000000-0000-0000-0000-00000000a001', true, 10)$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.sistema_candidatos_mensajes_huesped(now(), 10)$q$, '42501');
select public.verify_expect_error($q$select hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', null, 'sin_contacto', null, null, null)$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.historial_mensajes_huesped('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_su();
select public.verify_assert(public.verify_envio_n('00000000-0000-0000-0000-0000000a1a01') = 0, 'nada se escribio');
select 1 as ok_solo_sistema;
rollback;

\echo '=== 12. slug del aviso: solo sistema, solo hoteles; propiedad inexistente -> NULL ==='
begin;
select public.verify_as('');
select public.verify_assert(hoteles.sistema_slug_aviso('00000000-0000-0000-0000-0000000a1a01') = 'hotel-a-mh', 'slug de A');
select public.verify_assert(hoteles.sistema_slug_aviso('00000000-0000-0000-0000-00000000dead') is null, 'inexistente');
select 1 as ok_slug;
rollback;

\echo '=== 13. configuracion: gm y owner la escriben; el trigger deriva organization_id y sella el autor; frontdesk la ve (3 filas) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
insert into hoteles.mensaje_huesped_config (property_id, evento, activo, horas_antes) values ('00000000-0000-0000-0000-0000000a1a01', 'pre_llegada', true, 36);
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', false);
update hoteles.mensaje_huesped_config set horas_antes = 72 where property_id = '00000000-0000-0000-0000-0000000a1a01' and evento = 'pre_llegada';
select public.verify_assert((select organization_id = '00000000-0000-0000-0000-00000000a001' and actualizado_por = '00000000-0000-0000-0000-0000000a0a02' and horas_antes = 72 from hoteles.mensaje_huesped_config where evento = 'pre_llegada'), 'organization_id derivado y autor sellado');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'reserva.confirmada', true);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select count(*) from hoteles.mensaje_huesped_config) = 3, 'frontdesk ve las 3 filas');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.vencido', false)$q$, '42501');
rollback;

\echo '=== 13b. frontdesk no puede actualizar la configuracion (RLS filtra: 0 filas afectadas) ==='
begin;
select public.verify_su();
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', true);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
with u as (update hoteles.mensaje_huesped_config set activo = false returning 1) select count(*) as frontdesk_no_actualiza_deberia_ser_0 from u;
rollback;

\echo '=== 13c. housekeeping no ve la configuracion (0 filas) ==='
begin;
select public.verify_su();
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', true);
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select count(*) as housekeeping_no_ve_deberia_ser_0 from hoteles.mensaje_huesped_config;
rollback;

\echo '=== 13d. el owner de OTRO tenant no ve la configuracion (0 filas) ==='
begin;
select public.verify_su();
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', true);
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select count(*) as otro_tenant_no_ve_deberia_ser_0 from hoteles.mensaje_huesped_config;
rollback;

\echo '=== 14. configuracion: owner de OTRO tenant no puede escribir en mi hotel (42501); no se puede mover la fila ni falsear columnas (42501); anon 42501 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', false)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', false);
select public.verify_expect_error($q$update hoteles.mensaje_huesped_config set organization_id = '00000000-0000-0000-0000-00000000b001'$q$, '42501');
select public.verify_expect_error($q$update hoteles.mensaje_huesped_config set property_id = '00000000-0000-0000-0000-0000000b1b01'$q$, '42501');
select public.verify_expect_error($q$update hoteles.mensaje_huesped_config set actualizado_por = null$q$, '42501');
select public.verify_expect_error($q$update hoteles.mensaje_huesped_config set evento = 'hold.vencido'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.mensaje_huesped_config$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.mensaje_huesped_config$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.vencido', false)$q$, '42501');
rollback;

\echo '=== 15. configuracion: horas solo en pre_llegada (23514), horas 1 a 336 (23514), enlace de resena solo https y solo en post_estancia (23514), evento invalido (23514), duplicado (23505) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo, horas_antes) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', true, 24)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo, horas_antes) values ('00000000-0000-0000-0000-0000000a1a01', 'pre_llegada', true, 0)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo, horas_antes) values ('00000000-0000-0000-0000-0000000a1a01', 'pre_llegada', true, 337)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo, resena_url) values ('00000000-0000-0000-0000-0000000a1a01', 'post_estancia', true, 'http://inseguro.example.com/r')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo, resena_url) values ('00000000-0000-0000-0000-0000000a1a01', 'pre_llegada', true, 'https://ok.example.com/r')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'evento_inventado', true)$q$, '23514');
insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.vencido', true);
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_config (property_id, evento, activo) values ('00000000-0000-0000-0000-0000000a1a01', 'hold.vencido', false)$q$, '23505');
rollback;

\echo '=== 16. historial: gm y frontdesk lo ven con el estado real del outbox; housekeeping, otro tenant y anon no ==='
begin;
select public.verify_as('');
select public.verify_assert(hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', '00000000-0000-0000-0000-0000000f1001', 'whatsapp', null, 'mh.hold.aprobado', 'mh:hold.aprobado:f1001:whatsapp', '{"to":"+5215511112222","phone_number_id":"10000000000001","body":"texto"}'::jsonb) is not null, 'emite');
select public.verify_assert(hoteles.sistema_emitir_mensaje_huesped('00000000-0000-0000-0000-0000000a1a01', 'hold.rechazado', 'hold', '00000000-0000-0000-0000-0000000f1002', null, 'baja_whatsapp', null, null, null) is not null, 'emite no_enviado');
select public.verify_su();
update hoteles.messaging_outbox set status = 'dead', last_error_class = 'suprimido' where event_type = 'mh.hold.aprobado';
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_assert((select count(*) from hoteles.historial_mensajes_huesped('00000000-0000-0000-0000-0000000a1a01')) = 2, 'gm ve 2');
select public.verify_assert((select h.out_envio = 'dead' and h.out_error_clase = 'suprimido' from hoteles.historial_mensajes_huesped('00000000-0000-0000-0000-0000000a1a01') h where h.out_evento = 'hold.aprobado'), 'estado real del outbox');
select public.verify_assert((select h.out_estado = 'no_enviado' and h.out_motivo = 'baja_whatsapp' and h.out_envio is null from hoteles.historial_mensajes_huesped('00000000-0000-0000-0000-0000000a1a01') h where h.out_evento = 'hold.rechazado'), 'motivo del no enviado');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select count(*) from hoteles.historial_mensajes_huesped('00000000-0000-0000-0000-0000000a1a01')) = 2, 'frontdesk ve 2');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_assert((select count(*) from hoteles.historial_mensajes_huesped('00000000-0000-0000-0000-0000000a1a01')) = 0, 'housekeeping no ve nada');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_assert((select count(*) from hoteles.historial_mensajes_huesped('00000000-0000-0000-0000-0000000a1a01')) = 0, 'otro tenant no ve nada');
select count(*) as tabla_directa_otro_tenant_deberia_ser_0 from hoteles.mensaje_huesped_envio;
rollback;

\echo '=== 17. la bitacora es solo lectura para el cliente y el outbox sigue cerrado (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$insert into hoteles.mensaje_huesped_envio (organization_id, property_id, evento, ref_tipo, ref_id, estado, motivo) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'hold.aprobado', 'hold', gen_random_uuid(), 'no_enviado', 'sin_contacto')$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.mensaje_huesped_envio$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.messaging_outbox$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.mensaje_huesped_envio$q$, '42501');
rollback;

\echo '=== 18. privilegios: funciones nuevas security definer con search_path fijo y sin EXECUTE para anon ni public; tablas sin GRANT a anon ==='
begin;
select public.verify_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'hoteles' and (p.proname in ('sistema_candidatos_mensajes_huesped', 'sistema_emitir_mensaje_huesped', 'sistema_slug_aviso', 'historial_mensajes_huesped', 'system_run_retention_conversaciones', 'mensaje_huesped_config_guard'))
    and not (p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))) = 0, 'todas security definer con search_path fijo');
select public.verify_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'hoteles' and (p.proname in ('sistema_candidatos_mensajes_huesped', 'sistema_emitir_mensaje_huesped', 'sistema_slug_aviso', 'historial_mensajes_huesped', 'system_run_retention_conversaciones', 'mensaje_huesped_config_guard'))
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))) = 0, 'sin EXECUTE para anon ni public');
select public.verify_assert(not has_table_privilege('anon', 'hoteles.mensaje_huesped_config', 'select') and not has_table_privilege('anon', 'hoteles.mensaje_huesped_envio', 'select'), 'anon sin GRANT');
select public.verify_assert(not has_table_privilege('authenticated', 'hoteles.mensaje_huesped_envio', 'insert') and not has_table_privilege('authenticated', 'hoteles.mensaje_huesped_config', 'delete'), 'authenticated sin escritura de bitacora ni delete de config');
select public.verify_assert(not has_column_privilege('authenticated', 'hoteles.mensaje_huesped_config', 'organization_id', 'update') and not has_column_privilege('authenticated', 'hoteles.mensaje_huesped_config', 'organization_id', 'insert'), 'organization_id no es escribible');
select 1 as ok_privilegios;
rollback;

-- =============================================================================
-- (e) Retencion de las conversaciones de WhatsApp de hoteles
-- =============================================================================
insert into hoteles.whatsapp_conversations (id, organization_id, property_id, phone, messages, status, created_at, updated_at) values
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '+5215511112222', '[{"role":"user","content":"hola, mi curp es X"}]'::jsonb, 'completed', now() - interval '400 days', now() - interval '400 days'),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '+5215599990000', '[{"role":"user","content":"reciente"}]'::jsonb, 'active', now(), now()),
  ('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '+5215577770000', '[{"role":"user","content":"vieja con ARCO abierta"}]'::jsonb, 'completed', now() - interval '400 days', now() - interval '400 days'),
  ('00000000-0000-0000-0000-00000000c3b1', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '+5215500001111', '[{"role":"user","content":"vieja de B"}]'::jsonb, 'completed', now() - interval '400 days', now() - interval '400 days')
on conflict do nothing;
insert into hoteles.arco_request (id, organization_id, property_id, folio, right_type, requester_name, requester_contact, channel, received_on, response_due_on, status) values
  ('00000000-0000-0000-0000-0000000ac001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-MH-1', 'acceso', 'Titular Siete', '55 7777 0000', 'whatsapp', current_date, current_date + 20, 'recibida')
on conflict do nothing;
insert into hoteles.messaging_outbox (id, property_id, organization_id, channel, event_type, dedupe_key, payload, status, created_at) values
  ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'whatsapp', 'mh.vieja', 'mh-old-sent', '{"to":"+5215511112222","body":"texto viejo"}'::jsonb, 'sent', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'whatsapp', 'mh.vieja', 'mh-old-pending', '{"to":"+5215511112222","body":"texto viejo pendiente"}'::jsonb, 'pending', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000b0003', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'whatsapp', 'mh.reciente', 'mh-new-sent', '{"to":"+5215511112222","body":"texto reciente"}'::jsonb, 'sent', now())
on conflict do nothing;

create or replace function public.verify_msgs(p_id uuid) returns integer language sql security definer as $$
  select jsonb_array_length(messages) from hoteles.whatsapp_conversations where id = p_id
$$;
create or replace function public.verify_payload(p_id uuid) returns text language sql security definer as $$
  select payload::text from hoteles.messaging_outbox where id = p_id
$$;
grant execute on function public.verify_msgs(uuid), public.verify_payload(uuid) to public;

\echo '=== 19. la clase de retencion existe con los mismos dias que restaurantes (180/30/1095) y ejecutor de plataforma ==='
begin;
select public.verify_assert((select default_days = 180 and min_days = 30 and max_days = 1095 and executor = 'plataforma' and vertical = 'hoteles' from core.retention_class where data_class = 'hoteles_whatsapp_conversaciones'), 'clase de retencion');
select public.verify_assert((select r.default_days = c.default_days and r.min_days = c.min_days and r.max_days = c.max_days from core.retention_class r, core.retention_class c where r.data_class = 'hoteles_whatsapp_conversaciones' and c.data_class = 'restaurantes_whatsapp_conversaciones'), 'iguales a restaurantes');
select public.verify_as('');
select public.verify_assert((select count(*) from core.system_list_purge_targets(null, 50, '00000000-0000-0000-0000-00000000a001') where out_data_class = 'hoteles_whatsapp_conversaciones') = 1, 'una organizacion de hoteles entra en los objetivos de la purga de plataforma');
select public.verify_assert((select count(*) from core.system_list_purge_targets(null, 50, '00000000-0000-0000-0000-00000000b001') where out_data_class = 'hoteles_whatsapp_conversaciones') = 1, 'tambien la otra');
select 1 as ok_clase;
rollback;

\echo '=== 20. simulacion: cuenta lo que vaciaria sin tocar nada, protege la ARCO abierta y deja registro ==='
begin;
select public.verify_as('');
select public.verify_assert((select out_status = 'simulacion' and out_retention_days = 180 and out_rows_affected = 2 and out_rows_protected = 1 from hoteles.system_run_retention_conversaciones('00000000-0000-0000-0000-00000000a001', true, 500)), 'simulacion: 1 conversacion + 1 outbox enviado; 1 protegida');
select public.verify_su();
select public.verify_assert(public.verify_msgs('00000000-0000-0000-0000-00000000c301') = 1, 'no se toco la conversacion');
select public.verify_assert(public.verify_payload('00000000-0000-0000-0000-0000000b0001') like '%texto viejo%', 'no se toco el outbox');
select public.verify_assert((select count(*) from core.purge_run_log where organization_id = '00000000-0000-0000-0000-00000000a001' and data_class = 'hoteles_whatsapp_conversaciones' and status = 'simulacion') = 1, 'registro de la corrida');
select 1 as ok_simulacion;
rollback;

\echo '=== 21. ejecucion: vacia el texto de lo vencido, conserva filas y fecha, no toca lo reciente, lo pendiente, la ARCO abierta ni otro tenant ==='
begin;
select public.verify_as('');
select public.verify_assert((select out_status = 'ok' and out_rows_affected = 2 and out_rows_protected = 1 from hoteles.system_run_retention_conversaciones('00000000-0000-0000-0000-00000000a001', false, 500)), 'ejecuta');
select public.verify_su();
select public.verify_assert(public.verify_msgs('00000000-0000-0000-0000-00000000c301') = 0, 'la vencida queda vacia');
select public.verify_assert((select updated_at < now() - interval '300 days' from hoteles.whatsapp_conversations where id = '00000000-0000-0000-0000-00000000c301'), 'conserva la fila y su fecha');
select public.verify_assert(public.verify_msgs('00000000-0000-0000-0000-00000000c302') = 1, 'la reciente intacta');
select public.verify_assert(public.verify_msgs('00000000-0000-0000-0000-00000000c303') = 1, 'la de ARCO abierta intacta');
select public.verify_assert(public.verify_msgs('00000000-0000-0000-0000-00000000c3b1') = 1, 'otro tenant intacto');
select public.verify_assert(public.verify_payload('00000000-0000-0000-0000-0000000b0001') = '{"purgado": true}', 'outbox enviado vaciado');
select public.verify_assert(public.verify_payload('00000000-0000-0000-0000-0000000b0002') like '%pendiente%', 'outbox pendiente intacto');
select public.verify_assert(public.verify_payload('00000000-0000-0000-0000-0000000b0003') like '%reciente%', 'outbox reciente intacto');
select public.verify_assert((select count(*) from hoteles.messaging_outbox where id in ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000b0003')) = 3, 'las filas se conservan');
select public.verify_as('');
select public.verify_assert((select out_rows_affected = 0 from hoteles.system_run_retention_conversaciones('00000000-0000-0000-0000-00000000a001', false, 500)), 'idempotente: la segunda corrida no vacia nada mas');
select 1 as ok_ejecucion;
rollback;

\echo '=== 22. retencion legal activa: bloquea (status bloqueada, 0 filas) y queda en el registro; al liberarla vuelve a purgar ==='
begin;
select public.verify_su();
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000a001', 'hoteles_whatsapp_conversaciones', 'Retencion legal por proceso en curso', '00000000-0000-0000-0000-0000000a0a01');
select public.verify_as('');
select public.verify_assert((select out_status = 'bloqueada' and out_rows_affected = 0 from hoteles.system_run_retention_conversaciones('00000000-0000-0000-0000-00000000a001', false, 500)), 'bloqueada');
select public.verify_su();
select public.verify_assert(public.verify_msgs('00000000-0000-0000-0000-00000000c301') = 1, 'nada se vacio');
select public.verify_assert((select blocked_reason = 'retencion_legal_activa' from core.purge_run_log where organization_id = '00000000-0000-0000-0000-00000000a001' and status = 'bloqueada' and data_class = 'hoteles_whatsapp_conversaciones'), 'motivo en el registro');
update core.purge_hold set released_at = now(), released_by = '00000000-0000-0000-0000-0000000a0a01' where id = '00000000-0000-0000-0000-0000000a0001';
select public.verify_as('');
select public.verify_assert((select out_status = 'ok' and out_rows_affected = 2 from hoteles.system_run_retention_conversaciones('00000000-0000-0000-0000-00000000a001', false, 500)), 'liberada: purga');
select 1 as ok_hold;
rollback;

\echo '=== 23. una politica de organizacion cambia los dias efectivos (400 dias -> la conversacion de 400 dias aun no vence con 1095) ==='
begin;
select public.verify_su();
insert into core.retention_policy (organization_id, data_class, retention_days) values ('00000000-0000-0000-0000-00000000a001', 'hoteles_whatsapp_conversaciones', 1000);
select public.verify_as('');
select public.verify_assert((select out_retention_days = 1000 and out_rows_affected = 0 and out_rows_protected = 0 from hoteles.system_run_retention_conversaciones('00000000-0000-0000-0000-00000000a001', false, 500)), 'con 1000 dias nada vence');
select 1 as ok_politica;
rollback;

\echo 'Escenarios 1 a 23 (con 13b-13d) deben terminar sin error: cada verify_assert/verify_expect_error falla el escenario si no se cumple.'
