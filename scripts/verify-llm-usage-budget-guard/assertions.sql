-- Verifica, contra Postgres REAL (real GRANT + real `auth.uid()` — NO el
-- repositorio en memoria, que nunca aplica ninguno de los dos), el hallazgo de
-- revisión de PR sobre `packages/db/migrations/0010_llm_usage_budget_schema.sql`:
-- `core.record_llm_usage`/`core.reserve_llm_monthly_budget`/
-- `core.settle_llm_monthly_budget` son `security definer` + GRANT a
-- `authenticated`, reciben `organization_id` como parámetro plano, y viven en
-- el schema `core` — expuesto por PostgREST vía
-- `supabase/config.toml::api.schemas`. Sin el guard `auth.uid() is not null ->
-- 42501` que esta migración agrega, cualquier sesión `authenticated` (staff de
-- CUALQUIER tenant, vía RPC directo) podía invocarlas con la organización de
-- OTRO tenant e inflar su gasto o agotar su tope mensual — o el tope GLOBAL de
-- plataforma, compartido entre todas las organizaciones — denegación de
-- servicio real del LLM.
--
-- Cada escenario corre dentro de su propio `begin; ... rollback;` — nada de
-- esto persiste. Mismo formato que scripts/verify-outbox-grants/assertions.sql
-- (`as should_fail` = el runner de CI espera que la sentencia ERROR; sin ese
-- alias, espera que tenga éxito).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'hoteles', 'Org gasto-api A', 'org-gasto-api-a'),
  ('00000000-0000-0000-0000-0000000000a2', 'restaurantes', 'Org gasto-api B (ajena)', 'org-gasto-api-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000a9', 'staff-gasto-api@example.com', 'Staff Gasto API', 'seed')
on conflict do nothing;

\echo '=== 1. record_llm_usage: sesion de SISTEMA (auth.uid() IS NULL) SI puede registrar uso ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000a1', 'hoteles', 'hoteles:whatsapp_agent', 'anthropic', 'claude-x', 'interactive', 100, 50, 12000, false);
rollback;

\echo '=== 2. record_llm_usage: staff con sesion REAL (auth.uid() no nulo) es RECHAZADO, aunque sea de la MISMA organizacion que intenta registrar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a9', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000a1', 'hoteles', 'hoteles:whatsapp_agent', 'anthropic', 'claude-x', 'interactive', 100, 50, 12000, false) as should_fail;
rollback;

\echo '=== 3. reserve_llm_monthly_budget: sesion de SISTEMA SI puede reservar tope mensual ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-0000000000a1', 'res-guard-1', 5000);
rollback;

\echo '=== 4. reserve_llm_monthly_budget: staff con sesion REAL es RECHAZADO -- el hueco real: sin este guard podia reservar (agotar tope) contra la organizacion de OTRO tenant por RPC directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a9', true);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-0000000000a2', 'res-guard-abuso', 999999999999) as should_fail;
rollback;

\echo '=== 5. settle_llm_monthly_budget: sesion de SISTEMA SI puede liquidar (flujo completo reserve+settle, ambos bajo sesion de sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.reserve_llm_monthly_budget('00000000-0000-0000-0000-0000000000a1', 'res-guard-2', 5000);
select core.settle_llm_monthly_budget('res-guard-2', 4000);
rollback;

\echo '=== 6. settle_llm_monthly_budget: staff con sesion REAL es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a9', true);
select core.settle_llm_monthly_budget('res-guard-cualquiera', 0) as should_fail;
rollback;
