-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), packages/db/migrations/0073_onboarding_evento.sql (y 0078: tipo
-- 'metodos_pago_confirmados'):
-- registrar_onboarding_evento (owner/admin y sistema escriben; staff, otra organizacion y anon no), idempotencia, lista cerrada de tipos,
-- sucursal de otra organizacion, y lectura por RLS solo para owner/admin de la propia organizacion; sin escritura directa en la tabla.
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback; deberia_ser_N = ultima fila
-- vale N; should_fail = el escenario debe terminar en ERROR.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'Org A evento', 'org-ev-a', 'active'),
  ('00000000-0000-0000-0000-0000000f7301', 'restaurantes', 'Org B evento', 'org-ev-b', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f7310', '00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'Suc A', 'active'),
  ('00000000-0000-0000-0000-0000000f7311', '00000000-0000-0000-0000-0000000f7301', 'restaurantes', 'Suc B', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f7320', 'owner-a-ev@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f7321', 'staff-a-ev@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000f7322', 'owner-b-ev@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f7320', '00000000-0000-0000-0000-0000000f7300', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f7321', '00000000-0000-0000-0000-0000000f7300', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f7322', '00000000-0000-0000-0000-0000000f7301', null, 'owner', 'owner')
on conflict do nothing;

\echo '1. owner de A registra la prueba del agente: true -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
select (case when core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', '00000000-0000-0000-0000-0000000f7310', '{}'::jsonb) then 1 else 0 end)::int as deberia_ser_1;
rollback;

\echo '2. idempotente: la segunda vez devuelve false y queda una sola fila -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', '00000000-0000-0000-0000-0000000f7310', '{}'::jsonb);
select (case when core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', '00000000-0000-0000-0000-0000000f7310', '{}'::jsonb) then 1 else 0 end)::int as deberia_ser_0;
rollback;

\echo '3. una sola fila tras dos registros y el actor es auth.uid() -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', null, '{}'::jsonb);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', null, '{}'::jsonb);
select (select count(*) from core.onboarding_evento where organization_id = '00000000-0000-0000-0000-0000000f7300' and actor_user_id = '00000000-0000-0000-0000-0000000f7320')::int as deberia_ser_1;
rollback;

\echo '4. staff (member) de A no registra: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7321', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', null, '{}'::jsonb) as should_fail;
rollback;

\echo '5. cross-tenant: owner de B no registra en A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7322', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', null, '{}'::jsonb) as should_fail;
rollback;

\echo '6. sucursal de otra organizacion: 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', '00000000-0000-0000-0000-0000000f7311', '{}'::jsonb) as should_fail;
rollback;

\echo '7. tipo fuera de la lista cerrada: 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'cualquier_cosa', null, '{}'::jsonb) as should_fail;
rollback;

\echo '8. vertical distinta a la de la organizacion: 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'citas', 'prueba_agente_whatsapp', null, '{}'::jsonb) as should_fail;
rollback;

\echo '9. sesion de sistema (uid nulo) registra -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (case when core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7301', 'restaurantes', 'celebracion_listo_vista', null, '{"n": 1}'::jsonb) then 1 else 0 end)::int as deberia_ser_1;
rollback;

\echo '10. anon no ejecuta -- RECHAZADO'
begin;
set local role anon;
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp', null, '{}'::jsonb) as should_fail;
rollback;

\echo '11. insert directo en la tabla (owner): sin GRANT -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
insert into core.onboarding_evento (organization_id, vertical, tipo) values ('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_voz') returning 1 as should_fail;
rollback;

\echo '12. lectura RLS: owner de A ve el evento de A -- OK'
begin;
insert into core.onboarding_evento (organization_id, vertical, tipo) values ('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
select (select count(*) from core.onboarding_evento)::int as deberia_ser_1;
rollback;

\echo '13. lectura RLS: owner de B (otra organizacion) no ve el evento de A -- OK'
begin;
insert into core.onboarding_evento (organization_id, vertical, tipo) values ('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7322', true);
select (select count(*) from core.onboarding_evento)::int as deberia_ser_0;
rollback;

\echo '14. lectura RLS: staff (member) de A no ve el evento de A -- OK'
begin;
insert into core.onboarding_evento (organization_id, vertical, tipo) values ('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'prueba_agente_whatsapp');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7321', true);
select (select count(*) from core.onboarding_evento)::int as deberia_ser_0;
rollback;

\echo '15. anon no lee la tabla -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.onboarding_evento;
rollback;

\echo '16. (0078) owner de A confirma los metodos de pago de su sucursal: true -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7320', true);
select (case when core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'metodos_pago_confirmados', '00000000-0000-0000-0000-0000000f7310', '{}'::jsonb) then 1 else 0 end)::int as deberia_ser_1;
rollback;

\echo '17. (0078) staff de A no confirma metodos de pago -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7321', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'metodos_pago_confirmados', '00000000-0000-0000-0000-0000000f7310', '{}'::jsonb) as should_fail;
rollback;

\echo '18. (0078) owner de B no confirma por la sucursal de A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7322', true);
select core.registrar_onboarding_evento('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'metodos_pago_confirmados', '00000000-0000-0000-0000-0000000f7310', '{}'::jsonb) as should_fail;
rollback;

\echo '19. (0078) el CHECK acepta el tipo nuevo y sigue rechazando uno inventado -- RECHAZADO'
begin;
insert into core.onboarding_evento (organization_id, vertical, tipo) values ('00000000-0000-0000-0000-0000000f7300', 'restaurantes', 'tipo_inventado') returning id as should_fail;
rollback;

\echo ''
\echo 'Fin.'
