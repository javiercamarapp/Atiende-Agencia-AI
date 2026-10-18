-- D-32 -- verificacion contra Postgres REAL de la migracion 023 (igualas y prefacturas de honorarios).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el
-- valor esperado (ver run-gate.mjs). Los negativos tienen un control positivo con la misma precondicion para que un fallo por otra causa no
-- se confunda con la defensa que se prueba.
-- Sujetos: admin de A (org-wide), contador de A acotado a UN cliente, readonly de A, admin de B (otro despacho), admin de un hotel, usuario
-- sin membresia y una sesion sin sub (anon / sistema). Todos los RFC, UUID y correos son ficticios.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-000000f32a01', 'despachos', 'Despacho A', 'despacho-a-honorarios', 'active'),
  ('00000000-0000-0000-0000-000000f32a02', 'despachos', 'Despacho B', 'despacho-b-honorarios', 'active'),
  ('00000000-0000-0000-0000-000000f32a03', 'hoteles', 'Hotel H', 'hotel-h-honorarios', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32a01', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-000000f32b02', '00000000-0000-0000-0000-000000f32a01', 'despachos', 'Cliente A2'),
  ('00000000-0000-0000-0000-000000f32b03', '00000000-0000-0000-0000-000000f32a02', 'despachos', 'Cliente B1'),
  ('00000000-0000-0000-0000-000000f32b04', '00000000-0000-0000-0000-000000f32a03', 'hoteles', 'Hotel H1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000f32c01', 'hon-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000f32c02', 'hon-contador-a@example.com', 'Contador A1', 'seed'),
  ('00000000-0000-0000-0000-000000f32c03', 'hon-readonly-a@example.com', 'Readonly A', 'seed'),
  ('00000000-0000-0000-0000-000000f32c04', 'hon-admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-000000f32c05', 'hon-nadie@example.com', 'Sin membresia', 'seed'),
  ('00000000-0000-0000-0000-000000f32c06', 'hon-admin-h@example.com', 'Admin hotel', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000f32c01', '00000000-0000-0000-0000-000000f32a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000f32c02', '00000000-0000-0000-0000-000000f32a01', array['00000000-0000-0000-0000-000000f32b01']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000f32c03', '00000000-0000-0000-0000-000000f32a01', null, 'viewer', 'readonly'),
  ('00000000-0000-0000-0000-000000f32c04', '00000000-0000-0000-0000-000000f32a02', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000f32c06', '00000000-0000-0000-0000-000000f32a03', null, 'admin', 'admin')
on conflict do nothing;
insert into despachos.cliente_ficha (property_id, organization_id, rfc, razon_social, regimenes_fiscales, cp_fiscal) values
  ('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32a01', 'RRR010101RR1', 'Receptor Uno SA de CV', array['601', '603'], '64000'),
  ('00000000-0000-0000-0000-000000f32b02', '00000000-0000-0000-0000-000000f32a01', 'RRS020202RS2', 'Receptor Dos SC', array['612'], '06600'),
  ('00000000-0000-0000-0000-000000f32b03', '00000000-0000-0000-0000-000000f32a02', 'RRB030303RB3', 'Receptor B SA de CV', array['601'], '44100')
on conflict do nothing;
-- d01 simple (100000 + IVA 16%), d02 con retenciones (ISR 10% y 2/3 de IVA), d03 en A2, d04 en B1, d05 inactiva.
insert into despachos.iguala (id, organization_id, property_id, concepto, monto_base_centavos, tasa_iva_bp, retencion_isr_bp, retiene_iva_dos_tercios, dia_emision, activa) values
  ('00000000-0000-0000-0000-000000f32d01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', 'Iguala contable mensual', 100000, 1600, 0, false, 5, true),
  ('00000000-0000-0000-0000-000000f32d02', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', 'Iguala fiscal con retenciones', 100000, 1600, 1000, true, 5, true),
  ('00000000-0000-0000-0000-000000f32d03', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b02', 'Iguala de A2', 50000, 1600, 0, false, 1, true),
  ('00000000-0000-0000-0000-000000f32d04', '00000000-0000-0000-0000-000000f32a02', '00000000-0000-0000-0000-000000f32b03', 'Iguala de B1', 70000, 1600, 0, false, 1, true),
  ('00000000-0000-0000-0000-000000f32d05', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', 'Iguala inactiva', 10000, 1600, 0, false, 1, false)
on conflict do nothing;

\echo '=== IGUALAS ==='
\echo '1. admin de A crea una iguala en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true);
select count(*) as iguala_creada_deberia_ser_1 from despachos.iguala where property_id = '00000000-0000-0000-0000-000000f32b02' and concepto = 'Iguala nueva' and creado_por = '00000000-0000-0000-0000-000000f32c01' and clave_sat_estado = 'por_verificar';
rollback;

\echo '2. contador de A NO crea iguala (solo admin escribe)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '3. readonly de A NO crea iguala'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c03', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '4. cross-tenant: admin de B NO crea iguala en un cliente de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '5. admin de un hotel NO crea iguala en una property de hoteles'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c06', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b04', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '6. usuario sin membresia NO crea iguala'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c05', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '7. anon NO tiene EXECUTE sobre iguala_guardar'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '8. sesion sin sub NO crea iguala'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '9. monto 0 se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 0, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '10. control: monto 1 centavo si se acepta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 1, 1600, 0, false, 3, 'G03', true);
select count(*) as control_monto_deberia_ser_1 from despachos.iguala where property_id = '00000000-0000-0000-0000-000000f32b02' and monto_base_centavos = 1;
rollback;

\echo '11. tasa de IVA 1000 se rechaza (solo 0, 800 o 1600)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 250000, 1000, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '12. dia de emision 29 se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 29, 'G03', true) as should_fail;
rollback;

\echo '13. concepto de dos caracteres se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'ab', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '14. clave de producto/servicio mal formada se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '15. uso de CFDI mal formado se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'ZZ9', true) as should_fail;
rollback;

\echo '16. retencion de ISR de 5000 bp se rechaza (tope 3500)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 5000, false, 3, 'G03', true) as should_fail;
rollback;

\echo '17. actualizar una iguala cambia el monto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true);
select monto_base_centavos as monto_actualizado_deberia_ser_250000 from despachos.iguala where id = '00000000-0000-0000-0000-000000f32d01';
rollback;

\echo '18. actualizar una iguala inexistente da P0002'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d99', 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '19. actualizar la iguala de A2 diciendo que es de A1 se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d03', 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '20. el contador NO actualiza una iguala'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '21. admin de A elimina una iguala sin prefacturas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_eliminar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d05');
select count(*) as iguala_eliminada_deberia_ser_0 from despachos.iguala where id = '00000000-0000-0000-0000-000000f32d05';
rollback;

\echo '22. NO se elimina una iguala con prefacturas'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-06', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-06-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_eliminar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01') as should_fail;
rollback;

\echo '23. control: la misma iguala sin prefacturas si se elimina'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_eliminar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01');
select count(*) as control_eliminar_deberia_ser_0 from despachos.iguala where id = '00000000-0000-0000-0000-000000f32d01';
rollback;

\echo '24. el contador NO elimina iguala'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.iguala_eliminar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d05') as should_fail;
rollback;

\echo '25. admin de B NO elimina iguala de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select despachos.iguala_eliminar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d05') as should_fail;
rollback;

\echo '26. tope de 50 igualas por cliente: la 51 se rechaza'
begin;
insert into despachos.iguala (organization_id, property_id, concepto, monto_base_centavos) select '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b02', 'Relleno ' || g, 1000 from generate_series(1, 49) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true) as should_fail;
rollback;

\echo '27. control del tope: con 49 igualas la 50 si entra'
begin;
insert into despachos.iguala (organization_id, property_id, concepto, monto_base_centavos) select '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b02', 'Relleno ' || g, 1000 from generate_series(1, 48) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.iguala_guardar('00000000-0000-0000-0000-000000f32b02', null, 'Iguala nueva', '84111500', 'E48', 250000, 1600, 0, false, 3, 'G03', true);
select count(*) as total_igualas_deberia_ser_50 from despachos.iguala where property_id = '00000000-0000-0000-0000-000000f32b02';
rollback;

\echo '=== ESCRITURA DIRECTA CERRADA Y RLS DE LECTURA ==='
\echo '28. INSERT directo en iguala por authenticated falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
insert into despachos.iguala (organization_id, property_id, concepto, monto_base_centavos) values ('00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', 'Directo', 100) returning id as should_fail;
rollback;

\echo '29. UPDATE directo en iguala por authenticated falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
update despachos.iguala set monto_base_centavos = 1 where id = '00000000-0000-0000-0000-000000f32d01' returning id as should_fail;
rollback;

\echo '30. DELETE directo en iguala por authenticated falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
delete from despachos.iguala where id = '00000000-0000-0000-0000-000000f32d05' returning id as should_fail;
rollback;

\echo '31. INSERT directo en prefactura por authenticated falla'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
insert into despachos.prefactura (organization_id, property_id, iguala_id, periodo, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-01', 'x', '84111500', 'E48', 'RRR010101RR1', 'x', '601', '64000', 'G03', '2026-01-05', 100, 16, 116) returning id as should_fail;
rollback;

\echo '32. UPDATE directo en prefactura por authenticated falla'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f02', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-06', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-06-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
update despachos.prefactura set estado = 'timbrada' where id = '00000000-0000-0000-0000-000000f32f02' returning id as should_fail;
rollback;

\echo '33. DELETE directo en prefactura por authenticated falla'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f02', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-06', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-06-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
delete from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f02' returning id as should_fail;
rollback;

\echo '34. RLS: admin de A ve las 4 igualas de A1 y A2 con su fixture (d01, d02, d03, d05)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select count(*) as igualas_de_a_deberia_ser_4 from despachos.iguala;
rollback;

\echo '35. RLS: el contador acotado a A1 NO ve la iguala de A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select count(*) as contador_ve_a2_deberia_ser_0 from despachos.iguala where property_id = '00000000-0000-0000-0000-000000f32b02';
rollback;

\echo '36. RLS: el contador acotado a A1 si ve las igualas de A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select count(*) as contador_ve_a1_deberia_ser_3 from despachos.iguala where property_id = '00000000-0000-0000-0000-000000f32b01';
rollback;

\echo '37. RLS: admin de B solo ve la iguala de B'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select count(*) as admin_b_ve_deberia_ser_1 from despachos.iguala;
rollback;

\echo '38. RLS: admin de B NO ve las prefacturas de A'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f03', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-06', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-06-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select count(*) as prefacturas_ajenas_deberia_ser_0 from despachos.prefactura;
rollback;

\echo '39. RLS: readonly de A ve las prefacturas (solo lectura)'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f03', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-06', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-06-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c03', true);
select count(*) as readonly_ve_deberia_ser_1 from despachos.prefactura;
rollback;

\echo '40. RLS: usuario sin membresia no ve nada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c05', true);
select count(*) as nadie_ve_deberia_ser_0 from despachos.iguala;
rollback;

\echo '41. RLS: anon no lee igualas'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from despachos.iguala;
rollback;

\echo '42. RLS: anon no lee prefacturas'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from despachos.prefactura;
rollback;

\echo '=== GENERAR PREFACTURAS ==='
\echo '43. admin genera la prefactura de julio de una iguala simple: desglose y receptor de la ficha'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000);
select count(*) as prefactura_generada_deberia_ser_1 from despachos.prefactura where iguala_id = '00000000-0000-0000-0000-000000f32d01' and periodo = '2026-07' and estado = 'borrador' and base_centavos = 100000 and iva_centavos = 16000 and total_centavos = 116000 and receptor_rfc = 'RRR010101RR1' and receptor_regimen = '601' and receptor_cp = '64000' and fecha_emision = date '2026-07-05' and creado_por = '00000000-0000-0000-0000-000000f32c01';
rollback;

\echo '44. generar dos veces NO duplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000);
select count(*) as una_sola_deberia_ser_1 from despachos.prefactura where iguala_id = '00000000-0000-0000-0000-000000f32d01' and periodo = '2026-07';
rollback;

\echo '45. la segunda generacion devuelve exactamente null (no un id)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000);
select (despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000) is null)::int as segunda_null_deberia_ser_1;
rollback;

\echo '46. desglose con retenciones: el total neto es 95333'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d02', '2026-07', 100000, 16000, 10000, 10667, 95333);
select total_centavos as total_neto_deberia_ser_95333 from despachos.prefactura where iguala_id = '00000000-0000-0000-0000-000000f32d02';
rollback;

\echo '47. desglose con retenciones: ISR 10% = 10000'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d02', '2026-07', 100000, 16000, 10000, 10667, 95333);
select retencion_isr_centavos as isr_deberia_ser_10000 from despachos.prefactura where iguala_id = '00000000-0000-0000-0000-000000f32d02';
rollback;

\echo '48. desglose con retenciones: 2/3 del IVA = 10667'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d02', '2026-07', 100000, 16000, 10000, 10667, 95333);
select retencion_iva_centavos as iva_ret_deberia_ser_10667 from despachos.prefactura where iguala_id = '00000000-0000-0000-0000-000000f32d02';
rollback;

\echo '49. vector de redondeo compartido con el dominio TypeScript (12345 -> IVA 1975, ISR 1235, ret. IVA 1317, total 11768)'
begin;
insert into despachos.iguala (id, organization_id, property_id, concepto, monto_base_centavos, tasa_iva_bp, retencion_isr_bp, retiene_iva_dos_tercios) values ('00000000-0000-0000-0000-000000f32d06', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', 'Vector de redondeo', 12345, 1600, 1000, true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d06', '2026-07', 12345, 1975, 1235, 1317, 11768);
select count(*) as vector_redondeo_deberia_ser_1 from despachos.prefactura where iguala_id = '00000000-0000-0000-0000-000000f32d06' and total_centavos = 11768;
rollback;

\echo '50. el vector de redondeo con un IVA redondeado hacia abajo (1974) se rechaza'
begin;
insert into despachos.iguala (id, organization_id, property_id, concepto, monto_base_centavos, tasa_iva_bp, retencion_isr_bp, retiene_iva_dos_tercios) values ('00000000-0000-0000-0000-000000f32d06', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', 'Vector de redondeo', 12345, 1600, 1000, true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d06', '2026-07', 12345, 1974, 1235, 1317, 11767) as should_fail;
rollback;

\echo '51. un IVA que no es el de la iguala (15999) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 15999, 0, 0, 115999) as should_fail;
rollback;

\echo '52. una base distinta al monto de la iguala se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 90000, 14400, 0, 0, 104400) as should_fail;
rollback;

\echo '53. un total que no cuadra con el desglose se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116001) as should_fail;
rollback;

\echo '54. retenciones omitidas cuando la iguala las lleva se rechazan'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d02', '2026-07', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '55. una iguala inactiva no genera prefactura'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d05', '2026-07', 10000, 1600, 0, 0, 11600) as should_fail;
rollback;

\echo '56. un cliente sin ficha fiscal no genera prefactura'
begin;
delete from despachos.cliente_ficha where property_id = '00000000-0000-0000-0000-000000f32b01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '57. la iguala de A2 no se genera diciendo que es de A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d03', '2026-07', 50000, 8000, 0, 0, 58000) as should_fail;
rollback;

\echo '58. periodo invalido 2026-13 se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-13', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '59. el contador NO genera prefacturas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '60. readonly NO genera prefacturas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c03', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '61. cross-tenant: admin de B NO genera prefacturas de un cliente de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '62. usuario sin membresia NO genera prefacturas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c05', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '63. anon NO tiene EXECUTE sobre prefactura_generar'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '64. sesion sin sub NO genera prefacturas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.prefactura_generar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 100000, 16000, 0, 0, 116000) as should_fail;
rollback;

\echo '=== APROBAR ==='
\echo '65. admin aprueba un borrador'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_aprobar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01');
select count(*) as aprobada_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'aprobada' and aprobada_en is not null and aprobada_por = '00000000-0000-0000-0000-000000f32c01';
rollback;

\echo '66. aprobar dos veces se rechaza (55000)'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_aprobar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01') as should_fail;
rollback;

\echo '67. no se aprueba una prefactura cancelada'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, motivo_cancelacion, cancelada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'cancelada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '02', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_aprobar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01') as should_fail;
rollback;

\echo '68. el contador NO aprueba'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.prefactura_aprobar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01') as should_fail;
rollback;

\echo '69. readonly NO aprueba'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c03', true);
select despachos.prefactura_aprobar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01') as should_fail;
rollback;

\echo '70. cross-tenant: admin de B NO aprueba'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select despachos.prefactura_aprobar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01') as should_fail;
rollback;

\echo '71. aprobar una prefactura de A2 diciendo que es de A1 da P0002'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b02', '00000000-0000-0000-0000-000000f32d03', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_aprobar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01') as should_fail;
rollback;

\echo '72. anon NO tiene EXECUTE sobre aprobar'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.prefactura_aprobar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01') as should_fail;
rollback;

\echo '=== RESERVA DE TIMBRADO (compare-and-set) ==='
\echo '73. reservar una aprobada gana la reserva'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as reserva_ganada_deberia_ser_1;
select count(*) as estado_timbrando_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'timbrando' and timbrando_en is not null;
rollback;

\echo '74. la segunda reserva de la misma prefactura NO gana (solo una llama al PAC)'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as segunda_deberia_ser_0;
rollback;

\echo '75. un borrador no se reserva'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as borrador_deberia_ser_0;
rollback;

\echo '76. una timbrada no se reserva de nuevo'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as timbrada_deberia_ser_0;
rollback;

\echo '77. una cancelada no se reserva'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, motivo_cancelacion, cancelada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'cancelada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '02', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as cancelada_deberia_ser_0;
rollback;

\echo '78. una reserva vieja (1 hora) se puede reclamar'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now() - interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as reserva_vieja_deberia_ser_1;
rollback;

\echo '79. una reserva reciente NO se reclama'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now() - interval '1 minute');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as reserva_reciente_deberia_ser_0;
rollback;

\echo '80. una fallida se puede reintentar'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'fallida', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as fallida_deberia_ser_1;
rollback;

\echo '81. la reserva expira en 300 segundos o mas (60 se rechaza)'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 60)::int as should_fail;
rollback;

\echo '82. el contador NO reserva'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as should_fail;
rollback;

\echo '83. readonly NO reserva'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c03', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as should_fail;
rollback;

\echo '84. cross-tenant: admin de B NO reserva'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as should_fail;
rollback;

\echo '85. anon NO tiene EXECUTE sobre reservar'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900)::int as should_fail;
rollback;

\echo '=== REGISTRAR TIMBRE Y FALLO ==='
\echo '86. registrar timbre de una prefactura timbrando la deja timbrada con su UUID'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '11111111-1111-4111-8111-111111111111', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml');
select count(*) as timbrada_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'timbrada' and uuid_cfdi = '11111111-1111-4111-8111-111111111111' and pac_id = 'pac_123' and timbrando_en is null and timbrada_en is not null;
rollback;

\echo '87. sin reserva vigente (aprobada) NO se registra un timbre'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '11111111-1111-4111-8111-111111111111', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml') as should_fail;
rollback;

\echo '88. un UUID fiscal mal formado se rechaza'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 'no-es-uuid', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml') as should_fail;
rollback;

\echo '89. el mismo UUID fiscal no se liga a dos prefacturas de la organizacion'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-06', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-06-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f02', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d02', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f02', '11111111-1111-4111-8111-111111111111', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml') as should_fail;
rollback;

\echo '90. control: un UUID distinto si se registra'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-06', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-06-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f02', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d02', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f02', '22222222-2222-4222-8222-222222222222', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml');
select count(*) as control_uuid_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f02' and estado = 'timbrada';
rollback;

\echo '91. el contador NO registra timbre'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '11111111-1111-4111-8111-111111111111', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml') as should_fail;
rollback;

\echo '92. cross-tenant: admin de B NO registra timbre'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '11111111-1111-4111-8111-111111111111', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml') as should_fail;
rollback;

\echo '93. anon NO tiene EXECUTE sobre registrar timbre'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '11111111-1111-4111-8111-111111111111', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml') as should_fail;
rollback;

\echo '94. registrar fallo deja la prefactura fallida y libera la reserva'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_registrar_fallo('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 'pac_no_disponible');
select count(*) as fallida_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'fallida' and timbrando_en is null and error_timbrado = 'pac_no_disponible';
rollback;

\echo '95. el texto del fallo se trunca a 200 caracteres'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_registrar_fallo('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
select char_length(error_timbrado) as error_largo_deberia_ser_200 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01';
rollback;

\echo '96. sin reserva vigente NO se registra un fallo'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_registrar_fallo('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 'pac_no_disponible') as should_fail;
rollback;

\echo '97. el contador NO registra fallo'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.prefactura_registrar_fallo('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 'pac_no_disponible') as should_fail;
rollback;

\echo '98. cross-tenant: admin de B NO registra fallo'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select despachos.prefactura_registrar_fallo('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 'pac_no_disponible') as should_fail;
rollback;

\echo '99. ciclo completo: aprobada -> reserva -> fallo -> reserva -> timbre'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900);
select despachos.prefactura_registrar_fallo('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 'pac_no_disponible');
select despachos.prefactura_reservar_timbrado('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', 900);
select despachos.prefactura_registrar_timbre('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '11111111-1111-4111-8111-111111111111', 'pac_123', 'https://pac.example/f.pdf', 'https://pac.example/f.xml');
select count(*) as ciclo_timbrada_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'timbrada';
rollback;

\echo '=== CANCELAR (guardas) ==='
\echo '100. cancelar un borrador con motivo 02 no necesita PAC'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, false);
select count(*) as borrador_cancelado_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'cancelada' and motivo_cancelacion = '02' and cancelada_en is not null;
rollback;

\echo '101. cancelar una aprobada con motivo 03'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '03', null, false);
select count(*) as aprobada_cancelada_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'cancelada';
rollback;

\echo '102. cancelar una fallida'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'fallida', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '04', null, false);
select count(*) as fallida_cancelada_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'cancelada';
rollback;

\echo '103. una timbrada NO se cancela sin acuse del PAC'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, false) as should_fail;
rollback;

\echo '104. control: la misma timbrada con acuse del PAC si se cancela y conserva su UUID'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, true);
select count(*) as timbrada_cancelada_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'cancelada' and uuid_cfdi = '11111111-1111-4111-8111-111111111111';
rollback;

\echo '105. motivo 05 se rechaza'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '05', null, false) as should_fail;
rollback;

\echo '106. motivo nulo se rechaza'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', null, null, false) as should_fail;
rollback;

\echo '107. el motivo 01 exige folio de sustitucion'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '01', null, false) as should_fail;
rollback;

\echo '108. el motivo 01 con folio de sustitucion valido se cancela'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '01', '22222222-2222-4222-8222-222222222222', true);
select count(*) as sustitucion_deberia_ser_1 from despachos.prefactura where id = '00000000-0000-0000-0000-000000f32f01' and estado = 'cancelada' and folio_sustitucion = '22222222-2222-4222-8222-222222222222';
rollback;

\echo '109. el folio de sustitucion no puede ser el del propio CFDI'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '01', '11111111-1111-4111-8111-111111111111', true) as should_fail;
rollback;

\echo '110. el motivo 02 no admite folio de sustitucion'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', '22222222-2222-4222-8222-222222222222', false) as should_fail;
rollback;

\echo '111. el folio de sustitucion mal formado se rechaza'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '01', 'no-uuid', true) as should_fail;
rollback;

\echo '112. cancelar dos veces se rechaza'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, motivo_cancelacion, cancelada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'cancelada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '02', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, false) as should_fail;
rollback;

\echo '113. una prefactura con timbrado en curso NO se cancela'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrando_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c01', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, true) as should_fail;
rollback;

\echo '114. el contador NO cancela'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c02', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, false) as should_fail;
rollback;

\echo '115. readonly NO cancela'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c03', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, false) as should_fail;
rollback;

\echo '116. cross-tenant: admin de B NO cancela'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f32c04', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, false) as should_fail;
rollback;

\echo '117. anon NO tiene EXECUTE sobre cancelar'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'borrador', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.prefactura_cancelar('00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32f01', '02', null, false) as should_fail;
rollback;

\echo '=== INTEGRIDAD (CHECK / UNIQUE / FK, como dueno de las tablas) ==='
\echo '118. UNIQUE (iguala, periodo): una segunda fila del mismo periodo falla'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f02', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000) returning id as should_fail;
rollback;

\echo '119. control del UNIQUE: otro periodo de la misma iguala si entra'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f02', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-08', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-08-05', 100000, 16000, 116000);
select count(*) as control_unique_deberia_ser_2 from despachos.prefactura where iguala_id = '00000000-0000-0000-0000-000000f32d01';
rollback;

\echo '120. CHECK: un total que no cuadra con base + IVA - retenciones falla'
begin;

insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116001) returning id as should_fail;
rollback;

\echo '121. CHECK: estado timbrada sin UUID fiscal falla'
begin;

insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, now()) returning id as should_fail;
rollback;

\echo '122. CHECK: estado timbrando sin timbrando_en falla'
begin;

insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'timbrando', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000) returning id as should_fail;
rollback;

\echo '123. CHECK: estado cancelada sin motivo falla'
begin;

insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'cancelada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000) returning id as should_fail;
rollback;

\echo '124. CHECK: un motivo de cancelacion 09 falla'
begin;

insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, motivo_cancelacion, cancelada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'cancelada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '09', now()) returning id as should_fail;
rollback;

\echo '125. FK compuesta: una prefactura de la iguala de A1 con tenant de B falla'
begin;

insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a02', '00000000-0000-0000-0000-000000f32b03', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000) returning id as should_fail;
rollback;

\echo '126. UNIQUE parcial del UUID fiscal por organizacion'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-06', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-06-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now());
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos, uuid_cfdi, timbrada_en) values ('00000000-0000-0000-0000-000000f32f02', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d02', '2026-07', 'timbrada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000, '11111111-1111-4111-8111-111111111111', now()) returning id as should_fail;
rollback;

\echo '127. CHECK de iguala: tasa de IVA 1000 falla'
begin;

insert into despachos.iguala (organization_id, property_id, concepto, monto_base_centavos, tasa_iva_bp) values ('00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', 'Mala tasa', 100, 1000) returning id as should_fail;
rollback;

\echo '128. CHECK de iguala: periodicidad distinta de mensual falla'
begin;

insert into despachos.iguala (organization_id, property_id, concepto, monto_base_centavos, periodicidad) values ('00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', 'Bimestral', 100, 'bimestral') returning id as should_fail;
rollback;

\echo '129. borrar la property borra en cascada igualas y prefacturas'
begin;
insert into despachos.prefactura (id, organization_id, property_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, total_centavos) values ('00000000-0000-0000-0000-000000f32f01', '00000000-0000-0000-0000-000000f32a01', '00000000-0000-0000-0000-000000f32b01', '00000000-0000-0000-0000-000000f32d01', '2026-07', 'aprobada', 'Iguala', '84111500', 'E48', 'RRR010101RR1', 'Receptor Uno SA de CV', '601', '64000', 'G03', '2026-07-05', 100000, 16000, 116000);
delete from despachos.prefactura where property_id = '00000000-0000-0000-0000-000000f32b01';
delete from core.property where id = '00000000-0000-0000-0000-000000f32b01';
select count(*) as cascada_deberia_ser_0 from despachos.iguala where property_id = '00000000-0000-0000-0000-000000f32b01';
rollback;

\echo '=== POSTURA DE CATALOGO ==='
\echo '130. RLS habilitado en las 2 tablas'
begin;

select (count(*) filter (where c.relrowsecurity))::int as rls_deberia_ser_2 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'despachos' and c.relname in ('iguala', 'prefactura');
rollback;

\echo '131. ninguna policy de las 2 tablas es permisiva (using true) y todas son select'
begin;

select count(*)::int as policies_permisivas_deberia_ser_0 from pg_policies where schemaname = 'despachos' and tablename in ('iguala', 'prefactura') and (qual = 'true' or cmd <> 'SELECT');
rollback;

\echo '132. anon y public no tienen privilegios sobre las 2 tablas'
begin;

select count(*)::int as privilegios_anon_deberia_ser_0 from (select unnest(array['select','insert','update','delete']) p) x, (select unnest(array['despachos.iguala','despachos.prefactura']) t) y where has_table_privilege('anon', y.t, x.p);
rollback;

\echo '133. authenticated solo tiene select (ni insert, update ni delete)'
begin;

select count(*)::int as escritura_authenticated_deberia_ser_0 from (select unnest(array['insert','update','delete']) p) x, (select unnest(array['despachos.iguala','despachos.prefactura']) t) y where has_table_privilege('authenticated', y.t, x.p);
rollback;

\echo '134. ninguna funcion de la migracion es ejecutable por public ni anon'
begin;

select count(*)::int as funciones_expuestas_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and (p.proname like 'prefactura\_%' or p.proname like 'iguala\_%' or p.proname like 'honorarios\_%') and (has_function_privilege('anon'::name, p.oid, 'execute') or has_function_privilege('public'::name, p.oid, 'execute'));
rollback;

\echo '135. las funciones de escritura son definer con search_path fijo'
begin;

select count(*)::int as definer_sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.prosecdef and (p.proname like 'prefactura\_%' or p.proname like 'iguala\_%' or p.proname like 'honorarios\_%') and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
rollback;

\echo '136. las 8 funciones de escritura de authenticated existen (iguala_guardar, iguala_eliminar y 6 de prefactura)'
begin;

select count(*)::int as funciones_authenticated_deberia_ser_8 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and (p.proname like 'prefactura\_%' or p.proname like 'iguala\_%') and has_function_privilege('authenticated'::name, p.oid, 'execute');
rollback;

\echo '137. el guard honorarios_puede_escribir no es ejecutable por authenticated'
begin;

select count(*)::int as guard_expuesto_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname in ('honorarios_puede_escribir', 'honorarios_porcentaje') and has_function_privilege('authenticated'::name, p.oid, 'execute');
rollback;

