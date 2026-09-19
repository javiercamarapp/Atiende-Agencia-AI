-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales --
-- no el repositorio en memoria de domain-rentas, que nunca aplica ninguno de los
-- dos), que packages/domain-rentas/migrations/021_rentas_audit_log.sql cierra
-- exactamente lo que dice cerrar:
--
--   1. `rentas.record_audit_log` (security definer) SIEMPRE toma el actor de
--      `auth.uid()`, nunca de un parámetro -- sin sesión autenticada (`auth.uid()`
--      NULL, la sesión de sistema), la función RECHAZA en vez de insertar un actor
--      NULL.
--   2. Cross-tenant: un actor autenticado real que NO pertenece a la organización
--      que intenta auditar es RECHAZADO por la función (nunca puede sembrar una fila
--      de auditoría falsa en la bitácora de un tenant ajeno, aunque `security
--      definer` bypasse RLS).
--   3. Lectura: SOLO `admin_gestora` de la ORGANIZACIÓN VE su propia bitácora -- un
--      miembro real de la misma organización SIN ese rol ve RLS filtrar en silencio
--      (0 filas, nunca un error), y un `admin_gestora` de OTRA organización tampoco
--      ve nada de esta.
--   4. `anon` está rechazado por completo, tanto en lectura como en la función de
--      escritura (sin ningún GRANT).
--   5. `rentas.audit_log` es append-only de verdad: ni UPDATE ni DELETE están
--      permitidos, para NINGÚN rol (ni siquiera el superusuario que corre este
--      script) -- los triggers de bloqueo lo impiden incondicionalmente.
--   6. `authenticated` no puede insertar directo en la tabla saltándose la función
--      (sin policy de INSERT, deny-by-default real).
--   7. El catálogo cerrado de `entity_type` rechaza un valor fuera de la lista.
--   8. Un `campo`/`antes`/`despues` de más de 200/500/500 caracteres NUNCA viola el
--      CHECK de longitud de la tabla -- la función trunca con `left()` antes del
--      INSERT (corrección de revisión r5: un `motivoVersion` largo de un owner
--      statement hacía que la fila se perdiera en silencio, ver el comentario de
--      cabecera de `rentas.record_audit_log`).
--
-- Run vía ./run.sh -- ver ese archivo para cómo se levanta el Postgres efímero + el
-- mock mínimo de plataforma (mismo patrón que scripts/verify-outbox-grants/).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto persiste
-- (salvo las fixtures de arriba, insertadas directo como el superusuario que corre
-- el script, igual que el resto de scripts/verify-*/).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (rentas)', 'org-a-rentas-bitacora'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (rentas, ajena)', 'org-b-rentas-bitacora')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'admin-org-a@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000012', 'operador-org-a@example.com', 'Operador Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000013', 'admin-org-b@example.com', 'Admin Org B (ajeno)', 'seed')
on conflict do nothing;

-- staff 11: admin_gestora real de la Org A (el único rol con acceso de lectura a la
-- bitácora). staff 12: staff REAL de la Org A, pero SIN el rol admin_gestora (el
-- escenario "staff sin rol admin no lee"). staff 13: admin_gestora real, pero de la
-- Org B -- el actor "cross-tenant" que intenta tocar la bitácora de la Org A.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:acceso_total'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-0000000000a2', null, 'admin', 'admin_gestora')
on conflict do nothing;

-- Fixture persistente para los escenarios de LECTURA/append-only de abajo --
-- INSERT directo (nunca vía `rentas.record_audit_log`: esa función EXIGE
-- `auth.uid()` no nulo, y esta conexión de fixtures -- igual que el resto de
-- scripts/verify-*/ -- corre como el superusuario sin ninguna sesión de staff
-- simulada). El superusuario es dueño de la tabla -- ni RLS ni GRANT le aplican --
-- así que puede sembrar la fila con el actor que la prueba necesita sin pasar por
-- la función, exactamente como el resto de fixtures de este archivo se siembran
-- directo contra `core.organization`/`core.staff_user`/`core.membership`.
insert into rentas.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000011', 'reserva.cancelada', 'reserva', '00000000-0000-0000-0000-0000000000d1', 'estado', 'confirmado', 'cancelado');

\echo ''
\echo '=== 1) escritura positiva: admin_gestora real de la Org A audita su propia organización ==='
\echo ''

\echo '--- 1. admin_gestora de la Org A escribe una fila real (actor SIEMPRE de auth.uid(), nunca del parámetro) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.record_audit_log(
  '00000000-0000-0000-0000-0000000000a1',
  'pricing.tarifa_base.actualizada',
  'pricing',
  '00000000-0000-0000-0000-0000000000c1',
  'precio_noche_centavos',
  null,
  '200000 MXN desde 2026-06-01'
) as nuevo_id;
rollback;

-- Corrección de revisión r5 (no bloqueante #6): el escenario 2 original leía la
-- fixture de arriba (sembrada por el SUPERUSUARIO con un `actor_user_id` fijo,
-- fuera de cualquier begin/rollback) -- eso es tautológico, nunca demuestra que
-- `rentas.record_audit_log` tome el actor de `auth.uid()`; esa propiedad la
-- garantiza únicamente la FIRMA de la función (no acepta ningún parámetro de
-- actor), no un dato que el propio script insertó a mano. Además, al vivir fuera
-- de un `begin;.../rollback;`, `scripts/verify-real-postgres-ci/run-gate.mjs` ni
-- siquiera lo contaba como escenario (de ahí el "14/14" pese a documentar 15).
--
-- Este reemplazo SÍ demuestra la propiedad con una llamada real: dentro del MISMO
-- begin, invoca la función autenticado como el staff 11 y confirma que la fila
-- que ACABA de insertar tiene `actor_user_id = auth.uid()` -- nunca lee una
-- fixture ajena.
\echo '--- 2. actor real: la fila que la función ACABA de insertar (dentro del mismo begin) tiene actor_user_id = auth.uid() -- nunca depende de leer una fixture externa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.record_audit_log(
  '00000000-0000-0000-0000-0000000000a1',
  'pricing.tarifa_base.actualizada',
  'pricing',
  '00000000-0000-0000-0000-0000000000c2',
  'precio_noche_centavos',
  null,
  '180000 MXN desde 2026-09-01'
) as nuevo_id;
select (actor_user_id = auth.uid())::int as actor_correcto_deberia_ser_1
from rentas.audit_log where entity_id = '00000000-0000-0000-0000-0000000000c2';
rollback;

\echo ''
\echo '=== 2) negativo: sin actor autenticado (sesion de sistema) ==='
\echo ''

\echo '--- 3. auth.uid() NULL (sesion de sistema, MISMA sesion que usan los crons) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'pricing.tarifa_base.actualizada', 'pricing', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 3) cross-tenant: un actor real, pero de OTRA organizacion ==='
\echo ''

\echo '--- 4. admin_gestora de la Org B intenta auditar a nombre de la Org A -- RECHAZADO (no pertenece a esa organizacion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'payout.registrado', 'payout', null, null, null, 'intento cross-tenant') as should_fail;
rollback;

\echo '--- 5. admin_gestora de la Org B SI puede auditar su propia organizacion (el rechazo de arriba es real, no un bloqueo general de la funcion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a2', 'payout.registrado', 'payout', null, null, null, 'auditoria real de su propia org') as nuevo_id;
rollback;

\echo '--- 6. admin_gestora de la Org B nunca VE la bitacora de la Org A (RLS de lectura, silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(*) as filas_visibles_deberia_ser_0 from rentas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000a1';
rollback;

\echo ''
\echo '=== 4) staff real de la MISMA organizacion, pero SIN el rol admin_gestora ==='
\echo ''

\echo '--- 7. staff con membership real en la Org A pero rol operador:acceso_total (no admin_gestora) NO lee la bitacora -- 0 filas, nunca un error ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select count(*) as filas_visibles_deberia_ser_0 from rentas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000a1';
rollback;

\echo '--- 8. admin_gestora de la Org A SI lee su propia bitacora (el 0 de arriba es del rol, no de la organizacion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
-- Exactamente 1: la única fixture sembrada para la Org A -- ningún otro escenario de
-- este archivo persiste una fila real fuera de un begin/rollback.
select count(*) as filas_visibles_deberia_ser_1 from rentas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000a1';
rollback;

\echo ''
\echo '=== 5) anon: rechazado por completo, lectura y escritura ==='
\echo ''

\echo '--- 9. anon no puede LEER la bitacora (sin GRANT SELECT) ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.audit_log;
rollback;

\echo '--- 10. anon no puede EJECUTAR rentas.record_audit_log (sin GRANT EXECUTE) ---'
begin;
set local role anon;
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'x', 'pricing', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 6) append-only real: UPDATE/DELETE rechazados incondicionalmente ==='
\echo ''

\echo '--- 11. UPDATE sobre una fila real -- RECHAZADO por el trigger, incluso corriendo como el propio superusuario (no depende del rol) ---'
begin;
-- as should_fail (el trigger de bloqueo, no un alias -- UPDATE no admite `as` sobre
-- la sentencia completa; este comentario, DENTRO del bloque begin;/rollback;, es lo
-- que el runner automático detecta para marcar el escenario como "debe terminar en
-- ERROR", mismo criterio que scripts/verify-rentas-break-glass/assertions.sql
-- escenarios 20/21).
update rentas.audit_log set action = 'manipulado' where entity_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 12. DELETE sobre una fila real -- RECHAZADO por el trigger, mismo criterio que el UPDATE de arriba ---'
begin;
-- as should_fail (ver nota del escenario 11 -- mismo motivo, DELETE tampoco admite
-- `as` sobre la sentencia completa).
delete from rentas.audit_log where entity_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 13. authenticated tampoco puede UPDATE/DELETE (doble barrera: ni GRANT ni trigger lo permiten) ---'
begin;
-- as should_fail (ver nota del escenario 11).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.audit_log set action = 'manipulado' where entity_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo ''
\echo '=== 7) authenticated no puede saltarse la funcion e insertar directo en la tabla ==='
\echo ''

\echo '--- 14. INSERT directo (sin pasar por rentas.record_audit_log) -- RECHAZADO, sin policy de INSERT para authenticated ---'
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario, dentro del bloque begin;/rollback;, es lo que el runner detecta).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.audit_log (organization_id, actor_user_id, action, entity_type) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000011', 'x', 'pricing');
rollback;

\echo ''
\echo '=== 8) catalogo cerrado de entity_type ==='
\echo ''

\echo '--- 15. un entity_type fuera del catalogo -- RECHAZADO por el CHECK, ni siquiera llega a intentar el INSERT real ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'x', 'tipo_inventado', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 9) truncamiento defensivo: un motivoVersion largo nunca revienta el CHECK de longitud (corrección de revisión r5) ==='
\echo ''

\echo '--- 16. un `despues` de 600 caracteres (más de 500) NUNCA viola el CHECK -- la función trunca con left() antes del INSERT, la fila SIEMPRE se escribe ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.record_audit_log(
  '00000000-0000-0000-0000-0000000000a1',
  'owner_statement.nueva_version',
  'owner_statement',
  '00000000-0000-0000-0000-0000000000c3',
  'version',
  null,
  repeat('x', 600)
) as nuevo_id;
select char_length(despues) as despues_truncado_deberia_ser_500
from rentas.audit_log where entity_id = '00000000-0000-0000-0000-0000000000c3';
rollback;
