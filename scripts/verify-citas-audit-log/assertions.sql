-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales --
-- no el repositorio en memoria de domain-citas, que nunca aplica ninguno de los
-- dos), que packages/domain-citas/migrations/023_citas_audit_log.sql cierra
-- exactamente lo que dice cerrar. Mismo patrón EXACTO que
-- scripts/verify-restaurantes-audit-log/assertions.sql (leído primero como
-- plantilla), adaptado a que CITAS_ROLES (domain-citas/src/roles.ts) es
-- owner/admin/staff -- SIN un rol disjunto de más bajo privilegio como
-- "repartidor" (restaurantes sí lo tiene). El escenario "rol insuficiente" de
-- abajo (4) usa por eso un `vertical_role` FUERA del catálogo completo de
-- CITAS_ROLES (`'repartidor'`, nombre de rol genérico ya usado en otras
-- verticales de este mismo `core.membership` -- nunca inventado) para demostrar
-- que `citas.record_audit_log` valida el ROL de verdad (no solo membership), y
-- no confía en que el resto del código de citas nunca vaya a producir esa fila:
--
--   1. `citas.record_audit_log` (security definer) SIEMPRE toma el actor de
--      `auth.uid()`, nunca de un parámetro -- sin sesión autenticada (`auth.uid()`
--      NULL, la sesión de sistema), la función RECHAZA en vez de insertar un actor
--      NULL.
--   2. Rol suficiente (nace validado desde el día uno): SOLO owner/admin/staff
--      (CITAS_ROLES completo) pueden escribir -- un membership con un
--      `vertical_role` fuera de ese catálogo es RECHAZADO, aunque pertenezca a
--      esa misma organización.
--   3. Cross-tenant: un actor autenticado real que NO pertenece a la organización
--      que intenta auditar es RECHAZADO por la función (nunca puede sembrar una fila
--      de auditoría falsa en la bitácora de un tenant ajeno, aunque `security
--      definer` bypasse RLS).
--   4. Lectura: SOLO owner/admin de la ORGANIZACIÓN ven su propia bitácora -- un
--      "staff" real (SÍ puede escribir, CITAS_ROLES completo) NO puede leer, y un
--      owner/admin de OTRA organización no ve nada de esta.
--   5. `anon` está rechazado por completo, tanto en lectura como en la función de
--      escritura (sin ningún GRANT).
--   6. `citas.audit_log` es append-only de verdad: ni UPDATE ni DELETE están
--      permitidos, para NINGÚN rol (ni siquiera el superusuario que corre este
--      script) -- los triggers de bloqueo lo impiden incondicionalmente.
--   7. `authenticated` no puede insertar directo en la tabla saltándose la función
--      (sin policy de INSERT, deny-by-default real).
--   8. El catálogo cerrado de `entity_type` rechaza un valor fuera de la lista.
--   9. Un `campo`/`antes`/`despues` de más de 200/500/500 caracteres NUNCA viola el
--      CHECK de longitud de la tabla -- la función trunca con `left()` antes del
--      INSERT.
--  10. Orden TOTAL determinista dentro de UNA transacción y paginación por offset
--      ESTABLE sobre ese empate (`seq` ya vive en la migración 023 -- nunca hace
--      falta una segunda migración para esto).
--  11. Esquema de PRODUCCIÓN a medio migrar (023 no aplicada -- "REGLA DURA DE
--      COMPATIBILIDAD CON LA BASE SIN MIGRAR" del AGENTS.md de esta fase): el SQL
--      REAL de las dos sentencias que `PostgresCitasRepository` emite (`select
--      citas.record_audit_log(...)` en `registrarAuditoria`, el SELECT de datos en
--      `listAuditoria`) contra Postgres REAL, con la función/tabla eliminada DENTRO
--      de la misma transacción (DDL transaccional, revertido al final -- mismo
--      patrón que scripts/verify-restaurantes-audit-log/assertions.sql escenarios
--      23/24), recuperado con el mismo SAVEPOINT/ROLLBACK TO SAVEPOINT real que
--      `runWithSavepointFallback` (@atiende/db) usa en producción -- no solo el
--      doble en memoria (`AbortAwareFakeSession`) de
--      packages/domain-citas/tests/audit-log-savepoint.spec.ts.
--
-- Run vía ./run.sh -- ver ese archivo para cómo se levanta el Postgres efímero + el
-- mock mínimo de plataforma.
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto persiste
-- (salvo las fixtures de arriba, insertadas directo como el superusuario que corre
-- el script, igual que el resto de scripts/verify-*/).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000c1', 'citas', 'Org A (citas)', 'org-a-citas-bitacora'),
  ('00000000-0000-0000-0000-0000000000c2', 'citas', 'Org B (citas, ajena)', 'org-b-citas-bitacora')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000031', 'owner-org-a@example.com', 'Owner Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000032', 'admin-org-a@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000033', 'staff-org-a@example.com', 'Staff Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000034', 'rol-insuficiente-org-a@example.com', 'Rol insuficiente Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000035', 'owner-org-b@example.com', 'Owner Org B (ajeno)', 'seed')
on conflict do nothing;

-- staff 31: owner real de la Org A (lee Y escribe). staff 32: admin real de la Org A
-- (lee Y escribe -- prueba que "solo owner/admin" de verdad incluye a ambos, no solo
-- a owner). staff 33: staff real de la Org A (SÍ escribe, CITAS_ROLES completo, pero
-- NO lee -- el gate de lectura es más angosto). staff 34: membership REAL de la
-- Org A con un `vertical_role` FUERA del catálogo completo de CITAS_ROLES (NI
-- escribe NI lee -- rol insuficiente para ambas cosas, ver comentario de cabecera).
-- staff 35: owner real, pero de la Org B -- el actor "cross-tenant" que intenta
-- tocar la bitácora de la Org A.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-0000000000c1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-0000000000c1', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-0000000000c1', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000034', '00000000-0000-0000-0000-0000000000c1', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-000000000035', '00000000-0000-0000-0000-0000000000c2', null, 'owner', 'owner')
on conflict do nothing;

-- Fixture persistente para los escenarios de LECTURA/append-only de abajo --
-- INSERT directo (nunca vía `citas.record_audit_log`: esa función EXIGE
-- `auth.uid()` no nulo, y esta conexión de fixtures -- igual que el resto de
-- scripts/verify-*/ -- corre como el superusuario sin ninguna sesión de staff
-- simulada).
insert into citas.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000031', 'cita.cancelada_por_staff', 'cita', '00000000-0000-0000-0000-0000000000e1', 'status', 'confirmed', 'cancelled');

\echo ''
\echo '=== 1) escritura positiva: owner real de la Org A audita su propia organizacion ==='
\echo ''

\echo '--- 1. owner de la Org A escribe una fila real (actor SIEMPRE de auth.uid(), nunca del parametro) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select citas.record_audit_log(
  '00000000-0000-0000-0000-0000000000c1',
  'servicio.tarifa_actualizada',
  'servicio',
  '00000000-0000-0000-0000-0000000000d1',
  'priceCents',
  '35000',
  '40000'
) as nuevo_id;
rollback;

\echo '--- 2. actor real: la fila que la funcion ACABA de insertar (dentro del mismo begin) tiene actor_user_id = auth.uid() -- nunca depende de leer una fixture externa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select citas.record_audit_log(
  '00000000-0000-0000-0000-0000000000c1',
  'servicio.tarifa_actualizada',
  'servicio',
  '00000000-0000-0000-0000-0000000000d2',
  'priceCents',
  '35000',
  '42000'
) as nuevo_id;
select (actor_user_id = auth.uid())::int as actor_correcto_deberia_ser_1
from citas.audit_log where entity_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo ''
\echo '=== 2) rol suficiente (CITAS_ROLES completo, no solo owner/admin) ==='
\echo ''

\echo '--- 3. staff real (CITAS_ROLES completo, no solo owner/admin) SI puede escribir ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'configuracion.horario_creado', 'configuracion', null, null, null, 'lun 09:00-17:00') as nuevo_id;
rollback;

\echo '--- 4. membership REAL en la Org A pero con vertical_role FUERA del catalogo completo de CITAS_ROLES -- RECHAZADO, aunque pertenezca a la organizacion (defensa en profundidad de la funcion, no del codigo TypeScript) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000034', true);
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'cita.cancelada_por_staff', 'cita', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 3) negativo: sin actor autenticado (sesion de sistema) ==='
\echo ''

\echo '--- 5. auth.uid() NULL (sesion de sistema) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 4) cross-tenant: un actor real, pero de OTRA organizacion ==='
\echo ''

\echo '--- 6. owner de la Org B intenta auditar a nombre de la Org A -- RECHAZADO (no pertenece a esa organizacion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000035', true);
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'intento cross-tenant') as should_fail;
rollback;

\echo '--- 7. owner de la Org B SI puede auditar su propia organizacion (el rechazo de arriba es real, no un bloqueo general de la funcion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000035', true);
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c2', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'auditoria real de su propia org') as nuevo_id;
rollback;

\echo '--- 8. owner de la Org B nunca VE la bitacora de la Org A (RLS de lectura, silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000035', true);
select count(*) as filas_visibles_deberia_ser_0 from citas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo ''
\echo '=== 5) lectura: solo owner/admin, incluso staff real de la MISMA organizacion queda fuera ==='
\echo ''

\echo '--- 9. owner de la Org A SI lee su propia bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
-- Exactamente 1: la única fixture sembrada para la Org A -- ningún otro escenario de
-- este archivo persiste una fila real fuera de un begin/rollback.
select count(*) as filas_visibles_deberia_ser_1 from citas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '--- 10. admin de la Org A tambien lee (no solo owner) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
select count(*) as filas_visibles_deberia_ser_1 from citas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '--- 11. staff real de la Org A (SI puede ESCRIBIR, CITAS_ROLES completo) NO puede LEER -- 0 filas, nunca un error ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select count(*) as filas_visibles_deberia_ser_0 from citas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo ''
\echo '=== 6) anon: rechazado por completo, lectura y escritura ==='
\echo ''

\echo '--- 12. anon no puede LEER la bitacora (sin GRANT SELECT) ---'
begin;
set local role anon;
select count(*) as should_fail from citas.audit_log;
rollback;

\echo '--- 13. anon no puede EJECUTAR citas.record_audit_log (sin GRANT EXECUTE) ---'
begin;
set local role anon;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'x', 'servicio', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 7) append-only real: UPDATE/DELETE rechazados incondicionalmente ==='
\echo ''

\echo '--- 14. UPDATE sobre una fila real -- RECHAZADO por el trigger, incluso corriendo como el propio superusuario (no depende del rol) ---'
begin;
-- as should_fail (el trigger de bloqueo, no un alias -- UPDATE no admite `as` sobre
-- la sentencia completa; este comentario, DENTRO del bloque begin;/rollback;, es lo
-- que el runner automático detecta para marcar el escenario como "debe terminar en
-- ERROR").
update citas.audit_log set action = 'manipulado' where entity_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 15. DELETE sobre una fila real -- RECHAZADO por el trigger, mismo criterio que el UPDATE de arriba ---'
begin;
-- as should_fail (ver nota del escenario 14 -- mismo motivo, DELETE tampoco admite
-- `as` sobre la sentencia completa).
delete from citas.audit_log where entity_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 16. authenticated tampoco puede UPDATE/DELETE (doble barrera: ni GRANT ni trigger lo permiten) ---'
begin;
-- as should_fail (ver nota del escenario 14).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
update citas.audit_log set action = 'manipulado' where entity_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo ''
\echo '=== 8) authenticated no puede saltarse la funcion e insertar directo en la tabla ==='
\echo ''

\echo '--- 17. INSERT directo (sin pasar por citas.record_audit_log) -- RECHAZADO, sin policy de INSERT para authenticated ---'
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario, dentro del bloque begin;/rollback;, es lo que el runner detecta).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
insert into citas.audit_log (organization_id, actor_user_id, action, entity_type) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000031', 'x', 'servicio');
rollback;

\echo ''
\echo '=== 9) catalogo cerrado de entity_type ==='
\echo ''

\echo '--- 18. un entity_type fuera del catalogo -- RECHAZADO por el CHECK, ni siquiera llega a intentar el INSERT real ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'x', 'tipo_inventado', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 10) truncamiento defensivo: campo/antes/despues largos nunca revientan el CHECK de longitud ==='
\echo ''

\echo '--- 19. un `despues` de 600 caracteres (mas de 500) NUNCA viola el CHECK -- la funcion trunca con left() antes del INSERT, la fila SIEMPRE se escribe ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select citas.record_audit_log(
  '00000000-0000-0000-0000-0000000000c1',
  'configuracion.tenant_actualizada',
  'configuracion',
  '00000000-0000-0000-0000-0000000000d3',
  'value',
  null,
  repeat('x', 600)
) as nuevo_id;
select char_length(despues) as despues_truncado_deberia_ser_500
from citas.audit_log where entity_id = '00000000-0000-0000-0000-0000000000d3';
rollback;

\echo ''
\echo '=== 11) orden TOTAL determinista dentro de UNA transaccion + paginacion estable (seq desde el dia uno) ==='
\echo ''
\echo 'Bug real que esto previene (ya corregido para rentas en el PR #173, r6): now()'
\echo '(created_at) es CONSTANTE dentro de una transaccion de Postgres -- varias filas'
\echo 'de bitacora escritas en la MISMA transaccion (una accion de staff que audita 2+'
\echo 'cambios, o un batch) quedarian con el MISMO created_at sin un desempate. Aqui'
\echo '`seq bigint generated always as identity` ya vive en la migracion 023 (nunca'
\echo 'hizo falta una segunda migracion): order by created_at desc, seq desc da un'
\echo 'orden TOTAL exacto desde el dia uno.'
\echo ''

-- Mismo criterio que restaurantes: la premisa (mismo created_at) y el orden exacto
-- se combinan en UN SOLO booleano con un UNICO alias `deberia_ser_N` -- el gate
-- automatico solo evalua el PRIMER alias `deberia_ser_N` de cada bloque.
\echo '--- 20. 5 filas de la MISMA transaccion (mismo created_at) -- el orden exacto por seq desc es siempre orden-5..orden-1 (premisa + orden combinados en un solo booleano) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'orden-1') as id_1;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'orden-2') as id_2;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'orden-3') as id_3;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'orden-4') as id_4;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'orden-5') as id_5;
select (
  (count(distinct created_at) = 1)
  and (array_agg(despues order by created_at desc, seq desc) = array['orden-5','orden-4','orden-3','orden-2','orden-1'])
)::int as un_solo_created_at_y_orden_total_exacto_deberia_ser_1
from citas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000c1' and despues like 'orden-%';
rollback;

\echo '--- 21. paginacion por offset ESTABLE sobre el mismo empate: 6 filas de la MISMA transaccion, 2 paginas de 3 -- la union es EXACTA, sin repetir ni perder ninguna fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'pag-1') as id_1;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'pag-2') as id_2;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'pag-3') as id_3;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'pag-4') as id_4;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'pag-5') as id_5;
select citas.record_audit_log('00000000-0000-0000-0000-0000000000c1', 'servicio.tarifa_actualizada', 'servicio', null, null, null, 'pag-6') as id_6;
-- Misma consulta EXACTA (dos veces, con LIMIT/OFFSET distintos) que
-- PostgresCitasRepository.listAuditoria arma para la pantalla de Auditoria -- si el
-- orden no fuera TOTAL, la segunda pagina podria repetir una fila de la primera (o
-- saltarse una) porque Postgres es libre de reordenar los empatados entre dos
-- ejecuciones del mismo plan.
with pagina_1 as (
  select despues from citas.audit_log
  where organization_id = '00000000-0000-0000-0000-0000000000c1' and despues like 'pag-%'
  order by created_at desc, seq desc limit 3 offset 0
), pagina_2 as (
  select despues from citas.audit_log
  where organization_id = '00000000-0000-0000-0000-0000000000c1' and despues like 'pag-%'
  order by created_at desc, seq desc limit 3 offset 3
)
select (
  (select array_agg(despues) from pagina_1) || (select array_agg(despues) from pagina_2)
  = array['pag-6','pag-5','pag-4','pag-3','pag-2','pag-1']
)::int as paginacion_sin_repetir_ni_perder_deberia_ser_1;
rollback;

\echo ''
\echo '=== 12) esquema de PRODUCCION a medio migrar (023 no aplicada): SQLSTATE real de Postgres para las DOS sentencias reales del repositorio, recuperado con SAVEPOINT real (no el doble en memoria de audit-log-savepoint.spec.ts) ==='
\echo ''

\echo '--- 22. escritura: con citas.record_audit_log ELIMINADA dentro de esta MISMA transaccion (drop transaccional, revertido al `rollback;` final), la llamada REAL que PostgresCitasRepository.registrarAuditoria emite (select citas.record_audit_log($1..$7)) falla con SQLSTATE 42883 -- SAVEPOINT + ROLLBACK TO SAVEPOINT (mismo mecanismo que runWithSavepointFallback en produccion) recupera la transaccion: la query siguiente, completamente ajena a la funcion eliminada, SI corre (nunca 25P02) ---'
begin;
drop function citas.record_audit_log(uuid, text, text, uuid, text, text, text);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
savepoint sp_verify_citas_audit_log_write;
do $$
declare
  v_state text;
  v_msg text;
begin
  begin
    -- Mismo texto SQL EXACTO (solo $1..$7 -> literales) que
    -- PostgresCitasRepository.registrarAuditoria emite realmente, ver
    -- packages/domain-citas/src/postgres-repository.ts.
    perform citas.record_audit_log(
      '00000000-0000-0000-0000-0000000000c1',
      'servicio.tarifa_actualizada',
      'servicio',
      null,
      null,
      null,
      'compat-base-sin-migrar'
    );
    raise exception 'se esperaba que la funcion eliminada hiciera fallar esta llamada con SQLSTATE 42883, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883 (undefined_function -- el mismo que packages/db/src/sql-errors.ts::UNDEFINED_FUNCTION_MESSAGE_RE exige), se obtuvo % con mensaje: %', v_state, v_msg;
    end if;
    if v_msg !~ '^function\s+\S+\(.*\)\s+does not exist' then
      raise exception 'se esperaba un mensaje con la forma "function ...(...) does not exist" (la misma que UNDEFINED_FUNCTION_MESSAGE_RE exige), se obtuvo: %', v_msg;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_citas_audit_log_write;
release savepoint sp_verify_citas_audit_log_write;
-- "la query siguiente debe funcionar": una consulta REAL, completamente ajena a la
-- funcion eliminada, en la MISMA transaccion -- prueba que ROLLBACK TO SAVEPOINT
-- deja la transaccion compartida REALMENTE utilizable (no abortada). Sin el
-- SAVEPOINT de arriba, esta consulta fallaria con 25P02 ("current transaction is
-- aborted, commands ignored until end of transaction block").
select 1 as transaccion_recuperada_tras_42883_deberia_ser_1;
rollback;

\echo '--- 23. lectura: con citas.audit_log ELIMINADA dentro de esta MISMA transaccion, el SELECT REAL de datos que PostgresCitasRepository.listAuditoria emite (mismas columnas, mismo order by created_at desc, seq desc) falla con SQLSTATE 42P01 -- SAVEPOINT + ROLLBACK TO SAVEPOINT recupera la transaccion: la query siguiente SI corre ---'
begin;
drop table citas.audit_log;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
savepoint sp_verify_citas_audit_log_read;
do $$
declare
  v_state text;
  v_msg text;
begin
  begin
    -- Mismo texto SQL EXACTO (mismas columnas, mismo order by/limit/offset) que
    -- PostgresCitasRepository.listAuditoria emite realmente para la pagina de
    -- datos de la pantalla de Auditoria (el `count(*)` previo del mismo método
    -- toca la misma tabla eliminada y fallaría igual; se usa el SELECT de datos
    -- por ser el que de verdad arma lo que ve el staff).
    perform id, actor_user_id, action, entity_type, entity_id, campo, antes, despues, created_at::text as created_at
    from citas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000c1'
    order by created_at desc, seq desc limit 50 offset 0;
    raise exception 'se esperaba que la tabla eliminada hiciera fallar este SELECT con SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01 (undefined_table), se obtuvo % con mensaje: %', v_state, v_msg;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_citas_audit_log_read;
release savepoint sp_verify_citas_audit_log_read;
-- Misma prueba que el escenario 22: la transaccion compartida sigue utilizable
-- tras el ROLLBACK TO SAVEPOINT, con una consulta ajena a la tabla eliminada.
select 1 as transaccion_recuperada_tras_42p01_deberia_ser_1;
rollback;
