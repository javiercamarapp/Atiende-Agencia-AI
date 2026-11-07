-- Fixtures + assertions contra Postgres REAL para las migraciones de la paridad menor F4c:
--   180_producto_archivado.sql          (products.archived_at: soft-delete de un producto con historial)
--   181_voz_idiomas_sucursal.sql        (idiomas del agente de voz por sucursal)
--   182_conocimiento_archivos.sql       (registro de PDF/imagenes cargados a la base de conocimiento)
--   183_agente_whatsapp_personalizacion.sql (tono y mensaje adicional del dueno)
--
--   A. 180: valor por omision; archivar y borrar solo owner/admin de SU organizacion; historial por items @> [{id}]; cascada a branch_products; base sin migrar.
--   B. 181: omision; INSERT/UPDATE solo owner/admin y sucursal propia; CHECK de formato/maximo/principal repetido; lectura del sistema; anon fuera.
--   C. 182: INSERT/SELECT/DELETE solo owner/admin; sin UPDATE; CHECK de MIME/tamano/huella; UNIQUE por huella.
--   D. 183: INSERT/UPDATE solo owner/admin; CHECK de tono/largo/controles; updated_by no se falsifica; lectura del sistema.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail` marca el que debe terminar en ERROR;
-- `..._deberia_ser_N` el valor esperado (UN solo count(*) entero).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f4a01', 'restaurantes', 'Paridad Org A', 'paridad-org-a'),
  ('00000000-0000-0000-0000-0000000f4a02', 'restaurantes', 'Paridad Org B', 'paridad-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000f4b02', '00000000-0000-0000-0000-0000000f4a02', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f4e01', 'paridad-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f4e02', 'paridad-staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000f4e03', 'paridad-owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f4e01', '00000000-0000-0000-0000-0000000f4a01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f4e02', '00000000-0000-0000-0000-0000000f4a01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f4e03', '00000000-0000-0000-0000-0000000f4a02', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.products (id, organization_id, name, price) values
  ('00000000-0000-0000-0000-0000000f4c01', '00000000-0000-0000-0000-0000000f4a01', 'Producto con historial', 50),
  ('00000000-0000-0000-0000-0000000f4c02', '00000000-0000-0000-0000-0000000f4a01', 'Producto sin historial', 60)
on conflict do nothing;

insert into restaurantes.branch_products (property_id, product_id, price) values
  ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4c02', 60)
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, items) values
  ('00000000-0000-0000-0000-0000000f4d01', '00000000-0000-0000-0000-0000000f4a01', '00000000-0000-0000-0000-0000000f4b01', 'Cliente', '9990000000', 50,
   '[{"id":"00000000-0000-0000-0000-0000000f4c01","name":"Producto con historial","price":50,"quantity":1}]')
on conflict do nothing;

\echo ''
\echo '=== A) 180: producto archivado ==='
\echo ''

\echo '--- 1. los productos nacen sin archivar (comportamiento anterior intacto) ---'
begin;
select count(*) as sin_archivar_deberia_ser_2 from restaurantes.products
  where organization_id = '00000000-0000-0000-0000-0000000f4a01' and archived_at is null;
rollback;

\echo '--- 2. owner de la Org A archiva su producto ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
with u as (
  update restaurantes.products set archived_at = now(), is_available = false
   where organization_id = '00000000-0000-0000-0000-0000000f4a01' and id = '00000000-0000-0000-0000-0000000f4c01' returning 1
)
select count(*) as archivar_owner_deberia_ser_1 from u;
rollback;

\echo '--- 3. owner de la Org B NO puede archivar el producto de la Org A (cross-tenant): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
with u as (
  update restaurantes.products set archived_at = now()
   where organization_id = '00000000-0000-0000-0000-0000000f4a01' and id = '00000000-0000-0000-0000-0000000f4c01' returning 1
)
select count(*) as archivar_otra_org_deberia_ser_0 from u;
rollback;

\echo '--- 4. anon no puede archivar: RECHAZADO ---'
begin;
set local role anon;
update restaurantes.products set archived_at = now() where id = '00000000-0000-0000-0000-0000000f4c01' returning 1 as should_fail;
rollback;

\echo '--- 5. el historial se encuentra por items @> [{id}]: el producto con pedidos tiene 1; el otro, 0 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
select count(*) as pedidos_con_historial_deberia_ser_1 from restaurantes.orders
  where organization_id = '00000000-0000-0000-0000-0000000f4a01' and jsonb_typeof(items) = 'array'
    and items @> '[{"id":"00000000-0000-0000-0000-0000000f4c01"}]'::jsonb;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
select count(*) as pedidos_sin_historial_deberia_ser_0 from restaurantes.orders
  where organization_id = '00000000-0000-0000-0000-0000000f4a01' and jsonb_typeof(items) = 'array'
    and items @> '[{"id":"00000000-0000-0000-0000-0000000f4c02"}]'::jsonb;
rollback;

\echo '--- 6. owner de la Org A borra de verdad el producto SIN historial ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
with d as (
  delete from restaurantes.products where organization_id = '00000000-0000-0000-0000-0000000f4a01' and id = '00000000-0000-0000-0000-0000000f4c02' returning 1
)
select count(*) as borrar_owner_deberia_ser_1 from d;
rollback;

\echo '--- 7. owner de la Org B NO puede borrar el producto de la Org A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
with d as (
  delete from restaurantes.products where organization_id = '00000000-0000-0000-0000-0000000f4a01' and id = '00000000-0000-0000-0000-0000000f4c02' returning 1
)
select count(*) as borrar_otra_org_deberia_ser_0 from d;
rollback;

\echo '--- 8. borrar el producto arrastra su fila por sucursal (cascada) ---'
begin;
delete from restaurantes.products where id = '00000000-0000-0000-0000-0000000f4c02';
select count(*) as branch_products_restantes_deberia_ser_0 from restaurantes.branch_products where product_id = '00000000-0000-0000-0000-0000000f4c02';
rollback;

\echo '--- 9. base SIN la 180: 42703 se recupera con SAVEPOINT (como runWithSavepointFallback) y la transaccion sigue usable ---'
begin;
-- Una base sin la 180 tampoco tiene la 184: su trigger depende de la columna y se quita primero.
drop trigger products_archivar_limpia_promos on restaurantes.products;
alter table restaurantes.products drop column archived_at;
savepoint sp_verify_archivado;
do $$
declare
  v_state text;
begin
  begin
    perform archived_at from restaurantes.products;
    raise exception 'se esperaba SQLSTATE 42703 y la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_archivado;
release savepoint sp_verify_archivado;
select count(*) as productos_tras_el_savepoint_deberia_ser_2 from restaurantes.products where organization_id = '00000000-0000-0000-0000-0000000f4a01';
rollback;

\echo ''
\echo '=== B) 181: idiomas de voz por sucursal ==='
\echo ''

\echo '--- 10. una fila minima nace con es-MX, sin adicionales y sin deteccion ---'
begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01');
select count(*) as omision_deberia_ser_1 from restaurantes.branch_voice_languages
  where property_id = '00000000-0000-0000-0000-0000000f4b01' and idioma_principal = 'es-MX' and cardinality(idiomas_adicionales) = 0 and deteccion_automatica = false;
rollback;

\echo '--- 11. owner de la Org A crea los idiomas de SU sucursal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
with i as (
  insert into restaurantes.branch_voice_languages (property_id, organization_id, idioma_principal, idiomas_adicionales, deteccion_automatica, updated_by)
  values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', 'es-MX', '{en-US,fr-FR}', true, '00000000-0000-0000-0000-0000000f4e01') returning 1
)
select count(*) as insert_owner_deberia_ser_1 from i;
rollback;

\echo '--- 12. owner de la Org B NO puede crear idiomas para la sucursal de la Org A (cross-tenant): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
insert into restaurantes.branch_voice_languages (property_id, organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', '00000000-0000-0000-0000-0000000f4e03') returning 1 as should_fail;
rollback;

\echo '--- 13. owner de la Org B NO puede colgar una sucursal de la Org A bajo SU organizacion: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
insert into restaurantes.branch_voice_languages (property_id, organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a02', '00000000-0000-0000-0000-0000000f4e03') returning 1 as should_fail;
rollback;

\echo '--- 14. staff (no owner/admin) NO puede crear: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e02', true);
insert into restaurantes.branch_voice_languages (property_id, organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', '00000000-0000-0000-0000-0000000f4e02') returning 1 as should_fail;
rollback;

\echo '--- 15. updated_by falsificado (a nombre de otro usuario): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
insert into restaurantes.branch_voice_languages (property_id, organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', '00000000-0000-0000-0000-0000000f4e03') returning 1 as should_fail;
rollback;

\echo '--- 16. UPDATE: owner de la Org A si; staff y owner de la Org B no (0 filas) ---'
begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
with u as (
  update restaurantes.branch_voice_languages set idioma_principal = 'en-US', updated_by = '00000000-0000-0000-0000-0000000f4e01' where property_id = '00000000-0000-0000-0000-0000000f4b01' returning 1
)
select count(*) as update_owner_deberia_ser_1 from u;
rollback;

begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e02', true);
with u as (
  update restaurantes.branch_voice_languages set idioma_principal = 'en-US', updated_by = '00000000-0000-0000-0000-0000000f4e02' where property_id = '00000000-0000-0000-0000-0000000f4b01' returning 1
)
select count(*) as update_staff_deberia_ser_0 from u;
rollback;

begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
with u as (
  update restaurantes.branch_voice_languages set idioma_principal = 'en-US', updated_by = '00000000-0000-0000-0000-0000000f4e03' where property_id = '00000000-0000-0000-0000-0000000f4b01' returning 1
)
select count(*) as update_otra_org_deberia_ser_0 from u;
rollback;

\echo '--- 17. CHECK: formato del codigo, mas de 4 adicionales y principal repetido mueren en la base ---'
begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id, idioma_principal) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', 'ES') returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id, idiomas_adicionales) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', '{en-US,fr-FR,de-DE,it-IT,pt-BR}') returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id, idiomas_adicionales) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', '{es-MX}') returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id, idiomas_adicionales) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01', '{en_US}') returning 1 as should_fail;
rollback;

\echo '--- 18. lectura: la sesion de SISTEMA (servicio de llamadas) lee; anon no ---'
begin;
insert into restaurantes.branch_voice_languages (property_id, organization_id) values ('00000000-0000-0000-0000-0000000f4b01', '00000000-0000-0000-0000-0000000f4a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as lectura_sistema_deberia_ser_1 from restaurantes.branch_voice_languages where property_id = '00000000-0000-0000-0000-0000000f4b01';
rollback;

begin;
set local role anon;
select idioma_principal as should_fail from restaurantes.branch_voice_languages;
rollback;

\echo ''
\echo '=== C) 182: archivos de conocimiento ==='
\echo ''

\echo '--- 19. owner de la Org A registra un archivo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
with i as (
  insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256, subido_por)
  values ('00000000-0000-0000-0000-0000000f4a01', 'politicas.pdf', 'application/pdf', 1000, repeat('a', 64), '00000000-0000-0000-0000-0000000f4e01') returning 1
)
select count(*) as insert_owner_deberia_ser_1 from i;
rollback;

\echo '--- 20. staff y owner de otra organizacion NO pueden registrar archivos: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e02', true);
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256, subido_por)
values ('00000000-0000-0000-0000-0000000f4a01', 'x.pdf', 'application/pdf', 1000, repeat('b', 64), '00000000-0000-0000-0000-0000000f4e02') returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256, subido_por)
values ('00000000-0000-0000-0000-0000000f4a01', 'x.pdf', 'application/pdf', 1000, repeat('c', 64), '00000000-0000-0000-0000-0000000f4e03') returning 1 as should_fail;
rollback;

\echo '--- 21. subido_por falsificado: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256, subido_por)
values ('00000000-0000-0000-0000-0000000f4a01', 'x.pdf', 'application/pdf', 1000, repeat('d', 64), '00000000-0000-0000-0000-0000000f4e03') returning 1 as should_fail;
rollback;

\echo '--- 22. UNIQUE (organizacion, huella): el mismo archivo dos veces: RECHAZADO ---'
begin;
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 10, repeat('e', 64));
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4a01', 'b.pdf', 'application/pdf', 10, repeat('e', 64)) returning 1 as should_fail;
rollback;

\echo '--- 23. CHECK: MIME fuera de la lista, tamano 0, tamano > 5 MiB y huella mal formada mueren en la base ---'
begin;
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4a01', 'a.exe', 'application/x-msdownload', 10, repeat('f', 64)) returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 0, repeat('1', 64)) returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 5242881, repeat('2', 64)) returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 10, 'no-es-sha') returning 1 as should_fail;
rollback;

\echo '--- 24. lectura y borrado: owner de la Org A si; staff y owner de la Org B no; anon fuera ---'
begin;
insert into restaurantes.conocimiento_archivos (id, organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4f01', '00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 10, repeat('3', 64));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
select count(*) as lectura_owner_deberia_ser_1 from restaurantes.conocimiento_archivos where organization_id = '00000000-0000-0000-0000-0000000f4a01';
rollback;

begin;
insert into restaurantes.conocimiento_archivos (id, organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4f01', '00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 10, repeat('3', 64));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e02', true);
select count(*) as lectura_staff_deberia_ser_0 from restaurantes.conocimiento_archivos where organization_id = '00000000-0000-0000-0000-0000000f4a01';
rollback;

begin;
insert into restaurantes.conocimiento_archivos (id, organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4f01', '00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 10, repeat('3', 64));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
select count(*) as lectura_otra_org_deberia_ser_0 from restaurantes.conocimiento_archivos where organization_id = '00000000-0000-0000-0000-0000000f4a01';
rollback;

begin;
insert into restaurantes.conocimiento_archivos (id, organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4f01', '00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 10, repeat('3', 64));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
with d as (delete from restaurantes.conocimiento_archivos where id = '00000000-0000-0000-0000-0000000f4f01' returning 1)
select count(*) as borrar_owner_deberia_ser_1 from d;
rollback;

begin;
insert into restaurantes.conocimiento_archivos (id, organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4f01', '00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 10, repeat('3', 64));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
with d as (delete from restaurantes.conocimiento_archivos where id = '00000000-0000-0000-0000-0000000f4f01' returning 1)
select count(*) as borrar_otra_org_deberia_ser_0 from d;
rollback;

begin;
set local role anon;
select nombre as should_fail from restaurantes.conocimiento_archivos;
rollback;

\echo '--- 25. sin UPDATE para authenticated (el registro es inmutable): RECHAZADO ---'
begin;
insert into restaurantes.conocimiento_archivos (id, organization_id, nombre, mime, tamano_bytes, sha256) values ('00000000-0000-0000-0000-0000000f4f01', '00000000-0000-0000-0000-0000000f4a01', 'a.pdf', 'application/pdf', 10, repeat('3', 64));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
update restaurantes.conocimiento_archivos set nombre = 'otro.pdf' where id = '00000000-0000-0000-0000-0000000f4f01' returning 1 as should_fail;
rollback;

\echo ''
\echo '=== D) 183: personalizacion del agente de WhatsApp ==='
\echo ''

\echo '--- 26. owner de la Org A guarda tono y mensaje (con salto de linea permitido) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
with i as (
  insert into restaurantes.agente_whatsapp_personalizacion (organization_id, tono, mensaje_dueno, updated_by)
  values ('00000000-0000-0000-0000-0000000f4a01', 'calido_cercano', E'Bienvenido\nSomos de casa', '00000000-0000-0000-0000-0000000f4e01') returning 1
)
select count(*) as insert_owner_deberia_ser_1 from i;
rollback;

\echo '--- 27. staff y owner de otra organizacion NO pueden guardar: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e02', true);
insert into restaurantes.agente_whatsapp_personalizacion (organization_id, tono, updated_by) values ('00000000-0000-0000-0000-0000000f4a01', 'formal_directo', '00000000-0000-0000-0000-0000000f4e02') returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
insert into restaurantes.agente_whatsapp_personalizacion (organization_id, tono, updated_by) values ('00000000-0000-0000-0000-0000000f4a01', 'formal_directo', '00000000-0000-0000-0000-0000000f4e03') returning 1 as should_fail;
rollback;

\echo '--- 28. updated_by falsificado: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
insert into restaurantes.agente_whatsapp_personalizacion (organization_id, tono, updated_by) values ('00000000-0000-0000-0000-0000000f4a01', 'formal_directo', '00000000-0000-0000-0000-0000000f4e03') returning 1 as should_fail;
rollback;

\echo '--- 29. CHECK: tono fuera de la lista, mensaje de 601 caracteres y caracteres de control mueren en la base ---'
begin;
insert into restaurantes.agente_whatsapp_personalizacion (organization_id, tono) values ('00000000-0000-0000-0000-0000000f4a01', 'grosero') returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.agente_whatsapp_personalizacion (organization_id, mensaje_dueno) values ('00000000-0000-0000-0000-0000000f4a01', repeat('a', 601)) returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.agente_whatsapp_personalizacion (organization_id, mensaje_dueno) values ('00000000-0000-0000-0000-0000000f4a01', E'hola\x01mundo') returning 1 as should_fail;
rollback;

begin;
insert into restaurantes.agente_whatsapp_personalizacion (organization_id, mensaje_dueno) values ('00000000-0000-0000-0000-0000000f4a01', repeat('a', 600)) returning 1 as largo_600_ok;
rollback;

\echo '--- 30. UPDATE: owner de la Org A si; staff y owner de la Org B no (0 filas) ---'
begin;
insert into restaurantes.agente_whatsapp_personalizacion (organization_id) values ('00000000-0000-0000-0000-0000000f4a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
with u as (update restaurantes.agente_whatsapp_personalizacion set tono = 'divertido_desenfadado', updated_by = '00000000-0000-0000-0000-0000000f4e01' where organization_id = '00000000-0000-0000-0000-0000000f4a01' returning 1)
select count(*) as update_owner_deberia_ser_1 from u;
rollback;

begin;
insert into restaurantes.agente_whatsapp_personalizacion (organization_id) values ('00000000-0000-0000-0000-0000000f4a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e02', true);
with u as (update restaurantes.agente_whatsapp_personalizacion set tono = 'divertido_desenfadado', updated_by = '00000000-0000-0000-0000-0000000f4e02' where organization_id = '00000000-0000-0000-0000-0000000f4a01' returning 1)
select count(*) as update_staff_deberia_ser_0 from u;
rollback;

begin;
insert into restaurantes.agente_whatsapp_personalizacion (organization_id) values ('00000000-0000-0000-0000-0000000f4a01');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e03', true);
with u as (update restaurantes.agente_whatsapp_personalizacion set tono = 'divertido_desenfadado', updated_by = '00000000-0000-0000-0000-0000000f4e03' where organization_id = '00000000-0000-0000-0000-0000000f4a01' returning 1)
select count(*) as update_otra_org_deberia_ser_0 from u;
rollback;

\echo '--- 31. lectura: la sesion de SISTEMA (webhook de WhatsApp) lee; anon no ---'
begin;
insert into restaurantes.agente_whatsapp_personalizacion (organization_id, tono) values ('00000000-0000-0000-0000-0000000f4a01', 'calido_cercano');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as lectura_sistema_deberia_ser_1 from restaurantes.agente_whatsapp_personalizacion where organization_id = '00000000-0000-0000-0000-0000000f4a01';
rollback;

begin;
set local role anon;
select tono as should_fail from restaurantes.agente_whatsapp_personalizacion;
rollback;

\echo ''
\echo '=== E) 184: el historial protege el borrado y las promociones no quedan con ids huerfanos ==='
\echo ''

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f4e04', 'paridad-admin-acotado-a@example.com', 'Admin acotado A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f4e04', '00000000-0000-0000-0000-0000000f4a01', array['00000000-0000-0000-0000-0000000f4b01']::uuid[], 'admin', 'admin')
on conflict do nothing;

\echo '--- 32. DELETE de un producto CON pedidos: RECHAZADO por la base (owner) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e01', true);
delete from restaurantes.products where id = '00000000-0000-0000-0000-0000000f4c01' returning 1 as should_fail;
rollback;

\echo '--- 33. tampoco con SQL directo de superusuario/servicio (el trigger aplica a todos): RECHAZADO ---'
begin;
delete from restaurantes.products where id = '00000000-0000-0000-0000-0000000f4c01' returning 1 as should_fail;
rollback;

\echo '--- 34. un admin ACOTADO a una sucursal NO puede borrar productos de la organizacion: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4e04', true);
with d as (delete from restaurantes.products where id = '00000000-0000-0000-0000-0000000f4c02' returning 1)
select count(*) as borrar_admin_acotado_deberia_ser_0 from d;
rollback;

\echo '--- 35. archivar quita el id de promotions.product_ids y deja los demas ---'
begin;
insert into restaurantes.promotions (organization_id, code, name, type, value, product_ids)
  values ('00000000-0000-0000-0000-0000000f4a01', 'DOSPROD', 'Dos productos', 'percentage', 10, array['00000000-0000-0000-0000-0000000f4c01', '00000000-0000-0000-0000-0000000f4c02']::uuid[]);
update restaurantes.products set archived_at = now() where id = '00000000-0000-0000-0000-0000000f4c01';
select count(*) as promo_sin_id_archivado_deberia_ser_1 from restaurantes.promotions
  where code = 'DOSPROD' and product_ids = array['00000000-0000-0000-0000-0000000f4c02']::uuid[];
rollback;

\echo '--- 36. si el arreglo se quedaria vacio, pasa a null (CHECK de 027) ---'
begin;
insert into restaurantes.promotions (organization_id, code, name, type, value, product_ids)
  values ('00000000-0000-0000-0000-0000000f4a01', 'SOLOUNO', 'Un producto', 'percentage', 10, array['00000000-0000-0000-0000-0000000f4c01']::uuid[]);
update restaurantes.products set archived_at = now() where id = '00000000-0000-0000-0000-0000000f4c01';
select count(*) as promo_arreglo_nulo_deberia_ser_1 from restaurantes.promotions where code = 'SOLOUNO' and product_ids is null;
rollback;

\echo '--- 37. una promocion de CORTESIA que quedaria sin producto se DESACTIVA (no viola el CHECK) ---'
begin;
insert into restaurantes.promotions (organization_id, code, name, type, value, product_ids, courtesy_product_ids, courtesy_quantity)
  values ('00000000-0000-0000-0000-0000000f4a01', 'CORTESIA1', 'Cortesia', 'cortesia', 1, array['00000000-0000-0000-0000-0000000f4c01']::uuid[], array['00000000-0000-0000-0000-0000000f4c02']::uuid[], 1);
update restaurantes.products set archived_at = now() where id = '00000000-0000-0000-0000-0000000f4c01';
select count(*) as cortesia_desactivada_deberia_ser_1 from restaurantes.promotions where code = 'CORTESIA1' and is_active = false;
rollback;

\echo '--- 38. borrar un producto SIN historial tambien lo quita de las promociones ---'
begin;
insert into restaurantes.promotions (organization_id, code, name, type, value, product_ids)
  values ('00000000-0000-0000-0000-0000000f4a01', 'BORRADO1', 'Borrado', 'percentage', 10, array['00000000-0000-0000-0000-0000000f4c02', '00000000-0000-0000-0000-0000000f4c01']::uuid[]);
delete from restaurantes.products where id = '00000000-0000-0000-0000-0000000f4c02';
select count(*) as promo_tras_borrar_deberia_ser_1 from restaurantes.promotions where code = 'BORRADO1' and product_ids = array['00000000-0000-0000-0000-0000000f4c01']::uuid[];
rollback;
