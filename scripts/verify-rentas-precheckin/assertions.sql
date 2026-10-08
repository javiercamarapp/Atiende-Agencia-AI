-- Fixtures + assertions contra Postgres REAL (RLS / GRANT por columna / auth.uid() / security definer reales: el repositorio en memoria de
-- domain-rentas nunca los aplica) de la migracion packages/domain-rentas/migrations/036_rentas_precheckin_acceso.sql:
--   A. funciones de sistema: solo con auth.uid() NULL (anon y staff reciben error)
--   B. rentas.precheckin_verificar: emparejamiento, resultado generico, bloqueo tras 5 fallos y su vencimiento, token
--   C. rentas.precheckin_capturar: token de un solo uso, privacidad y reglamento, no sobrescribe, formas invalidas
--   D. RLS y GRANT por columna de precheckin_config / precheckin_captura / intentos / tokens, entre tenants y anon
--   E. rentas.acceso_marcar_entregada_manual y su efecto en la liberacion automatica; omitida sin contacto vuelve a ser candidata
--   F. purga de retencion rentas_huesped_pii: WhatsApp capturado
--   G. higiene: 0 funciones definer sin search_path, nada ejecutable ni visible para anon
--
-- Run via scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con ./run.sh. Cada escenario corre en su propio
-- `begin; ... rollback;`. Las fechas son relativas a current_date para que el archivo no caduque.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-000000f36001', 'rentas', 'Org A (precheckin)', 'org-a-precheckin'),
  ('00000000-0000-0000-0000-000000f36002', 'rentas', 'Org B (precheckin, ajena)', 'org-b-precheckin')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36001', 'rentas', 'Casa A'),
  ('00000000-0000-0000-0000-000000f36011', '00000000-0000-0000-0000-000000f36002', 'rentas', 'Casa B (ajena)')
on conflict do nothing;
insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values
  ('00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36001', 'America/Cancun', 'MXN'),
  ('00000000-0000-0000-0000-000000f36011', '00000000-0000-0000-0000-000000f36002', 'America/Cancun', 'MXN')
on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-000000f36020', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', 'Unidad A1', 1),
  ('00000000-0000-0000-0000-000000f36021', '00000000-0000-0000-0000-000000f36002', '00000000-0000-0000-0000-000000f36011', 'Unidad B1 (ajena)', 1)
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000f36030', 'admin-a-pre@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000f36031', 'contador-a-pre@example.com', 'Contador Org A', 'seed'),
  ('00000000-0000-0000-0000-000000f36032', 'admin-b-pre@example.com', 'Admin Org B (ajeno)', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000f36030', '00000000-0000-0000-0000-000000f36001', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000f36031', '00000000-0000-0000-0000-000000f36001', null, 'viewer', 'contador'),
  ('00000000-0000-0000-0000-000000f36032', '00000000-0000-0000-0000-000000f36002', null, 'admin', 'admin_gestora')
on conflict do nothing;

-- Reservas (canal Airbnb). o1 futura sin huesped; o2 futura con huesped y correo del staff; o3 PASADA; o4 CANCELADA futura;
-- o5 futura sin huesped; oB de la property B (otra organizacion).
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id, codigo_confirmacion, telefono_ultimos4) values
  ('00000000-0000-0000-0000-000000f36050', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36020', daterange(current_date + 20, current_date + 22, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o1', 'HMAB12CD34', '0123'),
  ('00000000-0000-0000-0000-000000f36051', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36020', daterange(current_date + 40, current_date + 43, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o2', 'HMZZ99YY88', '4455'),
  ('00000000-0000-0000-0000-000000f36052', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36020', daterange(current_date - 10, current_date - 7, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o3', 'HMPAST0001', '1111'),
  ('00000000-0000-0000-0000-000000f36053', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36020', daterange(current_date + 60, current_date + 62, '[)'), 'reserva', 'RESERVA_CANAL', 'cancelado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o4', 'HMCANC0001', '2222'),
  ('00000000-0000-0000-0000-000000f36055', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36020', daterange(current_date + 80, current_date + 82, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o5', 'HMFIVE0005', '5555'),
  ('00000000-0000-0000-0000-000000f36054', '00000000-0000-0000-0000-000000f36002', '00000000-0000-0000-0000-000000f36011', '00000000-0000-0000-0000-000000f36021', daterange(current_date + 20, current_date + 22, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-oB', 'HMBBBBBBBB', '9999')
on conflict do nothing;
insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto) values
  ('00000000-0000-0000-0000-000000f36060', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', 'Huesped del staff', 'staff@example.com')
on conflict do nothing;
update rentas.ocupacion set huesped_minimo_id = '00000000-0000-0000-0000-000000f36060' where id = '00000000-0000-0000-0000-000000f36051';
insert into rentas.precheckin_config (property_id, organization_id, reglamento, reglamento_version) values ('00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36001', 'Reglamento de prueba: sin fiestas.', 3)
on conflict do nothing;
insert into rentas.acceso_politica (property_id, organization_id, activo, horas_antes_checkin, hora_checkin, exigir_pago, ota_cuenta_como_pagada) values ('00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36001', true, 24, '15:00', true, true)
on conflict do nothing;
-- Capturas ya existentes (solo para probar RLS y purga; el staff no puede escribirlas): o3 (pasada) y o4 (futura).
insert into rentas.precheckin_captura (ocupacion_id, organization_id, property_id, whatsapp, acepto_privacidad_en, aviso_version) values
  ('00000000-0000-0000-0000-000000f36052', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '9981234567', now(), 'v1'),
  ('00000000-0000-0000-0000-000000f36053', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '9987654321', now(), 'v1')
on conflict do nothing;


-- Rn-P3-10: reservas para la ventana horaria del recordatorio (llegada MANANA a las 15:00 en Cancun: siempre entre 15 y 39 h de ahora).
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-000000f36022', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', 'Unidad A2', 1)
on conflict do nothing;
insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto) values
  ('00000000-0000-0000-0000-000000f36061', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', 'Con correo', 'huesped-recordatorio@example.com'),
  ('00000000-0000-0000-0000-000000f36062', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', 'Solo telefono', '9981112233')
on conflict do nothing;
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id, huesped_minimo_id) values
  ('00000000-0000-0000-0000-000000f36056', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36020', daterange((now() at time zone 'America/Cancun')::date + 1, (now() at time zone 'America/Cancun')::date + 3, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o6', '00000000-0000-0000-0000-000000f36061'),
  ('00000000-0000-0000-0000-000000f36057', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', '00000000-0000-0000-0000-000000f36022', daterange((now() at time zone 'America/Cancun')::date + 1, (now() at time zone 'America/Cancun')::date + 3, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o7', '00000000-0000-0000-0000-000000f36062')
on conflict do nothing;

\echo ''
\echo '=== A. funciones de sistema ==='
\echo ''

\echo '--- A1. anon no puede ejecutar precheckin_verificar (sin EXECUTE) ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('b', 64));
rollback;

\echo '--- A2. un usuario autenticado (auth.uid() no nulo) recibe 42501 al verificar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select count(*) as should_fail from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('b', 64));
rollback;

\echo '--- A3. un usuario autenticado recibe 42501 al capturar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select count(*) as should_fail from rentas.precheckin_capturar(repeat('b', 64), 'a@example.com', null, true, 'v1', true);
rollback;

\echo '--- A4. anon no puede ejecutar precheckin_capturar ni precheckin_info ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.precheckin_info('00000000-0000-0000-0000-000000f36010');
rollback;

\echo '--- A5. un usuario autenticado recibe 42501 en precheckin_info ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select count(*) as should_fail from rentas.precheckin_info('00000000-0000-0000-0000-000000f36010');
rollback;

\echo '--- A6. la sesion de sistema obtiene el nombre y el reglamento de la property A y nada de una property inexistente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as info_deberia_ser_1 from rentas.precheckin_info('00000000-0000-0000-0000-000000f36010') where propiedad_nombre = 'Casa A' and reglamento_version = 3 and reglamento like 'Reglamento%';
rollback;

\echo '--- A7. property inexistente: cero filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as info_inexistente_deberia_ser_0 from rentas.precheckin_info('00000000-0000-0000-0000-00000000dead');
rollback;

\echo ''
\echo '=== B. precheckin_verificar ==='
\echo ''

\echo '--- B1. codigo + 4 digitos correctos: ok, con token, dias y unidad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ok_deberia_ser_1 from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('b', 64)) where resultado = 'ok' and ocupacion_id = '00000000-0000-0000-0000-000000f36050' and unidad_nombre = 'Unidad A1' and ya_capturado = false and token_expira_en > now();
rollback;

\echo '--- B2. el codigo se normaliza (minusculas y espacios) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ok_normalizado_deberia_ser_1 from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', '  hmab12cd34 ', '0123', repeat('a', 64), repeat('b', 64)) where resultado = 'ok';
rollback;

\echo '--- B3. telefono distinto: invalido y NO crea token ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '9999', repeat('a', 64), repeat('b', 64));
reset role;
select count(*) as tokens_deberia_ser_0 from rentas.precheckin_token;
rollback;

\echo '--- B4. telefono distinto y codigo inexistente dan EXACTAMENTE el mismo resultado generico ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(distinct resultado) as un_solo_resultado_deberia_ser_1 from (select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '9999', repeat('a', 64), repeat('b', 64)) union all select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMNOEXISTE1', '0123', repeat('c', 64), repeat('d', 64))) r;
rollback;

\echo '--- B5. reserva pasada, cancelada y de OTRA property: todas invalidas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as no_invalidas_deberia_ser_0 from (select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMPAST0001', '1111', repeat('a', 64), repeat('b', 64)) union all select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMCANC0001', '2222', repeat('c', 64), repeat('d', 64)) union all select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMBBBBBBBB', '9999', repeat('e', 64), repeat('f', 64))) r where resultado <> 'invalido';
rollback;

\echo '--- B6. la property de la URL acota: el codigo de la property B funciona en B y NO en A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as acota_por_property_deberia_ser_2 from (select 'b' as k, resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36011', 'HMBBBBBBBB', '9999', repeat('a', 64), repeat('b', 64)) union all select 'a', resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMBBBBBBBB', '9999', repeat('c', 64), repeat('d', 64))) r where (k = 'b' and resultado = 'ok') or (k = 'a' and resultado = 'invalido');
rollback;

\echo '--- B7. 5 fallos con el mismo codigo: el 6to intento, aun con el telefono CORRECTO, queda bloqueado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '1111', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '2222', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '3333', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '4444', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '5555', repeat('a', 64), repeat('b', 64));
select count(*) as bloqueado_deberia_ser_1 from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('b', 64)) where resultado = 'bloqueado';
rollback;

\echo '--- B8. 4 fallos todavia NO bloquean (el 5to intento correcto entra) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '1111', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '2222', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '3333', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '4444', repeat('a', 64), repeat('b', 64));
select count(*) as ok_tras_4_fallos_deberia_ser_1 from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('b', 64)) where resultado = 'ok';
rollback;

\echo '--- B9. el bloqueo tambien aplica a un codigo que NO existe (sin oraculo de existencia) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMNOEXISTE1', '1111', repeat('c', 64), repeat('d', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMNOEXISTE1', '1111', repeat('c', 64), repeat('d', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMNOEXISTE1', '1111', repeat('c', 64), repeat('d', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMNOEXISTE1', '1111', repeat('c', 64), repeat('d', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMNOEXISTE1', '1111', repeat('c', 64), repeat('d', 64));
select count(*) as bloqueado_inexistente_deberia_ser_1 from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMNOEXISTE1', '1111', repeat('c', 64), repeat('d', 64)) where resultado = 'bloqueado';
rollback;

\echo '--- B10. el bloqueo vence a la hora: con bloqueado_hasta en el pasado el intento correcto entra ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '1111', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '2222', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '3333', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '4444', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '5555', repeat('a', 64), repeat('b', 64));
reset role;
update rentas.precheckin_intento set ventana_inicio = now() - interval '2 hours', bloqueado_hasta = now() - interval '1 hour';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ok_tras_vencer_deberia_ser_1 from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('b', 64)) where resultado = 'ok';
rollback;

\echo '--- B11. un acierto reinicia el contador: 4 fallos, acierto y 4 fallos mas NO bloquean ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '1111', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '2222', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '3333', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '4444', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('e', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '1111', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '2222', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '3333', repeat('a', 64), repeat('b', 64));
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '4444', repeat('a', 64), repeat('b', 64));
select count(*) as sin_bloqueo_deberia_ser_1 from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('f', 64)) where resultado = 'ok';
rollback;

\echo '--- B12. un parametro con forma invalida (telefono de 3 digitos) lanza 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '012', repeat('a', 64), repeat('b', 64));
rollback;

\echo '--- B13. una reserva que ya capturo se reporta ya_capturado=true al verificar (ok) ---'
begin;
reset role;
insert into rentas.precheckin_captura (ocupacion_id, organization_id, property_id, whatsapp, acepto_privacidad_en, aviso_version) values ('00000000-0000-0000-0000-000000f36050', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', null, now(), 'v1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ya_capturado_deberia_ser_1 from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('b', 64)) where resultado = 'ok' and ya_capturado;
rollback;

\echo ''
\echo '=== C. precheckin_capturar ==='
\echo ''

\echo '--- C1. flujo completo: verifica, captura, guarda el correo en guest_minimo, la captura (version del reglamento) y el evento en la bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
select resultado from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', true, 'v1', true);
reset role;
select count(*) as flujo_completo_deberia_ser_1 from rentas.ocupacion o join rentas.guest_minimo g on g.id = o.huesped_minimo_id join rentas.precheckin_captura c on c.ocupacion_id = o.id where o.id = '00000000-0000-0000-0000-000000f36050' and g.contacto = 'huesped@example.com' and c.whatsapp = '9981112233' and c.reglamento_version = 3 and c.acepto_reglamento_en is not null and c.organization_id = '00000000-0000-0000-0000-000000f36001' and exists (select 1 from rentas.acceso_bitacora b where b.ocupacion_id = '00000000-0000-0000-0000-000000f36050' and b.evento = 'precheckin_capturado');
rollback;

\echo '--- C2. el token es de UN SOLO USO: el segundo intento con el mismo token da token_invalido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
select resultado from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', true, 'v1', true);
select count(*) as reuso_deberia_ser_1 from rentas.precheckin_capturar(repeat('7', 64), 'otro@example.com', '9981112233', true, 'v1', true) where resultado = 'token_invalido';
rollback;

\echo '--- C3. un token inexistente da token_invalido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as inexistente_deberia_ser_1 from rentas.precheckin_capturar(repeat('9', 64), 'huesped@example.com', '9981112233', true, 'v1', true) where resultado = 'token_invalido';
rollback;

\echo '--- C4. un token vencido da token_invalido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
reset role;
update rentas.precheckin_token set expira_en = now() - interval '1 minute';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as vencido_deberia_ser_1 from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', true, 'v1', true) where resultado = 'token_invalido';
rollback;

\echo '--- C5. sin aceptar el aviso de privacidad: privacidad_requerida y el token NO se consume (puede reintentar) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
select resultado from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', false, 'v1', true);
select count(*) as reintento_deberia_ser_1 from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', true, 'v1', true) where resultado = 'ok';
rollback;

\echo '--- C6. la property tiene reglamento y no lo acepto: reglamento_requerido, token intacto y nada guardado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
select resultado from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', true, 'v1', false);
reset role;
select count(*) as nada_guardado_deberia_ser_1 from rentas.ocupacion o where o.id = '00000000-0000-0000-0000-000000f36050' and o.huesped_minimo_id is null and not exists (select 1 from rentas.precheckin_captura c where c.ocupacion_id = '00000000-0000-0000-0000-000000f36050') and (select usado_en from rentas.precheckin_token) is null;
rollback;

\echo '--- C7. NO sobrescribe el correo que el staff ya tenia, pero si registra la captura ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMZZ99YY88', '4455', repeat('a', 64), repeat('7', 64));
select resultado from rentas.precheckin_capturar(repeat('7', 64), 'nuevo@example.com', '9981112233', true, 'v1', true);
reset role;
select count(*) as correo_staff_intacto_deberia_ser_1 from rentas.guest_minimo g join rentas.precheckin_captura c on c.ocupacion_id = '00000000-0000-0000-0000-000000f36051' where g.id = '00000000-0000-0000-0000-000000f36060' and g.contacto = 'staff@example.com';
rollback;

\echo '--- C8. una reserva que ya capturo NO se sobrescribe: ya_capturado y el correo original se conserva ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
select resultado from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', true, 'v1', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('8', 64));
select count(*) as no_sobrescribe_deberia_ser_1 from rentas.precheckin_capturar(repeat('8', 64), 'atacante@example.com', '9981112233', true, 'v1', true) where resultado = 'ya_capturado';
rollback;

\echo '--- C9. correo con forma invalida lanza 22023 y NO consume el token ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
select count(*) as should_fail from rentas.precheckin_capturar(repeat('7', 64), 'no-es-correo', '9981112233', true, 'v1', true);
rollback;

\echo '--- C10. WhatsApp con letras o fuera de 10-15 digitos lanza 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
select count(*) as should_fail from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', 'abc123', true, 'v1', true);
rollback;

\echo '--- C11. un token solo captura SU reserva: la captura queda con la organizacion y property del token ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36011', 'HMBBBBBBBB', '9999', repeat('a', 64), repeat('7', 64));
select resultado from rentas.precheckin_capturar(repeat('7', 64), 'b@example.com', null, true, 'v1', false);
reset role;
select count(*) as capturo_b_no_a_deberia_ser_1 from rentas.precheckin_captura c where c.ocupacion_id = '00000000-0000-0000-0000-000000f36054' and c.organization_id = '00000000-0000-0000-0000-000000f36002' and c.property_id = '00000000-0000-0000-0000-000000f36011' and c.reglamento_version is null and not exists (select 1 from rentas.precheckin_captura x where x.ocupacion_id = '00000000-0000-0000-0000-000000f36050' and x.whatsapp is not null);
rollback;

\echo '--- C12. una reserva que ya paso (token valido pero la estancia termino) da token_invalido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
reset role;
update rentas.ocupacion set rango = daterange(current_date - 5, current_date - 3, '[)') where id = '00000000-0000-0000-0000-000000f36050';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as estancia_pasada_deberia_ser_1 from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', true, 'v1', true) where resultado = 'token_invalido';
rollback;

\echo ''
\echo '=== D. RLS y GRANT ==='
\echo ''

\echo '--- D1. admin_gestora de la property A guarda el reglamento (RLS de escritura) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
update rentas.precheckin_config set reglamento = 'Nuevo reglamento', reglamento_version = 4, updated_by = '00000000-0000-0000-0000-000000f36030', updated_at = now() where property_id = '00000000-0000-0000-0000-000000f36010';
select count(*) as reglamento_actualizado_deberia_ser_1 from rentas.precheckin_config where property_id = '00000000-0000-0000-0000-000000f36010' and reglamento_version = 4;
rollback;

\echo '--- D2. el admin de la Org B NO puede insertar el reglamento de la property A (WITH CHECK) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36032', true);
insert into rentas.precheckin_config (property_id, organization_id, reglamento, reglamento_version, updated_by) values ('00000000-0000-0000-0000-000000f36011', '00000000-0000-0000-0000-000000f36001', 'x', 1, '00000000-0000-0000-0000-000000f36032') returning 1 as should_fail;
rollback;

\echo '--- D3. el contador (sin can_manage_acceso) no ve el reglamento ni las capturas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36031', true);
select (select count(*) from rentas.precheckin_config) + (select count(*) from rentas.precheckin_captura) as contador_ve_deberia_ser_0;
rollback;

\echo '--- D4. el admin de la Org B no ve las capturas de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36032', true);
select count(*) as admin_b_ve_deberia_ser_0 from rentas.precheckin_captura;
rollback;

\echo '--- D5. el admin de la Org A ve las 2 capturas de su property ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select count(*) as admin_a_ve_deberia_ser_2 from rentas.precheckin_captura;
rollback;

\echo '--- D6. el staff NO puede insertar capturas (sin GRANT de escritura: solo la funcion de sistema) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
insert into rentas.precheckin_captura (ocupacion_id, organization_id, property_id, acepto_privacidad_en, aviso_version) values ('00000000-0000-0000-0000-000000f36050', '00000000-0000-0000-0000-000000f36001', '00000000-0000-0000-0000-000000f36010', now(), 'v1') returning 1 as should_fail;
rollback;

\echo '--- D7. el staff NO puede actualizar capturas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
update rentas.precheckin_captura set whatsapp = '9990000000' returning 1 as should_fail;
rollback;

\echo '--- D8. GRANT por columna: property_id del reglamento es inmutable para el staff ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
update rentas.precheckin_config set property_id = '00000000-0000-0000-0000-000000f36011' where property_id = '00000000-0000-0000-0000-000000f36010' returning 1 as should_fail;
rollback;

\echo '--- D9. authenticated NO puede leer los intentos ni los tokens (sin GRANT) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select count(*) as should_fail from rentas.precheckin_intento;
rollback;

\echo '--- D10. authenticated NO puede leer los tokens ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select count(*) as should_fail from rentas.precheckin_token;
rollback;

\echo '--- D11. anon NO puede leer las capturas ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.precheckin_captura;
rollback;

\echo '--- D12. anon NO puede leer el reglamento ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.precheckin_config;
rollback;

\echo ''
\echo '=== E. entrega manual del acceso ==='
\echo ''

\echo '--- E1. el admin marca la reserva como entregada a mano: true, via manual y evento en la bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36050') as primera;
select count(*) as entregada_deberia_ser_1 from rentas.acceso_reserva ar join rentas.acceso_bitacora b on b.ocupacion_id = ar.ocupacion_id where ar.ocupacion_id = '00000000-0000-0000-0000-000000f36050' and ar.liberado_via = 'manual' and ar.liberado_en is not null and b.evento = 'entregada_manual';
rollback;

\echo '--- E2. es idempotente: la segunda llamada devuelve false y no duplica la bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36050');
select count(*) as segunda_true_deberia_ser_0 from (select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36050') as r) x where x.r;
rollback;

\echo '--- E3. el admin de la Org B recibe P0002 sobre una reserva de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36032', true);
select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36050') as should_fail;
rollback;

\echo '--- E4. el contador (sin can_manage_acceso) recibe P0002 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36031', true);
select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36050') as should_fail;
rollback;

\echo '--- E5. anon no puede ejecutarla ---'
begin;
set local role anon;
select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36050') as should_fail;
rollback;

\echo '--- E6. la sesion de sistema (auth.uid() NULL) tampoco: es una funcion de staff ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36050') as should_fail;
rollback;

\echo '--- E7. una reserva cancelada no se puede marcar (P0002) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36053') as should_fail;
rollback;

\echo '--- E8. ANTES de marcarla, la reserva esta en la ventana de liberacion y SIN contacto (candidata que se omitiria) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as candidata_sin_contacto_deberia_ser_1 from rentas.acceso_siguiente_liberacion_cifrada('{}', (((current_date + 20) + time '12:00') at time zone 'America/Cancun')) where ocupacion_id = '00000000-0000-0000-0000-000000f36050' and huesped_contacto is null;
rollback;

\echo '--- E9. DESPUES de marcarla a mano, la liberacion automatica ya no la toma ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select rentas.acceso_marcar_entregada_manual('00000000-0000-0000-0000-000000f36050');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ya_no_candidata_deberia_ser_0 from rentas.acceso_siguiente_liberacion_cifrada('{}', (((current_date + 20) + time '12:00') at time zone 'America/Cancun')) where ocupacion_id = '00000000-0000-0000-0000-000000f36050';
rollback;

\echo '--- E10. una reserva omitida por falta de contacto VUELVE a ser candidata y ahora con el correo capturado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select resultado from rentas.precheckin_verificar('00000000-0000-0000-0000-000000f36010', 'HMAB12CD34', '0123', repeat('a', 64), repeat('7', 64));
select resultado from rentas.precheckin_capturar(repeat('7', 64), 'huesped@example.com', '9981112233', true, 'v1', true);
select count(*) as candidata_con_contacto_deberia_ser_1 from rentas.acceso_siguiente_liberacion_cifrada('{}', (((current_date + 20) + time '12:00') at time zone 'America/Cancun')) where ocupacion_id = '00000000-0000-0000-0000-000000f36050' and huesped_contacto = 'huesped@example.com';
rollback;

\echo ''
\echo '=== F. retencion rentas_huesped_pii: WhatsApp ==='
\echo ''

\echo '--- F1. la purga limpia el WhatsApp de la reserva pasada, conserva la fila (evidencia) y NO toca el de la futura ---'
begin;
select set_config('request.jwt.claim.sub', '', true);
select out_afectadas from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f36001', 'rentas_huesped_pii', now(), false, 500);
select count(*) as limpio_y_futuro_intacto_deberia_ser_1 from (select (select count(*) from rentas.precheckin_captura where ocupacion_id = '00000000-0000-0000-0000-000000f36052' and whatsapp is null and aviso_version = 'v1') as pasada_limpia, (select count(*) from rentas.precheckin_captura where ocupacion_id = '00000000-0000-0000-0000-000000f36053' and whatsapp = '9987654321') as futura_intacta) r where r.pasada_limpia = 1 and r.futura_intacta = 1;
rollback;

\echo '--- F2. la simulacion cuenta sin tocar nada ---'
begin;
select set_config('request.jwt.claim.sub', '', true);
select out_afectadas from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f36001', 'rentas_huesped_pii', now(), true, 500);
select count(*) as sigue_el_dato_deberia_ser_1 from rentas.precheckin_captura where ocupacion_id = '00000000-0000-0000-0000-000000f36052' and whatsapp = '9981234567';
rollback;

\echo '--- F3. la purga sigue siendo solo de sistema (un autenticado recibe 42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select count(*) as should_fail from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f36001', 'rentas_huesped_pii', now(), true, 10);
rollback;

\echo '--- F4. la otra clase de retencion (rentas_acceso_instrucciones) sigue funcionando con el cuerpo reemplazado ---'
begin;
select set_config('request.jwt.claim.sub', '', true);
select out_afectadas as acceso_sin_filas_deberia_ser_0 from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f36001', 'rentas_acceso_instrucciones', now(), true, 10);
rollback;

\echo ''
\echo '=== G. higiene ==='
\echo ''

\echo '--- G1. 0 funciones security definer del schema rentas sin search_path fijo ---'
begin;
select count(*) as definer_sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'rentas' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%');
rollback;

\echo '--- G2. anon no ejecuta ninguna funcion precheckin_* ni acceso_marcar_entregada_manual ---'
begin;
select count(*) as anon_ejecuta_deberia_ser_0 from pg_proc p where p.pronamespace = 'rentas'::regnamespace and (p.proname like 'precheckin%' or p.proname = 'acceso_marcar_entregada_manual') and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo '--- G3. anon no tiene ningun privilegio sobre las tablas precheckin_* ---'
begin;
select count(*) as anon_con_privilegios_deberia_ser_0 from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'rentas' and table_name like 'precheckin%';
rollback;

\echo '--- G4. authenticated no tiene privilegios sobre intentos ni tokens ---'
begin;
select count(*) as authenticated_con_privilegios_deberia_ser_0 from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'rentas' and table_name in ('precheckin_intento', 'precheckin_token');
rollback;

\echo '--- G5. ninguna policy nueva usa using (true) ---'
begin;
select count(*) as policies_abiertas_deberia_ser_0 from pg_policies where schemaname = 'rentas' and tablename like 'precheckin%' and (qual = 'true' or with_check = 'true');
rollback;

\echo ''
\echo '=== H. consulta del recordatorio horario (PostgresRentasRepository.listReservasProximasACheckInVentana), bajo la sesion real del cron: role authenticated con sub vacio (auth.uid() null) ==='
\echo ''
\echo '--- H1. la reserva con correo que llega manana a las 15:00 (Cancun) entra en la ventana de 2 a 48 h ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as con_correo_deberia_ser_1 from (select o.id
         from rentas.ocupacion o
         join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         left join rentas.property_config pc on pc.property_id = o.property_id
        where o.capa = 'reserva' and o.estado = 'confirmado' and o.recordatorio_checkin_enviado_en is null
          and lower(o.rango) between (now()::timestamptz)::date - 1 and (now()::timestamptz)::date + 3
          and g.contacto ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          and ((lower(o.rango) + '15:00'::time) at time zone coalesce(pc.zona_horaria, 'America/Mexico_City')) between now()::timestamptz + make_interval(hours => 2::int) and now()::timestamptz + make_interval(hours => 48::int)) q where q.id = '00000000-0000-0000-0000-000000f36056';
rollback;
\echo '--- H2. la reserva cuyo huesped solo dejo un telefono NO es candidata ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sin_correo_deberia_ser_0 from (select o.id
         from rentas.ocupacion o
         join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         left join rentas.property_config pc on pc.property_id = o.property_id
        where o.capa = 'reserva' and o.estado = 'confirmado' and o.recordatorio_checkin_enviado_en is null
          and lower(o.rango) between (now()::timestamptz)::date - 1 and (now()::timestamptz)::date + 3
          and g.contacto ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          and ((lower(o.rango) + '15:00'::time) at time zone coalesce(pc.zona_horaria, 'America/Mexico_City')) between now()::timestamptz + make_interval(hours => 2::int) and now()::timestamptz + make_interval(hours => 48::int)) q where q.id = '00000000-0000-0000-0000-000000f36057';
rollback;
\echo '--- H3. una reserva de dentro de 20 dias queda fuera de la ventana ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as lejana_deberia_ser_0 from (select o.id
         from rentas.ocupacion o
         join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         left join rentas.property_config pc on pc.property_id = o.property_id
        where o.capa = 'reserva' and o.estado = 'confirmado' and o.recordatorio_checkin_enviado_en is null
          and lower(o.rango) between (now()::timestamptz)::date - 1 and (now()::timestamptz)::date + 3
          and g.contacto ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          and ((lower(o.rango) + '15:00'::time) at time zone coalesce(pc.zona_horaria, 'America/Mexico_City')) between now()::timestamptz + make_interval(hours => 2::int) and now()::timestamptz + make_interval(hours => 48::int)) q where q.id = '00000000-0000-0000-0000-000000f36050';
rollback;
\echo '--- H4. con el reloj 40 h adelante la llegada de manana ya paso la ventana (menos de 2 h o ya ocurrio) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as fuera_deberia_ser_0 from (select o.id
         from rentas.ocupacion o
         join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         left join rentas.property_config pc on pc.property_id = o.property_id
        where o.capa = 'reserva' and o.estado = 'confirmado' and o.recordatorio_checkin_enviado_en is null
          and lower(o.rango) between ((now() + interval '40 hours')::timestamptz)::date - 1 and ((now() + interval '40 hours')::timestamptz)::date + 3
          and g.contacto ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          and ((lower(o.rango) + '15:00'::time) at time zone coalesce(pc.zona_horaria, 'America/Mexico_City')) between (now() + interval '40 hours')::timestamptz + make_interval(hours => 2::int) and (now() + interval '40 hours')::timestamptz + make_interval(hours => 48::int)) q where q.id = '00000000-0000-0000-0000-000000f36056';
rollback;
\echo '--- H5. una vez marcado el recordatorio como enviado deja de ser candidata (idempotencia) ---'
begin;
update rentas.ocupacion set recordatorio_checkin_enviado_en = now() where id = '00000000-0000-0000-0000-000000f36056';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ya_marcada_deberia_ser_0 from (select o.id
         from rentas.ocupacion o
         join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         left join rentas.property_config pc on pc.property_id = o.property_id
        where o.capa = 'reserva' and o.estado = 'confirmado' and o.recordatorio_checkin_enviado_en is null
          and lower(o.rango) between (now()::timestamptz)::date - 1 and (now()::timestamptz)::date + 3
          and g.contacto ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          and ((lower(o.rango) + '15:00'::time) at time zone coalesce(pc.zona_horaria, 'America/Mexico_City')) between now()::timestamptz + make_interval(hours => 2::int) and now()::timestamptz + make_interval(hours => 48::int)) q where q.id = '00000000-0000-0000-0000-000000f36056';
rollback;
\echo '--- H6. una reserva cancelada no es candidata ---'
begin;
update rentas.ocupacion set estado = 'cancelado' where id = '00000000-0000-0000-0000-000000f36056';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as cancelada_deberia_ser_0 from (select o.id
         from rentas.ocupacion o
         join rentas.guest_minimo g on g.id = o.huesped_minimo_id
         left join rentas.property_config pc on pc.property_id = o.property_id
        where o.capa = 'reserva' and o.estado = 'confirmado' and o.recordatorio_checkin_enviado_en is null
          and lower(o.rango) between (now()::timestamptz)::date - 1 and (now()::timestamptz)::date + 3
          and g.contacto ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          and ((lower(o.rango) + '15:00'::time) at time zone coalesce(pc.zona_horaria, 'America/Mexico_City')) between now()::timestamptz + make_interval(hours => 2::int) and now()::timestamptz + make_interval(hours => 48::int)) q where q.id = '00000000-0000-0000-0000-000000f36056';
rollback;

\echo '--- H7. bajo la sesion del cron guest_minimo es legible (antes de la correccion de RLS devolvia 0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as guest_visible_al_cron_deberia_ser_1 from rentas.guest_minimo where id = '00000000-0000-0000-0000-000000f36061';
rollback;
\echo '--- H8. un usuario real de OTRA organizacion sigue sin ver el guest_minimo (el escape solo aplica con auth.uid() nulo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36032', true);
select count(*) as ajeno_deberia_ser_0 from rentas.guest_minimo where id = '00000000-0000-0000-0000-000000f36061';
rollback;
\echo '--- H9. un usuario real de la organizacion dueña lo sigue viendo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f36030', true);
select count(*) as propio_deberia_ser_1 from rentas.guest_minimo where id = '00000000-0000-0000-0000-000000f36061';
rollback;
\echo '--- H10. anon sigue sin privilegios sobre guest_minimo ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.guest_minimo;
rollback;

\echo ''
\echo '=== listo: los escenarios *_deberia_ser_N deben devolver N; los marcados should_fail deben terminar en ERROR ==='
