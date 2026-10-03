-- Copiloto de superadmin (migracion 0048) -- verificacion contra Postgres REAL: bitacora de consultas con alcance de plataforma,
-- gasto mensual propio, reporte de uso y RLS de la conversacion de plataforma. Cada escenario corre en su propio
-- `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el valor esperado es N (ver
-- scripts/verify-real-postgres-ci/run-gate.mjs). Datos ficticios; nada envia mensajes.
-- Sesion de sistema = sin `set local role` ni claim (auth.uid() es null); usuario real = `set local role authenticated` + claim
-- `request.jwt.claim.sub`; anon = `set local role anon`.
-- Sujetos: s1 superadmin completo, s2 superadmin restringido a `finanzas`, s3 owner de la organizacion A (no superadmin), s4 staff sin
-- membresia. Organizaciones: A = restaurantes, B = hoteles.
-- Filas de bitacora sembradas: plataforma (s1, 1.000.000 micro-USD, ahora), plataforma (s2, 2.500.000, ahora), plataforma (s1, 9.000.000,
-- enero de 2020: fuera del mes), restaurantes (s3, organizacion A, 7.000.000, ahora).
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000a1601', 'restaurantes', 'Restaurante A', 'restaurante-a-copiloto-plat'),
  ('00000000-0000-0000-0000-0000000a1602', 'hoteles', 'Hotel B', 'hotel-b-copiloto-plat')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c1601', 'copiloto-plat-s1@example.com', 'S1', 'seed'),
  ('00000000-0000-0000-0000-0000000c1602', 'copiloto-plat-s2@example.com', 'S2', 'seed'),
  ('00000000-0000-0000-0000-0000000c1603', 'copiloto-plat-s3@example.com', 'S3', 'seed'),
  ('00000000-0000-0000-0000-0000000c1604', 'copiloto-plat-s4@example.com', 'S4', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c1603', '00000000-0000-0000-0000-0000000a1601', null, 'owner', 'owner')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000c1601'), ('00000000-0000-0000-0000-0000000c1602') on conflict do nothing;
insert into core.cfo_zone_role (staff_user_id, rol, assigned_by, reason) values
  ('00000000-0000-0000-0000-0000000c1602', 'finanzas', '00000000-0000-0000-0000-0000000c1601', 'Rol de solo lectura para la contadora externa del trimestre.')
on conflict do nothing;
insert into core.data_chat_query_log (organization_id, user_id, vertical, tool, outcome, row_count, duration_ms, route, costo_micro_usd, modelo, rol, created_at) values
  (null, '00000000-0000-0000-0000-0000000c1601', 'plataforma', 'organizaciones', 'ok', 3, 10, 'llm', 1000000, 'anthropic/claude-sonnet-5.5', 'superadmin:copiloto', now()),
  (null, '00000000-0000-0000-0000-0000000c1602', 'plataforma', 'mrr', 'ok', 1, 10, 'llm', 2500000, 'anthropic/claude-sonnet-5.5', 'superadmin:copiloto', now()),
  (null, '00000000-0000-0000-0000-0000000c1601', 'plataforma', 'organizaciones', 'ok', 3, 10, 'llm', 9000000, 'anthropic/claude-sonnet-5.5', 'superadmin:copiloto', '2020-01-15T12:00:00Z'),
  ('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000c1603', 'restaurantes', 'ventas_por_dia', 'ok', 5, 10, 'llm', 7000000, 'deepseek/deepseek-v4.1-flash', 'restaurantes:data_chat', now());

\echo '=== BITACORA: alcance de plataforma ==='
\echo '1. s1 (superadmin) registra una fila de plataforma: queda sin organizacion y con vertical plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select core.record_data_chat_query(null, 'organizaciones', '{}'::jsonb, 'ok', 3, 12, null, 'llm', 1234, 'anthropic/claude-sonnet-5.5', 'superadmin:copiloto');
reset role;
select count(*)::int as filas_plataforma_deberia_ser_3 from core.data_chat_query_log where vertical = 'plataforma' and organization_id is null and created_at > now() - interval '1 hour';
rollback;

\echo '2. el actor de la fila es auth.uid() y guarda costo, modelo y rol'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select core.record_data_chat_query(null, 'organizaciones', '{}'::jsonb, 'ok', 3, 12, null, 'llm', 1234, 'anthropic/claude-sonnet-5.5', 'superadmin:copiloto');
reset role;
select (count(*) = 1)::int as actor_costo_deberia_ser_1 from core.data_chat_query_log where user_id = '00000000-0000-0000-0000-0000000c1601' and costo_micro_usd = 1234 and modelo = 'anthropic/claude-sonnet-5.5' and rol = 'superadmin:copiloto' and vertical = 'plataforma' and row_count = 3;
rollback;

\echo '3. s2 (superadmin restringido a finanzas) tambien registra su consulta: su uso queda auditado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1602', true);
select core.record_data_chat_query(null, 'organizaciones', '{}'::jsonb, 'ok', 3, 12, null, 'llm', 1234, 'anthropic/claude-sonnet-5.5', 'superadmin:copiloto');
reset role;
select count(*)::int as filas_finanzas_deberia_ser_2 from core.data_chat_query_log where user_id = '00000000-0000-0000-0000-0000000c1602' and vertical = 'plataforma';
rollback;

\echo '4. s3 (owner de una organizacion, no superadmin) NO puede sembrar una fila de plataforma (42501)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1603', true);
select core.record_data_chat_query(null, 'x', '{}'::jsonb, 'ok', 0, 0, null, null, null, null, null) as should_fail;
rollback;

\echo '5. s4 (sin membresia ni superadmin) NO puede sembrar una fila de plataforma (42501)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1604', true);
select core.record_data_chat_query(null, 'x', '{}'::jsonb, 'ok', 0, 0, null, null, null, null, null) as should_fail;
rollback;

\echo '6. la sesion de sistema (auth.uid() nulo) no escribe en la bitacora de plataforma (28000)'
begin;
select core.record_data_chat_query(null, 'x', '{}'::jsonb, 'ok', 0, 0, null, null, null, null, null) as should_fail;
rollback;

\echo '7. anon no ejecuta core.record_data_chat_query'
begin;
set local role anon;
select core.record_data_chat_query(null, 'x', '{}'::jsonb, 'ok', 0, 0, null, null, null, null, null) as should_fail;
rollback;

\echo '8. s1 (superadmin sin membresia) NO puede registrar con la organizacion de un cliente (42501: la identidad de un tenant no se presta)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select core.record_data_chat_query('00000000-0000-0000-0000-0000000a1602', 'x', '{}'::jsonb, 'ok', 0, 0, null, null, null, null, null) as should_fail;
rollback;

\echo '9. s3 registra con su organizacion: la vertical sale de la organizacion y la fila lleva su organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1603', true);
select core.record_data_chat_query('00000000-0000-0000-0000-0000000a1601', 'ventas_por_dia', '{}'::jsonb, 'ok', 1, 5, null, 'llm', 10, 'm', 'restaurantes:data_chat');
reset role;
select count(*)::int as fila_org_deberia_ser_2 from core.data_chat_query_log where organization_id = '00000000-0000-0000-0000-0000000a1601' and vertical = 'restaurantes';
rollback;

\echo '10. CHECK: una fila con vertical plataforma no puede llevar organizacion'
begin;
insert into core.data_chat_query_log (organization_id, user_id, vertical, outcome) values ('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000c1601', 'plataforma', 'ok') returning 1 as should_fail;
rollback;

\echo '11. CHECK: una fila de cliente no puede omitir la organizacion'
begin;
insert into core.data_chat_query_log (organization_id, user_id, vertical, outcome) values (null, '00000000-0000-0000-0000-0000000c1601', 'restaurantes', 'ok') returning 1 as should_fail;
rollback;

\echo '12. CHECK: una vertical desconocida se rechaza'
begin;
insert into core.data_chat_query_log (organization_id, user_id, vertical, outcome) values (null, '00000000-0000-0000-0000-0000000c1601', 'otra', 'ok') returning 1 as should_fail;
rollback;

\echo '13. authenticated no inserta directo en la bitacora (sin GRANT)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
insert into core.data_chat_query_log (organization_id, user_id, vertical, outcome) values (null, '00000000-0000-0000-0000-0000000c1601', 'plataforma', 'ok') returning 1 as should_fail;
rollback;

\echo '14. la bitacora sigue siendo append-only tambien para las filas de plataforma (UPDATE bloqueado)'
begin;
update core.data_chat_query_log set outcome = 'error' where vertical = 'plataforma' returning 1 as should_fail;
rollback;

\echo '15. la bitacora sigue siendo append-only tambien para las filas de plataforma (DELETE bloqueado)'
begin;
delete from core.data_chat_query_log where vertical = 'plataforma' returning 1 as should_fail;
rollback;

\echo '16. RLS: el owner de una organizacion no ve ninguna fila de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1603', true);
select count(*)::int as plataforma_visible_a_owner_deberia_ser_0 from core.data_chat_query_log where vertical = 'plataforma';
rollback;

\echo '17. RLS: ni el superadmin lee directo la bitacora de plataforma (solo por las funciones definer)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select count(*)::int as plataforma_directo_deberia_ser_0 from core.data_chat_query_log where vertical = 'plataforma';
rollback;

\echo '18. RLS: el owner sigue viendo SU bitacora de organizacion como antes (1 fila sembrada)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1603', true);
select count(*)::int as bitacora_propia_deberia_ser_1 from core.data_chat_query_log where organization_id = '00000000-0000-0000-0000-0000000a1601';
rollback;

\echo '=== GASTO MENSUAL DEL COPILOTO DE PLATAFORMA ==='
\echo '19. s1 mide el gasto del mes: suma solo las filas de plataforma del mes en curso (1.000.000 + 2.500.000; ni la de 2020 ni la de un cliente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select (core.get_copiloto_plataforma_gasto_mes('00000000-0000-0000-0000-0000000c1601') = 3500000)::int as gasto_deberia_ser_1;
rollback;

\echo '20. s2 (finanzas) tambien lo mide: el motor topa el gasto antes de cada turno de cualquiera de los dos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1602', true);
select (core.get_copiloto_plataforma_gasto_mes('00000000-0000-0000-0000-0000000c1602') = 3500000)::int as gasto_finanzas_deberia_ser_1;
rollback;

\echo '21. s3 (no superadmin) recibe 0: ni confirma ni niega el gasto de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1603', true);
select core.get_copiloto_plataforma_gasto_mes('00000000-0000-0000-0000-0000000c1603')::int as gasto_ajeno_deberia_ser_0;
rollback;

\echo '22. caller-binding: s1 no mide el gasto con la identidad de otro superadmin (p_caller_id distinto de auth.uid())'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select core.get_copiloto_plataforma_gasto_mes('00000000-0000-0000-0000-0000000c1602')::int as gasto_suplantado_deberia_ser_0;
rollback;

\echo '23. la sesion de sistema recibe 0'
begin;
select core.get_copiloto_plataforma_gasto_mes('00000000-0000-0000-0000-0000000c1601')::int as gasto_sistema_deberia_ser_0;
rollback;

\echo '24. anon no ejecuta core.get_copiloto_plataforma_gasto_mes'
begin;
set local role anon;
select core.get_copiloto_plataforma_gasto_mes('00000000-0000-0000-0000-0000000c1601') as should_fail;
rollback;

\echo '=== REPORTE DE USO DEL COPILOTO ==='
\echo '25. s1 (superadmin completo) ve el uso agregado: 3 consultas del mes (2 de plataforma y 1 de restaurantes), la de 2020 queda fuera del rango'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select coalesce(sum(consultas), 0)::int as consultas_deberia_ser_3 from core.get_copiloto_uso_for_superadmin('00000000-0000-0000-0000-0000000c1601', (current_date - 30), current_date);
rollback;

\echo '26. el costo agregado de plataforma en el rango es 3.500.000'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select (coalesce(sum(costo_micro_usd), 0) = 3500000)::int as costo_plataforma_deberia_ser_1 from core.get_copiloto_uso_for_superadmin('00000000-0000-0000-0000-0000000c1601', (current_date - 30), current_date) where vertical = 'plataforma';
rollback;

\echo '27. s2 (finanzas) NO ve el uso del Copiloto (cero filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1602', true);
select count(*)::int as uso_finanzas_deberia_ser_0 from core.get_copiloto_uso_for_superadmin('00000000-0000-0000-0000-0000000c1602', (current_date - 30), current_date);
rollback;

\echo '28. s3 (no superadmin) no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1603', true);
select count(*)::int as uso_ajeno_deberia_ser_0 from core.get_copiloto_uso_for_superadmin('00000000-0000-0000-0000-0000000c1603', (current_date - 30), current_date);
rollback;

\echo '29. caller-binding: s1 no lee el uso con la identidad de otro'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select count(*)::int as uso_suplantado_deberia_ser_0 from core.get_copiloto_uso_for_superadmin('00000000-0000-0000-0000-0000000c1602', (current_date - 30), current_date);
rollback;

\echo '30. un rango de mas de 366 dias devuelve cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select count(*)::int as uso_rango_largo_deberia_ser_0 from core.get_copiloto_uso_for_superadmin('00000000-0000-0000-0000-0000000c1601', (current_date - 400), current_date);
rollback;

\echo '31. anon no ejecuta core.get_copiloto_uso_for_superadmin'
begin;
set local role anon;
select * from core.get_copiloto_uso_for_superadmin('00000000-0000-0000-0000-0000000c1601', (current_date - 30), current_date) as should_fail;
rollback;

\echo '=== CONVERSACION DE PLATAFORMA: RLS y escritura ==='
\echo '32. s1 abre una conversacion de plataforma: scope plataforma, vertical plataforma, sin organizacion, 2 mensajes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select * from core.append_data_chat_turn(null, null, null, 'Cuantas organizaciones hay', 'Hay 2 organizaciones.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
reset role;
select (count(*) = 1)::int as conv_plataforma_deberia_ser_1 from core.data_chat_conversation c where c.user_id = '00000000-0000-0000-0000-0000000c1601' and c.scope = 'plataforma' and c.vertical = 'plataforma' and c.organization_id is null and c.message_count = 2;
rollback;

\echo '33. s2 (finanzas, superadmin restringido) puede guardar su propia conversacion de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1602', true);
select * from core.append_data_chat_turn(null, null, null, 'Cuantas organizaciones hay', 'Hay 2 organizaciones.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
reset role;
select count(*)::int as conv_finanzas_deberia_ser_1 from core.data_chat_conversation c where c.user_id = '00000000-0000-0000-0000-0000000c1602' and c.scope = 'plataforma';
rollback;

\echo '34. s3 (owner de una organizacion, no superadmin) no abre conversaciones de plataforma (42501)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1603', true);
select * from core.append_data_chat_turn(null, null, null, 'x', 'y', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '35. la sesion de sistema no abre conversaciones de plataforma (28000)'
begin;
select * from core.append_data_chat_turn(null, null, null, 'x', 'y', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '36. RLS: s1 lee su conversacion de plataforma recien creada (1)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select * from core.append_data_chat_turn(null, null, null, 'Cuantas organizaciones hay', 'Hay 2 organizaciones.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select count(*)::int as lee_propia_deberia_ser_1 from core.data_chat_conversation where scope = 'plataforma';
rollback;

\echo '37. RLS: s2 NO lee las conversaciones de plataforma de s1 (solo el autor las ve), aunque ambos sean superadmin'
begin;
insert into core.data_chat_conversation (id, scope, organization_id, vertical, user_id, title, message_count) values ('00000000-0000-0000-0000-0000000e1601', 'plataforma', null, 'plataforma', '00000000-0000-0000-0000-0000000c1601', 'De s1', 2);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1602', true);
select count(*)::int as ajena_deberia_ser_0 from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e1601';
rollback;

\echo '38. RLS: el owner de una organizacion no lee conversaciones de plataforma'
begin;
insert into core.data_chat_conversation (id, scope, organization_id, vertical, user_id, title, message_count) values ('00000000-0000-0000-0000-0000000e1601', 'plataforma', null, 'plataforma', '00000000-0000-0000-0000-0000000c1601', 'De s1', 2);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1603', true);
select count(*)::int as owner_no_lee_deberia_ser_0 from core.data_chat_conversation where scope = 'plataforma';
rollback;

\echo '39. s2 no continua la conversacion de plataforma de s1 (P0002: indistinguible de inexistente)'
begin;
insert into core.data_chat_conversation (id, scope, organization_id, vertical, user_id, title, message_count) values ('00000000-0000-0000-0000-0000000e1601', 'plataforma', null, 'plataforma', '00000000-0000-0000-0000-0000000c1601', 'De s1', 2);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1602', true);
select * from core.append_data_chat_turn(null, null, '00000000-0000-0000-0000-0000000e1601', 'x', 'y', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '40. una conversacion de plataforma no lleva propiedad (22023)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1601', true);
select * from core.append_data_chat_turn(null, '00000000-0000-0000-0000-00000000b999', null, 'x', 'y', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '=== ESTRUCTURA ==='
\echo '41. las tres funciones nuevas o reescritas son security definer con search_path fijo'
begin;
select count(*)::int as search_path_deberia_ser_3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core' and p.proname in ('record_data_chat_query', 'get_copiloto_plataforma_gasto_mes', 'get_copiloto_uso_for_superadmin') and p.prosecdef
  and p.pronargs in (11, 1, 3)
  and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=core, pg_temp');
rollback;

\echo 'anon y PUBLIC no tienen EXECUTE sobre las tres funciones (ni la de 11 argumentos reescrita)'
begin;
select count(*)::int as anon_o_public_deberia_ser_0
from pg_proc p
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where p.oid in (
  'core.record_data_chat_query(uuid,text,jsonb,text,integer,integer,text,text,bigint,text,text)'::regprocedure,
  'core.get_copiloto_plataforma_gasto_mes(uuid)'::regprocedure,
  'core.get_copiloto_uso_for_superadmin(uuid,date,date)'::regprocedure)
  and (a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname = 'anon'));
rollback;

\echo '44. RLS sigue activa en la bitacora y ninguna policy usa true'
begin;
select count(*)::int as rls_o_true_deberia_ser_1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'core' and c.relname = 'data_chat_query_log' and c.relrowsecurity
  and not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'data_chat_query_log' and (qual = 'true' or with_check = 'true'));
rollback;

\echo 'core.llm_usage_daily NO se toco: ningun CHECK suyo menciona plataforma (decision documentada: el gasto del Copiloto de plataforma se mide en la bitacora)'
begin;
select count(*)::int as llm_usage_sin_plataforma_deberia_ser_0 from pg_constraint
where conrelid = 'core.llm_usage_daily'::regclass and pg_get_constraintdef(oid) like '%plataforma%';
rollback;

\echo 'Fin: todos los escenarios *_deberia_ser_N deben devolver N y los should_fail deben terminar en ERROR.'
