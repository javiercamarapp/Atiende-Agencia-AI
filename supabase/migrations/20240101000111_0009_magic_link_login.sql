-- REQ-LOGIN-MAGICLINK: inicio de sesión sin contraseña por enlace mágico, para
-- staff, las 6 verticales -- mismo criterio de UX que Likida (Google arriba,
-- "Continuar con correo" sin pedir contraseña abajo). Reutiliza EXACTAMENTE el
-- mismo mecanismo de token de un solo uso que `core.staff_invite`
-- (`@atiende/core-auth::generateInviteToken`/`hashInviteToken` -- token aleatorio
-- de 32 bytes, solo se persiste el hash SHA-256, nunca el token plano) en vez de
-- inventar un segundo esquema de token para lo mismo.
--
-- Igual que Google (ver `..._0008_staff_google_identity.sql`): "Sign in" nunca
-- da de alta una cuenta nueva por sí solo -- si el correo no tiene ya un
-- `core.staff_user`, `POST /auth/magic-link/iniciar` responde el MISMO 200
-- genérico ("si ese correo existe, te enviamos un enlace") sin enviar nada,
-- mismo criterio anti-enumeración que ya usa `POST /auth/login` (mensaje 401
-- idéntico para contraseña incorrecta y correo inexistente).
--
-- Vida corta (15 min) + consumo atómico de un solo uso (`status` pending ->
-- used dentro del mismo UPDATE, mismo patrón que `core.accept_staff_invite`) --
-- un enlace reenviado o interceptado después de usarse una vez, o tras 15 min,
-- nunca vuelve a servir.
create table core.magic_link_token (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','used','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index magic_link_token_staff_idx on core.magic_link_token (staff_user_id);
-- Limpieza futura opcional (purgar filas viejas) -- ningún job la usa todavía,
-- mismo estado que `core.revoked_refresh_token` (se documenta el gap, no se
-- inventa un cron para esto en este pase).
create index magic_link_token_expires_idx on core.magic_link_token (expires_at);

alter table core.magic_link_token enable row level security;

-- Mismo criterio que `core.staff_google_identity`: este monorepo no aprovisiona
-- `service_role` -- acceso exclusivamente vía las dos funciones `security
-- definer` de abajo, RLS habilitado + sin GRANT directo es denegación explícita
-- para cualquier query cruda.
revoke all on core.magic_link_token from public, anon, authenticated;

create or replace function core.create_magic_link_token(p_staff_id uuid, p_token_hash text, p_expires_at timestamptz)
returns void
language sql security definer set search_path = core, pg_temp
as $$
  insert into core.magic_link_token (staff_user_id, token_hash, expires_at)
  values (p_staff_id, p_token_hash, p_expires_at);
$$;

revoke all on function core.create_magic_link_token(uuid, text, timestamptz) from public;
grant execute on function core.create_magic_link_token(uuid, text, timestamptz) to authenticated;

-- Consumo atómico: la fila solo pasa a 'used' si TODAVÍA estaba 'pending' y no
-- había vencido -- un token repetido (replay) o vencido nunca resuelve a un
-- staff, sin ventana de carrera entre "leer" y "marcar usado" (mismo patrón
-- exacto que `core.accept_staff_invite`).
create or replace function core.consume_magic_link_token(p_token_hash text)
returns setof core.staff_user
language sql security definer set search_path = core, pg_temp
as $$
  with consumido as (
    update core.magic_link_token
    set status = 'used', used_at = now()
    where token_hash = p_token_hash and status = 'pending' and expires_at > now()
    returning staff_user_id
  )
  select su.* from core.staff_user su join consumido c on c.staff_user_id = su.id;
$$;

revoke all on function core.consume_magic_link_token(text) from public;
grant execute on function core.consume_magic_link_token(text) to authenticated;
