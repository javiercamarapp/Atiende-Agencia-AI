-- Copiloto: valoraciones «Útil / No fue útil» (migracion 0076) -- verificacion contra Postgres REAL de core.data_chat_feedback y de
-- core.data_chat_feedback_resumen / core.superadmin_data_chat_feedback_resumen. Cada escenario corre en su propio `begin; ... rollback;`.
-- Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el valor esperado (scripts/verify-real-postgres-ci/run-gate.mjs).
-- Sesion de sistema = sin `set local role` ni claim (auth.uid() null); usuario real = `set local role authenticated` + claim.
-- Sujetos: v1 owner de A, v2 member de A, v3 owner de B, v4 superadmin sin membresia, v6 sin membresia, v7 admin de A.
-- A = hoteles, B = restaurantes. Conversaciones: q1 (v1, A), q2 (v2, A), q3 (v3, B), q4 (v4, plataforma). Mensaje 2 = asistente.
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a7d1', 'hoteles', 'Hotel A valoraciones', 'hotel-a-valoraciones'),
  ('00000000-0000-0000-0000-00000000a7d2', 'restaurantes', 'Restaurante B valoraciones', 'restaurante-b-valoraciones')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0001', 'valora-v1@example.com', 'V1', 'seed'),
  ('00000000-0000-0000-0000-0000000f0002', 'valora-v2@example.com', 'V2', 'seed'),
  ('00000000-0000-0000-0000-0000000f0003', 'valora-v3@example.com', 'V3', 'seed'),
  ('00000000-0000-0000-0000-0000000f0004', 'valora-v4@example.com', 'V4', 'seed'),
  ('00000000-0000-0000-0000-0000000f0006', 'valora-v6@example.com', 'V6', 'seed'),
  ('00000000-0000-0000-0000-0000000f0007', 'valora-v7@example.com', 'V7', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-00000000a7d1', null, 'member', 'recepcion'),
  ('00000000-0000-0000-0000-0000000f0003', '00000000-0000-0000-0000-00000000a7d2', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0007', '00000000-0000-0000-0000-00000000a7d1', null, 'admin', 'gm')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f0004') on conflict do nothing;
insert into core.data_chat_conversation (id, scope, organization_id, vertical, property_id, user_id, title, message_count) values
  ('00000000-0000-0000-0000-0000000f1001', 'vertical', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', null, '00000000-0000-0000-0000-0000000f0001', 'Ocupacion', 2),
  ('00000000-0000-0000-0000-0000000f1002', 'vertical', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', null, '00000000-0000-0000-0000-0000000f0002', 'Reservas', 2),
  ('00000000-0000-0000-0000-0000000f1003', 'vertical', '00000000-0000-0000-0000-00000000a7d2', 'restaurantes', null, '00000000-0000-0000-0000-0000000f0003', 'Pedidos', 2),
  ('00000000-0000-0000-0000-0000000f1004', 'plataforma', null, 'plataforma', null, '00000000-0000-0000-0000-0000000f0004', 'Plataforma', 2);
insert into core.data_chat_message (conversation_id, seq, role, text, status) values
  ('00000000-0000-0000-0000-0000000f1001', 1, 'user', 'Ocupacion', null), ('00000000-0000-0000-0000-0000000f1001', 2, 'assistant', 'Ocupacion de 80.', 'ok'),
  ('00000000-0000-0000-0000-0000000f1002', 1, 'user', 'Reservas', null), ('00000000-0000-0000-0000-0000000f1002', 2, 'assistant', 'Hay 3 reservas.', 'ok'),
  ('00000000-0000-0000-0000-0000000f1003', 1, 'user', 'Pedidos', null), ('00000000-0000-0000-0000-0000000f1003', 2, 'assistant', 'Hubo 7 pedidos.', 'ok'),
  ('00000000-0000-0000-0000-0000000f1004', 1, 'user', 'Plataforma', null), ('00000000-0000-0000-0000-0000000f1004', 2, 'assistant', 'Hay 2 organizaciones.', 'ok');

\echo '=== ESCRITURA: solo el autor, solo respuestas del asistente, misma organizacion y vertical ==='
\echo '1. v1 marca «Útil» una respuesta de su conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', true);
select count(*)::int as propia_deberia_ser_1 from core.data_chat_feedback;
rollback;

\echo '2. v1 cambia de opinion (upsert): queda UNA fila «No fue útil» con motivo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util, motivo) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', false, 'dato_incorrecto')
  on conflict (conversation_id, seq, user_id) do update set util = excluded.util, motivo = excluded.motivo, updated_at = now();
select count(*)::int as cambio_deberia_ser_1 from core.data_chat_feedback where util = false and motivo = 'dato_incorrecto';
rollback;

\echo '3. no se valora la PREGUNTA (mensaje del usuario)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1001', 1, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', true) returning 1 as should_fail;
rollback;

\echo '4. el owner de A NO valora la conversacion de su staff (v2)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1002', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', true) returning 1 as should_fail;
rollback;

\echo '5. nadie escribe a nombre de otra persona'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0002', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', false) returning 1 as should_fail;
rollback;

\echo '6. cross-tenant: v3 (owner de B) no valora una respuesta de A ni la etiqueta con su organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0003', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0003', '00000000-0000-0000-0000-00000000a7d2', 'restaurantes', true) returning 1 as should_fail;
rollback;

\echo '7. v1 no puede mover su valoracion a otra organizacion o vertical que la de su conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d2', 'restaurantes', true) returning 1 as should_fail;
rollback;

\echo '8. el motivo solo acompaña a «No fue útil» y es de la lista cerrada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util, motivo) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', true, 'otro') returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util, motivo) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', false, 'mi telefono es 9991234567') returning 1 as should_fail;
rollback;

\echo '9. anon no escribe ni lee'
begin;
set local role anon;
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', true) returning 1 as should_fail;
rollback;

begin;
set local role anon;
select count(*) as should_fail from core.data_chat_feedback;
rollback;

\echo '10. nadie borra una valoracion (sin GRANT de delete)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
delete from core.data_chat_feedback where user_id = '00000000-0000-0000-0000-0000000f0001' returning 1 as should_fail;
rollback;

\echo '11. el superadmin valora una respuesta de SU conversacion de plataforma (sin organizacion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0004', true);
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util) values ('00000000-0000-0000-0000-0000000f1004', 2, '00000000-0000-0000-0000-0000000f0004', null, 'plataforma', true);
select count(*)::int as plataforma_deberia_ser_1 from core.data_chat_feedback;
rollback;

\echo '=== LECTURA: filas solo propias; agregados para owner/admin y superadmin ==='
-- Siembra de sistema (sin auth.uid()): una valoracion de v1 (no util, dato_incorrecto), una de v2 (util) en A y una de v3 en B.
insert into core.data_chat_feedback (conversation_id, seq, user_id, organization_id, vertical, util, motivo) values
  ('00000000-0000-0000-0000-0000000f1001', 2, '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', false, 'dato_incorrecto'),
  ('00000000-0000-0000-0000-0000000f1002', 2, '00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-00000000a7d1', 'hoteles', true, null),
  ('00000000-0000-0000-0000-0000000f1003', 2, '00000000-0000-0000-0000-0000000f0003', '00000000-0000-0000-0000-00000000a7d2', 'restaurantes', true, null);

\echo '12. el owner de A solo ve SU fila suelta (no la de su staff)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
select count(*)::int as filas_propias_deberia_ser_1 from core.data_chat_feedback;
rollback;

\echo '13. el owner de A ve el agregado de A: 2 valoraciones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
select sum(total)::int as agregado_a_deberia_ser_2 from core.data_chat_feedback_resumen('00000000-0000-0000-0000-00000000a7d1', null);
rollback;

\echo '14. el admin de A tambien ve el agregado; 1 de esas es «No fue útil» por dato incorrecto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0007', true);
select coalesce(sum(total) filter (where not util and motivo = 'dato_incorrecto'), 0)::int as no_util_deberia_ser_1 from core.data_chat_feedback_resumen('00000000-0000-0000-0000-00000000a7d1', null);
rollback;

\echo '15. un member (sin owner/admin) no lee el agregado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0002', true);
select * from core.data_chat_feedback_resumen('00000000-0000-0000-0000-00000000a7d1', null) as should_fail;
rollback;

\echo '16. cross-tenant: el owner de B no lee el agregado de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0003', true);
select * from core.data_chat_feedback_resumen('00000000-0000-0000-0000-00000000a7d1', null) as should_fail;
rollback;

\echo '17. sin actor (sesion de sistema) el agregado de organizacion falla'
begin;
select * from core.data_chat_feedback_resumen('00000000-0000-0000-0000-00000000a7d1', null) as should_fail;
rollback;

\echo '18. anon no ejecuta el agregado'
begin;
set local role anon;
select * from core.data_chat_feedback_resumen('00000000-0000-0000-0000-00000000a7d1', null) as should_fail;
rollback;

\echo '19. el superadmin ve el agregado de plataforma: 3 valoraciones en 2 organizaciones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0004', true);
select sum(total)::int as plataforma_total_deberia_ser_3 from core.superadmin_data_chat_feedback_resumen('00000000-0000-0000-0000-0000000f0004', null);
rollback;

\echo '20. el superadmin no se hace pasar por otro (p_caller_id distinto de auth.uid())'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0004', true);
select * from core.superadmin_data_chat_feedback_resumen('00000000-0000-0000-0000-0000000f0001', null) as should_fail;
rollback;

\echo '21. un owner (no superadmin) no lee el agregado de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
select * from core.superadmin_data_chat_feedback_resumen('00000000-0000-0000-0000-0000000f0001', null) as should_fail;
rollback;

\echo '22. un desde futuro deja el agregado vacio (filtro de fecha aplicado)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0001', true);
select count(*)::int as futuro_deberia_ser_0 from core.data_chat_feedback_resumen('00000000-0000-0000-0000-00000000a7d1', now() + interval '1 day');
rollback;

\echo '=== ESTRUCTURA ==='
\echo '23. RLS activa, sin privilegios para anon/PUBLIC, funciones security definer con search_path fijo'
begin;
select (
  (select relrowsecurity from pg_class where oid = 'core.data_chat_feedback'::regclass)
  and not has_table_privilege('anon', 'core.data_chat_feedback', 'select')
  and not has_table_privilege('authenticated', 'core.data_chat_feedback', 'delete')
  and not has_function_privilege('anon', 'core.data_chat_feedback_resumen(uuid, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'core.superadmin_data_chat_feedback_resumen(uuid, timestamptz)', 'execute')
  and (select bool_and(p.prosecdef and p.proconfig is not null and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
         from pg_proc p where p.oid in ('core.data_chat_feedback_resumen(uuid, timestamptz)'::regprocedure, 'core.superadmin_data_chat_feedback_resumen(uuid, timestamptz)'::regprocedure))
  and not exists (select 1 from pg_policies where schemaname = 'core' and tablename = 'data_chat_feedback' and (qual = 'true' or with_check = 'true'))
)::int as estructura_deberia_ser_1;
rollback;

\echo '24. base sin migrar: sin la tabla, la consulta falla con 42P01 y SAVEPOINT deja la transaccion utilizable'
begin;
drop table core.data_chat_feedback cascade;
savepoint sp_valoracion;
do $$ begin
  begin
    perform 1 from core.data_chat_feedback;
    raise exception 'la tabla deberia faltar';
  exception when undefined_table then null;
  end;
end $$;
rollback to savepoint sp_valoracion;
select 1::int as utilizable_deberia_ser_1;
rollback;
