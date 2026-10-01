-- D-21 + D-22 -- verificación contra Postgres REAL de la migración 018 (cartera de clientes + CFDI completo).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias
-- `..._deberia_ser_N` = el valor esperado (ver run-gate.mjs). Sujetos: staff admin de A (org-wide), contador de A
-- acotado a UN cliente, readonly de A, admin de B (otro despacho), staff de un hotel, staff de un despacho
-- suspendido, y una sesión sin sub (anon / sistema). Todos los RFC y correos son ficticios.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-000000d21a01', 'despachos', 'Despacho A', 'despacho-a-cartera', 'active'),
  ('00000000-0000-0000-0000-000000d21a02', 'despachos', 'Despacho B', 'despacho-b-cartera', 'active'),
  ('00000000-0000-0000-0000-000000d21a03', 'hoteles', 'Hotel H', 'hotel-h-cartera', 'active'),
  ('00000000-0000-0000-0000-000000d21a04', 'despachos', 'Despacho C suspendido', 'despacho-c-cartera', 'suspended'),
  ('00000000-0000-0000-0000-000000d21a05', 'despachos', 'Despacho D tope', 'despacho-d-cartera', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21a01', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-000000d21b02', '00000000-0000-0000-0000-000000d21a01', 'despachos', 'Cliente A2 sin ficha'),
  ('00000000-0000-0000-0000-000000d21b03', '00000000-0000-0000-0000-000000d21a02', 'despachos', 'Cliente B1'),
  ('00000000-0000-0000-0000-000000d21b04', '00000000-0000-0000-0000-000000d21a03', 'hoteles', 'Hotel H1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000d21c01', 'cartera-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000d21c02', 'cartera-contador-a@example.com', 'Contador A1', 'seed'),
  ('00000000-0000-0000-0000-000000d21c03', 'cartera-readonly-a@example.com', 'Readonly A', 'seed'),
  ('00000000-0000-0000-0000-000000d21c04', 'cartera-admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-000000d21c05', 'cartera-nadie@example.com', 'Sin membresia', 'seed'),
  ('00000000-0000-0000-0000-000000d21c06', 'cartera-admin-h@example.com', 'Admin hotel', 'seed'),
  ('00000000-0000-0000-0000-000000d21c07', 'cartera-admin-c@example.com', 'Admin C', 'seed'),
  ('00000000-0000-0000-0000-000000d21c08', 'cartera-admin-d@example.com', 'Admin D', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000d21c01', '00000000-0000-0000-0000-000000d21a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d21c02', '00000000-0000-0000-0000-000000d21a01', array['00000000-0000-0000-0000-000000d21b01']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000d21c03', '00000000-0000-0000-0000-000000d21a01', null, 'viewer', 'readonly'),
  ('00000000-0000-0000-0000-000000d21c04', '00000000-0000-0000-0000-000000d21a02', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d21c06', '00000000-0000-0000-0000-000000d21a03', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d21c07', '00000000-0000-0000-0000-000000d21a04', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d21c08', '00000000-0000-0000-0000-000000d21a05', null, 'admin', 'admin')
on conflict do nothing;
insert into despachos.cliente_ficha (property_id, organization_id, rfc, razon_social, regimenes_fiscales, cp_fiscal, periodicidad) values
  ('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21a01', 'CAA010101AB1', 'Cliente A1 SA de CV', array['601'], '06600', 'mensual'),
  ('00000000-0000-0000-0000-000000d21b03', '00000000-0000-0000-0000-000000d21a02', 'CBB020202BC2', 'Cliente B1 SA de CV', array['601'], '64000', 'mensual')
on conflict do nothing;
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, fecha) values
  ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e01', 'I', 'CAA010101AB1', 'RRR010101RR1', 100, 116, 16, true, '2026-07-10'),
  ('00000000-0000-0000-0000-000000d21d02', '00000000-0000-0000-0000-000000d21a02', '00000000-0000-0000-0000-000000d21b03', '00000000-0000-0000-0000-000000d21e02', 'I', 'CBB020202BC2', 'RRR020202RR2', 200, 232, 32, true, '2026-07-11')
on conflict do nothing;

\echo '=== ALTA DE CLIENTE (cliente_alta) ==='
\echo '1. alta positiva (admin de A): crea la ficha con el RFC normalizado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null);
select count(*) as alta_crea_ficha_deberia_ser_1 from despachos.cliente_ficha where rfc = 'NNN010101NN1' and organization_id = '00000000-0000-0000-0000-000000d21a01';
rollback;

\echo '2. alta persona moral (RFC de 12) deriva tipo_persona = moral'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null);
select (tipo_persona = 'moral')::int as tipo_moral_deberia_ser_1 from despachos.cliente_ficha where rfc = 'NNN010101NN1';
rollback;

\echo '3. alta persona fisica (RFC de 13) deriva tipo_persona = fisica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'PEPJ800101AB1', 'Nuevo SA de CV', array['612'], '03100', 'mensual', null);
select (tipo_persona = 'fisica')::int as tipo_fisica_deberia_ser_1 from despachos.cliente_ficha where rfc = 'PEPJ800101AB1';
rollback;

\echo '4. el alta crea una property de vertical despachos en la organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null);
select count(*) as property_despachos_deberia_ser_1 from core.property p join despachos.cliente_ficha f on f.property_id = p.id where f.rfc = 'NNN010101NN1' and p.vertical = 'despachos' and p.organization_id = '00000000-0000-0000-0000-000000d21a01';
rollback;

\echo '5. normaliza: RFC en minusculas se guarda en mayusculas y regimenes repetidos se deduplican'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'nnn010101nn1', 'Nuevo SA de CV', array['601','601',' 603 '], '03100', 'mensual', null);
select (rfc = 'NNN010101NN1' and regimenes_fiscales = array['601','603'])::int as normalizado_deberia_ser_1 from despachos.cliente_ficha where organization_id = '00000000-0000-0000-0000-000000d21a01' and rfc = 'NNN010101NN1';
rollback;

\echo '6. contador acotado a UN cliente NO puede dar de alta (el alta es de toda la organizacion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c02', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '7. readonly NO puede dar de alta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c03', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '8. cross-tenant: admin de B NO puede dar de alta en la organizacion A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '9. staff de un hotel NO puede dar de alta en un despacho'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c06', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '10. usuario sin membresia NO puede dar de alta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c05', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '11. organizacion suspendida NO da de alta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c07', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a04', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '12. sin sub (sistema/anonimo con rol authenticated) NO puede dar de alta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '13. anon no tiene EXECUTE sobre cliente_alta'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '=== VALIDACION DE LA FICHA ==='
\echo '14. RFC generico XAXX010101000 se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'XAXX010101000', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '15. RFC generico XEXX010101000 se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'XEXX010101000', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '16. RFC con mes imposible (13) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN011301NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '17. RFC con dia imposible (32) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010132NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '18. RFC demasiado corto se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN0101', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '19. RFC con caracteres invalidos se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NN!010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '20. regimen malformado (2 digitos) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['60'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '21. sin regimenes (arreglo vacio) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array[]::text[], '03100', 'mensual', null) as should_fail;
rollback;

\echo '22. regimenes nulos se rechazan'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', null, '03100', 'mensual', null) as should_fail;
rollback;

\echo '23. mas de 10 regimenes se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['600','601','602','603','604','605','606','607','608','609','610'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '24. CP fiscal de 4 digitos se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '1234', 'mensual', null) as should_fail;
rollback;

\echo '25. periodicidad fuera de catalogo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'semanal', null) as should_fail;
rollback;

\echo '26. razon social vacia se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', '   ', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '27. nombre vacio se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', '  ', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '28. responsable de OTRA organizacion se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', '00000000-0000-0000-0000-000000d21c04') as should_fail;
rollback;

\echo '29. responsable staff de la misma organizacion se acepta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', '00000000-0000-0000-0000-000000d21c03');
select count(*) as responsable_ok_deberia_ser_1 from despachos.cliente_ficha where rfc = 'NNN010101NN1' and responsable_id = '00000000-0000-0000-0000-000000d21c03';
rollback;

\echo '30. RFC duplicado en la misma organizacion se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a01', 'Cliente nuevo', 'CAA010101AB1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '31. el mismo RFC en OTRA organizacion si se permite (cada despacho lleva su cartera)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a02', 'Cliente nuevo', 'CAA010101AB1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null);
select count(*) as mismo_rfc_otra_org_deberia_ser_1 from despachos.cliente_ficha where rfc = 'CAA010101AB1' and organization_id = '00000000-0000-0000-0000-000000d21a02';
rollback;

\echo '32. tope de 500 clientes por organizacion (54000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c08', true);
reset role;
insert into core.property (organization_id, vertical, name) select '00000000-0000-0000-0000-000000d21a05', 'despachos', 'Cliente ' || g from generate_series(1, 500) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c08', true);
select * from despachos.cliente_alta('00000000-0000-0000-0000-000000d21a05', 'Cliente nuevo', 'NNN010101NN1', 'Nuevo SA de CV', array['601'], '03100', 'mensual', null) as should_fail;
rollback;

\echo '=== GUARDAR / ACTUALIZAR FICHA (cliente_ficha_guardar) ==='
\echo '33. contador acotado actualiza la ficha de SU cliente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c02', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b01', 'CAA010101AB1', 'Razon nueva SA', array['601'], '11000', 'bimestral', null);
select (razon_social = 'Razon nueva SA' and cp_fiscal = '11000' and periodicidad = 'bimestral')::int as actualizo_deberia_ser_1 from despachos.cliente_ficha where property_id = '00000000-0000-0000-0000-000000d21b01';
rollback;

\echo '34. contador acotado NO actualiza la ficha de un cliente fuera de su alcance (A2)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c02', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b02', 'ZZZ010101ZZ1', 'Cliente A1 SA de CV', array['601'], '06600', 'mensual', null) as should_fail;
rollback;

\echo '35. el RFC de una ficha existente NO se cambia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b01', 'CAA010101AB2', 'Cliente A1 SA de CV', array['601'], '06600', 'mensual', null) as should_fail;
rollback;

\echo '36. admin crea la ficha de una property existente sin ficha (A2)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b02', 'DDD010101DD1', 'A2 SA', array['601'], '01000', 'mensual', null);
select count(*) as ficha_a2_deberia_ser_1 from despachos.cliente_ficha where property_id = '00000000-0000-0000-0000-000000d21b02';
rollback;

\echo '37. cross-tenant: admin de B NO guarda la ficha de un cliente de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b01', 'CAA010101AB1', 'Cliente A1 SA de CV', array['601'], '06600', 'mensual', null) as should_fail;
rollback;

\echo '38. una property de hoteles NO admite ficha'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c06', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b04', 'HHH010101HH1', 'Cliente A1 SA de CV', array['601'], '06600', 'mensual', null) as should_fail;
rollback;

\echo '39. readonly NO guarda fichas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c03', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b01', 'CAA010101AB1', 'Cliente A1 SA de CV', array['601'], '06600', 'mensual', null) as should_fail;
rollback;

\echo '40. guardar valida el formato (CP invalido)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b01', 'CAA010101AB1', 'Cliente A1 SA de CV', array['601'], 'ABCDE', 'mensual', null) as should_fail;
rollback;

\echo '41. anon no tiene EXECUTE sobre cliente_ficha_guardar'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.cliente_ficha_guardar('00000000-0000-0000-0000-000000d21b01', 'CAA010101AB1', 'Cliente A1 SA de CV', array['601'], '06600', 'mensual', null) as should_fail;
rollback;

\echo '=== LECTURA (RLS) Y ESCRITURA DIRECTA CERRADA ==='
\echo '42. admin de A ve SOLO las fichas de su organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select (count(*) = 1 and bool_and(organization_id = '00000000-0000-0000-0000-000000d21a01'))::int as ve_solo_las_suyas_deberia_ser_1 from despachos.cliente_ficha;
rollback;

\echo '43. el contador acotado ve solo la ficha de su cliente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c02', true);
select count(*) as contador_ve_una_deberia_ser_1 from despachos.cliente_ficha;
rollback;

\echo '44. cross-tenant: admin de B no ve la ficha de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
select count(*) as b_no_ve_a_deberia_ser_0 from despachos.cliente_ficha where property_id = '00000000-0000-0000-0000-000000d21b01';
rollback;

\echo '45. sin sub no ve ninguna ficha'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sin_sub_deberia_ser_0 from despachos.cliente_ficha;
rollback;

\echo '46. anon NO puede leer fichas'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from despachos.cliente_ficha;
rollback;

\echo '47. INSERT directo en cliente_ficha esta cerrado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.cliente_ficha (property_id, organization_id, rfc, razon_social, regimenes_fiscales, cp_fiscal) values ('00000000-0000-0000-0000-000000d21b02', '00000000-0000-0000-0000-000000d21a01', 'EEE010101EE1', 'X', array['601'], '01000') returning 1 as should_fail;
rollback;

\echo '48. UPDATE directo en cliente_ficha esta cerrado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
update despachos.cliente_ficha set razon_social = 'X' where property_id = '00000000-0000-0000-0000-000000d21b01' returning 1 as should_fail;
rollback;

\echo '49. DELETE directo en cliente_ficha esta cerrado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
delete from despachos.cliente_ficha where property_id = '00000000-0000-0000-0000-000000d21b01' returning 1 as should_fail;
rollback;

\echo '50. el helper cartera_puede_escribir NO es ejecutable por authenticated'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select despachos.cartera_puede_escribir('00000000-0000-0000-0000-000000d21b01') as should_fail;
rollback;

\echo '=== CFDI COMPLETO: columnas nuevas y desglose de impuestos ==='
\echo '51. una fila de invoice con solo las columnas historicas sigue siendo valida (estado_sat = pendiente, resto NULL)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e03', 'I', 'CAA010101AB1', 'RRR010101RR1', 10, 11.6, true, '2026-07-12');
select count(*) as legado_deberia_ser_1 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d21e03' and estado_sat = 'pendiente' and direccion is null and total_centavos is null and moneda is null;
rollback;

\echo '52. el insert con las columnas nuevas funciona (staff de A, su property)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, fecha, direccion, metodo_pago, forma_pago, uso_cfdi, moneda, tipo_cambio, subtotal_centavos, total_centavos, iva_trasladado_centavos)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e04', 'I', 'CAA010101AB1', 'RRR010101RR1', 100, 116, 16, true, '2026-07-12', 'emitido', 'PPD', '99', 'G03', 'USD', 17.512345, 10000, 11600, 1600);
select count(*) as insert_completo_deberia_ser_1 from despachos.invoice where folio_fiscal = '00000000-0000-0000-0000-000000d21e04' and tipo_cambio = 17.512345;
rollback;

\echo '53. CHECK de direccion: valor invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, direccion)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1, 1, true, '2026-07-12', 'sideral') returning 1 as should_fail;
rollback;

\echo '54. CHECK de metodo_pago: valor invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, metodo_pago)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1, 1, true, '2026-07-12', 'XYZ') returning 1 as should_fail;
rollback;

\echo '55. CHECK de forma_pago: valor invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, forma_pago)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1, 1, true, '2026-07-12', '1') returning 1 as should_fail;
rollback;

\echo '56. CHECK de uso_cfdi: valor invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, uso_cfdi)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1, 1, true, '2026-07-12', 'g03') returning 1 as should_fail;
rollback;

\echo '57. CHECK de moneda: valor invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, moneda)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1, 1, true, '2026-07-12', 'mxn') returning 1 as should_fail;
rollback;

\echo '58. CHECK de tipo_cambio: valor invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, tipo_cambio)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1, 1, true, '2026-07-12', 0) returning 1 as should_fail;
rollback;

\echo '59. CHECK de subtotal_centavos: valor invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, subtotal_centavos)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1, 1, true, '2026-07-12', -1) returning 1 as should_fail;
rollback;

\echo '60. CHECK de estado_sat: valor invalido se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha, estado_sat)
values ('00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21e05', 'I', 'CAA010101AB1', 'RRR010101RR1', 1, 1, true, '2026-07-12', 'raro') returning 1 as should_fail;
rollback;

\echo '61. insert de un impuesto (IVA 16%) del CFDI de la property propia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600);
select count(*) as impuesto_ok_deberia_ser_1 from despachos.invoice_impuesto where invoice_id = '00000000-0000-0000-0000-000000d21d01';
rollback;

\echo '62. traslado Exento sin tasa ni importe es valido'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Exento', null, 10000, null);
select count(*) as exento_ok_deberia_ser_1 from despachos.invoice_impuesto where invoice_id = '00000000-0000-0000-0000-000000d21d01' and tipo_factor = 'Exento';
rollback;

\echo '63. Exento con importe se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Exento', null, 10000, 1600) returning 1 as should_fail;
rollback;

\echo '64. una RETENCION no puede ser Exenta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'retencion', '002', 'Exento', null, 10000, null) returning 1 as should_fail;
rollback;

\echo '65. impuesto fuera de catalogo (004) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '004', 'Tasa', 0.160000, 10000, 1600) returning 1 as should_fail;
rollback;

\echo '66. importe negativo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, -5) returning 1 as should_fail;
rollback;

\echo '67. el mismo renglon (naturaleza, impuesto, factor, tasa) no se duplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600) returning 1 as should_fail;
rollback;

\echo '68. cross-tenant: admin de B NO inserta impuestos en un CFDI de A (property de A)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600) returning 1 as should_fail;
rollback;

\echo '69. cross-tenant: admin de B NO apunta un impuesto de SU property al CFDI de A (FK compuesta)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a02', '00000000-0000-0000-0000-000000d21b03', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600) returning 1 as should_fail;
rollback;

\echo '70. cross-cliente: un impuesto con la property equivocada (A2) para el CFDI de A1 se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b02', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600) returning 1 as should_fail;
rollback;

\echo '71. el contador acotado a A1 NO inserta impuestos de un CFDI de A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c02', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b02', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600) returning 1 as should_fail;
rollback;

\echo '72. anon NO puede insertar impuestos'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600) returning 1 as should_fail;
rollback;

\echo '73. lectura: admin de B no ve los impuestos de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
reset role;
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
select count(*) as b_no_ve_impuestos_de_a_deberia_ser_0 from despachos.invoice_impuesto;
rollback;

\echo '74. lectura: el staff de A ve los impuestos de su cliente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
reset role;
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select count(*) as a_ve_sus_impuestos_deberia_ser_1 from despachos.invoice_impuesto;
rollback;

\echo '75. anon NO puede leer impuestos'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from despachos.invoice_impuesto;
rollback;

\echo '76. UPDATE directo de impuestos esta cerrado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
reset role;
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
update despachos.invoice_impuesto set importe_centavos = 1 returning 1 as should_fail;
rollback;

\echo '77. DELETE directo de impuestos esta cerrado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
reset role;
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
delete from despachos.invoice_impuesto returning 1 as should_fail;
rollback;

\echo '78. borrar el CFDI (service) borra en cascada su desglose'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
reset role;
insert into despachos.invoice_impuesto (invoice_id, organization_id, property_id, naturaleza, impuesto, tipo_factor, tasa_o_cuota, base_centavos, importe_centavos) values ('00000000-0000-0000-0000-000000d21d01', '00000000-0000-0000-0000-000000d21a01', '00000000-0000-0000-0000-000000d21b01', 'traslado', '002', 'Tasa', 0.160000, 10000, 1600);
delete from despachos.invoice where id = '00000000-0000-0000-0000-000000d21d01';
select count(*) as cascada_deberia_ser_0 from despachos.invoice_impuesto where invoice_id = '00000000-0000-0000-0000-000000d21d01';
rollback;

\echo '=== ESTADO SAT (invoice_estado_sat_registrar) ==='
\echo '79. el contador acotado registra 'vigente''
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c02', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'vigente');
select (estado_sat = 'vigente' and estado_sat_verificado_en is not null)::int as sat_vigente_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-000000d21d01';
rollback;

\echo '80. un CFDI cancelado no regresa a vigente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'cancelado');
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'vigente') as should_fail;
rollback;

\echo '81. cancelado -> cancelado es idempotente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'cancelado');
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'cancelado');
select (estado_sat = 'cancelado')::int as cancelado_idempotente_deberia_ser_1 from despachos.invoice where id = '00000000-0000-0000-0000-000000d21d01';
rollback;

\echo '82. estado fuera de catalogo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'vencido') as should_fail;
rollback;

\echo '83. cross-tenant: admin de B NO cambia el estado de un CFDI de A (sin acceso a la property)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'vigente') as should_fail;
rollback;

\echo '84. cross-tenant: admin de B con SU property pero el id de un CFDI de A -> no existe en esa property'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c04', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b03', '00000000-0000-0000-0000-000000d21d01', 'vigente') as should_fail;
rollback;

\echo '85. readonly NO registra el estado SAT'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c03', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'vigente') as should_fail;
rollback;

\echo '86. anon NO tiene EXECUTE sobre invoice_estado_sat_registrar'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'vigente') as should_fail;
rollback;

\echo '87. sin sub NO registra el estado SAT'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.invoice_estado_sat_registrar('00000000-0000-0000-0000-000000d21b01', '00000000-0000-0000-0000-000000d21d01', 'vigente') as should_fail;
rollback;

\echo '88. UPDATE directo de estado_sat sobre invoice esta cerrado (sin GRANT de UPDATE)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d21c01', true);
update despachos.invoice set estado_sat = 'vigente' where id = '00000000-0000-0000-0000-000000d21d01' returning 1 as should_fail;
rollback;

\echo 'Fin: 88 escenarios. Los que deben terminar en ERROR llevan el alias should_fail.'
