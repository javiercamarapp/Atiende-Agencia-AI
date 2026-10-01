-- Ejerce, contra Postgres REAL (RLS + GRANT reales; el repositorio en memoria nunca los aplica), la
-- migración 015_despachos_estado_cuenta_movimiento (D-03): libro de movimientos importados de
-- estados de cuenta, con idempotencia por hash. Cada escenario corre en su propio
-- `begin; ... rollback;` -- nada persiste salvo el fixture de arriba. El SQL de INSERT es el MISMO
-- de `PostgresDespachosRepository.insertEstadoCuentaMovimientos` (copiado literal).
--
-- Fixtures: org A (despachos) con properties A1/A2; org B con B1. Staff: 1 admin A, 2 contador A,
-- 3 auditor A, 4 contador B, 5 contador A acotado a A1, 6 admin de A y de B a la vez.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-000000000d0a', 'despachos', 'Despacho A Verify', 'despacho-a-verify-ec'),
  ('00000000-0000-0000-0000-000000000d0b', 'despachos', 'Despacho B Verify', 'despacho-b-verify-ec')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-000000000d0a', 'despachos', 'Cliente A1'),
  ('00000000-0000-0000-0000-00000000da02', '00000000-0000-0000-0000-000000000d0a', 'despachos', 'Cliente A2'),
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-000000000d0b', 'despachos', 'Cliente B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000d01', 'admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000d02', 'contador-a@example.com', 'Contador A', 'seed'),
  ('00000000-0000-0000-0000-000000000d03', 'auditor-a@example.com', 'Auditor A', 'seed'),
  ('00000000-0000-0000-0000-000000000d04', 'contador-b@example.com', 'Contador B', 'seed'),
  ('00000000-0000-0000-0000-000000000d05', 'contador-a1@example.com', 'Contador A1', 'seed'),
  ('00000000-0000-0000-0000-000000000d06', 'admin-ab@example.com', 'Admin AB', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-000000000d0a', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000d02', '00000000-0000-0000-0000-000000000d0a', null, 'member', 'contador'),
  ('00000000-0000-0000-0000-000000000d03', '00000000-0000-0000-0000-000000000d0a', null, 'viewer', 'auditor'),
  ('00000000-0000-0000-0000-000000000d04', '00000000-0000-0000-0000-000000000d0b', null, 'member', 'contador'),
  ('00000000-0000-0000-0000-000000000d05', '00000000-0000-0000-0000-000000000d0a', array['00000000-0000-0000-0000-00000000da01']::uuid[], 'member', 'contador'),
  ('00000000-0000-0000-0000-000000000d06', '00000000-0000-0000-0000-000000000d0a', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000d06', '00000000-0000-0000-0000-000000000d0b', null, 'admin', 'admin')
on conflict do nothing;

\echo '=== 1. contador de A importa 2 movimientos con el SQL REAL del repositorio (insert ... select jsonb_to_recordset ... on conflict do nothing returning hash): ambos se insertan. ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d02', true);
insert into despachos.estado_cuenta_movimiento
  (organization_id, property_id, hash, cuenta, banco, formato, fecha, descripcion, referencia, cargo, abono, monto, saldo, lote_id, renglon)
select '00000000-0000-0000-0000-000000000d0a'::uuid, '00000000-0000-0000-0000-00000000da01'::uuid, m.hash, m.cuenta, m.banco, m.formato, m.fecha::date, m.descripcion, m.referencia, m.cargo, m.abono, m.monto, m.saldo, '00000000-0000-0000-0000-0000000000f1'::uuid, m.renglon
  from jsonb_to_recordset('[
    {"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cuenta":"012180000123456782","banco":"bbva","formato":"csv","fecha":"2026-01-05","descripcion":"SPEI RECIBIDO","referencia":"R1","cargo":null,"abono":1160.00,"monto":1160.00,"saldo":51160.00,"renglon":3},
    {"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cuenta":"012180000123456782","banco":"bbva","formato":"csv","fecha":"2026-01-08","descripcion":"PAGO DE NÓMINA","referencia":null,"cargo":3000.00,"abono":null,"monto":-3000.00,"saldo":48160.00,"renglon":4}
  ]'::jsonb) as m(hash text, cuenta text, banco text, formato text, fecha text, descripcion text, referencia text, cargo numeric, abono numeric, monto numeric, saldo numeric, renglon int)
on conflict (property_id, hash) do nothing
returning hash;
rollback;

\echo ''
\echo '=== 2. IDEMPOTENCIA: la misma importación dos veces (misma transacción) deja exactamente 2 filas, y la 2a no lanza error. ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d02', true);
insert into despachos.estado_cuenta_movimiento
  (organization_id, property_id, hash, banco, formato, fecha, descripcion, cargo, abono, monto, lote_id, renglon)
values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbva', 'csv', '2026-01-05', 'X', null, 10, 10, '00000000-0000-0000-0000-0000000000f1', 1),
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'bbva', 'csv', '2026-01-06', 'Y', 5, null, -5, '00000000-0000-0000-0000-0000000000f1', 2)
on conflict (property_id, hash) do nothing;
insert into despachos.estado_cuenta_movimiento
  (organization_id, property_id, hash, banco, formato, fecha, descripcion, cargo, abono, monto, lote_id, renglon)
values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbva', 'csv', '2026-01-05', 'X', null, 10, 10, '00000000-0000-0000-0000-0000000000f2', 1),
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'bbva', 'csv', '2026-01-06', 'Y', 5, null, -5, '00000000-0000-0000-0000-0000000000f2', 2)
on conflict (property_id, hash) do nothing;
select count(*) as filas_deberia_ser_2 from despachos.estado_cuenta_movimiento where property_id = '00000000-0000-0000-0000-00000000da01';
rollback;

\echo ''
\echo '=== 3. La huella es única POR property: el mismo hash en A1 y en A2 (otro cliente del mismo despacho) es legítimo -> A2 queda con 1 fila. ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d02', true);
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1),
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da02', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
select count(*) as filas_a2_deberia_ser_1 from despachos.estado_cuenta_movimiento where property_id = '00000000-0000-0000-0000-00000000da02';
rollback;

\echo ''
\echo '=== 4. NEGATIVO: el AUDITOR de A (solo lectura) NO puede importar -- RLS rechaza el INSERT. ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d03', true);
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
rollback;

\echo ''
\echo '=== 5. CROSS-TENANT: el contador de B NO puede insertar en la property A1 (ni siquiera etiquetando organization_id = A). ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d04', true);
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
rollback;

\echo ''
\echo '=== 6. MEZCLA DE TENANTS: un admin con membership en A y en B NO puede insertar una fila de la property A1 etiquetada con organization_id = B (la fila debe pertenecer a la organización de su property). ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d06', true);
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0b', '00000000-0000-0000-0000-00000000da01', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
rollback;

\echo ''
\echo '=== 7. ALCANCE POR PROPERTY: el contador acotado a A1 NO puede insertar en A2 (property_ids no la incluye). ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d05', true);
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da02', '1111111111111111111111111111111111111111111111111111111111111111', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
rollback;

\echo ''
\echo '=== 8. LIBRO DE SOLO-ANEXAR: ni el staff autenticado puede UPDATE un movimiento ya importado (sin GRANT de UPDATE). ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '2222222222222222222222222222222222222222222222222222222222222222', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d02', true);
update despachos.estado_cuenta_movimiento set descripcion = 'reescrito' where property_id = '00000000-0000-0000-0000-00000000da01';
rollback;

\echo ''
\echo '=== 9. LIBRO DE SOLO-ANEXAR: ni el admin autenticado puede DELETE un movimiento (sin GRANT de DELETE). ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '3333333333333333333333333333333333333333333333333333333333333333', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d01', true);
delete from despachos.estado_cuenta_movimiento where property_id = '00000000-0000-0000-0000-00000000da01';
rollback;

\echo ''
\echo '=== 10. ANON: sin ningún GRANT -- no puede ni leer la tabla. ==='
begin;
set local role anon;
select count(*) as should_fail from despachos.estado_cuenta_movimiento;
rollback;

\echo ''
\echo '=== 11. GRANT POR COLUMNA: el cliente no puede falsear `importado_por` (columna fuera del grant de INSERT). ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d02', true);
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon, importado_por) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '4444444444444444444444444444444444444444444444444444444444444444', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1, '00000000-0000-0000-0000-000000000d01');
rollback;

\echo ''
\echo '=== 12. `importado_por` lo llena el DEFAULT auth.uid(): queda el id del contador que importó. ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d02', true);
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '5555555555555555555555555555555555555555555555555555555555555555', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
select count(*) as importador_correcto_deberia_ser_1 from despachos.estado_cuenta_movimiento where importado_por = '00000000-0000-0000-0000-000000000d02';
rollback;

\echo ''
\echo '=== 13. LECTURA: el auditor de A SÍ ve los movimientos de su property (solo lectura). ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '6666666666666666666666666666666666666666666666666666666666666666', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d03', true);
select count(*) as filas_propias_deberia_ser_1 from despachos.estado_cuenta_movimiento;
rollback;

\echo ''
\echo '=== 14. CROSS-TENANT (lectura): el contador de B NO ve ninguna fila de A (RLS filtra en silencio -> 0). ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '7777777777777777777777777777777777777777777777777777777777777777', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d04', true);
select count(*) as filas_ajenas_deberia_ser_0 from despachos.estado_cuenta_movimiento;
rollback;

\echo ''
\echo '=== 15. ALCANCE POR PROPERTY (lectura): el contador acotado a A1 NO ve filas de A2 (-> 0). ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da02', '8888888888888888888888888888888888888888888888888888888888888888', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000d05', true);
select count(*) as filas_de_a2_deberia_ser_0 from despachos.estado_cuenta_movimiento where property_id = '00000000-0000-0000-0000-00000000da02';
rollback;

\echo ''
\echo '=== 16. CHECK de signo: un movimiento con cargo Y abono a la vez se rechaza. ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, cargo, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '9999999999999999999999999999999999999999999999999999999999999999', 'generico', 'csv', '2026-01-05', 'X', 5, 5, 5, '00000000-0000-0000-0000-0000000000f1', 1);
rollback;

\echo ''
\echo '=== 17. CHECK de signo: un cargo con `monto` positivo (signo incoherente) se rechaza. ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, cargo, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '0000000000000000000000000000000000000000000000000000000000000001', 'generico', 'csv', '2026-01-05', 'X', 5, 5, '00000000-0000-0000-0000-0000000000f1', 1);
rollback;

\echo ''
\echo '=== 18. CHECK de huella: un hash que no es SHA-256 hex en minúsculas se rechaza. ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', 'NO-ES-UN-HASH', 'generico', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
rollback;

\echo ''
\echo '=== 19. Un banco fuera de la lista cerrada se rechaza (check de banco). ==='
begin;
set local role service_role;
insert into despachos.estado_cuenta_movimiento (organization_id, property_id, hash, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-000000000d0a', '00000000-0000-0000-0000-00000000da01', '0000000000000000000000000000000000000000000000000000000000000002', 'bancoinventado', 'csv', '2026-01-05', 'X', 10, 10, '00000000-0000-0000-0000-0000000000f1', 1);
rollback;

\echo ''
\echo '=== FIN -- los escenarios 4/5/6/7/8/9/10/11/16/17/18/19 deben terminar en ERROR (ese es el resultado correcto); el resto debe completar sin error y los de valor devuelven el entero indicado en su alias. ==='
