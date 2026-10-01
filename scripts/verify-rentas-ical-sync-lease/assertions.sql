-- Fixtures + assertions contra Postgres REAL (RLS/GRANT/auth.uid()/security definer
-- reales -- el repositorio en memoria de domain-rentas nunca los aplica) de
-- packages/domain-rentas/migrations/024_rentas_ical_sync_lease_backoff_bitacora.sql
-- (Rn-01: sync iCal como lote idempotente).
--
-- Qué demuestra (positivo, negativo, cross-tenant, anon):
--   A. claim/lease: la sesión de sistema (auth.uid() NULL) reclama feeds; un segundo claim
--      no entrega el mismo feed; un lease expirado se reclama de nuevo; el piso de
--      espaciamiento entre intentos se respeta; liberar exige el token vigente.
--   B. backoff: tabla de la función pura + un feed fallido queda fuera de la cola hasta
--      su proximo_intento_en; un éxito lo limpia.
--   C. bitácora: solo la sesión de sistema escribe (vía función), el tenant se deriva
--      del feed, el staff de la property la lee, el de otra organización no, y solo puede
--      marcar una alerta como atendida (a sí mismo, una vez).
--   D. GRANT por columna: el staff ya NO puede escribir columnas de lease; SÍ sigue
--      pudiendo conectar/desconectar un feed (url_importacion/activo) y la sesión de
--      sistema SÍ sigue persistiendo el estado del sync.
--   E. conflictos: el staff de la property resuelve un conflicto (una sola vez, atribuido
--      a sí mismo); otra organización y la sesión de sistema no pueden; anon no ve nada.
--
-- Run vía scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con
-- ./run.sh. Cada escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (ical-lease)', 'org-a-ical-lease'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (ical-lease, ajena)', 'org-b-ical-lease')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Property A1'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Property B1 (ajena)')
on conflict do nothing;

insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Unidad A1-1', 1),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'Unidad B1-1 (ajena)', 1)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'admin-org-a-lease@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000013', 'admin-org-b-lease@example.com', 'Admin Org B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-0000000000a2', null, 'admin', 'admin_gestora')
on conflict do nothing;

-- 3 feeds de la Org A (airbnb/booking/vrbo, misma unidad) y 1 de la Org B.
insert into rentas.canal_feed_externo (id, organization_id, property_id, unidad_id, canal_id, url_importacion)
select v.id::uuid, v.org::uuid, v.prop::uuid, v.uni::uuid, c.id, 'https://example.com/' || v.id || '.ics'
from (values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'airbnb'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'booking'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'vrbo'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c2', 'airbnb')
) as v(id, org, prop, uni, canal)
join rentas.canal c on c.codigo = v.canal
on conflict do nothing;

-- Un overbooking entre canales ya detectado (reserva confirmada de airbnb + reserva de
-- booking en conflicto_pendiente sobre el mismo rango) para los escenarios de E.
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id)
select '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
       daterange('2027-01-01', '2027-01-05', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, c.id, 'uid-airbnb-1'
from rentas.canal c where c.codigo = 'airbnb'
on conflict do nothing;
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id)
select '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
       daterange('2027-01-01', '2027-01-05', '[)'), 'reserva', 'RESERVA_CANAL', 'conflicto_pendiente', false, c.id, 'uid-booking-1'
from rentas.canal c where c.codigo = 'booking'
on conflict do nothing;
insert into rentas.conflicto_calendario (id, organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', 'overbooking_confirmado')
on conflict do nothing;

\echo ''
\echo '=== A. claim/lease ==='
\echo ''

\echo '--- 1. la sesion de sistema (auth.uid() NULL) reclama los 4 feeds activos de la plataforma (de todas las organizaciones: el cron no esta acotado por tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as reclamados_deberia_ser_4 from rentas.claim_ical_feeds();
rollback;

\echo '--- 2. un segundo claim en la misma ventana NO entrega ningun feed ya reclamado (lease vigente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from rentas.claim_ical_feeds();
select count(*) as segundo_claim_deberia_ser_0 from rentas.claim_ical_feeds();
rollback;

\echo '--- 3. p_limite se respeta: claim de 2 devuelve 2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as limite_deberia_ser_2 from rentas.claim_ical_feeds(2);
rollback;

\echo '--- 4. un staff autenticado (auth.uid() no nulo) NO puede reclamar feeds -- RECHAZADO (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as should_fail from rentas.claim_ical_feeds();
rollback;

\echo '--- 5. anon no tiene EXECUTE sobre claim_ical_feeds -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.claim_ical_feeds();
rollback;

\echo '--- 6. un lease expirado vuelve a ser reclamable (el consumidor murio sin liberar) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from rentas.claim_ical_feeds();
reset role;
update rentas.canal_feed_externo set lease_hasta = now() - interval '1 second', ultimo_intento_en = now() - interval '1 hour' where id = '00000000-0000-0000-0000-0000000000f1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as lease_expirado_reclamable_deberia_ser_1 from rentas.claim_ical_feeds() where feed_id = '00000000-0000-0000-0000-0000000000f1';
rollback;

\echo '--- 7. un feed con lease VIGENTE aunque su ultimo intento sea viejo no se reclama (el lease manda sobre el espaciamiento) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from rentas.claim_ical_feeds();
reset role;
update rentas.canal_feed_externo set ultimo_intento_en = now() - interval '1 hour' where id = '00000000-0000-0000-0000-0000000000f2';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as lease_vigente_no_reclamable_deberia_ser_0 from rentas.claim_ical_feeds() where feed_id = '00000000-0000-0000-0000-0000000000f2';
rollback;

\echo '--- 8. liberar con el token vigente funciona (devuelve true) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table tok as select * from rentas.claim_ical_feeds(1);
select (rentas.liberar_ical_feed(feed_id, lease_token, true))::int as liberado_deberia_ser_1 from tok;
rollback;

\echo '--- 9. liberar con un token ajeno NO libera ni pisa el lease vigente (devuelve false) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table tok as select * from rentas.claim_ical_feeds(1);
select (rentas.liberar_ical_feed(feed_id, gen_random_uuid(), true))::int as token_ajeno_deberia_ser_0 from tok;
rollback;

\echo '--- 10. un staff autenticado no puede liberar un lease -- RECHAZADO (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table tok as select * from rentas.claim_ical_feeds(1);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.liberar_ical_feed(feed_id, lease_token, true) as should_fail from tok;
rollback;

\echo '--- 11. tras un exito, el espaciamiento minimo (600 s) mantiene al feed fuera de una segunda corrida inmediata ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table tok as select * from rentas.claim_ical_feeds(1);
select rentas.liberar_ical_feed(feed_id, lease_token, true) from tok;
select count(*) as espaciamiento_deberia_ser_0 from rentas.claim_ical_feeds() where feed_id = (select feed_id from tok);
rollback;

\echo ''
\echo '=== B. backoff ==='
\echo ''

\echo '--- 12. tabla de backoff: 1->30 min, 2->60, 3->2 h, 4->4 h, 5 o mas->6 h (tope), sin dato cuenta como 1 ---'
begin;
select (rentas.ical_backoff_segundos(1) = 1800 and rentas.ical_backoff_segundos(2) = 3600 and rentas.ical_backoff_segundos(3) = 7200
        and rentas.ical_backoff_segundos(4) = 14400 and rentas.ical_backoff_segundos(5) = 21600 and rentas.ical_backoff_segundos(99) = 21600
        and rentas.ical_backoff_segundos(0) = 1800 and rentas.ical_backoff_segundos(null) = 1800)::int as tabla_backoff_deberia_ser_1;
rollback;

\echo '--- 13. un feed fallido con 3 fallos consecutivos queda con proximo_intento_en ~ +2 h ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table tok as select * from rentas.claim_ical_feeds(1);
reset role;
update rentas.canal_feed_externo set intentos_fallidos_consecutivos = 3 where id = (select feed_id from tok);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.liberar_ical_feed(feed_id, lease_token, false) from tok;
select (f.proximo_intento_en > now() + interval '119 minutes' and f.proximo_intento_en <= now() + interval '121 minutes')::int as backoff_2h_deberia_ser_1
from rentas.canal_feed_externo f where f.id = (select feed_id from tok);
rollback;

\echo '--- 14. un feed en backoff NO se reclama aunque ya paso el espaciamiento minimo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table tok as select * from rentas.claim_ical_feeds(1);
select rentas.liberar_ical_feed(feed_id, lease_token, false) from tok;
reset role;
update rentas.canal_feed_externo set ultimo_intento_en = now() - interval '2 hours' where id = (select feed_id from tok);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as backoff_no_reclamable_deberia_ser_0 from rentas.claim_ical_feeds() where feed_id = (select feed_id from tok);
rollback;

\echo '--- 15. un exito limpia el backoff (proximo_intento_en vuelve a NULL) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table tok as select * from rentas.claim_ical_feeds(1);
select rentas.liberar_ical_feed(feed_id, lease_token, false) from tok;
reset role;
update rentas.canal_feed_externo set lease_hasta = now() + interval '1 minute', lease_token = (select lease_token from tok) where id = (select feed_id from tok);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.liberar_ical_feed(feed_id, lease_token, true) from tok;
select (f.proximo_intento_en is null)::int as backoff_limpio_deberia_ser_1 from rentas.canal_feed_externo f where f.id = (select feed_id from tok);
rollback;

\echo ''
\echo '=== C. bitacora / alertas ==='
\echo ''

\echo '--- 16. la sesion de sistema registra un evento y el tenant se DERIVA del feed (organization/property/unidad correctos) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', '3 intentos consecutivos de fetch fallidos', 0, 0);
reset role;
select (organization_id = '00000000-0000-0000-0000-0000000000a1' and property_id = '00000000-0000-0000-0000-0000000000b1' and unidad_id = '00000000-0000-0000-0000-0000000000c1')::int as tenant_derivado_deberia_ser_1
from rentas.ical_sync_bitacora where feed_id = '00000000-0000-0000-0000-0000000000f1';
rollback;

\echo '--- 17. un staff autenticado NO puede escribir la bitacora via la funcion -- RECHAZADO (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'sync_fallido', 'aviso', 'x', 0, 0) as should_fail;
rollback;

\echo '--- 18. un feed inexistente se rechaza (P0002), nunca crea una fila huerfana ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-00000000dead', 'sync_fallido', 'aviso', 'x', 0, 0) as should_fail;
rollback;

\echo '--- 19. un tipo fuera del catalogo se rechaza por el CHECK de la tabla ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'tipo_inventado', 'aviso', 'x', 0, 0) as should_fail;
rollback;

\echo '--- 20. INSERT directo del staff en la bitacora -- RECHAZADO (sin GRANT de INSERT) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.ical_sync_bitacora (organization_id, property_id, unidad_id, feed_id, canal_id, tipo, severidad)
  select organization_id, property_id, unidad_id, id, canal_id, 'sync_fallido', 'aviso' from rentas.canal_feed_externo where id = '00000000-0000-0000-0000-0000000000f1'
  returning id as should_fail;
rollback;

\echo '--- 21. cross-tenant: el staff de la Org A VE la alerta de su propio feed ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', 'x', 0, 0);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as visibles_org_a_deberia_ser_1 from rentas.ical_sync_bitacora where feed_id = '00000000-0000-0000-0000-0000000000f1';
rollback;

\echo '--- 22. cross-tenant: el staff de la Org B NO ve la bitacora de la Org A (RLS silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', 'x', 0, 0);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(*) as visibles_org_b_deberia_ser_0 from rentas.ical_sync_bitacora where feed_id = '00000000-0000-0000-0000-0000000000f1';
rollback;

\echo '--- 23. el staff de la Org A marca la alerta como atendida (atribuida a si mismo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', 'x', 0, 0);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with u as (update rentas.ical_sync_bitacora set atendida_en = now(), atendida_por = auth.uid() where feed_id = '00000000-0000-0000-0000-0000000000f1' and atendida_en is null returning 1)
select count(*) as atendida_deberia_ser_1 from u;
rollback;

\echo '--- 24. el staff de la Org B NO puede atender la alerta de la Org A (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', 'x', 0, 0);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
with u as (update rentas.ical_sync_bitacora set atendida_en = now(), atendida_por = auth.uid() where feed_id = '00000000-0000-0000-0000-0000000000f1' returning 1)
select count(*) as atendida_ajena_deberia_ser_0 from u;
rollback;

\echo '--- 25. atribuir la atencion a OTRO usuario -- RECHAZADO (with check atendida_por = auth.uid()) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', 'x', 0, 0);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.ical_sync_bitacora set atendida_en = now(), atendida_por = '00000000-0000-0000-0000-000000000013' where feed_id = '00000000-0000-0000-0000-0000000000f1' returning id as should_fail;
rollback;

\echo '--- 26. el staff no puede editar otras columnas de la bitacora (detalle) -- RECHAZADO (GRANT por columna) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', 'x', 0, 0);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.ical_sync_bitacora set detalle = 'borrado' where feed_id = '00000000-0000-0000-0000-0000000000f1' returning id as should_fail;
rollback;

\echo '--- 27. una alerta ya atendida no se puede reabrir (using exige atendida_en NULL): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', 'x', 0, 0);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.ical_sync_bitacora set atendida_en = now(), atendida_por = auth.uid() where feed_id = '00000000-0000-0000-0000-0000000000f1';
with u as (update rentas.ical_sync_bitacora set atendida_en = now(), atendida_por = auth.uid() where feed_id = '00000000-0000-0000-0000-0000000000f1' returning 1)
select count(*) as reabrir_o_reatender_deberia_ser_0 from u;
rollback;

\echo '--- 28. el staff no puede borrar filas de la bitacora (append-only) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.registrar_ical_sync_evento('00000000-0000-0000-0000-0000000000f1', 'cuarentena_activada', 'critica', 'x', 0, 0);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
delete from rentas.ical_sync_bitacora where feed_id = '00000000-0000-0000-0000-0000000000f1' returning id as should_fail;
rollback;

\echo '--- 29. anon no lee la bitacora -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.ical_sync_bitacora;
rollback;

\echo ''
\echo '=== D. GRANT por columna en canal_feed_externo ==='
\echo ''

\echo '--- 30. el staff NO puede escribir lease_token -- RECHAZADO (sin GRANT de columna) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.canal_feed_externo set lease_token = gen_random_uuid() where id = '00000000-0000-0000-0000-0000000000f1' returning id as should_fail;
rollback;

\echo '--- 31. el staff NO puede escribir lease_hasta (no puede fijarse un lease eterno) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.canal_feed_externo set lease_hasta = now() + interval '100 years' where id = '00000000-0000-0000-0000-0000000000f1' returning id as should_fail;
rollback;

\echo '--- 32. regresion: el staff SI puede conectar/reconectar un feed (url_importacion, activo, updated_at, proximo_intento_en) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with u as (update rentas.canal_feed_externo set url_importacion = 'https://example.com/nueva.ics', activo = true, updated_at = now(), proximo_intento_en = null where id = '00000000-0000-0000-0000-0000000000f1' returning 1)
select count(*) as reconexion_deberia_ser_1 from u;
rollback;

\echo '--- 33. regresion: el upsert real de connectFeed (INSERT ... ON CONFLICT DO UPDATE) sigue funcionando para el staff ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.canal_feed_externo (organization_id, property_id, unidad_id, canal_id, url_importacion, activo)
  select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, 'https://example.com/otra.ics', true from rentas.canal c where c.codigo = 'airbnb'
  on conflict (unidad_id, canal_id) do update set url_importacion = excluded.url_importacion, activo = true, updated_at = now()
  returning id;
rollback;

\echo '--- 34. regresion: la sesion de sistema SI persiste el estado del sync (columnas que escribe persistFeedSyncState) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with u as (update rentas.canal_feed_externo set ultima_sincronizacion_exitosa_en = now(), en_cuarentena_desde = null, intentos_fallidos_consecutivos = 0, motivo_cuarentena = null,
  etag_import = 'e', ultima_modificacion_http_import = 'm', drift_ultima_reconciliacion_completa = coalesce(0, drift_ultima_reconciliacion_completa), ultimo_resumen = '{}'::jsonb, updated_at = now()
  where id = '00000000-0000-0000-0000-0000000000f1' returning 1)
select count(*) as persistir_estado_deberia_ser_1 from u;
rollback;

\echo '--- 35. cross-tenant: el staff de la Org B no puede tocar un feed de la Org A (0 filas, RLS) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
with u as (update rentas.canal_feed_externo set activo = false where id = '00000000-0000-0000-0000-0000000000f1' returning 1)
select count(*) as feed_ajeno_deberia_ser_0 from u;
rollback;

\echo ''
\echo '=== E. conflictos de calendario ==='
\echo ''

\echo '--- 36. el staff de la Org A ve el overbooking entre canales de su property ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as visibles_deberia_ser_1 from rentas.conflicto_calendario where tipo = 'overbooking_confirmado' and resuelto_en is null;
rollback;

\echo '--- 37. el staff de la Org A resuelve el conflicto (atribuido a si mismo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with u as (update rentas.conflicto_calendario set resuelto_en = now(), resuelto_por = auth.uid() where id = '00000000-0000-0000-0000-0000000000e1' returning 1)
select count(*) as resuelto_deberia_ser_1 from u;
rollback;

\echo '--- 38. cross-tenant: el staff de la Org B NO puede resolver el conflicto de la Org A (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
with u as (update rentas.conflicto_calendario set resuelto_en = now(), resuelto_por = auth.uid() where id = '00000000-0000-0000-0000-0000000000e1' returning 1)
select count(*) as conflicto_ajeno_deberia_ser_0 from u;
rollback;

\echo '--- 39. resolver "a nombre de" otro usuario -- RECHAZADO (with check resuelto_por = auth.uid()) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.conflicto_calendario set resuelto_en = now(), resuelto_por = '00000000-0000-0000-0000-000000000013' where id = '00000000-0000-0000-0000-0000000000e1' returning id as should_fail;
rollback;

\echo '--- 40. un conflicto ya resuelto no se puede reabrir ni re-resolver (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.conflicto_calendario set resuelto_en = now(), resuelto_por = auth.uid() where id = '00000000-0000-0000-0000-0000000000e1';
with u as (update rentas.conflicto_calendario set resuelto_en = null, resuelto_por = null where id = '00000000-0000-0000-0000-0000000000e1' returning 1)
select count(*) as reabrir_deberia_ser_0 from u;
rollback;

\echo '--- 41. la sesion de sistema (auth.uid() NULL) NO resuelve conflictos: resolver es una decision humana (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with u as (update rentas.conflicto_calendario set resuelto_en = now() where id = '00000000-0000-0000-0000-0000000000e1' returning 1)
select count(*) as sistema_resuelve_deberia_ser_0 from u;
rollback;

\echo '--- 42. el staff no puede editar otras columnas del conflicto (tipo) -- RECHAZADO (GRANT por columna) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.conflicto_calendario set tipo = 'capa_cruzada' where id = '00000000-0000-0000-0000-0000000000e1' returning id as should_fail;
rollback;

\echo '--- 43. anon no lee los conflictos -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.conflicto_calendario;
rollback;

\echo '--- fin: los escenarios should_fail deben terminar en ERROR, los deberia_ser_N en N ---'
