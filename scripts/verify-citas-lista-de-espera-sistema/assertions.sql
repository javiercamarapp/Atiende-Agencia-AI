-- Verificación contra Postgres REAL de f2-citas-lista-de-espera:
--
--   (A) `citas.appointment_waitlist` (003_waitlist_and_rate_limit.sql) solo
--       tiene UNA policy, de staff autenticado (membership). Bajo sesión de
--       SISTEMA (`auth.uid()` NULL) el SELECT plano SIEMPRE devuelve 0 filas,
--       en silencio -- el aviso a la lista de espera cuando se libera un
--       horario NUNCA ha salido contra Postgres real, ni desde el agente de
--       voz/WhatsApp (sesión de sistema SIEMPRE) ni desde el post-commit del
--       cancelar de staff (PR #174). Arreglo: función `security definer` de
--       SOLO-SISTEMA `citas.system_load_live_waitlist_candidates`
--       (020_appointment_waitlist_sistema_lectura.sql).
--   (A2) Corrección post-revisión (revisor independiente del PR #180) -- el
--       MISMO gap de RLS, un paso más adelante: `citas.whatsapp_config`
--       (misma migración 003) también solo tiene policy de staff, así que
--       `resolveActiveWhatsAppPhoneNumberId` (SELECT plano) devolvía `null`
--       en sesión de sistema INCLUSO con la migración 020 ya aplicada --
--       runOptimizadorCore/runListaEsperaCore veían candidatos reales pero
--       nunca podían resolver a qué `phone_number_id` mandarles el aviso, así
--       que CERO avisos salían de todos modos. Arreglo: función
--       `security definer` de SOLO-SISTEMA
--       `citas.system_resolve_active_whatsapp_phone_number_id`
--       (021_whatsapp_config_sistema_lectura.sql), mismo patrón exacto que (A).
--   (B) POST .../waitlist/broadcast corría en sesión de STAFF y llamaba una
--       RPC solo-sistema (`citas.claim_waitlist_notification_slot`) -> 500
--       determinista. Arreglo: el efecto va POST-COMMIT en sesión de sistema
--       (ver `apps/api/.../citas/admin.ts::runCitasListaEsperaBroadcastAfterCommit`)
--       -- este script cubre el mecanismo SQL subyacente (misma RPC, mismo
--       guard); la orquestación HTTP/postCommitTasks se cubre en
--       `apps/api/tests/citas-admin.spec.ts`.
--
-- Cubre, de punta a punta y contra Postgres real (156+ migraciones reales de
-- `supabase/migrations/`, en orden):
--   1-2.   Control positivo/cross-tenant de la policy de STAFF sobre
--          `appointment_waitlist` (SIN cambio de este PR -- guard de
--          regresión de alcance).
--   3.     El gap (A) SIGUE existiendo a nivel de SELECT plano sobre
--          `appointment_waitlist` (el fix nunca fue un escape hatch sobre la
--          tabla).
--   4-5.   El fix (A): la función de sistema SÍ ve al candidato de su
--          organización, NUNCA al de otra (cross-tenant del fix).
--   6-7.   Controles negativos obligatorios (A): un staff autenticado real NO
--          puede llamar la función de sistema; `anon` tampoco (sin GRANT) --
--          ambos confirman el SQLSTATE EXACTO 42501 (nunca "cualquier error"),
--          y 7 además confirma con `has_function_privilege` que el rechazo es
--          por el REVOKE de EXECUTE (no por falta de USAGE en el schema).
--   8.     Columnas `date` (`preferred_date_from`/`preferred_date_to`) vuelven
--          como texto ISO comparable (regla dura #6 -- ver postgres-repository.ts).
--   9.     El gap (A2) SIGUE existiendo a nivel de SELECT plano sobre
--          `whatsapp_config` (mismo criterio que 3, pero para la tabla nueva
--          que entra en este fix).
--   10-11. El fix (A2): la función de sistema resuelve el `phone_number_id`
--          REAL de cada organización (10: A, 11: B) -- nunca cruza tenant
--          (el parámetro `organization_id` sigue acotando el resultado).
--   12-13. Controles negativos obligatorios (A2): mismo criterio EXACTO que
--          6-7, para la función de whatsapp_config.
--   14a-e. FLUJO ENTERO real: se libera un horario (cancelar desde el panel,
--          sesión de staff, transacción propia que SÍ confirma) -> una sesión
--          de SISTEMA nueva lee la lista de espera (función 020), resuelve el
--          `phone_number_id` (función 021), reclama el slot, encola el aviso
--          real en `citas.messaging_outbox` -- el mismo recorrido COMPLETO
--          que `runCitasListaEsperaBroadcastAfterCommit`/
--          `tryNotifyWaitlistOfFreedSlot` ejecutan desde TypeScript, con
--          AMBAS funciones de sistema invocadas de verdad (corrección
--          post-revisión: la versión anterior de este escenario saltaba la
--          resolución del teléfono y encolaba con SQL escrito a mano).
--   15a-d. "Esquema de producción a medias" (migraciones 020 Y 021 NO
--          aplicadas): se eliminan AMBAS funciones reales y se demuestra (a)
--          el SQLSTATE exacto (42883, `undefined_function`) que
--          `isUndefinedFunctionError`/`runWithSavepointFallback` capturan en
--          `postgres-repository.ts` para cada una, y (b) que el resto del
--          sistema (RLS de staff, guard de la RPC de claim) sigue funcionando
--          exactamente igual -- vacío honesto, nunca un 500 nuevo.
--
-- Cada escenario vive en su propio `begin; ... rollback;` (o `commit; rollback;`
-- cuando necesita persistir para el siguiente escenario del flujo #14 -- mismo
-- criterio que `scripts/verify-citas-cancelar-con-lista-de-espera/assertions.sql`,
-- ver su comentario de cabecera para el detalle de esta convención).
\set ON_ERROR_STOP off
\pset pager off

-- ============================================================================
-- Fixture -- 2 organizaciones de citas (A: la que se audita: B: solo para el
-- control cross-tenant), un staff con membership en A, un proveedor/servicio/
-- cliente/cita 'confirmed' de A, 2 candidatos de lista de espera activos (uno
-- por organización) que matchean el hueco que la cita de A libera, y (fix A2)
-- un `whatsapp_config` activo por organización -- SIN esto, el escenario 9b
-- original nunca ejercitaba la RPC de resolución de teléfono contra un dato
-- real: exactamente el hueco que el revisor independiente señaló en el
-- fixture del PR #180.
-- ============================================================================

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000f2', 'citas', 'Org Citas f2 (A)', 'org-citas-f2-a'),
  ('00000000-0000-0000-0000-0000000000f4', 'citas', 'Org Citas f2 (B, cross-tenant)', 'org-citas-f2-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000f3', 'staff-f2@example.com', 'Staff f2', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f2', null, 'admin', 'admin')
on conflict do nothing;

insert into citas.providers (id, organization_id, display_name) values
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000f2', 'Proveedor f2')
on conflict do nothing;

insert into citas.services (id, organization_id, name, duration_minutes) values
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000f2', 'Consulta f2', 30)
on conflict do nothing;

insert into citas.customers (id, organization_id, full_name, phone, email) values
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000f2', 'Cliente f2', '5215500000f2', 'cliente-f2@example.com')
on conflict do nothing;

insert into citas.appointments (id, organization_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000f7', now() + interval '1 day', now() + interval '1 day 30 minutes', 'confirmed')
on conflict do nothing;

insert into citas.appointment_waitlist (id, organization_id, customer_phone, customer_name, provider_id, preferred_date_from, status) values
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000f2', '5215500000f9', 'Candidato A', '00000000-0000-0000-0000-0000000000f5', '2026-01-15', 'active'),
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000f4', '5215500000fa', 'Candidato B (otra organización)', null, null, 'active')
on conflict do nothing;

insert into citas.whatsapp_config (organization_id, phone_number_id, is_active) values
  ('00000000-0000-0000-0000-0000000000f2', 'phone-f2-a', true),
  ('00000000-0000-0000-0000-0000000000f4', 'phone-f2-b', true)
on conflict do nothing;

-- ============================================================================
-- 1-2. Controles positivo/cross-tenant de la policy de STAFF -- SIN cambio de
-- este PR (guard de regresión de alcance: si algo aflojara esta policy sin
-- querer, este script empezaría a fallar).
-- ============================================================================

\echo '=== 1. (control positivo) STAFF de A ve su propio candidato vía SELECT directo -- la policy de RLS de staff no se tocó (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select count(*) as staff_ve_su_candidato_deberia_ser_1 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-0000000000f9';
rollback;

\echo '=== 2. (control cross-tenant) STAFF de A NO ve el candidato de B vía SELECT directo (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select count(*) as staff_no_ve_candidato_de_otra_org_deberia_ser_0 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-0000000000fa';
rollback;

-- ============================================================================
-- 3. EL GAP (hallazgo A) -- sigue existiendo a nivel de SELECT plano: el fix
-- de este PR es una función NUEVA, nunca un escape hatch sobre la tabla.
-- ============================================================================

\echo '=== 3. (el gap) SESIÓN DE SISTEMA (auth.uid() null): SELECT plano contra appointment_waitlist SIGUE devolviendo 0 filas -- la policy de staff nunca se tocó, exactamente el comportamiento pre-existente (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_select_directo_sigue_0_deberia_ser_0 from citas.appointment_waitlist where organization_id = '00000000-0000-0000-0000-0000000000f2';
rollback;

-- ============================================================================
-- 4-5. EL FIX -- citas.system_load_live_waitlist_candidates.
-- ============================================================================

\echo '=== 4. (el fix) SESIÓN DE SISTEMA: citas.system_load_live_waitlist_candidates(A) SÍ ve al candidato de A -- el gap queda cerrado (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_funcion_ve_candidato_de_a_deberia_ser_1
  from citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2')
  where out_id = '00000000-0000-0000-0000-0000000000f9';
rollback;

\echo '=== 5. (cross-tenant del fix) SESIÓN DE SISTEMA: citas.system_load_live_waitlist_candidates(A) NUNCA incluye al candidato de B -- el parámetro organization_id sigue acotando el resultado (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_funcion_nunca_cruza_tenant_deberia_ser_0
  from citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2')
  where out_id = '00000000-0000-0000-0000-0000000000fa';
rollback;

-- ============================================================================
-- 6-7. Controles negativos obligatorios (fix A) -- staff real / anon.
--
-- Corrección post-revisión (no-bloqueante #3 señalado por el revisor
-- independiente): el gate (`run-gate.mjs::deriveExpectation`, kind:'error')
-- acepta CUALQUIER error de Postgres en un bloque `as should_fail` -- nunca
-- confirmaba el SQLSTATE exacto (42501). Estos dos escenarios ahora envuelven
-- la llamada en un bloque `do $$ ... exception when sqlstate '42501' then
-- null; end $$;` -- si Postgres lanza CUALQUIER otro código (o si la llamada
-- tiene éxito), el `raise exception` explícito de abajo revienta el bloque y
-- el gate lo reporta como fallo real (ya no hay alias `should_fail`: estos
-- pasan a ser escenarios "success" que solo completan sin error cuando el
-- SQLSTATE exacto coincidió). El 7 además confirma con
-- `has_function_privilege` que el rechazo es por el REVOKE de EXECUTE
-- específicamente (nunca por falta de USAGE en el schema `citas`, que
-- produciría el mismo SQLSTATE 42501 por una razón distinta).
-- ============================================================================

\echo '=== 6. (negativo, SQLSTATE exacto) un STAFF autenticado real de A NO puede llamar la función de sistema -- guard auth.uid() is null, rechaza incluso al dueño legítimo de los datos, con el código EXACTO 42501 que la función lanza (using errcode) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
do $$
begin
  perform citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42501 (guard auth.uid() is null) pero la llamada tuvo éxito -- el guard no está rechazando a un staff real';
exception
  when sqlstate '42501' then null; -- esperado: exactamente el código que la función lanza con "using errcode"
end $$;
rollback;

\echo '=== 7. (negativo, SQLSTATE exacto + causa raíz confirmada) anon no tiene GRANT execute sobre la función de sistema -- 42501 exacto, Y confirmado que es el REVOKE de EXECUTE (nunca falta de USAGE en el schema) ==='
begin;
select (not has_function_privilege('anon', 'citas.system_load_live_waitlist_candidates(uuid)', 'execute'))::int as anon_sin_grant_execute_confirmado_deberia_ser_1;
rollback;

begin;
set local role anon;
do $$
begin
  perform citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42501 (sin GRANT execute) pero la llamada tuvo éxito';
exception
  when sqlstate '42501' then null; -- esperado: mismo código, esta vez por el REVOKE de EXECUTE (confirmado arriba con has_function_privilege), no por falta de USAGE en el schema
end $$;
rollback;

-- ============================================================================
-- 8. Regla dura #6 -- columnas `date` (pg entrega `date` como objeto Date, no
-- string) -- preferred_date_from de Candidato A es '2026-01-15'.
-- ============================================================================

\echo '=== 8. columnas date -- out_preferred_date_from vuelve como TEXTO ISO comparable, nunca un objeto date crudo (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_preferred_date_from = '2026-01-15')::int as fecha_vuelve_como_texto_deberia_ser_1
  from citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2')
  where out_id = '00000000-0000-0000-0000-0000000000f9';
rollback;

-- ============================================================================
-- 9-13. Corrección post-revisión (hallazgo A2) -- MISMO gap de RLS, un paso
-- más adelante: citas.whatsapp_config bajo sesión de sistema.
-- ============================================================================

\echo '=== 9. (el gap A2) SESIÓN DE SISTEMA: SELECT plano contra whatsapp_config SIGUE devolviendo 0 filas -- la policy de staff de esta tabla tampoco se tocó (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_select_directo_whatsapp_config_sigue_0_deberia_ser_0 from citas.whatsapp_config where organization_id = '00000000-0000-0000-0000-0000000000f2';
rollback;

\echo '=== 10. (el fix A2) SESIÓN DE SISTEMA: citas.system_resolve_active_whatsapp_phone_number_id(A) resuelve el phone_number_id REAL de A -- el gap queda cerrado (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (citas.system_resolve_active_whatsapp_phone_number_id('00000000-0000-0000-0000-0000000000f2') = 'phone-f2-a')::int as sistema_funcion_whatsapp_resuelve_a_deberia_ser_1;
rollback;

\echo '=== 11. (cross-tenant del fix A2) SESIÓN DE SISTEMA: citas.system_resolve_active_whatsapp_phone_number_id(B) resuelve el propio phone_number_id de B, NUNCA el de A -- el parámetro organization_id sigue acotando el resultado (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (citas.system_resolve_active_whatsapp_phone_number_id('00000000-0000-0000-0000-0000000000f4') = 'phone-f2-b')::int as sistema_funcion_whatsapp_resuelve_b_deberia_ser_1;
rollback;

\echo '=== 12. (negativo, SQLSTATE exacto) un STAFF autenticado real de A NO puede llamar la función de sistema de whatsapp_config -- guard auth.uid() is null, código EXACTO 42501 (mismo criterio que 6) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
do $$
begin
  perform citas.system_resolve_active_whatsapp_phone_number_id('00000000-0000-0000-0000-0000000000f2');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42501 (guard auth.uid() is null) pero la llamada tuvo éxito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 13. (negativo, SQLSTATE exacto + causa raíz confirmada) anon no tiene GRANT execute sobre la función de sistema de whatsapp_config -- 42501 exacto, confirmado que es el REVOKE de EXECUTE (mismo criterio que 7) ==='
begin;
select (not has_function_privilege('anon', 'citas.system_resolve_active_whatsapp_phone_number_id(uuid)', 'execute'))::int as anon_sin_grant_execute_whatsapp_confirmado_deberia_ser_1;
rollback;

begin;
set local role anon;
do $$
begin
  perform citas.system_resolve_active_whatsapp_phone_number_id('00000000-0000-0000-0000-0000000000f2');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42501 (sin GRANT execute) pero la llamada tuvo éxito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

-- ============================================================================
-- 14. FLUJO ENTERO -- se libera un horario -> se lee la lista de espera en
-- sesión de sistema -> se resuelve el teléfono en sesión de sistema -> queda
-- el aviso encolado. Mismo recorrido EXACTO que
-- `runCitasListaEsperaBroadcastAfterCommit`/`tryNotifyWaitlistOfFreedSlot`
-- (TypeScript) ejecutan, con dos sesiones/transacciones DISTINTAS (staff, que
-- confirma primero; sistema, después) -- nunca la misma transacción.
-- ============================================================================

\echo '=== 14a. STAFF cancela la cita real de A (transacción propia, confirma de verdad) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select citas.cancel_appointment_from_panel('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f8');
commit;
rollback;

-- NOTA sobre el gate automático (`run-gate.mjs`): un bloque con un alias
-- `..._deberia_ser_N` se AÍSLA a SOLO esa sentencia (ver `isolateTargetStatement`)
-- -- las sentencias que siguen (resolver-teléfono/claim/enqueue/commit) NUNCA
-- correrían. Por eso este bloque, a propósito, NO repite ningún chequeo
-- `deberia_ser` (ya los cubren los escenarios 4 y 10) -- así el gate lo trata
-- como "success" (sin alias -> debe completar sin error) y SÍ ejecuta el
-- bloque completo de verdad, incluido el `commit;`. Corrección post-revisión
-- (no-bloqueante #2 señalado por el revisor independiente): ANTES este bloque
-- saltaba la resolución del teléfono y encolaba con SQL escrito a mano
-- ("ya lo vio en el escenario 4") -- ahora invoca las DOS funciones de
-- sistema reales, sin alias, para que el flujo sea genuinamente continuo -- el
-- efecto se verifica después, en 14c/14d/14e.
\echo '=== 14b. SESIÓN DE SISTEMA NUEVA (después del commit de arriba): lee la lista de espera vía la función (020), resuelve el phone_number_id vía la función (021), reclama el slot y encola el aviso real -- exactamente lo que runCitasListaEsperaBroadcastAfterCommit hace desde TypeScript ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2') where out_id = '00000000-0000-0000-0000-0000000000f9';
select citas.system_resolve_active_whatsapp_phone_number_id('00000000-0000-0000-0000-0000000000f2');
select * from citas.claim_waitlist_notification_slot('00000000-0000-0000-0000-0000000000f9', 3);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000f2', 'whatsapp', 'waitlist.slot_offered', 'waitlist-offer-f2-verify', '{"to":"5215500000f9"}'::jsonb);
commit;
rollback;

\echo '=== 14c. FLUJO COMPLETO -- la cita quedó cancelada de verdad (deberia_ser_1) ==='
begin;
select (status = 'cancelled')::int as flujo_cita_cancelada_deberia_ser_1 from citas.appointments where id = '00000000-0000-0000-0000-0000000000f8';
rollback;

\echo '=== 14d. FLUJO COMPLETO -- el candidato quedó reclamado (notified_count = 1, deberia_ser_1) ==='
begin;
select notified_count as flujo_candidato_reclamado_deberia_ser_1 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-0000000000f9';
rollback;

\echo '=== 14e. FLUJO COMPLETO -- el aviso real quedó encolado en citas.messaging_outbox (deberia_ser_1) ==='
begin;
select count(*) as flujo_aviso_encolado_deberia_ser_1 from citas.messaging_outbox where organization_id = '00000000-0000-0000-0000-0000000000f2' and dedupe_key = 'waitlist-offer-f2-verify';
rollback;

-- ============================================================================
-- 15. "Esquema de producción a medias" (migraciones 020 Y 021 NO aplicadas) --
-- dentro de este mismo fixture, elimina AMBAS funciones reales para
-- reproducir el estado de una base que va detrás en migraciones (REGLA DURA
-- de compatibilidad del repo). El código TypeScript
-- (`loadLiveWaitlistCandidatesAsSystem`/`resolveActiveWhatsAppPhoneNumberIdAsSystem`,
-- `postgres-repository.ts`) captura EXACTAMENTE este SQLSTATE
-- (`isUndefinedFunctionError`, 42883) vía `runWithSavepointFallback` y
-- degrada a lista vacía/`null` -- nunca un 500 -- ver
-- `packages/domain-citas/tests/postgres-repository-waitlist-system-savepoint.spec.ts`
-- y `packages/domain-citas/tests/postgres-repository-whatsapp-config-system-savepoint.spec.ts`
-- para la prueba de ese fallback con un doble de sesión (AbortAwareFakeSession);
-- este script solo prueba que el SQLSTATE real de Postgres es el que ese
-- código espera, para las DOS funciones.
-- ============================================================================

drop function citas.system_load_live_waitlist_candidates(uuid);
drop function citas.system_resolve_active_whatsapp_phone_number_id(uuid);

\echo '=== 15a. (SQLSTATE exacto) ESQUEMA A MEDIAS: llamar system_load_live_waitlist_candidates (ya no existe) lanza EXACTAMENTE 42883 (undefined_function) -- lo que isUndefinedFunctionError/runWithSavepointFallback capturan en postgres-repository.ts ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42883 (función eliminada) pero la llamada tuvo éxito -- ¿el DROP de arriba no corrió?';
exception
  when sqlstate '42883' then null; -- exactamente lo que isUndefinedFunctionError reconoce
end $$;
rollback;

\echo '=== 15b. (SQLSTATE exacto) ESQUEMA A MEDIAS: llamar system_resolve_active_whatsapp_phone_number_id (ya no existe) lanza el MISMO 42883 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_resolve_active_whatsapp_phone_number_id('00000000-0000-0000-0000-0000000000f2');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42883 (función eliminada) pero la llamada tuvo éxito -- ¿el DROP de arriba no corrió?';
exception
  when sqlstate '42883' then null;
end $$;
rollback;

\echo '=== 15c. ESQUEMA A MEDIAS: el staff SIGUE viendo su propio candidato tal cual (ninguna de las dos migraciones nuevas tocó ninguna policy de staff -- vacío honesto, nunca una regresión, deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select count(*) as esquema_a_medias_staff_sigue_viendo_su_candidato_deberia_ser_1 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-0000000000f9';
rollback;

\echo '=== 15d. (SQLSTATE exacto) ESQUEMA A MEDIAS: el guard de claim_waitlist_notification_slot (migración 015, YA aplicada desde antes) sigue intacto -- sesión de staff sigue rechazada con EXACTAMENTE 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
do $$
begin
  perform citas.claim_waitlist_notification_slot('00000000-0000-0000-0000-0000000000f9', 3);
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42501 (guard auth.uid() is null de claim_waitlist_notification_slot) pero la llamada tuvo éxito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== FIN -- 24 bloques begin/rollback en total (2 control staff, 1 gap A, 2 fix A, 2 negativos A [7 en 2 bloques], 1 fecha, 1 gap A2, 2 fix A2, 2 negativos A2 [13 en 2 bloques], 5 flujo completo, 4 esquema-a-medias) = 24/24. Corrección post-revisión (no-bloqueante #3): 6, 7, 12, 13, 15a, 15b y 15d ya NO usan el alias `should_fail` (el gate aceptaba cualquier error) -- ahora son bloques `do $$ ... exception when sqlstate ... $$;` que solo completan sin error cuando Postgres lanzó EXACTAMENTE el SQLSTATE esperado; cualquier otro código (o un éxito inesperado) hace que el `raise exception` explícito revienta el bloque y el gate lo reporta como fallo real. ==='
