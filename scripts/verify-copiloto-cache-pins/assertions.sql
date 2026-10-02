-- Copiloto: cache de resultados, ruta en la bitacora y fijados (migracion 0045) -- verificacion contra Postgres REAL.
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias
-- `..._deberia_ser_N` = el valor esperado (ver scripts/verify-real-postgres-ci/run-gate.mjs). Datos ficticios.
-- Sesion de sistema = sin `set local role` ni claim (auth.uid() es null); usuario real = `set local role authenticated` +
-- claim `request.jwt.claim.sub`.
-- Sujetos: u1 owner de A, u2 member de A (recepcion), u3 admin de A, u4 owner de B, u5 viewer de A, u6 sin membresia.
-- A = hoteles, B = restaurantes. Fijados sembrados: p1 (u1 privado), p2 (u1 compartido), p3 (u2 compartido, NO admin),
-- p4 (u2 privado), p5 (u4 compartido en B).
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a0e1', 'hoteles', 'Hotel A', 'hotel-a-pins'),
  ('00000000-0000-0000-0000-00000000a0e2', 'restaurantes', 'Restaurante B', 'restaurante-b-pins')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000d0e1', 'pins-u1@example.com', 'U1', 'seed'),
  ('00000000-0000-0000-0000-00000000d0e2', 'pins-u2@example.com', 'U2', 'seed'),
  ('00000000-0000-0000-0000-00000000d0e3', 'pins-u3@example.com', 'U3', 'seed'),
  ('00000000-0000-0000-0000-00000000d0e4', 'pins-u4@example.com', 'U4', 'seed'),
  ('00000000-0000-0000-0000-00000000d0e5', 'pins-u5@example.com', 'U5', 'seed'),
  ('00000000-0000-0000-0000-00000000d0e6', 'pins-u6@example.com', 'U6', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000d0e1', '00000000-0000-0000-0000-00000000a0e1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000d0e2', '00000000-0000-0000-0000-00000000a0e1', null, 'member', 'recepcion'),
  ('00000000-0000-0000-0000-00000000d0e3', '00000000-0000-0000-0000-00000000a0e1', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-00000000d0e4', '00000000-0000-0000-0000-00000000a0e2', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000d0e5', '00000000-0000-0000-0000-00000000a0e1', null, 'viewer', 'recepcion')
on conflict do nothing;
insert into core.data_chat_conversation (id, scope, organization_id, vertical, user_id, title, message_count) values
  ('00000000-0000-0000-0000-0000000e0e01', 'vertical', '00000000-0000-0000-0000-00000000a0e1', 'hoteles', '00000000-0000-0000-0000-00000000d0e1', 'Conversacion de u1', 2),
  ('00000000-0000-0000-0000-0000000e0e02', 'vertical', '00000000-0000-0000-0000-00000000a0e1', 'hoteles', '00000000-0000-0000-0000-00000000d0e2', 'Conversacion de u2', 2);
insert into core.copiloto_pin (id, organization_id, vertical, author_id, tool, args, title, shared) values
  ('00000000-0000-0000-0000-0000000f0e01', '00000000-0000-0000-0000-00000000a0e1', 'hoteles', '00000000-0000-0000-0000-00000000d0e1', 'ocupacion_adr_revpar', '{"periodo":"ultimos_30_dias"}', 'Ocupacion 30 dias', false),
  ('00000000-0000-0000-0000-0000000f0e02', '00000000-0000-0000-0000-00000000a0e1', 'hoteles', '00000000-0000-0000-0000-00000000d0e1', 'ingresos_por_periodo', '{"periodo":"este_mes"}', 'Ingresos del mes', true),
  ('00000000-0000-0000-0000-0000000f0e03', '00000000-0000-0000-0000-00000000a0e1', 'hoteles', '00000000-0000-0000-0000-00000000d0e2', 'cancelaciones', '{"periodo":"este_mes"}', 'Cancelaciones', true),
  ('00000000-0000-0000-0000-0000000f0e04', '00000000-0000-0000-0000-00000000a0e1', 'hoteles', '00000000-0000-0000-0000-00000000d0e2', 'tickets_abiertos_sla', '{}', 'Tickets', false),
  ('00000000-0000-0000-0000-0000000f0e05', '00000000-0000-0000-0000-00000000a0e2', 'restaurantes', '00000000-0000-0000-0000-00000000d0e4', 'ventas_por_dia', '{"periodo":"hoy"}', 'Ventas de hoy', true);

\echo '=== CACHE: solo sesion de sistema ==='
\echo '1. sistema: put y get devuelven el valor guardado'
begin;
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '{"status":"ok","rows":[]}'::jsonb, 300);
select (core.data_chat_cache_get('dchat:v1:0123456789abcdef') ->> 'status' = 'ok')::int as get_tras_put_deberia_ser_1;
rollback;

\echo '2. una entrada vencida no se devuelve'
begin;
insert into core.data_chat_cache (cache_key, organization_id, value, expires_at) values ('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '{"status":"ok"}', now() - interval '1 second');
select (core.data_chat_cache_get('dchat:v1:0123456789abcdef') is not null)::int as vencida_deberia_ser_0;
rollback;

\echo '3. una clave inexistente devuelve null'
begin;
select (core.data_chat_cache_get('dchat:v1:no-existe-nunca') is not null)::int as inexistente_deberia_ser_0;
rollback;

\echo '4. el TTL se acota a 24 horas'
begin;
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '{"status":"ok"}'::jsonb, 99999999);
select (expires_at <= now() + interval '24 hours 1 minute')::int as ttl_acotado_deberia_ser_1 from core.data_chat_cache where cache_key = 'dchat:v1:0123456789abcdef';
rollback;

\echo '5. el TTL minimo es de 1 segundo (un TTL negativo no crea una entrada eterna)'
begin;
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '{"status":"ok"}'::jsonb, -50);
select (expires_at <= now() + interval '2 seconds')::int as ttl_minimo_deberia_ser_1 from core.data_chat_cache where cache_key = 'dchat:v1:0123456789abcdef';
rollback;

\echo '6. put repetido con la misma clave reemplaza el valor (una sola fila)'
begin;
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '{"v":1}'::jsonb, 300);
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '{"v":2}'::jsonb, 300);
select count(*)::int as filas_deberia_ser_1 from core.data_chat_cache where cache_key = 'dchat:v1:0123456789abcdef' and value ->> 'v' = '2';
rollback;

\echo '7. la purga quita lo vencido y deja lo vigente'
begin;
insert into core.data_chat_cache (cache_key, organization_id, value, expires_at) values ('dchat:v1:vencida0001', '00000000-0000-0000-0000-00000000a0e1', '{}', now() - interval '1 hour'), ('dchat:v1:vigente0001', '00000000-0000-0000-0000-00000000a0e1', '{}', now() + interval '1 hour');
select core.data_chat_cache_purge();
select count(*)::int as restantes_deberia_ser_1 from core.data_chat_cache;
rollback;

\echo '8. put rechaza un valor que no es objeto'
begin;
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '[1,2]'::jsonb, 300) as should_fail;
rollback;

\echo '9. put rechaza un valor de mas de 64 KB'
begin;
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', jsonb_build_object('x', repeat(md5(random()::text), 3000)), 300) as should_fail;
rollback;

\echo '10. put rechaza una organizacion inexistente'
begin;
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000dead', '{}'::jsonb, 300) as should_fail;
rollback;

\echo '11. un usuario autenticado NO puede leer la cache'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.data_chat_cache_get('dchat:v1:0123456789abcdef') as should_fail;
rollback;

\echo '12. un usuario autenticado NO puede sembrar la cache'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '{}'::jsonb, 300) as should_fail;
rollback;

\echo '13. un usuario autenticado NO puede purgar la cache'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.data_chat_cache_purge() as should_fail;
rollback;

\echo '14. anon no puede leer la cache'
begin;
set local role anon;
select core.data_chat_cache_get('dchat:v1:0123456789abcdef') as should_fail;
rollback;

\echo '15. anon no puede sembrar la cache'
begin;
set local role anon;
select core.data_chat_cache_put('dchat:v1:0123456789abcdef', '00000000-0000-0000-0000-00000000a0e1', '{}'::jsonb, 300) as should_fail;
rollback;

\echo '16. la tabla de cache no se lee de forma directa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select count(*) as should_fail from core.data_chat_cache;
rollback;

\echo '17. la tabla de cache no se escribe de forma directa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
insert into core.data_chat_cache (cache_key, organization_id, value, expires_at) values ('dchat:v1:directa0001', '00000000-0000-0000-0000-00000000a0e1', '{}', now() + interval '1 hour') returning 1 as should_fail;
rollback;

\echo '=== BITACORA: ruta ==='
\echo '18. u1 registra una consulta con ruta 'cache''
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000a0e1', 'ocupacion_adr_revpar', '{"periodo":"hoy"}'::jsonb, 'ok', 3, 12, null, 'cache');
select count(*)::int as ruta_cache_deberia_ser_1 from core.data_chat_query_log where route = 'cache' and user_id = '00000000-0000-0000-0000-00000000d0e1';
rollback;

\echo '19. una ruta desconocida se guarda como null'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000a0e1', 'ocupacion_adr_revpar', '{}'::jsonb, 'ok', 3, 12, null, 'inventada');
select count(*)::int as ruta_nula_deberia_ser_1 from core.data_chat_query_log where route is null and user_id = '00000000-0000-0000-0000-00000000d0e1';
rollback;

\echo '20. la sobrecarga de 7 argumentos sigue funcionando (compatibilidad)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000a0e1', 'ocupacion_adr_revpar', '{}'::jsonb, 'ok', 3, 12, null);
select count(*)::int as sin_ruta_deberia_ser_1 from core.data_chat_query_log where route is null and user_id = '00000000-0000-0000-0000-00000000d0e1';
rollback;

\echo '21. la sesion de sistema no escribe la bitacora con ruta'
begin;
select core.record_data_chat_query('00000000-0000-0000-0000-00000000a0e1', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'directa') as should_fail;
rollback;

\echo '22. un usuario sin membresia no escribe la bitacora con ruta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e6', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000a0e1', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'directa') as should_fail;
rollback;

\echo '23. cross-tenant: el owner de A no escribe en la bitacora de B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000a0e2', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'directa') as should_fail;
rollback;

\echo '24. anon no escribe la bitacora con ruta'
begin;
set local role anon;
select core.record_data_chat_query('00000000-0000-0000-0000-00000000a0e1', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'directa') as should_fail;
rollback;

\echo '25. la bitacora sigue siendo append-only (la columna nueva no se edita)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.record_data_chat_query('00000000-0000-0000-0000-00000000a0e1', 'x', '{}'::jsonb, 'ok', 0, 0, null, 'llm');
update core.data_chat_query_log set route = 'directa' where user_id = '00000000-0000-0000-0000-00000000d0e1' returning 1 as should_fail;
rollback;

\echo '=== FIJADOS: visibilidad (RLS) ==='
\echo '26. u1 (owner de A) ve sus 2 fijados; el compartido de u2 (no admin) NO se ve'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select count(*)::int as visibles_deberia_ser_2 from core.copiloto_pin;
rollback;

\echo '27. u2 (member de A) ve los suyos y el compartido por el owner, no el privado de u1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e2', true);
select count(*)::int as visibles_deberia_ser_3 from core.copiloto_pin;
rollback;

\echo '28. u2 NO ve el fijado privado de u1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e2', true);
select count(*)::int as privado_ajeno_deberia_ser_0 from core.copiloto_pin where id = '00000000-0000-0000-0000-0000000f0e01';
rollback;

\echo '29. u3 (admin de A) ve solo lo compartido por admins/owners (p2)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e3', true);
select count(*)::int as compartidos_deberia_ser_1 from core.copiloto_pin;
rollback;

\echo '30. u5 (viewer de A) ve el compartido por el owner'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e5', true);
select count(*)::int as viewer_deberia_ser_1 from core.copiloto_pin;
rollback;

\echo '31. cross-tenant: u4 (owner de B) solo ve lo de B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e4', true);
select count(*)::int as solo_b_deberia_ser_1 from core.copiloto_pin;
rollback;

\echo '32. un usuario sin membresia no ve ningun fijado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e6', true);
select count(*)::int as sin_membresia_deberia_ser_0 from core.copiloto_pin;
rollback;

\echo '33. anon no lee fijados'
begin;
set local role anon;
select count(*) as should_fail from core.copiloto_pin;
rollback;

\echo '34. si degradan al autor, sus compartidos dejan de verse'
begin;
update core.membership set platform_role = 'member' where user_id = '00000000-0000-0000-0000-00000000d0e1' and organization_id = '00000000-0000-0000-0000-00000000a0e1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e3', true);
select count(*)::int as degradado_deberia_ser_0 from core.copiloto_pin;
rollback;

\echo '35. una membresia revocada ya no ve ni sus propios fijados'
begin;
delete from core.membership where user_id = '00000000-0000-0000-0000-00000000d0e2' and organization_id = '00000000-0000-0000-0000-00000000a0e1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e2', true);
select count(*)::int as revocada_deberia_ser_0 from core.copiloto_pin;
rollback;

\echo '=== FIJADOS: alta (core.copiloto_pin_create) ==='
\echo '36. u1 fija un resultado de su conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', '00000000-0000-0000-0000-0000000e0e01', 2, 0, 'cancelaciones', '{"periodo":"este_mes"}'::jsonb, 'Cancelaciones del mes');
select count(*)::int as fijados_deberia_ser_3 from core.copiloto_pin where author_id = '00000000-0000-0000-0000-00000000d0e1';
rollback;

\echo '37. la vertical sale de la organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', '{}'::jsonb, 'x');
select count(*)::int as vertical_deberia_ser_1 from core.copiloto_pin where author_id = '00000000-0000-0000-0000-00000000d0e1' and tool = 'cancelaciones' and vertical = 'hoteles';
rollback;

\echo '38. un fijado repetido (misma herramienta y argumentos) no se duplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'ocupacion_adr_revpar', '{"periodo":"ultimos_30_dias"}'::jsonb, 'otro titulo');
select count(*)::int as sin_duplicar_deberia_ser_1 from core.copiloto_pin where author_id = '00000000-0000-0000-0000-00000000d0e1' and tool = 'ocupacion_adr_revpar';
rollback;

\echo '39. la sesion de sistema no fija'
begin;
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', '{}'::jsonb, 'x') as should_fail;
rollback;

\echo '40. un usuario sin membresia no fija'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e6', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', '{}'::jsonb, 'x') as should_fail;
rollback;

\echo '41. cross-tenant: el owner de A no fija en B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e2', null, null, null, 'ventas_por_dia', '{}'::jsonb, 'x') as should_fail;
rollback;

\echo '42. anon no fija'
begin;
set local role anon;
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', '{}'::jsonb, 'x') as should_fail;
rollback;

\echo '43. no se fija desde la conversacion de otro usuario'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', '00000000-0000-0000-0000-0000000e0e02', 2, 0, 'cancelaciones', '{}'::jsonb, 'x') as should_fail;
rollback;

\echo '44. nombre de herramienta invalido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'Mala Herramienta; drop', '{}'::jsonb, 'x') as should_fail;
rollback;

\echo '45. argumentos que no son un objeto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', '[1]'::jsonb, 'x') as should_fail;
rollback;

\echo '46. titulo vacio'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', '{}'::jsonb, '   ') as should_fail;
rollback;

\echo '47. tope de 50 fijados por autor y organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', jsonb_build_object('n', g), 'p') from generate_series(1, 48) g;
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', '{"n":999}'::jsonb, 'p') as should_fail;
rollback;

\echo '48. el tope no cuenta fijados de otra organizacion ni de otro autor'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
select core.copiloto_pin_create('00000000-0000-0000-0000-00000000a0e1', null, null, null, 'cancelaciones', jsonb_build_object('n', g), 'p') from generate_series(1, 47) g;
select count(*)::int as bajo_el_tope_deberia_ser_49 from core.copiloto_pin where author_id = '00000000-0000-0000-0000-00000000d0e1';
rollback;

\echo '49. no hay INSERT directo para authenticated'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
insert into core.copiloto_pin (organization_id, vertical, author_id, tool, title) values ('00000000-0000-0000-0000-00000000a0e1', 'hoteles', '00000000-0000-0000-0000-00000000d0e1', 'cancelaciones', 'x') returning 1 as should_fail;
rollback;

\echo '=== FIJADOS: compartir, renombrar y borrar ==='
\echo '50. el owner comparte su fijado privado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
with u as (update core.copiloto_pin set shared = true where id = '00000000-0000-0000-0000-0000000f0e01' returning 1)
select count(*)::int as compartidos_deberia_ser_1 from u;
rollback;

\echo '51. u2 (member, no admin) NO puede compartir su fijado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e2', true);
update core.copiloto_pin set shared = true where id = '00000000-0000-0000-0000-0000000f0e04' returning 1 as should_fail;
rollback;

\echo '52. u2 puede dejar de compartir el suyo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e2', true);
with u as (update core.copiloto_pin set shared = false where id = '00000000-0000-0000-0000-0000000f0e03' returning 1)
select count(*)::int as descompartidos_deberia_ser_1 from u;
rollback;

\echo '53. el autor renombra su fijado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
with u as (update core.copiloto_pin set title = 'Nuevo titulo' where id = '00000000-0000-0000-0000-0000000f0e01' returning 1)
select count(*)::int as renombrados_deberia_ser_1 from u;
rollback;

\echo '54. nadie renombra el fijado de otro (la RLS filtra, 0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
with u as (update core.copiloto_pin set title = 'x' where id = '00000000-0000-0000-0000-0000000f0e03' returning 1)
select count(*)::int as ajenos_deberia_ser_0 from u;
rollback;

\echo '55. el admin tampoco edita el fijado compartido de otro'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e3', true);
with u as (update core.copiloto_pin set shared = false where id = '00000000-0000-0000-0000-0000000f0e02' returning 1)
select count(*)::int as admin_ajeno_deberia_ser_0 from u;
rollback;

\echo '56. titulo vacio se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
update core.copiloto_pin set title = '' where id = '00000000-0000-0000-0000-0000000f0e01' returning 1 as should_fail;
rollback;

\echo '57. el cliente no puede cambiar la herramienta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
update core.copiloto_pin set tool = 'otra' where id = '00000000-0000-0000-0000-0000000f0e01' returning 1 as should_fail;
rollback;

\echo '58. el cliente no puede cambiar los argumentos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
update core.copiloto_pin set args = '{}' where id = '00000000-0000-0000-0000-0000000f0e01' returning 1 as should_fail;
rollback;

\echo '59. el cliente no puede mover el fijado a otro autor'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
update core.copiloto_pin set author_id = '00000000-0000-0000-0000-00000000d0e2' where id = '00000000-0000-0000-0000-0000000f0e01' returning 1 as should_fail;
rollback;

\echo '60. el cliente no puede cambiar la organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
update core.copiloto_pin set organization_id = '00000000-0000-0000-0000-00000000a0e2' where id = '00000000-0000-0000-0000-0000000f0e01' returning 1 as should_fail;
rollback;

\echo '61. anon no edita'
begin;
set local role anon;
update core.copiloto_pin set title = 'x' where id = '00000000-0000-0000-0000-0000000f0e01' returning 1 as should_fail;
rollback;

\echo '62. el autor borra su fijado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
with d as (delete from core.copiloto_pin where id = '00000000-0000-0000-0000-0000000f0e01' returning 1)
select count(*)::int as borrados_deberia_ser_1 from d;
rollback;

\echo '63. nadie borra el fijado de otro (0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e3', true);
with d as (delete from core.copiloto_pin where id = '00000000-0000-0000-0000-0000000f0e02' returning 1)
select count(*)::int as ajenos_deberia_ser_0 from d;
rollback;

\echo '64. cross-tenant: el owner de A no borra el fijado de B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000d0e1', true);
with d as (delete from core.copiloto_pin where id = '00000000-0000-0000-0000-0000000f0e05' returning 1)
select count(*)::int as cross_deberia_ser_0 from d;
rollback;

\echo '65. borrar la conversacion de origen conserva el fijado (set null)'
begin;
insert into core.copiloto_pin (id, organization_id, vertical, author_id, conversation_id, tool, args, title) values ('00000000-0000-0000-0000-0000000f0e99', '00000000-0000-0000-0000-00000000a0e1', 'hoteles', '00000000-0000-0000-0000-00000000d0e1', '00000000-0000-0000-0000-0000000e0e01', 'x', '{}', 't');
delete from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0e01';
select count(*)::int as conserva_deberia_ser_1 from core.copiloto_pin where id = '00000000-0000-0000-0000-0000000f0e99' and conversation_id is null;
rollback;

\echo '66. anon no borra'
begin;
set local role anon;
delete from core.copiloto_pin where id = '00000000-0000-0000-0000-0000000f0e01' returning 1 as should_fail;
rollback;

\echo '=== ESTRUCTURA ==='
\echo '67. RLS activa en cache y fijados'
begin;
select count(*)::int as rls_deberia_ser_2 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'core' and c.relname in ('data_chat_cache', 'copiloto_pin') and c.relrowsecurity;
rollback;

\echo '68. la cache no tiene ninguna policy (deny-by-default)'
begin;
select count(*)::int as policies_cache_deberia_ser_0 from pg_policies where schemaname = 'core' and tablename = 'data_chat_cache';
rollback;

\echo '69. ninguna policy de fijados usa true como condicion'
begin;
select count(*)::int as policies_true_deberia_ser_0 from pg_policies where schemaname = 'core' and tablename = 'copiloto_pin' and (qual = 'true' or with_check = 'true');
rollback;

\echo '70. anon no tiene ningun privilegio sobre las tablas nuevas'
begin;
select count(*)::int as anon_deberia_ser_0 from information_schema.table_privileges where table_schema = 'core' and table_name in ('data_chat_cache', 'copiloto_pin') and grantee in ('anon', 'PUBLIC');
rollback;

\echo '71. authenticated no tiene ningun privilegio sobre la cache'
begin;
select count(*)::int as auth_cache_deberia_ser_0 from information_schema.table_privileges where table_schema = 'core' and table_name = 'data_chat_cache' and grantee in ('authenticated', 'service_role');
rollback;

\echo '72. authenticated no tiene INSERT sobre fijados'
begin;
select count(*)::int as insert_deberia_ser_0 from information_schema.table_privileges where table_schema = 'core' and table_name = 'copiloto_pin' and grantee in ('authenticated', 'service_role', 'anon') and privilege_type = 'INSERT';
rollback;

\echo '73. las unicas columnas actualizables de fijados son title y shared'
begin;
select count(*)::int as columnas_deberia_ser_2 from information_schema.column_privileges where table_schema = 'core' and table_name = 'copiloto_pin' and grantee = 'authenticated' and privilege_type = 'UPDATE';
rollback;

\echo '74. las funciones definer nuevas fijan search_path'
begin;
select count(*)::int as search_path_deberia_ser_7 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.prosecdef and p.proname in ('data_chat_cache_get', 'data_chat_cache_put', 'data_chat_cache_purge', 'copiloto_pin_create', 'copiloto_pin_author_is_admin', 'record_data_chat_query') and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=core, pg_temp');
rollback;

\echo '75. anon no puede ejecutar ninguna funcion nueva'
begin;
select count(*)::int as exec_anon_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.proname in ('data_chat_cache_get', 'data_chat_cache_put', 'data_chat_cache_purge', 'copiloto_pin_create', 'copiloto_pin_author_is_admin') and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo 'Fin: todos los escenarios *_deberia_ser_N deben devolver N y los should_fail deben terminar en ERROR.'
