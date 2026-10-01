-- L-02 (licitaciones, paridad de auth): sesiones activas del staff (listar y cerrar una a una)
-- y vinculacion/desvinculacion de cuentas de Google desde la propia cuenta.
--
-- Modelo de acceso (mismo patron que `0026_staff_totp_stepup_reset.sql`, `core.revoked_refresh_token`
-- y `core.staff_google_identity`): la tabla nueva tiene RLS habilitado y NINGUN GRANT directo para
-- `public`/`anon`/`authenticated` (denegacion explicita para cualquier consulta cruda). Todo acceso
-- pasa por funciones `security definer` con `set search_path = core, pg_temp`, `revoke ... from
-- public` y `grant execute` SOLO a `authenticated` (el rol bajo el que corre `withAppSession`, con
-- o sin `auth.uid()`); nunca a `anon`.
--
-- Hasta hoy el monorepo solo registraba refresh tokens REVOCADOS, nunca los emitidos
-- (`0006_revoke_all_sessions.sql`), por lo que no habia nada que listar. `core.staff_session` guarda
-- una fila por refresh token VIGENTE (id = `jti` del refresh token): una rotacion
-- (`POST /auth/refresh`) borra la fila anterior y crea la nueva heredando `started_at`, asi que la
-- tabla contiene como maximo una fila por sesion viva (no crece con cada refresh). Un refresh token
-- cerrado por logout o por corte masivo deja su fila hasta que vence (se filtra al listar y se purga
-- al registrar la siguiente sesion de ese usuario).
--
-- Dos familias de funciones, cada una con su guard:
--   * "solo sistema" (`register_staff_session`): exige `auth.uid() is null` (42501 si no).
--     Justificacion: se llama al EMITIR una sesion (login, refresh, canje de codigo), momento en
--     el que todavia no hay sesion autenticada; una sesion con `auth.uid()` real nunca debe poder
--     fabricar filas de sesion de otra cuenta (llenaria su lista con sesiones falsas).
--   * "atadas al usuario" (`list_staff_sessions`, `revoke_staff_session`, `list_google_identities`,
--     `unlink_google_identity`): exigen `auth.uid() = p_staff_id`. Justificacion: son acciones de la
--     propia cuenta ya autenticada; sin el guard cualquier sesion `authenticated` podria enumerar
--     los dispositivos o las identidades de Google de OTRA cuenta, cerrar sus sesiones o
--     desvincular su Google llamando la funcion por RPC directo. `revoke_staff_session` solo
--     alcanza filas con `staff_user_id = p_staff_id` (otro id de sesion -> false, indistinguible
--     de "no existe").
--
-- El access token ya emitido de una sesion cerrada sigue vivo hasta su propio `exp` (JWT stateless,
-- mismo trade-off que logout/rotacion de `0003`); lo que se corta de inmediato es el refresh.
--
-- Vincular Google NO requiere funcion nueva: reutiliza `core.link_google_identity` (solo sistema,
-- `0012`) desde el callback OAuth, que ocurre sin sesion con `auth.uid()`; la identidad destino la
-- fija el `state` firmado que emitio una ruta autenticada.
--
-- Orden de despliegue: CUALQUIER ORDEN. El codigo TypeScript que consume estas funciones captura
-- SQLSTATE 42883/42P01/42703 (migracion pendiente): el login/refresh siguen emitiendo sesion sin
-- registrarla, la lista responde "no disponible aun" y vincular Google queda sin desvincular.

create table core.staff_session (
  -- jti del refresh token vigente de esta sesion.
  id uuid primary key,
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  -- Inicio de la sesion: se hereda en cada rotacion del refresh token.
  started_at timestamptz not null default now(),
  -- Emision del refresh token vigente (ultima actividad conocida: se renueva cada ~15 min).
  issued_at timestamptz not null default now(),
  -- Expiracion natural del refresh token (claim `exp`).
  expires_at timestamptz not null,
  -- Navegador/dispositivo, recortado a 200 caracteres. Sin IP a proposito (dato personal sin uso
  -- operativo en esta pantalla).
  user_agent text check (user_agent is null or length(user_agent) <= 200)
);

create index staff_session_staff_idx on core.staff_session (staff_user_id, issued_at desc);

alter table core.staff_session enable row level security;
revoke all on core.staff_session from public, anon, authenticated;

-- Registra la sesion recien emitida. Si `p_replaces_jti` es una sesion VIVA de la misma cuenta (rotacion),
-- la borra y hereda su `started_at`. Purga filas vencidas de la cuenta y limita a 50 las vivas
-- (las mas viejas se descartan) para que la tabla este acotada por cuenta.
create or replace function core.register_staff_session(
  p_staff_id uuid, p_jti uuid, p_expires_at timestamptz, p_user_agent text, p_replaces_jti uuid default null
)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_started timestamptz := now();
begin
  if auth.uid() is not null then
    raise exception 'register_staff_session: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_jti is null or p_staff_id is null or p_expires_at is null then
    raise exception 'register_staff_session: parametros requeridos' using errcode = '22023';
  end if;
  if p_replaces_jti is not null then
    delete from core.staff_session
     where id = p_replaces_jti and staff_user_id = p_staff_id
     returning started_at into v_started;
    v_started := coalesce(v_started, now());
  end if;
  delete from core.staff_session where staff_user_id = p_staff_id and expires_at <= now();
  insert into core.staff_session (id, staff_user_id, started_at, issued_at, expires_at, user_agent)
  values (p_jti, p_staff_id, v_started, now(), p_expires_at, left(p_user_agent, 200))
  on conflict (id) do nothing;
  delete from core.staff_session
   where staff_user_id = p_staff_id
     and id in (select id from core.staff_session where staff_user_id = p_staff_id order by issued_at desc offset 50);
end;
$$;

-- Sesiones vivas de la propia cuenta: no vencidas, no revocadas por logout/cierre y emitidas despues del
-- ultimo corte masivo (`sessions_revoked_at`).
create or replace function core.list_staff_sessions(p_staff_id uuid)
returns table (id uuid, started_at timestamptz, issued_at timestamptz, expires_at timestamptz, user_agent text)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'list_staff_sessions: solo la propia cuenta' using errcode = '42501';
  end if;
  return query
    select s.id, s.started_at, s.issued_at, s.expires_at, s.user_agent
      from core.staff_session s
      join core.staff_user su on su.id = s.staff_user_id
     where s.staff_user_id = p_staff_id
       and s.expires_at > now()
       and (su.sessions_revoked_at is null or s.issued_at >= su.sessions_revoked_at)
       and not exists (select 1 from core.revoked_refresh_token r where r.jti = s.id)
     order by s.issued_at desc;
end;
$$;

-- Cierra UNA sesion de la propia cuenta: revoca su refresh token y borra la fila. false si no existe o
-- no es de la cuenta (nunca se distingue cual).
create or replace function core.revoke_staff_session(p_staff_id uuid, p_session_id uuid)
returns boolean
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_expires timestamptz;
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'revoke_staff_session: solo la propia cuenta' using errcode = '42501';
  end if;
  delete from core.staff_session
   where id = p_session_id and staff_user_id = p_staff_id
   returning expires_at into v_expires;
  if v_expires is null then
    return false;
  end if;
  insert into core.revoked_refresh_token (jti, user_id, expires_at)
  values (p_session_id, p_staff_id, v_expires)
  on conflict (jti) do nothing;
  return true;
end;
$$;

-- Identidades de Google vinculadas a la propia cuenta (nunca devuelve `provider_sub`).
create or replace function core.list_google_identities(p_staff_id uuid)
returns table (id uuid, email text, created_at timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'list_google_identities: solo la propia cuenta' using errcode = '42501';
  end if;
  return query
    select g.id, g.email, g.created_at from core.staff_google_identity g
     where g.staff_user_id = p_staff_id order by g.created_at;
end;
$$;

-- Desvincula una identidad de Google de la propia cuenta. false si no existe o es de otra cuenta. La ruta
-- exige la contrasena actual ANTES de llamar esto.
create or replace function core.unlink_google_identity(p_staff_id uuid, p_identity_id uuid)
returns boolean
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_deleted int;
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'unlink_google_identity: solo la propia cuenta' using errcode = '42501';
  end if;
  delete from core.staff_google_identity where id = p_identity_id and staff_user_id = p_staff_id;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function core.register_staff_session(uuid, uuid, timestamptz, text, uuid) from public;
revoke all on function core.list_staff_sessions(uuid) from public;
revoke all on function core.revoke_staff_session(uuid, uuid) from public;
revoke all on function core.list_google_identities(uuid) from public;
revoke all on function core.unlink_google_identity(uuid, uuid) from public;

grant execute on function core.register_staff_session(uuid, uuid, timestamptz, text, uuid) to authenticated;
grant execute on function core.list_staff_sessions(uuid) to authenticated;
grant execute on function core.revoke_staff_session(uuid, uuid) to authenticated;
grant execute on function core.list_google_identities(uuid) to authenticated;
grant execute on function core.unlink_google_identity(uuid, uuid) to authenticated;
