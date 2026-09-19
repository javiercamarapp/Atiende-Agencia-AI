-- Fixtures + assertions que verifican, contra Postgres REAL, el fix de
-- migrations/023_night_audit_sistema_escritura.sql (punto 4 del inventario de
-- scripts/verify-flujos-sistema/README.md, analizado y dejado deliberadamente fuera
-- por scripts/verify-flujos-sistema-2/README.md -- léanse ambos primero, ahí vive la
-- metodología completa y el porqué de cada decisión de diseño; este directorio no la
-- repite).
--
-- Cubre, bajo sesión de sistema real
-- (`packages/db/src/managed-postgres-engine.ts::withAppSession({ userId: null })`
-- -- `set local role authenticated` + `auth.uid()` SIEMPRE NULL, nunca
-- `service_role`):
--   (A) night-audit completo de una property: lee el lote de reservas en casa +
--       tarifa+folio (JOIN completo), lee la configuración fiscal, postea el cargo de
--       hospedaje con el monto YA CALCULADO (simulando lo que TypeScript ya calculó
--       antes de llamar), NUNCA lo duplica en una segunda corrida, y el resumen de
--       caja (cargos por concepto / pagos por método) lo refleja.
--   (B) no-show completo: lee las candidatas, aplica la transición + penalización YA
--       CALCULADA en una sola llamada atómica, NUNCA la duplica en un reintento
--       (mismo guard que protege contra 2 instancias concurrentes -- ver el header de
--       migrations/023 para el análisis de por qué esto también cubre concurrencia
--       real, no solo un reintento secuencial), dejando el MISMO rastro que dejaría
--       el camino de staff (`hoteles.reservation_status_event`, actor NULL =
--       "sistema").
--   (C) Invariantes validadas por las funciones mismas (nunca solo por el llamador):
--       reserva de otra organización/property rechazada, folio que no es el de la
--       reserva rechazado, montos negativos rechazados.
--   (D) Controles negativos obligatorios: las 7 funciones nuevas rechazan a un staff
--       autenticado real (exclusivas de sesión de sistema) y a `anon`; un staff de la
--       organización B sigue sin ver folios/cargos de la organización A.
--   (E) Control positivo: el camino de staff de front desk (INSERT directo de un
--       cargo en su propio folio, camino YA existente, sin ningún cambio de esta
--       migración) sigue funcionando exactamente igual.
--   (F) Límite deliberado: esta migración NO abre ninguna policy de
--       reservation/folio/charge/payment -- un SELECT/INSERT directo contra esas
--       tablas bajo sesión de sistema SIGUE bloqueado exactamente igual que antes.
--   (G) Los totales del folio cuadran tras night-audit + un reverso (staff reversa el
--       cargo de hospedaje recién posteado por el camino de sistema -- mismo
--       `hoteles.mark_charge_reversed()` de siempre, sin cambio).
--
-- Corre vía ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI).
-- Cada escenario vive en su propio `begin; ... rollback;` -- nada de esta sección
-- persiste. IMPORTANTE (a diferencia de una prueba unitaria normal): cada bloque es
-- TOTALMENTE autocontenido -- una prueba de "reintento"/"no duplica" hace AMBAS
-- llamadas dentro del MISMO bloque (nunca confía en que el bloque anterior haya
-- persistido nada, porque no persiste). `reset role` (vuelve a `postgres`, dueño de
-- las tablas, bypass RLS) se usa SOLO para verificar el estado resultante dentro de
-- la MISMA transacción que hace rollback, cuando ninguna policy de staff/sistema
-- dejaría leerlo de otra forma -- mismo patrón ya usado por
-- scripts/verify-flujos-sistema/assertions.sql.
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten — corren como postgres, bypass RLS).
-- ---------------------------------------------------------------------------

insert into core.organization (id, vertical, name, slug, status) values
  ('76000000-0000-0000-0000-000000000001', 'hoteles', 'Hotel Night Audit Sistema A', 'night-audit-sistema-a', 'active'),
  ('76000000-0000-0000-0000-000000000002', 'hoteles', 'Hotel Night Audit Sistema B', 'night-audit-sistema-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-000000000001', 'hoteles', 'Property singleton A', 'active'),
  ('76000000-0000-0000-0000-0000000000b1', '76000000-0000-0000-0000-000000000002', 'hoteles', 'Property singleton B', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('76000000-0000-0000-0000-0000000f0a01', 'owner-a@night-audit-sistema.example.com', 'Owner A', 'seed'),
  ('76000000-0000-0000-0000-0000000f0b01', 'owner-b@night-audit-sistema.example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('76000000-0000-0000-0000-0000000f0a01', '76000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('76000000-0000-0000-0000-0000000f0b01', '76000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.tax_config (property_id, organization_id, iva_rate, ish_rate, discount_threshold) values
  ('76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-000000000001', 0.16, 0.03, 500)
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('76000000-0000-0000-0000-0000000c0a01', '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', 'Estándar')
on conflict do nothing;

-- Tarifa real de la noche auditada (2026-09-10) -- insumo del JOIN de
-- `system_list_in_house_reservations_for_night_audit` (escenario 1).
insert into hoteles.rate_plan (organization_id, property_id, room_type_id, date, price) values
  ('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000c0a01', '2026-09-10', 1000)
on conflict do nothing;

-- Reserva 1: "en casa" la noche del 2026-09-10 (check_in 08, check_out 12) -- objetivo
-- del posteo de hospedaje (escenarios 1, 3-8, 31). Con folio primario propio.
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount) values
  ('76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000c0a01', '2026-09-08', '2026-09-12', 'en_estancia', 4000)
on conflict do nothing;
insert into hoteles.folio (id, organization_id, property_id, reservation_id, label, is_primary) values
  ('76000000-0000-0000-0000-0000000e0a01', '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a01', 'Principal', true)
on conflict do nothing;

-- Reserva 3: "en casa" también, pero AJENA a la reserva 1 -- su folio (folio 3) es el
-- que el escenario 7 usa para probar que `system_post_night_audit_charge` rechaza un
-- folio que no es el de la reserva que se le pasa.
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount) values
  ('76000000-0000-0000-0000-0000000d0a03', '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000c0a01', '2026-01-01', '2026-01-03', 'en_estancia', 1000)
on conflict do nothing;
insert into hoteles.folio (id, organization_id, property_id, reservation_id, label, is_primary) values
  ('76000000-0000-0000-0000-0000000e0a03', '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a03', 'Principal', true)
on conflict do nothing;

-- Reserva 2: 'confirmada', check-in 2026-09-05, ya vencida al 2026-09-10 -- candidata
-- a no-show (escenarios 9-13). total_amount=3000 / 3 noches = 1000 neto de
-- penalización (evaluateNoShowPenaltyBase real) -- IVA 16% = 160, ISH 0 (no-show NUNCA
-- cobra ISH, computeNoShowPenaltyAmounts).
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount) values
  ('76000000-0000-0000-0000-0000000d0a02', '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000c0a01', '2026-09-05', '2026-09-08', 'confirmada', 3000)
on conflict do nothing;

-- Reserva 5: otra 'confirmada' -- objetivo de los controles cross-tenant/monto
-- inválido de `system_apply_no_show` (escenarios 14-16), para no interferir con la
-- reserva 2 (que los escenarios 10-13 SÍ consumen).
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount) values
  ('76000000-0000-0000-0000-0000000d0a05', '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000c0a01', '2026-08-01', '2026-08-03', 'confirmada', 1000)
on conflict do nothing;

-- Pago real capturado en el folio 1 -- insumo del escenario 5
-- (`system_sum_payments_by_method_for_business_date`). `created_at` real (now(), sin
-- override) porque esa función agrupa por la fecha de negocio en que se CAPTURÓ el
-- pago, no por ninguna fecha de estadía -- las verificaciones que lo leen usan
-- `(now() at time zone 'America/Mexico_City')::date` como `p_business_date`, nunca
-- una fecha fija, para no depender de cuándo corre este script.
insert into hoteles.payment (organization_id, property_id, folio_id, amount, method, status) values
  ('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000e0a01', 500, 'tarjeta', 'capturado')
on conflict do nothing;

-- =============================================================================
-- (A) Night-audit completo bajo sesión de sistema.
-- =============================================================================

\echo '=== 1. system_list_in_house_reservations_for_night_audit: la sesion de sistema SI ve la reserva en casa con su folio primario + tarifa de la noche (JOIN completo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (count(*) filter (
    where out_reservation_id = '76000000-0000-0000-0000-0000000d0a01'
      and out_folio_id = '76000000-0000-0000-0000-0000000e0a01'
      and out_nightly_price = 1000
  ))::int as ve_reserva_en_casa_con_folio_y_tarifa_deberia_ser_1
  from hoteles.system_list_in_house_reservations_for_night_audit('76000000-0000-0000-0000-0000000000a1', '2026-09-10');
rollback;

\echo '=== 2. system_load_tax_config: la sesion de sistema SI lee IVA/ISH/umbral reales (antes: bloqueado por core.has_property_access) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_iva_rate = 0.16 and out_ish_rate = 0.03 and out_discount_threshold = 500)::int as lee_tax_config_real_deberia_ser_1
  from hoteles.system_load_tax_config('76000000-0000-0000-0000-0000000000a1');
rollback;

\echo '=== 3. system_post_night_audit_charge: postea el cargo de hospedaje con el monto YA CALCULADO, y una segunda corrida de la MISMA noche NUNCA lo duplica (indice unico parcial existente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_is_new as primera_corrida_es_nueva
  from hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-10', 1000, 190
  );
select out_is_new as segunda_corrida_no_es_nueva
  from hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-10', 1000, 190
  );
-- `reset role` (vuelve a `postgres`, dueño de la tabla, bypass RLS) SOLO para
-- verificar el estado resultante dentro de la MISMA transacción que hace rollback --
-- `hoteles.charge` SIGUE sin SELECT directo para sesión de sistema a propósito
-- (límite deliberado, ver escenario 30 más abajo), así que un SELECT bajo
-- `authenticated`/`auth.uid() is null` aquí devolvería 0 filas en silencio y este
-- control de "no duplica" no probaría nada real.
reset role;
select count(*)::int as una_sola_fila_de_hospedaje_tras_2_corridas_deberia_ser_1
  from hoteles.charge
  where folio_id = '76000000-0000-0000-0000-0000000e0a01' and stay_date = '2026-09-10' and concept = 'hospedaje';
rollback;

\echo '=== 4. system_sum_charges_by_concept_for_business_date: el resumen de caja del dia SI ve el cargo de hospedaje recien posteado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_is_new
  from hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-10', 1000, 190
  );
select (count(*) filter (where out_concept = 'hospedaje' and out_total = 1190))::int as resumen_de_caja_ve_el_cargo_deberia_ser_1
  from hoteles.system_sum_charges_by_concept_for_business_date(
    '76000000-0000-0000-0000-0000000000a1', (now() at time zone 'America/Mexico_City')::date, 'America/Mexico_City'
  );
rollback;

\echo '=== 5. system_sum_payments_by_method_for_business_date: el resumen de caja del dia SI ve el pago ya capturado (fixture) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (count(*) filter (where out_method = 'tarjeta' and out_total = 500))::int as resumen_de_caja_ve_el_pago_deberia_ser_1
  from hoteles.system_sum_payments_by_method_for_business_date(
    '76000000-0000-0000-0000-0000000000a1', (now() at time zone 'America/Mexico_City')::date, 'America/Mexico_City'
  );
rollback;

\echo '=== 6. system_post_night_audit_charge rechaza una reserva que no pertenece a la organizacion/property indicada (invariante validada por la funcion, no solo por el llamador) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000002', '76000000-0000-0000-0000-0000000000b1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-10', 1000, 190
  ) as should_fail;
rollback;

\echo '=== 7. system_post_night_audit_charge rechaza un folio que NO es el folio primario de la reserva indicada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a03',
    '2026-09-10', 1000, 190
  ) as should_fail;
rollback;

\echo '=== 8. system_post_night_audit_charge rechaza un monto negativo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-10', -1, 0
  ) as should_fail;
rollback;

-- =============================================================================
-- (B) No-show completo bajo sesión de sistema.
-- =============================================================================

\echo '=== 9. system_find_due_no_show_reservations: la sesion de sistema SI ve la candidata a no-show con sus 3 campos minimos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (count(*) filter (
    where out_reservation_id = '76000000-0000-0000-0000-0000000d0a02'
      and out_check_in_date = '2026-09-05' and out_check_out_date = '2026-09-08' and out_total_amount = 3000
  ))::int as ve_candidata_no_show_deberia_ser_1
  from hoteles.system_find_due_no_show_reservations('76000000-0000-0000-0000-0000000000a1', '2026-09-10');
rollback;

\echo '=== 10. system_apply_no_show: aplica no-show COMPLETO (transicion + liberacion de disponibilidad + folio + penalizacion YA CALCULADA) en una sola llamada, y un reintento (mismo cron 2 veces, o 2 instancias concurrentes) NUNCA vuelve a aplicarlo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_folio_id as primera_aplicacion_folio
  from hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a02', 1000, 160);
select count(*)::int as reintento_pierde_la_carrera_deberia_ser_0
  from hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a02', 1000, 160);
rollback;

\echo '=== 11. tras systemApplyNoShow, el folio de la reserva 2 tiene EXACTAMENTE 1 cargo de penalizacion (anti-doble-captura verificada contra la tabla real, no solo el booleano de retorno) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_folio_id
  from hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a02', 1000, 160);
reset role;
select count(*)::int as un_solo_cargo_de_penalizacion_deberia_ser_1
  from hoteles.charge c
  join hoteles.folio f on f.id = c.folio_id
  where f.reservation_id = '76000000-0000-0000-0000-0000000d0a02' and c.concept = 'hospedaje' and c.stay_date is null;
rollback;

\echo '=== 12. tras systemApplyNoShow, la reserva 2 SI queda en no_show (transicion real aplicada, no solo el retorno de la funcion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_folio_id
  from hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a02', 1000, 160);
reset role;
select (status = 'no_show')::int as reserva_queda_no_show_deberia_ser_1
  from hoteles.reservation where id = '76000000-0000-0000-0000-0000000d0a02';
rollback;

\echo '=== 13. bitacora: hoteles.reservation_status_event registra confirmada->no_show con actor_user_id NULL ("sistema") -- MISMO rastro que dejaria el camino de staff, sin bitacora nueva ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_folio_id
  from hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a02', 1000, 160);
reset role;
select (actor_user_id is null)::int as bitacora_actor_sistema_deberia_ser_1
  from hoteles.reservation_status_event
  where reservation_id = '76000000-0000-0000-0000-0000000d0a02' and from_status = 'confirmada' and to_status = 'no_show'
  order by created_at desc limit 1;
rollback;

\echo '=== 14. system_apply_no_show NUNCA aplica una reserva que pertenece a otra organizacion/property (silencioso, 0 filas -- MISMO criterio que transitionReservation: el caller decide, nunca lanza) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as cross_tenant_no_aplica_deberia_ser_0
  from hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000002', '76000000-0000-0000-0000-0000000000b1', '76000000-0000-0000-0000-0000000d0a05', 1000, 160);
rollback;

\echo '=== 15. tras el intento cross-tenant del escenario 14, la reserva 5 sigue "confirmada" (NUNCA tocada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)
  from hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000002', '76000000-0000-0000-0000-0000000000b1', '76000000-0000-0000-0000-0000000d0a05', 1000, 160);
reset role;
select (status = 'confirmada')::int as reserva_ajena_no_tocada_deberia_ser_1
  from hoteles.reservation where id = '76000000-0000-0000-0000-0000000d0a05';
rollback;

\echo '=== 16. system_apply_no_show rechaza un monto negativo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a05', -1, 0) as should_fail;
rollback;

-- =============================================================================
-- (D) Controles negativos: las 7 funciones nuevas son EXCLUSIVAS de sesión de
--     sistema -- un staff autenticado real (owner A, con acceso legítimo a esta
--     property por cualquier otra vía) NO puede invocarlas.
-- =============================================================================

\echo '=== 17. system_list_in_house_reservations_for_night_audit rechaza a un staff autenticado real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
select hoteles.system_list_in_house_reservations_for_night_audit('76000000-0000-0000-0000-0000000000a1', '2026-09-10') as should_fail;
rollback;

\echo '=== 18. system_load_tax_config rechaza a un staff autenticado real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
select hoteles.system_load_tax_config('76000000-0000-0000-0000-0000000000a1') as should_fail;
rollback;

\echo '=== 19. system_sum_charges_by_concept_for_business_date rechaza a un staff autenticado real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
select hoteles.system_sum_charges_by_concept_for_business_date('76000000-0000-0000-0000-0000000000a1', current_date, 'America/Mexico_City') as should_fail;
rollback;

\echo '=== 20. system_sum_payments_by_method_for_business_date rechaza a un staff autenticado real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
select hoteles.system_sum_payments_by_method_for_business_date('76000000-0000-0000-0000-0000000000a1', current_date, 'America/Mexico_City') as should_fail;
rollback;

\echo '=== 21. system_post_night_audit_charge rechaza a un staff autenticado real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
select hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-10', 1000, 190
  ) as should_fail;
rollback;

\echo '=== 22. system_find_due_no_show_reservations rechaza a un staff autenticado real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
select hoteles.system_find_due_no_show_reservations('76000000-0000-0000-0000-0000000000a1', '2026-09-10') as should_fail;
rollback;

\echo '=== 23. system_apply_no_show rechaza a un staff autenticado real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
select hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a02', 1000, 160) as should_fail;
rollback;

\echo '=== 24. system_post_night_audit_charge rechaza a anon (sin GRANT execute) ==='
begin;
set local role anon;
select hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-10', 1000, 190
  ) as should_fail;
rollback;

\echo '=== 25. system_apply_no_show rechaza a anon (sin GRANT execute) ==='
begin;
set local role anon;
select hoteles.system_apply_no_show('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000d0a02', 1000, 160) as should_fail;
rollback;

\echo '=== 26. system_list_in_house_reservations_for_night_audit rechaza a anon (sin GRANT execute) ==='
begin;
set local role anon;
select hoteles.system_list_in_house_reservations_for_night_audit('76000000-0000-0000-0000-0000000000a1', '2026-09-10') as should_fail;
rollback;

-- =============================================================================
-- (D cont.) Aislamiento cross-tenant, (E) control positivo del camino de staff, (F)
-- límite deliberado.
-- =============================================================================

\echo '=== 27. (control cross-tenant) staff real de la organizacion B NO ve el folio de la organizacion A (sin cambio -- ninguna policy de folio se toco) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_folio_deberia_ser_0
  from hoteles.folio where id = '76000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '=== 28. (control positivo) staff real de la organizacion A SIGUE pudiendo cobrar directo en su propio folio (front desk, camino YA existente, sin ningun cambio de esta migracion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept)
values ('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000e0a01', 'Cargo manual de control positivo', 100, 16, 'extras')
returning (id is not null)::int as staff_sigue_cobrando_directo_deberia_ser_1;
rollback;

\echo '=== 29. (limite deliberado) un SELECT directo contra hoteles.reservation bajo sesion de sistema SIGUE bloqueado -- esta migracion NUNCA abrio esa policy ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as select_reservation_sigue_bloqueado_deberia_ser_0
  from hoteles.reservation where id = '76000000-0000-0000-0000-0000000d0a01';
rollback;

\echo '=== 30. (limite deliberado) un INSERT directo contra hoteles.charge bajo sesion de sistema SIGUE bloqueado -- esta migracion NUNCA abrio esa policy ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept)
values ('76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1', '76000000-0000-0000-0000-0000000e0a01', 'Cargo directo bajo sesion de sistema', 100, 16, 'extras');
rollback;

-- =============================================================================
-- (G) Los totales del folio cuadran tras night-audit + un reverso.
-- =============================================================================

\echo '=== 31. tras postear el cargo de hospedaje por el camino de sistema, un reverso real (staff, hoteles.mark_charge_reversed -- sin cambio) deja el folio en NETO CERO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_id
  from hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-10', 1000, 190
  );
select set_config('request.jwt.claim.sub', '76000000-0000-0000-0000-0000000f0a01', true);
with original as (
  select id, organization_id, property_id, folio_id, amount, tax_amount
  from hoteles.charge
  where folio_id = '76000000-0000-0000-0000-0000000e0a01' and stay_date = '2026-09-10' and concept = 'hospedaje' and reversed_by is null
  limit 1
), reversal as (
  insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
  select organization_id, property_id, folio_id, 'Reverso de control final', -amount, -tax_amount, 'reverso', id
  from original
  returning id
)
select hoteles.mark_charge_reversed((select id from original), (select id from reversal));
select (sum(amount + tax_amount) = 0)::int as totales_del_folio_cuadran_tras_reverso_deberia_ser_1
  from hoteles.charge where folio_id = '76000000-0000-0000-0000-0000000e0a01' and concept in ('hospedaje', 'reverso');
rollback;

\echo '=== FIN — revisa arriba: los escenarios marcados should_fail/deberia_ser_N deben terminar en ERROR o el valor N indicado; el resto debe devolver filas/RETURNING reales. ==='
