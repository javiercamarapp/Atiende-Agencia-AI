-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales, no el repositorio en memoria), el SQL de
-- SOLO LECTURA del catalogo de "Chatea con tus datos" de CITAS (packages/domain-citas/src/data-chat/sql.ts) y la funcion
-- `citas.data_chat_reminder_delivery` de la migracion 027. El texto de cada consulta se copia IDENTICO aqui (lo genera el
-- mismo texto del modulo) y tests/data-chat/sql-drift.spec.ts de domain-citas falla si divergen.
--
-- Datos (zona America/Merida = UTC-6, sin horario de verano; "ahora" de los escenarios de huecos = lun 28-sep-2026 10:30 local):
--   Clinica A: sucursales Centro y Norte; profesionales Ana (Centro), Beto (Norte), Lola (SIN sucursal) e Inactivo (Centro, inactivo).
--   Clinica B (ajena): un profesional, un servicio con precio enorme y una cita.
--   Usuarios: owner A (todas), admin acotado a Centro, staff A (rol staff), owner B.
--
-- Escenarios (todos como rol `authenticated` con auth.uid() real, salvo `anon`):
--   A) alcance: sucursales visibles, cross-tenant en ambos sentidos, cross-sucursal (admin de Centro aunque la app pasara
--      null o el id de otra sucursal), `anon` sin acceso.
--   B) cifras exactas: citas por dia (dia LOCAL: una cita a las 22:30 locales cae en su dia aunque en UTC sea el siguiente),
--      ocupacion por profesional y por sucursal (excepciones del dia, cita fuera de horario, profesional inactivo),
--      cancelaciones/no-show, ingresos por periodo y por servicio, clientes nuevos vs recurrentes, huecos libres,
--      recordatorios pendientes.
--   C) funcion citas.data_chat_reminder_delivery: owner/admin de la organizacion, staff, otra organizacion, otra sucursal,
--      `authenticated` sin sesion y `anon`.
--   D) base sin migrar: con la funcion / columna / tabla eliminada dentro de la transaccion el SQL real falla con
--      42883 / 42703 / 42P01 y SAVEPOINT + ROLLBACK TO SAVEPOINT (el mecanismo de runWithSavepointFallback) deja la
--      transaccion utilizable.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = debe terminar en ERROR; alias
-- `..._deberia_ser_N` = esa consulta devuelve N; un bloque DO que lanza excepcion ante una discrepancia = debe completar sin
-- error. Cada escenario va en su `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off


insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-000000c10100', 'citas', 'Clinica A (data chat)', 'clinica-a-data-chat'),
  ('00000000-0000-0000-0000-000000c10200', 'citas', 'Clinica B (data chat, ajena)', 'clinica-b-data-chat')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000c11001', 'owner-a-dc-citas@example.com', 'Owner Clinica A', 'seed'),
  ('00000000-0000-0000-0000-000000c11002', 'admin-centro-dc-citas@example.com', 'Admin solo Centro', 'seed'),
  ('00000000-0000-0000-0000-000000c11003', 'staff-a-dc-citas@example.com', 'Staff Clinica A', 'seed'),
  ('00000000-0000-0000-0000-000000c11004', 'owner-b-dc-citas@example.com', 'Owner Clinica B (ajena)', 'seed')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c10100', 'citas', 'Centro'),
  ('00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c10100', 'citas', 'Norte'),
  ('00000000-0000-0000-0000-000000c12003', '00000000-0000-0000-0000-000000c10200', 'citas', 'Sucursal B (ajena)')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000c11001', '00000000-0000-0000-0000-000000c10100', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000c11002', '00000000-0000-0000-0000-000000c10100', array['00000000-0000-0000-0000-000000c12001']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000c11003', '00000000-0000-0000-0000-000000c10100', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000c11004', '00000000-0000-0000-0000-000000c10200', null, 'owner', 'owner')
on conflict do nothing;

insert into citas.tenant_config (organization_id, default_timezone) values ('00000000-0000-0000-0000-000000c10100', 'America/Merida'), ('00000000-0000-0000-0000-000000c10200', 'America/Merida') on conflict do nothing;

insert into citas.providers (id, organization_id, property_id, display_name, is_active) values
  ('00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', 'Ana Perez', true),
  ('00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', 'Beto Ruiz', true),
  ('00000000-0000-0000-0000-000000c13003', '00000000-0000-0000-0000-000000c10100', null, 'Lola Sin Sucursal', true),
  ('00000000-0000-0000-0000-000000c13004', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', 'Profesional inactivo', false),
  ('00000000-0000-0000-0000-000000c13005', '00000000-0000-0000-0000-000000c10200', '00000000-0000-0000-0000-000000c12003', 'Profesional ajeno B', true)
on conflict do nothing;

insert into citas.services (id, organization_id, name, duration_minutes, price_cents) values
  ('00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c10100', 'Consulta', 60, 50000),
  ('00000000-0000-0000-0000-000000c14002', '00000000-0000-0000-0000-000000c10100', 'Limpieza', 30, 30000),
  ('00000000-0000-0000-0000-000000c14003', '00000000-0000-0000-0000-000000c10100', 'Valoracion sin precio', 30, null),
  ('00000000-0000-0000-0000-000000c14004', '00000000-0000-0000-0000-000000c10200', 'Servicio B', 60, 99999900)
on conflict do nothing;

-- Horario: Ana lun-vie 09-13 (dom=0) · Beto lun-vie 10-14 · Lola solo lunes 09-10 · Inactivo y Ajeno tambien tienen horario.
insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time)
select p.id, d, p.t0::time, p.t1::time
from (values ('00000000-0000-0000-0000-000000c13001'::uuid, '09:00', '13:00'), ('00000000-0000-0000-0000-000000c13002'::uuid, '10:00', '14:00'), ('00000000-0000-0000-0000-000000c13004'::uuid, '09:00', '13:00'), ('00000000-0000-0000-0000-000000c13005'::uuid, '09:00', '13:00')) as p(id, t0, t1)
cross join generate_series(1, 5) as d;
insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time) values ('00000000-0000-0000-0000-000000c13003', 1, '09:00', '10:00');
-- Excepciones: Ana cerrada el vie 25-sep; Beto el mie 23-sep solo 10-12 (SUSTITUYE las reglas de ese dia).
insert into citas.availability_overrides (provider_id, override_date, is_closed, start_time, end_time) values
  ('00000000-0000-0000-0000-000000c13001', '2026-09-25', true, null, null),
  ('00000000-0000-0000-0000-000000c13002', '2026-09-23', false, '10:00', '12:00');

insert into citas.customers (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-000000c15001', '00000000-0000-0000-0000-000000c10100', 'Cliente Uno', '+520000000001'),
  ('00000000-0000-0000-0000-000000c15002', '00000000-0000-0000-0000-000000c10100', 'Cliente Dos', '+520000000002'),
  ('00000000-0000-0000-0000-000000c15003', '00000000-0000-0000-0000-000000c10100', 'Cliente Tres', '+520000000003'),
  ('00000000-0000-0000-0000-000000c15004', '00000000-0000-0000-0000-000000c10100', 'Cliente Cuatro', '+520000000004'),
  ('00000000-0000-0000-0000-000000c15005', '00000000-0000-0000-0000-000000c10200', 'Cliente B ajeno', '+520000000005')
on conflict do nothing;

insert into citas.appointments (id, organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, reminder_24h_sent_at) values
  ('00000000-0000-0000-0000-000000c16001', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15001', '2026-09-21T15:00:00Z', '2026-09-21T16:00:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c16002', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14002', '00000000-0000-0000-0000-000000c15002', '2026-09-21T16:00:00Z', '2026-09-21T16:30:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c16003', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15003', '2026-09-22T15:00:00Z', '2026-09-22T16:00:00Z', 'cancelled', null),
  ('00000000-0000-0000-0000-000000c16004', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14002', '00000000-0000-0000-0000-000000c15003', '2026-09-23T15:00:00Z', '2026-09-23T15:30:00Z', 'no_show', null),
  ('00000000-0000-0000-0000-000000c16005', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15001', '2026-09-24T15:00:00Z', '2026-09-24T16:00:00Z', 'confirmed', null),
  ('00000000-0000-0000-0000-000000c16006', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15002', '2026-09-25T15:00:00Z', '2026-09-25T16:00:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c16007', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15004', '2026-09-21T16:00:00Z', '2026-09-21T17:00:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c16008', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15004', '2026-09-23T17:00:00Z', '2026-09-23T19:00:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c16009', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c14002', '00000000-0000-0000-0000-000000c15001', '2026-09-22T16:00:00Z', '2026-09-22T17:00:00Z', 'pending', null),
  ('00000000-0000-0000-0000-000000c1600a', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c14002', '00000000-0000-0000-0000-000000c15004', '2026-09-22T04:30:00Z', '2026-09-22T05:00:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c1600b', '00000000-0000-0000-0000-000000c10100', null, '00000000-0000-0000-0000-000000c13003', '00000000-0000-0000-0000-000000c14003', '00000000-0000-0000-0000-000000c15002', '2026-09-21T15:00:00Z', '2026-09-21T15:30:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c1600c', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15001', '2026-09-01T15:00:00Z', '2026-09-01T16:00:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c1600d', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15004', '2026-08-31T16:00:00Z', '2026-08-31T17:00:00Z', 'cancelled', null),
  ('00000000-0000-0000-0000-000000c1600e', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15001', '2026-09-28T17:00:00Z', '2026-09-28T18:00:00Z', 'confirmed', null),
  ('00000000-0000-0000-0000-000000c1600f', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15002', '2026-09-29T15:00:00Z', '2026-09-29T16:00:00Z', 'pending', null),
  ('00000000-0000-0000-0000-000000c16010', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c14002', '00000000-0000-0000-0000-000000c15004', '2026-09-28T16:00:00Z', '2026-09-28T16:45:00Z', 'completed', null),
  ('00000000-0000-0000-0000-000000c16011', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15004', '2026-09-30T16:00:00Z', '2026-09-30T17:00:00Z', 'confirmed', '2026-09-29T16:00:00Z'),
  ('00000000-0000-0000-0000-000000c16012', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12002', '00000000-0000-0000-0000-000000c13002', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15001', '2026-10-01T16:00:00Z', '2026-10-01T17:00:00Z', 'confirmed', null),
  ('00000000-0000-0000-0000-000000c16013', '00000000-0000-0000-0000-000000c10100', '00000000-0000-0000-0000-000000c12001', '00000000-0000-0000-0000-000000c13001', '00000000-0000-0000-0000-000000c14001', '00000000-0000-0000-0000-000000c15003', '2026-09-30T15:00:00Z', '2026-09-30T16:00:00Z', 'cancelled', null),
  ('00000000-0000-0000-0000-000000c16014', '00000000-0000-0000-0000-000000c10200', '00000000-0000-0000-0000-000000c12003', '00000000-0000-0000-0000-000000c13005', '00000000-0000-0000-0000-000000c14004', '00000000-0000-0000-0000-000000c15005', '2026-09-22T15:00:00Z', '2026-09-22T16:00:00Z', 'completed', null)
on conflict do nothing;

-- Outbox: la fila 'appointment.created' (cita f3, misma forma de dedupe_key) NO es un recordatorio y no debe contar.
insert into citas.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status) values
  ('00000000-0000-0000-0000-000000c10100', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-000000c1600e', '{}'::jsonb, 'sent'),
  ('00000000-0000-0000-0000-000000c10100', 'email', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-000000c1600e', '{}'::jsonb, 'sent'),
  ('00000000-0000-0000-0000-000000c10100', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-000000c1600f', '{}'::jsonb, 'failed'),
  ('00000000-0000-0000-0000-000000c10100', 'email', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-000000c1600f', '{}'::jsonb, 'dead'),
  ('00000000-0000-0000-0000-000000c10100', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-000000c16011', '{}'::jsonb, 'pending'),
  ('00000000-0000-0000-0000-000000c10100', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-000000c16012', '{}'::jsonb, 'dead'),
  ('00000000-0000-0000-0000-000000c10100', 'whatsapp', 'appointment.created', 'reminder-24h:00000000-0000-0000-0000-000000c16010', '{}'::jsonb, 'sent'),
  ('00000000-0000-0000-0000-000000c10200', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-000000c16014', '{}'::jsonb, 'dead');


\echo ''
\echo '=== A) alcance: sucursales visibles, cross-tenant, cross-sucursal, anon ==='
\echo ''
\echo '--- 1. sucursales visibles. owner A ve Centro y Norte (no la de la clinica B) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'citas' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[] into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'name') = 'Centro' and (v->1->>'name') = 'Norte') then raise exception 'sucursales visibles. owner A ve Centro y Norte (no la de la : %', v; end if;
end $do$;
rollback;
\echo '--- 2. sucursales visibles. el admin de Centro (aunque la app pasara null) ve solo Centro ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'citas' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[] into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'name') = 'Centro') then raise exception 'sucursales visibles. el admin de Centro (aunque la app pasar: %', v; end if;
end $do$;
rollback;
\echo '--- 3. cross-tenant. el owner de la clinica B pidiendo la organizacion A no ve ninguna sucursal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'citas' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[] into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant. el owner de la clinica B pidiendo la organizac: %', v; end if;
end $do$;
rollback;
\echo '--- 4. citas por dia (owner A). 5 dias en hora LOCAL (la cita de las 22.30 del lunes cuenta el lunes aunque en UTC sea martes); la clinica B no aparece ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text into v;
  if not (jsonb_array_length(v) = 5 and (v->0->>'bucket') = '2026-09-21' and (v->0->>'total')::numeric = 5 and (v->0->>'scheduled')::numeric = 0 and (v->0->>'completed')::numeric = 5 and (v->0->>'cancelled')::numeric = 0 and (v->0->>'no_show')::numeric = 0 and (v->1->>'bucket') = '2026-09-22' and (v->1->>'total')::numeric = 2 and (v->1->>'scheduled')::numeric = 1 and (v->1->>'completed')::numeric = 0 and (v->1->>'cancelled')::numeric = 1 and (v->1->>'no_show')::numeric = 0 and (v->2->>'bucket') = '2026-09-23' and (v->2->>'total')::numeric = 2 and (v->2->>'scheduled')::numeric = 0 and (v->2->>'completed')::numeric = 1 and (v->2->>'cancelled')::numeric = 0 and (v->2->>'no_show')::numeric = 1 and (v->3->>'bucket') = '2026-09-24' and (v->3->>'total')::numeric = 1 and (v->3->>'scheduled')::numeric = 1 and (v->3->>'completed')::numeric = 0 and (v->3->>'cancelled')::numeric = 0 and (v->3->>'no_show')::numeric = 0 and (v->4->>'bucket') = '2026-09-25' and (v->4->>'total')::numeric = 1 and (v->4->>'scheduled')::numeric = 0 and (v->4->>'completed')::numeric = 1 and (v->4->>'cancelled')::numeric = 0 and (v->4->>'no_show')::numeric = 0) then raise exception 'citas por dia (owner A). 5 dias en hora LOCAL (la cita de la: %', v; end if;
end $do$;
rollback;
\echo '--- 5. citas por dia. agrupar por semana junta todo en el lunes 21 (11 citas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'week'::text into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'bucket') = '2026-09-21' and (v->0->>'total')::numeric = 11 and (v->0->>'completed')::numeric = 7 and (v->0->>'scheduled')::numeric = 2 and (v->0->>'cancelled')::numeric = 1 and (v->0->>'no_show')::numeric = 1) then raise exception 'citas por dia. agrupar por semana junta todo en el lunes 21 : %', v; end if;
end $do$;
rollback;
\echo '--- 6. cross-tenant. el owner de la clinica B pidiendo la organizacion A obtiene 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant. el owner de la clinica B pidiendo la organizac: %', v; end if;
end $do$;
rollback;
\echo '--- 7. cross-tenant. el owner de la clinica A pidiendo la organizacion B obtiene 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10200'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant. el owner de la clinica A pidiendo la organizac: %', v; end if;
end $do$;
rollback;
\echo '--- 8. cross-tenant. la clinica B solo ve su propia cita (1) con su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10200'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'bucket') = '2026-09-22' and (v->0->>'total')::numeric = 1 and (v->0->>'completed')::numeric = 1) then raise exception 'cross-tenant. la clinica B solo ve su propia cita (1) con su: %', v; end if;
end $do$;
rollback;
\echo '--- 9. cross-sucursal. el admin de Centro con su alcance [Centro] ve solo las 6 citas de Ana ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12001']::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text into v;
  if not (jsonb_array_length(v) = 5 and (v->0->>'bucket') = '2026-09-21' and (v->0->>'total')::numeric = 2 and (v->1->>'bucket') = '2026-09-22' and (v->1->>'total')::numeric = 1 and (v->2->>'bucket') = '2026-09-23' and (v->2->>'total')::numeric = 1 and (v->3->>'bucket') = '2026-09-24' and (v->3->>'total')::numeric = 1 and (v->4->>'bucket') = '2026-09-25' and (v->4->>'total')::numeric = 1) then raise exception 'cross-sucursal. el admin de Centro con su alcance [Centro] v: %', v; end if;
end $do$;
rollback;
\echo '--- 10. cross-sucursal. el admin de Centro aunque la app pasara null NO ve Norte (RLS por sucursal). 7 citas = Ana + Lola sin sucursal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'week'::text into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'bucket') = '2026-09-21' and (v->0->>'total')::numeric = 7) then raise exception 'cross-sucursal. el admin de Centro aunque la app pasara null: %', v; end if;
end $do$;
rollback;
\echo '--- 11. cross-sucursal. el admin de Centro pidiendo el id de Norte obtiene 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12002']::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-sucursal. el admin de Centro pidiendo el id de Norte o: %', v; end if;
end $do$;
rollback;
\echo '--- 12. alcance por nombre. owner A acotado a Norte ve las 4 citas de Beto ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12002']::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'week'::text into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'bucket') = '2026-09-21' and (v->0->>'total')::numeric = 4) then raise exception 'alcance por nombre. owner A acotado a Norte ve las 4 citas d: %', v; end if;
end $do$;
rollback;
\echo '--- 13. anon. sin acceso a las citas (permission denied) ---'
begin;
set local role anon;
do $do$
begin
  execute $q$select count(*) as should_fail from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as total,
    count(*) filter (where a.status in ('pending', 'confirmed')) as scheduled,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text;
end $do$;
rollback;
\echo '--- 14. anon. sin acceso a los ingresos (permission denied) ---'
begin;
set local role anon;
do $do$
begin
  execute $q$select count(*) as should_fail from (select s.name as service, count(*) as appointments,
    coalesce(sum(s.price_cents), 0) as revenue_cents,
    count(*) filter (where s.price_cents is null) as without_price,
    sum(coalesce(sum(s.price_cents), 0)) over () as total_revenue_cents
  from citas.appointments a
  join citas.services s on s.id = a.service_id and s.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4 and a.status = 'completed'
  group by s.id, s.name
  order by revenue_cents desc, s.name
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int;
end $do$;
rollback;

\echo ''
\echo '=== B) cifras exactas ==='
\echo ''
\echo '--- 15. ocupacion por profesional (lun 21 - vie 25). Ana 960 min disponibles (vie cerrado) y 150 ocupados (la cita del viernes cerrado y la cancelada no cuentan); Beto 1080 (el mie solo 10-12) y 180 (la cita de las 22.30 cae fuera de horario y la del mie se recorta a 60); Lola 60/30; sin el inactivo ni la clinica B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  ), avail as (
    select s.provider_id, sum(extract(epoch from (upper(s.slot) - lower(s.slot))) / 60) as minutes
    from slots s group by s.provider_id
  ), booked as (
    select s.provider_id, sum(extract(epoch from (upper(i.r) - lower(i.r))) / 60) as minutes
    from slots s
    join citas.appointments a on a.provider_id = s.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && s.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * s.slot as r) as i
    group by s.provider_id
  )
  select pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    coalesce(av.minutes, 0) as available_minutes, coalesce(bk.minutes, 0) as booked_minutes,
    sum(coalesce(av.minutes, 0)) over () as total_available, sum(coalesce(bk.minutes, 0)) over () as total_booked,
    count(*) over () as total_providers
  from prov pv
  left join avail av on av.provider_id = pv.id
  left join booked bk on bk.provider_id = pv.id
  left join core.property p on p.id = pv.property_id
  order by pv.display_name, pv.id
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21'::date, '2026-09-25'::date, 'America/Merida'::text, 51::int into v;
  if not (jsonb_array_length(v) = 3 and (v->0->>'provider') = 'Ana Perez' and (v->0->>'branch') = 'Centro' and (v->0->>'available_minutes')::numeric = 960 and (v->0->>'booked_minutes')::numeric = 150 and (v->0->>'total_available')::numeric = 2100 and (v->0->>'total_booked')::numeric = 360 and (v->0->>'total_providers')::numeric = 3 and (v->1->>'provider') = 'Beto Ruiz' and (v->1->>'branch') = 'Norte' and (v->1->>'available_minutes')::numeric = 1080 and (v->1->>'booked_minutes')::numeric = 180 and (v->2->>'provider') = 'Lola Sin Sucursal' and (v->2->>'branch') = 'Sin sucursal asignada' and (v->2->>'available_minutes')::numeric = 60 and (v->2->>'booked_minutes')::numeric = 30) then raise exception 'ocupacion por profesional (lun 21 - vie 25). Ana 960 min dis: %', v; end if;
end $do$;
rollback;
\echo '--- 16. ocupacion por sucursal. Centro 960/150, Norte 1080/180 y las citas sin sucursal aparte (60/30) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  ), avail as (
    select s.provider_id, sum(extract(epoch from (upper(s.slot) - lower(s.slot))) / 60) as minutes
    from slots s group by s.provider_id
  ), booked as (
    select s.provider_id, sum(extract(epoch from (upper(i.r) - lower(i.r))) / 60) as minutes
    from slots s
    join citas.appointments a on a.provider_id = s.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && s.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * s.slot as r) as i
    group by s.provider_id
  )
  select coalesce(p.name, 'Sin sucursal asignada') as branch, count(*) as providers,
    sum(coalesce(av.minutes, 0)) as available_minutes, sum(coalesce(bk.minutes, 0)) as booked_minutes,
    sum(sum(coalesce(av.minutes, 0))) over () as total_available, sum(sum(coalesce(bk.minutes, 0))) over () as total_booked,
    sum(count(*)) over () as total_providers
  from prov pv
  left join avail av on av.provider_id = pv.id
  left join booked bk on bk.provider_id = pv.id
  left join core.property p on p.id = pv.property_id
  group by p.id, p.name
  order by p.name nulls last, p.id
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21'::date, '2026-09-25'::date, 'America/Merida'::text, 51::int into v;
  if not (jsonb_array_length(v) = 3 and (v->0->>'branch') = 'Centro' and (v->0->>'providers')::numeric = 1 and (v->0->>'available_minutes')::numeric = 960 and (v->0->>'booked_minutes')::numeric = 150 and (v->0->>'total_available')::numeric = 2100 and (v->0->>'total_booked')::numeric = 360 and (v->0->>'total_providers')::numeric = 3 and (v->1->>'branch') = 'Norte' and (v->1->>'providers')::numeric = 1 and (v->1->>'available_minutes')::numeric = 1080 and (v->1->>'booked_minutes')::numeric = 180 and (v->2->>'branch') = 'Sin sucursal asignada' and (v->2->>'providers')::numeric = 1 and (v->2->>'available_minutes')::numeric = 60 and (v->2->>'booked_minutes')::numeric = 30) then raise exception 'ocupacion por sucursal. Centro 960/150, Norte 1080/180 y las: %', v; end if;
end $do$;
rollback;
\echo '--- 17. ocupacion. el admin de Centro con alcance [Centro] solo ve a Ana (ni Beto ni Lola sin sucursal) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  ), avail as (
    select s.provider_id, sum(extract(epoch from (upper(s.slot) - lower(s.slot))) / 60) as minutes
    from slots s group by s.provider_id
  ), booked as (
    select s.provider_id, sum(extract(epoch from (upper(i.r) - lower(i.r))) / 60) as minutes
    from slots s
    join citas.appointments a on a.provider_id = s.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && s.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * s.slot as r) as i
    group by s.provider_id
  )
  select pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    coalesce(av.minutes, 0) as available_minutes, coalesce(bk.minutes, 0) as booked_minutes,
    sum(coalesce(av.minutes, 0)) over () as total_available, sum(coalesce(bk.minutes, 0)) over () as total_booked,
    count(*) over () as total_providers
  from prov pv
  left join avail av on av.provider_id = pv.id
  left join booked bk on bk.provider_id = pv.id
  left join core.property p on p.id = pv.property_id
  order by pv.display_name, pv.id
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12001']::uuid[], '2026-09-21'::date, '2026-09-25'::date, 'America/Merida'::text, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'provider') = 'Ana Perez' and (v->0->>'available_minutes')::numeric = 960 and (v->0->>'booked_minutes')::numeric = 150 and (v->0->>'total_providers')::numeric = 1) then raise exception 'ocupacion. el admin de Centro con alcance [Centro] solo ve a: %', v; end if;
end $do$;
rollback;
\echo '--- 18. ocupacion. la clinica B solo ve a su profesional (5 dias x 240 = 1200 min disponibles y 60 ocupados) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  ), avail as (
    select s.provider_id, sum(extract(epoch from (upper(s.slot) - lower(s.slot))) / 60) as minutes
    from slots s group by s.provider_id
  ), booked as (
    select s.provider_id, sum(extract(epoch from (upper(i.r) - lower(i.r))) / 60) as minutes
    from slots s
    join citas.appointments a on a.provider_id = s.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && s.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * s.slot as r) as i
    group by s.provider_id
  )
  select pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    coalesce(av.minutes, 0) as available_minutes, coalesce(bk.minutes, 0) as booked_minutes,
    sum(coalesce(av.minutes, 0)) over () as total_available, sum(coalesce(bk.minutes, 0)) over () as total_booked,
    count(*) over () as total_providers
  from prov pv
  left join avail av on av.provider_id = pv.id
  left join booked bk on bk.provider_id = pv.id
  left join core.property p on p.id = pv.property_id
  order by pv.display_name, pv.id
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10200'::uuid, null::uuid[], '2026-09-21'::date, '2026-09-25'::date, 'America/Merida'::text, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'provider') = 'Profesional ajeno B' and (v->0->>'available_minutes')::numeric = 1200 and (v->0->>'booked_minutes')::numeric = 60 and (v->0->>'total_providers')::numeric = 1) then raise exception 'ocupacion. la clinica B solo ve a su profesional (5 dias x 2: %', v; end if;
end $do$;
rollback;
\echo '--- 19. cross-tenant. owner de la clinica A pidiendo la organizacion B en ocupacion obtiene 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  ), avail as (
    select s.provider_id, sum(extract(epoch from (upper(s.slot) - lower(s.slot))) / 60) as minutes
    from slots s group by s.provider_id
  ), booked as (
    select s.provider_id, sum(extract(epoch from (upper(i.r) - lower(i.r))) / 60) as minutes
    from slots s
    join citas.appointments a on a.provider_id = s.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && s.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * s.slot as r) as i
    group by s.provider_id
  )
  select pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    coalesce(av.minutes, 0) as available_minutes, coalesce(bk.minutes, 0) as booked_minutes,
    sum(coalesce(av.minutes, 0)) over () as total_available, sum(coalesce(bk.minutes, 0)) over () as total_booked,
    count(*) over () as total_providers
  from prov pv
  left join avail av on av.provider_id = pv.id
  left join booked bk on bk.provider_id = pv.id
  left join core.property p on p.id = pv.property_id
  order by pv.display_name, pv.id
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10200'::uuid, null::uuid[], '2026-09-21'::date, '2026-09-25'::date, 'America/Merida'::text, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant. owner de la clinica A pidiendo la organizacion: %', v; end if;
end $do$;
rollback;
\echo '--- 20. ocupacion. el admin de Centro aunque la app pasara null NO ve a Beto de Norte (la consulta repite la cobertura por sucursal); si ve a Lola sin sucursal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  ), avail as (
    select s.provider_id, sum(extract(epoch from (upper(s.slot) - lower(s.slot))) / 60) as minutes
    from slots s group by s.provider_id
  ), booked as (
    select s.provider_id, sum(extract(epoch from (upper(i.r) - lower(i.r))) / 60) as minutes
    from slots s
    join citas.appointments a on a.provider_id = s.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && s.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * s.slot as r) as i
    group by s.provider_id
  )
  select pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    coalesce(av.minutes, 0) as available_minutes, coalesce(bk.minutes, 0) as booked_minutes,
    sum(coalesce(av.minutes, 0)) over () as total_available, sum(coalesce(bk.minutes, 0)) over () as total_booked,
    count(*) over () as total_providers
  from prov pv
  left join avail av on av.provider_id = pv.id
  left join booked bk on bk.provider_id = pv.id
  left join core.property p on p.id = pv.property_id
  order by pv.display_name, pv.id
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21'::date, '2026-09-25'::date, 'America/Merida'::text, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'provider') = 'Ana Perez' and (v->0->>'total_providers')::numeric = 2 and (v->1->>'provider') = 'Lola Sin Sucursal') then raise exception 'ocupacion. el admin de Centro aunque la app pasara null NO v: %', v; end if;
end $do$;
rollback;
\echo '--- 21. cancelaciones y no-show por profesional. Ana 6 citas (3 completadas, 1 cancelada, 1 no-show, 1 por atender) y totales de TODO el alcance (11 / 1 / 1) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select pv.display_name as provider, count(*) as total,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show,
    sum(count(*)) over () as grand_total,
    sum(count(*) filter (where a.status = 'cancelled')) over () as grand_cancelled,
    sum(count(*) filter (where a.status = 'no_show')) over () as grand_no_show
  from citas.appointments a
  join citas.providers pv on pv.id = a.provider_id and pv.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by pv.id, pv.display_name
  order by count(*) filter (where a.status in ('cancelled', 'no_show')) desc, pv.display_name
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 3 and (v->0->>'provider') = 'Ana Perez' and (v->0->>'total')::numeric = 6 and (v->0->>'completed')::numeric = 3 and (v->0->>'cancelled')::numeric = 1 and (v->0->>'no_show')::numeric = 1 and (v->0->>'grand_total')::numeric = 11 and (v->0->>'grand_cancelled')::numeric = 1 and (v->0->>'grand_no_show')::numeric = 1 and (v->1->>'provider') = 'Beto Ruiz' and (v->1->>'total')::numeric = 4 and (v->1->>'completed')::numeric = 3 and (v->1->>'cancelled')::numeric = 0 and (v->1->>'no_show')::numeric = 0 and (v->2->>'provider') = 'Lola Sin Sucursal' and (v->2->>'total')::numeric = 1 and (v->2->>'completed')::numeric = 1) then raise exception 'cancelaciones y no-show por profesional. Ana 6 citas (3 comp: %', v; end if;
end $do$;
rollback;
\echo '--- 22. cancelaciones. cross-sucursal, el admin de Centro solo ve a Ana ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select pv.display_name as provider, count(*) as total,
    count(*) filter (where a.status = 'completed') as completed,
    count(*) filter (where a.status = 'cancelled') as cancelled,
    count(*) filter (where a.status = 'no_show') as no_show,
    sum(count(*)) over () as grand_total,
    sum(count(*) filter (where a.status = 'cancelled')) over () as grand_cancelled,
    sum(count(*) filter (where a.status = 'no_show')) over () as grand_no_show
  from citas.appointments a
  join citas.providers pv on pv.id = a.provider_id and pv.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4
  group by pv.id, pv.display_name
  order by count(*) filter (where a.status in ('cancelled', 'no_show')) desc, pv.display_name
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12001']::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'provider') = 'Ana Perez' and (v->0->>'total')::numeric = 6 and (v->0->>'grand_total')::numeric = 6) then raise exception 'cancelaciones. cross-sucursal, el admin de Centro solo ve a : %', v; end if;
end $do$;
rollback;
\echo '--- 23. ingresos por dia. lun 21 $1,600 en 5 citas (1 sin precio) -- la de las 22.30 locales cuenta el lunes; mie 23 $500; vie 25 $500; la clinica B ($999,999) no entra ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select to_char(date_trunc($7::text, a.starts_at at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    count(*) as appointments,
    coalesce(sum(s.price_cents), 0) as revenue_cents,
    count(*) filter (where s.price_cents is null) as without_price
  from citas.appointments a
  join citas.services s on s.id = a.service_id and s.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4 and a.status = 'completed'
  group by 1 order by 1 limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 'America/Merida'::text, 51::int, 'day'::text into v;
  if not (jsonb_array_length(v) = 3 and (v->0->>'bucket') = '2026-09-21' and (v->0->>'appointments')::numeric = 5 and (v->0->>'revenue_cents')::numeric = 160000 and (v->0->>'without_price')::numeric = 1 and (v->1->>'bucket') = '2026-09-23' and (v->1->>'appointments')::numeric = 1 and (v->1->>'revenue_cents')::numeric = 50000 and (v->1->>'without_price')::numeric = 0 and (v->2->>'bucket') = '2026-09-25' and (v->2->>'appointments')::numeric = 1 and (v->2->>'revenue_cents')::numeric = 50000 and (v->2->>'without_price')::numeric = 0) then raise exception 'ingresos por dia. lun 21 $1,600 en 5 citas (1 sin precio) --: %', v; end if;
end $do$;
rollback;
\echo '--- 24. ingresos por servicio. Consulta $2,000 (4), Limpieza $600 (2), sin precio $0 (1, sin precio); total $2,600 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select s.name as service, count(*) as appointments,
    coalesce(sum(s.price_cents), 0) as revenue_cents,
    count(*) filter (where s.price_cents is null) as without_price,
    sum(coalesce(sum(s.price_cents), 0)) over () as total_revenue_cents
  from citas.appointments a
  join citas.services s on s.id = a.service_id and s.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4 and a.status = 'completed'
  group by s.id, s.name
  order by revenue_cents desc, s.name
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 3 and (v->0->>'service') = 'Consulta' and (v->0->>'appointments')::numeric = 4 and (v->0->>'revenue_cents')::numeric = 200000 and (v->0->>'without_price')::numeric = 0 and (v->0->>'total_revenue_cents')::numeric = 260000 and (v->1->>'service') = 'Limpieza' and (v->1->>'appointments')::numeric = 2 and (v->1->>'revenue_cents')::numeric = 60000 and (v->2->>'service') = 'Valoracion sin precio' and (v->2->>'appointments')::numeric = 1 and (v->2->>'revenue_cents')::numeric = 0 and (v->2->>'without_price')::numeric = 1) then raise exception 'ingresos por servicio. Consulta $2,000 (4), Limpieza $600 (2: %', v; end if;
end $do$;
rollback;
\echo '--- 25. ingresos. cross-sucursal, el admin de Centro solo suma lo de Ana ($1,300 = 500 + 300 + 500) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select s.name as service, count(*) as appointments,
    coalesce(sum(s.price_cents), 0) as revenue_cents,
    count(*) filter (where s.price_cents is null) as without_price,
    sum(coalesce(sum(s.price_cents), 0)) over () as total_revenue_cents
  from citas.appointments a
  join citas.services s on s.id = a.service_id and s.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4 and a.status = 'completed'
  group by s.id, s.name
  order by revenue_cents desc, s.name
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12001']::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'service') = 'Consulta' and (v->0->>'appointments')::numeric = 2 and (v->0->>'revenue_cents')::numeric = 100000 and (v->0->>'total_revenue_cents')::numeric = 130000 and (v->1->>'service') = 'Limpieza' and (v->1->>'appointments')::numeric = 1 and (v->1->>'revenue_cents')::numeric = 30000) then raise exception 'ingresos. cross-sucursal, el admin de Centro solo suma lo de: %', v; end if;
end $do$;
rollback;
\echo '--- 26. ingresos. la clinica B solo ve su servicio ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select s.name as service, count(*) as appointments,
    coalesce(sum(s.price_cents), 0) as revenue_cents,
    count(*) filter (where s.price_cents is null) as without_price,
    sum(coalesce(sum(s.price_cents), 0)) over () as total_revenue_cents
  from citas.appointments a
  join citas.services s on s.id = a.service_id and s.organization_id = a.organization_id
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4 and a.status = 'completed'
  group by s.id, s.name
  order by revenue_cents desc, s.name
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10200'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'service') = 'Servicio B' and (v->0->>'appointments')::numeric = 1 and (v->0->>'revenue_cents')::numeric = 99999900) then raise exception 'ingresos. la clinica B solo ve su servicio: %', v; end if;
end $do$;
rollback;
\echo '--- 27. clientes (21-25). 3 con cita viva; C2 y C4 nuevos (C4 solo tenia una cita CANCELADA antes) y C1 recurrente; C3 solo cancelo/no asistio y no cuenta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with in_period as (
    select a.customer_id
    from citas.appointments a
    left join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4 and a.status in ('pending', 'confirmed', 'completed')
    group by a.customer_id
  ), before_period as (
    select distinct a.customer_id
    from citas.appointments a
    left join core.property p on p.id = a.property_id
    where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.starts_at < $3 and a.status in ('pending', 'confirmed', 'completed')
  )
  select count(*) as customers,
    count(*) filter (where b.customer_id is null) as new_customers,
    count(*) filter (where b.customer_id is not null) as recurring
  from in_period i left join before_period b on b.customer_id = i.customer_id
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'customers')::numeric = 3 and (v->0->>'new_customers')::numeric = 2 and (v->0->>'recurring')::numeric = 1) then raise exception 'clientes (21-25). 3 con cita viva; C2 y C4 nuevos (C4 solo t: %', v; end if;
end $do$;
rollback;
\echo '--- 28. clientes. el admin de Centro (alcance [Centro]) ve solo a C1 recurrente y C2 nuevo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with in_period as (
    select a.customer_id
    from citas.appointments a
    left join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4 and a.status in ('pending', 'confirmed', 'completed')
    group by a.customer_id
  ), before_period as (
    select distinct a.customer_id
    from citas.appointments a
    left join core.property p on p.id = a.property_id
    where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.starts_at < $3 and a.status in ('pending', 'confirmed', 'completed')
  )
  select count(*) as customers,
    count(*) filter (where b.customer_id is null) as new_customers,
    count(*) filter (where b.customer_id is not null) as recurring
  from in_period i left join before_period b on b.customer_id = i.customer_id
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12001']::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'customers')::numeric = 2 and (v->0->>'new_customers')::numeric = 1 and (v->0->>'recurring')::numeric = 1) then raise exception 'clientes. el admin de Centro (alcance [Centro]) ve solo a C1: %', v; end if;
end $do$;
rollback;
\echo '--- 29. clientes. cross-tenant, la clinica B pidiendo la organizacion A obtiene 0 clientes ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with in_period as (
    select a.customer_id
    from citas.appointments a
    left join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= $3 and a.starts_at < $4 and a.status in ('pending', 'confirmed', 'completed')
    group by a.customer_id
  ), before_period as (
    select distinct a.customer_id
    from citas.appointments a
    left join core.property p on p.id = a.property_id
    where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.starts_at < $3 and a.status in ('pending', 'confirmed', 'completed')
  )
  select count(*) as customers,
    count(*) filter (where b.customer_id is null) as new_customers,
    count(*) filter (where b.customer_id is not null) as recurring
  from in_period i left join before_period b on b.customer_id = i.customer_id
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'customers')::numeric = 0 and (v->0->>'new_customers')::numeric = 0 and (v->0->>'recurring')::numeric = 0) then raise exception 'clientes. cross-tenant, la clinica B pidiendo la organizacio: %', v; end if;
end $do$;
rollback;
\echo '--- 30. huecos libres (ahora = lun 28 10.30 local). Ana lun 90 (150 restantes - cita 60), mar 180; Beto lun 195 (210 - 15 de su cita en curso), mar 240; Lola lunes ya paso (no aparece) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  ), live as (
    select s.provider_id, s.day, s.slot * tstzrange($6::timestamptz, null) as slot
    from slots s
  ), cap as (
    select l.provider_id, l.day, sum(extract(epoch from (upper(l.slot) - lower(l.slot))) / 60) as minutes
    from live l where not isempty(l.slot) group by l.provider_id, l.day
  ), bk as (
    select l.provider_id, l.day, sum(extract(epoch from (upper(i.r) - lower(i.r))) / 60) as minutes
    from live l
    join citas.appointments a on a.provider_id = l.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && l.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * l.slot as r) as i
    where not isempty(l.slot)
    group by l.provider_id, l.day
  )
  select to_char(c.day, 'YYYY-MM-DD') as day, pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    c.minutes - coalesce(b.minutes, 0) as free_minutes,
    sum(c.minutes - coalesce(b.minutes, 0)) over () as total_free
  from cap c
  join prov pv on pv.id = c.provider_id
  left join bk b on b.provider_id = c.provider_id and b.day = c.day
  left join core.property p on p.id = pv.property_id
  where c.minutes - coalesce(b.minutes, 0) > 0
  order by c.day, pv.display_name, pv.id
  limit $7) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-29'::date, 'America/Merida'::text, '2026-09-28T16:30:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 4 and (v->0->>'day') = '2026-09-28' and (v->0->>'provider') = 'Ana Perez' and (v->0->>'branch') = 'Centro' and (v->0->>'free_minutes')::numeric = 90 and (v->0->>'total_free')::numeric = 705 and (v->1->>'day') = '2026-09-28' and (v->1->>'provider') = 'Beto Ruiz' and (v->1->>'branch') = 'Norte' and (v->1->>'free_minutes')::numeric = 195 and (v->2->>'day') = '2026-09-29' and (v->2->>'provider') = 'Ana Perez' and (v->2->>'free_minutes')::numeric = 180 and (v->3->>'day') = '2026-09-29' and (v->3->>'provider') = 'Beto Ruiz' and (v->3->>'free_minutes')::numeric = 240) then raise exception 'huecos libres (ahora = lun 28 10.30 local). Ana lun 90 (150 : %', v; end if;
end $do$;
rollback;
\echo '--- 31. recordatorios por enviar (ahora = lun 28 10.30 local). 3 citas por atender sin recordatorio (la cancelada, la completada y la que ya tiene marca no cuentan), 2 empiezan en menos de 24 h ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select count(*) as pending,
    count(*) filter (where a.starts_at < $5::timestamptz + interval '24 hours') as next_24h
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= greatest($3::timestamptz, $5::timestamptz) and a.starts_at < $4
    and a.status in ('pending', 'confirmed') and a.reminder_24h_sent_at is null
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, '2026-09-28T16:30:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'pending')::numeric = 3 and (v->0->>'next_24h')::numeric = 2) then raise exception 'recordatorios por enviar (ahora = lun 28 10.30 local). 3 cit: %', v; end if;
end $do$;
rollback;
\echo '--- 32. recordatorios por enviar. el admin de Centro solo ve las 2 de Ana ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select count(*) as pending,
    count(*) filter (where a.starts_at < $5::timestamptz + interval '24 hours') as next_24h
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= greatest($3::timestamptz, $5::timestamptz) and a.starts_at < $4
    and a.status in ('pending', 'confirmed') and a.reminder_24h_sent_at is null
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12001']::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, '2026-09-28T16:30:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'pending')::numeric = 2 and (v->0->>'next_24h')::numeric = 2) then raise exception 'recordatorios por enviar. el admin de Centro solo ve las 2 d: %', v; end if;
end $do$;
rollback;
\echo '--- 33. recordatorios por enviar. cross-tenant, la clinica B pidiendo la organizacion A obtiene 0 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select count(*) as pending,
    count(*) filter (where a.starts_at < $5::timestamptz + interval '24 hours') as next_24h
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= greatest($3::timestamptz, $5::timestamptz) and a.starts_at < $4
    and a.status in ('pending', 'confirmed') and a.reminder_24h_sent_at is null
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, '2026-09-28T16:30:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'pending')::numeric = 0 and (v->0->>'next_24h')::numeric = 0) then raise exception 'recordatorios por enviar. cross-tenant, la clinica B pidiend: %', v; end if;
end $do$;
rollback;

\echo ''
\echo '=== C) funcion citas.data_chat_reminder_delivery (migracion 027) ==='
\echo ''
\echo '--- 34. entrega de recordatorios (owner A). solo recordatorios (la fila appointment.created no cuenta) y solo la organizacion A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 6 and (v->0->>'channel') = 'email' and (v->0->>'status') = 'dead' and (v->0->>'total')::numeric = 1 and (v->1->>'channel') = 'email' and (v->1->>'status') = 'sent' and (v->1->>'total')::numeric = 1 and (v->2->>'channel') = 'whatsapp' and (v->2->>'status') = 'dead' and (v->2->>'total')::numeric = 1 and (v->3->>'channel') = 'whatsapp' and (v->3->>'status') = 'failed' and (v->3->>'total')::numeric = 1 and (v->4->>'channel') = 'whatsapp' and (v->4->>'status') = 'pending' and (v->4->>'total')::numeric = 1 and (v->5->>'channel') = 'whatsapp' and (v->5->>'status') = 'sent' and (v->5->>'total')::numeric = 1) then raise exception 'entrega de recordatorios (owner A). solo recordatorios (la f: %', v; end if;
end $do$;
rollback;
\echo '--- 35. entrega. el admin de Centro con [Centro] solo cuenta los recordatorios de Ana ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12001']::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 4 and (v->0->>'channel') = 'email' and (v->0->>'status') = 'dead' and (v->0->>'total')::numeric = 1 and (v->1->>'channel') = 'email' and (v->1->>'status') = 'sent' and (v->1->>'total')::numeric = 1 and (v->2->>'channel') = 'whatsapp' and (v->2->>'status') = 'failed' and (v->2->>'total')::numeric = 1 and (v->3->>'channel') = 'whatsapp' and (v->3->>'status') = 'sent' and (v->3->>'total')::numeric = 1) then raise exception 'entrega. el admin de Centro con [Centro] solo cuenta los rec: %', v; end if;
end $do$;
rollback;
\echo '--- 36. entrega. el admin de Centro aunque la app pasara null solo cuenta Centro (la funcion aplica su propia cobertura por sucursal) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 4 and (v->0->>'channel') = 'email' and (v->0->>'status') = 'dead' and (v->0->>'total')::numeric = 1 and (v->1->>'channel') = 'email' and (v->1->>'status') = 'sent' and (v->1->>'total')::numeric = 1 and (v->2->>'channel') = 'whatsapp' and (v->2->>'status') = 'failed' and (v->2->>'total')::numeric = 1 and (v->3->>'channel') = 'whatsapp' and (v->3->>'status') = 'sent' and (v->3->>'total')::numeric = 1) then raise exception 'entrega. el admin de Centro aunque la app pasara null solo c: %', v; end if;
end $do$;
rollback;
\echo '--- 37. entrega. el admin de Centro pidiendo el id de Norte obtiene 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11002', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, array['00000000-0000-0000-0000-000000c12002']::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'entrega. el admin de Centro pidiendo el id de Norte obtiene : %', v; end if;
end $do$;
rollback;
\echo '--- 38. entrega. el rol staff (no owner/admin) obtiene 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11003', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'entrega. el rol staff (no owner/admin) obtiene 0 filas: %', v; end if;
end $do$;
rollback;
\echo '--- 39. entrega. cross-tenant, el owner de la clinica B pidiendo la organizacion A obtiene 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'entrega. cross-tenant, el owner de la clinica B pidiendo la : %', v; end if;
end $do$;
rollback;
\echo '--- 40. entrega. la clinica B solo ve su propio recordatorio fallido (su cita es del 22) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11004', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10200'::uuid, null::uuid[], '2026-09-21T06:00:00Z'::timestamptz, '2026-09-26T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'channel') = 'whatsapp' and (v->0->>'status') = 'dead' and (v->0->>'total')::numeric = 1) then raise exception 'entrega. la clinica B solo ve su propio recordatorio fallido: %', v; end if;
end $do$;
rollback;
\echo '--- 41. entrega. authenticated SIN sesion (auth.uid() nulo) obtiene 0 filas ---'
begin;
set local role authenticated;
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'entrega. authenticated SIN sesion (auth.uid() nulo) obtiene : %', v; end if;
end $do$;
rollback;
\echo '--- 42. entrega. anon no puede ejecutar la funcion (permission denied) ---'
begin;
set local role anon;
do $do$
begin
  execute $q$select count(*) as should_fail from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int;
end $do$;
rollback;
\echo '--- 43. authenticated no puede leer el outbox directamente (por eso existe la funcion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
select count(*) as should_fail from citas.messaging_outbox;
rollback;
\echo '--- 44. catalogo. security definer, search_path fijo, sin EXECUTE para anon ni public, con EXECUTE para authenticated ---'
begin;
do $do$
declare r record;
begin
  select p.prosecdef, p.proconfig into r from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'citas' and p.proname = 'data_chat_reminder_delivery';
  if not found then raise exception 'la funcion no existe'; end if;
  if not r.prosecdef then raise exception 'debe ser security definer'; end if;
  if not (r.proconfig @> array['search_path=citas, core, pg_temp']) then raise exception 'search_path no fijado: %', r.proconfig; end if;
  if has_function_privilege('anon', 'citas.data_chat_reminder_delivery(uuid, uuid[], timestamptz, timestamptz)', 'execute') then raise exception 'anon no debe poder ejecutarla'; end if;
  if has_function_privilege('public', 'citas.data_chat_reminder_delivery(uuid, uuid[], timestamptz, timestamptz)', 'execute') then raise exception 'public no debe poder ejecutarla'; end if;
  if not has_function_privilege('authenticated', 'citas.data_chat_reminder_delivery(uuid, uuid[], timestamptz, timestamptz)', 'execute') then raise exception 'authenticated debe poder ejecutarla'; end if;
end $do$;
rollback;

\echo ''
\echo '=== D) base SIN migrar: SQLSTATE real + SAVEPOINT (mismo mecanismo que runWithSavepointFallback) ==='
\echo ''
\echo '--- 45. sin migracion 027 (funcion ausente) el SQL de entrega falla con 42883 y la transaccion se recupera (nunca 25P02) ---'
begin;
drop function citas.data_chat_reminder_delivery(uuid, uuid[], timestamptz, timestamptz);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
savepoint sp_verify_unmigrated;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select d.channel, d.status, d.total
  from citas.data_chat_reminder_delivery($1::uuid, $2::uuid[], $3::timestamptz, $4::timestamptz) as d
  limit $5) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, 51::int;
    raise exception 'se esperaba SQLSTATE 42883 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42883' then raise exception 'se esperaba 42883, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_unmigrated;
release savepoint sp_verify_unmigrated;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 46. sin la columna reminder_24h_sent_at el SQL de recordatorios por enviar falla con 42703 y la transaccion se recupera ---'
begin;
alter table citas.appointments drop column reminder_24h_sent_at;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
savepoint sp_verify_unmigrated;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select count(*) as pending,
    count(*) filter (where a.starts_at < $5::timestamptz + interval '24 hours') as next_24h
  from citas.appointments a
  left join core.property p on p.id = a.property_id
  where a.organization_id = $1 and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
    and a.starts_at >= greatest($3::timestamptz, $5::timestamptz) and a.starts_at < $4
    and a.status in ('pending', 'confirmed') and a.reminder_24h_sent_at is null
  limit $6) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-02T06:00:00Z'::timestamptz, '2026-09-28T16:30:00Z'::timestamptz, 51::int;
    raise exception 'se esperaba SQLSTATE 42703 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42703' then raise exception 'se esperaba 42703, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_unmigrated;
release savepoint sp_verify_unmigrated;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 47. sin la tabla availability_overrides el SQL de huecos falla con 42P01 y la transaccion se recupera ---'
begin;
drop table citas.availability_overrides cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000c11001', true);
savepoint sp_verify_unmigrated;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (with prov as (
    select pr.id, pr.display_name, pr.property_id
    from citas.providers pr
    where pr.organization_id = $1 and pr.is_active
      and ($2::uuid[] is null or pr.property_id = any($2::uuid[]))
      and exists (
        select 1 from core.membership m
        where m.organization_id = pr.organization_id and m.user_id = auth.uid()
          and (pr.property_id is null or m.property_ids is null or pr.property_id = any(m.property_ids))
      )
  ), slots as (
    select pv.id as provider_id, ($3::date + g.n) as day,
      tstzrange((($3::date + g.n) + x.t0) at time zone $5::text, (($3::date + g.n) + x.t1) at time zone $5::text) as slot
    from prov pv
    cross join generate_series(0, $4::date - $3::date) as g(n)
    cross join lateral (
      select o.start_time as t0, o.end_time as t1
      from citas.availability_overrides o
      where o.provider_id = pv.id and o.override_date = ($3::date + g.n) and not o.is_closed
      union all
      select r.start_time, r.end_time
      from citas.availability_rules r
      where r.provider_id = pv.id and r.is_active and r.day_of_week = extract(dow from ($3::date + g.n))::int
        and not exists (select 1 from citas.availability_overrides o2 where o2.provider_id = pv.id and o2.override_date = ($3::date + g.n))
    ) as x(t0, t1)
  ), live as (
    select s.provider_id, s.day, s.slot * tstzrange($6::timestamptz, null) as slot
    from slots s
  ), cap as (
    select l.provider_id, l.day, sum(extract(epoch from (upper(l.slot) - lower(l.slot))) / 60) as minutes
    from live l where not isempty(l.slot) group by l.provider_id, l.day
  ), bk as (
    select l.provider_id, l.day, sum(extract(epoch from (upper(i.r) - lower(i.r))) / 60) as minutes
    from live l
    join citas.appointments a on a.provider_id = l.provider_id and a.organization_id = $1
      and a.status in ('pending', 'confirmed', 'completed') and tstzrange(a.starts_at, a.ends_at) && l.slot
    cross join lateral (select tstzrange(a.starts_at, a.ends_at) * l.slot as r) as i
    where not isempty(l.slot)
    group by l.provider_id, l.day
  )
  select to_char(c.day, 'YYYY-MM-DD') as day, pv.display_name as provider, coalesce(p.name, 'Sin sucursal asignada') as branch,
    c.minutes - coalesce(b.minutes, 0) as free_minutes,
    sum(c.minutes - coalesce(b.minutes, 0)) over () as total_free
  from cap c
  join prov pv on pv.id = c.provider_id
  left join bk b on b.provider_id = c.provider_id and b.day = c.day
  left join core.property p on p.id = pv.property_id
  where c.minutes - coalesce(b.minutes, 0) > 0
  order by c.day, pv.display_name, pv.id
  limit $7) t$q$ using '00000000-0000-0000-0000-000000c10100'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-29'::date, 'America/Merida'::text, '2026-09-28T16:30:00Z'::timestamptz, 51::int;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_unmigrated;
release savepoint sp_verify_unmigrated;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo ''
\echo '=== fin: todos los escenarios con DO deben completar sin error; los marcados should_fail deben terminar en ERROR ==='
