-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/044_repartidor_perfil_operativo.sql: perfil operativo del repartidor (R-15).
--
--   A. Escritura: el repartidor guarda SU perfil; owner/admin guardan el de un repartidor de su organizacion; reemplazo completo.
--   B. Lectura (RLS): el repartidor lee solo el suyo; owner/admin leen los de su organizacion; el staff de piso lee lo OPERATIVO
--      pero NO lo personal (licencia y contacto de emergencia); otro repartidor, otro tenant y anon no leen nada.
--   C. Rechazos de escritura: staff de piso, repartidor ajeno, otro tenant, anon, sistema; owner sobre quien no es repartidor (P0002);
--      validaciones (enum, telefono, pares licencia/emergencia, vigencia).
--   D. Escritura directa: authenticated no inserta, actualiza ni borra las tablas (42501).
--   E. Supresion ARCO: solo owner/admin; borra ambas filas; el repartidor no suprime; otro tenant no suprime.
--   F. Retencion: al eliminar la membresia se borran ambas filas (FK en cascada).
--   G. Barrido de licencias por vencer: solo sistema, ids y dias sin PII, excluye lo que vence despues del umbral.
--   H. Bitacora: entity_type 'exportacion' admitido; un valor desconocido sigue rechazado.
--   J. historial del dia del repartidor: el rango [00:00, 24:00) del dia LOCAL de la sucursal (zona horaria) y solo sus pedidos.
--   I. base SIN migrar: la funcion eliminada da 42883 y un bloque con subtransaccion recupera la transaccion.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; los alias con sufijo deberia_ser_N marcan el
-- valor esperado; el rechazo se prueba con public.t_esperar_error (exige el SQLSTATE exacto).
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.t_esperar_error(p_sql text, p_estado text) returns void
language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v = returned_sqlstate;
    if v <> p_estado then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_estado, v, sqlerrm;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e5001', 'restaurantes', 'Perfil Org A', 'perfil-a'),
  ('00000000-0000-0000-0000-0000000e5002', 'restaurantes', 'Perfil Org B (ajena)', 'perfil-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e5011', 'owner-a@perfil.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5012', 'admin-a@perfil.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5013', 'staff-a@perfil.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5014', 'rep1-a@perfil.example.com', 'Repartidor 1 A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5015', 'rep2-a@perfil.example.com', 'Repartidor 2 A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5016', 'owner-b@perfil.example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000e5017', 'rep-b@perfil.example.com', 'Repartidor B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e5011', '00000000-0000-0000-0000-0000000e5001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e5012', '00000000-0000-0000-0000-0000000e5001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e5013', '00000000-0000-0000-0000-0000000e5001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e5014', '00000000-0000-0000-0000-0000000e5001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e5015', '00000000-0000-0000-0000-0000000e5001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e5016', '00000000-0000-0000-0000-0000000e5002', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e5017', '00000000-0000-0000-0000-0000000e5002', null, 'member', 'repartidor')
on conflict do nothing;

\echo '=== A1. el repartidor guarda SU perfil operativo y lo lee ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as x;
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil where user_id = '00000000-0000-0000-0000-0000000e5014' and vehiculo_tipo = 'moto' and placas = 'ABC-123';
rollback;

\echo '=== A2. el repartidor guarda su perfil personal y lo lee ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as x;
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil_privado where user_id = '00000000-0000-0000-0000-0000000e5014' and emergencia_telefono = '5512345678' and licencia_numero = 'LIC-001';
rollback;

\echo '=== A3. owner guarda el perfil de un repartidor de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5015','bicicleta','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as x;
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil where user_id = '00000000-0000-0000-0000-0000000e5015' and vehiculo_tipo = 'bicicleta';
rollback;

\echo '=== A4. admin guarda el perfil de un repartidor de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5012', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5015','auto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as x;
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil where user_id = '00000000-0000-0000-0000-0000000e5015' and vehiculo_tipo = 'auto';
rollback;

\echo '=== A5. guardar de nuevo REEMPLAZA (una sola fila; campos vacios quedan vacios) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as x;
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','a_pie',null,'disponible','L-V 12:00-20:00',null,null,null,null) as y;
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil p join restaurantes.repartidor_perfil_privado q using (organization_id, user_id) where p.user_id = '00000000-0000-0000-0000-0000000e5014' and p.vehiculo_tipo = 'a_pie' and p.placas is null and q.licencia_numero is null and q.emergencia_nombre is null;
rollback;

\echo '=== A6. se recortan los espacios de los textos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','  XY-9  ','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as x;
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil where user_id = '00000000-0000-0000-0000-0000000e5014' and placas = 'XY-9';
rollback;

\echo '=== B1. el repartidor lee su perfil operativo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil;
rollback;

\echo '=== B2. el repartidor lee su perfil personal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil_privado;
rollback;

\echo '=== B3. OTRO repartidor de la misma organizacion NO lee el perfil operativo ajeno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select count(*) as filas_deberia_ser_0 from restaurantes.repartidor_perfil;
rollback;

\echo '=== B4. OTRO repartidor NO lee el perfil personal ajeno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select count(*) as filas_deberia_ser_0 from restaurantes.repartidor_perfil_privado;
rollback;

\echo '=== B5. owner lee el perfil operativo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil;
rollback;

\echo '=== B6. owner lee el perfil personal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil_privado;
rollback;

\echo '=== B7. admin lee el perfil personal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5012', true);
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil_privado;
rollback;

\echo '=== B8. staff de piso lee el perfil operativo (despacho) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select count(*) as filas_deberia_ser_1 from restaurantes.repartidor_perfil;
rollback;

\echo '=== B9. staff de piso NO lee licencia ni contacto de emergencia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select count(*) as filas_deberia_ser_0 from restaurantes.repartidor_perfil_privado;
rollback;

\echo '=== B10. cross-tenant: owner de otra organizacion NO lee el perfil operativo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5016', true);
select count(*) as filas_deberia_ser_0 from restaurantes.repartidor_perfil;
rollback;

\echo '=== B11. cross-tenant: owner de otra organizacion NO lee el perfil personal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5016', true);
select count(*) as filas_deberia_ser_0 from restaurantes.repartidor_perfil_privado;
rollback;

\echo '=== B12. cross-tenant: repartidor de otra organizacion NO lee nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5017', true);
select count(*) as filas_deberia_ser_0 from restaurantes.repartidor_perfil;
rollback;

\echo '=== B13. RECHAZADO: anon no lee el perfil operativo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.repartidor_perfil$q$, '42501');
rollback;

\echo '=== B14. RECHAZADO: anon no lee el perfil personal -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.repartidor_perfil_privado$q$, '42501');
rollback;

\echo '=== C1. RECHAZADO: el staff de piso no guarda perfiles -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '42501');
rollback;

\echo '=== C2. RECHAZADO: un repartidor no guarda el perfil de OTRO -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '42501');
rollback;

\echo '=== C3. RECHAZADO cross-tenant: owner de B no guarda un perfil de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5016', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '42501');
rollback;

\echo '=== C4. RECHAZADO cross-tenant: repartidor de B no guarda en A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5017', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '42501');
rollback;

\echo '=== C5. RECHAZADO: la sesion de sistema (sin usuario) no guarda -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '42501');
rollback;

\echo '=== C6. RECHAZADO: anon no ejecuta guardar -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '42501');
rollback;

\echo '=== C7. RECHAZADO: owner sobre quien NO es repartidor -> P0002 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5013','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, 'P0002');
rollback;

\echo '=== C8. RECHAZADO: el owner no tiene perfil de repartidor propio -> P0002 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5011','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, 'P0002');
rollback;

\echo '=== C9. RECHAZADO: tipo de vehiculo desconocido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','cohete','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '22023');
rollback;

\echo '=== C10. RECHAZADO: disponibilidad desconocida -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','vacaciones','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '22023');
rollback;

\echo '=== C11. RECHAZADO: telefono de emergencia que no es de 10 digitos -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','12345')$q$, '22023');
rollback;

\echo '=== C12. RECHAZADO: contacto de emergencia sin telefono -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez',null)$q$, '22023');
rollback;

\echo '=== C13. RECHAZADO: licencia sin vigencia -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',null,'Maria Perez','5512345678')$q$, '22023');
rollback;

\echo '=== C14. RECHAZADO: vigencia fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',date '1999-01-01','Maria Perez','5512345678')$q$, '22023');
rollback;

\echo '=== C15. RECHAZADO: placas de mas de 15 caracteres -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','XXXXXXXXXXXXXXXX','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678')$q$, '22023');
rollback;

\echo '=== D1. RECHAZADO: authenticated no inserta directo en el perfil operativo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$insert into restaurantes.repartidor_perfil (organization_id, user_id, disponibilidad) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014', 'disponible')$q$, '42501');
rollback;

\echo '=== D2. RECHAZADO: authenticated no inserta directo en el perfil personal -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$insert into restaurantes.repartidor_perfil_privado (organization_id, user_id) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014')$q$, '42501');
rollback;

\echo '=== D3. RECHAZADO: authenticated no actualiza el perfil -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$update restaurantes.repartidor_perfil set placas = 'X'$q$, '42501');
rollback;

\echo '=== D4. RECHAZADO: authenticated no borra el perfil personal -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$delete from restaurantes.repartidor_perfil_privado$q$, '42501');
rollback;

\echo '=== E1. owner suprime el perfil (ARCO cancelacion): borra ambas filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select restaurantes.suprimir_perfil_repartidor('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014') as suprimido;
select (select count(*) from restaurantes.repartidor_perfil) + (select count(*) from restaurantes.repartidor_perfil_privado) as filas_restantes_deberia_ser_0;
rollback;

\echo '=== E2. suprimir un perfil inexistente devuelve false ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select (not restaurantes.suprimir_perfil_repartidor('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014'))::int as inexistente_false_deberia_ser_1;
rollback;

\echo '=== E3. RECHAZADO: el repartidor no suprime su propio perfil -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select restaurantes.suprimir_perfil_repartidor('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014')$q$, '42501');
rollback;

\echo '=== E4. RECHAZADO: el staff de piso no suprime -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select public.t_esperar_error($q$select restaurantes.suprimir_perfil_repartidor('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014')$q$, '42501');
rollback;

\echo '=== E5. RECHAZADO cross-tenant: owner de B no suprime perfiles de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5016', true);
select public.t_esperar_error($q$select restaurantes.suprimir_perfil_repartidor('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014')$q$, '42501');
rollback;

\echo '=== E6. RECHAZADO: anon no suprime -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.suprimir_perfil_repartidor('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014')$q$, '42501');
rollback;

\echo '=== F1. dar de baja al repartidor (borrar su membresia) borra sus dos perfiles ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
delete from core.membership where user_id = '00000000-0000-0000-0000-0000000e5014' and organization_id = '00000000-0000-0000-0000-0000000e5001';
select (select count(*) from restaurantes.repartidor_perfil) + (select count(*) from restaurantes.repartidor_perfil_privado) as filas_restantes_deberia_ser_0;
rollback;

\echo '=== G1. barrido de sistema: lista la licencia que vence en 10 dias (con 30 de umbral) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_deberia_ser_1 from restaurantes.licencias_por_vencer_sistema(30) where user_id = '00000000-0000-0000-0000-0000000e5014' and dias_restantes = 10 and organization_id = '00000000-0000-0000-0000-0000000e5001';
rollback;

\echo '=== G2. barrido de sistema: NO lista la que vence despues del umbral ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date + 10,'Maria Perez','5512345678') as fixture;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_deberia_ser_0 from restaurantes.licencias_por_vencer_sistema(5) where user_id = '00000000-0000-0000-0000-0000000e5014';
rollback;

\echo '=== G3. barrido de sistema: lista una licencia YA vencida con dias negativos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5014','moto','ABC-123','disponible','L-V 12:00-20:00','LIC-001',current_date - 3,'Maria Perez','5512345678') as x;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_deberia_ser_1 from restaurantes.licencias_por_vencer_sistema(30) where user_id = '00000000-0000-0000-0000-0000000e5014' and dias_restantes = -3;
rollback;

\echo '=== G4. RECHAZADO: un usuario no ejecuta el barrido -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.licencias_por_vencer_sistema(30)$q$, '42501');
rollback;

\echo '=== G5. RECHAZADO: anon no ejecuta el barrido -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.licencias_por_vencer_sistema(30)$q$, '42501');
rollback;

\echo '=== G6. el barrido solo devuelve ids y dias (sin datos personales) ==='
begin;
set local role authenticated;
select (pg_get_function_result('restaurantes.licencias_por_vencer_sistema(integer)'::regprocedure) = 'TABLE(organization_id uuid, user_id uuid, dias_restantes integer)')::int as sin_pii_deberia_ser_1;
rollback;

\echo '=== H1. la bitacora admite el tipo 'exportacion' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select (restaurantes.record_audit_log('00000000-0000-0000-0000-0000000e5001', 'historial.exportado', 'exportacion', null, 'formato', null, 'csv') is not null)::int as ok_deberia_ser_1;
rollback;

\echo '=== H2. RECHAZADO: un tipo desconocido sigue rechazado -> 23514 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select restaurantes.record_audit_log('00000000-0000-0000-0000-0000000e5001', 'x', 'inventado', null, null, null, null)$q$, '23514');
rollback;

\echo '=== J1. entregas del dia local en la zona de la sucursal: 00:30 y 23:59 locales cuentan; 23:30 del dia anterior y 00:00 del siguiente NO; otro repartidor NO ==='
begin;
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000e5a01', '00000000-0000-0000-0000-0000000e5001', 'Sucursal J') on conflict do nothing;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, assigned_repartidor_id) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5a01', 'C0', '+52 550000000', 10, 'entregado', '[]', 'web', '2026-10-01 12:00:00+00', '2026-10-03 06:30:00+00', '00000000-0000-0000-0000-0000000e5014');
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, assigned_repartidor_id) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5a01', 'C1', '+52 550000001', 10, 'entregado', '[]', 'web', '2026-10-01 12:00:00+00', '2026-10-03 05:30:00+00', '00000000-0000-0000-0000-0000000e5014');
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, assigned_repartidor_id) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5a01', 'C2', '+52 550000002', 10, 'entregado', '[]', 'web', '2026-10-01 12:00:00+00', '2026-10-04 05:59:00+00', '00000000-0000-0000-0000-0000000e5014');
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, assigned_repartidor_id) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5a01', 'C3', '+52 550000003', 10, 'entregado', '[]', 'web', '2026-10-01 12:00:00+00', '2026-10-04 06:00:00+00', '00000000-0000-0000-0000-0000000e5014');
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, assigned_repartidor_id) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5a01', 'C4', '+52 550000004', 10, 'entregado', '[]', 'web', '2026-10-01 12:00:00+00', '2026-10-03 17:00:00+00', '00000000-0000-0000-0000-0000000e5015');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select count(*) as entregas_deberia_ser_2 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e5001' and assigned_repartidor_id = '00000000-0000-0000-0000-0000000e5014' and delivered_at is not null and delivered_at >= ('2026-10-03'::date)::timestamp at time zone 'America/Mexico_City' and delivered_at < (('2026-10-03'::date + 1))::timestamp at time zone 'America/Mexico_City';
rollback;

\echo '=== I1. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.guardar_perfil_repartidor(uuid, uuid, text, text, text, text, text, date, text, text);
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.guardar_perfil_repartidor('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5014', 'moto', null, 'disponible', null, null, null, null, null);
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
