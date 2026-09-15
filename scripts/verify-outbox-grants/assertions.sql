-- Fixtures + assertions that verify, against REAL Postgres (real RLS + real GRANT —
-- NOT the in-memory test repo, which never applies either), that the fix in
-- migrations 86-91 (packages/domain-*/migrations/*_email_outbox_authenticated_grants.sql)
-- actually works: the outbox functions are callable by `authenticated` (previously
-- "permission denied for function ..." for every caller, since only `service_role`
-- had EXECUTE and this monorepo never provisions that role — see
-- packages/db/src/managed-postgres-engine.ts header comment), AND the internal
-- authorization check each function adds actually blocks a staff session without
-- real access to the target organization/property (never a silent cross-tenant
-- leak from the new GRANT). Run via ./run.sh — see that file for how the ephemeral
-- Postgres instance + minimal `auth.uid()`/role mock get set up first.
--
-- Every scenario below runs inside its own `begin; ... rollback;` — nothing here
-- persists.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000000a', 'citas', 'Org A (citas)', 'org-a-citas'),
  ('00000000-0000-0000-0000-00000000000b', 'hoteles', 'Org B (hoteles)', 'org-b-hoteles'),
  ('00000000-0000-0000-0000-00000000000c', 'rentas', 'Org C (rentas)', 'org-c-rentas')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'hoteles', 'Hotel B1'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000c', 'rentas', 'Property C1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000001', 'staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-000000000002', 'staff-other@example.com', 'Staff Other', 'seed')
on conflict do nothing;

-- staff 1 pertenece a las 3 orgs (con acceso a sus properties); staff 2 no
-- pertenece a NINGUNA — es el caso "staff real pero sin acceso" de cada escenario.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', null, 'admin', 'admin')
on conflict do nothing;

\echo '=== 1. sesion de sistema (auth.uid() IS NULL) SI puede enqueue_messaging_outbox (citas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000000a', 'email', 'test.event', 'dedupe-sys-1', '{}'::jsonb) as enqueued_id;
rollback;

\echo '=== 2. staff SIN membership de la org objetivo es RECHAZADO (citas.enqueue_messaging_outbox) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000000a', 'email', 'test.event', 'dedupe-nomember-1', '{}'::jsonb) as should_fail;
rollback;

\echo '=== 3. staff CON membership real de la org objetivo SI puede encolar (citas.enqueue_messaging_outbox) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000000a', 'email', 'test.event', 'dedupe-member-1', '{}'::jsonb) as enqueued_id;
rollback;

\echo '=== 4. staff con sesion real (auth.uid() no nulo) NO puede llamar claim_email_outbox_batch (solo sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select * from citas.claim_email_outbox_batch(5);
rollback;

\echo '=== 5. sesion de sistema SI puede encolar + reclamar (claim_email_outbox_batch) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000000a', 'email', 'test.event', 'dedupe-sys-2', '{}'::jsonb) as enqueued_id;
select id from citas.claim_email_outbox_batch(5);
rollback;

\echo '=== 6. hoteles.enqueue_messaging_outbox (property-scoped): staff CON acceso a la property SI puede ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select hoteles.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'email', 'test.event', 'dedupe-hotel-1', '{}'::jsonb) as enqueued_id;
rollback;

\echo '=== 7. hoteles.enqueue_messaging_outbox: staff SIN acceso a la property es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select hoteles.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'email', 'test.event', 'dedupe-hotel-2', '{}'::jsonb) as should_fail;
rollback;

\echo '=== 8. rentas.enqueue_messaging_outbox (property-scoped, mismo criterio que hoteles) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select rentas.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000c', 'email', 'test.event', 'dedupe-rentas-1', '{}'::jsonb) as enqueued_id;
rollback;

\echo '=== 9. restaurantes.enqueue_messaging_outbox: staff CON membership SI puede ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select restaurantes.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000000a', 'email', 'staff.invite', 'dedupe-rest-1', '{}'::jsonb) as enqueued_id;
rollback;

\echo '=== 10. despachos.enqueue_messaging_outbox: staff SIN membership es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select despachos.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000000a', 'email', 'test.event', 'dedupe-desp-1', '{}'::jsonb) as should_fail;
rollback;

\echo '=== 11. licitaciones.enqueue_messaging_outbox: RECHAZA cualquier auth.uid() real, incluso con membership (system-only, sin caller de staff real hoy) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select licitaciones.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000000a', 'email', 'test.event', 'dedupe-lic-1', '{}'::jsonb) as should_fail;
rollback;

\echo '=== 12. licitaciones.enqueue_messaging_outbox: sesion de sistema SI puede ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000000a', 'email', 'test.event', 'dedupe-lic-2', '{}'::jsonb) as enqueued_id;
rollback;

\echo '=== 13. despachos.organization_notification_recipients: staff CON membership SI puede leer ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select * from despachos.organization_notification_recipients('00000000-0000-0000-0000-00000000000a');
rollback;

\echo '=== 14. despachos.organization_notification_recipients: staff SIN membership es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select * from despachos.organization_notification_recipients('00000000-0000-0000-0000-00000000000a');
rollback;

\echo '=== 15. hoteles.complete_email_outbox_job persiste last_error_class = p_error (regresión: el borrador de la migración 88 escribía p_status por error, corregido antes de aplicarse) ==='
begin;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.messaging_outbox (id, property_id, organization_id, channel, event_type, dedupe_key, payload, status)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'email', 'test.event', 'dedupe-hotel-complete-1', '{}'::jsonb, 'processing');
set local role authenticated;
select hoteles.complete_email_outbox_job('00000000-0000-0000-0000-0000000000e1', 'failed', 'boom: smtp timeout');
reset role;
select status, last_error_class from hoteles.messaging_outbox where id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '=== 16. complete_email_outbox_job sigue rechazando un status invalido incluso en sesion de sistema (validacion preexistente, no removida por el fix) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.complete_email_outbox_job('00000000-0000-0000-0000-0000000000e1', 'not_a_real_status', null);
rollback;

\echo '=== FIN — revisa arriba: los escenarios 2/4/7/10/11/14/16 deben terminar en ERROR (ese es el resultado correcto); el resto debe devolver una fila. ==='
