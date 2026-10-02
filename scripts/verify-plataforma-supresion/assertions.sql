-- SA-L-46 (migracion 0043) -- verificacion contra Postgres REAL de la lista de supresion de plataforma.
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR;
-- alias `..._deberia_ser_N` = el ultimo valor (entero) esperado (ver scripts/verify-real-postgres-ci/run-gate.mjs).
-- Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio; usuario real = claim con su id.
-- Datos ficticios. Los hashes de prueba salen de valores ficticios: nunca hay telefonos ni correos reales.
-- Vector compartido con apps/api/tests/supresion.spec.ts:
--   sha256('atiende:supresion:v1:telefono:+525512345678') = a896f051...ef4120
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f6a00', 'citas', 'Supresion Org A', 'org-supresion-a', 'active'),
  ('00000000-0000-0000-0000-0000000f6b00', 'restaurantes', 'Supresion Org B', 'org-supresion-b', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f6a01', 'owner-sup-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6c00', 'sa-sup@example.com', 'Superadmin Supresion', 'seed'),
  ('00000000-0000-0000-0000-0000000f6c01', 'sa2-sup@example.com', 'Superadmin Supresion 2', 'seed'),
  ('00000000-0000-0000-0000-0000000f6c02', 'sa-fin-sup@example.com', 'Superadmin Finanzas', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000f6c00'), ('00000000-0000-0000-0000-0000000f6c01'), ('00000000-0000-0000-0000-0000000f6c02')
on conflict do nothing;
insert into core.cfo_zone_role (staff_user_id, rol, reason) values ('00000000-0000-0000-0000-0000000f6c02', 'finanzas', 'Rol restringido de prueba para la verificacion');
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f6a01', '00000000-0000-0000-0000-0000000f6a00', null, 'owner', 'owner')
on conflict do nothing;

\echo '=== REGISTRO Y CONSULTA (sesion de sistema) ==='
\echo '1. el sistema registra una baja nueva: devuelve true'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', '00000000-0000-0000-0000-0000000f6a00')::int as nueva_deberia_ser_1;
rollback;

\echo '2. idempotente: registrar dos veces el mismo contacto y motivo deja UNA fila y la segunda devuelve false'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.hoteles', null)::int as segunda_deberia_ser_0;
rollback;

\echo '2b. tras dos registros iguales solo existe una fila'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
reset role;
select count(*)::int as filas_deberia_ser_1 from core.supresion_contacto where valor_hash = 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120';
rollback;

\echo '3. esta_suprimido devuelve true para un contacto registrado'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
select core.esta_suprimido('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120')::int as suprimido_deberia_ser_1;
rollback;

\echo '4. esta_suprimido devuelve false para un contacto no registrado'
begin;
set local role authenticated;
select core.esta_suprimido('telefono', '1111111111111111111111111111111111111111111111111111111111111111')::int as suprimido_deberia_ser_0;
rollback;

\echo '4b. el tipo cuenta: el mismo hash como correo NO esta suprimido si solo se registro como telefono'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
select core.esta_suprimido('correo', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120')::int as suprimido_deberia_ser_0;
rollback;

\echo '5. el hash de la base coincide con el del API (mismo prefijo de dominio y mismo valor normalizado)'
begin;
select (encode(sha256(convert_to('atiende:supresion:v1:telefono:+525512345678', 'UTF8')), 'hex') = 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120')::int as vector_deberia_ser_1;
rollback;

\echo '5b. supresion GLOBAL (cross-tenant): lo registrado con origen en la org A suprime tambien para consultas de cualquier otra org'
begin;
set local role authenticated;
select core.registrar_supresion('correo', '7e332a7fd228e7bc82f19ca61fbd151da629c35b1a54cb511486aabbe23b6399', 'queja', 'correo.citas', '00000000-0000-0000-0000-0000000f6a00');
select core.esta_suprimido('correo', '7e332a7fd228e7bc82f19ca61fbd151da629c35b1a54cb511486aabbe23b6399')::int as suprimido_global_deberia_ser_1;
rollback;

\echo '5c. motivos distintos del mismo contacto son filas distintas'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'solicitud_arco', 'arco', null);
reset role;
select count(*)::int as filas_deberia_ser_2 from core.supresion_contacto where valor_hash = 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120';
rollback;

\echo '=== SOLO SISTEMA: una sesion de usuario no registra ni consulta ==='
\echo '6. sesion de staff (auth.uid real) NO puede registrar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6a01', true);
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null) as should_fail;
rollback;

\echo '7. sesion de staff NO puede consultar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6a01', true);
select core.esta_suprimido('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120') as should_fail;
rollback;

\echo '7b. un superadmin tampoco puede usar la via de sistema (registrar_supresion exige auth.uid() nulo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null) as should_fail;
rollback;

\echo '8. anon NO puede registrar'
begin;
set local role anon;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null) as should_fail;
rollback;

\echo '8b. anon NO puede consultar'
begin;
set local role anon;
select core.esta_suprimido('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120') as should_fail;
rollback;

\echo '8c. anon NO puede listar ni agregar'
begin;
set local role anon;
select * from core.list_supresiones_for_superadmin('00000000-0000-0000-0000-0000000f6c00') as should_fail;
rollback;

begin;
set local role anon;
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c00', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120') as should_fail;
rollback;

\echo '=== TABLA SIN ACCESO DIRECTO ==='
\echo '9. un usuario autenticado no lee la tabla (sin GRANT)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select * from core.supresion_contacto as should_fail;
rollback;

\echo '9b. un usuario autenticado no inserta directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
insert into core.supresion_contacto (tipo, valor_hash, motivo, origen) values ('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'directo') returning 1 as should_fail;
rollback;

\echo '9c. anon no lee la tabla'
begin;
set local role anon;
select * from core.supresion_contacto as should_fail;
rollback;

\echo '9d. RLS habilitado y cero policies'
begin;
select (select relrowsecurity from pg_class where oid = 'core.supresion_contacto'::regclass)::int as rls_deberia_ser_1;
rollback;

begin;
select count(*)::int as policies_deberia_ser_0 from pg_policies where schemaname = 'core' and tablename = 'supresion_contacto';
rollback;

\echo '9e. ningun rol de la aplicacion tiene privilegios de tabla'
begin;
select count(*)::int as privilegios_deberia_ser_0 from information_schema.role_table_grants where table_schema = 'core' and table_name = 'supresion_contacto' and grantee in ('anon', 'authenticated', 'public');
rollback;

\echo '9f. el helper interno de insercion no es ejecutable por la app'
begin;
select count(*)::int as ejecutables_deberia_ser_0 from pg_proc p where p.pronamespace = 'core'::regnamespace and p.proname in ('supresion_insertar') and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
rollback;

\echo '9g. anon no tiene EXECUTE en ninguna funcion publica de supresion'
begin;
select count(*)::int as anon_deberia_ser_0 from pg_proc p where p.pronamespace = 'core'::regnamespace and p.proname in ('registrar_supresion', 'esta_suprimido', 'list_supresiones_for_superadmin', 'agregar_no_contactar_for_superadmin') and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo '9h. todas las funciones definer de supresion fijan search_path'
begin;
select count(*)::int as sin_search_path_deberia_ser_0 from pg_proc p where p.pronamespace = 'core'::regnamespace and p.proname in ('supresion_insertar', 'registrar_supresion', 'esta_suprimido', 'list_supresiones_for_superadmin', 'agregar_no_contactar_for_superadmin') and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
rollback;

\echo '=== NUNCA VALORES EN CLARO ==='
\echo '10. un telefono en claro NO se acepta como hash'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', '+525512345678', 'baja', 'whatsapp.citas', null) as should_fail;
rollback;

\echo '10b. un correo en claro NO se acepta como hash'
begin;
set local role authenticated;
select core.registrar_supresion('correo', 'ana@example.com', 'baja', 'correo.citas', null) as should_fail;
rollback;

\echo '10c. un hash en mayusculas o de longitud distinta se rechaza'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'A896F05198562634B8AAB833A835EB1C8BA3009CB6DA337746EF4120', 'baja', 'whatsapp.citas', null) as should_fail;
rollback;

\echo '10d. la tabla rechaza un hash invalido aunque se escriba como dueno'
begin;
insert into core.supresion_contacto (tipo, valor_hash, motivo, origen) values ('telefono', '5512345678', 'baja', 'directo') returning 1 as should_fail;
rollback;

\echo '10e. motivo, tipo y origen invalidos se rechazan'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'porque_si', 'whatsapp.citas', null) as should_fail;
rollback;

begin;
set local role authenticated;
select core.registrar_supresion('sms', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null) as should_fail;
rollback;

begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'Origen Con Espacios', null) as should_fail;
rollback;

\echo '=== SUPERADMIN: listado agregado y no contactar manual ==='
\echo '11. el superadmin real lista conteos agrupados (3 grupos: baja/whatsapp.citas x2 contactos, queja/correo.citas, rebote/correo.hoteles)'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
select core.registrar_supresion('telefono', '2222222222222222222222222222222222222222222222222222222222222222', 'baja', 'whatsapp.citas', null);
select core.registrar_supresion('correo', '7e332a7fd228e7bc82f19ca61fbd151da629c35b1a54cb511486aabbe23b6399', 'queja', 'correo.citas', null);
select core.registrar_supresion('correo', '3333333333333333333333333333333333333333333333333333333333333333', 'rebote', 'correo.hoteles', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select count(*)::int as grupos_deberia_ser_3 from core.list_supresiones_for_superadmin('00000000-0000-0000-0000-0000000f6c00');
rollback;

\echo '11b. el grupo de bajas por WhatsApp de citas cuenta 2'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
select core.registrar_supresion('telefono', '2222222222222222222222222222222222222222222222222222222222222222', 'baja', 'whatsapp.citas', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select coalesce(sum(total), 0)::int as total_deberia_ser_2 from core.list_supresiones_for_superadmin('00000000-0000-0000-0000-0000000f6c00') where motivo = 'baja' and origen = 'whatsapp.citas';
rollback;

\echo '11c. el listado NO expone hashes ni valores (ninguna columna de salida los contiene)'
begin;
select count(*)::int as columnas_deberia_ser_0 from pg_proc p, unnest(p.proargnames) n where p.proname = 'list_supresiones_for_superadmin' and p.pronamespace = 'core'::regnamespace and n ~ '(hash|valor)';
rollback;

\echo '12. un staff comun NO puede listar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6a01', true);
select * from core.list_supresiones_for_superadmin('00000000-0000-0000-0000-0000000f6a01') as should_fail;
rollback;

\echo '12b. caller-binding: un superadmin NO puede listar con el id de otro superadmin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select * from core.list_supresiones_for_superadmin('00000000-0000-0000-0000-0000000f6c01') as should_fail;
rollback;

\echo '12c. el superadmin restringido a finanzas SI puede listar (funcion de solo lectura: conteos, sin valores)'
begin;
set local role authenticated;
select core.registrar_supresion('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120', 'baja', 'whatsapp.citas', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c02', true);
select count(*)::int as grupos_deberia_ser_1 from core.list_supresiones_for_superadmin('00000000-0000-0000-0000-0000000f6c02');
rollback;

\echo '12d. sin sesion de usuario (sistema) tampoco se lista'
begin;
set local role authenticated;
select * from core.list_supresiones_for_superadmin('00000000-0000-0000-0000-0000000f6c00') as should_fail;
rollback;

\echo '13. el superadmin agrega "no contactar": true la primera vez, false la segunda (idempotente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c00', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120')::int as primera_deberia_ser_1;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c00', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120');
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c00', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120')::int as segunda_deberia_ser_0;
rollback;

\echo '13b. la fila queda con motivo no_contactar, origen superadmin y el actor'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c00', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120');
reset role;
select count(*)::int as filas_deberia_ser_1 from core.supresion_contacto where motivo = 'no_contactar' and origen = 'superadmin' and creado_por = '00000000-0000-0000-0000-0000000f6c00';
rollback;

\echo '13c. lo agregado por el superadmin suprime para el despachador (sesion de sistema)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c00', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120');
select set_config('request.jwt.claim.sub', '', true);
select core.esta_suprimido('telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120')::int as suprimido_deberia_ser_1;
rollback;

\echo '14. un staff comun NO puede agregar no contactar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6a01', true);
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6a01', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120') as should_fail;
rollback;

\echo '14b. caller-binding en agregar: id de otro superadmin se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c01', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120') as should_fail;
rollback;

\echo '14c. el superadmin de finanzas NO puede agregar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c02', true);
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c02', 'telefono', 'a896f05198562634b8aaab833a835eeaf440ba8c1bb3009cb6da337746ef4120') as should_fail;
rollback;

\echo '14d. agregar con un valor en claro se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6c00', true);
select core.agregar_no_contactar_for_superadmin('00000000-0000-0000-0000-0000000f6c00', 'telefono', '+525512345678') as should_fail;
rollback;
