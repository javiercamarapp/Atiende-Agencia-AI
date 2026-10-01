-- Fixtures + assertions contra Postgres REAL (RLS/GRANT/auth.uid()/security definer
-- reales -- el repositorio en memoria de domain-rentas nunca los aplica) de
-- packages/domain-rentas/migrations/026_rentas_conflictos_estado_bitacora.sql
-- (Rn-02: conflictos de calendario con estado abierto/resuelto/ignorado, motivo y bitácora).
--
-- Qué demuestra (positivo, negativo, cross-tenant, anon):
--   A. positivo: ignorar con motivo, resolver cuando el solape ya no existe, resolver sin
--      segunda ocupación; cada decisión deja su fila de bitácora atribuida a auth.uid().
--   B. regla segura: "resuelto" se rechaza mientras las dos ocupaciones sigan cruzadas;
--      ignorar exige motivo (3 a 500); acción inválida; un conflicto ya cerrado no se
--      vuelve a decidir.
--   C. autorización: otra organización, otra property, un rol de solo lectura, la sesión de
--      sistema y anon no pueden resolver (ni distinguir si el conflicto existe).
--   D. GRANT/RLS: el UPDATE directo de 024 quedó cerrado; la bitácora es solo lectura para
--      el staff de la property (append-only, sin INSERT/UPDATE/DELETE), otra organización y
--      anon no la ven.
--   E. CHECKs de la tabla (abierto <=> sin resolución; ignorado con motivo) y definer con
--      search_path fijo y EXECUTE revocado a public/anon.
--
-- Run vía scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con
-- ./run.sh. Cada escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (conflictos)', 'org-a-conflictos'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (conflictos, ajena)', 'org-b-conflictos')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Property A1'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Property A2 (misma organizacion)'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Property B1 (ajena)')
on conflict do nothing;

insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Unidad A1-1', 1)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'admin-org-a-conflictos@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000012', 'solo-calendario-org-a@example.com', 'Solo calendario Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000013', 'admin-org-b-conflictos@example.com', 'Admin Org B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:solo_calendario'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-0000000000a2', null, 'admin', 'admin_gestora')
on conflict do nothing;

-- Ocupaciones (todas de la Unidad A1-1, rangos distintos por conflicto para no chocar con el
-- EXCLUDE de reservas bloqueantes):
--   e1: d1 (airbnb, confirmado) vs d2 (booking, conflicto_pendiente)   -> solape VIGENTE
--   e2: d3 (airbnb, confirmado) vs d4 (booking, CANCELADO)             -> sin solape
--   e3: d5 (airbnb, confirmado) vs d6 (booking, conflicto_pendiente)   -> solape VIGENTE (otro)
--   e6: d7 (bloqueo de mantenimiento) sin segunda ocupacion            -> no verificable
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id)
select v.id::uuid, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
       daterange(v.desde::date, v.hasta::date, '[)'), v.capa, v.razon, v.estado, v.bloqueante, c.id, v.uid
from (values
  ('00000000-0000-0000-0000-0000000000d1', '2027-01-01', '2027-01-05', 'reserva', 'RESERVA_CANAL', 'confirmado', true, 'airbnb', 'uid-1'),
  ('00000000-0000-0000-0000-0000000000d2', '2027-01-01', '2027-01-05', 'reserva', 'RESERVA_CANAL', 'conflicto_pendiente', false, 'booking', 'uid-2'),
  ('00000000-0000-0000-0000-0000000000d3', '2027-02-01', '2027-02-05', 'reserva', 'RESERVA_CANAL', 'confirmado', true, 'airbnb', 'uid-3'),
  ('00000000-0000-0000-0000-0000000000d4', '2027-02-01', '2027-02-05', 'reserva', 'RESERVA_CANAL', 'cancelado', false, 'booking', 'uid-4'),
  ('00000000-0000-0000-0000-0000000000d5', '2027-03-01', '2027-03-05', 'reserva', 'RESERVA_CANAL', 'confirmado', true, 'airbnb', 'uid-5'),
  ('00000000-0000-0000-0000-0000000000d6', '2027-03-01', '2027-03-05', 'reserva', 'RESERVA_CANAL', 'conflicto_pendiente', false, 'booking', 'uid-6')
) as v(id, desde, hasta, capa, razon, estado, bloqueante, canal, uid)
join rentas.canal c on c.codigo = v.canal
on conflict do nothing;
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante)
values ('00000000-0000-0000-0000-0000000000d7', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
        daterange('2027-04-01', '2027-04-05', '[)'), 'bloqueo', 'MANTENIMIENTO', 'confirmado', true)
on conflict do nothing;

insert into rentas.conflicto_calendario (id, organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', 'overbooking_confirmado'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000d4', 'overbooking_confirmado'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000d6', 'overbooking_confirmado'),
  ('00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d7', null, 'capa_cruzada')
on conflict do nothing;

-- Una decision YA registrada (como rol dueno, para los escenarios de lectura de la bitacora):
-- e3 ignorado por el admin de la Org A.
update rentas.conflicto_calendario set resuelto_en = now(), resuelto_por = '00000000-0000-0000-0000-000000000011', resolucion = 'ignorado', motivo_resolucion = 'mismo huesped en dos plataformas'
where id = '00000000-0000-0000-0000-0000000000e3';
insert into rentas.conflicto_calendario_bitacora (organization_id, property_id, conflicto_id, accion, motivo, actor_user_id) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e3', 'ignorado', 'mismo huesped en dos plataformas', '00000000-0000-0000-0000-000000000011');

\echo ''
\echo '=== A. positivo ==='
\echo ''

\echo '--- 1. el admin de la property ignora el conflicto abierto e1 con motivo: queda ignorado y atribuido a si mismo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', 'el huesped de Booking se muda a otra unidad');
select count(*) as ignorado_deberia_ser_1 from rentas.conflicto_calendario where id = '00000000-0000-0000-0000-0000000000e1' and resolucion = 'ignorado' and resuelto_por = auth.uid() and resuelto_en is not null and motivo_resolucion = 'el huesped de Booking se muda a otra unidad';
rollback;

\echo '--- 2. esa decision deja UNA fila de bitacora atribuida a auth.uid() ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', 'el huesped de Booking se muda a otra unidad');
select count(*) as bitacora_deberia_ser_1 from rentas.conflicto_calendario_bitacora where conflicto_id = '00000000-0000-0000-0000-0000000000e1' and accion = 'ignorado' and actor_user_id = auth.uid();
rollback;

\echo '--- 3. resolver e2 (una de las dos ocupaciones esta cancelada: el solape ya no existe) funciona sin motivo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e2', 'resuelto');
select count(*) as resuelto_deberia_ser_1 from rentas.conflicto_calendario where id = '00000000-0000-0000-0000-0000000000e2' and resolucion = 'resuelto' and motivo_resolucion is null and resuelto_por = auth.uid();
rollback;

\echo '--- 4. un conflicto sin segunda ocupacion (e6, bloqueo) se puede resolver: no hay solape verificable ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e6', 'resuelto', '  se quito el bloqueo  ');
select count(*) as resuelto_deberia_ser_1 from rentas.conflicto_calendario where id = '00000000-0000-0000-0000-0000000000e6' and resolucion = 'resuelto' and motivo_resolucion = 'se quito el bloqueo';
rollback;

\echo ''
\echo '=== B. regla segura ==='
\echo ''

\echo '--- 5. NO se puede marcar "resuelto" mientras las dos ocupaciones siguen cruzadas (e1) -- RECHAZADO (55000) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'resuelto') as should_fail;
rollback;

\echo '--- 6. el conflicto sigue abierto tras ese rechazo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as abierto_deberia_ser_1 from rentas.conflicto_calendario where id = '00000000-0000-0000-0000-0000000000e1' and resuelto_en is null and resolucion is null;
rollback;

\echo '--- 7. ignorar SIN motivo -- RECHAZADO (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado') as should_fail;
rollback;

\echo '--- 8. ignorar con un motivo de solo espacios o de 2 caracteres -- RECHAZADO (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', '  ab  ') as should_fail;
rollback;

\echo '--- 9. un motivo de mas de 500 caracteres -- RECHAZADO (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', repeat('x', 501)) as should_fail;
rollback;

\echo '--- 10. una accion fuera del catalogo (reabrir/cancelar) -- RECHAZADO (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'cancelar_reserva', 'x') as should_fail;
rollback;

\echo '--- 11. un conflicto ya cerrado (e3, ignorado en el fixture) no se decide otra vez -- RECHAZADO (P0002) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e3', 'ignorado', 'otra vez') as should_fail;
rollback;

\echo '--- 12. resolver nunca toca las reservas: las dos ocupaciones de e1 siguen igual tras ignorarlo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', 'se acepta el solape');
select count(*) as ocupaciones_intactas_deberia_ser_2 from rentas.ocupacion where id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2') and estado in ('confirmado', 'conflicto_pendiente') and version = 1;
rollback;

\echo ''
\echo '=== C. autorizacion ==='
\echo ''

\echo '--- 13. cross-tenant: el admin de la Org B NO puede decidir un conflicto de la Org A -- RECHAZADO (P0002, misma respuesta que inexistente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', 'intento ajeno') as should_fail;
rollback;

\echo '--- 14. misma organizacion pero OTRA property: el conflicto no pertenece a p_property_id -- RECHAZADO (P0002) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000e1', 'ignorado', 'property equivocada') as should_fail;
rollback;

\echo '--- 15. un rol de SOLO lectura (operador:solo_calendario) -- RECHAZADO (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', 'sin permiso de escritura') as should_fail;
rollback;

\echo '--- 16. la sesion de sistema (auth.uid() NULL) NO decide: resolver es una decision humana -- RECHAZADO (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', 'sesion de sistema') as should_fail;
rollback;

\echo '--- 17. anon no puede ejecutar la funcion -- RECHAZADO (permission denied) ---'
begin;
set local role anon;
select rentas.resolver_conflicto_calendario('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'ignorado', 'anon') as should_fail;
rollback;

\echo ''
\echo '=== D. GRANT / RLS ==='
\echo ''

\echo '--- 18. el UPDATE directo de 024 (resuelto_en/resuelto_por) quedo cerrado -- RECHAZADO (permission denied) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.conflicto_calendario set resuelto_en = now(), resuelto_por = auth.uid() where id = '00000000-0000-0000-0000-0000000000e1' returning id as should_fail;
rollback;

\echo '--- 19. tampoco se pueden escribir resolucion ni motivo a mano -- RECHAZADO (permission denied) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.conflicto_calendario set resolucion = 'resuelto', motivo_resolucion = 'a mano' where id = '00000000-0000-0000-0000-0000000000e1' returning id as should_fail;
rollback;

\echo '--- 20. el staff NO inserta filas en la bitacora a mano (deny-by-default) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.conflicto_calendario_bitacora (organization_id, property_id, conflicto_id, accion, motivo, actor_user_id) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'resuelto', 'falsa', '00000000-0000-0000-0000-000000000011') returning id as should_fail;
rollback;

\echo '--- 21. la bitacora es append-only: el staff no actualiza -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.conflicto_calendario_bitacora set motivo = 'reescrito' returning id as should_fail;
rollback;

\echo '--- 22. ... ni borran (el staff no tiene DELETE) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
delete from rentas.conflicto_calendario_bitacora returning id as should_fail;
rollback;

\echo '--- 23. el staff de la Org A lee la bitacora de su property (1 fila del fixture) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as visibles_deberia_ser_1 from rentas.conflicto_calendario_bitacora;
rollback;

\echo '--- 24. cross-tenant: el staff de la Org B no ve la bitacora de la Org A (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(*) as ajenas_deberia_ser_0 from rentas.conflicto_calendario_bitacora;
rollback;

\echo '--- 25. anon no lee la bitacora -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.conflicto_calendario_bitacora;
rollback;

\echo ''
\echo '=== E. CHECKs y definer ==='
\echo ''

\echo '--- 26. CHECK: una fila cerrada sin resolucion es incoherente -- RECHAZADO ---'
begin;
update rentas.conflicto_calendario set resuelto_en = now() where id = '00000000-0000-0000-0000-0000000000e1' returning id as should_fail;
rollback;

\echo '--- 27. CHECK: ignorado sin motivo no es posible ni siquiera para el rol dueno -- RECHAZADO ---'
begin;
update rentas.conflicto_calendario set resuelto_en = now(), resolucion = 'ignorado' where id = '00000000-0000-0000-0000-0000000000e1' returning id as should_fail;
rollback;

\echo '--- 28. CHECK: una resolucion fuera del catalogo -- RECHAZADO ---'
begin;
update rentas.conflicto_calendario set resuelto_en = now(), resolucion = 'cancelado' where id = '00000000-0000-0000-0000-0000000000e1' returning id as should_fail;
rollback;

\echo '--- 29. la funcion es security definer con search_path fijo que empieza en pg_catalog ---'
begin;
select count(*) as definer_deberia_ser_1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'rentas' and p.proname = 'resolver_conflicto_calendario' and p.prosecdef and array_to_string(p.proconfig, ',') like 'search_path=pg_catalog, rentas, core, pg_temp';
rollback;

\echo '--- 30. EXECUTE no esta concedido a anon ni a public ---'
begin;
select count(*) as sin_execute_deberia_ser_0 from (select 1 where has_function_privilege('anon', 'rentas.resolver_conflicto_calendario(uuid,uuid,text,text)', 'execute') or has_function_privilege('public', 'rentas.resolver_conflicto_calendario(uuid,uuid,text,text)', 'execute')) x;
rollback;

\echo '--- 31. coherencia global: ninguna fila queda cerrada sin resolucion ni con resolucion sin cerrar ---'
begin;
select count(*) as incoherentes_deberia_ser_0 from rentas.conflicto_calendario where (resuelto_en is null) <> (resolucion is null);
rollback;

\echo '--- fin: los escenarios should_fail deben terminar en ERROR, los deberia_ser_N en N ---'
