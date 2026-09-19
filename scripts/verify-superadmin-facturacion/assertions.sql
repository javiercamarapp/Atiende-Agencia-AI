-- Fixtures + escenarios de autorización para las 3 funciones de
-- `packages/db/migrations/0013_superadmin_facturacion.sql`
-- (`core.list_organization_billing_for_superadmin`/
-- `core.list_recent_billing_webhook_events_for_superadmin`/
-- `core.count_billing_webhook_events_for_superadmin`) — mismo patrón EXACTO
-- que `scripts/verify-caller-binding-fase2/assertions.sql`: cada escenario es
-- su propia transacción (`begin;`...`rollback;`, nunca persiste nada), y el
-- alias de la columna de verificación (`deberia_ser_N`/`should_fail`) es lo
-- que `scripts/verify-real-postgres-ci/run-gate.mjs` usa para decidir
-- pass/fail automáticamente quien lo corre en CI — este archivo también se
-- corre a mano con `run.sh` para inspección humana.
--
-- Actores:
--   - staff-fact-a: staff REAL (member normal) de org-fact, sin ninguna
--     autoridad de superadmin.
--   - superadmin-fact: superadmin REAL (fila en core.platform_superadmin).
--   - org-fact: organización real, con staff-fact-a como 'member' y una
--     fila de `organization_billing` real (seats=7, activa, customer
--     conocido) -- para demostrar que un caller no autorizado no ve esos
--     valores reales.
--   - un evento de `core.billing_webhook_event` real, y una fila de
--     `core.billing_entity_order` que cruza por `stripe_customer_id` (para
--     que `list_organization_billing_for_superadmin` resuelva
--     `last_applied_event_unix` real).
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000f1', 'staff-fact-a@example.com', 'Staff Fact A', 'seed'),
  ('00000000-0000-0000-0000-0000000000f3', 'superadmin-fact@example.com', 'Superadmin Fact', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000000f3')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000f9', 'hoteles', 'Org Fact', 'org-fact')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f9', null, 'member', 'staff')
on conflict do nothing;

insert into core.organization_billing (organization_id, stripe_customer_id, stripe_subscription_id, price_id, seats, status) values
  ('00000000-0000-0000-0000-0000000000f9', 'cus_fact_real', 'sub_fact_real', 'price_fact', 7, 'activa')
on conflict do nothing;

insert into core.billing_webhook_event (event_id, processed_at) values
  ('evt_fact_real', now())
on conflict do nothing;

insert into core.billing_entity_order (entity_id, last_applied_created_unix) values
  ('cus_fact_real', 1735689600)
on conflict do nothing;

-- ═══ core.list_organization_billing_for_superadmin ═══

\echo '=== 1. list_organization_billing_for_superadmin: superadmin-fact, con SU PROPIA sesion, SI ve el billing real de org-fact (seats = 7) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select seats as deberia_ser_7 from core.list_organization_billing_for_superadmin('00000000-0000-0000-0000-0000000000f3') where organization_id = '00000000-0000-0000-0000-0000000000f9';
rollback;

\echo '=== 1b. list_organization_billing_for_superadmin: el mismo caller SI ve el last_applied_event_unix real (cruzado por stripe_customer_id) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select last_applied_event_unix as deberia_ser_1735689600 from core.list_organization_billing_for_superadmin('00000000-0000-0000-0000-0000000000f3') where organization_id = '00000000-0000-0000-0000-0000000000f9';
rollback;

\echo '=== 2. list_organization_billing_for_superadmin: staff-fact-a (sesion real, NO superadmin) pasando el id de superadmin-fact como p_caller_id obtiene CERO filas -- el hueco real: antes de atar auth.uid(), cualquier authenticated podia leer seats/stripe_customer_id/status de CUALQUIER organizacion suplantando al superadmin ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
select count(*) as deberia_ser_0 from core.list_organization_billing_for_superadmin('00000000-0000-0000-0000-0000000000f3');
rollback;

\echo '=== 3. list_organization_billing_for_superadmin: sesion de SISTEMA (auth.uid() null) pasando el id de superadmin-fact tambien obtiene CERO filas -- este es EXACTAMENTE el patron que apps/api usaria si olvidara abrir la sesion como el caller ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_organization_billing_for_superadmin('00000000-0000-0000-0000-0000000000f3');
rollback;

\echo '=== 4. list_organization_billing_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_organization_billing_for_superadmin('00000000-0000-0000-0000-0000000000f3') as should_fail;
rollback;

-- ═══ core.list_recent_billing_webhook_events_for_superadmin ═══

\echo '=== 5. list_recent_billing_webhook_events_for_superadmin: superadmin-fact, con SU PROPIA sesion, SI ve el evento real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select count(*) as deberia_ser_1 from core.list_recent_billing_webhook_events_for_superadmin('00000000-0000-0000-0000-0000000000f3', 20);
rollback;

\echo '=== 6. list_recent_billing_webhook_events_for_superadmin: staff-fact-a pasando el id de superadmin-fact obtiene CERO filas -- nunca el feed real de webhooks de plataforma ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
select count(*) as deberia_ser_0 from core.list_recent_billing_webhook_events_for_superadmin('00000000-0000-0000-0000-0000000000f3', 20);
rollback;

\echo '=== 7. list_recent_billing_webhook_events_for_superadmin: sesion de SISTEMA pasando el id de superadmin-fact tambien obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_recent_billing_webhook_events_for_superadmin('00000000-0000-0000-0000-0000000000f3', 20);
rollback;

\echo '=== 8. list_recent_billing_webhook_events_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_recent_billing_webhook_events_for_superadmin('00000000-0000-0000-0000-0000000000f3', 20) as should_fail;
rollback;

-- ═══ core.count_billing_webhook_events_for_superadmin ═══

\echo '=== 9. count_billing_webhook_events_for_superadmin: superadmin-fact, con SU PROPIA sesion, SI ve el total real (1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select core.count_billing_webhook_events_for_superadmin('00000000-0000-0000-0000-0000000000f3') as deberia_ser_1;
rollback;

\echo '=== 10. count_billing_webhook_events_for_superadmin: staff-fact-a pasando el id de superadmin-fact obtiene 0, NUNCA el total real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
select core.count_billing_webhook_events_for_superadmin('00000000-0000-0000-0000-0000000000f3') as deberia_ser_0;
rollback;

\echo '=== 11. count_billing_webhook_events_for_superadmin: sesion de SISTEMA pasando el id de superadmin-fact tambien obtiene 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.count_billing_webhook_events_for_superadmin('00000000-0000-0000-0000-0000000000f3') as deberia_ser_0;
rollback;

\echo '=== 12. count_billing_webhook_events_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.count_billing_webhook_events_for_superadmin('00000000-0000-0000-0000-0000000000f3') as should_fail;
rollback;
