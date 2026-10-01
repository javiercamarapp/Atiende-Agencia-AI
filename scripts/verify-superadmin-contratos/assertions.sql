-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0037_superadmin_contrato_cliente.sql (SA-43, contrato por cliente):
--
--   A) Alta: solo un superadmin real y NO restringido (caller-binding, staff normal, rol `finanzas`,
--      anon y sesion de sistema rechazados), validaciones, version 1 con quien y por que.
--   B) Vigencias traslapadas rechazadas EN LA BASE (un dia en comun, contrato sin fin, enmienda que
--      extiende el fin sobre otro contrato); contiguas e independientes entre organizaciones, OK.
--   C) Enmiendas: version n+1 inmutable con su autor; sin cambios, en el pasado, no crecientes, despues
--      del fin del contrato o sobre un contrato inexistente, rechazadas; otros usuarios sin acceso.
--   D) Inmutabilidad: UPDATE, DELETE y TRUNCATE bloqueados (0A000) incluso para el dueño.
--   E) Lecturas: historial e insumos de la facturacion estimada (sucursales activas, minutos de voz del
--      mes), cero filas para quien no es el superadmin autenticado, aislamiento entre organizaciones.
--   F) La tabla no tiene ningun acceso directo (RLS sin policy, sin GRANT) y las funciones nuevas estan
--      fijadas a search_path y no son ejecutables por anon.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; el alias `should_fail` marca un escenario que debe terminar en ERROR; el alias
-- deberia_ser_N exige que la ultima fila valga N; el resto debe completar sin error. Sesion de SISTEMA =
-- rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures (como dueño, sin pasar por las funciones).
insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000e5000', 'restaurantes', 'Org A contratos', 'org-ct-a', 'active'),
  ('00000000-0000-0000-0000-0000000e5001', 'hoteles', 'Org B contratos', 'org-ct-b', 'active')
on conflict do nothing;

-- A: 3 sucursales activas y 1 inactiva (no cuenta). B: ninguna.
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', 'restaurantes', 'Sucursal 1', 'active'),
  ('00000000-0000-0000-0000-0000000e5301', '00000000-0000-0000-0000-0000000e5000', 'restaurantes', 'Sucursal 2', 'active'),
  ('00000000-0000-0000-0000-0000000e5302', '00000000-0000-0000-0000-0000000e5000', 'restaurantes', 'Sucursal 3', 'active'),
  ('00000000-0000-0000-0000-0000000e5303', '00000000-0000-0000-0000-0000000e5000', 'restaurantes', 'Sucursal cerrada', 'inactive')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e5100', 'sa-ct-1@example.com', 'Superadmin CT 1', 'seed'),
  ('00000000-0000-0000-0000-0000000e5101', 'sa-ct-2@example.com', 'Superadmin CT 2', 'seed'),
  ('00000000-0000-0000-0000-0000000e5102', 'owner-ct@example.com', 'Owner de la Org A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5103', 'finanzas-ct@example.com', 'Finanzas CT', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000e5100'), ('00000000-0000-0000-0000-0000000e5101'), ('00000000-0000-0000-0000-0000000e5103')
on conflict do nothing;

-- Superadmin restringido al rol `finanzas` (solo lectura, 0034).
insert into core.cfo_zone_role (staff_user_id, rol, assigned_by, reason) values
  ('00000000-0000-0000-0000-0000000e5103', 'finanzas', '00000000-0000-0000-0000-0000000e5100', 'Fixture: rol de solo lectura para la verificacion.')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e5102', '00000000-0000-0000-0000-0000000e5000', null, 'owner', 'staff')
on conflict do nothing;

-- Voz de A en septiembre 2026: 3 min + 90 s (1.5 min) = 4.5 -> 5 min (2 eventos); en octubre: 7 min (1 evento).
-- Un evento de whatsapp en septiembre NO cuenta como voz.
insert into core.usage_cost_event (organization_id, property_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, costo_estimado, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000e5000', null, 'restaurantes', '2026-09-10 12:00+00', 'voz', 'livekit', 'minuto', 3, 1500000, true, 'voice_call', 'ct-va-1'),
  ('00000000-0000-0000-0000-0000000e5000', null, 'restaurantes', '2026-09-11 12:00+00', 'voz', 'livekit', 'segundo', 90, 700000, true, 'voice_call', 'ct-va-2'),
  ('00000000-0000-0000-0000-0000000e5000', null, 'restaurantes', '2026-09-12 12:00+00', 'whatsapp', 'meta', 'mensaje', 100, 400000, false, 'whatsapp_msg', 'ct-wa-1'),
  ('00000000-0000-0000-0000-0000000e5000', null, 'restaurantes', '2026-10-05 12:00+00', 'voz', 'livekit', 'minuto', 7, 3000000, true, 'voice_call', 'ct-va-3')
on conflict do nothing;

-- Ayudantes SOLO de esta verificacion (invoker: usan la identidad de quien llama). Dan fechas relativas al mes
-- en curso (hora de Mexico) para que las pruebas de enmienda no dependan del dia en que corra el CI.
create or replace function public.ct_m0() returns date language sql stable as $$
  select date_trunc('month', (now() at time zone 'America/Mexico_City'))::date
$$;
create or replace function public.ct_crear(p_caller uuid, p_org uuid, p_desde date, p_hasta date, p_base bigint default 590000, p_bolsa integer default 10000)
returns uuid language sql as $$
  select core.superadmin_create_contract(p_caller, p_org, p_desde, p_hasta, p_base, 400000, 1, p_bolsa, 300, 4500000, 0, 0, 'Fixture: alta de contrato de la verificacion.')
$$;
create or replace function public.ct_enmendar(p_caller uuid, p_contract uuid, p_desde date, p_hasta date default null, p_base bigint default 790000, p_bolsa integer default 10000)
returns integer language sql as $$
  select core.superadmin_amend_contract(p_caller, p_contract, p_desde, p_hasta, p_base, 400000, 1, p_bolsa, 300, 4500000, 0, 0, 'Fixture: enmienda de contrato de la verificacion.')
$$;

\echo 'A1. superadmin da de alta un contrato: version 1, contract_id = id, MXN, autor y motivo guardados -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
reset role;
select (version = 1 and contract_id = id and moneda = 'MXN' and created_by = '00000000-0000-0000-0000-0000000e5100' and motivo like 'Fixture:%' and vigente_hasta is null and base_centavos = 590000)::int as deberia_ser_1
from core.customer_contract_version where contract_id = current_setting('t.c1')::uuid;
rollback;

\echo 'A2. el owner de la propia organizacion (staff normal, no superadmin) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5102', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5102', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null) as should_fail;
rollback;

\echo 'A3. anon no puede ejecutar superadmin_create_contract (sin GRANT EXECUTE) -- RECHAZADO'
begin;
set local role anon;
select core.superadmin_create_contract('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null, 1, 1, 0, 0, 0, 0, 0, 0, 'Intento de anon que debe fallar.') as should_fail;
rollback;

\echo 'A4. caller-binding: p_caller_id de un superadmin pero auth.uid() de OTRO superadmin -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5101', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null) as should_fail;
rollback;

\echo 'A5. superadmin restringido al rol finanzas (solo lectura) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5103', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5103', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null) as should_fail;
rollback;

\echo 'A6. sesion de sistema (auth.uid() nulo) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null) as should_fail;
rollback;

\echo 'A7. organizacion inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5999', public.ct_m0(), null) as should_fail;
rollback;

\echo 'A8. monto negativo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null, -1) as should_fail;
rollback;

\echo 'A9. descuento de mas de 100 % (10001 puntos base) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select core.superadmin_create_contract('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null, 590000, 400000, 1, 10000, 300, 0, 10001, 0, 'Fixture: descuento fuera de rango.') as should_fail;
rollback;

\echo 'A10. motivo de menos de 20 caracteres -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select core.superadmin_create_contract('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'corto') as should_fail;
rollback;

\echo 'A11. vigente_hasta anterior a vigente_desde -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), public.ct_m0() - 1) as should_fail;
rollback;

\echo 'A12. con descuento porcentual y fijo y bolsa en cero se guarda tal cual (enteros) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', core.superadmin_create_contract('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), public.ct_m0() + 365, 590000, 400000, 2, 0, 300, 4500000, 1000, 5000, 'Fixture: descuentos y bolsa en cero.')::text, true);
reset role;
select (descuento_bp = 1000 and descuento_fijo_centavos = 5000 and bolsa_minutos = 0 and sucursales_incluidas = 2 and instalacion_centavos = 4500000)::int as deberia_ser_1
from core.customer_contract_version where contract_id = current_setting('t.c1')::uuid;
rollback;

\echo 'B1. segundo contrato de la misma organizacion que se traslapa con uno SIN FIN -- RECHAZADO (23P01)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() + 30, public.ct_m0() + 60) as should_fail;
rollback;

\echo 'B2. traslape de UN SOLO dia (el fin del primero es el inicio del segundo) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, public.ct_m0() + 30);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() + 30, null) as should_fail;
rollback;

\echo 'B3. contratos contiguos (el segundo empieza el dia siguiente al fin del primero) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, public.ct_m0() + 30);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() + 31, null);
reset role;
select count(*) as deberia_ser_2 from core.customer_contract_version where organization_id = '00000000-0000-0000-0000-0000000e5000';
rollback;

\echo 'B4. dos organizaciones distintas pueden tener la misma vigencia (el traslape es por organizacion) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5001', public.ct_m0() - 90, null);
reset role;
select count(distinct organization_id) as deberia_ser_2 from core.customer_contract_version where organization_id in ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5001');
rollback;

\echo 'B5. un contrato anterior con fin y uno posterior sin fin NO se traslapan; uno nuevo antes de ambos que alcanza al primero SI -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, public.ct_m0() + 30);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 200, public.ct_m0() - 89) as should_fail;
rollback;

\echo 'B6. una enmienda que EXTIENDE el fin de un contrato sobre otro contrato -- RECHAZADO (23P01)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, public.ct_m0() + 30)::text, true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() + 31, null);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5100', current_setting('t.c1')::uuid, public.ct_m0(), public.ct_m0() + 45) as should_fail;
rollback;

\echo 'C1. enmienda a mitad de mes: version 2 con su autor y la version 1 intacta (historial inmutable) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5100', current_setting('t.c1')::uuid, public.ct_m0() + 14, null);
reset role;
select (count(*) = 2
        and count(*) filter (where version = 1 and base_centavos = 590000 and vigente_desde = public.ct_m0() - 90) = 1
        and count(*) filter (where version = 2 and base_centavos = 790000 and vigente_desde = public.ct_m0() + 14 and created_by = '00000000-0000-0000-0000-0000000e5100') = 1)::int as deberia_ser_1
from core.customer_contract_version where contract_id = current_setting('t.c1')::uuid;
rollback;

\echo 'C2. enmienda que no cambia ninguna condicion -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5100', current_setting('t.c1')::uuid, public.ct_m0() + 14, null, 590000) as should_fail;
rollback;

\echo 'C3. enmienda que empieza antes del primer dia del mes en curso (no se reescribe el pasado) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5100', current_setting('t.c1')::uuid, public.ct_m0() - 1) as should_fail;
rollback;

\echo 'C4. enmienda con el mismo vigente_desde que la version anterior (no creciente) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0(), null)::text, true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5100', current_setting('t.c1')::uuid, public.ct_m0()) as should_fail;
rollback;

\echo 'C5. enmienda que empieza despues del fin del contrato -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, public.ct_m0() + 10)::text, true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5100', current_setting('t.c1')::uuid, public.ct_m0() + 20, null) as should_fail;
rollback;

\echo 'C6. enmendar un contrato inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5998', public.ct_m0() + 1) as should_fail;
rollback;

\echo 'C7. el owner de la organizacion (staff normal) no puede enmendar su contrato -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5102', true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5102', current_setting('t.c1')::uuid, public.ct_m0() + 14) as should_fail;
rollback;

\echo 'C8. el rol finanzas (solo lectura) no puede enmendar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5103', true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5103', current_setting('t.c1')::uuid, public.ct_m0() + 14) as should_fail;
rollback;

\echo 'C9. anon no puede ejecutar superadmin_amend_contract -- RECHAZADO'
begin;
set local role anon;
select core.superadmin_amend_contract('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5998', public.ct_m0() + 1, null, 1, 1, 0, 0, 0, 0, 0, 0, 'Intento de anon que debe fallar.') as should_fail;
rollback;

\echo 'C10. el segundo superadmin enmienda y queda como autor de la version 2 (quien lo cambio) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5101', true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5101', current_setting('t.c1')::uuid, public.ct_m0() + 14, null);
reset role;
select (created_by = '00000000-0000-0000-0000-0000000e5101')::int as deberia_ser_1 from core.customer_contract_version where contract_id = current_setting('t.c1')::uuid and version = 2;
rollback;

\echo 'D1. UPDATE de una version (como dueño de la tabla) -- RECHAZADO (0A000, historial inmutable)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
reset role;
update core.customer_contract_version set base_centavos = 1 where contract_id = current_setting('t.c1')::uuid returning 1 as should_fail;
rollback;

\echo 'D2. DELETE de una version (como dueño de la tabla) -- RECHAZADO (0A000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
reset role;
delete from core.customer_contract_version where contract_id = current_setting('t.c1')::uuid returning 1 as should_fail;
rollback;

\echo 'D3. TRUNCATE bloqueado con SQLSTATE 0A000 (el bloque termina bien solo si el trigger lo rechazo)'
begin;
do $$
begin
  begin
    truncate core.customer_contract_version;
    raise exception 'el TRUNCATE no fue bloqueado';
  exception when sqlstate '0A000' then
    null;
  end;
end $$;
rollback;

\echo 'E1. superadmin lista el historial de la organizacion (2 versiones, la mas reciente primero) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select set_config('t.c1', public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null)::text, true);
select public.ct_enmendar('00000000-0000-0000-0000-0000000e5100', current_setting('t.c1')::uuid, public.ct_m0() + 14, null);
select (count(*) = 2 and (array_agg(version order by ordinality))[1] = 2 and bool_and(created_by_email = 'sa-ct-1@example.com') and bool_and(organization_name = 'Org A contratos'))::int as deberia_ser_1
from core.list_customer_contracts_for_superadmin('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', 50) with ordinality as t;
rollback;

\echo 'E2. aislamiento: el historial de la organizacion B no trae los contratos de A -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null);
select count(*) as deberia_ser_0 from core.list_customer_contracts_for_superadmin('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5001', 50);
rollback;

\echo 'E3. el owner de la organizacion (no superadmin) pide el historial de su propia organizacion -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5102', true);
select count(*) as deberia_ser_0 from core.list_customer_contracts_for_superadmin('00000000-0000-0000-0000-0000000e5102', '00000000-0000-0000-0000-0000000e5000', 50);
rollback;

\echo 'E4. caller-binding en la lectura: p_caller_id de un superadmin pero auth.uid() de OTRO usuario -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5102', true);
select count(*) as deberia_ser_0 from core.list_customer_contracts_for_superadmin('00000000-0000-0000-0000-0000000e5100', null, 50);
rollback;

\echo 'E5. anon no puede ejecutar el historial -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.list_customer_contracts_for_superadmin('00000000-0000-0000-0000-0000000e5100', null, 50);
rollback;

\echo 'E6. el rol finanzas (solo lectura) SI puede leer el historial -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select public.ct_crear('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', public.ct_m0() - 90, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5103', true);
select (count(*) = 1)::int as deberia_ser_1 from core.list_customer_contracts_for_superadmin('00000000-0000-0000-0000-0000000e5103', '00000000-0000-0000-0000-0000000e5000', 50);
rollback;

\echo 'E7. insumos de septiembre: 3 sucursales activas (la inactiva no cuenta), 5 minutos de voz (4.5 hacia arriba) y 2 eventos -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select (sucursales_activas = 3 and minutos_voz = 5 and eventos_voz = 2)::int as deberia_ser_1
from core.get_contract_billing_inputs_for_superadmin('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', '2026-09-17');
rollback;

\echo 'E8. insumos de octubre: solo el evento de octubre (7 minutos), no el de septiembre -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select (minutos_voz = 7 and eventos_voz = 1)::int as deberia_ser_1
from core.get_contract_billing_inputs_for_superadmin('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', '2026-10-01');
rollback;

\echo 'E9. organizacion sin eventos de voz: 0 eventos (el API lo trata como minutos NO medidos) y 0 sucursales -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select (sucursales_activas = 0 and minutos_voz = 0 and eventos_voz = 0)::int as deberia_ser_1
from core.get_contract_billing_inputs_for_superadmin('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5001', '2026-09-01');
rollback;

\echo 'E10. organizacion inexistente -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select count(*) as deberia_ser_0 from core.get_contract_billing_inputs_for_superadmin('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5999', '2026-09-01');
rollback;

\echo 'E11. el owner de la organizacion (no superadmin) pide los insumos de su organizacion -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5102', true);
select count(*) as deberia_ser_0 from core.get_contract_billing_inputs_for_superadmin('00000000-0000-0000-0000-0000000e5102', '00000000-0000-0000-0000-0000000e5000', '2026-09-01');
rollback;

\echo 'E12. anon no puede ejecutar los insumos -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_contract_billing_inputs_for_superadmin('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', '2026-09-01');
rollback;

\echo 'F1. authenticated no puede leer la tabla directo (sin GRANT) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
select count(*) as should_fail from core.customer_contract_version;
rollback;

\echo 'F2. authenticated no puede insertar directo (se salta las funciones) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5100', true);
insert into core.customer_contract_version (id, contract_id, organization_id, version, vigente_desde, base_centavos, por_sucursal_centavos, sucursales_incluidas, bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by)
values ('00000000-0000-0000-0000-0000000e5f00', '00000000-0000-0000-0000-0000000e5f00', '00000000-0000-0000-0000-0000000e5000', 1, current_date, 1, 1, 0, 0, 0, 0, 0, 0, 'Insert directo que debe fallar.', '00000000-0000-0000-0000-0000000e5100') returning 1 as should_fail;
rollback;

\echo 'F3. anon no puede leer la tabla -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.customer_contract_version;
rollback;

\echo 'F4. ni authenticated ni anon tienen privilegio alguno sobre la tabla; RLS habilitado'
begin;
select (
  count(*) filter (where has_table_privilege(r, 'core.customer_contract_version', p)) = 0
  and (select relrowsecurity from pg_class where oid = 'core.customer_contract_version'::regclass)
)::int as deberia_ser_1
from unnest(array['anon', 'authenticated']) as r, unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p;
rollback;

\echo 'F5. las funciones nuevas: security definer con search_path fijo; ninguna ejecutable por anon'
begin;
select count(*) as deberia_ser_0
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core'
  and p.proname in ('superadmin_create_contract', 'superadmin_amend_contract', 'list_customer_contracts_for_superadmin',
                    'get_contract_billing_inputs_for_superadmin', 'contract_validate_terms',
                    'customer_contract_version_guard', 'customer_contract_version_block_mutation')
  and (has_function_privilege('anon', p.oid, 'execute')
       or p.proconfig is null
       or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
       or (p.proname in ('superadmin_create_contract', 'superadmin_amend_contract', 'list_customer_contracts_for_superadmin', 'get_contract_billing_inputs_for_superadmin') and not p.prosecdef));
rollback;

\echo 'F6. el ayudante interno de validacion no es ejecutable por authenticated'
begin;
select (not has_function_privilege('authenticated', 'core.contract_validate_terms(text, date, date, bigint, bigint, integer, integer, bigint, bigint, integer, bigint, text)', 'execute'))::int as deberia_ser_1;
rollback;
