-- Verificación contra Postgres REAL de f2-citas-whatsapp-config-sesion-sistema:
--
--   El webhook entrante de WhatsApp de citas
--   (`apps/api/.../citas/whatsapp.ts::POST /v1/citas/whatsapp/webhook`) abre su
--   PROPIA sesión de SISTEMA (`deps.engine.withAppSession({ userId: null }, ...)`,
--   sin `authMiddleware`/JWT -- Meta no manda ningún usuario autenticado) y usa
--   `resolveOrganizationByPhoneNumberId` (SELECT plano contra
--   `citas.whatsapp_config`, policy de RLS SOLO de staff, 003_waitlist_and_
--   rate_limit.sql) como PRIMERA consulta real de esa sesión, para rutear el
--   mensaje entrante a la organización dueña de ese `phone_number_id`. Bajo
--   `auth.uid()` NULL esa policy SIEMPRE deniega -- 0 filas, en silencio -- así
--   que este webhook JAMÁS resolvía ninguna organización contra Postgres real:
--   cada mensaje entrante caía en la rama "número no configurado en la
--   plataforma" (ack silencioso, sin reintento), sin importar qué tan bien
--   configurado estuviera el negocio. Mismo gap EXACTO, mismo mecanismo, que ya
--   se cerró para la dirección de SALIDA (`resolveActiveWhatsAppPhoneNumberId`,
--   migración 021) -- este es el gap INVERSO, documentado ahí mismo como
--   pendiente ("PostgresCitasRepository.resolveOrganizationByPhoneNumberId ...
--   tiene el mismo gap en la dirección inversa").
--
--   Arreglo: función `security definer` de SOLO-SISTEMA
--   `citas.system_resolve_organization_by_whatsapp_phone_number_id`
--   (022_whatsapp_config_organizacion_sistema_lectura.sql), mismo patrón EXACTO
--   que `system_resolve_active_whatsapp_phone_number_id` (021).
--
-- Cubre, de punta a punta y contra Postgres real (todas las migraciones reales de
-- `supabase/migrations/`, en orden):
--   1-2.  Controles positivo/cross-tenant de la policy de STAFF sobre
--         `whatsapp_config` (SIN cambio de este PR -- guard de regresión de
--         alcance, mismo criterio que 021/escenarios 1-2).
--   3.    El gap SIGUE existiendo a nivel de SELECT plano por `phone_number_id`
--         bajo sesión de sistema (el fix nunca fue un escape hatch sobre la
--         tabla).
--   4-5.  El fix: la función de sistema SÍ resuelve la organización dueña de
--         cada `phone_number_id`, NUNCA cruza tenant (parámetro
--         `phone_number_id` sigue acotando el resultado a UNA organización).
--   6.    Un `phone_number_id` desconocido en la plataforma resuelve NULL de
--         verdad (nunca un error) -- mismo "número no configurado" honesto de
--         hoy.
--   7.    Regla real de `resolveActiveWhatsAppPhoneNumberId`/021 que este
--         mirror también respeta: `is_active = false` NUNCA resuelve, aunque
--         la fila exista.
--   8-9.  Controles negativos obligatorios: un staff autenticado real NO puede
--         llamar la función de sistema; `anon` tampoco (sin GRANT) -- ambos
--         confirman el SQLSTATE EXACTO 42501 (nunca "cualquier error"), y 9
--         además confirma con `has_function_privilege` que el rechazo es por
--         el REVOKE de EXECUTE (no por falta de USAGE en el schema).
--   10.   "Esquema de producción a medias" (migración 022 NO aplicada): se
--         elimina la función real y se demuestra el SQLSTATE exacto (42883,
--         `undefined_function`) que `isUndefinedFunctionError`/
--         `runWithSavepointFallback` capturan en `postgres-repository.ts`.
--   11.   ESQUEMA A MEDIAS: el staff SIGUE viendo su propio `whatsapp_config`
--         tal cual (la migración nueva no tocó ninguna policy de staff --
--         vacío honesto, nunca una regresión).
--
-- Cada escenario vive en su propio `begin; ... rollback;` (mismo criterio que
-- scripts/verify-citas-lista-de-espera-sistema/assertions.sql).
\set ON_ERROR_STOP off
\pset pager off

-- ============================================================================
-- Fixture -- 2 organizaciones de citas (A: la que se audita; B: solo para el
-- control cross-tenant), un staff con membership en A, y un `whatsapp_config`
-- activo por organización con `phone_number_id` distinto y verificable --
-- exactamente lo que el webhook entrante necesita resolver en sentido inverso.
-- ============================================================================

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000e1', 'citas', 'Org Citas whatsapp-config (A)', 'org-citas-wc-a'),
  ('00000000-0000-0000-0000-0000000000e2', 'citas', 'Org Citas whatsapp-config (B, cross-tenant)', 'org-citas-wc-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000e3', 'staff-wc@example.com', 'Staff whatsapp-config', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000e1', null, 'admin', 'admin')
on conflict do nothing;

insert into citas.whatsapp_config (organization_id, phone_number_id, is_active) values
  ('00000000-0000-0000-0000-0000000000e1', 'phone-wc-a', true),
  ('00000000-0000-0000-0000-0000000000e2', 'phone-wc-b', true),
  ('00000000-0000-0000-0000-0000000000e2', 'phone-wc-b-inactivo', false)
on conflict do nothing;

-- ============================================================================
-- 1-2. Controles positivo/cross-tenant de la policy de STAFF -- SIN cambio de
-- este PR (guard de regresión de alcance).
-- ============================================================================

\echo '=== 1. (control positivo) STAFF de A ve su propio whatsapp_config vía SELECT directo -- la policy de RLS de staff no se tocó (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select count(*) as staff_ve_su_whatsapp_config_deberia_ser_1 from citas.whatsapp_config where organization_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '=== 2. (control cross-tenant) STAFF de A NO ve el whatsapp_config de B vía SELECT directo (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select count(*) as staff_no_ve_whatsapp_config_de_otra_org_deberia_ser_0 from citas.whatsapp_config where organization_id = '00000000-0000-0000-0000-0000000000e2';
rollback;

-- ============================================================================
-- 3. EL GAP (dirección INVERSA) -- sigue existiendo a nivel de SELECT plano: el
-- fix de este PR es una función NUEVA, nunca un escape hatch sobre la tabla.
-- ============================================================================

\echo '=== 3. (el gap, dirección inversa) SESIÓN DE SISTEMA (auth.uid() null): SELECT plano por phone_number_id contra whatsapp_config SIGUE devolviendo 0 filas -- exactamente lo que hacía que el webhook entrante nunca resolviera ninguna organización (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_select_directo_por_telefono_sigue_0_deberia_ser_0 from citas.whatsapp_config where phone_number_id = 'phone-wc-a' and is_active = true;
rollback;

-- ============================================================================
-- 4-5. EL FIX -- citas.system_resolve_organization_by_whatsapp_phone_number_id.
-- ============================================================================

\echo '=== 4. (el fix) SESIÓN DE SISTEMA: system_resolve_organization_by_whatsapp_phone_number_id(phone-wc-a) resuelve la organización A REAL -- el gap queda cerrado (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (citas.system_resolve_organization_by_whatsapp_phone_number_id('phone-wc-a') = '00000000-0000-0000-0000-0000000000e1'::uuid)::int as sistema_funcion_resuelve_org_a_deberia_ser_1;
rollback;

\echo '=== 5. (cross-tenant del fix) SESIÓN DE SISTEMA: system_resolve_organization_by_whatsapp_phone_number_id(phone-wc-b) resuelve la organización B, NUNCA la A -- el parámetro phone_number_id sigue acotando a UNA sola organización (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (citas.system_resolve_organization_by_whatsapp_phone_number_id('phone-wc-b') = '00000000-0000-0000-0000-0000000000e2'::uuid)::int as sistema_funcion_resuelve_org_b_deberia_ser_1;
rollback;

-- ============================================================================
-- 6-7. Comportamiento honesto -- número desconocido / configuración inactiva.
-- ============================================================================

\echo '=== 6. número desconocido en la plataforma: system_resolve_organization_by_whatsapp_phone_number_id resuelve NULL de verdad, nunca un error -- mismo "número no configurado" honesto de hoy (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (citas.system_resolve_organization_by_whatsapp_phone_number_id('phone-que-no-existe') is null)::int as numero_desconocido_resuelve_null_deberia_ser_1;
rollback;

\echo '=== 7. configuración INACTIVA (is_active=false): NUNCA resuelve, aunque la fila exista -- mismo criterio real que resolveActiveWhatsAppPhoneNumberId/021 (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (citas.system_resolve_organization_by_whatsapp_phone_number_id('phone-wc-b-inactivo') is null)::int as config_inactiva_nunca_resuelve_deberia_ser_1;
rollback;

-- ============================================================================
-- 8-9. Controles negativos obligatorios -- staff real / anon.
-- ============================================================================

\echo '=== 8. (negativo, SQLSTATE exacto) un STAFF autenticado real de A NO puede llamar la función de sistema -- guard auth.uid() is null, rechaza incluso al dueño legítimo de los datos, con el código EXACTO 42501 que la función lanza (using errcode) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
do $$
begin
  perform citas.system_resolve_organization_by_whatsapp_phone_number_id('phone-wc-a');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42501 (guard auth.uid() is null) pero la llamada tuvo éxito -- el guard no está rechazando a un staff real';
exception
  when sqlstate '42501' then null; -- esperado: exactamente el código que la función lanza con "using errcode"
end $$;
rollback;

\echo '=== 9. (negativo, SQLSTATE exacto + causa raíz confirmada) anon no tiene GRANT execute sobre la función de sistema -- 42501 exacto, Y confirmado que es el REVOKE de EXECUTE (nunca falta de USAGE en el schema) ==='
begin;
select (not has_function_privilege('anon', 'citas.system_resolve_organization_by_whatsapp_phone_number_id(text)', 'execute'))::int as anon_sin_grant_execute_confirmado_deberia_ser_1;
rollback;

begin;
set local role anon;
do $$
begin
  perform citas.system_resolve_organization_by_whatsapp_phone_number_id('phone-wc-a');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42501 (sin GRANT execute) pero la llamada tuvo éxito';
exception
  when sqlstate '42501' then null; -- esperado: mismo código, esta vez por el REVOKE de EXECUTE (confirmado arriba con has_function_privilege), no por falta de USAGE en el schema
end $$;
rollback;

-- ============================================================================
-- 10-11. "Esquema de producción a medias" (migración 022 NO aplicada) -- dentro
-- de este mismo fixture, elimina la función real para reproducir el estado de
-- una base que va detrás en migraciones (REGLA DURA de compatibilidad del
-- repo). El código TypeScript (`resolveOrganizationByPhoneNumberIdAsSystem`,
-- `postgres-repository.ts`) captura EXACTAMENTE este SQLSTATE
-- (`isUndefinedFunctionError`, 42883) vía `runWithSavepointFallback` y degrada
-- a `null` -- nunca un 500.
-- ============================================================================

drop function citas.system_resolve_organization_by_whatsapp_phone_number_id(text);

\echo '=== 10. (SQLSTATE exacto) ESQUEMA A MEDIAS: llamar system_resolve_organization_by_whatsapp_phone_number_id (ya no existe) lanza EXACTAMENTE 42883 (undefined_function) -- lo que isUndefinedFunctionError/runWithSavepointFallback capturan en postgres-repository.ts ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.system_resolve_organization_by_whatsapp_phone_number_id('phone-wc-a');
  raise exception 'BLOQUEANTE: se esperaba SQLSTATE 42883 (función eliminada) pero la llamada tuvo éxito -- ¿el DROP de arriba no corrió?';
exception
  when sqlstate '42883' then null; -- exactamente lo que isUndefinedFunctionError reconoce
end $$;
rollback;

\echo '=== 11. ESQUEMA A MEDIAS: el staff SIGUE viendo su propio whatsapp_config tal cual (esta migración nueva no tocó ninguna policy de staff -- vacío honesto, nunca una regresión, deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select count(*) as esquema_a_medias_staff_sigue_viendo_su_whatsapp_config_deberia_ser_1 from citas.whatsapp_config where organization_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '=== FIN -- 15 bloques begin/rollback en total (2 control staff, 1 gap inverso, 2 fix, 1 numero-desconocido, 1 config-inactiva, 2 negativos [8 y 9 en 2 bloques cada uno = 4 conexiones], 1 esquema-a-medias-sqlstate, 1 esquema-a-medias-staff-sigue-viendo) -- 8 y 9 no usan el alias `should_fail` (el gate aceptaría cualquier error): son bloques `do $$ ... exception when sqlstate ... $$;` que solo completan sin error cuando Postgres lanzó EXACTAMENTE el SQLSTATE esperado; cualquier otro código (o un éxito inesperado) hace que el `raise exception` explícito reviente el bloque y el gate lo reporte como fallo real. ==='
