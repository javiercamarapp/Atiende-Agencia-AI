-- Copiloto: presupuesto, costo por rol y tope diario de turnos (migracion 0047) -- verificacion contra Postgres REAL.
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias
-- `..._deberia_ser_N` = el valor esperado (ver scripts/verify-real-postgres-ci/run-gate.mjs). Datos ficticios.
-- Sesion de sistema = sin `set local role` ni claim (auth.uid() es null); usuario real = `set local role authenticated` +
-- claim `request.jwt.claim.sub`.
-- Sujetos: u1 owner de A (hoteles), u2 owner de B (restaurantes), u3 superadmin, u4 sin membresia.
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000b0e1', 'hoteles', 'Hotel A presupuesto', 'hotel-a-presupuesto'),
  ('00000000-0000-0000-0000-00000000b0e2', 'restaurantes', 'Restaurante B presupuesto', 'restaurante-b-presupuesto')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000c0e1', 'pres-u1@example.com', 'U1', 'seed'),
  ('00000000-0000-0000-0000-00000000c0e2', 'pres-u2@example.com', 'U2', 'seed'),
  ('00000000-0000-0000-0000-00000000c0e3', 'pres-u3@example.com', 'U3', 'seed'),
  ('00000000-0000-0000-0000-00000000c0e4', 'pres-u4@example.com', 'U4', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000c0e1', '00000000-0000-0000-0000-00000000b0e1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c0e2', '00000000-0000-0000-0000-00000000b0e2', null, 'owner', 'owner')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-00000000c0e3') on conflict do nothing;

\echo '=== SUBTOPE DEL COPILOTO (30 % del tope de la organizacion) ==='
\echo '1. sistema: una reserva con rol devuelve los totales tras reservar'
begin;
insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd) values ('00000000-0000-0000-0000-00000000b0e1', 1000);
select (org_total_micro_usd = 100 and org_cap_micro_usd = 1000)::int as totales_deberia_ser_1 from core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r1', 100, 'hoteles:data_chat');
rollback;

\echo '2. el Copiloto puede llegar EXACTO al 30 % (300 de 1000)'
begin;
insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd) values ('00000000-0000-0000-0000-00000000b0e1', 1000);
select count(*)::int as exacto_deberia_ser_1 from core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r2', 300, 'hoteles:data_chat');
rollback;

\echo '3. pasar del 30 % del Copiloto se rechaza'
begin;
insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd) values ('00000000-0000-0000-0000-00000000b0e1', 1000);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r3a', 300, 'hoteles:data_chat');
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r3b', 1, 'hoteles:data_chat') as should_fail;
rollback;

\echo '4. el reintento por guardia de cifras (data_chat_retry) comparte el subtope'
begin;
insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd) values ('00000000-0000-0000-0000-00000000b0e1', 1000);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r4a', 300, 'hoteles:data_chat');
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r4b', 1, 'hoteles:data_chat_retry') as should_fail;
rollback;

\echo '5. con el subtope agotado, otro rol (agente de WhatsApp) sigue reservando contra el tope de la organizacion'
begin;
insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd) values ('00000000-0000-0000-0000-00000000b0e1', 1000);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r5a', 300, 'hoteles:data_chat');
select count(*)::int as otro_rol_deberia_ser_1 from core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r5b', 600, 'hoteles:whatsapp_agent');
rollback;

\echo '6. el subtope es de cada organizacion: la otra organizacion conserva el suyo'
begin;
insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd) values ('00000000-0000-0000-0000-00000000b0e1', 1000), ('00000000-0000-0000-0000-00000000b0e2', 1000);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r6a', 300, 'hoteles:data_chat');
select count(*)::int as otra_org_deberia_ser_1 from core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e2', 'pres-r6b', 300, 'restaurantes:data_chat');
rollback;

\echo '7. liquidar a un costo menor libera subtope (settle ajusta la reserva)'
begin;
insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd) values ('00000000-0000-0000-0000-00000000b0e1', 1000);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r7a', 300, 'hoteles:data_chat');
select core.settle_llm_monthly_budget('pres-r7a', 10);
select count(*)::int as liberado_deberia_ser_1 from core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r7b', 250, 'hoteles:data_chat');
rollback;

\echo '8. la reserva de 3 argumentos sigue funcionando (compatibilidad) y no cuenta para el subtope'
begin;
insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd) values ('00000000-0000-0000-0000-00000000b0e1', 1000);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r8a', 500);
select count(*)::int as sin_rol_deberia_ser_1 from core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r8b', 300, 'hoteles:data_chat');
rollback;

\echo '9. un usuario real NO reserva (ni en su propia organizacion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r9', 10, 'hoteles:data_chat') as should_fail;
rollback;

\echo '10. un usuario real NO reserva contra la organizacion de OTRO tenant'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e2', 'pres-r10', 999999999, 'restaurantes:data_chat') as should_fail;
rollback;

\echo '11. anon NO reserva'
begin;
set local role anon;
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-00000000b0e1', 'pres-r11', 10, 'hoteles:data_chat') as should_fail;
rollback;

\echo '=== TOPE DIARIO DE TURNOS POR ROL ==='
\echo '12. con tope 3: los tres primeros turnos pasan'
begin;
select (allowed and used = 3)::int as tercer_turno_deberia_ser_1 from (
  select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3)
  union all select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3)
  union all select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3)
) t order by used desc limit 1;
rollback;

\echo '13. el turno 4 con tope 3 se rechaza y NO consume'
begin;
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3);
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3);
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3);
select (not allowed and used = 3)::int as rechazado_deberia_ser_1 from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3);
rollback;

\echo '14. el contador no sube tras el rechazo'
begin;
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 1);
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 1);
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 1);
select turns::int as contador_deberia_ser_1 from core.llm_role_daily_turns where organization_id = '00000000-0000-0000-0000-00000000b0e1' and role = 'hoteles:data_chat';
rollback;

\echo '15. un tope propio de la organizacion manda sobre el default'
begin;
insert into core.llm_org_role_limit (organization_id, role, max_turnos_dia) values ('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 1);
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 500);
select (not allowed)::int as tope_propio_deberia_ser_1 from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 500);
rollback;

\echo '16. otra organizacion y otro rol cuentan aparte'
begin;
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 1);
select allowed::int as otra_org_deberia_ser_1 from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e2', 'hoteles:data_chat', 1);
rollback;

\echo '17. otro rol de la misma organizacion cuenta aparte'
begin;
select * from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 1);
select allowed::int as otro_rol_deberia_ser_1 from core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'plataforma:titulos_resumenes', 1);
rollback;

\echo '18. un usuario real NO consume turnos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3) as should_fail;
rollback;

\echo '19. anon NO consume turnos'
begin;
set local role anon;
select core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 3) as should_fail;
rollback;

\echo '20. un rol con forma invalida se rechaza'
begin;
select core.consume_llm_role_turn('00000000-0000-0000-0000-00000000b0e1', 'Rol Malo; drop', 3) as should_fail;
rollback;

\echo '=== VENTANA HORARIA DE FALLBACKS ==='
\echo '21. sistema: cuenta llamadas y respaldos de la hora'
begin;
select * from core.record_llm_hour_window(false);
select * from core.record_llm_hour_window(true);
select (calls = 3 and fallbacks = 1)::int as ventana_deberia_ser_1 from core.record_llm_hour_window(false);
rollback;

\echo '22. un usuario real NO escribe la ventana'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.record_llm_hour_window(true) as should_fail;
rollback;

\echo '=== BITACORA: costo, modelo y rol ==='
\echo '23. u1 registra un turno con costo, modelo, rol y ruta sin_ia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000b0e1', null, '{}'::jsonb, 'budget_exceeded', 0, 5, null, 'sin_ia', 1234, 'deepseek/deepseek-v4.1-flash', 'hoteles:data_chat');
select count(*)::int as fila_deberia_ser_1 from core.data_chat_query_log where route = 'sin_ia' and costo_micro_usd = 1234 and modelo = 'deepseek/deepseek-v4.1-flash' and rol = 'hoteles:data_chat';
rollback;

\echo '24. la ruta escalado se acepta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000b0e1', null, '{}'::jsonb, 'ok', 0, 5, null, 'escalado', 10, null, 'hoteles:data_chat_retry');
select count(*)::int as escalado_deberia_ser_1 from core.data_chat_query_log where route = 'escalado';
rollback;

\echo '25. un costo negativo se guarda como 0 y un rol invalido como null'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000b0e1', 'x', '{}'::jsonb, 'ok', 0, 5, null, 'llm', -50, 'm', 'Rol Malo; drop');
select count(*)::int as saneado_deberia_ser_1 from core.data_chat_query_log where costo_micro_usd = 0 and rol is null;
rollback;

\echo '26. la sesion de sistema no escribe la bitacora'
begin;
select core.record_data_chat_query('00000000-0000-0000-0000-00000000b0e1', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'llm', 1, 'm', 'hoteles:data_chat') as should_fail;
rollback;

\echo '27. cross-tenant: u1 no registra en la organizacion B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000b0e2', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'llm', 1, 'm', 'hoteles:data_chat') as should_fail;
rollback;

\echo '28. un usuario sin membresia no registra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e4', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000b0e1', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'llm', 1, 'm', 'hoteles:data_chat') as should_fail;
rollback;

\echo '29. anon no registra'
begin;
set local role anon;
select core.record_data_chat_query('00000000-0000-0000-0000-00000000b0e1', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'llm', 1, 'm', 'hoteles:data_chat') as should_fail;
rollback;

\echo '30. una ruta fuera de la lista se guarda como null en la sobrecarga nueva'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000b0e1', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'inventada', 1, 'm', 'hoteles:data_chat');
select count(*)::int as ruta_nula_deberia_ser_1 from core.data_chat_query_log where route is null and rol = 'hoteles:data_chat';
rollback;

\echo '=== TABLAS: sin acceso directo ==='
\echo '31. las tablas nuevas no se leen directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select count(*) as should_fail from core.llm_role_daily_turns;
rollback;

\echo '32. el tope por rol no se escribe directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
insert into core.llm_org_role_limit (organization_id, role, max_turnos_dia) values ('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 99999) returning 1 as should_fail;
rollback;

\echo '33. anon no lee la ventana horaria'
begin;
set local role anon;
select count(*) as should_fail from core.llm_usage_hourly;
rollback;

\echo '=== BACK OFFICE (superadmin) ==='
\echo '34. el superadmin ve el reporte por organizacion, rol y mes'
begin;
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-00000000b0e1', current_date, 'hoteles', 'hoteles:data_chat', 'openrouter:m', 'm', 'interactive', 500, 2),
  ('00000000-0000-0000-0000-00000000b0e1', current_date, 'plataforma', 'plataforma:titulos_resumenes', 'openrouter:m', 'm', 'background', 70, 1);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e3', true);
select count(*)::int as filas_deberia_ser_2 from core.get_llm_usage_by_org_role_month_for_superadmin('00000000-0000-0000-0000-00000000c0e3', current_date - 1, current_date + 1);
rollback;

\echo '35. un usuario que NO es superadmin recibe cero filas'
begin;
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-00000000b0e1', current_date, 'hoteles', 'hoteles:data_chat', 'openrouter:m', 'm', 'interactive', 500, 2);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select count(*)::int as sin_permiso_deberia_ser_0 from core.get_llm_usage_by_org_role_month_for_superadmin('00000000-0000-0000-0000-00000000c0e1', current_date - 1, current_date + 1);
rollback;

\echo '36. el superadmin no puede consultar con el id de otro (auth.uid() distinto de p_caller_id)'
begin;
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-00000000b0e1', current_date, 'hoteles', 'hoteles:data_chat', 'openrouter:m', 'm', 'interactive', 500, 2);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select count(*)::int as suplantado_deberia_ser_0 from core.get_llm_usage_by_org_role_month_for_superadmin('00000000-0000-0000-0000-00000000c0e3', current_date - 1, current_date + 1);
rollback;

\echo '37. anon no ve el reporte'
begin;
set local role anon;
select * from core.get_llm_usage_by_org_role_month_for_superadmin('00000000-0000-0000-0000-00000000c0e3', current_date - 1, current_date + 1) as should_fail;
rollback;

\echo '38. el superadmin fija un tope diario por rol y lo ve en la lista'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e3', true);
select core.set_llm_org_role_limit_for_superadmin('00000000-0000-0000-0000-00000000c0e3', '00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 30);
select count(*)::int as lista_deberia_ser_1 from core.list_llm_org_role_limits_for_superadmin('00000000-0000-0000-0000-00000000c0e3', '00000000-0000-0000-0000-00000000b0e1') where role = 'hoteles:data_chat' and max_turnos_dia = 30;
rollback;

\echo '39. quien no es superadmin NO fija el tope'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select core.set_llm_org_role_limit_for_superadmin('00000000-0000-0000-0000-00000000c0e1', '00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 30) as should_fail;
rollback;

\echo '40. un tope fuera de rango se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e3', true);
select core.set_llm_org_role_limit_for_superadmin('00000000-0000-0000-0000-00000000c0e3', '00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 0) as should_fail;
rollback;

\echo '41. la lista de topes por rol de un no superadmin viene vacia'
begin;
insert into core.llm_org_role_limit (organization_id, role, max_turnos_dia) values ('00000000-0000-0000-0000-00000000b0e1', 'hoteles:data_chat', 30);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c0e1', true);
select count(*)::int as lista_ajena_deberia_ser_0 from core.list_llm_org_role_limits_for_superadmin('00000000-0000-0000-0000-00000000c0e1', '00000000-0000-0000-0000-00000000b0e1');
rollback;

\echo '=== ESTRUCTURA ==='
\echo '42. ninguna funcion nueva es security definer sin search_path fijo'
begin;
select count(*)::int as sin_search_path_deberia_ser_0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'core' and p.prosecdef
   and p.proname in ('consume_llm_role_turn', 'record_llm_hour_window', 'get_llm_usage_by_org_role_month_for_superadmin', 'list_llm_org_role_limits_for_superadmin', 'set_llm_org_role_limit_for_superadmin', 'reserve_llm_monthly_budget')
   and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
rollback;

\echo '43. anon no tiene EXECUTE en ninguna funcion nueva'
begin;
select count(*)::int as anon_deberia_ser_0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'core'
   and p.proname in ('consume_llm_role_turn', 'record_llm_hour_window', 'get_llm_usage_by_org_role_month_for_superadmin', 'list_llm_org_role_limits_for_superadmin', 'set_llm_org_role_limit_for_superadmin', 'copiloto_subtope_pct')
   and has_function_privilege('anon', p.oid, 'execute');
rollback;
