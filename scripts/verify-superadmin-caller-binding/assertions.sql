-- Verifica, contra Postgres REAL (real GRANT + real `auth.uid()` — NO el
-- repositorio en memoria, que nunca aplica ninguno de los dos), el hallazgo de
-- seguridad de `packages/db/migrations/0011_superadmin_caller_binding.sql`:
-- las 12 funciones `security definer` del back office de plataforma
-- (`core.*_for_superadmin`) reciben `p_caller_id` como parámetro plano y
-- autorizan con `core.is_platform_superadmin(p_caller_id)` — SIN atar ese
-- parámetro a `auth.uid()` (la identidad real de la sesión Postgres) antes de
-- este fix. `core` está expuesto por PostgREST vía
-- `supabase/config.toml::api.schemas`, y las 12 funciones tienen
-- `grant execute ... to authenticated` — así que cualquier sesión
-- `authenticated` (staff de CUALQUIER tenant, o una sesión de SISTEMA que
-- olvidara bindear el caller) podía invocarlas con el UUID de un superadmin
-- real como `p_caller_id` y leer/escribir datos de PLATAFORMA completa.
--
-- Cubre, con al menos un representante de LECTURA y uno de ESCRITURA por cada
-- migración fuente: `0010_platform_superadmin.sql`
-- (`list_all_organizations_for_superadmin`), `0012_superadmin_prospectos.sql`
-- (`create_prospecto_for_superadmin`), `0014_superadmin_demo_access.sql`
-- (`ensure_demo_access_for_superadmin`) y las funciones de back office de
-- `0010_llm_usage_budget_schema.sql` (`get_llm_usage_summary_for_superadmin`/
-- `set_llm_org_monthly_cap_for_superadmin`) — las 7 restantes comparten
-- LITERALMENTE el mismo guard (`auth.uid() is not null and auth.uid() =
-- p_caller_id`) en el mismo archivo de migración, así que no se repiten aquí
-- escenario por escenario (ver el comentario de cabecera de
-- `0011_superadmin_caller_binding.sql` para la lista completa de las 12).
--
-- Cada escenario corre dentro de su propio `begin; ... rollback;` — nada de
-- esto persiste salvo las 5 filas de fixture insertadas antes (organización,
-- staff, superadmin, membership, un registro de uso de LLM real). Mismo
-- formato que scripts/verify-llm-usage-budget-guard/assertions.sql
-- (`as should_fail` = el runner de CI espera que la sentencia ERROR;
-- `as deberia_ser_N` = el runner espera que la columna así nombrada valga
-- exactamente N; sin ninguno de los dos, espera éxito sin chequear un valor
-- puntual).
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures (persisten para TODOS los escenarios de abajo, nunca dentro de un
-- begin/rollback que los revierta):
--   - org-binding-a / org-binding-b: dos organizaciones de plataforma.
--   - superadmin-binding: superadmin REAL (fila en core.platform_superadmin).
--   - staff-binding: staff normal, CON membership en org-binding-a (por lo
--     tanto NO superadmin) — el "atacante" de estos escenarios: un usuario
--     real y autenticado, pero de ningún modo autorizado para el back office
--     de plataforma.
--   - un registro real de gasto de LLM en org-binding-a (tokens_in = 1234) —
--     para poder demostrar que un caller no autorizado NO ve el número real
--     (fuga de datos), no solo que "falla".
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000b1', 'hoteles', 'Org binding A', 'org-binding-a'),
  ('00000000-0000-0000-0000-0000000000b2', 'restaurantes', 'Org binding B', 'org-binding-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000b9', 'superadmin-binding@example.com', 'Superadmin Binding', 'seed'),
  ('00000000-0000-0000-0000-0000000000ba', 'staff-binding@example.com', 'Staff Binding (atacante)', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000000b9')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000ba', '00000000-0000-0000-0000-0000000000b1', null, 'owner', 'owner')
on conflict do nothing;

insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, tokens_in, tokens_out, cost_micro_usd, call_count, fallback_call_count) values
  ('00000000-0000-0000-0000-0000000000b1', current_date, 'hoteles', 'hoteles:whatsapp_agent', 'anthropic', 'claude-x', 'interactive', 1234, 500, 90000, 10, 0)
on conflict do nothing;

-- ═══ 0010_platform_superadmin.sql — core.list_all_organizations_for_superadmin ═══

\echo '=== 1. list_all_organizations_for_superadmin: el superadmin real, con SU PROPIA sesion (auth.uid() = su propio id), SI ve las organizaciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b9', true);
select count(*) as deberia_ser_2 from core.list_all_organizations_for_superadmin('00000000-0000-0000-0000-0000000000b9');
rollback;

\echo '=== 2. list_all_organizations_for_superadmin: un staff NORMAL (auth.uid() real, sin ser superadmin) que pasa el UUID del superadmin como p_caller_id obtiene CERO filas -- el hueco real: antes de este fix esto devolvia TODAS las organizaciones de la plataforma ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ba', true);
select count(*) as deberia_ser_0 from core.list_all_organizations_for_superadmin('00000000-0000-0000-0000-0000000000b9');
rollback;

\echo '=== 3. list_all_organizations_for_superadmin: sesion de SISTEMA (auth.uid() NULL) pasando el UUID del superadmin como p_caller_id obtiene CERO filas -- este es EXACTAMENTE el patron que apps/api usaba ANTES de este fix (withAppSession({userId:null})); demuestra la defensa en profundidad a nivel de base de datos, independiente de que la API este bien escrita ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_all_organizations_for_superadmin('00000000-0000-0000-0000-0000000000b9');
rollback;

\echo '=== 4. list_all_organizations_for_superadmin: anon NO puede ni ejecutar la funcion (sin GRANT EXECUTE) ==='
begin;
set local role anon;
select * from core.list_all_organizations_for_superadmin('00000000-0000-0000-0000-0000000000b9') as should_fail;
rollback;

-- ═══ 0010_llm_usage_budget_schema.sql (back office) — core.get_llm_usage_summary_for_superadmin ═══

\echo '=== 5. get_llm_usage_summary_for_superadmin: el superadmin real ve el gasto REAL (tokens_in = 1234) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b9', true);
select tokens_in as deberia_ser_1234 from core.get_llm_usage_summary_for_superadmin('00000000-0000-0000-0000-0000000000b9', current_date - 7, current_date + 1);
rollback;

\echo '=== 6. get_llm_usage_summary_for_superadmin: un staff NORMAL que pasa el UUID del superadmin ve CERO -- nunca el numero real (sin fuga de gasto de otro tenant/de plataforma) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ba', true);
select tokens_in as deberia_ser_0 from core.get_llm_usage_summary_for_superadmin('00000000-0000-0000-0000-0000000000b9', current_date - 7, current_date + 1);
rollback;

\echo '=== 7. get_llm_usage_summary_for_superadmin: sesion de SISTEMA pasando el UUID del superadmin tambien ve CERO -- mismo criterio que el escenario 3 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select tokens_in as deberia_ser_0 from core.get_llm_usage_summary_for_superadmin('00000000-0000-0000-0000-0000000000b9', current_date - 7, current_date + 1);
rollback;

-- ═══ 0012_superadmin_prospectos.sql — core.create_prospecto_for_superadmin ═══

\echo '=== 8. create_prospecto_for_superadmin: el superadmin real, con su propia sesion, SI puede crear un prospecto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b9', true);
select core.create_prospecto_for_superadmin('00000000-0000-0000-0000-0000000000b9', 'Empresa de prueba', 'hoteles', null, null, null, null, null, null);
rollback;

\echo '=== 9. create_prospecto_for_superadmin: un staff NORMAL que pasa el UUID del superadmin es RECHAZADO -- el hueco real: antes de este fix creaba el prospecto (con creado_por = el superadmin suplantado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ba', true);
select core.create_prospecto_for_superadmin('00000000-0000-0000-0000-0000000000b9', 'Empresa suplantada', 'hoteles', null, null, null, null, null, null) as should_fail;
rollback;

\echo '=== 10. create_prospecto_for_superadmin: sesion de SISTEMA pasando el UUID del superadmin tambien es RECHAZADA -- mismo criterio que el escenario 3 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.create_prospecto_for_superadmin('00000000-0000-0000-0000-0000000000b9', 'Empresa suplantada sistema', 'hoteles', null, null, null, null, null, null) as should_fail;
rollback;

\echo '=== 11. create_prospecto_for_superadmin: anon NO puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.create_prospecto_for_superadmin('00000000-0000-0000-0000-0000000000b9', 'Empresa anon', 'hoteles', null, null, null, null, null, null) as should_fail;
rollback;

-- ═══ 0014_superadmin_demo_access.sql — core.ensure_demo_access_for_superadmin ═══

\echo '=== 12. ensure_demo_access_for_superadmin: el superadmin real, con su propia sesion, SI puede entrar a un panel demo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b9', true);
select demo_slug from core.ensure_demo_access_for_superadmin('00000000-0000-0000-0000-0000000000b9', 'licitaciones');
rollback;

\echo '=== 13. ensure_demo_access_for_superadmin: un staff NORMAL que pasa el UUID del superadmin es RECHAZADO -- el hueco real: antes de este fix le daba membership real (como el superadmin suplantado) en la organizacion demo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ba', true);
select core.ensure_demo_access_for_superadmin('00000000-0000-0000-0000-0000000000b9', 'licitaciones') as should_fail;
rollback;

-- ═══ 0010_llm_usage_budget_schema.sql (back office) — core.set_llm_org_monthly_cap_for_superadmin ═══

\echo '=== 14. set_llm_org_monthly_cap_for_superadmin: el superadmin real, con su propia sesion, SI puede fijar el tope de una organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b9', true);
select core.set_llm_org_monthly_cap_for_superadmin('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000b1', 500000000, 80);
rollback;

\echo '=== 15. set_llm_org_monthly_cap_for_superadmin: un staff NORMAL que pasa el UUID del superadmin es RECHAZADO -- el hueco real: antes de este fix podia fijar (o vaciar) el tope mensual de CUALQUIER organizacion, o el de plataforma completa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ba', true);
select core.set_llm_org_monthly_cap_for_superadmin('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000b1', 1, 80) as should_fail;
rollback;
