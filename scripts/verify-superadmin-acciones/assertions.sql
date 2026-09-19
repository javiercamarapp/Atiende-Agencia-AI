-- Fixtures + escenarios de autorización para
-- `packages/db/migrations/0016_superadmin_acciones.sql` (acciones sugeridas
-- con confirmación + dos automatizaciones) -- MISMO patrón EXACTO que
-- `scripts/verify-superadmin-resumen/assertions.sql`: cada escenario es su
-- propia transacción (`begin;`...`rollback;`, nunca persiste nada salvo los
-- fixtures de arriba), y el alias de la columna de verificación
-- (`deberia_ser_N`/`should_fail`) es lo que
-- `scripts/verify-real-postgres-ci/run-gate.mjs` usa para decidir pass/fail
-- automáticamente en CI.
--
-- Actores:
--   - staff-acciones-a: staff REAL (member normal), SIN autoridad de
--     superadmin.
--   - superadmin-acciones-1 / superadmin-acciones-2: dos superadmins REALES
--     distintos (para probar que uno no puede confirmar el intent del otro).
--   - org-acciones: organización real de vertical 'hoteles'.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000201', 'staff-acciones-a@example.com', 'Staff Acciones A', 'seed'),
  ('00000000-0000-0000-0000-000000000202', 'superadmin-acciones-1@example.com', 'Superadmin Acciones 1', 'seed'),
  ('00000000-0000-0000-0000-000000000203', 'superadmin-acciones-2@example.com', 'Superadmin Acciones 2', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-000000000202'),
  ('00000000-0000-0000-0000-000000000203')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug, created_at) values
  ('00000000-0000-0000-0000-000000000204', 'hoteles', 'Org Acciones', 'org-acciones', now() - interval '90 days'),
  ('00000000-0000-0000-0000-000000000205', 'citas', 'Org Acciones Citas', 'org-acciones-citas', now() - interval '90 days')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000204', null, 'member', 'staff')
on conflict do nothing;

-- Un prospecto real, en estado NO terminal, sin movimiento hace mucho --
-- candidato real para `_marcar_prospectos_sin_movimiento` y luego para
-- `cerrar_prospecto`.
insert into core.prospecto (id, empresa, vertical, estado, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000210', 'Prospecto Acciones Abandonado', 'hoteles', 'contactado', '2020-01-01T10:00:00Z', '2020-01-01T10:00:00Z')
on conflict do nothing;

-- ── Fixtures de messaging_outbox reales, cada uno probando un caso REAL del
--    criterio documentado en `core._desatascar_outbox_colgados` ──────────────

-- citas: 'processing' reclamada por WhatsApp (claimed_at viejo, attempts < 5)
-- -- SÍ debe desatascarse.
insert into citas.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, attempts, claimed_at, next_attempt_at) values
  ('00000000-0000-0000-0000-000000000220', '00000000-0000-0000-0000-000000000205', 'whatsapp', 'reminder', 'dedupe-220', '{"to":"+525599990000"}'::jsonb, 'processing', 1, now() - interval '2 hours', now() - interval '1 hour')
on conflict do nothing;

-- citas: 'processing' reclamada por email (claimed_at NULL) -- NUNCA se
-- toca, aunque lleve mucho tiempo así (created_at viejo), porque no hay
-- forma de saber desde cuándo con certeza.
insert into citas.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, attempts, claimed_at, created_at) values
  ('00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000205', 'email', 'reminder', 'dedupe-221', '{"to":"a@example.com"}'::jsonb, 'processing', 1, null, now() - interval '2 hours')
on conflict do nothing;

-- citas: 'processing' reclamada por WhatsApp pero YA agotó el tope de
-- intentos (attempts = 5) -- NUNCA se resucita.
insert into citas.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, attempts, claimed_at) values
  ('00000000-0000-0000-0000-000000000222', '00000000-0000-0000-0000-000000000205', 'whatsapp', 'reminder', 'dedupe-222', '{"to":"+525599990001"}'::jsonb, 'processing', 5, now() - interval '2 hours')
on conflict do nothing;

-- despachos: 'processing' reclamada hace mucho (created_at viejo) -- esta
-- vertical NO tiene `claimed_at`, así que NUNCA se toca pase lo que pase.
insert into despachos.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, attempts, created_at) values
  ('00000000-0000-0000-0000-000000000223', '00000000-0000-0000-0000-000000000204', 'email', 'reminder', 'dedupe-223', '{"to":"b@example.com"}'::jsonb, 'processing', 1, now() - interval '2 hours')
on conflict do nothing;

-- Property real de la organización de hoteles (requerida por
-- `hoteles.messaging_outbox.property_id`, `not null`).
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000204', 'Property Acciones')
on conflict do nothing;

-- hoteles: un mensaje 'dead' real, con un destinatario en el payload -- para
-- `reencolar_mensaje_muerto`.
insert into hoteles.messaging_outbox (id, property_id, organization_id, channel, event_type, dedupe_key, payload, status, attempts, last_error_class) values
  ('00000000-0000-0000-0000-000000000224', '00000000-0000-0000-0000-000000000225', '00000000-0000-0000-0000-000000000204', 'email', 'confirmacion', 'dedupe-224', '{"to":"huesped@example.com"}'::jsonb, 'dead', 5, 'permanent_failure')
on conflict do nothing;

-- ═══ core._desatascar_outbox_colgados / desatascar_outbox_colgados_for_system ═══

\echo '=== 1. desatascar_outbox_colgados_for_system: sesion de SISTEMA SI puede correr, mueve la fila reclamada por WhatsApp de citas (id 220) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select filas_movidas as deberia_ser_1 from core.desatascar_outbox_colgados_for_system(30) where queue_name = 'citas';
reset role;
select status as deberia_ser_pending from citas.messaging_outbox where id = '00000000-0000-0000-0000-000000000220';
rollback;

\echo '=== 2. desatascar_outbox_colgados_for_system: NUNCA mueve la fila reclamada por email (claimed_at null, id 221) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.desatascar_outbox_colgados_for_system(30);
reset role;
select status as deberia_ser_processing from citas.messaging_outbox where id = '00000000-0000-0000-0000-000000000221';
rollback;

\echo '=== 3. desatascar_outbox_colgados_for_system: NUNCA resucita una fila que ya agotó attempts (id 222, attempts=5) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.desatascar_outbox_colgados_for_system(30);
reset role;
select status as deberia_ser_processing from citas.messaging_outbox where id = '00000000-0000-0000-0000-000000000222';
rollback;

\echo '=== 4. desatascar_outbox_colgados_for_system: despachos/licitaciones reportan aplica=false, NUNCA tocan la fila vieja de despachos (id 223) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select aplica as deberia_ser_f from core.desatascar_outbox_colgados_for_system(30) where queue_name = 'despachos';
reset role;
select status as deberia_ser_processing from despachos.messaging_outbox where id = '00000000-0000-0000-0000-000000000223';
rollback;

\echo '=== 5. desatascar_outbox_colgados_for_system: es idempotente -- una segunda corrida inmediata ya no mueve nada de citas (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.desatascar_outbox_colgados_for_system(30);
select filas_movidas as deberia_ser_0 from core.desatascar_outbox_colgados_for_system(30) where queue_name = 'citas';
rollback;

\echo '=== 6. desatascar_outbox_colgados_for_system: una sesion REAL es RECHAZADA -- 42501, es funcion de solo-sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select * from core.desatascar_outbox_colgados_for_system(30) as should_fail;
rollback;

\echo '=== 7. desatascar_outbox_colgados_for_system: escribe en la bitacora (core.automation_action_log) por cada fila movida ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.desatascar_outbox_colgados_for_system(30);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select count(*) as deberia_ser_1 from core.list_automation_action_log_for_superadmin('00000000-0000-0000-0000-000000000202', 100);
rollback;

-- ═══ core._marcar_prospectos_sin_movimiento / marcar_prospectos_sin_movimiento_for_system ═══

\echo '=== 8. marcar_prospectos_sin_movimiento_for_system: marca el prospecto real sin movimiento ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select empresa as deberia_ser_prospecto_acciones_abandonado from core.marcar_prospectos_sin_movimiento_for_system(14);
reset role;
select (necesita_seguimiento_desde is not null) as deberia_ser_t from core.prospecto where id = '00000000-0000-0000-0000-000000000210';
rollback;

\echo '=== 9. marcar_prospectos_sin_movimiento_for_system: idempotente -- una segunda corrida no vuelve a marcarlo (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.marcar_prospectos_sin_movimiento_for_system(14);
select count(*) as deberia_ser_0 from core.marcar_prospectos_sin_movimiento_for_system(14);
rollback;

\echo '=== 10. marcar_prospectos_sin_movimiento_for_system: una sesion REAL es RECHAZADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select * from core.marcar_prospectos_sin_movimiento_for_system(14) as should_fail;
rollback;

\echo '=== 11. update_prospecto_for_superadmin: cualquier actualizacion real DESMARCA necesita_seguimiento_desde ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.marcar_prospectos_sin_movimiento_for_system(14);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select core.update_prospecto_for_superadmin('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000210', 'demo', null);
reset role;
select (necesita_seguimiento_desde is null) as deberia_ser_t from core.prospecto where id = '00000000-0000-0000-0000-000000000210';
rollback;

-- ═══ core.superadmin_action_intent -- catalogo cerrado ═══

\echo '=== 12. crear_superadmin_action_intent_for_superadmin: un tipo fuera del catalogo es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'ajustar_tope_gasto_llm', '{}'::jsonb, 'x', 5) as should_fail;
rollback;

\echo '=== 13. crear_superadmin_action_intent_for_superadmin: staff (no superadmin) pasando su PROPIO id es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000201', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 5) as should_fail;
rollback;

\echo '=== 14. crear_superadmin_action_intent_for_superadmin: staff pasando el UUID del superadmin (caller binding) obtiene NADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 5) as should_fail;
rollback;

\echo '=== 15. crear_superadmin_action_intent_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', '{}'::jsonb, 'x', 5) as should_fail;
rollback;

-- ═══ Flujo real: cerrar_prospecto ═══

\echo '=== 16. cerrar_prospecto: crear + confirmar de punta a punta -- el prospecto SI queda perdido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t16 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'Cerrar Prospecto Acciones Abandonado', 5);
select estado as deberia_ser_executed from core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t16));
reset role;
select estado as deberia_ser_perdido from core.prospecto where id = '00000000-0000-0000-0000-000000000210';
rollback;

\echo '=== 17. confirmar_superadmin_action_intent_for_superadmin: OTRO superadmin NO puede confirmar el intent ajeno -- devuelve el intent SIN ejecutar (estado sigue pending) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t17 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 5);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000203', (select intent_id from t17)) as should_fail;
rollback;

\echo '=== 18. confirmar_superadmin_action_intent_for_superadmin: staff de tenant pasando el UUID del superadmin no logra NADA -- 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t18 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 5);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t18)) as should_fail;
rollback;

\echo '=== 19. confirmar_superadmin_action_intent_for_superadmin: un intent VENCIDO no se puede confirmar -- queda expired, ejecuta CERO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t19 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 1);
reset role;
update core.superadmin_action_intent set vence_en = now() - interval '1 minute' where id = (select intent_id from t19);
set local role authenticated;
select estado as deberia_ser_expired from core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t19));
reset role;
select estado as deberia_ser_contactado from core.prospecto where id = '00000000-0000-0000-0000-000000000210';
rollback;

\echo '=== 20. confirmar_superadmin_action_intent_for_superadmin: una segunda confirmacion del MISMO intent ya ejecutado NO vuelve a ejecutar (el prospecto no cambia dos veces) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t20 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 5);
select core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t20));
select estado as deberia_ser_executed from core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t20));
rollback;

\echo '=== 21. cancelar_superadmin_action_intent_for_superadmin: el creador SI puede cancelar un intent pending; confirmarlo despues ya no ejecuta nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t21 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 5);
select estado as deberia_ser_cancelled from core.cancelar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t21));
reset role;
select estado as deberia_ser_contactado from core.prospecto where id = '00000000-0000-0000-0000-000000000210';
rollback;

-- ═══ Flujo real: reencolar_mensaje_muerto ═══

\echo '=== 22. reencolar_mensaje_muerto: crear + confirmar de punta a punta -- el mensaje muerto SI vuelve a pending ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t22 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'reencolar_mensaje_muerto', jsonb_build_object('queue', 'hoteles', 'mensajeId', '00000000-0000-0000-0000-000000000224'), 'Reencolar mensaje muerto de hoteles', 5);
select estado as deberia_ser_executed from core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t22));
reset role;
select status as deberia_ser_pending from hoteles.messaging_outbox where id = '00000000-0000-0000-0000-000000000224';
rollback;

\echo '=== 23. reencolar_mensaje_muerto: re-valida el estado actual -- si YA no esta dead al confirmar, ejecuta CERO (estado queda failed, con motivo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t23 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'reencolar_mensaje_muerto', jsonb_build_object('queue', 'hoteles', 'mensajeId', '00000000-0000-0000-0000-000000000224'), 'x', 5);
reset role;
update hoteles.messaging_outbox set status = 'sent' where id = '00000000-0000-0000-0000-000000000224';
set local role authenticated;
select estado as deberia_ser_failed from core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t23));
reset role;
select (error is not null) as deberia_ser_t from core.superadmin_action_intent where id = (select intent_id from t23);
rollback;

\echo '=== 24. get_outbox_dead_message_for_superadmin: SI ve el mensaje muerto real (incluido el payload) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select organization_name as deberia_ser_org_acciones from core.get_outbox_dead_message_for_superadmin('00000000-0000-0000-0000-000000000202', 'hoteles', '00000000-0000-0000-0000-000000000224');
rollback;

\echo '=== 25. list_outbox_mensajes_muertos_for_superadmin: staff (no superadmin) obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select count(*) as deberia_ser_0 from core.list_outbox_mensajes_muertos_for_superadmin('00000000-0000-0000-0000-000000000201', 20);
rollback;

-- ═══ Flujo real: ejecutar_mantenimiento_ahora ═══

\echo '=== 26. ejecutar_mantenimiento_ahora: confirmarlo corre las DOS automatizaciones reales (misma corrida que el cron) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t26 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'ejecutar_mantenimiento_ahora', '{}'::jsonb, 'Ejecutar mantenimiento ahora', 5);
select estado as deberia_ser_executed from core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t26));
reset role;
select status as deberia_ser_pending from citas.messaging_outbox where id = '00000000-0000-0000-0000-000000000220';
select (necesita_seguimiento_desde is not null) as deberia_ser_t from core.prospecto where id = '00000000-0000-0000-0000-000000000210';
rollback;

-- ═══ Bitácora del intent visible a CUALQUIER superadmin (equipo, no buzón privado) ═══

\echo '=== 27. list_superadmin_action_intents_for_superadmin: OTRO superadmin (no el creador) SI ve el intent en la bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'Intent de bitacora visible', 5);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select resumen as deberia_ser_intent_de_bitacora_visible from core.list_superadmin_action_intents_for_superadmin('00000000-0000-0000-0000-000000000203', 50) where resumen = 'Intent de bitacora visible';
rollback;

\echo '=== 28. list_superadmin_action_intents_for_superadmin: staff (no superadmin) obtiene CERO filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
select count(*) as deberia_ser_0 from core.list_superadmin_action_intents_for_superadmin('00000000-0000-0000-0000-000000000201', 50);
rollback;

\echo '=== 29. list_superadmin_action_intents_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_superadmin_action_intents_for_superadmin('00000000-0000-0000-0000-000000000202', 50) as should_fail;
rollback;

\echo '=== 30. list_automation_action_log_for_superadmin: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core.list_automation_action_log_for_superadmin('00000000-0000-0000-0000-000000000202', 50) as should_fail;
rollback;

-- ═══ Blindaje de las 3 funciones INTERNAS (`core._desatascar_outbox_colgados`/
--    `core._marcar_prospectos_sin_movimiento`/`core._reencolar_mensaje_muerto`)
--    -- dos capas independientes, probadas por separado: (capa 1) REVOKE
--    explícito de anon/authenticated/service_role -- ninguna de las dos
--    debería poder ni EJECUTAR la función (permission denied); (capa 2) el
--    guard de CONTEXTO dentro de cada función -- probado corriendo SIN
--    `set local role` (la sesión por defecto de este script es el dueño
--    real de la función, que retiene EXECUTE implícito pase lo que pase con
--    el REVOKE de arriba -- exactamente el escenario "¿y si el REVOKE
--    fallara o se revirtiera?" que motivó este blindaje) con un
--    `auth.uid()` real pero SIN ningún intent legítimo confirmándose -- el
--    guard interno debe rechazarla igual, DEMOSTRANDO que la capa 2 no
--    depende en absoluto de la capa 1. ═══

\echo '=== 31. _desatascar_outbox_colgados: sesion authenticated (superadmin real) NO puede ejecutarla directo -- permission denied (capa 1: revoke) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select * from core._desatascar_outbox_colgados(30) as should_fail;
rollback;

\echo '=== 32. _desatascar_outbox_colgados: sesion authenticated SIN auth.uid() (simulando sistema) tampoco puede ejecutarla directo -- permission denied (capa 1: revoke) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core._desatascar_outbox_colgados(30) as should_fail;
rollback;

\echo '=== 33. _desatascar_outbox_colgados: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core._desatascar_outbox_colgados(30) as should_fail;
rollback;

\echo '=== 34. _desatascar_outbox_colgados: AUNQUE tuviera EXECUTE (sesion sin cambio de rol, dueño real), un superadmin SIN un intent ejecutar_mantenimiento_ahora confirmandose es RECHAZADO por el guard interno (capa 2, independiente del revoke) ==='
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select * from core._desatascar_outbox_colgados(30) as should_fail;
rollback;

\echo '=== 35. _marcar_prospectos_sin_movimiento: sesion authenticated (superadmin real) NO puede ejecutarla directo -- permission denied (capa 1: revoke) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select * from core._marcar_prospectos_sin_movimiento(14) as should_fail;
rollback;

\echo '=== 36. _marcar_prospectos_sin_movimiento: sesion authenticated SIN auth.uid() tampoco puede ejecutarla directo -- permission denied (capa 1: revoke) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core._marcar_prospectos_sin_movimiento(14) as should_fail;
rollback;

\echo '=== 37. _marcar_prospectos_sin_movimiento: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select * from core._marcar_prospectos_sin_movimiento(14) as should_fail;
rollback;

\echo '=== 38. _marcar_prospectos_sin_movimiento: AUNQUE tuviera EXECUTE, un superadmin SIN un intent ejecutar_mantenimiento_ahora confirmandose es RECHAZADO por el guard interno (capa 2) ==='
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select * from core._marcar_prospectos_sin_movimiento(14) as should_fail;
rollback;

\echo '=== 39. _reencolar_mensaje_muerto: sesion authenticated (superadmin real) NO puede ejecutarla directo -- permission denied (capa 1: revoke) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select core._reencolar_mensaje_muerto('00000000-0000-0000-0000-000000000000'::uuid, 'hoteles', '00000000-0000-0000-0000-000000000224') as should_fail;
rollback;

\echo '=== 40. _reencolar_mensaje_muerto: sesion authenticated SIN auth.uid() (simulando sistema) tampoco puede ejecutarla directo -- permission denied (capa 1: revoke) -- NUNCA hay un caso legitimo de sistema para esta funcion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core._reencolar_mensaje_muerto('00000000-0000-0000-0000-000000000000'::uuid, 'hoteles', '00000000-0000-0000-0000-000000000224') as should_fail;
rollback;

\echo '=== 41. _reencolar_mensaje_muerto: anon no puede ni ejecutar la funcion ==='
begin;
set local role anon;
select core._reencolar_mensaje_muerto('00000000-0000-0000-0000-000000000000'::uuid, 'hoteles', '00000000-0000-0000-0000-000000000224') as should_fail;
rollback;

\echo '=== 42. _reencolar_mensaje_muerto: AUNQUE tuviera EXECUTE, un superadmin real SIN un intent reencolar_mensaje_muerto confirmandose (id inventado) es RECHAZADO por el guard interno (capa 2) -- nunca reencola nada (el ROLLBACK del propio bloque ya garantiza que el mensaje no cambió, no hace falta un SELECT de verificación después del error: un statement DESPUÉS de uno fallido en la misma transacción solo vería "current transaction is aborted") ==='
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select core._reencolar_mensaje_muerto('00000000-0000-0000-0000-000000000000'::uuid, 'hoteles', '00000000-0000-0000-0000-000000000224') as should_fail;
rollback;

\echo '=== 43. _reencolar_mensaje_muerto: sesion de SISTEMA (auth.uid() null), sin cambiar de rol (capa 2), es RECHAZADA SIEMPRE -- creado_por nunca puede ser igual a un auth.uid() nulo, esta funcion NUNCA tiene un caso legitimo de sistema ==='
begin;
select set_config('request.jwt.claim.sub', '', true);
select core._reencolar_mensaje_muerto('00000000-0000-0000-0000-000000000000'::uuid, 'hoteles', '00000000-0000-0000-0000-000000000224') as should_fail;
rollback;

\echo '=== 44. _reencolar_mensaje_muerto: un intent REAL, confirmado y YA ejecutado (estado != pending) NO puede reutilizarse para una segunda llamada directa al helper -- el mensaje sigue igual ==='
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t44 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'reencolar_mensaje_muerto', jsonb_build_object('queue', 'hoteles', 'mensajeId', '00000000-0000-0000-0000-000000000224'), 'x', 5);
select core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t44));
select core._reencolar_mensaje_muerto((select intent_id from t44), 'hoteles', '00000000-0000-0000-0000-000000000224') as should_fail;
rollback;

-- ═══ cerrar_prospecto: re-validación del estado ACTUAL del prospecto antes de
--    ejecutar (`packages/db/migrations/0019_cerrar_prospecto_revalida_estado.sql`,
--    corrige el lost-update: ANTES de esta migración, esta rama era la ÚNICA de
--    las tres que nunca revisaba de nuevo el mundo real antes de escribir). `now()`
--    es constante dentro de una misma transacción en Postgres, así que estos
--    escenarios usan el mismo truco de `update ... set creado_en = now() -
--    interval ...` que el escenario 19 (intent vencido) en vez de esperar reloj
--    real. ═══

-- NOTA sobre el patrón de aserción de 45-48: el gate de CI
-- (`scripts/verify-real-postgres-ci/run-gate.mjs`, `deriveExpectation`) solo
-- reconoce `as should_fail`, `deberia_ser_<DIGITOS>` (numérico) o
-- `deberia_fallar` -- CUALQUIER OTRO alias (`deberia_ser_executed`,
-- `deberia_ser_demo`, etc.) no matchea nada y el escenario cae en kind
-- "success" = el gate solo comprueba que NO hubo excepción, sin mirar el
-- valor. Además el gate corta el bloque en la PRIMERA aparición de
-- `deberia_ser_<DIGITOS>` y descarta todo lo que viene después -- por eso
-- cada escenario termina en UN SOLO `select count(*) ... as
-- <descripcion>_deberia_ser_N` que combina TODAS las condiciones que hacen
-- al escenario válido (estado del intent, `error`, estado del prospecto) en
-- una sola fila, y ningún alias `deberia_ser_<digitos>` aparece antes de ese
-- select final dentro del mismo bloque.
\echo '=== 45. cerrar_prospecto: camino feliz SIN cambios en el prospecto -- sigue ejecutando normal tras el fix (regresión) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t45 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 5);
select core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t45));
reset role;
select count(*) as intent_executed_y_prospecto_perdido_deberia_ser_1 from core.superadmin_action_intent i join core.prospecto p on p.id = '00000000-0000-0000-0000-000000000210' where i.id = (select intent_id from t45) and i.estado = 'executed' and p.estado = 'perdido';
rollback;

\echo '=== 46. cerrar_prospecto: el prospecto fue MODIFICADO por OTRO superadmin despues de crear el intent -- confirmacion RECHAZADA (failed con motivo), el estado nuevo NO se pisa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t46 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'perdido'), 'x', 5);
reset role;
-- Retrocede `creado_en` del intent (mismo truco que el escenario 19) -- simula
-- que pasaron varios minutos desde que se creó, sin depender del reloj real.
update core.superadmin_action_intent set creado_en = now() - interval '10 minutes' where id = (select intent_id from t46);
-- Otro superadmin edita el MISMO prospecto por el editor normal mientras el
-- primer intent seguía pendiente de confirmar.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000203', true);
select core.update_prospecto_for_superadmin('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000210', 'demo', 'editado por otro superadmin');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t46));
reset role;
select count(*) as intent_failed_con_error_y_prospecto_intacto_deberia_ser_1 from core.superadmin_action_intent i join core.prospecto p on p.id = '00000000-0000-0000-0000-000000000210' where i.id = (select intent_id from t46) and i.estado = 'failed' and i.error is not null and p.estado = 'demo';
rollback;

\echo '=== 47. cerrar_prospecto: el prospecto YA esta en un estado terminal cuando se confirma -- confirmacion RECHAZADA (failed con motivo), no se re-ejecuta encima ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t47 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000210', 'estado', 'descartado'), 'x', 5);
-- El prospecto ya se cerro por otro camino ANTES de que el creador del intent
-- llegara a confirmarlo.
select core.update_prospecto_for_superadmin('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000210', 'perdido', null);
select core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t47));
reset role;
select count(*) as intent_failed_con_error_y_prospecto_intacto_deberia_ser_1 from core.superadmin_action_intent i join core.prospecto p on p.id = '00000000-0000-0000-0000-000000000210' where i.id = (select intent_id from t47) and i.estado = 'failed' and i.error is not null and p.estado = 'perdido';
rollback;

\echo '=== 48. cerrar_prospecto: el prospecto YA NO EXISTE cuando se confirma -- confirmacion RECHAZADA (failed con motivo), tercera rama de la re-validacion (ninguno de 45-47 la cubre) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000202', true);
select id as intent_id into temp t48 from core.crear_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', 'cerrar_prospecto', jsonb_build_object('prospectoId', '00000000-0000-0000-0000-000000000299', 'estado', 'perdido'), 'x', 5);
select core.confirmar_superadmin_action_intent_for_superadmin('00000000-0000-0000-0000-000000000202', (select intent_id from t48));
reset role;
select count(*) as intent_failed_con_error_deberia_ser_1 from core.superadmin_action_intent where id = (select intent_id from t48) and estado = 'failed' and error is not null;
rollback;
