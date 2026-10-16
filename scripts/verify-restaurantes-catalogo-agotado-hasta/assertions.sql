-- Fixtures + escenarios contra Postgres REAL (GRANT/RLS/triggers reales, rol `authenticated`) de "Dejar de venderlo" (import-orig-14).
--
-- Contexto: el panel de Productos cancela la reposicion programada de un producto «agotado hasta mañana»
-- (`restaurantes.branch_products.agotado_hasta`, migracion 050) para que el cron `restaurantes.agotados_reponer` (076) no lo reactive.
-- La migracion 065 le quita a `authenticated` todo UPDATE de branch_products salvo `grant update (price, is_available, updated_at)`:
-- escribir `agotado_hasta = null` directo da 42501. Por eso PostgresRestaurantesRepository.limpiarAgotadoHasta hace DOS UPDATE de
-- columnas permitidas (is_available true y luego false) y deja que el trigger branch_products_limpiar_agotado_hasta (050) borre la fecha
-- en el primer cambio. Apagar algo YA apagado no dispara el trigger: por eso hacen falta los dos pasos.
--
--   V1. CONTROL: sin «Dejar de venderlo» el cron reactiva los dos productos agotados.
--   V2. Con «Dejar de venderlo» (dos UPDATE como owner) el cron reactiva SOLO el otro: el apagado a proposito no vuelve solo.
--   V3. Queda apagado y sin fecha.
--   V4. Documenta el permiso: UPDATE directo de agotado_hasta como authenticated falla con 42501 (no se agrega grant a la columna).
--   V5. Un solo UPDATE (apagar lo ya apagado) NO limpia la fecha: por eso son dos pasos.
--   V6. Un staff sin membresia en la organizacion no cambia nada (RLS): 0 filas.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias con sufijo deberia_ser_N marca el valor
-- esperado; un escenario sin alias debe terminar sin error (t_esperar_error exige el SQLSTATE exacto).
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
  ('00000000-0000-0000-0000-0000000e7001', 'restaurantes', 'Catalogo Org A', 'catalogo-a'),
  ('00000000-0000-0000-0000-0000000e7002', 'restaurantes', 'Catalogo Org B (ajena)', 'catalogo-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e70b1', '00000000-0000-0000-0000-0000000e7002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', 'a1', 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e70b1', '00000000-0000-0000-0000-0000000e7002', 'b1', null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e7011', 'owner-a@catalogo.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e7015', 'owner-b@catalogo.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e7011', '00000000-0000-0000-0000-0000000e7001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e7015', '00000000-0000-0000-0000-0000000e7002', null, 'owner', 'owner')
on conflict do nothing;

-- Dos productos agotados «hasta mañana» (2026-10-08): P1 se «deja de vender», P2 es el control.
insert into restaurantes.products (id, organization_id, name, price) values
  ('00000000-0000-0000-0000-0000000e70c1', '00000000-0000-0000-0000-0000000e7001', 'Taco agotado 1', 50),
  ('00000000-0000-0000-0000-0000000e70c2', '00000000-0000-0000-0000-0000000e7001', 'Taco agotado 2', 50)
on conflict do nothing;
insert into restaurantes.branch_products (property_id, product_id, price, is_available) values
  ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e70c1', 50, true),
  ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e70c2', 50, true)
on conflict do nothing;
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-08' where property_id = '00000000-0000-0000-0000-0000000e70a1';

\echo '=== V1. CONTROL: sin «Dejar de venderlo» el cron reactiva los dos agotados ==='
begin;
set local role authenticated;
select count(*) as repuestos_control_deberia_ser_2 from restaurantes.agotados_reponer(timestamptz '2026-10-09 18:00:00+00');
rollback;

\echo '=== V2. «Dejar de venderlo» (dos UPDATE como owner): el cron reactiva SOLO el otro producto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
update restaurantes.branch_products set is_available = true, updated_at = now() where property_id = '00000000-0000-0000-0000-0000000e70a1' and product_id = '00000000-0000-0000-0000-0000000e70c1' and is_available = false and agotado_hasta is not null;
update restaurantes.branch_products set is_available = false, updated_at = now() where property_id = '00000000-0000-0000-0000-0000000e70a1' and product_id = '00000000-0000-0000-0000-0000000e70c1' and is_available = true;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as repuestos_tras_dejar_de_venderlo_deberia_ser_1 from restaurantes.agotados_reponer(timestamptz '2026-10-09 18:00:00+00');
rollback;

\echo '=== V3. tras «Dejar de venderlo» queda apagado y sin fecha ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
update restaurantes.branch_products set is_available = true, updated_at = now() where property_id = '00000000-0000-0000-0000-0000000e70a1' and product_id = '00000000-0000-0000-0000-0000000e70c1' and is_available = false and agotado_hasta is not null;
update restaurantes.branch_products set is_available = false, updated_at = now() where property_id = '00000000-0000-0000-0000-0000000e70a1' and product_id = '00000000-0000-0000-0000-0000000e70c1' and is_available = true;
reset role;
select count(*) as apagado_sin_fecha_deberia_ser_1 from restaurantes.branch_products where product_id = '00000000-0000-0000-0000-0000000e70c1' and not is_available and agotado_hasta is null;
rollback;

\echo '=== V4. documenta el permiso: UPDATE directo de agotado_hasta como authenticated -> 42501 (065: solo price, is_available, updated_at) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select public.t_esperar_error($q$update restaurantes.branch_products set agotado_hasta = null where product_id = '00000000-0000-0000-0000-0000000e70c1'$q$, '42501');
rollback;

\echo '=== V5. un solo UPDATE (apagar lo ya apagado) NO limpia la fecha: por eso son dos pasos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
update restaurantes.branch_products set is_available = false, updated_at = now() where product_id = '00000000-0000-0000-0000-0000000e70c1';
reset role;
select count(*) as fecha_sigue_ahi_deberia_ser_1 from restaurantes.branch_products where product_id = '00000000-0000-0000-0000-0000000e70c1' and agotado_hasta is not null;
rollback;

\echo '=== V6. el owner de OTRA organizacion no cambia nada (RLS): 0 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7015', true);
with u as (update restaurantes.branch_products set is_available = true, updated_at = now() where product_id = '00000000-0000-0000-0000-0000000e70c1' returning 1) select count(*) as filas_ajenas_deberia_ser_0 from u;
rollback;
