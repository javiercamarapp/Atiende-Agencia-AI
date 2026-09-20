-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales -- nunca el
-- repositorio en memoria de packages/db/src/authz-audit-repository.ts, que no
-- aplica ninguno de los dos), los requisitos de seguridad no negociables de
-- packages/db/migrations/0021_superadmin_authz_audit_log.sql:
--
--   1. `core.record_authz_audit_denial` es de SOLO SISTEMA -- rechaza
--      cualquier llamada con `auth.uid()` NO nulo (28000).
--   2. `anon` no puede ni ejecutar la función de escritura (sin GRANT EXECUTE).
--   3. `decision`/`reason` inválidos -- rechazados (22023) ANTES del INSERT.
--   4. Camino feliz: sesión de sistema inserta una fila real -- `id` no nulo.
--   5. La fila insertada es visible para OTRO superadmin real vía
--      `core.list_authz_audit_log_for_superadmin` (oversight de plataforma).
--   6. Un staff con membership real (NO superadmin) NO ve nada -- ni siquiera
--      las filas fixture ya sembradas -- vía la función de lectura.
--   7. Caller-binding: `auth.uid()` debe coincidir con `p_caller_id` en la
--      lectura -- pasar el uuid de OTRO superadmin como parámetro no filtra
--      nada ajeno.
--   8. `anon` no puede ni ejecutar la función de lectura.
--   9. Bitácora append-only: ni UPDATE ni DELETE, para NADIE, ni siquiera
--      `service_role` -- ni tampoco un INSERT/SELECT directo (sin pasar por
--      las funciones) desde `authenticated` ni `anon`.
--  10. SELECT directo (RLS): un staff normal ve 0 filas, un superadmin real
--      ve todas -- misma policy que ya prueba la función de lectura, pero
--      ejercitada como SELECT crudo, no solo a través de la función.
--  11. Tope defensivo de ráfaga: con la ventana móvil ya al tope, la función
--      de escritura descarta el INSERT en silencio (`id` NULL, sin lanzar).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de eso
-- persiste salvo las filas de fixture insertadas antes (directas, como el
-- superusuario `postgres` que corre este script -- mismo criterio que el
-- resto de scripts/verify-*/assertions.sql).
\set ON_ERROR_STOP off
\pset pager off

-- ═══════════════════════════════════════════════════════════════════════════
-- Fixtures (persisten para TODOS los escenarios de abajo)
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000aa000', 'restaurantes', 'Org Auditoría Denegaciones', 'org-auditoria-denegaciones')
on conflict do nothing;

-- superadmin-1/2: dos superadmins REALES (core.platform_superadmin) --
-- superadmin-2 nunca escribe nada, solo se usa para probar oversight
-- ("ve lo que otro insertó") y caller-binding.
-- staff-normal: staff real, member de la organización de arriba, NUNCA
-- superadmin -- el caso "no lee nada, ni lo suyo ni lo ajeno".
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000aa100', 'superadmin-aud-1@example.com', 'Superadmin Auditoría 1', 'seed'),
  ('00000000-0000-0000-0000-0000000aa101', 'superadmin-aud-2@example.com', 'Superadmin Auditoría 2', 'seed'),
  ('00000000-0000-0000-0000-0000000aa102', 'staff-normal-aud@example.com', 'Staff Normal Auditoría', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000aa100'),
  ('00000000-0000-0000-0000-0000000aa101')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000aa102', '00000000-0000-0000-0000-0000000aa000', null, 'member', 'staff')
on conflict do nothing;

-- Dos filas insertadas DIRECTO (como el superusuario que corre este script --
-- la función security definer no aplica aquí, solo se ejercitan la lectura/
-- RLS/bloqueo de mutación sobre estas filas).
insert into core.authz_audit_log (id, actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, metadata, occurred_at) values
  ('00000000-0000-0000-0000-0000000aa400', '00000000-0000-0000-0000-0000000aa102', '203.0.113.7', '00000000-0000-0000-0000-0000000aa000', 'admin:access', '/superadmin/fixture-a', 'POST', 'denied', 'no_membership', '{}'::jsonb, now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-0000000aa401', null, '203.0.113.8', null, 'admin:access', '/superadmin/fixture-b', 'GET', 'denied', 'insufficient_role', '{}'::jsonb, now() - interval '1 minute')
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) core.record_authz_audit_denial -- solo sistema, decision/reason válidos
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 1. record_authz_audit_denial: auth.uid() NO nulo (staff-normal autenticado) -- RECHAZADO (solo sesión de sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa102', true);
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa102', '203.0.113.9', null, 'admin:access', '/superadmin/x', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) as should_fail;
rollback;

\echo '=== 2. record_authz_audit_denial: anon no puede ni ejecutar la función (sin GRANT EXECUTE) -- RECHAZADO ==='
begin;
set local role anon;
select core.record_authz_audit_denial(null, '203.0.113.9', null, 'admin:access', '/superadmin/x', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) as should_fail;
rollback;

\echo '=== 3. record_authz_audit_denial: decision inválida -- RECHAZADO (22023) antes de insertar ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial(null, '203.0.113.9', null, 'admin:access', '/superadmin/x', 'POST', 'bogus', 'no_membership', '{}'::jsonb, now()) as should_fail;
rollback;

\echo '=== 4. record_authz_audit_denial: reason inválido -- RECHAZADO (22023) antes de insertar ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial(null, '203.0.113.9', null, 'admin:access', '/superadmin/x', 'POST', 'denied', 'razon_que_no_existe', '{}'::jsonb, now()) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Camino feliz + oversight de plataforma + caller-binding en la lectura
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 5. record_authz_audit_denial: sesión de sistema (auth.uid() NULL), entrada VÁLIDA -- inserta y devuelve un id real (nunca NULL) ==='
begin;
set local role authenticated;
select (core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa102', '203.0.113.50', '00000000-0000-0000-0000-0000000aa000', 'admin:access', '/superadmin/camino-feliz', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) is not null)::int as deberia_ser_1;
rollback;

\echo '=== 6. Oversight de plataforma: la fila que insertó la sesión de sistema es visible para OTRO superadmin real (superadmin-2, que nunca la insertó) ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa102', '203.0.113.50', '00000000-0000-0000-0000-0000000aa000', 'admin:access', '/superadmin/camino-feliz-6', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) as id \gset aud6_
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa101', true);
select (count(*) >= 1)::int as deberia_ser_1 from core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa101', 500, 0) where id = :'aud6_id';
rollback;

\echo '=== 7. Un staff con membership real (NO superadmin) NO ve NADA vía la función de lectura -- ni siquiera las 2 filas fixture ya sembradas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa102', true);
select count(*) as deberia_ser_0 from core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa102', 500, 0);
rollback;

\echo '=== 8. Caller-binding en la lectura: auth.uid()=superadmin-1 pero p_caller_id=superadmin-2 (OTRO real) -- 0 filas, nunca filtra por el parámetro ajeno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa100', true);
select count(*) as deberia_ser_0 from core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa101', 500, 0);
rollback;

\echo '=== 9. list_authz_audit_log_for_superadmin: anon no puede ni ejecutar la función -- RECHAZADO (sin GRANT EXECUTE) ==='
begin;
set local role anon;
select core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa100', 500, 0) as should_fail;
rollback;

\echo '=== 10. Un superadmin real ve las 2 filas fixture (al menos) vía la función de lectura -- oversight real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa100', true);
select (count(*) >= 2)::int as deberia_ser_1 from core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa100', 500, 0);
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Append-only real -- ni un UPDATE/DELETE/INSERT/SELECT directo indebido
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 11. authz_audit_log: UPDATE directo está bloqueado incluso para service_role ==='
begin;
-- as should_fail (el trigger de bloqueo, no un alias -- UPDATE no admite
-- `as` sobre la sentencia completa; este comentario, DENTRO del bloque
-- begin;/rollback;, es lo que el runner automático detecta para marcar el
-- escenario como "debe terminar en ERROR").
set local role service_role;
update core.authz_audit_log set route = '/alterado' where id = '00000000-0000-0000-0000-0000000aa400';
rollback;

\echo '=== 12. authz_audit_log: DELETE directo está bloqueado incluso para service_role ==='
begin;
-- as should_fail (ver nota del escenario 11 -- DELETE tampoco admite `as`
-- sobre la sentencia completa).
set local role service_role;
delete from core.authz_audit_log where id = '00000000-0000-0000-0000-0000000aa400';
rollback;

\echo '=== 13. authz_audit_log: INSERT directo desde authenticated (sin pasar por la función) -- RECHAZADO (sin policy de escritura) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario es lo que el runner automático detecta).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa102', true);
insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason)
values ('00000000-0000-0000-0000-0000000aa102', '203.0.113.9', null, 'admin:access', '/superadmin/insert-directo', 'POST', 'denied', 'no_membership');
rollback;

\echo '=== 14. authz_audit_log: INSERT directo desde anon -- RECHAZADO (sin GRANT) ==='
begin;
-- as should_fail (mismo motivo que 13).
set local role anon;
insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason)
values (null, '203.0.113.9', null, 'admin:access', '/superadmin/insert-anon', 'POST', 'denied', 'no_membership');
rollback;

\echo '=== 15. authz_audit_log: SELECT directo desde anon -- RECHAZADO (sin GRANT, ni siquiera llega a evaluar RLS) ==='
begin;
-- as should_fail (sin GRANT SELECT a anon -- "permission denied", nunca una
-- lista vacía silenciosa; ver revoke all ... from public, anon, authenticated,
-- service_role de la migración).
set local role anon;
select * from core.authz_audit_log as should_fail;
rollback;

\echo '=== 16. authz_audit_log: SELECT directo (RLS) como staff normal -- 0 filas, RLS filtra en silencio (no un error) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa102', true);
select count(*) as deberia_ser_0 from core.authz_audit_log;
rollback;

\echo '=== 17. authz_audit_log: SELECT directo (RLS) como superadmin real -- ve las filas fixture (al menos 2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa100', true);
select (count(*) >= 2)::int as deberia_ser_1 from core.authz_audit_log;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) Tope defensivo de ráfaga (mandato de la tarea: "agrega un tope
--    defensivo para que una ráfaga de denegaciones no llene la tabla")
-- ═══════════════════════════════════════════════════════════════════════════

-- 5000 filas más, TODAS dentro de la ventana móvil de 10 minutos que la
-- función cuenta -- deliberadamente DESPUÉS de todos los escenarios de
-- arriba (que cuentan filas exactas/aproximadas): esta ráfaga persiste para
-- el resto del script, así que va al final para no contaminar los conteos
-- de los escenarios 6/7/8/9/10/16/17.
insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, occurred_at)
select null, '203.0.113.99', null, 'admin:access', '/superadmin/rafaga', 'POST', 'denied', 'rate_limited', now()
from generate_series(1, 5000);

\echo '=== 18. record_authz_audit_denial: con la ventana móvil ya en 5000+ filas -- descarta el INSERT EN SILENCIO (id NULL, nunca lanza) ==='
begin;
set local role authenticated;
select (core.record_authz_audit_denial(null, '203.0.113.100', null, 'admin:access', '/superadmin/rafaga-una-mas', 'POST', 'denied', 'rate_limited', '{}'::jsonb, now()) is null)::int as deberia_ser_1;
rollback;
