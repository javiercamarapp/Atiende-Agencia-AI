-- D-24 + D-25 -- verificación contra Postgres REAL de la migración 020 (libro contable y pagos provisionales).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias
-- `..._deberia_ser_N` = el valor esperado (ver run-gate.mjs). Los negativos tienen un control positivo con la misma
-- precondición para que un fallo por otra causa no se confunda con la defensa que se prueba.
-- Sujetos: admin de A (org-wide), contador de A acotado a UN cliente, readonly de A, admin de B (otro despacho), admin de
-- un hotel, usuario sin membresía y una sesión sin sub (anon / sistema). Todos los RFC, folios y correos son ficticios.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-000000d24a01', 'despachos', 'Despacho A', 'despacho-a-libro', 'active'),
  ('00000000-0000-0000-0000-000000d24a02', 'despachos', 'Despacho B', 'despacho-b-libro', 'active'),
  ('00000000-0000-0000-0000-000000d24a03', 'hoteles', 'Hotel H', 'hotel-h-libro', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', 'despachos', 'Cliente A2'),
  ('00000000-0000-0000-0000-000000d24b03', '00000000-0000-0000-0000-000000d24a02', 'despachos', 'Cliente B1'),
  ('00000000-0000-0000-0000-000000d24b04', '00000000-0000-0000-0000-000000d24a03', 'hoteles', 'Hotel H1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000d24c01', 'libro-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000d24c02', 'libro-contador-a@example.com', 'Contador A1', 'seed'),
  ('00000000-0000-0000-0000-000000d24c03', 'libro-readonly-a@example.com', 'Readonly A', 'seed'),
  ('00000000-0000-0000-0000-000000d24c04', 'libro-admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-000000d24c05', 'libro-nadie@example.com', 'Sin membresia', 'seed'),
  ('00000000-0000-0000-0000-000000d24c06', 'libro-admin-h@example.com', 'Admin hotel', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000d24c01', '00000000-0000-0000-0000-000000d24a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d24c02', '00000000-0000-0000-0000-000000d24a01', array['00000000-0000-0000-0000-000000d24b01']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000d24c03', '00000000-0000-0000-0000-000000d24a01', null, 'viewer', 'readonly'),
  ('00000000-0000-0000-0000-000000d24c04', '00000000-0000-0000-0000-000000d24a02', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d24c06', '00000000-0000-0000-0000-000000d24a03', null, 'admin', 'admin')
on conflict do nothing;
-- Catálogo de A1 y de B1 (insert directo: el fixture corre como dueño, no por las funciones).
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values
  ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', '1020000', 'Bancos', 'D'),
  ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', '1050000', 'Clientes', 'D'),
  ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', '2010000', 'Proveedores nacionales', 'A'),
  ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', '2600300', 'IVA acreditable', 'D'),
  ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', '2600400', 'IVA trasladado', 'A'),
  ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', '4080000', 'Ingresos por servicios', 'A'),
  ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', '6020100', 'Servicios profesionales', 'D'),
  ('00000000-0000-0000-0000-000000d24b03', '00000000-0000-0000-0000-000000d24a02', '1050000', 'Clientes', 'D'),
  ('00000000-0000-0000-0000-000000d24b03', '00000000-0000-0000-0000-000000d24a02', '4080000', 'Ingresos por servicios', 'A')
on conflict do nothing;
-- CFDI ficticios (centavos). 100000 + 16000 de IVA = 116000.
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, fecha,
                               direccion, metodo_pago, forma_pago, uso_cfdi, moneda, subtotal_centavos, total_centavos, iva_trasladado_centavos, estado_sat) values
  ('00000000-0000-0000-0000-000000d24d01', '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24e01', 'I', 'CAA010101AB1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-10', 'emitido', 'PPD', '99', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d24d02', '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24e02', 'I', 'PPP010101PP1', 'CAA010101AB1', 1000, 1160, 160, true, '2026-07-11', 'recibido', 'PPD', '99', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d24d03', '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24e03', 'I', 'CAA010101AB1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-12', 'emitido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d24d04', '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24e04', 'I', 'CAA010101AB1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-13', 'emitido', 'PPD', '99', 'G03', 'MXN', 100000, 116000, 16000, 'cancelado'),
  ('00000000-0000-0000-0000-000000d24d05', '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-14', 'emitido', 'PPD', '99', 'G03', 'USD', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d24d06', '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24e06', 'I', 'CAA020202AB2', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-15', 'emitido', 'PPD', '99', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-000000d24d07', '00000000-0000-0000-0000-000000d24a02', '00000000-0000-0000-0000-000000d24b03', '00000000-0000-0000-0000-000000d24e07', 'I', 'CBB020202BC2', 'RRR020202RR2', 1000, 1160, 160, true, '2026-07-16', 'emitido', 'PPD', '99', 'G03', 'MXN', 100000, 116000, 16000, 'vigente')
on conflict do nothing;

\echo '=== CATALOGO DE CUENTAS ==='
\echo '1. siembra el catalogo del cliente A2 (admin de A)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"},{"codigo":"2600400","descripcion":"IVA trasladado","naturaleza":"A"}]'::jsonb);
select count(*) as siembra_deberia_ser_3 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d24b02';
rollback;

\echo '2. la siembra es idempotente (dos veces = mismas 3 cuentas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"},{"codigo":"2600400","descripcion":"IVA trasladado","naturaleza":"A"}]'::jsonb);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"},{"codigo":"2600400","descripcion":"IVA trasladado","naturaleza":"A"}]'::jsonb);
select count(*) as siembra_idempotente_deberia_ser_3 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d24b02';
rollback;

\echo '3. naturaleza invalida en la siembra se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"X"}]'::jsonb) as should_fail;
rollback;

\echo '4. contador acotado a A1 NO siembra el catalogo de A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c02', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"},{"codigo":"2600400","descripcion":"IVA trasladado","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '5. readonly NO siembra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c03', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"},{"codigo":"2600400","descripcion":"IVA trasladado","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '6. cross-tenant: admin de B NO siembra el catalogo de A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"},{"codigo":"2600400","descripcion":"IVA trasladado","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '7. anon NO tiene EXECUTE sobre la siembra'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"},{"codigo":"2600400","descripcion":"IVA trasladado","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '8. sin sub (rol authenticated) NO siembra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d24b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"},{"codigo":"2600400","descripcion":"IVA trasladado","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '9. alta de una cuenta nueva (admin de A)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d24b01', '6020900', 'Gastos varios', 'D');
select count(*) as cuenta_nueva_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d24b01' and codigo = '6020900';
rollback;

\echo '10. codigo de cuenta invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d24b01', '12', 'Corta', 'D') as should_fail;
rollback;

\echo '11. una cuenta con partidas NO cambia de naturaleza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d24b01', '1050000', 'Clientes', 'A') as should_fail;
rollback;

\echo '12. control: cambiar la descripcion (misma naturaleza) de una cuenta con partidas SI se permite'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d24b01', '1050000', 'Clientes nacionales', 'D');
rollback;

\echo '=== POLIZAS ==='
\echo '13. registra una poliza de ingreso cuadrada: folio 1, 3 partidas, total en centavos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select count(*) as poliza_ok_deberia_ser_1 from despachos.libro_poliza p where p.property_id = '00000000-0000-0000-0000-000000d24b01' and p.folio = 1 and p.tipo = 'ingreso' and p.total_centavos = 116000 and (select count(*) from despachos.libro_movimiento m where m.poliza_id = p.id) = 3;
rollback;

\echo '14. folio consecutivo por (cliente, mes, tipo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select max(folio) as folio_deberia_ser_2 from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and tipo = 'ingreso';
rollback;

\echo '15. el folio es independiente por tipo de poliza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'diario', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select count(*) as folios_independientes_deberia_ser_2 from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and folio = 1;
rollback;

\echo '16. poliza descuadrada se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}]'::jsonb, null) as should_fail;
rollback;

\echo '17. una partida con debe Y haber se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta":"1050000","debe":5,"haber":5},{"cuenta":"4080000","debe":0,"haber":0}]'::jsonb, null) as should_fail;
rollback;

\echo '18. una partida en cero se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 100, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 0}]'::jsonb, null) as should_fail;
rollback;

\echo '19. una poliza de una sola partida se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 100, "haber": 0}]'::jsonb, null) as should_fail;
rollback;

\echo '20. una cuenta que no existe en el catalogo del cliente se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 100, "haber": 0}, {"cuenta": "9999999", "concepto": "", "debe": 0, "haber": 100}]'::jsonb, null) as should_fail;
rollback;

\echo '21. montos con decimales (no son centavos enteros) se rechazan'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta":"1050000","debe":10.5,"haber":0},{"cuenta":"4080000","debe":0,"haber":10.5}]'::jsonb, null) as should_fail;
rollback;

\echo '22. periodo cerrado: la poliza se rechaza'
begin;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 7, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null) as should_fail;
rollback;

\echo '23. control: con el periodo abierto la misma poliza SI se registra'
begin;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 7, 'open');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
rollback;

\echo '24. control: periodo cerrado de OTRO mes no bloquea julio'
begin;
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 6, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
rollback;

\echo '25. contador acotado a A1 SI registra en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c02', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select count(*) as contador_registra_deberia_ser_1 from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01';
rollback;

\echo '26. contador acotado a A1 NO registra en A2'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '1050000', 'Clientes', 'D'), ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '4080000', 'Ingresos', 'A'), ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '2600400', 'IVA', 'A');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c02', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b02', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null) as should_fail;
rollback;

\echo '27. control: admin de A SI registra en A2 con el mismo catalogo'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '1050000', 'Clientes', 'D'), ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '4080000', 'Ingresos', 'A'), ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '2600400', 'IVA', 'A');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b02', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
rollback;

\echo '28. readonly NO registra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c03', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null) as should_fail;
rollback;

\echo '29. cross-tenant: admin de B NO registra en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null) as should_fail;
rollback;

\echo '30. staff de un hotel NO registra en un despacho'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c06', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null) as should_fail;
rollback;

\echo '31. usuario sin membresia NO registra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c05', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null) as should_fail;
rollback;

\echo '32. anon NO tiene EXECUTE sobre el registro'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null) as should_fail;
rollback;

\echo '33. sin sub (rol authenticated) NO registra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null) as should_fail;
rollback;

\echo '=== POLIZA DE UN CFDI ==='
\echo '34. poliza ligada a un CFDI emitido: origen cfdi y liga al comprobante'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, '00000000-0000-0000-0000-000000d24d01');
select count(*) as poliza_cfdi_deberia_ser_1 from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and origen = 'cfdi' and invoice_id = '00000000-0000-0000-0000-000000d24d01';
rollback;

\echo '35. un CFDI no tiene dos polizas vigentes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, '00000000-0000-0000-0000-000000d24d01');
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, '00000000-0000-0000-0000-000000d24d01') as should_fail;
rollback;

\echo '36. un CFDI cancelado ante el SAT no se contabiliza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, '00000000-0000-0000-0000-000000d24d04') as should_fail;
rollback;

\echo '37. el CFDI de OTRA property no se liga (no confirma su existencia)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, '00000000-0000-0000-0000-000000d24d06') as should_fail;
rollback;

\echo '38. el CFDI de otra organizacion no se liga'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, '00000000-0000-0000-0000-000000d24d07') as should_fail;
rollback;

\echo '=== REVERSA ==='
\echo '39. la reversa crea una poliza de diario con partidas invertidas y marca la original'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and origen = 'manual'), '2026-07-25', 'Corrige captura');
select count(*) as reversa_deberia_ser_1 from despachos.libro_poliza r join despachos.libro_poliza o on o.id = r.reversa_de where r.origen = 'reversa' and r.tipo = 'diario' and o.reversada and r.total_centavos = o.total_centavos;
rollback;

\echo '40. tras la reversa el saldo neto de cada cuenta es cero'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and origen = 'manual'), '2026-07-25', 'Corrige captura');
select count(*) as saldo_neto_deberia_ser_0 from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 7) where out_saldo_final_centavos <> 0;
rollback;

\echo '41. una poliza no se revierte dos veces'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and origen = 'manual'), '2026-07-25', 'Una');
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and origen = 'manual'), '2026-07-26', 'Dos') as should_fail;
rollback;

\echo '42. una poliza de reversa no se revierte'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and origen = 'manual'), '2026-07-25', 'Una');
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where origen = 'reversa' and property_id = '00000000-0000-0000-0000-000000d24b01'), '2026-07-26', 'Otra') as should_fail;
rollback;

\echo '43. revertir una poliza libera al CFDI para contabilizarse de nuevo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, '00000000-0000-0000-0000-000000d24d01');
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and origen = 'cfdi'), '2026-07-25', 'Corrige');
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, '00000000-0000-0000-0000-000000d24d01');
rollback;

\echo '44. la reversa en un periodo cerrado se rechaza'
begin;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
insert into despachos.periodo_cierre (organization_id, property_id, anio, mes, status) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 7, 'closed');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' and origen = 'manual'), '2026-07-25', 'Tarde') as should_fail;
rollback;

\echo '45. cross-tenant: admin de B NO revierte la poliza de A'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' limit 1), '2026-07-25', 'Ajena') as should_fail;
rollback;

\echo '46. readonly NO revierte'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c03', true);
select despachos.libro_poliza_reversar((select id from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' limit 1), '2026-07-25', 'RO') as should_fail;
rollback;

\echo '=== ESCRITURA DIRECTA CERRADA Y RLS ==='
\echo '47. INSERT directo en libro_poliza (authenticated) falla: no hay GRANT'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
insert into despachos.libro_poliza (organization_id, property_id, ejercicio, mes, tipo, folio, fecha, concepto, origen, total_centavos) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ingreso', 99, '2026-07-01', 'x', 'manual', 1) returning id as should_fail;
rollback;

\echo '48. INSERT directo en libro_movimiento falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
insert into despachos.libro_movimiento (poliza_id, organization_id, property_id, linea, cuenta, debe_centavos) values (gen_random_uuid(), '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 1, '1050000', 1) returning id as should_fail;
rollback;

\echo '49. INSERT directo en libro_cuenta falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values ('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24a01', '5555555', 'x', 'D') returning codigo as should_fail;
rollback;

\echo '50. UPDATE directo en libro_poliza falla (una poliza no se edita)'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
update despachos.libro_poliza set concepto = 'editada' where property_id = '00000000-0000-0000-0000-000000d24b01' returning id as should_fail;
rollback;

\echo '51. DELETE directo en libro_movimiento falla'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
delete from despachos.libro_movimiento where property_id = '00000000-0000-0000-0000-000000d24b01' returning id as should_fail;
rollback;

\echo '52. DELETE directo en libro_poliza falla'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
delete from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' returning id as should_fail;
rollback;

\echo '53. anon NO lee el libro'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from despachos.libro_poliza as should_fail;
rollback;

\echo '54. RLS: admin de B ve 0 polizas de A'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select count(*) as ve_ajenas_deberia_ser_0 from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01';
rollback;

\echo '55. RLS: admin de B ve 0 partidas de A'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select count(*) as ve_partidas_ajenas_deberia_ser_0 from despachos.libro_movimiento where property_id = '00000000-0000-0000-0000-000000d24b01';
rollback;

\echo '56. RLS: el contador acotado a A1 ve la poliza de A1'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c02', true);
select count(*) as ve_propias_deberia_ser_1 from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01';
rollback;

\echo '57. RLS: el contador acotado a A1 NO ve las polizas de A2'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '1050000', 'Clientes', 'D'), ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '4080000', 'Ingresos', 'A'), ('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24a01', '2600400', 'IVA', 'A');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b02', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c02', true);
select count(*) as ve_a2_deberia_ser_0 from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b02';
rollback;

\echo '58. llave compuesta: una partida no se liga a la poliza de otra property (aunque se mienta en property_id)'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
reset role;
select set_config('request.jwt.claim.sub', '', true);
insert into despachos.libro_movimiento (poliza_id, organization_id, property_id, linea, cuenta, debe_centavos) select id, organization_id, '00000000-0000-0000-0000-000000d24b03', 9, '1050000', 5 from despachos.libro_poliza where property_id = '00000000-0000-0000-0000-000000d24b01' limit 1 returning id as should_fail;
rollback;

\echo '59. CHECK: la fecha de la poliza debe coincidir con ejercicio y mes'
begin;
select set_config('request.jwt.claim.sub', '', true);
insert into despachos.libro_poliza (organization_id, property_id, ejercicio, mes, tipo, folio, fecha, concepto, origen, total_centavos) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 8, 'ingreso', 1, '2026-07-01', 'x', 'manual', 1) returning id as should_fail;
rollback;

\echo '60. UNIQUE: el folio no se repite por (cliente, mes, tipo)'
begin;
select set_config('request.jwt.claim.sub', '', true);
insert into despachos.libro_poliza (organization_id, property_id, ejercicio, mes, tipo, folio, fecha, concepto, origen, total_centavos) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ingreso', 1, '2026-07-01', 'x', 'manual', 1), ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ingreso', 1, '2026-07-02', 'y', 'manual', 1) returning id as should_fail;
rollback;

\echo '61. CHECK: una partida con debe Y haber en la misma fila se rechaza'
begin;
select set_config('request.jwt.claim.sub', '', true);
insert into despachos.libro_poliza (id, organization_id, property_id, ejercicio, mes, tipo, folio, fecha, concepto, origen, total_centavos) values ('00000000-0000-0000-0000-000000d24f01', '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ingreso', 1, '2026-07-01', 'x', 'manual', 1);
insert into despachos.libro_movimiento (poliza_id, organization_id, property_id, linea, cuenta, debe_centavos, haber_centavos) values ('00000000-0000-0000-0000-000000d24f01', '00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 1, '1050000', 5, 5) returning id as should_fail;
rollback;

\echo '=== BALANZA DERIVADA ==='
\echo '62. la balanza del mes cuadra: suma(debe) = suma(haber)'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-28', 'Cobro', '[{"cuenta": "1020000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "1050000", "concepto": "", "debe": 0, "haber": 116000}]'::jsonb, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select (sum(out_debe_centavos) = sum(out_haber_centavos) and sum(out_debe_centavos) = 232000)::int as balanza_cuadra_deberia_ser_1 from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 7);
rollback;

\echo '63. saldo final de Clientes = cargo menos abono (naturaleza deudora): 116000 - 116000 = 0'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-28', 'Cobro', '[{"cuenta": "1020000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "1050000", "concepto": "", "debe": 0, "haber": 116000}]'::jsonb, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select count(*) as clientes_saldado_deberia_ser_1 from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 7) where out_cuenta = '1050000' and out_saldo_final_centavos = 0 and out_debe_centavos = 116000 and out_haber_centavos = 116000;
rollback;

\echo '64. saldo final de Ingresos (acreedora) = 100000'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-28', 'Cobro', '[{"cuenta": "1020000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "1050000", "concepto": "", "debe": 0, "haber": 116000}]'::jsonb, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select count(*) as ingresos_deberia_ser_1 from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 7) where out_cuenta = '4080000' and out_saldo_final_centavos = 100000 and out_naturaleza = 'A';
rollback;

\echo '65. saldo inicial de agosto = saldo final de julio en cuentas de balance (Bancos 116000)'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-28', 'Cobro', '[{"cuenta": "1020000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "1050000", "concepto": "", "debe": 0, "haber": 116000}]'::jsonb, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select count(*) as inicial_agosto_deberia_ser_1 from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 8) where out_cuenta = '1020000' and out_saldo_inicial_centavos = 116000 and out_debe_centavos = 0 and out_saldo_final_centavos = 116000;
rollback;

\echo '66. las cuentas de resultados se reinician en enero: Ingresos de 2025 no entran al saldo inicial de 2026'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2025-12-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select count(*) as resultados_reinician_deberia_ser_0 from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 1) where out_cuenta = '4080000';
rollback;

\echo '67. las cuentas de balance si se arrastran de un ejercicio al siguiente (Clientes 2025 -> saldo inicial de enero 2026)'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2025-12-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select count(*) as balance_arrastra_deberia_ser_1 from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 1) where out_cuenta = '1050000' and out_saldo_inicial_centavos = 116000;
rollback;

\echo '68. la balanza no mezcla clientes: B1 no ve la de A1'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d24b01', 'ingreso', '2026-07-28', 'Cobro', '[{"cuenta": "1020000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "1050000", "concepto": "", "debe": 0, "haber": 116000}]'::jsonb, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select count(*) as balanza_ajena_deberia_ser_0 from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 7);
rollback;

\echo '69. anon NO tiene EXECUTE sobre la balanza'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.libro_balanza('00000000-0000-0000-0000-000000d24b01', 2026, 7) as should_fail;
rollback;

\echo '=== PAGOS DE CFDI PPD (REP) ==='
\echo '70. registra el pago parcial de un CFDI emitido PPD (devuelve true)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0);
select count(*) as pago_ok_deberia_ser_1 from despachos.pago_cfdi where property_id = '00000000-0000-0000-0000-000000d24b01' and invoice_id = '00000000-0000-0000-0000-000000d24d01' and importe_pagado_centavos = 58000 and flujo = 'trasladado';
rollback;

\echo '71. registra el pago de un CFDI recibido PPD con flujo acreditable'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d02', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'acreditable', 1, 58000, 50000, 8000, 0);
rollback;

\echo '72. el mismo pago del mismo REP es idempotente (no se duplica)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0);
select count(*) as pago_idempotente_deberia_ser_1 from despachos.pago_cfdi where property_id = '00000000-0000-0000-0000-000000d24b01';
rollback;

\echo '73. dos parcialidades que no rebasan el total SI se registran'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '22222222-2222-2222-2222-222222222222', 0, '2026-08-05', 'trasladado', 2, 58000, 50000, 8000, 0);
select count(*) as dos_pagos_deberia_ser_2 from despachos.pago_cfdi where invoice_id = '00000000-0000-0000-0000-000000d24d01';
rollback;

\echo '74. sobrepago: los pagos no pueden sumar mas que el total del CFDI'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 100000, 50000, 8000, 0);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '22222222-2222-2222-2222-222222222222', 0, '2026-08-05', 'trasladado', 2, 20000, 17000, 3000, 0) as should_fail;
rollback;

\echo '75. un CFDI con metodo PUE no recibe pagos de complemento'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d03', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '76. un CFDI cancelado ante el SAT no recibe pagos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d04', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '77. un CFDI en dolares no se registra (solo pesos)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d05', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '78. el flujo debe corresponder al sentido del CFDI (acreditable sobre un emitido se rechaza)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'acreditable', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '79. la base no puede exceder el subtotal del CFDI'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 999999, 8000, 0) as should_fail;
rollback;

\echo '80. el CFDI de OTRA property no se paga desde A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d06', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '81. importe cero o negativo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 0, 50000, 8000, 0) as should_fail;
rollback;

\echo '82. folio de REP con formato invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', 'no-es-un-uuid', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '83. readonly NO registra pagos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c03', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '84. contador acotado a A1 NO registra pagos de A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c02', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24d06', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '85. control: admin de A SI registra pagos de A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b02', '00000000-0000-0000-0000-000000d24d06', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0);
rollback;

\echo '86. cross-tenant: admin de B NO registra pagos en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '87. anon NO tiene EXECUTE sobre el registro de pagos'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '88. sin sub NO registra pagos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0) as should_fail;
rollback;

\echo '89. INSERT directo en pago_cfdi falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
insert into despachos.pago_cfdi (organization_id, property_id, invoice_id, folio_fiscal_rep, pago_index, fecha_pago, flujo, importe_pagado_centavos, base_centavos, iva_centavos) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 1, 0) returning id as should_fail;
rollback;

\echo '90. RLS: admin de B ve 0 pagos de A'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_cfdi_registrar('00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d01', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 58000, 50000, 8000, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select count(*) as pagos_ajenos_deberia_ser_0 from despachos.pago_cfdi where property_id = '00000000-0000-0000-0000-000000d24b01';
rollback;

\echo '91. la llave compuesta impide ligar un pago a la factura de otra property (superusuario)'
begin;
select set_config('request.jwt.claim.sub', '', true);
insert into despachos.pago_cfdi (organization_id, property_id, invoice_id, folio_fiscal_rep, pago_index, fecha_pago, flujo, importe_pagado_centavos, base_centavos, iva_centavos) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', '00000000-0000-0000-0000-000000d24d06', '11111111-1111-1111-1111-111111111111', 0, '2026-08-05', 'trasladado', 1, 1, 0) returning id as should_fail;
rollback;

\echo '=== PAPEL DE TRABAJO DEL PAGO PROVISIONAL ==='
\echo '92. guarda el papel de trabajo del ISR de julio'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
select count(*) as papel_ok_deberia_ser_1 from despachos.pago_provisional where property_id = '00000000-0000-0000-0000-000000d24b01' and impuesto = 'ISR' and estado = 'borrador' and a_cargo_centavos = 200000;
rollback;

\echo '93. guardar de nuevo actualiza el borrador (no duplica)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 100555, 100000, 555, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
select count(*) as papel_actualiza_deberia_ser_1 from despachos.pago_provisional where property_id = '00000000-0000-0000-0000-000000d24b01' and a_cargo_centavos = 555;
rollback;

\echo '94. el papel de IVA y el de ISR del mismo mes conviven'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'IVA', '601', 0, 0, 0, 0, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
select count(*) as dos_papeles_deberia_ser_2 from despachos.pago_provisional where property_id = '00000000-0000-0000-0000-000000d24b01' and mes = 7;
rollback;

\echo '95. a cargo Y a favor a la vez se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 100, 100, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '96. impuesto fuera de catalogo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'IEPS', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '97. mes fuera de rango se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 13, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '98. monto negativo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', -1, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '99. parametros que no son un objeto json se rechazan'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '[1]'::jsonb, 0) as should_fail;
rollback;

\echo '100. readonly NO guarda el papel'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c03', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '101. contador acotado a A1 NO guarda el papel de A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c02', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b02', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '102. cross-tenant: admin de B NO guarda el papel de A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '103. anon NO tiene EXECUTE sobre guardar el papel'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '104. sin sub NO guarda el papel'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '105. presentar marca el papel y cierra el vencimiento ISR del periodo en el calendario fiscal'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 'ISR', '2026-07', '2026-08-17', 'alta');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14');
select count(*) as presentado_deberia_ser_1 from despachos.pago_provisional p join despachos.fiscal_deadline d on d.property_id = p.property_id and d.tipo = 'ISR' and d.periodo = '2026-07' where p.property_id = '00000000-0000-0000-0000-000000d24b01' and p.estado = 'presentado' and p.monto_pagado_centavos = 200000 and d.estado = 'completado' and d.fecha_presentacion = '2026-08-14';
rollback;

\echo '106. presentar sin papel guardado se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14') as should_fail;
rollback;

\echo '107. presentar dos veces se rechaza'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14');
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14') as should_fail;
rollback;

\echo '108. un papel presentado no se recalcula (guardar falla)'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 1, 0, '{"coeficiente":"0.200000"}'::jsonb, 0) as should_fail;
rollback;

\echo '109. presentar con monto negativo se rechaza'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', -1, '2026-08-14') as should_fail;
rollback;

\echo '110. readonly NO presenta'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c03', true);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14') as should_fail;
rollback;

\echo '111. cross-tenant: admin de B NO presenta el papel de A1'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14') as should_fail;
rollback;

\echo '112. anon NO tiene EXECUTE sobre presentar'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14') as should_fail;
rollback;

\echo '113. INSERT directo en pago_provisional falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
insert into despachos.pago_provisional (organization_id, property_id, ejercicio, mes, impuesto, regimen, base_centavos, determinado_centavos, acreditable_centavos, a_cargo_centavos, a_favor_centavos) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 0, 0, 0, 0, 0) returning id as should_fail;
rollback;

\echo '114. UPDATE directo en pago_provisional falla'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
update despachos.pago_provisional set a_cargo_centavos = 0 where property_id = '00000000-0000-0000-0000-000000d24b01' returning id as should_fail;
rollback;

\echo '115. RLS: admin de B ve 0 papeles de A'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c04', true);
select count(*) as papeles_ajenos_deberia_ser_0 from despachos.pago_provisional where property_id = '00000000-0000-0000-0000-000000d24b01';
rollback;

\echo '116. RLS: el contador acotado ve el papel de A1'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c02', true);
select count(*) as papel_propio_deberia_ser_1 from despachos.pago_provisional where property_id = '00000000-0000-0000-0000-000000d24b01';
rollback;

\echo '=== AVISO DE VENCIMIENTO (solo sistema) ==='
\echo '117. sin sub: cuenta 1 obligacion ISR por vencer en la ventana de 7 dias'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 'ISR', '2026-07', '2026-08-17', 'alta', 'pendiente');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select coalesce(sum(out_cantidad), 0) as por_vencer_deberia_ser_1 from despachos.system_pagos_provisionales_por_vencer('2026-08-12', 7);
rollback;

\echo '118. fuera de la ventana no cuenta (hoy 1-ago, ventana 7: el dia 17 queda fuera)'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 'ISR', '2026-07', '2026-08-17', 'alta', 'pendiente');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select coalesce(sum(out_cantidad), 0) as fuera_ventana_deberia_ser_0 from despachos.system_pagos_provisionales_por_vencer('2026-08-01', 7);
rollback;

\echo '119. una obligacion completada no cuenta'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 'ISR', '2026-07', '2026-08-17', 'alta', 'completado');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select coalesce(sum(out_cantidad), 0) as completada_deberia_ser_0 from despachos.system_pagos_provisionales_por_vencer('2026-08-12', 7);
rollback;

\echo '120. un papel PRESENTADO excluye la obligacion del aviso'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 'ISR', '2026-07', '2026-08-17', 'alta', 'pendiente');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
set local role authenticated;
select despachos.pago_provisional_guardar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', '601', 1000000, 300000, 100000, 200000, 0, '{"coeficiente":"0.200000"}'::jsonb, 0);
select despachos.pago_provisional_presentar('00000000-0000-0000-0000-000000d24b01', 2026, 7, 'ISR', 200000, '2026-08-14');
reset role;
select set_config('request.jwt.claim.sub', '', true);
update despachos.fiscal_deadline set estado = 'pendiente' where property_id = '00000000-0000-0000-0000-000000d24b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select coalesce(sum(out_cantidad), 0) as presentada_deberia_ser_0 from despachos.system_pagos_provisionales_por_vencer('2026-08-12', 7);
rollback;

\echo '121. solo cuenta ISR/IVA: una obligacion DIOT no se avisa como pago provisional'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 'DIOT', '2026-07', '2026-08-17', 'alta');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select coalesce(sum(out_cantidad), 0) as diot_deberia_ser_0 from despachos.system_pagos_provisionales_por_vencer('2026-08-12', 7);
rollback;

\echo '122. devuelve una fila por organizacion (A y B por separado) y nada mas que organizacion + conteo'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 'ISR', '2026-07', '2026-08-17', 'alta', 'pendiente');
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values ('00000000-0000-0000-0000-000000d24a02', '00000000-0000-0000-0000-000000d24b03', 'IVA', '2026-07', '2026-08-17', 'alta');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(distinct out_organization_id) as dos_organizaciones_deberia_ser_2 from despachos.system_pagos_provisionales_por_vencer('2026-08-12', 7);
rollback;

\echo '123. una sesion de staff (con sub) NO puede ejecutarla'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad, estado) values ('00000000-0000-0000-0000-000000d24a01', '00000000-0000-0000-0000-000000d24b01', 'ISR', '2026-07', '2026-08-17', 'alta', 'pendiente');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d24c01', true);
select * from despachos.system_pagos_provisionales_por_vencer('2026-08-12', 7) as should_fail;
rollback;

\echo '124. anon NO tiene EXECUTE sobre la funcion de sistema'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_pagos_provisionales_por_vencer('2026-08-12', 7) as should_fail;
rollback;

\echo '125. ventana invalida (40 dias) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_pagos_provisionales_por_vencer('2026-08-12', 40) as should_fail;
rollback;

\echo '126. fecha nula se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.system_pagos_provisionales_por_vencer(null, 7) as should_fail;
rollback;

