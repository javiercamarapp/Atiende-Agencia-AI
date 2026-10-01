-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales -- nunca el
-- repositorio en memoria de packages/db/src/authz-audit-repository.ts, que no
-- aplica ninguno de los dos), los requisitos de seguridad no negociables de
-- packages/db/migrations/0021_superadmin_authz_audit_log.sql:
--
--   1. `core.record_authz_audit_denial` es de SOLO SISTEMA -- rechaza
--      cualquier llamada con `auth.uid()` NO nulo (28000).
--   2. `anon` no puede ni ejecutar la función de escritura (sin GRANT EXECUTE).
--   3. `decision`/`reason` inválidos -- rechazados (22023) ANTES del INSERT.
--   4. Camino feliz: sesión de sistema inserta una fila real -- `id` no nulo.
--   5. La fila insertada es visible para OTRO superadmin real vía
--      `core.list_authz_audit_log_for_superadmin` (oversight de plataforma).
--   6. Un staff con membership real (NO superadmin) NO ve nada -- ni siquiera
--      las filas fixture ya sembradas -- vía la función de lectura.
--   7. Caller-binding: `auth.uid()` debe coincidir con `p_caller_id` en la
--      lectura -- pasar el uuid de OTRO superadmin como parámetro no filtra
--      nada ajeno.
--   8. `anon` no puede ni ejecutar la función de lectura.
--   9. Bitácora append-only: ni UPDATE ni DELETE, para NADIE, ni siquiera
--      `service_role` -- ni tampoco un INSERT/SELECT directo (sin pasar por
--      las funciones) desde `authenticated` ni `anon`.
--  10. SELECT directo (RLS): un staff normal ve 0 filas, un superadmin real
--      ve todas -- misma policy que ya prueba la función de lectura, pero
--      ejercitada como SELECT crudo, no solo a través de la función.
--  11. Tope defensivo de ráfaga: con la ventana móvil ya al tope, la función
--      de escritura descarta el INSERT en silencio (`id` NULL, sin lanzar).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de eso
-- persiste salvo las filas de fixture insertadas antes (directas, como el
-- superusuario `postgres` que corre este script -- mismo criterio que el
-- resto de scripts/verify-*/assertions.sql).
\set ON_ERROR_STOP off
\pset pager off

-- ═══════════════════════════════════════════════════════════════════════════
-- Fixtures (persisten para TODOS los escenarios de abajo)
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000aa000', 'restaurantes', 'Org Auditoría Denegaciones', 'org-auditoria-denegaciones')
on conflict do nothing;

-- superadmin-1/2: dos superadmins REALES (core.platform_superadmin) --
-- superadmin-2 nunca escribe nada, solo se usa para probar oversight
-- ("ve lo que otro insertó") y caller-binding.
-- staff-normal: staff real, member de la organización de arriba, NUNCA
-- superadmin -- el caso "no lee nada, ni lo suyo ni lo ajeno".
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000aa100', 'superadmin-aud-1@example.com', 'Superadmin Auditoría 1', 'seed'),
  ('00000000-0000-0000-0000-0000000aa101', 'superadmin-aud-2@example.com', 'Superadmin Auditoría 2', 'seed'),
  ('00000000-0000-0000-0000-0000000aa102', 'staff-normal-aud@example.com', 'Staff Normal Auditoría', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000aa100'),
  ('00000000-0000-0000-0000-0000000aa101')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000aa102', '00000000-0000-0000-0000-0000000aa000', null, 'member', 'staff')
on conflict do nothing;

-- Dos filas insertadas DIRECTO (como el superusuario que corre este script --
-- la función security definer no aplica aquí, solo se ejercitan la lectura/
-- RLS/bloqueo de mutación sobre estas filas).
insert into core.authz_audit_log (id, actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, metadata, occurred_at) values
  ('00000000-0000-0000-0000-0000000aa400', '00000000-0000-0000-0000-0000000aa102', '203.0.113.7', '00000000-0000-0000-0000-0000000aa000', 'admin:access', '/superadmin/fixture-a', 'POST', 'denied', 'no_membership', '{}'::jsonb, now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-0000000aa401', null, '203.0.113.8', null, 'admin:access', '/superadmin/fixture-b', 'GET', 'denied', 'insufficient_role', '{}'::jsonb, now() - interval '1 minute')
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) core.record_authz_audit_denial -- solo sistema, decision/reason válidos
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 1. record_authz_audit_denial: auth.uid() NO nulo (staff-normal autenticado) -- RECHAZADO (solo sesión de sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa102', true);
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa102', '203.0.113.9', null, 'admin:access', '/superadmin/x', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) as should_fail;
rollback;

\echo '=== 2. record_authz_audit_denial: anon no puede ni ejecutar la función (sin GRANT EXECUTE) -- RECHAZADO ==='
begin;
set local role anon;
select core.record_authz_audit_denial(null, '203.0.113.9', null, 'admin:access', '/superadmin/x', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) as should_fail;
rollback;

\echo '=== 3. record_authz_audit_denial: decision inválida -- RECHAZADO (22023) antes de insertar ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial(null, '203.0.113.9', null, 'admin:access', '/superadmin/x', 'POST', 'bogus', 'no_membership', '{}'::jsonb, now()) as should_fail;
rollback;

\echo '=== 4. record_authz_audit_denial: reason inválido -- RECHAZADO (22023) antes de insertar ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial(null, '203.0.113.9', null, 'admin:access', '/superadmin/x', 'POST', 'denied', 'razon_que_no_existe', '{}'::jsonb, now()) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Camino feliz + oversight de plataforma + caller-binding en la lectura
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 5. record_authz_audit_denial: sesión de sistema (auth.uid() NULL), entrada VÁLIDA -- inserta y devuelve un id real (nunca NULL) ==='
begin;
set local role authenticated;
select (core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa102', '203.0.113.50', '00000000-0000-0000-0000-0000000aa000', 'admin:access', '/superadmin/camino-feliz', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) is not null)::int as deberia_ser_1;
rollback;

\echo '=== 6. Oversight de plataforma: la fila que insertó la sesión de sistema es visible para OTRO superadmin real (superadmin-2, que nunca la insertó) ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa102', '203.0.113.50', '00000000-0000-0000-0000-0000000aa000', 'admin:access', '/superadmin/camino-feliz-6', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) as id \gset aud6_
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa101', true);
select (count(*) >= 1)::int as deberia_ser_1 from core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa101', 500, 0) where id = :'aud6_id';
rollback;

\echo '=== 7. Un staff con membership real (NO superadmin) NO ve NADA vía la función de lectura -- ni siquiera las 2 filas fixture ya sembradas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa102', true);
select count(*) as deberia_ser_0 from core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa102', 500, 0);
rollback;

\echo '=== 8. Caller-binding en la lectura: auth.uid()=superadmin-1 pero p_caller_id=superadmin-2 (OTRO real) -- 0 filas, nunca filtra por el parámetro ajeno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa100', true);
select count(*) as deberia_ser_0 from core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa101', 500, 0);
rollback;

\echo '=== 9. list_authz_audit_log_for_superadmin: anon no puede ni ejecutar la función -- RECHAZADO (sin GRANT EXECUTE) ==='
begin;
set local role anon;
select core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa100', 500, 0) as should_fail;
rollback;

\echo '=== 10. Un superadmin real ve las 2 filas fixture (al menos) vía la función de lectura -- oversight real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa100', true);
select (count(*) >= 2)::int as deberia_ser_1 from core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa100', 500, 0);
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Append-only real -- ni un UPDATE/DELETE/INSERT/SELECT directo indebido
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 11. authz_audit_log: UPDATE directo está bloqueado incluso para service_role ==='
begin;
-- as should_fail (el trigger de bloqueo, no un alias -- UPDATE no admite
-- `as` sobre la sentencia completa; este comentario, DENTRO del bloque
-- begin;/rollback;, es lo que el runner automático detecta para marcar el
-- escenario como "debe terminar en ERROR").
set local role service_role;
update core.authz_audit_log set route = '/alterado' where id = '00000000-0000-0000-0000-0000000aa400';
rollback;

\echo '=== 12. authz_audit_log: DELETE directo está bloqueado incluso para service_role ==='
begin;
-- as should_fail (ver nota del escenario 11 -- DELETE tampoco admite `as`
-- sobre la sentencia completa).
set local role service_role;
delete from core.authz_audit_log where id = '00000000-0000-0000-0000-0000000aa400';
rollback;

\echo '=== 13. authz_audit_log: INSERT directo desde authenticated (sin pasar por la función) -- RECHAZADO (sin policy de escritura) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario es lo que el runner automático detecta).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa102', true);
insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason)
values ('00000000-0000-0000-0000-0000000aa102', '203.0.113.9', null, 'admin:access', '/superadmin/insert-directo', 'POST', 'denied', 'no_membership');
rollback;

\echo '=== 14. authz_audit_log: INSERT directo desde anon -- RECHAZADO (sin GRANT) ==='
begin;
-- as should_fail (mismo motivo que 13).
set local role anon;
insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason)
values (null, '203.0.113.9', null, 'admin:access', '/superadmin/insert-anon', 'POST', 'denied', 'no_membership');
rollback;

\echo '=== 15. authz_audit_log: SELECT directo desde anon -- RECHAZADO (sin GRANT, ni siquiera llega a evaluar RLS) ==='
begin;
-- as should_fail (sin GRANT SELECT a anon -- "permission denied", nunca una
-- lista vacía silenciosa; ver revoke all ... from public, anon, authenticated,
-- service_role de la migración).
set local role anon;
select * from core.authz_audit_log as should_fail;
rollback;

\echo '=== 16. authz_audit_log: SELECT directo (RLS) como staff normal -- 0 filas, RLS filtra en silencio (no un error) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa102', true);
select count(*) as deberia_ser_0 from core.authz_audit_log;
rollback;

\echo '=== 17. authz_audit_log: SELECT directo (RLS) como superadmin real -- ve las filas fixture (al menos 2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000aa100', true);
select (count(*) >= 2)::int as deberia_ser_1 from core.authz_audit_log;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) Tope defensivo POR ACTOR + GLOBAL, marcador de desborde (endurecimiento
--    de esta ronda -- packages/db/migrations/
--    0022_superadmin_bitacoras_endurecimiento.sql, ver su cabecera para el
--    razonamiento completo). Hallazgo que reemplaza: el tope de la versión
--    anterior (5000 filas/10 min, GLOBAL a secas) se podía agotar con una
--    sola cuenta autenticada variando de ruta -- desde ahí, las
--    denegaciones de TODOS los demás actores se perdían en silencio durante
--    el resto de la ventana. Se verifica aquí:
--
--      18. Tope POR ACTOR alcanzado (500/10min) -- descarta EN SILENCIO
--          (id NULL, nunca lanza).
--      19. ... e inserta UN marcador de desborde (nunca uno por evento), Y
--          afirma su CONTENIDO: `actor_key`/`actor_user_id` correctos,
--          `windowMinutes` = 10 y `metadata.rowsInWindowAtOverflow` = 500
--          EXACTAS (re-revisión: ese campo es cuántas filas YA había en la
--          ventana al momento del tope, NUNCA "cuántas se descartaron" -- lo
--          descartado en ese instante siempre es 1; nunca lleva la llave
--          vieja `discardedAtLeast`, que sí afirmaba estar contando
--          descartes cuando no lo hacía).
--      20. DOS intentos denegados del MISMO actor en la MISMA ventana -- el
--          marcador NUNCA se duplica (sigue habiendo exactamente 1).
--      21. Un actor DISTINTO, muy por debajo de su propio tope -- NO
--          afectado por el tope agotado del actor de arriba (la corrección
--          real de este hallazgo).
--      22. Tope GLOBAL alcanzado (20000/10min, última red) -- descarta EN
--          SILENCIO incluso para un actor que jamás se acercó a su propio
--          tope por actor.
--      23. ... e inserta UN marcador de desborde GLOBAL, con el mismo
--          contenido verificado que el escenario 19 (`windowMinutes`,
--          `rowsInWindowAtOverflow` capturado dinámicamente antes de la
--          llamada, sin la llave vieja `discardedAtLeast`).
--      24. DOS intentos cualquiera (incluso de actores distintos), misma
--          ventana -- el marcador global NUNCA se duplica.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000aa500', 'actor-tope-por-actor@example.com', 'Actor Tope Por Actor', 'seed'),
  ('00000000-0000-0000-0000-0000000aa501', 'actor-no-afectado@example.com', 'Actor No Afectado', 'seed')
on conflict do nothing;

-- 500 filas para UN solo actor -- exactamente `c_max_per_actor_window` de la
-- función (ver la migración). Deliberadamente DESPUÉS de todos los
-- escenarios de arriba (que cuentan filas exactas/aproximadas): esta ráfaga
-- persiste para el resto del script.
insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, occurred_at)
select '00000000-0000-0000-0000-0000000aa500', null, null, 'admin:access', '/superadmin/rafaga-actor', 'POST', 'denied', 'rate_limited', now()
from generate_series(1, 500);

\echo '=== 18. record_authz_audit_denial: tope POR ACTOR alcanzado (500/10min) -- descarta el INSERT EN SILENCIO (id NULL, nunca lanza) ==='
begin;
set local role authenticated;
select (core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa500', null, null, 'admin:access', '/superadmin/rafaga-actor-una-mas', 'POST', 'denied', 'rate_limited', '{}'::jsonb, now()) is null)::int as deberia_ser_1;
rollback;

\echo '=== 19. ... inserta EXACTAMENTE UN marcador de desborde por-actor (nunca uno por evento descartado), con actor_key/metadata correctos (re-revisión: metadata.rowsInWindowAtOverflow es cuántas filas YA había en la ventana al momento del tope, NUNCA "cuántas se descartaron" -- lo descartado en ese instante es siempre 1) ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa500', null, null, 'admin:access', '/superadmin/rafaga-actor-marca', 'POST', 'denied', 'rate_limited', '{}'::jsonb, now());
-- `reset role` -- vuelve a `postgres` (bypassa RLS) SOLO para poder contar
-- filas directamente; la función de escritura ya corrió como sistema
-- (auth.uid() NULL) arriba, esto no es parte de lo que se está probando.
reset role;
select count(*) as deberia_ser_1 from core.authz_audit_log where actor_user_id = '00000000-0000-0000-0000-0000000aa500' and reason = 'audit_capacity_overflow_actor';
-- Contenido exacto de la fila marcador -- no solo su existencia: la llave
-- de actor correcta (nunca la de otro), `windowMinutes` = 10 (constante de
-- la función), y `rowsInWindowAtOverflow` = 500 EXACTAS (las 500 filas ya
-- persistidas para este actor por el fixture de arriba, el mismo `count(*)`
-- que la función usó para decidir el tope -- NUNCA 1, que sería el valor
-- si el campo de verdad contara "lo descartado en este instante").
select (
  m.reason = 'audit_capacity_overflow_actor'
  and m.actor_user_id = '00000000-0000-0000-0000-0000000aa500'
  and m.actor_key = '00000000-0000-0000-0000-0000000aa500'
  and (m.metadata ->> 'windowMinutes')::int = 10
  and (m.metadata ->> 'rowsInWindowAtOverflow')::bigint = 500
  and not (m.metadata ? 'discardedAtLeast')
)::int as deberia_ser_1
from core.authz_audit_log m
where m.actor_user_id = '00000000-0000-0000-0000-0000000aa500' and m.reason = 'audit_capacity_overflow_actor';
rollback;

\echo '=== 20. ... DOS intentos denegados del mismo actor en la MISMA transacción -- ambos descartan EN SILENCIO Y el marcador NUNCA se duplica (sigue siendo exactamente 1) ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa500', null, null, 'admin:access', '/superadmin/rafaga-actor-otra-mas-1', 'POST', 'denied', 'rate_limited', '{}'::jsonb, now());
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa500', null, null, 'admin:access', '/superadmin/rafaga-actor-otra-mas-2', 'POST', 'denied', 'rate_limited', '{}'::jsonb, now());
reset role;
select count(*) as deberia_ser_1 from core.authz_audit_log where actor_user_id = '00000000-0000-0000-0000-0000000aa500' and reason = 'audit_capacity_overflow_actor';
rollback;

\echo '=== 21. record_authz_audit_denial: un actor DISTINTO, muy por debajo de su propio tope -- NUNCA afectado por el tope agotado de otro actor (la corrección real de este hallazgo) ==='
begin;
set local role authenticated;
select (core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa501', null, null, 'admin:access', '/superadmin/actor-no-afectado', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) is not null)::int as deberia_ser_1;
rollback;

-- 40 actores DISTINTOS, cada uno MUY por debajo de su propio tope por-actor
-- (490 < 500), pero cuya suma (19600) sumada a lo de arriba (~502) supera el
-- tope GLOBAL (20000, "última red") -- el escenario que un tope solo-por-
-- actor NUNCA cubriría (muchos actores DISTINTOS en paralelo, no uno solo
-- insistiendo).
do $$
declare i int;
begin
  for i in 1..40 loop
    insert into core.staff_user (id, email, full_name, created_via)
    values (('00000000-0000-0000-0000-0000000ab' || lpad(i::text, 3, '0'))::uuid, 'bulk-global-' || i || '@example.com', 'Bulk Global ' || i, 'seed')
    on conflict do nothing;
    insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, occurred_at)
    select ('00000000-0000-0000-0000-0000000ab' || lpad(i::text, 3, '0'))::uuid, null, null, 'admin:access', '/superadmin/rafaga-global', 'GET', 'denied', 'no_membership', now()
    from generate_series(1, 490);
  end loop;
end $$;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000aa502', 'actor-tope-global@example.com', 'Actor Tope Global', 'seed')
on conflict do nothing;

\echo '=== 22. record_authz_audit_denial: tope GLOBAL alcanzado (20000/10min) -- descarta EN SILENCIO incluso para un actor que jamás se acercó a su propio tope por-actor ==='
begin;
set local role authenticated;
select (core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa502', null, null, 'admin:access', '/superadmin/tope-global', 'POST', 'denied', 'no_membership', '{}'::jsonb, now()) is null)::int as deberia_ser_1;
rollback;

\echo '=== 23. ... inserta EXACTAMENTE UN marcador de desborde GLOBAL, con metadata correcta (re-revisión: rowsInWindowAtOverflow es cuántas filas YA había en la ventana, NUNCA "cuántas se descartaron") ==='
begin;
-- Capturado ANTES de llamar a la función, todavía como `postgres` (sin RLS
-- de por medio) -- exactamente el mismo `count(*)` que la función calculará
-- adentro para decidir el tope GLOBAL, así el assert no depende de
-- hardcodear cuántas filas dejaron los fixtures de arriba.
select count(*) as n from core.authz_audit_log where occurred_at > now() - make_interval(mins => 10) \gset antes_
set local role authenticated;
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa502', null, null, 'admin:access', '/superadmin/tope-global-marca', 'POST', 'denied', 'no_membership', '{}'::jsonb, now());
reset role;
select count(*) as deberia_ser_1 from core.authz_audit_log where reason = 'audit_capacity_overflow_global';
select (
  m.reason = 'audit_capacity_overflow_global'
  and (m.metadata ->> 'windowMinutes')::int = 10
  and (m.metadata ->> 'rowsInWindowAtOverflow')::bigint = :antes_n
  and not (m.metadata ? 'discardedAtLeast')
)::int as deberia_ser_1
from core.authz_audit_log m
where m.reason = 'audit_capacity_overflow_global';
rollback;

\echo '=== 24. ... DOS intentos cualquiera (incluso de actores DISTINTOS), misma transacción -- ambos descartan EN SILENCIO Y el marcador global NUNCA se duplica (sigue siendo exactamente 1) ==='
begin;
set local role authenticated;
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa501', null, null, 'admin:access', '/superadmin/tope-global-otra-mas-1', 'POST', 'denied', 'no_membership', '{}'::jsonb, now());
select core.record_authz_audit_denial('00000000-0000-0000-0000-0000000aa502', null, null, 'admin:access', '/superadmin/tope-global-otra-mas-2', 'POST', 'denied', 'no_membership', '{}'::jsonb, now());
reset role;
select count(*) as deberia_ser_1 from core.authz_audit_log where reason = 'audit_capacity_overflow_global';
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) BASE SIN MIGRAR -- el encargo del PR #172 pedía esto explícitamente y no
--    se entregó (ver review de esa ronda): escenarios que, DENTRO del
--    fixture y en una transacción que se revierte, deshacen lo que
--    producción aún no tiene, y afirman el SQLSTATE EXACTO que
--    packages/db/src/authz-audit-repository.ts espera
--    (`isMigrationMissingError`: 42883/42P01/42703) -- nunca solo "algo
--    truena", el código real. Cada escenario es un bloque `do $$ ... $$`
--    que ATRAPA el error con `exception when others`, compara
--    `returned_sqlstate` (`get stacked diagnostics`) contra el código
--    esperado, y solo entonces decide si re-lanzar (si el código NO
--    coincide, `do` SÍ propaga un error real -- el runner automático de
--    scripts/verify-real-postgres-ci/run-gate.mjs lo marca FAIL igual que
--    cualquier otro escenario sin alias que termine en ERROR inesperado).
--    Un escenario que SÍ pasa completa el `begin;...rollback;` SIN ningún
--    error visible desde afuera -- la comprobación ya ocurrió adentro.
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 25. Base sin migrar -- record_authz_audit_denial NO existe (función eliminada dentro de la transacción) -- SQLSTATE EXACTO 42883 ==='
begin;
drop function core.record_authz_audit_denial(uuid, text, uuid, text, text, text, text, text, jsonb, timestamptz);
do $$
declare v_sqlstate text;
begin
  begin
    perform core.record_authz_audit_denial(null, null, null, 'admin:access', '/x', 'GET', 'denied', 'no_membership', '{}'::jsonb, now());
    raise exception 'no lanzó ningún error -- se esperaba SQLSTATE 42883 (undefined_function)';
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> '42883' then
      raise exception 'SQLSTATE inesperado: % (se esperaba 42883)', v_sqlstate;
    end if;
  end;
end $$;
rollback;

\echo '=== 26. Base sin migrar -- list_authz_audit_log_for_superadmin NO existe -- SQLSTATE EXACTO 42883 ==='
begin;
drop function core.list_authz_audit_log_for_superadmin(uuid, int, int);
do $$
declare v_sqlstate text;
begin
  begin
    perform core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa100', 10, 0);
    raise exception 'no lanzó ningún error -- se esperaba SQLSTATE 42883 (undefined_function)';
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> '42883' then
      raise exception 'SQLSTATE inesperado: % (se esperaba 42883)', v_sqlstate;
    end if;
  end;
end $$;
rollback;

\echo '=== 27. Base sin migrar -- la tabla core.authz_audit_log NO existe (0021 nunca aplicada) -- record_authz_audit_denial: SQLSTATE EXACTO 42P01 ==='
begin;
drop table core.authz_audit_log cascade;
do $$
declare v_sqlstate text;
begin
  begin
    perform core.record_authz_audit_denial(null, null, null, 'admin:access', '/x', 'GET', 'denied', 'no_membership', '{}'::jsonb, now());
    raise exception 'no lanzó ningún error -- se esperaba SQLSTATE 42P01 (undefined_table)';
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> '42P01' then
      raise exception 'SQLSTATE inesperado: % (se esperaba 42P01)', v_sqlstate;
    end if;
  end;
end $$;
rollback;

\echo '=== 28. Base sin migrar -- la tabla core.authz_audit_log NO existe -- list_authz_audit_log_for_superadmin: SQLSTATE EXACTO 42P01 ==='
begin;
drop table core.authz_audit_log cascade;
do $$
declare v_sqlstate text;
begin
  begin
    perform core.list_authz_audit_log_for_superadmin('00000000-0000-0000-0000-0000000aa100', 10, 0);
    raise exception 'no lanzó ningún error -- se esperaba SQLSTATE 42P01 (undefined_table)';
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> '42P01' then
      raise exception 'SQLSTATE inesperado: % (se esperaba 42P01)', v_sqlstate;
    end if;
  end;
end $$;
rollback;

\echo '=== 29. CASO INTERMEDIO -- 0021 aplicada, la migración 0022 de ESTA ronda NO (columna actor_key ausente, la función NUEVA sí activa) -- SQLSTATE EXACTO 42703 ==='
begin;
-- Deshace SOLO la parte de 0022 que introduce la columna nueva -- simula, vía
-- DDL transaccional real (no una afirmación sin probar: PR #173, ronda de
-- revisión, marcó exactamente esta inexactitud en otro verify), el estado
-- "0021 aplicada, 0022 no" contra Postgres real, dejando activa la función
-- NUEVA de 0022 (que sí quedó `create or replace`-ada al aplicar todas las
-- migraciones) para probar que, si esa columna faltara, Postgres lanza
-- 42703 (undefined_column) -- exactamente lo que
-- `isMigrationMissingError` en packages/db/src/authz-audit-repository.ts ya
-- captura.
alter table core.authz_audit_log drop column actor_key cascade;
do $$
declare v_sqlstate text;
begin
  begin
    perform core.record_authz_audit_denial(null, null, null, 'admin:access', '/x', 'GET', 'denied', 'no_membership', '{}'::jsonb, now());
    raise exception 'no lanzó ningún error -- se esperaba SQLSTATE 42703 (undefined_column)';
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate <> '42703' then
      raise exception 'SQLSTATE inesperado: % (se esperaba 42703)', v_sqlstate;
    end if;
  end;
end $$;
rollback;

-- NOTA -- por qué NO hace falta un escenario adicional de "0022 no aplicada,
-- código sigue funcionando": a diferencia de 022_rentas_audit_log_orden_
-- determinista.sql (PR #173, que si introducía una dependencia real: la
-- función necesitaba la columna `seq` para su NUEVO order by), esta
-- migración reemplaza `record_authz_audit_denial`/`list_authz_audit_log_
-- for_superadmin` con `create or replace function` de la MISMA firma -- si
-- 0022 no está aplicada, la función VIEJA de 0021 sigue activa tal cual (sin
-- tope por actor, sin el marcador de desborde, con el tope global anterior
-- de 5000) y sigue respondiendo con normalidad -- exactamente el mismo
-- comportamiento que ya prueban los escenarios 1-24 de este archivo cuando
-- se corren contra la base con TODAS las migraciones aplicadas (que incluyen
-- 0022). El escenario 29 de arriba es la comprobación real de que, SI algo
-- rompiera esa compatibilidad hacia atrás (una columna que la función nueva
-- diera por sentada), el código TypeScript la captura con el SQLSTATE
-- correcto -- no que ese estado sea alcanzable hoy por un `supabase db push`
-- parcial real.
