-- Demuestra, a nivel SQL puro contra Postgres real, el mecanismo COMPLETO que
-- motiva runWithSavepointFallback (packages/db/src/savepoint-fallback.ts) — ver el
-- comentario de cabecera de ese archivo para el diseño. Corre vía ./run.sh (UNA
-- sola conexión psql por escenario, para que BEGIN/COMMIT del propio escenario se
-- vean de verdad — a diferencia del resto de scripts/verify-*/assertions.sql de
-- este repo, que run-gate.mjs envuelve SIEMPRE en `begin;...rollback;`: esa
-- envoltura genérica no puede probar "qué tag de comando devuelve un COMMIT real",
-- así que este archivo NO sigue esa convención y run.sh lo parsea con su propia
-- lógica, no con scripts/verify-real-postgres-ci/run-gate.mjs).
--
-- Cada escenario imprime su propio marcador \echo ANTES y DESPUÉS -- run.sh graba
-- la salida completa de psql (que incluye el tag de cada comando: BEGIN/INSERT/
-- ERROR/COMMIT/ROLLBACK) y hace el pass/fail por grep entre esos marcadores.
\set ON_ERROR_STOP off
\pset pager off

-- =============================================================================
-- ESCENARIO 1 — SIN SAVEPOINT: un error deja la transacción abortada, la consulta
-- de "camino de respaldo" falla con 25P02, y el COMMIT final NO lanza error --
-- devuelve el tag ROLLBACK. Tabla temporal (vive solo en esta sesión) para poder
-- verificar DESPUÉS, en la misma sesión, que la transacción completa se revirtió.
-- =============================================================================
\echo 'MARCA-ESCENARIO-1-INICIO'
begin;
create temp table t_sin_savepoint(x int);
insert into t_sin_savepoint values (1);
select 1/0; -- SQLSTATE 22012 -- deja la transacción ABORTADA (cualquier error sirve; el mecanismo no depende del código específico)
select 1 as intento_de_respaldo_sin_savepoint; -- debe fallar con 25P02 -- la "consulta de respaldo" de un catch simple, sin SAVEPOINT
commit; -- Postgres NO lanza error -- imprime el tag ROLLBACK, no COMMIT
\echo 'MARCA-ESCENARIO-1-FIN'
-- La tabla temporal NUNCA debió persistir -- toda la transacción (CREATE TABLE
-- incluido) se revirtió. Esta consulta debe fallar ("relation ... does not
-- exist"), prueba independiente de que el COMMIT de arriba fue en realidad un
-- ROLLBACK.
\echo 'MARCA-ESCENARIO-1-VERIFICACION-INICIO'
select count(*) from t_sin_savepoint;
\echo 'MARCA-ESCENARIO-1-VERIFICACION-FIN'

-- =============================================================================
-- ESCENARIO 2 — CON SAVEPOINT: el mismo error, pero protegido -- ROLLBACK TO
-- SAVEPOINT recupera la sesión, el camino de respaldo SÍ corre, y el COMMIT final
-- es un COMMIT real.
-- =============================================================================
create table t_con_savepoint(x int); -- tabla PERMANENTE -- para verificar los datos en una sesión NUEVA después de este script.
\echo 'MARCA-ESCENARIO-2-INICIO'
begin;
insert into t_con_savepoint values (1);
savepoint sp_demo;
select 1/0; -- mismo error que el escenario 1
rollback to savepoint sp_demo; -- ESTO es lo que el escenario 1 no tenía -- recupera la sesión
release savepoint sp_demo;
insert into t_con_savepoint values (2); -- "camino de respaldo" -- ahora SÍ corre sin 25P02
commit; -- tag real COMMIT
\echo 'MARCA-ESCENARIO-2-FIN'
\echo 'MARCA-ESCENARIO-2-VERIFICACION-INICIO'
select count(*) as filas from t_con_savepoint; -- debe ser 2 -- la fila de ANTES del error Y la del camino de respaldo, ambas persistieron
\echo 'MARCA-ESCENARIO-2-VERIFICACION-FIN'

-- =============================================================================
-- ESCENARIO 3 — citas.appointments contra el CHECK viejo (23514), SIN la
-- migración 019 aplicada (run.sh la excluye a propósito -- ver su comentario).
-- Reproduce EXACTAMENTE el hallazgo CRÍTICO: markAppointmentGoogleSyncInvalid
-- degradando a google_sync_status='error' vía SAVEPOINT.
-- =============================================================================
insert into core.organization (id, vertical, name, slug, status) values
  ('90000000-0000-0000-0000-000000000001', 'citas', 'Verify Fallback Savepoint', 'verify-fallback-savepoint', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('90000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-000000000001', 'citas', 'Sucursal', 'active')
on conflict do nothing;
insert into citas.services (id, organization_id, name, duration_minutes, price_cents, is_active) values
  ('90000000-0000-0000-0000-0000000d0a01', '90000000-0000-0000-0000-000000000001', 'Consulta', 30, 10000, true)
on conflict do nothing;
insert into citas.providers (id, organization_id, property_id, display_name, role_label, is_active) values
  ('90000000-0000-0000-0000-0000000c0a01', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000a1', 'Proveedor', 'Proveedor', true)
on conflict do nothing;
insert into citas.customers (id, organization_id, full_name, phone, email) values
  ('90000000-0000-0000-0000-0000000e0a01', '90000000-0000-0000-0000-000000000001', 'Cliente sin correo', '9990000000', null)
on conflict do nothing;
insert into citas.appointments (id, organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source) values
  ('90000000-0000-0000-0000-0000000f0a01', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000a1',
   '90000000-0000-0000-0000-0000000c0a01', '90000000-0000-0000-0000-0000000d0a01', '90000000-0000-0000-0000-0000000e0a01',
   '2026-12-01 09:00:00-06', '2026-12-01 09:30:00-06', 'pending', 'web')
on conflict do nothing;

-- 3a. SIN SAVEPOINT: exactamente el UPDATE directo que tenía el código ANTES de
-- este PR -- debe fallar 23514 (CHECK viejo, sin 'invalid').
\echo 'MARCA-ESCENARIO-3A-INICIO'
begin;
update citas.appointments set google_sync_status = 'invalid' where id = '90000000-0000-0000-0000-0000000f0a01'; -- SQLSTATE 23514 -- 'invalid' no está en el CHECK viejo
rollback;
\echo 'MARCA-ESCENARIO-3A-FIN'

-- 3b. CON SAVEPOINT (el fix real): degrada a 'error', COMMIT real, motivo
-- conservado en google_sync_error.
\echo 'MARCA-ESCENARIO-3B-INICIO'
begin;
savepoint sp_google_sync_invalid;
update citas.appointments set google_sync_status = 'invalid', google_sync_error = 'Cal.com rechazó: falta attendeeEmail' where id = '90000000-0000-0000-0000-0000000f0a01'; -- falla 23514 otra vez
rollback to savepoint sp_google_sync_invalid;
release savepoint sp_google_sync_invalid;
update citas.appointments set google_sync_status = 'error', google_sync_error = 'Cal.com rechazó: falta attendeeEmail' where id = '90000000-0000-0000-0000-0000000f0a01'; -- camino de respaldo -- mismo SQL que markAppointmentGoogleSyncExhausted
commit; -- tag real COMMIT -- sin el SAVEPOINT de arriba, este commit habría impreso ROLLBACK
\echo 'MARCA-ESCENARIO-3B-FIN'
\echo 'MARCA-ESCENARIO-3B-VERIFICACION-INICIO'
select google_sync_status, google_sync_error from citas.appointments where id = '90000000-0000-0000-0000-0000000f0a01';
\echo 'MARCA-ESCENARIO-3B-VERIFICACION-FIN'
