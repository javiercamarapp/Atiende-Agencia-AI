-- Fixtures + escenarios contra Postgres REAL (CHECK + RLS + GRANT reales -- nunca el repositorio en
-- memoria) de packages/domain-restaurantes/migrations/038_promociones_por_sucursal.sql:
--
--   A. promotions.property_ids (alcance por sucursal): positivo (owner de A con dos sucursales de A),
--      null = todas (las filas anteriores no cambian) y CHECKs (arreglo vacio, mas de 50).
--   B. Compatibilidad hacia atras: el INSERT anterior (sin la columna) sigue funcionando y deja null;
--      los CHECK de 010/027/031 siguen vigentes (cortesia sin lista, auto_apply sin canales).
--   C. Cross-tenant: owner de B no inserta ni actualiza el alcance de promociones de A (RLS).
--   D. anon no escribe; la sesion de sistema (auth.uid() null) resuelve solo promociones ACTIVAS con su alcance.
--   E. Base SIN migrar: el SQL real que emite el repositorio (columna property_ids) falla con 42703 y
--      SAVEPOINT / ROLLBACK TO SAVEPOINT recupera la transaccion.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`: un escenario
-- "RECHAZADO" termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e0001', 'restaurantes', 'Alcance Org A', 'alcance-org-a'),
  ('00000000-0000-0000-0000-0000000e0002', 'restaurantes', 'Alcance Org B (ajena)', 'alcance-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000e00c1', '00000000-0000-0000-0000-0000000e0001', 'restaurantes', 'Sucursal A1', 'active'),
  ('00000000-0000-0000-0000-0000000e00c2', '00000000-0000-0000-0000-0000000e0001', 'restaurantes', 'Sucursal A2', 'active'),
  ('00000000-0000-0000-0000-0000000e00c3', '00000000-0000-0000-0000-0000000e0002', 'restaurantes', 'Sucursal B1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0011', 'owner-a@alcance.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0014', 'owner-b@alcance.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e0011', '00000000-0000-0000-0000-0000000e0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e0014', '00000000-0000-0000-0000-0000000e0002', null, 'owner', 'owner')
on conflict do nothing;

-- Promociones previas (insertadas como superusuario): una sin alcance (null = todas) y una con alcance a A1.
insert into restaurantes.promotions (id, organization_id, code, name, type, value, is_active, property_ids) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'SINALCANCE', 'Sin alcance', 'percentage', 10, true, null),
  ('00000000-0000-0000-0000-0000000e00a2', '00000000-0000-0000-0000-0000000e0001', 'SOLOA1', 'Solo A1', 'percentage', 10, true, array['00000000-0000-0000-0000-0000000e00c1']::uuid[]),
  ('00000000-0000-0000-0000-0000000e00a3', '00000000-0000-0000-0000-0000000e0001', 'INACTIVA', 'Inactiva', 'percentage', 10, false, array['00000000-0000-0000-0000-0000000e00c1']::uuid[])
on conflict do nothing;

\echo '=== A1. POSITIVO: owner de A crea un 2x1 de lunes, solo recoger, solo en dos sucursales de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, days_of_week, channels, auto_apply, property_ids)
  values ('00000000-0000-0000-0000-0000000e0001', 'LUNES2X1', 'Lunes 2x1', 'bogo', 1, array[1]::smallint[], array['recoger']::text[], true,
          array['00000000-0000-0000-0000-0000000e00c1', '00000000-0000-0000-0000-0000000e00c2']::uuid[])
  returning code, cardinality(property_ids) as sucursales;
rollback;

\echo '=== A2. Las promociones existentes conservan property_ids = null (todas las sucursales): 1 fila sin alcance ==='
begin;
select count(*)::int as sin_alcance_deberia_ser_1 from restaurantes.promotions
  where organization_id = '00000000-0000-0000-0000-0000000e0001' and property_ids is null;
rollback;

\echo '=== A3. RECHAZADO (debe fallar): arreglo de sucursales vacio ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
  values ('00000000-0000-0000-0000-0000000e0001', 'ALCANCEVACIO', 'x', 'percentage', 10, '{}'::uuid[]);
rollback;

\echo '=== A4. RECHAZADO (debe fallar): mas de 50 sucursales (defensa de tamano) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
  values ('00000000-0000-0000-0000-0000000e0001', 'MUCHASUC', 'x', 'percentage', 10, array(select gen_random_uuid() from generate_series(1, 51)));
rollback;

\echo '=== A5. POSITIVO: exactamente 50 sucursales es el limite aceptado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
  values ('00000000-0000-0000-0000-0000000e0001', 'LIMITE50', 'x', 'percentage', 10, array(select gen_random_uuid() from generate_series(1, 50)))
  returning code, cardinality(property_ids) as sucursales;
rollback;

\echo '=== A6. POSITIVO: owner de A acota (update) una promocion sin alcance a una sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
update restaurantes.promotions set property_ids = array['00000000-0000-0000-0000-0000000e00c2']::uuid[]
  where id = '00000000-0000-0000-0000-0000000e00a1' returning code, property_ids;
rollback;

\echo '=== B1. COMPATIBILIDAD: el INSERT anterior (sin la columna) sigue funcionando y deja property_ids en null ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value)
  values ('00000000-0000-0000-0000-0000000e0001', 'LEGADO10', 'Legado', 'percentage', 10)
  returning code, property_ids;
rollback;

\echo '=== B2. RECHAZADO (debe fallar): el CHECK de 031 sigue vigente (auto_apply sin canales) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, auto_apply, property_ids)
  values ('00000000-0000-0000-0000-0000000e0001', 'AUTOSINCANAL', 'x', 'bogo', 1, true, array['00000000-0000-0000-0000-0000000e00c1']::uuid[]);
rollback;

\echo '=== B3. RECHAZADO (debe fallar): el CHECK de 010 sigue vigente (porcentaje mayor a 100) con alcance ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
  values ('00000000-0000-0000-0000-0000000e0001', 'PCT150', 'x', 'percentage', 150, array['00000000-0000-0000-0000-0000000e00c1']::uuid[]);
rollback;

\echo '=== C1. RECHAZADO (debe fallar): owner de B inserta una promocion con alcance declarando la organizacion A ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
  values ('00000000-0000-0000-0000-0000000e0001', 'CRUZADO', 'x', 'percentage', 10, array['00000000-0000-0000-0000-0000000e00c1']::uuid[]);
rollback;

\echo '=== C2. CROSS-TENANT: owner de B no cambia el alcance de una promocion de A (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
with actualizado as (
  update restaurantes.promotions set property_ids = array['00000000-0000-0000-0000-0000000e00c3']::uuid[] where id = '00000000-0000-0000-0000-0000000e00a2' returning id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== C3. CROSS-TENANT: owner de B no ve el alcance de las promociones de A (staff ve solo las de su organizacion; activas visibles para el checkout) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*)::int as inactivas_ajenas_visibles_deberia_ser_0 from restaurantes.promotions where is_active = false;
rollback;

\echo '=== D1. RECHAZADO (debe fallar): anon no inserta promociones con alcance ==='
begin;
-- as should_fail (INSERT sin alias)
set local role anon;
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
  values ('00000000-0000-0000-0000-0000000e0001', 'ANON', 'x', 'percentage', 10, array['00000000-0000-0000-0000-0000000e00c1']::uuid[]);
rollback;

\echo '=== D2. anon no modifica el alcance de una promocion existente (0 filas o sin permiso): nunca cambia ==='
begin;
set local role anon;
do $$
begin
  begin
    update restaurantes.promotions set property_ids = null where id = '00000000-0000-0000-0000-0000000e00a2';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;
select count(*)::int as alcance_intacto_deberia_ser_1 from restaurantes.promotions where id = '00000000-0000-0000-0000-0000000e00a2' and property_ids is not null;
rollback;

\echo '=== D3. Sesion de sistema (authenticated sin usuario, auth.uid() null): resuelve la promocion ACTIVA con su alcance; la inactiva no es visible ==='
begin;
set local role authenticated;
select code, cardinality(property_ids) as sucursales from restaurantes.promotions where code = 'SOLOA1';
select count(*)::int as inactivas_visibles_para_sistema_deberia_ser_0 from restaurantes.promotions where is_active = false;
rollback;

\echo '=== E1. BASE SIN MIGRAR: sin property_ids la lectura real del repositorio falla con 42703 y SAVEPOINT recupera la transaccion ==='
begin;
-- cascade: las policies de la migracion 042 dependen de property_ids; en una base sin migrar (sin 038 ni 041) no existen.
alter table restaurantes.promotions drop column property_ids cascade;
savepoint sp_verify_promociones_sucursal_lectura;
do $$
declare
  v_state text;
begin
  begin
    perform id, code, property_ids from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000e0001';
    raise exception 'se esperaba SQLSTATE 42703, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_promociones_sucursal_lectura;
release savepoint sp_verify_promociones_sucursal_lectura;
select count(*)::int as lectura_anterior_sigue_funcionando_deberia_ser_3 from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== E2. BASE SIN MIGRAR: crear una promocion con alcance falla con 42703 y SAVEPOINT recupera la transaccion ==='
begin;
-- cascade: las policies de la migracion 042 dependen de property_ids; en una base sin migrar (sin 038 ni 041) no existen.
alter table restaurantes.promotions drop column property_ids cascade;
savepoint sp_verify_promociones_sucursal_alta;
do $$
declare
  v_state text;
begin
  begin
    execute $sql$insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
      values ('00000000-0000-0000-0000-0000000e0001', 'XALCANCE', 'x', 'percentage', 10, null)$sql$;
    raise exception 'se esperaba SQLSTATE 42703, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_promociones_sucursal_alta;
release savepoint sp_verify_promociones_sucursal_alta;
select count(*)::int as transaccion_recuperada_deberia_ser_1 from (select 1) t;
rollback;
