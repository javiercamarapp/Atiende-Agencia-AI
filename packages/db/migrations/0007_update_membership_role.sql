-- Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
-- restaurantes permite gestionar roles desde el producto"): verificado contra el
-- código real antes de escribir esta migración -- ni siquiera restaurantes (el
-- único vertical que el hallazgo señalaba como ejemplo) tenía forma de cambiar el
-- `vertical_role`/`platform_role` de un staff YA ACEPTADO (`core.membership`).
-- `apps/api/src/routes/verticals/restaurantes/admin-staff.ts` (Fase 10, migración
-- 0002) solo fija el rol AL INVITAR -- una vez aceptada la invitación, el único
-- lugar que escribe `core.membership.vertical_role`/`platform_role` es
-- `core.accept_staff_invite` (un solo INSERT/ON CONFLICT en el momento de aceptar).
-- Las otras 3 verticales con alta de staff ya construida (despachos/citas/
-- licitaciones, mismo patrón que restaurantes) tienen exactamente el mismo hueco.
--
-- Dos funciones `security definer`, MISMO patrón exacto que
-- `core.list_org_members_by_vertical_role`/`core.accept_staff_invite`
-- (`0004_list_org_members_by_vertical_role.sql`/`0002_staff_invite_schema.sql`):
-- la policy "staff ve su propia membership" (`0001_core_schema.sql`) restringe
-- SELECT a `user_id = auth.uid()`, y `authenticated` no tiene NINGÚN GRANT de
-- UPDATE sobre `core.membership` -- sin estas funciones, no hay forma de que un
-- owner/admin autenticado real vea o edite la fila de un COMPAÑERO.
--
--   1. `core.list_org_members(organization_id)` -- generaliza
--      `list_org_members_by_vertical_role` sin el filtro de `vertical_role`: TODOS
--      los miembros ya aceptados de la organización (con su rol actual), para la
--      tabla nueva del panel ("Staff activo"). Mismo chequeo de "el caller también
--      es miembro de esa organización" que su análoga.
--   2. `core.update_membership_role(organization_id, target_user_id,
--      new_platform_role, new_vertical_role)` -- la escritura real. Reimplementa
--      DENTRO de la función (nunca solo en la capa TS) la MISMA jerarquía que ya
--      aplica `@atiende/core-authz::canInviteStaff` al INVITAR: el caller necesita
--      `platform_role` admin u owner, y su rango debe ser >= al rango tanto del rol
--      ACTUAL del target como del rol NUEVO que se le quiere asignar (un admin
--      nunca toca a un owner, ni puede ascender a nadie por encima de su propio
--      rango) -- la MISMA regla, duplicada a propósito porque aquí SÍ es la
--      autoridad real (RLS/SECURITY DEFINER), no una promesa de la capa TS. Bloquea
--      además el auto-cambio de rol (`target_user_id = auth.uid()`) -- ninguna ruta
--      HTTP de este monorepo necesita que alguien se re-asigne su propio rol, y
--      permitirlo abriría la puerta a que el único owner de una organización se
--      degrade a sí mismo por error (o un admin comprometido se autoascienda a
--      owner) sin ningún control cruzado. El rango de `platform_role` (owner=4 >
--      admin=3 > member=2 > viewer=1) es un `case` literal en SQL -- MISMO orden
--      que `PLATFORM_ROLE_HIERARCHY` de `packages/core-authz/src/roles.ts`,
--      duplicado aquí porque una función `security definer` no puede importar TS.
--      La validación de que `new_vertical_role` es un valor válido PARA ESE
--      vertical concreto (ej. "owner"/"admin"/"staff"/"repartidor" en
--      restaurantes) sigue viviendo SIEMPRE en la capa TS de cada
--      `admin-staff.ts` (mismo criterio que `isRestaurantesRole` ya aplica al
--      invitar) -- `core` es opaco al string de `vertical_role`, igual que en el
--      resto de este esquema.

create or replace function core.list_org_members(p_organization_id uuid)
returns table (
  user_id uuid,
  email text,
  full_name text,
  platform_role text,
  vertical_role text,
  property_ids uuid[]
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select su.id, su.email, su.full_name, m.platform_role, m.vertical_role, m.property_ids
  from core.membership m
  join core.staff_user su on su.id = m.user_id
  where m.organization_id = p_organization_id
    and exists (
      select 1 from core.membership caller
      where caller.organization_id = p_organization_id
        and caller.user_id = auth.uid()
    )
  order by su.full_name asc;
$$;

revoke all on function core.list_org_members(uuid) from public;
-- El caller SIEMPRE corre bajo el rol `authenticated` (ver
-- `ManagedPostgresEngine.withAppSession`: `set local role authenticated` en toda
-- sesión, con o sin `auth.uid()` real) -- nunca `anon`, mismo criterio que
-- `core.list_org_members_by_vertical_role`.
grant execute on function core.list_org_members(uuid) to authenticated;

create or replace function core.update_membership_role(
  p_organization_id uuid,
  p_target_user_id uuid,
  p_new_platform_role text,
  p_new_vertical_role text
)
returns table (
  user_id uuid,
  email text,
  full_name text,
  platform_role text,
  vertical_role text,
  property_ids uuid[]
)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_caller_role text;
  v_target_role text;
  v_rank_caller int;
  v_rank_target_current int;
  v_rank_target_new int;
begin
  if p_new_platform_role not in ('owner','admin','member','viewer') then
    raise exception 'platform_role inválido' using errcode = 'P0001';
  end if;

  -- Nunca auto-cambio de rol -- ver el comentario de cabecera de esta migración
  -- para el porqué (evita que el único owner se degrade a sí mismo por error, o
  -- que una sesión comprometida se autoascienda).
  if p_target_user_id = auth.uid() then
    raise exception 'no puedes cambiar tu propio rol' using errcode = 'P0001';
  end if;

  -- Columnas calificadas con el alias `m.` a propósito (nunca un bare
  -- `platform_role`/`vertical_role`): esta función tiene columnas de SALIDA
  -- (`returns table`) con el MISMO nombre que las columnas de `core.membership`
  -- que lee aquí -- PL/pgSQL trae esas columnas de salida a este scope como
  -- variables implícitas, así que una referencia sin calificar es ambigua
  -- (verificado contra Postgres real: "column reference platform_role is
  -- ambiguous" sin este alias, antes de que esta migración se aplicara a main).
  select m.platform_role into v_caller_role
    from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'no perteneces a esta organización' using errcode = 'P0001';
  end if;

  select m.platform_role into v_target_role
    from core.membership m
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id;
  if v_target_role is null then
    raise exception 'el staff indicado no pertenece a esta organización' using errcode = 'P0001';
  end if;

  v_rank_caller := case v_caller_role when 'owner' then 4 when 'admin' then 3 when 'member' then 2 when 'viewer' then 1 else 0 end;
  v_rank_target_current := case v_target_role when 'owner' then 4 when 'admin' then 3 when 'member' then 2 when 'viewer' then 1 else 0 end;
  v_rank_target_new := case p_new_platform_role when 'owner' then 4 when 'admin' then 3 when 'member' then 2 when 'viewer' then 1 else 0 end;

  -- Mismo umbral que `canInviteStaff` (core-authz/src/roles.ts): solo admin/owner
  -- gestionan roles, nunca member/viewer.
  if v_rank_caller < 3 then
    raise exception 'tu rol no alcanza para cambiar roles de staff' using errcode = 'P0001';
  end if;
  -- Mismo criterio que `canInviteStaff`: nunca tocar a alguien de rango MAYOR, ni
  -- asignar un rol de rango MAYOR al propio.
  if v_rank_caller < v_rank_target_current or v_rank_caller < v_rank_target_new then
    raise exception 'no puedes cambiar el rol de alguien con más alcance que el tuyo, ni asignar un rol por encima del tuyo' using errcode = 'P0001';
  end if;

  -- Alias `m` en el UPDATE por el mismo motivo que las dos lecturas de arriba
  -- (`user_id` también es columna de SALIDA de esta función -- un `where user_id =
  -- ...` sin calificar es ambiguo, verificado contra Postgres real).
  update core.membership m
    set platform_role = p_new_platform_role, vertical_role = p_new_vertical_role
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id;

  return query
    select su.id, su.email, su.full_name, m.platform_role, m.vertical_role, m.property_ids
    from core.membership m
    join core.staff_user su on su.id = m.user_id
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id;
end;
$$;

revoke all on function core.update_membership_role(uuid, uuid, text, text) from public;
grant execute on function core.update_membership_role(uuid, uuid, text, text) to authenticated;
