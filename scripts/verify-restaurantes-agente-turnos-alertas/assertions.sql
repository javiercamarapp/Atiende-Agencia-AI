-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/085_agente_turnos_recientes_alertas.sql
-- (alertas del agente de WhatsApp: tasa de timeouts y rachas de fallos).
--
-- ROL Y SESION EXACTOS DE PRODUCCION: `set local role authenticated` + `request.jwt.claim.sub = ''` (auth.uid() NULL) = `withAppSession({ userId: null })`.
--
--   A. el defecto: el SELECT directo de la sesion de sistema sobre whatsapp_inbound_events no ve nada (sin GRANT/RLS).
--   B. la funcion devuelve los turnos terminados de la ventana (processed y failed), nunca `processing`, sin la organizacion demo y fuera de ventana excluidos.
--   C. ventana invalida (mayor a 2 horas, invertida, nula): rechazada con 22023.
--   D. staff autenticado y anon: rechazados (solo-sistema / sin EXECUTE).
--   E. sin PII: la funcion no expone message_id ni phone_hash.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail` marca el que debe terminar en ERROR;
-- `..._deberia_ser_N` el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f5a01', 'restaurantes', 'Turnos Org A', 'turnos-org-a'),
  ('00000000-0000-0000-0000-0000000f5a02', 'restaurantes', 'Turnos Org Demo', 'turnos-org-demo')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f5c01', 'turnos-owner-a@example.com', 'Owner A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f5c01', '00000000-0000-0000-0000-0000000f5a01', null, 'owner', 'owner')
on conflict do nothing;
insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000f5a02', 'test') on conflict do nothing;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, status, attempts, claimed_at, last_error_class) values
  ('turnos-ok-1',        '00000000-0000-0000-0000-0000000f5a01', repeat('a', 64), 'processed',  1, now() - interval '2 minutes',  null),
  ('turnos-timeout-1',   '00000000-0000-0000-0000-0000000f5a01', repeat('b', 64), 'failed',     1, now() - interval '3 minutes',  'TimeoutError'),
  ('turnos-fallo-1',     '00000000-0000-0000-0000-0000000f5a01', repeat('c', 64), 'failed',     1, now() - interval '4 minutes',  'TypeError'),
  ('turnos-procesando',  '00000000-0000-0000-0000-0000000f5a01', repeat('d', 64), 'processing', 1, now() - interval '1 minute',   null),
  ('turnos-viejo',       '00000000-0000-0000-0000-0000000f5a01', repeat('e', 64), 'processed',  1, now() - interval '5 hours',    null),
  ('turnos-demo',        '00000000-0000-0000-0000-0000000f5a02', repeat('f', 64), 'failed',     1, now() - interval '2 minutes',  'TimeoutError')
on conflict do nothing;

\echo ''
\echo '=== A) el defecto: la sesion de sistema no ve la tabla por SELECT directo ==='
\echo ''
\echo '--- 1. SELECT directo con el rol de produccion: permission denied (no hay GRANT) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from restaurantes.whatsapp_inbound_events where organization_id = '00000000-0000-0000-0000-0000000f5a01';
rollback;

\echo ''
\echo '=== B) la funcion devuelve los turnos terminados de la ventana ==='
\echo ''
\echo '--- 2. ventana de 1 h: 3 turnos de la organizacion A (ok, timeout, fallo); ni processing, ni el viejo, ni la demo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as turnos_ventana_deberia_ser_3 from restaurantes.agente_turnos_recientes(now() - interval '1 hour', now());
rollback;

\echo '--- 3. los estados y la clase de error llegan tal cual (1 processed, 1 failed TimeoutError, 1 failed TypeError), mas reciente primero ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (
  array_agg(status order by claimed_at desc) = array['processed', 'failed', 'failed']
  and array_agg(coalesce(last_error_class, '-') order by claimed_at desc) = array['-', 'TimeoutError', 'TypeError']
)::int as estados_deberia_ser_1
from restaurantes.agente_turnos_recientes(now() - interval '1 hour', now());
rollback;

\echo '--- 4. ventana vacia (futuro lejano): 0 filas, sin error ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as ventana_vacia_deberia_ser_0 from restaurantes.agente_turnos_recientes(now() + interval '1 day', now() + interval '1 day 10 minutes');
rollback;

\echo '--- 5. la organizacion demo no aparece nunca ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as demo_deberia_ser_0 from restaurantes.agente_turnos_recientes(now() - interval '1 hour', now()) where organization_id = '00000000-0000-0000-0000-0000000f5a02';
rollback;

\echo '--- 6. el turno de hace 5 horas queda fuera incluso de la ventana maxima de 2 horas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as viejo_fuera_deberia_ser_3 from restaurantes.agente_turnos_recientes(now() - interval '2 hours', now());
rollback;

\echo ''
\echo '=== C) ventana invalida ==='
\echo ''
\echo '--- 7. mas de 2 horas: 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from restaurantes.agente_turnos_recientes(now() - interval '3 hours', now());
rollback;

\echo '--- 8. ventana invertida: 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from restaurantes.agente_turnos_recientes(now(), now() - interval '1 hour');
rollback;

\echo '--- 9. limites nulos: 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from restaurantes.agente_turnos_recientes(null, now());
rollback;

\echo ''
\echo '=== D) quien NO debe poder llamarla ==='
\echo ''
\echo '--- 10. staff autenticado (auth.uid() no nulo): 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c01', true);
select count(*) as should_fail from restaurantes.agente_turnos_recientes(now() - interval '1 hour', now());
rollback;

\echo '--- 11. anon: sin EXECUTE ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.agente_turnos_recientes(now() - interval '1 hour', now());
rollback;

\echo ''
\echo '=== E) sin PII ==='
\echo ''
\echo '--- 12. la funcion devuelve exactamente 4 columnas y ninguna es message_id ni phone_hash ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(p.proargnames) a where n.nspname = 'restaurantes' and p.proname = 'agente_turnos_recientes' and a in ('message_id', 'phone_hash')) = 0
)::int as sin_pii_deberia_ser_1;
rollback;
