-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales -- nunca el
-- repositorio en memoria de packages/db/src/impersonation-repository.ts, que
-- no aplica ninguno de los dos), los requisitos de seguridad no negociables
-- de packages/db/migrations/0020_superadmin_impersonacion.sql (Bloque C):
--
--   1. Solo un superadmin de plataforma REAL (core.is_platform_superadmin)
--      puede iniciar/terminar una impersonación.
--   2. Caller-binding: auth.uid() debe coincidir con p_caller_id -- SIEMPRE,
--      incluso si p_caller_id es un superadmin real distinto del actor real.
--   3. anon no puede ni ejecutar las funciones (sin GRANT EXECUTE).
--   4. Motivo obligatorio (>=20 caracteres tras btrim).
--   5. Organización inexistente -- rechazada.
--   6. "Nunca impersonar a otro superadmin" -- una organización con OTRO
--      superadmin de plataforma como miembro es rechazada.
--   7. Una sola sesión activa por actor a la vez.
--   8. Duración/expiración SIEMPRE calculada en SQL (15 min fijos, nunca el
--      cliente) -- y "activa" se verifica EN SQL, no en la aplicación.
--   9. Una sesión VENCIDA no admite cierre explícito ni cuenta como activa.
--  10. Solo el propio actor puede terminar su sesión.
--  11. Bitácora append-only: ni UPDATE ni DELETE, para NADIE, ni siquiera
--      service_role -- ni tampoco un INSERT/UPDATE/DELETE directo (sin pasar
--      por las funciones) desde `authenticated` ni `anon`.
--  12. Camino feliz: iniciar -> queda en la bitácora ('start') -> terminar ->
--      queda en la bitácora ('end') -- oversight de plataforma (cualquier
--      superadmin real ve la bitácora completa).
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
  ('00000000-0000-0000-0000-0000000c9200', 'restaurantes', 'Org Impersonación', 'org-impersonacion'),
  ('00000000-0000-0000-0000-0000000c9201', 'restaurantes', 'Org Impersonación (con superadmin miembro)', 'org-impersonacion-con-superadmin'),
  ('00000000-0000-0000-0000-0000000c9202', 'restaurantes', 'Org Impersonación (con el propio caller como miembro)', 'org-impersonacion-self-member')
on conflict do nothing;

-- superadmin-1/2/3: tres superadmins REALES (core.platform_superadmin).
-- superadmin-2 ADEMÁS es staff (member) de org-impersonacion-con-superadmin --
-- el caso real que el requisito "nunca impersonar a otro superadmin" protege
-- (ver comentario de cabecera de la migración).
-- staff-normal: staff real, member de org-impersonacion, NUNCA superadmin.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c9100', 'superadmin-imp-1@example.com', 'Superadmin Impersonación 1', 'seed'),
  ('00000000-0000-0000-0000-0000000c9101', 'superadmin-imp-2@example.com', 'Superadmin Impersonación 2', 'seed'),
  ('00000000-0000-0000-0000-0000000c9102', 'superadmin-imp-3@example.com', 'Superadmin Impersonación 3', 'seed'),
  ('00000000-0000-0000-0000-0000000c9103', 'staff-normal-imp@example.com', 'Staff Normal Impersonación', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000c9100'),
  ('00000000-0000-0000-0000-0000000c9101'),
  ('00000000-0000-0000-0000-0000000c9102')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c9103', '00000000-0000-0000-0000-0000000c9200', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c9201', null, 'member', 'staff'),
  -- superadmin-3 (c9102) ADEMÁS es staff de esta organización -- el caso que
  -- el escenario 22 (self-exclusion) verifica: no es "OTRO" superadmin, es
  -- el propio caller, así que start_impersonation_session NO debe rechazarlo.
  ('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9202', null, 'member', 'staff')
on conflict do nothing;

-- Dos sesiones insertadas DIRECTO (como el superusuario que corre este
-- script -- las funciones security definer no aplican aquí, solo se
-- ejercitan las lecturas/el bloqueo de mutación sobre estas filas):
--   - imp-activa: vigente, actor superadmin-1, sobre org-impersonacion.
--   - imp-vencida: expires_at en el PASADO, nunca cerrada, mismo actor.
insert into core.impersonation_session (id, actor_user_id, actor_email, organization_id, reason, started_at, expires_at) values
  ('00000000-0000-0000-0000-0000000c9300', '00000000-0000-0000-0000-0000000c9100', 'superadmin-imp-1@example.com', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: sesión activa real para verificación contra Postgres.', now(), now() + interval '15 minutes'),
  ('00000000-0000-0000-0000-0000000c9301', '00000000-0000-0000-0000-0000000c9100', 'superadmin-imp-1@example.com', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: sesión ya vencida, nunca cerrada a mano.', now() - interval '1 hour', now() - interval '45 minutes')
on conflict do nothing;

insert into core.impersonation_audit_log (id, session_id, event_type, actor_user_id, actor_email, organization_id, reason, detail, occurred_at) values
  ('00000000-0000-0000-0000-0000000c9400', '00000000-0000-0000-0000-0000000c9300', 'start', '00000000-0000-0000-0000-0000000c9100', 'superadmin-imp-1@example.com', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: sesión activa real para verificación contra Postgres.', '{}'::jsonb, now())
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) start_impersonation_session -- caller-binding, motivo, organización,
--    target-superadmin, sesión-duplicada
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 1. start_impersonation_session: staff con membership real (NO superadmin) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9103', true);
select core.start_impersonation_session('00000000-0000-0000-0000-0000000c9103', '00000000-0000-0000-0000-0000000c9200', 'Intento de staff normal con membership real, nunca superadmin.') as should_fail;
rollback;

\echo '=== 2. start_impersonation_session: caller-binding inválido (auth.uid()=superadmin-2, p_caller_id=superadmin-1) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9101', true);
select core.start_impersonation_session('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9200', 'Intento de pasar el UUID de OTRO superadmin como p_caller_id.') as should_fail;
rollback;

\echo '=== 3. start_impersonation_session: anon no puede ni ejecutar la función (sin GRANT EXECUTE) -- RECHAZADO ==='
begin;
set local role anon;
select core.start_impersonation_session('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9200', 'anon nunca debería llegar aquí.') as should_fail;
rollback;

\echo '=== 4. start_impersonation_session: organización inexistente -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9100', true);
select core.start_impersonation_session('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9299', 'Organización que no existe en absoluto en core.organization.') as should_fail;
rollback;

\echo '=== 5. start_impersonation_session: motivo demasiado corto -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9102', true);
select core.start_impersonation_session('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200', 'corto') as should_fail;
rollback;

\echo '=== 6. start_impersonation_session: organización con OTRO superadmin como miembro -- RECHAZADO (nunca impersonar a otro superadmin) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9100', true);
select core.start_impersonation_session('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9201', 'Intento de impersonar una organización donde superadmin-2 es miembro.') as should_fail;
rollback;

\echo '=== 7. start_impersonation_session: superadmin-1 YA tiene una sesión activa (fixture imp-activa) -- RECHAZADO (una sola sesión activa por actor) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9100', true);
select core.start_impersonation_session('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9200', 'Segundo intento mientras la sesión fixture sigue activa.') as should_fail;
rollback;

\echo '=== 8. start_impersonation_session: superadmin-3 (sin sesión previa), entrada VÁLIDA -- abre sin error, expires_at = started_at + 15 minutos EXACTOS (calculado en SQL, nunca por el cliente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9102', true);
select (extract(epoch from (s.expires_at - s.started_at)) = 900)::int as duracion_deberia_ser_1
from core.start_impersonation_session('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: apertura válida de una sesión de impersonación real.') as s;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) end_impersonation_session -- dueño, sesión vencida, camino feliz
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 9. end_impersonation_session: sesión VENCIDA (fixture imp-vencida) -- RECHAZADO (no requiere cierre explícito) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9100', true);
select core.end_impersonation_session('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9301') as should_fail;
rollback;

\echo '=== 10. end_impersonation_session: OTRO superadmin real (no el dueño) intenta terminar la sesión de superadmin-1 -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9101', true);
select core.end_impersonation_session('00000000-0000-0000-0000-0000000c9101', '00000000-0000-0000-0000-0000000c9300') as should_fail;
rollback;

\echo '=== 11. end_impersonation_session: anon no puede ni ejecutar la función -- RECHAZADO ==='
begin;
set local role anon;
select core.end_impersonation_session('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9300') as should_fail;
rollback;

-- Camino feliz completo (superadmin-3 inicia -> queda ACTIVA en SQL ->
-- aparece en la bitácora (start) -> termina -> ya NO cuenta como activa ->
-- aparece en la bitácora (end) -- hash chain real) -- partido en varios
-- escenarios de UN SOLO alias `deberia_ser_N` cada uno (corrección de esta
-- revisión, ver PR): `scripts/verify-real-postgres-ci/run-gate.mjs`
-- (`isolateTargetStatement`) SOLO ejecuta, para un escenario "value", el
-- texto hasta el FINAL de la sentencia del PRIMER alias `..._deberia_ser_N`
-- que encuentra en el bloque -- con los 4 aliases que tenía este escenario
-- en una sola sentencia `begin;...rollback;`, el gate de CI solo llegaba a
-- ejecutar `start` + `activa_tras_iniciar`; la llamada a `end_impersonation_
-- session` y las dos comprobaciones posteriores NUNCA corrían en CI (aunque
-- SÍ corren si alguien pega el archivo completo a mano en `psql`, que es por
-- lo que el bug pasó desapercibido). Cada escenario de abajo repite su
-- propio `start` (cada uno vive en su PROPIA transacción, con su PROPIO
-- `rollback;` -- nunca se pisan entre sí ni dejan estado para el siguiente).
\echo '=== 12a. Camino feliz (1/5): superadmin-3 inicia -> queda ACTIVA en SQL ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9102', true);
select (core.start_impersonation_session('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: camino feliz completo iniciar/terminar con bitácora real.')).id as id \gset imp12a_
select core.is_impersonation_active_for_caller_and_org('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200')::int as activa_tras_iniciar_deberia_ser_1;
rollback;

\echo '=== 12b. Camino feliz (2/5): superadmin-3 inicia -> aparece en la bitácora como start ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9102', true);
select (core.start_impersonation_session('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: camino feliz completo iniciar/terminar con bitácora real.')).id as id \gset imp12b_
select count(*) as bitacora_start_deberia_ser_1 from core.impersonation_audit_log where session_id = :'imp12b_id' and event_type = 'start';
rollback;

\echo '=== 12c. Camino feliz (3/5): superadmin-3 inicia -> TERMINA -> ya NO cuenta como activa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9102', true);
select (core.start_impersonation_session('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: camino feliz completo iniciar/terminar con bitácora real.')).id as id \gset imp12c_
select core.end_impersonation_session('00000000-0000-0000-0000-0000000c9102', :'imp12c_id');
select core.is_impersonation_active_for_caller_and_org('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200')::int as activa_tras_terminar_deberia_ser_0;
rollback;

\echo '=== 12d. Camino feliz (4/5): superadmin-3 inicia -> TERMINA -> aparece en la bitácora como end ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9102', true);
select (core.start_impersonation_session('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: camino feliz completo iniciar/terminar con bitácora real.')).id as id \gset imp12d_
select core.end_impersonation_session('00000000-0000-0000-0000-0000000c9102', :'imp12d_id');
select count(*) as bitacora_end_deberia_ser_1 from core.impersonation_audit_log where session_id = :'imp12d_id' and event_type = 'end';
rollback;

\echo '=== 12e. Camino feliz (5/5): hash chain real -- el evento end encadena (prev_hash) con el hash del evento start de la MISMA sesión, y ningún hash queda NULL ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9102', true);
select (core.start_impersonation_session('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9200', 'Ticket SOP-VERIFY: camino feliz completo iniciar/terminar con bitácora real.')).id as id \gset imp12e_
select core.end_impersonation_session('00000000-0000-0000-0000-0000000c9102', :'imp12e_id');
select (
  a_end.prev_hash is not distinct from a_start.hash
  and a_start.hash is not null
  and a_end.hash is not null
  and a_start.prev_hash is distinct from a_start.hash
)::int as hash_chain_deberia_ser_1
from core.impersonation_audit_log a_start
join core.impersonation_audit_log a_end
  on a_end.session_id = a_start.session_id
where a_start.session_id = :'imp12e_id' and a_start.event_type = 'start' and a_end.event_type = 'end';
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Expiración verificada EN SQL, no solo en la aplicación
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 13. is_impersonation_active_for_caller_and_org: sesión ACTIVA real (fixture imp-activa) -- TRUE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9100', true);
select core.is_impersonation_active_for_caller_and_org('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9200')::int as deberia_ser_1;
rollback;

\echo '=== 14. get_active_impersonation_session_for_superadmin: superadmin-2 (sin ninguna sesión propia, ni activa ni vencida) -- 0 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9101', true);
select count(*) as deberia_ser_0 from core.get_active_impersonation_session_for_superadmin('00000000-0000-0000-0000-0000000c9101');
rollback;

\echo '=== 14b. is_impersonation_active_for_caller_and_org: superadmin-1 sobre la MISMA organización de su sesión VENCIDA (imp-vencida, expirada hace 45 min) -- FALSE/0 (la expiración se verifica EN SQL, no en una cookie de aplicación con TTL propio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9100', true);
-- NOTA: superadmin-1 también tiene la sesión ACTIVA (imp-activa) sobre esta
-- misma organización -- por eso este escenario, a diferencia del 13, no
-- alcanzaría a probar "solo lo vencido cuenta como inactivo" si dependiera de
-- is_impersonation_active_for_caller_and_org (que ya daría TRUE por la
-- sesión activa). Se verifica en su lugar de forma directa: la fila vencida
-- por sí sola, filtrada por expires_at > now(), nunca aparece.
select count(*) as deberia_ser_0 from core.impersonation_session where id = '00000000-0000-0000-0000-0000000c9301' and expires_at > now();
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) Bitácora -- append-only real, ni un INSERT/UPDATE/DELETE directo
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 15. impersonation_audit_log: UPDATE directo está bloqueado incluso para service_role ==='
begin;
-- as should_fail (el trigger de bloqueo, no un alias -- UPDATE no admite `as`
-- sobre la sentencia completa; este comentario, DENTRO del bloque
-- begin;/rollback;, es lo que el runner automático detecta para marcar el
-- escenario como "debe terminar en ERROR").
set local role service_role;
update core.impersonation_audit_log set reason = 'alterado' where id = '00000000-0000-0000-0000-0000000c9400';
rollback;

\echo '=== 16. impersonation_audit_log: DELETE directo está bloqueado incluso para service_role ==='
begin;
-- as should_fail (ver nota del escenario 15 -- mismo motivo, DELETE tampoco
-- admite `as` sobre la sentencia completa).
set local role service_role;
delete from core.impersonation_audit_log where id = '00000000-0000-0000-0000-0000000c9400';
rollback;

\echo '=== 17. impersonation_session: UPDATE directo está bloqueado incluso para service_role ==='
begin;
-- as should_fail (mismo motivo que 15/16).
set local role service_role;
update core.impersonation_session set reason = 'alterado' where id = '00000000-0000-0000-0000-0000000c9300';
rollback;

\echo '=== 18. impersonation_audit_log: INSERT directo desde authenticated (sin pasar por las funciones) -- RECHAZADO (sin policy de escritura) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario es lo que el runner automático detecta).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9100', true);
insert into core.impersonation_audit_log (session_id, event_type, actor_user_id, actor_email, organization_id, reason, detail)
values ('00000000-0000-0000-0000-0000000c9300', 'start', '00000000-0000-0000-0000-0000000c9100', 'suplantado@example.com', '00000000-0000-0000-0000-0000000c9200', 'Intento de insertar bitácora directo, sin pasar por la función.', '{}'::jsonb);
rollback;

\echo '=== 19. impersonation_session: INSERT directo desde anon -- RECHAZADO (sin GRANT) ==='
begin;
-- as should_fail (mismo motivo que 18).
set local role anon;
insert into core.impersonation_session (actor_user_id, organization_id, reason, expires_at)
values ('00000000-0000-0000-0000-0000000c9100', '00000000-0000-0000-0000-0000000c9200', 'Intento de insertar una sesión directo como anon.', now() + interval '15 minutes');
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) Oversight de plataforma -- cualquier superadmin real ve TODA la bitácora
-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 20. list_impersonation_sessions_for_superadmin: superadmin-2 (que NUNCA abrió una sesión) ve las de superadmin-1 también -- oversight real, deberia_ser >= 2 (verificado como \"al menos 2\") ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9101', true);
select (count(*) >= 2)::int as deberia_ser_1 from core.list_impersonation_sessions_for_superadmin('00000000-0000-0000-0000-0000000c9101', 500);
rollback;

\echo '=== 21. list_impersonation_sessions_for_superadmin: staff con membership real (no superadmin) ve CERO -- nunca sesiones ajenas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9103', true);
select count(*) as deberia_ser_0 from core.list_impersonation_sessions_for_superadmin('00000000-0000-0000-0000-0000000c9103', 500);
rollback;

\echo '=== 22. start_impersonation_session: self-exclusion -- superadmin-3 impersona una organización donde ÉL MISMO es miembro (no OTRO superadmin) -- ACEPTADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9102', true);
select core.start_impersonation_session('00000000-0000-0000-0000-0000000c9102', '00000000-0000-0000-0000-0000000c9202', 'Ticket SOP-VERIFY: self-exclusion -- el propio caller es miembro de esta organización, no debe contar como OTRO superadmin.');
rollback;

\echo '=== 23. list_impersonation_audit_log_for_superadmin: superadmin-2 (oversight de plataforma) ve al menos la entrada start de la fixture imp-activa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9101', true);
select (count(*) >= 1)::int as deberia_ser_1 from core.list_impersonation_audit_log_for_superadmin('00000000-0000-0000-0000-0000000c9101', 500);
rollback;

\echo '=== 24. list_impersonation_audit_log_for_superadmin: staff con membership real (no superadmin) ve CERO -- nunca bitácora ajena ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9103', true);
select count(*) as deberia_ser_0 from core.list_impersonation_audit_log_for_superadmin('00000000-0000-0000-0000-0000000c9103', 500);
rollback;

\echo '=== 25. impersonation_session: SELECT directo desde anon -- RECHAZADO (sin GRANT, ni siquiera llega a evaluar RLS) ==='
begin;
-- as should_fail (sin GRANT SELECT a anon -- "permission denied", nunca una
-- lista vacía silenciosa; ver revoke all ... from public, anon de la
-- migración).
set local role anon;
select * from core.impersonation_session as should_fail;
rollback;
