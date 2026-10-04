-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/063_consentimiento_checkout_aviso_programado.sql:
--
--   A. system_record_order_privacy_consent: la sesion de sistema registra UNA fila por pedido con la version del aviso que decide
--      la BASE (privacy_config.notice_version de la organizacion; 'v1' si no hay fila), idempotente (la segunda llamada devuelve NULL),
--      y la tabla no guarda telefono, nombre, direccion ni correo.
--   B. Rechazos de la funcion: usuario logueado (42501), pedido de OTRA organizacion (42501), pedido inexistente (42501),
--      canal no admitido (22023), anon (42501 por permiso).
--   C. Lectura/escritura de la tabla: owner y admin de la organizacion la ven; staff de piso, otro tenant y anon no; ningun rol
--      inserta, actualiza ni borra directo (42501).
--   D. staff_order_notification / enqueue_staff_order_notification: el evento nuevo order.programado_promovido (sistema y staff de la
--      organizacion, idempotente), los eventos historicos siguen funcionando, un evento invalido falla, staff de OTRA organizacion
--      (42501), pedido de otra organizacion o de otra sucursal (42501), y el CHECK de la tabla rechaza un evento fuera de lista (23514).
--   E. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el que debe terminar en
-- ERROR; los alias con sufijo deberia_ser_N marcan el valor esperado; t_esperar_error exige el SQLSTATE exacto.
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
  ('00000000-0000-0000-0000-0000000e4301', 'restaurantes', 'Consent Org A', 'consent-a'),
  ('00000000-0000-0000-0000-0000000e4302', 'restaurantes', 'Consent Org B (ajena)', 'consent-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e4301', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e43a2', '00000000-0000-0000-0000-0000000e4301', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e43b1', '00000000-0000-0000-0000-0000000e4302', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e4301', 'a1'),
  ('00000000-0000-0000-0000-0000000e43a2', '00000000-0000-0000-0000-0000000e4301', 'a2'),
  ('00000000-0000-0000-0000-0000000e43b1', '00000000-0000-0000-0000-0000000e4302', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4311', 'owner-a@consent.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4312', 'admin-a@consent.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4313', 'staff-a@consent.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4314', 'owner-b@consent.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4311', '00000000-0000-0000-0000-0000000e4301', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4312', '00000000-0000-0000-0000-0000000e4301', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4313', '00000000-0000-0000-0000-0000000e4301', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e4314', '00000000-0000-0000-0000-0000000e4302', null, 'owner', 'owner')
on conflict do nothing;

-- La organizacion A configuro la version v2 del aviso; B nunca guardo configuracion (cae a v1).
insert into restaurantes.privacy_config (organization_id, notice_version) values ('00000000-0000-0000-0000-0000000e4301', 'v2') on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source) values
  ('00000000-0000-0000-0000-0000000e43c1', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', 'Cliente Uno', '+52 5511111111', 100, 'pending', '[]', 'web'),
  ('00000000-0000-0000-0000-0000000e43c3', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a2', 'Cliente Dos', '+52 5522222222', 90, 'pending', '[]', 'web'),
  ('00000000-0000-0000-0000-0000000e43c2', '00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43b1', 'Cliente Ajeno', '+52 5533333333', 80, 'pending', '[]', 'web');

\echo '=== A1. sistema registra el consentimiento de A: la version la decide la base (v2) ==='
begin;
set local role authenticated;
select (restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web') = 'v2')::int as registrado_v2_deberia_ser_1;
rollback;

\echo '=== A2. organizacion sin privacy_config: version por defecto v1 ==='
begin;
set local role authenticated;
select (restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43c2', 'web') = 'v1')::int as registrado_v1_deberia_ser_1;
rollback;

\echo '=== A3. idempotente: la segunda llamada devuelve NULL y queda UNA sola fila ==='
begin;
set local role authenticated;
select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
select (restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web') is null)::int as segunda_null_deberia_ser_1;
reset role;
select count(*) as filas_deberia_ser_1 from restaurantes.order_privacy_consent where order_id = '00000000-0000-0000-0000-0000000e43c1';
rollback;

\echo '=== A4. la fila guarda version, canal y fecha de aceptacion (sin PII) ==='
begin;
set local role authenticated;
select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
reset role;
select (notice_version = 'v2' and channel = 'web' and accepted_at is not null and organization_id = '00000000-0000-0000-0000-0000000e4301')::int as fila_deberia_ser_1 from restaurantes.order_privacy_consent where order_id = '00000000-0000-0000-0000-0000000e43c1';
rollback;

\echo '=== A5. la tabla NO tiene columnas de telefono, nombre, direccion ni correo ==='
begin;
select count(*) as columnas_pii_deberia_ser_0 from information_schema.columns
  where table_schema = 'restaurantes' and table_name = 'order_privacy_consent' and column_name ~ '(phone|telefono|name|nombre|address|direccion|email|correo)';
rollback;

\echo '=== B1. RECHAZADO: un usuario logueado no registra consentimientos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web')$q$, '42501');
rollback;

\echo '=== B2. RECHAZADO: el pedido debe ser de la organizacion declarada (cross-tenant) -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43c1', 'web')$q$, '42501');
rollback;

\echo '=== B3. RECHAZADO: pedido inexistente -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43ff', 'web')$q$, '42501');
rollback;

\echo '=== B4. RECHAZADO: canal no admitido -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'whatsapp')$q$, '22023');
rollback;

\echo '=== B5. RECHAZADO: anon no ejecuta la funcion -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web')$q$, '42501');
rollback;

\echo '=== C1. lectura: el owner de A ve el consentimiento de su pedido ==='
begin;
set local role authenticated;
select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(*) as filas_deberia_ser_1 from restaurantes.order_privacy_consent;
rollback;

\echo '=== C2. lectura: el admin de A tambien lo ve ==='
begin;
set local role authenticated;
select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4312', true);
select count(*) as filas_deberia_ser_1 from restaurantes.order_privacy_consent;
rollback;

\echo '=== C3. lectura: el staff de piso NO lo ve ==='
begin;
set local role authenticated;
select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4313', true);
select count(*) as filas_deberia_ser_0 from restaurantes.order_privacy_consent;
rollback;

\echo '=== C4. lectura: el owner de OTRO tenant no ve nada (aislamiento) ==='
begin;
set local role authenticated;
select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4314', true);
select count(*) as filas_deberia_ser_0 from restaurantes.order_privacy_consent;
rollback;

\echo '=== C5. RECHAZADO: anon no lee la tabla -> 42501 ==='
begin;
set local role authenticated;
select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
reset role;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.order_privacy_consent$q$, '42501');
rollback;

\echo '=== C6. RECHAZADO: ni el owner inserta directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$insert into restaurantes.order_privacy_consent (organization_id, order_id, notice_version, channel) values ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'v1', 'web')$q$, '42501');
rollback;

\echo '=== C7. RECHAZADO: ni actualiza ni borra -> 42501 ==='
begin;
set local role authenticated;
select restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$update restaurantes.order_privacy_consent set notice_version = 'v9'$q$, '42501');
select public.t_esperar_error($q$delete from restaurantes.order_privacy_consent$q$, '42501');
rollback;

\echo '=== C8. RECHAZADO: service_role tampoco escribe directo (solo la funcion) -> 42501 ==='
begin;
set local role service_role;
select public.t_esperar_error($q$insert into restaurantes.order_privacy_consent (organization_id, order_id, notice_version, channel) values ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'v1', 'web')$q$, '42501');
rollback;

\echo '=== D1. sistema avisa order.programado_promovido: una fila, idempotente ==='
begin;
set local role authenticated;
select count(*) as avisos_deberia_ser_1 from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'El pedido programado entro a cocina');
select count(*) as repetido_deberia_ser_1 from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'otro texto');
reset role;
select count(*) as filas_deberia_ser_1 from restaurantes.staff_order_notification where order_id = '00000000-0000-0000-0000-0000000e43c1' and event_type = 'order.programado_promovido';
rollback;

\echo '=== D2. los eventos historicos siguen funcionando (order.created) ==='
begin;
set local role authenticated;
select count(*) as aviso_deberia_ser_1 from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.created', 'Nuevo pedido');
rollback;

\echo '=== D3. el staff de la organizacion tambien puede avisar de un pedido propio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4313', true);
select count(*) as aviso_deberia_ser_1 from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'Entro a cocina');
rollback;

\echo '=== D4. RECHAZADO: un evento fuera de lista falla -> P0001 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.inventado', 'x')$q$, 'P0001');
rollback;

\echo '=== D5. RECHAZADO: staff de OTRA organizacion no avisa en la mia -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4314', true);
select public.t_esperar_error($q$select * from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'x')$q$, '42501');
rollback;

\echo '=== D6. RECHAZADO: el pedido debe ser de la organizacion declarada (cross-tenant) -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c2', 'order.programado_promovido', 'x')$q$, '42501');
rollback;

\echo '=== D7. RECHAZADO: el pedido debe ser de la sucursal declarada -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a2', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'x')$q$, '42501');
rollback;

\echo '=== D8. RECHAZADO: anon no ejecuta el enqueue -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'x')$q$, '42501');
rollback;

\echo '=== D9. RECHAZADO: el CHECK de la tabla rechaza un evento fuera de lista (23514) ==='
begin;
select public.t_esperar_error($q$insert into restaurantes.staff_order_notification (organization_id, property_id, order_id, event_type, message) values ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.inventado', 'x')$q$, '23514');
rollback;

\echo '=== D10. el CHECK admite los 4 eventos reales ==='
begin;
insert into restaurantes.staff_order_notification (organization_id, property_id, order_id, event_type, message) values
  ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.created', 'a'), ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.problema', 'b'),
  ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.assigned_repartidor', 'c'), ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'd');
select count(*) as eventos_deberia_ser_4 from restaurantes.staff_order_notification where order_id = '00000000-0000-0000-0000-0000000e43c1';
rollback;

\echo '=== D11. lectura: el staff de la organizacion ve el aviso nuevo; otro tenant no ==='
begin;
set local role authenticated;
select count(*) from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'Entro a cocina');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4313', true);
select count(*) as propio_deberia_ser_1 from restaurantes.staff_order_notification where event_type = 'order.programado_promovido';
rollback;

\echo '=== D12. lectura: otro tenant no ve el aviso ==='
begin;
set local role authenticated;
select count(*) from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 'order.programado_promovido', 'Entro a cocina');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4314', true);
select count(*) as ajeno_deberia_ser_0 from restaurantes.staff_order_notification;
rollback;

\echo '=== E1. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.system_record_order_privacy_consent(uuid, uuid, text);
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.system_record_order_privacy_consent('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43c1', 'web');
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
