-- D-P3-10/11/12 -- verificación contra Postgres REAL de la migración 025 (integridad del CFDI en la conciliación y piloto automático).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; `..._deberia_ser_N` = el valor esperado
-- (ver run-gate.mjs). Los negativos tienen un control positivo con la misma precondición para que un fallo por otra causa no se confunda con la
-- defensa que se prueba; los SQLSTATE propios (CF001..CF004) se comprueban por código exacto con un bloque DO.
-- Sujetos: admin de A (org-wide), contador de A acotado a UN cliente (A1), readonly de A, admin de B (otro despacho), usuario sin membresía, sesión
-- sin sub y anon. Todos los RFC, folios, hashes y correos son ficticios.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-000000d36a01', 'despachos', 'Despacho A', 'despacho-a-integ', 'active'),
  ('00000000-0000-0000-0000-000000d36a02', 'despachos', 'Despacho B', 'despacho-b-integ', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36a01', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-000000d36b02', '00000000-0000-0000-0000-000000d36a01', 'despachos', 'Cliente A2'),
  ('00000000-0000-0000-0000-000000d36b03', '00000000-0000-0000-0000-000000d36a02', 'despachos', 'Cliente B1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000d36c01', 'integ-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000d36c02', 'integ-contador-a1@example.com', 'Contador A1', 'seed'),
  ('00000000-0000-0000-0000-000000d36c03', 'integ-readonly-a@example.com', 'Readonly A', 'seed'),
  ('00000000-0000-0000-0000-000000d36c04', 'integ-admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-000000d36c05', 'integ-nadie@example.com', 'Sin membresia', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000d36c01', '00000000-0000-0000-0000-000000d36a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d36c02', '00000000-0000-0000-0000-000000d36a01', array['00000000-0000-0000-0000-000000d36b01']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000d36c03', '00000000-0000-0000-0000-000000d36a01', null, 'viewer', 'readonly'),
  ('00000000-0000-0000-0000-000000d36c04', '00000000-0000-0000-0000-000000d36a02', null, 'admin', 'admin')
on conflict do nothing;

insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, fecha,
                               direccion, metodo_pago, forma_pago, uso_cfdi, moneda, subtotal_centavos, total_centavos, iva_trasladado_centavos, estado_sat) values
  ('00000000-0000-0000-0000-000000d36d01', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36a11', 'I', 'CAA010101AB1', 'RRR010101RR1', 1000, 1000, 0, true, '2026-07-10', 'emitido', 'PUE', '03', 'G03', 'MXN', 100000, 100000, 0, 'vigente'),
  ('00000000-0000-0000-0000-000000d36d02', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36a12', 'I', 'CAA010101AB1', 'RRR010101RR1', 500, 500, 0, true, '2026-07-10', 'recibido', 'PUE', '03', 'G03', 'MXN', 50000, 50000, 0, 'vigente'),
  ('00000000-0000-0000-0000-000000d36d03', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36a13', 'I', 'CAA010101AB1', 'RRR010101RR1', 300, 300, 0, true, '2026-07-10', 'emitido', 'PUE', '03', 'G03', 'MXN', 30000, 30000, 0, 'cancelado'),
  ('00000000-0000-0000-0000-000000d36d04', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36a14', 'I', 'CAA010101AB1', 'RRR010101RR1', 200, 200, 0, true, '2026-07-10', 'indeterminado', 'PUE', '03', 'G03', 'MXN', 20000, 20000, 0, 'vigente'),
  ('00000000-0000-0000-0000-000000d36d05', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36a15', 'I', 'CAA010101AB1', 'RRR010101RR1', 777, 777, 0, true, '2026-07-10', 'emitido', 'PUE', '03', 'G03', 'MXN', 77700, 77700, 0, 'vigente'),
  ('00000000-0000-0000-0000-000000d36d06', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36a16', 'I', 'CAA010101AB1', 'RRR010101RR1', 90, 90, 0, true, '2026-07-10', null, 'PUE', '03', 'G03', 'MXN', 9000, 9000, 0, 'vigente'),
  ('00000000-0000-0000-0000-000000d36d07', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b02', '00000000-0000-0000-0000-000000d36a17', 'I', 'CAA020202AB2', 'RRR010101RR1', 1000, 1000, 0, true, '2026-07-10', 'emitido', 'PUE', '03', 'G03', 'MXN', 100000, 100000, 0, 'vigente')
on conflict do nothing;
insert into despachos.estado_cuenta_movimiento (id, organization_id, property_id, hash, cuenta, banco, formato, fecha, descripcion, abono, cargo, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000d36f01', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i1') || md5('i1b'), 'CTA1', 'bbva', 'csv', '2026-07-10', 'COBRO 1000', 1000, null, 1000, '00000000-0000-0000-0000-000000d361a1', 1),
  ('00000000-0000-0000-0000-000000d36f02', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i2') || md5('i2b'), 'CTA1', 'bbva', 'csv', '2026-07-11', 'PAGO 500', null, 500, -500, '00000000-0000-0000-0000-000000d361a1', 2),
  ('00000000-0000-0000-0000-000000d36f03', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i3') || md5('i3b'), 'CTA1', 'bbva', 'csv', '2026-07-12', 'COBRO 300', 300, null, 300, '00000000-0000-0000-0000-000000d361a1', 3),
  ('00000000-0000-0000-0000-000000d36f04', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i4') || md5('i4b'), 'CTA1', 'bbva', 'csv', '2026-07-13', 'COBRO 400', 400, null, 400, '00000000-0000-0000-0000-000000d361a1', 4),
  ('00000000-0000-0000-0000-000000d36f05', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i5') || md5('i5b'), 'CTA1', 'bbva', 'csv', '2026-07-14', 'COBRO 600', 600, null, 600, '00000000-0000-0000-0000-000000d361a1', 5),
  ('00000000-0000-0000-0000-000000d36f06', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i6') || md5('i6b'), 'CTA1', 'bbva', 'csv', '2026-07-15', 'COBRO 50', 50, null, 50, '00000000-0000-0000-0000-000000d361a1', 6),
  ('00000000-0000-0000-0000-000000d36f07', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i7') || md5('i7b'), 'CTA1', 'bbva', 'csv', '2026-07-16', 'COBRO 200', 200, null, 200, '00000000-0000-0000-0000-000000d361a1', 7),
  ('00000000-0000-0000-0000-000000d36f08', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i8') || md5('i8b'), 'CTA1', 'bbva', 'csv', '2026-07-17', 'COBRO 777', 777, null, 777, '00000000-0000-0000-0000-000000d361a1', 8),
  ('00000000-0000-0000-0000-000000d36f09', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i9') || md5('i9b'), 'CTA1', 'bbva', 'csv', '2026-07-18', 'COBRO 90', 90, null, 90, '00000000-0000-0000-0000-000000d361a1', 9),
  ('00000000-0000-0000-0000-000000d36f10', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i10') || md5('i10b'), 'CTA1', 'bbva', 'csv', '2026-07-19', 'COBRO 1000 B', 1000, null, 1000, '00000000-0000-0000-0000-000000d361a1', 10),
  ('00000000-0000-0000-0000-000000d36f11', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b02', md5('i11') || md5('i11b'), 'CTA9', 'bbva', 'csv', '2026-07-15', 'OTRO CLIENTE', 1000, null, 1000, '00000000-0000-0000-0000-000000d361a1', 11),
  ('00000000-0000-0000-0000-000000d36f12', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', md5('i12') || md5('i12b'), 'CTA1', 'bbva', 'csv', '2026-08-05', 'AGOSTO', 100, null, 100, '00000000-0000-0000-0000-000000d361a1', 12)
on conflict do nothing;
insert into despachos.conciliacion_sesion (id, organization_id, property_id, periodo, cuenta) values
  ('00000000-0000-0000-0000-000000d36e01', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '2026-07', null),
  ('00000000-0000-0000-0000-000000d36e03', '00000000-0000-0000-0000-000000d36a02', '00000000-0000-0000-0000-000000d36b03', '2026-07', null),
  ('00000000-0000-0000-0000-000000d36e04', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b02', '2026-07', null)
on conflict do nothing;
insert into despachos.conciliacion_sesion (id, organization_id, property_id, periodo, cuenta, estado, cerrada_en) values
  ('00000000-0000-0000-0000-000000d36e02', '00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '2026-06', null, 'cerrada', now())
on conflict do nothing;
insert into despachos.property_config (property_id, organization_id) values ('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36a01') on conflict do nothing;

\echo '=== TOPE DE MONTO, CFDI CANCELADO Y SIGNO ==='
\echo '1. abono de 1000 contra el CFDI emitido de 1000: se concilia (control positivo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f01", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select count(*) as vigentes_deberia_ser_1 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d36e01' and deshecho_en is null;
rollback;

\echo '2. el mismo CFDI NO se concilia dos veces por el monto completo (antes quedaba conciliado N veces)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f01", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f10", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb) as should_fail;
rollback;

\echo '3. pagos parciales que suman el total SI se permiten (400 + 600 = 1000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f04", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f05", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select count(*) as vigentes_deberia_ser_2 from despachos.conciliacion_match where invoice_id = '00000000-0000-0000-0000-000000d36d01' and deshecho_en is null;
rollback;

\echo '4. un pago parcial de mas (400 + 600 + 50) rebasa el total y se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f04", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f05", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f06", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb) as should_fail;
rollback;

\echo '5. deshacer libera el cupo del CFDI: se puede conciliar de nuevo otro movimiento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f01", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d36b01', (select id from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d36e01'), 'motivo valido');
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f10", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select count(*) as vigentes_deberia_ser_1 from despachos.conciliacion_match where invoice_id = '00000000-0000-0000-0000-000000d36d01' and deshecho_en is null;
rollback;

\echo '6. el tope tambien aplica a una sugerencia de IA aprobada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
insert into despachos.conciliacion_sugerencia (organization_id, property_id, sesion_id, movimiento_id, invoice_id, confianza, razon) values ('00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '00000000-0000-0000-0000-000000d36f10', '00000000-0000-0000-0000-000000d36d01', 60, 'fixture');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f01", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select * from despachos.conciliacion_sugerencia_resolver('00000000-0000-0000-0000-000000d36b01', (select id from despachos.conciliacion_sugerencia where sesion_id = '00000000-0000-0000-0000-000000d36e01' and estado = 'pendiente'), true) as should_fail;
rollback;

\echo '7. un CFDI cancelado ante el SAT NO se concilia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f03", "invoice_id": "00000000-0000-0000-0000-000000d36d03", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb) as should_fail;
rollback;

\echo '8. control: el mismo movimiento SI se concilia contra un CFDI vigente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f03", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
rollback;

\echo '9. signo: un abono NO concilia contra un CFDI recibido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f04", "invoice_id": "00000000-0000-0000-0000-000000d36d02", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb) as should_fail;
rollback;

\echo '10. control: un cargo SI concilia contra un CFDI recibido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f02", "invoice_id": "00000000-0000-0000-0000-000000d36d02", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
rollback;

\echo '11. signo: un cargo NO concilia contra un CFDI emitido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f02", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb) as should_fail;
rollback;

\echo '12. un CFDI con direccion indeterminada se acepta en la base (la revision humana la exige la capa de aplicacion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f07", "invoice_id": "00000000-0000-0000-0000-000000d36d04", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select count(*) as vigentes_deberia_ser_1 from despachos.conciliacion_match where invoice_id = '00000000-0000-0000-0000-000000d36d04' and deshecho_en is null;
rollback;

\echo '13. un CFDI sin direccion (anterior a la 018) se acepta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f09", "invoice_id": "00000000-0000-0000-0000-000000d36d06", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
rollback;

\echo '14. el origen autopiloto NO se acepta por la confirmacion normal'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "nivel": 1, "confianza": 100, "origen": "autopiloto"}]'::jsonb) as should_fail;
rollback;

\echo '15. CF001 es el SQLSTATE de un CFDI cancelado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
do $$ begin
  perform * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f03", "invoice_id": "00000000-0000-0000-0000-000000d36d03", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
  raise exception 'no fallo';
exception
  when sqlstate 'CF001' then null;
end $$;
rollback;

\echo '16. CF002 es el SQLSTATE del tope de monto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f01", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
do $$ begin
  perform * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f10", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
  raise exception 'no fallo';
exception
  when sqlstate 'CF002' then null;
end $$;
rollback;

\echo '17. CF003 es el SQLSTATE del signo invertido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
do $$ begin
  perform * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f04", "invoice_id": "00000000-0000-0000-0000-000000d36d02", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
  raise exception 'no fallo';
exception
  when sqlstate 'CF003' then null;
end $$;
rollback;

\echo '=== PROPUESTAS GUARDADAS EN LA SESION ==='
\echo '18. el admin guarda las propuestas de la sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '{"version": 1, "propuestas": []}'::jsonb);
select count(*) as guardadas_deberia_ser_1 from despachos.conciliacion_sesion where id = '00000000-0000-0000-0000-000000d36e01' and propuestas is not null and propuestas_en is not null;
rollback;

\echo '19. el contador acotado a A1 guarda las propuestas de su cliente (control positivo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c02', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '{"version": 1, "propuestas": []}'::jsonb);
rollback;

\echo '20. readonly NO guarda propuestas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c03', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '{"version": 1, "propuestas": []}'::jsonb) as should_fail;
rollback;

\echo '21. el admin de otro despacho NO guarda propuestas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c04', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '{"version": 1, "propuestas": []}'::jsonb) as should_fail;
rollback;

\echo '22. usuario sin membresia NO guarda propuestas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c05', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '{"version": 1, "propuestas": []}'::jsonb) as should_fail;
rollback;

\echo '23. el contador acotado a A1 NO guarda propuestas del cliente A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c02', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b02', '00000000-0000-0000-0000-000000d36e04', '{"version": 1, "propuestas": []}'::jsonb) as should_fail;
rollback;

\echo '24. una sesion ajena a la property indicada no se encuentra (P0002)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b02', '00000000-0000-0000-0000-000000d36e01', '{"version": 1, "propuestas": []}'::jsonb) as should_fail;
rollback;

\echo '25. sin sub NO guarda propuestas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '{"version": 1, "propuestas": []}'::jsonb) as should_fail;
rollback;

\echo '26. anon NO tiene EXECUTE'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '{"version": 1, "propuestas": []}'::jsonb) as should_fail;
rollback;

\echo '27. una sesion cerrada no admite propuestas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e02', '{"version": 1, "propuestas": []}'::jsonb) as should_fail;
rollback;

\echo '28. las propuestas deben ser un objeto json'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select despachos.conciliacion_sesion_propuestas_guardar('00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '[1]'::jsonb) as should_fail;
rollback;

\echo '29. authenticated NO actualiza la columna directo (solo la funcion definer)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
update despachos.conciliacion_sesion set propuestas = '{}'::jsonb where id = '00000000-0000-0000-0000-000000d36e01' returning 1 as should_fail;
rollback;

\echo '=== SESION IDEMPOTENTE (asegurar) ==='
\echo '30. asegurar dos veces el mismo periodo crea UNA sola sesion (idempotente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null);
select count(*) as sesiones_deberia_ser_1 from despachos.conciliacion_sesion where property_id = '00000000-0000-0000-0000-000000d36b01' and periodo = '2026-08';
rollback;

\echo '31. la primera llamada crea y la segunda no'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null);
select count(*) filter (where out_creada) as segunda_creada_deberia_ser_0 from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null);
rollback;

\echo '32. si ya hay una sesion abierta del periodo y cuenta, la devuelve sin crear otra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select count(*) as misma_deberia_ser_1 from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-07', null) where out_sesion_id = '00000000-0000-0000-0000-000000d36e01' and not out_creada;
rollback;

\echo '33. otra cuenta del mismo periodo SI crea su propia sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select count(*) filter (where out_creada) as creadas_deberia_ser_1 from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-07', 'CTA1');
rollback;

\echo '34. el contador acotado a A1 asegura su sesion (control positivo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c02', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null);
rollback;

\echo '35. periodo sin movimientos guardados se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-09', null) as should_fail;
rollback;

\echo '36. periodo con formato invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-13', null) as should_fail;
rollback;

\echo '37. readonly NO asegura sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c03', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null) as should_fail;
rollback;

\echo '38. el admin de otro despacho NO asegura sesion en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c04', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null) as should_fail;
rollback;

\echo '39. el contador acotado a A1 NO asegura sesion en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c02', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b02', '2026-07', 'CTA9') as should_fail;
rollback;

\echo '40. usuario sin membresia NO asegura sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c05', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null) as should_fail;
rollback;

\echo '41. sin sub NO asegura sesion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null) as should_fail;
rollback;

\echo '42. anon NO tiene EXECUTE'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_sesion_asegurar('00000000-0000-0000-0000-000000d36b01', '2026-08', null) as should_fail;
rollback;

\echo '=== PILOTO AUTOMATICO (bandera por cliente, apagada por omision) ==='
\echo '43. la bandera nace APAGADA: el piloto no confirma nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select count(*) as encendidas_deberia_ser_0 from despachos.property_config where conciliacion_autoconfirmar_nivel1;
rollback;

\echo '44. con la bandera apagada el piloto rechaza (CF004)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
do $$ begin
  perform * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb);
  raise exception 'no fallo';
exception
  when sqlstate 'CF004' then null;
end $$;
rollback;

\echo '45. con la bandera apagada no queda ningun match autopiloto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '46. con la bandera encendida confirma un par de nivel 1 con origen autopiloto y el actor real en confirmado_por'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb);
select count(*) as autopiloto_deberia_ser_1 from despachos.conciliacion_match where sesion_id = '00000000-0000-0000-0000-000000d36e01' and origen = 'autopiloto' and nivel = 1 and confirmado_por = '00000000-0000-0000-0000-000000d36c01' and deshecho_en is null;
rollback;

\echo '47. un match del piloto se puede deshacer con motivo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb);
select * from despachos.conciliacion_match_deshacer('00000000-0000-0000-0000-000000d36b01', (select id from despachos.conciliacion_match where origen = 'autopiloto'), 'revision humana');
select count(*) as vigentes_deberia_ser_0 from despachos.conciliacion_match where origen = 'autopiloto' and deshecho_en is null;
rollback;

\echo '48. el piloto NO confirma si el monto no coincide con el CFDI (solo nivel 1)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f04", "invoice_id": "00000000-0000-0000-0000-000000d36d01", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '49. el piloto NO confirma un CFDI con direccion indeterminada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f07", "invoice_id": "00000000-0000-0000-0000-000000d36d04", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '50. el piloto NO confirma un CFDI sin direccion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f09", "invoice_id": "00000000-0000-0000-0000-000000d36d06", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '51. el piloto NO confirma contra un CFDI cancelado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f03", "invoice_id": "00000000-0000-0000-0000-000000d36d03", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '52. el piloto NO confirma con el signo invertido (cargo contra emitido)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f02", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '53. el piloto respeta el tope: un CFDI ya conciliado por el total no se confirma otra vez'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
select * from despachos.conciliacion_matches_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "nivel": null, "confianza": null, "origen": "manual"}]'::jsonb);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f10", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '54. readonly NO ejecuta el piloto aunque la bandera este encendida'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c03', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c03', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '55. el admin de otro despacho NO ejecuta el piloto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c04', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c04', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '56. usuario sin membresia NO ejecuta el piloto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c05', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c05', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '57. sin sub NO ejecuta el piloto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '58. anon NO tiene EXECUTE del piloto'
begin;
reset role;
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.conciliacion_autopiloto_confirmar('00000000-0000-0000-0000-000000d36e01', '[{"movimiento_id": "00000000-0000-0000-0000-000000d36f08", "invoice_id": "00000000-0000-0000-0000-000000d36d05", "confianza": 100}]'::jsonb) as should_fail;
rollback;

\echo '59. la bandera: el contador acotado NO puede encenderla (solo admin, por RLS)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c02', true);
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
select count(*) as encendidas_deberia_ser_0 from despachos.property_config where conciliacion_autoconfirmar_nivel1;
rollback;

\echo '60. la bandera: el admin del despacho SI puede encenderla (control positivo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c01', true);
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
select count(*) as encendidas_deberia_ser_1 from despachos.property_config where conciliacion_autoconfirmar_nivel1;
rollback;

\echo '61. la bandera: el admin de OTRO despacho no la enciende en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d36c04', true);
update despachos.property_config set conciliacion_autoconfirmar_nivel1 = true where property_id = '00000000-0000-0000-0000-000000d36b01';
select count(*) as encendidas_deberia_ser_0 from despachos.property_config where conciliacion_autoconfirmar_nivel1;
rollback;

\echo '=== INTEGRIDAD Y POSTURA DE CATALOGO ==='
\echo '62. CHECK: un match autopiloto exige nivel 1 (nivel 2 se rechaza)'
begin;
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen, nivel, confianza) values ('00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '00000000-0000-0000-0000-000000d36f08', '00000000-0000-0000-0000-000000d36d05', 'autopiloto', 2, 90) returning 1 as should_fail;
rollback;

\echo '63. control: un match autopiloto de nivel 1 con confianza SI entra'
begin;
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen, nivel, confianza) values ('00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '00000000-0000-0000-0000-000000d36f08', '00000000-0000-0000-0000-000000d36d05', 'autopiloto', 1, 100);
rollback;

\echo '64. CHECK: un origen desconocido se rechaza'
begin;
insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, origen) values ('00000000-0000-0000-0000-000000d36a01', '00000000-0000-0000-0000-000000d36b01', '00000000-0000-0000-0000-000000d36e01', '00000000-0000-0000-0000-000000d36f08', '00000000-0000-0000-0000-000000d36d05', 'sistema') returning 1 as should_fail;
rollback;

\echo '65. las funciones nuevas son definer con search_path fijo'
begin;
select count(*)::int as sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname in ('conciliacion_sesion_propuestas_guardar','conciliacion_sesion_asegurar','conciliacion_autopiloto_confirmar','conciliacion_match_insertar','conciliacion_matches_confirmar') and (not p.prosecdef or p.proconfig is null);
rollback;

\echo '66. anon y public sin EXECUTE en las funciones nuevas; el nucleo interno tampoco para authenticated'
begin;
select (has_function_privilege('anon', 'despachos.conciliacion_sesion_propuestas_guardar(uuid,uuid,jsonb)', 'execute')::int + has_function_privilege('anon', 'despachos.conciliacion_sesion_asegurar(uuid,text,text)', 'execute')::int + has_function_privilege('anon', 'despachos.conciliacion_autopiloto_confirmar(uuid,jsonb)', 'execute')::int + has_function_privilege('public', 'despachos.conciliacion_autopiloto_confirmar(uuid,jsonb)', 'execute')::int + has_function_privilege('authenticated', 'despachos.conciliacion_match_insertar(uuid,uuid,uuid,smallint,numeric,text)', 'execute')::int) as ejecutables_deberia_ser_0;
rollback;

\echo '67. authenticated conserva EXECUTE de las 3 funciones nuevas (control)'
begin;
select (has_function_privilege('authenticated', 'despachos.conciliacion_sesion_propuestas_guardar(uuid,uuid,jsonb)', 'execute')::int + has_function_privilege('authenticated', 'despachos.conciliacion_sesion_asegurar(uuid,text,text)', 'execute')::int + has_function_privilege('authenticated', 'despachos.conciliacion_autopiloto_confirmar(uuid,jsonb)', 'execute')::int) as ejecutables_deberia_ser_3;
rollback;

\echo '68. las tablas siguen sin privilegios de escritura para authenticated y sin ninguno para anon'
begin;
select count(*)::int as tablas_con_privilegios_de_mas_deberia_ser_0 from unnest(array['conciliacion_sesion','conciliacion_match','conciliacion_sugerencia']) as t(nombre) where has_table_privilege('anon'::name, 'despachos.' || t.nombre, 'select, insert, update, delete') or has_table_privilege('authenticated'::name, 'despachos.' || t.nombre, 'insert, update, delete, truncate');
rollback;

\echo 'Todos los escenarios deben pasar (should_fail = ERROR de Postgres; deberia_ser_N = valor).'
