-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0090_whatsapp_credenciales_meta.sql (credenciales de Meta por organizacion: varias apps):
--
--   A) Registrar: solo un superadmin real y NO restringido (owner de la org, anon, caller-binding roto, rol `finanzas`
--      y sesion de sistema rechazados); app_id activo unico en la plataforma; solo sobres cifrados (nunca texto claro).
--   R) Rotar y revocar: campos sueltos, nunca la credencial de otra organizacion, revocar borra sobres y libera numeros.
--   N) Asignar numeros: sucursal + credencial de la misma organizacion; un numero, sucursal o credencial de OTRA
--      organizacion se rechaza; liberar devuelve el numero a la plataforma; cambiar el numero de una sucursal suelta el viejo.
--   L) Lecturas del superadmin: solo metadatos y cero filas para cualquier otro.
--   S) Lectura de sistema: solo con auth.uid() nulo (ni un superadmin autenticado ni anon).
--   T) Tablas sin acceso directo (ni service_role), bitacora append-only y funciones con search_path fijo, sin anon.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback propio; el alias
-- `should_fail` marca un escenario que debe terminar en ERROR; el alias deberia_ser_N exige que la ultima fila valga N; el resto
-- debe completar sin error. Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures (como dueño, sin pasar por las funciones).
insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f9000', 'restaurantes', 'Org A whatsapp meta', 'org-wm-a', 'active'),
  ('00000000-0000-0000-0000-0000000f9001', 'restaurantes', 'Org B whatsapp meta', 'org-wm-b', 'active'),
  ('00000000-0000-0000-0000-0000000f9002', 'hoteles', 'Org C hotel', 'org-wm-c', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f9300', '00000000-0000-0000-0000-0000000f9000', 'restaurantes', 'Sucursal A1', 'active'),
  ('00000000-0000-0000-0000-0000000f9301', '00000000-0000-0000-0000-0000000f9000', 'restaurantes', 'Sucursal A2', 'active'),
  ('00000000-0000-0000-0000-0000000f9302', '00000000-0000-0000-0000-0000000f9001', 'restaurantes', 'Sucursal B1', 'active'),
  ('00000000-0000-0000-0000-0000000f9303', '00000000-0000-0000-0000-0000000f9002', 'hoteles', 'Hotel C1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f9100', 'sa-wm-1@example.com', 'Superadmin WM 1', 'seed'),
  ('00000000-0000-0000-0000-0000000f9101', 'sa-wm-2@example.com', 'Superadmin WM 2', 'seed'),
  ('00000000-0000-0000-0000-0000000f9102', 'owner-wm@example.com', 'Owner de la Org A', 'seed'),
  ('00000000-0000-0000-0000-0000000f9103', 'finanzas-wm@example.com', 'Finanzas WM', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000f9100'), ('00000000-0000-0000-0000-0000000f9101'), ('00000000-0000-0000-0000-0000000f9103')
on conflict do nothing;

insert into core.cfo_zone_role (staff_user_id, rol, assigned_by, reason) values
  ('00000000-0000-0000-0000-0000000f9103', 'finanzas', '00000000-0000-0000-0000-0000000f9100', 'Fixture: rol de solo lectura para la verificacion.')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f9102', '00000000-0000-0000-0000-0000000f9000', null, 'owner', 'staff')
on conflict do nothing;

-- Credencial existente de A (app 11111, numero 5550001 en la sucursal A1) y de B (app 33333, numero 5550009 en la sucursal B1).
insert into core.whatsapp_meta_credencial (id, organization_id, etiqueta, app_id, waba_id, app_secret_cifrado, access_token_cifrado, verify_token_hash) values
  ('00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', 'App de A', '11111', '22222', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.c2VjcmV0bw', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.dG9rZW4', repeat('a', 64)),
  ('00000000-0000-0000-0000-0000000f9b00', '00000000-0000-0000-0000-0000000f9001', 'App de B', '33333', '44444', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.c2VjcmV0bw', 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.dG9rZW4', null)
on conflict do nothing;
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id) values
  ('5550001', '00000000-0000-0000-0000-0000000f9000', '00000000-0000-0000-0000-0000000f9300'),
  ('5550009', '00000000-0000-0000-0000-0000000f9001', '00000000-0000-0000-0000-0000000f9302')
on conflict do nothing;
insert into core.whatsapp_meta_numero (phone_number_id, organization_id, credencial_id) values
  ('5550001', '00000000-0000-0000-0000-0000000f9000', '00000000-0000-0000-0000-0000000f9a00'),
  ('5550009', '00000000-0000-0000-0000-0000000f9001', '00000000-0000-0000-0000-0000000f9b00')
on conflict do nothing;

-- Ayudantes SOLO de esta verificacion (invoker: usan la identidad de quien llama).
create or replace function public.wm_sobre() returns text language sql immutable as $$
  select 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.bnVldm8'
$$;
create or replace function public.wm_registrar(p_caller uuid, p_cred uuid, p_org uuid, p_app text, p_waba text)
returns void language sql as $$
  select core.whatsapp_meta_registrar_credencial(p_caller, p_cred, p_org, 'Fixture', p_app, p_waba, public.wm_sobre(), public.wm_sobre(), null)
$$;

\echo 'A1. superadmin registra una credencial de A: activa, con su evento en la bitacora -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select public.wm_registrar('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a01', '00000000-0000-0000-0000-0000000f9000', '55555', '66666');
reset role;
select ((select activa and creada_por = '00000000-0000-0000-0000-0000000f9100' from core.whatsapp_meta_credencial where id = '00000000-0000-0000-0000-0000000f9a01')
        and exists (select 1 from core.whatsapp_meta_evento where credencial_id = '00000000-0000-0000-0000-0000000f9a01' and evento = 'credencial_registrada'))::int as deberia_ser_1;
rollback;

\echo 'A2. el owner de la propia organizacion (no superadmin) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select public.wm_registrar('00000000-0000-0000-0000-0000000f9102', '00000000-0000-0000-0000-0000000f9a02', '00000000-0000-0000-0000-0000000f9000', '55556', '66667') as should_fail;
rollback;

\echo 'A3. anon no puede ejecutar la funcion -- RECHAZADO'
begin;
set local role anon;
select core.whatsapp_meta_registrar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a03', '00000000-0000-0000-0000-0000000f9000', 'x', '55557', '66668', public.wm_sobre(), public.wm_sobre(), null) as should_fail;
rollback;

\echo 'A4. caller-binding: p_caller_id de un superadmin con auth.uid() de OTRO -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9101', true);
select public.wm_registrar('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a04', '00000000-0000-0000-0000-0000000f9000', '55558', '66669') as should_fail;
rollback;

\echo 'A5. superadmin restringido al rol finanzas -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9103', true);
select public.wm_registrar('00000000-0000-0000-0000-0000000f9103', '00000000-0000-0000-0000-0000000f9a05', '00000000-0000-0000-0000-0000000f9000', '55559', '66670') as should_fail;
rollback;

\echo 'A6. sesion de sistema (auth.uid() nulo) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.wm_registrar('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a06', '00000000-0000-0000-0000-0000000f9000', '55560', '66671') as should_fail;
rollback;

\echo 'A7. la app de B (app_id activo) no se puede registrar tambien en A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select public.wm_registrar('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a07', '00000000-0000-0000-0000-0000000f9000', '33333', '66672') as should_fail;
rollback;

\echo 'A8. un secreto en texto claro (no es un sobre cifrado) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_registrar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a08', '00000000-0000-0000-0000-0000000f9000', 'x', '55561', '66673', 'texto-claro', public.wm_sobre(), null) as should_fail;
rollback;

\echo 'A9. organizacion inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select public.wm_registrar('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a09', '00000000-0000-0000-0000-0000000f9999', '55562', '66674') as should_fail;
rollback;

\echo 'R1. rotar solo el token: cambia el sobre, la bitacora nombra el campo y no guarda el sobre -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_rotar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', null, null, public.wm_sobre(), null, false);
reset role;
select ((select access_token_cifrado = public.wm_sobre() and app_secret_cifrado <> public.wm_sobre() from core.whatsapp_meta_credencial where id = '00000000-0000-0000-0000-0000000f9a00')
        and exists (select 1 from core.whatsapp_meta_evento where credencial_id = '00000000-0000-0000-0000-0000000f9a00' and evento = 'credencial_rotada'
                    and detalle -> 'campos' = '["access_token"]'::jsonb and detalle::text not like '%bnVldm8%'))::int as deberia_ser_1;
rollback;

\echo 'R2. rotar la credencial de B diciendo que es de A (cross-tenant) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_rotar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9b00', '00000000-0000-0000-0000-0000000f9000', null, null, public.wm_sobre(), null, false) as should_fail;
rollback;

\echo 'R3. rotar sin ningun cambio -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_rotar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', null, null, null, null, false) as should_fail;
rollback;

\echo 'R4. revocar: libera su numero, borra sobres y hash y deja el motivo en la bitacora -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_revocar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', 'Rotacion por baja del proveedor');
reset role;
select ((select not activa and app_secret_cifrado is null and access_token_cifrado is null and verify_token_hash is null from core.whatsapp_meta_credencial where id = '00000000-0000-0000-0000-0000000f9a00')
        and not exists (select 1 from core.whatsapp_meta_numero where credencial_id = '00000000-0000-0000-0000-0000000f9a00')
        and exists (select 1 from core.whatsapp_meta_evento where credencial_id = '00000000-0000-0000-0000-0000000f9a00' and evento = 'credencial_revocada' and (detalle ->> 'numeros_liberados')::int = 1))::int as deberia_ser_1;
rollback;

\echo 'R5. revocar sin motivo suficiente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_revocar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', 'corto') as should_fail;
rollback;

\echo 'R6. rotar una credencial ya revocada -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_revocar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', 'Rotacion por baja del proveedor');
select core.whatsapp_meta_rotar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', null, null, public.wm_sobre(), null, false) as should_fail;
rollback;

\echo 'R7. el owner de A no puede revocar la credencial de A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select core.whatsapp_meta_revocar_credencial('00000000-0000-0000-0000-0000000f9102', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', 'Intento del owner que debe fallar') as should_fail;
rollback;

\echo 'N1. asignar numero nuevo a la sucursal A2 con la credencial de A: ruteo de la sucursal + asignacion -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000', '5550002', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9301');
reset role;
select (exists (select 1 from restaurantes.whatsapp_branch_channel where phone_number_id = '5550002' and property_id = '00000000-0000-0000-0000-0000000f9301' and organization_id = '00000000-0000-0000-0000-0000000f9000')
        and exists (select 1 from core.whatsapp_meta_numero where phone_number_id = '5550002' and credencial_id = '00000000-0000-0000-0000-0000000f9a00')
        and exists (select 1 from core.whatsapp_meta_evento where evento = 'numero_asignado' and detalle ->> 'phone_number_id' = '5550002'))::int as deberia_ser_1;
rollback;

\echo 'N2. el numero de B no se puede asignar a A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000', '5550009', '00000000-0000-0000-0000-0000000f9a00', null) as should_fail;
rollback;

\echo 'N3. la sucursal de B no se puede usar desde A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000', '5550003', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9302') as should_fail;
rollback;

\echo 'N4. la credencial de B no se puede asignar a un numero de A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000', '5550001', '00000000-0000-0000-0000-0000000f9b00', null) as should_fail;
rollback;

\echo 'N5. liberar el numero de A1 (credencial null): vuelve a la plataforma -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000', '5550001', null, null);
reset role;
select count(*) as deberia_ser_0 from core.whatsapp_meta_numero where phone_number_id = '5550001';
rollback;

\echo 'N6. cambiar el numero de la sucursal A1: el viejo deja de rutear y suelta su credencial -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000', '5550004', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9300');
reset role;
select ((select phone_number_id from restaurantes.whatsapp_branch_channel where property_id = '00000000-0000-0000-0000-0000000f9300') = '5550004'
        and not exists (select 1 from core.whatsapp_meta_numero where phone_number_id = '5550001')
        and exists (select 1 from core.whatsapp_meta_numero where phone_number_id = '5550004'))::int as deberia_ser_1;
rollback;

\echo 'N7. el owner de A no puede asignar numeros desde aqui -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9102', '00000000-0000-0000-0000-0000000f9000', '5550005', '00000000-0000-0000-0000-0000000f9a00', null) as should_fail;
rollback;

\echo 'N8. phone_number_id con letras -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000', 'abc123', '00000000-0000-0000-0000-0000000f9a00', null) as should_fail;
rollback;

\echo 'N9. la sucursal de un hotel no admite numero por sucursal -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_asignar_numero('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9002', '5550006', null, '00000000-0000-0000-0000-0000000f9303') as should_fail;
rollback;

\echo 'L1. el superadmin lista las credenciales de A (solo metadatos) -- 1 fila'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select count(*) as deberia_ser_1 from core.whatsapp_meta_listar_credenciales('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000') where tiene_verify_token and numeros = 1;
rollback;

\echo 'L2. el owner de A no lee las credenciales de A -- 0 filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.whatsapp_meta_listar_credenciales('00000000-0000-0000-0000-0000000f9102', '00000000-0000-0000-0000-0000000f9000');
rollback;

\echo 'L3. numeros de A: sus dos sucursales (A1 con numero y credencial, A2 sin numero) -- 2 filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select count(*) as deberia_ser_2 from core.whatsapp_meta_listar_numeros('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9000');
rollback;

\echo 'L4. las lecturas del superadmin no devuelven ninguna columna cifrada ni hash'
begin;
select count(*) as deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core' and p.proname in ('whatsapp_meta_listar_credenciales', 'whatsapp_meta_listar_numeros')
  and (pg_get_function_result(p.oid) like '%cifrado%' or pg_get_function_result(p.oid) like '%hash%');
rollback;

\echo 'L5. el owner de A no lee los numeros de A por esta via -- 0 filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.whatsapp_meta_listar_numeros('00000000-0000-0000-0000-0000000f9102', '00000000-0000-0000-0000-0000000f9000');
rollback;

\echo 'S1. la sesion de sistema lee las credenciales activas con sus numeros -- 2'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_2 from core.whatsapp_meta_credenciales_para_sistema() where cardinality(phone_number_ids) = 1;
rollback;

\echo 'S2. un superadmin AUTENTICADO no puede leer los sobres -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select count(*) as should_fail from core.whatsapp_meta_credenciales_para_sistema();
rollback;

\echo 'S3. anon no puede leer los sobres -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.whatsapp_meta_credenciales_para_sistema();
rollback;

\echo 'S4. una credencial revocada ya no la ve el sistema -- 1'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select core.whatsapp_meta_revocar_credencial('00000000-0000-0000-0000-0000000f9100', '00000000-0000-0000-0000-0000000f9a00', '00000000-0000-0000-0000-0000000f9000', 'Rotacion por baja del proveedor');
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.whatsapp_meta_credenciales_para_sistema();
rollback;

\echo 'T1. anon no lee la tabla de credenciales -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.whatsapp_meta_credencial;
rollback;

\echo 'T2. un superadmin autenticado no lee la tabla directo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select count(*) as should_fail from core.whatsapp_meta_credencial;
rollback;

\echo 'T3. service_role tampoco lee la tabla directo -- RECHAZADO'
begin;
set local role service_role;
select count(*) as should_fail from core.whatsapp_meta_credencial;
rollback;

\echo 'T4. ningun privilegio de anon, authenticated ni service_role sobre las 3 tablas; RLS habilitado'
begin;
select (
  count(*) filter (where has_table_privilege(r, t, p)) = 0
  and (select bool_and(relrowsecurity) from pg_class where oid in ('core.whatsapp_meta_credencial'::regclass, 'core.whatsapp_meta_numero'::regclass, 'core.whatsapp_meta_evento'::regclass))
)::int as deberia_ser_1
from unnest(array['anon', 'authenticated', 'service_role']) as r,
     unnest(array['core.whatsapp_meta_credencial', 'core.whatsapp_meta_numero', 'core.whatsapp_meta_evento']) as t,
     unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p;
rollback;

\echo 'T5. la bitacora no se puede editar ni siquiera como dueño -- RECHAZADO'
begin;
insert into core.whatsapp_meta_evento (organization_id, evento) values ('00000000-0000-0000-0000-0000000f9000', 'numero_liberado');
update core.whatsapp_meta_evento set detalle = '{}'::jsonb returning 1 as should_fail;
rollback;

\echo 'T6. la bitacora no se puede borrar ni siquiera como dueño -- RECHAZADO'
begin;
insert into core.whatsapp_meta_evento (organization_id, evento) values ('00000000-0000-0000-0000-0000000f9000', 'numero_liberado');
delete from core.whatsapp_meta_evento returning 1 as should_fail;
rollback;

\echo 'T7. funciones nuevas: security definer con search_path fijo; ninguna ejecutable por anon'
begin;
select count(*) as deberia_ser_0
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core'
  and p.proname in ('whatsapp_meta_registrar_credencial', 'whatsapp_meta_rotar_credencial', 'whatsapp_meta_revocar_credencial', 'whatsapp_meta_asignar_numero',
                    'whatsapp_meta_listar_credenciales', 'whatsapp_meta_listar_numeros', 'whatsapp_meta_credenciales_para_sistema', 'whatsapp_meta_evento_bloquear_mutacion')
  and (has_function_privilege('anon', p.oid, 'execute')
       or p.proconfig is null
       or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
       or (p.proname <> 'whatsapp_meta_evento_bloquear_mutacion' and not p.prosecdef));
rollback;
