-- Fixtures + escenarios de autorizacion y de cuadre para `packages/db/migrations/0044_superadmin_corridas_y_panel_agentes.sql`
-- (core.agent_run, core.agent_definition y sus cuatro funciones). Mismo patron EXACTO que
-- `scripts/verify-superadmin-resumen/assertions.sql`: cada escenario es su propia transaccion (`begin;`...`rollback;`)
-- y el alias de la columna de verificacion (`deberia_ser_N` / `should_fail`) es lo que
-- `scripts/verify-real-postgres-ci/run-gate.mjs` usa para decidir pass/fail automaticamente en CI.
--
-- Actores:
--   - staff-agentes: staff REAL (member) de org-agentes-a, sin autoridad de superadmin.
--   - owner-agentes-b: OWNER de org-agentes-b (otro tenant); aun siendo owner no es superadmin de plataforma.
--   - superadmin-agentes: superadmin REAL (fila en core.platform_superadmin).
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000001a1', 'staff-agentes@example.com', 'Staff Agentes', 'seed'),
  ('00000000-0000-0000-0000-0000000001a2', 'owner-agentes-b@example.com', 'Owner Agentes B', 'seed'),
  ('00000000-0000-0000-0000-0000000001a3', 'superadmin-agentes@example.com', 'Superadmin Agentes', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000001a3')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug, created_at) values
  ('00000000-0000-0000-0000-0000000001b1', 'restaurantes', 'Org Agentes A', 'org-agentes-a', now() - interval '60 days'),
  ('00000000-0000-0000-0000-0000000001b2', 'restaurantes', 'Org Agentes B', 'org-agentes-b', now() - interval '60 days')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001b1', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-0000000001b2', null, 'owner', 'admin')
on conflict do nothing;

-- Corridas del agente `restaurantes:whatsapp_agent` escritas por el camino REAL de sistema (sub vacio):
-- 2 ok y 1 fallo dentro de los ultimos 30 dias (una de cada org). Las dos filas viejas (40 y 100 dias) se siembran
-- directo (el fixture corre como dueño de la tabla): la de 40 dias queda FUERA de la ventana de 30 dias del panel
-- pero DENTRO de la retencion de 90; la de 100 dias queda fuera de la retencion y la purga la borra.
select core.record_agent_run('restaurantes:whatsapp_agent', 'restaurantes', '00000000-0000-0000-0000-0000000001b1', 'whatsapp', 'ok', null, null, null, null, now() - interval '3 hours', now() - interval '3 hours' + interval '2 seconds');
select core.record_agent_run('restaurantes:whatsapp_agent', 'restaurantes', '00000000-0000-0000-0000-0000000001b2', 'whatsapp', 'ok', null, null, null, null, now() - interval '2 hours', now() - interval '2 hours' + interval '3 seconds');
select core.record_agent_run('restaurantes:whatsapp_agent', 'restaurantes', '00000000-0000-0000-0000-0000000001b1', 'whatsapp', 'fallo', null, null, null, 'timeout del proveedor', now() - interval '1 hour', now() - interval '1 hour' + interval '1 second');
select core.record_agent_run('/internal/hoteles/night-audit', 'hoteles', null, 'cron', 'parcial', 3, 4, null, 'una propiedad fallo', now() - interval '30 minutes', now() - interval '29 minutes');
insert into core.agent_run (id, agente, vertical, organization_id, disparo, estado, iniciado_en, terminado_en) values
  ('00000000-0000-0000-0000-0000000001c1', 'restaurantes:whatsapp_agent', 'restaurantes', '00000000-0000-0000-0000-0000000001b1', 'whatsapp', 'ok', now() - interval '40 days', now() - interval '40 days' + interval '1 second'),
  ('00000000-0000-0000-0000-0000000001c2', 'restaurantes:whatsapp_agent', 'restaurantes', '00000000-0000-0000-0000-0000000001b1', 'whatsapp', 'ok', now() - interval '100 days', now() - interval '100 days' + interval '1 second');

-- Gasto de LLM real del dia por la RPC de sistema real: 15000 del rol y 5000 de su variante escalada = 20000 micro-USD.
select core.record_llm_usage('00000000-0000-0000-0000-0000000001b1', 'restaurantes', 'restaurantes:whatsapp_agent', 'openrouter', 'modelo-test', 'interactive', 1000, 200, 15000, false);
select core.record_llm_usage('00000000-0000-0000-0000-0000000001b1', 'restaurantes', 'restaurantes:whatsapp_agent_escalated', 'openrouter', 'modelo-test', 'interactive', 500, 100, 5000, true);

-- ═══ core.record_agent_run (solo sistema) ═══

\echo '=== 1. record_agent_run: la sesion de SISTEMA escribe una corrida y devuelve su id ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(core.record_agent_run('hoteles:whatsapp_agent', 'hoteles', null, 'whatsapp', 'ok', null, null, null, null, now() - interval '1 minute', now())) as deberia_ser_1;
rollback;

\echo '=== 2. record_agent_run: una sesion REAL (staff de un tenant) es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a1', true);
select core.record_agent_run('hoteles:whatsapp_agent', 'hoteles', null, 'whatsapp', 'ok', null, null, null, null, now() - interval '1 minute', now()) as should_fail;
rollback;

\echo '=== 3. record_agent_run: ni un superadmin REAL puede escribir (es solo sistema) -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select core.record_agent_run('hoteles:whatsapp_agent', 'hoteles', null, 'whatsapp', 'ok', null, null, null, null, now() - interval '1 minute', now()) as should_fail;
rollback;

\echo '=== 4. record_agent_run: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.record_agent_run('hoteles:whatsapp_agent', 'hoteles', null, 'whatsapp', 'ok', null, null, null, null, now() - interval '1 minute', now()) as should_fail;
rollback;

\echo '=== 5. record_agent_run: un estado fuera de ok|parcial|fallo es rechazado (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_agent_run('hoteles:whatsapp_agent', 'hoteles', null, 'whatsapp', 'roto', null, null, null, null, now() - interval '1 minute', now()) as should_fail;
rollback;

\echo '=== 6. record_agent_run: tareas_hechas > tareas_total es rechazado por el CHECK de la tabla ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_agent_run('/internal/hoteles/night-audit', 'hoteles', null, 'cron', 'parcial', 5, 2, null, null, now() - interval '1 minute', now()) as should_fail;
rollback;

\echo '=== 7. record_agent_run: un disparo fuera de cron|whatsapp|voz|manual es rechazado por el CHECK ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_agent_run('hoteles:whatsapp_agent', 'hoteles', null, 'sms', 'ok', null, null, null, null, now() - interval '1 minute', now()) as should_fail;
rollback;

\echo '=== 8. record_agent_run: el correo y el telefono del error se redactan en la base (nunca se persisten) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_agent_run('hoteles:whatsapp_agent', 'hoteles', null, 'whatsapp', 'fallo', null, null, null, 'falla con ana.perez@example.com y el telefono +5215512345678 y 55 1234 5678', now() - interval '1 minute', now());
reset role;
select (count(*) filter (where error like '%[correo]%' and error like '%[numero]%' and error not like '%@%' and error not like '%5512345678%' and error not like '%1234 5678%'))::int as deberia_ser_1 from core.agent_run where agente = 'hoteles:whatsapp_agent' and error like 'falla con%';
rollback;

\echo '=== 9. record_agent_run: un error de 900 caracteres se guarda truncado a 500 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_agent_run('hoteles:whatsapp_agent', 'hoteles', null, 'whatsapp', 'fallo', null, null, null, repeat('x', 900), now() - interval '1 minute', now());
reset role;
select max(char_length(error)) as deberia_ser_500 from core.agent_run where agente = 'hoteles:whatsapp_agent' and error like 'xxxx%';
rollback;

-- ═══ acceso directo a las tablas ═══

\echo '=== 10. core.agent_run: ni authenticated (aun superadmin) lee la tabla directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select * from core.agent_run as should_fail;
rollback;

\echo '=== 11. core.agent_run: anon no lee la tabla ==='
begin;
set local role anon;
select * from core.agent_run as should_fail;
rollback;

\echo '=== 12. core.agent_run: authenticated no puede insertar directo (sin GRANT) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
insert into core.agent_run (agente, vertical, disparo, estado, iniciado_en, terminado_en) values ('hoteles:whatsapp_agent', 'hoteles', 'whatsapp', 'ok', now(), now()) returning id as should_fail;
rollback;

\echo '=== 13. core.agent_definition: authenticated no lee ni escribe la tabla directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select * from core.agent_definition as should_fail;
rollback;

\echo '=== 14. core.agent_definition: anon no lee la tabla ==='
begin;
set local role anon;
select * from core.agent_definition as should_fail;
rollback;

-- ═══ core.list_agent_runs_for_superadmin ═══

\echo '=== 15. list_agent_runs: el superadmin ve las 5 corridas del agente (3 recientes y las de 40 y 100 dias) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select count(*) as deberia_ser_5 from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a3', 'restaurantes:whatsapp_agent');
rollback;

\echo '=== 16. list_agent_runs: el filtro por estado devuelve solo los fallos del agente (1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select count(*) as deberia_ser_1 from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a3', 'restaurantes:whatsapp_agent', null, 'fallo');
rollback;

\echo '=== 17. list_agent_runs: la corrida de cron parcial trae tareas 3 de 4 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select tareas_hechas * 10 + tareas_total as deberia_ser_34 from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a3', '/internal/hoteles/night-audit');
rollback;

\echo '=== 18. list_agent_runs: el limite se acota a 200 aunque se pida 100000 (no explota) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select (count(*) <= 200)::int as deberia_ser_1 from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a3', null, null, null, null, null, 100000);
rollback;

\echo '=== 19. list_agent_runs: staff de un tenant (no superadmin) recibe CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a1', true);
select count(*) as deberia_ser_0 from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a1');
rollback;

\echo '=== 20. list_agent_runs (cross-tenant): el OWNER de otra organizacion tampoco ve las corridas -- CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a2', true);
select count(*) as deberia_ser_0 from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a2');
rollback;

\echo '=== 21. list_agent_runs: un sub que no coincide con p_caller_id (suplantar al superadmin) recibe CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a1', true);
select count(*) as deberia_ser_0 from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a3');
rollback;

\echo '=== 22. list_agent_runs: la sesion de sistema (sub vacio) recibe CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a3');
rollback;

\echo '=== 23. list_agent_runs: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a3') as should_fail;
rollback;

\echo '=== 24. list_agent_runs: un rango de mas de 400 dias es rechazado (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select * from core.list_agent_runs_for_superadmin('00000000-0000-0000-0000-0000000001a3', null, null, null, now() - interval '500 days', now()) as should_fail;
rollback;

-- ═══ core.get_agent_panel_for_superadmin ═══

\echo '=== 25. panel: el superadmin ve las 15 filas del catalogo sembrado (14 de la 0044 + superadmin:copiloto de la 0048) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select count(*) as deberia_ser_15 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date);
rollback;

\echo '=== 26. panel: corridas de 30 dias del agente = 3 (la de 40 y la de 100 dias quedan fuera de la ventana) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select corridas_30d as deberia_ser_3 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date) where id = 'restaurantes:whatsapp_agent';
rollback;

\echo '=== 27. panel: corridas ok de 30 dias = 2 (exito 2 de 3 cuadra con agent_run) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select corridas_ok_30d as deberia_ser_2 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date) where id = 'restaurantes:whatsapp_agent';
rollback;

\echo '=== 28. panel: costo de 30 dias = 20000 micro-USD (rol 15000 + escalado 5000, cuadra con llm_usage_daily) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select costo_30d_micro_usd as deberia_ser_20000 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date) where id = 'restaurantes:whatsapp_agent';
rollback;

\echo '=== 29. panel: llamadas de 30 dias del agente = 2 (record_llm_usage cuenta 1 por llamada: rol y rol escalado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select llamadas_30d as deberia_ser_2 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date) where id = 'restaurantes:whatsapp_agent';
rollback;

\echo '=== 30. panel: un agente sin corridas ni gasto sale en ceros y sin ultima corrida (nunca un dato inventado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select (corridas_30d = 0 and costo_30d_micro_usd = 0 and ultima_corrida_en is null)::int as deberia_ser_1 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date) where id = 'citas:data_chat';
rollback;

\echo '=== 31. panel: con p_hoy dentro de 41 dias ninguna corrida cae en la ventana (corridas_30d = 0): la ventana depende de p_hoy ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select corridas_30d as deberia_ser_0 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date + 41) where id = 'restaurantes:whatsapp_agent';
rollback;

\echo '=== 32. panel: staff de un tenant recibe CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a1', true);
select count(*) as deberia_ser_0 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a1', current_date);
rollback;

\echo '=== 33. panel (cross-tenant): el OWNER de otra organizacion recibe CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a2', true);
select count(*) as deberia_ser_0 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a2', current_date);
rollback;

\echo '=== 34. panel: un sub que no coincide con p_caller_id recibe CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a1', true);
select count(*) as deberia_ser_0 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date);
rollback;

\echo '=== 35. panel: la sesion de sistema recibe CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date);
rollback;

\echo '=== 36. panel: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', current_date) as should_fail;
rollback;

\echo '=== 37. panel: p_hoy nulo es rechazado (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select * from core.get_agent_panel_for_superadmin('00000000-0000-0000-0000-0000000001a3', null) as should_fail;
rollback;

-- ═══ retencion y purga ═══

\echo '=== 38. retencion: la clase plataforma_agent_run esta registrada con 90 dias ==='
begin;
select default_days as deberia_ser_90 from core.retention_class where data_class = 'plataforma_agent_run';
rollback;

\echo '=== 39. purga: la sesion de sistema borra la corrida de 100 dias y conserva la de 40 y las recientes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.system_purge_agent_runs(1000);
reset role;
select ((select count(*) from core.agent_run where id = '00000000-0000-0000-0000-0000000001c2') = 0
  and (select count(*) from core.agent_run where id = '00000000-0000-0000-0000-0000000001c1') = 1
  and (select count(*) from core.agent_run where iniciado_en > now() - interval '1 day') >= 4)::int as deberia_ser_1;
rollback;

\echo '=== 40. purga: una sesion REAL (staff) es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a1', true);
select core.system_purge_agent_runs(1000) as should_fail;
rollback;

\echo '=== 41. purga: ni un superadmin REAL puede purgar (es solo sistema) -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select core.system_purge_agent_runs(1000) as should_fail;
rollback;

\echo '=== 42. purga: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.system_purge_agent_runs(1000) as should_fail;
rollback;

\echo '=== 43. purga: un lote fuera de rango es rechazado (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.system_purge_agent_runs(0) as should_fail;
rollback;

\echo '=== 44. system_agent_is_live: la sesion de sistema ve vivo a un agente del catalogo sembrado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.system_agent_is_live('restaurantes:whatsapp_agent')::int as deberia_ser_1;
rollback;

\echo '=== 45. system_agent_is_live: un agente que no esta en el catalogo no es vivo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.system_agent_is_live('/internal/hoteles/night-audit')::int as deberia_ser_0;
rollback;

\echo '=== 46. system_agent_is_live: una sesion REAL (superadmin) es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a3', true);
select core.system_agent_is_live('restaurantes:whatsapp_agent') as should_fail;
rollback;

\echo '=== 47. system_agent_is_live: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.system_agent_is_live('restaurantes:whatsapp_agent') as should_fail;
rollback;

\echo '=== 48. org_list_retention_policies: el owner de una organizacion NO ve la clase interna plataforma_agent_run ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a2', true);
select count(*) as deberia_ser_0 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000001b2') where out_data_class = 'plataforma_agent_run';
rollback;

\echo '=== 49. org_list_retention_policies: el owner sigue viendo las clases de su catalogo (control: la funcion no quedo vacia) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a2', true);
select (count(*) > 0)::int as deberia_ser_1 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000001b2') where out_data_class = 'restaurantes_whatsapp_conversaciones';
rollback;

\echo '=== 50. org_set_retention_policy: un owner no puede fijar una politica sobre la clase interna (no es de la plataforma por organizacion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000001a2', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000001b2', 'plataforma_agent_run', 60) as should_fail;
rollback;

\echo 'Fin: los escenarios con alias should_fail deben terminar en ERROR; el resto devuelve el valor deberia_ser_N.'
