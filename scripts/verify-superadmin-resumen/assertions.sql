-- Fixtures + escenarios de autorización para las 15 funciones nuevas de
-- `packages/db/migrations/0015_superadmin_resumen_diario.sql` (resumen
-- diario automático) -- MISMO patrón EXACTO que
-- `scripts/verify-superadmin-salud/assertions.sql`: cada escenario es su
-- propia transacción (`begin;`...`rollback;`, nunca persiste nada salvo los
-- fixtures de arriba), y el alias de la columna de verificación
-- (`deberia_ser_N`/`should_fail`) es lo que
-- `scripts/verify-real-postgres-ci/run-gate.mjs` usa para decidir pass/fail
-- automáticamente en CI -- este archivo también se corre a mano con
-- `run.sh` para inspección humana.
--
-- Actores:
--   - staff-resumen-a: staff REAL (member normal) de org-resumen, sin
--     ninguna autoridad de superadmin.
--   - superadmin-resumen: superadmin REAL (fila en core.platform_superadmin).
--   - org-resumen: organización real de vertical 'licitaciones', con
--     staff-resumen-a como 'member'.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000f1', 'staff-resumen-a@example.com', 'Staff Resumen A', 'seed'),
  ('00000000-0000-0000-0000-0000000000f3', 'superadmin-resumen@example.com', 'Superadmin Resumen', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000000f3')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug, created_at) values
  ('00000000-0000-0000-0000-0000000000f9', 'licitaciones', 'Org Resumen', 'org-resumen', now() - interval '30 days')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f9', null, 'member', 'staff')
on conflict do nothing;

-- Un latido real (sembrado directo, como en verify-superadmin-salud -- esa
-- autorización se prueba por separado en el propio archivo de salud, no aquí).
insert into core.cron_heartbeat (cron_name, last_started_at, last_finished_at, last_status, last_error, last_duration_ms, consecutive_failures) values
  ('/internal/resumen-verify/test-cron', now() - interval '5 minutes', now() - interval '4 minutes 59 seconds', 'ok', null, 1200, 0)
on conflict do nothing;

-- Una corrida real de fuente de licitaciones.
insert into licitaciones.source_run (id, organization_id, source, state, started_at, finished_at, http_status, response_hash, message, coverage_expected, coverage_obtained, correlation_id) values
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000f9', 'compras_mx_historico', 'ok', now() - interval '2 hours', now() - interval '1 hour 55 minutes', 200, null, 'ok', null, null, null)
on conflict do nothing;

-- Organización y staff "nuevos hoy" (dentro de la ventana de prueba de abajo)
-- vs. uno viejo (fuera de la ventana) -- para verificar que
-- get_organizaciones_staff_nuevos_for_system SÍ filtra por ventana.
insert into core.organization (id, vertical, name, slug, created_at) values
  ('00000000-0000-0000-0000-0000000000fb', 'hoteles', 'Org Nueva De Hoy', 'org-nueva-de-hoy', '2026-06-15T12:00:00Z')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via, created_at) values
  ('00000000-0000-0000-0000-0000000000fc', 'staff-nuevo-de-hoy@example.com', 'Staff Nuevo De Hoy', 'seed', '2026-06-15T12:00:00Z')
on conflict do nothing;

-- Prospectos: uno dado de alta HOY (dentro de ventana), uno con cambio de
-- estado HOY (creado antes, actualizado dentro de ventana), uno sin
-- movimiento desde hace mucho en estado NO terminal.
insert into core.prospecto (id, empresa, vertical, estado, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000000fd', 'Prospecto Alta De Hoy', 'hoteles', 'nuevo', '2026-06-15T10:00:00Z', '2026-06-15T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000000fe', 'Prospecto Cambio De Hoy', 'hoteles', 'demo', '2026-05-01T10:00:00Z', '2026-06-15T11:00:00Z'),
  ('00000000-0000-0000-0000-0000000000ff', 'Prospecto Abandonado', 'hoteles', 'contactado', '2025-01-01T10:00:00Z', '2025-01-01T10:00:00Z')
on conflict do nothing;

-- Facturación: una organización que pasó a 'activa' HOY (alta) y otra
-- 'cancelada' HOY (baja), más un total 'pago_pendiente' fuera de la ventana
-- (no cuenta como "moroso nuevo", pero sí en el total vigente).
insert into core.organization (id, vertical, name, slug, created_at) values
  ('00000000-0000-0000-0000-00000000010a', 'hoteles', 'Org Alta Facturacion', 'org-alta-facturacion', now() - interval '60 days'),
  ('00000000-0000-0000-0000-00000000010b', 'hoteles', 'Org Baja Facturacion', 'org-baja-facturacion', now() - interval '60 days'),
  ('00000000-0000-0000-0000-00000000010c', 'hoteles', 'Org Morosa Vieja', 'org-morosa-vieja', now() - interval '60 days')
on conflict do nothing;
insert into core.organization_billing (organization_id, status, seats, updated_at) values
  ('00000000-0000-0000-0000-00000000010a', 'activa', 3, '2026-06-15T09:00:00Z'),
  ('00000000-0000-0000-0000-00000000010b', 'cancelada', 0, '2026-06-15T09:30:00Z'),
  ('00000000-0000-0000-0000-00000000010c', 'pago_pendiente', 2, '2026-01-01T09:00:00Z')
on conflict (organization_id) do update set status = excluded.status, updated_at = excluded.updated_at;

-- Gasto de LLM real del día, vía la RPC de sistema real (mismo camino que
-- production/llm-usage-gateway-adapters.ts) -- nunca un INSERT directo, para
-- probar el camino real de escritura también.
select core.record_llm_usage('00000000-0000-0000-0000-0000000000f9', 'licitaciones', 'licitaciones:requirement_extractor', 'anthropic', 'claude-test', 'interactive', 1000, 200, 15000, false);

-- ═══ core.list_cron_heartbeats_for_system ═══

\echo '=== 1. list_cron_heartbeats_for_system: sesion de SISTEMA ve el latido real sembrado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select last_status as deberia_ser_ok from core.list_cron_heartbeats_for_system() where cron_name = '/internal/resumen-verify/test-cron';
rollback;

\echo '=== 2. list_cron_heartbeats_for_system: una sesion REAL (auth.uid() = superadmin-resumen) es RECHAZADA -- 42501, es funcion de solo-sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select * from core.list_cron_heartbeats_for_system() as should_fail;
rollback;

\echo '=== 3. list_cron_heartbeats_for_system: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_cron_heartbeats_for_system() as should_fail;
rollback;

-- ═══ core.get_outbox_health_for_system ═══

\echo '=== 4. get_outbox_health_for_system: sesion de sistema ve las 6 colas reales (count = 6) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_6 from core.get_outbox_health_for_system(now() - interval '1 day', now() + interval '1 day');
rollback;

\echo '=== 5. get_outbox_health_for_system: una sesion REAL es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select * from core.get_outbox_health_for_system(now() - interval '1 day', now() + interval '1 day') as should_fail;
rollback;

\echo '=== 6. get_outbox_health_for_system: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.get_outbox_health_for_system(now() - interval '1 day', now() + interval '1 day') as should_fail;
rollback;

-- ═══ core.list_licitaciones_source_runs_for_system ═══

\echo '=== 7. list_licitaciones_source_runs_for_system: sesion de sistema ve la corrida real sembrada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select state as deberia_ser_ok from core.list_licitaciones_source_runs_for_system() where organization_id = '00000000-0000-0000-0000-0000000000f9' and source = 'compras_mx_historico';
rollback;

\echo '=== 8. list_licitaciones_source_runs_for_system: una sesion REAL es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select * from core.list_licitaciones_source_runs_for_system() as should_fail;
rollback;

-- ═══ core.get_llm_platform_budget_for_system / uso real del día ═══

\echo '=== 9. get_llm_platform_budget_for_system: sesion de sistema ve el tope semilla real ($1000 USD/mes) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select monthly_cap_micro_usd as deberia_ser_1000000000 from core.get_llm_platform_budget_for_system();
rollback;

\echo '=== 10. get_llm_platform_budget_for_system: una sesion REAL es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select * from core.get_llm_platform_budget_for_system() as should_fail;
rollback;

\echo '=== 11. get_llm_usage_total_for_system: refleja el gasto REAL registrado hoy via core.record_llm_usage (15000 micro-USD) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select cost_micro_usd as deberia_ser_15000 from core.get_llm_usage_total_for_system(current_date);
rollback;

\echo '=== 12. list_llm_usage_top_organizaciones_for_system: Org Resumen aparece como top gasto de hoy ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select organization_name as deberia_ser_org_resumen from core.list_llm_usage_top_organizaciones_for_system(current_date, 5) limit 1;
rollback;

-- ═══ core.get_organizaciones_staff_nuevos_for_system -- filtra por ventana ═══

\echo '=== 13. get_organizaciones_staff_nuevos_for_system: SOLO cuenta lo creado DENTRO de la ventana pasada (1 org, 1 staff) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select organizaciones_nuevas as deberia_ser_1 from core.get_organizaciones_staff_nuevos_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z');
rollback;

\echo '=== 14. get_organizaciones_staff_nuevos_for_system: una ventana que NO cubre nada real da 0, nunca error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select organizaciones_nuevas as deberia_ser_0 from core.get_organizaciones_staff_nuevos_for_system('2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z');
rollback;

-- ═══ core.get_prospectos_agregado_for_system -- altas/cambios/sin-movimiento ═══

\echo '=== 15. get_prospectos_agregado_for_system: 1 alta dentro de la ventana ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select altas as deberia_ser_1 from core.get_prospectos_agregado_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z', '2026-01-01T00:00:00Z');
rollback;

\echo '=== 16. get_prospectos_agregado_for_system: 1 cambio de estado dentro de la ventana (creado ANTES, actualizado DENTRO) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select cambios_estado as deberia_ser_1 from core.get_prospectos_agregado_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z', '2026-01-01T00:00:00Z');
rollback;

\echo '=== 17. get_prospectos_agregado_for_system: 1 sin movimiento (estado NO terminal, updated_at antes del umbral) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select sin_movimiento as deberia_ser_1 from core.get_prospectos_agregado_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z', '2025-06-01T00:00:00Z');
rollback;

-- ═══ core.get_facturacion_agregado_for_system -- altas/bajas del día ═══

\echo '=== 18. get_facturacion_agregado_for_system: 1 alta y 1 baja dentro de la ventana ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select altas as deberia_ser_1 from core.get_facturacion_agregado_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z');
rollback;

\echo '=== 19. get_facturacion_agregado_for_system: totales vigentes incluyen al moroso viejo (fuera de ventana pero sigue pago_pendiente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select pago_pendiente_total as deberia_ser_1 from core.get_facturacion_agregado_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z');
rollback;

\echo '=== 20. get_facturacion_agregado_for_system: una sesion REAL es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select * from core.get_facturacion_agregado_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z') as should_fail;
rollback;

-- ═══ core.count_break_glass_abiertos_for_system -- cruza a rentas.break_glass_session ═══

\echo '=== 21. count_break_glass_abiertos_for_system: 1 acceso abierto DENTRO de la ventana ==='
begin;
set local role authenticated;
-- La policy real de INSERT de rentas.break_glass_session exige `actor_user_id =
-- auth.uid()` + `rentas.is_platform_superadmin(auth.uid())` -- el insert real de
-- este fixture se hace con la sesión del PROPIO superadmin (nunca de sistema,
-- que violaría esa policy), antes de cambiar a sesión de sistema para leer.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
insert into rentas.break_glass_session (actor_user_id, actor_email, organization_id, reason, opened_at, expires_at) values
  ('00000000-0000-0000-0000-0000000000f3', 'superadmin-resumen@example.com', '00000000-0000-0000-0000-0000000000f9', 'verificacion automatizada del resumen diario', '2026-06-15T13:00:00Z', '2026-06-15T15:00:00Z');
select set_config('request.jwt.claim.sub', '', true);
select core.count_break_glass_abiertos_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z') as deberia_ser_1;
rollback;

\echo '=== 22. count_break_glass_abiertos_for_system: una sesion REAL es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select core.count_break_glass_abiertos_for_system('2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z') as should_fail;
rollback;

-- ═══ core.list_platform_superadmin_emails_for_system ═══

\echo '=== 23. list_platform_superadmin_emails_for_system: incluye el correo real del superadmin sembrado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select email as deberia_ser_superadmin_resumen_example_com from core.list_platform_superadmin_emails_for_system() where email = 'superadmin-resumen@example.com';
rollback;

-- ═══ core.upsert_daily_ops_summary / get_daily_ops_summary_for_system / mark_daily_ops_summary_email_sent ═══

\echo '=== 24. upsert_daily_ops_summary: sesion de sistema SI puede escribir un resumen real (se verifica leyendo de vuelta con get_daily_ops_summary_for_system) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.upsert_daily_ops_summary('2026-06-15'::date, '{"fecha":"2026-06-15"}'::jsonb, 'Narrativa de prueba', 'determinista', null, null, null);
select generado_por as deberia_ser_determinista from core.get_daily_ops_summary_for_system('2026-06-15'::date);
rollback;

\echo '=== 25. upsert_daily_ops_summary: una sesion REAL es RECHAZADA -- 42501, es funcion de solo-sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select core.upsert_daily_ops_summary('2026-06-16'::date, '{}'::jsonb, 'x', 'determinista', null, null, null) as should_fail;
rollback;

\echo '=== 26. upsert_daily_ops_summary: es idempotente por fecha -- una segunda llamada la MISMA fecha ACTUALIZA (nunca duplica). Verificado vía get_daily_ops_summary_for_system -- core.daily_ops_summary NO tiene GRANT directo (ni para authenticated), todo acceso pasa por las funciones security definer ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.upsert_daily_ops_summary('2026-06-17'::date, '{"v":1}'::jsonb, 'primera version', 'determinista', null, null, null);
select core.upsert_daily_ops_summary('2026-06-17'::date, '{"v":2}'::jsonb, 'segunda version', 'llm', 3400, 'claude-test', 'anthropic');
select count(*) as deberia_ser_1 from core.get_daily_ops_summary_for_system('2026-06-17'::date);
select narrativa as deberia_ser_segunda_version from core.get_daily_ops_summary_for_system('2026-06-17'::date);
select generado_por as deberia_ser_llm from core.get_daily_ops_summary_for_system('2026-06-17'::date);
rollback;

\echo '=== 27. mark_daily_ops_summary_email_sent: primera vez SI marca (retorna true) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.upsert_daily_ops_summary('2026-06-18'::date, '{}'::jsonb, 'x', 'determinista', null, null, null);
select core.mark_daily_ops_summary_email_sent('2026-06-18'::date)::int as deberia_ser_1;
rollback;

\echo '=== 28. mark_daily_ops_summary_email_sent: segunda vez la MISMA fecha NO vuelve a marcar (retorna false) -- un solo envio por fecha ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.upsert_daily_ops_summary('2026-06-19'::date, '{}'::jsonb, 'x', 'determinista', null, null, null);
select core.mark_daily_ops_summary_email_sent('2026-06-19'::date);
select core.mark_daily_ops_summary_email_sent('2026-06-19'::date)::int as deberia_ser_0;
rollback;

\echo '=== 29. mark_daily_ops_summary_email_sent: una sesion REAL es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select core.mark_daily_ops_summary_email_sent('2026-06-19'::date) as should_fail;
rollback;

-- ═══ core.list_daily_ops_summaries_for_superadmin / get_daily_ops_summary_for_superadmin ═══

\echo '=== 30. list_daily_ops_summaries_for_superadmin: el superadmin real, con SU PROPIA sesion, SI ve el resumen real sembrado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.upsert_daily_ops_summary('2026-06-20'::date, '{}'::jsonb, 'resumen del 20', 'determinista', null, null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select narrativa as deberia_ser_resumen_del_20 from core.list_daily_ops_summaries_for_superadmin('00000000-0000-0000-0000-0000000000f3', 30) where fecha = '2026-06-20'::date;
rollback;

\echo '=== 31. list_daily_ops_summaries_for_superadmin: staff-resumen-a (sesion real, NO superadmin) pasando el id de superadmin-resumen obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
select count(*) as deberia_ser_0 from core.list_daily_ops_summaries_for_superadmin('00000000-0000-0000-0000-0000000000f3', 30);
rollback;

\echo '=== 32. list_daily_ops_summaries_for_superadmin: sesion de SISTEMA pasando el id de superadmin-resumen tambien obtiene CERO filas -- el patron que apps/api usaria si olvidara abrir la sesion como el caller ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_daily_ops_summaries_for_superadmin('00000000-0000-0000-0000-0000000000f3', 30);
rollback;

\echo '=== 33. list_daily_ops_summaries_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_daily_ops_summaries_for_superadmin('00000000-0000-0000-0000-0000000000f3', 30) as should_fail;
rollback;

\echo '=== 34. get_daily_ops_summary_for_superadmin: el superadmin real ve el resumen real de una fecha puntual ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.upsert_daily_ops_summary('2026-06-21'::date, '{}'::jsonb, 'resumen del 21', 'determinista', null, null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select narrativa as deberia_ser_resumen_del_21 from core.get_daily_ops_summary_for_superadmin('00000000-0000-0000-0000-0000000000f3', '2026-06-21'::date);
rollback;

\echo '=== 35. get_daily_ops_summary_for_superadmin: staff-resumen-a (NO superadmin) obtiene CERO filas para la misma fecha ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.upsert_daily_ops_summary('2026-06-22'::date, '{}'::jsonb, 'resumen del 22', 'determinista', null, null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
select count(*) as deberia_ser_0 from core.get_daily_ops_summary_for_superadmin('00000000-0000-0000-0000-0000000000f3', '2026-06-22'::date);
rollback;

\echo '=== 36. get_daily_ops_summary_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.get_daily_ops_summary_for_superadmin('00000000-0000-0000-0000-0000000000f3', '2026-06-22'::date) as should_fail;
rollback;

-- ═══ Hallazgo endurecido (revisores del 19-sep, rubro B) -- SQLSTATE 42883 NO
-- es exclusivo de "function does not exist" ═══
--
-- Un guard que clasifique CUALQUIER 42883 como "migración pendiente" (el
-- código de este repo ANTES de este fix, ver `packages/db/src/sql-errors.ts::
-- isUndefinedFunctionError`) confundiría el escenario 37 de abajo con una
-- migración sin aplicar -- es un BUG REAL de tipos (comparar `uuid` con
-- `text` sin cast explícito), NUNCA "falta aplicar una migración". El helper
-- endurecido exige que el MENSAJE tenga la forma "function ... does not
-- exist" -- los escenarios 37/38 de abajo, contra Postgres REAL (no un
-- supuesto), confirman que Postgres reporta un mensaje MUY distinto para
-- cada caso aunque ambos compartan el mismo SQLSTATE 42883:
--   37. "operator does not exist: uuid = text"          -- NUNCA migración pendiente
--   38. "function core.funcion_inexistente...() does not exist" -- SÍ migración pendiente
-- (mensajes exactos verificados con `initdb`/`pg_ctl` efímero, 19-sep-2026 --
-- ver también la prueba unitaria que fija este texto en
-- `packages/db/tests/sql-errors.spec.ts`).

\echo '=== 37. HALLAZGO ENDURECIDO: comparar uuid = text (AMBOS lados con tipo YA conocido, sin margen para coaccion implicita de literal) falla con SQLSTATE 42883 "operator does not exist" -- NUNCA debe clasificarse como migracion pendiente ==='
begin;
select '00000000-0000-0000-0000-0000000000f3'::uuid = 'no-es-un-uuid-valido'::text as should_fail;
rollback;

\echo '=== 38. Contraste: una funcion REALMENTE inexistente falla con el MISMO SQLSTATE 42883 pero mensaje "function ... does not exist" -- este SI es el caso de migracion pendiente ==='
begin;
select * from core.funcion_que_no_existe_para_verificar_el_mensaje_de_42883() as should_fail;
rollback;
