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
--   1-2. Control positivo/cross-tenant de la policy de STAFF (SIN cambio de
--        este PR -- guard de regresión de alcance).
--   3.   El gap SIGUE existiendo a nivel de SELECT plano (el fix nunca fue un
--        escape hatch sobre la tabla).
--   4-5. El fix: la función de sistema SÍ ve al candidato de su organización,
--        NUNCA al de otra (cross-tenant del fix).
--   6-7. Controles negativos obligatorios: un staff autenticado real NO puede
--        llamar la función de sistema (42501); `anon` tampoco (sin GRANT).
--   8.   Columnas `date` (`preferred_date_from`/`preferred_date_to`) vuelven
--        como texto ISO comparable (regla dura #6 -- ver postgres-repository.ts).
--   9.   FLUJO ENTERO real: se libera un horario (cancelar desde el panel,
--        sesión de staff, transacción propia que SÍ confirma) -> una sesión de
--        SISTEMA nueva lee la lista de espera (la función de arriba) -> reclama
--        el slot -> encola el aviso real en `citas.messaging_outbox` -- el
--        mismo recorrido que `runCitasListaEsperaBroadcastAfterCommit`/
--        `tryNotifyWaitlistOfFreedSlot` ejecutan desde TypeScript.
--   10.  "Esquema de producción a medias" (migración 020 NO aplicada): se
--        elimina la función real y se demuestra (a) el SQLSTATE exacto
--        (42883, `undefined_function`) que `isUndefinedFunctionError`/
--        `runWithSavepointFallback` capturan en `postgres-repository.ts`, y
--        (b) que el resto del sistema (RLS de staff, guard de la RPC de
--        claim) sigue funcionando exactamente igual -- vacío honesto, nunca
--        un 500 nuevo.
--
-- Cada escenario vive en su propio `begin; ... rollback;` (o `commit; rollback;`
-- cuando necesita persistir para el siguiente escenario del flujo #9 -- mismo
-- criterio que `scripts/verify-citas-cancelar-con-lista-de-espera/assertions.sql`,
-- ver su comentario de cabecera para el detalle de esta convención).
\set ON_ERROR_STOP off
\pset pager off

-- ============================================================================
-- Fixture -- 2 organizaciones de citas (A: la que se audita: B: solo para el
-- control cross-tenant), un staff con membership en A, un proveedor/servicio/
-- cliente/cita 'confirmed' de A, y 2 candidatos de lista de espera activos (uno
-- por organización) que matchean el hueco que la cita de A libera.
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
-- 6-7. Controles negativos obligatorios -- staff real / anon.
-- ============================================================================

\echo '=== 6. (negativo) un STAFF autenticado real de A NO puede llamar la función de sistema -- guard auth.uid() is null, rechaza incluso al dueño legítimo de los datos (should_fail, 42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2') as should_fail;
rollback;

\echo '=== 7. (negativo) anon no tiene GRANT execute sobre la función de sistema (should_fail) ==='
begin;
set local role anon;
select citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2') as should_fail;
rollback;

-- ============================================================================
-- 8. Regla dura #6 -- columnas `date` con `::text` (pg entrega `date` como
-- objeto Date, no string) -- preferred_date_from de Candidato A es '2026-01-15'.
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
-- 9. FLUJO ENTERO -- se libera un horario -> se lee la lista de espera en
-- sesión de sistema -> queda el aviso encolado. Mismo recorrido EXACTO que
-- `runCitasListaEsperaBroadcastAfterCommit`/`tryNotifyWaitlistOfFreedSlot`
-- (TypeScript) ejecutan, con dos sesiones/transacciones DISTINTAS (staff, que
-- confirma primero; sistema, después) -- nunca la misma transacción.
-- ============================================================================

\echo '=== 9a. STAFF cancela la cita real de A (transacción propia, confirma de verdad) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select citas.cancel_appointment_from_panel('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f8');
commit;
rollback;

-- NOTA sobre el gate automático (`run-gate.mjs`): un bloque con un alias
-- `..._deberia_ser_N` se AÍSLA a SOLO esa sentencia (ver `isolateTargetStatement`)
-- -- las sentencias que siguen (claim/enqueue/commit) NUNCA correrían. Por eso
-- este bloque, a propósito, NO repite el chequeo `deberia_ser` de lectura (ya
-- lo cubre el escenario 4) -- así el gate lo trata como "success" (sin alias
-- -> debe completar sin error) y SÍ ejecuta el bloque completo de verdad,
-- incluido el `commit;` -- el efecto se verifica después, en 9c/9d/9e.
\echo '=== 9b. SESIÓN DE SISTEMA NUEVA (después del commit de arriba): reclama el slot (ya lo vio en el escenario 4) y encola el aviso real -- exactamente lo que runCitasListaEsperaBroadcastAfterCommit hace desde TypeScript ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from citas.claim_waitlist_notification_slot('00000000-0000-0000-0000-0000000000f9', 3);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000f2', 'whatsapp', 'waitlist.slot_offered', 'waitlist-offer-f2-verify', '{"to":"5215500000f9"}'::jsonb);
commit;
rollback;

\echo '=== 9c. FLUJO COMPLETO -- la cita quedó cancelada de verdad (deberia_ser_1) ==='
begin;
select (status = 'cancelled')::int as flujo_cita_cancelada_deberia_ser_1 from citas.appointments where id = '00000000-0000-0000-0000-0000000000f8';
rollback;

\echo '=== 9d. FLUJO COMPLETO -- el candidato quedó reclamado (notified_count = 1, deberia_ser_1) ==='
begin;
select notified_count as flujo_candidato_reclamado_deberia_ser_1 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-0000000000f9';
rollback;

\echo '=== 9e. FLUJO COMPLETO -- el aviso real quedó encolado en citas.messaging_outbox (deberia_ser_1) ==='
begin;
select count(*) as flujo_aviso_encolado_deberia_ser_1 from citas.messaging_outbox where organization_id = '00000000-0000-0000-0000-0000000000f2' and dedupe_key = 'waitlist-offer-f2-verify';
rollback;

-- ============================================================================
-- 10. "Esquema de producción a medias" (migración 020 NO aplicada) -- dentro
-- de este mismo fixture, elimina la función real para reproducir el estado de
-- una base que va detrás en migraciones (REGLA DURA de compatibilidad del
-- repo). El código TypeScript (`loadLiveWaitlistCandidatesAsSystem`,
-- `postgres-repository.ts`) captura EXACTAMENTE este SQLSTATE
-- (`isUndefinedFunctionError`, 42883) vía `runWithSavepointFallback` y
-- degrada a lista vacía -- nunca un 500 -- ver
-- `packages/domain-citas/tests/waitlist-cancelar-savepoint.spec.ts` para la
-- prueba de ese fallback con un doble de sesión (AbortAwareFakeSession); este
-- script solo prueba que el SQLSTATE real de Postgres es el que ese código
-- espera.
-- ============================================================================

drop function citas.system_load_live_waitlist_candidates(uuid);

\echo '=== 10a. ESQUEMA A MEDIAS: llamar la función (ya no existe) lanza SQLSTATE 42883 (undefined_function) -- exactamente lo que isUndefinedFunctionError/runWithSavepointFallback capturan en postgres-repository.ts (should_fail) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.system_load_live_waitlist_candidates('00000000-0000-0000-0000-0000000000f2') as should_fail;
rollback;

\echo '=== 10b. ESQUEMA A MEDIAS: el staff SIGUE viendo su propio candidato tal cual (la migración 020 nunca tocó la policy de staff -- vacío honesto, nunca una regresión, deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select count(*) as esquema_a_medias_staff_sigue_viendo_su_candidato_deberia_ser_1 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-0000000000f9';
rollback;

\echo '=== 10c. ESQUEMA A MEDIAS: el guard de claim_waitlist_notification_slot (migración 015, YA aplicada desde antes) sigue intacto -- sesión de staff sigue rechazada con 42501 (should_fail) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select citas.claim_waitlist_notification_slot('00000000-0000-0000-0000-0000000000f9', 3) as should_fail;
rollback;

\echo '=== FIN -- 16 bloques begin/rollback en total (2 control staff, 1 gap, 2 fix, 2 negativos, 1 fecha, 5 flujo completo, 3 esquema-a-medias) = 16/16. Los escenarios 6, 7, 10a y 10c terminan en ERROR a propósito (should_fail); todos los demás deben completar sin error. ==='
