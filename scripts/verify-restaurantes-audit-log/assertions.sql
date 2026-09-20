-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales --
-- no el repositorio en memoria de domain-restaurantes, que nunca aplica ninguno de
-- los dos), que packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql
-- cierra exactamente lo que dice cerrar:
--
--   1. `restaurantes.record_audit_log` (security definer) SIEMPRE toma el actor de
--      `auth.uid()`, nunca de un parámetro -- sin sesión autenticada (`auth.uid()`
--      NULL, la sesión de sistema), la función RECHAZA en vez de insertar un actor
--      NULL.
--   2. Rol suficiente (nace validado desde el día uno, a diferencia de
--      rentas.record_audit_log): SOLO owner/admin/staff (MANAGER_ROLES) pueden
--      escribir -- un "repartidor" con membership REAL en la organización es
--      RECHAZADO, aunque pertenezca a esa misma organización.
--   3. Cross-tenant: un actor autenticado real que NO pertenece a la organización
--      que intenta auditar es RECHAZADO por la función (nunca puede sembrar una fila
--      de auditoría falsa en la bitácora de un tenant ajeno, aunque `security
--      definer` bypasse RLS).
--   4. Lectura: SOLO owner/admin de la ORGANIZACIÓN ven su propia bitácora -- un
--      "staff" real (SÍ puede escribir, MANAGER_ROLES) NO puede leer, un
--      "repartidor" tampoco, y un owner/admin de OTRA organización no ve nada de
--      esta.
--   5. `anon` está rechazado por completo, tanto en lectura como en la función de
--      escritura (sin ningún GRANT).
--   6. `restaurantes.audit_log` es append-only de verdad: ni UPDATE ni DELETE están
--      permitidos, para NINGÚN rol (ni siquiera el superusuario que corre este
--      script) -- los triggers de bloqueo lo impiden incondicionalmente.
--   7. `authenticated` no puede insertar directo en la tabla saltándose la función
--      (sin policy de INSERT, deny-by-default real).
--   8. El catálogo cerrado de `entity_type` rechaza un valor fuera de la lista.
--   9. Un `campo`/`antes`/`despues` de más de 200/500/500 caracteres NUNCA viola el
--      CHECK de longitud de la tabla -- la función trunca con `left()` antes del
--      INSERT (desde el día uno, ver el comentario de cabecera de
--      `restaurantes.record_audit_log`).
--  10. Orden TOTAL determinista dentro de UNA transacción y paginación por offset
--      ESTABLE sobre ese empate (`seq` ya vive en la migración 019 -- a diferencia
--      de rentas, nunca hace falta una segunda migración para esto).
--
-- Run vía ./run.sh -- ver ese archivo para cómo se levanta el Postgres efímero + el
-- mock mínimo de plataforma (mismo patrón que scripts/verify-rentas-bitacora-auditoria/).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto persiste
-- (salvo las fixtures de arriba, insertadas directo como el superusuario que corre
-- el script, igual que el resto de scripts/verify-*/).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000b1', 'restaurantes', 'Org A (restaurantes)', 'org-a-restaurantes-bitacora'),
  ('00000000-0000-0000-0000-0000000000b2', 'restaurantes', 'Org B (restaurantes, ajena)', 'org-b-restaurantes-bitacora')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000021', 'owner-org-a@example.com', 'Owner Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000022', 'admin-org-a@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000023', 'staff-org-a@example.com', 'Staff Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000024', 'repartidor-org-a@example.com', 'Repartidor Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000025', 'owner-org-b@example.com', 'Owner Org B (ajeno)', 'seed')
on conflict do nothing;

-- staff 21: owner real de la Org A (lee Y escribe). staff 22: admin real de la Org A
-- (lee Y escribe -- prueba que "solo owner/admin" de verdad incluye a ambos, no solo
-- a owner). staff 23: staff real de la Org A (SÍ escribe, MANAGER_ROLES, pero NO
-- lee -- el gate de lectura es más angosto). staff 24: repartidor real de la Org A
-- (NI escribe NI lee -- rol insuficiente para ambas cosas). staff 25: owner real,
-- pero de la Org B -- el actor "cross-tenant" que intenta tocar la bitácora de la
-- Org A.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-0000000000b1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-0000000000b1', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-0000000000b1', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000024', '00000000-0000-0000-0000-0000000000b1', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-000000000025', '00000000-0000-0000-0000-0000000000b2', null, 'owner', 'owner')
on conflict do nothing;

-- Fixture persistente para los escenarios de LECTURA/append-only de abajo --
-- INSERT directo (nunca vía `restaurantes.record_audit_log`: esa función EXIGE
-- `auth.uid()` no nulo, y esta conexión de fixtures -- igual que el resto de
-- scripts/verify-*/ -- corre como el superusuario sin ninguna sesión de staff
-- simulada).
insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000021', 'pedido.cancelado', 'pedido', '00000000-0000-0000-0000-0000000000e1', 'status', 'pending', 'cancelado');

\echo ''
\echo '=== 1) escritura positiva: owner real de la Org A audita su propia organizacion ==='
\echo ''

\echo '--- 1. owner de la Org A escribe una fila real (actor SIEMPRE de auth.uid(), nunca del parametro) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
select restaurantes.record_audit_log(
  '00000000-0000-0000-0000-0000000000b1',
  'producto.precio_actualizado',
  'producto',
  '00000000-0000-0000-0000-0000000000c1',
  'price',
  '35',
  '40'
) as nuevo_id;
rollback;

\echo '--- 2. actor real: la fila que la funcion ACABA de insertar (dentro del mismo begin) tiene actor_user_id = auth.uid() -- nunca depende de leer una fixture externa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
select restaurantes.record_audit_log(
  '00000000-0000-0000-0000-0000000000b1',
  'producto.precio_actualizado',
  'producto',
  '00000000-0000-0000-0000-0000000000c2',
  'price',
  '35',
  '42'
) as nuevo_id;
select (actor_user_id = auth.uid())::int as actor_correcto_deberia_ser_1
from restaurantes.audit_log where entity_id = '00000000-0000-0000-0000-0000000000c2';
rollback;

\echo ''
\echo '=== 2) rol suficiente (nace validado desde el dia uno, a diferencia de rentas) ==='
\echo ''

\echo '--- 3. staff real (MANAGER_ROLES, no solo owner/admin) SI puede escribir ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000023', true);
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'promocion.creada', 'promocion', null, null, null, 'BIENVENIDA10') as nuevo_id;
rollback;

\echo '--- 4. repartidor real (membership REAL en la Org A, pero rol insuficiente) -- RECHAZADO, aunque pertenezca a la organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000024', true);
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'pedido.cancelado', 'pedido', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 3) negativo: sin actor autenticado (sesion de sistema) ==='
\echo ''

\echo '--- 5. auth.uid() NULL (sesion de sistema) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 4) cross-tenant: un actor real, pero de OTRA organizacion ==='
\echo ''

\echo '--- 6. owner de la Org B intenta auditar a nombre de la Org A -- RECHAZADO (no pertenece a esa organizacion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000025', true);
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'intento cross-tenant') as should_fail;
rollback;

\echo '--- 7. owner de la Org B SI puede auditar su propia organizacion (el rechazo de arriba es real, no un bloqueo general de la funcion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000025', true);
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b2', 'producto.precio_actualizado', 'producto', null, null, null, 'auditoria real de su propia org') as nuevo_id;
rollback;

\echo '--- 8. owner de la Org B nunca VE la bitacora de la Org A (RLS de lectura, silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000025', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo ''
\echo '=== 5) lectura: solo owner/admin, incluso staff real de la MISMA organizacion queda fuera ==='
\echo ''

\echo '--- 9. owner de la Org A SI lee su propia bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
-- Exactamente 1: la única fixture sembrada para la Org A -- ningún otro escenario de
-- este archivo persiste una fila real fuera de un begin/rollback.
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 10. admin de la Org A tambien lee (no solo owner) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000022', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 11. staff real de la Org A (SI puede ESCRIBIR, MANAGER_ROLES) NO puede LEER -- 0 filas, nunca un error ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000023', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 12. repartidor real de la Org A tampoco lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000024', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo ''
\echo '=== 6) anon: rechazado por completo, lectura y escritura ==='
\echo ''

\echo '--- 13. anon no puede LEER la bitacora (sin GRANT SELECT) ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.audit_log;
rollback;

\echo '--- 14. anon no puede EJECUTAR restaurantes.record_audit_log (sin GRANT EXECUTE) ---'
begin;
set local role anon;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'x', 'producto', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 7) append-only real: UPDATE/DELETE rechazados incondicionalmente ==='
\echo ''

\echo '--- 15. UPDATE sobre una fila real -- RECHAZADO por el trigger, incluso corriendo como el propio superusuario (no depende del rol) ---'
begin;
-- as should_fail (el trigger de bloqueo, no un alias -- UPDATE no admite `as` sobre
-- la sentencia completa; este comentario, DENTRO del bloque begin;/rollback;, es lo
-- que el runner automático detecta para marcar el escenario como "debe terminar en
-- ERROR").
update restaurantes.audit_log set action = 'manipulado' where entity_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 16. DELETE sobre una fila real -- RECHAZADO por el trigger, mismo criterio que el UPDATE de arriba ---'
begin;
-- as should_fail (ver nota del escenario 15 -- mismo motivo, DELETE tampoco admite
-- `as` sobre la sentencia completa).
delete from restaurantes.audit_log where entity_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 17. authenticated tampoco puede UPDATE/DELETE (doble barrera: ni GRANT ni trigger lo permiten) ---'
begin;
-- as should_fail (ver nota del escenario 15).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
update restaurantes.audit_log set action = 'manipulado' where entity_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo ''
\echo '=== 8) authenticated no puede saltarse la funcion e insertar directo en la tabla ==='
\echo ''

\echo '--- 18. INSERT directo (sin pasar por restaurantes.record_audit_log) -- RECHAZADO, sin policy de INSERT para authenticated ---'
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario, dentro del bloque begin;/rollback;, es lo que el runner detecta).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000021', 'x', 'producto');
rollback;

\echo ''
\echo '=== 9) catalogo cerrado de entity_type ==='
\echo ''

\echo '--- 19. un entity_type fuera del catalogo -- RECHAZADO por el CHECK, ni siquiera llega a intentar el INSERT real ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'x', 'tipo_inventado', null, null, null, 'x') as should_fail;
rollback;

\echo ''
\echo '=== 10) truncamiento defensivo: campo/antes/despues largos nunca revientan el CHECK de longitud ==='
\echo ''

\echo '--- 20. un `despues` de 600 caracteres (mas de 500) NUNCA viola el CHECK -- la funcion trunca con left() antes del INSERT, la fila SIEMPRE se escribe ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
select restaurantes.record_audit_log(
  '00000000-0000-0000-0000-0000000000b1',
  'promocion.actualizada',
  'promocion',
  '00000000-0000-0000-0000-0000000000c3',
  'value',
  null,
  repeat('x', 600)
) as nuevo_id;
select char_length(despues) as despues_truncado_deberia_ser_500
from restaurantes.audit_log where entity_id = '00000000-0000-0000-0000-0000000000c3';
rollback;

\echo ''
\echo '=== 11) orden TOTAL determinista dentro de UNA transaccion + paginacion estable (seq desde el dia uno) ==='
\echo ''
\echo 'Bug real que esto previene (ya corregido para rentas en el PR #173, r6): now()'
\echo '(created_at) es CONSTANTE dentro de una transaccion de Postgres -- varias filas'
\echo 'de bitacora escritas en la MISMA transaccion (una accion de staff que audita 2+'
\echo 'cambios, o un batch) quedarian con el MISMO created_at sin un desempate. Aqui'
\echo '`seq bigint generated always as identity` ya vive en la migracion 019 (nunca'
\echo 'hizo falta una segunda migracion): order by created_at desc, seq desc da un'
\echo 'orden TOTAL exacto desde el dia uno.'
\echo ''

-- Corrección aplicada desde el diseño (no en revisión, a diferencia de rentas #173):
-- la premisa (mismo created_at) y el orden exacto se combinan en UN SOLO booleano
-- con un UNICO alias `deberia_ser_N` -- `scripts/verify-real-postgres-ci/run-gate.mjs`
-- solo evalua automaticamente el PRIMER alias `deberia_ser_N` de cada bloque
-- (ver su propio comentario de cabecera, "aisla ... hasta el alias objetivo"); dos
-- alias en el mismo bloque dejaria el segundo (el que de verdad importa, el orden
-- exacto) sin verificar en el gate automatico -- exactamente el hallazgo no
-- bloqueante que la revision r6 de rentas señaló sobre su propio escenario 17.
\echo '--- 21. 5 filas de la MISMA transaccion (mismo created_at) -- el orden exacto por seq desc es siempre orden-5..orden-1 (premisa + orden combinados en un solo booleano) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'orden-1') as id_1;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'orden-2') as id_2;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'orden-3') as id_3;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'orden-4') as id_4;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'orden-5') as id_5;
select (
  (count(distinct created_at) = 1)
  and (array_agg(despues order by created_at desc, seq desc) = array['orden-5','orden-4','orden-3','orden-2','orden-1'])
)::int as un_solo_created_at_y_orden_total_exacto_deberia_ser_1
from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000000b1' and despues like 'orden-%';
rollback;

\echo '--- 22. paginacion por offset ESTABLE sobre el mismo empate: 6 filas de la MISMA transaccion, 2 paginas de 3 -- la union es EXACTA, sin repetir ni perder ninguna fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'pag-1') as id_1;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'pag-2') as id_2;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'pag-3') as id_3;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'pag-4') as id_4;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'pag-5') as id_5;
select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000000b1', 'producto.precio_actualizado', 'producto', null, null, null, 'pag-6') as id_6;
-- Misma consulta EXACTA (dos veces, con LIMIT/OFFSET distintos) que
-- PostgresRestaurantesRepository.listAuditoria arma para la pantalla de Auditoria --
-- si el orden no fuera TOTAL, la segunda pagina podria repetir una fila de la
-- primera (o saltarse una) porque Postgres es libre de reordenar los empatados
-- entre dos ejecuciones del mismo plan.
with pagina_1 as (
  select despues from restaurantes.audit_log
  where organization_id = '00000000-0000-0000-0000-0000000000b1' and despues like 'pag-%'
  order by created_at desc, seq desc limit 3 offset 0
), pagina_2 as (
  select despues from restaurantes.audit_log
  where organization_id = '00000000-0000-0000-0000-0000000000b1' and despues like 'pag-%'
  order by created_at desc, seq desc limit 3 offset 3
)
select (
  (select array_agg(despues) from pagina_1) || (select array_agg(despues) from pagina_2)
  = array['pag-6','pag-5','pag-4','pag-3','pag-2','pag-1']
)::int as paginacion_sin_repetir_ni_perder_deberia_ser_1;
rollback;

-- NOTA -- esquema a medio migrar (019 no aplicada, regla dura de esta fase --
-- "REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR" del AGENTS.md): este
-- runner (`run-gate.mjs`) SIEMPRE aplica TODAS las migraciones de
-- `supabase/migrations/` en orden, sin forma de saltarse una a propósito (ver el
-- comentario de cabecera de ese script) -- así que el caso "019 no aplicada
-- todavía" no puede reproducirse AQUÍ contra Postgres real. Esa cobertura vive en
-- packages/domain-restaurantes/tests/audit-log-savepoint.spec.ts
-- (`AbortAwareFakeSession`, SQLSTATE 42883/42P01 -- misma técnica que
-- packages/domain-rentas/tests/audit-log-savepoint.spec.ts) -- mismo criterio que
-- el resto de "compatibilidad con la base sin migrar" de esta fase, que tampoco se
-- prueba contra Postgres real por el mismo motivo (ver la nota equivalente en
-- scripts/verify-rentas-bitacora-auditoria/assertions.sql).
