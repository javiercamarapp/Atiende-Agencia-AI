-- D-35 + D-02 -- verificación contra Postgres REAL de la migración 021 (conciliación persistida y sugerencias del nivel 4).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias
-- `..._deberia_ser_N` = el valor esperado (ver run-gate.mjs). Los negativos tienen un control positivo con la misma
-- precondición para que un fallo por otra causa no se confunda con la defensa que se prueba.
-- Sujetos: admin de A (org-wide), contador de A acotado a UN cliente (A1), readonly de A, admin de B (otro despacho),
-- usuario sin membresía, sesión sin sub y anon. Todos los RFC, folios, hashes y correos son ficticios.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-000000d35a01', 'despachos', 'Despacho A', 'despacho-a-conc', 'active'),
  ('00000000-0000-0000-0000-000000d35a02', 'despachos', 'Despacho B', 'despacho-b-conc', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35a01', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-000000d35b02', '00000000-0000-0000-0000-000000d35a01', 'despachos', 'Cliente A2'),
  ('00000000-0000-0000-0000-000000d35b03', '00000000-0000-0000-0000-000000d35a02', 'despachos', 'Cliente B1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000d35c01', 'conc-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000d35c02', 'conc-contador-a1@example.com', 'Contador A1', 'seed'),
  ('00000000-0000-0000-0000-000000d35c03', 'conc-readonly-a@example.com', 'Readonly A', 'seed'),
  ('00000000-0000-0000-0000-000000d35c04', 'conc-admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-000000d35c05', 'conc-nadie@example.com', 'Sin membresia', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000d35c01', '00000000-0000-0000-0000-000000d35a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d35c02', '00000000-0000-0000-0000-000000d35a01', array['00000000-0000-0000-0000-000000d35b01']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000d35c03', '00000000-0000-0000-0000-000000d35a01', null, 'viewer', 'readonly'),
  ('00000000-0000-0000-0000-000000d35c04', '00000000-0000-0000-0000-000000d35a02', null, 'admin', 'admin')
on conflict do nothing;
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, fecha,
                               direccion, metodo_pago, forma_pago, uso_cfdi, moneda, subtotal_centavos, total_centavos, iva_trasladado_centavos, estado_sat) values
  ('00000000-0000-0000-0000-000000d35d01', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35a11', 'I', 'CAA010101AB1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-10', 'emitido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d35d02', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35a12', 'I', 'CAA010101AB1', 'RRR010101RR1', 500, 580, 80, true, '2026-07-12', 'emitido', 'PUE', '03', 'G03', 'MXN', 50000, 58000, 8000, 'vigente'),
  ('00000000-0000-0000-0000-000000d35d03', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35a13', 'I', 'CAA010101AB1', 'RRR010101RR1', 300, 348, 48, true, '2026-07-15', 'emitido', 'PUE', '03', 'G03', 'MXN', 30000, 34800, 4800, 'vigente'),
  ('00000000-0000-0000-0000-000000d35d06', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b02', '00000000-0000-0000-0000-000000d35a16', 'I', 'CAA020202AB2', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-15', 'emitido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d35d07', '00000000-0000-0000-0000-000000d35a02', '00000000-0000-0000-0000-000000d35b03', '00000000-0000-0000-0000-000000d35a17', 'I', 'CBB020202BC2', 'RRR020202RR2', 1000, 1160, 160, true, '2026-07-16', 'emitido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente')
on conflict do nothing;
insert into despachos.estado_cuenta_movimiento (id, organization_id, property_id, hash, cuenta, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', md5('m1') || md5('m1b'), 'CTA1', 'bbva', 'csv', '2026-07-10', 'SPEI RECIBIDO', 1160, 1160, '00000000-0000-0000-0000-000000d351a1', 1),
  ('00000000-0000-0000-0000-000000d35f02', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', md5('m2') || md5('m2b'), 'CTA1', 'bbva', 'csv', '2026-07-12', 'SPEI RECIBIDO 2', 580, 580, '00000000-0000-0000-0000-000000d351a1', 2),
  ('00000000-0000-0000-0000-000000d35f03', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', md5('m3') || md5('m3b'), 'CTA2', 'bbva', 'csv', '2026-07-15', 'DEPOSITO CTA2', 348, 348, '00000000-0000-0000-0000-000000d351a1', 3),
  ('00000000-0000-0000-0000-000000d35f04', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', md5('m4') || md5('m4b'), 'CTA1', 'bbva', 'csv', '2026-08-05', 'AGOSTO', 100, 100, '00000000-0000-0000-0000-000000d351a2', 1),
  ('00000000-0000-0000-0000-000000d35f05', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b02', md5('m5') || md5('m5b'), 'CTA9', 'bbva', 'csv', '2026-07-15', 'OTRO CLIENTE', 1160, 1160, '00000000-0000-0000-0000-000000d351a3', 1),
  ('00000000-0000-0000-0000-000000d35f06', '00000000-0000-0000-0000-000000d35a02', '00000000-0000-0000-0000-000000d35b03', md5('m6') || md5('m6b'), 'CTB1', 'bbva', 'csv', '2026-07-16', 'OTRO DESPACHO', 1160, 1160, '00000000-0000-0000-0000-000000d351a4', 1)
on conflict do nothing;
insert into despachos.conciliacion_sesion (id, organization_id, property_id, periodo, cuenta) values
  ('00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '2026-07', null),
  ('00000000-0000-0000-0000-000000d35e02', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '2026-07', 'CTA2'),
  ('00000000-0000-0000-0000-000000d35e03', '00000000-0000-0000-0000-000000d35a02', '00000000-0000-0000-0000-000000d35b03', '2026-07', null),
  ('00000000-0000-0000-0000-000000d35e04', '00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '2026-08', null)
on conflict do nothing;
insert into despachos.conciliacion_match (id, organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values
  ('00000000-0000-0000-0000-000000d359b1', '00000000-0000-0000-0000-000000d35a02', '00000000-0000-0000-0000-000000d35b03', '00000000-0000-0000-0000-000000d35e03', '00000000-0000-0000-0000-000000d35f06', '00000000-0000-0000-0000-000000d35d07', 'manual')
on conflict do nothing;

\echo '=== CREAR SESION ==='
\echo '1. admin de A crea la sesion de julio de A1: 3 movimientos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select out_movimientos as movimientos_deberia_ser_3 from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-07', null);
rollback;

\echo '2. la sesion acotada a la cuenta CTA2 ve 1 movimiento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select out_movimientos as movimientos_cta2_deberia_ser_1 from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-07', 'CTA2');
rollback;

\echo '3. el contador acotado a A1 crea su sesion (control positivo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c02', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-07', null);
rollback;

\echo '4. el contador acotado a A1 NO crea sesion en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c02', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b02', '2026-07', null) as should_fail;
rollback;

\echo '5. readonly NO crea sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c03', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-07', null) as should_fail;
rollback;

\echo '6. el admin de otro despacho NO crea sesion en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-07', null) as should_fail;
rollback;

\echo '7. usuario sin membresia NO crea sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c05', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-07', null) as should_fail;
rollback;

\echo '8. anon NO tiene EXECUTE'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-07', null) as should_fail;
rollback;

\echo '9. sin sub NO crea sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-07', null) as should_fail;
rollback;

\echo '10. periodo sin movimientos guardados se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-09', null) as should_fail;
rollback;

\echo '11. periodo con formato invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sesion_crear('00000000-0000-0000-0000-000000d35b01', '2026-13', null) as should_fail;
rollback;

\echo '=== CONFIRMAR ==='
\echo '12. confirma un par motor nivel 1: queda 1 match vigente con confirmado_por'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select count(*) as vigentes_deberia_ser_1 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01' and deshecho_en is null and confirmado_por = '00000000-0000-0000-0000-000000d35c01' and origen = 'motor' and nivel = 1;
rollback;

\echo '13. el contador acotado confirma en su cliente (control positivo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c02', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
rollback;

\echo '14. un movimiento NO admite dos matches vigentes (indice unico parcial)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d02", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '15. el lote es todo o nada: un par invalido revierte los validos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
do $$ begin perform * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}, {"movimiento_id": "00000000-0000-0000-0000-000000d35f05", "invoice_id": "00000000-0000-0000-0000-000000d35d02", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb); exception when others then null; end $$;
select count(*) as vigentes_deberia_ser_0 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01';
rollback;

\echo '16. un movimiento de OTRO cliente no se confirma en la sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f05", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '17. un CFDI de OTRO cliente no se confirma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d06", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '18. un movimiento fuera del periodo de la sesion se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f04", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '19. sesion acotada a CTA2: un movimiento de CTA1 se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e02', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '20. sesion acotada a CTA2: el movimiento de CTA2 si (control)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e02', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f03", "invoice_id": "00000000-0000-0000-0000-000000d35d03", "nivel": 2, "confianza": 90, "origen": "motor"}]'::jsonb);
rollback;

\echo '21. periodo cerrado bloquea confirmar (55000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
reset role;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', 2026, 7, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '22. control: con otro mes cerrado, julio sigue confirmable'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
reset role;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', 2026, 6, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
rollback;

\echo '23. una sesion cerrada no admite confirmar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sesion_cerrar('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01');
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '24. un match manual sin nivel ni confianza es valido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
rollback;

\echo '25. un match manual con nivel se rechaza (CHECK)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 2, "confianza": 80, "origen": "manual"}]'::jsonb) as should_fail;
rollback;

\echo '26. un match motor con nivel 4 se rechaza (CHECK)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 4, "confianza": 80, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '27. un origen desconocido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 80, "origen": "cliente"}]'::jsonb) as should_fail;
rollback;

\echo '28. lote vacio se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[]'::jsonb) as should_fail;
rollback;

\echo '29. readonly NO confirma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c03', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '30. el admin de otro despacho NO confirma en la sesion de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '31. usuario sin membresia NO confirma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c05', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '32. anon NO tiene EXECUTE sobre confirmar'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '33. sin sub NO confirma'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb) as should_fail;
rollback;

\echo '=== DESHACER ==='
\echo '34. deshacer marca quien, cuando y por que; el movimiento queda libre'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01' and deshecho_en is null), 'Se concilio contra la factura equivocada');
select count(*) as deshechos_deberia_ser_1 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01' and deshecho_en is not null and deshecho_por = '00000000-0000-0000-0000-000000d35c01' and motivo_deshacer = 'Se concilio contra la factura equivocada';
rollback;

\echo '35. deshacer es idempotente: la segunda llamada informa ya_deshecho'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'primer motivo valido');
select out_ya_deshecho::int as ya_deshecho_deberia_ser_1 from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'segundo motivo valido');
rollback;

\echo '36. la segunda llamada NO pisa el motivo original'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'primer motivo valido');
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'segundo motivo valido');
select count(*) as motivo_original_deberia_ser_1 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01' and motivo_deshacer = 'primer motivo valido';
rollback;

-- D-P3-11: se re-concilia contra un CFDI cuyo total cubre el movimiento (contra uno de 580 el tope de la 025 rechaza un movimiento de 1160).
\echo '37. tras deshacer el movimiento se puede conciliar de nuevo (el indice parcial lo libera)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'motivo valido uno');
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 2, "confianza": 85, "origen": "motor"}]'::jsonb);
select count(*) as vigentes_deberia_ser_1 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01' and deshecho_en is null;
rollback;

\echo '38. el motivo es obligatorio (vacio)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), '   ') as should_fail;
rollback;

\echo '39. el motivo demasiado corto se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'ab') as should_fail;
rollback;

\echo '40. periodo cerrado bloquea deshacer (55000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
reset role;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', 2026, 7, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'motivo valido') as should_fail;
rollback;

\echo '41. un match YA deshecho sigue siendo idempotente aunque el periodo se cierre despues'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'motivo valido');
reset role;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', 2026, 7, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select out_ya_deshecho::int as ya_deshecho_deberia_ser_1 from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'otra vez');
rollback;

\echo '42. readonly NO deshace'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c03', true);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b03', '00000000-0000-0000-0000-000000d359b1', 'motivo valido') as should_fail;
rollback;

\echo '43. el admin de A NO deshace el match de B1 (otra organizacion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b03', '00000000-0000-0000-0000-000000d359b1', 'motivo valido') as should_fail;
rollback;

\echo '44. el admin de A NO deshace el match de B1 pasando su propia property (no existe ahi)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d359b1', 'motivo valido') as should_fail;
rollback;

\echo '45. control: el admin de B SI deshace su propio match'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b03', '00000000-0000-0000-0000-000000d359b1', 'motivo valido');
rollback;

\echo '46. anon NO tiene EXECUTE sobre deshacer'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b03', '00000000-0000-0000-0000-000000d359b1', 'motivo valido') as should_fail;
rollback;

\echo '47. sin sub NO deshace'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b03', '00000000-0000-0000-0000-000000d359b1', 'motivo valido') as should_fail;
rollback;

\echo '=== SUGERENCIAS LLM (NUNCA SE APLICAN SOLAS) ==='
\echo '48. guardar una sugerencia la deja PENDIENTE y no crea ningun match'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select count(*) as matches_deberia_ser_0 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01';
rollback;

\echo '49. la sugerencia guardada queda pendiente con su confianza y razon'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select count(*) as pendientes_deberia_ser_1 from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01' and estado = 'pendiente' and confianza = 72.5 and razon = 'Mismo monto y cliente';
rollback;

\echo '50. guardar dos veces el mismo movimiento deja UNA pendiente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select count(*) as pendientes_deberia_ser_1 from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01' and estado = 'pendiente';
rollback;

\echo '51. readonly NO guarda sugerencias'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c03', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb) as should_fail;
rollback;

\echo '52. el admin de B NO guarda sugerencias en la sesion de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb) as should_fail;
rollback;

\echo '53. anon NO guarda sugerencias'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb) as should_fail;
rollback;

\echo '54. aprobar crea el match llm_aprobado nivel 4 y marca la sugerencia aprobada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), true);
select count(*) as aprobado_deberia_ser_1 from despachos.conciliacion_match m join despachos.conciliacion_sugerencia g on g.match_id = m.id where m.origen = 'llm_aprobado' and m.nivel = 4 and m.confirmado_por = '00000000-0000-0000-0000-000000d35c01' and g.estado = 'aprobada' and g.resuelta_por = '00000000-0000-0000-0000-000000d35c01';
rollback;

\echo '55. rechazar NO crea match'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), false);
select count(*) as matches_deberia_ser_0 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01';
rollback;

\echo '56. rechazar deja la sugerencia rechazada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), false);
select count(*) as rechazadas_deberia_ser_1 from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01' and estado = 'rechazada' and resuelta_por = '00000000-0000-0000-0000-000000d35c01';
rollback;

\echo '57. una sugerencia ya resuelta no se resuelve dos veces'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), true);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), false) as should_fail;
rollback;

\echo '58. aprobar falla si el movimiento ya tiene match vigente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d02", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), true) as should_fail;
rollback;

\echo '59. periodo cerrado bloquea aprobar (55000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
reset role;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', 2026, 7, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), true) as should_fail;
rollback;

\echo '60. control: rechazar si se puede con el periodo cerrado (no cambia contabilidad)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
reset role;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', 2026, 7, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), false);
rollback;

\echo '61. readonly NO aprueba'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c03', true);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d359c1', true) as should_fail;
rollback;

\echo '62. el admin de B NO aprueba una sugerencia de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d359c1', true) as should_fail;
rollback;

\echo '63. anon NO tiene EXECUTE sobre resolver'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d359c1', true) as should_fail;
rollback;

\echo '64. indicar si se aprueba o rechaza es obligatorio'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sugerencias_guardar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "confianza": 72.5, "razon": "Mismo monto y cliente"}]'::jsonb);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d35e01'), null) as should_fail;
rollback;

\echo '=== CERRAR SESION ==='
\echo '65. cerrar la sesion la marca cerrada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sesion_cerrar('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01');
select count(*) as cerrada_deberia_ser_1 from despachos.conciliacion_sesion where id = '00000000-0000-0000-0000-000000d35e01' and estado = 'cerrada' and cerrada_por = '00000000-0000-0000-0000-000000d35c01';
rollback;

\echo '66. cerrar es idempotente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_sesion_cerrar('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01');
select out_ya_cerrada::int as ya_cerrada_deberia_ser_1 from despachos.conciliacion_sesion_cerrar('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01');
rollback;

\echo '67. readonly NO cierra la sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c03', true);
select * from despachos.conciliacion_sesion_cerrar('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01') as should_fail;
rollback;

\echo '68. el admin de B NO cierra la sesion de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select * from despachos.conciliacion_sesion_cerrar('00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01') as should_fail;
rollback;

\echo '=== RLS DE LECTURA Y ESCRITURA DIRECTA CERRADA ==='
\echo '69. el admin de A ve las 3 sesiones de A y ninguna de B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select count(*) as sesiones_deberia_ser_3 from despachos.conciliacion_sesion;
rollback;

\echo '70. el contador acotado ve solo las sesiones de A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c02', true);
select count(*) as sesiones_deberia_ser_3 from despachos.conciliacion_sesion;
rollback;

\echo '71. el admin de B ve solo su sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select count(*) as sesiones_deberia_ser_1 from despachos.conciliacion_sesion;
rollback;

\echo '72. el usuario sin membresia no ve sesiones'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c05', true);
select count(*) as sesiones_deberia_ser_0 from despachos.conciliacion_sesion;
rollback;

\echo '73. el admin de A no ve el match de B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select count(*) as matches_ajenos_deberia_ser_0 from despachos.conciliacion_match where property_id = '00000000-0000-0000-0000-000000d35b03';
rollback;

\echo '74. el admin de B ve su match'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select count(*) as matches_propios_deberia_ser_1 from despachos.conciliacion_match where property_id = '00000000-0000-0000-0000-000000d35b03';
rollback;

\echo '75. readonly SI puede leer las sesiones de su despacho'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c03', true);
select count(*) as sesiones_deberia_ser_3 from despachos.conciliacion_sesion;
rollback;

\echo '76. authenticated NO inserta matches directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d01', 'manual') returning id as should_fail;
rollback;

\echo '77. authenticated NO actualiza matches directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
update despachos.conciliacion_match set motivo_deshacer = 'x' where id = '00000000-0000-0000-0000-000000d359b1' returning id as should_fail;
rollback;

\echo '78. authenticated NO borra matches directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
delete from despachos.conciliacion_match where id = '00000000-0000-0000-0000-000000d359b1' returning id as should_fail;
rollback;

\echo '79. authenticated NO inserta sesiones directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
insert into despachos.conciliacion_sesion (organization_id, property_id, periodo) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '2026-07') returning id as should_fail;
rollback;

\echo '80. authenticated NO inserta sugerencias directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
insert into despachos.conciliacion_sugerencia (organization_id, property_id, sesion_id, movimiento_id, invoice_id, confianza) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d01', 50) returning id as should_fail;
rollback;

\echo '81. anon NO lee sesiones'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from despachos.conciliacion_sesion;
rollback;

\echo '82. anon NO lee matches'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from despachos.conciliacion_match;
rollback;

\echo '=== INTEGRIDAD (como dueno de la tabla) ==='
\echo '83. FK compuesta: un match no liga la sesion de A1 con un movimiento de A2'
begin;
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f05', '00000000-0000-0000-0000-000000d35d01', 'manual') returning 1 as should_fail;
rollback;

\echo '84. FK compuesta: un match no mezcla organizaciones'
begin;
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values ('00000000-0000-0000-0000-000000d35a02', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d01', 'manual') returning 1 as should_fail;
rollback;

\echo '85. indice unico parcial: dos matches vigentes del mismo movimiento fallan'
begin;
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d01', 'manual');
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d02', 'manual') returning 1 as should_fail;
rollback;

\echo '86. indice unico parcial: con el primero deshecho el segundo SI entra'
begin;
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen, deshecho_en, deshecho_por, motivo_deshacer) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d01', 'manual', now(), '00000000-0000-0000-0000-000000d35c01', 'motivo valido');
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d02', 'manual');
select count(*) as vigentes_deberia_ser_1 from despachos.conciliacion_match where movimiento_id = '00000000-0000-0000-0000-000000d35f01' and deshecho_en is null;
rollback;

\echo '87. CHECK: deshecho_en sin motivo se rechaza'
begin;
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen, deshecho_en) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d01', 'manual', now()) returning 1 as should_fail;
rollback;

\echo '88. CHECK: periodo de la sesion con formato invalido'
begin;
insert into despachos.conciliacion_sesion (organization_id, property_id, periodo) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '2026-7') returning 1 as should_fail;
rollback;

\echo '89. CHECK: una sugerencia aprobada exige match'
begin;
insert into despachos.conciliacion_sugerencia (organization_id, property_id, sesion_id, movimiento_id, invoice_id, confianza, estado, resuelta_en) values ('00000000-0000-0000-0000-000000d35a01', '00000000-0000-0000-0000-000000d35b01', '00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d01', 50, 'aprobada', now()) returning 1 as should_fail;
rollback;

\echo '=== VISTA DERIVADA invoice_conciliacion ==='
\echo '90. la marca de conciliado aparece al confirmar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select count(*) as conciliados_deberia_ser_1 from despachos.invoice_conciliacion where invoice_id = '00000000-0000-0000-0000-000000d35d01' and movimientos = 1;
rollback;

\echo '91. la marca desaparece al deshacer (derivada, sin desincronizarse)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d35b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d35e01'), 'motivo valido');
select count(*) as conciliados_deberia_ser_0 from despachos.invoice_conciliacion where invoice_id = '00000000-0000-0000-0000-000000d35d01';
rollback;

\echo '92. la vista aplica RLS de quien consulta: B no ve la marca de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d35e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d35f01", "invoice_id": "00000000-0000-0000-0000-000000d35d01", "nivel": 1, "confianza": 100, "origen": "motor"}]'::jsonb);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c04', true);
select count(*) as ajenos_deberia_ser_0 from despachos.invoice_conciliacion where property_id = '00000000-0000-0000-0000-000000d35b01';
rollback;

\echo '93. anon NO lee la vista'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from despachos.invoice_conciliacion;
rollback;

\echo '=== POSTURA DE CATALOGO ==='
\echo '94. las 3 tablas tienen RLS habilitado'
begin;
select (count(*) filter (where c.relrowsecurity))::int as rls_deberia_ser_3 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'despachos' and c.relname in ('conciliacion_sesion','conciliacion_match','conciliacion_sugerencia');
rollback;

\echo '95. ninguna policy es permisiva (using true) ni aplica a anon'
begin;
select count(*)::int as policies_permisivas_deberia_ser_0 from pg_policies where schemaname = 'despachos' and tablename in ('conciliacion_sesion','conciliacion_match','conciliacion_sugerencia') and (qual = 'true' or with_check = 'true' or 'anon' = any(roles));
rollback;

\echo '96. anon y public sin privilegios; authenticated solo lee'
begin;
select count(*)::int as tablas_con_privilegios_de_mas_deberia_ser_0 from unnest(array['conciliacion_sesion','conciliacion_match','conciliacion_sugerencia']) as t(nombre) where has_table_privilege('anon'::name, 'despachos.' || t.nombre, 'select, insert, update, delete, truncate, references, trigger') or has_table_privilege('public'::name, 'despachos.' || t.nombre, 'select, insert, update, delete, truncate, references, trigger') or has_table_privilege('authenticated'::name, 'despachos.' || t.nombre, 'insert, update, delete, truncate, references, trigger');
rollback;

\echo '97. las 6 funciones definer tienen search_path fijo'
begin;
select count(*)::int as sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname in ('conciliacion_sesion_crear','conciliacion_match_insertar','conciliacion_matches_confirmar','conciliacion_match_deshacer','conciliacion_sesion_cerrar','conciliacion_sugerencias_guardar','conciliacion_sugerencia_resolver') and (not p.prosecdef or p.proconfig is null);
rollback;

\echo '98. el nucleo interno conciliacion_match_insertar no es ejecutable por authenticated ni anon'
begin;
select (has_function_privilege('authenticated', 'despachos.conciliacion_match_insertar(uuid,uuid,uuid,smallint,numeric,text)', 'execute')::int + has_function_privilege('anon', 'despachos.conciliacion_match_insertar(uuid,uuid,uuid,smallint,numeric,text)', 'execute')::int) as ejecutable_deberia_ser_0;
rollback;

\echo '99. el nucleo interno tampoco se invoca directo por un admin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d35c01', true);
select despachos.conciliacion_match_insertar('00000000-0000-0000-0000-000000d35e01', '00000000-0000-0000-0000-000000d35f01', '00000000-0000-0000-0000-000000d35d01', 1::smallint, 100, 'motor') as should_fail;
rollback;

\echo '100. anon sin EXECUTE en ninguna funcion publica'
begin;
select count(*)::int as anon_ejecuta_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname like 'conciliacion\_%' and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo 'Todos los escenarios deben pasar (should_fail = ERROR de Postgres; deberia_ser_N = valor).'
