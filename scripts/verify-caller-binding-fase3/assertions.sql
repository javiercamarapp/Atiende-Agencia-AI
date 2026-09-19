-- Verifica, contra Postgres REAL (real GRANT + real `auth.uid()` — NO el
-- repositorio en memoria, que nunca aplica ninguno de los dos), la Fase 3 del
-- hallazgo de seguridad "caller binding" (ver `packages/db/migrations/0016_
-- caller_binding_fase3.sql` + las 4 migraciones de vertical hermanas —
-- `packages/domain-despachos/migrations/010_despachos_caller_binding_fase3.sql`,
-- `packages/domain-hoteles/migrations/024_hoteles_caller_binding_fase3.sql`,
-- `packages/domain-restaurantes/migrations/018_restaurantes_caller_binding_
-- fase3.sql`, `packages/domain-rentas/migrations/019_rentas_caller_binding_
-- fase3.sql` — para el resumen completo de cada hallazgo). Un escenario
-- positivo (el caller LEGÍTIMO sigue funcionando exactamente igual) y uno
-- negativo (el hueco real que este fix cierra) por función, más los
-- escenarios cross-org/anon/estructurales que pide el encargo de esta fase —
-- mismo criterio/mismo formato que scripts/verify-caller-binding-fase2/
-- assertions.sql (`as should_fail` = el runner de CI espera ERROR;
-- `as deberia_ser_N` = el runner espera que esa columna valga exactamente N;
-- sin ninguno de los dos, espera éxito sin chequear un valor puntual).
\set ON_ERROR_STOP off
\pset pager off

-- ── Fixtures (persisten para TODOS los escenarios de abajo, nunca dentro de
-- un begin/rollback que los revierta) ──────────────────────────────────────
--   - org-f3-a (hoteles): staff-f3-owner-a ('owner'), staff-f3-member-a
--     ('member', NO admin) -- para los escenarios de find_staff_for_org_admin/
--     is_staff_org_member_for_org_admin (rango insuficiente) y para el guard
--     org-scoped de enqueue_staff_order_notification.
--   - org-f3-b (restaurantes): staff-f3-owner-b ('owner', "el atacante
--     cross-org" en los escenarios de la Fase 3) y staff-f3-staff-b ('staff',
--     el repartidor/admin real que SÍ pertenece a la organización dueña del
--     pedido) -- property-f3-b, order-f3-b, promo-f3-b para
--     enqueue_staff_order_notification/increment_promotion_uses.
--   - staff-f3-outsider: cuenta real de `core.staff_user` SIN ninguna
--     membership todavía (el "candidato a invitar" que find_staff_for_org_
--     admin debe poder encontrar por correo, exactamente igual que hacía
--     findStaffByEmail antes de esta fase).
--   - owner-f3 (rentas.owner + rentas.owner_credential): propietario real del
--     portal, para find_owner_credential_by_email/revoke_owner_refresh_token.
--   - property-f3-a (hoteles): para hoteles.record_fraude_audit_log.
--   - org-f3-c (despachos): para despachos.record_audit_log.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000e1', 'staff-f3-owner-a@example.com', 'Staff F3 Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000e2', 'staff-f3-member-a@example.com', 'Staff F3 Member A', 'seed'),
  ('00000000-0000-0000-0000-0000000000e3', 'staff-f3-owner-b@example.com', 'Staff F3 Owner B (atacante cross-org)', 'seed'),
  ('00000000-0000-0000-0000-0000000000e4', 'staff-f3-staff-b@example.com', 'Staff F3 Staff B', 'seed'),
  ('00000000-0000-0000-0000-0000000000e5', 'outsider-f3@example.com', 'Outsider F3 (candidato a invitar)', 'seed')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000e9', 'hoteles', 'Org F3 A', 'org-f3-a'),
  ('00000000-0000-0000-0000-0000000000ea', 'restaurantes', 'Org F3 B', 'org-f3-b'),
  ('00000000-0000-0000-0000-0000000000eb', 'despachos', 'Org F3 C', 'org-f3-c')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e9', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e9', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000ea', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000ea', null, 'member', 'staff')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e9', 'hoteles', 'Property F3 A'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000ea', 'restaurantes', 'Property F3 B')
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, items) values
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000f2', 'Cliente F3', '5215500000000', 150.00, '[]'::jsonb)
on conflict do nothing;

insert into restaurantes.promotions (id, organization_id, code, name, type, value, max_uses, times_used) values
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000ea', 'F3PROMO', 'Promo F3', 'percentage', 10, 5, 0)
on conflict do nothing;

insert into rentas.owner (id, name, email) values
  ('00000000-0000-0000-0000-0000000000f5', 'Owner F3', 'owner-f3@example.com')
on conflict do nothing;

-- password_hash construido (nunca un literal con forma de hash real, ver
-- restricciones de fixtures del encargo) -- 60 caracteres, mismo largo que un
-- hash scrypt/bcrypt real, sin parecer uno.
insert into rentas.owner_credential (owner_id, password_hash) values
  ('00000000-0000-0000-0000-0000000000f5', repeat('x', 60))
on conflict do nothing;

-- ═══ 0011_login_lookup_security_definer.sql — core.find_staff_by_email (Clase A/B, solo sistema) ═══

\echo '=== 1. find_staff_by_email: sesion de SISTEMA (login real) SI resuelve el correo (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.find_staff_by_email('staff-f3-owner-a@example.com');
rollback;

\echo '=== 2. find_staff_by_email: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de esta fase, cualquier authenticated podia leer password_hash de CUALQUIER staff_user por RPC directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select * from core.find_staff_by_email('staff-f3-owner-a@example.com') as should_fail;
rollback;

\echo '=== 3. find_staff_by_email: anon no puede ni ejecutar la funcion (representa al grupo -- find_staff_by_id/find_memberships_by_user_id comparten el mismo GRANT heredado) ==='
begin;
set local role anon;
select * from core.find_staff_by_email('staff-f3-owner-a@example.com') as should_fail;
rollback;

-- ═══ 0011_login_lookup_security_definer.sql — core.find_staff_by_id (Clase A/B, solo sistema) ═══

\echo '=== 4. find_staff_by_id: sesion de SISTEMA (refresh/GET-me real) SI resuelve el id (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.find_staff_by_id('00000000-0000-0000-0000-0000000000e1');
rollback;

\echo '=== 5. find_staff_by_id: una sesion AUTENTICADA real es RECHAZADA ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select * from core.find_staff_by_id('00000000-0000-0000-0000-0000000000e1') as should_fail;
rollback;

-- ═══ 0011_login_lookup_security_definer.sql — core.find_memberships_by_user_id (Clase A/B, solo sistema) ═══

\echo '=== 6. find_memberships_by_user_id: sesion de SISTEMA (login/GET-me real) SI resuelve las membresias (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.find_memberships_by_user_id('00000000-0000-0000-0000-0000000000e1');
rollback;

\echo '=== 7. find_memberships_by_user_id: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de esta fase, cualquier authenticated podia enumerar las membresias (organizacion/rol/propertyIds) de CUALQUIER otro staff por RPC directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select * from core.find_memberships_by_user_id('00000000-0000-0000-0000-0000000000e1') as should_fail;
rollback;

\echo '=== 8. login completo bajo sesion de sistema: find_staff_by_email + find_memberships_by_user_id encadenadas (el recorrido SQL real de POST /auth/login) siguen funcionando juntas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.find_memberships_by_user_id(
  (select id from core.find_staff_by_email('staff-f3-owner-a@example.com'))
);
rollback;

-- ═══ 0017_caller_binding_fase3.sql — core.find_staff_for_org_admin (uso "administración de staff") ═══

\echo '=== 9. find_staff_for_org_admin: staff-f3-owner-a (owner real de org-f3-a), con su propia sesion, SI encuentra al outsider por correo (1 fila, para invitarlo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select count(*) as deberia_ser_1 from core.find_staff_for_org_admin('00000000-0000-0000-0000-0000000000e9', 'outsider-f3@example.com');
rollback;

\echo '=== 10. find_staff_for_org_admin: staff-f3-member-a (member real de org-f3-a, SIN rango de admin) es RECHAZADO -- mismo umbral que core.update_membership_role (rank >= 3) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
select * from core.find_staff_for_org_admin('00000000-0000-0000-0000-0000000000e9', 'outsider-f3@example.com') as should_fail;
rollback;

\echo '=== 11. find_staff_for_org_admin: staff-f3-owner-b (owner real, pero de OTRA organizacion -- org-f3-b) pasando el id de org-f3-a es RECHAZADO -- el hueco real que cierra esta fase: un admin de la organizacion A no puede buscar staff de la organizacion B (ni al reves) por RPC directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select * from core.find_staff_for_org_admin('00000000-0000-0000-0000-0000000000e9', 'outsider-f3@example.com') as should_fail;
rollback;

\echo '=== 12. find_staff_for_org_admin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.find_staff_for_org_admin('00000000-0000-0000-0000-0000000000e9', 'outsider-f3@example.com') as should_fail;
rollback;

\echo '=== 13. find_staff_for_org_admin: NUNCA devuelve password_hash -- prueba estructural (la columna ni siquiera existe en su tipo de retorno, a diferencia de find_staff_by_email) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select password_hash from core.find_staff_for_org_admin('00000000-0000-0000-0000-0000000000e9', 'outsider-f3@example.com') as should_fail;
rollback;

-- ═══ 0017_caller_binding_fase3.sql — core.is_staff_org_member_for_org_admin ═══

\echo '=== 14. is_staff_org_member_for_org_admin: staff-f3-owner-a SI ve que staff-f3-member-a YA es miembro de su organizacion (true) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select core.is_staff_org_member_for_org_admin('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000e2')::int as deberia_ser_1;
rollback;

\echo '=== 15. is_staff_org_member_for_org_admin: staff-f3-owner-a ve que el outsider NO es miembro todavia (false) -- asi decide "invitar", nunca "conflicto" ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select core.is_staff_org_member_for_org_admin('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000e5')::int as deberia_ser_0;
rollback;

\echo '=== 16. is_staff_org_member_for_org_admin: staff-f3-member-a (sin rango de admin) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', true);
select core.is_staff_org_member_for_org_admin('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000e2') as should_fail;
rollback;

\echo '=== 17. is_staff_org_member_for_org_admin: staff-f3-owner-b (owner real de OTRA organizacion) preguntando por membresias de org-f3-a es RECHAZADO -- un admin de la organizacion B no puede listar staff de la organizacion A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select core.is_staff_org_member_for_org_admin('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000e2') as should_fail;
rollback;

-- ═══ 008_despachos_audit_log.sql — despachos.record_audit_log (Clase B, solo sistema) ═══

\echo '=== 18. record_audit_log: sesion de SISTEMA (ProductionDespachosAuditSink real) SI inserta la bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000eb', '00000000-0000-0000-0000-0000000000e1', 'test.accion', '{}'::jsonb);
rollback;

\echo '=== 19. record_audit_log: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de esta fase, cualquier authenticated podia insertar una entrada de bitacora FALSA en CUALQUIER organizacion, atribuida a CUALQUIER actor ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000eb', '00000000-0000-0000-0000-0000000000e1', 'test.hostil', '{}'::jsonb) as should_fail;
rollback;

\echo '=== 20. record_audit_log: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select despachos.record_audit_log('00000000-0000-0000-0000-0000000000eb', '00000000-0000-0000-0000-0000000000e1', 'test.anon', '{}'::jsonb) as should_fail;
rollback;

-- ═══ 017_fraude_audit_log.sql — hoteles.record_fraude_audit_log (Clase B, solo sistema) ═══

\echo '=== 21. record_fraude_audit_log: sesion de SISTEMA (ProductionHotelesFraudeAuditSink real) SI inserta la bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'test.accion', '{}'::jsonb);
rollback;

\echo '=== 22. record_fraude_audit_log: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de esta fase, cualquier authenticated podia insertar una entrada de bitacora de fraude FALSA en CUALQUIER property, atribuida a CUALQUIER actor ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e3', true);
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'test.hostil', '{}'::jsonb) as should_fail;
rollback;

\echo '=== 23. record_fraude_audit_log: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select hoteles.record_fraude_audit_log('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'test.anon', '{}'::jsonb) as should_fail;
rollback;

-- ═══ 009_order_notifications.sql — restaurantes.enqueue_staff_order_notification (org-scoped: sistema SIN restricción, autenticado atado a su membership) ═══

\echo '=== 24. enqueue_staff_order_notification: sesion de SISTEMA (createOrder real, checkout publico) SI encola -- sin membership, exactamente igual que antes de esta fase ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3', 'order.created', 'Nuevo pedido de prueba F3.');
rollback;

\echo '=== 25. enqueue_staff_order_notification: staff-f3-staff-b (sesion real, SI es miembro de org-f3-b -- el repartidor/admin real de assign-repartidor/changeAssignedOrderStatus) SI encola ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e4', true);
select count(*) as deberia_ser_1 from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3', 'order.problema', 'Incidencia de prueba F3.');
rollback;

\echo '=== 26. enqueue_staff_order_notification: staff-f3-owner-a (sesion real, pero de OTRA organizacion -- org-f3-a) intentando inyectar una notificacion en la bandeja de org-f3-b es RECHAZADO -- el hueco real que cierra esta fase: antes, cualquier authenticated de CUALQUIER organizacion podia inyectar una notificacion falsa en la bandeja de un tercero por RPC directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select * from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3', 'order.assigned_repartidor', 'Notificacion hostil F3.') as should_fail;
rollback;

\echo '=== 27. enqueue_staff_order_notification: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3', 'order.created', 'anon') as should_fail;
rollback;

-- ═══ 010_promotions.sql — restaurantes.increment_promotion_uses (Clase B, solo sistema) ═══

\echo '=== 28. increment_promotion_uses: sesion de SISTEMA (createOrder real) SI incrementa el contador ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.increment_promotion_uses('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000f4');
rollback;

\echo '=== 29. increment_promotion_uses: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de esta fase, cualquier authenticated de CUALQUIER organizacion podia agotar max_uses de una promocion ajena por RPC directo, sin haber creado ningun pedido real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select restaurantes.increment_promotion_uses('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000f4') as should_fail;
rollback;

\echo '=== 30. increment_promotion_uses: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select restaurantes.increment_promotion_uses('00000000-0000-0000-0000-0000000000ea', '00000000-0000-0000-0000-0000000000f4') as should_fail;
rollback;

-- ═══ 013_owner_portal_security_definer.sql — rentas.find_owner_credential_by_email (Clase A, pre-auth, solo sistema) ═══

\echo '=== 31. find_owner_credential_by_email: sesion de SISTEMA (login real del portal de propietario) SI resuelve la credencial (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from rentas.find_owner_credential_by_email('owner-f3@example.com');
rollback;

\echo '=== 32. find_owner_credential_by_email: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de esta fase, cualquier authenticated podia leer password_hash de CUALQUIER propietario por RPC directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select * from rentas.find_owner_credential_by_email('owner-f3@example.com') as should_fail;
rollback;

\echo '=== 33. find_owner_credential_by_email: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from rentas.find_owner_credential_by_email('owner-f3@example.com') as should_fail;
rollback;

-- ═══ 017_owner_portal_refresh_revocation.sql — rentas.revoke_owner_refresh_token (Clase C, self) ═══

\echo '=== 34. revoke_owner_refresh_token: owner-f3, con SU PROPIA sesion (auth.uid() = owner_id, exactamente el patron real de POST .../owner-portal/auth/logout), SI revoca su jti ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f5', true);
select rentas.revoke_owner_refresh_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f5', now() + interval '30 days');
rollback;

\echo '=== 35. revoke_owner_refresh_token: staff-f3-owner-a (sesion real, pero OTRA identidad -- ni siquiera un owner, un staff) pasando el id de owner-f3 es RECHAZADO -- el hueco real: antes de esta fase, cualquier authenticated podia revocar el refresh token de CUALQUIER propietario por RPC directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
select rentas.revoke_owner_refresh_token('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f5', now() + interval '30 days') as should_fail;
rollback;

\echo '=== 36. revoke_owner_refresh_token: sesion de SISTEMA (auth.uid() null) pasando el id de owner-f3 tambien es RECHAZADA -- self-binding real, nunca alcanzable sin ser exactamente ese propietario autenticado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.revoke_owner_refresh_token('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000f5', now() + interval '30 days') as should_fail;
rollback;

\echo '=== 37. revoke_owner_refresh_token: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select rentas.revoke_owner_refresh_token('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000f5', now() + interval '30 days') as should_fail;
rollback;
