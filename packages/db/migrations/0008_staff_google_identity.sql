-- H12a-fusion · REQ-LOGIN-GOOGLE: "Sign in with Google" para staff, las 6
-- verticales. Igual mecanismo real que ya prueba en producción atiende-hoteles
-- (Google OAuth 2.0 Authorization Code + PKCE, ver `apps/api/src/routes/
-- auth-google.ts` de este mismo pase) -- Google es SOLO un proveedor de
-- identidad, nunca reemplaza el JWT propio (ADR-004): tras verificar el
-- id_token, se emite la MISMA sesión que `POST /auth/login` ya emite hoy.
--
-- `core.staff_google_identity` vincula un `sub` (subject id, estable y único
-- por cuenta de Google) a un `core.staff_user` -- necesaria porque el correo
-- por sí solo no es una llave segura a largo plazo (un usuario podría, en
-- teoría, cambiar el correo asociado a su cuenta de Google sin que `sub`
-- cambie; guardar solo el correo forzaría a re-resolver por correo en cada
-- login, perdiendo la garantía de que sigue siendo la MISMA cuenta de Google
-- que se vinculó la primera vez).
--
-- Alcance de ESTE pase: solo `purpose=login` (staff YA existente, dado de alta
-- por invitación o registro con contraseña) -- iniciar sesión con Google
-- NUNCA da de alta una cuenta nueva por sí solo, mismo criterio que ya aplica
-- hoteles ("cuenta_no_invitada" -> rechazo explícito, ver auth-google.ts). El
-- auto-registro de una organización nueva vía Google (`purpose=registro`, que
-- hoteles sí implementa) queda fuera de este pase -- no hay todavía un flujo
-- de alta de organización genérico para las 6 verticales al que enganchar esa
-- rama (cada vertical tiene su propio criterio de qué significa "una
-- organización nueva").
--
-- Sin tabla de `oauth_state`: a diferencia de hoteles (que persiste
-- state/nonce/code_verifier en una tabla con consumo atómico de un solo uso),
-- este pase codifica esos tres valores + `purpose`/`vertical` en un JWT de
-- corta duración (10 min), firmado con el mismo `jwtSecret` de staff (ver
-- `packages/core-auth/src/google-oauth.ts::signOAuthState`/`verifyOAuthState`)
-- -- sin estado en el servidor, sin tabla nueva que limpiar. Trade-off
-- consciente: se pierde la garantía de "un solo uso" del `state` en sí (nada
-- impide reenviar el mismo `state` dos veces dentro de la ventana de 10 min),
-- pero el `code` de autorización que Google emite SÍ es de un solo uso del
-- lado de Google (un segundo intercambio con el mismo `code` es rechazado por
-- Google independientemente de este servidor) y el `nonce` embebido en el
-- `state` firmado se compara contra el `nonce` real del `id_token` devuelto
-- -- un atacante que solo capturó la URL de `state` (sin el `code` real de
-- Google, que viaja en un segundo parámetro separado y de un solo uso) no
-- puede completar un login con ella. Si en un futuro pase se requiere la
-- garantía de un solo uso real, migrar a una tabla con el mismo patrón que
-- `core.staff_invite`/`oauth_state` de hoteles.
create table core.staff_google_identity (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  -- Subject id de Google (claim `sub` del id_token) -- estable por cuenta de
  -- Google, único globalmente (ver comentario de cabecera).
  provider_sub text not null unique,
  email text not null,
  created_at timestamptz not null default now()
);

create index staff_google_identity_staff_user_idx on core.staff_google_identity (staff_user_id);

alter table core.staff_google_identity enable row level security;

-- Sin policy ni GRANT directo para `authenticated`: este monorepo NO
-- aprovisiona `service_role` (ver comentario de `core.revoke_all_refresh_tokens`
-- en `0006_revoke_all_sessions.sql`) -- la sesión de sistema del login
-- (`userId: null`) corre igual bajo el rol `authenticated`, solo que sin
-- `auth.uid()`. Acceso exclusivamente vía las dos funciones `security definer`
-- de abajo (mismo patrón que `core.accept_staff_invite`/
-- `core.revoke_all_refresh_tokens`) -- RLS habilitado + tabla sin GRANT directo
-- es denegación explícita para cualquier query cruda, incluida una futura ruta
-- que olvide pasar por estas funciones.
revoke all on core.staff_google_identity from public, anon, authenticated;

-- `find_staff_by_google_sub`: retorna el staff YA vinculado a este `sub` de
-- Google, o ninguna fila si esta cuenta de Google nunca se vinculó (el
-- adaptador TS lo mapea a `null`, ver `postgres-core-repository.ts`).
create or replace function core.find_staff_by_google_sub(p_sub text)
returns setof core.staff_user
language sql stable security definer set search_path = core, pg_temp
as $$
  select su.* from core.staff_user su
  join core.staff_google_identity gi on gi.staff_user_id = su.id
  where gi.provider_sub = p_sub;
$$;

revoke all on function core.find_staff_by_google_sub(text) from public;
grant execute on function core.find_staff_by_google_sub(text) to authenticated;

-- `link_google_identity`: vincula (o re-confirma, si `p_sub` ya estaba
-- vinculado a este MISMO staff) una cuenta de Google a un `core.staff_user` ya
-- existente. `on conflict` es por idempotencia normal (reintentos de red),
-- NUNCA para re-vincular un `sub` ya usado por OTRO staff -- `provider_sub` es
-- `unique`, así que un intento de vincularlo a un staff distinto lanza
-- (comportamiento correcto: una cuenta de Google no puede pertenecer a dos
-- staff a la vez).
create or replace function core.link_google_identity(p_staff_id uuid, p_sub text, p_email text)
returns void
language sql security definer set search_path = core, pg_temp
as $$
  insert into core.staff_google_identity (staff_user_id, provider_sub, email)
  values (p_staff_id, p_sub, p_email)
  on conflict (provider_sub) do update
    set email = excluded.email
    where core.staff_google_identity.staff_user_id = excluded.staff_user_id;
$$;

revoke all on function core.link_google_identity(uuid, text, text) from public;
grant execute on function core.link_google_identity(uuid, text, text) to authenticated;
