-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0036_plataforma_arco_retencion_aviso.sql (privacidad de plataforma):
--
--   A) Vista ARCO por organizacion (core.org_list_arco_requests): solo owner/admin, aislada por
--      organizacion, sin datos del titular, plazos y estados normalizados de citas, restaurantes
--      y hoteles.
--   B) Vista ARCO de plataforma (core.platform_list_arco_requests, platform_privacy_overview):
--      solo superadmin real y no restringido.
--   C) Politicas de retencion por organizacion con rangos por clase y precedencia
--      organizacion > vertical > defecto.
--   D) Bloqueo previo a purga (retencion legal): alta, baja, aislamiento entre organizaciones.
--   E) Purga (core.system_run_retention_purge): solo sistema, simulacion sin efectos, respeto del
--      bloqueo y de las solicitudes ARCO abiertas, aislamiento por organizacion, registro sin PII
--      y registro append-only.
--   F) Aviso de privacidad versionado y su aceptacion.
--   G) Superficie: tablas sin acceso directo, funciones internas sin EXECUTE, definer con
--      search_path fijo, anon sin EXECUTE.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; el alias de columna que termina en should_fail marca un escenario que debe
-- terminar en ERROR; un alias que termina en deberia_ser_N exige que la ultima fila valga N.
-- Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes', 'Privacidad Org A', 'org-privacidad-a', 'active'),
  ('00000000-0000-0000-0000-0000000f5b00', 'restaurantes', 'Privacidad Org B', 'org-privacidad-b', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000f5a10', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes', 'Sucursal A')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f5a01', 'owner-priv-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f5a02', 'admin-priv-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000f5a03', 'member-priv-a@example.com', 'Member A', 'seed'),
  ('00000000-0000-0000-0000-0000000f5b01', 'owner-priv-b@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000f5c00', 'sa-priv@example.com', 'Superadmin Privacidad', 'seed'),
  ('00000000-0000-0000-0000-0000000f5c01', 'sa-finanzas-priv@example.com', 'Superadmin Finanzas', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f5c00'), ('00000000-0000-0000-0000-0000000f5c01') on conflict do nothing;
insert into core.cfo_zone_role (staff_user_id, rol, reason) values ('00000000-0000-0000-0000-0000000f5c01', 'finanzas', 'Rol restringido de prueba para la verificacion');
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5a00', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5a00', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000f5a03', '00000000-0000-0000-0000-0000000f5a00', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f5b01', '00000000-0000-0000-0000-0000000f5b00', null, 'owner', 'owner')
on conflict do nothing;

-- Solicitudes ARCO de la organizacion A: citas (1, vencida), restaurantes (3: en proceso a tiempo,
-- pendiente de confirmar, recibida del telefono ...002 que protege su conversacion) y hoteles (2:
-- una vencida y una a tiempo). Organizacion B: una de citas.
insert into citas.data_rights_requests (organization_id, customer_phone, right_type, channel, status, confirmed_at, response_due_at, execution_due_at) values
  ('00000000-0000-0000-0000-0000000f5a00', '+521555000901', 'acceso', 'whatsapp', 'recibida', now() - interval '30 days', now() - interval '10 days', now() + interval '5 days'),
  ('00000000-0000-0000-0000-0000000f5b00', '+521555000902', 'acceso', 'whatsapp', 'recibida', now(), now() + interval '20 days', now() + interval '35 days');
insert into restaurantes.data_rights_requests (organization_id, customer_phone, right_type, channel, status, confirmed_at, response_due_at, execution_due_at) values
  ('00000000-0000-0000-0000-0000000f5a00', '+521555000001', 'acceso', 'whatsapp', 'en_proceso', now() - interval '3 days', now() + interval '17 days', now() + interval '32 days'),
  ('00000000-0000-0000-0000-0000000f5a00', '+521555000003', 'oposicion', 'whatsapp', 'pendiente_confirmacion', null, null, null),
  ('00000000-0000-0000-0000-0000000f5a00', '+521555000002', 'cancelacion', 'whatsapp', 'recibida', now(), now() + interval '20 days', now() + interval '35 days');
insert into hoteles.arco_request (organization_id, property_id, folio, right_type, requester_name, channel, received_on, response_due_on) values
  ('00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a10', 'ARCO-VENCIDA', 'acceso', 'Titular Uno', 'correo', current_date - 40, current_date - 20),
  ('00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a10', 'ARCO-ATIEMPO', 'rectificacion', 'Titular Dos', 'web', current_date, current_date + 20);

-- Datos retenibles de restaurantes (organizacion A). Conversaciones: telefono ...004 vieja y sin
-- solicitud (se vacia); ...002 vieja pero con una solicitud ARCO recibida (protegida); ...003
-- reciente. Organizacion B: una vieja que una purga de A nunca debe tocar. Llamadas: la vieja se
-- purga, la reciente no, y la del titular con ARCO abierta (hash de ...002) queda protegida.
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages, updated_at) values
  ('00000000-0000-0000-0000-0000000f5a00', '+521555000004', '[{"role":"user","text":"hola"}]'::jsonb, now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000f5a00', '+521555000002', '[{"role":"user","text":"hola"}]'::jsonb, now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000f5a00', '+521555000003', '[{"role":"user","text":"hola"}]'::jsonb, now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000f5b00', '+521555000004', '[{"role":"user","text":"hola"}]'::jsonb, now() - interval '400 days');
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values
  ('00000000-0000-0000-0000-0000000f5a31', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a10', 'call-vieja', 'llamada', 'gemini-3.8-live', repeat('a', 64), now() - interval '60 days', now() - interval '60 days'),
  ('00000000-0000-0000-0000-0000000f5a32', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a10', 'call-reciente', 'llamada', 'gemini-3.8-live', repeat('b', 64), now() - interval '1 day', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5a33', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a10', 'call-protegida', 'llamada', 'gemini-3.8-live', encode(sha256(convert_to('521555000002', 'UTF8')), 'hex'), now() - interval '60 days', now() - interval '60 days');
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values
  ('00000000-0000-0000-0000-0000000f5a31', '00000000-0000-0000-0000-0000000f5a00', 0, 'cliente', 'turno uno'),
  ('00000000-0000-0000-0000-0000000f5a31', '00000000-0000-0000-0000-0000000f5a00', 1, 'agente', 'turno dos'),
  ('00000000-0000-0000-0000-0000000f5a33', '00000000-0000-0000-0000-0000000f5a00', 0, 'cliente', 'turno protegido');

-- ═══ A) Vista ARCO por organizacion ═══
\echo 'A1. owner A lista todas las solicitudes de su organizacion (6 = 1 citas + 3 restaurantes + 2 hoteles)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as a1_deberia_ser_6 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 50, 0);
rollback;

\echo 'A2. solo abiertas: la pendiente de confirmar no cuenta (5)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as a2_deberia_ser_5 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', true, 50, 0);
rollback;

\echo 'A3. admin A tambien ve las 6'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a02', true);
select count(*)::int as a3_deberia_ser_6 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 50, 0);
rollback;

\echo 'A4. member A (no owner/admin) no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a03', true);
select count(*)::int as a4_deberia_ser_0 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 50, 0);
rollback;

\echo 'A5. cross-tenant: owner B pidiendo la organizacion A no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select count(*)::int as a5_deberia_ser_0 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 50, 0);
rollback;

\echo 'A6. owner B ve solo lo suyo (1)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select count(*)::int as a6_deberia_ser_1 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5b00', false, 50, 0);
rollback;

\echo 'A7. anon no tiene EXECUTE'
begin;
set local role anon;
select core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 50, 0) as should_fail;
rollback;

\echo 'A8. sesion de sistema (sin usuario) no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as a8_deberia_ser_0 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 50, 0);
rollback;

\echo 'A9. vencidas marcadas: citas y hoteles (2)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as a9_deberia_ser_2 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 50, 0) where out_is_overdue;
rollback;

\echo 'A10. la salida NO trae telefono, contacto ni nombre del titular'
begin;
select count(*)::int as a10_deberia_ser_0 from information_schema.parameters where specific_schema = 'core' and specific_name like 'org_list_arco_requests%' and parameter_name ~ '(phone|contact|requester|name|detail|folio)';
rollback;

\echo 'A11. paginacion: limit 2 devuelve 2 filas pero el total sigue siendo 6'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select (count(*) = 2 and max(out_total) = 6)::int as a11_deberia_ser_1 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 2, 0);
rollback;

\echo 'A12. estados normalizados: la solicitud pendiente de confirmar queda como por_confirmar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as a12_deberia_ser_1 from core.org_list_arco_requests('00000000-0000-0000-0000-0000000f5a00', false, 50, 0) where out_status_bucket = 'por_confirmar' and out_native_status = 'pendiente_confirmacion';
rollback;

-- ═══ B) Vista de plataforma ═══
\echo 'B1. superadmin ve las 7 solicitudes de todas las organizaciones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c00', true);
select count(*)::int as b1_deberia_ser_7 from core.platform_list_arco_requests('00000000-0000-0000-0000-0000000f5c00', false, false, 50, 0);
rollback;

\echo 'B2. solo vencidas (2)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c00', true);
select count(*)::int as b2_deberia_ser_2 from core.platform_list_arco_requests('00000000-0000-0000-0000-0000000f5c00', false, true, 50, 0);
rollback;

\echo 'B3. owner A (no superadmin) no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as b3_deberia_ser_0 from core.platform_list_arco_requests('00000000-0000-0000-0000-0000000f5a01', false, false, 50, 0);
rollback;

\echo 'B4. superadmin restringido a finanzas no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c01', true);
select count(*)::int as b4_deberia_ser_0 from core.platform_list_arco_requests('00000000-0000-0000-0000-0000000f5c01', false, false, 50, 0);
rollback;

\echo 'B5. caller-binding: p_caller_id de un superadmin con otra sesion no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as b5_deberia_ser_0 from core.platform_list_arco_requests('00000000-0000-0000-0000-0000000f5c00', false, false, 50, 0);
rollback;

\echo 'B6. sesion de sistema no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as b6_deberia_ser_0 from core.platform_list_arco_requests('00000000-0000-0000-0000-0000000f5c00', false, false, 50, 0);
rollback;

\echo 'B7. anon no tiene EXECUTE'
begin;
set local role anon;
select core.platform_list_arco_requests('00000000-0000-0000-0000-0000000f5c00', false, false, 50, 0) as should_fail;
rollback;

\echo 'B8. resumen: la organizacion A tiene 5 abiertas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c00', true);
select out_open_arco::int as b8_deberia_ser_5 from core.platform_privacy_overview('00000000-0000-0000-0000-0000000f5c00', 50, 0) where out_organization_id = '00000000-0000-0000-0000-0000000f5a00';
rollback;

\echo 'B9. resumen: la organizacion A tiene 2 vencidas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c00', true);
select out_overdue_arco::int as b9_deberia_ser_2 from core.platform_privacy_overview('00000000-0000-0000-0000-0000000f5c00', 50, 0) where out_organization_id = '00000000-0000-0000-0000-0000000f5a00';
rollback;

\echo 'B10. resumen: un owner no lo ve'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as b10_deberia_ser_0 from core.platform_privacy_overview('00000000-0000-0000-0000-0000000f5a01', 50, 0);
rollback;

\echo 'B11. bitacora de purgas de plataforma: un owner no la ve'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as b11_deberia_ser_0 from core.platform_list_purge_runs('00000000-0000-0000-0000-0000000f5a01', 50, null);
rollback;

\echo 'B12. resumen: el finanzas restringido no lo ve'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c01', true);
select count(*)::int as b12_deberia_ser_0 from core.platform_privacy_overview('00000000-0000-0000-0000-0000000f5c01', 50, 0);
rollback;

-- ═══ C) Retencion por organizacion ═══
\echo 'C1. owner A ve las 6 clases del catalogo (3 de PL-13 + 2 de rentas, migracion rentas 028 + hoteles_whatsapp_conversaciones, migracion hoteles 046)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as c1_deberia_ser_6 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo 'C2. sin politica ni config de vertical rige el defecto documentado (180 dias)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select (out_effective_days = 180 and out_source = 'defecto')::int as c2_deberia_ser_1 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000f5a00') where out_data_class = 'restaurantes_whatsapp_conversaciones';
rollback;

\echo 'C3. owner A fija 90 dias: queda como politica de la organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 90);
select (out_effective_days = 90 and out_source = 'organizacion')::int as c3_deberia_ser_1 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000f5a00') where out_data_class = 'restaurantes_whatsapp_conversaciones';
rollback;

\echo 'C4. por debajo del minimo de la clase (30) es RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 10) as should_fail;
rollback;

\echo 'C5. por encima del maximo de la clase (1095) es RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 2000) as should_fail;
rollback;

\echo 'C6. una clase que gobierna el vertical no admite politica de plataforma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'hoteles_identidad_documento', 30) as should_fail;
rollback;

\echo 'C7. clase desconocida es RECHAZADA'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'no_existe', 30) as should_fail;
rollback;

\echo 'C8. member A no fija politicas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a03', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 90) as should_fail;
rollback;

\echo 'C9. cross-tenant: owner B no fija politicas de la organizacion A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 90) as should_fail;
rollback;

\echo 'C10. anon no tiene EXECUTE'
begin;
set local role anon;
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 90) as should_fail;
rollback;

\echo 'C11. la config del vertical (restaurantes.privacy_config) se respeta como valor intermedio'
begin;
insert into restaurantes.privacy_config (organization_id, conversation_retention_days) values ('00000000-0000-0000-0000-0000000f5a00', 365);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select (out_effective_days = 365 and out_source = 'vertical')::int as c11_deberia_ser_1 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000f5a00') where out_data_class = 'restaurantes_whatsapp_conversaciones';
rollback;

\echo 'C12. la politica de la organizacion gana a la config del vertical'
begin;
insert into restaurantes.privacy_config (organization_id, conversation_retention_days) values ('00000000-0000-0000-0000-0000000f5a00', 365);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 60);
select (out_effective_days = 60 and out_source = 'organizacion')::int as c12_deberia_ser_1 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000f5a00') where out_data_class = 'restaurantes_whatsapp_conversaciones';
rollback;

\echo 'C13. quitar la politica vuelve al defecto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 90);
select core.org_clear_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones');
select (out_effective_days = 180 and out_source = 'defecto')::int as c13_deberia_ser_1 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000f5a00') where out_data_class = 'restaurantes_whatsapp_conversaciones';
rollback;

\echo 'C14. voz admite 0 dias (no conservar transcripcion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_set_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_voz_transcripciones', 0);
select (out_effective_days = 0)::int as c14_deberia_ser_1 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000f5a00') where out_data_class = 'restaurantes_voz_transcripciones';
rollback;

\echo 'C15. member A no ve las politicas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a03', true);
select count(*)::int as c15_deberia_ser_0 from core.org_list_retention_policies('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo 'C16. quitar la politica sin ser owner/admin es RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a03', true);
select core.org_clear_retention_policy('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones') as should_fail;
rollback;

-- ═══ D) Bloqueo previo a purga ═══
\echo 'D1. owner A coloca un bloqueo y queda activo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_place_purge_hold('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Investigacion en curso por solicitud de autoridad');
select count(*)::int as d1_deberia_ser_1 from core.org_list_purge_holds('00000000-0000-0000-0000-0000000f5a00') where out_active;
rollback;

\echo 'D2. un segundo bloqueo activo para la misma clase es RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_place_purge_hold('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Investigacion en curso por solicitud de autoridad');
select core.org_place_purge_hold('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Otro motivo suficientemente largo') as should_fail;
rollback;

\echo 'D3. member A no coloca bloqueos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a03', true);
select core.org_place_purge_hold('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Investigacion en curso por solicitud de autoridad') as should_fail;
rollback;

\echo 'D4. motivo demasiado corto es RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_place_purge_hold('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'corto') as should_fail;
rollback;

\echo 'D5. cross-tenant: owner B no coloca bloqueos en la organizacion A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select core.org_place_purge_hold('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Investigacion en curso por solicitud de autoridad') as should_fail;
rollback;

\echo 'D6. cross-tenant: owner B no libera el bloqueo de la organizacion A (usando SU organizacion)'
begin;
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a20', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select core.org_release_purge_hold('00000000-0000-0000-0000-0000000f5b00', '00000000-0000-0000-0000-0000000f5a20', null)::int as d6_deberia_ser_0;
rollback;

\echo 'D7. cross-tenant: owner B no libera el bloqueo declarando la organizacion A'
begin;
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a20', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select core.org_release_purge_hold('00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a20', null) as should_fail;
rollback;

\echo 'D8. owner A libera su bloqueo'
begin;
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a20', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_release_purge_hold('00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a20', 'Caso cerrado')::int as d8_deberia_ser_1;
rollback;

\echo 'D9. liberar dos veces: la segunda no encuentra bloqueo activo'
begin;
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a20', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_release_purge_hold('00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a20', 'Caso cerrado');
select core.org_release_purge_hold('00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a20', 'Otra vez')::int as d9_deberia_ser_0;
rollback;

\echo 'D10. member A no ve los bloqueos'
begin;
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a20', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a03', true);
select count(*)::int as d10_deberia_ser_0 from core.org_list_purge_holds('00000000-0000-0000-0000-0000000f5a00');
rollback;

-- ═══ E) Purga (solo sistema) ═══
\echo 'E1. simulacion: cuenta 1 vaciable (la 004) y 1 protegida (la 002 con ARCO abierta)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'simulacion' and out_rows_affected = 1 and out_rows_protected = 1 and out_retention_days = 180)::int as e1_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', true, 500);
rollback;

\echo 'E2. simulacion: no cambia ningun dato'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', true, 500);
reset role;
select count(*)::int as e2_deberia_ser_3 from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000f5a00' and messages <> '[]'::jsonb;
rollback;

\echo 'E3. purga real: vacia solo la vencida sin ARCO abierta; deja la protegida y la reciente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
reset role;
select count(*)::int as e3_deberia_ser_2 from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000f5a00' and messages <> '[]'::jsonb;
rollback;

\echo 'E4. purga real de A no toca la organizacion B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
reset role;
select count(*)::int as e4_deberia_ser_1 from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000f5b00' and messages <> '[]'::jsonb;
rollback;

\echo 'E5. la purga real deja registro sin PII: estado ok, 1 fila afectada, 1 protegida'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
reset role;
select count(*)::int as e5_deberia_ser_1 from core.purge_run_log where organization_id = '00000000-0000-0000-0000-0000000f5a00' and data_class = 'restaurantes_whatsapp_conversaciones' and status = 'ok' and rows_affected = 1 and rows_protected = 1;
rollback;

\echo 'E6. owner (staff) no puede disparar la purga'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500) as should_fail;
rollback;

\echo 'E7. superadmin tampoco: es solo sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c00', true);
select core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500) as should_fail;
rollback;

\echo 'E8. anon no tiene EXECUTE'
begin;
set local role anon;
select core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500) as should_fail;
rollback;

\echo 'E9. con retencion legal activa NO se purga: estado bloqueada y nada cambia'
begin;
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a20', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'bloqueada' and out_rows_affected = 0)::int as e9_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
rollback;

\echo 'E10. con retencion legal activa los datos siguen intactos'
begin;
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a20', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
reset role;
select count(*)::int as e10_deberia_ser_3 from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000f5a00' and messages <> '[]'::jsonb;
rollback;

\echo 'E11. el bloqueo bloqueado queda registrado con su motivo fijo'
begin;
insert into core.purge_hold (id, organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a20', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
reset role;
select count(*)::int as e11_deberia_ser_1 from core.purge_run_log where organization_id = '00000000-0000-0000-0000-0000000f5a00' and status = 'bloqueada' and blocked_reason = 'retencion_legal_activa';
rollback;

\echo 'E12. un bloqueo de OTRA clase no frena la purga de conversaciones'
begin;
insert into core.purge_hold (organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_voz_transcripciones', 'Retencion legal de voz de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'ok' and out_rows_affected = 1)::int as e12_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
rollback;

\echo 'E13. un bloqueo sin clase (todas) frena cualquier purga de la organizacion'
begin;
insert into core.purge_hold (organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a00', null, 'Retencion legal general de prueba', '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'bloqueada')::int as e13_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_voz_transcripciones', false, 500);
rollback;

\echo 'E14. un bloqueo ya liberado no frena la purga'
begin;
insert into core.purge_hold (organization_id, data_class, reason, placed_by, released_at, released_by) values ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'Retencion legal ya cerrada', '00000000-0000-0000-0000-0000000f5a01', now(), '00000000-0000-0000-0000-0000000f5a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'ok' and out_rows_affected = 1)::int as e14_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
rollback;

\echo 'E15. la politica de la organizacion manda: con 500 dias la conversacion de 400 dias no vence'
begin;
insert into core.retention_policy (organization_id, data_class, retention_days) values ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 500);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'ok' and out_rows_affected = 0 and out_retention_days = 500)::int as e15_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500);
rollback;

\echo 'E16. una clase que corre el vertical responde sin_ejecutor y no borra nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'sin_ejecutor' and out_rows_affected = 0)::int as e16_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'hoteles_identidad_documento', false, 500);
rollback;

\echo 'E17. clase desconocida es RECHAZADA'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'no_existe', false, 500) as should_fail;
rollback;

\echo 'E18. organizacion inexistente es RECHAZADA'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.system_run_retention_purge('00000000-0000-0000-0000-0000000fffff', 'restaurantes_whatsapp_conversaciones', false, 500) as should_fail;
rollback;

\echo 'E19. voz real: borra los 2 turnos de la llamada vieja, anonimiza 1 llamada y protege la del titular con ARCO abierta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'ok' and out_rows_affected = 2 and out_rows_anonymized = 1 and out_rows_protected = 1)::int as e19_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_voz_transcripciones', false, 500);
rollback;

\echo 'E20. voz real: la llamada protegida conserva su turno y la reciente su hash'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_voz_transcripciones', false, 500);
reset role;
select ((select count(*) from restaurantes.voice_turn where organization_id = '00000000-0000-0000-0000-0000000f5a00') = 1 and (select count(*) from restaurantes.voice_conversation where organization_id = '00000000-0000-0000-0000-0000000f5a00' and caller_hash is not null) = 2)::int as e20_deberia_ser_1;
rollback;

\echo 'E21. voz con retencion de 0 dias: la llamada reciente (ya terminada) tambien se purga de turnos y hash'
begin;
insert into core.retention_policy (organization_id, data_class, retention_days) values ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_voz_transcripciones', 0);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_rows_anonymized = 2)::int as e21_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_voz_transcripciones', false, 500);
rollback;

\echo 'E22. el registro de purgas es visible al owner de SU organizacion y solo a esa'
begin;
select core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', false, 500) from (select set_config('request.jwt.claim.sub', '', true)) s;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select count(*)::int as e22_deberia_ser_0 from core.org_list_purge_runs('00000000-0000-0000-0000-0000000f5a00', 50, null);
rollback;

\echo 'E23. el owner de A ve su registro de purgas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', true, 500);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*)::int as e23_deberia_ser_1 from core.org_list_purge_runs('00000000-0000-0000-0000-0000000f5a00', 50, null);
rollback;

\echo 'E24. el superadmin ve el registro global de purgas con el nombre de la organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', true, 500);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c00', true);
select count(*)::int as e24_deberia_ser_1 from core.platform_list_purge_runs('00000000-0000-0000-0000-0000000f5c00', 50, null) where out_organization_name = 'Privacidad Org A';
rollback;

\echo 'E25. el registro de purgas es append-only: UPDATE RECHAZADO'
begin;
insert into core.purge_run_log (organization_id, data_class, status) values ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'ok');
update core.purge_run_log set rows_affected = 99 where organization_id = '00000000-0000-0000-0000-0000000f5a00' and data_class = 'restaurantes_whatsapp_conversaciones' and status = 'ok' returning 1 as should_fail;
rollback;

\echo 'E26. el registro de purgas es append-only: DELETE RECHAZADO'
begin;
insert into core.purge_run_log (organization_id, data_class, status) values ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'ok');
delete from core.purge_run_log where organization_id = '00000000-0000-0000-0000-0000000f5a00' returning 1 as should_fail;
rollback;

\echo 'E27. el registro no admite un motivo de bloqueo libre (sin texto con datos)'
begin;
insert into core.purge_run_log (organization_id, data_class, status, blocked_reason) values ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 'bloqueada', 'telefono +5215550000') returning 1 as should_fail;
rollback;

\echo 'E28. sistema lista los pares organizacion/clase de plataforma (2 organizaciones x 2 clases = 4)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as e28_deberia_ser_4 from core.system_list_purge_targets(null, 50);
rollback;

\echo 'E29. el cursor continua despues de la primera organizacion (2 pares)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as e29_deberia_ser_2 from core.system_list_purge_targets('00000000-0000-0000-0000-0000000f5a00', 50);
rollback;

\echo 'E29b. filtrar por una organizacion devuelve solo sus 2 pares'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as e29b_deberia_ser_2 from core.system_list_purge_targets(null, 50, '00000000-0000-0000-0000-0000000f5b00');
rollback;

\echo 'E30. un owner (staff) no lista objetivos de purga'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.system_list_purge_targets(null, 50) as should_fail;
rollback;

\echo 'E31. anon no tiene EXECUTE sobre la lista de objetivos'
begin;
set local role anon;
select core.system_list_purge_targets(null, 50) as should_fail;
rollback;

-- ═══ F) Aviso de privacidad versionado ═══
\echo 'F1. owner A publica la version 1 y su aceptacion queda registrada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select (out_version = 1 and out_accepted_count = 1 and out_accepted_by_caller and out_is_current)::int as f1_deberia_ser_1 from core.org_list_privacy_notices('00000000-0000-0000-0000-0000000f5a00', 20);
rollback;

\echo 'F2. una segunda publicacion es la version 2 y la 1 deja de ser vigente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select count(*)::int as f2_deberia_ser_1 from core.org_list_privacy_notices('00000000-0000-0000-0000-0000000f5a00', 20) where out_version = 1 and not out_is_current;
rollback;

\echo 'F3. otro admin acepta la version vigente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a02', true);
select core.org_accept_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 1)::int as f3_deberia_ser_1;
rollback;

\echo 'F4. aceptar dos veces es idempotente (la segunda no inserta)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a02', true);
select core.org_accept_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 1);
select core.org_accept_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 1)::int as f4_deberia_ser_0;
rollback;

\echo 'F5. aceptar una version que ya no es la vigente es RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a02', true);
select core.org_accept_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 1) as should_fail;
rollback;

\echo 'F6. aceptar una version inexistente es RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_accept_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 7) as should_fail;
rollback;

\echo 'F7. member A no publica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a03', true);
select core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso') as should_fail;
rollback;

\echo 'F8. cross-tenant: owner B no publica en la organizacion A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso') as should_fail;
rollback;

\echo 'F9. la URL debe ser https'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'http://ejemplo.mx/aviso') as should_fail;
rollback;

\echo 'F10. un titulo demasiado corto es RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'ab', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso') as should_fail;
rollback;

\echo 'F11. member A no acepta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a03', true);
select core.org_accept_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 1) as should_fail;
rollback;

\echo 'F12. la huella sha256 de lo publicado se guarda (64 hex)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select (length(out_content_sha256) = 64 and out_content_sha256 ~ '^[0-9a-f]+$')::int as f12_deberia_ser_1 from core.org_list_privacy_notices('00000000-0000-0000-0000-0000000f5a00', 20);
rollback;

\echo 'F13. cross-tenant: owner B no lee los avisos de la organizacion A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5b01', true);
select count(*)::int as f13_deberia_ser_0 from core.org_list_privacy_notices('00000000-0000-0000-0000-0000000f5a00', 20);
rollback;

\echo 'F14. el aviso publicado es append-only: UPDATE RECHAZADO'
begin;
insert into core.privacy_notice_version (organization_id, version, title, summary, notice_url, content_sha256, published_by) values ('00000000-0000-0000-0000-0000000f5a00', 1, 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso', repeat('0', 64), '00000000-0000-0000-0000-0000000f5a01');
update core.privacy_notice_version set title = 'Cambiado' where organization_id = '00000000-0000-0000-0000-0000000f5a00' returning 1 as should_fail;
rollback;

\echo 'F15. el aviso publicado es append-only: DELETE RECHAZADO'
begin;
insert into core.privacy_notice_version (organization_id, version, title, summary, notice_url, content_sha256, published_by) values ('00000000-0000-0000-0000-0000000f5a00', 1, 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso', repeat('0', 64), '00000000-0000-0000-0000-0000000f5a01');
delete from core.privacy_notice_version where organization_id = '00000000-0000-0000-0000-0000000f5a00' returning 1 as should_fail;
rollback;

\echo 'F16. la aceptacion es append-only: UPDATE RECHAZADO'
begin;
insert into core.privacy_notice_version (id, organization_id, version, title, summary, notice_url, content_sha256, published_by) values ('00000000-0000-0000-0000-0000000f5a40', '00000000-0000-0000-0000-0000000f5a00', 1, 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso', repeat('0', 64), '00000000-0000-0000-0000-0000000f5a01');
insert into core.privacy_notice_acceptance (organization_id, notice_id, version, accepted_by) values ('00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a40', 1, '00000000-0000-0000-0000-0000000f5a01');
update core.privacy_notice_acceptance set version = 2 where organization_id = '00000000-0000-0000-0000-0000000f5a00' returning 1 as should_fail;
rollback;

\echo 'F17. el resumen de plataforma muestra la version vigente de la organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select * from core.org_publish_privacy_notice('00000000-0000-0000-0000-0000000f5a00', 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5c00', true);
select out_notice_version::int as f17_deberia_ser_2 from core.platform_privacy_overview('00000000-0000-0000-0000-0000000f5c00', 50, 0) where out_organization_id = '00000000-0000-0000-0000-0000000f5a00';
rollback;

\echo 'F18. dos publicaciones simultaneas de una misma organizacion no repiten version (unique)'
begin;
insert into core.privacy_notice_version (organization_id, version, title, summary, notice_url, content_sha256, published_by) values ('00000000-0000-0000-0000-0000000f5a00', 1, 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso', repeat('0', 64), '00000000-0000-0000-0000-0000000f5a01');
insert into core.privacy_notice_version (organization_id, version, title, summary, notice_url, content_sha256, published_by) values ('00000000-0000-0000-0000-0000000f5a00', 1, 'Aviso de privacidad', 'Usamos tus datos para atender tu pedido.', 'https://ejemplo.mx/aviso', repeat('1', 64), '00000000-0000-0000-0000-0000000f5a01') returning 1 as should_fail;
rollback;

-- ═══ G) Superficie ═══
\echo 'G. authenticated no lee core.retention_class directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*) as should_fail from core.retention_class;
rollback;

\echo 'G. anon no lee core.retention_class directo'
begin;
set local role anon;
select count(*) as should_fail from core.retention_class;
rollback;

\echo 'G. authenticated no lee core.retention_policy directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*) as should_fail from core.retention_policy;
rollback;

\echo 'G. anon no lee core.retention_policy directo'
begin;
set local role anon;
select count(*) as should_fail from core.retention_policy;
rollback;

\echo 'G. authenticated no lee core.purge_hold directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*) as should_fail from core.purge_hold;
rollback;

\echo 'G. anon no lee core.purge_hold directo'
begin;
set local role anon;
select count(*) as should_fail from core.purge_hold;
rollback;

\echo 'G. authenticated no lee core.purge_run_log directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*) as should_fail from core.purge_run_log;
rollback;

\echo 'G. anon no lee core.purge_run_log directo'
begin;
set local role anon;
select count(*) as should_fail from core.purge_run_log;
rollback;

\echo 'G. authenticated no lee core.privacy_notice_version directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*) as should_fail from core.privacy_notice_version;
rollback;

\echo 'G. anon no lee core.privacy_notice_version directo'
begin;
set local role anon;
select count(*) as should_fail from core.privacy_notice_version;
rollback;

\echo 'G. authenticated no lee core.privacy_notice_acceptance directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*) as should_fail from core.privacy_notice_acceptance;
rollback;

\echo 'G. anon no lee core.privacy_notice_acceptance directo'
begin;
set local role anon;
select count(*) as should_fail from core.privacy_notice_acceptance;
rollback;

\echo 'G. authenticated no escribe core.retention_policy directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
insert into core.retention_policy (organization_id, data_class, retention_days) values ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes_whatsapp_conversaciones', 31) returning 1 as should_fail;
rollback;

\echo 'G. authenticated no escribe core.purge_hold directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
insert into core.purge_hold (organization_id, reason, placed_by) values ('00000000-0000-0000-0000-0000000f5a00', 'Bloqueo directo prohibido', '00000000-0000-0000-0000-0000000f5a01') returning 1 as should_fail;
rollback;

\echo 'G. service_role no lee core.purge_run_log directo'
begin;
set local role service_role;
select count(*) as should_fail from core.purge_run_log;
rollback;

\echo 'G. las funciones internas no son ejecutables por authenticated ni anon'
begin;
select (not has_function_privilege('authenticated', 'core._arco_union()', 'execute') and not has_function_privilege('anon', 'core._arco_union()', 'execute') and not has_function_privilege('authenticated', 'core._privacy_is_org_admin(uuid)', 'execute') and not has_function_privilege('authenticated', 'core._privacy_is_platform_reader(uuid)', 'execute') and not has_function_privilege('authenticated', 'core._retention_effective(uuid, text)', 'execute'))::int as g_internas_deberia_ser_1;
rollback;

\echo 'G. authenticated no puede llamar _arco_union directo (veria todas las organizaciones)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5a01', true);
select count(*) as should_fail from core._arco_union();
rollback;

\echo 'G. todas las funciones nuevas son security definer con search_path fijo (las internas y el trigger sin search_path propio solo se cuentan si son definer)'
begin;
select count(*)::int as g_definer_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.proname = any(array['org_list_arco_requests','org_list_retention_policies','org_set_retention_policy','org_clear_retention_policy','org_place_purge_hold','org_release_purge_hold','org_list_purge_holds','org_list_purge_runs','org_publish_privacy_notice','org_accept_privacy_notice','org_list_privacy_notices','platform_list_arco_requests','platform_privacy_overview','platform_list_purge_runs','system_run_retention_purge','system_list_purge_targets','_privacy_is_org_admin','_privacy_is_platform_reader','_arco_union','_retention_effective','privacy_append_only_block_mutation']) and p.proname <> 'privacy_append_only_block_mutation' and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
rollback;

\echo 'G. ninguna funcion nueva es ejecutable por anon ni por public'
begin;
select count(*)::int as g_anon_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.proname = any(array['org_list_arco_requests','org_list_retention_policies','org_set_retention_policy','org_clear_retention_policy','org_place_purge_hold','org_release_purge_hold','org_list_purge_holds','org_list_purge_runs','org_publish_privacy_notice','org_accept_privacy_notice','org_list_privacy_notices','platform_list_arco_requests','platform_privacy_overview','platform_list_purge_runs','system_run_retention_purge','system_list_purge_targets','_privacy_is_org_admin','_privacy_is_platform_reader','_arco_union','_retention_effective','privacy_append_only_block_mutation']) and (has_function_privilege('anon', p.oid, 'execute') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
rollback;

\echo 'G. las tablas nuevas tienen RLS habilitado'
begin;
select count(*)::int as g_rls_deberia_ser_0 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'core' and c.relname in ('retention_class','retention_policy','purge_hold','purge_run_log','privacy_notice_version','privacy_notice_acceptance') and not c.relrowsecurity;
rollback;

\echo 'G. el catalogo trae las 3 clases con sus rangos documentados'
begin;
select count(*)::int as g_catalogo_deberia_ser_3 from core.retention_class where (data_class = 'restaurantes_whatsapp_conversaciones' and default_days = 180 and min_days = 30 and max_days = 1095 and executor = 'plataforma') or (data_class = 'restaurantes_voz_transcripciones' and default_days = 30 and min_days = 0 and max_days = 365 and executor = 'plataforma') or (data_class = 'hoteles_identidad_documento' and default_days = 30 and min_days = 0 and max_days = 365 and executor = 'vertical');
rollback;

\echo 'verify-plataforma-privacidad: fin de los escenarios'
