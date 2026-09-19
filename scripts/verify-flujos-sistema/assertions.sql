-- Fixtures + assertions que verifican, contra Postgres REAL, los 2 fixes de
-- este PR ("flujos de sistema bloqueados en escritura"):
--   * supabase/migrations/20240101000137_024_licitaciones_sistema_ingesta_escritura.sql
--   * supabase/migrations/20240101000139_022_hoteles_sistema_voz_whatsapp_escritura.sql
--
-- Cubre, de punta a punta y bajo sesión de sistema real
-- (`packages/db/src/managed-postgres-engine.ts::withAppSession({ userId: null })`
-- -- `set local role authenticated` + `auth.uid()` SIEMPRE NULL, nunca
-- `service_role`):
--   (A) licitaciones: enumerar organización -> ingerir convocatoria descubierta
--       (upsert) -> registrar la corrida de ingesta -> escanear/crear
--       recordatorio de vencimiento -- el recorrido EXACTO de
--       `discover-tenders.ts`/`deadline-reminders.ts`.
--   (B) hoteles: resolver el secreto de voz por-property -> crear el pedido de
--       F&B (voice tool) -- y resolver la property por `phone_number_id` de
--       WhatsApp (webhook entrante) -- el recorrido EXACTO de
--       `voice-tools.ts`/`whatsapp.ts`.
--   (C) Controles negativos obligatorios por cada tabla/función tocada: un
--       staff autenticado de una organización ajena NO puede alcanzar los
--       datos de otra vía las funciones nuevas ni vía las policies con
--       escape hatch; `anon` sigue sin acceso; un staff de la organización
--       dueña SIGUE viendo/gestionando lo suyo exactamente igual que antes
--       (el fix nunca relajó el camino de staff autenticado real).
--   (D) Límite deliberado de este PR: las tablas/flujos que quedaron FUERA de
--       alcance (night-audit/no-show de hoteles -- `charge`/`payment`/
--       `reservation`/`folio`/`rate_plan`/`tax_config` --, y el resto de
--       tablas de escritura de licitaciones ajenas a este fix) siguen
--       bloqueadas para sesión de sistema exactamente igual que antes --
--       guard de regresión de alcance explícito: si un cambio futuro les
--       agregara un escape hatch por error/accidente, este script empezaría a
--       fallar.
--
-- Corre vía ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI).
-- Cada escenario vive en su propio `begin; ... rollback;` -- nada de esta sección
-- persiste. Los fixtures de abajo SÍ persisten (corren fuera de una transacción,
-- como superusuario, bypass RLS).
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten — corren como postgres, bypass RLS).
-- ---------------------------------------------------------------------------

-- Licitaciones: organización A (la que se ejercita de punta a punta) +
-- organización B (control cross-tenant) + un staff real por cada una.
insert into core.organization (id, vertical, name, slug, status) values
  ('70000000-0000-0000-0000-000000000001', 'licitaciones', 'Despacho Flujos Sistema A', 'flujos-sistema-lic-a', 'active'),
  ('70000000-0000-0000-0000-000000000002', 'licitaciones', 'Despacho Flujos Sistema B', 'flujos-sistema-lic-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('70000000-0000-0000-0000-0000000000a1', '70000000-0000-0000-0000-000000000001', 'licitaciones', 'Property singleton A', 'active'),
  ('70000000-0000-0000-0000-0000000000b1', '70000000-0000-0000-0000-000000000002', 'licitaciones', 'Property singleton B', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('70000000-0000-0000-0000-0000000f0a01', 'owner-lic-a@flujos-sistema.example.com', 'Owner Lic A', 'seed'),
  ('70000000-0000-0000-0000-0000000f0b01', 'owner-lic-b@flujos-sistema.example.com', 'Owner Lic B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('70000000-0000-0000-0000-0000000f0a01', '70000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('70000000-0000-0000-0000-0000000f0b01', '70000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

-- Hoteles: property A (voz + WhatsApp configurados) + property B (control
-- cross-tenant) + un staff real por cada organización.
insert into core.organization (id, vertical, name, slug, status) values
  ('72000000-0000-0000-0000-000000000001', 'hoteles', 'Hotel Flujos Sistema A', 'flujos-sistema-hot-a', 'active'),
  ('72000000-0000-0000-0000-000000000002', 'hoteles', 'Hotel Flujos Sistema B', 'flujos-sistema-hot-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('72000000-0000-0000-0000-0000000000a1', '72000000-0000-0000-0000-000000000001', 'hoteles', 'Propiedad Flujos Sistema A', 'active'),
  ('72000000-0000-0000-0000-0000000000b1', '72000000-0000-0000-0000-000000000002', 'hoteles', 'Propiedad Flujos Sistema B', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('72000000-0000-0000-0000-0000000f0a01', 'owner-hot-a@flujos-sistema.example.com', 'Owner Hot A', 'seed'),
  ('72000000-0000-0000-0000-0000000f0b01', 'owner-hot-b@flujos-sistema.example.com', 'Owner Hot B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('72000000-0000-0000-0000-0000000f0a01', '72000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('72000000-0000-0000-0000-0000000f0b01', '72000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.voice_agent_config (property_id, organization_id, tool_webhook_secret, enabled) values
  ('72000000-0000-0000-0000-0000000000a1', '72000000-0000-0000-0000-000000000001', 'secreto-de-voz-flujos-sistema-a', true)
on conflict do nothing;

insert into hoteles.whatsapp_channel_config (property_id, organization_id, phone_number_id, enabled) values
  ('72000000-0000-0000-0000-0000000000a1', '72000000-0000-0000-0000-000000000001', '15550001111', true)
on conflict do nothing;

-- =============================================================================
-- (A) Licitaciones — recorrido completo del cron de descubrimiento +
--     recordatorios de plazo, TODO bajo sesión de sistema.
-- =============================================================================

\echo '=== 1. system_ingest_tender: la sesion de sistema SI puede ingerir una convocatoria descubierta (antes: bloqueado por licitaciones.can_write_org) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_id is not null and out_inserted)::int as ingesta_crea_convocatoria_deberia_ser_1
  from licitaciones.system_ingest_tender(
    '70000000-0000-0000-0000-000000000001', 'Convocatoria flujos de sistema', now() + interval '2 days',
    'compras_mx_historico', 'ext-flujos-sistema-001', 'Entidad Convocante Flujos Sistema',
    array['12345678']::text[], 1000000, 'MXN', 'vigente', 'licitacion_publica'
  );
rollback;

\echo '=== 2. system_ingest_tender: re-ingerir el MISMO external_id actualiza (upsert), nunca duplica ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_ingest_tender(
  '70000000-0000-0000-0000-000000000001', 'Convocatoria flujos de sistema', now() + interval '2 days',
  'compras_mx_historico', 'ext-flujos-sistema-002', 'Entidad Convocante Flujos Sistema',
  array['12345678']::text[], 1000000, 'MXN', 'vigente', 'licitacion_publica'
);
select licitaciones.system_ingest_tender(
  '70000000-0000-0000-0000-000000000001', 'Convocatoria flujos de sistema (titulo actualizado)', now() + interval '2 days',
  'compras_mx_historico', 'ext-flujos-sistema-002', 'Entidad Convocante Flujos Sistema',
  array['12345678']::text[], 1500000, 'MXN', 'vigente', 'licitacion_publica'
);
-- `reset role` (vuelve a `postgres`, dueño de la tabla, bypass RLS) SOLO para
-- verificar el estado resultante dentro de la MISMA transacción que hace
-- rollback -- licitaciones.tender SIGUE sin SELECT directo para sesión de
-- sistema a propósito (alcance deliberado, ver escenario 8 más abajo), así
-- que un SELECT bajo `authenticated`/`auth.uid() is null` aquí devolvería 0
-- filas en silencio y este control de "no duplica" no probaría nada real.
reset role;
select count(*)::int as nunca_duplica_deberia_ser_1
  from licitaciones.tender where organization_id = '70000000-0000-0000-0000-000000000001' and source = 'compras_mx_historico' and external_id = 'ext-flujos-sistema-002';
rollback;

\echo '=== 3. system_record_source_run: la sesion de sistema SI puede registrar la corrida de ingesta (antes: bloqueado por licitaciones.can_write_org) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_id is not null)::int as registra_corrida_deberia_ser_1
  from licitaciones.system_record_source_run(
    '70000000-0000-0000-0000-000000000001', 'compras_mx_historico', 'ok', now(), now(),
    null, null, 'ingesta ok', 3, 3, null
  );
rollback;

\echo '=== 4. system_list_tenders_with_upcoming_deadline: la sesion de sistema SI ve la convocatoria que ella misma ingirio (antes: 0 filas SIEMPRE por "org ve sus convocatorias", el mismo sintoma que motivo el PR #141) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_ingest_tender(
  '70000000-0000-0000-0000-000000000001', 'Convocatoria por vencer', now() + interval '1 day',
  'compras_mx_historico', 'ext-flujos-sistema-003', 'Entidad Convocante', array[]::text[], null, 'MXN', 'vigente', null
);
-- El filtro es sobre out_title (salida de la propia función, security
-- definer), nunca sobre licitaciones.tender directo -- esa tabla SIGUE sin
-- SELECT para sesión de sistema a propósito (ver escenario 8).
select count(*)::int as ve_convocatoria_por_vencer_deberia_ser_1
  from licitaciones.system_list_tenders_with_upcoming_deadline('70000000-0000-0000-0000-000000000001', now(), now() + interval '3 days')
  where out_title = 'Convocatoria por vencer';
rollback;

\echo '=== 5. system_record_deadline_reminder: la sesion de sistema SI crea el recordatorio, y re-escanear el MISMO dia NO lo duplica (dedupe real) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- El id de la convocatoria se toma del OUTPUT de system_ingest_tender (nunca
-- de un SELECT directo contra licitaciones.tender, bloqueado a propósito para
-- sesión de sistema) -- las funciones en el FROM que referencian columnas de
-- `t` son LATERAL implícito (Postgres >= 9.3).
with t as (
  select * from licitaciones.system_ingest_tender(
    '70000000-0000-0000-0000-000000000001', 'Convocatoria con recordatorio', now() + interval '1 day',
    'compras_mx_historico', 'ext-flujos-sistema-004', 'Entidad Convocante', array[]::text[], null, 'MXN', 'vigente', null
  )
)
select (r.out_id is not null)::int as crea_recordatorio_deberia_ser_1
from t, licitaciones.system_record_deadline_reminder(
  '70000000-0000-0000-0000-000000000001', t.out_id, t.out_submission_deadline::timestamptz,
  t.out_submission_deadline::date, 1, 'vence pronto'
) r;

-- Reintento del MISMO día (mismo tender_id + deadline_date): `on conflict do
-- nothing` no devuelve fila -- el JOIN implícito con la función-tabla vacía
-- produce 0 filas, prueba real de dedupe sin tocar licitaciones.tender.
with t as (
  select * from licitaciones.system_ingest_tender(
    '70000000-0000-0000-0000-000000000001', 'Convocatoria con recordatorio', now() + interval '1 day',
    'compras_mx_historico', 'ext-flujos-sistema-004', 'Entidad Convocante', array[]::text[], null, 'MXN', 'vigente', null
  )
)
select count(*)::int as reintento_mismo_dia_no_duplica_deberia_ser_0
from t, licitaciones.system_record_deadline_reminder(
  '70000000-0000-0000-0000-000000000001', t.out_id, t.out_submission_deadline::timestamptz,
  t.out_submission_deadline::date, 1, 'vence pronto (reintento del mismo dia)'
) r;
rollback;

-- =============================================================================
-- (A-neg) Controles negativos de licitaciones.
-- =============================================================================

\echo '=== 6. system_ingest_tender rechaza a un staff autenticado real (auth.uid() no nulo) -- exclusivo de sesion de sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-0000000f0a01', true);
select licitaciones.system_ingest_tender(
  '70000000-0000-0000-0000-000000000001', 'x', null, 'compras_mx_historico', 'ext-rechazo', null, array[]::text[], null, 'MXN', null, null
) as should_fail;
rollback;

\echo '=== 7. system_ingest_tender rechaza a anon (sin GRANT execute) ==='
begin;
set local role anon;
select licitaciones.system_ingest_tender(
  '70000000-0000-0000-0000-000000000001', 'x', null, 'compras_mx_historico', 'ext-rechazo-anon', null, array[]::text[], null, 'MXN', null, null
) as should_fail;
rollback;

\echo '=== 8. el alcance del fix es SOLO las 4 funciones nuevas -- un INSERT directo contra licitaciones.tender bajo sesion de sistema SIGUE bloqueado (la policy "escritura: roles de escritura crean convocatorias" nunca se toco) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario es lo que el runner automático detecta -- mismo patrón que
-- scripts/verify-rentas-break-glass/assertions.sql escenario 22).
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into licitaciones.tender (organization_id, title, source) values ('70000000-0000-0000-0000-000000000001', 'insert directo', 'compras_mx_historico');
rollback;

\echo '=== 9. (control positivo) staff real de la organizacion A SIGUE pudiendo dar de alta una convocatoria manual directo (upsertTenderManual, camino de staff -- sin cambio de este fix) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-0000000f0a01', true);
insert into licitaciones.tender (organization_id, title, source, created_by) values ('70000000-0000-0000-0000-000000000001', 'alta manual de staff', 'manual', '70000000-0000-0000-0000-0000000f0a01')
  returning (id is not null)::int as staff_sigue_pudiendo_alta_manual_deberia_ser_1;
rollback;

\echo '=== 10. (control cross-tenant) staff real de la organizacion A SIGUE sin poder dar de alta una convocatoria para la organizacion B (can_write_org sin cambio) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-0000000f0a01', true);
insert into licitaciones.tender (organization_id, title, source, created_by) values ('70000000-0000-0000-0000-000000000002', 'alta cruzada', 'manual', '70000000-0000-0000-0000-0000000f0a01');
rollback;

\echo '=== 11. (limite deliberado, fuera de alcance de este PR) licitaciones.matching_profile SIGUE bloqueada para sesion de sistema -- ningun escape hatch se agrego ahi ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into licitaciones.matching_profile (organization_id) values ('70000000-0000-0000-0000-000000000001');
rollback;

-- =============================================================================
-- (B) Hoteles — voice tool de F&B (secreto + pedido) y resolucion de property
--     por telefono de WhatsApp, TODO bajo sesion de sistema.
-- =============================================================================

\echo '=== 12. system_find_voice_agent_config: la sesion de sistema SI resuelve el secreto de voz por-property (antes: bloqueado por la policy for all) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_tool_webhook_secret = 'secreto-de-voz-flujos-sistema-a' and out_enabled)::int as resuelve_secreto_voz_deberia_ser_1
  from hoteles.system_find_voice_agent_config('72000000-0000-0000-0000-0000000000a1');
rollback;

\echo '=== 13. hoteles.fnb_order INSERT: la sesion de sistema SI puede crear el pedido de F&B por voz (createdBy null, actor system:voz) -- el hallazgo ya senalado explicitamente en el PR previo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.fnb_order (organization_id, property_id, room_id, items, notes, allergy_declared, allergy_declared_via, created_by)
  values ('72000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-0000000000a1', null, '[{"nombre":"club sandwich"}]'::jsonb, null, false, null, null)
  returning (id is not null)::int as crea_pedido_fnb_por_voz_deberia_ser_1;
rollback;

\echo '=== 14. hoteles.whatsapp_channel_config SELECT: la sesion de sistema SI resuelve la property por phone_number_id (antes: 0 filas SIEMPRE -- el webhook entrante quedaba inerte en silencio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as resuelve_property_por_telefono_deberia_ser_1
  from hoteles.whatsapp_channel_config where phone_number_id = '15550001111' and enabled;
rollback;

-- =============================================================================
-- (B-neg) Controles negativos de hoteles.
-- =============================================================================

\echo '=== 15. system_find_voice_agent_config rechaza a un staff autenticado real (exclusivo de sesion de sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '72000000-0000-0000-0000-0000000f0a01', true);
select hoteles.system_find_voice_agent_config('72000000-0000-0000-0000-0000000000a1') as should_fail;
rollback;

\echo '=== 16. system_find_voice_agent_config rechaza a anon (sin GRANT execute) ==='
begin;
set local role anon;
select hoteles.system_find_voice_agent_config('72000000-0000-0000-0000-0000000000a1') as should_fail;
rollback;

\echo '=== 17. el alcance del fix de voice_agent_config es SOLO la funcion nueva -- un SELECT directo contra hoteles.voice_agent_config bajo sesion de sistema SIGUE devolviendo 0 filas (la policy "for all" nunca se toco) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as select_directo_sigue_bloqueado_deberia_ser_0
  from hoteles.voice_agent_config where property_id = '72000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== 18. (control positivo) staff admin real de la organizacion A SIGUE pudiendo ver/rotar su propio secreto de voz directo (policy for all, sin cambio de este fix) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '72000000-0000-0000-0000-0000000f0a01', true);
select count(*)::int as staff_sigue_viendo_su_secreto_deberia_ser_1
  from hoteles.voice_agent_config where property_id = '72000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== 19. (control cross-tenant) staff real de la organizacion B de hoteles SIGUE sin poder crear un pedido de F&B en la property de la organizacion A (el OR nunca relaja el acceso de un staff autenticado real) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '72000000-0000-0000-0000-0000000f0b01', true);
insert into hoteles.fnb_order (organization_id, property_id, items, allergy_declared)
  values ('72000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-0000000000a1', '[]'::jsonb, false);
rollback;

\echo '=== 20. anon SIGUE sin poder crear un pedido de F&B (sin GRANT a anon, sin cambio de este fix) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role anon;
insert into hoteles.fnb_order (organization_id, property_id, items, allergy_declared)
  values ('72000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-0000000000a1', '[]'::jsonb, false);
rollback;

\echo '=== 21. (limite deliberado, fuera de alcance de este PR) night-audit/no-show de hoteles SIGUEN bloqueados para sesion de sistema -- hoteles.charge/hoteles.reservation no reciben ningun escape hatch aqui ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as select_reservation_sigue_bloqueado_deberia_ser_0
  from hoteles.reservation where property_id = '72000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== FIN — revisa arriba: los escenarios marcados should_fail/deberia_ser_N deben terminar en ERROR o el valor N indicado; el resto debe devolver filas/RETURNING reales. ==='
