-- Verificación ANTES/DESPUÉS contra Postgres REAL del hallazgo de la auditoría
-- a2b (CRÍTICO): "el drenado inline de WhatsApp aborta la transacción de negocio
-- en TODA ruta de staff que lo dispara" — primo directo del hallazgo ya cerrado en
-- PR #166 para el drenado de CORREO (ver
-- scripts/verify-correo-inline-sesion-staff/assertions.sql, del que este archivo
-- es copia adaptada, "cópialo como plantilla").
--
-- Mecanismo que esto reproduce, IDÉNTICO al que corre `apps/api/src/routes/
-- internal/whatsapp-dispatch.ts::triggerInline` sobre `c.get("db")` desde
-- `verticals/restaurantes/{admin-orders,repartidor-orders}.ts` (los 2 ÚNICOS call
-- sites de sesión de STAFF de los 6 -- ver README.md para la enumeración completa
-- de los 6 call sites y su clasificación):
--   1. Una ruta de STAFF (authMiddleware -> dbSession, auth.uid() no nulo) abre
--      UNA transacción para todo el request (`begin;` + `set local role
--      authenticated;` + `select set_config('request.jwt.claim.sub', ...)`,
--      mismo patrón que packages/db/src/managed-postgres-engine.ts).
--   2. Dentro de ESA MISMA transacción cambia el estado de un pedido real
--      (`restaurantes.orders`, exactamente el UPDATE de
--      `postgres-repository.ts::updateOrderStatus`) y luego llama
--      `<vertical>.claim_messaging_outbox_batch(...)` para intentar enviar el
--      WhatsApp YA en vez de esperar al cron.
--   3. `claim_messaging_outbox_batch` SIEMPRE lanza 42501 en sesión de staff
--      (guard idéntico al de `claim_email_outbox_batch`, correcto y necesario,
--      cross-tenant -- NO se toca, ver packages/domain-*/migrations/
--      0{15,17,19}_messaging_outbox_dispatch_authenticated_grants.sql) -- pasa
--      HAYA O NO mensajes pendientes, la excepción se lanza antes de tocar
--      cualquier fila.
--   4. SIN un SAVEPOINT que la rodee, esa excepción deja la transacción COMPLETA
--      abortada (25P02) hasta que algo haga `ROLLBACK TO SAVEPOINT`. Un
--      `commit;` posterior sobre una transacción abortada NO lanza error --
--      Postgres responde "ROLLBACK" en silencio (ver
--      packages/db/src/managed-postgres-engine.ts::withAppSession) -- el cambio
--      de estado del pedido del paso 2 se pierde con un 2xx.
--   5. CON el SAVEPOINT (el hotfix real, ver
--      apps/api/.../internal/whatsapp-dispatch.ts::triggerInline tras el fix):
--      `SAVEPOINT sp_inline_whatsapp_dispatch` antes de intentar el drenado,
--      `ROLLBACK TO SAVEPOINT` + `RELEASE SAVEPOINT` en el catch -- la
--      transacción vuelve a un estado sano y el `commit;` posterior SÍ confirma
--      el cambio de estado del pedido.
--
-- Cubre restaurantes (`restaurantes.orders` -- el flujo REAL, mismo UPDATE que
-- `admin-orders.ts`/`repartidor-orders.ts` disparan hoy) como prueba principal, y
-- citas (`citas.providers`)/hoteles (`hoteles.guest`) como defensa en profundidad
-- (mismo `triggerInline` compartido por las 3 verticales -- ver whatsapp-dispatch.ts
-- -- aunque hoy solo restaurantes tiene call sites de sesión de staff, un cambio
-- futuro que agregue uno en citas/hoteles queda cubierto por el mismo SAVEPOINT sin
-- tocar este archivo).
--
-- Cada bloque ANTES/DESPUÉS hace su propio `begin; ... commit;` real (con una
-- `rollback;` final inofensiva solo para calzar con el contrato de
-- scripts/verify-real-postgres-ci/run-gate.mjs, que reconoce escenarios
-- `begin;...rollback;` -- ver su comentario de cabecera; un `rollback;` tras un
-- `commit;` ya cerrado solo emite un WARNING de Postgres, nunca un error) --
-- así que SÍ persiste entre escenarios en la misma base efímera, a propósito:
-- necesitamos un commit real para poder verificar qué sobrevivió.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000010a1', 'restaurantes', 'Taqueria a2b', 'taqueria-a2b'),
  ('00000000-0000-0000-0000-0000000010a2', 'citas', 'Org Citas a2b', 'org-citas-a2b'),
  ('00000000-0000-0000-0000-0000000010a3', 'hoteles', 'Org Hoteles a2b', 'org-hoteles-a2b')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000010a1', 'restaurantes', 'Taqueria a2b - Sucursal 1'),
  ('00000000-0000-0000-0000-0000000010b3', '00000000-0000-0000-0000-0000000010a3', 'hoteles', 'Hotel a2b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000010c1', 'staff-a2b@example.com', 'Staff a2b', 'seed')
on conflict do nothing;

-- vertical_role='gm' para hoteles porque hoteles.can_manage_reservations() exige
-- ('owner','gm','frontdesk','reservations'); citas no filtra por rol (solo
-- membership de la organización); restaurantes.orders tampoco filtra por
-- vertical_role a nivel de policy (ver migrations/007_admin_backoffice_grants_
-- and_policies.sql -- "staff actualiza pedidos de su organización" solo exige
-- membership), 'owner' alcanza.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000010c1', '00000000-0000-0000-0000-0000000010a1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000010c1', '00000000-0000-0000-0000-0000000010a2', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000010c1', '00000000-0000-0000-0000-0000000010a3', null, 'admin', 'gm')
on conflict do nothing;

-- Dos pedidos "pending" reales de la taqueria a2b -- uno para el escenario ANTES,
-- otro para el DESPUES (cada uno se transiciona una sola vez).
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-0000000010ca', '00000000-0000-0000-0000-0000000010a1', '9990000010', 'Cliente a2b', 0)
on conflict do nothing;

-- Cuatro pedidos "pending" reales de la taqueria a2b -- d1/d2 para el escenario
-- original ANTES/DESPUES (SAVEPOINT de `claim_messaging_outbox_batch`, ver abajo),
-- d3/d4 para el escenario nuevo Blocker A (SAVEPOINT del SELECT de
-- `resolveActiveWhatsAppPhoneNumberId`, ver más abajo).
insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source) values
  ('00000000-0000-0000-0000-0000000010d1', '00000000-0000-0000-0000-0000000010a1', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000010ca', 'Cliente a2b', '9990000010', 180, 'pending', '[{"name":"Taco","qty":3,"price":60}]'::jsonb, 'whatsapp'),
  ('00000000-0000-0000-0000-0000000010d2', '00000000-0000-0000-0000-0000000010a1', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000010ca', 'Cliente a2b', '9990000010', 240, 'pending', '[{"name":"Taco","qty":4,"price":60}]'::jsonb, 'whatsapp'),
  ('00000000-0000-0000-0000-0000000010d3', '00000000-0000-0000-0000-0000000010a1', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000010ca', 'Cliente a2b', '9990000010', 120, 'pending', '[{"name":"Taco","qty":2,"price":60}]'::jsonb, 'whatsapp'),
  ('00000000-0000-0000-0000-0000000010d4', '00000000-0000-0000-0000-0000000010a1', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000010ca', 'Cliente a2b', '9990000010', 300, 'pending', '[{"name":"Taco","qty":5,"price":60}]'::jsonb, 'whatsapp')
on conflict do nothing;

-- Canal de WhatsApp real conectado para la organización -- necesario para que el
-- SELECT de `resolveActiveWhatsAppPhoneNumberId` (postgres-repository.ts:631) tenga
-- algo que leer; el 42501 de la sección Blocker A de abajo ocurre en el CHEQUEO DE
-- PERMISOS (falta el GRANT), antes siquiera de mirar si hay filas -- da igual si la
-- tabla está vacía o no, pero una fila real hace el fixture honesto.
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values
  ('00000000-0000-0000-0000-0000000010a1', 'PHONE_NUMBER_ID_TAQUERIA_A2B')
on conflict do nothing;

-- =============================================================================
-- RESTAURANTES — flujo REAL: PATCH .../admin/orders/:orderId/status
-- (updateOrderStatus, grant+policy en migrations/007_admin_backoffice_grants_and_
-- policies.sql) + claim_messaging_outbox_batch (migrations/015_messaging_outbox_
-- dispatch_authenticated_grants.sql) -- exactamente lo que admin-orders.ts línea
-- ~155 y repartidor-orders.ts línea ~106 disparan hoy en producción.
-- =============================================================================

\echo '=== restaurantes ANTES (sin SAVEPOINT): pending -> preparando + claim_messaging_outbox_batch (42501) + commit -- reproduce el bug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000010c1', true);
update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000010d1' and status = 'pending';
\set ON_ERROR_STOP off
select * from restaurantes.claim_messaging_outbox_batch(5);
\set ON_ERROR_STOP on
commit;
rollback;

\echo '=== restaurantes ANTES: el cambio de estado del pedido se PERDIÓ (prueba el bug -- deberia_ser_0) ==='
begin;
select count(*) as restaurantes_antes_status_perdido_deberia_ser_0 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000010d1' and status = 'preparando';
rollback;

\echo '=== restaurantes DESPUES (con SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE, mismo patrón del hotfix): pending -> preparando persiste tras commit ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000010c1', true);
update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000010d2' and status = 'pending';
savepoint sp_inline_whatsapp_dispatch;
\set ON_ERROR_STOP off
select * from restaurantes.claim_messaging_outbox_batch(5);
\set ON_ERROR_STOP on
rollback to savepoint sp_inline_whatsapp_dispatch;
release savepoint sp_inline_whatsapp_dispatch;
commit;
rollback;

\echo '=== restaurantes DESPUES: el cambio de estado del pedido PERSISTE (prueba el fix -- deberia_ser_1) ==='
begin;
select count(*) as restaurantes_despues_status_persiste_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000010d2' and status = 'preparando';
rollback;

-- =============================================================================
-- RESTAURANTES — Blocker A (revisión independiente de PR #169): el flujo completo
-- UPDATE + SELECT de `whatsapp_channel_config` (resolveActiveWhatsAppPhoneNumberId,
-- postgres-repository.ts:631, llamado desde order-notifications.ts::
-- tryNotifyCustomerOnOrderStatusChange -- ANTES de `claim_messaging_outbox_batch`,
-- ver order-lifecycle.ts::changeOrderStatus) + claim + commit, reproduciendo la
-- base real SIN la migración que otorga el GRANT (`revoke select` de abajo simula
-- el estado sin supabase/migrations/
-- 20240101000140_017_restaurantes_sistema_whatsapp_channel_config.sql -- ver su
-- propio encabezado: "NUNCA recibió ninguna policy NI ningún GRANT a
-- authenticated" desde la Fase 1). El escenario original de arriba (con
-- `claim_messaging_outbox_batch`) NO ejercitaba este SELECT porque corre DESPUÉS,
-- en `triggerInline` -- si este SELECT ya abortó la transacción antes de llegar
-- ahí, el SAVEPOINT de `triggerInline` nunca alcanza a rescatar nada.
-- =============================================================================

revoke select on restaurantes.whatsapp_channel_config from authenticated;

\echo '=== restaurantes Blocker A ANTES (sin SAVEPOINT en el SELECT de whatsapp_channel_config): pending -> preparando + SELECT (42501, GRANT ausente) + commit -- reproduce el bug real de la base sin migrar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000010c1', true);
update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000010d3' and status = 'pending';
\set ON_ERROR_STOP off
select phone_number_id from restaurantes.whatsapp_channel_config where organization_id = '00000000-0000-0000-0000-0000000010a1';
\set ON_ERROR_STOP on
commit;
rollback;

\echo '=== restaurantes Blocker A ANTES: el cambio de estado del pedido se PERDIÓ (prueba el bug -- deberia_ser_0) ==='
begin;
select count(*) as restaurantes_blocker_a_antes_status_perdido_deberia_ser_0 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000010d3' and status = 'preparando';
rollback;

\echo '=== restaurantes Blocker A DESPUES (con SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE alrededor del SELECT, mismo patrón que src/order-notifications.ts::runNotifyBestEffort): pending -> preparando + SELECT (42501, absorbido) + claim (42501, absorbido, SAVEPOINT de triggerInline) + commit -- flujo completo real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000010c1', true);
update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000010d4' and status = 'pending';
savepoint sp_order_notify_best_effort;
\set ON_ERROR_STOP off
select phone_number_id from restaurantes.whatsapp_channel_config where organization_id = '00000000-0000-0000-0000-0000000010a1';
\set ON_ERROR_STOP on
rollback to savepoint sp_order_notify_best_effort;
release savepoint sp_order_notify_best_effort;
-- El best-effort de notificación falló limpio (sin phone_number_id resuelto, nunca
-- llega a `enqueueMessagingOutbox`) -- comportamiento honesto, el negocio sigue.
-- `triggerInline` corre después con su PROPIO SAVEPOINT (ya cubierto por el
-- escenario de arriba) -- se reproduce aquí también para probar el flujo COMPLETO
-- de un solo request real.
savepoint sp_inline_whatsapp_dispatch;
\set ON_ERROR_STOP off
select * from restaurantes.claim_messaging_outbox_batch(5);
\set ON_ERROR_STOP on
rollback to savepoint sp_inline_whatsapp_dispatch;
release savepoint sp_inline_whatsapp_dispatch;
commit;
rollback;

\echo '=== restaurantes Blocker A DESPUES: el cambio de estado del pedido PERSISTE (prueba el fix -- deberia_ser_1) ==='
begin;
select count(*) as restaurantes_blocker_a_despues_status_persiste_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000010d4' and status = 'preparando';
rollback;

grant select on restaurantes.whatsapp_channel_config to authenticated;

-- =============================================================================
-- CITAS — defensa en profundidad (mismo `triggerInline` compartido, ver
-- whatsapp-dispatch.ts): citas.providers (grant insert + policy "staff gestiona
-- proveedores de su organización", ver packages/domain-citas/migrations/
-- 011_citas_admin_backoffice_grants_and_policies.sql). Hoy NINGÚN call site de
-- citas invoca triggerCitasWhatsAppDispatchInline en sesión de staff (solo el
-- webhook, sesión de sistema, ver README.md) -- este escenario prueba el mismo
-- mecanismo SQL para que un futuro call site de staff quede cubierto sin tocar
-- este archivo.
-- =============================================================================

\echo '=== citas ANTES (sin SAVEPOINT): fila de negocio + claim_messaging_outbox_batch (42501) + commit -- reproduce el bug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000010c1', true);
insert into citas.providers (id, organization_id, display_name)
values ('00000000-0000-0000-0000-0000000010e1', '00000000-0000-0000-0000-0000000010a2', 'Proveedor ANTES (citas a2b)');
\set ON_ERROR_STOP off
select * from citas.claim_messaging_outbox_batch(5);
\set ON_ERROR_STOP on
commit;
rollback;

\echo '=== citas ANTES: la fila de negocio se PERDIÓ (prueba el bug -- deberia_ser_0) ==='
begin;
select count(*) as citas_antes_fila_perdida_deberia_ser_0 from citas.providers where id = '00000000-0000-0000-0000-0000000010e1';
rollback;

\echo '=== citas DESPUES (con SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE): fila de negocio persiste tras commit ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000010c1', true);
insert into citas.providers (id, organization_id, display_name)
values ('00000000-0000-0000-0000-0000000010e2', '00000000-0000-0000-0000-0000000010a2', 'Proveedor DESPUES (citas a2b)');
savepoint sp_inline_whatsapp_dispatch;
\set ON_ERROR_STOP off
select * from citas.claim_messaging_outbox_batch(5);
\set ON_ERROR_STOP on
rollback to savepoint sp_inline_whatsapp_dispatch;
release savepoint sp_inline_whatsapp_dispatch;
commit;
rollback;

\echo '=== citas DESPUES: la fila de negocio PERSISTE (prueba el fix -- deberia_ser_1) ==='
begin;
select count(*) as citas_despues_fila_persiste_deberia_ser_1 from citas.providers where id = '00000000-0000-0000-0000-0000000010e2';
rollback;

-- =============================================================================
-- HOTELES — defensa en profundidad (mismo criterio que citas arriba): hoteles.guest
-- (grant insert + policy can_manage_reservations(), ver packages/domain-hoteles/
-- migrations/018_admin_catalogo_alta.sql). Hoy NINGÚN call site de hoteles invoca
-- triggerHotelesWhatsAppDispatchInline en sesión de staff (solo el webhook, ver
-- README.md).
-- =============================================================================

\echo '=== hoteles ANTES (sin SAVEPOINT): fila de negocio + claim_messaging_outbox_batch (42501) + commit -- reproduce el bug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000010c1', true);
insert into hoteles.guest (id, organization_id, property_id, full_name, email)
values ('00000000-0000-0000-0000-0000000010f1', '00000000-0000-0000-0000-0000000010a3', '00000000-0000-0000-0000-0000000010b3', 'Huésped ANTES (hoteles a2b)', 'antes-a2b@example.com');
\set ON_ERROR_STOP off
select * from hoteles.claim_messaging_outbox_batch(5);
\set ON_ERROR_STOP on
commit;
rollback;

\echo '=== hoteles ANTES: la fila de negocio se PERDIÓ (prueba el bug -- deberia_ser_0) ==='
begin;
select count(*) as hoteles_antes_fila_perdida_deberia_ser_0 from hoteles.guest where id = '00000000-0000-0000-0000-0000000010f1';
rollback;

\echo '=== hoteles DESPUES (con SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE): fila de negocio persiste tras commit ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000010c1', true);
insert into hoteles.guest (id, organization_id, property_id, full_name, email)
values ('00000000-0000-0000-0000-0000000010f2', '00000000-0000-0000-0000-0000000010a3', '00000000-0000-0000-0000-0000000010b3', 'Huésped DESPUES (hoteles a2b)', 'despues-a2b@example.com');
savepoint sp_inline_whatsapp_dispatch;
\set ON_ERROR_STOP off
select * from hoteles.claim_messaging_outbox_batch(5);
\set ON_ERROR_STOP on
rollback to savepoint sp_inline_whatsapp_dispatch;
release savepoint sp_inline_whatsapp_dispatch;
commit;
rollback;

\echo '=== hoteles DESPUES: la fila de negocio PERSISTE (prueba el fix -- deberia_ser_1) ==='
begin;
select count(*) as hoteles_despues_fila_persiste_deberia_ser_1 from hoteles.guest where id = '00000000-0000-0000-0000-0000000010f2';
rollback;

\echo '=== FIN — 16 escenarios: los 4 *_antes_*_deberia_ser_0 y los 4 *_despues_*_deberia_ser_1 son las verificaciones de valor (restaurantes original, restaurantes Blocker A, citas, hoteles); los 8 bloques ANTES/DESPUES de arriba deben completar sin ERROR (la excepción 42501 se absorbe con \set ON_ERROR_STOP off, a propósito). ==='
