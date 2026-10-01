-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT +
-- auth.uid() reales -- el repositorio en memoria de domain-citas nunca aplica
-- ninguno de los tres), que packages/domain-citas/migrations/024_citas_data_rights.sql
-- cierra lo que dice cerrar. Mismo patron que scripts/verify-citas-audit-log/.
--
-- Cobertura (positivo, negativo, cross-tenant, anon):
--   A. Registro desde el sistema (webhook sin usuario): crea la solicitud en
--      'pendiente_confirmacion', es idempotente por (org, telefono, derecho), un
--      derecho distinto abre otra, y la rechaza cualquier sesion CON usuario o anon.
--   B. Confirmacion/retiro por el titular: arranca los plazos (20 + 15 dias),
--      solo afecta SU telefono y SU organizacion, y una confirmacion de mas de 24 h
--      caduca (expirada) en vez de confirmarse.
--   C. Actualizacion de estado por staff: solo owner/admin de la organizacion;
--      cross-tenant, rol 'staff', sistema y anon rechazados; transiciones validas e
--      invalidas ('bloqueada' solo para cancelacion, 'rechazada' exige motivo).
--   D. Lectura (RLS): owner/admin ven su organizacion; staff, owner ajeno y anon no.
--   E. Deny-by-default de escritura directa (INSERT/UPDATE/DELETE) y bitacora de
--      eventos append-only.
--   F. Base de PRODUCCION a medio migrar (024 no aplicada): el SQLSTATE real
--      (42883/42P01) de las sentencias que emite PostgresCitasRepository, recuperado
--      con SAVEPOINT real.
--
-- Los escenarios que deben fallar usan verify_support.expect_sqlstate: exige el
-- SQLSTATE EXACTO (un error cualquiera NO basta para pasar) y terminan en exito.
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
  ('00000000-0000-0000-0000-0000000000d1', 'citas', 'Org A (citas ARCO)', 'org-a-citas-arco'),
  ('00000000-0000-0000-0000-0000000000d2', 'citas', 'Org B (citas ARCO, ajena)', 'org-b-citas-arco')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000051', 'owner-a-arco@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000052', 'admin-a-arco@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000053', 'staff-a-arco@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-000000000054', 'owner-b-arco@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-0000000000d1', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000053', '00000000-0000-0000-0000-0000000000d1', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000054', '00000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

-- Fixture persistente (insert directo como superusuario): solicitudes de la Org A
-- para los escenarios de LECTURA y de actualizacion.
insert into citas.data_rights_requests (id, organization_id, customer_phone, right_type, status, confirmed_at, response_due_at, execution_due_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', '+5219990000001', 'acceso', 'recibida', now(), now() + interval '20 days', now() + interval '35 days'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d1', '+5219990000002', 'cancelacion', 'recibida', now(), now() + interval '20 days', now() + interval '35 days'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000d1', '+5219990000003', 'oposicion', 'resuelta', now(), now() + interval '20 days', now() + interval '35 days');

\echo ''
\echo '=== A) registro desde el sistema ==='
\echo ''

\echo '--- 1. sistema registra una solicitud nueva: nace pendiente_confirmacion y no estaba abierta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'pendiente_confirmacion' and not out_already_open and out_response_due_at is null)::int as registro_nuevo_deberia_ser_1 from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'acceso', 'whatsapp', 'mensaje');
rollback;

\echo '--- 2. idempotente: el mismo (org, telefono, derecho) devuelve la solicitud abierta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select (out_already_open)::int as segunda_vez_ya_abierta_deberia_ser_1 from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'acceso', 'whatsapp', 'otra vez');
rollback;

\echo '--- 3. idempotente: solo queda UNA fila para ese derecho ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
reset role;
select count(*) as filas_deberia_ser_1 from citas.data_rights_requests where customer_phone = '+5219990000010' and right_type = 'acceso';
rollback;

\echo '--- 4. un derecho DISTINTO del mismo titular abre otra solicitud ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select (not out_already_open)::int as derecho_distinto_nueva_deberia_ser_1 from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'rectificacion', 'whatsapp', null);
rollback;

\echo '--- 5. el registro deja un evento 'registrada' del titular en la bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
reset role;
select count(*) as eventos_deberia_ser_1 from citas.data_rights_events e join citas.data_rights_requests r on r.id = e.request_id where r.customer_phone = '+5219990000010' and e.event = 'registrada' and e.actor_kind = 'titular' and e.actor_user_id is null;
rollback;

\echo '--- 6. derecho fuera del catalogo cerrado: CHECK (23514) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000010', 'supresion_total', 'whatsapp', 'quiero ejercer mi derecho')$q$, '23514') as expect_ok;
rollback;

\echo '--- 7. un usuario AUTENTICADO (auth.uid() no nulo) no puede usar la funcion de sistema (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000011', 'acceso', 'whatsapp', 'quiero ejercer mi derecho')$q$, '42501') as expect_ok;
rollback;

\echo '--- 8. anon no puede ejecutar la funcion de sistema (42501, sin GRANT) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000011', 'acceso', 'whatsapp', 'quiero ejercer mi derecho')$q$, '42501') as expect_ok;
rollback;

\echo '--- 9. organizacion inexistente: FK (23503), nunca una fila huerfana ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000ee', '+5219990000012', 'acceso', 'whatsapp', null)$q$, '23503') as expect_ok;
rollback;

\echo ''
\echo '=== B) confirmacion / retiro por el titular ==='
\echo ''

\echo '--- 10. confirmar arranca los plazos: respuesta a 20 dias y ejecucion 15 dias mas (35 desde la confirmacion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000020', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select (out_status = 'recibida' and out_response_due_at = now() + interval '20 days' and out_execution_due_at = now() + interval '35 days')::int as plazos_20_y_15_dias_deberia_ser_1 from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000020', true);
rollback;

\echo '--- 11. confirmar deja evento 'confirmada' y confirmed_at ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000020', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select * from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000020', true);
reset role;
select count(*) as eventos_deberia_ser_1 from citas.data_rights_events e join citas.data_rights_requests r on r.id = e.request_id where r.customer_phone = '+5219990000020' and e.event = 'confirmada' and r.confirmed_at is not null;
rollback;

\echo '--- 12. retirar la solicitud: cancelada_titular, sin plazos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000020', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select (out_status = 'cancelada_titular' and out_response_due_at is null)::int as retiro_deberia_ser_1 from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000020', false);
rollback;

\echo '--- 13. sin solicitud pendiente no hay nada que confirmar (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sin_pendiente_deberia_ser_0 from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000021', true);
rollback;

\echo '--- 14. otro TELEFONO no puede confirmar la solicitud de alguien mas (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000020', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select count(*) as telefono_ajeno_deberia_ser_0 from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000099', true);
rollback;

\echo '--- 15. otro TELEFONO no la confirma: la solicitud original sigue pendiente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000020', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select * from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000099', true);
reset role;
select count(*) as sigue_pendiente_deberia_ser_1 from citas.data_rights_requests where customer_phone = '+5219990000020' and status = 'pendiente_confirmacion';
rollback;

\echo '--- 16. cross-tenant: confirmar con OTRA organizacion no toca la solicitud (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000020', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
select count(*) as org_ajena_deberia_ser_0 from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d2', '+5219990000020', true);
rollback;

\echo '--- 17. una solicitud pendiente de mas de 24 h NO se confirma (0 filas) ---'
begin;
insert into citas.data_rights_requests (organization_id, customer_phone, right_type, created_at) values ('00000000-0000-0000-0000-0000000000d1', '+5219990000030', 'acceso', now() - interval '25 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as caducada_deberia_ser_0 from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000030', true);
rollback;

\echo '--- 18. al volver a pedir tras 24 h, la vieja pasa a expirada y se abre una NUEVA ---'
begin;
insert into citas.data_rights_requests (organization_id, customer_phone, right_type, created_at) values ('00000000-0000-0000-0000-0000000000d1', '+5219990000030', 'acceso', now() - interval '25 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000030', 'acceso', 'whatsapp', 'quiero ejercer mi derecho');
reset role;
select count(*) filter (where status = 'expirada') * 10 + count(*) filter (where status = 'pendiente_confirmacion') as expirada_y_nueva_deberia_ser_11 from citas.data_rights_requests where customer_phone = '+5219990000030';
rollback;

\echo '--- 19. un usuario autenticado no puede confirmar por el titular (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$select * from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000020', true)$q$, '42501') as expect_ok;
rollback;

\echo '--- 20. anon no puede ejecutar la confirmacion (42501) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000020', true)$q$, '42501') as expect_ok;
rollback;

\echo ''
\echo '=== C) actualizacion de estado por staff (owner/admin) ==='
\echo ''

\echo '--- 21. owner de la Org A pasa recibida -> en_proceso ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select (out_status = 'en_proceso')::int as owner_en_proceso_deberia_ser_1 from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null);
rollback;

\echo '--- 22. admin de la Org A tambien puede (no solo owner) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000052', true);
select (out_status = 'en_proceso')::int as admin_en_proceso_deberia_ser_1 from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null);
rollback;

\echo '--- 23. el cambio registra el actor real (auth.uid()) en un evento de staff ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null);
select (count(*) = 1)::int as evento_staff_deberia_ser_1 from citas.data_rights_events where request_id = '00000000-0000-0000-0000-0000000000f1' and actor_kind = 'staff' and actor_user_id = auth.uid() and from_status = 'recibida' and to_status = 'en_proceso';
rollback;

\echo '--- 24. resolver fija resolved_at, la nota y handled_by ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'resuelta', 'datos entregados');
select (resolved_at is not null and resolution_note = 'datos entregados' and handled_by = auth.uid())::int as resuelta_deberia_ser_1 from citas.data_rights_requests where id = '00000000-0000-0000-0000-0000000000f1';
rollback;

\echo '--- 25. 'bloqueada' es valida para CANCELACION (bloqueo previo a la supresion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select (out_status = 'bloqueada')::int as bloqueo_cancelacion_deberia_ser_1 from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f2', 'bloqueada', null);
rollback;

\echo '--- 26. 'bloqueada' NO es valida para un derecho de ACCESO (55000) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'bloqueada', null)$q$, '55000') as expect_ok;
rollback;

\echo '--- 27. rechazar exige motivo (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'rechazada', null)$q$, '22023') as expect_ok;
rollback;

\echo '--- 28. rechazar con motivo funciona ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select (out_status = 'rechazada')::int as rechazo_con_motivo_deberia_ser_1 from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'rechazada', 'no se pudo verificar la identidad');
rollback;

\echo '--- 29. un estado terminal no admite mas transiciones (55000) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f3', 'en_proceso', null)$q$, '55000') as expect_ok;
rollback;

\echo '--- 30. estado destino fuera de la lista permitida (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'recibida', null)$q$, '22023') as expect_ok;
rollback;

\echo '--- 31. una solicitud aun sin confirmar por el titular no se puede procesar (55000) ---'
begin;
insert into citas.data_rights_requests (id, organization_id, customer_phone, right_type) values ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000d1', '+5219990000040', 'acceso');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f9', 'en_proceso', null)$q$, '55000') as expect_ok;
rollback;

\echo '--- 32. solicitud inexistente (P0002) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000ff', 'en_proceso', null)$q$, 'P0002') as expect_ok;
rollback;

\echo '--- 33. rol 'staff' de la Org A (agenda) NO puede actualizar (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000053', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, '42501') as expect_ok;
rollback;

\echo '--- 34. cross-tenant: owner de la Org B usando SU organizacion no encuentra la solicitud de la A (P0002) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000054', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, 'P0002') as expect_ok;
rollback;

\echo '--- 35. cross-tenant: owner de la Org B usando la organizacion A (42501, no pertenece) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000054', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, '42501') as expect_ok;
rollback;

\echo '--- 36. sesion de sistema (sin auth.uid()) no puede cambiar estados (28000) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, '28000') as expect_ok;
rollback;

\echo '--- 37. anon no puede ejecutar la actualizacion (42501) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null)$q$, '42501') as expect_ok;
rollback;

\echo ''
\echo '=== D) lectura (RLS + GRANT por columna) ==='
\echo ''

\echo '--- 38. owner de la Org A ve exactamente sus 3 solicitudes ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select count(*) as filas_deberia_ser_3 from citas.data_rights_requests;
rollback;

\echo '--- 39. admin de la Org A tambien lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000052', true);
select count(*) as filas_deberia_ser_3 from citas.data_rights_requests;
rollback;

\echo '--- 40. rol 'staff' de la Org A NO lee (0 filas, no error) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000053', true);
select count(*) as filas_deberia_ser_0 from citas.data_rights_requests;
rollback;

\echo '--- 41. owner de la Org B (ajeno) NO ve nada de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000054', true);
select count(*) as filas_deberia_ser_0 from citas.data_rights_requests where organization_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 42. anon no puede leer la tabla (42501) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select count(*) from citas.data_rights_requests$q$, '42501') as expect_ok;
rollback;

\echo '--- 43. anon no puede leer la bitacora de eventos (42501) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select count(*) from citas.data_rights_events$q$, '42501') as expect_ok;
rollback;

\echo '--- 44. owner ve en la bitacora el evento de un cambio de su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select * from citas.update_data_rights_request_status('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'en_proceso', null);
select count(*) as eventos_deberia_ser_1 from citas.data_rights_events where organization_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 45. owner ajeno no ve los eventos de la Org A ---'
begin;
insert into citas.data_rights_events (organization_id, request_id, actor_kind, event, to_status) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'sistema', 'registrada', 'recibida');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000054', true);
select count(*) as eventos_ajenos_deberia_ser_0 from citas.data_rights_events;
rollback;

\echo '--- 46. rol 'staff' no ve los eventos ---'
begin;
insert into citas.data_rights_events (organization_id, request_id, actor_kind, event, to_status) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'sistema', 'registrada', 'recibida');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000053', true);
select count(*) as eventos_staff_deberia_ser_0 from citas.data_rights_events;
rollback;

\echo ''
\echo '=== E) deny-by-default de escritura directa y bitacora append-only ==='
\echo ''

\echo '--- 47. authenticated no puede INSERT directo en la tabla (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$insert into citas.data_rights_requests (organization_id, customer_phone, right_type) values ('00000000-0000-0000-0000-0000000000d1', '+5219990000050', 'acceso')$q$, '42501') as expect_ok;
rollback;

\echo '--- 48. authenticated no puede UPDATE directo: saltaria transiciones y plazos (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$update citas.data_rights_requests set status = 'resuelta'$q$, '42501') as expect_ok;
rollback;

\echo '--- 49. authenticated no puede DELETE (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$delete from citas.data_rights_requests$q$, '42501') as expect_ok;
rollback;

\echo '--- 50. authenticated no puede INSERT en la bitacora (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000051', true);
select verify_support.expect_sqlstate($q$insert into citas.data_rights_events (organization_id, request_id, actor_kind, event) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'staff', 'cambio_estado')$q$, '42501') as expect_ok;
rollback;

\echo '--- 51. la bitacora es append-only: UPDATE bloqueado incluso para el superusuario (0A000) ---'
begin;
insert into citas.data_rights_events (organization_id, request_id, actor_kind, event, to_status) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'sistema', 'registrada', 'recibida');
select verify_support.expect_sqlstate($q$update citas.data_rights_events set note = 'x'$q$, '0A000') as expect_ok;
rollback;

\echo '--- 52. la bitacora es append-only: DELETE bloqueado incluso para el superusuario (0A000) ---'
begin;
insert into citas.data_rights_events (organization_id, request_id, actor_kind, event, to_status) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'sistema', 'registrada', 'recibida');
select verify_support.expect_sqlstate($q$delete from citas.data_rights_events$q$, '0A000') as expect_ok;
rollback;

\echo '--- 53. GRANT SELECT por COLUMNA: 17 columnas explicitas (no a nivel tabla) ---'
begin;
select count(*) as columnas_con_grant_deberia_ser_17 from information_schema.column_privileges where table_schema = 'citas' and table_name = 'data_rights_requests' and grantee = 'authenticated' and privilege_type = 'SELECT';
rollback;

\echo '--- 54. nadie (authenticated/anon/service_role/PUBLIC) tiene GRANT de escritura sobre las 2 tablas ---'
begin;
select count(*) as grants_escritura_deberia_ser_0 from information_schema.role_table_grants where table_schema = 'citas' and table_name in ('data_rights_requests','data_rights_events') and grantee in ('authenticated','anon','service_role','PUBLIC') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');
rollback;

\echo ''
\echo '=== F) base de PRODUCCION a medio migrar (024 no aplicada) ==='
\echo ''

\echo '--- 55. funcion de registro ELIMINADA en la misma transaccion: 42883, y SAVEPOINT deja la transaccion utilizable ---'
begin;
drop function citas.system_register_data_rights_request(uuid, text, text, text, text);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
savepoint sp_verify_registro;
do $$
declare
  v_state text;
begin
  begin
    perform * from citas.system_register_data_rights_request('00000000-0000-0000-0000-0000000000d1', '+5219990000060', 'acceso', 'whatsapp', null);
    raise exception 'se esperaba SQLSTATE 42883 y no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_registro;
release savepoint sp_verify_registro;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '--- 56. funcion de confirmacion ELIMINADA: 42883 recuperable con SAVEPOINT ---'
begin;
drop function citas.system_resolve_data_rights_confirmation(uuid, text, boolean);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
savepoint sp_verify_confirmacion;
do $$
declare
  v_state text;
begin
  begin
    perform * from citas.system_resolve_data_rights_confirmation('00000000-0000-0000-0000-0000000000d1', '+5219990000060', true);
    raise exception 'se esperaba SQLSTATE 42883 y no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_confirmacion;
release savepoint sp_verify_confirmacion;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '--- 57. tablas ELIMINADAS: la lectura del panel falla con 42P01, recuperable con SAVEPOINT ---'
begin;
drop table citas.data_rights_events;
drop table citas.data_rights_requests;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
savepoint sp_verify_lectura;
do $$
declare
  v_state text;
begin
  begin
    perform id, customer_phone, right_type, status from citas.data_rights_requests where organization_id = '00000000-0000-0000-0000-0000000000d1' order by created_at desc, seq desc limit 50;
    raise exception 'se esperaba SQLSTATE 42P01 y no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_lectura;
release savepoint sp_verify_lectura;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo ''
\echo '=== fin: 57 escenarios (los alias deberia_ser_N validan el valor exacto; el resto debe terminar sin error, y los negativos exigen el SQLSTATE exacto via expect_sqlstate) ==='
