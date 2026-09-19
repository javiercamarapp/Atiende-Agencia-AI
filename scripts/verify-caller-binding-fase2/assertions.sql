-- Verifica, contra Postgres REAL (real GRANT + real `auth.uid()` — NO el
-- repositorio en memoria, que nunca aplica ninguno de los dos), el hallazgo de
-- seguridad de `packages/db/migrations/0012_caller_binding_fase2.sql` (Fase 2
-- de la investigación de `0011_superadmin_caller_binding.sql`): 14 funciones
-- `security definer` del esquema `core` con `grant execute ... to
-- authenticated`, que reciben una identidad/alcance como parámetro plano
-- (`p_user_id`/`p_staff_id`/`p_caller_id`) SIN atarlo a `auth.uid()` antes de
-- este fix, o que corren en momentos pre-sesión (login/Google/magic-link) sin
-- ningún guard de "solo sesión de sistema".
--
-- Un escenario positivo (el caller LEGÍTIMO sigue funcionando exactamente
-- igual) y uno negativo (el hueco real que este fix cierra) por función,
-- agrupadas por clase — mismo criterio/mismo formato que
-- scripts/verify-superadmin-caller-binding/assertions.sql (`as should_fail` =
-- el runner de CI espera ERROR; `as deberia_ser_N`/`deberia_fallar` = el
-- runner espera que esa columna valga exactamente N/0; sin ninguno de los
-- dos, espera éxito sin chequear un valor puntual), más un representante de
-- `anon` sin acceso por grupo (las 14 comparten el mismo `revoke all ...
-- from public; grant execute ... to authenticated;` heredado sin cambios de
-- su migración original — no se repite anon 14 veces, mismo criterio de
-- economía que ya usa el script de Fase 1).
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures (persisten para TODOS los escenarios de abajo, nunca dentro de un
-- begin/rollback que los revierta):
--   - staff-f2-a: staff real, "el caller legítimo" de la mayoría de escenarios
--     (dueño de sus propias notificaciones/sesiones/status, owner real de
--     org-f2).
--   - staff-f2-b: OTRO staff real y autenticado (con su propia sesión válida)
--     -- "el atacante": intenta actuar en nombre de staff-f2-a o leer sus
--     datos, nunca teniendo ninguna autoridad real sobre ellos.
--   - superadmin-f2: superadmin REAL (fila en core.platform_superadmin) --
--     usado solo por los escenarios de `is_platform_superadmin`.
--   - org-f2: organización de plataforma, con staff-f2-a como 'owner' (para
--     el checkout de billing) y una fila de `organization_billing` real
--     (seats=7, stripe_customer_id conocido) para demostrar que un caller no
--     autorizado no ve esos valores reales.
--   - una notificación real de staff-f2-a (para list/count/mark).
--   - una identidad de Google ya vinculada a staff-f2-a (para find_staff_by_
--     google_sub).
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c1', 'staff-f2-a@example.com', 'Staff F2 A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c2', 'staff-f2-b@example.com', 'Staff F2 B (atacante)', 'seed'),
  ('00000000-0000-0000-0000-0000000000c3', 'superadmin-f2@example.com', 'Superadmin F2', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000000c3')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000c9', 'hoteles', 'Org F2', 'org-f2')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c9', null, 'owner', 'owner')
on conflict do nothing;

insert into core.organization_billing (organization_id, stripe_customer_id, stripe_subscription_id, price_id, seats, status) values
  ('00000000-0000-0000-0000-0000000000c9', 'cus_f2_real', 'sub_f2_real', 'price_f2', 7, 'activa')
on conflict do nothing;

insert into core.notification (id, staff_user_id, vertical, titulo, cuerpo) values
  ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-0000000000c1', 'hoteles', 'Notificación real de staff-f2-a', 'cuerpo')
on conflict do nothing;

insert into core.staff_google_identity (staff_user_id, provider_sub, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'google-sub-f2-real', 'staff-f2-a@example.com')
on conflict do nothing;

-- ═══ 0003_refresh_token_revocation.sql — core.revoke_refresh_token (Clase B) ═══

\echo '=== 1. revoke_refresh_token: sesion de SISTEMA (logout/refresh real, antes de que exista Bearer) SI puede revocar un jti ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.revoke_refresh_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', now() + interval '30 days');
rollback;

\echo '=== 2. revoke_refresh_token: una sesion AUTENTICADA real (auth.uid() no nulo) es RECHAZADA -- antes de este fix, cualquier authenticated podia revocar el jti de CUALQUIER usuario por RPC directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.revoke_refresh_token('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', now() + interval '30 days') as should_fail;
rollback;

\echo '=== 3. revoke_refresh_token: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.revoke_refresh_token('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', now() + interval '30 days') as should_fail;
rollback;

-- ═══ 0006_revoke_all_sessions.sql — core.revoke_all_refresh_tokens (Clase C) ═══

\echo '=== 4. revoke_all_refresh_tokens: staff-f2-a, con SU PROPIA sesion, SI puede revocar todas sus sesiones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select core.revoke_all_refresh_tokens('00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '=== 5. revoke_all_refresh_tokens: staff-f2-b (sesion real, OTRO usuario) pasando el id de staff-f2-a es RECHAZADO -- el hueco real: antes de este fix, cualquier authenticated podia revocar TODAS las sesiones de CUALQUIER otro staff (denegacion de servicio real) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.revoke_all_refresh_tokens('00000000-0000-0000-0000-0000000000c1') as should_fail;
rollback;

\echo '=== 6. revoke_all_refresh_tokens: sesion de SISTEMA pasando el id de staff-f2-a tambien es RECHAZADA -- este es EXACTAMENTE el patron que apps/api usaba ANTES de este fix (withAppSession({userId:null})) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.revoke_all_refresh_tokens('00000000-0000-0000-0000-0000000000c1') as should_fail;
rollback;

-- ═══ 0010_platform_superadmin.sql — core.is_platform_superadmin (Clase C) ═══

\echo '=== 7. is_platform_superadmin: superadmin-f2, con SU PROPIA sesion, se ve a si mismo como superadmin (true) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select core.is_platform_superadmin('00000000-0000-0000-0000-0000000000c3')::int as deberia_ser_1;
rollback;

\echo '=== 8. is_platform_superadmin: staff-f2-b (staff normal) preguntando por el status de OTRO id (el del superadmin real) obtiene false -- el hueco real: antes de este fix, cualquier authenticated podia usar esto como oraculo para identificar cuentas superadmin por UUID ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.is_platform_superadmin('00000000-0000-0000-0000-0000000000c3')::int as deberia_ser_0;
rollback;

\echo '=== 9. is_platform_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.is_platform_superadmin('00000000-0000-0000-0000-0000000000c3') as should_fail;
rollback;

-- ═══ 0009_billing_saas_schema.sql — core.get_organization_billing_for_checkout (Clase C) ═══

\echo '=== 10. get_organization_billing_for_checkout: staff-f2-a (owner real de org-f2), con su propia sesion, SI ve el billing real (seats = 7) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select seats as deberia_ser_7 from core.get_organization_billing_for_checkout('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c9');
rollback;

\echo '=== 11. get_organization_billing_for_checkout: staff-f2-b (sesion real, sin ninguna autoridad sobre org-f2) pasando el id de staff-f2-a como p_caller_id es RECHAZADO -- el hueco real: antes de este fix, cualquier authenticated podia leer el stripe_customer_id/seats/status de CUALQUIER organizacion suplantando a su owner ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select * from core.get_organization_billing_for_checkout('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c9') as should_fail;
rollback;

\echo '=== 12. get_organization_billing_for_checkout: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.get_organization_billing_for_checkout('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c9') as should_fail;
rollback;

-- ═══ 0009_billing_saas_schema.sql — core.get_organization_billing_for_webhook (Clase B) ═══

\echo '=== 13. get_organization_billing_for_webhook: sesion de SISTEMA (el webhook real de Stripe, autorizado por firma HMAC en la app, no por auth.uid()) SI ve el billing real (seats = 7) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select seats as deberia_ser_7 from core.get_organization_billing_for_webhook('00000000-0000-0000-0000-0000000000c9');
rollback;

\echo '=== 14. get_organization_billing_for_webhook: una sesion AUTENTICADA real obtiene CERO filas -- nunca el estado de billing real de una organizacion ajena ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) as deberia_ser_0 from core.get_organization_billing_for_webhook('00000000-0000-0000-0000-0000000000c9');
rollback;

-- ═══ 0009_billing_saas_schema.sql — core.upsert_organization_billing (Clase B) ═══

\echo '=== 15. upsert_organization_billing: sesion de SISTEMA (el webhook real) SI puede fijar el estado de billing ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.upsert_organization_billing('00000000-0000-0000-0000-0000000000c9', 'cus_f2_real', 'sub_f2_real', 'price_f2', 9, 'activa', now() + interval '30 days');
rollback;

\echo '=== 16. upsert_organization_billing: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de este fix, cualquier authenticated podia fijar (o vaciar) el estado de billing de CUALQUIER organizacion por RPC directo, sin haber pagado nada en Stripe ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.upsert_organization_billing('00000000-0000-0000-0000-0000000000c9', 'cus_falso', 'sub_falso', 'price_falso', 999, 'activa', now() + interval '30 days') as should_fail;
rollback;

-- ═══ 0013_notifications_schema.sql — core.list_notifications_for_staff /
-- count_unread_notifications_for_staff / mark_notification_read /
-- mark_all_notifications_read (Clase C) ═══

\echo '=== 17. list_notifications_for_staff: staff-f2-a, con su propia sesion, SI ve su propia notificacion (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select count(*) as deberia_ser_1 from core.list_notifications_for_staff('00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '=== 18. list_notifications_for_staff: staff-f2-b pasando el id de staff-f2-a obtiene CERO filas -- el hueco real: antes de este fix, cualquier authenticated podia leer las notificaciones (potencialmente sensibles, cruzan las 6 verticales + back office) de CUALQUIER otro staff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) as deberia_ser_0 from core.list_notifications_for_staff('00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '=== 19. count_unread_notifications_for_staff: staff-f2-a ve su conteo real (1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select core.count_unread_notifications_for_staff('00000000-0000-0000-0000-0000000000c1') as deberia_ser_1;
rollback;

\echo '=== 20. count_unread_notifications_for_staff: staff-f2-b pasando el id de staff-f2-a ve CERO -- nunca el numero real de otro staff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.count_unread_notifications_for_staff('00000000-0000-0000-0000-0000000000c1') as deberia_ser_0;
rollback;

\echo '=== 21. mark_notification_read: staff-f2-a SI puede marcar su propia notificacion como leida ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select core.mark_notification_read('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000ca');
rollback;

\echo '=== 22. mark_notification_read: staff-f2-b pasando el id de staff-f2-a es RECHAZADO -- el hueco real: antes de este fix, cualquier authenticated podia marcar (o, via mark_all, vaciar el badge de) las notificaciones de CUALQUIER otro staff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.mark_notification_read('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000ca') as should_fail;
rollback;

\echo '=== 23. mark_all_notifications_read: staff-f2-a SI puede marcar todas las suyas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select core.mark_all_notifications_read('00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '=== 24. mark_all_notifications_read: staff-f2-b pasando el id de staff-f2-a es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.mark_all_notifications_read('00000000-0000-0000-0000-0000000000c1') as should_fail;
rollback;

\echo '=== 25. list_notifications_for_staff: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_notifications_for_staff('00000000-0000-0000-0000-0000000000c1') as should_fail;
rollback;

-- ═══ 0008_staff_google_identity.sql — core.link_google_identity /
-- core.find_staff_by_google_sub (Clase A, pre-autenticación) ═══

\echo '=== 26. link_google_identity: sesion de SISTEMA (el callback real de Google, antes de que exista sesion propia) SI puede vincular una identidad ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.link_google_identity('00000000-0000-0000-0000-0000000000c2', 'google-sub-f2-nuevo', 'staff-f2-b@example.com');
rollback;

\echo '=== 27. link_google_identity: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de este fix, cualquier authenticated podia vincular una identidad de Google arbitraria a la cuenta de OTRO staff (incluido el propio atacante, tomando control futuro de esa cuenta via "iniciar sesion con Google") ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.link_google_identity('00000000-0000-0000-0000-0000000000c1', 'google-sub-hostil', 'ataque@example.com') as should_fail;
rollback;

\echo '=== 28. find_staff_by_google_sub: sesion de SISTEMA (el callback real de Google) SI resuelve la identidad ya vinculada (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.find_staff_by_google_sub('google-sub-f2-real');
rollback;

\echo '=== 29. find_staff_by_google_sub: una sesion AUTENTICADA real obtiene CERO filas -- nunca el staff_user completo (PII) detras de un sub de Google conocido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) as deberia_ser_0 from core.find_staff_by_google_sub('google-sub-f2-real');
rollback;

-- ═══ 0009_magic_link_login.sql / 0008_auth_exchange_code.sql — core.create_
-- magic_link_token / core.create_auth_exchange_code (Clase A, pre-autenticación) ═══

\echo '=== 30. create_magic_link_token: sesion de SISTEMA (la solicitud real de magic-link) SI puede crear un token ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.create_magic_link_token('00000000-0000-0000-0000-0000000000c1', 'hash-f2-magic-link-1', now() + interval '15 minutes');
rollback;

\echo '=== 31. create_magic_link_token: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de este fix, cualquier authenticated podia emitirse un magic-link de login para CUALQUIER otro staff, sin conocer su contraseña ni su correo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.create_magic_link_token('00000000-0000-0000-0000-0000000000c1', 'hash-f2-magic-link-hostil', now() + interval '15 minutes') as should_fail;
rollback;

\echo '=== 32. create_auth_exchange_code: sesion de SISTEMA (login/Google real) SI puede crear un codigo de intercambio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.create_auth_exchange_code('00000000-0000-0000-0000-0000000000c1', 'hash-f2-exchange-1', now() + interval '60 seconds');
rollback;

\echo '=== 33. create_auth_exchange_code: una sesion AUTENTICADA real es RECHAZADA -- el hueco real: antes de este fix, cualquier authenticated podia emitirse un codigo de intercambio (canjeable por token+refreshToken reales) para CUALQUIER otro staff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select core.create_auth_exchange_code('00000000-0000-0000-0000-0000000000c1', 'hash-f2-exchange-hostil', now() + interval '60 seconds') as should_fail;
rollback;

\echo '=== 34. create_magic_link_token: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.create_magic_link_token('00000000-0000-0000-0000-0000000000c1', 'hash-f2-anon', now() + interval '15 minutes') as should_fail;
rollback;
