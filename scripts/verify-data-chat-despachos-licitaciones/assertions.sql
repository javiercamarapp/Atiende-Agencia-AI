-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales, no el repositorio en
-- memoria), el SQL de SOLO LECTURA de los catalogos de "Chatea con tus datos" de DESPACHOS
-- (packages/domain-despachos/src/data-chat/sql.ts) y LICITACIONES (packages/domain-licitaciones/src/data-chat/sql.ts).
-- El texto de cada consulta se copia IDENTICO aqui (lo genera el mismo texto del modulo) y los tests
-- packages/domain-{despachos,licitaciones}/tests/data-chat/sql-drift.spec.ts fallan si divergen.
--
-- Escenarios (todos como rol `authenticated` con auth.uid() real, salvo `anon`):
--   A) DESPACHOS: positivo (cifras exactas), cross-tenant en ambos sentidos, cross-cliente (un contador con
--      membership acotada a UN cliente solo ve ese aunque la aplicacion pasara null o el id de otro),
--      pagados fuera de la cartera, fecha local del negocio (hoy 29-sep a las 23:30 de Merida aunque en UTC
--      sea 30-sep), lista 69-B solo via funciones security definer (acceso a la property, staff de otra
--      vertical, anon), base sin migrar (42P01/42883 + SAVEPOINT).
--   B) LICITACIONES: positivo, cross-tenant, rol viewer lee, dias restantes y semaforo en fecha LOCAL (una
--      convocatoria que cierra a las 23:45 locales tiene 0 dias aunque en UTC ya sea otro dia), moneda
--      distinta de MXN sin monto, zona horaria configurada, anon, base sin migrar (42703/42P01 + SAVEPOINT).
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = debe terminar en
-- ERROR; alias `..._deberia_ser_N` = esa consulta devuelve N; un bloque DO que lanza excepcion ante una
-- discrepancia = debe completar sin error. Cada escenario va en su `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000d101', 'despachos', 'Despacho A (data chat)', 'despacho-a-data-chat'),
  ('00000000-0000-0000-0000-00000000d102', 'despachos', 'Despacho B (data chat, ajeno)', 'despacho-b-data-chat'),
  ('00000000-0000-0000-0000-00000000d201', 'licitaciones', 'Licitaciones A (data chat)', 'licitaciones-a-data-chat'),
  ('00000000-0000-0000-0000-00000000d202', 'licitaciones', 'Licitaciones B (data chat, ajena)', 'licitaciones-b-data-chat')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000061', 'admin-a-dc-dl@example.com', 'Admin Despacho A', 'seed'),
  ('00000000-0000-0000-0000-000000000062', 'contador-taller-dc-dl@example.com', 'Contador solo Taller', 'seed'),
  ('00000000-0000-0000-0000-000000000063', 'admin-b-dc-dl@example.com', 'Admin Despacho B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000000071', 'owner-lic-a-dc-dl@example.com', 'Owner Licitaciones A', 'seed'),
  ('00000000-0000-0000-0000-000000000072', 'viewer-lic-a-dc-dl@example.com', 'Viewer Licitaciones A', 'seed'),
  ('00000000-0000-0000-0000-000000000073', 'owner-lic-b-dc-dl@example.com', 'Owner Licitaciones B (ajeno)', 'seed')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000d101', 'despachos', 'Abarrotes La Esquina SA de CV'),
  ('00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-00000000d101', 'despachos', 'Taller Mecánico Peninsular'),
  ('00000000-0000-0000-0000-00000000e103', '00000000-0000-0000-0000-00000000d102', 'despachos', 'Clínica Dental B (ajena)')
on conflict do nothing;

-- admin A: todos los clientes · contador: SOLO el Taller · admin B: su despacho ajeno · licitaciones: owner/viewer A y owner B.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-00000000d101', null, 'owner', 'admin'),
  ('00000000-0000-0000-0000-000000000062', '00000000-0000-0000-0000-00000000d101', array['00000000-0000-0000-0000-00000000e102']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000000063', '00000000-0000-0000-0000-00000000d102', null, 'owner', 'admin'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-00000000d201', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000072', '00000000-0000-0000-0000-00000000d201', null, 'viewer', 'viewer'),
  ('00000000-0000-0000-0000-000000000073', '00000000-0000-0000-0000-00000000d202', null, 'owner', 'owner')
on conflict do nothing;

-- ===== DESPACHOS =====
-- CFDI: i1 Abarrotes I valido 1160 (iva 160) 10-sep · i2 Abarrotes I INVALIDO 580 (iva 80) 12-sep · i3 Abarrotes N 3000 15-sep
--       i4 Abarrotes I valido 580 31-AGO (fuera de la ventana de septiembre) · i5 Abarrotes I valido 2320 (iva 320) 20-sep, emisor en la 69-B, en revision
--       i6 Taller I valido 232 (iva 32) 5-sep · i7 Clinica B (otro despacho) 99999
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, requires_human_review, fecha) values
  ('00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a1', 'I', 'PRV010101AB1', 'ABA010101AB1', 1000, 1160, 160, true, false, '2026-09-10'),
  ('00000000-0000-0000-0000-0000000f0102', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a2', 'I', 'PRV010101AB1', 'ABA010101AB1', 500, 580, 80, false, false, '2026-09-12'),
  ('00000000-0000-0000-0000-0000000f0103', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a3', 'N', 'ABA010101AB1', 'EMP010101AB1', 3000, 3000, 0, true, false, '2026-09-15'),
  ('00000000-0000-0000-0000-0000000f0104', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a4', 'I', 'PRV010101AB1', 'ABA010101AB1', 500, 580, 80, true, false, '2026-08-31'),
  ('00000000-0000-0000-0000-0000000f0105', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a5', 'I', 'AAA010101AAA', 'ABA010101AB1', 2000, 2320, 320, true, true, '2026-09-20'),
  ('00000000-0000-0000-0000-0000000f0106', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-0000000000a6', 'I', 'PRV020202CD2', 'TAL010101AB1', 200, 232, 32, true, false, '2026-09-05'),
  ('00000000-0000-0000-0000-0000000f0107', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000e103', '00000000-0000-0000-0000-0000000000a7', 'I', 'PRV030303EF3', 'CLI010101AB1', 86206.90, 99999, 13792.10, true, false, '2026-09-10')
on conflict do nothing;

-- Cartera (hoy = 2026-09-29): r1 i1 vence 1-sep (28 dias, 1-30) · r2 i5 vence 1-jun (120 dias, >90) · r3 i4 vence 15-oct (vigente)
--   r4 i6 Taller vence 20-sep (9 dias) · r5 i2 PAGADA (fuera de la cartera) · r6 Clinica B vencida enorme (otro despacho)
insert into despachos.receivable (id, organization_id, property_id, invoice_id, fecha_vencimiento, monto_pagado, pagado_en) values
  ('00000000-0000-0000-0000-0000000f0201', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0101', '2026-09-01', null, null),
  ('00000000-0000-0000-0000-0000000f0202', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0105', '2026-06-01', null, null),
  ('00000000-0000-0000-0000-0000000f0203', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0104', '2026-10-15', null, null),
  ('00000000-0000-0000-0000-0000000f0204', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-0000000f0106', '2026-09-20', null, null),
  ('00000000-0000-0000-0000-0000000f0205', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0102', '2026-08-01', 580, '2026-08-20T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0206', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000e103', '00000000-0000-0000-0000-0000000f0107', '2026-01-01', null, null)
on conflict do nothing;

insert into despachos.fiscal_deadline (id, organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values
  ('00000000-0000-0000-0000-0000000f0301', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', 'IVA', '2026-09', '2026-10-17', 'alta', 'pendiente'),
  ('00000000-0000-0000-0000-0000000f0302', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', 'DIOT', '2026-08', '2026-09-17', 'critica', 'pendiente'),
  ('00000000-0000-0000-0000-0000000f0303', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e102', 'ISR', '2026-08', '2026-09-17', 'media', 'completado'),
  ('00000000-0000-0000-0000-0000000f0304', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000e103', 'ISR', '2026-08', '2026-09-17', 'alta', 'pendiente')
on conflict do nothing;

-- Cierres: Abarrotes ago-2026 VENCIDO (3 tareas: pending vence 10-sep, in_progress vence 10-oct, done) · Abarrotes jul-2026 CERRADO
--          Taller sep-2026 abierto sin tareas · Clinica B abierto con una tarea (otro despacho)
insert into despachos.periodo_cierre (id, organization_id, property_id, anio, mes, status) values
  ('00000000-0000-0000-0000-0000000f0401', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', 2026, 8, 'overdue'),
  ('00000000-0000-0000-0000-0000000f0402', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', 2026, 7, 'closed'),
  ('00000000-0000-0000-0000-0000000f0403', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e102', 2026, 9, 'open'),
  ('00000000-0000-0000-0000-0000000f0404', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000e103', 2026, 9, 'open')
on conflict do nothing;
insert into despachos.periodo_cierre_tarea (id, periodo_cierre_id, title, category, status, due_date) values
  ('00000000-0000-0000-0000-0000000f0411', '00000000-0000-0000-0000-0000000f0401', 'Verificar CFDI', 'cfdi', 'pending', '2026-09-10'),
  ('00000000-0000-0000-0000-0000000f0412', '00000000-0000-0000-0000-0000000f0401', 'Conciliar bancos', 'bank', 'in_progress', '2026-10-10'),
  ('00000000-0000-0000-0000-0000000f0413', '00000000-0000-0000-0000-0000000f0401', 'Nomina', 'nomina', 'done', '2026-09-05'),
  ('00000000-0000-0000-0000-0000000f0414', '00000000-0000-0000-0000-0000000f0404', 'Tarea ajena', 'cfdi', 'pending', '2026-09-01')
on conflict do nothing;

insert into despachos.invoice_review (id, organization_id, property_id, invoice_id, reason, status) values
  ('00000000-0000-0000-0000-0000000f0501', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0105', 'Emisor en lista 69-B', 'pendiente')
on conflict do nothing;

-- Lista 69-B ingerida (se siembra como superusuario: las tablas efos_* no son legibles por authenticated).
insert into despachos.efos_ingesta (periodo, fuente_sha256, filas) values ('2026-09', 'abababababababababababababababababababababababababababababababab', 1) on conflict do nothing;
insert into despachos.efos_contribuyente (periodo, rfc, nombre, situacion) values ('2026-09', 'AAA010101AAA', 'Proveedor Fantasma SA', 'definitivo') on conflict do nothing;

-- ===== LICITACIONES (ahora = 2026-09-30T05:30Z = 29-sep 23:30 en Merida) =====
insert into licitaciones.tender (id, organization_id, title, submission_deadline, status, contracting_body, state, budget_amount, currency) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000d201', 'Uniformes escolares', '2026-10-01T16:00:00Z', 'in_progress', 'SEP Yucatán', 'Yucatán', 1250000.50, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-00000000d201', 'Limpieza hospitalaria', '2026-10-20T20:00:00Z', 'in_review', 'IMSS-Bienestar', null, 480000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1003', '00000000-0000-0000-0000-00000000d201', 'Equipo de computo en dolares', null, 'discovered', null, null, 50000, 'USD'),
  ('00000000-0000-0000-0000-0000000f1004', '00000000-0000-0000-0000-00000000d201', 'Cierra hoy a las 23:45 locales', '2026-09-30T05:45:00Z', 'go', 'CFE', null, 100000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1005', '00000000-0000-0000-0000-00000000d201', 'Vencida sin presentar', '2026-09-25T18:00:00Z', 'go', 'SEDUMA', null, 70000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1006', '00000000-0000-0000-0000-00000000d201', 'Ya presentada', '2026-10-05T18:00:00Z', 'submitted', 'ISSSTE', null, 300000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1007', '00000000-0000-0000-0000-00000000d201', 'Amarillo', '2026-10-05T18:00:00Z', 'in_progress', 'SAT', null, 200000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1008', '00000000-0000-0000-0000-00000000d201', 'Ganada', '2026-08-01T18:00:00Z', 'won', 'IMSS-Bienestar', null, 900000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1009', '00000000-0000-0000-0000-00000000d201', 'Perdida en dolares', '2026-08-01T18:00:00Z', 'lost', 'SEDUMA', null, 1000, 'USD'),
  ('00000000-0000-0000-0000-0000000f1010', '00000000-0000-0000-0000-00000000d201', 'No-go', '2026-10-30T18:00:00Z', 'no_go', 'SCT', null, 5000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1011', '00000000-0000-0000-0000-00000000d201', 'Cancelada', '2026-10-30T18:00:00Z', 'cancelled', 'SCT', null, 5000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-00000000d202', 'Convocatoria ajena B', '2026-10-02T18:00:00Z', 'in_progress', 'Otra dependencia', null, 99999999, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1102', '00000000-0000-0000-0000-00000000d202', 'Fallo ajeno B', '2026-08-02T18:00:00Z', 'won', 'Otra dependencia', null, 99999999, 'MXN')
on conflict do nothing;

insert into licitaciones.go_no_go_decision (id, organization_id, tender_id, decision, reasons, match_score, match_eligibility_status, match_inputs_hash, decided_by, decided_at) values
  ('00000000-0000-0000-0000-0000000f1201', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1001', 'go', array['Experiencia comprobable','Otro']::text[], 87.5, 'cumple', 'h1', '00000000-0000-0000-0000-000000000071', '2026-09-20T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1202', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1010', 'no_go', array['Fuera de giro']::text[], 31, 'no_cumple', 'h2', '00000000-0000-0000-0000-000000000071', '2026-09-18T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1203', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1002', 'go', array['Antigua']::text[], 60, 'cumple', 'h3', '00000000-0000-0000-0000-000000000071', '2026-08-15T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1204', '00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-0000000f1101', 'go', array['Ajena']::text[], 99, 'cumple', 'h4', '00000000-0000-0000-0000-000000000073', '2026-09-20T18:00:00Z')
on conflict do nothing;

insert into licitaciones.proposal (id, organization_id, tender_id, title) values
  ('00000000-0000-0000-0000-0000000f1301', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1001', 'Propuesta uniformes'),
  ('00000000-0000-0000-0000-0000000f1302', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1006', 'Propuesta presentada'),
  ('00000000-0000-0000-0000-0000000f1303', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1008', 'Propuesta ganadora'),
  ('00000000-0000-0000-0000-0000000f1304', '00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-0000000f1101', 'Propuesta ajena')
on conflict do nothing;
insert into licitaciones.submission (id, organization_id, proposal_id, submitted_at) values
  ('00000000-0000-0000-0000-0000000f1311', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1302', '2026-09-28T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1312', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1303', '2026-07-30T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1313', '00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-0000000f1304', '2026-09-28T18:00:00Z')
on conflict do nothing;

insert into licitaciones.tender_resolution (id, organization_id, tender_id, resolution, from_status, reason, resolved_by, resolved_at) values
  ('00000000-0000-0000-0000-0000000f1401', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1008', 'won', 'submitted', 'Adjudicada', '00000000-0000-0000-0000-000000000071', '2026-09-10T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1402', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1009', 'lost', 'submitted', 'Precio', '00000000-0000-0000-0000-000000000071', '2026-09-02T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1403', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1003', 'lost', 'submitted', 'Antigua', '00000000-0000-0000-0000-000000000071', '2026-07-01T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1404', '00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-0000000f1102', 'won', 'submitted', 'Ajena', '00000000-0000-0000-0000-000000000073', '2026-09-10T18:00:00Z')
on conflict do nothing;

-- Contratos: c1 (ganada) fin 15-nov con opcion de renovacion y alerta pendiente (47 dias) · c2 fin 1-dic (63) · c3 fin 1-jun-2027 (fuera de 90 dias)
--            c4 CERRADO fin 30-oct · c5 sin fecha de fin · c6 fin 28-sep (ya paso) · c7 B ajeno
insert into licitaciones.contract (id, organization_id, tender_id, status, end_date, contract_number, has_renewal_option) values
  ('00000000-0000-0000-0000-0000000f1501', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1008', 'en_ejecucion', '2026-11-15', 'IMSS-2025-044', true),
  ('00000000-0000-0000-0000-0000000f1502', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1006', 'adjudicado', '2026-12-01', null, false),
  ('00000000-0000-0000-0000-0000000f1503', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1002', 'en_ejecucion', '2027-06-01', 'LIM-1', false),
  ('00000000-0000-0000-0000-0000000f1504', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1010', 'cerrado', '2026-10-30', 'CER-1', false),
  ('00000000-0000-0000-0000-0000000f1505', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1011', 'adjudicado', null, 'SIN-FIN', false),
  ('00000000-0000-0000-0000-0000000f1506', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1003', 'en_ejecucion', '2026-09-28', 'PASO-1', false),
  ('00000000-0000-0000-0000-0000000f1507', '00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-0000000f1101', 'en_ejecucion', '2026-11-01', 'B-1', true)
on conflict do nothing;
insert into licitaciones.renewal_alert (id, organization_id, contract_id, tender_id, predicted_date, lead_days, confidence, status) values
  ('00000000-0000-0000-0000-0000000f1601', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1501', '00000000-0000-0000-0000-0000000f1008', '2026-11-15', 60, 0.80, 'pendiente'),
  ('00000000-0000-0000-0000-0000000f1602', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1502', '00000000-0000-0000-0000-0000000f1006', '2026-12-01', 60, 0.80, 'reconocida')
on conflict do nothing;

insert into licitaciones.tenant_config (organization_id, timezone) values
  ('00000000-0000-0000-0000-00000000d201', 'America/Cancun'), ('00000000-0000-0000-0000-00000000d202', 'America/Tijuana')
on conflict do nothing;

\echo ''
\echo '=== A) DESPACHOS ==='
\echo ''
\echo '--- 1. clientes visibles: admin A ve sus 2 clientes (no el de otro despacho) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.id as property_id, p.name
   from core.property p
   where p.organization_id = $1 and p.vertical = 'despachos' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 200) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[] into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'name') = 'Abarrotes La Esquina SA de CV' and (v->1->>'name') = 'Taller Mecánico Peninsular') then raise exception 'esperaba 2 clientes: %', v; end if;
end $do$;
rollback;
\echo '--- 2. clientes visibles: el contador del Taller SI ve exactamente 1 cliente (Taller) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000062', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.id as property_id, p.name
   from core.property p
   where p.organization_id = $1 and p.vertical = 'despachos' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 200) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[] into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'name') = 'Taller Mecánico Peninsular') then raise exception 'esperaba solo el Taller: %', v; end if;
end $do$;
rollback;
\echo '--- 3. cartera por cliente (hoy 2026-09-29): Abarrotes 3 cuentas $4,060 con 2 vencidas $3,480; Taller 1 cuenta $232 vencida; la PAGADA y el otro despacho no cuentan ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente,
    count(*) as cuentas_pendientes,
    coalesce(sum(i.total), 0) as monto_pendiente,
    count(*) filter (where r.fecha_vencimiento < $3::date) as cuentas_vencidas,
    coalesce(sum(i.total) filter (where r.fecha_vencimiento < $3::date), 0) as monto_vencido
  from despachos.receivable r
  join despachos.invoice i on i.id = r.invoice_id
  join core.property p on p.id = r.property_id
  where r.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or r.property_id = any($2::uuid[])) and r.pagado_en is null
  group by p.id, p.name
  order by monto_pendiente desc, p.name
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'cliente') = 'Abarrotes La Esquina SA de CV' and (v->0->>'cuentas_pendientes')::int = 3 and (v->0->>'monto_pendiente')::numeric = 4060 and (v->0->>'cuentas_vencidas')::int = 2 and (v->0->>'monto_vencido')::numeric = 3480 and (v->1->>'cliente') = 'Taller Mecánico Peninsular' and (v->1->>'monto_pendiente')::numeric = 232 and (v->1->>'monto_vencido')::numeric = 232) then raise exception 'cartera inesperada: %', v; end if;
end $do$;
rollback;
\echo '--- 4. cartera: el contador del Taller pasando null (app equivocada) solo ve $232 del Taller (RLS has_property_access) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000062', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente,
    count(*) as cuentas_pendientes,
    coalesce(sum(i.total), 0) as monto_pendiente,
    count(*) filter (where r.fecha_vencimiento < $3::date) as cuentas_vencidas,
    coalesce(sum(i.total) filter (where r.fecha_vencimiento < $3::date), 0) as monto_vencido
  from despachos.receivable r
  join despachos.invoice i on i.id = r.invoice_id
  join core.property p on p.id = r.property_id
  where r.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or r.property_id = any($2::uuid[])) and r.pagado_en is null
  group by p.id, p.name
  order by monto_pendiente desc, p.name
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'cliente') = 'Taller Mecánico Peninsular' and (v->0->>'monto_pendiente')::numeric = 232) then raise exception 'cross-cliente por null: %', v; end if;
end $do$;
rollback;
\echo '--- 5. cartera: el contador del Taller pidiendo el id de Abarrotes -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000062', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente,
    count(*) as cuentas_pendientes,
    coalesce(sum(i.total), 0) as monto_pendiente,
    count(*) filter (where r.fecha_vencimiento < $3::date) as cuentas_vencidas,
    coalesce(sum(i.total) filter (where r.fecha_vencimiento < $3::date), 0) as monto_vencido
  from despachos.receivable r
  join despachos.invoice i on i.id = r.invoice_id
  join core.property p on p.id = r.property_id
  where r.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or r.property_id = any($2::uuid[])) and r.pagado_en is null
  group by p.id, p.name
  order by monto_pendiente desc, p.name
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, array['00000000-0000-0000-0000-00000000e101'::uuid]::uuid[], '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-cliente por id: %', v; end if;
end $do$;
rollback;
\echo '--- 6. cartera cross-tenant: admin B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000063', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente,
    count(*) as cuentas_pendientes,
    coalesce(sum(i.total), 0) as monto_pendiente,
    count(*) filter (where r.fecha_vencimiento < $3::date) as cuentas_vencidas,
    coalesce(sum(i.total) filter (where r.fecha_vencimiento < $3::date), 0) as monto_vencido
  from despachos.receivable r
  join despachos.invoice i on i.id = r.invoice_id
  join core.property p on p.id = r.property_id
  where r.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or r.property_id = any($2::uuid[])) and r.pagado_en is null
  group by p.id, p.name
  order by monto_pendiente desc, p.name
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant: %', v; end if;
end $do$;
rollback;
\echo '--- 7. cartera cross-tenant (sentido inverso): admin A pidiendo la organizacion B y el cliente de B -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente,
    count(*) as cuentas_pendientes,
    coalesce(sum(i.total), 0) as monto_pendiente,
    count(*) filter (where r.fecha_vencimiento < $3::date) as cuentas_vencidas,
    coalesce(sum(i.total) filter (where r.fecha_vencimiento < $3::date), 0) as monto_vencido
  from despachos.receivable r
  join despachos.invoice i on i.id = r.invoice_id
  join core.property p on p.id = r.property_id
  where r.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or r.property_id = any($2::uuid[])) and r.pagado_en is null
  group by p.id, p.name
  order by monto_pendiente desc, p.name
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d102'::uuid, array['00000000-0000-0000-0000-00000000e103'::uuid]::uuid[], '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant inverso: %', v; end if;
end $do$;
rollback;
\echo '--- 8. antiguedad de cobranza: Vigente 1/$580 · 1 a 30 días 2/$1,392 · más de 90 días 1/$2,320, en ese orden ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select b.bucket, count(*) as cuentas, coalesce(sum(b.total), 0) as monto
  from (
    select case
        when r.fecha_vencimiento >= $3::date then 'Vigente (aún no vence)'
        when $3::date - r.fecha_vencimiento <= 30 then '1 a 30 días vencida'
        when $3::date - r.fecha_vencimiento <= 60 then '31 a 60 días vencida'
        when $3::date - r.fecha_vencimiento <= 90 then '61 a 90 días vencida'
        else 'Más de 90 días vencida'
      end as bucket,
      case
        when r.fecha_vencimiento >= $3::date then 0
        when $3::date - r.fecha_vencimiento <= 30 then 1
        when $3::date - r.fecha_vencimiento <= 60 then 2
        when $3::date - r.fecha_vencimiento <= 90 then 3
        else 4
      end as orden,
      i.total
    from despachos.receivable r
    join despachos.invoice i on i.id = r.invoice_id
    join core.property p on p.id = r.property_id
    where r.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or r.property_id = any($2::uuid[])) and r.pagado_en is null
  ) b
  group by b.bucket, b.orden
  order by b.orden) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date into v;
  if not (jsonb_array_length(v) = 3 and (v->0->>'bucket') = 'Vigente (aún no vence)' and (v->0->>'monto')::numeric = 580 and (v->1->>'bucket') = '1 a 30 días vencida' and (v->1->>'cuentas')::int = 2 and (v->1->>'monto')::numeric = 1392 and (v->2->>'bucket') = 'Más de 90 días vencida' and (v->2->>'monto')::numeric = 2320) then raise exception 'antiguedad inesperada: %', v; end if;
end $do$;
rollback;
\echo '--- 9. CFDI por periodo (1-29 sep): Ingreso 4 (total $4,292, 1 con hallazgos, 1 en revisión) y Nómina 1 ($3,000); el CFDI del 31-ago y el otro despacho no cuentan ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select i.tipo, count(*) as cfdi, coalesce(sum(i.total), 0) as total,
    count(*) filter (where not i.valido) as invalidos,
    count(*) filter (where i.requires_human_review) as en_revision
  from despachos.invoice i
  join core.property p on p.id = i.property_id
  where i.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or i.property_id = any($2::uuid[])) and i.fecha >= $3::date and i.fecha <= $4::date
  group by i.tipo
  order by i.tipo
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'tipo') = 'I' and (v->0->>'cfdi')::int = 4 and (v->0->>'total')::numeric = 4292 and (v->0->>'invalidos')::int = 1 and (v->0->>'en_revision')::int = 1 and (v->1->>'tipo') = 'N' and (v->1->>'total')::numeric = 3000) then raise exception 'cfdi inesperado: %', v; end if;
end $do$;
rollback;
\echo '--- 10. CFDI cross-tenant: admin B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000063', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select i.tipo, count(*) as cfdi, coalesce(sum(i.total), 0) as total,
    count(*) filter (where not i.valido) as invalidos,
    count(*) filter (where i.requires_human_review) as en_revision
  from despachos.invoice i
  join core.property p on p.id = i.property_id
  where i.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or i.property_id = any($2::uuid[])) and i.fecha >= $3::date and i.fecha <= $4::date
  group by i.tipo
  order by i.tipo
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant cfdi: %', v; end if;
end $do$;
rollback;
\echo '--- 11. IVA acreditable (sep): solo CFDI I VÁLIDOS: Abarrotes 2 CFDI base $3,000 IVA $480 (el inválido de $80 excluido); Taller $32 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente, count(*) as cfdi,
    coalesce(sum(i.subtotal), 0) as base, coalesce(sum(i.iva), 0) as iva_acreditable
  from despachos.invoice i
  join core.property p on p.id = i.property_id
  where i.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or i.property_id = any($2::uuid[])) and i.fecha >= $3::date and i.fecha <= $4::date
    and i.tipo = 'I' and i.valido
  group by p.id, p.name
  order by iva_acreditable desc, p.name
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'cliente') = 'Abarrotes La Esquina SA de CV' and (v->0->>'cfdi')::int = 2 and (v->0->>'base')::numeric = 3000 and (v->0->>'iva_acreditable')::numeric = 480 and (v->1->>'iva_acreditable')::numeric = 32) then raise exception 'iva inesperado: %', v; end if;
end $do$;
rollback;
\echo '--- 12. IVA: el contador del Taller solo ve el IVA de su cliente ($32) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000062', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente, count(*) as cfdi,
    coalesce(sum(i.subtotal), 0) as base, coalesce(sum(i.iva), 0) as iva_acreditable
  from despachos.invoice i
  join core.property p on p.id = i.property_id
  where i.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or i.property_id = any($2::uuid[])) and i.fecha >= $3::date and i.fecha <= $4::date
    and i.tipo = 'I' and i.valido
  group by p.id, p.name
  order by iva_acreditable desc, p.name
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'iva_acreditable')::numeric = 32) then raise exception 'cross-cliente iva: %', v; end if;
end $do$;
rollback;
\echo '--- 13. obligaciones fiscales (1-sep..31-oct, hoy 29-sep): DIOT 17-sep 'vencido' (calculado aunque siga 'pendiente'), IVA 17-oct 'pendiente', Taller ISR 'completado'; el otro despacho no aparece ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente, d.tipo, d.periodo,
    to_char(d.fecha_limite, 'YYYY-MM-DD') as fecha_limite,
    case when d.estado = 'completado' then 'completado'
         when d.fecha_limite < $5::date then 'vencido'
         else d.estado end as estado,
    d.prioridad
  from despachos.fiscal_deadline d
  join core.property p on p.id = d.property_id
  where d.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or d.property_id = any($2::uuid[])) and d.fecha_limite >= $3::date and d.fecha_limite <= $4::date
  order by d.fecha_limite asc, p.name, d.tipo
  limit $6) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-01'::date, '2026-10-31'::date, '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 3 and (v->0->>'tipo') = 'DIOT' and (v->0->>'estado') = 'vencido' and (v->0->>'fecha_limite') = '2026-09-17' and (v->1->>'tipo') = 'ISR' and (v->1->>'estado') = 'completado' and (v->2->>'tipo') = 'IVA' and (v->2->>'estado') = 'pendiente') then raise exception 'obligaciones inesperadas: %', v; end if;
end $do$;
rollback;
\echo '--- 14. cierres pendientes: Abarrotes ago-2026 VENCIDO con 3 tareas, 2 pendientes y 1 vencida; Taller sep-2026 abierto sin tareas; el cerrado (jul) y el de otro despacho no aparecen ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente, c.anio, c.mes, c.status,
    count(t.id) as tareas_total,
    count(t.id) filter (where t.status in ('pending', 'in_progress', 'blocked')) as tareas_pendientes,
    count(t.id) filter (where t.status in ('pending', 'in_progress', 'blocked') and t.due_date < $3::date) as tareas_vencidas
  from despachos.periodo_cierre c
  join core.property p on p.id = c.property_id
  left join despachos.periodo_cierre_tarea t on t.periodo_cierre_id = c.id
  where c.organization_id = $1 and p.vertical = 'despachos'
    and ($2::uuid[] is null or c.property_id = any($2::uuid[])) and c.status <> 'closed'
  group by c.id, p.name, c.anio, c.mes, c.status
  order by c.anio asc, c.mes asc, p.name
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'cliente') = 'Abarrotes La Esquina SA de CV' and (v->0->>'mes')::int = 8 and (v->0->>'status') = 'overdue' and (v->0->>'tareas_total')::int = 3 and (v->0->>'tareas_pendientes')::int = 2 and (v->0->>'tareas_vencidas')::int = 1 and (v->1->>'cliente') = 'Taller Mecánico Peninsular' and (v->1->>'tareas_total')::int = 0) then raise exception 'cierres inesperados: %', v; end if;
end $do$;
rollback;
\echo '--- 15. carga de trabajo por cliente: Abarrotes 1 revisión, 2 vencimientos abiertos (1 vencido), 2 tareas de cierre; Taller todo en 0 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente,
    (select count(*) from despachos.invoice_review rv where rv.property_id = p.id and rv.status = 'pendiente') as revisiones_pendientes,
    (select count(*) from despachos.fiscal_deadline d where d.property_id = p.id and d.estado <> 'completado') as vencimientos_abiertos,
    (select count(*) from despachos.fiscal_deadline d where d.property_id = p.id and d.estado <> 'completado' and d.fecha_limite < $3::date) as vencimientos_vencidos,
    (select count(*) from despachos.periodo_cierre_tarea t join despachos.periodo_cierre c on c.id = t.periodo_cierre_id
       where c.property_id = p.id and c.status <> 'closed' and t.status in ('pending', 'in_progress', 'blocked')) as tareas_cierre_pendientes
  from core.property p
  where p.organization_id = $1 and p.vertical = 'despachos' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
  order by vencimientos_vencidos desc, revisiones_pendientes desc, p.name
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'cliente') = 'Abarrotes La Esquina SA de CV' and (v->0->>'revisiones_pendientes')::int = 1 and (v->0->>'vencimientos_abiertos')::int = 2 and (v->0->>'vencimientos_vencidos')::int = 1 and (v->0->>'tareas_cierre_pendientes')::int = 2 and (v->1->>'vencimientos_abiertos')::int = 0 and (v->1->>'tareas_cierre_pendientes')::int = 0) then raise exception 'carga inesperada: %', v; end if;
end $do$;
rollback;
\echo '--- 16. carga: el contador del Taller solo ve a su cliente (los subselect tambien respetan RLS) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000062', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select p.name as cliente,
    (select count(*) from despachos.invoice_review rv where rv.property_id = p.id and rv.status = 'pendiente') as revisiones_pendientes,
    (select count(*) from despachos.fiscal_deadline d where d.property_id = p.id and d.estado <> 'completado') as vencimientos_abiertos,
    (select count(*) from despachos.fiscal_deadline d where d.property_id = p.id and d.estado <> 'completado' and d.fecha_limite < $3::date) as vencimientos_vencidos,
    (select count(*) from despachos.periodo_cierre_tarea t join despachos.periodo_cierre c on c.id = t.periodo_cierre_id
       where c.property_id = p.id and c.status <> 'closed' and t.status in ('pending', 'in_progress', 'blocked')) as tareas_cierre_pendientes
  from core.property p
  where p.organization_id = $1 and p.vertical = 'despachos' and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
  order by vencimientos_vencidos desc, revisiones_pendientes desc, p.name
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'cliente') = 'Taller Mecánico Peninsular') then raise exception 'cross-cliente carga: %', v; end if;
end $do$;
rollback;
\echo '--- 17. lista 69-B: efos_invoices_afectados de Abarrotes devuelve el CFDI del emisor DEFINITIVO (1 fila, $2,320) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select out_rfc_emisor, out_emisor_nombre, out_fecha, out_total, out_situacion, out_periodo_lista
  from despachos.efos_invoices_afectados($1::uuid)) t$q$ using '00000000-0000-0000-0000-00000000e101'::uuid into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'out_rfc_emisor') = 'AAA010101AAA' and (v->0->>'out_situacion') = 'definitivo' and (v->0->>'out_total')::numeric = 2320) then raise exception 'efos inesperado: %', v; end if;
end $do$;
rollback;
\echo '--- 18. lista 69-B: efos_estado devuelve la edición cargada 2026-09 al staff de despachos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select out_periodo from despachos.efos_estado()) t$q$ into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'out_periodo') = '2026-09') then raise exception 'efos_estado: %', v; end if;
end $do$;
rollback;
\echo '--- 19. el contador del Taller NO puede consultar la 69-B de Abarrotes (sin acceso a la property -> 42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000062', true);
select count(*) as should_fail from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000e101'::uuid);
rollback;
\echo '--- 20. admin B (otro despacho) NO puede consultar la 69-B de una property de A (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000063', true);
select count(*) as should_fail from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000e101'::uuid);
rollback;
\echo '--- 21. staff de LICITACIONES no puede usar las funciones EFOS de despachos (efos_estado -> 42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
select count(*) as should_fail from despachos.efos_estado();
rollback;
\echo '--- 22. anon NO puede ejecutar efos_invoices_afectados (sin GRANT) ---'
begin;
set local role anon;
select count(*) as should_fail from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000e101'::uuid);
rollback;
\echo '--- 23. anon NO puede leer despachos.receivable (revocado) ---'
begin;
set local role anon;
select count(*) as should_fail from despachos.receivable;
rollback;
\echo '--- 24. anon NO puede leer despachos.invoice (revocado) ---'
begin;
set local role anon;
select count(*) as should_fail from despachos.invoice;
rollback;
\echo '--- 25. anon NO puede leer despachos.periodo_cierre (revocado) ---'
begin;
set local role anon;
select count(*) as should_fail from despachos.periodo_cierre;
rollback;
\echo '--- 26. las tablas efos_* NO son legibles ni por staff autenticado (solo via funcion security definer) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
select count(*) as should_fail from despachos.efos_contribuyente;
rollback;
\echo ''
\echo '=== B) LICITACIONES ==='
\echo ''
\echo '--- 27. zona horaria: el owner A lee America/Cancun de SU tenant_config (1 fila, no la de B) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select c.timezone from licitaciones.tenant_config c where c.organization_id = $1 limit $2) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 2::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'timezone') = 'America/Cancun') then raise exception 'tenant_config: %', v; end if;
end $do$;
rollback;
\echo '--- 28. zona horaria cross-tenant: owner B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000073', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select c.timezone from licitaciones.tenant_config c where c.organization_id = $1 limit $2) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 2::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant tz: %', v; end if;
end $do$;
rollback;
\echo '--- 29. convocatorias abiertas (ahora = 29-sep 23:30 Mérida): 5 abiertas ordenadas por fecha límite; la vencida, la presentada, ganada, perdida, no-go y cancelada NO aparecen; la 'cierra a las 23:45 locales' tiene 0 días (fecha LOCAL, no UTC) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, t.state as entidad, t.status,
    to_char(t.submission_deadline at time zone $2::text, 'YYYY-MM-DD HH24:MI') as fecha_limite,
    case when t.submission_deadline is null then null
         else ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date end as dias_restantes,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn,
    t.currency as moneda
  from licitaciones.tender t
  where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
    and (t.submission_deadline is null or t.submission_deadline >= $3::timestamptz)
    and ($4::int is null or (t.submission_deadline is not null
         and ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= $4::int))
  order by t.submission_deadline asc nulls last, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, null::int, 51::int into v;
  if not (jsonb_array_length(v) = 5 and (v->0->>'titulo') = 'Cierra hoy a las 23:45 locales' and (v->0->>'dias_restantes')::int = 0 and (v->0->>'fecha_limite') = '2026-09-29 23:45' and (v->1->>'titulo') = 'Uniformes escolares' and (v->1->>'dias_restantes')::int = 2 and (v->1->>'monto_mxn')::numeric = 1250000.50 and (v->2->>'titulo') = 'Amarillo' and (v->2->>'dias_restantes')::int = 6 and (v->3->>'titulo') = 'Limpieza hospitalaria' and (v->3->>'dias_restantes')::int = 21 and (v->4->>'titulo') = 'Equipo de computo en dolares' and (v->4->>'fecha_limite') is null and (v->4->>'monto_mxn') is null and (v->4->>'moneda') = 'USD') then raise exception 'abiertas inesperadas: %', v; end if;
end $do$;
rollback;
\echo '--- 30. convocatorias por vencer en 7 días: solo las 3 con fecha límite <= 7 días (la sin fecha queda fuera) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, t.state as entidad, t.status,
    to_char(t.submission_deadline at time zone $2::text, 'YYYY-MM-DD HH24:MI') as fecha_limite,
    case when t.submission_deadline is null then null
         else ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date end as dias_restantes,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn,
    t.currency as moneda
  from licitaciones.tender t
  where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
    and (t.submission_deadline is null or t.submission_deadline >= $3::timestamptz)
    and ($4::int is null or (t.submission_deadline is not null
         and ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= $4::int))
  order by t.submission_deadline asc nulls last, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, 7::int, 51::int into v;
  if not (jsonb_array_length(v) = 3 and (v->2->>'titulo') = 'Amarillo') then raise exception 'por vencer: %', v; end if;
end $do$;
rollback;
\echo '--- 31. convocatorias: el tope de filas se respeta (limit 2 -> 2 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, t.state as entidad, t.status,
    to_char(t.submission_deadline at time zone $2::text, 'YYYY-MM-DD HH24:MI') as fecha_limite,
    case when t.submission_deadline is null then null
         else ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date end as dias_restantes,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn,
    t.currency as moneda
  from licitaciones.tender t
  where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
    and (t.submission_deadline is null or t.submission_deadline >= $3::timestamptz)
    and ($4::int is null or (t.submission_deadline is not null
         and ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= $4::int))
  order by t.submission_deadline asc nulls last, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, null::int, 2::int into v;
  if not (jsonb_array_length(v) = 2) then raise exception 'tope de filas: %', v; end if;
end $do$;
rollback;
\echo '--- 32. convocatorias cross-tenant: owner B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000073', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, t.state as entidad, t.status,
    to_char(t.submission_deadline at time zone $2::text, 'YYYY-MM-DD HH24:MI') as fecha_limite,
    case when t.submission_deadline is null then null
         else ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date end as dias_restantes,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn,
    t.currency as moneda
  from licitaciones.tender t
  where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
    and (t.submission_deadline is null or t.submission_deadline >= $3::timestamptz)
    and ($4::int is null or (t.submission_deadline is not null
         and ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= $4::int))
  order by t.submission_deadline asc nulls last, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, null::int, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant abiertas: %', v; end if;
end $do$;
rollback;
\echo '--- 33. convocatorias (sentido inverso): owner B solo ve la suya cuando pide su organizacion, jamas las de A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000073', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, t.state as entidad, t.status,
    to_char(t.submission_deadline at time zone $2::text, 'YYYY-MM-DD HH24:MI') as fecha_limite,
    case when t.submission_deadline is null then null
         else ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date end as dias_restantes,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn,
    t.currency as moneda
  from licitaciones.tender t
  where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
    and (t.submission_deadline is null or t.submission_deadline >= $3::timestamptz)
    and ($4::int is null or (t.submission_deadline is not null
         and ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= $4::int))
  order by t.submission_deadline asc nulls last, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, null::int, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'titulo') = 'Convocatoria ajena B') then raise exception 'aislamiento B: %', v; end if;
end $do$;
rollback;
\echo '--- 34. convocatorias: staff de DESPACHOS (otra vertical) pidiendo la organizacion de licitaciones A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, t.state as entidad, t.status,
    to_char(t.submission_deadline at time zone $2::text, 'YYYY-MM-DD HH24:MI') as fecha_limite,
    case when t.submission_deadline is null then null
         else ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date end as dias_restantes,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn,
    t.currency as moneda
  from licitaciones.tender t
  where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
    and (t.submission_deadline is null or t.submission_deadline >= $3::timestamptz)
    and ($4::int is null or (t.submission_deadline is not null
         and ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= $4::int))
  order by t.submission_deadline asc nulls last, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, null::int, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-vertical: %', v; end if;
end $do$;
rollback;
\echo '--- 35. convocatorias: el rol viewer PUEDE leer (can_access_org: lectura para todo miembro) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000072', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, t.state as entidad, t.status,
    to_char(t.submission_deadline at time zone $2::text, 'YYYY-MM-DD HH24:MI') as fecha_limite,
    case when t.submission_deadline is null then null
         else ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date end as dias_restantes,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn,
    t.currency as moneda
  from licitaciones.tender t
  where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
    and (t.submission_deadline is null or t.submission_deadline >= $3::timestamptz)
    and ($4::int is null or (t.submission_deadline is not null
         and ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= $4::int))
  order by t.submission_deadline asc nulls last, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, null::int, 51::int into v;
  if not (jsonb_array_length(v) = 5) then raise exception 'viewer lee: %', v; end if;
end $do$;
rollback;
\echo '--- 36. semáforo: Vencida 1 · Rojo 2 · Amarillo 1 · Verde 1 · Sin fecha 1, en ese orden ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select b.semaforo, count(*) as convocatorias
  from (
    select case
        when t.submission_deadline is null then 'Sin fecha límite registrada'
        when t.submission_deadline < $3::timestamptz then 'Vencida sin presentar'
        when ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= 3 then 'Rojo (3 días o menos)'
        when ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= 7 then 'Amarillo (4 a 7 días)'
        else 'Verde (más de 7 días)'
      end as semaforo,
      case
        when t.submission_deadline is null then 5
        when t.submission_deadline < $3::timestamptz then 0
        when ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= 3 then 1
        when ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= 7 then 2
        else 3
      end as orden
    from licitaciones.tender t
    where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
  ) b
  group by b.semaforo, b.orden
  order by b.orden
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, 10::int into v;
  if not (jsonb_array_length(v) = 5 and (v->0->>'semaforo') = 'Vencida sin presentar' and (v->0->>'convocatorias')::int = 1 and (v->1->>'semaforo') = 'Rojo (3 días o menos)' and (v->1->>'convocatorias')::int = 2 and (v->2->>'semaforo') = 'Amarillo (4 a 7 días)' and (v->3->>'semaforo') = 'Verde (más de 7 días)' and (v->4->>'semaforo') = 'Sin fecha límite registrada') then raise exception 'semaforo inesperado: %', v; end if;
end $do$;
rollback;
\echo '--- 37. semáforo cross-tenant: owner B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000073', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select b.semaforo, count(*) as convocatorias
  from (
    select case
        when t.submission_deadline is null then 'Sin fecha límite registrada'
        when t.submission_deadline < $3::timestamptz then 'Vencida sin presentar'
        when ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= 3 then 'Rojo (3 días o menos)'
        when ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= 7 then 'Amarillo (4 a 7 días)'
        else 'Verde (más de 7 días)'
      end as semaforo,
      case
        when t.submission_deadline is null then 5
        when t.submission_deadline < $3::timestamptz then 0
        when ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= 3 then 1
        when ((t.submission_deadline) at time zone $2::text)::date - (($3::timestamptz) at time zone $2::text)::date <= 7 then 2
        else 3
      end as orden
    from licitaciones.tender t
    where t.organization_id = $1 and t.status in ('discovered', 'in_review', 'go', 'in_progress')
  ) b
  group by b.semaforo, b.orden
  order by b.orden
  limit $4) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, 10::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant semaforo: %', v; end if;
end $do$;
rollback;
\echo '--- 38. go/no-go (septiembre en Mérida): 2 decisiones, la más reciente primero, con primer motivo; la de agosto y la de B no aparecen ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, g.decision, g.match_eligibility_status as elegibilidad, g.match_score as puntaje,
    to_char(g.decided_at at time zone $2::text, 'YYYY-MM-DD') as fecha, g.reasons[1] as motivo
  from licitaciones.go_no_go_decision g
  join licitaciones.tender t on t.id = g.tender_id and t.organization_id = g.organization_id
  where g.organization_id = $1 and g.decided_at >= $3::timestamptz and g.decided_at < $4::timestamptz
  order by g.decided_at desc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-01T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'titulo') = 'Uniformes escolares' and (v->0->>'decision') = 'go' and (v->0->>'motivo') = 'Experiencia comprobable' and (v->0->>'puntaje')::numeric = 87.5 and (v->1->>'decision') = 'no_go' and (v->1->>'elegibilidad') = 'no_cumple') then raise exception 'gonogo inesperado: %', v; end if;
end $do$;
rollback;
\echo '--- 39. go/no-go cross-tenant: owner B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000073', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, g.decision, g.match_eligibility_status as elegibilidad, g.match_score as puntaje,
    to_char(g.decided_at at time zone $2::text, 'YYYY-MM-DD') as fecha, g.reasons[1] as motivo
  from licitaciones.go_no_go_decision g
  join licitaciones.tender t on t.id = g.tender_id and t.organization_id = g.organization_id
  where g.organization_id = $1 and g.decided_at >= $3::timestamptz and g.decided_at < $4::timestamptz
  order by g.decided_at desc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-01-01T06:00:00Z'::timestamptz, '2026-12-31T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant gonogo: %', v; end if;
end $do$;
rollback;
\echo '--- 40. propuestas por estado: presentada 1/1 · en elaboración 1/0 · ganada 1/1 (la de B no cuenta) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.status, count(*) as propuestas,
    count(*) filter (where exists (
      select 1 from licitaciones.submission s where s.proposal_id = p.id and s.organization_id = p.organization_id
    )) as presentadas
  from licitaciones.proposal p
  join licitaciones.tender t on t.id = p.tender_id and t.organization_id = p.organization_id
  where p.organization_id = $1
  group by t.status
  order by propuestas desc, t.status asc
  limit $2) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 51::int into v;
  if not (jsonb_array_length(v) = 3 and (select sum((e->>'propuestas')::int) from jsonb_array_elements(v) e) = 3 and (select sum((e->>'presentadas')::int) from jsonb_array_elements(v) e) = 2 and (select (e->>'presentadas')::int from jsonb_array_elements(v) e where e->>'status' = 'in_progress') = 0) then raise exception 'propuestas inesperadas: %', v; end if;
end $do$;
rollback;
\echo '--- 41. propuestas cross-tenant: owner B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000073', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.status, count(*) as propuestas,
    count(*) filter (where exists (
      select 1 from licitaciones.submission s where s.proposal_id = p.id and s.organization_id = p.organization_id
    )) as presentadas
  from licitaciones.proposal p
  join licitaciones.tender t on t.id = p.tender_id and t.organization_id = p.organization_id
  where p.organization_id = $1
  group by t.status
  order by propuestas desc, t.status asc
  limit $2) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant propuestas: %', v; end if;
end $do$;
rollback;
\echo '--- 42. fallos (septiembre): Ganada (monto MXN $900,000) y Perdida en dólares SIN monto; el de julio y el de B no aparecen ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, r.resolution as resultado,
    to_char(r.resolved_at at time zone $2::text, 'YYYY-MM-DD') as fecha,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn
  from licitaciones.tender_resolution r
  join licitaciones.tender t on t.id = r.tender_id and t.organization_id = r.organization_id
  where r.organization_id = $1 and r.resolved_at >= $3::timestamptz and r.resolved_at < $4::timestamptz
  order by r.resolved_at desc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-01T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'resultado') = 'won' and (v->0->>'monto_mxn')::numeric = 900000 and (v->0->>'fecha') = '2026-09-10' and (v->1->>'resultado') = 'lost' and (v->1->>'monto_mxn') is null) then raise exception 'fallos inesperados: %', v; end if;
end $do$;
rollback;
\echo '--- 43. fallos cross-tenant: owner B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000073', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select t.title as titulo, t.contracting_body as dependencia, r.resolution as resultado,
    to_char(r.resolved_at at time zone $2::text, 'YYYY-MM-DD') as fecha,
    case when t.currency = 'MXN' then t.budget_amount end as monto_mxn
  from licitaciones.tender_resolution r
  join licitaciones.tender t on t.id = r.tender_id and t.organization_id = r.organization_id
  where r.organization_id = $1 and r.resolved_at >= $3::timestamptz and r.resolved_at < $4::timestamptz
  order by r.resolved_at desc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-01-01T06:00:00Z'::timestamptz, '2026-12-31T06:00:00Z'::timestamptz, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant fallos: %', v; end if;
end $do$;
rollback;
\echo '--- 44. renovaciones (90 días): c1 a 47 días con opción de renovación y alerta pendiente, c2 a 63 días con alerta RECONOCIDA (no pendiente); cerrado, sin fecha, ya vencido, fuera de 90 días y de B no aparecen ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select c.contract_number as contrato, t.title as titulo, t.contracting_body as dependencia,
    to_char(c.end_date, 'YYYY-MM-DD') as fin_vigencia,
    c.end_date - (($3::timestamptz) at time zone $2::text)::date as dias_restantes,
    c.has_renewal_option as opcion_renovacion, c.status,
    exists (
      select 1 from licitaciones.renewal_alert a
      where a.contract_id = c.id and a.organization_id = c.organization_id and a.status = 'pendiente'
    ) as alerta_pendiente
  from licitaciones.contract c
  join licitaciones.tender t on t.id = c.tender_id and t.organization_id = c.organization_id
  where c.organization_id = $1 and c.end_date is not null
    and c.status not in ('cerrado', 'rescindido')
    and c.end_date >= (($3::timestamptz) at time zone $2::text)::date
    and c.end_date - (($3::timestamptz) at time zone $2::text)::date <= $4::int
  order by c.end_date asc, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, 90::int, 51::int into v;
  if not (jsonb_array_length(v) = 2 and (v->0->>'contrato') = 'IMSS-2025-044' and (v->0->>'dias_restantes')::int = 47 and (v->0->>'opcion_renovacion') = 'true' and (v->0->>'alerta_pendiente') = 'true' and (v->1->>'contrato') is null and (v->1->>'dias_restantes')::int = 63 and (v->1->>'alerta_pendiente') = 'false') then raise exception 'renovaciones inesperadas: %', v; end if;
end $do$;
rollback;
\echo '--- 45. renovaciones: el horizonte es inclusivo (47 días incluye al contrato que vence a 47) y 46 lo excluye ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select c.contract_number as contrato, t.title as titulo, t.contracting_body as dependencia,
    to_char(c.end_date, 'YYYY-MM-DD') as fin_vigencia,
    c.end_date - (($3::timestamptz) at time zone $2::text)::date as dias_restantes,
    c.has_renewal_option as opcion_renovacion, c.status,
    exists (
      select 1 from licitaciones.renewal_alert a
      where a.contract_id = c.id and a.organization_id = c.organization_id and a.status = 'pendiente'
    ) as alerta_pendiente
  from licitaciones.contract c
  join licitaciones.tender t on t.id = c.tender_id and t.organization_id = c.organization_id
  where c.organization_id = $1 and c.end_date is not null
    and c.status not in ('cerrado', 'rescindido')
    and c.end_date >= (($3::timestamptz) at time zone $2::text)::date
    and c.end_date - (($3::timestamptz) at time zone $2::text)::date <= $4::int
  order by c.end_date asc, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, 47::int, 51::int into v;
  if not (jsonb_array_length(v) = 1 and (v->0->>'dias_restantes')::int = 47) then raise exception 'horizonte inclusivo: %', v; end if;
end $do$;
rollback;
\echo '--- 46. renovaciones horizonte 46 -> 0 contratos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select c.contract_number as contrato, t.title as titulo, t.contracting_body as dependencia,
    to_char(c.end_date, 'YYYY-MM-DD') as fin_vigencia,
    c.end_date - (($3::timestamptz) at time zone $2::text)::date as dias_restantes,
    c.has_renewal_option as opcion_renovacion, c.status,
    exists (
      select 1 from licitaciones.renewal_alert a
      where a.contract_id = c.id and a.organization_id = c.organization_id and a.status = 'pendiente'
    ) as alerta_pendiente
  from licitaciones.contract c
  join licitaciones.tender t on t.id = c.tender_id and t.organization_id = c.organization_id
  where c.organization_id = $1 and c.end_date is not null
    and c.status not in ('cerrado', 'rescindido')
    and c.end_date >= (($3::timestamptz) at time zone $2::text)::date
    and c.end_date - (($3::timestamptz) at time zone $2::text)::date <= $4::int
  order by c.end_date asc, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, 46::int, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'horizonte 46: %', v; end if;
end $do$;
rollback;
\echo '--- 47. renovaciones cross-tenant: owner B pidiendo la organizacion A -> 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000073', true);
do $do$
declare v jsonb;
begin
  execute $q$select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select c.contract_number as contrato, t.title as titulo, t.contracting_body as dependencia,
    to_char(c.end_date, 'YYYY-MM-DD') as fin_vigencia,
    c.end_date - (($3::timestamptz) at time zone $2::text)::date as dias_restantes,
    c.has_renewal_option as opcion_renovacion, c.status,
    exists (
      select 1 from licitaciones.renewal_alert a
      where a.contract_id = c.id and a.organization_id = c.organization_id and a.status = 'pendiente'
    ) as alerta_pendiente
  from licitaciones.contract c
  join licitaciones.tender t on t.id = c.tender_id and t.organization_id = c.organization_id
  where c.organization_id = $1 and c.end_date is not null
    and c.status not in ('cerrado', 'rescindido')
    and c.end_date >= (($3::timestamptz) at time zone $2::text)::date
    and c.end_date - (($3::timestamptz) at time zone $2::text)::date <= $4::int
  order by c.end_date asc, t.title asc
  limit $5) t$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, 'America/Merida'::text, '2026-09-30T05:30:00Z'::timestamptz, 365::int, 51::int into v;
  if not (jsonb_array_length(v) = 0) then raise exception 'cross-tenant renovaciones: %', v; end if;
end $do$;
rollback;
\echo '--- 48. anon NO puede leer licitaciones.tender (revocado) ---'
begin;
set local role anon;
select count(*) as should_fail from licitaciones.tender;
rollback;
\echo '--- 49. anon NO puede leer licitaciones.contract (revocado) ---'
begin;
set local role anon;
select count(*) as should_fail from licitaciones.contract;
rollback;
\echo '--- 50. anon NO puede leer licitaciones.go_no_go_decision (revocado) ---'
begin;
set local role anon;
select count(*) as should_fail from licitaciones.go_no_go_decision;
rollback;
\echo '--- 51. anon NO puede leer licitaciones.tender_resolution (revocado) ---'
begin;
set local role anon;
select count(*) as should_fail from licitaciones.tender_resolution;
rollback;
\echo '--- 52. anon NO puede leer licitaciones.proposal (revocado) ---'
begin;
set local role anon;
select count(*) as should_fail from licitaciones.proposal;
rollback;
\echo ''
\echo '=== C) base SIN migrar: SQLSTATE real + SAVEPOINT (mismo mecanismo que runWithSavepointFallback) ==='
\echo ''
\echo '--- 53. despachos: con despachos.receivable ELIMINADA el SQL de cartera falla con 42P01 y la transaccion se recupera (nunca 25P02) ---'
begin;
drop table despachos.receivable cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
savepoint sp_verify_recv;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform * from despachos.receivable where organization_id = '00000000-0000-0000-0000-00000000d101' limit 51;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_recv;
release savepoint sp_verify_recv;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 54. despachos: con la funcion efos_estado ELIMINADA (migracion 014 pendiente) falla con 42883 'function ... does not exist' y la transaccion se recupera ---'
begin;
drop function despachos.efos_estado();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
savepoint sp_verify_efos;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform out_periodo from despachos.efos_estado();
    raise exception 'se esperaba SQLSTATE 42883 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42883' then raise exception 'se esperaba 42883, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_efos;
release savepoint sp_verify_efos;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 55. despachos: con la funcion efos_invoices_afectados ELIMINADA falla con 42883 y la transaccion se recupera ---'
begin;
drop function despachos.efos_invoices_afectados(uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
savepoint sp_verify_efosinv;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform * from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000e101'::uuid);
    raise exception 'se esperaba SQLSTATE 42883 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42883' then raise exception 'se esperaba 42883, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_efosinv;
release savepoint sp_verify_efosinv;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 56. despachos: con despachos.periodo_cierre_tarea ELIMINADA el SQL de cierres/carga falla con 42P01 y la transaccion se recupera ---'
begin;
drop table despachos.periodo_cierre_tarea cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000061', true);
savepoint sp_verify_cierre;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform * from despachos.periodo_cierre_tarea limit 1;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_cierre;
release savepoint sp_verify_cierre;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 57. licitaciones: con tender.contracting_body ELIMINADA (migracion 007 pendiente) el SQL de convocatorias falla con 42703 y la transaccion se recupera ---'
begin;
alter table licitaciones.tender drop column contracting_body cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
savepoint sp_verify_tender;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform contracting_body from licitaciones.tender where organization_id = '00000000-0000-0000-0000-00000000d201' limit 51;
    raise exception 'se esperaba SQLSTATE 42703 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42703' then raise exception 'se esperaba 42703, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_tender;
release savepoint sp_verify_tender;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 58. licitaciones: con licitaciones.tenant_config ELIMINADA (migracion 027 pendiente) la zona horaria falla con 42P01 y la transaccion se recupera ---'
begin;
drop table licitaciones.tenant_config cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
savepoint sp_verify_tz;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform timezone from licitaciones.tenant_config where organization_id = '00000000-0000-0000-0000-00000000d201' limit 1;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_tz;
release savepoint sp_verify_tz;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 59. licitaciones: con licitaciones.renewal_alert ELIMINADA el SQL de renovaciones falla con 42P01 y la transaccion se recupera ---'
begin;
drop table licitaciones.renewal_alert cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', true);
savepoint sp_verify_renov;
do $do$
declare v_state text; v_msg text;
begin
  begin
    perform * from licitaciones.renewal_alert limit 1;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_renov;
release savepoint sp_verify_renov;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo ''
\echo '==> los escenarios marcados should_fail deben terminar en ERROR; los deberia_ser_N en N; los bloques DO sin error = OK (una discrepancia lanza excepcion).'
