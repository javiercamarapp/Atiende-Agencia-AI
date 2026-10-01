-- Copiloto: persistencia de conversaciones (migracion 0041) -- verificacion contra Postgres REAL de las tablas
-- core.data_chat_conversation / core.data_chat_message y de core.append_data_chat_turn. Cada escenario corre en su
-- propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el valor
-- esperado (ver scripts/verify-real-postgres-ci/run-gate.mjs). Datos ficticios; nada envia mensajes.
-- Sesion de sistema = sin `set local role` ni claim (auth.uid() es null); usuario real = `set local role
-- authenticated` + claim `request.jwt.claim.sub`.
-- Sujetos: c1 owner de A, c2 miembro de A acotado a la propiedad p1, c3 owner de B, c4 superadmin sin membresia,
-- c5 miembro de A y de B, c6 sin membresia, c7 miembro de A (tope de 200). A = hoteles (p1, p2), B = restaurantes (p3).
-- Conversaciones sembradas: k1 (c1, A), k2 (c2, A), k3 (c3, B), k4 (c4, plataforma), k5 (c5, A), k6 (c5, B).
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a0d1', 'hoteles', 'Hotel A', 'hotel-a-copiloto'),
  ('00000000-0000-0000-0000-00000000a0d2', 'restaurantes', 'Restaurante B', 'restaurante-b-copiloto')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000b0d1', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', 'Hotel A p1'),
  ('00000000-0000-0000-0000-00000000b0d2', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', 'Hotel A p2'),
  ('00000000-0000-0000-0000-00000000b0d3', '00000000-0000-0000-0000-00000000a0d2', 'restaurantes', 'Resto B p1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0001', 'copiloto-c1@example.com', 'C1', 'seed'),
  ('00000000-0000-0000-0000-0000000d0002', 'copiloto-c2@example.com', 'C2', 'seed'),
  ('00000000-0000-0000-0000-0000000d0003', 'copiloto-c3@example.com', 'C3', 'seed'),
  ('00000000-0000-0000-0000-0000000d0004', 'copiloto-c4@example.com', 'C4', 'seed'),
  ('00000000-0000-0000-0000-0000000d0005', 'copiloto-c5@example.com', 'C5', 'seed'),
  ('00000000-0000-0000-0000-0000000d0006', 'copiloto-c6@example.com', 'C6', 'seed'),
  ('00000000-0000-0000-0000-0000000d0007', 'copiloto-c7@example.com', 'C7', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000a0d1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-00000000a0d1', array['00000000-0000-0000-0000-00000000b0d1']::uuid[], 'member', 'recepcion'),
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-00000000a0d2', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0005', '00000000-0000-0000-0000-00000000a0d1', null, 'member', 'recepcion'),
  ('00000000-0000-0000-0000-0000000d0005', '00000000-0000-0000-0000-00000000a0d2', null, 'member', 'mesero'),
  ('00000000-0000-0000-0000-0000000d0007', '00000000-0000-0000-0000-00000000a0d1', null, 'member', 'recepcion')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000d0004') on conflict do nothing;
insert into core.data_chat_conversation (id, scope, organization_id, vertical, property_id, user_id, title, message_count) values
  ('00000000-0000-0000-0000-0000000e0001', 'vertical', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', '00000000-0000-0000-0000-00000000b0d1', '00000000-0000-0000-0000-0000000d0001', 'Ventas de ayer', 2),
  ('00000000-0000-0000-0000-0000000e0002', 'vertical', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', '00000000-0000-0000-0000-00000000b0d1', '00000000-0000-0000-0000-0000000d0002', 'Mis reservas', 2),
  ('00000000-0000-0000-0000-0000000e0003', 'vertical', '00000000-0000-0000-0000-00000000a0d2', 'restaurantes', null, '00000000-0000-0000-0000-0000000d0003', 'Pedidos de B', 2),
  ('00000000-0000-0000-0000-0000000e0004', 'plataforma', null, 'plataforma', null, '00000000-0000-0000-0000-0000000d0004', 'Resumen de plataforma', 2),
  ('00000000-0000-0000-0000-0000000e0005', 'vertical', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', null, '00000000-0000-0000-0000-0000000d0005', 'Chat de c5 en A', 2),
  ('00000000-0000-0000-0000-0000000e0006', 'vertical', '00000000-0000-0000-0000-00000000a0d2', 'restaurantes', null, '00000000-0000-0000-0000-0000000d0005', 'Chat de c5 en B', 2);
insert into core.data_chat_message (conversation_id, seq, role, text, status) values
  ('00000000-0000-0000-0000-0000000e0001', 1, 'user', 'Ventas de ayer', null), ('00000000-0000-0000-0000-0000000e0001', 2, 'assistant', 'Ayer vendiste 10 pedidos.', 'ok'),
  ('00000000-0000-0000-0000-0000000e0002', 1, 'user', 'Mis reservas', null), ('00000000-0000-0000-0000-0000000e0002', 2, 'assistant', 'Tienes 3 reservas.', 'ok'),
  ('00000000-0000-0000-0000-0000000e0003', 1, 'user', 'Pedidos de B', null), ('00000000-0000-0000-0000-0000000e0003', 2, 'assistant', 'Hubo 7 pedidos.', 'ok'),
  ('00000000-0000-0000-0000-0000000e0004', 1, 'user', 'Resumen de plataforma', null), ('00000000-0000-0000-0000-0000000e0004', 2, 'assistant', 'Hay 2 organizaciones.', 'ok'),
  ('00000000-0000-0000-0000-0000000e0005', 1, 'user', 'Chat de c5 en A', null), ('00000000-0000-0000-0000-0000000e0005', 2, 'assistant', 'Respuesta A.', 'ok'),
  ('00000000-0000-0000-0000-0000000e0006', 1, 'user', 'Chat de c5 en B', null), ('00000000-0000-0000-0000-0000000e0006', 2, 'assistant', 'Respuesta B.', 'ok');

\echo '=== APPEND: autoria, membresia, alcance y limites ==='
\echo '1. c1 abre una conversacion nueva en A: pregunta y respuesta quedan guardadas (2 mensajes nuevos)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select count(*)::int as mensajes_deberia_ser_4 from core.data_chat_message m join core.data_chat_conversation c on c.id = m.conversation_id where c.user_id = '00000000-0000-0000-0000-0000000d0001';
rollback;

\echo '2. el titulo es la pregunta recortada a 60 caracteres mas puntos suspensivos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, 'Dame el detalle completo de todas las reservas confirmadas del fin de semana largo por canal de venta', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select (char_length(title) = 61 and title like '%…')::int as titulo_recortado_deberia_ser_1 from core.data_chat_conversation where user_id = '00000000-0000-0000-0000-0000000d0001' and title like 'Dame el detalle%';
rollback;

\echo '3. agregar a una conversacion existente suma dos mensajes y el asistente queda en seq 4'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0001', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select max(m.seq)::int as seq_deberia_ser_4 from core.data_chat_message m where m.conversation_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '4. la vertical sale de la organizacion, no de un parametro'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0003', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d2', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select count(*)::int as vertical_derivada_deberia_ser_2 from core.data_chat_conversation where user_id = '00000000-0000-0000-0000-0000000d0003' and vertical = 'restaurantes';
rollback;

\echo '5. la sesion de sistema (sin auth.uid()) no puede escribir'
begin;
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '6. un usuario sin membresia en A no escribe en A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0006', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '7. cross-tenant: el owner de A no escribe en la organizacion B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d2', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '8. un miembro acotado a p1 no abre conversacion desde la propiedad p2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0002', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', '00000000-0000-0000-0000-00000000b0d2', null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '9. un miembro acotado a p1 si abre desde p1 y queda guardada la propiedad'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0002', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', '00000000-0000-0000-0000-00000000b0d1', null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select count(*)::int as con_propiedad_deberia_ser_2 from core.data_chat_conversation where user_id = '00000000-0000-0000-0000-0000000d0002' and property_id = '00000000-0000-0000-0000-00000000b0d1';
rollback;

\echo '10. una propiedad de otra organizacion no se acepta aunque el usuario tenga acceso a ambas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0005', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', '00000000-0000-0000-0000-00000000b0d3', null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '11. un usuario no agrega a la conversacion de otro usuario de la misma organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0005', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0001', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '12. una conversacion de otra organizacion es indistinguible de una inexistente (P0002)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0003', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '13. la conversacion propia no se puede usar bajo otra organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0005', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d2', null, '00000000-0000-0000-0000-0000000e0005', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '14. un id inexistente falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0999', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '15. pregunta vacia: error 22023'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '   ', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '16. respuesta vacia: error 22023'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '¿Cuánto vendimos ayer?', '', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '17. bloques que no son un arreglo se guardan como arreglo vacio (el texto del turno no se pierde)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb);
select jsonb_array_length(m.blocks)::int as bloques_deberia_ser_0 from core.data_chat_message m join core.data_chat_conversation c on c.id = m.conversation_id where c.user_id = '00000000-0000-0000-0000-0000000d0001' and m.role = 'assistant' and c.id <> '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '18. los bloques, fuentes y herramientas validos se guardan tal cual'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0001', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[{"tool":"ventas_por_dia","title":"Ventas","rows":[{"total":10}]}]'::jsonb, '[{"tool":"ventas_por_dia","source":"Pedidos"}]'::jsonb, '[{"tool":"ventas_por_dia","args":{"periodo":"ayer"}}]'::jsonb);
select (jsonb_array_length(m.blocks) = 1 and jsonb_array_length(m.sources) = 1 and m.tool_calls -> 0 ->> 'tool' = 'ventas_por_dia')::int as guardado_deberia_ser_1 from core.data_chat_message m where m.conversation_id = '00000000-0000-0000-0000-0000000e0001' and m.seq = 4;
rollback;

\echo '19. el superadmin abre una conversacion de plataforma (organizacion nula)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0004', true);
select * from core.append_data_chat_turn(null, null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select count(*)::int as plataforma_deberia_ser_2 from core.data_chat_conversation where user_id = '00000000-0000-0000-0000-0000000d0004' and scope = 'plataforma' and vertical = 'plataforma';
rollback;

\echo '20. quien no es superadmin no puede abrir una conversacion de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn(null, null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '21. la conversacion de plataforma no lleva propiedad'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0004', true);
select * from core.append_data_chat_turn(null, '00000000-0000-0000-0000-00000000b0d1', null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '22. el superadmin revocado ya no escribe en plataforma'
begin;
delete from core.platform_superadmin where staff_user_id = '00000000-0000-0000-0000-0000000d0004';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0004', true);
select * from core.append_data_chat_turn(null, null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '23. membresia revocada: el usuario ya no escribe en la organizacion'
begin;
delete from core.membership where user_id = '00000000-0000-0000-0000-0000000d0001' and organization_id = '00000000-0000-0000-0000-00000000a0d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0001', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '24. anon no ejecuta la funcion'
begin;
set local role anon;
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '25. tope de 199 conversaciones: la 200 todavia se crea'
begin;
insert into core.data_chat_conversation (scope, organization_id, vertical, user_id, title, message_count)
select 'vertical', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', '00000000-0000-0000-0000-0000000d0007', 'c' || g, 0 from generate_series(1, 199) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0007', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select count(*)::int as conversaciones_deberia_ser_200 from core.data_chat_conversation where user_id = '00000000-0000-0000-0000-0000000d0007';
rollback;

\echo '26. tope de 200 conversaciones: la 201 se rechaza (54000)'
begin;
insert into core.data_chat_conversation (scope, organization_id, vertical, user_id, title, message_count)
select 'vertical', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', '00000000-0000-0000-0000-0000000d0007', 'c' || g, 0 from generate_series(1, 200) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0007', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) as should_fail;
rollback;

\echo '27. el tope de conversaciones es por organizacion: 200 en A no bloquean a c5 en B'
begin;
insert into core.data_chat_conversation (scope, organization_id, vertical, user_id, title, message_count)
select 'vertical', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', '00000000-0000-0000-0000-0000000d0005', 'c' || g, 0 from generate_series(1, 199) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0005', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d2', null, null, '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select count(*)::int as en_b_deberia_ser_2 from core.data_chat_conversation where user_id = '00000000-0000-0000-0000-0000000d0005' and organization_id = '00000000-0000-0000-0000-00000000a0d2';
rollback;

\echo '28. al llegar a 100 mensajes el siguiente turno abre una conversacion de continuacion'
begin;
update core.data_chat_conversation set message_count = 100 where id = '00000000-0000-0000-0000-0000000e0001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0001', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select count(*)::int as continuacion_deberia_ser_1 from core.data_chat_conversation where user_id = '00000000-0000-0000-0000-0000000d0001' and id <> '00000000-0000-0000-0000-0000000e0001' and title like '% (cont.)' and message_count = 2;
rollback;

\echo '29. la conversacion llena conserva sus 100 mensajes'
begin;
update core.data_chat_conversation set message_count = 100 where id = '00000000-0000-0000-0000-0000000e0001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0001', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select message_count::int as llena_deberia_ser_100 from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '30. con 98 mensajes todavia cabe el turno en la misma conversacion (queda en 100)'
begin;
update core.data_chat_conversation set message_count = 98 where id = '00000000-0000-0000-0000-0000000e0001';
delete from core.data_chat_message where conversation_id = '00000000-0000-0000-0000-0000000e0001';
insert into core.data_chat_message (conversation_id, seq, role, text) select '00000000-0000-0000-0000-0000000e0001', g, case when g % 2 = 1 then 'user' else 'assistant' end, 'm' || g from generate_series(1, 98) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select * from core.append_data_chat_turn('00000000-0000-0000-0000-00000000a0d1', null, '00000000-0000-0000-0000-0000000e0001', '¿Cuánto vendimos ayer?', 'Ayer vendiste 10 pedidos.', 'ok', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
select message_count::int as cabe_deberia_ser_100 from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== LECTURA / RLS ==='
\echo '31. c1 ve su conversacion k1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select count(*)::int as propia_deberia_ser_1 from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '32. c1 no ve conversaciones de otros usuarios ni de otras organizaciones ni de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select count(*)::int as ajenas_deberia_ser_0 from core.data_chat_conversation where id in ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000e0004', '00000000-0000-0000-0000-0000000e0005', '00000000-0000-0000-0000-0000000e0006');
rollback;

\echo '33. el owner NO lee las conversaciones de su staff (k2 es de c2, misma organizacion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select count(*)::int as staff_deberia_ser_0 from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0002';
rollback;

\echo '34. el owner NO lee los mensajes de la conversacion de su staff'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select count(*)::int as mensajes_staff_deberia_ser_0 from core.data_chat_message where conversation_id = '00000000-0000-0000-0000-0000000e0002';
rollback;

\echo '35. c1 lee los mensajes de su conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select count(*)::int as mensajes_propios_deberia_ser_2 from core.data_chat_message where conversation_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '36. cross-tenant: el owner de B no ve nada de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0003', true);
select count(*)::int as cross_tenant_deberia_ser_0 from core.data_chat_conversation where organization_id = '00000000-0000-0000-0000-00000000a0d1';
rollback;

\echo '37. c5 ve sus dos conversaciones (A y B) y ninguna mas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0005', true);
select count(*)::int as c5_deberia_ser_2 from core.data_chat_conversation;
rollback;

\echo '38. membresia revocada: c1 deja de ver su conversacion'
begin;
delete from core.membership where user_id = '00000000-0000-0000-0000-0000000d0001' and organization_id = '00000000-0000-0000-0000-00000000a0d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select count(*)::int as revocada_deberia_ser_0 from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '39. membresia revocada: tampoco ve los mensajes'
begin;
delete from core.membership where user_id = '00000000-0000-0000-0000-0000000d0001' and organization_id = '00000000-0000-0000-0000-00000000a0d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
select count(*)::int as mensajes_revocada_deberia_ser_0 from core.data_chat_message where conversation_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '40. el superadmin vigente ve su conversacion de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0004', true);
select count(*)::int as superadmin_deberia_ser_1 from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0004';
rollback;

\echo '41. el superadmin no ve las conversaciones de las organizaciones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0004', true);
select count(*)::int as superadmin_ajenas_deberia_ser_0 from core.data_chat_conversation where id in ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000e0005', '00000000-0000-0000-0000-0000000e0006');
rollback;

\echo '42. superadmin revocado: deja de ver la conversacion de plataforma'
begin;
delete from core.platform_superadmin where staff_user_id = '00000000-0000-0000-0000-0000000d0004';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0004', true);
select count(*)::int as superadmin_revocado_deberia_ser_0 from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0004';
rollback;

\echo '43. un usuario sin membresia no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0006', true);
select count(*)::int as sin_membresia_deberia_ser_0 from core.data_chat_conversation;
rollback;

\echo '44. la sesion de sistema (sin auth.uid()) bajo el rol authenticated no ve nada'
begin;
set local role authenticated;
select count(*)::int as sistema_deberia_ser_0 from core.data_chat_conversation;
rollback;

\echo '45. anon no puede leer conversaciones'
begin;
set local role anon;
select count(*) as should_fail from core.data_chat_conversation;
rollback;

\echo '46. anon no puede leer mensajes'
begin;
set local role anon;
select count(*) as should_fail from core.data_chat_message;
rollback;

\echo '=== RENOMBRAR (solo title) ==='
\echo '47. c1 renombra su conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
with u as (update core.data_chat_conversation set title = 'Ventas de la semana' where id = '00000000-0000-0000-0000-0000000e0001' returning 1)
select count(*)::int as renombradas_deberia_ser_1 from u;
rollback;

\echo '48. c1 no renombra la conversacion de su staff (la RLS filtra, 0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
with u as (update core.data_chat_conversation set title = 'x' where id = '00000000-0000-0000-0000-0000000e0002' returning 1)
select count(*)::int as renombradas_ajenas_deberia_ser_0 from u;
rollback;

\echo '49. membresia revocada: ya no renombra'
begin;
delete from core.membership where user_id = '00000000-0000-0000-0000-0000000d0001' and organization_id = '00000000-0000-0000-0000-00000000a0d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
with u as (update core.data_chat_conversation set title = 'x' where id = '00000000-0000-0000-0000-0000000e0001' returning 1)
select count(*)::int as renombradas_revocada_deberia_ser_0 from u;
rollback;

\echo '50. titulo vacio se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
update core.data_chat_conversation set title = '' where id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '51. titulo solo con espacios se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
update core.data_chat_conversation set title = '   ' where id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '52. titulo de mas de 80 caracteres se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
update core.data_chat_conversation set title = repeat('a', 81) where id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '53. el cliente no puede cambiar el contador de mensajes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
update core.data_chat_conversation set message_count = 0 where id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '54. el cliente no puede mover la conversacion a otro usuario'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
update core.data_chat_conversation set user_id = '00000000-0000-0000-0000-0000000d0002' where id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '55. el cliente no puede cambiar la organizacion de la conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0005', true);
update core.data_chat_conversation set organization_id = '00000000-0000-0000-0000-00000000a0d2' where id = '00000000-0000-0000-0000-0000000e0005' returning 1 as should_fail;
rollback;

\echo '56. los mensajes no se editan'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
update core.data_chat_message set text = 'otro' where conversation_id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '57. anon no renombra'
begin;
set local role anon;
update core.data_chat_conversation set title = 'x' where id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '=== BORRAR ==='
\echo '58. c1 borra su conversacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
with d as (delete from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001' returning 1)
select count(*)::int as borradas_deberia_ser_1 from d;
rollback;

\echo '59. al borrar la conversacion se borran sus mensajes (cascada)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
delete from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001';
reset role;
select count(*)::int as mensajes_huerfanos_deberia_ser_0 from core.data_chat_message where conversation_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '60. c1 no borra la conversacion de su staff (0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
with d as (delete from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0002' returning 1)
select count(*)::int as borradas_ajenas_deberia_ser_0 from d;
rollback;

\echo '61. cross-tenant: c3 no borra conversaciones de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0003', true);
with d as (delete from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001' returning 1)
select count(*)::int as borradas_cross_tenant_deberia_ser_0 from d;
rollback;

\echo '62. membresia revocada: ya no borra'
begin;
delete from core.membership where user_id = '00000000-0000-0000-0000-0000000d0001' and organization_id = '00000000-0000-0000-0000-00000000a0d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
with d as (delete from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001' returning 1)
select count(*)::int as borradas_revocada_deberia_ser_0 from d;
rollback;

\echo '63. los mensajes no se borran uno por uno'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
delete from core.data_chat_message where conversation_id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '64. anon no borra'
begin;
set local role anon;
delete from core.data_chat_conversation where id = '00000000-0000-0000-0000-0000000e0001' returning 1 as should_fail;
rollback;

\echo '=== ESCRITURA DIRECTA CERRADA, FORMA Y GRANTS ==='
\echo '65. authenticated no inserta conversaciones directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
insert into core.data_chat_conversation (scope, organization_id, vertical, user_id, title) values ('vertical', '00000000-0000-0000-0000-00000000a0d1', 'hoteles', '00000000-0000-0000-0000-0000000d0001', 'x') returning 1 as should_fail;
rollback;

\echo '66. authenticated no inserta mensajes directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
insert into core.data_chat_message (conversation_id, seq, role, text) values ('00000000-0000-0000-0000-0000000e0001', 50, 'user', 'x') returning 1 as should_fail;
rollback;

\echo '67. CHECK: scope plataforma exige organizacion nula'
begin;
insert into core.data_chat_conversation (scope, organization_id, vertical, user_id, title) values ('plataforma', '00000000-0000-0000-0000-00000000a0d1', 'plataforma', '00000000-0000-0000-0000-0000000d0004', 'x') returning 1 as should_fail;
rollback;

\echo '68. CHECK: scope vertical exige organizacion'
begin;
insert into core.data_chat_conversation (scope, organization_id, vertical, user_id, title) values ('vertical', null, 'hoteles', '00000000-0000-0000-0000-0000000d0001', 'x') returning 1 as should_fail;
rollback;

\echo '69. CHECK: seq mayor a 100 se rechaza'
begin;
insert into core.data_chat_message (conversation_id, seq, role, text) values ('00000000-0000-0000-0000-0000000e0001', 101, 'user', 'x') returning 1 as should_fail;
rollback;

\echo '70. CHECK: texto de mas de 2000 caracteres se rechaza'
begin;
insert into core.data_chat_message (conversation_id, seq, role, text) values ('00000000-0000-0000-0000-0000000e0001', 50, 'user', repeat('a', 2001)) returning 1 as should_fail;
rollback;

\echo '71. anon no tiene ningun privilegio sobre las tablas'
begin;
select count(*)::int as anon_tablas_deberia_ser_0 from information_schema.table_privileges
where table_schema = 'core' and table_name in ('data_chat_conversation', 'data_chat_message') and grantee in ('anon', 'PUBLIC');
rollback;

\echo '72. anon no ejecuta core.append_data_chat_turn (sin grant a anon ni a PUBLIC)'
begin;
select count(*)::int as anon_funcion_deberia_ser_0 from information_schema.routine_privileges
where routine_schema = 'core' and routine_name = 'append_data_chat_turn' and grantee in ('anon', 'PUBLIC');
rollback;

\echo '73. sobre los mensajes authenticated solo tiene SELECT'
begin;
select count(*)::int as mensajes_no_select_deberia_ser_0 from information_schema.table_privileges
where table_schema = 'core' and table_name = 'data_chat_message' and grantee = 'authenticated' and privilege_type <> 'SELECT';
rollback;

\echo '74. sobre las conversaciones authenticated solo tiene SELECT y DELETE a nivel tabla (sin INSERT ni UPDATE)'
begin;
select count(*)::int as conv_privilegios_deberia_ser_0 from information_schema.table_privileges
where table_schema = 'core' and table_name = 'data_chat_conversation' and grantee = 'authenticated' and privilege_type not in ('SELECT', 'DELETE');
rollback;

\echo '75. el unico UPDATE de columna de authenticated es title'
begin;
select count(*)::int as columnas_update_deberia_ser_1 from information_schema.column_privileges
where table_schema = 'core' and table_name = 'data_chat_conversation' and grantee = 'authenticated' and privilege_type = 'UPDATE' and column_name = 'title';
rollback;

\echo '76. no hay mas columnas actualizables que title'
begin;
select count(*)::int as otras_columnas_deberia_ser_0 from information_schema.column_privileges
where table_schema = 'core' and table_name = 'data_chat_conversation' and grantee = 'authenticated' and privilege_type = 'UPDATE' and column_name <> 'title';
rollback;

\echo '77. append_data_chat_turn es security definer con search_path fijo'
begin;
select count(*)::int as search_path_deberia_ser_1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core' and p.proname = 'append_data_chat_turn' and p.prosecdef
  and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=core, pg_temp');
rollback;

\echo '78. RLS activa en ambas tablas'
begin;
select count(*)::int as rls_deberia_ser_2 from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'core' and c.relname in ('data_chat_conversation', 'data_chat_message') and c.relrowsecurity;
rollback;

\echo '79. ninguna policy usa true como condicion'
begin;
select count(*)::int as policies_true_deberia_ser_0 from pg_policies
where schemaname = 'core' and tablename in ('data_chat_conversation', 'data_chat_message') and (qual = 'true' or with_check = 'true');
rollback;

\echo 'Fin: todos los escenarios *_deberia_ser_N deben devolver N y los should_fail deben terminar en ERROR.'
