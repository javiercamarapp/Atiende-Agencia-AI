-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de las migraciones 170, 171 y 172 (ciclo operativo del pedido):
-- aceptar/rechazar con tiempo prometido y motivo, entrega de la sucursal con hora real, tiempos reales vs prometidos, encuesta post-entrega y
-- recordatorios de pedidos sin aceptar.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; los alias con sufijo deberia_ser_N marcan el valor entero esperado
-- (SIEMPRE un solo count(*) o un booleano ::int); un fallo esperado se afirma con public.t_esperar_error(sql, sqlstate), que exige el SQLSTATE exacto.
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
  ('00000000-0000-0000-0000-0000000e7001', 'restaurantes', 'Ciclo Org A', 'ciclo-a'),
  ('00000000-0000-0000-0000-0000000e7002', 'restaurantes', 'Ciclo Org B (ajena)', 'ciclo-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e70a2', '00000000-0000-0000-0000-0000000e7001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e70b1', '00000000-0000-0000-0000-0000000e7002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, slug, organization_id, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e70a1', 'a1', '00000000-0000-0000-0000-0000000e7001', 'America/Merida')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e7011', 'owner-a@ciclo.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e7012', 'encargado-a1@ciclo.example.com', 'Encargado A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e7013', 'cajero-a1@ciclo.example.com', 'Cajero A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e7014', 'chofer-a1@ciclo.example.com', 'Chofer A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e7017', 'owner-b@ciclo.example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000e7018', 'staff-a2@ciclo.example.com', 'Staff A2', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role, perfil_operativo) values
  ('00000000-0000-0000-0000-0000000e7011', '00000000-0000-0000-0000-0000000e7001', null, 'owner', 'owner', null),
  ('00000000-0000-0000-0000-0000000e7012', '00000000-0000-0000-0000-0000000e7001', array['00000000-0000-0000-0000-0000000e70a1']::uuid[], 'member', 'staff', null),
  ('00000000-0000-0000-0000-0000000e7013', '00000000-0000-0000-0000-0000000e7001', array['00000000-0000-0000-0000-0000000e70a1']::uuid[], 'member', 'staff', 'cajero'),
  ('00000000-0000-0000-0000-0000000e7014', '00000000-0000-0000-0000-0000000e7001', array['00000000-0000-0000-0000-0000000e70a1']::uuid[], 'member', 'repartidor', null),
  ('00000000-0000-0000-0000-0000000e7017', '00000000-0000-0000-0000-0000000e7002', null, 'owner', 'owner', null),
  ('00000000-0000-0000-0000-0000000e7018', '00000000-0000-0000-0000-0000000e7001', array['00000000-0000-0000-0000-0000000e70a2']::uuid[], 'member', 'staff', null)
on conflict do nothing;

-- c1..c3 pendientes recien creados; c4 ya preparando; c5 en camino (salio hace 40 min, aceptado hace 45 con 45 prometidos); c6 de la OTRA organizacion;
-- c7 pendiente en la sucursal A2; c8 entregado hace 3 h (candidato de encuesta); c9 pendiente desde hace 25 min (candidato de recordatorio); c10 pendiente de A1.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal, created_at) values
  ('00000000-0000-0000-0000-0000000e70c1', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Uno', '+52 5500000001', 100, 'pending', '[]', 'admin', 'domicilio', now()),
  ('00000000-0000-0000-0000-0000000e70c2', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Dos', '+52 5500000002', 100, 'pending', '[]', 'admin', 'domicilio', now()),
  ('00000000-0000-0000-0000-0000000e70c3', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Tres', '+52 5500000003', 100, 'pending', '[]', 'admin', 'domicilio', now()),
  ('00000000-0000-0000-0000-0000000e70c4', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Cuatro', '+52 5500000004', 100, 'preparando', '[]', 'admin', 'domicilio', now()),
  ('00000000-0000-0000-0000-0000000e70c5', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Cinco', '+52 5500000005', 100, 'en_camino', '[]', 'admin', 'domicilio', now() - interval '60 minutes'),
  ('00000000-0000-0000-0000-0000000e70c6', '00000000-0000-0000-0000-0000000e7002', '00000000-0000-0000-0000-0000000e70b1', 'Cliente Ajeno', '+52 5500000006', 100, 'pending', '[]', 'admin', 'domicilio', now()),
  ('00000000-0000-0000-0000-0000000e70c7', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a2', 'Cliente Siete', '+52 5500000007', 100, 'pending', '[]', 'admin', 'domicilio', now()),
  ('00000000-0000-0000-0000-0000000e70c8', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Ocho', '+52 9991230001', 100, 'entregado', '[]', 'admin', 'domicilio', now() - interval '4 hours'),
  ('00000000-0000-0000-0000-0000000e70c9', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Nueve', '+52 5500000009', 100, 'pending', '[]', 'admin', 'domicilio', now() - interval '25 minutes'),
  ('00000000-0000-0000-0000-0000000e70d0', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Diez', '+52 5500000010', 100, 'pending', '[]', 'admin', 'domicilio', now());
update restaurantes.orders set salio_at = now() - interval '40 minutes', assigned_repartidor_id = '00000000-0000-0000-0000-0000000e7014', aceptado_at = now() - interval '45 minutes', tiempo_prometido_min = 45 where id = '00000000-0000-0000-0000-0000000e70c5';
update restaurantes.orders set delivered_at = now() - interval '3 hours' where id = '00000000-0000-0000-0000-0000000e70c8';


\echo '=== A1. el encargado acepta con 45 min: pasa a preparando y guarda quien, cuando y el tiempo ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 45);
reset role;
select count(*) as aceptado_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c1' and status = 'preparando' and tiempo_prometido_min = 45 and aceptado_por = '00000000-0000-0000-0000-0000000e7012' and aceptado_at is not null and estimated_delivery_at is not null;
rollback;

\echo '=== A2. el cajero tambien acepta (accion 'gestionar') ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7013');
select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 30);
reset role;
select count(*) as cajero_acepta_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c1' and status = 'preparando' and tiempo_prometido_min = 30;
rollback;

\echo '=== A3. idempotente: la segunda llamada es ya_aplicado y conserva el primer tiempo ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 45);
select count(*) as ya_aplicado_deberia_ser_1 from (select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 90) as r) x where x.r ->> 'tiempo_prometido_min' = '45' and x.r ->> 'resultado' = 'ya_aplicado';
rollback;

\echo '=== A4. tiempo fuera de 5 a 240 -> 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 4)$$, '22023');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 241)$$, '22023');
select count(*) as sin_cambio_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c1' and status = 'pending';
rollback;

\echo '=== A5. el chofer no acepta (42501) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7014');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 30)$$, '42501');
select count(*) as chofer_sin_efecto_deberia_ser_0 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c1' and status <> 'pending';
rollback;

\echo '=== A6. staff de OTRA sucursal no acepta un pedido de A1 (42501) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7018');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 30)$$, '42501');
select count(*) as otra_sucursal_deberia_ser_0 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c1' and status <> 'pending';
rollback;

\echo '=== A7. el dueno de otra organizacion no acepta (42501) y un pedido ajeno es P0404 igual que uno inexistente ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7017');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 30)$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7011');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c6', 30)$$, 'P0404');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-000000000001', 30)$$, 'P0404');
select count(*) as ajeno_intacto_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c6' and status = 'pending';
rollback;

\echo '=== A8. sin sesion (sistema) y anon no aceptan (42501) ==='
begin;
select public.t_como('');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 30)$$, '42501');
set local role anon;
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c1', 30)$$, '42501');
reset role;
select count(*) as nadie_acepto_deberia_ser_0 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c1' and status <> 'pending';
rollback;

\echo '=== A9. aceptar un pedido que ya no esta pendiente es P0409 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c4', 30)$$, 'P0409');
select count(*) as conflicto_sin_efecto_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c4' and status = 'preparando' and aceptado_at is null;
rollback;

\echo '=== R1. el encargado rechaza con motivo: cancela, guarda motivo y nota, y el motivo queda en el historial ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c2', 'saturado', 'hay 14 comandas');
reset role;
select count(*) as rechazado_deberia_ser_1 from restaurantes.orders o join restaurantes.order_status_events e on e.order_id = o.id and e.to_status = 'cancelado' and e.motivo = 'rechazo:saturado' where o.id = '00000000-0000-0000-0000-0000000e70c2' and o.status = 'cancelado' and o.rechazo_motivo = 'saturado' and o.rechazo_nota = 'hay 14 comandas' and o.rechazado_at is not null;
rollback;

\echo '=== R2. el cajero no rechaza (accion 'cancelar', 42501) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7013');
select public.t_esperar_error($$select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c2', 'otro', null)$$, '42501');
select count(*) as cajero_sin_efecto_deberia_ser_0 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c2' and status <> 'pending';
rollback;

\echo '=== R3. motivo fuera de la lista y nota de mas de 240 caracteres -> 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c2', 'porque_si', null)$$, '22023');
select public.t_esperar_error($$select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c2', 'otro', repeat('x', 241))$$, '22023');
select public.t_esperar_error($$select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c2', null, null)$$, '22023');
select count(*) as sin_cambio_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c2' and status = 'pending';
rollback;

\echo '=== R4. idempotente y solo un pedido pendiente se rechaza (P0409 si ya esta en cocina) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c2', 'cerrado', null);
select count(*) as ya_aplicado_deberia_ser_1 from (select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c2', 'cerrado', null) as r) x where x.r ->> 'resultado' = 'ya_aplicado';
rollback;

\echo '=== R5. rechazar un pedido en preparacion es P0409 y de otra organizacion P0404 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c4', 'otro', null)$$, 'P0409');
select public.t_esperar_error($$select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c6', 'otro', null)$$, 'P0404');
select count(*) as sin_cancelar_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c4' and status = 'preparando';
rollback;

\echo '=== E1. el encargado marca la entrega con la hora REAL (hace 10 min) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', now() - interval '10 minutes', 120);
reset role;
select count(*) as entregado_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c5' and status = 'entregado' and delivered_at between now() - interval '11 minutes' and now() - interval '9 minutes' and cobrado_monto = 120;
rollback;

\echo '=== E2. sin hora usa ahora; la hora futura o anterior a la salida es 22023 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', now() + interval '2 hours', null)$$, '22023');
select public.t_esperar_error($$select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', now() - interval '5 hours', null)$$, '22023');
select public.t_esperar_error($$select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', null, 100001)$$, '22023');
select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', null, null);
reset role;
select count(*) as entregado_ahora_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e70c5' and status = 'entregado' and delivered_at > now() - interval '1 minute';
rollback;

\echo '=== E3. el cajero y el chofer no marcan entrega de la sucursal (42501); un pedido no en camino es P0409 ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7013');
select public.t_esperar_error($$select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', null, null)$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7014');
select public.t_esperar_error($$select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', null, null)$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c4', null, null)$$, 'P0409');
select count(*) as sin_entregar_deberia_ser_0 from restaurantes.orders where id in ('00000000-0000-0000-0000-0000000e70c4', '00000000-0000-0000-0000-0000000e70c5') and status = 'entregado';
rollback;

\echo '=== E4. idempotente: entregar dos veces es ya_aplicado ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', now() - interval '5 minutes', null);
select count(*) as ya_aplicado_deberia_ser_1 from (select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', null, null) as r) x where x.r ->> 'resultado' = 'ya_aplicado';
rollback;

\echo '=== M1. tiempos reales vs prometidos: 1 entrega con promesa, 1 a tiempo ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', now() - interval '10 minutes', null);
select count(*) as a_tiempo_deberia_ser_1 from (select restaurantes.operacion_tiempos('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now() + interval '1 hour') as r) x where (x.r ->> 'a_tiempo')::int = 1;
rollback;

\echo '=== M2. el conteo de entregas con promesa cuenta solo las aceptadas con tiempo ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_entregar_staff('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c5', now() - interval '10 minutes', null);
select count(*) as con_promesa_deberia_ser_1 from (select restaurantes.operacion_tiempos('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now() + interval '1 hour') as r) x where (x.r ->> 'entregados_con_promesa')::int = 1;
rollback;

\echo '=== M3. rechazos por motivo en los agregados ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_rechazar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c2', 'saturado', null);
select count(*) as saturado_deberia_ser_1 from (select restaurantes.operacion_tiempos('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now() + interval '1 hour') as r) x where ((x.r -> 'rechazos_por_motivo') ->> 'saturado')::int = 1;
rollback;

\echo '=== M4. el chofer, otra sucursal, otra organizacion y un rango de mas de 63 dias no leen los tiempos ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7014');
select public.t_esperar_error($$select restaurantes.operacion_tiempos('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now())$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7018');
select public.t_esperar_error($$select restaurantes.operacion_tiempos('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now())$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7017');
select public.t_esperar_error($$select restaurantes.operacion_tiempos('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now())$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7011');
select public.t_esperar_error($$select restaurantes.operacion_tiempos('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '64 days', now())$$, '22023');
select count(*) as pedidos_distintos_deberia_ser_0 from (select restaurantes.operacion_tiempos('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now() + interval '1 hour') as r) x where (x.r ->> 'pedidos')::int <> (select count(*) from restaurantes.orders where property_id = '00000000-0000-0000-0000-0000000e70a1');
rollback;

\echo '=== S1. la configuracion de encuesta viene APAGADA por omision ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select count(*) as apagada_deberia_ser_0 from restaurantes.encuesta_config_leer('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1') where habilitada;
rollback;

\echo '=== S2. solo owner/admin encienden la encuesta; el staff no (42501); el link debe ser https (23514) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, null)$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7011');
select public.t_esperar_error($$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, 'http://inseguro.example')$$, '23514');
select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, 'https://g.page/r/ejemplo/review');
select count(*) as encendida_deberia_ser_1 from restaurantes.encuesta_config_leer('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1') where habilitada and link_resena = 'https://g.page/r/ejemplo/review';
rollback;

\echo '=== S3. las candidatas son solo de sistema: pedido entregado hace 3 h con la encuesta encendida; el staff no las ve (42501) ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select count(*) as candidata_deberia_ser_1 from restaurantes.encuesta_candidatas(now(), 50) where order_id = '00000000-0000-0000-0000-0000000e70c8' and phone_hash ~ '^[0-9a-f]{64}$' and opt_out = false;
rollback;

\echo '=== S4. un staff con sesion no puede pedir las candidatas ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select * from restaurantes.encuesta_candidatas(now(), 50)$$, '42501');
select count(*) as sin_filas_deberia_ser_0 from restaurantes.encuesta_entrega;
rollback;

\echo '=== S5. sin la encuesta encendida no hay candidatas ==='
begin;
select public.t_como('');
select count(*) as sin_config_deberia_ser_0 from restaurantes.encuesta_candidatas(now(), 50);
rollback;

\echo '=== S6. una sola vez por pedido: reservar dos veces solo deja pasar a la primera ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select count(*) as una_vez_deberia_ser_1 from (select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto') as ok union all select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto')) x where x.ok;
rollback;

\echo '=== S7. reservada, el pedido ya no sale como candidato ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'omitida', 'sin_ventana_ni_plantilla', null);
select count(*) as ya_no_candidata_deberia_ser_0 from restaurantes.encuesta_candidatas(now(), 50) where order_id = '00000000-0000-0000-0000-0000000e70c8';
rollback;

\echo '=== S8. responder 1 a 5 dentro de las 48 h; fuera de rango es 22023 y sin encuesta no hace nada ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto');
select public.t_esperar_error($$select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 6, now())$$, '22023');
select count(*) as otra_huella_sin_efecto from (select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 5, now()) as r) x where x.r ->> 'resultado' = 'sin_encuesta';
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 5, now());
select count(*) as respondida_deberia_ser_1 from restaurantes.encuesta_entrega where order_id = '00000000-0000-0000-0000-0000000e70c8' and estado = 'respondida' and calificacion = 5;
rollback;

\echo '=== S9. responder una segunda vez no cambia la nota ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto');
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2, now());
select count(*) as segunda_deberia_ser_1 from (select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 5, now()) as r) x where x.r ->> 'resultado' = 'sin_encuesta';
rollback;

\echo '=== S10. el comentario opcional se guarda una sola vez y dentro de 30 min ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto');
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 4, now());
select restaurantes.encuesta_comentar('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Todo muy rico', now());
select count(*) as unico_deberia_ser_1 from (select restaurantes.encuesta_comentar('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'otro mas', now()) as r) x where x.r ->> 'resultado' = 'sin_encuesta';
rollback;

\echo '=== S11. el comentario vacio es 22023 y fuera de los 30 min no se guarda ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto');
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 4, now());
select public.t_esperar_error($$select restaurantes.encuesta_comentar('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '   ', now())$$, '22023');
select count(*) as fuera_de_ventana_deberia_ser_1 from (select restaurantes.encuesta_comentar('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tarde', now() + interval '31 minutes') as r) x where x.r ->> 'resultado' = 'sin_encuesta';
rollback;

\echo '=== S12. estado esperado del telefono: calificacion tras enviar, comentario tras calificar, ninguna despues ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto');
select count(*) as espera_nota_deberia_ser_1 from (select restaurantes.encuesta_estado_para('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now()) as e) x where x.e = 'calificacion';
rollback;

\echo '=== S13. tras calificar espera comentario y despues de 31 min ya no espera nada ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto');
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 3, now());
select count(*) as dos_estados_deberia_ser_2 from (select restaurantes.encuesta_estado_para('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now()) as e union all select restaurantes.encuesta_estado_para('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() + interval '31 minutes')) x where x.e in ('comentario', 'ninguna');
rollback;

\echo '=== S14. la baja (opt-out): se registra una vez, la huella invalida es 22023 y el candidato la refleja ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select public.t_esperar_error($$select restaurantes.encuesta_optout_registrar('00000000-0000-0000-0000-0000000e7001', 'no-es-hash')$$, '22023');
select restaurantes.encuesta_optout_registrar('00000000-0000-0000-0000-0000000e7001', encode(sha256(convert_to('9991230001', 'UTF8')), 'hex'));
select count(*) as baja_visible_deberia_ser_1 from restaurantes.encuesta_candidatas(now(), 50) where order_id = '00000000-0000-0000-0000-0000000e70c8' and opt_out;
rollback;

\echo '=== S15. la ventana de 24 h: el ultimo mensaje del cliente sale de la conversacion de WhatsApp ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
insert into restaurantes.whatsapp_conversations (organization_id, phone, property_id, messages) values ('00000000-0000-0000-0000-0000000e7001', '+5219991230001', '00000000-0000-0000-0000-0000000e70a1',
  jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'hola', 'at', to_char((now() at time zone 'utc') - interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
select public.t_como('');
select count(*) as ventana_visible_deberia_ser_1 from restaurantes.encuesta_candidatas(now(), 50) where order_id = '00000000-0000-0000-0000-0000000e70c8' and ultimo_entrante_at > now() - interval '3 hours';
rollback;

\echo '=== S16. las metricas las leen owner/admin/staff de la sucursal; chofer y otra organizacion no (42501) ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto');
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e7001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 5, now());
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.encuesta_metricas('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a2', now() - interval '1 day', now() + interval '1 day')$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7014');
select public.t_esperar_error($$select restaurantes.encuesta_metricas('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now() + interval '1 day')$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7017');
select public.t_esperar_error($$select restaurantes.encuesta_metricas('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now() + interval '1 day')$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select count(*) as respondidas_deberia_ser_1 from (select restaurantes.encuesta_metricas('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', now() - interval '1 day', now() + interval '1 day') as r) x where (x.r ->> 'respondidas')::int = 1;
rollback;

\echo '=== S17. las tablas de encuesta no se escriben directo ni exponen la huella del telefono ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$insert into restaurantes.encuesta_entrega (organization_id, property_id, order_id, phone_hash, estado, omitido_motivo) values ('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'omitida', 'sin_canal')$$, '42501');
select public.t_esperar_error($$select phone_hash from restaurantes.encuesta_entrega$$, '42501');
select public.t_esperar_error($$delete from restaurantes.encuesta_optout$$, '42501');
select count(*) as sin_filas_deberia_ser_0 from restaurantes.encuesta_entrega;
rollback;

\echo '=== S18. otra organizacion no ve las encuestas (RLS) ==='
begin;
insert into restaurantes.encuesta_config (property_id, organization_id, habilitada) values ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', true);
select public.t_como('');
select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'omitida', 'sin_canal', null);
reset role;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7017');
select count(*) as ajena_deberia_ser_0 from restaurantes.encuesta_entrega;
rollback;

\echo '=== S19. ningun rol anon ejecuta las funciones de encuesta ==='
begin;
set local role anon;
select public.t_esperar_error($$select restaurantes.encuesta_config_leer('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1')$$, '42501');
select public.t_esperar_error($$select * from restaurantes.encuesta_candidatas(now(), 5)$$, '42501');
select public.t_esperar_error($$select restaurantes.encuesta_reservar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c8', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'enviada', null, 'texto')$$, '42501');
reset role;
select count(*) as nada_escrito_deberia_ser_0 from restaurantes.encuesta_entrega;
rollback;

\echo '=== S20. la encuesta no guarda telefono, nombre ni direccion ==='
begin;
select count(*) as columnas_pii_deberia_ser_0 from information_schema.columns where table_schema = 'restaurantes' and table_name in ('encuesta_entrega', 'encuesta_optout', 'encuesta_config') and column_name ~ '(phone$|telefono|name|nombre|address|direccion|email)';
rollback;

\echo '=== Q1. el pedido pendiente hace 25 min es candidato con el recordatorio 2 (10/10/3 por omision); los recien creados no ==='
begin;
select public.t_como('');
select count(*) as recordatorio_2_deberia_ser_1 from restaurantes.recordatorios_pedido_candidatos(now()) where order_id = '00000000-0000-0000-0000-0000000e70c9' and numero_recordatorio = 2 and maximo = 3;
rollback;

\echo '=== Q2. los pedidos recien creados no son candidatos ==='
begin;
select public.t_como('');
select count(*) as recien_creados_deberia_ser_0 from restaurantes.recordatorios_pedido_candidatos(now()) where order_id in ('00000000-0000-0000-0000-0000000e70c1', '00000000-0000-0000-0000-0000000e70c2', '00000000-0000-0000-0000-0000000e70c3', '00000000-0000-0000-0000-0000000e70d0');
rollback;

\echo '=== Q3. un pedido ya aceptado deja de ser candidato ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select restaurantes.pedido_aceptar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70c9', 30);
select public.t_como('');
reset role;
select count(*) as aceptado_fuera_deberia_ser_0 from restaurantes.recordatorios_pedido_candidatos(now()) where order_id = '00000000-0000-0000-0000-0000000e70c9';
rollback;

\echo '=== Q4. el numero crece con la edad y se detiene en el maximo ==='
begin;
select public.t_como('');
select count(*) as tope_deberia_ser_1 from restaurantes.recordatorios_pedido_candidatos(now() + interval '3 hours') where order_id = '00000000-0000-0000-0000-0000000e70c9' and numero_recordatorio = 3;
rollback;

\echo '=== Q5. apagado por sucursal no recuerda ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7011');
select restaurantes.recordatorio_pedido_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', false, 10, 10, 3);
select public.t_como('');
reset role;
select count(*) as apagado_deberia_ser_0 from restaurantes.recordatorios_pedido_candidatos(now()) where order_id = '00000000-0000-0000-0000-0000000e70c9';
rollback;

\echo '=== Q6. con N = 5 minutos entra tambien un pedido de hace 7 min ==='
begin;
update restaurantes.orders set created_at = now() - interval '7 minutes' where id = '00000000-0000-0000-0000-0000000e70d0';
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7011');
select restaurantes.recordatorio_pedido_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, 5, 5, 2);
select public.t_como('');
reset role;
select count(*) as n5_deberia_ser_1 from restaurantes.recordatorios_pedido_candidatos(now()) where order_id = '00000000-0000-0000-0000-0000000e70d0' and numero_recordatorio = 1 and maximo = 2;
rollback;

\echo '=== Q7. la configuracion de recordatorios solo la guarda owner/admin y valida rangos ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select restaurantes.recordatorio_pedido_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, 5, 5, 2)$$, '42501');
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7011');
select public.t_esperar_error($$select restaurantes.recordatorio_pedido_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, 2, 5, 2)$$, '22023');
select public.t_esperar_error($$select restaurantes.recordatorio_pedido_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, 5, 121, 2)$$, '22023');
select public.t_esperar_error($$select restaurantes.recordatorio_pedido_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, 5, 5, 7)$$, '22023');
select public.t_esperar_error($$select restaurantes.recordatorio_pedido_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', null, 5, 5, 2)$$, '22023');
select count(*) as fuera_de_omision_deberia_ser_0 from restaurantes.recordatorio_pedido_config_leer('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1') where primero_min <> 10 or repetir_min <> 10 or maximo <> 3 or not habilitado;
rollback;

\echo '=== Q8. los candidatos son solo de sistema (42501 con sesion) y no devuelven telefono ni nombre ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7012');
select public.t_esperar_error($$select * from restaurantes.recordatorios_pedido_candidatos(now())$$, '42501');
select count(*) as columnas_pii_deberia_ser_0 from information_schema.columns where table_schema = 'restaurantes' and table_name = 'recordatorio_pedido_config' and column_name ~ '(phone|telefono|name|nombre|email)';
rollback;

\echo '=== Q9. otra organizacion no lee la configuracion (42501) ni la tabla (RLS) ==='
begin;
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7011');
select restaurantes.recordatorio_pedido_config_guardar('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', true, 5, 5, 2);
set local role authenticated;
select public.t_como('00000000-0000-0000-0000-0000000e7017');
select public.t_esperar_error($$select * from restaurantes.recordatorio_pedido_config_leer('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1')$$, '42501');
select count(*) as ajena_deberia_ser_0 from restaurantes.recordatorio_pedido_config;
rollback;

\echo 'Los escenarios usan alias *_deberia_ser_N (un entero) o public.t_esperar_error con el SQLSTATE exacto; ninguno termina en ERROR a proposito.'
