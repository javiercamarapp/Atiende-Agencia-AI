-- "Entrar a un cliente" desde el superadmin -- sesión de SOPORTE sobre la impersonación de 0020.
--
-- QUÉ AGREGA (forward-only; no reescribe ni borra nada de 0020):
--   1. Relaja, sin tocar filas existentes, dos CHECK de 0020 que impedían una sesión de soporte con la
--      duración y el motivo que pidió Javier: motivo >= 10 caracteres (antes 20) y techo de 120 min (antes 20).
--      `core.start_impersonation_session` sigue exigiendo 20 caracteres y 15 min DENTRO de la función, así que la
--      impersonación clásica no cambia; el CHECK era solo defensa en profundidad.
--   2. Permite el evento `elevate` en `core.impersonation_audit_log` (elevación explícita a edición, con 2.º motivo).
--   3. `core.start_support_session`: abre la sesión de soporte (60 min) y escribe el evento `start` en la bitácora
--      hash-encadenada de la organización, en la MISMA transacción: si la bitácora falla no hay sesión.
--   4. `core.elevate_support_session`, `core.get_support_session_state`: elevación y estado verificados en SQL.
--   5. `core.support_membership_grant` + `core.grant_support_membership` + `core.revoke_support_memberships`:
--      concesión TEMPORAL y trazada de membresía para un superadmin que NO es miembro de la organización (toda la
--      autorización del shell y la RLS de las 6 verticales se resuelven contra `core.membership`; no existe otro
--      camino que no sea saltarse RLS). Nunca permanente ni oculta: queda ligada a la sesión, se revoca al salir
--      y de forma perezosa al vencer/terminar (cada nueva entrada o consulta de estado barre las del propio caller).
--
-- SEGURIDAD: toda función es `security definer` con `set search_path = core, pg_temp`, `revoke ... from public`,
-- `grant execute` solo a `authenticated` y exige `auth.uid() = p_caller_id` + `core.is_platform_superadmin`.
-- La tabla de concesiones tiene RLS sin ninguna policy y sin GRANT: solo las funciones definer la tocan.
-- La solo-lectura NO se aplica en SQL: la impone la guarda central de la API sobre el claim `soporte` del token
-- (apps/api/src/soporte/guard.ts); la concesión usa el rol de acceso total de la vertical, igual que el acceso demo (0014).

-- 1) CHECKs relajados -----------------------------------------------------------------------------------------
alter table core.impersonation_session drop constraint if exists impersonation_session_reason_check;
alter table core.impersonation_session
  add constraint impersonation_session_reason_check check (char_length(btrim(reason)) >= 10);

alter table core.impersonation_session drop constraint if exists impersonation_session_duracion_maxima_20_min;
alter table core.impersonation_session
  add constraint impersonation_session_duracion_maxima_120_min check (expires_at <= started_at + interval '120 minutes');

-- 2) evento `elevate` -----------------------------------------------------------------------------------------
alter table core.impersonation_audit_log drop constraint if exists impersonation_audit_log_event_type_check;
alter table core.impersonation_audit_log
  add constraint impersonation_audit_log_event_type_check check (event_type in ('start', 'end', 'elevate'));

-- 3) concesiones temporales de membresía --------------------------------------------------------------------
create table core.support_membership_grant (
  session_id uuid primary key references core.impersonation_session(id) on delete restrict,
  user_id uuid not null references core.staff_user(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
revoke all on core.support_membership_grant from public, anon, authenticated;
alter table core.support_membership_grant enable row level security;
-- Sin ninguna policy ni GRANT: solo las funciones security definer de abajo leen o escriben.

-- 4) sesión de soporte ----------------------------------------------------------------------------------------
create or replace function core.start_support_session(
  p_caller_id uuid,
  p_organization_id uuid,
  p_reason text,
  p_minutes int default 60
)
returns core.impersonation_session
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_session core.impersonation_session;
  v_email text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_started timestamptz := now();
  v_minutes int := greatest(5, least(coalesce(p_minutes, 60), 120));
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'start_support_session: caller binding inválido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'start_support_session: solo un superadmin de plataforma real puede abrir una sesión de soporte' using errcode = '42501';
  end if;
  if char_length(v_reason) < 10 then
    raise exception 'start_support_session: motivo obligatorio (mínimo 10 caracteres)' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'start_support_session: la organización % no existe', p_organization_id using errcode = 'P0002';
  end if;
  if exists (
    select 1 from core.membership m
    join core.platform_superadmin ps on ps.staff_user_id = m.user_id
    where m.organization_id = p_organization_id and m.user_id <> p_caller_id
  ) then
    raise exception 'start_support_session: no se puede entrar a una organización que tiene a otro superadmin de plataforma como miembro' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('impersonation_start:' || p_caller_id::text));

  -- Barrido perezoso de concesiones vencidas o de sesiones terminadas de ESTE caller.
  perform core.revoke_support_memberships(p_caller_id, null);

  if exists (
    select 1 from core.impersonation_session s
    where s.actor_user_id = p_caller_id and s.expires_at > v_started
      and not exists (select 1 from core.impersonation_audit_log a where a.session_id = s.id and a.event_type = 'end')
  ) then
    raise exception 'start_support_session: ya existe una sesión activa para este superadmin -- termínala antes de abrir otra' using errcode = '55006';
  end if;

  select s.email into v_email from core.staff_user s where s.id = p_caller_id;

  insert into core.impersonation_session (actor_user_id, actor_email, organization_id, reason, started_at, expires_at)
  values (p_caller_id, v_email, p_organization_id, v_reason, v_started, v_started + make_interval(mins => v_minutes))
  returning * into v_session;

  insert into core.impersonation_audit_log (session_id, event_type, actor_user_id, actor_email, organization_id, reason, detail, occurred_at)
  values (v_session.id, 'start', p_caller_id, v_email, p_organization_id, v_reason,
          jsonb_build_object('kind', 'soporte', 'soloLectura', true, 'expiresAt', v_session.expires_at), v_started);

  return v_session;
end;
$$;
revoke all on function core.start_support_session(uuid, uuid, text, int) from public;
grant execute on function core.start_support_session(uuid, uuid, text, int) to authenticated;

-- 5) elevación a edición (2.º motivo, queda en la bitácora) ---------------------------------------------------
create or replace function core.elevate_support_session(p_caller_id uuid, p_session_id uuid, p_reason text)
returns core.impersonation_audit_log
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_session core.impersonation_session;
  v_entry core.impersonation_audit_log;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_now timestamptz := now();
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'elevate_support_session: caller binding inválido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'elevate_support_session: solo un superadmin de plataforma real' using errcode = '42501';
  end if;
  if char_length(v_reason) < 10 then
    raise exception 'elevate_support_session: motivo obligatorio (mínimo 10 caracteres)' using errcode = '22023';
  end if;

  select * into v_session from core.impersonation_session where id = p_session_id;
  if v_session.id is null then
    raise exception 'elevate_support_session: la sesión % no existe', p_session_id using errcode = 'P0002';
  end if;
  if v_session.actor_user_id <> p_caller_id then
    raise exception 'elevate_support_session: solo quien abrió la sesión puede elevarla' using errcode = '42501';
  end if;
  if v_session.expires_at <= v_now
     or exists (select 1 from core.impersonation_audit_log a where a.session_id = p_session_id and a.event_type = 'end') then
    raise exception 'elevate_support_session: la sesión ya terminó o venció' using errcode = '55006';
  end if;
  if not exists (
    select 1 from core.impersonation_audit_log a
    where a.session_id = p_session_id and a.event_type = 'start' and a.detail ->> 'kind' = 'soporte'
  ) then
    raise exception 'elevate_support_session: solo las sesiones de soporte se pueden elevar' using errcode = '42501';
  end if;
  if exists (select 1 from core.impersonation_audit_log a where a.session_id = p_session_id and a.event_type = 'elevate') then
    raise exception 'elevate_support_session: la sesión ya está elevada' using errcode = '55006';
  end if;

  insert into core.impersonation_audit_log (session_id, event_type, actor_user_id, actor_email, organization_id, reason, detail, occurred_at)
  values (p_session_id, 'elevate', p_caller_id, v_session.actor_email, v_session.organization_id, v_reason,
          jsonb_build_object('kind', 'soporte', 'soloLectura', false), v_now)
  returning * into v_entry;

  return v_entry;
end;
$$;
revoke all on function core.elevate_support_session(uuid, uuid, text) from public;
grant execute on function core.elevate_support_session(uuid, uuid, text) to authenticated;

-- 6) estado verificado en SQL (lo consulta la guarda de la API en cada petición con token de soporte) ---------
create or replace function core.get_support_session_state(p_caller_id uuid, p_session_id uuid)
returns table (organization_id uuid, expires_at timestamptz, active boolean, elevated boolean, soporte boolean)
language sql stable security definer set search_path = core, pg_temp
as $$
  select
    s.organization_id,
    s.expires_at,
    (s.expires_at > now()
      and not exists (select 1 from core.impersonation_audit_log a where a.session_id = s.id and a.event_type = 'end')) as active,
    exists (select 1 from core.impersonation_audit_log a where a.session_id = s.id and a.event_type = 'elevate') as elevated,
    exists (select 1 from core.impersonation_audit_log a where a.session_id = s.id and a.event_type = 'start' and a.detail ->> 'kind' = 'soporte') as soporte
  from core.impersonation_session s
  where auth.uid() is not null and auth.uid() = p_caller_id
    and s.actor_user_id = p_caller_id
    and s.id = p_session_id;
$$;
revoke all on function core.get_support_session_state(uuid, uuid) from public;
grant execute on function core.get_support_session_state(uuid, uuid) to authenticated;

-- 7) concesión temporal de membresía -----------------------------------------------------------------------
create or replace function core.grant_support_membership(p_caller_id uuid, p_session_id uuid)
returns boolean
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_session core.impersonation_session;
  v_vertical text;
  v_vertical_role text;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'grant_support_membership: caller binding inválido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'grant_support_membership: solo un superadmin de plataforma real' using errcode = '42501';
  end if;

  select * into v_session from core.impersonation_session where id = p_session_id;
  if v_session.id is null or v_session.actor_user_id <> p_caller_id then
    raise exception 'grant_support_membership: la sesión % no existe o no es tuya', p_session_id using errcode = 'P0002';
  end if;
  if v_session.expires_at <= now()
     or exists (select 1 from core.impersonation_audit_log a where a.session_id = p_session_id and a.event_type = 'end') then
    raise exception 'grant_support_membership: la sesión ya terminó o venció' using errcode = '55006';
  end if;
  if not exists (
    select 1 from core.impersonation_audit_log a
    where a.session_id = p_session_id and a.event_type = 'start' and a.detail ->> 'kind' = 'soporte'
  ) then
    raise exception 'grant_support_membership: solo las sesiones de soporte pueden concederla' using errcode = '42501';
  end if;

  -- Ya es miembro de verdad: no se toca nada (y nunca se revocará una membresía que no creó esta función).
  if exists (select 1 from core.membership m where m.user_id = p_caller_id and m.organization_id = v_session.organization_id) then
    return false;
  end if;

  select o.vertical into v_vertical from core.organization o where o.id = v_session.organization_id;
  v_vertical_role := case v_vertical
    when 'hoteles' then 'owner'
    when 'restaurantes' then 'owner'
    when 'citas' then 'owner'
    when 'licitaciones' then 'owner'
    when 'despachos' then 'admin'
    when 'rentas' then 'admin_gestora'
  end;
  if v_vertical_role is null then
    raise exception 'grant_support_membership: vertical sin rol de acceso conocido' using errcode = '22023';
  end if;

  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
  values (p_caller_id, v_session.organization_id, null, 'owner', v_vertical_role);

  insert into core.support_membership_grant (session_id, user_id, organization_id)
  values (p_session_id, p_caller_id, v_session.organization_id);

  return true;
end;
$$;
revoke all on function core.grant_support_membership(uuid, uuid) from public;
grant execute on function core.grant_support_membership(uuid, uuid) to authenticated;

-- Revoca las concesiones del propio caller: la de `p_session_id` (si se da) y, siempre, las de sesiones ya
-- terminadas o vencidas. Devuelve cuántas membresías quitó. Solo borra membresías que una concesión creó.
create or replace function core.revoke_support_memberships(p_caller_id uuid, p_session_id uuid)
returns int
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_grant record;
  v_count int := 0;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'revoke_support_memberships: caller binding inválido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;

  for v_grant in
    select g.session_id, g.user_id, g.organization_id
    from core.support_membership_grant g
    join core.impersonation_session s on s.id = g.session_id
    where g.user_id = p_caller_id
      and g.revoked_at is null
      and (
        g.session_id = p_session_id
        or s.expires_at <= now()
        or exists (select 1 from core.impersonation_audit_log a where a.session_id = s.id and a.event_type = 'end')
      )
    for update of g
  loop
    delete from core.membership m where m.user_id = v_grant.user_id and m.organization_id = v_grant.organization_id;
    update core.support_membership_grant set revoked_at = now() where session_id = v_grant.session_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
revoke all on function core.revoke_support_memberships(uuid, uuid) from public;
grant execute on function core.revoke_support_memberships(uuid, uuid) to authenticated;
