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

\echo '--- A2b. un valor corto (1-2 caracteres) produce un sobre de 2-3 caracteres de texto cifrado y el CHECK lo ACEPTA ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_cifrada, codigo_cifrado, instrucciones_cifradas, key_version, updated_by)
values ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAA', 1, '00000000-0000-0000-0000-000000f29030');
select count(*) as sobres_cortos_aceptados_deberia_ser_1 from rentas.acceso_instruccion where unidad_id = '00000000-0000-0000-0000-000000f29022' and codigo_cifrado is not null and instrucciones_cifradas is not null;
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

\echo ''
\echo '=== C. Rn-07: solicitudes ARCO propias de rentas ==='
\echo ''

\echo '--- C1. el admin de la gestora registra una solicitud; los plazos los calcula la base (20 + 15 dias) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select out_creada::int as creada_deberia_ser_1 from rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'Titular Uno', 'titular1@example.com', 'Quiere copia de sus datos');
select count(*) as plazos_20_y_35_dias_deberia_ser_1 from rentas.arco_solicitud
 where respuesta_vence_en - recibida_en = interval '20 days' and ejecucion_vence_en - recibida_en = interval '35 days' and registrada_por = '00000000-0000-0000-0000-000000f29030';
select count(*) as evento_registrada_deberia_ser_1 from rentas.arco_evento where evento = 'registrada' and hacia_estado = 'recibida';
rollback;

\echo '--- C2. registrar dos veces el mismo contacto y derecho es idempotente (una sola abierta) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'Titular Uno', 'titular1@example.com');
select out_creada::int as segunda_no_crea_deberia_ser_0 from rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'acceso', 'telefono', 'Titular Uno', ' TITULAR1@example.com ');
select count(*) as una_sola_fila_deberia_ser_1 from rentas.arco_solicitud;
rollback;

\echo '--- C3. un rol que no es admin_gestora (contador) NO registra -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29031', true);
select * from rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'X', 'x@example.com') as should_fail;
rollback;

\echo '--- C4. el admin de OTRA organizacion NO registra en la Org A (cross-tenant) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29032', true);
select * from rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'X', 'x@example.com') as should_fail;
rollback;

\echo '--- C5. anon no lee, no escribe ni ejecuta -- RECHAZADO (tres intentos) ---'
begin;
set local role anon;
select * from rentas.arco_solicitud as should_fail;
rollback;
begin;
set local role anon;
select * from rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'X', 'x@example.com') as should_fail;
rollback;
begin;
set local role anon;
select * from rentas.arco_evento as should_fail;
rollback;

\echo '--- C6. cross-tenant en lectura: el admin A ve su solicitud, el admin B ve 0 ---'
begin;
insert into rentas.arco_solicitud (organization_id, derecho, canal, solicitante_nombre, solicitante_contacto, respuesta_vence_en, ejecucion_vence_en)
values ('00000000-0000-0000-0000-000000f29001', 'cancelacion', 'correo', 'Titular Dos', 'titular2@example.com', now() + interval '20 days', now() + interval '35 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select count(*) as admin_a_ve_1_deberia_ser_1 from rentas.arco_solicitud;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29032', true);
select count(*) as admin_b_ve_0_deberia_ser_0 from rentas.arco_solicitud;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29031', true);
select count(*) as contador_ve_0_deberia_ser_0 from rentas.arco_solicitud;
rollback;

\echo '--- C7. el staff NO escribe directo en la tabla (sin GRANT de escritura) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
insert into rentas.arco_solicitud (organization_id, derecho, canal, solicitante_nombre, solicitante_contacto, respuesta_vence_en, ejecucion_vence_en)
values ('00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'X', 'x@example.com', now(), now()) returning 1 as should_fail;
rollback;

\echo '--- C8. cambio de estado: recibida -> en_proceso -> resuelta; bitacora completa; resuelta es terminal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'rectificacion', 'presencial', 'Titular Tres', 'titular3@example.com');
select rentas.arco_cambiar_estado('00000000-0000-0000-0000-000000f29001', (select id from rentas.arco_solicitud limit 1), 'en_proceso', null) as paso_1;
select rentas.arco_cambiar_estado('00000000-0000-0000-0000-000000f29001', (select id from rentas.arco_solicitud limit 1), 'resuelta', 'Dato corregido') as paso_2;
select count(*) as cerrada_con_fecha_y_nota_deberia_ser_1 from rentas.arco_solicitud where estado = 'resuelta' and resuelta_en is not null and nota_resolucion = 'Dato corregido' and atendida_por = '00000000-0000-0000-0000-000000f29030';
select count(*) as tres_eventos_deberia_ser_3 from rentas.arco_evento;
rollback;

\echo '--- C9. una solicitud resuelta NO vuelve a cambiar de estado (55000) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'oposicion', 'correo', 'Titular Cuatro', 'titular4@example.com');
select rentas.arco_cambiar_estado('00000000-0000-0000-0000-000000f29001', (select id from rentas.arco_solicitud limit 1), 'resuelta', 'ok');
select rentas.arco_cambiar_estado('00000000-0000-0000-0000-000000f29001', (select id from rentas.arco_solicitud limit 1), 'en_proceso', null) as should_fail;
rollback;

\echo '--- C10. rechazar exige el motivo (22023) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'oposicion', 'correo', 'Titular Cinco', 'titular5@example.com');
select rentas.arco_cambiar_estado('00000000-0000-0000-0000-000000f29001', (select id from rentas.arco_solicitud limit 1), 'rechazada', null) as should_fail;
rollback;

\echo '--- C11. el admin B NO cambia el estado de una solicitud de la Org A (cross-tenant) -- RECHAZADO ---'
begin;
insert into rentas.arco_solicitud (id, organization_id, derecho, canal, solicitante_nombre, solicitante_contacto, respuesta_vence_en, ejecucion_vence_en)
values ('00000000-0000-0000-0000-000000f29070', '00000000-0000-0000-0000-000000f29001', 'cancelacion', 'correo', 'Titular Dos', 'titular2@example.com', now() + interval '20 days', now() + interval '35 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29032', true);
select rentas.arco_cambiar_estado('00000000-0000-0000-0000-000000f29002', '00000000-0000-0000-0000-000000f29070', 'en_proceso', null) as should_fail;
rollback;

\echo '--- C12. la bitacora ARCO es append-only (UPDATE y DELETE bloqueados incluso para el dueno) -- RECHAZADO ---'
begin;
insert into rentas.arco_solicitud (id, organization_id, derecho, canal, solicitante_nombre, solicitante_contacto, respuesta_vence_en, ejecucion_vence_en)
values ('00000000-0000-0000-0000-000000f29071', '00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'T', 't@example.com', now() + interval '20 days', now() + interval '35 days');
insert into rentas.arco_evento (organization_id, solicitud_id, evento, hacia_estado) values ('00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29071', 'registrada', 'recibida');
update rentas.arco_evento set nota = 'reescrita' returning 1 as should_fail;
rollback;
begin;
insert into rentas.arco_solicitud (id, organization_id, derecho, canal, solicitante_nombre, solicitante_contacto, respuesta_vence_en, ejecucion_vence_en)
values ('00000000-0000-0000-0000-000000f29071', '00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'T', 't@example.com', now() + interval '20 days', now() + interval '35 days');
insert into rentas.arco_evento (organization_id, solicitud_id, evento, hacia_estado) values ('00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29071', 'registrada', 'recibida');
delete from rentas.arco_evento returning 1 as should_fail;
rollback;

\echo '--- C13. la fecha de recepcion no puede ser futura ni anterior a 60 dias (22023) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select * from rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'X', 'x@example.com', null, now() - interval '61 days') as should_fail;
rollback;

\echo '--- C14. core._arco_union() incluye rentas con estado normalizado, sin datos del titular; la vencida se marca ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select rentas.arco_registrar('00000000-0000-0000-0000-000000f29001', 'acceso', 'correo', 'Titular Seis', 'titular6@example.com', null, now() - interval '50 days');
select count(*) as visible_en_la_vista_de_org_deberia_ser_1 from core.org_list_arco_requests('00000000-0000-0000-0000-000000f29001', true, 50, 0)
 where out_vertical = 'rentas' and out_status_bucket = 'abierta' and out_native_status = 'recibida' and out_is_overdue;
select count(*) as admin_b_no_la_ve_deberia_ser_0 from core.org_list_arco_requests('00000000-0000-0000-0000-000000f29002', true, 50, 0) where out_vertical = 'rentas';
rollback;

\echo ''
\echo '=== B. Rn-30: retencion de plataforma de rentas ==='
\echo ''

\echo '--- B1. el catalogo trae las dos clases de rentas con ejecutor plataforma y defecto 90 dias ---'
select count(*) as clases_deberia_ser_2 from core.retention_class where vertical = 'rentas' and executor = 'plataforma' and default_days = 90 and min_days = 30 and max_days = 730;

\echo '--- B2. la plataforma lista los pares (org rentas, clase) a purgar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as pares_de_la_org_a_deberia_ser_2 from core.system_list_purge_targets(null, 50, '00000000-0000-0000-0000-000000f29001');
rollback;

\echo '--- B3. un staff autenticado NO dispara la purga (solo sistema) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f29030', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-000000f29001', 'rentas_huesped_pii', true, 10) as should_fail;
rollback;

\echo '--- B4. la funcion de purga del vertical NO es invocable por la aplicacion (authenticated ni anon) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f29001', 'rentas_huesped_pii', now(), true, 10) as should_fail;
rollback;
begin;
set local role anon;
select * from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f29001', 'rentas_huesped_pii', now(), true, 10) as should_fail;
rollback;

\echo '--- B5. huesped_pii: simulacion no toca nada; ejecucion anonimiza solo al vencido sin ARCO abierta ni estancia reciente ---'
begin;
insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto, created_at) values
  ('00000000-0000-0000-0000-000000f29081', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Viejo Vencido', 'vencido@example.com', '2025-01-01'),
  ('00000000-0000-0000-0000-000000f29082', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Viejo Con ARCO', 'conarco@example.com', '2025-01-01'),
  ('00000000-0000-0000-0000-000000f29083', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Reciente', 'reciente@example.com', now()),
  ('00000000-0000-0000-0000-000000f29084', '00000000-0000-0000-0000-000000f29002', '00000000-0000-0000-0000-000000f29011', 'Viejo De Otra Org', 'otraorg@example.com', '2025-01-01');
insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, huesped_minimo_id) values
  ('00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', '00000000-0000-0000-0000-000000f29022', daterange('2025-02-01', '2025-02-03', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, '00000000-0000-0000-0000-000000f29081');
insert into rentas.arco_solicitud (organization_id, derecho, canal, solicitante_nombre, solicitante_contacto, respuesta_vence_en, ejecucion_vence_en)
values ('00000000-0000-0000-0000-000000f29001', 'cancelacion', 'correo', 'Otro Nombre', 'ConArco@example.com', now() + interval '20 days', now() + interval '35 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'simulacion' and out_rows_affected = 1 and out_rows_protected = 1 and out_retention_days = 90)::int as simulacion_cuenta_1_y_protege_1_deberia_ser_1
  from core.system_run_retention_purge('00000000-0000-0000-0000-000000f29001', 'rentas_huesped_pii', true, 500);
reset role;
select count(*) as simulacion_no_toco_nada_deberia_ser_4 from rentas.guest_minimo where nombre is not null and id in ('00000000-0000-0000-0000-000000f29081','00000000-0000-0000-0000-000000f29082','00000000-0000-0000-0000-000000f29083','00000000-0000-0000-0000-000000f29084');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'ok' and out_rows_affected = 1 and out_rows_anonymized = 1 and out_rows_protected = 1)::int as ejecucion_anonimiza_1_deberia_ser_1
  from core.system_run_retention_purge('00000000-0000-0000-0000-000000f29001', 'rentas_huesped_pii', false, 500);
reset role;
select count(*) as vencido_anonimizado_deberia_ser_1 from rentas.guest_minimo where id = '00000000-0000-0000-0000-000000f29081' and nombre is null and contacto is null;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
select count(*) as con_arco_reciente_y_otra_org_intactos_deberia_ser_3 from rentas.guest_minimo where nombre is not null and id in ('00000000-0000-0000-0000-000000f29082','00000000-0000-0000-0000-000000f29083','00000000-0000-0000-0000-000000f29084');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
select count(*) as la_reserva_se_conserva_deberia_ser_1 from rentas.ocupacion where huesped_minimo_id = '00000000-0000-0000-0000-000000f29081';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
select count(*) as dos_corridas_registradas_sin_pii_deberia_ser_2 from core.purge_run_log where organization_id = '00000000-0000-0000-0000-000000f29001' and data_class = 'rentas_huesped_pii';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
rollback;

\echo '--- B6. un huesped con estancia futura NO se anonimiza aunque su fila sea vieja ---'
begin;
insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto, created_at) values
  ('00000000-0000-0000-0000-000000f29085', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Con Estancia Futura', 'futura@example.com', '2025-01-01');
insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, huesped_minimo_id) values
  ('00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', '00000000-0000-0000-0000-000000f29022', daterange('2027-06-01', '2027-06-03', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, '00000000-0000-0000-0000-000000f29085');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_rows_affected as nada_que_purgar_deberia_ser_0 from core.system_run_retention_purge('00000000-0000-0000-0000-000000f29001', 'rentas_huesped_pii', false, 500);
reset role;
select count(*) as sigue_intacto_deberia_ser_1 from rentas.guest_minimo where id = '00000000-0000-0000-0000-000000f29085' and nombre is not null;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
rollback;

\echo '--- B7. un bloqueo por retencion legal impide la purga y queda registrado ---'
begin;
insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto, created_at) values
  ('00000000-0000-0000-0000-000000f29081', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'Viejo Bloqueado', 'bloqueado@example.com', '2025-01-01');
insert into core.purge_hold (organization_id, data_class, reason, placed_by) values
  ('00000000-0000-0000-0000-000000f29001', 'rentas_huesped_pii', 'Retencion legal por requerimiento de autoridad (verificacion)', '00000000-0000-0000-0000-000000f29030');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'bloqueada' and out_rows_affected = 0)::int as bloqueada_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-000000f29001', 'rentas_huesped_pii', false, 500);
reset role;
select count(*) as sigue_intacto_deberia_ser_1 from rentas.guest_minimo where id = '00000000-0000-0000-0000-000000f29081' and nombre is not null;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
rollback;

\echo '--- B8. acceso_instrucciones: borra solo el sobre de la unidad sin reservas vigentes ni recientes y deja bitacora sin contenido ---'
begin;
-- Unidad A2 (f29022): sobre viejo y SIN reserva vigente (solo una pasada de 2025) -> elegible.
-- Unidad A1 (f29020): sobre viejo pero con reserva futura (2027) -> protegida.
-- Unidad B1 (f29021, Org B): sobre viejo pero otra organizacion -> intacta.
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_cifrada, key_version, updated_at) values
  ('00000000-0000-0000-0000-000000f29022', '00000000-0000-0000-0000-000000f29001', '00000000-0000-0000-0000-000000f29010', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 1, '2025-01-01'),
  ('00000000-0000-0000-0000-000000f29021', '00000000-0000-0000-0000-000000f29002', '00000000-0000-0000-0000-000000f29011', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', 1, '2025-01-01');
update rentas.acceso_instruccion set updated_at = '2025-01-01' where unidad_id = '00000000-0000-0000-0000-000000f29020';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'simulacion' and out_rows_affected = 1)::int as simulacion_cuenta_1_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-000000f29001', 'rentas_acceso_instrucciones', true, 500);
reset role;
select count(*) as simulacion_no_borro_deberia_ser_3 from rentas.acceso_instruccion;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'ok' and out_rows_affected = 1)::int as ejecucion_borra_1_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-000000f29001', 'rentas_acceso_instrucciones', false, 500);
reset role;
select count(*) as unidad_sin_reservas_borrada_deberia_ser_0 from rentas.acceso_instruccion where unidad_id = '00000000-0000-0000-0000-000000f29022';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
select count(*) as con_reserva_futura_y_otra_org_intactas_deberia_ser_2 from rentas.acceso_instruccion where unidad_id in ('00000000-0000-0000-0000-000000f29020', '00000000-0000-0000-0000-000000f29021');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
select count(*) as bitacora_purga_sin_contenido_deberia_ser_1 from rentas.acceso_instruccion_bitacora where evento = 'purga_retencion' and actor_id is null and unidad_id = '00000000-0000-0000-0000-000000f29022';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
rollback;
