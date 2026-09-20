-- FASE 3 (producto) — ZONA HORARIA POR NEGOCIO, parte hoteles: verifica contra
-- Postgres REAL (nunca el mirror en memoria de domain-hoteles, que jamás aplica
-- RLS/GRANT/triggers reales) que `packages/domain-hoteles/migrations/
-- 030_zona_horaria_property.sql` cierra lo que dice cerrar. Corre vía ./run.sh
-- (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI). Mismo patrón EXACTO
-- que scripts/verify-hoteles-motor-tarifas/assertions.sql (leído primero como
-- plantilla): fixtures persistentes (corren fuera de `begin/rollback`, como
-- superusuario o como el actor real cuya policy sí lo permite) + cada escenario en
-- su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten -- corren como el superusuario de la conexión, bypass RLS).
-- Mismo patrón/mismos roles que scripts/verify-hoteles-sql-critico/assertions.sql:
-- Hotel A (owner/gm/frontdesk) y Hotel B (owner ajeno, sin ninguna relación con
-- Hotel A) -- el caso "staff real pero de otra organización".
-- ---------------------------------------------------------------------------
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-zona-horaria'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-zona-horaria')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 2'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;

-- Fixture de property_config -- insertada como el superusuario de la conexión
-- (bypass RLS, mismo criterio que las filas de arriba), NUNCA usada para probar
-- RLS de escritura (eso lo cubren los escenarios 1-5 de abajo, cada uno con su
-- propio INSERT real bajo el rol/auth.uid() correspondiente) -- solo es el dato ya
-- persistido que los escenarios 6 (cross-tenant SELECT) y 8 (sesión de sistema)
-- necesitan leer.
insert into hoteles.property_config (property_id, organization_id, timezone) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Cancun')
on conflict (property_id) do update set timezone = excluded.timezone;

-- =============================================================================
-- (a) RLS/GRANT positivos -- owner/gm configuran su propia property.
-- =============================================================================

\echo '=== 1. owner configura la zona horaria de SU property -- upsert real (insert) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.property_config (property_id, organization_id, timezone)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Cancun')
on conflict (property_id) do update set timezone = excluded.timezone
returning timezone as deberia_ser_america_cancun;
rollback;

\echo '=== 2. gm puede ACTUALIZARLA despues (ON CONFLICT DO UPDATE, mismo nivel que owner) -- parte de la fixture ya persistida (America/Cancun) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
insert into hoteles.property_config (property_id, organization_id, timezone)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Tijuana')
on conflict (property_id) do update set timezone = excluded.timezone
returning timezone as deberia_ser_america_tijuana;
rollback;

\echo '=== 3. el trigger DERIVA/CONGELA organization_id desde core.property -- ignora un organization_id ajeno mandado por el cliente (usa una property DISTINTA, sin fixture previa, para probar el camino de INSERT limpio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.property_config (property_id, organization_id, timezone)
values ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000b001', 'America/Cancun')
returning organization_id as deberia_ser_org_a_no_org_b;
rollback;

-- =============================================================================
-- (b) RLS negativos -- frontdesk/anon/cross-tenant.
-- =============================================================================

\echo '=== 4. frontdesk NO puede configurar la zona horaria (fuera de can_manage_catalog) -- 0 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.property_config (property_id, organization_id, timezone)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Cancun')
on conflict (property_id) do nothing
returning 1 as should_fail;
rollback;

\echo '=== 5. owner de Hotel B (cross-tenant) NO puede configurar la property de Hotel A -- 0 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
insert into hoteles.property_config (property_id, organization_id, timezone)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Cancun')
on conflict (property_id) do nothing
returning 1 as should_fail;
rollback;

\echo '=== 6. owner de Hotel B tampoco puede LEER la zona de la property de Hotel A (cross-tenant, SELECT) -- 0 filas -- usa la fixture ya persistida arriba ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as deberia_ser_0 from hoteles.property_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 7. anon: rechazado por completo (lectura y escritura) ==='
begin;
set local role anon;
select count(*) as deberia_ser_0 from hoteles.property_config;
rollback;
begin;
set local role anon;
insert into hoteles.property_config (property_id, organization_id, timezone)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Cancun')
returning 1 as should_fail;
rollback;

-- =============================================================================
-- (c) sesión de SISTEMA (auth.uid() is null) -- insumo del JOIN de
--     listActiveHotelProperties() que corren los barridos de night-audit y
--     revenue-recommendations-cron (SIEMPRE bajo sesión de sistema, ver
--     apps/worker/src/jobs/hoteles/night-audit.ts /
--     apps/api/src/routes/verticals/hoteles/revenue-recommendations-cron.ts).
-- =============================================================================

\echo '=== 8. sesion de SISTEMA (auth.uid() is null) SI puede leer la fixture persistida arriba -- el barrido necesita el join, nunca cero filas en silencio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select p.id as property_id, pc.timezone as deberia_ser_america_cancun
  from core.property p
  left join hoteles.property_config pc on pc.property_id = p.id
 where p.id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

-- =============================================================================
-- (d) GRANT a nivel columna -- organization_id/property_id/created_at son
--     inmutables por UPDATE directo (solo `timezone` tiene GRANT de UPDATE).
-- =============================================================================

\echo '=== 9. UPDATE directo de organization_id (columna sin GRANT) es RECHAZADO por Postgres antes de llegar a RLS ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
do $$
begin
  begin
    update hoteles.property_config set organization_id = '00000000-0000-0000-0000-00000000b001' where property_id = '00000000-0000-0000-0000-0000000a1a01';
    raise exception 'se esperaba que el UPDATE de organization_id fallara por falta de GRANT de columna, pero no fallo';
  exception when insufficient_privilege then
    null; -- esperado.
  end;
end $$;
rollback;

-- =============================================================================
-- (e) Esquema de PRODUCCIÓN a medio migrar (030 no aplicada): SQLSTATE 42703/42P01
--     reales, recuperados con SAVEPOINT real -- mismo mecanismo EXACTO que
--     `runWithSavepointFallback` (@atiende/db) usa en producción para
--     `findPropertyTimezone`/`listActiveHotelProperties`. REGLA DURA DE
--     COMPATIBILIDAD del repo: mergear a main NO aplica esta migración a la base
--     real -- el código debe seguir funcionando (cayendo al default de
--     plataforma) mientras la columna/tabla no exista todavía. Cada DDL de abajo
--     corre dentro de un `begin/rollback` -- transaccional en Postgres, así que la
--     tabla real (con la fixture persistida al inicio) queda intacta al terminar.
-- =============================================================================

\echo '=== 10. con la columna hoteles.property_config.timezone ELIMINADA dentro de esta MISMA transaccion, la consulta REAL que findPropertyTimezone emitiria falla con SQLSTATE 42703 -- SAVEPOINT + ROLLBACK TO SAVEPOINT recupera la transaccion: la consulta siguiente, completamente ajena, SI corre (nunca 25P02) ==='
begin;
alter table hoteles.property_config drop column timezone;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
savepoint sp_verify_find_property_timezone;
do $$
declare
  v_state text;
  v_msg text;
  v_result text;
begin
  begin
    select timezone into v_result from hoteles.property_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
    raise exception 'se esperaba que la columna eliminada hiciera fallar esta consulta con SQLSTATE 42703, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703 (undefined_column), se obtuvo % con mensaje: %', v_state, v_msg;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_find_property_timezone;
release savepoint sp_verify_find_property_timezone;
-- Query completamente ajena, en la MISMA transaccion -- si el SAVEPOINT no hubiera
-- recuperado la transaccion, esto fallaria con 25P02 (in_failed_sql_transaction),
-- nunca con un resultado real. El código real, en este punto, cae al default de
-- plataforma (America/Mexico_City) -- nunca un 500.
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '=== 11. con hoteles.property_config ELIMINADA POR COMPLETO (42P01, tabla inexistente -- caso mas extremo que 42703), mismo mecanismo de SAVEPOINT recupera la transaccion ==='
begin;
drop table hoteles.property_config;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
savepoint sp_verify_property_config_missing;
do $$
declare
  v_state text;
begin
  begin
    perform 1 from hoteles.property_config limit 1;
    raise exception 'se esperaba que la tabla eliminada hiciera fallar esta consulta con SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01 (undefined_table), se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_property_config_missing;
release savepoint sp_verify_property_config_missing;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo ''
\echo '=== 12. tras las 2 corridas de DDL destructivo (escenarios 10/11), la tabla y su fixture SIGUEN intactas (DDL transaccional, revertido al rollback) ==='
select timezone as deberia_seguir_siendo_america_cancun from hoteles.property_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
