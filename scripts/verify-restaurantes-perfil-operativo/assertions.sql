-- Perfil operativo (090) y lectura del perfil previo (100) contra Postgres real. Cada chequeo imprime PASS/FAIL; el script falla si alguno falla.
\set ON_ERROR_STOP on
\pset pager off
insert into core.organization (id, vertical, name, slug) values ('00000000-0000-0000-0000-0000000a0001', 'restaurantes', 'Perfil Org', 'perfil-org') on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000a00c1', '00000000-0000-0000-0000-0000000a0001', 'restaurantes', 'Suc 1', 'active'),
  ('00000000-0000-0000-0000-0000000a00c2', '00000000-0000-0000-0000-0000000a0001', 'restaurantes', 'Suc 2', 'active') on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0011', 'o@x.example.com', 'Owner', 'seed'),
  ('00000000-0000-0000-0000-0000000a0012', 'ac@x.example.com', 'Admin acotado', 'seed'),
  ('00000000-0000-0000-0000-0000000a0013', 's@x.example.com', 'Staff', 'seed'),
  ('00000000-0000-0000-0000-0000000a0014', 'r@x.example.com', 'Repartidor', 'seed') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0011', '00000000-0000-0000-0000-0000000a0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0012', '00000000-0000-0000-0000-0000000a0001', array['00000000-0000-0000-0000-0000000a00c1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000a0013', '00000000-0000-0000-0000-0000000a0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000a0014', '00000000-0000-0000-0000-0000000a0001', null, 'member', 'repartidor') on conflict do nothing;

create or replace function public.vpo_chk(nombre text, ok boolean) returns void language plpgsql as $$
begin
  if ok then raise notice 'PASS %', nombre; else raise exception 'FAIL %', nombre; end if;
end $$;

-- Intenta una sentencia y devuelve el SQLSTATE ('ok' si no fallo).
create or replace function public.vpo_estado(sentencia text) returns text language plpgsql as $$
begin execute sentencia; return 'ok'; exception when others then return sqlstate; end $$;
grant execute on function public.vpo_chk(text, boolean), public.vpo_estado(text) to public;
grant usage on schema public to public;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0011', true);
select public.vpo_chk('owner lee perfil nulo del staff', restaurantes.staff_perfil_operativo_leer('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0013') is null);
select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0013', 'cajero');
select public.vpo_chk('owner lee el perfil guardado', restaurantes.staff_perfil_operativo_leer('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0013') = 'cajero');
select public.vpo_chk('objetivo no staff -> P0404', public.vpo_estado($q$select restaurantes.staff_perfil_operativo_leer('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0014')$q$) = 'P0404');
select public.vpo_chk('operador_puede: owner despacha', restaurantes.operador_puede('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a00c1', 'despachar'));
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0012', true);
select public.vpo_chk('admin ACOTADO no lee perfiles (42501)', public.vpo_estado($q$select restaurantes.staff_perfil_operativo_leer('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0013')$q$) = '42501');
select public.vpo_chk('admin ACOTADO no guarda perfiles (42501)', public.vpo_estado($q$select restaurantes.staff_perfil_operativo_guardar('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0013', 'encargado')$q$) = '42501');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0013', true);
select public.vpo_chk('staff no lee perfiles (42501)', public.vpo_estado($q$select restaurantes.staff_perfil_operativo_leer('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0013')$q$) = '42501');
select public.vpo_chk('cajero marcado: captura si', restaurantes.operador_puede('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a00c1', 'capturar'));
select public.vpo_chk('cajero marcado: NO despacha', not restaurantes.operador_puede('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a00c1', 'despachar'));
select public.vpo_chk('cajero marcado: NO cancela', not restaurantes.operador_puede('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a00c1', 'cancelar'));
commit;

begin;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select public.vpo_chk('sesion de sistema no lee perfiles (42501)', public.vpo_estado($q$select restaurantes.staff_perfil_operativo_leer('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0013')$q$) = '42501');
commit;
drop function public.vpo_chk(text, boolean);
drop function public.vpo_estado(text);
