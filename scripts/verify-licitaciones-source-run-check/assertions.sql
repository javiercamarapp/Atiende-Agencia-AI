-- Fixtures + assertions contra Postgres REAL (RLS + GRANT + CHECK reales) para
-- packages/domain-licitaciones/migrations/028_source_run_check_yucatan_guadalajara.sql
-- (hallazgo a5: el CHECK de licitaciones.source_run.source nunca admitio
-- 'yucatan_ocds'/'guadalajara_ocds', los conectores del PR #193).
--
--   1. MIGRADO (esquema real tras 028): ingest + source_run de yucatan_ocds y
--      guadalajara_ocds en sesion de sistema -> 2 tenders y 2 source_run.
--   2. SIN MIGRAR (se recrea el CHECK de la migracion 023 dentro de la transaccion):
--      el INSERT de source_run viola 23514 -- ANTES del fix, sin SAVEPOINT, esto
--      aborta la transaccion y el COMMIT revierte los tenders (escenario should_fail).
--   3. SIN MIGRAR + SAVEPOINT (lo que hace PostgresLicitacionesRepository.recordSourceRun
--      con runWithSavepointFallback): el 23514 se recupera, el tender insertado en la
--      MISMA transaccion se CONSERVA, no queda source_run y la sesion sigue utilizable.
--   4. SIN MIGRAR: una fuente ya soportada (nl_ocds) sigue registrandose.
--   5. NEGATIVO: sesion autenticada (auth.uid() no nulo) -> 42501 (funcion de solo-sistema).
--   6. NEGATIVO: anon -> sin EXECUTE.
--   7. CROSS-TENANT: owner de otra organizacion no puede insertar source_run ajeno (RLS);
--      el owner propio SI puede con 'yucatan_ocds' (CHECK + RLS migrados).
--   8. NEGATIVO: un source desconocido sigue rechazado (23514) tras 028.
--
-- Cada escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000f1', 'licitaciones', 'Org A (source_run check)', 'org-a-source-run-check'),
  ('00000000-0000-0000-0000-0000000000f2', 'licitaciones', 'Org B (source_run check, ajena)', 'org-b-source-run-check')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a-src@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000a2', 'owner-b-src@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000f2', null, 'owner', 'owner')
on conflict do nothing;

\echo ''
\echo '=== licitaciones.source_run -- CHECK de source (028) ==='
\echo ''

\echo '--- 1. MIGRADO: yucatan_ocds y guadalajara_ocds -> 2 tenders + 2 source_run (sesion de sistema) ---'
begin;
select out_id from licitaciones.system_ingest_tender('00000000-0000-0000-0000-0000000000f1'::uuid, 'Tender yucatan_ocds', null::timestamptz, 'yucatan_ocds', 'y-1', null, '{}'::text[], null::numeric, 'MXN', null, null);
select out_id from licitaciones.system_ingest_tender('00000000-0000-0000-0000-0000000000f1'::uuid, 'Tender guadalajara_ocds', null::timestamptz, 'guadalajara_ocds', 'g-1', null, '{}'::text[], null::numeric, 'MXN', null, null);
select out_id from licitaciones.system_record_source_run('00000000-0000-0000-0000-0000000000f1'::uuid, 'yucatan_ocds', 'ok', now(), now(), null, null, 'Ingesta de prueba', 1, 1, null);
select out_id from licitaciones.system_record_source_run('00000000-0000-0000-0000-0000000000f1'::uuid, 'guadalajara_ocds', 'ok', now(), now(), null, null, 'Ingesta de prueba', 1, 1, null);
do $$
begin
  if (select count(*) from licitaciones.tender where organization_id = '00000000-0000-0000-0000-0000000000f1' and source in ('yucatan_ocds','guadalajara_ocds')) <> 2 then
    raise exception 'se esperaban 2 tenders';
  end if;
  if (select count(*) from licitaciones.source_run where organization_id = '00000000-0000-0000-0000-0000000000f1' and source in ('yucatan_ocds','guadalajara_ocds')) <> 2 then
    raise exception 'se esperaban 2 source_run';
  end if;
end $$;
rollback;

\echo '--- 2. SIN MIGRAR, patron ANTERIOR al fix (sin SAVEPOINT): el INSERT de source_run viola 23514 y deja la transaccion abortada -- RECHAZADO ---'
begin;
alter table licitaciones.source_run drop constraint source_run_source_check;
alter table licitaciones.source_run add constraint source_run_source_check
  check (source in ('manual', 'comprasmx', 'dof', 'ocds_shcp', 'pdn_s6', 'state_portal', 'compras_mx_historico', 'nl_ocds', 'cdmx_ocds', 'aggregator'));
select out_id from licitaciones.system_ingest_tender('00000000-0000-0000-0000-0000000000f1'::uuid, 'Tender yucatan_ocds', null::timestamptz, 'yucatan_ocds', 'y-2', null, '{}'::text[], null::numeric, 'MXN', null, null);
-- as should_fail (23514 sobre source_run_source_check; ver nota de run-gate.mjs)
select out_id as should_fail from licitaciones.system_record_source_run('00000000-0000-0000-0000-0000000000f1'::uuid, 'yucatan_ocds', 'ok', now(), now(), null, null, 'Ingesta de prueba', 1, 1, null);
rollback;

\echo '--- 3. SIN MIGRAR + SAVEPOINT (runWithSavepointFallback): 23514 recuperado, el tender se CONSERVA, sin source_run, sesion utilizable ---'
begin;
alter table licitaciones.source_run drop constraint source_run_source_check;
alter table licitaciones.source_run add constraint source_run_source_check
  check (source in ('manual', 'comprasmx', 'dof', 'ocds_shcp', 'pdn_s6', 'state_portal', 'compras_mx_historico', 'nl_ocds', 'cdmx_ocds', 'aggregator'));
select out_id from licitaciones.system_ingest_tender('00000000-0000-0000-0000-0000000000f1'::uuid, 'Tender yucatan_ocds', null::timestamptz, 'yucatan_ocds', 'y-3', null, '{}'::text[], null::numeric, 'MXN', null, null);
savepoint sp_licitaciones_source_run_insert;
do $$
declare
  v_state text;
  v_constraint text;
begin
  begin
    perform * from licitaciones.system_record_source_run('00000000-0000-0000-0000-0000000000f1'::uuid, 'yucatan_ocds', 'ok', now(), now(), null, null, 'x', 1, 1, null);
    raise exception 'se esperaba 23514 (CHECK sin migrar), pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
    if v_state <> '23514' or v_constraint <> 'source_run_source_check' then
      raise exception 'se esperaba 23514/source_run_source_check pero fue % / %', v_state, v_constraint;
    end if;
  end;
end $$;
rollback to savepoint sp_licitaciones_source_run_insert;
release savepoint sp_licitaciones_source_run_insert;
do $$
begin
  if (select count(*) from licitaciones.tender where organization_id = '00000000-0000-0000-0000-0000000000f1' and source = 'yucatan_ocds' and external_id = 'y-3') <> 1 then
    raise exception 'el tender debia conservarse tras el SAVEPOINT';
  end if;
  if (select count(*) from licitaciones.source_run where organization_id = '00000000-0000-0000-0000-0000000000f1' and source = 'yucatan_ocds') <> 0 then
    raise exception 'no debia quedar source_run';
  end if;
end $$;
rollback;

\echo '--- 4. SIN MIGRAR: una fuente ya soportada (nl_ocds) sigue registrandose ---'
begin;
alter table licitaciones.source_run drop constraint source_run_source_check;
alter table licitaciones.source_run add constraint source_run_source_check
  check (source in ('manual', 'comprasmx', 'dof', 'ocds_shcp', 'pdn_s6', 'state_portal', 'compras_mx_historico', 'nl_ocds', 'cdmx_ocds', 'aggregator'));
select out_id from licitaciones.system_record_source_run('00000000-0000-0000-0000-0000000000f1'::uuid, 'nl_ocds', 'ok', now(), now(), null, null, 'Ingesta de prueba', 1, 1, null);
rollback;

\echo '--- 5. NEGATIVO: sesion autenticada (auth.uid() no nulo), aunque sea owner real -- RECHAZADA (42501, funcion de solo-sistema) ---'
begin;
-- as should_fail (ver nota del escenario 2).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select out_id as should_fail from licitaciones.system_record_source_run('00000000-0000-0000-0000-0000000000f1'::uuid, 'yucatan_ocds', 'ok', now(), now(), null, null, 'Ingesta de prueba', 1, 1, null);
rollback;

\echo '--- 6. NEGATIVO: anon -- sin EXECUTE ---'
begin;
-- as should_fail (ver nota del escenario 2).
set local role anon;
select out_id as should_fail from licitaciones.system_record_source_run('00000000-0000-0000-0000-0000000000f1'::uuid, 'yucatan_ocds', 'ok', now(), now(), null, null, 'Ingesta de prueba', 1, 1, null);
rollback;

\echo '--- 7a. CROSS-TENANT: owner de la Org B inserta source_run de la Org A -- RECHAZADO por RLS ---'
begin;
-- as should_fail (ver nota del escenario 2).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
insert into licitaciones.source_run (organization_id, source, state, started_at, finished_at, message)
  values ('00000000-0000-0000-0000-0000000000f1', 'yucatan_ocds', 'ok', now(), now(), 'cross-tenant');
rollback;

\echo '--- 7b. POSITIVO: owner de la Org A inserta su propio source_run yucatan_ocds (CHECK 028 + RLS) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
insert into licitaciones.source_run (organization_id, source, state, started_at, finished_at, message)
  values ('00000000-0000-0000-0000-0000000000f1', 'yucatan_ocds', 'ok', now(), now(), 'propio') returning id;
rollback;

\echo '--- 8. NEGATIVO: source desconocido sigue rechazado tras 028 (23514) ---'
begin;
-- as should_fail (ver nota del escenario 2).
select out_id as should_fail from licitaciones.system_record_source_run('00000000-0000-0000-0000-0000000000f1'::uuid, 'fuente_inexistente', 'ok', now(), now(), null, null, 'Ingesta de prueba', 1, 1, null);
rollback;
