-- Onboarding P0: el superadmin puede invitar al primer dueño (y al equipo inicial) de CUALQUIER vertical, no solo restaurantes.
--
-- Problema (disponibilidad del arranque): 0053 agrego core.superadmin_invite_staff con una lista blanca SOLO para restaurantes
-- (`if v_vertical <> 'restaurantes' then raise ...`). Una organizacion de citas, hoteles, despachos, licitaciones o rentas dada de alta
-- por el superadmin nace con 0 miembros y no habia ningun camino soportado para darle acceso a su dueño: solo SQL a mano.
--
-- Que cambia (todo en schema core, nada toca datos existentes; archivo aditivo, 0053 no se edita):
--   1) core.superadmin_invite_staff: MISMA firma, MISMO tipo de retorno y mismas reglas que 0053, con la lista blanca por vertical.
--      Cada vertical_role se mapea a un platform_role FIJO, identico a PLATFORM_ROLE_BY_VERTICAL_ROLE de su packages/domain-<v>/src/roles.ts:
--        restaurantes: owner->owner, admin->admin, staff->member, repartidor->member
--        citas:        owner->owner, admin->admin, staff->member
--        hoteles:      owner->owner, gm->admin, frontdesk|reservations|housekeeping|maintenance|fnb|accountant->member
--        despachos:    admin->owner, contador->admin, auditor|readonly->viewer
--        licitaciones: owner->owner, admin->admin, analyst|writer|reviewer->member, viewer->viewer
--        rentas:       admin_gestora->owner, operador:acceso_total|operador:calendario_mensajeria|operador:solo_calendario|limpieza->member,
--                      contador->viewer
--      La regla de "segundo owner solo con confirmacion" ahora se evalua sobre el platform_role resultante (en despachos el dueño es
--      vertical_role 'admin', en rentas 'admin_gestora'), no sobre el texto 'owner'.
--   2) core.list_org_team_for_superadmin: mismo contrato que 0053 + la llave 'vertical' (la API la usa para elegir la plantilla del correo
--      y la consola para mostrar los roles validos de esa vertical). Las demas llaves no cambian.
--
-- Requiere: 0053 (funciones que este archivo reemplaza con create or replace, misma firma).
--
-- Justificacion de seguridad:
--   * No se crea ninguna tabla, policy ni GRANT de tabla. `create or replace` conserva los permisos de 0053; se reafirman abajo
--     (revoke de public y anon, execute solo a authenticated) para que el archivo sea autocontenido.
--   * Ambas funciones siguen siendo security definer con `set search_path = core, pg_temp`, sin SQL dinamico.
--   * superadmin_invite_staff abre con core.superadmin_require_caller (auth.uid() = p_caller_id y superadmin real): staff normal,
--     uid ajeno, sesion de sistema y anon reciben 42501 igual que antes. El llamador sigue sin elegir el platform_role: sale de la lista
--     blanca de la vertical de la organizacion (leida de core.organization, nunca del request).
--   * Sucursales de otra organizacion, correo ya miembro, invitacion pendiente duplicada y motivo < 20 siguen rechazandose; el token en
--     claro nunca llega a la base; la bitacora guarda el correo enmascarado.
--   * list_org_team_for_superadmin: devuelve NULL para quien no es superadmin con su propio uid (sin cambio); la llave nueva es el texto
--     de la vertical de la organizacion, sin datos personales.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) Crear la invitacion (lista blanca por vertical)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_invite_staff(
  p_caller_id uuid,
  p_organization_id uuid,
  p_email text,
  p_vertical_role text,
  p_property_ids uuid[],
  p_token_hash text,
  p_motivo text,
  p_confirmar_segundo_owner boolean default false
)
returns table (id uuid, email text, vertical_role text, platform_role text, property_ids uuid[], status text, expires_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_vertical text;
  v_platform_role text;
  v_props uuid[];
  v_row core.staff_invite;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_invite_staff');
  if char_length(v_motivo) < 20 then
    raise exception 'superadmin_invite_staff: motivo obligatorio (minimo 20 caracteres)' using errcode = '22023';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_email) > 254 then
    raise exception 'superadmin_invite_staff: correo invalido' using errcode = '22023';
  end if;
  if p_token_hash is null or char_length(p_token_hash) < 32 then
    raise exception 'superadmin_invite_staff: token_hash requerido' using errcode = '22023';
  end if;

  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
  if v_vertical is null then
    raise exception 'superadmin_invite_staff: organizacion no encontrada' using errcode = 'P0002';
  end if;

  -- Lista blanca por vertical -> platform_role fijo (espejo de PLATFORM_ROLE_BY_VERTICAL_ROLE de cada domain-<vertical>).
  v_platform_role := case v_vertical
    when 'restaurantes' then case p_vertical_role
      when 'owner' then 'owner' when 'admin' then 'admin' when 'staff' then 'member' when 'repartidor' then 'member' else null end
    when 'citas' then case p_vertical_role
      when 'owner' then 'owner' when 'admin' then 'admin' when 'staff' then 'member' else null end
    when 'hoteles' then case p_vertical_role
      when 'owner' then 'owner' when 'gm' then 'admin'
      when 'frontdesk' then 'member' when 'reservations' then 'member' when 'housekeeping' then 'member'
      when 'maintenance' then 'member' when 'fnb' then 'member' when 'accountant' then 'member' else null end
    when 'despachos' then case p_vertical_role
      when 'admin' then 'owner' when 'contador' then 'admin' when 'auditor' then 'viewer' when 'readonly' then 'viewer' else null end
    when 'licitaciones' then case p_vertical_role
      when 'owner' then 'owner' when 'admin' then 'admin'
      when 'analyst' then 'member' when 'writer' then 'member' when 'reviewer' then 'member' when 'viewer' then 'viewer' else null end
    when 'rentas' then case p_vertical_role
      when 'admin_gestora' then 'owner'
      when 'operador:acceso_total' then 'member' when 'operador:calendario_mensajeria' then 'member'
      when 'operador:solo_calendario' then 'member' when 'limpieza' then 'member' when 'contador' then 'viewer' else null end
    else null
  end;
  if v_platform_role is null then
    raise exception 'superadmin_invite_staff: rol fuera de la lista blanca de la vertical %', v_vertical using errcode = '22023';
  end if;

  -- Sucursales: null = todas; si se indican, deben existir y ser de ESTA organizacion.
  if p_property_ids is not null then
    select array_agg(distinct x) into v_props from unnest(p_property_ids) x;
    if v_props is null or cardinality(v_props) = 0 then
      raise exception 'superadmin_invite_staff: property_ids vacio (usa null para todas las sucursales)' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_props) x where x is null or not exists (select 1 from core.property p where p.id = x and p.organization_id = p_organization_id)) then
      raise exception 'superadmin_invite_staff: alguna sucursal no pertenece a la organizacion' using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1 from core.staff_user u join core.membership m on m.user_id = u.id
    where lower(u.email) = v_email and m.organization_id = p_organization_id
  ) then
    raise exception 'superadmin_invite_staff: ese correo ya es miembro de la organizacion' using errcode = '23505';
  end if;
  if exists (
    select 1 from core.staff_invite i
    where i.organization_id = p_organization_id and lower(i.email) = v_email and i.status = 'pending' and i.expires_at > now()
  ) then
    raise exception 'superadmin_invite_staff: ya hay una invitacion pendiente para ese correo (reenviala o revocala)' using errcode = '23505';
  end if;

  -- Segundo owner (platform_role owner, sea cual sea el nombre del rol en la vertical): solo con confirmacion explicita.
  if v_platform_role = 'owner' and not coalesce(p_confirmar_segundo_owner, false) and (
    exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.platform_role = 'owner')
    or exists (select 1 from core.staff_invite i where i.organization_id = p_organization_id and i.platform_role = 'owner' and i.status = 'pending' and i.expires_at > now())
  ) then
    raise exception 'superadmin_invite_staff: la organizacion ya tiene un owner (confirma explicitamente un segundo owner)' using errcode = '55000';
  end if;

  insert into core.staff_invite (email, organization_id, platform_role, vertical_role, property_ids, token_hash, invited_by, expires_at)
  values (v_email, p_organization_id, v_platform_role, p_vertical_role, v_props, p_token_hash, p_caller_id, now() + interval '7 days')
  returning * into v_row;

  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_invite_created', p_caller_id, p_organization_id,
    jsonb_build_object('invite_id', v_row.id, 'email', core.mask_email(v_email), 'vertical_role', p_vertical_role, 'property_ids', v_props, 'motivo', v_motivo));

  return query select v_row.id, v_row.email, v_row.vertical_role, v_row.platform_role, v_row.property_ids, v_row.status, v_row.expires_at, v_row.created_at;
end;
$$;
revoke all on function core.superadmin_invite_staff(uuid, uuid, text, text, uuid[], text, text, boolean) from public, anon;
grant execute on function core.superadmin_invite_staff(uuid, uuid, text, text, uuid[], text, text, boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Leer el equipo (+ vertical de la organizacion)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_org_team_for_superadmin(p_caller_id uuid, p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_vertical text;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return null;
  end if;
  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
  if v_vertical is null then
    return null;
  end if;
  return jsonb_build_object(
    'vertical', v_vertical,
    'miembros', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', m.user_id, 'correo', core.mask_email(u.email), 'rol', m.vertical_role, 'platformRole', m.platform_role,
        'propertyIds', to_jsonb(m.property_ids), 'altaEn', m.created_at) order by m.created_at, u.email)
      from core.membership m join core.staff_user u on u.id = m.user_id
      where m.organization_id = p_organization_id), '[]'::jsonb),
    'invitaciones', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'correo', core.mask_email(i.email), 'rol', i.vertical_role, 'platformRole', i.platform_role,
        'propertyIds', to_jsonb(i.property_ids), 'creadaEn', i.created_at, 'venceEn', i.expires_at, 'vencida', i.expires_at <= now()) order by i.created_at desc)
      from core.staff_invite i
      where i.organization_id = p_organization_id and i.status = 'pending'), '[]'::jsonb),
    'sucursales', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'nombre', p.name, 'estado', p.status) order by p.name)
      from core.property p where p.organization_id = p_organization_id), '[]'::jsonb)
  );
end;
$$;
revoke all on function core.list_org_team_for_superadmin(uuid, uuid) from public, anon;
grant execute on function core.list_org_team_for_superadmin(uuid, uuid) to authenticated;
