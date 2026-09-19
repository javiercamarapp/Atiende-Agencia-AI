-- Hallazgo de auditoría (rubro 15 de la lista de 22, severidad P2: "exposición de
-- tokens de sesión completos en query params de URL (Google OAuth y magic-link) --
-- riesgo de filtración vía Referer/historial/logs de servidor"). Hasta esta
-- migración, `GET /auth/google/callback` (`..._0008_staff_google_identity.sql`) y
-- `GET /auth/magic-link/verify` (`0009_magic_link_login.sql`) ponían el JWT de acceso
-- REAL y su refresh token, ya usables, directamente como query params del redirect
-- 302 hacia el frontend (`/${vertical}/auth/google/callback?token=...&refreshToken=
-- ...`) -- quedaban en el historial del navegador, se filtraban en el header
-- `Referer` si esa página cargaba cualquier recurso de terceros, y normalmente
-- terminan en logs de acceso de servidores/CDNs/proxies intermedios que registran
-- la URL completa de cada request (Vercel, analítica, etc.).
--
-- Fix: patrón "authorization code" -- ambos callbacks ahora ponen en la URL un
-- código de intercambio OPACO, de un solo uso y vida muy corta (60s, ver
-- `EXCHANGE_CODE_TTL_MS` en `apps/api/src/routes/auth.ts`), nunca el token real.
-- El frontend (`GoogleCallback.tsx`) lo canjea de inmediato vía
-- `POST /auth/exchange-code`, que devuelve `{token, refreshToken, ...}` en el BODY
-- de una respuesta JSON -- nunca en otra URL/redirect.
--
-- Mismo mecanismo EXACTO que `core.magic_link_token` (reutiliza
-- `@atiende/core-auth::generateInviteToken`/`hashInviteToken` -- token aleatorio de
-- 32 bytes, solo se persiste el hash SHA-256, nunca el código en texto plano) en vez
-- de inventar un tercer esquema de token de un solo uso para lo mismo. Diferencia
-- deliberada con `magic_link_token`: aquí NO se persiste ningún JWT -- solo el
-- `staff_user_id`, exactamente igual que magic-link -- el token/refreshToken reales
-- se generan recién en el momento del canje (`issueSession`, siempre fresco contra
-- las membresías actuales), nunca se guardan en esta tabla.
create table core.auth_exchange_code (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  code_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','used','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index auth_exchange_code_staff_idx on core.auth_exchange_code (staff_user_id);
-- Limpieza futura opcional (purgar filas viejas) -- ningún job la usa todavía,
-- mismo estado que `core.magic_link_token`/`core.revoked_refresh_token` (se
-- documenta el gap, no se inventa un cron para esto en este pase; a 60s de TTL el
-- volumen de filas muertas es mínimo comparado con magic_link_token de 15min).
create index auth_exchange_code_expires_idx on core.auth_exchange_code (expires_at);

alter table core.auth_exchange_code enable row level security;

-- Mismo criterio que `core.magic_link_token`/`core.staff_google_identity`: este
-- monorepo no aprovisiona `service_role` -- acceso exclusivamente vía las dos
-- funciones `security definer` de abajo, RLS habilitado + sin GRANT directo es
-- denegación explícita para cualquier query cruda.
revoke all on core.auth_exchange_code from public, anon, authenticated;

create or replace function core.create_auth_exchange_code(p_staff_id uuid, p_code_hash text, p_expires_at timestamptz)
returns void
language sql security definer set search_path = core, pg_temp
as $$
  insert into core.auth_exchange_code (staff_user_id, code_hash, expires_at)
  values (p_staff_id, p_code_hash, p_expires_at);
$$;

revoke all on function core.create_auth_exchange_code(uuid, text, timestamptz) from public;
grant execute on function core.create_auth_exchange_code(uuid, text, timestamptz) to authenticated;

-- Consumo atómico: la fila solo pasa a 'used' si TODAVÍA estaba 'pending' y no
-- había vencido -- un código repetido (replay, ej. si alguien capturó la URL de
-- todas formas) o vencido nunca resuelve a un staff, sin ventana de carrera entre
-- "leer" y "marcar usado" (mismo patrón exacto que
-- `core.consume_magic_link_token`/`core.accept_staff_invite`).
create or replace function core.consume_auth_exchange_code(p_code_hash text)
returns setof core.staff_user
language sql security definer set search_path = core, pg_temp
as $$
  with consumido as (
    update core.auth_exchange_code
    set status = 'used', used_at = now()
    where code_hash = p_code_hash and status = 'pending' and expires_at > now()
    returning staff_user_id
  )
  select su.* from core.staff_user su join consumido c on c.staff_user_id = su.id;
$$;

revoke all on function core.consume_auth_exchange_code(text) from public;
grant execute on function core.consume_auth_exchange_code(text) to authenticated;
