-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0025_superadmin_mfa_switches_orgs.sql:
--
--   A) MFA TOTP: solo-sistema para leer/escribir el factor y registrar intentos
--      (un `authenticated` NO puede declarar "codigo correcto"); anon sin acceso;
--      superadmin real obligatorio al enrolar; factor activo no reemplazable;
--      bloqueo tras 5 fallos; reuso de paso TOTP rechazado; reset solo por OTRO
--      superadmin con motivo; el ciphertext solo existe en la tabla sin GRANT.
--   B) Interruptores: caller-binding, superadmin real, anon sin EXECUTE, motivo,
--      CHECK de claves validas en la BASE, lectura de bloqueados solo-sistema.
--   C) Organizaciones: solicitar->confirmar, solo el solicitante confirma/cancela,
--      una sola accion pendiente por organizacion, vencimiento, re-validacion al
--      confirmar, reactivar restaura el estado previo, alta crea la organizacion,
--      aislamiento entre organizaciones, inmutabilidad de la bitacora.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada
-- escenario es un `begin; ... rollback;` propio; `as should_fail` = debe terminar
-- en ERROR; `as deberia_ser_N` = la ultima fila debe valer N; el resto debe
-- completar sin error. Una sesion de SISTEMA es el rol `authenticated` con
-- request.jwt.claim.sub vacio (auth.uid() NULL) -- igual que
-- managed-postgres-engine.ts::withAppSession({ userId: null }).
\set ON_ERROR_STOP off
\pset pager off

-- ═══════════════════════════════════════════════════════════════════════════
-- Fixtures
-- ═══════════════════════════════════════════════════════════════════════════
insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000d1000', 'restaurantes', 'Org A activa', 'org-sa-a', 'active'),
  ('00000000-0000-0000-0000-0000000d1001', 'hoteles', 'Org B prueba', 'org-sa-b', 'trial'),
  ('00000000-0000-0000-0000-0000000d1002', 'citas', 'Org C suspendida', 'org-sa-c', 'suspended'),
  ('00000000-0000-0000-0000-0000000d1003', 'rentas', 'Org D activa', 'org-sa-d', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0100', 'sa-mfa-1@example.com', 'Superadmin MFA 1', 'seed'),
  ('00000000-0000-0000-0000-0000000d0101', 'sa-mfa-2@example.com', 'Superadmin MFA 2', 'seed'),
  ('00000000-0000-0000-0000-0000000d0102', 'staff-normal-mfa@example.com', 'Staff normal', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000d0100'),
  ('00000000-0000-0000-0000-0000000d0101')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0102', '00000000-0000-0000-0000-0000000d1000', null, 'owner', 'staff')
on conflict do nothing;

-- Interruptor ya bloqueado + accion de organizacion YA vencida (insertados como el
-- dueño, sin pasar por las funciones, para ejercitar lecturas/vencimiento).
insert into core.platform_switch (scope, target, blocked, reason, updated_by) values
  ('agente', 'restaurantes:whatsapp_agent', true, 'Fixture: interruptor activo para lecturas de verificacion.', '00000000-0000-0000-0000-0000000d0100')
on conflict do nothing;

insert into core.org_admin_action (id, tipo, organization_id, payload, motivo, creado_por, creado_en, vence_en) values
  ('00000000-0000-0000-0000-0000000d2000', 'suspender', '00000000-0000-0000-0000-0000000d1003', '{}'::jsonb,
   'Fixture: accion ya vencida que nadie confirmo a tiempo.', '00000000-0000-0000-0000-0000000d0100', now() - interval '2 hours', now() - interval '1 hour')
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- A) MFA
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'A1. begin_enrollment como authenticated con auth.uid() real (NO sistema) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc') as should_fail;
rollback;

\echo 'A2. begin_enrollment (sistema) para un usuario que NO es superadmin -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0102', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc') as should_fail;
rollback;

\echo 'A3. anon no puede ejecutar begin_enrollment (sin GRANT EXECUTE) -- RECHAZADO'
begin;
set local role anon;
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc') as should_fail;
rollback;

\echo 'A4. begin_enrollment con ciphertext demasiado corto (CHECK de la tabla) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'x') as should_fail;
rollback;

\echo 'A5. begin_enrollment (sistema) para superadmin real -- OK y get_factor lo ve pendiente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select count(*) as deberia_ser_1 from core.superadmin_mfa_get_factor('00000000-0000-0000-0000-0000000d0100') where status = 'pending';
rollback;

\echo 'A6. get_factor como authenticated con auth.uid() real -- RECHAZADO (el ciphertext nunca sale por RPC de cliente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select * from core.superadmin_mfa_get_factor('00000000-0000-0000-0000-0000000d0100') as should_fail;
rollback;

\echo 'A7. record_attempt como authenticated con auth.uid() real -- RECHAZADO (nadie declara "codigo correcto" desde un cliente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 100) as should_fail;
rollback;

\echo 'A8. record_attempt sin factor -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0101', true, 100) as should_fail;
rollback;

\echo 'A9. acierto sobre factor pendiente lo ACTIVA'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select (core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 100) = 'activated')::int as deberia_ser_1;
rollback;

\echo 'A10. mismo paso TOTP otra vez -- replay'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 100);
select (core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 100) = 'replay')::int as deberia_ser_1;
rollback;

\echo 'A11. paso TOTP MAS VIEJO que el ultimo usado -- replay'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 100);
select (core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 99) = 'replay')::int as deberia_ser_1;
rollback;

\echo 'A12. paso TOTP MAS NUEVO -- ok'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 100);
select (core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 101) = 'ok')::int as deberia_ser_1;
rollback;

\echo 'A13. acierto sin p_step -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, null) as should_fail;
rollback;

\echo 'A14. 4 fallos = invalid, el 5o bloquea'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select (core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null) = 'locked')::int as deberia_ser_1;
rollback;

\echo 'A15. con el factor bloqueado, ni un codigo correcto pasa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select (core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 500) = 'locked')::int as deberia_ser_1;
rollback;

\echo 'A16. un acierto reinicia el contador de fallos (4 fallos + acierto + 4 fallos NO bloquea)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 100);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null);
select (core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', false, null) = 'invalid')::int as deberia_ser_1;
rollback;

\echo 'A17. un factor ACTIVO no se reemplaza con begin_enrollment -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_record_attempt('00000000-0000-0000-0000-0000000d0100', true, 100);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.zzzzzzzzzzzzzzzz.yyyyyyyyyyyyyyyy.xxxxxxxxxxxxxxxx') as should_fail;
rollback;

\echo 'A18. un factor PENDIENTE si se puede reiniciar (re-escanear el QR)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.zzzzzzzzzzzzzzzz.yyyyyyyyyyyyyyyy.xxxxxxxxxxxxxxxx');
select count(*) as deberia_ser_1 from core.superadmin_mfa_get_factor('00000000-0000-0000-0000-0000000d0100') where secret_ciphertext like 'v1.zzzz%';
rollback;

\echo 'A19. mfa_status: el superadmin ve SU factor'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select count(*) as deberia_ser_1 from core.superadmin_mfa_status('00000000-0000-0000-0000-0000000d0100');
rollback;

\echo 'A20. mfa_status con caller-binding invalido (auth.uid()=sa2, p_caller_id=sa1) -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select count(*) as deberia_ser_0 from core.superadmin_mfa_status('00000000-0000-0000-0000-0000000d0100');
rollback;

\echo 'A21. mfa_status para staff que NO es superadmin -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0102', true);
select count(*) as deberia_ser_0 from core.superadmin_mfa_status('00000000-0000-0000-0000-0000000d0102');
rollback;

\echo 'A22. la tabla del factor NO es legible directo por authenticated (sin GRANT) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select count(*) as should_fail from core.superadmin_mfa_factor;
rollback;

\echo 'A23. reset del PROPIO factor -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.superadmin_mfa_reset('00000000-0000-0000-0000-0000000d0100', '00000000-0000-0000-0000-0000000d0100', 'Intento de resetear mi propio factor MFA.') as should_fail;
rollback;

\echo 'A24. reset por staff que NO es superadmin -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0102', true);
select core.superadmin_mfa_reset('00000000-0000-0000-0000-0000000d0102', '00000000-0000-0000-0000-0000000d0100', 'Staff normal intentando resetear el MFA de un superadmin.') as should_fail;
rollback;

\echo 'A25. reset con motivo corto -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.superadmin_mfa_reset('00000000-0000-0000-0000-0000000d0101', '00000000-0000-0000-0000-0000000d0100', 'corto') as should_fail;
rollback;

\echo 'A26. reset de un usuario SIN factor -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.superadmin_mfa_reset('00000000-0000-0000-0000-0000000d0101', '00000000-0000-0000-0000-0000000d0100', 'Reset de alguien que nunca enrolo un factor MFA.') as should_fail;
rollback;

\echo 'A27. reset por OTRO superadmin con motivo -- OK: el factor desaparece y queda en la bitacora'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.superadmin_mfa_reset('00000000-0000-0000-0000-0000000d0101', '00000000-0000-0000-0000-0000000d0100', 'Dispositivo perdido, verificado por llamada con el titular.');
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.superadmin_mfa_get_factor('00000000-0000-0000-0000-0000000d0100');
rollback;

\echo 'A28. el reset queda en la bitacora (visible para un superadmin)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_mfa_begin_enrollment('00000000-0000-0000-0000-0000000d0100', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.superadmin_mfa_reset('00000000-0000-0000-0000-0000000d0101', '00000000-0000-0000-0000-0000000d0100', 'Dispositivo perdido, verificado por llamada con el titular.');
select count(*) as deberia_ser_1 from core.list_superadmin_security_events('00000000-0000-0000-0000-0000000d0101', 'mfa', 50) where event = 'mfa_reset';
rollback;

\echo 'A29. la bitacora NO se lee con un usuario que no es superadmin -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0102', true);
select count(*) as deberia_ser_0 from core.list_superadmin_security_events('00000000-0000-0000-0000-0000000d0102', null, 50);
rollback;

\echo 'A30. la tabla de bitacora NO es legible directo (sin GRANT) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select count(*) as should_fail from core.superadmin_security_event;
rollback;

\echo 'A31. bitacora append-only: UPDATE bloqueado incluso para el dueño -- RECHAZADO'
begin;
insert into core.superadmin_security_event (area, event) values ('mfa', 'mfa_verified');
update core.superadmin_security_event set area = 'org' where event = 'mfa_verified' returning 1 as should_fail;
rollback;

\echo 'A32. bitacora append-only: DELETE bloqueado incluso para el dueño -- RECHAZADO'
begin;
insert into core.superadmin_security_event (area, event) values ('mfa', 'mfa_verified');
delete from core.superadmin_security_event where event = 'mfa_verified' returning 1 as should_fail;
rollback;

\echo 'A33. anon no ve funciones de lectura (sin GRANT EXECUTE) -- RECHAZADO'
begin;
set local role anon;
select * from core.list_superadmin_security_events('00000000-0000-0000-0000-0000000d0100', null, 10) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Interruptores
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'B1. set_platform_switch por staff que NO es superadmin -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0102', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0102', 'global', 'llm', true, 'Intento de staff normal de apagar el LLM global.') as should_fail;
rollback;

\echo 'B2. set_platform_switch con caller-binding invalido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'global', 'llm', true, 'Paso el UUID de otro superadmin como p_caller_id.') as should_fail;
rollback;

\echo 'B3. set_platform_switch como anon -- RECHAZADO'
begin;
set local role anon;
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'global', 'llm', true, 'anon nunca deberia llegar hasta aqui nunca.') as should_fail;
rollback;

\echo 'B4. set_platform_switch con motivo corto -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'global', 'llm', true, 'corto') as should_fail;
rollback;

\echo 'B5. clave invalida: cron fuera de /internal/ -- RECHAZADO por el CHECK de la base'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'cron', '/etc/passwd', true, 'Clave de cron invalida que no empieza con /internal/.') as should_fail;
rollback;

\echo 'B6. clave invalida: agente sin el formato vertical:rol -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'agente', 'Foo', true, 'Clave de agente invalida sin dos puntos ni minusculas.') as should_fail;
rollback;

\echo 'B7. clave invalida: global con objetivo desconocido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'global', 'todo', true, 'Objetivo global desconocido que el CHECK debe rechazar.') as should_fail;
rollback;

\echo 'B8. alcance invalido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'tenant', 'x', true, 'Alcance tenant no existe en el catalogo de interruptores.') as should_fail;
rollback;

\echo 'B9. p_blocked nulo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'global', 'llm', null, 'Sin valor de bloqueo no se puede decidir nada aqui.') as should_fail;
rollback;

\echo 'B10. superadmin bloquea un agente: el sistema lo ve en get_blocked'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0101', 'cron', '/internal/whatsapp/dispatch', true, 'Pausa del dispatcher por incidente de proveedor verificado.');
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.get_blocked_platform_switches() where scope = 'cron' and target = '/internal/whatsapp/dispatch';
rollback;

\echo 'B11. el interruptor fixture (agente restaurantes) tambien aparece bloqueado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.get_blocked_platform_switches() where scope = 'agente' and target = 'restaurantes:whatsapp_agent';
rollback;

\echo 'B12. desbloquear lo saca de get_blocked'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0100', 'agente', 'restaurantes:whatsapp_agent', false, 'Incidente resuelto, se reactiva el agente de WhatsApp.');
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_blocked_platform_switches() where target = 'restaurantes:whatsapp_agent';
rollback;

\echo 'B13. get_blocked con auth.uid() real -- RECHAZADO (solo sistema)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select * from core.get_blocked_platform_switches() as should_fail;
rollback;

\echo 'B14. anon no puede leer get_blocked -- RECHAZADO'
begin;
set local role anon;
select * from core.get_blocked_platform_switches() as should_fail;
rollback;

\echo 'B15. lista de interruptores: staff normal ve cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0102', true);
select count(*) as deberia_ser_0 from core.list_platform_switches_for_superadmin('00000000-0000-0000-0000-0000000d0102');
rollback;

\echo 'B16. lista de interruptores: superadmin ve el del fixture'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select count(*) as deberia_ser_1 from core.list_platform_switches_for_superadmin('00000000-0000-0000-0000-0000000d0100') where target = 'restaurantes:whatsapp_agent';
rollback;

\echo 'B17. la tabla de interruptores NO es legible ni escribible directo por authenticated -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
insert into core.platform_switch (scope, target, blocked, reason) values ('global', 'llm', true, 'Escritura directa sin pasar por la funcion de superadmin.') returning 1 as should_fail;
rollback;

\echo 'B18. cada cambio de interruptor queda en la bitacora con el actor'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000d0101', 'global', 'llm', true, 'Corte global de LLM por gasto fuera de control detectado.');
select count(*) as deberia_ser_1 from core.list_superadmin_security_events('00000000-0000-0000-0000-0000000d0101', 'switch', 50) where actor_user_id = '00000000-0000-0000-0000-0000000d0101';
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Organizaciones
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'C1. solicitar como staff que NO es superadmin -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0102', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0102', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Staff normal intentando suspender a su propia organizacion.') as should_fail;
rollback;

\echo 'C2. solicitar con caller-binding invalido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Paso el UUID de otro superadmin como p_caller_id aqui.') as should_fail;
rollback;

\echo 'C3. solicitar como anon -- RECHAZADO'
begin;
set local role anon;
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'anon intentando suspender una organizacion cualquiera.') as should_fail;
rollback;

\echo 'C4. solicitar con motivo corto -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'corto') as should_fail;
rollback;

\echo 'C5. solicitar sobre organizacion inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d19ff', '{}', 'Organizacion que no existe en core.organization en absoluto.') as should_fail;
rollback;

\echo 'C6. suspender una organizacion YA suspendida -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1002', '{}', 'Suspender algo que ya esta suspendido no tiene sentido.') as should_fail;
rollback;

\echo 'C7. reactivar una organizacion que NO esta suspendida -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'reactivar', '00000000-0000-0000-0000-0000000d1000', '{}', 'Reactivar algo que esta activo no tiene sentido aqui.') as should_fail;
rollback;

\echo 'C8. cambiar_plan con plan invalido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'cambiar_plan', '00000000-0000-0000-0000-0000000d1000', '{"plan":"enterprise"}', 'Plan que no existe en el catalogo de planes de cuenta.') as should_fail;
rollback;

\echo 'C9. cambiar_plan al plan que YA tiene -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'cambiar_plan', '00000000-0000-0000-0000-0000000d1000', '{"plan":"active"}', 'La organizacion ya esta en el plan activo, nada que cambiar.') as should_fail;
rollback;

\echo 'C10. cambiar_plan sobre una organizacion suspendida -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'cambiar_plan', '00000000-0000-0000-0000-0000000d1002', '{"plan":"active"}', 'No se cambia el plan de una organizacion suspendida sin reactivar.') as should_fail;
rollback;

\echo 'C11. alta con slug invalido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'alta', null, '{"vertical":"citas","name":"Clinica Nueva","slug":"Slug Invalido!"}', 'Alta con un slug que no cumple el formato permitido por la base.') as should_fail;
rollback;

\echo 'C12. alta con slug que YA existe -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'alta', null, '{"vertical":"citas","name":"Clinica Nueva","slug":"org-sa-a"}', 'Alta con un slug que ya pertenece a otra organizacion existente.') as should_fail;
rollback;

\echo 'C13. alta con vertical invalida -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'alta', null, '{"vertical":"pizzerias","name":"Clinica Nueva","slug":"clinica-nueva"}', 'Alta con una vertical que no existe en el catalogo de la plataforma.') as should_fail;
rollback;

\echo 'C14. alta que recibe organization_id -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'alta', '00000000-0000-0000-0000-0000000d1000', '{"vertical":"citas","name":"Clinica Nueva","slug":"clinica-nueva"}', 'Alta que intenta colgarse de una organizacion ya existente.') as should_fail;
rollback;

\echo 'C15. tipo desconocido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'borrar', '00000000-0000-0000-0000-0000000d1000', '{}', 'Tipo de accion que no existe: borrar organizaciones enteras.') as should_fail;
rollback;

\echo 'C16. solicitar suspender SOLO crea la accion: la organizacion sigue activa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.');
reset role;
select (status = 'active')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1000';
rollback;

\echo 'C17. solicitar + confirmar suspender: la organizacion queda suspendida'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
reset role;
select (status = 'suspended')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1000';
rollback;

\echo 'C18. suspender A NO toca a la organizacion B (aislamiento entre organizaciones)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
reset role;
select (status = 'trial')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1001';
rollback;

\echo 'C19. confirmar por OTRO superadmin -- RECHAZADO (solo el solicitante)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0101', (select id from _a)) as should_fail;
rollback;

\echo 'C20. confirmar por staff que NO es superadmin -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0102', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0102', (select id from _a)) as should_fail;
rollback;

\echo 'C21. confirmar como anon -- RECHAZADO'
begin;
set local role anon;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', '00000000-0000-0000-0000-0000000d2000') as should_fail;
rollback;

\echo 'C22. confirmar una accion inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', '00000000-0000-0000-0000-0000000d29ff') as should_fail;
rollback;

\echo 'C23. confirmar dos veces la misma accion -- el segundo RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a)) as should_fail;
rollback;

\echo 'C24. una accion vencida no se ejecuta: queda expired y la organizacion NO cambia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', '00000000-0000-0000-0000-0000000d2000');
reset role;
select (status = 'active')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1003';
rollback;

\echo 'C25. la accion vencida queda marcada expired'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select (core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', '00000000-0000-0000-0000-0000000d2000')).estado = 'expired' as ok;
reset role;
select (estado = 'expired')::int as deberia_ser_1 from core.org_admin_action where id = '00000000-0000-0000-0000-0000000d2000';
rollback;

\echo 'C26. dos acciones pendientes sobre la misma organizacion -- la segunda RECHAZADA'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Primera solicitud de suspension de la organizacion A.');
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'cambiar_plan', '00000000-0000-0000-0000-0000000d1000', '{"plan":"trial"}', 'Segunda solicitud sobre la misma organizacion A pendiente.') as should_fail;
rollback;

\echo 'C27. cancelar por el solicitante -- OK y la organizacion no cambia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select core.cancel_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
reset role;
select (status = 'active')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1000';
rollback;

\echo 'C28. cancelar por OTRO superadmin -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select core.cancel_org_admin_action('00000000-0000-0000-0000-0000000d0101', (select id from _a)) as should_fail;
rollback;

\echo 'C29. confirmar una accion CANCELADA -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select core.cancel_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a)) as should_fail;
rollback;

\echo 'C30. re-validacion al confirmar: si la organizacion ya fue suspendida por otro camino -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
reset role;
update core.organization set status = 'suspended' where id = '00000000-0000-0000-0000-0000000d1000';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a)) as should_fail;
rollback;

\echo 'C31. reactivar restaura el estado previo a la suspension (active)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
create temp table _b on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'reactivar', '00000000-0000-0000-0000-0000000d1000', '{}', 'El cliente regularizo su pago, se reactiva la cuenta.')).id as id;
grant select on _b to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _b));
reset role;
select (status = 'active')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1000';
rollback;

\echo 'C32. reactivar restaura el estado previo (trial, no active)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1001', '{}', 'Cuenta de prueba abusada, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
create temp table _b on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'reactivar', '00000000-0000-0000-0000-0000000d1001', '{}', 'El cliente aclaro el abuso, se reactiva su cuenta de prueba.')).id as id;
grant select on _b to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _b));
reset role;
select (status = 'trial')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1001';
rollback;

\echo 'C33. reactivar una organizacion suspendida sin historial (fixture C) la deja active'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _b on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'reactivar', '00000000-0000-0000-0000-0000000d1002', '{}', 'Suspension heredada sin registro previo, se reactiva la cuenta.')).id as id;
grant select on _b to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _b));
reset role;
select (status = 'active')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1002';
rollback;

\echo 'C34. cambiar_plan trial -> active se ejecuta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'cambiar_plan', '00000000-0000-0000-0000-0000000d1001', '{"plan":"active"}', 'La prueba termino y el cliente firmo, pasa a cuenta activa.')).id as id;
grant select on _a to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
reset role;
select (status = 'active')::int as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d1001';
rollback;

\echo 'C35. alta: solicitar + confirmar crea la organizacion en trial'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'alta', null, '{"vertical":"citas","name":"Clinica Nueva","slug":"clinica-nueva-sa"}', 'Cliente nuevo cerrado por ventas, se da de alta su organizacion.')).id as id;
grant select on _a to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
reset role;
select count(*) as deberia_ser_1 from core.organization where slug = 'clinica-nueva-sa' and status = 'trial' and vertical = 'citas';
rollback;

\echo 'C36. alta solo solicitada NO crea la organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'alta', null, '{"vertical":"citas","name":"Clinica Nueva","slug":"clinica-nueva-sa"}', 'Cliente nuevo cerrado por ventas, se da de alta su organizacion.');
reset role;
select count(*) as deberia_ser_0 from core.organization where slug = 'clinica-nueva-sa';
rollback;

\echo 'C37. alta: si el slug se ocupa entre solicitar y confirmar -- el confirmar RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'alta', null, '{"vertical":"citas","name":"Clinica Nueva","slug":"clinica-carrera"}', 'Cliente nuevo cerrado por ventas, se da de alta su organizacion.')).id as id;
grant select on _a to authenticated;
reset role;
insert into core.organization (vertical, name, slug) values ('citas', 'Otro con el mismo slug', 'clinica-carrera');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a)) as should_fail;
rollback;

\echo 'C38. la lista de acciones: staff normal ve cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0102', true);
select count(*) as deberia_ser_0 from core.list_org_admin_actions_for_superadmin('00000000-0000-0000-0000-0000000d0102', 50);
rollback;

\echo 'C39. la lista de acciones: superadmin ve la del fixture'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0101', true);
select count(*) as deberia_ser_1 from core.list_org_admin_actions_for_superadmin('00000000-0000-0000-0000-0000000d0101', 50) where id = '00000000-0000-0000-0000-0000000d2000';
rollback;

\echo 'C40. la tabla de acciones NO se escribe directo por authenticated -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
insert into core.org_admin_action (tipo, organization_id, payload, motivo, creado_por, vence_en)
values ('suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Escritura directa sin pasar por la funcion de superadmin.', '00000000-0000-0000-0000-0000000d0100', now() + interval '5 minutes') returning 1 as should_fail;
rollback;

\echo 'C41. la bitacora de acciones es inmutable: cambiar el motivo -- RECHAZADO'
begin;
update core.org_admin_action set motivo = 'Motivo reescrito despues de los hechos para borrar el rastro.' where id = '00000000-0000-0000-0000-0000000d2000' returning 1 as should_fail;
rollback;

\echo 'C42. la bitacora de acciones es inmutable: reabrir un estado terminal -- RECHAZADO'
begin;
update core.org_admin_action set estado = 'expired' where id = '00000000-0000-0000-0000-0000000d2000';
update core.org_admin_action set estado = 'pending' where id = '00000000-0000-0000-0000-0000000d2000' returning 1 as should_fail;
rollback;

\echo 'C43. la bitacora de acciones es inmutable: DELETE -- RECHAZADO'
begin;
delete from core.org_admin_action where id = '00000000-0000-0000-0000-0000000d2000' returning 1 as should_fail;
rollback;

\echo 'C44. ejecutar una accion deja evento org_action_executed en la bitacora'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000d0100', 'suspender', '00000000-0000-0000-0000-0000000d1000', '{}', 'Cliente en mora de 90 dias, se suspende previa confirmacion.')).id as id;
grant select on _a to authenticated;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000d0100', (select id from _a));
select count(*) as deberia_ser_1 from core.list_superadmin_security_events('00000000-0000-0000-0000-0000000d0100', 'org', 50) where event = 'org_action_executed';
rollback;

\echo ''
\echo '=== Fin. Los escenarios "should_fail"/"deberia_ser_N" los evalua scripts/verify-real-postgres-ci/run-gate.mjs; a mano, cada should_fail debe terminar en ERROR y cada deberia_ser_N en su valor. ==='
