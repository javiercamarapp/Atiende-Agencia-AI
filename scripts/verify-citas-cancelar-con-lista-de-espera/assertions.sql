-- Verificación ANTES/DESPUÉS contra Postgres REAL del hallazgo confirmado de la
-- auditoría a3 (ALTA, `auditoria-a3-resultado.json::confirmed[0]`): cancelar una
-- cita desde el panel de STAFF (POST .../appointments/:id/cancel, sesión de
-- staff -- `auth.uid()` real) responde 500 y REVIERTE la cancelación cuando hay
-- un candidato activo en la lista de espera que coincide con el hueco liberado.
--
-- Mecanismo real (idéntico al que corre
-- apps/api/.../citas/appointments-lifecycle.ts sobre `c.get("db")`):
--   1. La ruta abre UNA transacción para todo el request (`begin;` + `set local
--      role authenticated;` + `select set_config('request.jwt.claim.sub', ...)`,
--      packages/db/src/managed-postgres-engine.ts).
--   2. Llama `citas.cancel_appointment_from_panel(...)` -- éxito real.
--   3. Llama (antes del fix, EN LA MISMA transacción) al aviso best-effort de
--      lista de espera, que termina en `citas.claim_waitlist_notification_slot`.
--      Esa función SIEMPRE lanza 42501 en sesión de staff ("solo para la sesión
--      de sistema" -- guard correcto, NO se afloja).
--   4. SIN SAVEPOINT, esa excepción deja la transacción COMPLETA abortada
--      (25P02) -- el `commit;` posterior sobre una transacción abortada NO lanza
--      error (Postgres responde "ROLLBACK" en silencio,
--      packages/db/src/managed-postgres-engine.ts) -- la cancelación del paso 2
--      se pierde con una respuesta 2xx/500 según qué corra después.
--   5. CON el fix real (`repo.runWithRowSavepoint` alrededor del intento, ver
--      packages/domain-citas/src/reminders.ts::tryNotifyWaitlistOfFreedSlot):
--      `SAVEPOINT` antes del intento, `ROLLBACK TO SAVEPOINT` + `RELEASE
--      SAVEPOINT` en el catch -- la transacción vuelve a un estado sano y el
--      `commit;` posterior SÍ confirma la cancelación.
--
-- GAP ADICIONAL DESCUBIERTO durante esta verificación (documentado en
-- packages/domain-citas/README.md, NO corregido en este PR -- ver knownGaps del
-- PR): el SAVEPOINT evita el 500/rollback, pero por sí solo NUNCA logra que el
-- aviso salga de verdad, ni siquiera desde la sesión de SISTEMA a la que este PR
-- mueve la llamada (`runCitasWaitlistNotifyAfterCancel`, post-commit): la ÚNICA
-- policy de `citas.appointment_waitlist` (003_waitlist_and_rate_limit.sql) exige
-- `m.user_id = auth.uid()` -- bajo sesión de sistema `auth.uid()` es NULL (mismo
-- mecanismo documentado en el README raíz, "Sesión de sistema sin acceso a
-- core.property"), así que CUALQUIER lectura directa de esa tabla (incluida
-- `loadLiveWaitlistCandidates`, que corre ANTES de llegar siquiera a
-- `claim_waitlist_notification_slot`) devuelve CERO filas en silencio -- a
-- diferencia de `citas.providers`, que sí tiene una policy pública adicional
-- ("cualquiera puede ver proveedores activos") pensada exactamente para este
-- caso. Los escenarios "GAP RLS" de abajo lo demuestran de forma aislada. Esto
-- ya afectaba, ANTES de este PR, a los 2 callers que YA corrían en sesión de
-- sistema (cancelar/reagendar desde el agente de voz/WhatsApp,
-- apps/api/.../citas/appointments-lifecycle.ts) -- no es una regresión de este
-- fix, es un bug preexistente e independiente que este fix no puede resolver
-- sin una migración nueva (fuera de alcance: esta tarea viene asignada SIN
-- migración).
--
-- Cada bloque ANTES/DESPUÉS hace su propio `begin; ... commit;` real (con un
-- `rollback;` final inofensivo solo para calzar con el contrato de
-- scripts/verify-real-postgres-ci/run-gate.mjs -- ver el comentario de cabecera
-- de scripts/verify-correo-inline-sesion-staff/assertions.sql para el detalle
-- completo de esta convención) -- así que SÍ persiste entre escenarios en la
-- misma base efímera, a propósito.
\set ON_ERROR_STOP off
\pset pager off

-- ============================================================================
-- Fixture -- una organización de citas, un staff con membership, 3 proveedores
-- (uno por escenario, para no chocar con el EXCLUDE de solapamiento), un
-- servicio, un cliente, 3 citas 'confirmed' y 2 candidatos de lista de espera
-- 'active' que matchean el hueco que cada cancelación libera.
-- ============================================================================

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a9', 'citas', 'Org Citas a3', 'org-citas-a3')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c9', 'staff-a3@example.com', 'Staff a3', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000a9', null, 'admin', 'admin')
on conflict do nothing;

insert into citas.providers (id, organization_id, display_name) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a9', 'Proveedor 1 (antes)'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a9', 'Proveedor 2 (despues)'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a9', 'Proveedor 3 (esquema a medias)')
on conflict do nothing;

insert into citas.services (id, organization_id, name, duration_minutes) values
  ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000a9', 'Consulta', 30)
on conflict do nothing;

insert into citas.customers (id, organization_id, full_name, phone, email) values
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000a9', 'Cliente a3', '5215500000099', 'cliente-a3@example.com')
on conflict do nothing;

insert into citas.appointments (id, organization_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000f9', now() + interval '1 day', now() + interval '1 day 30 minutes', 'confirmed'),
  ('00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000f9', now() + interval '1 day', now() + interval '1 day 30 minutes', 'confirmed'),
  ('00000000-0000-0000-0000-000000000a03', '00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000f9', now() + interval '1 day', now() + interval '1 day 30 minutes', 'confirmed')
on conflict do nothing;

insert into citas.appointment_waitlist (id, organization_id, customer_phone, customer_name, provider_id, status) values
  ('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-0000000000a9', '5215500000001', 'Candidato 1', '00000000-0000-0000-0000-0000000000d1', 'active'),
  ('00000000-0000-0000-0000-000000000b02', '00000000-0000-0000-0000-0000000000a9', '5215500000002', 'Candidato 2', '00000000-0000-0000-0000-0000000000d2', 'active'),
  ('00000000-0000-0000-0000-000000000b04', '00000000-0000-0000-0000-0000000000a9', '5215500000004', 'Candidato 3', '00000000-0000-0000-0000-0000000000d3', 'active')
on conflict do nothing;

-- =============================================================================
-- ANTES -- reproduce el bug tal como está el código hoy en main (sin este PR):
-- claim_waitlist_notification_slot sin SAVEPOINT alguno.
-- =============================================================================

\echo '=== ANTES (sin SAVEPOINT): cancelar cita a01 + claim_waitlist_notification_slot (42501, sin protección) + encolar correo + commit -- reproduce el hallazgo confirmado a3 #1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c9', true);
select citas.cancel_appointment_from_panel('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-000000000a01');
\set ON_ERROR_STOP off
select * from citas.claim_waitlist_notification_slot('00000000-0000-0000-0000-000000000b01', 3);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000a9', 'email', 'appointment.cancelled', 'cancelled:a01', '{"to":"cliente-a3@example.com"}'::jsonb);
\set ON_ERROR_STOP on
commit;
rollback;

\echo '=== ANTES: la cita a01 SIGUE "confirmed" -- la cancelación se perdió con el commit sobre la transacción abortada (deberia_ser_1 = bug reproducido) ==='
begin;
select (status = 'confirmed')::int as antes_cancelacion_perdida_deberia_ser_1 from citas.appointments where id = '00000000-0000-0000-0000-000000000a01';
rollback;

\echo '=== ANTES: el correo de cancelación TAMBIÉN se perdió (nunca llegó a insertarse -- deberia_ser_0) ==='
begin;
select count(*) as antes_correo_perdido_deberia_ser_0 from citas.messaging_outbox where organization_id = '00000000-0000-0000-0000-0000000000a9' and dedupe_key = 'cancelled:a01';
rollback;

-- =============================================================================
-- DESPUÉS -- con el fix real de este PR (SAVEPOINT alrededor del intento de
-- claim, mismo patrón que packages/domain-citas/src/reminders.ts
-- ::tryNotifyWaitlistOfFreedSlot tras el hotfix).
-- =============================================================================

\echo '=== DESPUES (con SAVEPOINT): cancelar cita a02 + SAVEPOINT + claim_waitlist_notification_slot (42501, protegido) + ROLLBACK TO SAVEPOINT + encolar correo + commit -- la cancelación PERSISTE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c9', true);
select citas.cancel_appointment_from_panel('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-000000000a02');
savepoint sp_waitlist_notify;
\set ON_ERROR_STOP off
select * from citas.claim_waitlist_notification_slot('00000000-0000-0000-0000-000000000b02', 3);
\set ON_ERROR_STOP on
rollback to savepoint sp_waitlist_notify;
release savepoint sp_waitlist_notify;
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000a9', 'email', 'appointment.cancelled', 'cancelled:a02', '{"to":"cliente-a3@example.com"}'::jsonb);
commit;
rollback;

\echo '=== DESPUES: la cita a02 quedó "cancelled" de verdad -- el fix funciona (deberia_ser_1) ==='
begin;
select (status = 'cancelled')::int as despues_cancelacion_persiste_deberia_ser_1 from citas.appointments where id = '00000000-0000-0000-0000-000000000a02';
rollback;

\echo '=== DESPUES: el correo de cancelación SÍ quedó encolado (deberia_ser_1) ==='
begin;
select count(*) as despues_correo_encolado_deberia_ser_1 from citas.messaging_outbox where organization_id = '00000000-0000-0000-0000-0000000000a9' and dedupe_key = 'cancelled:a02';
rollback;

\echo '=== DESPUES: el guard SQL sigue intacto -- el candidato b02 NO fue reclamado por la sesión de staff (notified_count sigue 0, el SAVEPOINT NO afloja el guard, solo aísla el error -- deberia_ser_0) ==='
begin;
select notified_count as despues_guard_intacto_no_reclamado_por_staff_deberia_ser_0 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-000000000b02';
rollback;

-- =============================================================================
-- GAP RLS descubierto durante esta verificación (ver comentario de cabecera del
-- archivo) -- NO corregido en este PR, documentado en
-- packages/domain-citas/README.md y en knownGaps del PR. Demuestra por qué el
-- SAVEPOINT (arriba) evita el 500 pero el aviso real a la lista de espera sigue
-- sin poder salir ni siquiera desde la sesión de sistema post-commit a la que
-- este PR mueve la llamada.
-- =============================================================================

\echo '=== GAP RLS: en sesión de STAFF (auth.uid() real), el candidato b01 SÍ es visible (RLS funciona como se espera para el panel -- deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c9', true);
select count(*) as staff_ve_candidato_lista_espera_deberia_ser_1 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-000000000b01';
rollback;

\echo '=== GAP RLS: en sesión de SISTEMA (auth.uid() null, MISMO patrón que runCitasWaitlistNotifyAfterCancel post-commit y que el agente de voz/WhatsApp ya usa hoy), el MISMO candidato b01 es INVISIBLE -- 0 filas en silencio, ninguna excepción -- citas.appointment_waitlist NO tiene una policy de sistema como sí tiene citas.providers (deberia_ser_0, documenta el gap, NO es el comportamiento deseado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_no_ve_candidato_lista_espera_gap_rls_deberia_ser_0 from citas.appointment_waitlist where id = '00000000-0000-0000-0000-000000000b01';
rollback;

-- =============================================================================
-- "Esquema de producción a medias" -- dentro de este mismo fixture, revoca lo
-- que la migración 015 (packages/domain-citas/migrations/
-- 015_rpc_anti_duplicado_authenticated_grants.sql) agrega, para probar que el
-- mecanismo NO depende de que esa migración esté aplicada: sin su GRANT,
-- `authenticated` no tiene EXECUTE en absoluto sobre
-- claim_waitlist_notification_slot -- Postgres real responde "permission
-- denied", TAMBIÉN código 42501 (ver auditoria-a3-resultado.json::confirmed[0],
-- "el fallo no depende del estado de migraciones"). El fix (SAVEPOINT) debe
-- seguir protegiendo la cancelación igual.
-- =============================================================================

revoke execute on function citas.claim_waitlist_notification_slot(uuid, integer) from authenticated;

\echo '=== ESQUEMA A MEDIAS (sin el GRANT de la migración 015): cancelar cita a03 + SAVEPOINT + claim_waitlist_notification_slot ("permission denied", 42501 igual) + commit -- la cancelación PERSISTE sin depender de qué migraciones estén aplicadas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c9', true);
select citas.cancel_appointment_from_panel('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-000000000a03');
savepoint sp_waitlist_notify;
\set ON_ERROR_STOP off
select * from citas.claim_waitlist_notification_slot('00000000-0000-0000-0000-000000000b04', 3);
\set ON_ERROR_STOP on
rollback to savepoint sp_waitlist_notify;
release savepoint sp_waitlist_notify;
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-0000000000a9', 'email', 'appointment.cancelled', 'cancelled:a03', '{"to":"cliente-a3@example.com"}'::jsonb);
commit;
rollback;

\echo '=== ESQUEMA A MEDIAS: la cita a03 quedó "cancelled" de verdad, sin el GRANT de la migración 015 -- prueba que el fix no depende del estado de migraciones (deberia_ser_1) ==='
begin;
select (status = 'cancelled')::int as esquema_a_medias_cancelacion_persiste_deberia_ser_1 from citas.appointments where id = '00000000-0000-0000-0000-000000000a03';
rollback;

\echo '=== FIN -- 9 escenarios de valor (3 ANTES, 3 DESPUES, 1 guard-intacto, 2 GAP-RLS) + 1 ESQUEMA-A-MEDIAS = 10 en total. Los 3 bloques ANTES/DESPUES/ESQUEMA-A-MEDIAS de arriba deben completar sin ERROR (los 42501/permission-denied se absorben con ON_ERROR_STOP off, a propósito). ==='
