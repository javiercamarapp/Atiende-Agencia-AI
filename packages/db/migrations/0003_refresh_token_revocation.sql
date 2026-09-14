-- Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
-- hoteles" — ver `apps/web/src/verticals/hoteles/HotelesShell.tsx`): el panel de
-- staff de hoteles no tenía ningún botón de cerrar sesión, y la razón de fondo no era
-- solo de UI — `apps/api/src/routes/auth.ts` (POST /auth/login, /auth/refresh, /auth/
-- me, /auth/select-org, /auth/accept-invite) no tenía NINGÚN endpoint de logout/
-- revocación con el que cerrar sesión realmente invalidara algo del lado del
-- servidor. `clearHotelesSession` (`apps/web/src/verticals/hoteles/lib/
-- auth-client.ts`) ya existía desde antes pero nunca se llamaba desde ningún
-- componente, y aunque se hubiera llamado, solo habría borrado `localStorage` del
-- navegador que hizo clic — el refresh token (30 días de vida, ver
-- `ACCESS_TOKEN_TTL_SECONDS`/`REFRESH_TOKEN_TTL_SECONDS` en `apps/api/src/env.ts`)
-- habría seguido siendo válido para reemitir access tokens nuevos indefinidamente si
-- alguien más lo hubiera copiado de ese localStorage — el escenario real que hace
-- esto bloqueante para un panel de recepción con dinero: un equipo compartido de
-- recepción donde un turno termina y el siguiente empieza en la misma sesión de
-- Chrome.
--
-- Esta migración es la pieza de servidor que un botón de logout necesita para hacer
-- algo real: revocar el refresh token concreto que esa sesión estaba usando. El
-- access token en sí sigue siendo stateless (JWT firmado, sin lookup en cada
-- request — ver el comentario de cabecera de `packages/core-auth/src/jwt.ts`: "los
-- claims son informativos... la autorización real siempre se re-resuelve en vivo",
-- principio que aquí NO se toca) y por diseño expira solo en
-- `ACCESS_TOKEN_TTL_SECONDS` (900s = 15 min por defecto) — la revocación de esta
-- tabla cierra la ventana de RE-EMISIÓN (`POST /auth/refresh` deja de funcionar con
-- ese refresh token en cuanto se revoca), no la ventana del access token ya emitido.
-- Ese es el mismo trade-off "revocar el refresh token, dejar que el access token
-- expire naturalmente" que usan la mayoría de los sistemas de sesión JWT de dos
-- tokens sin mantener una tabla de sesiones activas por-request — agregar un chequeo
-- de revocación a `authMiddleware` (cada request autenticado) sería un cambio de
-- arquitectura mucho más grande (una consulta a Postgres en cada request, no solo en
-- login/refresh/logout) fuera del alcance de este hallazgo puntual.
--
-- Solo se persiste el `jti` (identificador del JWT, agregado en esta misma pasada a
-- `signRefreshToken`/`RefreshTokenClaims` — ver `packages/core-auth/src/jwt.ts`),
-- NUNCA el JWT completo ni el refresh token en texto plano — mismo criterio que un
-- password o un token de invitación (`core.staff_invite.token_hash`).
--
-- RLS habilitado pero SIN policies para `authenticated` (deny-by-default real, no
-- decorativo): el actor de `/auth/logout`/`/auth/refresh` corre en sesión de SISTEMA
-- (`userId: null`, `auth.uid()` nulo — ocurre antes/sin depender de una sesión
-- autenticada, mismo momento que login y que `core.accept_staff_invite`), así que ni
-- siquiera podría autenticar un `auth.uid()` propio contra el que filtrar una policy
-- normal. Ambas operaciones (`revoke_refresh_token`/`is_refresh_token_revoked`) pasan
-- por funciones `security definer`, exactamente el mismo patrón ya establecido por
-- `core.accept_staff_invite` en `0002_staff_invite_schema.sql` para el mismo problema
-- (escribir/leer desde una sesión sin `auth.uid()` sin necesitar `service_role`).

create table core.revoked_refresh_token (
  jti uuid primary key,
  user_id uuid not null references core.staff_user(id) on delete cascade,
  revoked_at timestamptz not null default now(),
  -- Expiración NATURAL del refresh token (su propio claim `exp`), no la fecha de
  -- revocación (esa es `revoked_at`) — permite un futuro job de limpieza que purgue
  -- filas de tokens que de todas formas ya expiraron por sí solos, sin volver a
  -- decodificar cada JWT. Ese job de limpieza queda deliberadamente FUERA de esta
  -- migración (ninguna vertical de este monorepo tiene todavía un cron/scheduled job
  -- real, ver `docs/REQUISITOS.md`) — la tabla crece con cada logout explícito, nunca
  -- con cada login/refresh, así que su tamaño es acotado por el uso real del botón,
  -- no por el tráfico de la API.
  expires_at timestamptz not null
);

create index revoked_refresh_token_user_idx on core.revoked_refresh_token (user_id);

alter table core.revoked_refresh_token enable row level security;

revoke all on core.revoked_refresh_token from public, anon, authenticated;
grant all on core.revoked_refresh_token to service_role;

-- `security definer`: corre con el privilegio del DUEÑO de la función, no con el del
-- rol `authenticated` sin `auth.uid()` que la invoca (mismo principio que
-- `core.accept_staff_invite`). Bloqueada con `set search_path = core, pg_temp` y sin
-- ningún parámetro que termine en SQL dinámico — superficie de inyección nula, todo
-- son placeholders con tipo fijo.
create or replace function core.revoke_refresh_token(p_jti uuid, p_user_id uuid, p_expires_at timestamptz)
returns void
language sql
security definer
set search_path = core, pg_temp
as $$
  insert into core.revoked_refresh_token (jti, user_id, expires_at)
  values (p_jti, p_user_id, p_expires_at)
  on conflict (jti) do nothing;
$$;

create or replace function core.is_refresh_token_revoked(p_jti uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select exists (select 1 from core.revoked_refresh_token where jti = p_jti);
$$;

revoke all on function core.revoke_refresh_token(uuid, uuid, timestamptz) from public;
revoke all on function core.is_refresh_token_revoked(uuid) from public;
-- Mismo rol que login/accept-invite corren bajo `ManagedPostgresEngine.withAppSession`
-- (siempre `set local role authenticated`, con o sin `auth.uid()` real) — nunca
-- `anon`, este monorepo no usa ese rol.
grant execute on function core.revoke_refresh_token(uuid, uuid, timestamptz) to authenticated;
grant execute on function core.is_refresh_token_revoked(uuid) to authenticated;
