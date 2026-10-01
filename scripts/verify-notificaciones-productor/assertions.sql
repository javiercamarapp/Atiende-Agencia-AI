-- Notificaciones (migracion 0039) -- verificacion contra Postgres REAL del productor unico
-- core.emit_notification y de la lectura v2. Cada escenario corre en su propio `begin; ... rollback;`.
-- Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el valor esperado
-- (ver scripts/verify-real-postgres-ci/run-gate.mjs). Datos ficticios; nada envia mensajes.
-- Sesion de sistema = sin `set local role` ni claim (auth.uid() es null); usuario real = `set local role
-- authenticated` + claim `request.jwt.claim.sub`.
-- Sujetos: s1 owner A, s2 recepcion A, s3 housekeeping A (no recibe eventos de recepcion), s4 owner B,
-- s5 superadmin de plataforma sin membresia, s6 recepcion A acotado a la propiedad p1.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-notif'),
  ('00000000-0000-0000-0000-00000000a002', 'restaurantes', 'Restaurante B', 'restaurante-b-notif')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A p1'),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A p2'),
  ('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000a002', 'restaurantes', 'Resto B p1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000c001', 'notif-s1@example.com', 'S1', 'seed'),
  ('00000000-0000-0000-0000-00000000c002', 'notif-s2@example.com', 'S2', 'seed'),
  ('00000000-0000-0000-0000-00000000c003', 'notif-s3@example.com', 'S3', 'seed'),
  ('00000000-0000-0000-0000-00000000c004', 'notif-s4@example.com', 'S4', 'seed'),
  ('00000000-0000-0000-0000-00000000c005', 'notif-s5@example.com', 'S5', 'seed'),
  ('00000000-0000-0000-0000-00000000c006', 'notif-s6@example.com', 'S6', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000a001', null, 'member', 'recepcion'),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-00000000c004', '00000000-0000-0000-0000-00000000a002', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c006', '00000000-0000-0000-0000-00000000a001', array['00000000-0000-0000-0000-00000000b001']::uuid[], 'member', 'recepcion')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-00000000c005') on conflict do nothing;

\echo '=== PRODUCTOR: destinatarios, dedupe y volumen ==='
\echo '1. el sistema emite a la org A para el rol recepcion: reciben owner + recepcion + recepcion acotado (3), no housekeeping ni otra org'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'Ticket con SLA vencido', 'Hay 2 tickets vencidos', '/hoteles/tickets', 'ticket', null, 'k1', array['recepcion'], null);
select count(*)::int as destinatarios_deberia_ser_3 from core.notification where dedupe_key = 'k1';
rollback;

\echo '2. el vertical se deriva de la organizacion, no del caller'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k2', null, null);
select count(*) filter (where vertical = 'hoteles' and organization_id = '00000000-0000-0000-0000-00000000a001' and severidad = 'info')::int as vertical_derivado_deberia_ser_1 from core.notification where dedupe_key = 'k2';
rollback;

\echo '3. dedupe: emitir dos veces la misma clave no duplica (segunda llamada devuelve 0)'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k3', null, null);
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k3', null, null) as segunda_deberia_ser_0;
rollback;

\echo '4. dedupe: la fila sigue siendo una por destinatario tras reemitir'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k4', null, null);
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k4', null, null);
select count(*)::int as filas_deberia_ser_1 from core.notification where dedupe_key = 'k4';
rollback;

\echo '5. la clave de dedupe es obligatoria'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, null, null, null) as should_fail;
rollback;

\echo '6. un enlace externo (esquema) se rechaza'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, 'https://example.com/x', null, null, 'k6', null, null) as should_fail;
rollback;

\echo '7. un enlace protocolo-relativo (//) se rechaza'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '//example.com/x', null, null, 'k7', null, null) as should_fail;
rollback;

\echo '7b. un enlace con espacio o comillas se rechaza'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/x y"onerror=1', null, null, 'k7b', null, null) as should_fail;
rollback;

\echo '7c. el marcador {orgSlug} del enlace se sustituye por el slug real de la organizacion'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/{orgSlug}/tickets', null, null, 'k7c', null, null);
select count(*) filter (where enlace = '/hoteles/hotel-a-notif/tickets')::int as slug_resuelto_deberia_ser_1 from core.notification where dedupe_key = 'k7c' and staff_user_id = '00000000-0000-0000-0000-00000000c001';
rollback;

\echo '8. un tipo con formato invalido se rechaza'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'Mal Tipo', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k8', null, null) as should_fail;
rollback;

\echo '8b. el tipo invalido se rechaza antes de resolver destinatarios (rol sin miembros)'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000b003', 'Mal Tipo', 'operacion', 'info', 'T', null, '/x', null, null, 'k8b', array['nadie'], null) as should_fail;
rollback;

\echo '9. una severidad fuera del catalogo se rechaza'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'urgente', 'T', null, '/hoteles/tickets', null, null, 'k9', null, null) as should_fail;
rollback;

\echo '10. una propiedad de OTRA organizacion se rechaza'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b003', 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k10', array['recepcion'], null) as should_fail;
rollback;

\echo '11. con propiedad p2, el usuario acotado a p1 NO recibe (owner + recepcion sin acotar = 2)'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000b002', 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k11', array['recepcion'], null);
select count(*)::int as destinatarios_deberia_ser_2 from core.notification where dedupe_key = 'k11';
rollback;

\echo '12. tope de volumen: 105 eventos distintos en una hora dejan 100 por destinatario'
begin;
select count(core.emit_notification('00000000-0000-0000-0000-00000000a002', null, 'restaurantes.pedido.nuevo', 'operacion', 'info', 'Pedido nuevo', null, '/restaurantes/pedidos', null, null, 'vol-' || g, null, null)) from generate_series(1, 105) g;
select count(*)::int as tope_deberia_ser_100 from core.notification where staff_user_id = '00000000-0000-0000-0000-00000000c004';
rollback;

\echo '13. retencion: una fila vencida del destinatario se depura en la siguiente emision'
begin;
insert into core.notification (id, staff_user_id, titulo, dedupe_key, expires_at) values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000c001', 'vieja', 'vieja-1', now() - interval '1 day');
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k13', null, null);
select count(*)::int as vencida_deberia_ser_0 from core.notification where id = '00000000-0000-0000-0000-00000000f001';
rollback;

\echo '=== AUTORIZACION DE EMISION ==='
\echo '14. un miembro de A emite a su propia organizacion (positivo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c002', true);
select (core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k14', null, null) >= 1)::int as emite_propia_deberia_ser_1;
rollback;

\echo '15. cross-tenant: un miembro de A NO puede emitir a la organizacion B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c002', true);
select core.emit_notification('00000000-0000-0000-0000-00000000a002', null, 'restaurantes.pedido.nuevo', 'operacion', 'info', 'T', null, '/restaurantes/pedidos', null, null, 'k15', null, null) as should_fail;
rollback;

\echo '16. un usuario sin membresia ni superadmin no emite a ninguna organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c999', true);
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k16', null, null) as should_fail;
rollback;

\echo '17. un miembro (no superadmin) NO emite notificaciones de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select core.emit_notification(null, null, 'superadmin.cfo.alerta', 'cobranza', 'critica', 'T', null, '/superadmin/cfo', null, null, 'k17', null, null) as should_fail;
rollback;

\echo '18. un superadmin SI emite una notificacion de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c005', true);
select (core.emit_notification(null, null, 'superadmin.cfo.alerta', 'cobranza', 'critica', 'T', null, '/superadmin/cfo', null, null, 'k18', null, null) >= 1)::int as plataforma_deberia_ser_1;
rollback;

\echo '19. anon NO puede ejecutar el productor'
begin;
set local role anon;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k19', null, null) as should_fail;
rollback;

\echo '20. la notificacion de plataforma llega SOLO a los superadmins (el owner de una organizacion recibe 0)'
begin;
select core.emit_notification(null, null, 'superadmin.cfo.alerta', 'cobranza', 'critica', 'T', null, '/superadmin/cfo', null, null, 'k20', null, null);
select count(*)::int as no_superadmin_deberia_ser_0 from core.notification where dedupe_key = 'k20' and staff_user_id in ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c004');
rollback;

\echo '=== LECTURA, ESTADO LEIDO Y RLS ==='
\echo '21. el destinatario lista sus notificaciones por la funcion v2 (positivo)'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'T', 'Cuerpo', '/hoteles/tickets', null, null, 'k21', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select count(*)::int as lista_deberia_ser_1 from core.list_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001');
rollback;

\echo '22. cross-tenant: el owner de B pasando el id del owner de A obtiene CERO filas'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'T', null, '/hoteles/tickets', null, null, 'k22', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c004', true);
select count(*)::int as ajeno_deberia_ser_0 from core.list_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001');
rollback;

\echo '23. el contador v2 de otro usuario devuelve 0'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'T', null, '/hoteles/tickets', null, null, 'k23', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c004', true);
select core.count_unread_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001') as ajeno_deberia_ser_0;
rollback;

\echo '24. la sesion de sistema (sin usuario) no lee notificaciones de nadie por la funcion v2'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'T', null, '/hoteles/tickets', null, null, 'k24', null, null);
select count(*)::int as sistema_deberia_ser_0 from core.list_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001');
rollback;

\echo '25. leido por usuario: owner A marca leida la suya; su contador baja a 0 y el de recepcion A sigue en 1'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'T', null, '/hoteles/tickets', null, null, 'k25', array['recepcion'], null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select core.mark_all_notifications_read('00000000-0000-0000-0000-00000000c001');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c002', true);
select core.count_unread_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c002') as otro_sigue_deberia_ser_1;
rollback;

\echo '26. leido por usuario: tras marcar todas, el contador del propio usuario es 0'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'T', null, '/hoteles/tickets', null, null, 'k26', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select core.mark_all_notifications_read('00000000-0000-0000-0000-00000000c001');
select core.count_unread_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001') as propio_deberia_ser_0;
rollback;

\echo '27. el filtro de solo no leidas excluye las leidas'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'T', null, '/hoteles/tickets', null, null, 'k27', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select core.mark_all_notifications_read('00000000-0000-0000-0000-00000000c001');
select count(*)::int as no_leidas_deberia_ser_0 from core.list_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001', 50, null, true, null);
rollback;

\echo '28. el filtro de categoria devuelve solo esa categoria'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'T', null, '/hoteles/tickets', null, null, 'k28a', null, null);
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.aprobacion.expirada', 'aprobaciones', 'atencion', 'T', null, '/hoteles/agentes', null, null, 'k28b', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select count(*)::int as categoria_deberia_ser_1 from core.list_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001', 50, null, false, 'aprobaciones');
rollback;

\echo '29. las notificaciones vencidas no se listan ni cuentan'
begin;
insert into core.notification (id, staff_user_id, titulo, dedupe_key, expires_at) values ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000c001', 'vencida', 'venc-1', now() - interval '1 minute');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select core.count_unread_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001') as vencidas_deberia_ser_0;
rollback;

\echo '30. el limite se respeta (limit 2 con 3 filas)'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k30a', null, null);
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k30b', null, null);
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k30c', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select count(*)::int as limite_deberia_ser_2 from core.list_notifications_v2_for_staff('00000000-0000-0000-0000-00000000c001', 2);
rollback;

\echo '31. compatibilidad: la funcion de 0013 sigue listando las filas nuevas del propio usuario'
begin;
select core.emit_notification('00000000-0000-0000-0000-00000000a001', null, 'hoteles.ticket.sla_vencido', 'operacion', 'info', 'T', null, '/hoteles/tickets', null, null, 'k31', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select count(*)::int as compat_deberia_ser_1 from core.list_notifications_for_staff('00000000-0000-0000-0000-00000000c001');
rollback;

\echo '32. la tabla no se lee directo con un usuario autenticado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
select count(*) as should_fail from core.notification;
rollback;

\echo '33. ni anon ni public tienen privilegios sobre las tablas'
begin;
select count(*)::int as grants_deberia_ser_0 from information_schema.role_table_grants
where table_schema = 'core' and table_name in ('notification', 'notification_read') and grantee in ('anon', 'PUBLIC', 'authenticated');
rollback;

\echo '34. las tres funciones security definer nuevas fijan search_path'
begin;
select (count(*) filter (where p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')))::int as definer_con_search_path_deberia_ser_3
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core' and p.proname in ('emit_notification', 'list_notifications_v2_for_staff', 'count_unread_notifications_v2_for_staff');
rollback;

\echo '35. anon no ejecuta ninguna de las tres funciones'
begin;
select count(*)::int as anon_deberia_ser_0 from information_schema.routine_privileges
where routine_schema = 'core' and routine_name in ('emit_notification', 'list_notifications_v2_for_staff', 'count_unread_notifications_v2_for_staff') and grantee in ('anon', 'PUBLIC');
rollback;
