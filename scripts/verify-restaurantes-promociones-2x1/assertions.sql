-- Fixtures + escenarios contra Postgres REAL (CHECK + RLS + GRANT reales -- nunca el repositorio
-- en memoria) de packages/domain-restaurantes/migrations/027_promociones_2x1_y_canal.sql:
--
--   A. Promociones 2x1 (type 'bogo') con canal y productos elegibles: positivo (owner de A) y CHECKs
--      (value distinto de 1, canal inexistente, canal vacio, > 50 productos, type desconocido).
--   B. Los CHECK de la 010 siguen vigentes (porcentaje > 100) y el INSERT anterior (sin columnas
--      nuevas) sigue funcionando: compatibilidad hacia atras.
--   C. Cross-tenant: owner de B no inserta ni actualiza promociones de A (RLS).
--   D. anon no lee ni escribe; la sesion de sistema (auth.uid() null) solo resuelve promociones ACTIVAS.
--      increment_promotion_uses con un 2x1.
--   E. Base SIN migrar: el SQL real que emite el repositorio (columnas channels/product_ids) falla
--      con 42703 y el SAVEPOINT/ROLLBACK TO SAVEPOINT recupera la transaccion.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`: un escenario
-- "RECHAZADO" termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0001', 'restaurantes', 'Promo Org A', 'promo-org-a'),
  ('00000000-0000-0000-0000-0000000d0002', 'restaurantes', 'Promo Org B (ajena)', 'promo-org-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0011', 'owner-a@promo.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0014', 'owner-b@promo.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0011', '00000000-0000-0000-0000-0000000d0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0014', '00000000-0000-0000-0000-0000000d0002', null, 'owner', 'owner')
on conflict do nothing;

-- Promociones previas (insertadas como superusuario): una activa y una inactiva de A.
insert into restaurantes.promotions (id, organization_id, code, name, type, value, is_active) values
  ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'ACTIVA10', 'Activa', 'percentage', 10, true),
  ('00000000-0000-0000-0000-0000000d00a2', '00000000-0000-0000-0000-0000000d0001', 'INACTIVA10', 'Inactiva', 'percentage', 10, false)
on conflict do nothing;

\echo '=== A1. POSITIVO: owner de A crea un 2x1 de lunes, solo para recoger, sobre un producto elegible ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, days_of_week, channels, product_ids)
  values ('00000000-0000-0000-0000-0000000d0001', 'LUNES2X1', 'Lunes 2x1', 'bogo', 1, array[1]::smallint[], array['recoger']::text[], array['00000000-0000-0000-0000-0000000d00c1']::uuid[])
  returning code, type, value, channels, product_ids;
rollback;

\echo '=== A2. RECHAZADO (debe fallar): un 2x1 con value distinto de 1 ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value)
  values ('00000000-0000-0000-0000-0000000d0001', 'MALO2X1', 'x', 'bogo', 5);
rollback;

\echo '=== A3. RECHAZADO (debe fallar): canal inexistente ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, channels)
  values ('00000000-0000-0000-0000-0000000d0001', 'MALOCANAL', 'x', 'bogo', 1, array['mesa']::text[]);
rollback;

\echo '=== A4. RECHAZADO (debe fallar): arreglo de canales vacio ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, channels)
  values ('00000000-0000-0000-0000-0000000d0001', 'CANALVACIO', 'x', 'bogo', 1, '{}'::text[]);
rollback;

\echo '=== A5. RECHAZADO (debe fallar): mas de 50 productos elegibles (defensa de tamano) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, product_ids)
  values ('00000000-0000-0000-0000-0000000d0001', 'MUCHOS', 'x', 'bogo', 1, array(select gen_random_uuid() from generate_series(1, 51)));
rollback;

\echo '=== A6. RECHAZADO (debe fallar): type desconocido ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value)
  values ('00000000-0000-0000-0000-0000000d0001', 'TIPOMALO', 'x', 'combo', 1);
rollback;

\echo '=== A7. La restriccion de type fue reemplazada (existe promotions_type_check y acepta bogo) ==='
begin;
select count(*)::int as restriccion_type_con_bogo_deberia_ser_1
  from pg_constraint where conname = 'promotions_type_check' and conrelid = 'restaurantes.promotions'::regclass and pg_get_constraintdef(oid) like '%bogo%';
rollback;

\echo '=== B1. COMPATIBILIDAD: el INSERT anterior (sin columnas de la 027) sigue funcionando y deja channels/product_ids en null ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value)
  values ('00000000-0000-0000-0000-0000000d0001', 'LEGADO10', 'Legado', 'percentage', 10)
  returning code, channels, product_ids;
rollback;

\echo '=== B2. RECHAZADO (debe fallar): el CHECK de la 010 sigue vigente (porcentaje mayor a 100) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value)
  values ('00000000-0000-0000-0000-0000000d0001', 'PCT150', 'x', 'percentage', 150);
rollback;

\echo '=== C1. RECHAZADO (debe fallar): owner de B inserta una promocion declarando la organizacion A ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, channels)
  values ('00000000-0000-0000-0000-0000000d0001', 'CRUZADO', 'x', 'bogo', 1, array['recoger']::text[]);
rollback;

\echo '=== C2. CROSS-TENANT: owner de B no actualiza canales de una promocion de A (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
with actualizado as (
  update restaurantes.promotions set channels = array['recoger']::text[] where id = '00000000-0000-0000-0000-0000000d00a1' returning id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== C3. POSITIVO: owner de A si actualiza canales de su propia promocion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
update restaurantes.promotions set channels = array['recoger']::text[] where id = '00000000-0000-0000-0000-0000000d00a1' returning code, channels;
rollback;

\echo '=== D1. RECHAZADO (debe fallar): anon no lee promociones (la lectura publica del checkout pasa por la sesion de sistema, nunca por anon) ==='
begin;
-- as should_fail (la consulta usa el alias en la columna)
set local role anon;
select count(*)::int as should_fail from restaurantes.promotions;
rollback;

\echo '=== D2. Sesion de sistema (authenticated sin usuario, auth.uid() null): resuelve una promocion ACTIVA por codigo; la inactiva no es resoluble ==='
begin;
set local role authenticated;
select code, type, channels, product_ids from restaurantes.promotions where code = 'ACTIVA10';
select count(*)::int as inactivas_visibles_para_sistema_deberia_ser_0 from restaurantes.promotions where is_active = false;
rollback;

\echo '=== D3. RECHAZADO (debe fallar): anon no inserta promociones ==='
begin;
-- as should_fail (INSERT sin alias)
set local role anon;
insert into restaurantes.promotions (organization_id, code, name, type, value)
  values ('00000000-0000-0000-0000-0000000d0001', 'ANON', 'x', 'bogo', 1);
rollback;

\echo '=== D4. increment_promotion_uses sigue funcionando con un 2x1 (sesion de sistema) ==='
begin;
insert into restaurantes.promotions (id, organization_id, code, name, type, value, max_uses)
  values ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0001', 'USO2X1', 'x', 'bogo', 1, 1);
set local role authenticated; -- sesion de sistema: auth.uid() null (la funcion exige esa condicion desde la 018)
select (restaurantes.increment_promotion_uses('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00b1') is not null)::int as primer_uso_deberia_ser_1;
rollback;

\echo '=== E1. BASE SIN MIGRAR: sin las columnas channels/product_ids, la lectura real del repositorio falla con 42703 y SAVEPOINT recupera la transaccion ==='
begin;
alter table restaurantes.promotions drop column channels, drop column product_ids;
savepoint sp_verify_promociones_2x1_lectura;
do $$
declare
  v_state text;
begin
  begin
    perform id, code, channels, product_ids from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000d0001';
    raise exception 'se esperaba SQLSTATE 42703, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_promociones_2x1_lectura;
release savepoint sp_verify_promociones_2x1_lectura;
select count(*)::int as lectura_anterior_sigue_funcionando_deberia_ser_2 from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000d0001';
rollback;

\echo '=== E2. BASE SIN MIGRAR: crear un 2x1 falla con 42703 (analisis de columnas, antes de cualquier CHECK) y SAVEPOINT recupera la transaccion ==='
begin;
alter table restaurantes.promotions drop column channels, drop column product_ids;
savepoint sp_verify_promociones_2x1_alta;
do $$
declare
  v_state text;
begin
  begin
    execute $sql$insert into restaurantes.promotions (organization_id, code, name, type, value, channels, product_ids)
      values ('00000000-0000-0000-0000-0000000d0001', 'X2X1', 'x', 'bogo', 1, null, null)$sql$;
    raise exception 'se esperaba SQLSTATE 42703, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_promociones_2x1_alta;
release savepoint sp_verify_promociones_2x1_alta;
select count(*)::int as transaccion_recuperada_deberia_ser_1 from (select 1) t;
rollback;
