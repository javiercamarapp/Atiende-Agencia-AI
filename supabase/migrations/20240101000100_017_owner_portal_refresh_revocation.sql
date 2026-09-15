-- Hallazgo de auditoría (severidad ALTA, "el portal de propietario (owner-portal) no
-- tiene logout/revocación real de sesión"): `OwnerPortalDashboard.tsx` ya renderiza un
-- botón "Cerrar sesión", pero su propio comentario de cabecera lo documenta como
-- honesto-pero-incompleto ("No hay POST /rentas/owner-portal/auth/logout en el
-- backend... 'cerrar sesión' aquí solo borra localStorage"): el refresh token de
-- propietario (`RentasPropertyOwnerRefreshTokenClaims`, 30 días de vida por defecto,
-- `deps.env.rentasOwnerRefreshTokenTtlSeconds`) seguía siendo válido para reemitir
-- access tokens nuevos indefinidamente si alguien más lo hubiera copiado del
-- localStorage de ese navegador -- exactamente el mismo gap que
-- `packages/db/migrations/0003_refresh_token_revocation.sql` ya cerró para staff
-- (login de core-auth). Mismo mecanismo, aplicado aquí a la identidad de propietario
-- (que deliberadamente vive fuera de `core.staff_user`, ver
-- `packages/domain-rentas/src/owner-portal/jwt.ts`): solo se persiste el `jti` (nunca
-- el JWT completo), vía función `security definer` (el rol `authenticated` sin
-- `auth.uid()` -- sesión de sistema, mismo momento que login/refresh de propietario --
-- no tiene ningún GRANT directo sobre esta tabla).
--
-- RLS habilitado pero SIN policies para `authenticated` (deny-by-default real): igual
-- que `core.revoked_refresh_token`, ambas operaciones pasan por `security definer`.
create table rentas.revoked_owner_refresh_token (
  jti uuid primary key,
  owner_id uuid not null references rentas.owner(id) on delete cascade,
  revoked_at timestamptz not null default now(),
  -- Expiración NATURAL del refresh token (su propio claim `exp`), no la fecha de
  -- revocación -- mismo criterio que `core.revoked_refresh_token.expires_at` (permite
  -- un futuro job de limpieza que purgue filas ya vencidas por sí solas; ese job
  -- queda deliberadamente FUERA de esta migración, ninguna vertical de este monorepo
  -- tiene todavía un cron de limpieza real).
  expires_at timestamptz not null
);

create index revoked_owner_refresh_token_owner_idx on rentas.revoked_owner_refresh_token (owner_id);

alter table rentas.revoked_owner_refresh_token enable row level security;

revoke all on rentas.revoked_owner_refresh_token from public, anon, authenticated;
grant all on rentas.revoked_owner_refresh_token to service_role;

-- `security definer`: corre con el privilegio del DUEÑO de la función, no con el del
-- rol `authenticated` sin `auth.uid()` que la invoca -- mismo principio EXACTO que
-- `core.revoke_refresh_token`/`core.is_refresh_token_revoked`
-- (`packages/db/migrations/0003_refresh_token_revocation.sql`). Bloqueada con
-- `set search_path = rentas, pg_temp` y sin ningún parámetro que termine en SQL
-- dinámico -- superficie de inyección nula, todo son placeholders con tipo fijo.
create or replace function rentas.revoke_owner_refresh_token(p_jti uuid, p_owner_id uuid, p_expires_at timestamptz)
returns void
language sql
security definer
set search_path = rentas, pg_temp
as $$
  insert into rentas.revoked_owner_refresh_token (jti, owner_id, expires_at)
  values (p_jti, p_owner_id, p_expires_at)
  on conflict (jti) do nothing;
$$;

create or replace function rentas.is_owner_refresh_token_revoked(p_jti uuid)
returns boolean
language sql
stable
security definer
set search_path = rentas, pg_temp
as $$
  select exists (select 1 from rentas.revoked_owner_refresh_token where jti = p_jti);
$$;

revoke all on function rentas.revoke_owner_refresh_token(uuid, uuid, timestamptz) from public;
revoke all on function rentas.is_owner_refresh_token_revoked(uuid) from public;
-- Mismo rol que login/refresh de propietario corren bajo
-- `ManagedPostgresEngine.withAppSession` (siempre `set local role authenticated`, con
-- o sin `auth.uid()` real) -- nunca `anon`, este monorepo no usa ese rol.
grant execute on function rentas.revoke_owner_refresh_token(uuid, uuid, timestamptz) to authenticated;
grant execute on function rentas.is_owner_refresh_token_revoked(uuid) to authenticated;
