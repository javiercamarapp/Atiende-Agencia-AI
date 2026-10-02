-- Fixtures + assertions contra Postgres REAL (RLS / GRANT por columna / auth.uid() / security definer reales: el
-- repositorio en memoria de domain-rentas nunca los aplica) de la migracion
-- packages/domain-rentas/migrations/028_rentas_privacidad_cifrado_arco_retencion.sql:
--   A. Rn-29  cifrado del acceso al huesped: solo sobres, trigger anti-texto-plano, bitacora, funciones de sistema,
--             barrido idempotente y romper-cristal sin esos campos.
--   B. Rn-30  retencion de plataforma de rentas (simulacion vs ejecucion).
--   C. Rn-07  solicitudes ARCO propias de rentas (por rol y entre tenants) y su union en core._arco_union().
--
-- Run via scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con ./run.sh. Cada escenario corre en
-- su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-000000f29001', 'rentas', 'Org A (privacidad rentas)', 'org-a-privacidad-rentas'),
  ('00000000-0000-0000-0000-000000f29002', 'rentas', 'Org B (privacidad rentas, ajena)', 'org-b-privacidad-rentas')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000f29010', '00000000-0000-0000-0000-000000f29001', 'rentas', 'Property A'),
  ('00000000-0000-0000-0000-000000f29011', '00000000-0000-0000-0000-000000f29002', 'rentas', 'Property B (ajena)')
on conflict do nothing;
insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values
  ('00000000-0000-0000-0000-000000f29010', '00000000-0000-0000-0000-000000f29001', 'America/Merida', 'MXN'),
  ('00000000-0000-0000-0000-000000f29011', '00000000-0000-0000-0000-000000f29002', 'America/Merida', 'MXN')
on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-000000f29020', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Unidad A1 (con instrucciones heredadas)', 1),
  ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Unidad A2 (sin instrucciones)', 1),
  ('00000000-0000-0000-0000-000000f29021', '00000000-0000-0000-0000-000000f29002', '00000000-0000-0000-0000-000000f29011', 'Unidad B1 (ajena)', 1)
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000f29030', 'admin-a-priv@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000f29031', 'contador-a-priv@example.com', 'Contador Org A', 'seed'),
  ('00000000-0000-0000-0000-000000f29032', 'admin-b-priv@example.com', 'Admin Org B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000f29033', 'superadmin-priv@example.com', 'Superadmin privacidad', 'seed'),
  ('00000000-0000-0000-0000-000000f29034', 'operador-total-a-priv@example.com', 'Operador acceso total Org A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000f29030', '00000000-0000-0000-0000-000000f29001', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000f29031', '00000000-0000-0000-0000-000000f29001', null, 'viewer', 'contador'),
  ('00000000-0000-0000-0000-000000f29032', '00000000-0000-0000-0000-000000f29002', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000f29034', '00000000-0000-0000-0000-000000f29001', null, 'member', 'operador:acceso_total')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-000000f29033') on conflict do nothing;

-- Politica de acceso de la property A: 24 h antes, check-in 15:00 hora local, sin exigir pago.
insert into rentas.acceso_politica (property_id, organization_id, activo, horas_antes_checkin, hora_checkin, exigir_pago, ota_cuenta_como_pagada) values
  ('00000000-0000-0000-0000-000000f29010', '00000000-0000-0000-0000-000000f29001', true, 24, '15:00', false, true)
on conflict do nothing;
insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto) values
  ('00000000-0000-0000-0000-000000f29040', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Huesped Privacidad', 'privacidad@example.com')
on conflict do nothing;
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, huesped_minimo_id) values
  ('00000000-0000-0000-0000-000000f29050', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', '00000000-0000-0000-0000-000000f29020', daterange('2027-03-10', '2027-03-12', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, '00000000-0000-0000-0000-000000f29040')
on conflict do nothing;

-- Instrucciones HEREDADAS en texto plano (previas a 028): se siembran con el trigger de "solo cifrado" apagado.
alter table rentas.acceso_instruccion disable trigger acceso_instruccion_solo_cifrado_trg;
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_exacta, codigo_acceso, instrucciones) values
  ('00000000-0000-0000-0000-000000f29020', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Calle 60 #123 Centro Merida', '4821', 'Caja junto a la puerta')
on conflict do nothing;
alter table rentas.acceso_instruccion enable trigger acceso_instruccion_solo_cifrado_trg;

-- Romper-cristal vigente de un superadmin real sobre la Org A.
insert into rentas.break_glass_session (id, actor_user_id, actor_email, organization_id, reason, opened_at, expires_at) values
  ('00000000-0000-0000-0000-000000f29060', '00000000-0000-0000-0000-000000f29033', 'superadmin-priv@example.com', '00000000-0000-0000-0000-000000f29001', 'Ticket SOP-VERIFY: verificar que el romper-cristal no devuelve el acceso al huesped.', now(), now() + interval '30 minutes')
on conflict do nothing;

\echo ''
\echo '=== A. Rn-29: cifrado en reposo del acceso al huesped ==='
\echo ''

\echo '--- A1. el staff NO puede insertar texto plano (trigger solo-cifrado) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_exacta, updated_by)
values ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Calle en claro 1', '00000000-0000-0000-0000-000000f29030') returning 1 as should_fail;
rollback;

\echo '--- A2. el admin inserta un SOBRE (direccion_cifrada + key_version) y no queda texto plano ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_cifrada, key_version, updated_by)
values ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 1, '00000000-0000-0000-0000-000000f29030');
select count(*) as insertada_sin_claro_deberia_ser_1 from rentas.acceso_instruccion where unidad_id = '00000000-0000-0000-0000-000000f29022' and direccion_exacta is null and direccion_cifrada is not null;
rollback;

\echo '--- A3. el staff NO puede fijar un texto plano NUEVO sobre la fila heredada -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
update rentas.acceso_instruccion set codigo_acceso = '0000', updated_at = now(), updated_by = '00000000-0000-0000-0000-000000f29030' where unidad_id = '00000000-0000-0000-0000-000000f29020' returning 1 as should_fail;
rollback;

\echo '--- A4. el admin migra la fila heredada: escribe el sobre y ANULA el texto plano en la misma sentencia ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
update rentas.acceso_instruccion set direccion_cifrada = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', key_version = 1, direccion_exacta = null, codigo_acceso = null, instrucciones = null, updated_at = now(), updated_by = '00000000-0000-0000-0000-000000f29030' where unidad_id = '00000000-0000-0000-0000-000000f29020';
select count(*) as migrada_deberia_ser_1 from rentas.acceso_instruccion where unidad_id = '00000000-0000-0000-0000-000000f29020' and direccion_exacta is null and codigo_acceso is null and instrucciones is null and direccion_cifrada is not null;
rollback;

\echo '--- A5. un sobre sin version de llave -- RECHAZADO (CHECK) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_cifrada, updated_by)
values ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', '00000000-0000-0000-0000-000000f29030') returning 1 as should_fail;
rollback;

\echo '--- A6. un sobre con formato invalido -- RECHAZADO (CHECK) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_cifrada, key_version, updated_by)
values ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'texto-que-no-es-un-sobre', 1, '00000000-0000-0000-0000-000000f29030') returning 1 as should_fail;
rollback;

\echo '--- A7. cross-tenant: el admin de la Org B NO puede escribir el sobre de una unidad de la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29032', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_cifrada, key_version, updated_by)
values ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 1, '00000000-0000-0000-0000-000000f29032') returning 1 as should_fail;
rollback;

\echo '--- A8. cross-tenant: el admin de la Org B no ve ninguna instruccion de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29032', true);
select count(*) as ajenas_visibles_deberia_ser_0 from rentas.acceso_instruccion where property_id = '00000000-0000-0000-0000-000000f29010';
rollback;

\echo '--- A9. el contador (sin autoridad de acceso) no ve instrucciones ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29031', true);
select count(*) as contador_ve_deberia_ser_0 from rentas.acceso_instruccion;
rollback;

\echo '--- A10. el contador no puede escribir un sobre -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29031', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_cifrada, key_version, updated_by)
values ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 1, '00000000-0000-0000-0000-000000f29031') returning 1 as should_fail;
rollback;

\echo '--- A11. anon no puede leer instrucciones -- RECHAZADO (sin GRANT) ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.acceso_instruccion;
rollback;

\echo '--- A12. bitacora: el admin registra una lectura de SU unidad y la ve (sin contenido) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select rentas.acceso_instruccion_registrar('00000000-0000-0000-0000-000000f29020', 'lectura_admin');
select count(*) as lectura_registrada_deberia_ser_1 from rentas.acceso_instruccion_bitacora where unidad_id = '00000000-0000-0000-0000-000000f29020' and evento = 'lectura_admin' and actor_id = '00000000-0000-0000-0000-000000f29030';
rollback;

\echo '--- A13. bitacora: el contador no puede registrar (sin autoridad) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29031', true);
select rentas.acceso_instruccion_registrar('00000000-0000-0000-0000-000000f29020', 'lectura_admin') as should_fail;
rollback;

\echo '--- A14. bitacora: cross-tenant, el admin de la Org B no registra sobre una unidad de la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29032', true);
select rentas.acceso_instruccion_registrar('00000000-0000-0000-0000-000000f29020', 'lectura_admin') as should_fail;
rollback;

\echo '--- A15. bitacora: sin usuario autenticado (sesion de sistema) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_instruccion_registrar('00000000-0000-0000-0000-000000f29020', 'lectura_admin') as should_fail;
rollback;

\echo '--- A16. bitacora: un evento que solo escribe el sistema (cifrado_inicial) no se acepta por la funcion de staff -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select rentas.acceso_instruccion_registrar('00000000-0000-0000-0000-000000f29020', 'cifrado_inicial') as should_fail;
rollback;

\echo '--- A17. bitacora append-only: ni el admin inserta directo -- RECHAZADO (sin GRANT de escritura) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
insert into rentas.acceso_instruccion_bitacora (organization_id, property_id, unidad_id, evento, actor_id)
values ('00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', '00000000-0000-0000-0000-000000f29020', 'lectura_admin', '00000000-0000-0000-0000-000000f29030') returning 1 as should_fail;
rollback;

\echo '--- A18. bitacora: el contador no la ve ---'
begin;
insert into rentas.acceso_instruccion_bitacora (organization_id, property_id, unidad_id, evento, actor_id)
values ('00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', '00000000-0000-0000-0000-000000f29020', 'lectura_admin', '00000000-0000-0000-0000-000000f29030');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29031', true);
select count(*) as contador_ve_bitacora_deberia_ser_0 from rentas.acceso_instruccion_bitacora;
rollback;

\echo '--- A19. funciones de SOLO-SISTEMA: un usuario de staff no puede pedir las filas por cifrar -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select * from rentas.acceso_instruccion_pendientes_cifrar(10) as should_fail;
rollback;

\echo '--- A20. funciones de SOLO-SISTEMA: un usuario de staff no puede aplicar un cifrado -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select rentas.acceso_instruccion_aplicar_cifrado('00000000-0000-0000-0000-000000f29020', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', null, null, 1) as should_fail;
rollback;

\echo '--- A21. funciones de SOLO-SISTEMA: un usuario de staff no puede pedir la liberacion con sobres -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select * from rentas.acceso_siguiente_liberacion_cifrada('{}', '2027-03-10 00:00:00+00') as should_fail;
rollback;

\echo '--- A22. anon no ejecuta ninguna de las funciones nuevas -- RECHAZADO ---'
begin;
set local role anon;
select * from rentas.acceso_instruccion_pendientes_cifrar(10) as should_fail;
rollback;

\echo '--- A23. la sesion de sistema ve la fila heredada pendiente de cifrar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as pendientes_deberia_ser_1 from rentas.acceso_instruccion_pendientes_cifrar(10);
rollback;

\echo '--- A24. barrido: el sistema aplica el sobre y el texto plano queda ANULADO en la misma sentencia ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_instruccion_aplicar_cifrado('00000000-0000-0000-0000-000000f29020', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBB', 'v1.CCCCCCCCCCCCCCCC.CCCCCCCCCCCCCCCCCCCCCC.CCCC', 1);
reset role;
select count(*) as sin_texto_plano_deberia_ser_1 from rentas.acceso_instruccion where unidad_id = '00000000-0000-0000-0000-000000f29020' and direccion_exacta is null and codigo_acceso is null and instrucciones is null and direccion_cifrada is not null and codigo_cifrado is not null and instrucciones_cifradas is not null and key_version = 1;
rollback;

\echo '--- A25. barrido idempotente: la segunda aplicacion no hace nada (devuelve false) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_instruccion_aplicar_cifrado('00000000-0000-0000-0000-000000f29020', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', null, null, 1);
select (not rentas.acceso_instruccion_aplicar_cifrado('00000000-0000-0000-0000-000000f29020', 'v1.DDDDDDDDDDDDDDDD.DDDDDDDDDDDDDDDDDDDDDD.DDDD', null, null, 1))::int as segunda_vez_deberia_ser_1;
rollback;

\echo '--- A26. barrido: queda UN evento cifrado_inicial en la bitacora, sin actor y sin contenido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_instruccion_aplicar_cifrado('00000000-0000-0000-0000-000000f29020', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', null, null, 1);
reset role;
select count(*) as evento_deberia_ser_1 from rentas.acceso_instruccion_bitacora where unidad_id = '00000000-0000-0000-0000-000000f29020' and evento = 'cifrado_inicial' and actor_id is null;
rollback;

\echo '--- A27. barrido: sin sobre de direccion -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_instruccion_aplicar_cifrado('00000000-0000-0000-0000-000000f29020', null, null, null, 1) as should_fail;
rollback;

\echo '--- A28. liberacion al huesped ANTES del barrido: entrega el texto heredado y ningun sobre ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (tiene_instrucciones and direccion_exacta like 'Calle 60%' and codigo_acceso = '4821' and direccion_cifrada is null)::int as heredada_deberia_ser_1
from rentas.acceso_siguiente_liberacion_cifrada('{}', '2027-03-10 00:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-000000f29050';
rollback;

\echo '--- A29. liberacion al huesped DESPUES del barrido: entrega los sobres y NINGUN texto plano ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_instruccion_aplicar_cifrado('00000000-0000-0000-0000-000000f29020', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBB', null, 1);
select (tiene_instrucciones and direccion_exacta is null and codigo_acceso is null and direccion_cifrada is not null and codigo_cifrado is not null and key_version = 1)::int as sobres_deberia_ser_1
from rentas.acceso_siguiente_liberacion_cifrada('{}', '2027-03-10 00:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-000000f29050';
rollback;

\echo '--- A30. la ventana la sigue decidiendo la base: fuera de la ventana no hay liberacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as fuera_de_ventana_deberia_ser_0 from rentas.acceso_siguiente_liberacion_cifrada('{}', '2027-03-01 00:00:00+00');
rollback;

\echo '--- A31. romper-cristal: el lector de reservas SI devuelve datos con sesion vigente (la prueba de abajo no es vacua) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29033', true);
select count(*) as reservas_visibles_deberia_ser_1 from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-000000f29033', '00000000-0000-0000-0000-000000f29001', null, 50, 0);
rollback;

\echo '--- A32. romper-cristal: NINGUNO de los 7 lectores devuelve la direccion, el codigo ni un sobre (con la unidad ya cifrada) ---'
begin;
select rentas.acceso_instruccion_aplicar_cifrado('00000000-0000-0000-0000-000000f29020', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.BBBB', null, 1);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29033', true);
select count(*) as campos_de_acceso_filtrados_deberia_ser_0 from (
  select to_jsonb(t)::text as j from rentas.list_reservas_for_break_glass('00000000-0000-0000-0000-000000f29033', '00000000-0000-0000-0000-000000f29001', null, 50, 0) t
  union all select to_jsonb(t)::text from rentas.list_finanzas_for_break_glass('00000000-0000-0000-0000-000000f29033', '00000000-0000-0000-0000-000000f29001', null, 50, 0) t
  union all select to_jsonb(t)::text from rentas.list_payouts_for_break_glass('00000000-0000-0000-0000-000000f29033', '00000000-0000-0000-0000-000000f29001', null, 50, 0) t
  union all select to_jsonb(t)::text from rentas.list_pricing_for_break_glass('00000000-0000-0000-0000-000000f29033', '00000000-0000-0000-0000-000000f29001', null, 50, 0) t
  union all select to_jsonb(t)::text from rentas.list_mensajeria_for_break_glass('00000000-0000-0000-0000-000000f29033', '00000000-0000-0000-0000-000000f29001', null, 50, 0) t
  union all select to_jsonb(t)::text from rentas.list_limpieza_for_break_glass('00000000-0000-0000-0000-000000f29033', '00000000-0000-0000-0000-000000f29001', null, 50, 0) t
  union all select to_jsonb(t)::text from rentas.list_sync_ical_for_break_glass('00000000-0000-0000-0000-000000f29033', '00000000-0000-0000-0000-000000f29001', null, 50, 0) t
) x where j ilike '%Calle 60%' or j like '%4821%' or j like '%v1.AAAA%' or j ilike '%direccion%' or j ilike '%codigo_acceso%' or j ilike '%cifrad%';
rollback;
