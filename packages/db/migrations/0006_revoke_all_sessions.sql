-- Hallazgo de auditoría (rubro 2, autenticación y sesión, severidad ALTA): no había
-- forma de invalidar TODAS las sesiones activas de un staff (ej. tras cambio de
-- contraseña o sospecha real de compromiso de una cuenta). `POST /auth/logout`
-- (`0003_refresh_token_revocation.sql`) ya revoca refresh tokens, pero UNO a la vez
-- (por su `jti` concreto) -- nunca "todos los que ese usuario tenga en circulación",
-- porque `core.revoked_refresh_token` solo registra `jti`s explícitamente revocados,
-- nunca los emitidos (este monorepo no mantiene ninguna tabla de sesiones activas que
-- enumerar).
--
-- Esta migración cierra ese hueco con un corte por FECHA en vez de por `jti`
-- individual: `core.staff_user.sessions_revoked_at` (nullable, `null` = nunca se pidió
-- una revocación masiva) es el instante desde el cual CUALQUIER refresh token con
-- `iat` (fecha de emisión) anterior se trata como revocado, sin importar si su `jti`
-- específico está en `core.revoked_refresh_token`. `POST /auth/refresh`
-- (`apps/api/src/routes/auth.ts`) valida esto contra el claim `iat` del refresh token
-- (agregado a `RefreshTokenClaims` en la misma pasada,
-- `packages/core-auth/src/jwt.ts`) ADEMÁS del chequeo existente por `jti` -- ambos
-- mecanismos conviven, ninguno reemplaza al otro (un logout selectivo de UNA sesión
-- sigue funcionando igual después de esta migración).
--
-- Trade-off documentado honestamente (mismo criterio que el resto de este monorepo:
-- documentar el límite, no esconderlo): la comparación es a nivel de SEGUNDO (`iat`
-- de un JWT no trae más precisión que epoch seconds), así que un login que ocurra en
-- el MISMO segundo que la llamada a `core.revoke_all_refresh_tokens` para ese usuario
-- puede, en el peor caso, quedar invalidado de inmediato -- una ventana de servidor
-- menor a 1 segundo, no un hueco de seguridad (el usuario simplemente reintenta
-- login). Deliberadamente FUERA de esta migración: revocar las sesiones de OTRO
-- usuario (un endpoint de administrador tipo "cerrar la sesión de este empleado") --
-- la ruta nueva (`POST /auth/revoke-sessions`) es siempre self-service, autenticada,
-- y siempre pasa `auth.uid()`/`c.get("userId")` propio, nunca un id recibido del body.
--
-- `core.revoke_all_refresh_tokens`: mismo patrón `security definer` que
-- `core.revoke_refresh_token`/`core.accept_staff_invite` de migraciones previas --
-- `authenticated` (sesión de sistema O sesión real por-request, nunca `service_role`,
-- que este monorepo no aprovisiona) solo tiene GRANT de SELECT sobre
-- `core.staff_user` (ver `0001_core_schema.sql`), nunca UPDATE.

alter table core.staff_user add column sessions_revoked_at timestamptz;

create or replace function core.revoke_all_refresh_tokens(p_user_id uuid)
returns void
language sql
security definer
set search_path = core, pg_temp
as $$
  update core.staff_user set sessions_revoked_at = now() where id = p_user_id;
$$;

revoke all on function core.revoke_all_refresh_tokens(uuid) from public;
-- Mismo rol que el resto de las rutas de auth corren bajo
-- `ManagedPostgresEngine.withAppSession` (siempre `set local role authenticated`, con
-- o sin `auth.uid()` real) -- nunca `anon`, este monorepo no usa ese rol.
grant execute on function core.revoke_all_refresh_tokens(uuid) to authenticated;
