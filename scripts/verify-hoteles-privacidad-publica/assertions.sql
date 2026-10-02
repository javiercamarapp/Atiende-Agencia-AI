-- H-30 (P1) -- PRIVACIDAD PUBLICA DEL HUESPED (aviso publico, ARCO publico verificado por codigo, exportacion del
-- staff y "mis datos"). Verifica contra Postgres REAL que
-- packages/domain-hoteles/migrations/041_hoteles_privacidad_publica_huesped.sql cierra lo que dice cerrar: funciones
-- solo-sistema (auth.uid() nulo), anon sin EXECUTE, cross-tenant, codigo de un solo uso con intentos y expiracion,
-- exportacion sin documento de identidad y SIEMPRE con bitacora, enlace "mis datos" solo para acceso procedente.
-- Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI, auto-descubierto).
--
-- Convencion: public.verify_expect_error(sql, sqlstate) exige el SQLSTATE exacto de un negativo;
-- public.verify_assert(cond, msg) lanza si la condicion no se cumple (los positivos multi-chequeo); los alias
-- *_deberia_ser_N validan un valor exacto. "Sesion de sistema" = rol authenticated SIN request.jwt.claim.sub.
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

create or replace function public.verify_assert(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'asercion fallida: %', p_msg;
  end if;
end;
$$;
grant execute on function public.verify_assert(boolean, text) to public;

-- ---------------------------------------------------------------------------
-- Fixtures persistentes (superusuario, bypass RLS)
-- ---------------------------------------------------------------------------
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-pub'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-pub'),
  ('00000000-0000-0000-0000-00000000f001', 'restaurantes', 'Resto F', 'resto-f-pub')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Centro', 'active'),
  ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Playa', 'active'),
  ('00000000-0000-0000-0000-0000000a1a03', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Cerrado', 'inactive'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1', 'active'),
  ('00000000-0000-0000-0000-0000000f1f01', '00000000-0000-0000-0000-00000000f001', 'restaurantes', 'Resto F', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;

-- Aviso vigente SOLO en A1 (A2 no ha publicado): la lectura publica debe distinguirlo.
insert into hoteles.privacy_notice (id, organization_id, property_id, version, simplified_text, integral_url, mandatory_purposes, optional_purposes) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'v1',
   'Aviso simplificado v1: identificarte, registro de huespedes y facturacion. Integral en el enlace.', 'https://hotel-a.example.com/aviso',
   array['identificar al huesped', 'registro de huespedes'], array['promociones'])
on conflict do nothing;

insert into hoteles.guest (id, organization_id, property_id, full_name, email, phone) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Huesped A1', 'huesped-a1@example.com', '+52 999 123 4567'),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a02', 'Huesped A2 otra property', null, null),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Huesped B', null, null)
on conflict do nothing;

insert into hoteles.identity_vault (id, property_id, guest_id, document_type, nationality, document_last4, payload_enc, retention_until) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'pasaporte', 'USA', 'Zq9z',
   'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2099-01-01')
on conflict do nothing;

insert into hoteles.reservation (id, organization_id, property_id, guest_id, check_in_date, check_out_date, status, total_amount) values
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', '2026-03-01', '2026-03-03', 'confirmada', 2500.00)
on conflict do nothing;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', false);
insert into hoteles.guest_note (organization_id, property_id, guest_id, kind, body) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'preferencia', 'Prefiere piso alto y almohada extra');
select set_config('request.jwt.claim.sub', '', false);
insert into hoteles.whatsapp_conversations (organization_id, property_id, phone, messages) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '5219991234567', '[{"role":"user","text":"hola"}]'::jsonb);
insert into hoteles.contacto_no_operativo (organization_id, property_id, guest_phone, guest_name, reason, source) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '+52 999 123 4567', 'Huesped A1', 'pregunta por factura', 'whatsapp');

-- =============================================================================
-- (a) Aviso publico (lectura sin login)
-- =============================================================================

\echo '=== 1. sesion de sistema: el aviso vigente se lee por slug; A tiene 2 properties activas (la inactiva y otros tenants no aparecen); A1 con aviso, A2 sin aviso ==='
begin;
set local role authenticated;
select public.verify_assert((select count(*) from hoteles.public_privacy_notices('hotel-a-pub')) = 2, 'A debe listar solo sus 2 properties activas');
select public.verify_assert((select out_version from hoteles.public_privacy_notices('hotel-a-pub') where out_property_id = '00000000-0000-0000-0000-0000000a1a01') = 'v1', 'A1 expone v1');
select public.verify_assert((select out_notice_id from hoteles.public_privacy_notices('hotel-a-pub') where out_property_id = '00000000-0000-0000-0000-0000000a1a02') is null, 'A2 sin aviso: notice nulo, no inventado');
select count(*) as slug_de_restaurantes_deberia_ser_0 from hoteles.public_privacy_notices('resto-f-pub');
rollback;

\echo '=== 2. slug inexistente: cero filas (la API responde 404 igual que cualquier hotel que no existe) ==='
begin;
set local role authenticated;
select count(*) as slug_inexistente_deberia_ser_0 from hoteles.public_privacy_notices('no-existe');
rollback;

\echo '=== 3. un usuario autenticado (staff de otro tenant) NO alcanza la funcion publica (42501) y anon no tiene EXECUTE (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select * from hoteles.public_privacy_notices('hotel-a-pub') $q$, '42501');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select * from hoteles.public_privacy_notices('hotel-a-pub') $q$, '42501');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) $q$, '42501');
select public.verify_expect_error($q$ select * from hoteles.public_arco_verify('00000000-0000-0000-0000-000000000001', repeat('a', 64), (now() at time zone 'utc')::date) $q$, '42501');
select public.verify_expect_error($q$ select hoteles.arco_access_snapshot('00000000-0000-0000-0000-000000000001', 'hotel-a-pub') $q$, '42501');
rollback;

-- =============================================================================
-- (b) Alta publica de ARCO
-- =============================================================================

\echo '=== 4. alta publica (sistema): pendiente_verificacion, canal publico, SIN plazo corriendo para el staff, correo con el codigo encolado, hash (no codigo) guardado, bitacora sin actor ==='
begin;
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'Ana@Example.com', 'Quiero mis datos', repeat('a', 64), 900,
  '{"to":"ana@example.com","subject":"Codigo","html":"<p>123456</p>","text":"123456"}'::jsonb, (now() at time zone 'utc')::date) as id_creado \gset
reset role;
select public.verify_assert((select status = 'pendiente_verificacion' and channel = 'publico' and requester_contact = 'ana@example.com' and created_by is null and response_due_on = received_on + 20
                               from hoteles.arco_request where id = :'id_creado'), 'solicitud pendiente de verificacion, contacto normalizado, sin autor de staff');
select public.verify_assert((select code_hash = repeat('a', 64) and used_at is null and attempts = 0 and expires_at > now() and expires_at <= now() + interval '16 minutes'
                               from hoteles.arco_public_verification where request_id = :'id_creado'), 'solo el hash, vigencia 15 min');
select public.verify_assert((select count(*) from hoteles.messaging_outbox where property_id = '00000000-0000-0000-0000-0000000a1a01' and channel = 'email' and event_type = 'arco.codigo_verificacion' and dedupe_key = 'arco-codigo:' || :'id_creado' and status = 'pending') = 1, 'correo encolado');
select public.verify_assert((select count(*) from hoteles.privacy_event_log where subject_id = :'id_creado' and action = 'solicitud_publica_creada' and actor_user_id is null and note not like '%ana%') = 1, 'bitacora sin PII y sin actor');
rollback;

\echo '=== 5. validaciones del alta publica: derecho, nombre, correo, descripcion, hash, ttl y fecha invalidos = 22023; property inactiva / de otro vertical = 42501 ==='
begin;
set local role authenticated;
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'borrado', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'A', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'no-es-correo', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', '+529991234567', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', repeat('x', 1001), repeat('a', 64), 900, null, (now() at time zone 'utc')::date) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, 'codigo-en-claro', 900, null, (now() at time zone 'utc')::date) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 90000, null, (now() at time zone 'utc')::date) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, '2020-01-01') $q$, '22023');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a03', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) $q$, '42501');
select public.verify_expect_error($q$ select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000f1f01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) $q$, '42501');
rollback;

\echo '=== 6. tope por contacto: la 4a solicitud sin verificar del mismo correo en 24 h devuelve NULL (la API responde igual) y no inserta ==='
begin;
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'tope@example.com', null, repeat('b', 64), 900, null, (now() at time zone 'utc')::date);
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'TOPE@example.com', null, repeat('b', 64), 900, null, (now() at time zone 'utc')::date);
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'tope@example.com', null, repeat('b', 64), 900, null, (now() at time zone 'utc')::date);
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'tope@example.com', null, repeat('b', 64), 900, null, (now() at time zone 'utc')::date) is null as cuarta_nula \gset
reset role;
select public.verify_assert(:'cuarta_nula'::boolean, 'la cuarta devuelve NULL');
select count(*) as pendientes_deberia_ser_3 from hoteles.arco_request where lower(requester_contact) = 'tope@example.com';
rollback;

\echo '=== 7. limpieza de minimizacion: una solicitud sin verificar de hace 8 dias se borra (con su verificacion) al llegar una nueva ==='
begin;
insert into hoteles.arco_request (id, organization_id, property_id, folio, right_type, requester_name, requester_contact, channel, received_on, response_due_on, status, created_at)
values ('00000000-0000-0000-0000-0000000aa001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-VIEJO-1', 'acceso', 'Vieja Pendiente', 'vieja@example.com', 'publico',
        current_date - 8, current_date + 12, 'pendiente_verificacion', now() - interval '8 days');
insert into hoteles.arco_public_verification (request_id, organization_id, property_id, code_hash, expires_at)
values ('00000000-0000-0000-0000-0000000aa001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', repeat('c', 64), now() - interval '8 days');
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Nueva Persona', 'nueva@example.com', null, repeat('d', 64), 900, null, (now() at time zone 'utc')::date);
reset role;
select count(*) as vieja_borrada_deberia_ser_0 from hoteles.arco_request where id = '00000000-0000-0000-0000-0000000aa001';
rollback;

-- =============================================================================
-- (c) Verificacion por codigo
-- =============================================================================

\echo '=== 8. codigo correcto: pasa a recibida, el plazo de 20 dias corre DESDE la verificacion, un solo uso (segundo intento = usado) y bitacora ==='
begin;
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) as id_v \gset
select out_result as r1, out_property_id as prop1, out_folio as folio1 from hoteles.public_arco_verify(:'id_v', repeat('a', 64), (now() at time zone 'utc')::date) \gset
select public.verify_assert(:'r1' = 'ok' and :'prop1' = '00000000-0000-0000-0000-0000000a1a01' and :'folio1' like 'ARCO-%', 'verificacion correcta devuelve ok, property y folio');
select out_result as r2 from hoteles.public_arco_verify(:'id_v', repeat('a', 64), (now() at time zone 'utc')::date) \gset
select public.verify_assert(:'r2' = 'usado', 'reutilizar el codigo no funciona');
reset role;
select public.verify_assert((select status = 'recibida' and response_due_on = received_on + 20 and received_on = (now() at time zone 'utc')::date from hoteles.arco_request where id = :'id_v'), 'recibida con plazo desde hoy');
select public.verify_assert((select used_at is not null from hoteles.arco_public_verification where request_id = :'id_v'), 'verificacion consumida');
select count(*) as bitacora_deberia_ser_1 from hoteles.privacy_event_log where subject_id = :'id_v' and action = 'solicitud_publica_verificada' and actor_user_id is null;
rollback;

\echo '=== 9. codigo incorrecto: el contador sube y persiste; al 5o fallo queda agotado y ni el codigo correcto sirve ==='
begin;
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) as id_i \gset
select out_result from hoteles.public_arco_verify(:'id_i', repeat('f', 64), (now() at time zone 'utc')::date);
select out_result from hoteles.public_arco_verify(:'id_i', repeat('f', 64), (now() at time zone 'utc')::date);
select out_result from hoteles.public_arco_verify(:'id_i', repeat('f', 64), (now() at time zone 'utc')::date);
select out_result from hoteles.public_arco_verify(:'id_i', repeat('f', 64), (now() at time zone 'utc')::date);
select out_result as quinto from hoteles.public_arco_verify(:'id_i', repeat('f', 64), (now() at time zone 'utc')::date) \gset
select public.verify_assert(:'quinto' = 'invalido', 'el quinto fallo sigue siendo invalido');
select out_result as correcto from hoteles.public_arco_verify(:'id_i', repeat('a', 64), (now() at time zone 'utc')::date) \gset
select public.verify_assert(:'correcto' = 'agotado', 'agotado aun con el codigo correcto');
reset role;
select public.verify_assert((select attempts = 5 from hoteles.arco_public_verification where request_id = :'id_i'), 'cinco intentos persistidos');
select count(*) as sigue_pendiente_deberia_ser_1 from hoteles.arco_request where id = :'id_i' and status = 'pendiente_verificacion';
rollback;

\echo '=== 10. codigo expirado: aunque sea el correcto no verifica; referencia inexistente = invalido; hash mal formado no cuenta ==='
begin;
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) as id_e \gset
reset role;
update hoteles.arco_public_verification set expires_at = now() - interval '1 minute' where request_id = :'id_e';
set local role authenticated;
select out_result as expirado from hoteles.public_arco_verify(:'id_e', repeat('a', 64), (now() at time zone 'utc')::date) \gset
select public.verify_assert(:'expirado' = 'expirado', 'expirado');
select out_result as inexistente from hoteles.public_arco_verify('00000000-0000-0000-0000-00000000dead', repeat('a', 64), (now() at time zone 'utc')::date) \gset
select public.verify_assert(:'inexistente' = 'invalido', 'inexistente = invalido');
reset role;
select count(*) as sigue_pendiente_deberia_ser_1 from hoteles.arco_request where id = :'id_e' and status = 'pendiente_verificacion';
rollback;

\echo '=== 11. una solicitud sin verificar NO se puede avanzar por el staff (P0001); una verificada si (recibida -> procedente) ==='
begin;
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) as id_p \gset
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error(format($q$ select hoteles.advance_arco_request(%L, 'procedente', 'Nota de decision suficiente', (now() at time zone 'utc')::date) $q$, :'id_p'), 'P0001');
select set_config('request.jwt.claim.sub', '', true);
select out_result from hoteles.public_arco_verify(:'id_p', repeat('a', 64), (now() at time zone 'utc')::date);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.advance_arco_request(:'id_p', 'procedente', 'Nota de decision suficiente', (now() at time zone 'utc')::date) as avance;
rollback;

\echo '=== 12. las tablas nuevas no tienen GRANT para clientes: verificacion/solicitudes no se escriben ni leen con authenticated sin RLS; anon sin acceso a nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select * from hoteles.arco_public_verification $q$, '42501');
select public.verify_expect_error($q$ insert into hoteles.arco_public_verification (request_id, organization_id, property_id, code_hash, expires_at) values (gen_random_uuid(), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', repeat('a', 64), now()) $q$, '42501');
select public.verify_expect_error($q$ insert into hoteles.arco_request (organization_id, property_id, folio, right_type, requester_name, channel, received_on, response_due_on, status) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-X-1', 'acceso', 'Falso', 'publico', current_date, current_date + 20, 'recibida') $q$, '42501');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select * from hoteles.arco_public_verification $q$, '42501');
select public.verify_expect_error($q$ select * from hoteles.arco_request $q$, '42501');
select public.verify_expect_error($q$ select * from hoteles.privacy_notice $q$, '42501');
rollback;

-- =============================================================================
-- (d) Exportacion del staff
-- =============================================================================

\echo '=== 13. owner/gm exportan: perfil, estancias, notas, conversaciones y solicitudes; el documento de identidad NUNCA sale (ni sobre cifrado ni ultimos 4); queda UNA huella en la bitacora con el actor ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.export_guest_data('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'json')::text as doc \gset
select public.verify_assert(:'doc'::jsonb #>> '{perfil,nombre}' = 'Huesped A1', 'perfil');
select public.verify_assert(jsonb_array_length(:'doc'::jsonb -> 'estancias') = 1 and jsonb_array_length(:'doc'::jsonb -> 'notas') = 1, 'estancias y notas');
select public.verify_assert(jsonb_array_length(:'doc'::jsonb -> 'conversaciones') = 1 and jsonb_array_length(:'doc'::jsonb -> 'solicitudesContacto') = 1, 'conversaciones y solicitudes de contacto por telefono');
select public.verify_assert(:'doc' not like '%payload%' and :'doc' not like '%v1.AAAA%' and :'doc' not like '%Zq9z%' and :'doc' not like '%document_last4%', 'sin documento de identidad en claro');
select public.verify_assert(:'doc'::jsonb #>> '{identidad,0,estado}' = 'activo' and :'doc'::jsonb #>> '{identidad,0,tipoDocumento}' = 'pasaporte', 'solo estado y tipo de la boveda');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select public.verify_assert(hoteles.export_guest_data('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'csv') is not null, 'gm exporta');
reset role;
select public.verify_assert((select count(*) from hoteles.privacy_event_log where subject_type = 'exportacion' and subject_id = '00000000-0000-0000-0000-00000000c001' and action = 'exportar_datos_huesped'
                                and actor_user_id = '00000000-0000-0000-0000-0000000a0a01' and note = 'formato json') = 1, 'huella del owner');
select count(*) as huellas_deberia_ser_2 from hoteles.privacy_event_log where subject_type = 'exportacion' and subject_id = '00000000-0000-0000-0000-00000000c001';
rollback;

\echo '=== 14. exportar: frontdesk (rol sin privacidad), owner de OTRA organizacion y anon = 42501; huesped de otra property = 23503; formato invalido = 22023; sin huella cuando falla ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.export_guest_data('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'json') $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.export_guest_data('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'json') $q$, '42501');
select public.verify_expect_error($q$ select hoteles.export_guest_data('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000c001', 'json') $q$, '23503');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.export_guest_data('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', 'json') $q$, '23503');
select public.verify_expect_error($q$ select hoteles.export_guest_data('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'xml') $q$, '22023');
select set_config('request.jwt.claim.sub', '', true);
select public.verify_expect_error($q$ select hoteles.export_guest_data('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'json') $q$, '42501');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select hoteles.export_guest_data('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'json') $q$, '42501');
select public.verify_expect_error($q$ select hoteles.guest_data_snapshot('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'staff') $q$, '42501');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.guest_data_snapshot('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'staff') $q$, '42501');
rollback;

-- =============================================================================
-- (e) "Mis datos": emision del enlace y consulta del titular
-- =============================================================================

\echo '=== 15. arco_access_grant: solo owner/gm y solo sobre un ACCESO procedente: recibida o rectificacion = P0001; frontdesk/otro tenant = 42501; huesped ajeno = 23503; liga el huesped ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Huesped A1', 'huesped-a1@example.com', 'correo', 'Quiero conocer mis datos', (now() at time zone 'utc')::date, null, null) as id_a \gset
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'rectificacion', 'Huesped A1', 'huesped-a1@example.com', 'correo', 'Corregir mi nombre', (now() at time zone 'utc')::date, null, null) as id_r \gset
select public.verify_expect_error(format($q$ select * from hoteles.arco_access_grant(%L, '00000000-0000-0000-0000-00000000c001') $q$, :'id_a'), 'P0001');
select hoteles.advance_arco_request(:'id_a', 'procedente', 'Identidad verificada en mostrador', (now() at time zone 'utc')::date);
select hoteles.advance_arco_request(:'id_r', 'procedente', 'Identidad verificada en mostrador', (now() at time zone 'utc')::date);
select public.verify_expect_error(format($q$ select * from hoteles.arco_access_grant(%L, '00000000-0000-0000-0000-00000000c001') $q$, :'id_r'), 'P0001');
select public.verify_expect_error(format($q$ select * from hoteles.arco_access_grant(%L, '00000000-0000-0000-0000-00000000c003') $q$, :'id_a'), '23503');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error(format($q$ select * from hoteles.arco_access_grant(%L, '00000000-0000-0000-0000-00000000c001') $q$, :'id_a'), '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error(format($q$ select * from hoteles.arco_access_grant(%L, '00000000-0000-0000-0000-00000000c001') $q$, :'id_a'), '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select public.verify_assert((select count(*) from hoteles.arco_access_grant(:'id_a', '00000000-0000-0000-0000-00000000c001') where out_contact = 'huesped-a1@example.com' and out_folio like 'ARCO-%') = 1, 'gm emite el enlace y recibe el contacto del titular');
reset role;
select public.verify_assert((select guest_id = '00000000-0000-0000-0000-00000000c001' from hoteles.arco_request where id = :'id_a'), 'el huesped queda ligado');
select count(*) as huella_deberia_ser_1 from hoteles.privacy_event_log where subject_id = :'id_a' and action = 'enlace_mis_datos_emitido' and actor_user_id = '00000000-0000-0000-0000-0000000a0a02';
rollback;

\echo '=== 16. arco_access_snapshot (sistema): con acceso procedente y huesped ligado devuelve SOLO perfil/estancias/consentimientos/identidad (sin notas internas ni conversaciones, sin documento) y deja huella; sin enlace, rectificacion o usuario autenticado = nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Huesped A1', 'huesped-a1@example.com', 'correo', 'Quiero conocer mis datos', (now() at time zone 'utc')::date, null, null) as id_a \gset
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Huesped A1', 'huesped-a1@example.com', 'correo', 'Sin ligar al huesped', (now() at time zone 'utc')::date, null, null) as id_n \gset
select hoteles.advance_arco_request(:'id_a', 'procedente', 'Identidad verificada en mostrador', (now() at time zone 'utc')::date);
select hoteles.advance_arco_request(:'id_n', 'procedente', 'Identidad verificada en mostrador', (now() at time zone 'utc')::date);
select out_folio from hoteles.arco_access_grant(:'id_a', '00000000-0000-0000-0000-00000000c001');
select public.verify_expect_error(format($q$ select hoteles.arco_access_snapshot(%L, 'hotel-a-pub') $q$, :'id_a'), '42501');
select set_config('request.jwt.claim.sub', '', true);
select hoteles.arco_access_snapshot(:'id_a', 'hotel-a-pub')::text as doc \gset
select public.verify_assert(:'doc'::jsonb #>> '{perfil,nombre}' = 'Huesped A1' and jsonb_array_length(:'doc'::jsonb -> 'estancias') = 1, 'perfil y estancias');
select public.verify_assert(not (:'doc'::jsonb ? 'notas') and not (:'doc'::jsonb ? 'conversaciones') and not (:'doc'::jsonb ? 'solicitudesContacto'), 'sin notas internas ni conversaciones');
select public.verify_assert(:'doc' not like '%payload%' and :'doc' not like '%v1.AAAA%' and :'doc' not like '%Zq9z%', 'sin documento de identidad');
select public.verify_assert(hoteles.arco_access_snapshot(:'id_n', 'hotel-a-pub') is null, 'acceso sin huesped ligado = nada');
select public.verify_assert(hoteles.arco_access_snapshot(:'id_a', 'hotel-b-pub') is null, 'el slug de OTRO hotel no abre la solicitud (cross-tenant)');
select public.verify_assert(hoteles.arco_access_snapshot('00000000-0000-0000-0000-00000000dead', 'hotel-a-pub') is null, 'solicitud inexistente = nada');
reset role;
select count(*) as huella_deberia_ser_1 from hoteles.privacy_event_log where subject_id = :'id_a' and action = 'mis_datos_consultado' and actor_user_id is null;
rollback;

\echo '=== 17. si la solicitud deja de ser procedente/ejecutada o cambia de derecho, el snapshot ya no responde (revocacion implicita del enlace) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Huesped A1', 'huesped-a1@example.com', 'correo', 'Quiero conocer mis datos', (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c001', null) as id_a \gset
select set_config('request.jwt.claim.sub', '', true);
select public.verify_assert(hoteles.arco_access_snapshot(:'id_a', 'hotel-a-pub') is null, 'recibida aun no es procedente: sin datos');
reset role;
update hoteles.arco_request set status = 'procedente', decided_on = current_date, execution_due_on = current_date + 15 where id = :'id_a';
set local role authenticated;
select public.verify_assert(hoteles.arco_access_snapshot(:'id_a', 'hotel-a-pub') is not null, 'procedente responde');
reset role;
update hoteles.arco_request set status = 'improcedente' where id = :'id_a';
set local role authenticated;
select public.verify_assert(hoteles.arco_access_snapshot(:'id_a', 'hotel-a-pub') is null, 'improcedente: sin datos');
rollback;

-- =============================================================================
-- (f) Base a medio migrar y amplitud de constraints
-- =============================================================================

\echo '=== 18. con la funcion publica AUSENTE (42883, base sin migrar) el SAVEPOINT recupera la transaccion y el camino anterior sigue corriendo (nunca 25P02) ==='
begin;
drop function hoteles.public_privacy_notices(text);
set local role authenticated;
savepoint sp_verify_fn_missing;
do $$
declare
  v_state text;
begin
  begin
    perform * from hoteles.public_privacy_notices('hotel-a-pub');
    raise exception 'se esperaba SQLSTATE 42883 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_fn_missing;
release savepoint sp_verify_fn_missing;
reset role;
select count(*) as camino_anterior_deberia_ser_1 from core.organization where slug = 'hotel-a-pub';
rollback;

\echo '=== 19. los CHECKs ampliados de 032 siguen cerrados a otros valores: canal/estado/sujeto fuera de lista = 23514; los nuevos valores validos entran ==='
begin;
select public.verify_expect_error($q$ insert into hoteles.arco_request (organization_id, property_id, folio, right_type, requester_name, channel, received_on, response_due_on) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-CK-1', 'acceso', 'Prueba Check', 'sms', current_date, current_date + 20) $q$, '23514');
select public.verify_expect_error($q$ insert into hoteles.arco_request (organization_id, property_id, folio, right_type, requester_name, channel, received_on, response_due_on, status) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-CK-2', 'acceso', 'Prueba Check', 'web', current_date, current_date + 20, 'archivada') $q$, '23514');
select public.verify_expect_error($q$ insert into hoteles.privacy_event_log (organization_id, property_id, subject_type, action) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'otra_cosa', 'x') $q$, '23514');
insert into hoteles.arco_request (organization_id, property_id, folio, right_type, requester_name, channel, received_on, response_due_on, status) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-CK-3', 'acceso', 'Prueba Check', 'publico', current_date, current_date + 20, 'pendiente_verificacion');
insert into hoteles.privacy_event_log (organization_id, property_id, subject_type, action) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'exportacion', 'x');
rollback;

\echo '=== 20. aislamiento cross-tenant de lectura directa: owner B no ve las solicitudes ni la bitacora de A; las pendientes de verificacion solo las ve owner/gm de su propia property ==='
begin;
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_assert((select count(*) from hoteles.arco_request where property_id = '00000000-0000-0000-0000-0000000a1a01') = 0, 'owner B no ve solicitudes de A');
select public.verify_assert((select count(*) from hoteles.privacy_event_log where property_id = '00000000-0000-0000-0000-0000000a1a01') = 0, 'owner B no ve la bitacora de A');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as frontdesk_ve_deberia_ser_0 from hoteles.arco_request where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 21. verificar sin fecha (NULL): la recepcion usa la zona horaria de la property o, sin configuracion, el default de negocio (Mexico) ==='
begin;
set local role authenticated;
select hoteles.public_arco_submit(gen_random_uuid(), '00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Ana Prueba', 'ana@example.com', null, repeat('a', 64), 900, null, (now() at time zone 'utc')::date) as id_z \gset
select out_result as rz from hoteles.public_arco_verify(:'id_z', repeat('a', 64), null) \gset
select public.verify_assert(:'rz' = 'ok', 'verifica sin fecha');
reset role;
select public.verify_assert((select received_on = (now() at time zone 'America/Mexico_City')::date and response_due_on = received_on + 20 from hoteles.arco_request where id = :'id_z'), 'default de negocio');
rollback;

\echo '=== listo: los escenarios *_deberia_ser_N deben dar N; los demas, sin ERROR; los should_fail/deberia_fallar, sin filas o con error. ==='
