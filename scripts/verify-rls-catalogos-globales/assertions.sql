-- Ola 2 (seguridad), arreglo F.3 -- las dos únicas tablas de los schemas del repo sin RLS:
--   hoteles.reservation_status_transition (005_reservas_estado; catálogo de las 8 transiciones válidas de la
--     máquina de estados, espejo de packages/domain-hoteles/src/reservationStateMachine.ts; la lee el trigger
--     SECURITY INVOKER hoteles.reservation_validate_transition bajo `authenticated`)
--   rentas.canal (001_rentas_schema; catálogo de los 4 canales airbnb/vrbo/booking/manual; lo leen
--     postgres-repository.ts y «Chatea con tus datos» bajo `authenticated`)
-- Ninguna tiene columnas de tenant. Sin RLS, su único control era el GRANT; con RLS habilitado y una policy de
-- SOLO LECTURA que enumera el dominio cerrado del catálogo, (a) ninguna escritura de `authenticated` pasa aunque
-- un GRANT futuro la abriera (no hay policy de escritura), y (b) una fila agregada fuera de una migración
-- revisada no la ve la app.
--
-- Migraciones: packages/domain-hoteles/migrations/052_hoteles_rls_reservation_status_transition.sql (espejo 835)
--              packages/domain-rentas/migrations/039_rentas_rls_canal.sql (espejo 836)
--
-- Escenarios: 1 catálogo (ninguna tabla de los schemas del repo sin RLS); 2-5 positivos (staff y sesión de
-- sistema ven el catálogo completo); 6-7 todo el catálogo sembrado por migraciones es visible (si una migración
-- futura agrega una fila sin ampliar la policy, esto se pone rojo); 8-9 una fila insertada fuera de migración no
-- es visible; 10-11 authenticated no escribe; 12-13 anon no lee.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = debe terminar en
-- ERROR; alias `..._deberia_ser_N` = esa consulta devuelve N. Cada escenario va en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000f601', 'hoteles', 'Hotel (rls catálogos)', 'hotel-rls-catalogos')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000f621', 'staff-rls-catalogos@example.com', 'Staff (rls catálogos)', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000f621', '00000000-0000-0000-0000-00000000f601', null, 'owner', 'owner')
on conflict do nothing;

\echo '1. ninguna tabla de los schemas del repo queda sin RLS'
begin;
select count(*) as tablas_sin_rls_deberia_ser_0
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and not c.relrowsecurity
  and n.nspname in ('core', 'citas', 'hoteles', 'restaurantes', 'despachos', 'licitaciones', 'rentas', 'mcp_cfdi');
rollback;

\echo '2. staff (authenticated con auth.uid()) ve las 8 transiciones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f621', true);
select count(*) as transiciones_staff_deberia_ser_8 from hoteles.reservation_status_transition;
rollback;

\echo '3. sesión de sistema (authenticated sin auth.uid()) ve las 8 transiciones'
begin;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select count(*) as transiciones_sistema_deberia_ser_8 from hoteles.reservation_status_transition;
rollback;

\echo '4. staff ve los 4 canales'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f621', true);
select count(*) as canales_staff_deberia_ser_4 from rentas.canal;
rollback;

\echo '5. sesión de sistema ve los 4 canales'
begin;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select count(*) as canales_sistema_deberia_ser_4 from rentas.canal;
rollback;

\echo '6. todas las transiciones sembradas por migraciones son visibles para la app'
begin;
select set_config('verify.total_transiciones', (select count(*) from hoteles.reservation_status_transition)::text, true);
set local role authenticated;
select (current_setting('verify.total_transiciones')::int - (select count(*) from hoteles.reservation_status_transition))::int as transiciones_ocultas_deberia_ser_0;
rollback;

\echo '7. todos los canales sembrados por migraciones son visibles para la app'
begin;
select set_config('verify.total_canales', (select count(*) from rentas.canal)::text, true);
set local role authenticated;
select (current_setting('verify.total_canales')::int - (select count(*) from rentas.canal))::int as canales_ocultos_deberia_ser_0;
rollback;

\echo '8. una transición insertada fuera de migración no es visible para la app'
begin;
insert into hoteles.reservation_status_transition (from_status, to_status) values ('cerrada', 'cotizada');
set local role authenticated;
select count(*) as transicion_fuera_de_dominio_deberia_ser_0 from hoteles.reservation_status_transition where from_status = 'cerrada';
rollback;

\echo '9. un canal insertado fuera de migración no es visible para la app'
begin;
insert into rentas.canal (codigo, nombre) values ('canal_no_revisado', 'Canal no revisado');
set local role authenticated;
select count(*) as canal_fuera_de_dominio_deberia_ser_0 from rentas.canal where codigo = 'canal_no_revisado';
rollback;

\echo '10. authenticated no inserta transiciones'
begin;
set local role authenticated;
insert into hoteles.reservation_status_transition (from_status, to_status) values ('cerrada', 'cotizada') returning 1 as should_fail;
rollback;

\echo '11. authenticated no inserta canales'
begin;
set local role authenticated;
insert into rentas.canal (codigo, nombre) values ('x', 'x') returning 1 as should_fail;
rollback;

\echo '12. anon no lee transiciones'
begin;
set local role anon;
select count(*) as should_fail from hoteles.reservation_status_transition;
rollback;

\echo '13. anon no lee canales'
begin;
set local role anon;
select count(*) as should_fail from rentas.canal;
rollback;
