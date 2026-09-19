-- Fixtures + escenarios de autorización para las 4 funciones nuevas de
-- `packages/db/migrations/0014_superadmin_salud_operativa.sql`
-- (`core.record_cron_heartbeat` / `core.list_cron_heartbeats_for_superadmin` /
-- `core.get_outbox_health_for_superadmin` /
-- `core.list_licitaciones_source_runs_for_superadmin`) -- MISMO patrón EXACTO
-- que `scripts/verify-superadmin-facturacion/assertions.sql`: cada escenario
-- es su propia transacción (`begin;`...`rollback;`, nunca persiste nada
-- salvo los fixtures de arriba), y el alias de la columna de verificación
-- (`deberia_ser_N`/`should_fail`) es lo que
-- `scripts/verify-real-postgres-ci/run-gate.mjs` usa para decidir pass/fail
-- automáticamente en CI -- este archivo también se corre a mano con
-- `run.sh` para inspección humana.
--
-- Actores:
--   - staff-salud-a: staff REAL (member normal) de org-salud, sin ninguna
--     autoridad de superadmin.
--   - superadmin-salud: superadmin REAL (fila en core.platform_superadmin).
--   - org-salud: organización real de vertical 'licitaciones', con
--     staff-salud-a como 'member' y una fila real de
--     `licitaciones.source_run` (para demostrar que un caller no autorizado
--     nunca ve ese historial).
--   - `core.cron_heartbeat` se siembra con un INSERT directo (no vía la
--     función -- esa autorización se prueba aparte, en su propia sección de
--     abajo) porque, corriendo como superusuario/dueño de la tabla, este
--     script bypassa RLS igual que cualquier fixture de los otros
--     `verify-*/assertions.sql` de este repo.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000e1', 'staff-salud-a@example.com', 'Staff Salud A', 'seed'),
  ('00000000-0000-0000-0000-0000000000e3', 'superadmin-salud@example.com', 'Superadmin Salud', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000000e3')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000e9', 'licitaciones', 'Org Salud', 'org-salud')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e9', null, 'member', 'staff')
on conflict do nothing;

insert into licitaciones.source_run (id, organization_id, source, state, started_at, finished_at, http_status, response_hash, message, coverage_expected, coverage_obtained, correlation_id) values
  ('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000e9', 'compras_mx_historico', 'captcha_detected', now() - interval '2 hours', now() - interval '1 hour 55 minutes', 403, null, '403 Access Denied (evidencia real, ver connector-registry.ts)', null, null, null)
on conflict do nothing;

insert into core.cron_heartbeat (cron_name, last_started_at, last_finished_at, last_status, last_error, last_duration_ms, consecutive_failures) values
  ('/internal/salud-verify/test-cron', now() - interval '5 minutes', now() - interval '4 minutes 59 seconds', 'ok', null, 1200, 0)
on conflict do nothing;

-- ═══ core.record_cron_heartbeat (función de SISTEMA) ═══

\echo '=== 1. record_cron_heartbeat: sesion de SISTEMA (auth.uid() IS NULL) SI puede registrar un latido real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_cron_heartbeat('/internal/salud-verify/scenario-1', 'ok', now(), now(), 500, null);
-- Verificado leyendo de vuelta vía la función de lectura (authenticated no
-- tiene GRANT directo sobre core.cron_heartbeat -- correcto, ver la
-- migración) con la sesión del superadmin, en la MISMA transacción antes del
-- rollback.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select last_status as deberia_ser_ok from core.list_cron_heartbeats_for_superadmin('00000000-0000-0000-0000-0000000000e3') where cron_name = '/internal/salud-verify/scenario-1';
rollback;

\echo '=== 2. record_cron_heartbeat: una sesion REAL (auth.uid() = superadmin-salud, autenticado de verdad) es RECHAZADA -- 42501, es funcion de sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select core.record_cron_heartbeat('/internal/salud-verify/scenario-2', 'ok', now(), now(), 500, null) as should_fail;
rollback;

\echo '=== 3. record_cron_heartbeat: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.record_cron_heartbeat('/internal/salud-verify/scenario-3', 'ok', now(), now(), 500, null) as should_fail;
rollback;

-- ═══ core.list_cron_heartbeats_for_superadmin ═══

\echo '=== 4. list_cron_heartbeats_for_superadmin: superadmin-salud, con SU PROPIA sesion, SI ve el latido real sembrado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select last_status as deberia_ser_ok from core.list_cron_heartbeats_for_superadmin('00000000-0000-0000-0000-0000000000e3') where cron_name = '/internal/salud-verify/test-cron';
rollback;

\echo '=== 5. list_cron_heartbeats_for_superadmin: staff-salud-a (sesion real, NO superadmin) pasando el id de superadmin-salud obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select count(*) as deberia_ser_0 from core.list_cron_heartbeats_for_superadmin('00000000-0000-0000-0000-0000000000e3');
rollback;

\echo '=== 6. list_cron_heartbeats_for_superadmin: sesion de SISTEMA pasando el id de superadmin-salud tambien obtiene CERO filas -- el patron que apps/api usaria si olvidara abrir la sesion como el caller ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_cron_heartbeats_for_superadmin('00000000-0000-0000-0000-0000000000e3');
rollback;

\echo '=== 7. list_cron_heartbeats_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_cron_heartbeats_for_superadmin('00000000-0000-0000-0000-0000000000e3') as should_fail;
rollback;

-- ═══ core.get_outbox_health_for_superadmin ═══

\echo '=== 8. get_outbox_health_for_superadmin: superadmin-salud ve las 6 colas reales (una fila por vertical, incluso vacias) Y el conteo real de un mensaje recien encolado en citas.messaging_outbox ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000e9', 'email', 'test.event', 'dedupe-salud-verify-1', '{}'::jsonb);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select count(*) as deberia_ser_6 from core.get_outbox_health_for_superadmin('00000000-0000-0000-0000-0000000000e3');
select pending_count as deberia_ser_al_menos_1 from core.get_outbox_health_for_superadmin('00000000-0000-0000-0000-0000000000e3') where queue_name = 'citas';
rollback;

\echo '=== 9. get_outbox_health_for_superadmin: staff-salud-a (sesion real, NO superadmin) pasando el id de superadmin-salud obtiene CERO filas -- la funcion de colas NUNCA filtra filas de un tenant a nadie que no sea superadmin ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select count(*) as deberia_ser_0 from core.get_outbox_health_for_superadmin('00000000-0000-0000-0000-0000000000e3');
rollback;

\echo '=== 10. get_outbox_health_for_superadmin: sesion de SISTEMA pasando el id de superadmin-salud tambien obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_outbox_health_for_superadmin('00000000-0000-0000-0000-0000000000e3');
rollback;

\echo '=== 11. get_outbox_health_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.get_outbox_health_for_superadmin('00000000-0000-0000-0000-0000000000e3') as should_fail;
rollback;

-- ═══ core.list_licitaciones_source_runs_for_superadmin ═══

\echo '=== 12. list_licitaciones_source_runs_for_superadmin: superadmin-salud, con SU PROPIA sesion, SI ve la corrida real sembrada (captcha_detected) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select state as deberia_ser_captcha_detected from core.list_licitaciones_source_runs_for_superadmin('00000000-0000-0000-0000-0000000000e3') where organization_id = '00000000-0000-0000-0000-0000000000e9' and source = 'compras_mx_historico';
rollback;

\echo '=== 13. list_licitaciones_source_runs_for_superadmin: staff-salud-a (sesion real, NO superadmin) pasando el id de superadmin-salud obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select count(*) as deberia_ser_0 from core.list_licitaciones_source_runs_for_superadmin('00000000-0000-0000-0000-0000000000e3');
rollback;

\echo '=== 14. list_licitaciones_source_runs_for_superadmin: sesion de SISTEMA pasando el id de superadmin-salud tambien obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_licitaciones_source_runs_for_superadmin('00000000-0000-0000-0000-0000000000e3');
rollback;

\echo '=== 15. list_licitaciones_source_runs_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_licitaciones_source_runs_for_superadmin('00000000-0000-0000-0000-0000000000e3') as should_fail;
rollback;
