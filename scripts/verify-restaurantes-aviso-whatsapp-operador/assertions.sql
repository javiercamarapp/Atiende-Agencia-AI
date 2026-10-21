-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/091_consentimiento_aviso_whatsapp_operador.sql
-- (panel movil del operador):
--
--   A. registrar_consentimiento_aviso: gestor con alcance registra (otorgado/no otorgado), idempotente por telefono (una sola fila), la tabla
--      guarda solo la huella (sin telefono), vigente = otorgado y no revocado; volver a otorgar tras un NO reactiva.
--   B. Rechazos: chofer, staff de otra sucursal, anon, telefono invalido, via invalida, sucursal de otra organizacion, pedido de otra organizacion.
--   C. Lectura de la tabla: owner/admin/staff de la organizacion la ven; otro tenant, chofer y anon no; ninguna escritura directa.
--   D. revocar_consentimiento_aviso: solo sistema; despues deja de estar vigente.
--   E. enqueue_messaging_outbox_diferido: fija next_attempt_at futuro, el claim no lo entrega antes de tiempo, tope de 10 min (22023), otro tenant (42501).
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

create or replace function public.t_como(p_uid text) returns void
language sql as $$ select set_config('request.jwt.claim.sub', p_uid, true) $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e5801', 'restaurantes', 'Aviso Org A', 'aviso-a'),
  ('00000000-0000-0000-0000-0000000e5802', 'restaurantes', 'Aviso Org B (ajena)', 'aviso-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e58a1', '00000000-0000-0000-0000-0000000e5801', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e58a2', '00000000-0000-0000-0000-0000000e5801', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e58b1', '00000000-0000-0000-0000-0000000e5802', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e5811', 'owner-a@aviso.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5812', 'staff-a1@aviso.example.com', 'Staff A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e5813', 'cajero-a1@aviso.example.com', 'Cajero A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e5814', 'chofer-a1@aviso.example.com', 'Chofer A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e5817', 'owner-b@aviso.example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000e5818', 'staff-a2@aviso.example.com', 'Staff A2', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role, perfil_operativo) values
  ('00000000-0000-0000-0000-0000000e5811', '00000000-0000-0000-0000-0000000e5801', null, 'owner', 'owner', null),
  ('00000000-0000-0000-0000-0000000e5812', '00000000-0000-0000-0000-0000000e5801', array['00000000-0000-0000-0000-0000000e58a1']::uuid[], 'member', 'staff', null),
  ('00000000-0000-0000-0000-0000000e5813', '00000000-0000-0000-0000-0000000e5801', array['00000000-0000-0000-0000-0000000e58a1']::uuid[], 'member', 'staff', 'cajero'),
  ('00000000-0000-0000-0000-0000000e5814', '00000000-0000-0000-0000-0000000e5801', array['00000000-0000-0000-0000-0000000e58a1']::uuid[], 'member', 'repartidor', null),
  ('00000000-0000-0000-0000-0000000e5817', '00000000-0000-0000-0000-0000000e5802', null, 'owner', 'owner', null),
  ('00000000-0000-0000-0000-0000000e5818', '00000000-0000-0000-0000-0000000e5801', array['00000000-0000-0000-0000-0000000e58a2']::uuid[], 'member', 'staff', null)
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal) values
  ('00000000-0000-0000-0000-0000000e58c1', '00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', 'Cliente Uno', '+52 5500000001', 100, 'preparando', '[]', 'admin', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e58c5', '00000000-0000-0000-0000-0000000e5802', '00000000-0000-0000-0000-0000000e58b1', 'Cliente Ajeno', '+52 5500000005', 100, 'preparando', '[]', 'admin', 'domicilio');

\echo '=== A1. el staff registra el consentimiento: queda vigente ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
select restaurantes.consentimiento_aviso_vigente('00000000-0000-0000-0000-0000000e5801', '+529990000001')::int as vigente_deberia_ser_1;
rollback;

\echo '=== A2. un NO explicito se registra y NO es vigente ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', false, 'verbal_llamada', null);
select (not restaurantes.consentimiento_aviso_vigente('00000000-0000-0000-0000-0000000e5801', '+529990000001'))::int as no_vigente_deberia_ser_1;
rollback;

\echo '=== A3. idempotente por telefono: una sola fila ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
reset role;
select count(*) as filas_deberia_ser_1 from restaurantes.whatsapp_aviso_consentimiento where organization_id = '00000000-0000-0000-0000-0000000e5801';
rollback;

\echo '=== A4. quedan quien (usuario) y cuando; la tabla no guarda el telefono ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
reset role;
select (capturado_por = '00000000-0000-0000-0000-0000000e5812' and otorgado_en is not null and telefono_hash ~ '^[0-9a-f]{64}$')::int as fila_deberia_ser_1 from restaurantes.whatsapp_aviso_consentimiento where organization_id = '00000000-0000-0000-0000-0000000e5801';
rollback;

\echo '=== A5. la tabla no tiene columnas de telefono, nombre ni direccion ==='
begin;
select count(*) as columnas_pii_deberia_ser_0 from information_schema.columns where table_schema = 'restaurantes' and table_name = 'whatsapp_aviso_consentimiento' and column_name ~ '(phone|telefono$|name|nombre|address|direccion|email|correo)';
rollback;

\echo '=== A6. volver a otorgar tras un NO reactiva el consentimiento ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', false, 'verbal_llamada', null);
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
select restaurantes.consentimiento_aviso_vigente('00000000-0000-0000-0000-0000000e5801', '+529990000001')::int as vigente_deberia_ser_1;
rollback;

\echo '=== A7. el cajero tambien registra (captura) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5813');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
select restaurantes.consentimiento_aviso_vigente('00000000-0000-0000-0000-0000000e5801', '+529990000001')::int as vigente_deberia_ser_1;
rollback;

\echo '=== A8. con pedido propio de la organizacion ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select (restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', '00000000-0000-0000-0000-0000000e58c1')->>'otorgado' = 'true')::int as ok_deberia_ser_1;
rollback;

\echo '=== A9. otro telefono no esta vigente ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
select (not restaurantes.consentimiento_aviso_vigente('00000000-0000-0000-0000-0000000e5801', '+529990000002'))::int as no_vigente_deberia_ser_1;
rollback;

\echo '=== B1. RECHAZADO: el chofer no registra -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5814');
select public.t_esperar_error($q$select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null)$q$, '42501');
rollback;

\echo '=== B2. RECHAZADO: staff de OTRA sucursal -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5818');
select public.t_esperar_error($q$select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null)$q$, '42501');
rollback;

\echo '=== B3. RECHAZADO: anon -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null)$q$, '42501');
rollback;

\echo '=== B4. RECHAZADO: telefono sin formato internacional -> 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select public.t_esperar_error($q$select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '9990000001', true, 'verbal_llamada', null)$q$, '22023');
rollback;

\echo '=== B5. RECHAZADO: via invalida -> 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select public.t_esperar_error($q$select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'telepatia', null)$q$, '22023');
rollback;

\echo '=== B6. RECHAZADO cross-tenant: sucursal de B con la org A -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select public.t_esperar_error($q$select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58b1', '+529990000001', true, 'verbal_llamada', null)$q$, '42501');
rollback;

\echo '=== B7. RECHAZADO cross-tenant: pedido de B -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select public.t_esperar_error($q$select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', '00000000-0000-0000-0000-0000000e58c5')$q$, '42501');
rollback;

\echo '=== B8. RECHAZADO: owner de B no registra en la org A -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5817');
select public.t_esperar_error($q$select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null)$q$, '42501');
rollback;

\echo '=== B9. RECHAZADO: el chofer no consulta -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5814');
select public.t_esperar_error($q$select restaurantes.consentimiento_aviso_vigente('00000000-0000-0000-0000-0000000e5801', '+529990000001')$q$, '42501');
rollback;

\echo '=== C1. lectura: owner de A ve la fila ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
reset role;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5811');
select count(*) as filas_deberia_ser_1 from restaurantes.whatsapp_aviso_consentimiento;
rollback;

\echo '=== C2. lectura: el staff tambien ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
select count(*) as filas_deberia_ser_1 from restaurantes.whatsapp_aviso_consentimiento;
rollback;

\echo '=== C3. lectura: el owner de OTRO tenant no ve nada ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
reset role;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5817');
select count(*) as filas_deberia_ser_0 from restaurantes.whatsapp_aviso_consentimiento;
rollback;

\echo '=== C4. lectura: el chofer no ve nada ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
reset role;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5814');
select count(*) as filas_deberia_ser_0 from restaurantes.whatsapp_aviso_consentimiento;
rollback;

\echo '=== C5. RECHAZADO: anon no lee -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.whatsapp_aviso_consentimiento$q$, '42501');
rollback;

\echo '=== C6. RECHAZADO: ni el owner inserta directo -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5811');
select public.t_esperar_error($q$insert into restaurantes.whatsapp_aviso_consentimiento (organization_id, telefono_hash, otorgado, via) values ('00000000-0000-0000-0000-0000000e5801', repeat('a', 64), true, 'verbal_llamada')$q$, '42501');
rollback;

\echo '=== C7. RECHAZADO: ni actualiza ni borra -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5811');
select public.t_esperar_error($q$update restaurantes.whatsapp_aviso_consentimiento set otorgado = true$q$, '42501');
select public.t_esperar_error($q$delete from restaurantes.whatsapp_aviso_consentimiento$q$, '42501');
rollback;

\echo '=== D1. la sesion de sistema revoca: deja de ser vigente ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
reset role;
set local role authenticated;
select public.t_como('');
select restaurantes.revocar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '+529990000001');
select (not restaurantes.consentimiento_aviso_vigente('00000000-0000-0000-0000-0000000e5801', '+529990000001'))::int as no_vigente_deberia_ser_1;
rollback;

\echo '=== D2. RECHAZADO: un usuario no revoca -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5811');
select public.t_esperar_error($q$select restaurantes.revocar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '+529990000001')$q$, '42501');
rollback;

\echo '=== D3. revocar un telefono desconocido devuelve falso ==='
begin;
set local role authenticated;
select (not restaurantes.revocar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '+529990000002'))::int as falso_deberia_ser_1;
rollback;

\echo '=== E1. el aviso diferido queda con next_attempt_at futuro ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'k1', '{}', now() + interval '60 seconds');
reset role;
select (next_attempt_at > now() + interval '50 seconds' and status = 'pending')::int as diferido_deberia_ser_1 from restaurantes.messaging_outbox where dedupe_key = 'k1';
rollback;

\echo '=== E2. el claim del despachador NO lo entrega antes de tiempo ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'k1', '{}', now() + interval '60 seconds');
reset role;
set local role authenticated;
select public.t_como('');
select count(*) as reclamados_deberia_ser_0 from restaurantes.claim_messaging_outbox_batch(50) where dedupe_key = 'k1';
rollback;

\echo '=== E3. un aviso con next_attempt_at ya vencido SI se reclama ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'k2', '{}', now());
reset role;
set local role authenticated;
select public.t_como('');
select count(*) as reclamados_deberia_ser_1 from restaurantes.claim_messaging_outbox_batch(50) where dedupe_key = 'k2';
rollback;

\echo '=== E4. RECHAZADO: mas de 10 minutos de aplazamiento -> 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select public.t_esperar_error($q$select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'k1', '{}', now() + interval '11 minutes')$q$, '22023');
rollback;

\echo '=== E5. RECHAZADO cross-tenant: encolar para otra organizacion -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select public.t_esperar_error($q$select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5802', 'whatsapp', 'pedido_entregado', 'k1', '{}', now() + interval '60 seconds')$q$, '42501');
rollback;

\echo '=== E6. RECHAZADO: anon -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'k1', '{}', now() + interval '60 seconds')$q$, '42501');
rollback;

\echo '=== E7. idempotente por llave: encolar dos veces deja una fila ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'k1', '{}', now() + interval '60 seconds');
select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'k1', '{}', now() + interval '60 seconds');
reset role;
select count(*) as filas_deberia_ser_1 from restaurantes.messaging_outbox where dedupe_key = 'k1';
rollback;

\echo '=== A10. el PRIMER consentimiento no se pisa: otro staff lo vuelve a registrar y primer_capturado_por sigue siendo el original ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
reset role;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5813');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
reset role;
select (primer_capturado_por = '00000000-0000-0000-0000-0000000e5812' and capturado_por = '00000000-0000-0000-0000-0000000e5813' and primera_via = 'verbal_llamada' and primer_otorgado_en is not null)::int as primer_deberia_ser_1 from restaurantes.whatsapp_aviso_consentimiento where organization_id = '00000000-0000-0000-0000-0000000e5801';
rollback;

\echo '=== A11. un NO inicial no cuenta como primer consentimiento ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', false, 'verbal_llamada', null);
reset role;
select (primer_otorgado_en is null and primer_capturado_por is null and revocado_por = 'staff')::int as sin_primer_deberia_ser_1 from restaurantes.whatsapp_aviso_consentimiento where organization_id = '00000000-0000-0000-0000-0000000e5801';
rollback;

\echo '=== C8. RECHAZADO: la huella del telefono no es legible para authenticated (grant por columna) -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('{OWNER_A}');
select public.t_esperar_error($q$select telefono_hash from restaurantes.whatsapp_aviso_consentimiento$q$, '42501');
rollback;

\echo '=== D4. una BAJA del sistema NO la reactiva el personal: bloqueado_por_baja y sigue sin ser vigente ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
select public.t_como('');
select restaurantes.revocar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '+529990000001');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select (restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null)->>'bloqueado_por_baja' = 'true' and not restaurantes.consentimiento_aviso_vigente('00000000-0000-0000-0000-0000000e5801', '+529990000001'))::int as bloqueado_deberia_ser_1;
rollback;

\echo '=== D5. el personal tampoco pisa el registro de la BAJA con un NO: revocado_por sigue siendo sistema ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', true, 'verbal_llamada', null);
select public.t_como('');
select restaurantes.revocar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '+529990000001');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5812');
select restaurantes.registrar_consentimiento_aviso('00000000-0000-0000-0000-0000000e5801', '00000000-0000-0000-0000-0000000e58a1', '+529990000001', false, 'verbal_llamada', null);
reset role;
select (revocado_por = 'sistema' and primer_capturado_por = '00000000-0000-0000-0000-0000000e5812')::int as baja_deberia_ser_1 from restaurantes.whatsapp_aviso_consentimiento where organization_id = '00000000-0000-0000-0000-0000000e5801';
rollback;

\echo '=== E8. el chofer encola SOLO el aviso 'entregado' de su pedido entregado ==='
begin;
update restaurantes.orders set status = 'entregado', assigned_repartidor_id = '00000000-0000-0000-0000-0000000e5814' where id = '00000000-0000-0000-0000-0000000e58c1';
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5814');
select (restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'order-status:00000000-0000-0000-0000-0000000e58c1:entregado', '{}', now() + interval '60 seconds') is not null)::int as chofer_deberia_ser_1;
rollback;

\echo '=== E9. RECHAZADO: el chofer no encola otro evento (en_camino) -> 42501 ==='
begin;
update restaurantes.orders set status = 'entregado', assigned_repartidor_id = '00000000-0000-0000-0000-0000000e5814' where id = '00000000-0000-0000-0000-0000000e58c1';
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5814');
select public.t_esperar_error($q$select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_en_camino', 'order-status:00000000-0000-0000-0000-0000000e58c1:en_camino', '{}', now() + interval '60 seconds')$q$, '42501');
rollback;

\echo '=== E10. RECHAZADO: el chofer no encola el 'entregado' de un pedido que NO le toca -> 42501 ==='
begin;
update restaurantes.orders set status = 'entregado' where id = '00000000-0000-0000-0000-0000000e58c1';
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5814');
select public.t_esperar_error($q$select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'order-status:00000000-0000-0000-0000-0000000e58c1:entregado', '{}', now() + interval '60 seconds')$q$, '42501');
rollback;

\echo '=== E11. RECHAZADO: el chofer no encola el 'entregado' si el pedido aun esta en camino -> 42501 ==='
begin;
update restaurantes.orders set status = 'en_camino', assigned_repartidor_id = '00000000-0000-0000-0000-0000000e5814' where id = '00000000-0000-0000-0000-0000000e58c1';
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5814');
select public.t_esperar_error($q$select restaurantes.enqueue_messaging_outbox_diferido('00000000-0000-0000-0000-0000000e5801', 'whatsapp', 'pedido_entregado', 'order-status:00000000-0000-0000-0000-0000000e58c1:entregado', '{}', now() + interval '60 seconds')$q$, '42501');
rollback;
