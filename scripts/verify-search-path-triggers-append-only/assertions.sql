-- Verificacion contra Postgres REAL de
-- packages/db/migrations/0035_search_path_triggers_append_only.sql (3 triggers
-- append-only con `search_path = pg_catalog, pg_temp`). Mismo contrato de
-- escenarios `begin;.../rollback;` que verify-search-path-hardening-dominio
-- (lo corre scripts/verify-real-postgres-ci/run-gate.mjs en CI):
--   1. `pg_proc.proconfig` de las 3 funciones es exactamente el esperado.
--   2. GUARD: ninguna funcion (no de extension) de core/citas/hoteles/rentas/
--      despachos/licitaciones/restaurantes/public queda sin `search_path` en
--      `proconfig`. Falla si una migracion futura agrega una sin fijarlo.
--   3. Con el `search_path` de sesion vaciado, UPDATE y DELETE sobre las 3
--      bitacoras siguen bloqueados (SQLSTATE 0A000) y el INSERT sigue
--      funcionando; anon sigue sin poder mutar.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d9b00', 'hoteles', 'Org Verify Search Path Triggers', 'org-verify-search-path-triggers')
on conflict do nothing;

-- Solicitudes ARCO padre (FK de data_rights_events.request_id), una por schema.
insert into citas.data_rights_requests (id, organization_id, customer_phone, right_type) values
  ('00000000-0000-0000-0000-0000000d9b20', '00000000-0000-0000-0000-0000000d9b00', '+520000000001', 'acceso')
on conflict do nothing;
insert into restaurantes.data_rights_requests (id, organization_id, customer_phone, right_type) values
  ('00000000-0000-0000-0000-0000000d9b20', '00000000-0000-0000-0000-0000000d9b00', '+520000000001', 'acceso')
on conflict do nothing;

insert into citas.data_rights_events (id, organization_id, request_id, actor_kind, event) values
  ('00000000-0000-0000-0000-0000000d9b10', '00000000-0000-0000-0000-0000000d9b00', '00000000-0000-0000-0000-0000000d9b20', 'sistema', 'registrada')
on conflict do nothing;

insert into restaurantes.data_rights_events (id, organization_id, request_id, actor_kind, event) values
  ('00000000-0000-0000-0000-0000000d9b11', '00000000-0000-0000-0000-0000000d9b00', '00000000-0000-0000-0000-0000000d9b20', 'sistema', 'registrada')
on conflict do nothing;

insert into citas.whatsapp_message_config_history (id, organization_id, version, accion, nuevo) values
  ('00000000-0000-0000-0000-0000000d9b12', '00000000-0000-0000-0000-0000000d9b00', 1, 'actualizado', '{}'::jsonb)
on conflict do nothing;

\echo '=== 1. proconfig es exactamente pg_catalog, pg_temp en las 3 funciones ==='
begin;
select count(*) as proconfig_exacto_deberia_ser_3
from (values
  ('citas',        'whatsapp_message_config_history_block_mutation'),
  ('citas',        'data_rights_events_block_mutation'),
  ('restaurantes', 'data_rights_events_block_mutation')
) as e(schema_name, fn_name)
join pg_namespace n on n.nspname = e.schema_name
join pg_proc p on p.pronamespace = n.oid and p.proname = e.fn_name
where p.proconfig = array['search_path=pg_catalog, pg_temp'];
rollback;

\echo '=== 2. GUARD: ninguna funcion de los schemas del producto sin search_path fijo ==='
begin;
select count(*) as funciones_sin_search_path_deberia_ser_0
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('core', 'citas', 'hoteles', 'rentas', 'despachos', 'licitaciones', 'restaurantes', 'public')
  and p.prokind = 'f'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%');
rollback;

\echo '=== 3. citas.data_rights_events: UPDATE bloqueado con search_path de sesion vaciado ==='
begin;
set local search_path = pg_catalog;
update citas.data_rights_events set note = 'manipulada' where id = '00000000-0000-0000-0000-0000000d9b10' returning 1 as should_fail;
rollback;

\echo '=== 4. citas.data_rights_events: DELETE bloqueado ==='
begin;
set local search_path = pg_catalog;
delete from citas.data_rights_events where id = '00000000-0000-0000-0000-0000000d9b10' returning 1 as should_fail;
rollback;

\echo '=== 5. restaurantes.data_rights_events: UPDATE bloqueado ==='
begin;
set local search_path = pg_catalog;
update restaurantes.data_rights_events set note = 'manipulada' where id = '00000000-0000-0000-0000-0000000d9b11' returning 1 as should_fail;
rollback;

\echo '=== 6. restaurantes.data_rights_events: DELETE bloqueado ==='
begin;
set local search_path = pg_catalog;
delete from restaurantes.data_rights_events where id = '00000000-0000-0000-0000-0000000d9b11' returning 1 as should_fail;
rollback;

\echo '=== 7. citas.whatsapp_message_config_history: UPDATE bloqueado ==='
begin;
set local search_path = pg_catalog;
update citas.whatsapp_message_config_history set accion = 'restablecido' where id = '00000000-0000-0000-0000-0000000d9b12' returning 1 as should_fail;
rollback;

\echo '=== 8. citas.whatsapp_message_config_history: DELETE bloqueado ==='
begin;
set local search_path = pg_catalog;
delete from citas.whatsapp_message_config_history where id = '00000000-0000-0000-0000-0000000d9b12' returning 1 as should_fail;
rollback;

\echo '=== 9. positivo: el INSERT en las 3 bitacoras sigue funcionando con search_path vaciado ==='
begin;
set local search_path = pg_catalog;
insert into citas.data_rights_events (organization_id, request_id, actor_kind, event)
values ('00000000-0000-0000-0000-0000000d9b00', '00000000-0000-0000-0000-0000000d9b20', 'sistema', 'confirmada');
insert into restaurantes.data_rights_events (organization_id, request_id, actor_kind, event)
values ('00000000-0000-0000-0000-0000000d9b00', '00000000-0000-0000-0000-0000000d9b20', 'sistema', 'confirmada');
insert into citas.whatsapp_message_config_history (organization_id, version, accion, nuevo)
values ('00000000-0000-0000-0000-0000000d9b00', 2, 'actualizado', '{}'::jsonb);
rollback;

\echo '=== 10. anon sigue SIN poder mutar una bitacora (sin permisos de tabla) ==='
begin;
set local role anon;
delete from citas.data_rights_events where id = '00000000-0000-0000-0000-0000000d9b10' returning 1 as should_fail;
rollback;
