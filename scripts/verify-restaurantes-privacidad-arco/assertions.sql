-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/030_privacidad_arco_aviso_retencion.sql (PM PR-9).
-- Cobertura: positivo, negativo, cross-tenant y anon por cada funcion/tabla nueva (ver README.md).
-- Los escenarios que deben fallar usan verify_support.expect_sqlstate (SQLSTATE exacto, termina
-- en exito); los de valor llevan el alias `..._deberia_ser_N`.
\set ON_ERROR_STOP off
\pset pager off

create schema verify_support;
grant usage on schema verify_support to authenticated, anon;
create function verify_support.expect_sqlstate(p_sql text, p_expected text) returns void
language plpgsql as $f$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_expected then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_expected, v_state, v_msg;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE %, pero la sentencia no fallo', p_expected;
end $f$;
grant execute on function verify_support.expect_sqlstate(text, text) to authenticated, anon;


insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000e1', 'restaurantes', 'Org A (privacidad)', 'org-a-privacidad'),
  ('00000000-0000-0000-0000-0000000000e2', 'restaurantes', 'Org B (privacidad, ajena)', 'org-b-privacidad')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 'Sucursal A'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e2', 'Sucursal B')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000e51', 'owner-a-priv@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000e52', 'admin-a-priv@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000e53', 'staff-a-priv@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-000000000e54', 'owner-b-priv@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000e51', '00000000-0000-0000-0000-0000000000e1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000e52', '00000000-0000-0000-0000-0000000000e1', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000e53', '00000000-0000-0000-0000-0000000000e1', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000e54', '00000000-0000-0000-0000-0000000000e2', null, 'owner', 'owner')
on conflict do nothing;
insert into restaurantes.data_rights_requests (id, organization_id, customer_phone, right_type, status, confirmed_at, response_due_at, execution_due_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', '+5219990000001', 'acceso', 'recibida', now(), now() + interval '20 days', now() + interval '35 days'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e1', '+5219990000002', 'cancelacion', 'recibida', now(), now() + interval '20 days', now() + interval '35 days'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e1', '+5219990000003', 'oposicion', 'resuelta', now(), now() + interval '20 days', now() + interval '35 days');


\echo ''
\echo '=== A) ARCO: registro y confirmacion desde el sistema ==='
\echo ''

\echo '--- 1. registro nuevo: nace pendiente_confirmacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'pendiente_confirmacion' and not out_already_open and out_response_due_at is null)::int as registro_nuevo_deberia_ser_1 from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'acceso', 'whatsapp', 'mensaje');
rollback;

\echo '--- 2. idempotente: mismo (org, telefono, derecho) devuelve la abierta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'acceso', 'whatsapp', 'mensaje');
select (out_already_open)::int as segunda_vez_deberia_ser_1 from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'acceso', 'whatsapp', 'mensaje');
rollback;

\echo '--- 3. idempotente: queda UNA sola fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'acceso', 'whatsapp', 'mensaje');
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'acceso', 'whatsapp', 'mensaje');
reset role;
select count(*) as filas_deberia_ser_1 from restaurantes.data_rights_requests where customer_phone = '+5219990000010' and right_type = 'acceso';
rollback;

\echo '--- 4. un derecho distinto del mismo titular abre otra solicitud ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'acceso', 'whatsapp', 'mensaje');
select (not out_already_open)::int as derecho_distinto_deberia_ser_1 from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'rectificacion', 'whatsapp', null);
rollback;

\echo '--- 5. el registro deja evento registrada del titular ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'acceso', 'whatsapp', 'mensaje');
reset role;
select count(*) as eventos_deberia_ser_1 from restaurantes.data_rights_events e join restaurantes.data_rights_requests r on r.id = e.request_id where r.customer_phone = '+5219990000010' and e.event = 'registrada' and e.actor_kind = 'titular' and e.actor_user_id is null;
rollback;

\echo '--- 6. canal voz: la identidad se basa en el identificador de llamada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000011', 'acceso', 'voice', 'mensaje');
reset role;
select (identity_basis = 'llamada_identificador' and channel = 'voice')::int as identidad_voz_deberia_ser_1 from restaurantes.data_rights_requests where customer_phone = '+5219990000011';
rollback;

\echo '--- 7. canal whatsapp: la identidad se basa en el numero ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000012', 'acceso', 'whatsapp', 'mensaje');
reset role;
select (identity_basis = 'whatsapp_numero')::int as identidad_wa_deberia_ser_1 from restaurantes.data_rights_requests where customer_phone = '+5219990000012';
rollback;

\echo '--- 8. derecho fuera del catalogo: CHECK 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'supresion_total', 'whatsapp', 'mensaje')$q$, '23514') as expect_ok;
rollback;

\echo '--- 9. canal fuera del catalogo: CHECK 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000010', 'acceso', 'sms', 'mensaje')$q$, '23514') as expect_ok;
rollback;

\echo '--- 10. organizacion inexistente: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000ee', '+5219990000010', 'acceso', 'whatsapp', 'mensaje')$q$, '42501') as expect_ok;
rollback;

\echo '--- 11. un usuario autenticado no puede usar la funcion de sistema: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000011', 'acceso', 'whatsapp', 'mensaje')$q$, '42501') as expect_ok;
rollback;

\echo '--- 12. anon no puede ejecutar la funcion de sistema: 42501 ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000011', 'acceso', 'whatsapp', 'mensaje')$q$, '42501') as expect_ok;
rollback;

\echo '--- 13. confirmar desde el mismo numero arranca los plazos (20 y 35 dias) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000020', 'acceso', 'whatsapp', 'mensaje');
select (out_status = 'recibida' and out_response_due_at > now() + interval '19 days 23 hours' and out_response_due_at < now() + interval '20 days 1 hour' and out_execution_due_at > now() + interval '34 days 23 hours' and out_execution_due_at < now() + interval '35 days 1 hour')::int as plazos_deberia_ser_1 from restaurantes.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000e1', '+5219990000020', true);
rollback;

\echo '--- 14. retirar la solicitud la cancela ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000020', 'acceso', 'whatsapp', 'mensaje');
select (out_status = 'cancelada_titular')::int as retiro_deberia_ser_1 from restaurantes.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000e1', '+5219990000020', false);
rollback;

\echo '--- 15. otro telefono NO puede confirmar la solicitud ajena (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000020', 'acceso', 'whatsapp', 'mensaje');
select count(*) as otro_telefono_deberia_ser_0 from restaurantes.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000e1', '+5219990000021', true);
rollback;

\echo '--- 16. otra organizacion NO puede confirmar (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000020', 'acceso', 'whatsapp', 'mensaje');
select count(*) as otra_org_deberia_ser_0 from restaurantes.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000e2', '+5219990000020', true);
rollback;

\echo '--- 17. una confirmacion de mas de 24 h ya no confirma (0 filas) ---'
begin;
insert into restaurantes.data_rights_requests (organization_id, customer_phone, right_type, created_at) values ('00000000-0000-0000-0000-0000000000e1', '+5219990000030', 'acceso', now() - interval '25 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as caducada_deberia_ser_0 from restaurantes.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000e1', '+5219990000030', true);
rollback;

\echo '--- 18. registrar de nuevo expira la pendiente vencida y abre una nueva ---'
begin;
insert into restaurantes.data_rights_requests (id, organization_id, customer_phone, right_type, created_at) values ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000e1', '+5219990000030', 'acceso', now() - interval '25 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (not out_already_open)::int as nueva_deberia_ser_1 from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000030', 'acceso', 'whatsapp', 'mensaje');
reset role;
select (status = 'expirada')::int as vieja_expirada_deberia_ser_1 from restaurantes.data_rights_requests where id = '00000000-0000-0000-0000-0000000000fa';
rollback;

\echo '--- 19. confirmar desde un usuario autenticado: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000e1', '+5219990000001', true)$q$, '42501') as expect_ok;
rollback;


\echo ''
\echo '=== B) ARCO: actualizacion de estado por staff ==='
\echo ''

\echo '--- 20. owner mueve a en_proceso y queda su actor en la bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', 'verificando identidad');
reset role;
select count(*) as bitacora_staff_deberia_ser_1 from restaurantes.data_rights_events where request_id = '00000000-0000-0000-0000-0000000000f1' and actor_kind = 'staff' and actor_user_id = '00000000-0000-0000-0000-000000000e51' and to_status = 'en_proceso';
rollback;

\echo '--- 21. admin tambien puede resolver ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e52', true);
select (out_status = 'resuelta')::int as admin_resuelve_deberia_ser_1 from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'resuelta', 'datos entregados');
rollback;

\echo '--- 22. resolver fija resolved_at, nota y handled_by ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'resuelta', 'datos entregados');
select (resolved_at is not null and resolution_note = 'datos entregados' and handled_by = auth.uid())::int as resuelta_deberia_ser_1 from restaurantes.data_rights_requests where id = '00000000-0000-0000-0000-0000000000f1';
rollback;

\echo '--- 23. rol staff (no owner/admin): 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e53', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, '42501') as expect_ok;
rollback;

\echo '--- 24. owner de OTRA organizacion: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e54', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, '42501') as expect_ok;
rollback;

\echo '--- 25. owner de otra organizacion declarando SU org sobre una solicitud ajena: P0002 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e54', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, 'P0002') as expect_ok;
rollback;

\echo '--- 26. sesion de sistema sin usuario: 28000 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, '28000') as expect_ok;
rollback;

\echo '--- 27. anon: 42501 ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, '42501') as expect_ok;
rollback;

\echo '--- 28. bloqueada es valida para cancelacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select (out_status = 'bloqueada')::int as bloqueo_cancelacion_deberia_ser_1 from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f2', 'bloqueada', null);
rollback;

\echo '--- 29. bloqueada NO es valida para acceso: 55000 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'bloqueada', null)$q$, '55000') as expect_ok;
rollback;

\echo '--- 30. rechazar exige motivo: 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'rechazada', null)$q$, '22023') as expect_ok;
rollback;

\echo '--- 31. rechazar con motivo funciona ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select (out_status = 'rechazada')::int as rechazo_deberia_ser_1 from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'rechazada', 'no se pudo verificar la identidad');
rollback;

\echo '--- 32. un estado terminal no admite mas transiciones: 55000 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f3', 'en_proceso', null)$q$, '55000') as expect_ok;
rollback;

\echo '--- 33. estado destino fuera de la lista: 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'recibida', null)$q$, '22023') as expect_ok;
rollback;

\echo '--- 34. solicitud aun sin confirmar no se procesa: 55000 ---'
begin;
insert into restaurantes.data_rights_requests (id, organization_id, customer_phone, right_type) values ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000e1', '+5219990000040', 'acceso');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f9', 'en_proceso', null)$q$, '55000') as expect_ok;
rollback;

\echo '--- 35. solicitud inexistente: P0002 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000ff', 'en_proceso', null)$q$, 'P0002') as expect_ok;
rollback;


\echo ''
\echo '=== C) ARCO: lectura por RLS y escritura directa denegada ==='
\echo ''

\echo '--- 36. owner ve las solicitudes de SU organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select count(*) as owner_ve_deberia_ser_3 from restaurantes.data_rights_requests;
rollback;

\echo '--- 37. admin ve las de su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e52', true);
select count(*) as admin_ve_deberia_ser_3 from restaurantes.data_rights_requests;
rollback;

\echo '--- 38. rol staff no ve ninguna ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e53', true);
select count(*) as staff_ve_deberia_ser_0 from restaurantes.data_rights_requests;
rollback;

\echo '--- 39. owner de otra organizacion no ve ninguna ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e54', true);
select count(*) as ajeno_ve_deberia_ser_0 from restaurantes.data_rights_requests;
rollback;

\echo '--- 40. anon no tiene SELECT: 42501 ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select count(*) from restaurantes.data_rights_requests$q$, '42501') as expect_ok;
rollback;

\echo '--- 41. el owner no puede insertar directo: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$insert into restaurantes.data_rights_requests (organization_id, customer_phone, right_type) values ('00000000-0000-0000-0000-0000000000e1', '+5219990000099', 'acceso')$q$, '42501') as expect_ok;
rollback;

\echo '--- 42. el owner no puede actualizar directo: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$update restaurantes.data_rights_requests set status = 'resuelta' where id = '00000000-0000-0000-0000-0000000000f1'$q$, '42501') as expect_ok;
rollback;

\echo '--- 43. el owner no puede borrar directo: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$delete from restaurantes.data_rights_requests where id = '00000000-0000-0000-0000-0000000000f1'$q$, '42501') as expect_ok;
rollback;

\echo '--- 44. el owner ve la bitacora de su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null);
select count(*) as bitacora_owner_deberia_ser_1 from restaurantes.data_rights_events;
rollback;

\echo '--- 45. el owner ajeno no ve la bitacora ---'
begin;
insert into restaurantes.data_rights_events (organization_id, request_id, actor_kind, event) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'sistema', 'registrada');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e54', true);
select count(*) as bitacora_ajena_deberia_ser_0 from restaurantes.data_rights_events;
rollback;

\echo '--- 46. la bitacora es append-only: UPDATE 0A000 ---'
begin;
insert into restaurantes.data_rights_events (id, organization_id, request_id, actor_kind, event) values ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'sistema', 'registrada');
select verify_support.expect_sqlstate($q$update restaurantes.data_rights_events set note = 'x' where id = '00000000-0000-0000-0000-0000000000e9'$q$, '0A000') as expect_ok;
rollback;

\echo '--- 47. la bitacora es append-only: DELETE 0A000 ---'
begin;
insert into restaurantes.data_rights_events (id, organization_id, request_id, actor_kind, event) values ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'sistema', 'registrada');
select verify_support.expect_sqlstate($q$delete from restaurantes.data_rights_events where id = '00000000-0000-0000-0000-0000000000e9'$q$, '0A000') as expect_ok;
rollback;


\echo ''
\echo '=== D) privacy_config ==='
\echo ''

\echo '--- 48. owner guarda la config y se lee de vuelta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', 'https://ejemplo.mx/aviso', 'v2', 90, 15, true);
select (notice_url = 'https://ejemplo.mx/aviso' and notice_version = 'v2' and conversation_retention_days = 90 and voice_retention_days = 15 and updated_by = auth.uid())::int as config_deberia_ser_1 from restaurantes.privacy_config where organization_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 49. segundo guardado actualiza (upsert), sigue una sola fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', 'https://ejemplo.mx/aviso', 'v1', 90, 15, true);
select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', null, 'v1', 120, 0, false);
select count(*) as una_fila_deberia_ser_1 from restaurantes.privacy_config where organization_id = '00000000-0000-0000-0000-0000000000e1' and conversation_retention_days = 120 and voice_retention_days = 0;
rollback;

\echo '--- 50. rol staff no puede guardar: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e53', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', null, 'v1', 90, 15, true)$q$, '42501') as expect_ok;
rollback;

\echo '--- 51. owner de otra organizacion no puede guardar la ajena: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e54', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', null, 'v1', 90, 15, true)$q$, '42501') as expect_ok;
rollback;

\echo '--- 52. sistema sin usuario no puede guardar: 28000 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', null, 'v1', 90, 15, true)$q$, '28000') as expect_ok;
rollback;

\echo '--- 53. anon no puede guardar: 42501 ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', null, 'v1', 90, 15, true)$q$, '42501') as expect_ok;
rollback;

\echo '--- 54. retencion de conversaciones menor a 30 dias: CHECK 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', null, 'v1', 7, 15, true)$q$, '23514') as expect_ok;
rollback;

\echo '--- 55. retencion de voz mayor a 365 dias: CHECK 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', null, 'v1', 90, 400, true)$q$, '23514') as expect_ok;
rollback;

\echo '--- 56. URL del aviso sin https: CHECK 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', 'http://inseguro.mx/aviso', 'v1', 90, 15, true)$q$, '23514') as expect_ok;
rollback;

\echo '--- 57. version del aviso con caracteres raros: CHECK 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.update_privacy_config('00000000-0000-0000-0000-0000000000e1', null, 'v 1; drop', 90, 15, true)$q$, '23514') as expect_ok;
rollback;

\echo '--- 58. escritura directa denegada: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$insert into restaurantes.privacy_config (organization_id) values ('00000000-0000-0000-0000-0000000000e1')$q$, '42501') as expect_ok;
rollback;

\echo '--- 59. el sistema (sin usuario) puede leer la config ---'
begin;
insert into restaurantes.privacy_config (organization_id, conversation_retention_days) values ('00000000-0000-0000-0000-0000000000e1', 45);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select conversation_retention_days as sistema_lee_deberia_ser_45 from restaurantes.privacy_config;
rollback;

\echo '--- 60. el owner ajeno no ve la config de otra organizacion ---'
begin;
insert into restaurantes.privacy_config (organization_id) values ('00000000-0000-0000-0000-0000000000e1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e54', true);
select count(*) as config_ajena_deberia_ser_0 from restaurantes.privacy_config;
rollback;

\echo '--- 61. el rol staff no ve la config ---'
begin;
insert into restaurantes.privacy_config (organization_id) values ('00000000-0000-0000-0000-0000000000e1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e53', true);
select count(*) as staff_config_deberia_ser_0 from restaurantes.privacy_config;
rollback;

\echo '--- 62. anon no tiene SELECT sobre la config: 42501 ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select count(*) from restaurantes.privacy_config$q$, '42501') as expect_ok;
rollback;


\echo ''
\echo '=== E) aviso simplificado: evidencia de entrega ==='
\echo ''

\echo '--- 63. primera entrega: TRUE ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1'))::int as primera_deberia_ser_1;
rollback;

\echo '--- 64. segunda entrega de la MISMA version: FALSE ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
select (restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1'))::int as segunda_deberia_ser_0;
rollback;

\echo '--- 65. una version nueva del aviso se entrega otra vez ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
select (restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v2'))::int as version_nueva_deberia_ser_1;
rollback;

\echo '--- 66. otro canal (voz) cuenta aparte ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
select (restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'voice', 'v1'))::int as canal_voz_deberia_ser_1;
rollback;

\echo '--- 67. queda UNA fila de evidencia por telefono-hash/canal/version ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
reset role;
select count(*) as evidencia_deberia_ser_1 from restaurantes.privacy_notice_deliveries;
rollback;

\echo '--- 68. hash de telefono con formato invalido: CHECK 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', '+5219990000001', 'whatsapp', 'v1')$q$, '23514') as expect_ok;
rollback;

\echo '--- 69. canal fuera del catalogo: CHECK 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'sms', 'v1')$q$, '23514') as expect_ok;
rollback;

\echo '--- 70. usuario autenticado no puede usar la funcion de sistema: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1')$q$, '42501') as expect_ok;
rollback;

\echo '--- 71. anon no puede: 42501 ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1')$q$, '42501') as expect_ok;
rollback;

\echo '--- 72. el owner lee la evidencia de SU organizacion ---'
begin;
insert into restaurantes.privacy_notice_deliveries (organization_id, phone_hash, channel, notice_version) values ('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select count(*) as evidencia_owner_deberia_ser_1 from restaurantes.privacy_notice_deliveries;
rollback;

\echo '--- 73. el owner ajeno NO lee la evidencia ---'
begin;
insert into restaurantes.privacy_notice_deliveries (organization_id, phone_hash, channel, notice_version) values ('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e54', true);
select count(*) as evidencia_ajena_deberia_ser_0 from restaurantes.privacy_notice_deliveries;
rollback;

\echo '--- 74. el owner no puede borrar la evidencia: 42501 ---'
begin;
insert into restaurantes.privacy_notice_deliveries (id, organization_id, phone_hash, channel, notice_version) values ('00000000-0000-0000-0000-0000000000e8', '00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$delete from restaurantes.privacy_notice_deliveries where id = '00000000-0000-0000-0000-0000000000e8'$q$, '42501') as expect_ok;
rollback;


\echo ''
\echo '=== F) consentimiento de grabacion de la llamada ==='
\echo ''

\echo '--- 75. sin consentimiento (pendiente) y config por defecto NO se persiste el turno ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0))::int as sin_consentimiento_deberia_ser_0;
rollback;

\echo '--- 76. con consentimiento otorgado SI se persiste el turno ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', true);
select (restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0))::int as con_consentimiento_deberia_ser_1;
reset role;
select count(*) as turnos_deberia_ser_1 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '--- 77. con consentimiento, un turno repetido es idempotente ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', true);
select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0);
select (restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0))::int as repetido_deberia_ser_0;
rollback;

\echo '--- 78. negar el consentimiento borra los turnos ya guardados ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', true);
select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0);
select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 2, 'cliente', 'hola', 100, 50, 0);
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', false);
reset role;
select count(*) as turnos_borrados_deberia_ser_0 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '--- 79. tras negar, no se puede volver a otorgar en la misma llamada ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', false);
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', true);
reset role;
select (recording_consent = 'negado')::int as sigue_negado_deberia_ser_1 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '--- 80. tras negar, voz_registrar_turno no persiste ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', false);
select (restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0))::int as negado_no_persiste_deberia_ser_0;
rollback;

\echo '--- 81. con consent_required=false se persiste aun sin respuesta ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
insert into restaurantes.privacy_config (organization_id, recording_consent_required) values ('00000000-0000-0000-0000-0000000000e1', false);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0))::int as no_requerido_deberia_ser_1;
rollback;

\echo '--- 82. con retencion de voz 0 NO se persiste ni con consentimiento ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
insert into restaurantes.privacy_config (organization_id, voice_retention_days) values ('00000000-0000-0000-0000-0000000000e1', 0);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', true);
select (restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0))::int as retencion_cero_deberia_ser_0;
rollback;

\echo '--- 83. conversacion de OTRA organizacion: 42501 ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', true)$q$, '42501') as expect_ok;
rollback;

\echo '--- 84. usuario autenticado no puede registrar consentimiento: 42501 ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', true)$q$, '42501') as expect_ok;
rollback;

\echo '--- 85. anon no puede registrar consentimiento: 42501 ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role anon;
select verify_support.expect_sqlstate($q$select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', true)$q$, '42501') as expect_ok;
rollback;

\echo '--- 86. conversacion ya cerrada: 42501 ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
update restaurantes.voice_conversation set ended_at = now() where id = '00000000-0000-0000-0000-0000000000c1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', true)$q$, '42501') as expect_ok;
rollback;

\echo '--- 87. voz_registrar_turno sigue siendo solo de sistema: 42501 ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0)$q$, '42501') as expect_ok;
rollback;

\echo '--- 88. voz_registrar_turno de una conversacion ajena: 42501 ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-1', 'llamada', 'gemini-3.8-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 1, 'cliente', 'hola', 100, 50, 0)$q$, '42501') as expect_ok;
rollback;


\echo ''
\echo '=== G) retencion y minimizacion ==='
\echo ''

\echo '--- 89. conversacion vencida (200 dias, retencion por defecto 180) se vacia ---'
begin;
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages, updated_at) values ('00000000-0000-0000-0000-0000000000e1', '+5219990000100', '[{"role":"user","content":"hola"}]'::jsonb, now() - interval '200 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_conversations_cleared as vaciadas_deberia_ser_1 from restaurantes.system_purge_expired_privacy_data(500);
rollback;

\echo '--- 90. conversacion reciente NO se toca ---'
begin;
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages, updated_at) values ('00000000-0000-0000-0000-0000000000e1', '+5219990000101', '[{"role":"user","content":"hola"}]'::jsonb, now() - interval '10 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_conversations_cleared as vaciadas_deberia_ser_0 from restaurantes.system_purge_expired_privacy_data(500);
rollback;

\echo '--- 91. el mensaje queda vacio pero la fila se conserva ---'
begin;
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages, updated_at) values ('00000000-0000-0000-0000-0000000000e1', '+5219990000100', '[{"role":"user","content":"hola"}]'::jsonb, now() - interval '200 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_purge_expired_privacy_data(500);
reset role;
select count(*) as fila_conservada_vacia_deberia_ser_1 from restaurantes.whatsapp_conversations where phone = '+5219990000100' and messages = '[]'::jsonb;
rollback;

\echo '--- 92. la retencion se respeta POR organizacion (30 dias en B) ---'
begin;
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages, updated_at) values ('00000000-0000-0000-0000-0000000000e2', '+5219990000103', '[{"role":"user","content":"hola"}]'::jsonb, now() - interval '40 days');
insert into restaurantes.privacy_config (organization_id, conversation_retention_days) values ('00000000-0000-0000-0000-0000000000e2', 30);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_purge_expired_privacy_data(500);
reset role;
select count(*) as b_vaciada_deberia_ser_1 from restaurantes.whatsapp_conversations where messages = '[]'::jsonb and organization_id = '00000000-0000-0000-0000-0000000000e2' and phone = '+5219990000103';
rollback;

\echo '--- 93. la conversacion de A con 40 dias sigue intacta (retencion 180) ---'
begin;
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages, updated_at) values ('00000000-0000-0000-0000-0000000000e1', '+5219990000102', '[{"role":"user","content":"hola"}]'::jsonb, now() - interval '40 days');
insert into restaurantes.privacy_config (organization_id, conversation_retention_days) values ('00000000-0000-0000-0000-0000000000e2', 30);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_purge_expired_privacy_data(500);
reset role;
select count(*) as a_intacta_deberia_ser_1 from restaurantes.whatsapp_conversations where phone = '+5219990000102' and messages <> '[]'::jsonb;
rollback;

\echo '--- 94. una solicitud ARCO abierta del titular bloquea la purga de su conversacion ---'
begin;
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages, updated_at) values ('00000000-0000-0000-0000-0000000000e1', '+5219990000002', '[{"role":"user","content":"hola"}]'::jsonb, now() - interval '200 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_conversations_cleared as vaciadas_deberia_ser_0 from restaurantes.system_purge_expired_privacy_data(500);
rollback;

\echo '--- 95. una solicitud ARCO ya resuelta NO bloquea la purga ---'
begin;
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages, updated_at) values ('00000000-0000-0000-0000-0000000000e1', '+5219990000003', '[{"role":"user","content":"hola"}]'::jsonb, now() - interval '200 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_conversations_cleared as vaciadas_deberia_ser_1 from restaurantes.system_purge_expired_privacy_data(500);
rollback;

\echo '--- 96. transcripcion de voz vencida (40 dias, retencion 30): se borran los turnos ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-old', 'llamada', 'gemini-3.8-live', repeat('c', 64), now() - interval '40 days', now() - interval '40 days');
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', 1, 'cliente', 'hola');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_voice_turns_deleted as turnos_deberia_ser_1 from restaurantes.system_purge_expired_privacy_data(500);
rollback;

\echo '--- 97. la llamada vencida queda anonimizada (caller_hash nulo) ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-old', 'llamada', 'gemini-3.8-live', repeat('c', 64), now() - interval '40 days', now() - interval '40 days');
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', 1, 'cliente', 'hola');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_purge_expired_privacy_data(500);
reset role;
select (caller_hash is null)::int as anonimizada_deberia_ser_1 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '--- 98. una llamada reciente NO se purga ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-old', 'llamada', 'gemini-3.8-live', repeat('c', 64), now() - interval '2 days', now() - interval '2 days');
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', 1, 'cliente', 'hola');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_voice_turns_deleted as turnos_deberia_ser_0 from restaurantes.system_purge_expired_privacy_data(500);
rollback;

\echo '--- 99. la llamada de un titular con ARCO abierto (mismo telefono) no se purga ---'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'call-old', 'llamada', 'gemini-3.8-live', encode(sha256(convert_to('5219990000002', 'UTF8')), 'hex'), now() - interval '40 days', now() - interval '40 days');
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', 1, 'cliente', 'hola');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_voice_turns_deleted as turnos_deberia_ser_0 from restaurantes.system_purge_expired_privacy_data(500);
rollback;

\echo '--- 100. la purga es solo de sistema: usuario autenticado 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000e51', true);
select verify_support.expect_sqlstate($q$select * from restaurantes.system_purge_expired_privacy_data(10)$q$, '42501') as expect_ok;
rollback;

\echo '--- 101. la purga no la puede ejecutar anon: 42501 ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from restaurantes.system_purge_expired_privacy_data(10)$q$, '42501') as expect_ok;
rollback;


\echo ''
\echo '=== H) base de PRODUCCION a medio migrar (030 no aplicada) ==='
\echo ''

\echo '--- 102. funcion de registro ELIMINADA: 42883 y el SAVEPOINT deja la transaccion utilizable ---'
begin;
drop function restaurantes.system_register_data_rights_request(uuid, text, text, text, text);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
savepoint sp_verify;
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.system_register_data_rights_request('00000000-0000-0000-0000-0000000000e1', '+5219990000060', 'acceso', 'whatsapp', 'mensaje');
    raise exception 'se esperaba SQLSTATE 42883 y no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify;
release savepoint sp_verify;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '--- 103. funcion de reclamo del aviso ELIMINADA: 42883 recuperable ---'
begin;
drop function restaurantes.system_claim_privacy_notice(uuid, text, text, text);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
savepoint sp_verify;
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.system_claim_privacy_notice('00000000-0000-0000-0000-0000000000e1', repeat('a', 64), 'whatsapp', 'v1');
    raise exception 'se esperaba SQLSTATE 42883 y no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify;
release savepoint sp_verify;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '--- 104. funcion de purga ELIMINADA: 42883 recuperable ---'
begin;
drop function restaurantes.system_purge_expired_privacy_data(integer);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
savepoint sp_verify;
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.system_purge_expired_privacy_data(10);
    raise exception 'se esperaba SQLSTATE 42883 y no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify;
release savepoint sp_verify;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '--- 105. tabla de configuracion ELIMINADA: 42P01 recuperable con SAVEPOINT ---'
begin;
drop function restaurantes.voz_registrar_turno(uuid, uuid, integer, text, text, integer, integer, bigint);
drop table restaurantes.privacy_config;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
savepoint sp_verify;
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.privacy_config;
    raise exception 'se esperaba SQLSTATE 42P01 y no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify;
release savepoint sp_verify;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
