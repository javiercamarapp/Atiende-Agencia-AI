-- Ola 2 (seguridad), arreglo F.1 -- toda función SECURITY DEFINER de los schemas del repo
-- lleva `revoke ... from public` explícito (regla de CLAUDE.md, "Base de datos y
-- migraciones"). Antes de este arreglo 33 funciones (helpers de autorización de hoteles,
-- licitaciones y rentas, core.has_property_access, hoteles.apply_cfdi_webhook_status y
-- funciones de trigger con hash encadenado o guardas) conservaban el EXECUTE por omisión de
-- PUBLIC, así que cualquier rol del clúster -- incluido `anon` -- podía invocarlas.
--
-- Migraciones que lo cierran (una por paquete, más la separación previa de policies de restaurantes):
--   packages/domain-restaurantes/migrations/202_restaurantes_catalogo_publico_policy_por_rol.sql
--   packages/db/migrations/0091_security_definer_revoke_public.sql
--   packages/domain-hoteles/migrations/051_hoteles_security_definer_revoke_public.sql
--   packages/domain-licitaciones/migrations/042_licitaciones_security_definer_revoke_public.sql
--   packages/domain-rentas/migrations/038_rentas_security_definer_revoke_public.sql
--
-- Qué se comprueba:
--   1-2. catálogo: ninguna función SECURITY DEFINER fuera de pg_catalog queda ejecutable por
--        PUBLIC ni por `anon` (cubre también funciones futuras: si alguien agrega una sin
--        revoke, este gate se pone rojo).
--   3-7. negativo `anon`: los helpers y la función del webhook de CFDI fallan con
--        "permission denied" (antes devolvían un booleano o corrían).
--   8-12. positivo/cross-tenant `authenticated`: los helpers siguen ejecutables por la app
--        (que siempre corre como `authenticated`, ver ManagedPostgresEngine.withAppSession);
--        el usuario de otra organización obtiene `false`; la RLS de core.property (que llama a
--        core.has_property_access) sigue filtrando bien; la sesión de sistema (sin auth.uid())
--        no ve dinero.
--   13. funciones de trigger: Postgres solo exige EXECUTE al crear el trigger, no al dispararlo;
--        el registro de asistencia (trigger attendance_log_set_hash + WITH CHECK con
--        core.has_property_access) sigue grabando el hash bajo `authenticated`.
--   15-16. la lectura pública heredada de restaurantes.branch_detail/branch_products (014_catalogo_publico_scoped,
--       contrato que también cubre verify-zona-horaria-por-negocio) sigue funcionando para `anon`: su policy de
--       anon ya no llama a core.has_property_access (202_restaurantes_catalogo_publico_policy_por_rol).
--   14. la función del webhook de CFDI sigue ejecutable por la sesión de sistema (authenticated
--       sin auth.uid()), que es quien la llama.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = debe
-- terminar en ERROR; alias `..._deberia_ser_N` = esa consulta devuelve N. Cada escenario va en su
-- propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000f501', 'hoteles', 'Hotel A (revoke definer)', 'hotel-a-revoke-definer'),
  ('00000000-0000-0000-0000-00000000f502', 'hoteles', 'Hotel B (revoke definer, ajeno)', 'hotel-b-revoke-definer')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000f511', '00000000-0000-0000-0000-00000000f501', 'hoteles', 'Hotel A Centro'),
  ('00000000-0000-0000-0000-00000000f512', '00000000-0000-0000-0000-00000000f502', 'hoteles', 'Hotel B Playa')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000f521', 'owner-a-revoke@example.com', 'Owner hotel A', 'seed'),
  ('00000000-0000-0000-0000-00000000f522', 'owner-b-revoke@example.com', 'Owner hotel B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000f521', '00000000-0000-0000-0000-00000000f501', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000f522', '00000000-0000-0000-0000-00000000f502', null, 'owner', 'owner')
on conflict do nothing;

\echo '1. ninguna función SECURITY DEFINER queda ejecutable por PUBLIC'
begin;
select count(*) as definer_con_execute_public_deberia_ser_0
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
  and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
rollback;

\echo '2. ninguna función SECURITY DEFINER queda ejecutable por anon (directo o vía PUBLIC)'
begin;
select count(*) as definer_ejecutable_por_anon_deberia_ser_0
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
  and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo '3. anon no ejecuta hoteles.can_access_money'
begin;
set local role anon;
select hoteles.can_access_money('00000000-0000-0000-0000-00000000f511') as should_fail;
rollback;

\echo '4. anon no ejecuta core.has_property_access'
begin;
set local role anon;
select core.has_property_access('00000000-0000-0000-0000-00000000f521', '00000000-0000-0000-0000-00000000f511') as should_fail;
rollback;

\echo '5. anon no ejecuta licitaciones.can_access_org'
begin;
set local role anon;
select licitaciones.can_access_org('00000000-0000-0000-0000-00000000f501') as should_fail;
rollback;

\echo '6. anon no ejecuta rentas.can_read_finanzas'
begin;
set local role anon;
select rentas.can_read_finanzas('00000000-0000-0000-0000-00000000f511') as should_fail;
rollback;

\echo '7. anon no ejecuta hoteles.apply_cfdi_webhook_status'
begin;
set local role anon;
select count(*) as should_fail from hoteles.apply_cfdi_webhook_status('00000000-0000-0000-0000-00000000f599', 'timbrado');
rollback;

\echo '8. authenticated (owner de A) sigue ejecutando hoteles.can_access_money sobre su propiedad'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f521', true);
select hoteles.can_access_money('00000000-0000-0000-0000-00000000f511')::int as dinero_propio_deberia_ser_1;
rollback;

\echo '9. cross-tenant: el owner de B obtiene false sobre la propiedad de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f522', true);
select hoteles.can_access_money('00000000-0000-0000-0000-00000000f511')::int as dinero_ajeno_deberia_ser_0;
rollback;

\echo '10. authenticated sigue ejecutando licitaciones.can_access_org y rentas.can_read_finanzas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f521', true);
select (licitaciones.can_access_org('00000000-0000-0000-0000-00000000f501')::int
        + rentas.can_read_finanzas('00000000-0000-0000-0000-00000000f511')::int) as helpers_deberia_ser_1;
rollback;

\echo '11. la RLS de core.property (core.has_property_access) sigue filtrando por organización'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f521', true);
select count(*) as propiedades_visibles_deberia_ser_1
from core.property
where id in ('00000000-0000-0000-0000-00000000f511', '00000000-0000-0000-0000-00000000f512');
rollback;

\echo '12. sesión de sistema (authenticated sin auth.uid()) no ve dinero, sin error'
begin;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select hoteles.can_access_money('00000000-0000-0000-0000-00000000f511')::int as sistema_dinero_deberia_ser_0;
rollback;

\echo '13. el trigger SECURITY DEFINER de asistencia sigue disparando bajo authenticated'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000f521', true);
insert into hoteles.attendance_log (organization_id, property_id, staff_user_id, event_type, source)
values ('00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f511', '00000000-0000-0000-0000-00000000f521', 'entrada', 'verify');
select count(*) as asistencia_con_hash_deberia_ser_1
from hoteles.attendance_log
where staff_user_id = '00000000-0000-0000-0000-00000000f521' and hash is not null and seq is not null;
rollback;

\echo '14. la sesión de sistema (authenticated sin auth.uid()) sigue ejecutando hoteles.apply_cfdi_webhook_status'
begin;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select count(*) as cfdi_webhook_sistema_deberia_ser_0
from hoteles.apply_cfdi_webhook_status('00000000-0000-0000-0000-00000000f599', 'timbrado');
rollback;

\echo '15. anon sigue leyendo restaurantes.branch_detail (lectura pública heredada) sin evaluar core.has_property_access'
begin;
set local role anon;
select count(*) as anon_lee_detalle_de_sucursal from restaurantes.branch_detail;
rollback;

\echo '16. anon sigue leyendo restaurantes.branch_products sin evaluar core.has_property_access'
begin;
set local role anon;
select count(*) as anon_lee_precios_de_sucursal from restaurantes.branch_products;
rollback;
