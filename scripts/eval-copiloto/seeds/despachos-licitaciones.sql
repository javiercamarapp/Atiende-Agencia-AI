-- SEMILLA del arnes de evaluacion del Copiloto (scripts/eval-copiloto). Despachos contables y licitaciones: CFDI, cobranza, vencimientos, cierres, EFOS 69-B; convocatorias, go/no-go, propuestas, fallos, contratos y junta.
-- Es una COPIA CONGELADA del bloque de fixtures del verify de data-chat de esa vertical (datos ficticios, sin PII real):
-- las respuestas esperadas de los casos se calculan contra ESTOS datos y se congelan en datos/*.congelado.json.
-- No editar sin volver a congelar (npm run eval:copiloto:congelar).
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000d301', 'despachos', 'Despacho A (data chat)', 'despacho-a-data-chat'),
  ('00000000-0000-0000-0000-00000000d302', 'despachos', 'Despacho B (data chat, ajeno)', 'despacho-b-data-chat'),
  ('00000000-0000-0000-0000-00000000d401', 'licitaciones', 'Licitaciones A (data chat)', 'licitaciones-a-data-chat'),
  ('00000000-0000-0000-0000-00000000d402', 'licitaciones', 'Licitaciones B (data chat, ajena)', 'licitaciones-b-data-chat')
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
  ('00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-00000000d301', 'despachos', 'Abarrotes La Esquina SA de CV'),
  ('00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-00000000d301', 'despachos', 'Taller Mecánico Peninsular'),
  ('00000000-0000-0000-0000-00000000e103', '00000000-0000-0000-0000-00000000d302', 'despachos', 'Clínica Dental B (ajena)')
on conflict do nothing;

-- admin A: todos los clientes · contador: SOLO el Taller · admin B: su despacho ajeno · licitaciones: owner/viewer A y owner B.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000061', '00000000-0000-0000-0000-00000000d301', null, 'owner', 'admin'),
  ('00000000-0000-0000-0000-000000000062', '00000000-0000-0000-0000-00000000d301', array['00000000-0000-0000-0000-00000000e102']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000000063', '00000000-0000-0000-0000-00000000d302', null, 'owner', 'admin'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-00000000d401', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000072', '00000000-0000-0000-0000-00000000d401', null, 'viewer', 'viewer'),
  ('00000000-0000-0000-0000-000000000073', '00000000-0000-0000-0000-00000000d402', null, 'owner', 'owner')
on conflict do nothing;

-- ===== DESPACHOS =====
-- CFDI: i1 Abarrotes I valido 1160 (iva 160) 10-sep · i2 Abarrotes I INVALIDO 580 (iva 80) 12-sep · i3 Abarrotes N 3000 15-sep
--       i4 Abarrotes I valido 580 31-AGO (fuera de la ventana de septiembre) · i5 Abarrotes I valido 2320 (iva 320) 20-sep, emisor en la 69-B, en revision
--       i6 Taller I valido 232 (iva 32) 5-sep · i7 Clinica B (otro despacho) 99999
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, requires_human_review, fecha) values
  ('00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a1', 'I', 'PRV010101AB1', 'ABA010101AB1', 1000, 1160, 160, true, false, '2026-09-10'),
  ('00000000-0000-0000-0000-0000000f0102', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a2', 'I', 'PRV010101AB1', 'ABA010101AB1', 500, 580, 80, false, false, '2026-09-12'),
  ('00000000-0000-0000-0000-0000000f0103', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a3', 'N', 'ABA010101AB1', 'EMP010101AB1', 3000, 3000, 0, true, false, '2026-09-15'),
  ('00000000-0000-0000-0000-0000000f0104', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a4', 'I', 'PRV010101AB1', 'ABA010101AB1', 500, 580, 80, true, false, '2026-08-31'),
  ('00000000-0000-0000-0000-0000000f0105', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000000a5', 'I', 'AAA010101AAA', 'ABA010101AB1', 2000, 2320, 320, true, true, '2026-09-20'),
  ('00000000-0000-0000-0000-0000000f0106', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-0000000000a6', 'I', 'PRV020202CD2', 'TAL010101AB1', 200, 232, 32, true, false, '2026-09-05'),
  ('00000000-0000-0000-0000-0000000f0107', '00000000-0000-0000-0000-00000000d302', '00000000-0000-0000-0000-00000000e103', '00000000-0000-0000-0000-0000000000a7', 'I', 'PRV030303EF3', 'CLI010101AB1', 86206.90, 99999, 13792.10, true, false, '2026-09-10')
on conflict do nothing;

-- Cartera (hoy = 2026-09-29): r1 i1 vence 1-sep (28 dias, 1-30) · r2 i5 vence 1-jun (120 dias, >90) · r3 i4 vence 15-oct (vigente)
--   r4 i6 Taller vence 20-sep (9 dias) · r5 i2 PAGADA (fuera de la cartera) · r6 Clinica B vencida enorme (otro despacho)
insert into despachos.receivable (id, organization_id, property_id, invoice_id, fecha_vencimiento, monto_pagado, pagado_en) values
  ('00000000-0000-0000-0000-0000000f0201', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0101', '2026-09-01', null, null),
  ('00000000-0000-0000-0000-0000000f0202', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0105', '2026-06-01', null, null),
  ('00000000-0000-0000-0000-0000000f0203', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0104', '2026-10-15', null, null),
  ('00000000-0000-0000-0000-0000000f0204', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e102', '00000000-0000-0000-0000-0000000f0106', '2026-09-20', null, null),
  ('00000000-0000-0000-0000-0000000f0205', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0102', '2026-08-01', 580, '2026-08-20T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0206', '00000000-0000-0000-0000-00000000d302', '00000000-0000-0000-0000-00000000e103', '00000000-0000-0000-0000-0000000f0107', '2026-01-01', null, null)
on conflict do nothing;

insert into despachos.fiscal_deadline (id, organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values
  ('00000000-0000-0000-0000-0000000f0301', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', 'IVA', '2026-09', '2026-10-17', 'alta', 'pendiente'),
  ('00000000-0000-0000-0000-0000000f0302', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', 'DIOT', '2026-08', '2026-09-17', 'critica', 'pendiente'),
  ('00000000-0000-0000-0000-0000000f0303', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e102', 'ISR', '2026-08', '2026-09-17', 'media', 'completado'),
  ('00000000-0000-0000-0000-0000000f0304', '00000000-0000-0000-0000-00000000d302', '00000000-0000-0000-0000-00000000e103', 'ISR', '2026-08', '2026-09-17', 'alta', 'pendiente')
on conflict do nothing;

-- Cierres: Abarrotes ago-2026 VENCIDO (3 tareas: pending vence 10-sep, in_progress vence 10-oct, done) · Abarrotes jul-2026 CERRADO
--          Taller sep-2026 abierto sin tareas · Clinica B abierto con una tarea (otro despacho)
insert into despachos.periodo_cierre (id, organization_id, property_id, anio, mes, status) values
  ('00000000-0000-0000-0000-0000000f0401', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', 2026, 8, 'overdue'),
  ('00000000-0000-0000-0000-0000000f0402', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', 2026, 7, 'closed'),
  ('00000000-0000-0000-0000-0000000f0403', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e102', 2026, 9, 'open'),
  ('00000000-0000-0000-0000-0000000f0404', '00000000-0000-0000-0000-00000000d302', '00000000-0000-0000-0000-00000000e103', 2026, 9, 'open')
on conflict do nothing;
insert into despachos.periodo_cierre_tarea (id, periodo_cierre_id, title, category, status, due_date) values
  ('00000000-0000-0000-0000-0000000f0411', '00000000-0000-0000-0000-0000000f0401', 'Verificar CFDI', 'cfdi', 'pending', '2026-09-10'),
  ('00000000-0000-0000-0000-0000000f0412', '00000000-0000-0000-0000-0000000f0401', 'Conciliar bancos', 'bank', 'in_progress', '2026-10-10'),
  ('00000000-0000-0000-0000-0000000f0413', '00000000-0000-0000-0000-0000000f0401', 'Nomina', 'nomina', 'done', '2026-09-05'),
  ('00000000-0000-0000-0000-0000000f0414', '00000000-0000-0000-0000-0000000f0404', 'Tarea ajena', 'cfdi', 'pending', '2026-09-01')
on conflict do nothing;

insert into despachos.invoice_review (id, organization_id, property_id, invoice_id, reason, status) values
  ('00000000-0000-0000-0000-0000000f0501', '00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000e101', '00000000-0000-0000-0000-0000000f0105', 'Emisor en lista 69-B', 'pendiente')
on conflict do nothing;

-- Lista 69-B ingerida (se siembra como superusuario: las tablas efos_* no son legibles por authenticated).
insert into despachos.efos_ingesta (periodo, fuente_sha256, filas) values ('2026-09', 'abababababababababababababababababababababababababababababababab', 1) on conflict do nothing;
insert into despachos.efos_contribuyente (periodo, rfc, nombre, situacion) values ('2026-09', 'AAA010101AAA', 'Proveedor Fantasma SA', 'definitivo') on conflict do nothing;

-- ===== LICITACIONES (ahora = 2026-09-30T05:30Z = 29-sep 23:30 en Merida) =====
insert into licitaciones.tender (id, organization_id, title, submission_deadline, status, contracting_body, state, budget_amount, currency) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000d401', 'Uniformes escolares', '2026-10-01T16:00:00Z', 'in_progress', 'SEP Yucatán', 'Yucatán', 1250000.50, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-00000000d401', 'Limpieza hospitalaria', '2026-10-20T20:00:00Z', 'in_review', 'IMSS-Bienestar', null, 480000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1003', '00000000-0000-0000-0000-00000000d401', 'Equipo de computo en dolares', null, 'discovered', null, null, 50000, 'USD'),
  ('00000000-0000-0000-0000-0000000f1004', '00000000-0000-0000-0000-00000000d401', 'Cierra hoy a las 23:45 locales', '2026-09-30T05:45:00Z', 'go', 'CFE', null, 100000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1005', '00000000-0000-0000-0000-00000000d401', 'Vencida sin presentar', '2026-09-25T18:00:00Z', 'go', 'SEDUMA', null, 70000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1006', '00000000-0000-0000-0000-00000000d401', 'Ya presentada', '2026-10-05T18:00:00Z', 'submitted', 'ISSSTE', null, 300000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1007', '00000000-0000-0000-0000-00000000d401', 'Amarillo', '2026-10-05T18:00:00Z', 'in_progress', 'SAT', null, 200000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1008', '00000000-0000-0000-0000-00000000d401', 'Ganada', '2026-08-01T18:00:00Z', 'won', 'IMSS-Bienestar', null, 900000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1009', '00000000-0000-0000-0000-00000000d401', 'Perdida en dolares', '2026-08-01T18:00:00Z', 'lost', 'SEDUMA', null, 1000, 'USD'),
  ('00000000-0000-0000-0000-0000000f1010', '00000000-0000-0000-0000-00000000d401', 'No-go', '2026-10-30T18:00:00Z', 'no_go', 'SCT', null, 5000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1011', '00000000-0000-0000-0000-00000000d401', 'Cancelada', '2026-10-30T18:00:00Z', 'cancelled', 'SCT', null, 5000, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-00000000d402', 'Convocatoria ajena B', '2026-10-02T18:00:00Z', 'in_progress', 'Otra dependencia', null, 99999999, 'MXN'),
  ('00000000-0000-0000-0000-0000000f1102', '00000000-0000-0000-0000-00000000d402', 'Fallo ajeno B', '2026-08-02T18:00:00Z', 'won', 'Otra dependencia', null, 99999999, 'MXN')
on conflict do nothing;

insert into licitaciones.go_no_go_decision (id, organization_id, tender_id, decision, reasons, match_score, match_eligibility_status, match_inputs_hash, decided_by, decided_at) values
  ('00000000-0000-0000-0000-0000000f1201', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1001', 'go', array['Experiencia comprobable','Otro']::text[], 87.5, 'cumple', 'h1', '00000000-0000-0000-0000-000000000071', '2026-09-20T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1202', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1010', 'no_go', array['Fuera de giro']::text[], 31, 'no_cumple', 'h2', '00000000-0000-0000-0000-000000000071', '2026-09-18T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1203', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1002', 'go', array['Antigua']::text[], 60, 'cumple', 'h3', '00000000-0000-0000-0000-000000000071', '2026-08-15T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1204', '00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-0000000f1101', 'go', array['Ajena']::text[], 99, 'cumple', 'h4', '00000000-0000-0000-0000-000000000073', '2026-09-20T18:00:00Z')
on conflict do nothing;

insert into licitaciones.proposal (id, organization_id, tender_id, title) values
  ('00000000-0000-0000-0000-0000000f1301', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1001', 'Propuesta uniformes'),
  ('00000000-0000-0000-0000-0000000f1302', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1006', 'Propuesta presentada'),
  ('00000000-0000-0000-0000-0000000f1303', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1008', 'Propuesta ganadora'),
  ('00000000-0000-0000-0000-0000000f1304', '00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-0000000f1101', 'Propuesta ajena')
on conflict do nothing;
insert into licitaciones.submission (id, organization_id, proposal_id, submitted_at) values
  ('00000000-0000-0000-0000-0000000f1311', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1302', '2026-09-28T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1312', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1303', '2026-07-30T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1313', '00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-0000000f1304', '2026-09-28T18:00:00Z')
on conflict do nothing;

insert into licitaciones.tender_resolution (id, organization_id, tender_id, resolution, from_status, reason, resolved_by, resolved_at) values
  ('00000000-0000-0000-0000-0000000f1401', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1008', 'won', 'submitted', 'Adjudicada', '00000000-0000-0000-0000-000000000071', '2026-09-10T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1402', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1009', 'lost', 'submitted', 'Precio', '00000000-0000-0000-0000-000000000071', '2026-09-02T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1403', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1003', 'lost', 'submitted', 'Antigua', '00000000-0000-0000-0000-000000000071', '2026-07-01T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f1404', '00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-0000000f1102', 'won', 'submitted', 'Ajena', '00000000-0000-0000-0000-000000000073', '2026-09-10T18:00:00Z')
on conflict do nothing;

-- Contratos: c1 (ganada) fin 15-nov con opcion de renovacion y alerta pendiente (47 dias) · c2 fin 1-dic (63) · c3 fin 1-jun-2027 (fuera de 90 dias)
--            c4 CERRADO fin 30-oct · c5 sin fecha de fin · c6 fin 28-sep (ya paso) · c7 B ajeno
insert into licitaciones.contract (id, organization_id, tender_id, status, end_date, contract_number, has_renewal_option) values
  ('00000000-0000-0000-0000-0000000f1501', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1008', 'en_ejecucion', '2026-11-15', 'IMSS-2025-044', true),
  ('00000000-0000-0000-0000-0000000f1502', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1006', 'adjudicado', '2026-12-01', null, false),
  ('00000000-0000-0000-0000-0000000f1503', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1002', 'en_ejecucion', '2027-06-01', 'LIM-1', false),
  ('00000000-0000-0000-0000-0000000f1504', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1010', 'cerrado', '2026-10-30', 'CER-1', false),
  ('00000000-0000-0000-0000-0000000f1505', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1011', 'adjudicado', null, 'SIN-FIN', false),
  ('00000000-0000-0000-0000-0000000f1506', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1003', 'en_ejecucion', '2026-09-28', 'PASO-1', false),
  ('00000000-0000-0000-0000-0000000f1507', '00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-0000000f1101', 'en_ejecucion', '2026-11-01', 'B-1', true)
on conflict do nothing;
insert into licitaciones.renewal_alert (id, organization_id, contract_id, tender_id, predicted_date, lead_days, confidence, status) values
  ('00000000-0000-0000-0000-0000000f1601', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1501', '00000000-0000-0000-0000-0000000f1008', '2026-11-15', 60, 0.80, 'pendiente'),
  ('00000000-0000-0000-0000-0000000f1602', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1502', '00000000-0000-0000-0000-0000000f1006', '2026-12-01', 60, 0.80, 'reconocida')
on conflict do nothing;

-- Junta de aclaraciones (L-04, migracion 029): t1001 con limite de preguntas 2-oct 15:00 y junta 5-oct 11:00 (hora de Merida); t1002 sin fechas.
--   q1 t1001 alta APROBADA · q2 t1002 media BORRADOR · q3 t1002 baja ENVIADA · q4 RESPONDIDA y q5 DESCARTADA (cerradas, no cuentan) · q6 de la organizacion B
insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, meeting_at) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000d401', '2026-10-02T21:00:00Z', '2026-10-05T17:00:00Z')
on conflict do nothing;
insert into licitaciones.junta_question (id, organization_id, tender_id, question_text, topic, priority, dedupe_key, status, created_by, approved_at, sent_at, answer_text, discard_reason) values
  ('00000000-0000-0000-0000-0000000f1701', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1001', 'Se aceptan tallas intermedias en la partida 3?', 'tecnico', 'alta', 'k1', 'aprobada', '00000000-0000-0000-0000-000000000071', now(), null, null, null),
  ('00000000-0000-0000-0000-0000000f1702', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1002', 'El anexo 4 sustituye al formato de la convocatoria?', 'administrativo', 'media', 'k2', 'borrador', '00000000-0000-0000-0000-000000000071', null, null, null, null),
  ('00000000-0000-0000-0000-0000000f1703', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1002', 'Como se acredita la experiencia en el apartado legal?', 'legal', 'baja', 'k3', 'enviada', '00000000-0000-0000-0000-000000000071', now(), now(), null, null),
  ('00000000-0000-0000-0000-0000000f1704', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1001', 'Pregunta ya respondida sobre plazos de entrega', 'otro', 'media', 'k4', 'respondida', '00000000-0000-0000-0000-000000000071', now(), now(), 'Respuesta confidencial del acta', null),
  ('00000000-0000-0000-0000-0000000f1705', '00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-0000000f1001', 'Pregunta descartada por duplicada', 'otro', 'baja', 'k5', 'descartada', '00000000-0000-0000-0000-000000000071', null, null, null, 'Duplicada'),
  ('00000000-0000-0000-0000-0000000f1706', '00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-0000000f1101', 'Pregunta ajena de la organizacion B', 'otro', 'alta', 'k6', 'borrador', '00000000-0000-0000-0000-000000000073', null, null, null, null)
on conflict do nothing;

insert into licitaciones.tenant_config (organization_id, timezone) values
  ('00000000-0000-0000-0000-00000000d401', 'America/Cancun'), ('00000000-0000-0000-0000-00000000d402', 'America/Tijuana')
on conflict do nothing;
