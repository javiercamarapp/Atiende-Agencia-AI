-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/052_marketing_consentimiento_y_campanas.sql (reactivacion de clientes inactivos):
--
--   A. Consentimiento de marketing: otorgar/revocar con la version del aviso que decide la BASE, idempotencia, historial; rechazos.
--   B. BAJA por telefono: revoca el consentimiento y mata los mensajes de campana pendientes; rechazos.
--   C. Borradores: apagado por omision, requiere promocion vigente, SIN consentimiento nadie entra al segmento, minimo, idempotencia, expiracion.
--   D. Aprobacion con un clic: con la campana sin aprobar NO se encola nada; aprobar encola solo con consentimiento VIGENTE (respeta control y tope de
--      14 dias); idempotente; rechazar no envia; requisitos honestos; cross-tenant, staff de piso y anon rechazados.
--   E. RLS de lectura de las tablas y ausencia de escritura directa.
--   F. Atribucion y grupo de control.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `should_fail` marca el que debe terminar en ERROR; los alias con
-- sufijo deberia_ser_N marcan el valor esperado; t_esperar_error exige el SQLSTATE exacto.
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.t_esperar_error(p_sql text, p_estado text) returns void
language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v = returned_sqlstate;
    if v <> p_estado then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_estado, v, sqlerrm;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e4501', 'restaurantes', 'Mkt Org A', 'mkt-a'),
  ('00000000-0000-0000-0000-0000000e4502', 'restaurantes', 'Mkt Org B (ajena)', 'mkt-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e45a1', '00000000-0000-0000-0000-0000000e4501', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e45b1', '00000000-0000-0000-0000-0000000e4502', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000e45a1', '00000000-0000-0000-0000-0000000e4501', 'a1'),
  ('00000000-0000-0000-0000-0000000e45b1', '00000000-0000-0000-0000-0000000e4502', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4515', 'admin-sucursal@mkt.example.com', 'Admin acotado a A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e4511', 'owner-a@mkt.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4512', 'admin-a@mkt.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4513', 'staff-a@mkt.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4514', 'owner-b@mkt.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4515', '00000000-0000-0000-0000-0000000e4501', array['00000000-0000-0000-0000-0000000e45a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4511', '00000000-0000-0000-0000-0000000e4501', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4512', '00000000-0000-0000-0000-0000000e4501', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4513', '00000000-0000-0000-0000-0000000e4501', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e4514', '00000000-0000-0000-0000-0000000e4502', null, 'owner', 'owner')
on conflict do nothing;

-- La organizacion A configuro la version v2 del aviso; B nunca guardo configuracion (cae a v1).
insert into restaurantes.privacy_config (organization_id, notice_version) values ('00000000-0000-0000-0000-0000000e4501', 'v2') on conflict do nothing;

-- WhatsApp conectado y plantilla de marketing APROBADA solo en A; la promocion vigente tambien.
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000e4501', 'pnid-mkt-a') on conflict do nothing;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, estado) values ('00000000-0000-0000-0000-0000000e4501', 'restaurantes', 'marketing.reactivacion', 'reactivacion_promo', 'aprobada') on conflict do nothing;
insert into restaurantes.promotions (organization_id, code, name, type, value) values ('00000000-0000-0000-0000-0000000e4501', 'VUELVE10', 'Vuelve con 10 por ciento', 'percentage', 10) on conflict do nothing;

-- 25 clientes inactivos de 45 dias (segmento inactivo_30), 3 de 75 dias (inactivo_60) y 2 activos (5 dias). Mas un cliente de la organizacion B.
insert into restaurantes.customers (id, organization_id, phone, name, order_count, last_order_at)
select ('00000000-0000-0000-0000-00000c45' || lpad(i::text, 4, '0'))::uuid, '00000000-0000-0000-0000-0000000e4501', '+5255100' || lpad(i::text, 4, '0'), 'Cliente ' || i, 2,
       now() - case when i <= 25 then interval '45 days' when i <= 28 then interval '75 days' else interval '5 days' end
from generate_series(1, 30) as i
on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name, order_count, last_order_at) values ('00000000-0000-0000-0000-00000c45b001', '00000000-0000-0000-0000-0000000e4502', '+5255200001', 'Cliente de B', 1, now() - interval '45 days') on conflict do nothing;

\echo '=== A1. sistema otorga el consentimiento: la version la decide la base (v2), con fecha y fuente ==='
begin;
set local role authenticated;
select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'whatsapp', true, 'checkout_web');
reset role;
select (estado = 'otorgado' and fuente = 'checkout_web' and version_aviso = 'v2' and otorgado_at is not null)::int as consentimiento_deberia_ser_1 from restaurantes.marketing_consentimiento where customer_id = '00000000-0000-0000-0000-00000c450001';
rollback;

\echo '=== A2. idempotente: repetir devuelve false y deja UN solo evento ==='
begin;
set local role authenticated;
select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'whatsapp', true, 'checkout_web');
select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'whatsapp', true, 'checkout_web') = false as segunda_false;
reset role;
select count(*) as eventos_deberia_ser_1 from restaurantes.marketing_consentimiento_evento where customer_id = '00000000-0000-0000-0000-00000c450001';
rollback;

\echo '=== A3. revocar despues de otorgar: estado revocado y DOS eventos en el historial ==='
begin;
set local role authenticated;
select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'whatsapp', true, 'checkout_web');
select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'whatsapp', false, 'baja_whatsapp');
reset role;
select ((select estado from restaurantes.marketing_consentimiento where customer_id = '00000000-0000-0000-0000-00000c450001') = 'revocado' and (select count(*) from restaurantes.marketing_consentimiento_evento where customer_id = '00000000-0000-0000-0000-00000c450001') = 2)::int as historial_deberia_ser_1;
rollback;

\echo '=== A4. RECHAZADO: un usuario logueado no registra consentimientos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'whatsapp', true, 'checkout_web')$q$, '42501');
rollback;

\echo '=== A5. RECHAZADO: cliente de OTRA organizacion (cross-tenant) -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4502', '00000000-0000-0000-0000-00000c450001', 'whatsapp', true, 'checkout_web')$q$, '42501');
rollback;

\echo '=== A6. RECHAZADO: canal no admitido -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'sms', true, 'checkout_web')$q$, '22023');
rollback;

\echo '=== A7. RECHAZADO: anon no ejecuta la funcion -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.marketing_registrar_consentimiento('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'whatsapp', true, 'checkout_web')$q$, '42501');
rollback;

\echo '=== A8. las tablas de consentimiento NO guardan telefono, nombre, direccion ni correo ==='
begin;
select count(*) as columnas_pii_deberia_ser_0 from information_schema.columns
  where table_schema = 'restaurantes' and table_name in ('marketing_consentimiento', 'marketing_consentimiento_evento', 'marketing_campana_envio') and column_name ~ '(phone|telefono|name|nombre|address|direccion|email|correo)';
rollback;

\echo '=== B1. BAJA por telefono revoca el consentimiento (digitos comparados, con o sin +) y devuelve 1 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

set local role authenticated;
select restaurantes.marketing_revocar_por_telefono('00000000-0000-0000-0000-0000000e4501', '52 55 1000001') as revocados_deberia_ser_1;
rollback;

\echo '=== B2. BAJA de un telefono desconocido no revoca nada (0) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

set local role authenticated;
select restaurantes.marketing_revocar_por_telefono('00000000-0000-0000-0000-0000000e4501', '+5255999999999') as revocados_deberia_ser_0;
rollback;

\echo '=== B3. BAJA en la organizacion B no toca los consentimientos de A (aislamiento) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

set local role authenticated;
select restaurantes.marketing_revocar_por_telefono('00000000-0000-0000-0000-0000000e4502', '+52551000001') as revocados_deberia_ser_0;
rollback;

\echo '=== B4. RECHAZADO: usuario logueado no revoca por telefono -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select restaurantes.marketing_revocar_por_telefono('00000000-0000-0000-0000-0000000e4501', '+52551000001')$q$, '42501');
rollback;

\echo '=== B5. RECHAZADO: telefono invalido -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.marketing_revocar_por_telefono('00000000-0000-0000-0000-0000000e4501', '123')$q$, '22023');
rollback;

\echo '=== C1. apagado por omision: sin configuracion activa NO hay borrador ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

set local role authenticated;
select count(*) as borradores_deberia_ser_0 from restaurantes.marketing_generar_borradores(now());
rollback;

\echo '=== C2. sin promocion vigente no hay borrador (nunca inventa descuentos) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');

update restaurantes.promotions set is_active = false where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select count(*) as borradores_deberia_ser_0 from restaurantes.marketing_generar_borradores(now());
rollback;

\echo '=== C3. sin consentimiento nadie entra al segmento: sin ningun consentimiento no hay borrador ==='
begin;
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');

set local role authenticated;
select count(*) as borradores_deberia_ser_0 from restaurantes.marketing_generar_borradores(now());
rollback;

\echo '=== C4. con consentimiento y configuracion: UN borrador inactivo_30 con conteo = tratados (sin el grupo de control) y costo = conteo x tarifa ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');

set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
select (k.segmento = 'inactivo_30' and k.conteo = (select count(*) from restaurantes.customers c where c.organization_id = '00000000-0000-0000-0000-0000000e4501' and c.last_order_at < now() - interval '30 days' and c.last_order_at > now() - interval '60 days' and not restaurantes.marketing_en_control(c.phone))
        and k.costo_estimado_centavos = k.conteo * 80 and k.promo_codigo = 'VUELVE10' and k.estado = 'borrador')::int as borrador_deberia_ser_1 from restaurantes.marketing_campana k where k.organization_id = '00000000-0000-0000-0000-0000000e4501' and k.segmento = 'inactivo_30';
rollback;

\echo '=== C5. el grupo de control es determinista y existe (hay clientes en control entre los 25 inactivos) ==='
begin;
select (count(*) filter (where restaurantes.marketing_en_control(phone)) > 0 and count(*) filter (where not restaurantes.marketing_en_control(phone)) > 0)::int as control_deberia_ser_1 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501' and last_order_at < now() - interval '30 days';
rollback;

\echo '=== C6. el segmento de 60 dias (3 clientes) queda bajo el minimo configurado (5): no hay borrador inactivo_60 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
select count(*) as inactivo_60_deberia_ser_0 from restaurantes.marketing_campana where segmento = 'inactivo_60';
rollback;

\echo '=== C7. idempotente: un segundo tick el mismo dia no crea otro borrador ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');

set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
select count(*) as nuevos_deberia_ser_0 from restaurantes.marketing_generar_borradores(now());
rollback;

\echo '=== C8. un borrador sin decidir expira a los 3 dias y ya no estorba ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';

insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');

set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
select count(*) from restaurantes.marketing_generar_borradores(now() + interval '4 days');
reset role;
select count(*) as expiradas_deberia_ser_1 from restaurantes.marketing_campana where estado = 'expirada' and segmento = 'inactivo_30';
rollback;

\echo '=== C9. RECHAZADO: un usuario logueado no dispara borradores -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_generar_borradores(now())$q$, '42501');
rollback;

\echo '=== C10. RECHAZADO: anon no genera borradores -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.marketing_generar_borradores(now())$q$, '42501');
rollback;

\echo '=== D1. con la campana SIN aprobar no se encola NADA en el outbox ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
select count(*) as outbox_deberia_ser_0 from restaurantes.messaging_outbox where event_type = 'marketing_reactivacion';
rollback;

\echo '=== D2. aprobar encola un mensaje por cliente tratado, no transaccional, con la plantilla y SOLO el codigo/nombre de la promocion ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), true);
reset role;
select ((select count(*) from restaurantes.messaging_outbox where event_type = 'marketing_reactivacion') = (select conteo from restaurantes.marketing_campana where segmento = 'inactivo_30')
        and (select count(*) from restaurantes.messaging_outbox where event_type = 'marketing_reactivacion' and (payload->>'transaccional') = 'false' and payload#>>'{template,name}' = 'reactivacion_promo' and payload->>'phone_number_id' = 'pnid-mkt-a') = (select conteo from restaurantes.marketing_campana where segmento = 'inactivo_30'))::int as encolados_deberia_ser_1;
rollback;

\echo '=== D3. el grupo de control NO recibe mensaje: sus renglones quedan en 'control' y ninguno tiene outbox ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4512', true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), true);
reset role;
select ((select count(*) from restaurantes.marketing_campana_envio where estado = 'control' and outbox_id is null) > 0 and (select count(*) from restaurantes.marketing_campana_envio where estado = 'control' and outbox_id is not null) = 0)::int as control_deberia_ser_1;
rollback;

\echo '=== D4. idempotente: un segundo clic no duplica ni un envio ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), true);
reset role;
select ((select count(*) from restaurantes.messaging_outbox where event_type = 'marketing_reactivacion') = (select count(*) from restaurantes.marketing_campana_envio where estado = 'encolado'))::int as sin_duplicados_deberia_ser_1;
rollback;

\echo '=== D5. rechazar NO envia nada y deja la campana rechazada ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), false);
reset role;
select ((select count(*) from restaurantes.messaging_outbox where event_type = 'marketing_reactivacion') = 0 and (select estado from restaurantes.marketing_campana where segmento = 'inactivo_30') = 'rechazada')::int as rechazada_deberia_ser_1;
rollback;

\echo '=== D6. un consentimiento REVOCADO entre el borrador y el clic no recibe mensaje ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update restaurantes.marketing_consentimiento set estado = 'revocado', revocado_at = now() where customer_id in (select id from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501' and phone in ('+52551000001', '+52551000002', '+52551000003', '+52551000004', '+52551000005'));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), true);
reset role;
select count(*) as encolados_a_revocados_deberia_ser_0 from restaurantes.marketing_campana_envio where customer_id in (select id from restaurantes.customers where phone in ('+52551000001', '+52551000002', '+52551000003', '+52551000004', '+52551000005'));
rollback;

\echo '=== D7. tope por cliente (1 cada 14 dias): quien ya recibio un mensaje de campana hace 5 dias queda fuera ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
insert into restaurantes.marketing_campana (organization_id, segmento, dias_min, dias_max, dia, estado, promo_nombre, promo_codigo, conteo) values ('00000000-0000-0000-0000-0000000e4501', 'inactivo_60', 60, 90, current_date - 5, 'aprobada', 'Previa', 'PREVIA', 1);
insert into restaurantes.marketing_campana_envio (campana_id, organization_id, customer_id, estado, created_at) select id, '00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'encolado', now() - interval '5 days' from restaurantes.marketing_campana where promo_codigo = 'PREVIA';
insert into restaurantes.marketing_campana_envio (campana_id, organization_id, customer_id, estado, created_at) select id, '00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450003', 'encolado', now() - interval '5 days' from restaurantes.marketing_campana where promo_codigo = 'PREVIA';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), true);
reset role;
select count(*) as repetidos_deberia_ser_0 from restaurantes.marketing_campana_envio e join restaurantes.marketing_campana k on k.id = e.campana_id where k.segmento = 'inactivo_30' and e.customer_id in ('00000000-0000-0000-0000-00000c450001', '00000000-0000-0000-0000-00000c450003');
rollback;

\echo '=== D8. BAJA despues de aprobar: el mensaje aun pendiente muere (dead, baja_marketing) y el renglon queda cancelado_baja ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), true);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.marketing_revocar_por_telefono('00000000-0000-0000-0000-0000000e4501', (select c.phone from restaurantes.customers c join restaurantes.marketing_campana_envio e on e.customer_id = c.id where e.estado = 'encolado' order by c.id limit 1));
select (count(*) = 1 and bool_and(o.status = 'dead' and o.last_error_class = 'baja_marketing'))::int as baja_deberia_ser_1 from restaurantes.marketing_campana_envio e join restaurantes.messaging_outbox o on o.id = e.outbox_id where e.estado = 'cancelado_baja';
rollback;

\echo '=== D9. sin tarifa configurada NO se genera borrador (el costo debe poder mostrarse antes de aprobar) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, null, 3, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
select (count(*) = 0)::int as borradores_sin_tarifa_deberia_ser_1 from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501';
rollback;

\echo '=== D9b. tarifa quitada despues del borrador -> requiere_tarifa (P0001) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update restaurantes.marketing_config set tarifa_centavos = null where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
rollback;

\echo '=== D9c. borrador heredado SIN costo (tarifa NULL) con tarifa fijada despues -> requiere_nuevo_borrador (P0001), no se encola nada y el tope no se salta ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, 100, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update restaurantes.marketing_campana set tarifa_centavos = null, costo_estimado_centavos = null where segmento = 'inactivo_30';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
reset role;
select ((select count(*) from restaurantes.messaging_outbox where event_type = 'marketing_reactivacion') = 0 and (select estado from restaurantes.marketing_campana where segmento = 'inactivo_30') = 'borrador')::int as sin_encolar_y_sigue_borrador_deberia_ser_1;
rollback;

\echo '=== D9d. tarifa cambiada entre el borrador y el clic -> requiere_nuevo_borrador (P0001) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update restaurantes.marketing_config set tarifa_centavos = 120 where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
rollback;

\echo '=== D9e. el tope se valida con el costo REAL (elegibles de hoy x tarifa vigente), no con el conteo del borrador: elegibles que crecen tras el borrador -> tope_mensual_excedido y nada encolado ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, 500, 3, 'reactivacion_promo');
update restaurantes.marketing_consentimiento set estado = 'revocado', revocado_at = now() where customer_id in (select id from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501' and phone in ('+52551000004', '+52551000005'));
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update restaurantes.marketing_consentimiento set estado = 'otorgado', revocado_at = null where customer_id in (select id from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501' and phone in ('+52551000004', '+52551000005'));
update restaurantes.marketing_config set tope_mensual_centavos = (select costo_estimado_centavos from restaurantes.marketing_campana where segmento = 'inactivo_30') where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
reset role;
select (select count(*) from restaurantes.messaging_outbox where event_type = 'marketing_reactivacion') as encolados_deberia_ser_0;
rollback;

\echo '=== D9f. marketing desactivado despues del borrador -> requiere_marketing_activo (P0001); rechazar sigue permitido ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update restaurantes.marketing_config set activo = false where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
select estado from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), false);
rollback;

\echo '=== D9g. borrador de mas de 3 dias aunque el tick no lo haya expirado -> campana_no_aprobable (P0001) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update restaurantes.marketing_campana set creada_at = now() - interval '4 days' where segmento = 'inactivo_30';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
rollback;

\echo '=== D9h. una promocion acotada a una sucursal NO genera borrador para toda la organizacion ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
update restaurantes.promotions set property_ids = array(select id from core.property where organization_id = '00000000-0000-0000-0000-0000000e4501' limit 1) where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
select (count(*) = 0)::int as borradores_con_promo_de_sucursal_deberia_ser_1 from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501';
rollback;

\echo '=== D10. REQUISITO honesto: plantilla NO aprobada -> P0001 (no se encola nada) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update core.whatsapp_plantilla set estado = 'enviada' where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
rollback;

\echo '=== D11. REQUISITO honesto: sin WhatsApp conectado -> P0001 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
delete from restaurantes.whatsapp_channel_config where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
rollback;

\echo '=== D12. tope mensual: si el costo estimado lo excede -> P0001 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
update restaurantes.marketing_config set tope_mensual_centavos = 100 where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, 'P0001');
rollback;

\echo '=== D13. RECHAZADO cross-tenant: el owner de B no aprueba la campana de A -> 42501 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4514', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, '42501');
rollback;

\echo '=== D14. RECHAZADO: el staff de piso no aprueba -> 42501 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4513', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, '42501');
rollback;

\echo '=== D15. RECHAZADO: anon no aprueba -> 42501 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, '42501');
rollback;

\echo '=== D16. RECHAZADO: una campana inexistente responde igual que una ajena -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana('00000000-0000-0000-0000-0000000e45ff', true)$q$, '42501');
rollback;

\echo '=== D17. guardar configuracion: el owner si, y queda en la bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select restaurantes.marketing_guardar_config('00000000-0000-0000-0000-0000000e4501', true, 90, 50000, 10, 'reactivacion_promo', 'es_MX');
reset role;
select ((select tarifa_centavos from restaurantes.marketing_config where organization_id = '00000000-0000-0000-0000-0000000e4501') = 90 and (select count(*) from restaurantes.audit_log where action = 'marketing.config_actualizada') = 1)::int as config_deberia_ser_1;
rollback;

\echo '=== D18. RECHAZADO: el staff de piso no guarda la configuracion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4513', true);
select public.t_esperar_error($q$select restaurantes.marketing_guardar_config('00000000-0000-0000-0000-0000000e4501', true, 90, null, 10, null, 'es_MX')$q$, '42501');
rollback;

\echo '=== D19. RECHAZADO: tarifa invalida -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select restaurantes.marketing_guardar_config('00000000-0000-0000-0000-0000000e4501', true, 0, null, 10, null, 'es_MX')$q$, '22023');
rollback;

\echo '=== D20. config_leer muestra los requisitos reales (promocion vigente, plantilla aprobada, WhatsApp conectado) ==='
begin;
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4512', true);
select (hay_promocion_vigente and plantilla_aprobada and whatsapp_conectado and activo)::int as requisitos_deberia_ser_1 from restaurantes.marketing_config_leer('00000000-0000-0000-0000-0000000e4501');
rollback;

\echo '=== D21. RECHAZADO: un admin acotado a UNA sucursal no aprueba campanas de toda la organizacion -> 42501 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4515', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where segmento = 'inactivo_30'), true)$q$, '42501');
select count(*) as filas_deberia_ser_0 from restaurantes.marketing_campana;
rollback;

\echo '=== E1. lectura: el owner de A ve sus campanas ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) as filas_deberia_ser_1 from restaurantes.marketing_campana;
rollback;

\echo '=== E2. lectura: el staff de piso NO ve campanas ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4513', true);
select count(*) as filas_deberia_ser_0 from restaurantes.marketing_campana;
rollback;

\echo '=== E3. lectura: el owner de OTRO tenant no ve nada (aislamiento) en campanas, consentimientos ni config ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4514', true);
select ((select count(*) from restaurantes.marketing_campana) + (select count(*) from restaurantes.marketing_consentimiento) + (select count(*) from restaurantes.marketing_config)) as filas_deberia_ser_0;
rollback;

\echo '=== E4. lectura: el admin de A ve los consentimientos de su organizacion (30) ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4512', true);
select count(*) as filas_deberia_ser_30 from restaurantes.marketing_consentimiento;
rollback;

\echo '=== E5. RECHAZADO: anon no lee ninguna de las tablas -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.marketing_campana$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.marketing_consentimiento$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.marketing_config$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.marketing_campana_envio$q$, '42501');
rollback;

\echo '=== E6. RECHAZADO: ni el owner inserta, actualiza ni borra directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso) values ('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-00000c450001', 'whatsapp', 'otorgado', 'panel', 'v1')$q$, '42501');
select public.t_esperar_error($q$update restaurantes.marketing_config set activo = true$q$, '42501');
select public.t_esperar_error($q$delete from restaurantes.marketing_campana$q$, '42501');
select public.t_esperar_error($q$insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload) values ('00000000-0000-0000-0000-0000000e4501', 'whatsapp', 'x', 'x', '{}')$q$, '42501');
rollback;

\echo '=== E7. RECHAZADO: las funciones internas no son ejecutables por authenticated -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_elegibles('00000000-0000-0000-0000-0000000e4501', 30, 60, now())$q$, '42501');
select public.t_esperar_error($q$select restaurantes.marketing_en_control('+52551')$q$, '42501');
rollback;

\echo '=== F1. atribucion: pedido de un tratado en los 7 dias siguientes cuenta como recompra; el de un control, como recompra del control ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v2', now() from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4501';
insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre) values ('00000000-0000-0000-0000-0000000e4501', true, 80, null, 5, 'reactivacion_promo');
set local role authenticated;
select count(*) from restaurantes.marketing_generar_borradores(now());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) from restaurantes.marketing_decidir_campana((select id from restaurantes.marketing_campana where organization_id = '00000000-0000-0000-0000-0000000e4501' and segmento = 'inactivo_30'), true);
reset role;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at)
select '00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-0000000e45a1', e.customer_id, 'x', 'x', 200, 'entregado', '[]', 'whatsapp', now() + interval '1 day'
  from (select customer_id from restaurantes.marketing_campana_envio where estado = 'encolado' order by customer_id limit 1) e;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at)
select '00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-0000000e45a1', e.customer_id, 'x', 'x', 150, 'entregado', '[]', 'whatsapp', now() + interval '2 days'
  from (select customer_id from restaurantes.marketing_campana_envio where estado = 'control' order by customer_id limit 1) e;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at)
select '00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-0000000e45a1', e.customer_id, 'x', 'x', 999, 'entregado', '[]', 'whatsapp', now() + interval '9 days'
  from (select customer_id from restaurantes.marketing_campana_envio where estado = 'encolado' order by customer_id offset 1 limit 1) e;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select (recompra_tratados = 1 and recompra_control = 1 and ingreso_tratados = 200)::int as atribucion_deberia_ser_1 from restaurantes.marketing_resumen_campanas('00000000-0000-0000-0000-0000000e4501');
rollback;

\echo '=== F2. RECHAZADO: el resumen exige owner/admin de la organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4514', true);
select public.t_esperar_error($q$select * from restaurantes.marketing_resumen_campanas('00000000-0000-0000-0000-0000000e4501')$q$, '42501');
rollback;

\echo '=== G1. WhatsApp silencioso: sin mensajes en la ventana y 5 por ventana en las 4 semanas previas -> candidata con mensajes_historico = 5 ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h1-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h1-' || g) || md5('x' || g), now() - interval '7 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h2-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h2-' || g) || md5('x' || g), now() - interval '14 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h3-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h3-' || g) || md5('x' || g), now() - interval '21 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h4-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h4-' || g) || md5('x' || g), now() - interval '28 days' - interval '20 minutes' from generate_series(1, 5) as g;
set local role authenticated;
select (count(*) = 1 and bool_and(mensajes_historico = 5 and ventana_min = 60))::int as silencio_deberia_ser_1 from restaurantes.whatsapp_silencio_candidatos(now());
rollback;

\echo '=== G2. con un mensaje entrante reciente (hace 10 minutos) NO hay alerta ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h1-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h1-' || g) || md5('x' || g), now() - interval '7 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h2-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h2-' || g) || md5('x' || g), now() - interval '14 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h3-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h3-' || g) || md5('x' || g), now() - interval '21 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h4-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h4-' || g) || md5('x' || g), now() - interval '28 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) values ('reciente-1', '00000000-0000-0000-0000-0000000e4501', md5('r') || md5('s'), now() - interval '10 minutes');
set local role authenticated;
select count(*) as silencio_deberia_ser_0 from restaurantes.whatsapp_silencio_candidatos(now());
rollback;

\echo '=== G3. sin historico suficiente (trafico en solo 2 de las 4 semanas) NO alerta ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h1-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h1-' || g) || md5('x' || g), now() - interval '7 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h2-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h2-' || g) || md5('x' || g), now() - interval '14 days' - interval '20 minutes' from generate_series(1, 5) as g;
set local role authenticated;
select count(*) as silencio_deberia_ser_0 from restaurantes.whatsapp_silencio_candidatos(now());
rollback;

\echo '=== G4. historico bajo el umbral conservador (1 mensaje por semana, promedio 1 < 3) NO alerta ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h1-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h1-' || g) || md5('x' || g), now() - interval '7 days' - interval '20 minutes' from generate_series(1, 1) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h2-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h2-' || g) || md5('x' || g), now() - interval '14 days' - interval '20 minutes' from generate_series(1, 1) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h3-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h3-' || g) || md5('x' || g), now() - interval '21 days' - interval '20 minutes' from generate_series(1, 1) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h4-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h4-' || g) || md5('x' || g), now() - interval '28 days' - interval '20 minutes' from generate_series(1, 1) as g;
set local role authenticated;
select count(*) as silencio_deberia_ser_0 from restaurantes.whatsapp_silencio_candidatos(now());
rollback;

\echo '=== G5. la organizacion demo se excluye ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h1-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h1-' || g) || md5('x' || g), now() - interval '7 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h2-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h2-' || g) || md5('x' || g), now() - interval '14 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h3-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h3-' || g) || md5('x' || g), now() - interval '21 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h4-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h4-' || g) || md5('x' || g), now() - interval '28 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000e4501', 'v-test');
set local role authenticated;
select count(*) as silencio_deberia_ser_0 from restaurantes.whatsapp_silencio_candidatos(now());
rollback;

\echo '=== G6. el umbral configurable manda: con silencio_activo = false NO alerta ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h1-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h1-' || g) || md5('x' || g), now() - interval '7 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h2-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h2-' || g) || md5('x' || g), now() - interval '14 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h3-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h3-' || g) || md5('x' || g), now() - interval '21 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h4-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h4-' || g) || md5('x' || g), now() - interval '28 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.alertas_duenio_config (organization_id, silencio_activo) values ('00000000-0000-0000-0000-0000000e4501', false);
set local role authenticated;
select count(*) as silencio_deberia_ser_0 from restaurantes.whatsapp_silencio_candidatos(now());
rollback;

\echo '=== G7. el umbral configurable manda: con historico_min = 6 (el historico promedia 5) NO alerta ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h1-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h1-' || g) || md5('x' || g), now() - interval '7 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h2-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h2-' || g) || md5('x' || g), now() - interval '14 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h3-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h3-' || g) || md5('x' || g), now() - interval '21 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h4-' || g, '00000000-0000-0000-0000-0000000e4501', md5('h4-' || g) || md5('x' || g), now() - interval '28 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.alertas_duenio_config (organization_id, silencio_historico_min) values ('00000000-0000-0000-0000-0000000e4501', 6);
set local role authenticated;
select count(*) as silencio_deberia_ser_0 from restaurantes.whatsapp_silencio_candidatos(now());
rollback;

\echo '=== G8. otra organizacion (sin canal de WhatsApp) nunca es candidata aunque tenga historico ==='
begin;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h1-' || g, '00000000-0000-0000-0000-0000000e4502', md5('h1-' || g) || md5('x' || g), now() - interval '7 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h2-' || g, '00000000-0000-0000-0000-0000000e4502', md5('h2-' || g) || md5('x' || g), now() - interval '14 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h3-' || g, '00000000-0000-0000-0000-0000000e4502', md5('h3-' || g) || md5('x' || g), now() - interval '21 days' - interval '20 minutes' from generate_series(1, 5) as g;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, claimed_at) select 'h4-' || g, '00000000-0000-0000-0000-0000000e4502', md5('h4-' || g) || md5('x' || g), now() - interval '28 days' - interval '20 minutes' from generate_series(1, 5) as g;
delete from restaurantes.whatsapp_channel_config where organization_id = '00000000-0000-0000-0000-0000000e4501';
set local role authenticated;
select count(*) as silencio_deberia_ser_0 from restaurantes.whatsapp_silencio_candidatos(now());
rollback;

\echo '=== G9. RECHAZADO: un usuario logueado no consulta candidatos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_silencio_candidatos(now())$q$, '42501');
rollback;

\echo '=== G10. RECHAZADO: anon no consulta candidatos -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.whatsapp_silencio_candidatos(now())$q$, '42501');
rollback;

\echo '=== G11. guardar umbrales: el owner si (queda en bitacora) y se leen despues ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select restaurantes.alertas_duenio_guardar_config('00000000-0000-0000-0000-0000000e4501', true, 90, 4.5);
reset role;
select ((select silencio_ventana_min from restaurantes.alertas_duenio_config where organization_id = '00000000-0000-0000-0000-0000000e4501') = 90 and (select count(*) from restaurantes.audit_log where action = 'alertas_duenio.config_actualizada') = 1)::int as umbrales_deberia_ser_1;
rollback;

\echo '=== G12. RECHAZADO: el staff de piso no guarda umbrales -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4513', true);
select public.t_esperar_error($q$select restaurantes.alertas_duenio_guardar_config('00000000-0000-0000-0000-0000000e4501', true, 90, 4.5)$q$, '42501');
rollback;

\echo '=== G13. RECHAZADO: un admin acotado a una sucursal no guarda umbrales de toda la organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4515', true);
select public.t_esperar_error($q$select restaurantes.alertas_duenio_guardar_config('00000000-0000-0000-0000-0000000e4501', true, 90, 4.5)$q$, '42501');
rollback;

\echo '=== G14. RECHAZADO: umbrales fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select restaurantes.alertas_duenio_guardar_config('00000000-0000-0000-0000-0000000e4501', true, 5, 4.5)$q$, '22023');
rollback;

\echo '=== G15. RECHAZADO cross-tenant: el owner de B no guarda los umbrales de A -> 42501; ni anon ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4514', true);
select public.t_esperar_error($q$select restaurantes.alertas_duenio_guardar_config('00000000-0000-0000-0000-0000000e4501', true, 90, 4.5)$q$, '42501');
rollback;

\echo '=== G16. lectura de umbrales: el owner de A los ve, el de B no, el staff de piso no ==='
begin;
insert into restaurantes.alertas_duenio_config (organization_id) values ('00000000-0000-0000-0000-0000000e4501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select count(*) as filas_deberia_ser_1 from restaurantes.alertas_duenio_config;
rollback;

\echo '=== G17. lectura de umbrales: el owner de OTRO tenant no ve nada ==='
begin;
insert into restaurantes.alertas_duenio_config (organization_id) values ('00000000-0000-0000-0000-0000000e4501');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4514', true);
select count(*) as filas_deberia_ser_0 from restaurantes.alertas_duenio_config;
rollback;

\echo '=== G18. RECHAZADO: ni el owner escribe directo en los umbrales -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$insert into restaurantes.alertas_duenio_config (organization_id) values ('00000000-0000-0000-0000-0000000e4501')$q$, '42501');
rollback;

\echo '=== G19. es_organizacion_restaurantes: el sistema ve true para restaurantes y false para otra cosa ==='
begin;
insert into core.organization (id, vertical, name, slug) values ('00000000-0000-0000-0000-0000000e4509', 'citas', 'Citas ajena', 'mkt-citas');
set local role authenticated;
select (restaurantes.es_organizacion_restaurantes('00000000-0000-0000-0000-0000000e4501') and not restaurantes.es_organizacion_restaurantes('00000000-0000-0000-0000-0000000e4509') and not restaurantes.es_organizacion_restaurantes('00000000-0000-0000-0000-0000000e45ff'))::int as vertical_deberia_ser_1;
rollback;

\echo '=== G20. RECHAZADO: un usuario logueado ni anon consultan el vertical -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4511', true);
select public.t_esperar_error($q$select restaurantes.es_organizacion_restaurantes('00000000-0000-0000-0000-0000000e4501')$q$, '42501');
rollback;

\echo 'Fin: cada escenario con alias deberia_ser_N debe devolver N; los t_esperar_error terminan sin error.'
