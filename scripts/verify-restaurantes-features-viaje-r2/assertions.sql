-- QA restaurantes ronda 2, lote features-y-viaje -- escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/077_features_viaje_r2_dia_negocio_cierre_handoff.sql.
--
--   N. nearest_branch_by_colonia (R2-features-08): una colonia de menos de 3 letras no asigna sucursal; las reales si.
--   D. dia de negocio y agotados (R2-features-03): la cola de un turno 12:00-01:00 es del dia anterior; no se repone a las 00:00; alcance y anon.
--   T. ticket impreso y aceptacion sin POS (R2-features-05): alcance por sucursal, cross-tenant, anon, idempotencia, bandera apagada.
--   R. no_recogido sin hora de recogida (R2-viaje-05).
--   E. historial de estados con orden estricto dentro de una transaccion (R2-features-06).
--   C. cierre del dia (R2-viaje-02/04): tiempos de entregado + completado; por_aprobar no es venta.
--   H. tomas PENDIENTES sin tomar (R2-viaje-06): una sola vez, solo sistema.
--   K. codigo de compensacion vigente por cliente (R2-features-07): solo sistema, por telefono y organizacion, un solo uso.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;` y termina en "success" solo si TODAS sus afirmaciones
-- (t_afirmar, ver abajo) se cumplen; t_esperar_error exige el SQLSTATE exacto.
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

-- El gate (run-gate.mjs) solo valida el PRIMER alias *_deberia_ser_N de un escenario y no ejecuta lo que sigue; aqui cada escenario trae varias
-- afirmaciones, asi que todas usan t_afirmar (lanza si es falsa) y el escenario termina en "success" solo si TODAS se cumplen.
create or replace function public.t_afirmar(p_ok boolean, p_nombre text) returns void
language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'afirmacion fallida: %', p_nombre;
  end if;
end $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e7701', 'restaurantes', 'Features R2 Org A', 'features-r2-a'),
  ('00000000-0000-0000-0000-0000000e7702', 'restaurantes', 'Features R2 Org B (ajena)', 'features-r2-b')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e77a1', '00000000-0000-0000-0000-0000000e7701', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e77a2', '00000000-0000-0000-0000-0000000e7701', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e77b1', '00000000-0000-0000-0000-0000000e7702', 'Sucursal B1')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria, lat, lng) values
  ('00000000-0000-0000-0000-0000000e77a1', '00000000-0000-0000-0000-0000000e7701', 'a1', 'America/Merida', 20.97, -89.62),
  ('00000000-0000-0000-0000-0000000e77a2', '00000000-0000-0000-0000-0000000e7701', 'a2', 'America/Merida', 21.01, -89.58),
  ('00000000-0000-0000-0000-0000000e77b1', '00000000-0000-0000-0000-0000000e7702', 'b1', 'America/Merida', 20.9, -89.5)
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e7711', 'owner-a@features-r2.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e7712', 'staff-a1@features-r2.example.com', 'Staff A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e7713', 'owner-b@features-r2.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e7711', '00000000-0000-0000-0000-0000000e7701', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e7712', '00000000-0000-0000-0000-0000000e7701', array['00000000-0000-0000-0000-0000000e77a1']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e7713', '00000000-0000-0000-0000-0000000e7702', null, 'owner', 'owner')
on conflict do nothing;

-- Horario de PM: todos los dias de 12:00 a 01:00 (cruza la medianoche) en A1.
insert into restaurantes.branch_policy (property_id, organization_id, horario) values
  ('00000000-0000-0000-0000-0000000e77a1', '00000000-0000-0000-0000-0000000e7701', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]'::jsonb)
on conflict do nothing;

insert into restaurantes.known_zone (organization_id, name, lat, lng) values
  ('00000000-0000-0000-0000-0000000e7701', 'Garcia Gineres', 20.99, -89.63),
  ('00000000-0000-0000-0000-0000000e7701', 'Prolongacion Montejo', 21.02, -89.59);

insert into restaurantes.products (id, organization_id, name, price) values
  ('00000000-0000-0000-0000-0000000e77c1', '00000000-0000-0000-0000-0000000e7701', 'Taco de prueba', 50) on conflict do nothing;
insert into restaurantes.branch_products (property_id, product_id, price, is_available) values
  ('00000000-0000-0000-0000-0000000e77a1', '00000000-0000-0000-0000-0000000e77c1', 50, true) on conflict do nothing;

-- Pedidos de la organizacion A.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal, hora_recogida, programado_para) values
  ('00000000-0000-0000-0000-0000000e77d1', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'T1', '5511111111', 100, 'pending', '[]', 'whatsapp', now(), null, 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e77d2', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a2', 'T2', '5522222222', 100, 'pending', '[]', 'whatsapp', now(), null, 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e77d3', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'T3', '5533333333', 100, 'preparando', '[]', 'whatsapp', now(), null, 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e77d4', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'R-web', '5544444441', 150, 'listo_para_recoger', '[]', 'web', now() - interval '3 hours', null, 'recoger', null, null),
  ('00000000-0000-0000-0000-0000000e77d5', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'R-wa', '5544444442', 150, 'listo_para_recoger', '[]', 'whatsapp', now() - interval '3 hours', null, 'recoger', now() - interval '2 hours', null);
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal) values
  ('00000000-0000-0000-0000-0000000e77e1', '00000000-0000-0000-0000-0000000e7702', '00000000-0000-0000-0000-0000000e77b1', 'CB', '5599999999', 100, 'pending', '[]', 'web', 'domicilio');

-- La sucursal A1 activa la aceptacion automatica; A2 no.
insert into restaurantes.autopiloto_config (property_id, organization_id, aceptacion_auto) values
  ('00000000-0000-0000-0000-0000000e77a1', '00000000-0000-0000-0000-0000000e7701', true)
on conflict (property_id) do update set aceptacion_auto = true;

\echo '=== N1. colonias de menos de 3 letras no asignan sucursal (a, mo, ab) ==='
begin;
set local role authenticated;
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'a')) = 0, 'colonia_a');
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'mo')) = 0, 'colonia_mo');
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', '   ')) = 0, 'colonia_vacia');
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', null)) = 0, 'colonia_nula');
rollback;

\echo '=== N2. las colonias reales si asignan la sucursal mas cercana ==='
begin;
set local role authenticated;
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'García Ginerés')) = 1, 'colonia_exacta');
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'Colonia Garcia Gineres Norte')) = 1, 'colonia_con_prefijo');
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'gineres')) = 1, 'fragmento_largo');
select public.t_afirmar((select (recognized_zone_name = 'Garcia Gineres')::int from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'Garcia Gineres')) = 1, 'zona_reconocida');
rollback;

\echo '=== N3. cross-tenant: una zona de A no asigna sucursal en B ==='
begin;
set local role authenticated;
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7702', 'Garcia Gineres')) = 0, 'zona_ajena');
rollback;

\echo '=== N4. (056) una zona SIN coordenadas no se usa como punto: cero filas; una zona con coordenadas si; el nombre exacto gana el desempate ==='
begin;
insert into restaurantes.known_zone (organization_id, name, lat, lng) values
  ('00000000-0000-0000-0000-0000000e7701', 'Colonia Sincoordenadas', null, null),
  ('00000000-0000-0000-0000-0000000e7701', 'Centro', 21.0, -89.6),
  ('00000000-0000-0000-0000-0000000e7701', 'Centro Chichi Suarez', 21.05, -89.65);
set local role authenticated;
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'Colonia Sincoordenadas')) = 0, 'zona_sin_coordenadas_no_es_punto');
select public.t_afirmar((select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'Centro Chichi Suarez')) = 1, 'zona_con_coordenadas_si');
select public.t_afirmar((select distance_km is not null from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'Centro Chichi Suarez')), 'zona_con_coordenadas_da_distancia');
select public.t_afirmar((select recognized_zone_name = 'Centro' from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'centro')), 'nombre_exacto_gana_al_mas_largo');
select public.t_afirmar((select recognized_zone_name = 'Centro Chichi Suarez' from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000e7701', 'Centro Chichi Suarez')), 'exacto_largo_gana');
rollback;

\echo '=== D1. dia de negocio: la cola del turno 12:00-01:00 pertenece al dia en que empezo ==='
begin;
select public.t_afirmar((select (restaurantes.dia_negocio_sucursal('00000000-0000-0000-0000-0000000e77a1', timestamptz '2026-10-08 00:10:00-06') = date '2026-10-07')::int) = 1, 'cola_es_dia_anterior');
select public.t_afirmar((select (restaurantes.dia_negocio_sucursal('00000000-0000-0000-0000-0000000e77a1', timestamptz '2026-10-08 00:59:00-06') = date '2026-10-07')::int) = 1, 'un_minuto_antes_del_cierre');
select public.t_afirmar((select (restaurantes.dia_negocio_sucursal('00000000-0000-0000-0000-0000000e77a1', timestamptz '2026-10-08 01:00:00-06') = date '2026-10-08')::int) = 1, 'al_cierre_cambia_el_dia');
select public.t_afirmar((select (restaurantes.dia_negocio_sucursal('00000000-0000-0000-0000-0000000e77a1', timestamptz '2026-10-08 15:00:00-06') = date '2026-10-08')::int) = 1, 'en_pleno_turno');
rollback;

\echo '=== D2. una excepcion por fecha NO mueve el corte (misma regla que 076/cierre): la cola sigue siendo del dia anterior ==='
begin;
insert into restaurantes.branch_hours_exception (organization_id, property_id, fecha_desde, fecha_hasta, horario, motivo)
values ('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', date '2026-10-07', date '2026-10-07', '[]'::jsonb, 'cerrado');
select public.t_afirmar((select (restaurantes.dia_negocio_sucursal('00000000-0000-0000-0000-0000000e77a1', timestamptz '2026-10-08 00:10:00-06') = date '2026-10-07')::int) = 1, 'excepcion_no_mueve_el_corte');
select public.t_afirmar((select (restaurantes.dia_negocio_sucursal('00000000-0000-0000-0000-0000000e77a1', timestamptz '2026-10-08 00:10:00-06') = restaurantes.dia_negocio('00000000-0000-0000-0000-0000000e77a1', timestamptz '2026-10-08 00:10:00-06'))::int) = 1, 'una_sola_regla_de_dia_de_negocio');
rollback;

\echo '=== D3. un horario malformado degrada al dia calendario, nunca rompe ==='
begin;
update restaurantes.branch_policy set horario = '[{"dias":[0,1,2,3,4,5,6],"abre":"basura","cierra":"01:00"}]'::jsonb where property_id = '00000000-0000-0000-0000-0000000e77a1';
select public.t_afirmar((select (restaurantes.dia_negocio_sucursal('00000000-0000-0000-0000-0000000e77a1', timestamptz '2026-10-08 00:10:00-06') = date '2026-10-08')::int) = 1, 'malformado_dia_calendario');
rollback;

\echo '=== D4. agotado hasta el 8-oct: a las 00:10 (en pleno turno) NO se repone ==='
begin;
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-08' where property_id = '00000000-0000-0000-0000-0000000e77a1' and product_id = '00000000-0000-0000-0000-0000000e77c1';
set local role authenticated;
select public.t_afirmar((select count(*) from restaurantes.agotados_reponer(timestamptz '2026-10-08 00:10:00-06')) = 0, 'repuestos_a_las_00_10');
rollback;

\echo '=== D5. agotado hasta el 8-oct: tras el cierre de la 01:00 SI se repone, una sola vez ==='
begin;
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-08' where property_id = '00000000-0000-0000-0000-0000000e77a1' and product_id = '00000000-0000-0000-0000-0000000e77c1';
set local role authenticated;
select public.t_afirmar((select count(*) from restaurantes.agotados_reponer(timestamptz '2026-10-08 01:05:00-06')) = 1, 'repuestos_tras_el_cierre');
select public.t_afirmar((select count(*) from restaurantes.agotados_reponer(timestamptz '2026-10-08 01:10:00-06')) = 0, 'segunda_pasada');
reset role;
select public.t_afirmar((select count(*) from restaurantes.branch_products where property_id = '00000000-0000-0000-0000-0000000e77a1' and product_id = '00000000-0000-0000-0000-0000000e77c1' and is_available and agotado_hasta is null) = 1, 'producto_disponible');
rollback;

\echo '=== D6. agotados_reponer es solo de sistema: un usuario recibe 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
select public.t_esperar_error($q$select * from restaurantes.agotados_reponer(now())$q$, '42501');
rollback;

\echo '=== D7. staff de A1 marca agotado hasta manana (dia de negocio + 1) y una fecha que no es posterior al dia de negocio se rechaza ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7712', true);
select public.t_afirmar((select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', '00000000-0000-0000-0000-0000000e77c1',
  restaurantes.dia_negocio_sucursal_actual('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1') + 1)::int) = 1, 'marca_manana');
select public.t_esperar_error($q$select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', '00000000-0000-0000-0000-0000000e77c1',
  restaurantes.dia_negocio_sucursal_actual('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1'))$q$, '22023');
rollback;

\echo '=== D8. dia_negocio_sucursal_actual: staff con alcance si; staff de A1 pidiendo A2, owner de B y anon -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7712', true);
select public.t_afirmar((select (restaurantes.dia_negocio_sucursal_actual('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1') is not null)::int) = 1, 'staff_con_alcance');
select public.t_esperar_error($q$select restaurantes.dia_negocio_sucursal_actual('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a2')$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7713', true);
select public.t_esperar_error($q$select restaurantes.dia_negocio_sucursal_actual('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1')$q$, '42501');
rollback;
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.dia_negocio_sucursal_actual('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1')$q$, '42501');
rollback;

\echo '=== D9. la funcion interna dia_negocio_sucursal no es ejecutable por usuarios ni anon -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
select public.t_esperar_error($q$select restaurantes.dia_negocio_sucursal('00000000-0000-0000-0000-0000000e77a1', now())$q$, '42501');
rollback;

\echo '=== T1. sin ticket impreso, la aceptacion automatica sin POS NO mueve el pedido ==='
begin;
set local role authenticated;
select public.t_afirmar((select count(*) from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e77d1' and to_status = 'preparando') = 0, 'sin_ticket');
rollback;

\echo '=== T2. staff de A1 registra el ticket impreso: el tick lo pasa a Preparando (aceptacion_automatica) y es idempotente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7712', true);
select public.t_afirmar((select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d1')::int) = 1, 'registra');
select public.t_afirmar((select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d1')::int) = 1, 'reimprimir_es_idempotente');
select public.t_afirmar((select count(*) from restaurantes.order_ticket_impreso where order_id = '00000000-0000-0000-0000-0000000e77d1') = 1, 'una_sola_fila');
select set_config('request.jwt.claim.sub', '', true);
select public.t_afirmar((select count(*) from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e77d1' and to_status = 'preparando' and motivo = 'aceptacion_automatica') = 1, 'candidato_aceptacion');
select public.t_afirmar((select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d1', 'pending', 'preparando', 'sistema', 'aceptacion_automatica')::int) = 1, 'transicion_aplicada');
rollback;

\echo '=== T3. con la bandera APAGADA (A2) el ticket impreso no mueve el pedido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
select public.t_afirmar((select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d2')::int) = 1, 'owner_registra');
select set_config('request.jwt.claim.sub', '', true);
select public.t_afirmar((select count(*) from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e77d2' and to_status = 'preparando') = 0, 'bandera_apagada');
rollback;

\echo '=== T4. RECHAZADO: staff de A1 no registra el ticket de un pedido de A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7712', true);
select public.t_esperar_error($q$select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d2')$q$, '42501');
rollback;

\echo '=== T5. RECHAZADO: cross-tenant, owner de B (y un pedido de B con la organizacion de A) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7713', true);
select public.t_esperar_error($q$select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d1')$q$, '42501');
select public.t_esperar_error($q$select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77e1')$q$, '42501');
rollback;

\echo '=== T6. RECHAZADO: anon y la sesion de sistema (sin usuario) no registran tickets ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d1')$q$, '42501');
rollback;
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d1')$q$, '42501');
rollback;

\echo '=== T7. un pedido que ya no esta pending no registra nada (false) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7712', true);
select public.t_afirmar((select restaurantes.pedido_ticket_impreso_registrar('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77d3')::int) = 0, 'ya_en_cocina');
select public.t_afirmar((select count(*) from restaurantes.order_ticket_impreso where order_id = '00000000-0000-0000-0000-0000000e77d3') = 0, 'sin_fila');
rollback;

\echo '=== T8. la tabla es append-only para usuarios: sin INSERT/UPDATE/DELETE directo y sin lectura cross-tenant ==='
begin;
insert into restaurantes.order_ticket_impreso (order_id, organization_id, property_id) values ('00000000-0000-0000-0000-0000000e77d1', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7713', true);
select public.t_afirmar((select count(*) from restaurantes.order_ticket_impreso) = 0, 'owner_ajeno_no_ve');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
select public.t_afirmar((select count(*) from restaurantes.order_ticket_impreso) = 1, 'owner_propio_ve');
select public.t_esperar_error($q$insert into restaurantes.order_ticket_impreso (order_id, organization_id, property_id) values ('00000000-0000-0000-0000-0000000e77d2', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a2')$q$, '42501');
select public.t_esperar_error($q$delete from restaurantes.order_ticket_impreso$q$, '42501');
rollback;
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.order_ticket_impreso$q$, '42501');
rollback;

\echo '=== R1. un pedido para recoger SIN hora (web) pasa a no_recogido a los 60 min de quedar listo; antes no ==='
begin;
select public.t_afirmar((select count(*) from restaurantes.autopiloto_candidatos_estados(now() + interval '10 minutes', 500) where order_id = '00000000-0000-0000-0000-0000000e77d4') = 0, 'web_sin_hora_aun_no');
select public.t_afirmar((select count(*) from restaurantes.autopiloto_candidatos_estados(now() + interval '90 minutes', 500) where order_id = '00000000-0000-0000-0000-0000000e77d4' and to_status = 'no_recogido') = 1, 'web_sin_hora_a_los_90_min');
rollback;

\echo '=== R2. el pedido de WhatsApp con hora: el plazo cuenta desde max(hora de recogida, cuando quedo listo) (cuerpo de 076) ==='
begin;
select public.t_afirmar((select count(*) from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e77d5' and to_status = 'no_recogido') = 0, 'whatsapp_recien_listo_aun_no');
select public.t_afirmar((select count(*) from restaurantes.autopiloto_candidatos_estados(now() + interval '90 minutes', 500) where order_id = '00000000-0000-0000-0000-0000000e77d5' and to_status = 'no_recogido') = 1, 'whatsapp_con_hora_a_los_90_min');
rollback;

\echo '=== R3. solo sistema: un usuario no consulta los candidatos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
select public.t_esperar_error($q$select * from restaurantes.autopiloto_candidatos_estados(now(), 10)$q$, '42501');
rollback;

\echo '=== E1. varias transiciones en UNA transaccion quedan en orden estricto (at estrictamente creciente) ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal) values
  ('00000000-0000-0000-0000-0000000e77f1', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'E1', '5500000001', 100, 'pending', '[]', 'whatsapp', 'domicilio');
update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000e77f1';
update restaurantes.orders set status = 'listo_para_recoger' where id = '00000000-0000-0000-0000-0000000e77f1';
update restaurantes.orders set status = 'entregado' where id = '00000000-0000-0000-0000-0000000e77f1';
update restaurantes.orders set status = 'completado' where id = '00000000-0000-0000-0000-0000000e77f1';
select public.t_afirmar((select (string_agg(to_status, '>' order by at, id) = 'pending>preparando>listo_para_recoger>entregado>completado')::int
  from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e77f1') = 1, 'orden_del_historial');
select public.t_afirmar((select count(*) from (
  select at, lag(at) over (order by at, id) as previo from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e77f1'
) x where previo is not null and at <= previo) = 0, 'instantes_repetidos');
rollback;

\echo '=== C1. cierre del dia: los 3 entregados que el autopiloto paso a completado conservan sus tiempos; por_aprobar no es venta ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal) values
  ('00000000-0000-0000-0000-0000000e77c9', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'V1', '5500001001', 100, 'completado', '[]', 'whatsapp', timestamptz '2026-03-10 18:00:00+00', timestamptz '2026-03-10 18:30:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e77ca', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'V2', '5500001002', 100, 'completado', '[]', 'whatsapp', timestamptz '2026-03-10 19:00:00+00', timestamptz '2026-03-10 19:20:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e77cb', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'V3', '5500001003', 100, 'entregado', '[]', 'whatsapp', timestamptz '2026-03-10 20:00:00+00', timestamptz '2026-03-10 20:40:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e77cc', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'GRANDE', '5500001004', 4500, 'por_aprobar', '[]', 'whatsapp', timestamptz '2026-03-10 21:00:00+00', null, 'domicilio');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
select public.t_afirmar((select (datos -> 'tiempos' ->> 'entregados')::int
  from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'dia', date '2026-03-10')) = 3, 'tiempos_entregados');
select public.t_afirmar((select (datos ->> 'pedidos')::int
  from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'dia', date '2026-03-10')) = 3, 'ventas_sin_por_aprobar');
select public.t_afirmar((select (datos ->> 'ventas_centavos')::int
  from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'dia', date '2026-03-10')) = 30000, 'ventas_centavos');
select public.t_afirmar((select (datos ->> 'pedidos_totales_incl_cancelados')::int
  from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'dia', date '2026-03-10')) = 4, 'totales_incluyen_el_retenido');
select public.t_afirmar((select ((datos -> 'tiempos' ->> 'promedio_min')::numeric = 30)::int
  from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'dia', date '2026-03-10')) = 1, 'promedio_30_min');
rollback;

\echo '=== H1. una toma PENDIENTE sin tomar tras el umbral se escala UNA sola vez (solo sistema) ==='
begin;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages) values
  ('00000000-0000-0000-0000-0000000e7791', '00000000-0000-0000-0000-0000000e7701', '5577000001', '00000000-0000-0000-0000-0000000e77a1', '[{"role":"user","content":"quiero hablar con alguien"}]'),
  ('00000000-0000-0000-0000-0000000e7792', '00000000-0000-0000-0000-0000000e7701', '5577000002', '00000000-0000-0000-0000-0000000e77a1', '[{"role":"user","content":"hola"}]'),
  ('00000000-0000-0000-0000-0000000e7793', '00000000-0000-0000-0000-0000000e7701', '5577000003', '00000000-0000-0000-0000-0000000e77a1', '[{"role":"user","content":"ya me atienden"}]');
insert into restaurantes.conversation_handoff (id, organization_id, property_id, canal, conversation_id, estado, solicitado_por, solicitada_at, tomada_at) values
  ('00000000-0000-0000-0000-0000000e7781', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'whatsapp', '00000000-0000-0000-0000-0000000e7791', 'pendiente', 'agente', now() - interval '30 minutes', null),
  ('00000000-0000-0000-0000-0000000e7782', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'whatsapp', '00000000-0000-0000-0000-0000000e7792', 'pendiente', 'agente', now() - interval '5 minutes', null),
  ('00000000-0000-0000-0000-0000000e7783', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'whatsapp', '00000000-0000-0000-0000-0000000e7793', 'tomada', 'agente', now() - interval '30 minutes', now() - interval '20 minutes');
set local role authenticated;
select public.t_afirmar((select count(*) from restaurantes.handoffs_pendientes_por_escalar(now(), 50)) = 1, 'escaladas_la_primera_vez');
select public.t_afirmar((select count(*) from restaurantes.handoffs_pendientes_por_escalar(now(), 50)) = 0, 'segunda_pasada');
reset role;
select public.t_afirmar((select count(*) from restaurantes.conversation_handoff where id = '00000000-0000-0000-0000-0000000e7782' and escalada_at is null) = 1, 'la_reciente_sigue_pendiente_sin_escalar');
select public.t_afirmar((select count(*) from restaurantes.conversation_handoff where id = '00000000-0000-0000-0000-0000000e7783' and escalada_at is not null) = 0, 'la_tomada_no_se_escala');
select public.t_afirmar((select count(*) from restaurantes.conversation_handoff where id = '00000000-0000-0000-0000-0000000e7781' and escalada_at is not null and estado = 'pendiente') = 1, 'la_escalada_queda_marcada');
rollback;

\echo '=== H2. el umbral sale de la configuracion de la sucursal (handoff_regreso_minutos) ==='
begin;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages) values
  ('00000000-0000-0000-0000-0000000e7794', '00000000-0000-0000-0000-0000000e7701', '5577000004', '00000000-0000-0000-0000-0000000e77a2', '[{"role":"user","content":"hola"}]');
insert into restaurantes.conversation_handoff (id, organization_id, property_id, canal, conversation_id, estado, solicitado_por, solicitada_at) values
  ('00000000-0000-0000-0000-0000000e7784', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a2', 'whatsapp', '00000000-0000-0000-0000-0000000e7794', 'pendiente', 'agente', now() - interval '10 minutes');
select public.t_afirmar((select count(*) from restaurantes.handoffs_pendientes_por_escalar(now(), 50)) = 0, 'con_umbral_15_no_escala');
insert into restaurantes.autopiloto_config (property_id, organization_id, handoff_regreso_minutos) values ('00000000-0000-0000-0000-0000000e77a2', '00000000-0000-0000-0000-0000000e7701', 5)
  on conflict (property_id) do update set handoff_regreso_minutos = 5;
select public.t_afirmar((select count(*) from restaurantes.handoffs_pendientes_por_escalar(now(), 50)) = 1, 'con_umbral_5_si_escala');
rollback;

\echo '=== H3. RECHAZADO: un usuario y anon no escalan tomas -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
select public.t_esperar_error($q$select * from restaurantes.handoffs_pendientes_por_escalar(now(), 10)$q$, '42501');
rollback;
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.handoffs_pendientes_por_escalar(now(), 10)$q$, '42501');
rollback;

\echo '=== K1. el codigo de compensacion vigente del cliente lo devuelve la sesion de sistema, por telefono y organizacion ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal) values
  ('00000000-0000-0000-0000-0000000e7761', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'Queja', '5511112222', 388, 'entregado', '[]', 'whatsapp', 'domicilio');
insert into restaurantes.promotions (id, organization_id, code, name, type, value, max_uses, is_active) values
  ('00000000-0000-0000-0000-0000000e7771', '00000000-0000-0000-0000-0000000e7701', 'GRACIAS-ABCD1234', 'Compensacion de un solo uso', 'percentage', 10, 1, true);
insert into restaurantes.solicitud_aprobacion (id, organization_id, property_id, tipo, estado, order_id, detalle, decision, codigo_descuento, resuelta_at) values
  ('00000000-0000-0000-0000-0000000e7751', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'compensacion', 'resuelta', '00000000-0000-0000-0000-0000000e7761', '{"subtipo":"frio"}', 'descuento_proximo', 'GRACIAS-ABCD1234', now());
set local role authenticated;
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '+52 551 111 2222') = 'GRACIAS-ABCD1234')::int) = 1, 'codigo_del_cliente');
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '5511112222') = 'GRACIAS-ABCD1234')::int) = 1, 'mismo_telefono_sin_formato');
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '5599998888') is null)::int) = 1, 'otro_telefono');
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7702', '5511112222') is null)::int) = 1, 'otra_organizacion');
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '123') is null)::int) = 1, 'telefono_corto');
rollback;

\echo '=== K2. un codigo usado, vencido o inactivo ya no se ofrece ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal) values
  ('00000000-0000-0000-0000-0000000e7761', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'Queja', '5511112222', 388, 'entregado', '[]', 'whatsapp', 'domicilio');
insert into restaurantes.promotions (id, organization_id, code, name, type, value, max_uses, is_active) values
  ('00000000-0000-0000-0000-0000000e7771', '00000000-0000-0000-0000-0000000e7701', 'GRACIAS-ABCD1234', 'Compensacion de un solo uso', 'percentage', 10, 1, true);
insert into restaurantes.solicitud_aprobacion (id, organization_id, property_id, tipo, estado, order_id, detalle, decision, codigo_descuento, resuelta_at) values
  ('00000000-0000-0000-0000-0000000e7751', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'compensacion', 'resuelta', '00000000-0000-0000-0000-0000000e7761', '{"subtipo":"frio"}', 'descuento_proximo', 'GRACIAS-ABCD1234', now());
update restaurantes.promotions set times_used = 1 where id = '00000000-0000-0000-0000-0000000e7771';
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '5511112222') is null)::int) = 1, 'usado');
update restaurantes.promotions set times_used = 0, ends_at = now() - interval '1 day' where id = '00000000-0000-0000-0000-0000000e7771';
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '5511112222') is null)::int) = 1, 'vencido');
update restaurantes.promotions set ends_at = null, is_active = false where id = '00000000-0000-0000-0000-0000000e7771';
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '5511112222') is null)::int) = 1, 'inactivo');
rollback;

\echo '=== K3. un usuario (aunque sea owner de la organizacion) nunca lee los codigos de los clientes: devuelve null; anon -> 42501 ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal) values
  ('00000000-0000-0000-0000-0000000e7761', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'Queja', '5511112222', 388, 'entregado', '[]', 'whatsapp', 'domicilio');
insert into restaurantes.promotions (id, organization_id, code, name, type, value, max_uses, is_active) values
  ('00000000-0000-0000-0000-0000000e7771', '00000000-0000-0000-0000-0000000e7701', 'GRACIAS-ABCD1234', 'Compensacion de un solo uso', 'percentage', 10, 1, true);
insert into restaurantes.solicitud_aprobacion (id, organization_id, property_id, tipo, estado, order_id, detalle, decision, codigo_descuento, resuelta_at) values
  ('00000000-0000-0000-0000-0000000e7751', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'compensacion', 'resuelta', '00000000-0000-0000-0000-0000000e7761', '{"subtipo":"frio"}', 'descuento_proximo', 'GRACIAS-ABCD1234', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
select public.t_afirmar((select (restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '5511112222') is null)::int) = 1, 'owner_no_lee_codigos');
rollback;
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.compensacion_codigo_disponible('00000000-0000-0000-0000-0000000e7701', '5511112222')$q$, '42501');
rollback;

\echo '=== V1. las TRES pantallas dan las mismas ventas del dia con un pedido programado: Cierre, Resumen (getSalesBucketedStats) y Copiloto (SQL_ORDER_STATS) ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, promovido_at, delivered_at, canal, programado_para) values
  ('00000000-0000-0000-0000-0000000e77b9', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'Prog', '5500002001', 200, 'completado', '[]', 'whatsapp', timestamptz '2026-03-09 18:00:00+00', timestamptz '2026-03-10 18:30:00+00', timestamptz '2026-03-10 19:00:00+00', 'domicilio', timestamptz '2026-03-10 18:30:00+00');
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal) values
  ('00000000-0000-0000-0000-0000000e77ba', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'N1', '5500002002', 100, 'entregado', '[]', 'web', timestamptz '2026-03-10 17:00:00+00', timestamptz '2026-03-10 17:40:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e77bb', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'N2', '5500002003', 300, 'entregado', '[]', 'web', timestamptz '2026-03-10 20:00:00+00', timestamptz '2026-03-10 20:40:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e77bc', '00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'GRANDE', '5500002004', 4500, 'por_aprobar', '[]', 'whatsapp', timestamptz '2026-03-10 21:00:00+00', null, 'domicilio');
-- Resumen: misma consulta que PostgresRestaurantesRepository.getSalesBucketedStats (ventana del 10-mar local de Merida = 06:00Z a 06:00Z).
select public.t_afirmar((select count(o.id) from restaurantes.orders o
   where o.organization_id = '00000000-0000-0000-0000-0000000e7701' and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
     and coalesce(o.promovido_at, o.created_at) >= timestamptz '2026-03-10 06:00:00+00' and coalesce(o.promovido_at, o.created_at) < timestamptz '2026-03-11 06:00:00+00') = 3, 'resumen_pedidos');
select public.t_afirmar((select coalesce(sum(o.total), 0) from restaurantes.orders o
   where o.organization_id = '00000000-0000-0000-0000-0000000e7701' and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
     and coalesce(o.promovido_at, o.created_at) >= timestamptz '2026-03-10 06:00:00+00' and coalesce(o.promovido_at, o.created_at) < timestamptz '2026-03-11 06:00:00+00') = 600, 'resumen_ventas');
-- Copiloto: SQL_ORDER_STATS de data-chat/sql.ts.
select public.t_afirmar((select count(*) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar'))
   from restaurantes.orders o join core.property p on p.id = o.property_id
   where o.organization_id = '00000000-0000-0000-0000-0000000e7701' and (null::uuid[] is null or o.property_id = any(null::uuid[]))
     and coalesce(o.promovido_at, o.created_at) >= timestamptz '2026-03-10 06:00:00+00' and coalesce(o.promovido_at, o.created_at) < timestamptz '2026-03-11 06:00:00+00') = 3, 'copiloto_pedidos');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7711', true);
-- Cierre del dia: las mismas 3 ventas y $600.
select public.t_afirmar((select (datos ->> 'pedidos')::int from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'dia', date '2026-03-10')) = 3, 'cierre_pedidos');
select public.t_afirmar((select (datos ->> 'ventas_centavos')::int from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7701', '00000000-0000-0000-0000-0000000e77a1', 'dia', date '2026-03-10')) = 60000, 'cierre_ventas');
rollback;
