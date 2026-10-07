-- D-P3-16 / D-P3-17 / D-P3-44 -- verificación contra Postgres REAL de la migración 028 (catálogo de cuentas con nivel, cuenta padre
-- y código agrupador del SAT; siembra, guardado, asignación masiva e importación). Cada escenario corre en su propio
-- `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR; alias `..._deberia_ser_N` = el valor esperado (ver run-gate.mjs).
-- Los negativos tienen un control positivo con la misma precondición para que un fallo por otra causa no se confunda con la defensa.
-- Sujetos: admin de A (org-wide), contador de A acotado a UN cliente, readonly de A, admin de B (otro despacho), admin de un hotel,
-- usuario sin membresía y una sesión sin sub (anon / sistema). Todos los RFC, folios y correos son ficticios.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-000000d44a01', 'despachos', 'Despacho A', 'despacho-a-catsat', 'active'),
  ('00000000-0000-0000-0000-000000d44a02', 'despachos', 'Despacho B', 'despacho-b-catsat', 'active'),
  ('00000000-0000-0000-0000-000000d44a03', 'hoteles', 'Hotel H', 'hotel-h-catsat', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-000000d44b02', '00000000-0000-0000-0000-000000d44a01', 'despachos', 'Cliente A2'),
  ('00000000-0000-0000-0000-000000d44b03', '00000000-0000-0000-0000-000000d44a02', 'despachos', 'Cliente B1'),
  ('00000000-0000-0000-0000-000000d44b04', '00000000-0000-0000-0000-000000d44a03', 'hoteles', 'Hotel H1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000d44c01', 'catsat-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000d44c02', 'catsat-contador-a@example.com', 'Contador A1', 'seed'),
  ('00000000-0000-0000-0000-000000d44c03', 'catsat-readonly-a@example.com', 'Readonly A', 'seed'),
  ('00000000-0000-0000-0000-000000d44c04', 'catsat-admin-b@example.com', 'Admin B', 'seed'),
  ('00000000-0000-0000-0000-000000d44c05', 'catsat-nadie@example.com', 'Sin membresia', 'seed'),
  ('00000000-0000-0000-0000-000000d44c06', 'catsat-admin-h@example.com', 'Admin hotel', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000d44c01', '00000000-0000-0000-0000-000000d44a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d44c02', '00000000-0000-0000-0000-000000d44a01', array['00000000-0000-0000-0000-000000d44b01']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000d44c03', '00000000-0000-0000-0000-000000d44a01', null, 'viewer', 'readonly'),
  ('00000000-0000-0000-0000-000000d44c04', '00000000-0000-0000-0000-000000d44a02', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d44c06', '00000000-0000-0000-0000-000000d44a03', null, 'admin', 'admin')
on conflict do nothing;
-- Catálogo de A1 (con jerarquía: 1020100 es subcuenta de 1020000) y de B1 (insert directo: el fixture corre como dueño). El orden
-- importa: el trigger de jerarquía exige que el padre exista antes que la subcuenta.
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre, codigo_agrupador) values
  ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020000', 'Bancos', 'D', 1, null, null),
  ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020100', 'Bancos nacionales', 'D', 2, '1020000', '102.01'),
  ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1050000', 'Clientes', 'D', 1, null, null),
  ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '2600400', 'IVA trasladado', 'A', 1, null, null),
  ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '4080000', 'Ingresos por servicios', 'A', 1, null, null),
  ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '6020100', 'Servicios profesionales', 'D', 1, null, null),
  ('00000000-0000-0000-0000-000000d44b03', '00000000-0000-0000-0000-000000d44a02', '1050000', 'Clientes', 'D', 1, null, null),
  ('00000000-0000-0000-0000-000000d44b03', '00000000-0000-0000-0000-000000d44a02', '9990000', 'Solo de B1', 'D', 1, null, null)
on conflict do nothing;

\echo '=== CHECKS Y LLAVES DE LA TABLA (insert directo como dueño) ==='
\echo '1. CONTROL: codigo agrupador con formato valido (ddd.dd) entra'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, codigo_agrupador) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020999', 'Prueba', 'D', '102.02');
select count(*) as formato_valido_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020999';
rollback;

\echo '2. CHECK: codigo agrupador 'abc' se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, codigo_agrupador) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020999', 'Prueba', 'D', 'abc') returning 1 as should_fail;
rollback;

\echo '3. CHECK: codigo agrupador '1020' se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, codigo_agrupador) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020999', 'Prueba', 'D', '1020') returning 1 as should_fail;
rollback;

\echo '4. CHECK: codigo agrupador '102.001' se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, codigo_agrupador) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020999', 'Prueba', 'D', '102.001') returning 1 as should_fail;
rollback;

\echo '5. CHECK: codigo agrupador '102.' se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, codigo_agrupador) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020999', 'Prueba', 'D', '102.') returning 1 as should_fail;
rollback;

\echo '6. CHECK: codigo agrupador '10.01' se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, codigo_agrupador) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020999', 'Prueba', 'D', '10.01') returning 1 as should_fail;
rollback;

\echo '7. CHECK: codigo agrupador '102,01' se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, codigo_agrupador) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020999', 'Prueba', 'D', '102,01') returning 1 as should_fail;
rollback;

\echo '8. CONTROL: subcuenta con padre existente y nivel consecutivo entra'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020101', 'Sub-subcuenta', 'D', 3, '1020100');
select count(*) as nivel3_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020101';
rollback;

\echo '9. FK: cuenta padre inexistente se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020101', 'Huerfana', 'D', 2, '1999999') returning 1 as should_fail;
rollback;

\echo '10. FK compuesta: el padre no puede ser una cuenta de OTRA property (9990000 existe solo en B1)'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '9990100', 'Hija de otro cliente', 'D', 2, '9990000') returning 1 as should_fail;
rollback;

\echo '11. CHECK: nivel 2 sin padre se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020101', 'Sin padre', 'D', 2) returning 1 as should_fail;
rollback;

\echo '12. CHECK: nivel 1 con padre se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020101', 'Nivel 1 con padre', 'D', 1, '1020000') returning 1 as should_fail;
rollback;

\echo '13. TRIGGER: nivel 3 con padre de nivel 1 (salta un nivel) se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza, nivel, cuenta_padre) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020101', 'Salta nivel', 'D', 3, '1020000') returning 1 as should_fail;
rollback;

\echo '14. CHECK: una cuenta no es su propio padre'
begin;
update despachos.libro_cuenta set nivel = 2, cuenta_padre = '1050000' where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1050000' returning 1 as should_fail;
rollback;

\echo '15. TRIGGER: una cuenta existente no pasa a nivel 2 colgando de un padre de nivel 2 (ciclo imposible)'
begin;
update despachos.libro_cuenta set nivel = 2, cuenta_padre = '1020100' where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020000' returning 1 as should_fail;
rollback;

\echo '16. la cuenta padre no se borra si tiene subcuentas (FK)'
begin;
delete from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020000' returning 1 as should_fail;
rollback;

\echo '17. CHECK: naturaleza sigue restringida a D/A (regresion de 020)'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1020998', 'Prueba', 'X') returning 1 as should_fail;
rollback;

\echo '=== libro_cuenta_guardar ==='
\echo '18. guardar con nivel, padre y codigo agrupador (admin de A) deja los tres valores'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1020200', 'Bancos extranjeros', 'D', 2, '1020000', '102.02');
select count(*) as guardar_completo_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020200' and nivel = 2 and cuenta_padre = '1020000' and codigo_agrupador = '102.02';
rollback;

\echo '19. guardar de 4 argumentos (el camino que usa el codigo viejo) sigue funcionando'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '6020900', 'Gastos varios', 'D');
select count(*) as guardar_4_args_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '6020900' and nivel = 1 and cuenta_padre is null and codigo_agrupador is null;
rollback;

\echo '20. editar la descripcion con 4 argumentos NO borra el codigo agrupador ni la jerarquia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1020100', 'Bancos nacionales (editada)', 'D');
select count(*) as edicion_conserva_metadatos_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020100' and nivel = 2 and cuenta_padre = '1020000' and codigo_agrupador = '102.01' and descripcion = 'Bancos nacionales (editada)';
rollback;

\echo '21. asignar el codigo agrupador a una cuenta que no lo tenia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105');
select count(*) as asigna_codigo_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1050000' and codigo_agrupador = '105' and nivel = 1;
rollback;

\echo '22. codigo agrupador con mal formato se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '10.5') as should_fail;
rollback;

\echo '23. nivel 2 sin cuenta padre se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1020200', 'Bancos extranjeros', 'D', 2, null, null) as should_fail;
rollback;

\echo '24. cuenta padre sin nivel se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1020200', 'Bancos extranjeros', 'D', null, '1020000', null) as should_fail;
rollback;

\echo '25. cuenta padre de otro rubro (primer digito) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '4080100', 'Hija de activo', 'A', 2, '1020000', null) as should_fail;
rollback;

\echo '26. cuenta padre inexistente se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1020200', 'Bancos extranjeros', 'D', 2, '1999999', null) as should_fail;
rollback;

\echo '27. cuenta padre con nivel que no es el inmediato superior se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1020101', 'Salta nivel', 'D', 3, '1020000', null) as should_fail;
rollback;

\echo '28. una cuenta no es su propio padre'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', 2, '1050000', null) as should_fail;
rollback;

\echo '29. cross-tenant: el padre de otro cliente (9990000 solo en B1) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '9990100', 'Hija de otro cliente', 'D', 2, '9990000', null) as should_fail;
rollback;

\echo '30. una cuenta con subcuentas no cambia de nivel'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1020000', 'Bancos', 'D', 2, '1050000', null) as should_fail;
rollback;

\echo '31. CONTROL: sin partidas, la naturaleza SI se puede cambiar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '6020100', 'Servicios profesionales', 'A');
select count(*) as cambia_naturaleza_sin_partidas_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '6020100' and naturaleza = 'A';
rollback;

\echo '32. regresion: una cuenta con partidas NO cambia de naturaleza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d44b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'A', null, null, '105') as should_fail;
rollback;

\echo '33. regresion: con partidas se puede asignar el codigo agrupador sin tocar la naturaleza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d44b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105');
select count(*) as agrupador_con_partidas_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1050000' and naturaleza = 'D' and codigo_agrupador = '105';
rollback;

\echo '34. regresion: la poliza se registra igual con el catalogo nuevo y la balanza la ve'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d44b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select count(*) as balanza_con_poliza_deberia_ser_3 from despachos.libro_balanza('00000000-0000-0000-0000-000000d44b01', 2026, 7);
rollback;

\echo '--- roles y tenant en libro_cuenta_guardar ---'
\echo '35. CONTROL: contador acotado a A1 guarda en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105');
select count(*) as contador_guarda_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1050000' and codigo_agrupador = '105';
rollback;

\echo '36. readonly NO guarda'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c03', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105') as should_fail;
rollback;

\echo '37. contador acotado a A1 NO guarda en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b02', '1050000', 'Clientes', 'D', null, null, '105') as should_fail;
rollback;

\echo '38. cross-tenant: admin de B NO guarda en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c04', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105') as should_fail;
rollback;

\echo '39. hotel: admin de un hotel NO guarda en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c06', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105') as should_fail;
rollback;

\echo '40. usuario sin membresia NO guarda'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c05', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105') as should_fail;
rollback;

\echo '41. sin sub (rol authenticated) NO guarda'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105') as should_fail;
rollback;

\echo '42. anon NO tiene EXECUTE'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b01', '1050000', 'Clientes', 'D', null, null, '105') as should_fail;
rollback;

\echo '43. la property de un hotel no es de despachos: ni el admin del hotel guarda en ella'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c06', true);
select despachos.libro_cuenta_guardar('00000000-0000-0000-0000-000000d44b04', '1050000', 'Clientes', 'D', null, null, '105') as should_fail;
rollback;

\echo '=== libro_catalogo_sembrar con jerarquia y codigo agrupador ==='
\echo '44. la siembra trae nivel, padre y codigo; la subcuenta queda ligada a su padre aunque venga primero en el arreglo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.01"},{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":1,"codigo_agrupador":"102"}]'::jsonb);
select count(*) as siembra_jerarquia_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b02' and codigo = '1020100' and nivel = 2 and cuenta_padre = '1020000' and codigo_agrupador = '102.01';
rollback;

\echo '45. la siembra devuelve el numero de cuentas NUEVAS'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"},{"codigo":"4080000","descripcion":"Ingresos","naturaleza":"A"}]'::jsonb) as sembradas_deberia_ser_2;
rollback;

\echo '46. la siembra es idempotente con codigos agrupadores (dos veces = mismas 3 cuentas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":1,"codigo_agrupador":"102"},{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.01"},{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"}]'::jsonb);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":1,"codigo_agrupador":"102"},{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.01"},{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"}]'::jsonb);
select count(*) as siembra_idempotente_deberia_ser_3 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b02';
rollback;

\echo '47. la siembra completa el codigo agrupador VACIO de una cuenta existente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1020000","descripcion":"OTRA","naturaleza":"D","nivel":1,"codigo_agrupador":"102"}]'::jsonb);
select count(*) as completa_vacio_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020000' and codigo_agrupador = '102' and descripcion = 'Bancos';
rollback;

\echo '48. la siembra NO pisa un codigo agrupador ya capturado ni la descripcion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1020100","descripcion":"OTRA","naturaleza":"A","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.02"}]'::jsonb);
select count(*) as no_pisa_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020100' and codigo_agrupador = '102.01' and descripcion = 'Bancos nacionales' and naturaleza = 'D';
rollback;

\echo '49. la siembra completa la jerarquia de una cuenta que seguia en nivel 1 sin padre'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D"},{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D","nivel":2,"cuenta_padre":"1020000"}]'::jsonb);
select count(*) as completa_jerarquia_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1050000' and nivel = 2 and cuenta_padre = '1020000';
rollback;

\echo '50. la siembra rechaza un codigo agrupador mal formado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D","codigo_agrupador":"xx"}]'::jsonb) as should_fail;
rollback;

\echo '51. la siembra rechaza un padre inexistente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1050100","descripcion":"Clientes nac","naturaleza":"D","nivel":2,"cuenta_padre":"1999999"}]'::jsonb) as should_fail;
rollback;

\echo '52. CONTROL: contador acotado a A1 siembra en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1080000","descripcion":"Deudores","naturaleza":"D","codigo_agrupador":"107"}]'::jsonb);
select count(*) as contador_siembra_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1080000';
rollback;

\echo '53. contador acotado a A1 NO siembra en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":1,"codigo_agrupador":"102"},{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.01"},{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"}]'::jsonb) as should_fail;
rollback;

\echo '54. readonly NO siembra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c03', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":1,"codigo_agrupador":"102"},{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.01"},{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"}]'::jsonb) as should_fail;
rollback;

\echo '55. cross-tenant: admin de B NO siembra en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c04', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":1,"codigo_agrupador":"102"},{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.01"},{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"}]'::jsonb) as should_fail;
rollback;

\echo '56. anon NO siembra'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":1,"codigo_agrupador":"102"},{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.01"},{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"}]'::jsonb) as should_fail;
rollback;

\echo '57. sin sub NO siembra'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.libro_catalogo_sembrar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":1,"codigo_agrupador":"102"},{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000","codigo_agrupador":"102.01"},{"codigo":"1050000","descripcion":"Clientes","naturaleza":"D"}]'::jsonb) as should_fail;
rollback;

\echo '=== libro_cuenta_agrupador_asignar ==='
\echo '58. asigna el codigo a varias cuentas y devuelve cuantas actualizo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb) as asignadas_deberia_ser_2;
rollback;

\echo '59. la asignacion deja el codigo en cada cuenta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb);
select count(*) as asignadas_con_codigo_deberia_ser_2 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo in ('1050000', '4080000') and codigo_agrupador is not null;
rollback;

\echo '60. una cuenta inexistente aborta TODA la asignacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"9999999","codigo_agrupador":"401"}]'::jsonb) as should_fail;
rollback;

\echo '61. codigo con mal formato aborta la asignacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105.123"}]'::jsonb) as should_fail;
rollback;

\echo '62. arreglo vacio se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[]'::jsonb) as should_fail;
rollback;

\echo '63. no es un arreglo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '{"codigo":"1050000"}'::jsonb) as should_fail;
rollback;

\echo '64. cross-tenant: una cuenta de otra property (9990000 es de B1) no se asigna desde A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"9990000","codigo_agrupador":"105"}]'::jsonb) as should_fail;
rollback;

\echo '65. CONTROL: contador acotado a A1 asigna en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb);
rollback;

\echo '66. contador acotado a A1 NO asigna en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"1050000","codigo_agrupador":"105"}]'::jsonb) as should_fail;
rollback;

\echo '67. readonly NO asigna'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c03', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb) as should_fail;
rollback;

\echo '68. cross-tenant: admin de B NO asigna en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c04', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb) as should_fail;
rollback;

\echo '69. hotel: admin de un hotel NO asigna en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c06', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb) as should_fail;
rollback;

\echo '70. usuario sin membresia NO asigna'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c05', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb) as should_fail;
rollback;

\echo '71. anon NO asigna'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb) as should_fail;
rollback;

\echo '72. sin sub NO asigna'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.libro_cuenta_agrupador_asignar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","codigo_agrupador":"105"},{"codigo":"4080000","codigo_agrupador":"401.01"}]'::jsonb) as should_fail;
rollback;

\echo '=== libro_catalogo_importar ==='
\echo '73. importar agrega las nuevas y actualiza las existentes (2 nuevas, 1 actualizada)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select out_agregadas as agregadas_deberia_ser_2 from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","descripcion":"Clientes (otro proveedor)","naturaleza":"D","nivel":1,"codigo_agrupador":"105"},{"codigo":"1050100","descripcion":"Clientes nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1050000","codigo_agrupador":"105.01"},{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A","nivel":1}]'::jsonb);
rollback;

\echo '74. importar reporta las actualizadas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select out_actualizadas as actualizadas_deberia_ser_1 from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","descripcion":"Clientes (otro proveedor)","naturaleza":"D","nivel":1},{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A","nivel":1}]'::jsonb);
rollback;

\echo '75. importar deja la jerarquia y la descripcion importadas aunque la subcuenta venga antes que su padre'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050100","descripcion":"Clientes nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1050000","codigo_agrupador":"105.01"},{"codigo":"1050000","descripcion":"Clientes (otro proveedor)","naturaleza":"D","nivel":1,"codigo_agrupador":"105"}]'::jsonb);
select count(*) as importa_jerarquia_deberia_ser_1 from despachos.libro_cuenta h join despachos.libro_cuenta p on p.property_id = h.property_id and p.codigo = h.cuenta_padre where h.property_id = '00000000-0000-0000-0000-000000d44b01' and h.codigo = '1050100' and p.descripcion = 'Clientes (otro proveedor)';
rollback;

\echo '76. importar NUNCA borra: las cuentas que el XML no menciona siguen ahi'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A","nivel":1}]'::jsonb);
select count(*) as no_borra_deberia_ser_7 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01';
rollback;

\echo '77. importar sin codigo agrupador NO borra el que la cuenta ya tenia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1020100","descripcion":"Bancos nacionales","naturaleza":"D","nivel":2,"cuenta_padre":"1020000"}]'::jsonb);
select count(*) as conserva_codigo_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1020100' and codigo_agrupador = '102.01';
rollback;

\echo '78. importar con la misma cuenta repetida se queda con la ultima aparicion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Primera","naturaleza":"A"},{"codigo":"7770000","descripcion":"Ultima","naturaleza":"A"}]'::jsonb);
select count(*) as ultima_aparicion_deberia_ser_1 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '7770000' and descripcion = 'Ultima';
rollback;

\echo '79. regresion: importar NO cambia la naturaleza de una cuenta con partidas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d44b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","descripcion":"Clientes","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '80. CONTROL: importar la misma cuenta con partidas y la misma naturaleza si pasa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_poliza_registrar('00000000-0000-0000-0000-000000d44b01', 'ingreso', '2026-07-20', 'Póliza de prueba', '[{"cuenta": "1050000", "concepto": "", "debe": 116000, "haber": 0}, {"cuenta": "4080000", "concepto": "", "debe": 0, "haber": 100000}, {"cuenta": "2600400", "concepto": "", "debe": 0, "haber": 16000}]'::jsonb, null);
select out_actualizadas as con_partidas_misma_naturaleza_deberia_ser_1 from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050000","descripcion":"Clientes importados","naturaleza":"D"}]'::jsonb);
rollback;

\echo '81. importar no cambia el nivel de una cuenta que ya tiene subcuentas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1020000","descripcion":"Bancos","naturaleza":"D","nivel":2,"cuenta_padre":"1050000"}]'::jsonb) as should_fail;
rollback;

\echo '82. importar rechaza un padre inexistente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1050100","descripcion":"X","naturaleza":"D","nivel":2,"cuenta_padre":"1999999"}]'::jsonb) as should_fail;
rollback;

\echo '83. importar rechaza un codigo que no es de 4 a 10 digitos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"1-01-001","descripcion":"X","naturaleza":"D"}]'::jsonb) as should_fail;
rollback;

\echo '84. importar rechaza un arreglo vacio'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[]'::jsonb) as should_fail;
rollback;

\echo '85. tope de 2000 cuentas por cliente en la importacion (borde exacto)'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) select '00000000-0000-0000-0000-000000d44b02', '00000000-0000-0000-0000-000000d44a01', (3000000 + g)::text, 'Relleno ' || g, 'D' from generate_series(1, 1995) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select out_agregadas as cinco_mas_deberia_ser_5 from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"8000001","descripcion":"a","naturaleza":"D"},{"codigo":"8000002","descripcion":"a","naturaleza":"D"},{"codigo":"8000003","descripcion":"a","naturaleza":"D"},{"codigo":"8000004","descripcion":"a","naturaleza":"D"},{"codigo":"8000005","descripcion":"a","naturaleza":"D"}]'::jsonb);
rollback;

\echo '86. tope de 2000 cuentas: la cuenta 2001 se rechaza'
begin;
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) select '00000000-0000-0000-0000-000000d44b02', '00000000-0000-0000-0000-000000d44a01', (3000000 + g)::text, 'Relleno ' || g, 'D' from generate_series(1, 1995) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"8000001","descripcion":"a","naturaleza":"D"},{"codigo":"8000002","descripcion":"a","naturaleza":"D"},{"codigo":"8000003","descripcion":"a","naturaleza":"D"},{"codigo":"8000004","descripcion":"a","naturaleza":"D"},{"codigo":"8000005","descripcion":"a","naturaleza":"D"},{"codigo":"8000006","descripcion":"a","naturaleza":"D"}]'::jsonb) as should_fail;
rollback;

\echo '--- roles y tenant en libro_catalogo_importar ---'
\echo '87. CONTROL: contador acotado a A1 importa en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A"}]'::jsonb);
rollback;

\echo '88. contador acotado a A1 NO importa en A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b02', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '89. readonly NO importa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c03', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '90. cross-tenant: admin de B NO importa en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c04', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '91. hotel: admin de un hotel NO importa en A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c06', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '92. usuario sin membresia NO importa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c05', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '93. sin sub NO importa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '94. anon NO tiene EXECUTE sobre la importacion'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.libro_catalogo_importar('00000000-0000-0000-0000-000000d44b01', '[{"codigo":"7770000","descripcion":"Cuenta nueva","naturaleza":"A"}]'::jsonb) as should_fail;
rollback;

\echo '=== escritura directa cerrada, RLS y postura de catalogo ==='
\echo '95. authenticated NO actualiza libro_cuenta directo (ni su codigo agrupador)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
update despachos.libro_cuenta set codigo_agrupador = '105' where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '1050000' returning 1 as should_fail;
rollback;

\echo '96. authenticated NO inserta en libro_cuenta directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
insert into despachos.libro_cuenta (property_id, organization_id, codigo, descripcion, naturaleza) values ('00000000-0000-0000-0000-000000d44b01', '00000000-0000-0000-0000-000000d44a01', '1999999', 'x', 'D') returning 1 as should_fail;
rollback;

\echo '97. authenticated NO borra de libro_cuenta directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
delete from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and codigo = '6020100' returning 1 as should_fail;
rollback;

\echo '98. anon NO lee libro_cuenta'
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from despachos.libro_cuenta;
rollback;

\echo '99. CONTROL: el staff lee el catalogo de su cliente con las columnas nuevas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c01', true);
select count(*) as lee_catalogo_deberia_ser_6 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01' and nivel >= 1;
rollback;

\echo '100. RLS: el admin de B no ve ninguna cuenta de A1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c04', true);
select count(*) as rls_otro_despacho_deberia_ser_0 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b01';
rollback;

\echo '101. RLS: el contador acotado a A1 no ve las cuentas de A2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d44c02', true);
select count(*) as rls_otro_cliente_deberia_ser_0 from despachos.libro_cuenta where property_id = '00000000-0000-0000-0000-000000d44b02' or property_id = '00000000-0000-0000-0000-000000d44b03';
rollback;

\echo '102. anon y public no tienen EXECUTE sobre las funciones nuevas'
begin;
select count(*) as anon_ejecuta_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname in ('libro_cuenta_guardar', 'libro_cuenta_agrupador_asignar', 'libro_catalogo_importar', 'libro_catalogo_sembrar') and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
rollback;

\echo '103. las cuatro funciones de escritura son security definer con search_path fijo'
begin;
select count(*) as sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname in ('libro_cuenta_guardar', 'libro_cuenta_agrupador_asignar', 'libro_catalogo_importar', 'libro_catalogo_sembrar') and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
rollback;

\echo '104. authenticated tiene EXECUTE sobre las cuatro funciones de escritura'
begin;
select count(*) as authenticated_ejecuta_deberia_ser_4 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname in ('libro_cuenta_guardar', 'libro_cuenta_agrupador_asignar', 'libro_catalogo_importar', 'libro_catalogo_sembrar') and has_function_privilege('authenticated', p.oid, 'execute');
rollback;

\echo '105. el trigger de jerarquia no es invocable por authenticated ni anon'
begin;
select count(*) as trigger_expuesto_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname = 'libro_cuenta_jerarquia_tg' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));
rollback;

\echo '106. la sobrecarga de 4 argumentos se eliminó: una sola libro_cuenta_guardar'
begin;
select count(*) as una_sola_guardar_deberia_ser_1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'despachos' and p.proname = 'libro_cuenta_guardar';
rollback;

\echo '107. authenticated solo tiene SELECT sobre libro_cuenta (sin grants nuevos)'
begin;
select count(*) as privilegios_de_escritura_deberia_ser_0 from information_schema.role_table_grants where table_schema = 'despachos' and table_name = 'libro_cuenta' and grantee in ('authenticated', 'anon', 'public') and privilege_type <> 'SELECT';
rollback;

\echo '108. ninguna policy permisiva en libro_cuenta (using true)'
begin;
select count(*) as policies_permisivas_deberia_ser_0 from pg_policies where schemaname = 'despachos' and tablename = 'libro_cuenta' and (qual = 'true' or qual is null);
rollback;

\echo 'Verificacion de la migracion 028 terminada: los escenarios de arriba deben pasar todos (los should_fail terminan en ERROR, los _deberia_ser_N dan N).'
