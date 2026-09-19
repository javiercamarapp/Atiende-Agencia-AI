-- Verificación ANTES/DESPUÉS contra Postgres REAL del hallazgo confirmado de la
-- auditoría a2 (CRÍTICO): "el drenado inline de correo aborta la transacción de
-- negocio en TODA ruta con sesión de staff". Ver
-- auditoria-a2-resultado.json::confirmed[0] para el detalle completo con
-- archivo/línea.
--
-- Mecanismo que esto reproduce, IDÉNTICO al que corre `apps/api/src/routes/
-- verticals/<vertical>/{email-dispatch,notifications,alertNotifications}.ts::
-- triggerXEmailDispatchInline` sobre `c.get("db")`:
--   1. Una ruta de STAFF (authMiddleware -> dbSession, auth.uid() no nulo) abre
--      UNA transacción para todo el request (`begin;` + `set local role
--      authenticated;` + `select set_config('request.jwt.claim.sub', ...)`,
--      mismo patrón que packages/db/src/managed-postgres-engine.ts).
--   2. Dentro de ESA MISMA transacción escribe una fila de negocio real (folio
--      cerrado, reserva creada, proveedor de citas dado de alta...) y luego llama
--      `<vertical>.claim_email_outbox_batch(...)` para intentar enviar el correo
--      YA en vez de esperar al cron diario.
--   3. `claim_email_outbox_batch` SIEMPRE lanza 42501 en sesión de staff (guard
--      correcto, cross-tenant -- NO se toca, ver packages/domain-*/migrations/
--      *_email_outbox_authenticated_grants.sql) -- pasa HAYA O NO correos
--      pendientes, la excepción se lanza antes de tocar cualquier fila.
--   4. SIN un SAVEPOINT que la rodee, esa excepción deja la transacción COMPLETA
--      abortada (25P02) hasta que algo haga `ROLLBACK TO SAVEPOINT`. Un
--      `commit;` posterior sobre una transacción abortada NO lanza error --
--      Postgres responde "ROLLBACK" en silencio (ver
--      packages/db/src/managed-postgres-engine.ts::withAppSession, que nunca
--      revisa el resultado del `commit;`) -- la fila de negocio del paso 2 se
--      pierde con un 2xx.
--   5. CON el SAVEPOINT (el hotfix real, ver
--      apps/api/.../email-dispatch.ts::triggerXEmailDispatchInline tras el fix):
--      `SAVEPOINT sp_inline_email_dispatch` antes de intentar el drenado,
--      `ROLLBACK TO SAVEPOINT` + `RELEASE SAVEPOINT` en el catch -- la
--      transacción vuelve a un estado sano y el `commit;` posterior SÍ confirma
--      la fila de negocio.
--
-- Cubre hoteles (hoteles.guest, insertable directo por staff con
-- can_manage_reservations()), citas (citas.providers, insertable directo por
-- staff con membership de su organización) y rentas (rentas.guest_minimo,
-- insertable directo por staff con core.has_property_access()) -- las 3 tablas
-- más simples con GRANT INSERT real a `authenticated` de cada vertical, elegidas
-- para no necesitar la cadena completa de FKs de una reserva/folio/cita real: el
-- mecanismo que se prueba (una excepción de otra función, en la MISMA
-- transacción, aborta CUALQUIER escritura previa) es independiente de qué tabla
-- se escriba.
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
  ('00000000-0000-0000-0000-0000000000a1', 'hoteles', 'Org Hoteles a2', 'org-hoteles-a2'),
  ('00000000-0000-0000-0000-0000000000a2', 'citas', 'Org Citas a2', 'org-citas-a2'),
  ('00000000-0000-0000-0000-0000000000a3', 'rentas', 'Org Rentas a2', 'org-rentas-a2')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'hoteles', 'Hotel a2'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a3', 'rentas', 'Unidad a2')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c1', 'staff-a2@example.com', 'Staff a2', 'seed')
on conflict do nothing;

-- vertical_role='gm' porque hoteles.can_manage_reservations() exige
-- ('owner','gm','frontdesk','reservations'); citas/rentas no filtran por rol
-- (solo membership de la organización/property), 'admin' alcanza.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a3', null, 'admin', 'admin')
on conflict do nothing;

-- =============================================================================
-- HOTELES — hoteles.guest (grant insert + policy can_manage_reservations(), ver
-- packages/domain-hoteles/migrations/018_admin_catalogo_alta.sql)
-- =============================================================================

\echo '=== hoteles ANTES (sin SAVEPOINT): fila de negocio + claim_email_outbox_batch (42501) + commit -- reproduce el bug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into hoteles.guest (id, organization_id, property_id, full_name, email)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Huésped ANTES (hoteles)', 'antes@example.com');
\set ON_ERROR_STOP off
select * from hoteles.claim_email_outbox_batch(5);
\set ON_ERROR_STOP on
commit;
rollback;

\echo '=== hoteles ANTES: la fila de negocio se PERDIÓ (prueba el bug -- deberia_ser_0) ==='
begin;
select count(*) as hoteles_antes_fila_perdida_deberia_ser_0 from hoteles.guest where id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '=== hoteles DESPUES (con SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE, mismo patrón del hotfix): fila de negocio persiste tras commit ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into hoteles.guest (id, organization_id, property_id, full_name, email)
values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Huésped DESPUES (hoteles)', 'despues@example.com');
savepoint sp_inline_email_dispatch;
\set ON_ERROR_STOP off
select * from hoteles.claim_email_outbox_batch(5);
\set ON_ERROR_STOP on
rollback to savepoint sp_inline_email_dispatch;
release savepoint sp_inline_email_dispatch;
commit;
rollback;

\echo '=== hoteles DESPUES: la fila de negocio PERSISTE (prueba el fix -- deberia_ser_1) ==='
begin;
select count(*) as hoteles_despues_fila_persiste_deberia_ser_1 from hoteles.guest where id = '00000000-0000-0000-0000-0000000000d2';
rollback;

-- =============================================================================
-- CITAS — citas.providers (grant insert + policy "staff gestiona proveedores de
-- su organización", ver packages/domain-citas/migrations/
-- 011_citas_admin_backoffice_grants_and_policies.sql)
-- =============================================================================

\echo '=== citas ANTES (sin SAVEPOINT): fila de negocio + claim_email_outbox_batch (42501) + commit -- reproduce el bug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into citas.providers (id, organization_id, display_name)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2', 'Proveedor ANTES (citas)');
\set ON_ERROR_STOP off
select * from citas.claim_email_outbox_batch(5);
\set ON_ERROR_STOP on
commit;
rollback;

\echo '=== citas ANTES: la fila de negocio se PERDIÓ (prueba el bug -- deberia_ser_0) ==='
begin;
select count(*) as citas_antes_fila_perdida_deberia_ser_0 from citas.providers where id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '=== citas DESPUES (con SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE): fila de negocio persiste tras commit ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into citas.providers (id, organization_id, display_name)
values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a2', 'Proveedor DESPUES (citas)');
savepoint sp_inline_email_dispatch;
\set ON_ERROR_STOP off
select * from citas.claim_email_outbox_batch(5);
\set ON_ERROR_STOP on
rollback to savepoint sp_inline_email_dispatch;
release savepoint sp_inline_email_dispatch;
commit;
rollback;

\echo '=== citas DESPUES: la fila de negocio PERSISTE (prueba el fix -- deberia_ser_1) ==='
begin;
select count(*) as citas_despues_fila_persiste_deberia_ser_1 from citas.providers where id = '00000000-0000-0000-0000-0000000000e2';
rollback;

-- =============================================================================
-- RENTAS — rentas.guest_minimo (grant insert + policy "staff inserta huéspedes
-- mínimos de su property", ver packages/domain-rentas/migrations/
-- 001_rentas_schema.sql)
-- =============================================================================

\echo '=== rentas ANTES (sin SAVEPOINT): fila de negocio + claim_email_outbox_batch (42501) + commit -- reproduce el bug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b3', 'Huésped ANTES (rentas)', '5500000001');
\set ON_ERROR_STOP off
select * from rentas.claim_email_outbox_batch(5);
\set ON_ERROR_STOP on
commit;
rollback;

\echo '=== rentas ANTES: la fila de negocio se PERDIÓ (prueba el bug -- deberia_ser_0) ==='
begin;
select count(*) as rentas_antes_fila_perdida_deberia_ser_0 from rentas.guest_minimo where id = '00000000-0000-0000-0000-0000000000f1';
rollback;

\echo '=== rentas DESPUES (con SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE): fila de negocio persiste tras commit ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto)
values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b3', 'Huésped DESPUES (rentas)', '5500000002');
savepoint sp_inline_email_dispatch;
\set ON_ERROR_STOP off
select * from rentas.claim_email_outbox_batch(5);
\set ON_ERROR_STOP on
rollback to savepoint sp_inline_email_dispatch;
release savepoint sp_inline_email_dispatch;
commit;
rollback;

\echo '=== rentas DESPUES: la fila de negocio PERSISTE (prueba el fix -- deberia_ser_1) ==='
begin;
select count(*) as rentas_despues_fila_persiste_deberia_ser_1 from rentas.guest_minimo where id = '00000000-0000-0000-0000-0000000000f2';
rollback;

\echo '=== FIN — 12 escenarios: los 3 *_antes_*_deberia_ser_0 y los 3 *_despues_*_deberia_ser_1 son las verificaciones de valor; los 6 bloques ANTES/DESPUES de arriba deben completar sin ERROR (la excepción 42501 se absorbe con \set ON_ERROR_STOP off, a propósito). ==='
