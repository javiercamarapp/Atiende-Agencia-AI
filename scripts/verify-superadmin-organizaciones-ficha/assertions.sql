-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0049_superadmin_organizaciones_ficha_onboarding.sql (SA-L-20, SA-07, SA-18):
--
--   A) Caller-binding: solo un superadmin real con su propio uid ve algo; staff normal, uid ajeno, sesion de sistema -> CERO filas;
--      anon no ejecuta nada (sin GRANT).
--   B) Checklist por vertical: organizacion completa 6/6; organizacion vacia con pendientes; despachos (sin fuente de operaciones)
--      -> 'no_se_pudo_medir' con razon, NUNCA 'pendiente'; una fuente ausente (tabla renombrada) tambien -> no_se_pudo_medir.
--   C) Aislamiento entre organizaciones: las operaciones, el menu y el WhatsApp de una organizacion no cuentan en otra.
--   D) Metricas a 30 dias: la ventana excluye lo viejo (operaciones y costo), la 'primera operacion' mira toda la historia.
--   E) Ficha 360: bloques con datos reales, sin nombre/correo de personas, organizacion inexistente -> cero filas.
--   F) Aviso 'organizacion lista': solo sistema, UNA sola vez (marcador persistente), no avisa a quien tiene un paso
--      no_se_pudo_medir/pendiente, no avisa a una organizacion antigua y un uid real no hace nada.
--   G) GRANT y estructura: helpers internos sin EXECUTE para authenticated, marcador sin acceso directo, search_path fijo, sin anon.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback propio; el alias
-- `should_fail` marca un escenario que debe terminar en ERROR; el alias deberia_ser_N exige que la ultima fila valga N; el resto
-- debe completar sin error. Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures (como dueño, sin pasar por las funciones).
--   F1 f2000 restaurantes COMPLETA (6/6)        F2 f2001 citas vacia            F3 f2002 despachos
--   F4 f2003 restaurantes con 3 pedidos y nada mas (ruido para el aislamiento)   F5 f2004 restaurantes COMPLETA pero de hace 90 dias
insert into core.organization (id, vertical, name, slug, status, created_at) values
  ('00000000-0000-0000-0000-0000000f2000', 'restaurantes', 'Org F1 ficha', 'org-of-1', 'active', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000f2001', 'citas', 'Org F2 ficha', 'org-of-2', 'active', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000f2002', 'despachos', 'Org F3 ficha', 'org-of-3', 'active', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000f2003', 'restaurantes', 'Org F4 ficha', 'org-of-4', 'active', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000f2004', 'restaurantes', 'Org F5 ficha', 'org-of-5', 'active', now() - interval '90 days')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f2300', '00000000-0000-0000-0000-0000000f2000', 'restaurantes', 'Sucursal F1', 'active'),
  ('00000000-0000-0000-0000-0000000f2303', '00000000-0000-0000-0000-0000000f2003', 'restaurantes', 'Sucursal F4', 'active'),
  ('00000000-0000-0000-0000-0000000f2304', '00000000-0000-0000-0000-0000000f2004', 'restaurantes', 'Sucursal F5', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f2100', 'sa-of-1@example.com', 'Superadmin OF Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f2101', 'owner-of@example.com', 'Dueño OF Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f2102', 'staff-of@example.com', 'Staff OF Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f2103', 'otro-of@example.com', 'Otro OF Secreto', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f2100') on conflict do nothing;

-- Membresias: F1 y F5 con 2 personas (staff invitado); F2/F3 con 1; F4 con 1.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f2101', '00000000-0000-0000-0000-0000000f2000', null, 'owner', 'staff'),
  ('00000000-0000-0000-0000-0000000f2102', '00000000-0000-0000-0000-0000000f2000', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f2101', '00000000-0000-0000-0000-0000000f2001', null, 'owner', 'staff'),
  ('00000000-0000-0000-0000-0000000f2101', '00000000-0000-0000-0000-0000000f2002', null, 'owner', 'staff'),
  ('00000000-0000-0000-0000-0000000f2101', '00000000-0000-0000-0000-0000000f2003', null, 'owner', 'staff'),
  ('00000000-0000-0000-0000-0000000f2101', '00000000-0000-0000-0000-0000000f2004', null, 'owner', 'staff'),
  ('00000000-0000-0000-0000-0000000f2102', '00000000-0000-0000-0000-0000000f2004', null, 'member', 'staff')
on conflict do nothing;

-- WhatsApp, menu y plan/contrato de F1 y F5.
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values
  ('00000000-0000-0000-0000-0000000f2000', 'pn-of-1'), ('00000000-0000-0000-0000-0000000f2004', 'pn-of-5');
insert into restaurantes.products (organization_id, name, price, is_available) values
  ('00000000-0000-0000-0000-0000000f2000', 'Taco F1', 20, true), ('00000000-0000-0000-0000-0000000f2004', 'Taco F5', 20, true),
  ('00000000-0000-0000-0000-0000000f2003', 'Taco F4 no disponible', 20, false);
insert into core.plan (id, nombre, vertical) values ('plan-of-rest', 'Plan restaurantes OF', 'restaurantes');
insert into core.organization_plan (organization_id, plan_id) values
  ('00000000-0000-0000-0000-0000000f2000', 'plan-of-rest'), ('00000000-0000-0000-0000-0000000f2004', 'plan-of-rest');
insert into core.customer_contract_version (id, contract_id, organization_id, version, vigente_desde, vigente_hasta, base_centavos, por_sucursal_centavos, sucursales_incluidas, bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by) values
  ('00000000-0000-0000-0000-0000000f2500', '00000000-0000-0000-0000-0000000f2500', '00000000-0000-0000-0000-0000000f2000', 1, (now() at time zone 'America/Mexico_City')::date - 30, null, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: contrato vigente de F1 para la ficha.', '00000000-0000-0000-0000-0000000f2100'),
  ('00000000-0000-0000-0000-0000000f2504', '00000000-0000-0000-0000-0000000f2504', '00000000-0000-0000-0000-0000000f2004', 1, (now() at time zone 'America/Mexico_City')::date - 30, null, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: contrato vigente de F5 para la ficha.', '00000000-0000-0000-0000-0000000f2100');

-- Pedidos: F1 uno de hoy y uno de hace 40 dias (+ uno cancelado de hoy que NO cuenta); F4 tres de hoy; F5 uno de hace 80 dias.
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, items, status, created_at) values
  ('00000000-0000-0000-0000-0000000f2000', '00000000-0000-0000-0000-0000000f2300', 'Cliente Secreto', '5550000000', 100, '[]', 'pending', now()),
  ('00000000-0000-0000-0000-0000000f2000', '00000000-0000-0000-0000-0000000f2300', 'Cliente Secreto', '5550000000', 100, '[]', 'entregado', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000f2000', '00000000-0000-0000-0000-0000000f2300', 'Cliente Secreto', '5550000000', 100, '[]', 'cancelado', now()),
  ('00000000-0000-0000-0000-0000000f2003', '00000000-0000-0000-0000-0000000f2303', 'Cliente Secreto', '5550000000', 100, '[]', 'pending', now()),
  ('00000000-0000-0000-0000-0000000f2003', '00000000-0000-0000-0000-0000000f2303', 'Cliente Secreto', '5550000000', 100, '[]', 'pending', now()),
  ('00000000-0000-0000-0000-0000000f2003', '00000000-0000-0000-0000-0000000f2303', 'Cliente Secreto', '5550000000', 100, '[]', 'pending', now()),
  ('00000000-0000-0000-0000-0000000f2004', '00000000-0000-0000-0000-0000000f2304', 'Cliente Secreto', '5550000000', 100, '[]', 'entregado', now() - interval '80 days');

-- Costo de IA: F1 5000 micro-USD hoy y 7000 hace 40 dias; eventos de costo de F1: voz 120 s hoy (900 micro-USD) y uno viejo.
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-0000000f2000', (now() at time zone 'America/Mexico_City')::date, 'restaurantes', 'whatsapp', 'p', 'm', 'interactive', 5000, 3),
  ('00000000-0000-0000-0000-0000000f2000', (now() at time zone 'America/Mexico_City')::date - 40, 'restaurantes', 'whatsapp', 'p', 'm', 'interactive', 7000, 4);
insert into core.usage_cost_event (organization_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000f2000', 'restaurantes', now(), 'voz', 'prov', 'segundo', 120, 900, 'llamada', 'of-1'),
  ('00000000-0000-0000-0000-0000000f2000', 'restaurantes', now() - interval '45 days', 'voz', 'prov', 'minuto', 10, 3000, 'llamada', 'of-2');

-- Dos denegaciones recientes y una antigua en F1 (una permitida que NO cuenta).
insert into core.authz_audit_log (actor_user_id, organization_id, action, route, method, decision, reason, occurred_at) values
  ('00000000-0000-0000-0000-0000000f2102', '00000000-0000-0000-0000-0000000f2000', 'admin:access', '/v1/restaurantes/x/admin/config', 'GET', 'denied', 'insufficient_role', now()),
  ('00000000-0000-0000-0000-0000000f2102', '00000000-0000-0000-0000-0000000f2000', 'admin:access', '/v1/restaurantes/x/admin/config', 'PUT', 'denied', 'insufficient_role', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f2102', '00000000-0000-0000-0000-0000000f2000', 'admin:access', '/v1/restaurantes/x/admin/vieja', 'GET', 'denied', 'no_membership', now() - interval '60 days'),
  ('00000000-0000-0000-0000-0000000f2102', '00000000-0000-0000-0000-0000000f2000', 'admin:access', '/v1/restaurantes/x/admin/ok', 'GET', 'allowed', null, now());

-- Una sesion reciente del staff de F1 (ultimo acceso).
insert into core.staff_session (id, staff_user_id, expires_at) values
  ('00000000-0000-0000-0000-0000000f2900', '00000000-0000-0000-0000-0000000f2102', now() + interval '7 days');

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Caller-binding
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'A1. superadmin real: el checklist de F1 trae 6 pasos -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (count(*) = 6)::int as deberia_ser_1 from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000');
rollback;

\echo 'A2. staff normal (no superadmin) con su propio uid: cero filas en las 4 funciones -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2101', true);
select ((select count(*) from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2101', '00000000-0000-0000-0000-0000000f2000'))
      + (select count(*) from core.get_orgs_onboarding_resumen_for_superadmin('00000000-0000-0000-0000-0000000f2101'))
      + (select count(*) from core.get_orgs_metricas_for_superadmin('00000000-0000-0000-0000-0000000f2101', (now() at time zone 'America/Mexico_City')::date))
      + (select count(*) from core.get_org_ficha_for_superadmin('00000000-0000-0000-0000-0000000f2101', '00000000-0000-0000-0000-0000000f2000', (now() at time zone 'America/Mexico_City')::date)) = 0)::int as deberia_ser_1;
rollback;

\echo 'A3. caller-binding falso (uid del superadmin pasado por otro staff): cero filas -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2101', true);
select ((select count(*) from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000'))
      + (select count(*) from core.get_org_ficha_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000', (now() at time zone 'America/Mexico_City')::date)) = 0)::int as deberia_ser_1;
rollback;

\echo 'A4. sesion de sistema (uid nulo) llamando como superadmin: cero filas -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((select count(*) from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000'))
      + (select count(*) from core.get_orgs_metricas_for_superadmin('00000000-0000-0000-0000-0000000f2100', (now() at time zone 'America/Mexico_City')::date)) = 0)::int as deberia_ser_1;
rollback;

\echo 'A5. anon no puede ejecutar la ficha -- RECHAZADO'
begin;
set local role anon;
select * from core.get_org_ficha_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000', current_date) as should_fail;
rollback;

\echo 'A6. anon no puede ejecutar el checklist -- RECHAZADO'
begin;
set local role anon;
select * from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000') as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Checklist por vertical
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'B1. F1 (restaurantes completa): los 6 pasos estan hechos -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (count(*) = 6 and count(*) filter (where estado = 'hecho') = 6) ::int as deberia_ser_1
from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000');
rollback;

\echo 'B2. F2 (citas vacia): whatsapp, catalogo y primera operacion PENDIENTES (se midieron y faltan), staff pendiente (1 membresia) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (count(*) = 6
        and count(*) filter (where estado = 'pendiente' and paso in ('whatsapp', 'catalogo', 'primera_operacion', 'staff_invitado', 'plan_asignado', 'contrato_registrado')) = 6
        and count(*) filter (where estado = 'no_se_pudo_medir') = 0)::int as deberia_ser_1
from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2001');
rollback;

\echo 'B3. F3 (despachos): sin whatsapp ni catalogo; la primera operacion es no_se_pudo_medir con razon sin_fuente (NO pendiente) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (count(*) = 4
        and count(*) filter (where paso in ('whatsapp', 'catalogo')) = 0
        and count(*) filter (where paso = 'primera_operacion' and estado = 'no_se_pudo_medir' and razon = 'sin_fuente') = 1
        and count(*) filter (where estado = 'pendiente' and paso = 'primera_operacion') = 0)::int as deberia_ser_1
from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2002');
rollback;

\echo 'B4. una fuente ausente (tabla de WhatsApp renombrada) sale no_se_pudo_medir con fuente_no_migrada, no pendiente -- OK'
begin;
alter table restaurantes.whatsapp_channel_config rename to whatsapp_channel_config_ausente;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (count(*) filter (where paso = 'whatsapp' and estado = 'no_se_pudo_medir' and razon = 'fuente_no_migrada') = 1
        and count(*) filter (where paso = 'whatsapp' and estado = 'pendiente') = 0)::int as deberia_ser_1
from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2004');
rollback;

\echo 'B5. el resumen x/y de todas las organizaciones: F1 6/6, F2 0/6, F3 0/4 con 1 no medible -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select ((select hechos = 6 and total = 6 and no_medibles = 0 from core.get_orgs_onboarding_resumen_for_superadmin('00000000-0000-0000-0000-0000000f2100') where organization_id = '00000000-0000-0000-0000-0000000f2000')
    and (select hechos = 0 and total = 6 from core.get_orgs_onboarding_resumen_for_superadmin('00000000-0000-0000-0000-0000000f2100') where organization_id = '00000000-0000-0000-0000-0000000f2001')
    and (select hechos = 0 and total = 4 and no_medibles = 1 from core.get_orgs_onboarding_resumen_for_superadmin('00000000-0000-0000-0000-0000000f2100') where organization_id = '00000000-0000-0000-0000-0000000f2002'))::int as deberia_ser_1;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Aislamiento entre organizaciones
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'C1. F4 tiene 3 pedidos pero NO menu disponible ni WhatsApp: no heredan nada de F1; su primera operacion si esta hecha -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (count(*) filter (where paso = 'primera_operacion' and estado = 'hecho') = 1
        and count(*) filter (where paso = 'catalogo' and estado = 'pendiente') = 1
        and count(*) filter (where paso = 'whatsapp' and estado = 'pendiente') = 1)::int as deberia_ser_1
from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2003');
rollback;

\echo 'C2. operaciones a 30 dias: F1 = 1 (el pedido cancelado y el de hace 40 dias no cuentan) y F4 = 3, sin mezclarse -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select ((select operaciones_30d = 1 from core.get_orgs_metricas_for_superadmin('00000000-0000-0000-0000-0000000f2100', (now() at time zone 'America/Mexico_City')::date) where organization_id = '00000000-0000-0000-0000-0000000f2000')
    and (select operaciones_30d = 3 from core.get_orgs_metricas_for_superadmin('00000000-0000-0000-0000-0000000f2100', (now() at time zone 'America/Mexico_City')::date) where organization_id = '00000000-0000-0000-0000-0000000f2003'))::int as deberia_ser_1;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Metricas a 30 dias
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'D1. costo de IA a 30 dias de F1 = 5000 (el de hace 40 dias no entra) y eventos = 900 -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (llm_30d_micro_usd = 5000 and eventos_30d_micro_usd = 900)::int as deberia_ser_1
from core.get_orgs_metricas_for_superadmin('00000000-0000-0000-0000-0000000f2100', (now() at time zone 'America/Mexico_City')::date) where organization_id = '00000000-0000-0000-0000-0000000f2000';
rollback;

\echo 'D2. despachos: operaciones null con razon sin_fuente (no 0) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (operaciones_30d is null and operaciones_razon = 'sin_fuente')::int as deberia_ser_1
from core.get_orgs_metricas_for_superadmin('00000000-0000-0000-0000-0000000f2100', (now() at time zone 'America/Mexico_City')::date) where organization_id = '00000000-0000-0000-0000-0000000f2002';
rollback;

\echo 'D3. F5 (solo un pedido de hace 80 dias): 0 operaciones a 30 dias pero la primera operacion SI esta hecha -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select ((select operaciones_30d = 0 from core.get_orgs_metricas_for_superadmin('00000000-0000-0000-0000-0000000f2100', (now() at time zone 'America/Mexico_City')::date) where organization_id = '00000000-0000-0000-0000-0000000f2004')
    and (select estado = 'hecho' from core.get_org_onboarding_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2004') where paso = 'primera_operacion'))::int as deberia_ser_1;
rollback;

\echo 'D4. un rango invalido (p_hoy nulo) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select * from core.get_orgs_metricas_for_superadmin('00000000-0000-0000-0000-0000000f2100', null) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Ficha 360
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'E1. la ficha de F1 trae uso, costo, membresias, errores, facturacion y onboarding con los datos reales -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select ((ficha #>> '{organizacion,vertical}') = 'restaurantes'
    and (ficha #>> '{uso,operaciones30d,valor}')::int = 1
    and (ficha #>> '{uso,conversaciones30d,valor}')::int = 0
    and (ficha #>> '{uso,minutosVoz30d,valor}')::numeric = 2
    and (ficha #>> '{costo,llm30dMicroUsd}')::bigint = 5000
    and (ficha #>> '{costo,eventos30dMicroUsd}')::bigint = 900
    and (ficha #>> '{costo,eventos30dTotal}')::int = 1
    and jsonb_array_length(ficha #> '{membresias,porRol}') = 2
    and (ficha #>> '{errores,denegaciones30d,valor}')::int = 2
    and jsonb_array_length(ficha #> '{errores,denegaciones30d,ultimas}') = 2
    and (ficha #>> '{errores,outboxMuerto,valor}')::int = 0
    and (ficha #>> '{errores,crons,razon}') = 'sin_fuente_por_organizacion'
    and (ficha #>> '{facturacion,plan,id}') = 'plan-of-rest'
    and (ficha #>> '{facturacion,contrato,version}')::int = 1
    and jsonb_array_length(ficha -> 'onboarding') = 6)::int as deberia_ser_1
from core.get_org_ficha_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000', (now() at time zone 'America/Mexico_City')::date);
rollback;

\echo 'E2. la ficha no contiene nombres, correos, telefonos ni IP de personas -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (ficha::text not like '%Secreto%' and ficha::text not like '%@example.com%' and ficha::text not like '%5550000000%')::int as deberia_ser_1
from core.get_org_ficha_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000', (now() at time zone 'America/Mexico_City')::date);
rollback;

\echo 'E3. el ultimo acceso sale de la sesion mas reciente del staff (sin su nombre) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select ((ficha #>> '{membresias,ultimosAccesos,0,ultimoAcceso}') is not null and (ficha #>> '{membresias,ultimosAccesos,0,rol}') = 'member')::int as deberia_ser_1
from core.get_org_ficha_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000', (now() at time zone 'America/Mexico_City')::date);
rollback;

\echo 'E4. una organizacion inexistente: cero filas (el API responde 404) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select (count(*) = 0)::int as deberia_ser_1
from core.get_org_ficha_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2fff', (now() at time zone 'America/Mexico_City')::date);
rollback;

\echo 'E5. una fuente ausente (authz_audit_log renombrada) no tumba la ficha: ese bloque sale null con razon, el resto sigue -- OK'
begin;
alter table core.authz_audit_log rename to authz_audit_log_ausente;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select ((ficha #>> '{errores,denegaciones30d,valor}') is null and (ficha #>> '{errores,denegaciones30d,razon}') = 'fuente_no_migrada'
    and (ficha #>> '{uso,operaciones30d,valor}')::int = 1)::int as deberia_ser_1
from core.get_org_ficha_for_superadmin('00000000-0000-0000-0000-0000000f2100', '00000000-0000-0000-0000-0000000f2000', (now() at time zone 'America/Mexico_City')::date);
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- F) Aviso 'organizacion lista'
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'F1. el sistema avisa de F1 (completa y reciente): 1 marcador, 1 notificacion al superadmin, y F5 (antigua) se marca SIN notificar -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table _n on commit drop as select core.avisar_organizaciones_listas_for_system() as n;
reset role;
select ((select n from _n) = 1
    and (select count(*) from core.org_onboarding_aviso where organization_id = '00000000-0000-0000-0000-0000000f2000' and notificado) = 1
    and (select count(*) from core.org_onboarding_aviso where organization_id = '00000000-0000-0000-0000-0000000f2004' and not notificado) = 1
    and (select count(*) from core.notification where staff_user_id = '00000000-0000-0000-0000-0000000f2100' and tipo = 'superadmin.organizacion.onboarding_listo') = 1
    and (select enlace from core.notification where staff_user_id = '00000000-0000-0000-0000-0000000f2100' and tipo = 'superadmin.organizacion.onboarding_listo') = '/superadmin/organizaciones/00000000-0000-0000-0000-0000000f2000')::int as deberia_ser_1;
rollback;

\echo 'F2. correr el aviso dos veces NO duplica el marcador ni la notificacion -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table _n1 on commit drop as select core.avisar_organizaciones_listas_for_system() as n;
create temp table _n2 on commit drop as select core.avisar_organizaciones_listas_for_system() as n;
reset role;
select ((select n from _n1) = 1 and (select n from _n2) = 0
    and (select count(distinct dedupe_key) from core.notification where tipo = 'superadmin.organizacion.onboarding_listo') = 1
    and (select count(*) from core.notification where tipo = 'superadmin.organizacion.onboarding_listo') = (select count(*) from core.platform_superadmin))::int as deberia_ser_1;
rollback;

\echo 'F3. las organizaciones con un paso pendiente o no_se_pudo_medir (F2 citas vacia, F3 despachos, F4 sin menu/WhatsApp) NO se marcan ni se avisan -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.avisar_organizaciones_listas_for_system();
reset role;
select (count(*) = 0)::int as deberia_ser_1 from core.org_onboarding_aviso where organization_id in
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f2002', '00000000-0000-0000-0000-0000000f2003');
rollback;

\echo 'F4. un uid real (aunque sea superadmin) no dispara el aviso: devuelve 0 y no escribe nada -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
create temp table _n on commit drop as select core.avisar_organizaciones_listas_for_system() as n;
reset role;
select ((select n from _n) = 0 and (select count(*) from core.org_onboarding_aviso where organization_id in ('00000000-0000-0000-0000-0000000f2000', '00000000-0000-0000-0000-0000000f2004')) = 0)::int as deberia_ser_1;
rollback;

\echo 'F5. el aviso se dispara cuando el ultimo paso se completa: F4 (restaurantes, ya con pedidos) completa su checklist y se avisa UNA vez -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table _antes on commit drop as select core.avisar_organizaciones_listas_for_system() as n;
reset role;
select ((select count(*) from core.org_onboarding_aviso where organization_id = '00000000-0000-0000-0000-0000000f2003') = 0)::int as deberia_ser_1;
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000f2003', 'pn-of-4');
update restaurantes.products set is_available = true where organization_id = '00000000-0000-0000-0000-0000000f2003';
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f2102', '00000000-0000-0000-0000-0000000f2003', null, 'member', 'staff');
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-0000000f2003', 'plan-of-rest');
insert into core.customer_contract_version (id, contract_id, organization_id, version, vigente_desde, vigente_hasta, base_centavos, por_sucursal_centavos, sucursales_incluidas, bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by) values
  ('00000000-0000-0000-0000-0000000f2503', '00000000-0000-0000-0000-0000000f2503', '00000000-0000-0000-0000-0000000f2003', 1, (now() at time zone 'America/Mexico_City')::date - 1, null, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: contrato de F4.', '00000000-0000-0000-0000-0000000f2100');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table _despues on commit drop as select core.avisar_organizaciones_listas_for_system() as n;
create temp table _otra on commit drop as select core.avisar_organizaciones_listas_for_system() as n;
reset role;
select ((select n from _despues) = 1 and (select n from _otra) = 0
    and (select count(*) from core.org_onboarding_aviso where organization_id = '00000000-0000-0000-0000-0000000f2003' and notificado) = 1
    and (select count(*) from core.notification where staff_user_id = '00000000-0000-0000-0000-0000000f2100'
         and enlace = '/superadmin/organizaciones/00000000-0000-0000-0000-0000000f2003' and categoria = 'onboarding' and severidad = 'info') = 1)::int as deberia_ser_1;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- G) GRANT y estructura
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'G1. los helpers internos no son ejecutables por authenticated -- RECHAZADO'
begin;
set local role authenticated;
select * from core.org_onboarding_pasos('00000000-0000-0000-0000-0000000f2000') as should_fail;
rollback;

\echo 'G2. el marcador no se lee directo con authenticated -- RECHAZADO'
begin;
set local role authenticated;
select * from core.org_onboarding_aviso as should_fail;
rollback;

\echo 'G3. el marcador no se escribe directo con authenticated -- RECHAZADO'
begin;
set local role authenticated;
insert into core.org_onboarding_aviso (organization_id) values ('00000000-0000-0000-0000-0000000f2001') returning 1 as should_fail;
rollback;

\echo 'G4. anon no ejecuta el aviso de sistema -- RECHAZADO'
begin;
set local role anon;
select core.avisar_organizaciones_listas_for_system() as should_fail;
rollback;

\echo 'G5. toda funcion definer nueva fija search_path y ninguna es ejecutable por public/anon -- OK'
select (count(*) = 5
        and count(*) filter (where p.proconfig is not null and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 5
        and count(*) filter (where has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')) = 0
        and count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) = 5)::int as deberia_ser_1
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core' and p.prosecdef and p.proname in
  ('get_org_onboarding_for_superadmin', 'get_orgs_onboarding_resumen_for_superadmin', 'get_orgs_metricas_for_superadmin', 'get_org_ficha_for_superadmin', 'avisar_organizaciones_listas_for_system');

\echo 'G6. el marcador tiene RLS habilitada y ningun GRANT para anon/authenticated -- OK'
select (c.relrowsecurity
        and not has_table_privilege('anon', c.oid, 'select, insert, update, delete')
        and not has_table_privilege('authenticated', c.oid, 'select, insert, update, delete'))::int as deberia_ser_1
from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'core' and c.relname = 'org_onboarding_aviso';
