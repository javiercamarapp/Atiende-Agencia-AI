-- 100: lectura del perfil operativo previo de un `staff` (para guardar `antes` en la bitacora al cambiarlo, migracion 090).
-- `authenticated` solo ve SU PROPIA fila de core.membership (RLS), asi que un admin no puede leer el perfil de otra persona sin una funcion definer.
--  * restaurantes.staff_perfil_operativo_leer: definer, search_path fijo, revoke de public/anon, grant a authenticated. Mismo umbral que
--    `staff_perfil_operativo_guardar`: owner/admin con alcance de toda la organizacion (sesion de sistema => 42501). Devuelve el perfil
--    ('encargado' | 'cajero') o null (sin marcar); P0404 si el objetivo no es staff de la organizacion. No devuelve ningun otro dato.
-- Compatibilidad: base sin esta migracion (42883) => el TypeScript guarda sin `antes` y lo deja registrado en el log de la API.
-- REVERSA: drop function if exists restaurantes.staff_perfil_operativo_leer(uuid, uuid);
create or replace function restaurantes.staff_perfil_operativo_leer(p_organization_id uuid, p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare
  v_perfil text;
begin
  if auth.uid() is null then
    raise exception 'staff_perfil_operativo_leer no es para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid()
      and m.organization_id = p_organization_id
      and m.vertical_role in ('owner', 'admin')
      and m.property_ids is null
  ) then
    raise exception 'solo owner/admin de alcance organizacional leen el perfil operativo' using errcode = '42501';
  end if;
  select m.perfil_operativo into v_perfil
  from core.membership m
  where m.user_id = p_user_id and m.organization_id = p_organization_id and m.vertical_role = 'staff';
  if not found then
    raise exception 'el usuario no es staff de la organizacion' using errcode = 'P0404';
  end if;
  return v_perfil;
end;
$$;
revoke all on function restaurantes.staff_perfil_operativo_leer(uuid, uuid) from public, anon;
grant execute on function restaurantes.staff_perfil_operativo_leer(uuid, uuid) to authenticated;
