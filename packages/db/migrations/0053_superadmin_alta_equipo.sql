-- Superadmin SA-L-26 (version minima, go-live G-07): alta del equipo inicial de una organizacion.
--
-- Problema (disponibilidad del arranque): una organizacion recien creada (por ejemplo la real de Los Taquitos de PM) puede tener
-- 0 miembros en core.membership. Hoy solo owner/admin de la PROPIA organizacion invitan (policies de 0002_staff_invite_schema),
-- la impersonacion del superadmin es de solo lectura y no hay registro publico: nadie puede darle acceso al dueño sin insertar
-- filas a mano en core.staff_invite. Esta migracion agrega el camino soportado, con motivo y bitacora.
--
-- Que agrega (todo en schema core, nada toca datos existentes):
--   0) CORRECCION de core.accept_staff_invite (0002): la funcion declara columnas de salida llamadas email, organization_id, platform_role,
--      vertical_role y property_ids, y su cuerpo usa esos mismos nombres como columnas (`where email = v_invite.email`,
--      `on conflict (user_id, organization_id)`). PL/pgSQL, con su ajuste por defecto (variable_conflict = error), responde SQLSTATE 42702
--      ("column reference \"email\" is ambiguous") en CADA llamada: contra Postgres real NINGUNA invitacion de staff se podia aceptar
--      (ni las que crea un owner/admin ni las de este archivo). Este archivo la reemplaza con la MISMA firma, el mismo tipo de retorno,
--      el mismo comportamiento y `#variable_conflict use_column` (un nombre sin calificar significa la columna, nunca el parametro).
--   A) core.superadmin_security_event: tres eventos nuevos en el CHECK (org_invite_created / org_invite_resent / org_invite_revoked).
--   B) core.superadmin_invite_staff           -- crea una invitacion para una organizacion (rol de la lista blanca de la vertical).
--   C) core.superadmin_resend_staff_invite    -- reenvio: token nuevo, el anterior deja de servir, vigencia de 7 dias otra vez.
--   D) core.superadmin_revoke_staff_invite    -- revoca una invitacion pendiente.
--   E) core.list_org_team_for_superadmin      -- miembros actuales e invitaciones pendientes (correo enmascarado, sin hashes).
--   F) core.superadmin_invite_acceptance_for_system -- solo sistema: dice si una invitacion YA aceptada fue creada por un superadmin
--      (para el aviso in-app 'miembro_aceptado'); no devuelve datos personales.
--
-- Requiere: 0002 (core.staff_invite, core.accept_staff_invite), 0010/0012 (core.is_platform_superadmin), 0025 (bitacora
-- core.superadmin_security_event y core.superadmin_require_caller) y 0038 (CHECK de eventos que este archivo reemplaza).
-- La aceptacion NO cambia: sigue siendo core.accept_staff_invite (el usuario define su propia contrasena; el superadmin nunca crea
-- usuarios ni contrasenas).
--
-- Justificacion de seguridad (cada GRANT, policy o funcion trae su razon):
--   * No se crea ninguna policy ni GRANT de tabla nuevo: core.staff_invite conserva sus policies de 0002 (solo owner/admin de la
--     organizacion escriben directo). El superadmin NO es miembro, asi que escribe unicamente a traves de las funciones definer de
--     abajo; ninguna acepta SQL dinamico y todas tienen `set search_path = core, pg_temp`.
--   * B, C, D, E: security definer, `revoke all ... from public, anon` y grant execute SOLO a `authenticated` (el rol bajo el que
--     corre toda sesion de la app, ver 0002). Cada una abre con core.superadmin_require_caller: auth.uid() = p_caller_id y superadmin
--     de plataforma real (excluye el rol `finanzas` de solo lectura). Un staff normal, un uid ajeno, la sesion de sistema o anon
--     reciben 42501 (E: contrato de lectura 'sin datos', como las demas lecturas *_for_superadmin).
--   * B valida DENTRO de la funcion (no solo en TypeScript): rol de la lista blanca de la vertical con su platform_role fijo (el
--     llamador no elige el platform_role), sucursales que pertenezcan a ESA organizacion (una invitacion de la org A nunca otorga
--     acceso a la org B), correo ya miembro -> conflicto, invitacion pendiente vigente del mismo correo -> conflicto, segundo owner
--     solo con confirmacion explicita, motivo >= 20 caracteres. El token en claro NUNCA llega a la base: solo su hash.
--   * C y D validan que la invitacion sea de la organizacion indicada y siga pendiente: no se puede revocar ni reenviar la de otra
--     organizacion ni resucitar una aceptada/revocada.
--   * Bitacora: cada accion escribe en core.superadmin_security_event (append-only, 0025) con el correo ENMASCARADO (primer caracter +
--     dominio) y el motivo; nunca el correo completo ni el token.
--   * E devuelve correos enmascarados y ningun hash ni token.
--   * F: security definer, solo sistema (auth.uid() debe ser null, 42501 si no), sin parametros que acepten SQL; solo expone el id de
--     la invitacion y de la organizacion, y solo cuando la invitacion esta aceptada Y existe su evento org_invite_created en la
--     bitacora (que solo escriben las funciones de este archivo): una invitacion creada por un owner/admin de la org no dispara aviso.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0) Correccion de core.accept_staff_invite (ambigüedad entre columnas de salida y columnas de tabla)
-- ═══════════════════════════════════════════════════════════════════════════
-- Mismo cuerpo que 0002, con `#variable_conflict use_column`. Seguridad: sigue siendo security definer con
-- `set search_path = core, pg_temp`, `revoke ... from public` y grant execute solo a `authenticated` (rol de toda sesion de la app,
-- incluida la del invitado sin sesion todavia); no se agrega ningun GRANT nuevo y nunca a anon. `create or replace` conserva los
-- permisos existentes; se reafirman abajo para que la migracion sea autocontenida.
create or replace function core.accept_staff_invite(
  p_token_hash text,
  p_full_name text,
  p_password_hash text
)
returns table (
  staff_id uuid,
  email text,
  organization_id uuid,
  vertical text,
  platform_role text,
  vertical_role text,
  property_ids uuid[]
)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
#variable_conflict use_column
declare
  v_invite core.staff_invite%rowtype;
  v_staff_id uuid;
begin
  select * into v_invite from core.staff_invite where token_hash = p_token_hash for update;
  if not found or v_invite.status <> 'pending' or v_invite.expires_at < now() then
    raise exception 'invitación inválida, ya usada/revocada, o expirada' using errcode = 'P0001';
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'full_name requerido' using errcode = 'P0001';
  end if;
  if p_password_hash is null or length(p_password_hash) = 0 then
    raise exception 'password_hash requerido' using errcode = 'P0001';
  end if;

  select id into v_staff_id from core.staff_user where core.staff_user.email = v_invite.email;
  if v_staff_id is null then
    insert into core.staff_user (email, password_hash, full_name, created_via, email_verified_at)
    values (v_invite.email, p_password_hash, p_full_name, 'invite', now())
    returning id into v_staff_id;
  end if;

  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
  values (v_staff_id, v_invite.organization_id, v_invite.property_ids, v_invite.platform_role, v_invite.vertical_role)
  on conflict (user_id, organization_id) do update
    set property_ids = excluded.property_ids,
        platform_role = excluded.platform_role,
        vertical_role = excluded.vertical_role;

  update core.staff_invite
    set status = 'accepted', accepted_at = now(), accepted_by = v_staff_id
    where id = v_invite.id;

  return query
    select v_staff_id, v_invite.email, v_invite.organization_id, o.vertical, v_invite.platform_role, v_invite.vertical_role, v_invite.property_ids
    from core.organization o
    where o.id = v_invite.organization_id;
end;
$$;

revoke all on function core.accept_staff_invite(text, text, text) from public, anon;
grant execute on function core.accept_staff_invite(text, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Eventos nuevos de la bitacora
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.superadmin_security_event drop constraint superadmin_security_event_event_check;
alter table core.superadmin_security_event add constraint superadmin_security_event_event_check check (event in (
  'mfa_enroll_started', 'mfa_activated', 'mfa_verified', 'mfa_failed', 'mfa_locked', 'mfa_replay', 'mfa_reset',
  'switch_set',
  'org_action_requested', 'org_action_executed', 'org_action_cancelled', 'org_action_expired',
  'org_action_approved',
  'org_invite_created', 'org_invite_resent', 'org_invite_revoked'
));

-- Correo enmascarado: primer caracter + dominio completo (mismo formato que enmascararCorreoInvitado de admin-staff.ts).
create or replace function core.mask_email(p_email text)
returns text language sql immutable set search_path = core, pg_temp as $$
  select case when p_email is null or position('@' in p_email) <= 1 then '***'
              else left(p_email, 1) || '***@' || substr(p_email, position('@' in p_email) + 1) end;
$$;
revoke all on function core.mask_email(text) from public, anon;
grant execute on function core.mask_email(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Crear la invitacion
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
  -- Lista blanca por vertical. Hoy solo restaurantes tiene su lista (owner, admin, staff, repartidor) mapeada a un platform_role fijo
  -- (igual que PLATFORM_ROLE_BY_VERTICAL_ROLE de domain-restaurantes); las demas verticales se rechazan hasta tener la suya.
  if v_vertical <> 'restaurantes' then
    raise exception 'superadmin_invite_staff: el alta de equipo aun no esta disponible para la vertical %', v_vertical using errcode = '22023';
  end if;
  v_platform_role := case p_vertical_role when 'owner' then 'owner' when 'admin' then 'admin' when 'staff' then 'member' when 'repartidor' then 'member' else null end;
  if v_platform_role is null then
    raise exception 'superadmin_invite_staff: rol fuera de la lista blanca (owner, admin, staff, repartidor)' using errcode = '22023';
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

  -- Segundo owner: solo con confirmacion explicita.
  if p_vertical_role = 'owner' and not coalesce(p_confirmar_segundo_owner, false) and (
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
-- C) Reenviar (token nuevo; el anterior deja de servir)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_resend_staff_invite(
  p_caller_id uuid,
  p_organization_id uuid,
  p_invite_id uuid,
  p_token_hash text,
  p_motivo text
)
returns table (id uuid, email text, vertical_role text, platform_role text, property_ids uuid[], status text, expires_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_row core.staff_invite;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_resend_staff_invite');
  if char_length(v_motivo) < 20 then
    raise exception 'superadmin_resend_staff_invite: motivo obligatorio (minimo 20 caracteres)' using errcode = '22023';
  end if;
  if p_token_hash is null or char_length(p_token_hash) < 32 then
    raise exception 'superadmin_resend_staff_invite: token_hash requerido' using errcode = '22023';
  end if;
  update core.staff_invite i
    set token_hash = p_token_hash, expires_at = now() + interval '7 days'
    where i.id = p_invite_id and i.organization_id = p_organization_id and i.status = 'pending'
    returning * into v_row;
  if not found then
    raise exception 'superadmin_resend_staff_invite: invitacion no encontrada o ya no esta pendiente' using errcode = 'P0002';
  end if;
  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_invite_resent', p_caller_id, p_organization_id,
    jsonb_build_object('invite_id', v_row.id, 'email', core.mask_email(v_row.email), 'vertical_role', v_row.vertical_role, 'motivo', v_motivo));
  return query select v_row.id, v_row.email, v_row.vertical_role, v_row.platform_role, v_row.property_ids, v_row.status, v_row.expires_at, v_row.created_at;
end;
$$;
revoke all on function core.superadmin_resend_staff_invite(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function core.superadmin_resend_staff_invite(uuid, uuid, uuid, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Revocar
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_revoke_staff_invite(p_caller_id uuid, p_organization_id uuid, p_invite_id uuid, p_motivo text)
returns uuid language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_row core.staff_invite;
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_revoke_staff_invite');
  if char_length(v_motivo) < 20 then
    raise exception 'superadmin_revoke_staff_invite: motivo obligatorio (minimo 20 caracteres)' using errcode = '22023';
  end if;
  update core.staff_invite i set status = 'revoked'
    where i.id = p_invite_id and i.organization_id = p_organization_id and i.status = 'pending'
    returning * into v_row;
  if not found then
    raise exception 'superadmin_revoke_staff_invite: invitacion no encontrada o ya no esta pendiente' using errcode = 'P0002';
  end if;
  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_invite_revoked', p_caller_id, p_organization_id,
    jsonb_build_object('invite_id', v_row.id, 'email', core.mask_email(v_row.email), 'vertical_role', v_row.vertical_role, 'motivo', v_motivo));
  return v_row.id;
end;
$$;
revoke all on function core.superadmin_revoke_staff_invite(uuid, uuid, uuid, text) from public, anon;
grant execute on function core.superadmin_revoke_staff_invite(uuid, uuid, uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Leer el equipo (miembros + invitaciones pendientes)
-- ═══════════════════════════════════════════════════════════════════════════
-- Devuelve NULL (sin datos) para quien no es superadmin o si la organizacion no existe. Correos enmascarados; sin hashes ni tokens.
create or replace function core.list_org_team_for_superadmin(p_caller_id uuid, p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return null;
  end if;
  if not exists (select 1 from core.organization o where o.id = p_organization_id) then
    return null;
  end if;
  return jsonb_build_object(
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

-- ═══════════════════════════════════════════════════════════════════════════
-- F) Solo sistema: ¿esta invitacion aceptada la creo un superadmin?
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_invite_acceptance_for_system(p_token_hash text)
returns table (invite_id uuid, organization_id uuid)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'superadmin_invite_acceptance_for_system es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select i.id, i.organization_id
    from core.staff_invite i
    where i.token_hash = p_token_hash
      and i.status = 'accepted'
      and exists (
        select 1 from core.superadmin_security_event e
        where e.event = 'org_invite_created' and e.organization_id = i.organization_id and e.detail ->> 'invite_id' = i.id::text);
end;
$$;
revoke all on function core.superadmin_invite_acceptance_for_system(text) from public, anon;
grant execute on function core.superadmin_invite_acceptance_for_system(text) to authenticated;
