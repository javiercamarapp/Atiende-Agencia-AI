-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/db/migrations/0059_login_chofer_whatsapp.sql y packages/domain-restaurantes/migrations/093_outbox_codigo_acceso_sin_residuo.sql
-- (login del repartidor por celular + codigo de WhatsApp; docs/LOGIN-CHOFER-WHATSAPP.md).
--
--   A. Gestion del telefono: owner/admin y encargado (staff) registran; cajero, repartidor, otro tenant, sistema y anon NO; el objetivo debe ser
--      un repartidor elegible; telefono duplicado y formato invalido rechazados; listar enmascara; quitar borra.
--   B. Limites: por telefono, por IP y bloqueo temporal por codigos agotados.
--   C. Ciclo del codigo: emitir invalida el anterior, reservar cuenta el intento, maximo 5, expiracion, un solo uso, vigencia maxima.
--   D. Elegibilidad: encargado, cajero, administrador, owner, superadmin, repartidor con otra membresia, de otra vertical o de org suspendida NO
--      resuelven aunque tengan telefono registrado; la baja de la membresia corta el acceso.
--   E. Superficie: funciones de sistema rechazan sesion autenticada (42501), anon sin EXECUTE, tablas sin acceso directo.
--   F. Plantilla `codigo_acceso`: solo aprobada y con el nombre exacto cuenta como disponible.
--   H. Usuario repartidor en DOS organizaciones: no resuelve, no se le emite codigo y el admin de la otra organizacion no puede registrarle un celular.
--   G. Outbox: el payload del evento `auth.codigo_acceso` queda sin codigo ni telefono al pasar a sent/dead.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; deberia_ser_N marca el valor esperado.
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

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f6001', 'restaurantes', 'Login Org A', 'login-a', 'trial'),
  ('00000000-0000-0000-0000-0000000f6002', 'restaurantes', 'Login Org B (ajena)', 'login-b', 'active'),
  ('00000000-0000-0000-0000-0000000f6003', 'hoteles', 'Login Hotel', 'login-h', 'active'),
  ('00000000-0000-0000-0000-0000000f6004', 'restaurantes', 'Login Org suspendida', 'login-s', 'suspended')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f6011', 'owner-a@login.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6012', 'admin-a@login.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6013', 'encargado-a@login.example.com', 'Encargado A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6014', 'cajero-a@login.example.com', 'Cajero A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6015', 'rep1-a@login.example.com', 'Repartidor 1 A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6016', 'rep2-a@login.example.com', 'Repartidor 2 A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6017', 'owner-b@login.example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000f6018', 'rep-b@login.example.com', 'Repartidor B', 'seed'),
  ('00000000-0000-0000-0000-0000000f6019', 'rep-multi@login.example.com', 'Repartidor con otra membresia', 'seed'),
  ('00000000-0000-0000-0000-0000000f6020', 'rep-hotel@login.example.com', 'Repartidor de hotel', 'seed'),
  ('00000000-0000-0000-0000-0000000f6021', 'rep-super@login.example.com', 'Repartidor superadmin', 'seed'),
  ('00000000-0000-0000-0000-0000000f6022', 'rep-susp@login.example.com', 'Repartidor org suspendida', 'seed'),
  ('00000000-0000-0000-0000-0000000f6023', 'rep-doble@login.example.com', 'Repartidor en dos organizaciones', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f6011', '00000000-0000-0000-0000-0000000f6001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f6012', '00000000-0000-0000-0000-0000000f6001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000f6013', '00000000-0000-0000-0000-0000000f6001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f6014', '00000000-0000-0000-0000-0000000f6001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f6015', '00000000-0000-0000-0000-0000000f6001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f6016', '00000000-0000-0000-0000-0000000f6001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f6017', '00000000-0000-0000-0000-0000000f6002', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f6018', '00000000-0000-0000-0000-0000000f6002', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f6019', '00000000-0000-0000-0000-0000000f6001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f6019', '00000000-0000-0000-0000-0000000f6002', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f6020', '00000000-0000-0000-0000-0000000f6003', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f6021', '00000000-0000-0000-0000-0000000f6001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f6022', '00000000-0000-0000-0000-0000000f6004', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f6023', '00000000-0000-0000-0000-0000000f6001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f6023', '00000000-0000-0000-0000-0000000f6002', null, 'member', 'repartidor')
on conflict do nothing;
-- El cajero es un `staff` con perfil_operativo = 'cajero' (migracion 090 de restaurantes).
update core.membership set perfil_operativo = 'cajero' where user_id = '00000000-0000-0000-0000-0000000f6014' and organization_id = '00000000-0000-0000-0000-0000000f6001';
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f6021') on conflict do nothing;

-- Telefonos registrados DIRECTAMENTE por el dueno de la tabla (fixture): incluye cuentas NO elegibles a proposito, para probar que tener un
-- telefono registrado no basta para entrar por esta via.
insert into core.chofer_login_telefono (user_id, organization_id, telefono_e164) values
  ('00000000-0000-0000-0000-0000000f6015', '00000000-0000-0000-0000-0000000f6001', '+529990000001'),
  ('00000000-0000-0000-0000-0000000f6011', '00000000-0000-0000-0000-0000000f6001', '+529990000010'),
  ('00000000-0000-0000-0000-0000000f6012', '00000000-0000-0000-0000-0000000f6001', '+529990000011'),
  ('00000000-0000-0000-0000-0000000f6013', '00000000-0000-0000-0000-0000000f6001', '+529990000012'),
  ('00000000-0000-0000-0000-0000000f6014', '00000000-0000-0000-0000-0000000f6001', '+529990000013'),
  ('00000000-0000-0000-0000-0000000f6019', '00000000-0000-0000-0000-0000000f6001', '+529990000014'),
  ('00000000-0000-0000-0000-0000000f6021', '00000000-0000-0000-0000-0000000f6001', '+529990000015'),
  ('00000000-0000-0000-0000-0000000f6020', '00000000-0000-0000-0000-0000000f6003', '+529990000016'),
  ('00000000-0000-0000-0000-0000000f6022', '00000000-0000-0000-0000-0000000f6004', '+529990000017'),
  ('00000000-0000-0000-0000-0000000f6018', '00000000-0000-0000-0000-0000000f6002', '+529990000018'),
  ('00000000-0000-0000-0000-0000000f6023', '00000000-0000-0000-0000-0000000f6002', '+529990000019')
on conflict do nothing;


\echo '=== A1. owner registra el telefono de un repartidor ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000002') as x;
select count(*) as filas_deberia_ser_1 from core.chofer_login_telefono_listar('00000000-0000-0000-0000-0000000f6001') where user_id = '00000000-0000-0000-0000-0000000f6016' and telefono_enmascarado = '******0002';
rollback;

\echo '=== A2. el encargado (staff, perfil encargado) registra el telefono ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6013', true);
select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000002') as x;
rollback;

\echo '=== A3. admin registra el telefono ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6012', true);
select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000002') as x;
rollback;

\echo '=== A4. el cajero NO puede registrar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6014', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000002')$e$, 'P0001') as x;
rollback;

\echo '=== A5. un repartidor NO puede registrar el telefono de otro ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6015', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000002')$e$, 'P0001') as x;
rollback;

\echo '=== A6. otro tenant NO puede registrar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6017', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000002')$e$, 'P0001') as x;
rollback;

\echo '=== A7. el objetivo no puede ser administrador ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6012','+529990000003')$e$, 'P0001') as x;
rollback;

\echo '=== A8. el objetivo no puede ser encargado ni cajero ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6013','+529990000003')$e$, 'P0001') as x;
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6014','+529990000003')$e$, 'P0001') as x;
rollback;

\echo '=== A9. el objetivo no puede ser superadmin ni tener otra membresia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6021','+529990000003')$e$, 'P0001') as x;
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6019','+529990000003')$e$, 'P0001') as x;
rollback;

\echo '=== A10. sin sesion (sistema) no registra ==='
begin;
set local role authenticated;
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000002')$e$, '42501') as x;
rollback;

\echo '=== A11. anon no tiene EXECUTE ==='
begin;
set local role anon;
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000002')$e$, '42501') as x;
rollback;

\echo '=== A12. telefono ya usado por otra cuenta: rechazo generico ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+529990000001')$e$, 'P0001') as x;
rollback;

\echo '=== A13. formato invalido (no mexicano / sin +52) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','+15551234567')$e$, '23514') as x;
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6016','9991234567')$e$, '23514') as x;
rollback;

\echo '=== A14. listar devuelve el telefono enmascarado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select count(*) as filas_deberia_ser_1 from core.chofer_login_telefono_listar('00000000-0000-0000-0000-0000000f6001') where user_id = '00000000-0000-0000-0000-0000000f6015' and telefono_enmascarado = '******0001';
rollback;

\echo '=== A15. listar: el cajero no puede ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6014', true);
select public.t_esperar_error($e$select * from core.chofer_login_telefono_listar('00000000-0000-0000-0000-0000000f6001')$e$, 'P0001') as x;
rollback;

\echo '=== A16. quitar borra el telefono (visto como dueno de la tabla) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select core.chofer_login_telefono_quitar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6015') as q;
reset role;
select count(*) as filas_deberia_ser_0 from core.chofer_login_telefono where user_id = '00000000-0000-0000-0000-0000000f6015';
rollback;

\echo '=== A17. el cajero no puede quitar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6014', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_quitar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6015')$e$, 'P0001') as x;
rollback;

\echo '=== B1. el cuarto envio por telefono en la ventana se rechaza (limite 3) ==='
begin;
set local role authenticated;
select count(*) filter (where ok = 'ok') as permitidas_deberia_ser_3 from (select core.chofer_login_puede_solicitar('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',3,100,900,1800) as ok from generate_series(1,5)) q;
rollback;

\echo '=== B2. limite por IP aunque cambie el telefono ==='
begin;
set local role authenticated;
select count(*) filter (where ok = 'ok') as permitidas_deberia_ser_2 from (select core.chofer_login_puede_solicitar(lpad(g::text, 64, '0'),'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',3,2,900,1800) as ok from generate_series(1,5) g) q;
rollback;

\echo '=== B3. dos codigos agotados bloquean temporalmente al telefono ==='
begin;
set local role authenticated;
select core.chofer_login_registrar_evento('codigo_agotado','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',null,null,null);
select core.chofer_login_registrar_evento('codigo_agotado','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',null,null,null);
select count(*) filter (where ok = 'ok') as permitidas_deberia_ser_0 from (select core.chofer_login_puede_solicitar('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',3,100,900,1800) as ok) q;
rollback;

\echo '=== B6. el bloqueo se distingue del limite solo por dentro ('bloqueado' vs 'limitado') ==='
begin;
set local role authenticated;
select core.chofer_login_registrar_evento('codigo_agotado','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',null,null,null);
select core.chofer_login_registrar_evento('codigo_agotado','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',null,null,null);
select count(*) as filas_deberia_ser_1 from (select core.chofer_login_puede_solicitar('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',3,100,900,1800) as r) q where r = 'bloqueado';
rollback;

\echo '=== B4. la auditoria guarda solo hashes (sin telefono ni IP en claro) ==='
begin;
select core.chofer_login_puede_solicitar('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',3,100,900,1800) as x;
select count(*) as filas_deberia_ser_0 from core.chofer_login_evento where telefono_hash !~ '^[0-9a-f]{64}$' or ip_hash !~ '^[0-9a-f]{64}$';
rollback;

\echo '=== B5. parametros de limite invalidos se rechazan ==='
begin;
set local role authenticated;
select public.t_esperar_error($e$select core.chofer_login_puede_solicitar('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',0,3,900,1800)$e$, '22023') as x;
rollback;

\echo '=== C1. emitir + reservar: devuelve hash y cuenta el intento ==='
begin;
set local role authenticated;
create temp table t as select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300) as cid;
select count(*) as filas_deberia_ser_1 from core.chofer_login_reservar_intento('+529990000001') where intentos = 1;
rollback;

\echo '=== C2. consumir: primer uso gana ==='
begin;
set local role authenticated;
create temp table t as select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300) as cid;
select count(*) as filas_deberia_ser_1 from core.chofer_login_consumir((select cid from t));
rollback;

\echo '=== C3. consumir: el segundo uso del mismo codigo no devuelve nada ==='
begin;
set local role authenticated;
create temp table t as select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300) as cid;
create temp table c1 as select * from core.chofer_login_consumir((select cid from t));
select count(*) as filas_deberia_ser_0 from core.chofer_login_consumir((select cid from t));
rollback;

\echo '=== C4. emitir uno nuevo invalida el anterior (un solo pendiente) ==='
begin;
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select count(*) as filas_deberia_ser_1 from core.chofer_login_codigo where staff_user_id = '00000000-0000-0000-0000-0000000f6015' and estado = 'pendiente';
rollback;

\echo '=== C5. el codigo reemplazado ya no se puede consumir ==='
begin;
set local role authenticated;
create temp table t as select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300) as cid;
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select count(*) as filas_deberia_ser_0 from core.chofer_login_consumir((select cid from t));
rollback;

\echo '=== C6. maximo 5 intentos: el sexto ya no devuelve el codigo ==='
begin;
set local role authenticated;
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
create temp table r(i int);
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
select count(*) as filas_deberia_ser_5 from r;
rollback;

\echo '=== C7. al gastar el quinto intento el codigo se invalida ==='
begin;
set local role authenticated;
create temp table t as select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300) as cid;
create temp table r(i int);
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
insert into r select intentos from core.chofer_login_reservar_intento('+529990000001');
select core.chofer_login_fallo((select cid from t));
reset role;
select count(*) as filas_deberia_ser_1 from core.chofer_login_codigo where staff_user_id = '00000000-0000-0000-0000-0000000f6015' and estado = 'invalidado' and motivo_cierre = 'intentos';
rollback;

\echo '=== C8. codigo vencido: no se devuelve ==='
begin;
set local role authenticated;
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
reset role;
update core.chofer_login_codigo set expires_at = now() - interval '1 minute';
set local role authenticated;
select count(*) as filas_deberia_ser_0 from core.chofer_login_reservar_intento('+529990000001');
rollback;

\echo '=== C9. codigo vencido: no se puede consumir ==='
begin;
set local role authenticated;
create temp table t as select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300) as cid;
reset role;
update core.chofer_login_codigo set expires_at = now() - interval '1 second';
set local role authenticated;
select count(*) as filas_deberia_ser_0 from core.chofer_login_consumir((select cid from t));
rollback;

\echo '=== C10. vigencia maxima de 10 minutos ==='
begin;
set local role authenticated;
select public.t_esperar_error($e$select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 601)$e$, '22023') as x;
rollback;

\echo '=== C11. el hash guardado no contiene el codigo en claro ==='
begin;
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select count(*) as filas_deberia_ser_0 from core.chofer_login_codigo where code_hash !~ '^[0-9a-f]{64}$' or code_salt !~ '^[0-9a-f]{32}$';
rollback;

\echo '=== D1. encargado, cajero, admin, owner, superadmin, repartidor con otra membresia, de hotel y de org suspendida NO resuelven aunque tengan telefono ==='
begin;
set local role authenticated;
select count(*) as filas_deberia_ser_0 from unnest(array['+529990000010','+529990000011','+529990000012','+529990000013','+529990000014','+529990000015','+529990000016','+529990000017']) p, lateral core.chofer_login_resolver(p);
rollback;

\echo '=== D2. un repartidor valido (de cualquier tenant) si resuelve ==='
begin;
set local role authenticated;
select count(*) as filas_deberia_ser_2 from unnest(array['+529990000001','+529990000018']) p, lateral core.chofer_login_resolver(p);
rollback;

\echo '=== D3. no se emiten codigos para cuentas no elegibles ==='
begin;
set local role authenticated;
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6013','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6014','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6011','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6012','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6021','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6019','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
reset role;
select count(*) as filas_deberia_ser_0 from core.chofer_login_codigo;
rollback;

\echo '=== D4. la baja de la membresia borra el telefono ==='
begin;
delete from core.membership where user_id = '00000000-0000-0000-0000-0000000f6015' and organization_id = '00000000-0000-0000-0000-0000000f6001';
select count(*) as filas_deberia_ser_0 from core.chofer_login_telefono where user_id = '00000000-0000-0000-0000-0000000f6015';
rollback;

\echo '=== D5. una baja entre reservar y consumir corta el acceso ==='
begin;
set local role authenticated;
create temp table t as select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300) as cid;
select count(*) from core.chofer_login_reservar_intento('+529990000001');
reset role;
delete from core.membership where user_id = '00000000-0000-0000-0000-0000000f6015' and organization_id = '00000000-0000-0000-0000-0000000f6001';
set local role authenticated;
select count(*) as filas_deberia_ser_0 from core.chofer_login_consumir((select cid from t));
rollback;

\echo '=== D6. ascender al repartidor a administrador lo saca de esta via ==='
begin;
update core.membership set vertical_role = 'admin', platform_role = 'admin' where user_id = '00000000-0000-0000-0000-0000000f6015' and organization_id = '00000000-0000-0000-0000-0000000f6001';
select count(*) as filas_deberia_ser_0 from core.chofer_login_resolver('+529990000001');
rollback;

\echo '=== D7. darle una segunda membresia (otra org) lo saca de esta via ==='
begin;
insert into core.membership (user_id, organization_id, platform_role, vertical_role) values ('00000000-0000-0000-0000-0000000f6015', '00000000-0000-0000-0000-0000000f6002', 'member', 'staff');
select count(*) as filas_deberia_ser_0 from core.chofer_login_resolver('+529990000001');
rollback;

\echo '=== D8. convertirlo en superadmin lo saca de esta via ==='
begin;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f6015');
select count(*) as filas_deberia_ser_0 from core.chofer_login_resolver('+529990000001');
rollback;

\echo '=== E1. las funciones de login rechazan una sesion autenticada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select * from core.chofer_login_resolver('+529990000001')$e$, '42501') as x;
rollback;

\echo '=== E2. anon no tiene EXECUTE en las funciones de login ==='
begin;
set local role anon;
select public.t_esperar_error($e$select * from core.chofer_login_resolver('+529990000001')$e$, '42501') as x;
rollback;

\echo '=== E3. authenticated no lee ni escribe las tablas directamente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select * from core.chofer_login_codigo$e$, '42501') as x;
select public.t_esperar_error($e$select * from core.chofer_login_telefono$e$, '42501') as x;
select public.t_esperar_error($e$select * from core.chofer_login_evento$e$, '42501') as x;
select public.t_esperar_error($e$insert into core.chofer_login_telefono (user_id, organization_id, telefono_e164) values ('00000000-0000-0000-0000-0000000f6016','00000000-0000-0000-0000-0000000f6001','+529990000099')$e$, '42501') as x;
rollback;

\echo '=== E4. anon no lee las tablas ==='
begin;
set local role anon;
select public.t_esperar_error($e$select * from core.chofer_login_codigo$e$, '42501') as x;
rollback;

\echo '=== E5. consumir, reservar y emitir rechazan sesion autenticada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select * from core.chofer_login_consumir('00000000-0000-0000-0000-0000000f6099')$e$, '42501') as x;
select public.t_esperar_error($e$select * from core.chofer_login_reservar_intento('+529990000001')$e$, '42501') as x;
select public.t_esperar_error($e$select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300)$e$, '42501') as x;
rollback;

\echo '=== F1. plantilla aprobada con el nombre exacto: disponible ==='
begin;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado) values ('00000000-0000-0000-0000-0000000f6001','restaurantes','auth.codigo_acceso','codigo_acceso','es_MX','{codigo}','aprobada');
select count(*) as filas_deberia_ser_1 from (select 1 where core.chofer_login_plantilla_disponible()) q;
rollback;

\echo '=== F2. plantilla en borrador: no disponible ==='
begin;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado) values ('00000000-0000-0000-0000-0000000f6001','restaurantes','auth.codigo_acceso','codigo_acceso','es_MX','{codigo}','borrador');
select count(*) as filas_deberia_ser_0 from (select 1 where core.chofer_login_plantilla_disponible()) q;
rollback;

\echo '=== F3. otro nombre aprobado: no disponible ==='
begin;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado) values ('00000000-0000-0000-0000-0000000f6001','restaurantes','auth.codigo_acceso','otra_plantilla','es_MX','{codigo}','aprobada');
select count(*) as filas_deberia_ser_0 from (select 1 where core.chofer_login_plantilla_disponible()) q;
rollback;

\echo '=== F4. la plantilla se resuelve por organizacion ==='
begin;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado) values ('00000000-0000-0000-0000-0000000f6001','restaurantes','auth.codigo_acceso','codigo_acceso','es_MX','{codigo}','aprobada');
select count(*) as filas_deberia_ser_1 from core.chofer_login_plantilla('00000000-0000-0000-0000-0000000f6001');
rollback;

\echo '=== F5. otra organizacion sin plantilla no la hereda ==='
begin;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado) values ('00000000-0000-0000-0000-0000000f6001','restaurantes','auth.codigo_acceso','codigo_acceso','es_MX','{codigo}','aprobada');
select count(*) as filas_deberia_ser_0 from core.chofer_login_plantilla('00000000-0000-0000-0000-0000000f6002');
rollback;

\echo '=== F6. las funciones de plantilla rechazan sesion autenticada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select core.chofer_login_plantilla_disponible()$e$, '42501') as x;
rollback;

\echo '=== H1. repartidor en dos organizaciones: aunque tenga telefono registrado no resuelve ==='
begin;
select count(*) as filas_deberia_ser_0 from core.chofer_login_resolver('+529990000019');
rollback;

\echo '=== H2. el admin de la otra organizacion NO puede registrarle un celular (ni el de la primera) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6017', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6002','00000000-0000-0000-0000-0000000f6023','+529990000099')$e$, 'P0001') as x;
rollback;

\echo '=== H3. el owner de la primera organizacion tampoco ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select core.chofer_login_telefono_guardar('00000000-0000-0000-0000-0000000f6001','00000000-0000-0000-0000-0000000f6023','+529990000099')$e$, 'P0001') as x;
rollback;

\echo '=== H4. no se le emite codigo ==='
begin;
set local role authenticated;
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6023','00000000-0000-0000-0000-0000000f6002','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6023','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 300);
reset role;
select count(*) as filas_deberia_ser_0 from core.chofer_login_codigo where staff_user_id = '00000000-0000-0000-0000-0000000f6023';
rollback;

\echo '=== H5. vigencia fuera de rango o nula se rechaza (22023) ==='
begin;
set local role authenticated;
select public.t_esperar_error($e$select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 0)$e$, '22023') as x;
select public.t_esperar_error($e$select core.chofer_login_emitir('00000000-0000-0000-0000-0000000f6015','00000000-0000-0000-0000-0000000f6001','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', null)$e$, '22023') as x;
rollback;

\echo '=== G1. el payload del codigo de acceso se redacta al pasar a sent ==='
begin;
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status) values ('00000000-0000-0000-0000-0000000f6070','00000000-0000-0000-0000-0000000f6001','whatsapp','auth.codigo_acceso','k1','{"to":"+529990000001","template":{"params":["123456"]}}','processing');
update restaurantes.messaging_outbox set status = 'sent' where id = '00000000-0000-0000-0000-0000000f6070';
select count(*) as filas_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000f6070' and payload = '{"redactado": true}'::jsonb;
rollback;

\echo '=== G2. tambien al pasar a dead ==='
begin;
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status) values ('00000000-0000-0000-0000-0000000f6070','00000000-0000-0000-0000-0000000f6001','whatsapp','auth.codigo_acceso','k1','{"to":"+529990000001","template":{"params":["123456"]}}','processing');
update restaurantes.messaging_outbox set status = 'dead' where id = '00000000-0000-0000-0000-0000000f6070';
select count(*) as filas_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000f6070' and payload = '{"redactado": true}'::jsonb;
rollback;

\echo '=== G3. pendiente o reintento conserva lo necesario para enviar ==='
begin;
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status) values ('00000000-0000-0000-0000-0000000f6070','00000000-0000-0000-0000-0000000f6001','whatsapp','auth.codigo_acceso','k1','{"to":"+529990000001","template":{"params":["123456"]}}','processing');
update restaurantes.messaging_outbox set status = 'pending' where id = '00000000-0000-0000-0000-0000000f6070';
select count(*) as filas_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000f6070' and payload ? 'to';
rollback;

\echo '=== G4. otros eventos no se tocan ==='
begin;
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status) values ('00000000-0000-0000-0000-0000000f6070','00000000-0000-0000-0000-0000000f6001','whatsapp','order.status.entregado','k1','{"to":"+529990000001","template":{"params":["123456"]}}','processing');
update restaurantes.messaging_outbox set status = 'sent' where id = '00000000-0000-0000-0000-0000000f6070';
select count(*) as filas_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000f6070' and payload ? 'to';
rollback;

\echo '=== G5. purgar_codigos_acceso_vencidos redacta y mata lo no terminal con mas de 10 min (pending, processing) y deja lo reciente y otros eventos ==='
begin;
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, created_at) values ('00000000-0000-0000-0000-0000000f6071','00000000-0000-0000-0000-0000000f6001','whatsapp','auth.codigo_acceso','k71','{"to":"+529990000001","template":{"params":["123456"]}}','pending', now() - interval '11 minutes');
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, created_at) values ('00000000-0000-0000-0000-0000000f6072','00000000-0000-0000-0000-0000000f6001','whatsapp','auth.codigo_acceso','k72','{"to":"+529990000001","template":{"params":["123456"]}}','processing', now() - interval '30 minutes');
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, created_at) values ('00000000-0000-0000-0000-0000000f6073','00000000-0000-0000-0000-0000000f6001','whatsapp','auth.codigo_acceso','k73','{"to":"+529990000001","template":{"params":["123456"]}}','pending', now() - interval '2 minutes');
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, created_at) values ('00000000-0000-0000-0000-0000000f6074','00000000-0000-0000-0000-0000000f6001','whatsapp','order.status.entregado','k74','{"to":"+529990000001","template":{"params":["123456"]}}','pending', now() - interval '40 minutes');
select restaurantes.purgar_codigos_acceso_vencidos() as x;
select count(*) as filas_deberia_ser_2 from restaurantes.messaging_outbox where id in ('00000000-0000-0000-0000-0000000f6071','00000000-0000-0000-0000-0000000f6072') and status = 'dead' and payload = '{"redactado": true}'::jsonb and last_error_class = 'codigo_vencido';
rollback;

\echo '=== G6. la purga deja intactos lo reciente y los otros eventos ==='
begin;
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, created_at) values ('00000000-0000-0000-0000-0000000f6073','00000000-0000-0000-0000-0000000f6001','whatsapp','auth.codigo_acceso','k73','{"to":"+529990000001","template":{"params":["123456"]}}','pending', now() - interval '2 minutes');
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, created_at) values ('00000000-0000-0000-0000-0000000f6074','00000000-0000-0000-0000-0000000f6001','whatsapp','order.status.entregado','k74','{"to":"+529990000001","template":{"params":["123456"]}}','pending', now() - interval '40 minutes');
select restaurantes.purgar_codigos_acceso_vencidos() as x;
select count(*) as filas_deberia_ser_2 from restaurantes.messaging_outbox where id in ('00000000-0000-0000-0000-0000000f6073','00000000-0000-0000-0000-0000000f6074') and status = 'pending' and payload ? 'to';
rollback;

\echo '=== G7. la purga rechaza una sesion autenticada y anon no tiene EXECUTE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6011', true);
select public.t_esperar_error($e$select restaurantes.purgar_codigos_acceso_vencidos()$e$, '42501') as x;
rollback;

\echo '=== G8. anon no ejecuta la purga ==='
begin;
set local role anon;
select public.t_esperar_error($e$select restaurantes.purgar_codigos_acceso_vencidos()$e$, '42501') as x;
rollback;
