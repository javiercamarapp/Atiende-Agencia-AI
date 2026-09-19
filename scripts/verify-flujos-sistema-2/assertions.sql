-- Fixtures + assertions que verifican, contra Postgres REAL, los 3 fixes de este PR
-- (segunda parte de "flujos de sistema bloqueados en escritura", ver el inventario
-- completo en scripts/verify-flujos-sistema/README.md y el README de este directorio):
--   * packages/domain-restaurantes/migrations/017_restaurantes_sistema_whatsapp_channel_config.sql
--   * packages/domain-despachos/migrations/009_despachos_sistema_cobranza_escritura.sql
--   * packages/domain-licitaciones/migrations/025_licitaciones_sistema_renovaciones_facturas.sql
--
-- Cubre, bajo sesión de sistema real
-- (`packages/db/src/managed-postgres-engine.ts::withAppSession({ userId: null })`
-- -- `set local role authenticated` + `auth.uid()` SIEMPRE NULL, nunca `service_role`):
--   (A) restaurantes: el webhook de WhatsApp entrante resuelve la organización por
--       `phone_number_id` (antes: RLS deny-all -- ni siquiera el staff podía leer).
--   (B) despachos: el cron `cobranza-reminders` lista la cartera pendiente + folio
--       fiscal/total del invoice, y registra el evento de recordatorio de forma
--       idempotente -- MISMO tiempo que confirma que el camino de staff
--       (`listReceivables`/`insertCollectionEvent`, panel + `/recordatorio` manual)
--       SIGUE funcionando exactamente igual, sin cambio.
--   (C) licitaciones: el barrido `alert-notifications` escanea contratos candidatos a
--       renovación, registra la alerta (dedupe real vía el índice único existente), y
--       lista facturas de contrato vencidas -- MISMO tiempo que confirma que
--       `scanRenewalAlerts` (camino de staff, `POST .../renewals/scan`) SIGUE
--       funcionando exactamente igual.
--   (D) Controles negativos obligatorios por cada tabla/función tocada: un staff
--       autenticado de una organización ajena no lee ni escribe datos de otra; una
--       sesión autenticada normal (staff real) NO puede invocar ninguna de las
--       funciones nuevas de solo-sistema; `anon` sigue sin acceso.
--   (E) Límite deliberado de este PR: ninguna policy existente se relajó -- un INSERT/
--       SELECT directo contra las tablas subyacentes bajo sesión de sistema sigue
--       bloqueado exactamente igual que antes (el fix es SOLO las funciones/policy
--       nuevas, nunca un escape hatch más amplio).
--
-- Punto 4 del inventario (hoteles night-audit/no-show) NO se toca en este PR -- ver
-- README de este directorio para el análisis completo. `scripts/verify-flujos-
-- sistema/assertions.sql` (escenario 21) ya cubre su guard de regresión de alcance;
-- no se duplica aquí.
--
-- Corre vía ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI).
-- Cada escenario vive en su propio `begin; ... rollback;` -- nada de esta sección
-- persiste. Los fixtures de abajo SÍ persisten (corren fuera de una transacción, como
-- superusuario, bypass RLS).
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten — corren como postgres, bypass RLS).
-- ---------------------------------------------------------------------------

-- Restaurantes: organización A (ejercitada de punta a punta) + organización B
-- (control cross-tenant), un staff real por cada una, config de WhatsApp de A.
insert into core.organization (id, vertical, name, slug, status) values
  ('73000000-0000-0000-0000-000000000001', 'restaurantes', 'Restaurante Flujos Sistema 2 A', 'flujos-sistema-2-rest-a', 'active'),
  ('73000000-0000-0000-0000-000000000002', 'restaurantes', 'Restaurante Flujos Sistema 2 B', 'flujos-sistema-2-rest-b', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('73000000-0000-0000-0000-0000000f0a01', 'owner-rest-a@flujos-sistema-2.example.com', 'Owner Rest A', 'seed'),
  ('73000000-0000-0000-0000-0000000f0b01', 'owner-rest-b@flujos-sistema-2.example.com', 'Owner Rest B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('73000000-0000-0000-0000-0000000f0a01', '73000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('73000000-0000-0000-0000-0000000f0b01', '73000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values
  ('73000000-0000-0000-0000-000000000001', '15559990001')
on conflict do nothing;

-- Despachos: organización A (ejercitada de punta a punta) + organización B (control
-- cross-tenant), property + staff real por cada una, un invoice + receivable pendiente
-- de A con cliente de contacto capturado.
insert into core.organization (id, vertical, name, slug, status) values
  ('74000000-0000-0000-0000-000000000001', 'despachos', 'Despacho Flujos Sistema 2 A', 'flujos-sistema-2-desp-a', 'active'),
  ('74000000-0000-0000-0000-000000000002', 'despachos', 'Despacho Flujos Sistema 2 B', 'flujos-sistema-2-desp-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('74000000-0000-0000-0000-0000000000a1', '74000000-0000-0000-0000-000000000001', 'despachos', 'Property singleton A', 'active'),
  ('74000000-0000-0000-0000-0000000000b1', '74000000-0000-0000-0000-000000000002', 'despachos', 'Property singleton B', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('74000000-0000-0000-0000-0000000f0a01', 'owner-desp-a@flujos-sistema-2.example.com', 'Owner Desp A', 'seed'),
  ('74000000-0000-0000-0000-0000000f0b01', 'owner-desp-b@flujos-sistema-2.example.com', 'Owner Desp B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('74000000-0000-0000-0000-0000000f0a01', '74000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('74000000-0000-0000-0000-0000000f0b01', '74000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

insert into despachos.invoice
  (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, emisor_nombre,
   subtotal, total, iva, descuento, categoria, valido, issues, warnings, requires_human_review, diot, fecha)
values
  ('74000000-0000-0000-0000-0000000000f1', '74000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-0000000000a1',
   'aaaaaaaa-0000-0000-0000-000000000001', 'I', 'CON950820K12', 'XAXX010101000', 'Cliente Flujos Sistema 2',
   1000, 1160, 160, 0, 'sin_clasificar', true, '[]'::jsonb, '[]'::jsonb, false, '{}'::jsonb, '2026-08-01')
on conflict do nothing;

insert into despachos.receivable (id, organization_id, property_id, invoice_id, fecha_vencimiento, cliente_nombre, cliente_email) values
  ('74000000-0000-0000-0000-0000000000e1', '74000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-0000000000a1',
   '74000000-0000-0000-0000-0000000000f1', '2026-09-14', 'Deudor Flujos Sistema 2', 'deudor@flujos-sistema-2.example.com')
on conflict do nothing;

-- Licitaciones: organización A (ejercitada de punta a punta) + organización B
-- (control cross-tenant), staff real por cada una, un tender+contrato con fin
-- próximo (candidato a renovación) y una factura de contrato ya vencida.
insert into core.organization (id, vertical, name, slug, status) values
  ('75000000-0000-0000-0000-000000000001', 'licitaciones', 'Despacho Lic Flujos Sistema 2 A', 'flujos-sistema-2-lic-a', 'active'),
  ('75000000-0000-0000-0000-000000000002', 'licitaciones', 'Despacho Lic Flujos Sistema 2 B', 'flujos-sistema-2-lic-b', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('75000000-0000-0000-0000-0000000f0a01', 'owner-lic-a@flujos-sistema-2.example.com', 'Owner Lic A', 'seed'),
  ('75000000-0000-0000-0000-0000000f0b01', 'owner-lic-b@flujos-sistema-2.example.com', 'Owner Lic B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('75000000-0000-0000-0000-0000000f0a01', '75000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('75000000-0000-0000-0000-0000000f0b01', '75000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

insert into licitaciones.tender (id, organization_id, title, source, status) values
  ('75000000-0000-0000-0000-00000000ae01', '75000000-0000-0000-0000-000000000001', 'Tender flujos sistema 2', 'manual', 'won')
on conflict do nothing;

insert into licitaciones.contract (id, organization_id, tender_id, end_date, status) values
  ('75000000-0000-0000-0000-00000000ac01', '75000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-00000000ae01', current_date + 20, 'en_ejecucion')
on conflict do nothing;

insert into licitaciones.contract_invoice (id, organization_id, contract_id, concepto, amount, invoice_verified_on, due_date, legal_reference) values
  ('75000000-0000-0000-0000-00000000ad01', '75000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-00000000ac01',
   'Pago flujos sistema 2', 5000, current_date - 30, current_date - 5, 'Contrato clausula 3')
on conflict do nothing;

-- =============================================================================
-- (A) Restaurantes — webhook de WhatsApp entrante resuelve la organización por
--     phone_number_id bajo sesión de sistema.
-- =============================================================================

\echo '=== 1. restaurantes.whatsapp_channel_config SELECT: la sesion de sistema SI resuelve la organizacion por phone_number_id (antes: RLS deny-all, ni el staff podia leer) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as resuelve_organizacion_por_telefono_deberia_ser_1
  from restaurantes.whatsapp_channel_config where phone_number_id = '15559990001';
rollback;

\echo '=== 2. (control positivo) staff real de la organizacion A SIGUE viendo su propia config de whatsapp (misma policy, ahora con escape hatch) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '73000000-0000-0000-0000-0000000f0a01', true);
select count(*)::int as staff_ve_su_propia_config_deberia_ser_1
  from restaurantes.whatsapp_channel_config where organization_id = '73000000-0000-0000-0000-000000000001';
rollback;

\echo '=== 3. (control cross-tenant) staff real de la organizacion B NO ve la config de whatsapp de la organizacion A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '73000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_config_deberia_ser_0
  from restaurantes.whatsapp_channel_config where organization_id = '73000000-0000-0000-0000-000000000001';
rollback;

\echo '=== 4. anon SIGUE sin acceso a restaurantes.whatsapp_channel_config (sin GRANT a anon) ==='
begin;
set local role anon;
select phone_number_id as should_fail from restaurantes.whatsapp_channel_config limit 1;
rollback;

\echo '=== 5. (limite deliberado) un INSERT directo contra restaurantes.whatsapp_channel_config por staff real SIGUE bloqueado -- esta migracion es SOLO SELECT, sin policy de insert/update/delete ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '73000000-0000-0000-0000-0000000f0a01', true);
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('73000000-0000-0000-0000-000000000001', '15559990099');
rollback;

-- =============================================================================
-- (B) Despachos — cron cobranza-reminders de punta a punta bajo sesion de sistema.
-- =============================================================================

\echo '=== 6. system_list_pending_receivables_with_invoice: la sesion de sistema SI ve la cartera pendiente + folio fiscal/total del invoice (antes: 0 filas por RLS, sin findInvoice posible) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (count(*) filter (where out_factura_folio_fiscal = 'aaaaaaaa-0000-0000-0000-000000000001' and out_cliente_email = 'deudor@flujos-sistema-2.example.com'))::int
    as sesion_sistema_ve_cartera_con_invoice_deberia_ser_1
  from despachos.system_list_pending_receivables_with_invoice('74000000-0000-0000-0000-0000000000a1');
rollback;

\echo '=== 7. system_record_collection_event: la sesion de sistema SI registra el evento de recordatorio (antes: bloqueado por policy de insert de staff) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_id is not null)::int as registra_evento_recordatorio_deberia_ser_1
  from despachos.system_record_collection_event(
    '74000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-0000000000a1', '74000000-0000-0000-0000-0000000000e1',
    'vencimiento', 'email', null, current_date
  );
rollback;

\echo '=== 8. system_record_collection_event: reintento MISMO dia/misma etapa no duplica (dedupe best-effort, ver header de la migracion 009) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.system_record_collection_event(
  '74000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-0000000000a1', '74000000-0000-0000-0000-0000000000e1',
  'vencimiento', 'email', null, current_date
);
select count(*)::int as reintento_mismo_dia_no_duplica_deberia_ser_0
  from despachos.system_record_collection_event(
    '74000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-0000000000a1', '74000000-0000-0000-0000-0000000000e1',
    'vencimiento', 'email', null, current_date
  );
rollback;

\echo '=== 9. system_list_pending_receivables_with_invoice rechaza a un staff autenticado real -- exclusiva de sesion de sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-0000-0000-0000000f0a01', true);
select despachos.system_list_pending_receivables_with_invoice('74000000-0000-0000-0000-0000000000a1') as should_fail;
rollback;

\echo '=== 10. system_record_collection_event rechaza a un staff autenticado real -- exclusiva de sesion de sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-0000-0000-0000000f0a01', true);
select despachos.system_record_collection_event(
  '74000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-0000000000a1', '74000000-0000-0000-0000-0000000000e1',
  'vencimiento', 'email', null, current_date
) as should_fail;
rollback;

\echo '=== 11. ambas funciones nuevas de despachos rechazan a anon (sin GRANT execute) ==='
begin;
set local role anon;
select despachos.system_list_pending_receivables_with_invoice('74000000-0000-0000-0000-0000000000a1') as should_fail;
rollback;

\echo '=== 12. (control positivo) staff real de la organizacion A SIGUE viendo su cartera pendiente via listReceivables (camino compartido con el cron, sin cambio de este fix) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-0000-0000-0000000f0a01', true);
select count(*)::int as staff_sigue_viendo_su_cartera_deberia_ser_1
  from despachos.receivable where property_id = '74000000-0000-0000-0000-0000000000a1' and pagado_en is null;
rollback;

\echo '=== 13. (control cross-tenant) staff real de la organizacion B NO ve la cartera pendiente de la property de la organizacion A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_cartera_deberia_ser_0
  from despachos.receivable where property_id = '74000000-0000-0000-0000-0000000000a1' and pagado_en is null;
rollback;

\echo '=== 14. (control positivo) staff real de la organizacion A SIGUE pudiendo registrar un evento de cobranza manual (insertCollectionEvent directo, camino de /recordatorio, sin cambio de este fix) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '74000000-0000-0000-0000-0000000f0a01', true);
insert into despachos.collection_event (organization_id, property_id, receivable_id, etapa, canal, respuesta)
  values ('74000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-0000000000a1', '74000000-0000-0000-0000-0000000000e1', 'respuesta', 'email', 'promesa_pago')
  returning (id is not null)::int as staff_sigue_registrando_evento_manual_deberia_ser_1;
rollback;

-- =============================================================================
-- (C) Licitaciones — barrido alert-notifications (renovaciones + facturas vencidas)
--     de punta a punta bajo sesion de sistema.
-- =============================================================================

\echo '=== 15. system_list_renewal_candidate_contracts: la sesion de sistema SI ve el contrato candidato a renovacion (antes: bloqueado por can_access_org) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as ve_contrato_candidato_deberia_ser_1
  from licitaciones.system_list_renewal_candidate_contracts('75000000-0000-0000-0000-000000000001')
  where out_contract_id = '75000000-0000-0000-0000-00000000ac01';
rollback;

\echo '=== 16. system_record_renewal_alert: la sesion de sistema SI crea la alerta, y reintentar el MISMO umbral no duplica (dedupe real, indice unico existente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_id is not null)::int as crea_alerta_renovacion_deberia_ser_1
  from licitaciones.system_record_renewal_alert(
    '75000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-00000000ac01', '75000000-0000-0000-0000-00000000ae01',
    current_date + 20, 30, 0.83
  );
select count(*)::int as reintento_mismo_umbral_no_duplica_deberia_ser_0
  from licitaciones.system_record_renewal_alert(
    '75000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-00000000ac01', '75000000-0000-0000-0000-00000000ae01',
    current_date + 20, 30, 0.83
  );
rollback;

\echo '=== 17. system_list_overdue_contract_invoices: la sesion de sistema SI ve la factura de contrato vencida (antes: bloqueado por can_access_org) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as ve_factura_vencida_deberia_ser_1
  from licitaciones.system_list_overdue_contract_invoices('75000000-0000-0000-0000-000000000001', current_date)
  where out_id = '75000000-0000-0000-0000-00000000ad01';
rollback;

\echo '=== 18. las 3 funciones nuevas de licitaciones rechazan a un staff autenticado real -- exclusivas de sesion de sistema (chequeo representativo de la lectura; las 3 comparten el MISMO guard `auth.uid() is not null -> raise 42501`, ver migracion 025) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '75000000-0000-0000-0000-0000000f0a01', true);
select licitaciones.system_list_renewal_candidate_contracts('75000000-0000-0000-0000-000000000001') as should_fail;
rollback;

\echo '=== 18b. system_record_renewal_alert (la escritura) rechaza tambien a un staff autenticado real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '75000000-0000-0000-0000-0000000f0a01', true);
select licitaciones.system_record_renewal_alert(
  '75000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-00000000ac01', '75000000-0000-0000-0000-00000000ae01',
  current_date + 20, 30, 0.83
) as should_fail;
rollback;

\echo '=== 19. las 3 funciones nuevas de licitaciones rechazan a anon (sin GRANT execute; chequeo representativo, mismo GRANT en las 3) ==='
begin;
set local role anon;
select licitaciones.system_list_overdue_contract_invoices('75000000-0000-0000-0000-000000000001', current_date) as should_fail;
rollback;

\echo '=== 20. (control positivo) staff real de la organizacion A SIGUE pudiendo escanear renovaciones a mano via scanRenewalAlerts/POST .../renewals/scan (camino de staff, sin cambio de este fix) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '75000000-0000-0000-0000-0000000f0a01', true);
select count(*)::int as staff_sigue_viendo_contrato_candidato_deberia_ser_1
  from licitaciones.contract where organization_id = '75000000-0000-0000-0000-000000000001' and end_date is not null and status not in ('cerrado', 'rescindido');
rollback;

\echo '=== 21. (limite deliberado) un INSERT directo contra licitaciones.renewal_alert bajo sesion de sistema SIGUE bloqueado -- la policy "escritura: roles de escritura registran alertas de renovacion" nunca se toco ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into licitaciones.renewal_alert (organization_id, contract_id, tender_id, predicted_date, lead_days, confidence)
  values ('75000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-00000000ac01', '75000000-0000-0000-0000-00000000ae01', current_date + 20, 60, 0.5);
rollback;

\echo '=== 22. (limite deliberado) un SELECT directo contra licitaciones.contract bajo sesion de sistema SIGUE devolviendo 0 filas -- la policy "org ve sus contratos" nunca se toco, el acceso es SOLO via la funcion nueva ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as select_directo_sigue_bloqueado_deberia_ser_0
  from licitaciones.contract where organization_id = '75000000-0000-0000-0000-000000000001';
rollback;

\echo '=== FIN — revisa arriba: los escenarios marcados should_fail/deberia_ser_N deben terminar en ERROR o el valor N indicado; el resto debe devolver filas/RETURNING reales. ==='
