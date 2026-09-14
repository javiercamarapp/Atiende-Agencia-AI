-- Fase 10 restaurantes — gap real detectado durante la Fase 8 (rol "repartidor"):
-- ninguna vertical de atiende-fusion tenía un mecanismo para dar de alta staff
-- ADICIONAL desde el producto después del alta inicial de una organización. El
-- propio comentario de `0001_core_schema.sql` ya declaraba esto pendiente:
-- "Escritura de gestión (crear org, invitar staff) queda para las rutas núcleo...
-- fuera del alcance de esta migración" — y `core.staff_user.created_via` ya admitía
-- el valor 'invite' desde esa migración sin que NINGÚN método lo produjera todavía
-- (ver `packages/db/src/core-repository.ts`).
--
-- Genérico para las 6 verticales (vive en `core`, no en `restaurantes.*`) — el token
-- con expiración + el flujo crear/aceptar son el mismo mecanismo para cualquier
-- organización, solo `apps/api` decide en esta fase exponer la ruta HTTP
-- ÚNICAMENTE para restaurantes (ver `apps/api/src/routes/verticals/restaurantes/
-- admin-staff.ts` — documenta ahí la decisión de NO exponerla aún para las otras 5).
--
-- Dos piezas:
--   1. `core.staff_invite` — la invitación en sí (token de un solo uso, hasheado,
--      con expiración — mismo patrón exacto que `rentas.owner_credential`/
--      `generateInviteToken` del portal de propietario, generalizado aquí a staff).
--      RLS real: solo owner/admin de la organización create/lista/revoca (`auth.uid()`
--      vía `core.membership`, nunca solo la capa TS).
--   2. `core.accept_staff_invite(token_hash, full_name, password_hash)` — función
--      `security definer` que el invitado (SIN sesión autenticada todavía, mismo
--      momento que login) llama para: validar pending+no-expirado, crear (o
--      reutilizar) su `core.staff_user`, crear/actualizar su `core.membership`, y
--      marcar la invitación 'accepted' — todo atómico. Es la pieza que de verdad
--      resuelve el "quedar vinculado" del gap: sin ella, la única forma de escribir
--      `core.staff_user`/`core.membership` fuera de una sesión ya autenticada sería
--      `service_role`, que este monorepo NO aprovisiona todavía (mismo gap ya
--      documentado para las 3 escrituras de `rentas.owner_credential` en
--      `apps/api/src/production/rentas-owner-portal-repository.ts`) — `security
--      definer` es la solución real y disponible hoy, sin depender de esa pieza de
--      infraestructura pendiente.

create table core.staff_invite (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  organization_id uuid not null references core.organization(id) on delete cascade,
  platform_role text not null check (platform_role in ('owner','admin','member','viewer')),
  -- Opaco para `core`, igual criterio que `core.membership.vertical_role` — cada
  -- domain-<vertical> valida el string concreto (ver
  -- `domain-restaurantes/src/roles.ts::isRestaurantesRole`) antes de llamar
  -- `createStaffInvite`.
  vertical_role text not null,
  -- null = acceso a TODAS las properties de la organización, misma semántica que
  -- `core.membership.property_ids`.
  property_ids uuid[],
  token_hash text not null unique,
  invited_by uuid not null references core.staff_user(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);

create index staff_invite_organization_idx on core.staff_invite (organization_id);
create index staff_invite_pending_by_org_idx on core.staff_invite (organization_id, created_at desc) where status = 'pending';

alter table core.staff_invite enable row level security;

-- Solo owner/admin de la organización ve/crea/revoca invitaciones — ningún
-- 'member'/'viewer' (ej. un repartidor o un mesero de restaurantes) llega siquiera a
-- ver que existen, defensa en profundidad idéntica a la que ya aplica
-- `assertVerticalRole` en la capa TS (ver `admin-staff.ts`), pero como autoridad real.
create policy "owner/admin ve invitaciones de su organización"
  on core.staff_invite for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = core.staff_invite.organization_id
        and m.user_id = auth.uid()
        and m.platform_role in ('owner','admin')
    )
  );

create policy "owner/admin crea invitaciones de su organización"
  on core.staff_invite for insert
  with check (
    invited_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = core.staff_invite.organization_id
        and m.user_id = auth.uid()
        and m.platform_role in ('owner','admin')
    )
  );

create policy "owner/admin revoca invitaciones de su organización"
  on core.staff_invite for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = core.staff_invite.organization_id
        and m.user_id = auth.uid()
        and m.platform_role in ('owner','admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = core.staff_invite.organization_id
        and m.user_id = auth.uid()
        and m.platform_role in ('owner','admin')
    )
  );

revoke all on core.staff_invite from public, anon;
grant select, insert, update on core.staff_invite to authenticated;
grant all on core.staff_invite to service_role;

-- `security definer`: corre con el privilegio del DUEÑO de la función (quien aplica
-- esta migración), NO con el del rol `authenticated` que la invoca sin `auth.uid()`
-- (el invitado todavía no tiene sesión) — mismo principio que `core.has_property_access`
-- de `0001_core_schema.sql`, aplicado aquí a una escritura en vez de a una lectura.
-- Bloqueada con `set search_path = core, pg_temp` (nunca deja el search_path del
-- caller) y sin ningún parámetro que el caller controle termine en SQL dinámico —
-- superficie de inyección nula, todo son placeholders con tipo fijo.
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

  select id into v_staff_id from core.staff_user where email = v_invite.email;
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

revoke all on function core.accept_staff_invite(text, text, text) from public;
-- El invitado corre bajo el mismo rol `authenticated` que login (ver
-- `ManagedPostgresEngine.withAppSession`: siempre `set local role authenticated`,
-- con o sin `auth.uid()` real) — nunca `anon`, este monorepo no usa ese rol.
grant execute on function core.accept_staff_invite(text, text, text) to authenticated;
