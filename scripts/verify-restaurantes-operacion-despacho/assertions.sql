-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/090_pedidos_salio_listo_captura_perfil_operativo.sql y 092_despacho_entrega_atomicos.sql
-- (panel movil del operador):
--
--   A. despachar_pedido: despacho feliz (efecto en la fila), doble llamada = un solo evento y ya_aplicado, reasignacion sin tocar salio_at,
--      owner de alcance organizacional.
--   B. Rechazos: cajero (42501), chofer (42501), staff de otra sucursal (42501), sesion de sistema (42501), anon (42501), pedido de otra
--      organizacion (P0404), pedido recoger (P0422), pedido pending (P0409), chofer de otra organizacion (P0404), eta invalida (22023).
--   C. marcar_listo: el cajero SI puede; idempotente; recoger pasa a listo_para_recoger; el chofer no.
--   D. marcar_entrega: solo el chofer asignado; idempotente; ajeno P0404; staff 42501; monto invalido 22023.
--   E. deshacer_entrega: dentro de 60 s; idempotente; fuera de ventana P0410; forzado por encargado; cajero y chofer ajeno P0404; la outbox pendiente
--      se borra y la ya enviada se informa.
--   F. perfil operativo: owner lo guarda, staff no, valor invalido, otro tenant, objetivo no staff; operador_puede por perfil.
--   G. CHECKs de las columnas nuevas.
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
  ('00000000-0000-0000-0000-0000000e5701', 'restaurantes', 'Despacho Org A', 'despacho-a'),
  ('00000000-0000-0000-0000-0000000e5702', 'restaurantes', 'Despacho Org B (ajena)', 'despacho-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e57a1', '00000000-0000-0000-0000-0000000e5701', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e57a2', '00000000-0000-0000-0000-0000000e5701', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e57b1', '00000000-0000-0000-0000-0000000e5702', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e5711', 'owner-a@despacho.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5712', 'encargado-a1@despacho.example.com', 'Encargado A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e5713', 'cajero-a1@despacho.example.com', 'Cajero A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e5714', 'chofer1-a1@despacho.example.com', 'Chofer Uno', 'seed'),
  ('00000000-0000-0000-0000-0000000e5715', 'chofer2-a1@despacho.example.com', 'Chofer Dos', 'seed'),
  ('00000000-0000-0000-0000-0000000e5716', 'chofer-b1@despacho.example.com', 'Chofer B', 'seed'),
  ('00000000-0000-0000-0000-0000000e5717', 'owner-b@despacho.example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000e5718', 'staff-a2@despacho.example.com', 'Staff A2', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role, perfil_operativo) values
  ('00000000-0000-0000-0000-0000000e5711', '00000000-0000-0000-0000-0000000e5701', null, 'owner', 'owner', null),
  ('00000000-0000-0000-0000-0000000e5712', '00000000-0000-0000-0000-0000000e5701', array['00000000-0000-0000-0000-0000000e57a1']::uuid[], 'member', 'staff', null),
  ('00000000-0000-0000-0000-0000000e5713', '00000000-0000-0000-0000-0000000e5701', array['00000000-0000-0000-0000-0000000e57a1']::uuid[], 'member', 'staff', 'cajero'),
  ('00000000-0000-0000-0000-0000000e5714', '00000000-0000-0000-0000-0000000e5701', array['00000000-0000-0000-0000-0000000e57a1']::uuid[], 'member', 'repartidor', null),
  ('00000000-0000-0000-0000-0000000e5715', '00000000-0000-0000-0000-0000000e5701', array['00000000-0000-0000-0000-0000000e57a1']::uuid[], 'member', 'repartidor', null),
  ('00000000-0000-0000-0000-0000000e5716', '00000000-0000-0000-0000-0000000e5702', array['00000000-0000-0000-0000-0000000e57b1']::uuid[], 'member', 'repartidor', null),
  ('00000000-0000-0000-0000-0000000e5717', '00000000-0000-0000-0000-0000000e5702', null, 'owner', 'owner', null),
  ('00000000-0000-0000-0000-0000000e5718', '00000000-0000-0000-0000-0000000e5701', array['00000000-0000-0000-0000-0000000e57a2']::uuid[], 'member', 'staff', null)
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal, assigned_repartidor_id) values
  ('00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'Cliente Uno', '+52 5500000001', 100, 'preparando', '[]', 'admin', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e57c2', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'Cliente Dos', '+52 5500000002', 100, 'preparando', '[]', 'admin', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e57c3', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'Cliente Tres', '+52 5500000003', 100, 'preparando', '[]', 'admin', 'recoger', null),
  ('00000000-0000-0000-0000-0000000e57c4', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'Cliente Cuatro', '+52 5500000004', 100, 'pending', '[]', 'admin', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e57c5', '00000000-0000-0000-0000-0000000e5702', '00000000-0000-0000-0000-0000000e57b1', 'Cliente Ajeno', '+52 5500000005', 100, 'preparando', '[]', 'admin', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e57c6', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'Cliente Seis', '+52 5500000006', 708, 'en_camino', '[]', 'admin', 'domicilio', '00000000-0000-0000-0000-0000000e5714'),
  ('00000000-0000-0000-0000-0000000e57c7', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'Cliente Siete', '+52 5500000007', 100, 'en_camino', '[]', 'admin', 'domicilio', '00000000-0000-0000-0000-0000000e5715'),
  ('00000000-0000-0000-0000-0000000e57c8', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'Cliente Ocho', '+52 5500000008', 100, 'preparando', '[]', 'admin', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e57c9', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'Cliente Nueve', '+52 5500000009', 100, 'preparando', '[]', 'admin', 'recoger', null),
  ('00000000-0000-0000-0000-0000000e57ca', '00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a2', 'Cliente Diez', '+52 5500000010', 100, 'preparando', '[]', 'admin', 'domicilio', null);

\echo '=== A1. el encargado despacha: resultado despachado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select (restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)->>'resultado' = 'despachado')::int as despachado_deberia_ser_1;
rollback;

\echo '=== A2. efecto en la fila: en_camino, chofer, salio_at y ETA posterior ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35);
reset role;
select (status = 'en_camino' and assigned_repartidor_id = '00000000-0000-0000-0000-0000000e5714' and salio_at is not null and estimated_delivery_at > salio_at)::int as fila_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e57c1';
rollback;

\echo '=== A3. doble llamada: ya_aplicado y UN solo evento a en_camino ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35);
select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)->>'resultado' as segunda;
reset role;
select count(*) as eventos_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e57c1' and to_status = 'en_camino';
rollback;

\echo '=== A3b. la segunda llamada responde ya_aplicado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35);
select (restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)->>'resultado' = 'ya_aplicado')::int as ya_aplicado_deberia_ser_1;
rollback;

\echo '=== A4. reasignar a otro chofer no cambia salio_at ni el estado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35);
reset role;
create temp table t_salio as select salio_at as s from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e57c1';
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5715', 35);
reset role;
select (o.salio_at = t.s and o.assigned_repartidor_id = '00000000-0000-0000-0000-0000000e5715' and o.status = 'en_camino')::int as reasignado_deberia_ser_1 from restaurantes.orders o, t_salio t where o.id = '00000000-0000-0000-0000-0000000e57c1';
rollback;

\echo '=== A5. el owner de alcance organizacional tambien despacha ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5711');
select (restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c2', '00000000-0000-0000-0000-0000000e5714', 35)->>'resultado' = 'despachado')::int as owner_deberia_ser_1;
rollback;

\echo '=== A6. RECHAZADO: el chofer solo tiene alcance a A1; un pedido de A2 no se le asigna -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5711');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57ca', '00000000-0000-0000-0000-0000000e5714', 35)$q$, 'P0404');
rollback;

\echo '=== B1. RECHAZADO: el cajero no despacha -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5713');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)$q$, '42501');
rollback;

\echo '=== B2. RECHAZADO: el chofer no despacha -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)$q$, '42501');
rollback;

\echo '=== B3. RECHAZADO: staff acotado a OTRA sucursal -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5718');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)$q$, '42501');
rollback;

\echo '=== B4. RECHAZADO: la sesion de sistema (sin usuario) no despacha -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)$q$, '42501');
rollback;

\echo '=== B5. RECHAZADO: anon no ejecuta -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)$q$, '42501');
rollback;

\echo '=== B6. RECHAZADO cross-tenant: pedido de B pasando la org A -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5711');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c5', '00000000-0000-0000-0000-0000000e5714', 35)$q$, 'P0404');
rollback;

\echo '=== B7. RECHAZADO cross-tenant: owner de B sobre un pedido de A -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5717');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5702', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5716', 35)$q$, 'P0404');
rollback;

\echo '=== B8. RECHAZADO: pedido a recoger no se despacha -> P0422 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c3', '00000000-0000-0000-0000-0000000e5714', 35)$q$, 'P0422');
rollback;

\echo '=== B9. RECHAZADO: pedido pending (aun no preparando) -> P0409 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c4', '00000000-0000-0000-0000-0000000e5714', 35)$q$, 'P0409');
rollback;

\echo '=== B10. RECHAZADO: chofer de OTRA organizacion -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5716', 35)$q$, 'P0404');
rollback;

\echo '=== B11. RECHAZADO: ETA invalida -> 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 4)$q$, '22023');
rollback;

\echo '=== B12. RECHAZADO: un usuario que no es chofer no puede ser asignado (el encargado como chofer) -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5713', 35)$q$, 'P0404');
rollback;

\echo '=== C1. el cajero SI marca listo un domicilio: fija listo_at y no cambia el estado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5713');
select restaurantes.marcar_listo('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c8');
reset role;
select (status = 'preparando' and listo_at is not null)::int as listo_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e57c8';
rollback;

\echo '=== C2. marcar listo dos veces: ya_aplicado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5713');
select restaurantes.marcar_listo('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c8');
select (restaurantes.marcar_listo('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c8')->>'resultado' = 'ya_aplicado')::int as ya_aplicado_deberia_ser_1;
rollback;

\echo '=== C3. un pedido a recoger pasa a listo_para_recoger ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select restaurantes.marcar_listo('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c9');
reset role;
select (status = 'listo_para_recoger' and listo_at is not null)::int as recoger_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e57c9';
rollback;

\echo '=== C4. RECHAZADO: el chofer no marca listo -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select public.t_esperar_error($q$select restaurantes.marcar_listo('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c8')$q$, '42501');
rollback;

\echo '=== C5. RECHAZADO: staff de otra sucursal -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5718');
select public.t_esperar_error($q$select restaurantes.marcar_listo('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c8')$q$, '42501');
rollback;

\echo '=== C6. RECHAZADO cross-tenant: pedido de B con la org A -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5711');
select public.t_esperar_error($q$select restaurantes.marcar_listo('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c5')$q$, 'P0404');
rollback;

\echo '=== D1. el chofer asignado entrega y cobra: estado, fecha y monto ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', 708);
reset role;
select (status = 'entregado' and delivered_at is not null and cobrado_monto = 708)::int as entregado_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e57c6';
rollback;

\echo '=== D2. doble toque: ya_aplicado y UN solo evento a entregado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
reset role;
select count(*) as eventos_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e57c6' and to_status = 'entregado';
rollback;

\echo '=== D2b. la segunda llamada responde ya_aplicado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
select (restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null)->>'resultado' = 'ya_aplicado')::int as ya_aplicado_deberia_ser_1;
rollback;

\echo '=== D3. RECHAZADO: otro chofer no entrega un pedido ajeno -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5715');
select public.t_esperar_error($q$select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null)$q$, 'P0404');
rollback;

\echo '=== D4. RECHAZADO: staff no marca la entrega -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null)$q$, '42501');
rollback;

\echo '=== D5. RECHAZADO: monto cobrado negativo -> 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select public.t_esperar_error($q$select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', -1)$q$, '22023');
rollback;

\echo '=== D6. RECHAZADO: sesion de sistema -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null)$q$, '42501');
rollback;

\echo '=== D7. RECHAZADO cross-tenant: chofer de B -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5716');
select public.t_esperar_error($q$select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null)$q$, '42501');
rollback;

\echo '=== D8. RECHAZADO: un pedido que aun no esta en camino no se entrega -> P0404 (no esta asignado a este chofer) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select public.t_esperar_error($q$select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', null)$q$, 'P0404');
rollback;

\echo '=== E1. el chofer deshace dentro de la ventana: vuelve a en_camino, sin fecha ni cobro ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', 708);
select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false);
reset role;
select (status = 'en_camino' and delivered_at is null and cobrado_monto is null)::int as deshecho_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e57c6';
rollback;

\echo '=== E2. deshacer dos veces: ya_aplicado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false);
select (restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false)->>'resultado' = 'ya_aplicado')::int as ya_aplicado_deberia_ser_1;
rollback;

\echo '=== E3. RECHAZADO: fuera de la ventana de 60 s -> P0410 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
reset role;
update restaurantes.orders set delivered_at = now() - interval '2 minutes' where id = '00000000-0000-0000-0000-0000000e57c6';
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select public.t_esperar_error($q$select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false)$q$, 'P0410');
rollback;

\echo '=== E4. el encargado deshace forzado fuera de la ventana ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
reset role;
update restaurantes.orders set delivered_at = now() - interval '2 minutes' where id = '00000000-0000-0000-0000-0000000e57c6';
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select (restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', true)->>'resultado' = 'deshecho')::int as forzado_deberia_ser_1;
rollback;

\echo '=== E5. RECHAZADO: el cajero no deshace forzado -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5713');
select public.t_esperar_error($q$select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', true)$q$, 'P0404');
rollback;

\echo '=== E6. RECHAZADO: el encargado SIN forzar no deshace una entrega ajena -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false)$q$, 'P0404');
rollback;

\echo '=== E7. RECHAZADO: otro chofer no deshace la entrega ajena -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5715');
select public.t_esperar_error($q$select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false)$q$, 'P0404');
rollback;

\echo '=== E8. el aviso 'entregado' pendiente en la outbox se borra al deshacer ==='
begin;
insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status) values ('00000000-0000-0000-0000-0000000e5701', 'whatsapp', 'pedido_entregado', 'order-status:00000000-0000-0000-0000-0000000e57c6:entregado', '{}', 'pending');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false);
reset role;
select count(*) as avisos_deberia_ser_0 from restaurantes.messaging_outbox where dedupe_key = 'order-status:00000000-0000-0000-0000-0000000e57c6:entregado';
rollback;

\echo '=== E9. si el aviso ya salio, se informa y no se borra ==='
begin;
insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status) values ('00000000-0000-0000-0000-0000000e5701', 'whatsapp', 'pedido_entregado', 'order-status:00000000-0000-0000-0000-0000000e57c6:entregado', '{}', 'sent');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select restaurantes.marcar_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', null);
select (restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false)->>'aviso_ya_enviado' = 'true')::int as ya_enviado_deberia_ser_1;
rollback;

\echo '=== E10. RECHAZADO: sesion de sistema -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false)$q$, '42501');
rollback;

\echo '=== E11. RECHAZADO: anon -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.deshacer_entrega('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c6', false)$q$, '42501');
rollback;

\echo '=== F1. el owner marca a un encargado como cajero ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5711');
select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e5712', 'cajero');
reset role;
select (perfil_operativo = 'cajero')::int as perfil_deberia_ser_1 from core.membership where user_id = '00000000-0000-0000-0000-0000000e5712' and organization_id = '00000000-0000-0000-0000-0000000e5701';
rollback;

\echo '=== F2. un cajero marcado ya no despacha (42501) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5711');
select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e5712', 'cajero');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35)$q$, '42501');
rollback;

\echo '=== F3. RECHAZADO: staff no cambia perfiles -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select public.t_esperar_error($q$select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e5713', 'encargado')$q$, '42501');
rollback;

\echo '=== F4. RECHAZADO: perfil invalido -> 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5711');
select public.t_esperar_error($q$select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e5712', 'jefe')$q$, '22023');
rollback;

\echo '=== F5. RECHAZADO cross-tenant: owner de B sobre la org A -> 42501 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5717');
select public.t_esperar_error($q$select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e5712', 'cajero')$q$, '42501');
rollback;

\echo '=== F6. RECHAZADO: el objetivo debe ser staff (un chofer no) -> P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5711');
select public.t_esperar_error($q$select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e5714', 'cajero')$q$, 'P0404');
rollback;

\echo '=== F7. RECHAZADO: sesion de sistema -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e5712', 'cajero')$q$, '42501');
rollback;

\echo '=== F8. operador_puede: encargado despacha y captura; cajero captura pero no despacha ni cancela ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select (restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'despachar') and restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'cancelar') and restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'capturar'))::int as encargado_deberia_ser_1;
rollback;

\echo '=== F9. operador_puede: el cajero captura y gestiona pero no despacha ni cancela ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5713');
select (restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'capturar') and restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'gestionar') and not restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'despachar') and not restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'cancelar'))::int as cajero_deberia_ser_1;
rollback;

\echo '=== F10. operador_puede: el chofer, otra sucursal y accion desconocida dan falso ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5714');
select (not restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'gestionar') and not restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a2', 'capturar') and not restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'borrar_todo'))::int as falsos_deberia_ser_1;
rollback;

\echo '=== G1. CHECK: canal_captura fuera de lista -> 23514 ==='
begin;
select public.t_esperar_error($q$update restaurantes.orders set canal_captura = 'telepatia' where id = '00000000-0000-0000-0000-0000000e57c1'$q$, '23514');
rollback;

\echo '=== G2. CHECK: paga_con y cobrado_monto negativos -> 23514 ==='
begin;
select public.t_esperar_error($q$update restaurantes.orders set paga_con = -5 where id = '00000000-0000-0000-0000-0000000e57c1'$q$, '23514');
select public.t_esperar_error($q$update restaurantes.orders set cobrado_monto = -5 where id = '00000000-0000-0000-0000-0000000e57c1'$q$, '23514');
rollback;

\echo '=== G3. CHECK: indicaciones_entrega de mas de 240 caracteres -> 23514 ==='
begin;
select public.t_esperar_error($q$update restaurantes.orders set indicaciones_entrega = repeat('x', 241) where id = '00000000-0000-0000-0000-0000000e57c1'$q$, '23514');
rollback;

\echo '=== G4. las columnas aceptan valores validos ==='
begin;
update restaurantes.orders set canal_captura = 'llamada', paga_con = 1000, cobrado_monto = 708, indicaciones_entrega = 'porton negro', capturado_por = '00000000-0000-0000-0000-0000000e5711' where id = '00000000-0000-0000-0000-0000000e57c1';
select (canal_captura = 'llamada' and capturado_por = '00000000-0000-0000-0000-0000000e5711')::int as columnas_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e57c1';
rollback;

\echo '=== G5. anon no ejecuta ninguna de las funciones nuevas -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.marcar_listo('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c8')$q$, '42501');
select public.t_esperar_error($q$select restaurantes.operador_puede('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57a1', 'capturar')$q$, '42501');
rollback;

\echo '=== A4b. reasignar deja renglon de auditoria en el historial ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5712');
select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5714', 35);
select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57c1', '00000000-0000-0000-0000-0000000e5715', 35);
reset role;
select count(*) as auditoria_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e57c1' and motivo = 'reasignado:00000000-0000-0000-0000-0000000e5715';
rollback;

\echo '=== B13. RECHAZADO: quien no es gestor de la organizacion recibe 42501 aun con un pedido inexistente (no se filtra la existencia) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e5716');
select public.t_esperar_error($q$select restaurantes.despachar_pedido('00000000-0000-0000-0000-0000000e5701', '00000000-0000-0000-0000-0000000e57ff', '00000000-0000-0000-0000-0000000e5714', 35)$q$, '42501');
rollback;
