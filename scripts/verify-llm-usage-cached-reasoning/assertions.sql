-- Verifica, contra Postgres REAL (GRANT reales + `auth.uid()` real), la migración
-- `packages/db/migrations/0040_llm_usage_tokens_cached_reasoning.sql`:
--   * `core.record_llm_usage` acumula tokens_cached/tokens_reasoning y sigue aceptando la llamada de
--     10 argumentos (código anterior a la migración).
--   * El CHECK de vertical admite superadmin/plataforma/reportes y sigue rechazando cualquier otro.
--   * Se conserva el guard de solo-sistema (`auth.uid() is null`): staff con sesión real (incluso de otra
--     organización, cross-tenant) y `anon` son RECHAZADOS; `authenticated` no lee la tabla directo.
-- Cada escenario corre dentro de su propio `begin; ... rollback;` — nada persiste. `as should_fail` = el
-- gate espera ERROR; `deberia_ser_N` = el gate espera ese valor.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000b1', 'hoteles', 'Org tokens A', 'org-tokens-a'),
  ('00000000-0000-0000-0000-0000000000b2', 'restaurantes', 'Org tokens B (ajena)', 'org-tokens-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000b9', 'staff-tokens@example.com', 'Staff Tokens', 'seed')
on conflict do nothing;

\echo '=== 1. sesion de SISTEMA registra uso con tokens de cache y razonamiento (12 argumentos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'restaurantes', 'restaurantes:data_chat', 'openrouter:openai/gpt-6-luna', 'openai/gpt-6-luna', 'interactive', 1000, 200, 150, false, 600, 80);
rollback;

\echo '=== 2. dos llamadas del mismo dia ACUMULAN tokens_cached (600 + 300 = 900) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'restaurantes', 'restaurantes:data_chat', 'openrouter:openai/gpt-6-luna', 'openai/gpt-6-luna', 'interactive', 1000, 200, 150, false, 600, 80);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'restaurantes', 'restaurantes:data_chat', 'openrouter:openai/gpt-6-luna', 'openai/gpt-6-luna', 'interactive', 500, 100, 70, false, 300, 20);
reset role;
select tokens_cached as deberia_ser_900 from core.llm_usage_daily where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '=== 3. dos llamadas del mismo dia ACUMULAN tokens_reasoning (80 + 20 = 100) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'restaurantes', 'restaurantes:data_chat', 'openrouter:openai/gpt-6-luna', 'openai/gpt-6-luna', 'interactive', 1000, 200, 150, false, 600, 80);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'restaurantes', 'restaurantes:data_chat', 'openrouter:openai/gpt-6-luna', 'openai/gpt-6-luna', 'interactive', 500, 100, 70, false, 300, 20);
reset role;
select tokens_reasoning as deberia_ser_100 from core.llm_usage_daily where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '=== 4. COMPATIBILIDAD: la llamada de 10 argumentos (codigo anterior) sigue funcionando y deja cache en 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'hoteles', 'hoteles:data_chat', 'openrouter:openai/gpt-6-luna', 'openai/gpt-6-luna', 'interactive', 100, 50, 12, false);
reset role;
select tokens_cached as deberia_ser_0 from core.llm_usage_daily where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '=== 5. valores negativos de cache NO restan: se normalizan a 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'hoteles', 'hoteles:data_chat', 'openrouter:openai/gpt-6-luna', 'openai/gpt-6-luna', 'interactive', 100, 50, 12, false, -500, -9);
reset role;
select tokens_cached + tokens_reasoning as deberia_ser_0 from core.llm_usage_daily where organization_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '=== 6. el CHECK de vertical admite superadmin (rol superadmin:copiloto) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'superadmin', 'superadmin:copiloto', 'openrouter:anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5', 'interactive', 100, 50, 500, false, 0, 10);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'plataforma', 'plataforma:enrutador_turno', 'openrouter:openai/gpt-6-luna', 'openai/gpt-6-luna', 'interactive', 100, 50, 5, false);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'reportes', 'reportes:analisis_general', 'openrouter:qwen/qwen3-235b-a22b-2507', 'qwen/qwen3-235b-a22b-2507', 'batch', 100, 50, 5, false);
rollback;

\echo '=== 7. el CHECK de vertical sigue RECHAZANDO una vertical inventada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'inventada', 'inventada:rol', 'p', 'm', 'interactive', 1, 1, 1, false) as should_fail;
rollback;

\echo '=== 8. staff con sesion REAL de OTRA organizacion (cross-tenant) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b9', true);
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b2', 'restaurantes', 'restaurantes:data_chat', 'p', 'm', 'interactive', 1, 1, 1, false, 999999, 999999) as should_fail;
rollback;

\echo '=== 9. el rol anon NO puede ejecutar la funcion ==='
begin;
set local role anon;
select core.record_llm_usage('00000000-0000-0000-0000-0000000000b1', 'restaurantes', 'restaurantes:data_chat', 'p', 'm', 'interactive', 1, 1, 1, false, 1, 1) as should_fail;
rollback;

\echo '=== 10. authenticated NO lee core.llm_usage_daily directo (sin GRANT de tabla; solo funciones security definer) ==='
begin;
set local role authenticated;
select count(*) as should_fail from core.llm_usage_daily;
rollback;

\echo '=== listo: los escenarios 7/8/9/10 deben terminar en ERROR; el resto debe tener exito o devolver el valor deberia_ser_N ==='
