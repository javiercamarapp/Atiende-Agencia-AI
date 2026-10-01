-- Verificacion contra Postgres REAL de
-- packages/db/migrations/0027_search_path_hardening_funciones_dominio.sql --
-- mismo contrato de escenarios `begin;.../rollback;` que
-- scripts/verify-search-path-hardening-core/assertions.sql (lo descubre y corre
-- automaticamente scripts/verify-real-postgres-ci/run-gate.mjs en CI):
--
--   1. `pg_proc.proconfig` de las 14 funciones es EXACTAMENTE el `search_path`
--      esperado tras aplicar TODAS las migraciones reales (catalogo, no el
--      texto del archivo SQL).
--   2. Defensa en profundidad real: con el `search_path` de SESION del caller
--      vaciado (solo pg_catalog), las funciones que antes dependian de el
--      siguen funcionando (resuelven con su propio path fijo) -- sobre todo
--      `restaurantes.nearest_branch_by_colonia`, que llama `unaccent()` sin
--      calificar y ANTES de esta migracion fallaba con ese path de sesion.
--   3. El comportamiento (positivo y negativo) no cambio: CAS de estado de
--      conversacion, reservar/liberar disponibilidad, bitacoras append-only
--      (UPDATE/DELETE siguen bloqueados con SQLSTATE 0A000) y la validacion de
--      staff de un horario.
\set ON_ERROR_STOP off
\pset pager off

-- ═══════════════════════════════════════════════════════════════════════════
-- Fixtures (persisten para todos los escenarios; insertadas como superusuario)
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d9a00', 'hoteles', 'Org Verify Search Path Dominio', 'org-verify-search-path-dominio')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d9a01', 'verify-search-path-dominio@example.com', 'Verify Search Path Dominio', 'seed')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a00', 'Verify Search Path Dominio Property')
on conflict do nothing;

-- public.conversations NO existe en las migraciones del repo (ver
-- packages/core-conversation/migrations/001_conversation_state_cas.sql); se crea
-- aqui, solo en esta base efimera, para ejercitar get/set_conversation_state_cas.
create table if not exists public.conversations (
  id uuid primary key,
  metadata jsonb
);
insert into public.conversations (id, metadata) values
  ('00000000-0000-0000-0000-0000000d9a10', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000d9a11', '{"conversation_state": {"state": "x", "context": {}, "version": 5}}'::jsonb)
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000d9a20', '00000000-0000-0000-0000-0000000d9a00', '00000000-0000-0000-0000-0000000d9a02', 'Sencilla verify')
on conflict do nothing;

insert into hoteles.availability (id, organization_id, property_id, room_type_id, date, total_rooms, booked_rooms) values
  ('00000000-0000-0000-0000-0000000d9a21', '00000000-0000-0000-0000-0000000d9a00', '00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a20', '2031-01-10', 5, 0),
  ('00000000-0000-0000-0000-0000000d9a22', '00000000-0000-0000-0000-0000000d9a00', '00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a20', '2031-01-11', 5, 2)
on conflict do nothing;

-- Filas para las 4 bitacoras append-only (UPDATE/DELETE deben seguir bloqueados).
insert into citas.audit_log (id, organization_id, actor_user_id, action, entity_type) values
  ('00000000-0000-0000-0000-0000000d9a30', '00000000-0000-0000-0000-0000000d9a00', '00000000-0000-0000-0000-0000000d9a01', 'verify.search_path', 'servicio')
on conflict do nothing;

insert into hoteles.attendance_log (id, organization_id, property_id, staff_user_id, event_type) values
  ('00000000-0000-0000-0000-0000000d9a31', '00000000-0000-0000-0000-0000000d9a00', '00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a01', 'entrada')
on conflict do nothing;

insert into restaurantes.voice_tool_audit (id, organization_id, tool, outcome) values
  ('00000000-0000-0000-0000-0000000d9a32', '00000000-0000-0000-0000-0000000d9a00', 'verify_tool', 'ok')
on conflict do nothing;

insert into rentas.break_glass_access_log (id, actor_user_id, organization_id, reason, resource_type) values
  ('00000000-0000-0000-0000-0000000d9a33', '00000000-0000-0000-0000-0000000d9a01', '00000000-0000-0000-0000-0000000d9a00', 'Motivo de prueba con al menos veinte caracteres.', 'otro')
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 1. proconfig es exactamente el search_path esperado en las 14 funciones ==='
begin;
select count(*) as proconfig_exacto_deberia_ser_14
from (values
  ('public',       'get_conversation_state',                       'search_path=public, pg_temp'),
  ('public',       'set_conversation_state_cas',                   'search_path=public, pg_temp'),
  ('citas',        'touch_provider_calendar_accounts_updated_at',  'search_path=citas, pg_temp'),
  ('citas',        'audit_log_block_mutation',                     'search_path=citas, pg_temp'),
  ('hoteles',      'book_availability',                            'search_path=hoteles, pg_temp'),
  ('hoteles',      'lock_availability',                            'search_path=hoteles, pg_temp'),
  ('hoteles',      'reservation_validate_transition',              'search_path=hoteles, pg_temp'),
  ('hoteles',      'release_availability',                         'search_path=hoteles, pg_temp'),
  ('hoteles',      'attendance_log_block_mutation',                'search_path=hoteles, pg_temp'),
  ('hoteles',      'staff_schedule_validate_staff',                'search_path=hoteles, pg_temp'),
  ('restaurantes', 'nearest_branch_by_colonia',                    'search_path=restaurantes, public, extensions, pg_temp'),
  ('restaurantes', 'voice_tool_audit_block_mutation',              'search_path=restaurantes, pg_temp'),
  ('licitaciones', 'protect_inconformidad_draft_content',          'search_path=licitaciones, pg_temp'),
  ('rentas',       'break_glass_access_log_block_mutation',        'search_path=rentas, pg_temp')
) as e(schema_name, fn_name, expected)
join pg_namespace n on n.nspname = e.schema_name
join pg_proc p on p.pronamespace = n.oid and p.proname = e.fn_name
where p.proconfig = array[e.expected];
rollback;

\echo '=== 2. ninguna de las 14 queda sin search_path fijo ==='
begin;
select count(*) as sin_search_path_deberia_ser_0
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where (n.nspname, p.proname) in (
  ('public','get_conversation_state'), ('public','set_conversation_state_cas'),
  ('citas','touch_provider_calendar_accounts_updated_at'), ('citas','audit_log_block_mutation'),
  ('hoteles','book_availability'), ('hoteles','lock_availability'),
  ('hoteles','reservation_validate_transition'), ('hoteles','release_availability'),
  ('hoteles','attendance_log_block_mutation'), ('hoteles','staff_schedule_validate_staff'),
  ('restaurantes','nearest_branch_by_colonia'), ('restaurantes','voice_tool_audit_block_mutation'),
  ('licitaciones','protect_inconformidad_draft_content'), ('rentas','break_glass_access_log_block_mutation')
)
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
rollback;

\echo '=== 3. nearest_branch_by_colonia resuelve unaccent() con el search_path de sesion vaciado (cero zonas -> cero filas) ==='
begin;
set local search_path = pg_catalog;
select count(*) as filas_deberia_ser_0
from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000d9a00', 'Cólonia Inexistente');
rollback;

\echo '=== 4. get_conversation_state con search_path de sesion vaciado: version por defecto 0 ==='
begin;
set local search_path = pg_catalog;
select coalesce((public.get_conversation_state('00000000-0000-0000-0000-0000000d9a10') ->> 'version')::int, -1) as version_deberia_ser_0;
rollback;

\echo '=== 5. set_conversation_state_cas con la version esperada correcta: gana (true) ==='
begin;
set local search_path = pg_catalog;
select case when public.set_conversation_state_cas('00000000-0000-0000-0000-0000000d9a10', 0, 'abierto', '{}'::jsonb) then 1 else 0 end as cas_gana_deberia_ser_1;
rollback;

\echo '=== 6. set_conversation_state_cas con version vieja: pierde la carrera (false), sin escribir ==='
begin;
set local search_path = pg_catalog;
select case when public.set_conversation_state_cas('00000000-0000-0000-0000-0000000d9a11', 0, 'otro', '{}'::jsonb) then 1 else 0 end as cas_pierde_deberia_ser_0;
rollback;

\echo '=== 7. book_availability con search_path vaciado: reserva 1 -> booked_rooms 1 ==='
begin;
set local search_path = pg_catalog;
select (hoteles.book_availability('00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a20', date '2031-01-10', 1)).booked_rooms as booked_deberia_ser_1;
rollback;

\echo '=== 8. book_availability con cantidad invalida sigue fallando ==='
begin;
set local search_path = pg_catalog;
select (hoteles.book_availability('00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a20', date '2031-01-10', 0)).booked_rooms as should_fail;
rollback;

\echo '=== 9. release_availability con search_path vaciado: 2 -> 1 ==='
begin;
set local search_path = pg_catalog;
select (hoteles.release_availability('00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a20', date '2031-01-11', 1)).booked_rooms as booked_deberia_ser_1;
rollback;

\echo '=== 10. lock_availability con search_path vaciado completa sin error ==='
begin;
set local search_path = pg_catalog;
select hoteles.lock_availability('00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a20', date '2031-01-10');
rollback;

\echo '=== 11. citas.audit_log: UPDATE sigue bloqueado (append-only) ==='
begin;
set local search_path = pg_catalog;
update citas.audit_log set action = 'manipulada' where id = '00000000-0000-0000-0000-0000000d9a30' returning 1 as should_fail;
rollback;

\echo '=== 12. citas.audit_log: DELETE sigue bloqueado ==='
begin;
delete from citas.audit_log where id = '00000000-0000-0000-0000-0000000d9a30' returning 1 as should_fail;
rollback;

\echo '=== 13. hoteles.attendance_log: UPDATE sigue bloqueado ==='
begin;
set local search_path = pg_catalog;
update hoteles.attendance_log set note = 'manipulada' where id = '00000000-0000-0000-0000-0000000d9a31' returning 1 as should_fail;
rollback;

\echo '=== 14. restaurantes.voice_tool_audit: UPDATE sigue bloqueado ==='
begin;
set local search_path = pg_catalog;
update restaurantes.voice_tool_audit set detail = 'manipulada' where id = '00000000-0000-0000-0000-0000000d9a32' returning 1 as should_fail;
rollback;

\echo '=== 15. rentas.break_glass_access_log: DELETE sigue bloqueado ==='
begin;
set local search_path = pg_catalog;
delete from rentas.break_glass_access_log where id = '00000000-0000-0000-0000-0000000d9a33' returning 1 as should_fail;
rollback;

\echo '=== 16. hoteles.staff_schedule: staff ajeno a la property sigue rechazado (trigger de validacion) ==='
begin;
set local search_path = pg_catalog;
insert into hoteles.staff_schedule (organization_id, property_id, staff_user_id, work_date, scheduled_start, scheduled_end)
values ('00000000-0000-0000-0000-0000000d9a00', '00000000-0000-0000-0000-0000000d9a02', '00000000-0000-0000-0000-0000000d9a01', date '2031-01-10', timestamptz '2031-01-10 09:00+00', timestamptz '2031-01-10 17:00+00')
returning 1 as should_fail;
rollback;

\echo '=== 17. anon sigue SIN poder ejecutar la mutacion de una bitacora (sin permisos de tabla) ==='
begin;
set local role anon;
delete from citas.audit_log where id = '00000000-0000-0000-0000-0000000d9a30' returning 1 as should_fail;
rollback;
