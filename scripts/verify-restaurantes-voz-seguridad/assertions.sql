-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/026_voz_secretos_sucursal_y_estado_pedido.sql
-- (secretos de voz por sucursal, estado del pedido en el servidor y bitacora de voz).
--
--   A. verify_voice_branch_secret (solo-sistema): coincide solo dentro de SU organizacion; el secreto
--      anterior vale solo dentro de la ventana de gracia; un staff autenticado y anon son rechazados.
--   B. rotate_voice_branch_secret (staff owner/admin): rota el secreto de una sucursal de su
--      organizacion; staff/repartidor, otra organizacion, sucursal ajena y sesion de sistema rechazados.
--   C. voice_branch_secret: ni authenticated ni anon pueden leer la tabla (ni el hash).
--   D. order_flow_state (solo-sistema): crear con expected=0, avanzar con CAS, conflicto con version
--      vieja, vencimiento visible como "sin estado", aislamiento entre organizaciones, staff y anon rechazados.
--   E. voice_tool_audit: escritura solo-sistema, append-only (UPDATE/DELETE bloqueados), lectura solo
--      owner/admin de la organizacion, sin lectura cross-tenant ni anon; los CHECK rechazan valores invalidos.
--   F. base SIN migrar: las funciones eliminadas dentro de la transaccion dan 42883 y un SAVEPOINT real
--      recupera la transaccion (el mismo mecanismo que runWithSavepointFallback usa en produccion).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail`
-- marca el que debe terminar en ERROR; `..._deberia_ser_N` el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c0a01', 'restaurantes', 'Voz Org A', 'voz-org-a'),
  ('00000000-0000-0000-0000-0000000c0a02', 'restaurantes', 'Voz Org B', 'voz-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-0000000c0a01', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000c0b02', '00000000-0000-0000-0000-0000000c0a01', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000c0b03', '00000000-0000-0000-0000-0000000c0a02', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c0c01', 'voz-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0c02', 'voz-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0c03', 'voz-staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0c04', 'voz-repartidor-a@example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0c05', 'voz-owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0a01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c0c02', '00000000-0000-0000-0000-0000000c0a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000c0c03', '00000000-0000-0000-0000-0000000c0a01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c0c04', '00000000-0000-0000-0000-0000000c0a01', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000c0c05', '00000000-0000-0000-0000-0000000c0a02', null, 'owner', 'owner')
on conflict do nothing;

-- Secreto vigente de la sucursal A1 (hash de 64 hex) + bitacora de la Org A: fixtures directas (superusuario).
insert into restaurantes.voice_branch_secret (property_id, organization_id, secret_hash, secret_hint)
values ('00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-0000000c0a01', repeat('a', 64), 'aaaa')
on conflict do nothing;
insert into restaurantes.voice_tool_audit (organization_id, property_id, call_id, tool, outcome, phone_hash, detail)
values ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b01', 'call-fixture', 'buscar_productos', 'ok', repeat('b', 64), null);

\echo ''
\echo '=== A) verify_voice_branch_secret (solo-sistema) ==='
\echo ''

\echo '--- 1. sesion de sistema (auth.uid() NULL) con el secreto correcto de SU organizacion: devuelve la sucursal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', repeat('a', 64)) = '00000000-0000-0000-0000-0000000c0b01')::int as sucursal_correcta_deberia_ser_1;
rollback;

\echo '--- 2. el MISMO secreto presentado contra OTRA organizacion: NULL (cross-tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a02', repeat('a', 64)) is null)::int as cross_tenant_nulo_deberia_ser_1;
rollback;

\echo '--- 3. secreto desconocido o con formato invalido: NULL ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', repeat('f', 64)) is null
        and restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', 'no-es-un-hash') is null)::int as desconocido_nulo_deberia_ser_1;
rollback;

\echo '--- 4. staff autenticado (auth.uid() no nulo) NO puede verificar secretos: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', repeat('a', 64)) as should_fail;
rollback;

\echo '--- 5. anon no tiene EXECUTE: RECHAZADO ---'
begin;
set local role anon;
select restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', repeat('a', 64)) as should_fail;
rollback;

\echo '--- 6. rotacion con gracia: el secreto anterior sigue valido; con gracia 0 deja de valer ---'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
set local role authenticated;
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b01', repeat('c', 64), 'cccc', 3600);
select set_config('request.jwt.claim.sub', '', true);
select ((restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', repeat('a', 64)) is not null)
        and (restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', repeat('c', 64)) is not null))::int as anterior_y_nuevo_validos_deberia_ser_1;
rollback;

\echo '--- 7. rotacion con gracia 0: el secreto anterior deja de valer de inmediato ---'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
set local role authenticated;
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b01', repeat('d', 64), 'dddd', 0);
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', repeat('a', 64)) is null)::int as anterior_vencido_deberia_ser_1;
rollback;

\echo ''
\echo '=== B) rotate_voice_branch_secret (staff owner/admin) ==='
\echo ''

\echo '--- 8. owner de la Org A rota el secreto de una sucursal SIN secreto previo (A2): OK ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b02', repeat('e', 64), 'eeee', 3600) as rotado_en;
rollback;

\echo '--- 9. admin de la Org A tambien puede rotar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c02', true);
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b02', repeat('e', 64), 'eeee', 3600) as rotado_en;
rollback;

\echo '--- 10. staff (no owner/admin) de la Org A: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c03', true);
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b02', repeat('e', 64), 'eeee', 3600) as should_fail;
rollback;

\echo '--- 11. repartidor de la Org A: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c04', true);
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b02', repeat('e', 64), 'eeee', 3600) as should_fail;
rollback;

\echo '--- 12. owner de la Org B contra una sucursal de la Org A: RECHAZADO (cross-tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c05', true);
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b02', repeat('e', 64), 'eeee', 3600) as should_fail;
rollback;

\echo '--- 13. owner de la Org A con la sucursal de la Org B (organization_id propio, property ajena): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b03', repeat('e', 64), 'eeee', 3600) as should_fail;
rollback;

\echo '--- 14. sesion de sistema (auth.uid() NULL) no puede rotar: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b02', repeat('e', 64), 'eeee', 3600) as should_fail;
rollback;

\echo '--- 15. hash con formato invalido: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b02', 'secreto-en-claro', 'xxxx', 3600) as should_fail;
rollback;

\echo '--- 16. anon no puede rotar: RECHAZADO ---'
begin;
set local role anon;
select restaurantes.rotate_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b02', repeat('e', 64), 'eeee', 3600) as should_fail;
rollback;

\echo ''
\echo '=== C) la tabla de secretos no es legible por ningun rol de la API ==='
\echo ''

\echo '--- 17. owner autenticado no puede leer voice_branch_secret (ni el hash): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select secret_hash as should_fail from restaurantes.voice_branch_secret;
rollback;

\echo '--- 18. anon no puede leer voice_branch_secret: RECHAZADO ---'
begin;
set local role anon;
select secret_hash as should_fail from restaurantes.voice_branch_secret;
rollback;

\echo '--- 19. owner autenticado no puede escribir directo en voice_branch_secret: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
update restaurantes.voice_branch_secret set secret_hash = repeat('9', 64) returning 1 as should_fail;
rollback;

\echo '--- 20. el mismo hash no puede asignarse a dos sucursales (unicidad) ---'
begin;
insert into restaurantes.voice_branch_secret (property_id, organization_id, secret_hash, secret_hint)
values ('00000000-0000-0000-0000-0000000c0b02', '00000000-0000-0000-0000-0000000c0a01', repeat('a', 64), 'aaaa') returning 1 as should_fail;
rollback;

\echo ''
\echo '=== D) order_flow_state (solo-sistema, CAS por version) ==='
\echo ''

\echo '--- 21. crear con expected=0 escribe; repetir expected=0 es conflicto ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c1', 0, 'cotizado', '{"quoteHash":"h"}'::jsonb, 600);
select (restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c1', 0, 'cotizado', '{"quoteHash":"h2"}'::jsonb, 600) = 'conflict')::int as segundo_insert_es_conflicto_deberia_ser_1;
rollback;

\echo '--- 22. avanzar con la version correcta escribe y sube la version; con la version vieja es conflicto ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c2', 0, 'cotizado', '{"quoteHash":"h"}'::jsonb, 600);
select restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c2', 1, 'confirmado', '{"quoteHash":"h"}'::jsonb, 600);
select ((select version from restaurantes.read_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c2')) = 2
        and restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c2', 1, 'creando', '{"quoteHash":"h"}'::jsonb, 600) = 'conflict')::int as version_vieja_es_conflicto_deberia_ser_1;
rollback;

\echo '--- 23. un estado VENCIDO se lee como sin estado pero conserva su version ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c3', 0, 'cotizado', '{"quoteHash":"h"}'::jsonb, 600);
reset role;
update restaurantes.order_flow_state set expires_at = now() - interval '1 minute' where flow_key = 'call:c3';
set local role authenticated;
select (state is null and context is null and version = 1)::int as vencido_sin_estado_con_version_deberia_ser_1 from restaurantes.read_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c3');
rollback;

\echo '--- 24. la clave de OTRA organizacion no se ve: misma flow_key, otra org = sin estado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'wa:5219990000000', 0, 'cotizado', '{"quoteHash":"h"}'::jsonb, 600);
select (state is null and version = 0)::int as otra_org_sin_estado_deberia_ser_1 from restaurantes.read_order_flow_state('00000000-0000-0000-0000-0000000c0a02', 'wa:5219990000000');
rollback;

\echo '--- 25. estado invalido: RECHAZADO por el CHECK ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c4', 0, 'hackeado', '{}'::jsonb, 600) as should_fail;
rollback;

\echo '--- 26. staff autenticado no puede leer ni escribir estados: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c5', 0, 'cotizado', '{}'::jsonb, 600) as should_fail;
rollback;

\echo '--- 27. staff autenticado no puede leer estados: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select state as should_fail from restaurantes.read_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c5');
rollback;

\echo '--- 28. anon no puede escribir estados: RECHAZADO ---'
begin;
set local role anon;
select restaurantes.write_order_flow_state('00000000-0000-0000-0000-0000000c0a01', 'call:c6', 0, 'cotizado', '{}'::jsonb, 600) as should_fail;
rollback;

\echo '--- 29. la tabla de estados no es legible directo por authenticated: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select flow_key as should_fail from restaurantes.order_flow_state;
rollback;

\echo ''
\echo '=== E) voice_tool_audit (append-only) ==='
\echo ''

\echo '--- 30. sesion de sistema registra una fila (telefono solo como hash) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.record_voice_tool_audit('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c0b01', 'call-1', 'crear_pedido', 'ok', repeat('b', 64), null);
rollback;

\echo '--- 31. un detalle largo se trunca a 300 en vez de perder la fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.record_voice_tool_audit('00000000-0000-0000-0000-0000000c0a01', null, 'call-2', 'crear_pedido', 'denied', null, repeat('x', 1000));
reset role;
select (max(char_length(detail)) = 300)::int as detalle_truncado_deberia_ser_1 from restaurantes.voice_tool_audit where call_id = 'call-2';
rollback;

\echo '--- 32. un telefono en claro (no es sha256) es RECHAZADO por el CHECK ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.record_voice_tool_audit('00000000-0000-0000-0000-0000000c0a01', null, 'call-3', 'crear_pedido', 'ok', '5219990000000', null) as should_fail;
rollback;

\echo '--- 33. un resultado fuera del catalogo es RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.record_voice_tool_audit('00000000-0000-0000-0000-0000000c0a01', null, 'call-4', 'crear_pedido', 'inventado', null, null) as should_fail;
rollback;

\echo '--- 34. staff autenticado no puede escribir en la bitacora de voz: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select restaurantes.record_voice_tool_audit('00000000-0000-0000-0000-0000000c0a01', null, 'call-5', 'crear_pedido', 'ok', null, null) as should_fail;
rollback;

\echo '--- 35. anon no puede escribir en la bitacora de voz: RECHAZADO ---'
begin;
set local role anon;
select restaurantes.record_voice_tool_audit('00000000-0000-0000-0000-0000000c0a01', null, 'call-6', 'crear_pedido', 'ok', null, null) as should_fail;
rollback;

\echo '--- 36. INSERT directo de un owner en la tabla: RECHAZADO (sin policy ni GRANT de escritura) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
insert into restaurantes.voice_tool_audit (organization_id, tool, outcome) values ('00000000-0000-0000-0000-0000000c0a01', 'x', 'ok') returning 1 as should_fail;
rollback;

\echo '--- 37. UPDATE sobre la bitacora (incluso como superusuario) esta bloqueado por el trigger ---'
begin;
update restaurantes.voice_tool_audit set detail = 'manipulado' returning 1 as should_fail;
rollback;

\echo '--- 38. DELETE sobre la bitacora (incluso como superusuario) esta bloqueado por el trigger ---'
begin;
delete from restaurantes.voice_tool_audit returning 1 as should_fail;
rollback;

\echo '--- 39. owner de la Org A lee su bitacora de voz (la fixture) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c01', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.voice_tool_audit where organization_id = '00000000-0000-0000-0000-0000000c0a01';
rollback;

\echo '--- 40. staff de la Org A (no owner/admin) NO ve la bitacora de voz (RLS silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c03', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.voice_tool_audit;
rollback;

\echo '--- 41. owner de la Org B NO ve la bitacora de voz de la Org A (cross-tenant, RLS silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0c05', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.voice_tool_audit where organization_id = '00000000-0000-0000-0000-0000000c0a01';
rollback;

\echo '--- 42. anon no puede leer la bitacora de voz: RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.voice_tool_audit;
rollback;

\echo ''
\echo '=== F) base SIN migrar: 42883 recuperado con SAVEPOINT real ==='
\echo ''

\echo '--- 43. sin la funcion (42883) un SAVEPOINT + ROLLBACK TO SAVEPOINT deja la transaccion usable (lo que hace runWithSavepointFallback) ---'
begin;
drop function restaurantes.verify_voice_branch_secret(uuid, text);
savepoint sp_verify_voz_seguridad;
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01'::uuid, repeat('a', 64));
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_voz_seguridad;
release savepoint sp_verify_voz_seguridad;
select 1 as siguiente_consulta_del_request_deberia_ser_1;
rollback;

\echo '--- 44. SIN el SAVEPOINT, el mismo 42883 deja la transaccion abortada (25P02): la razon del helper ---'
begin;
drop function restaurantes.verify_voice_branch_secret(uuid, text);
select restaurantes.verify_voice_branch_secret('00000000-0000-0000-0000-0000000c0a01', repeat('a', 64));
select 1 as should_fail;
rollback;
