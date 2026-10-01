-- L-01 / L-02 (licitaciones, paridad de auth): segundo factor TOTP para el staff
-- (base del step-up de las transiciones sensibles del contrato), codigos de respaldo,
-- reset de contrasena, cambio de contrasena y verificacion de correo.
--
-- Modelo de acceso (mismo patron que `core.revoked_refresh_token`, `core.magic_link_token`,
-- `core.auth_exchange_code`): TODAS las tablas nuevas tienen RLS habilitado y NINGUN
-- GRANT directo para `public`/`anon`/`authenticated` (denegacion explicita para
-- cualquier consulta cruda). Todo acceso pasa por funciones `security definer` con
-- `set search_path = core, pg_temp`, `revoke ... from public` y `grant execute` SOLO a
-- `authenticated` (el rol bajo el que corre `withAppSession`, con o sin `auth.uid()`);
-- nunca a `anon`.
--
-- Dos familias de funciones, cada una con su guard:
--   * "atadas al usuario" (`totp_*`, `change_staff_password`): exigen
--     `auth.uid() = p_staff_id`. Justificacion: son acciones de la propia cuenta
--     ya autenticada; sin el guard cualquier sesion `authenticated` podria leer el
--     secreto cifrado, quemar intentos (lockout) o desactivar el 2FA de OTRO usuario
--     llamando la funcion por RPC directo.
--   * "solo sistema" (`create/consume_password_reset_token`,
--     `create/consume_email_verification_token`): exigen `auth.uid() is null`
--     (errcode 42501 si no). Justificacion: ocurren ANTES de que exista sesion (el
--     usuario olvido su contrasena / abre el enlace del correo); una sesion con
--     `auth.uid()` real nunca debe poder fabricar ni canjear tokens ajenos.
--
-- Contrasenas y sesiones: `change_staff_password` y `consume_password_reset_token`
-- fijan `sessions_revoked_at` (corte por fecha de `0006_revoke_all_sessions.sql`) al
-- INICIO del segundo actual (`date_trunc('second', now())`): cualquier refresh token
-- emitido en un segundo anterior queda revocado, y uno emitido justo despues (el
-- `iat` de un JWT solo tiene precision de segundo) NO queda invalidado por error.
--
-- Lockout del segundo factor: 5 intentos fallidos consecutivos bloquean la
-- verificacion 15 minutos (`totp_register_failure`). El contador y el bloqueo se
-- calculan en SQL (no por parametro) para que un cliente no pueda elegir limites mas
-- laxos. Anti-replay: `totp_register_success` solo acepta un paso (time-step)
-- estrictamente mayor al ultimo usado, de forma atomica.
--
-- Orden de despliegue: CUALQUIER ORDEN. El codigo TypeScript que consume estas
-- funciones captura SQLSTATE 42883/42P01/42703 (migracion pendiente) y degrada:
-- las rutas de 2FA responden 503 "no disponible aun" y las transiciones sensibles del
-- contrato siguen exigiendo `DECISION_ROLES` como hoy.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------

create table core.staff_totp (
  staff_user_id uuid primary key references core.staff_user(id) on delete cascade,
  -- AES-256-GCM (clave derivada del secreto de la app): una filtracion de la tabla
  -- sola no entrega secretos TOTP utilizables.
  secret_ciphertext text not null,
  -- null = alta iniciada pero sin confirmar (no cuenta como 2FA activo).
  confirmed_at timestamptz,
  last_used_step bigint,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table core.staff_backup_code (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  -- sha256 del codigo normalizado; el texto plano solo se muestra una vez.
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (staff_user_id, code_hash)
);

create index staff_backup_code_staff_idx on core.staff_backup_code (staff_user_id) where used_at is null;

create table core.password_reset_token (
  token_hash text primary key,
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index password_reset_token_staff_idx on core.password_reset_token (staff_user_id);

create table core.email_verification_token (
  token_hash text primary key,
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index email_verification_token_staff_idx on core.email_verification_token (staff_user_id);

alter table core.staff_totp enable row level security;
alter table core.staff_backup_code enable row level security;
alter table core.password_reset_token enable row level security;
alter table core.email_verification_token enable row level security;

revoke all on core.staff_totp from public, anon, authenticated;
revoke all on core.staff_backup_code from public, anon, authenticated;
revoke all on core.password_reset_token from public, anon, authenticated;
revoke all on core.email_verification_token from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Segundo factor (atadas al usuario: auth.uid() = p_staff_id)
-- ---------------------------------------------------------------------------

-- Estado publico: nunca devuelve el secreto.
create or replace function core.totp_get_status(p_staff_id uuid)
returns table (enrolled boolean, pending boolean, locked_until timestamptz, backup_codes_remaining integer)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_get_status: solo la propia cuenta' using errcode = '42501';
  end if;
  return query
    select
      coalesce(t.confirmed_at is not null, false),
      coalesce(t.confirmed_at is null and t.staff_user_id is not null, false),
      case when t.locked_until > now() then t.locked_until else null end,
      (select count(*)::int from core.staff_backup_code b where b.staff_user_id = p_staff_id and b.used_at is null)
    from (select 1) x
    left join core.staff_totp t on t.staff_user_id = p_staff_id;
end;
$$;

-- Secreto cifrado + estado de verificacion, para que el servidor lo descifre y compare.
create or replace function core.totp_get_secret(p_staff_id uuid)
returns table (secret_ciphertext text, confirmed boolean, last_used_step bigint, locked_until timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_get_secret: solo la propia cuenta' using errcode = '42501';
  end if;
  return query
    select t.secret_ciphertext, t.confirmed_at is not null, t.last_used_step,
           case when t.locked_until > now() then t.locked_until else null end
    from core.staff_totp t where t.staff_user_id = p_staff_id;
end;
$$;

-- Inicia (o reinicia) un alta SIN confirmar. Si ya hay un 2FA confirmado se rechaza
-- (P0001): hay que desactivarlo primero, con prueba de un segundo factor valido.
create or replace function core.totp_begin_enrollment(p_staff_id uuid, p_secret_ciphertext text)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_begin_enrollment: solo la propia cuenta' using errcode = '42501';
  end if;
  if p_secret_ciphertext is null or length(p_secret_ciphertext) = 0 then
    raise exception 'totp_begin_enrollment: secreto vacio' using errcode = '22023';
  end if;
  if exists (select 1 from core.staff_totp where staff_user_id = p_staff_id and confirmed_at is not null) then
    raise exception 'totp_begin_enrollment: ya hay un segundo factor activo' using errcode = 'P0001';
  end if;
  insert into core.staff_totp (staff_user_id, secret_ciphertext)
  values (p_staff_id, p_secret_ciphertext)
  on conflict (staff_user_id) do update
    set secret_ciphertext = excluded.secret_ciphertext,
        confirmed_at = null, last_used_step = null, failed_attempts = 0, locked_until = null, updated_at = now();
end;
$$;

-- Confirma el alta con el primer codigo valido (su paso se registra para anti-replay)
-- y guarda los codigos de respaldo (solo hashes) en la MISMA transaccion.
create or replace function core.totp_confirm_enrollment(p_staff_id uuid, p_step bigint, p_backup_hashes text[])
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_updated int;
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_confirm_enrollment: solo la propia cuenta' using errcode = '42501';
  end if;
  if p_backup_hashes is null or coalesce(array_length(p_backup_hashes, 1), 0) < 1 or array_length(p_backup_hashes, 1) > 20 then
    raise exception 'totp_confirm_enrollment: se requieren entre 1 y 20 codigos de respaldo' using errcode = '22023';
  end if;
  update core.staff_totp
     set confirmed_at = now(), last_used_step = p_step, failed_attempts = 0, locked_until = null, updated_at = now()
   where staff_user_id = p_staff_id and confirmed_at is null;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'totp_confirm_enrollment: no hay un alta pendiente' using errcode = 'P0001';
  end if;
  delete from core.staff_backup_code where staff_user_id = p_staff_id;
  insert into core.staff_backup_code (staff_user_id, code_hash)
  select p_staff_id, h from unnest(p_backup_hashes) as h;
end;
$$;

-- Registra un acierto: solo avanza si el paso es MAYOR al ultimo usado (anti-replay
-- atomico). Devuelve false si ya se uso ese paso (o uno posterior) o si esta bloqueado.
create or replace function core.totp_register_success(p_staff_id uuid, p_step bigint)
returns boolean
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_updated int;
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_register_success: solo la propia cuenta' using errcode = '42501';
  end if;
  update core.staff_totp
     set last_used_step = p_step, failed_attempts = 0, locked_until = null, updated_at = now()
   where staff_user_id = p_staff_id
     and (last_used_step is null or last_used_step < p_step)
     and (locked_until is null or locked_until <= now());
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- Registra un fallo: 5 consecutivos -> bloqueo de 15 min (limites fijos en SQL).
-- Devuelve el instante de desbloqueo si quedo (o ya estaba) bloqueado, si no null.
create or replace function core.totp_register_failure(p_staff_id uuid)
returns timestamptz
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_locked timestamptz;
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_register_failure: solo la propia cuenta' using errcode = '42501';
  end if;
  update core.staff_totp
     set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
         locked_until = case
           when locked_until is not null and locked_until > now() then locked_until
           when failed_attempts + 1 >= 5 then now() + interval '15 minutes'
           else locked_until end,
         updated_at = now()
   where staff_user_id = p_staff_id
   returning case when locked_until > now() then locked_until else null end into v_locked;
  return v_locked;
end;
$$;

-- Consume un codigo de respaldo (un solo uso, atomico). false si no existe, ya se uso
-- o el segundo factor esta bloqueado.
create or replace function core.totp_consume_backup_code(p_staff_id uuid, p_code_hash text)
returns boolean
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_updated int;
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_consume_backup_code: solo la propia cuenta' using errcode = '42501';
  end if;
  if exists (select 1 from core.staff_totp where staff_user_id = p_staff_id and locked_until > now()) then
    return false;
  end if;
  update core.staff_backup_code
     set used_at = now()
   where staff_user_id = p_staff_id and code_hash = p_code_hash and used_at is null
     and exists (select 1 from core.staff_totp t where t.staff_user_id = p_staff_id and t.confirmed_at is not null);
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- Regenera los codigos de respaldo (invalida los anteriores). Requiere 2FA confirmado.
create or replace function core.totp_replace_backup_codes(p_staff_id uuid, p_backup_hashes text[])
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_replace_backup_codes: solo la propia cuenta' using errcode = '42501';
  end if;
  if p_backup_hashes is null or coalesce(array_length(p_backup_hashes, 1), 0) < 1 or array_length(p_backup_hashes, 1) > 20 then
    raise exception 'totp_replace_backup_codes: se requieren entre 1 y 20 codigos de respaldo' using errcode = '22023';
  end if;
  if not exists (select 1 from core.staff_totp where staff_user_id = p_staff_id and confirmed_at is not null) then
    raise exception 'totp_replace_backup_codes: no hay segundo factor activo' using errcode = 'P0001';
  end if;
  delete from core.staff_backup_code where staff_user_id = p_staff_id;
  insert into core.staff_backup_code (staff_user_id, code_hash)
  select p_staff_id, h from unnest(p_backup_hashes) as h;
end;
$$;

-- Desactiva el 2FA (borra secreto y codigos). La prueba de un segundo factor valido
-- se exige en la ruta ANTES de llamar esto.
create or replace function core.totp_disable(p_staff_id uuid)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'totp_disable: solo la propia cuenta' using errcode = '42501';
  end if;
  delete from core.staff_backup_code where staff_user_id = p_staff_id;
  delete from core.staff_totp where staff_user_id = p_staff_id;
end;
$$;

-- Cambio de contrasena de la propia cuenta: fija el hash nuevo y corta TODAS las
-- sesiones previas (ver nota de `date_trunc` en la cabecera). La ruta verifica la
-- contrasena actual ANTES de llamar esto.
create or replace function core.change_staff_password(p_staff_id uuid, p_new_password_hash text)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_staff_id then
    raise exception 'change_staff_password: solo la propia cuenta' using errcode = '42501';
  end if;
  if p_new_password_hash is null or p_new_password_hash !~ '^scrypt\$' then
    raise exception 'change_staff_password: hash invalido' using errcode = '22023';
  end if;
  update core.staff_user
     set password_hash = p_new_password_hash, sessions_revoked_at = date_trunc('second', now())
   where id = p_staff_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reset de contrasena y verificacion de correo (solo sistema: auth.uid() is null)
-- ---------------------------------------------------------------------------

create or replace function core.create_password_reset_token(p_staff_id uuid, p_token_hash text, p_expires_at timestamptz)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'create_password_reset_token: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  -- Un solo enlace vivo por usuario: pedir otro invalida los pendientes.
  update core.password_reset_token set used_at = now() where staff_user_id = p_staff_id and used_at is null;
  insert into core.password_reset_token (token_hash, staff_user_id, expires_at) values (p_token_hash, p_staff_id, p_expires_at);
end;
$$;

-- Canje atomico: marca usado, fija la contrasena nueva, corta todas las sesiones y
-- da por verificado el correo (el usuario demostro controlarlo). Devuelve el id o null
-- (inexistente, ya usado o vencido: nunca se distingue cual).
create or replace function core.consume_password_reset_token(p_token_hash text, p_new_password_hash text)
returns uuid
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_staff uuid;
begin
  if auth.uid() is not null then
    raise exception 'consume_password_reset_token: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_new_password_hash is null or p_new_password_hash !~ '^scrypt\$' then
    raise exception 'consume_password_reset_token: hash invalido' using errcode = '22023';
  end if;
  update core.password_reset_token
     set used_at = now()
   where token_hash = p_token_hash and used_at is null and expires_at > now()
   returning staff_user_id into v_staff;
  if v_staff is null then
    return null;
  end if;
  update core.staff_user
     set password_hash = p_new_password_hash,
         sessions_revoked_at = date_trunc('second', now()),
         email_verified_at = coalesce(email_verified_at, now())
   where id = v_staff;
  update core.password_reset_token set used_at = now() where staff_user_id = v_staff and used_at is null;
  return v_staff;
end;
$$;

create or replace function core.create_email_verification_token(p_staff_id uuid, p_token_hash text, p_expires_at timestamptz)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'create_email_verification_token: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  update core.email_verification_token set used_at = now() where staff_user_id = p_staff_id and used_at is null;
  insert into core.email_verification_token (token_hash, staff_user_id, expires_at) values (p_token_hash, p_staff_id, p_expires_at);
end;
$$;

create or replace function core.consume_email_verification_token(p_token_hash text)
returns uuid
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_staff uuid;
begin
  if auth.uid() is not null then
    raise exception 'consume_email_verification_token: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  update core.email_verification_token
     set used_at = now()
   where token_hash = p_token_hash and used_at is null and expires_at > now()
   returning staff_user_id into v_staff;
  if v_staff is null then
    return null;
  end if;
  update core.staff_user set email_verified_at = coalesce(email_verified_at, now()) where id = v_staff;
  return v_staff;
end;
$$;

-- ---------------------------------------------------------------------------
-- GRANTs: solo `authenticated` ejecuta; nunca public/anon.
-- ---------------------------------------------------------------------------

revoke all on function core.totp_get_status(uuid) from public;
revoke all on function core.totp_get_secret(uuid) from public;
revoke all on function core.totp_begin_enrollment(uuid, text) from public;
revoke all on function core.totp_confirm_enrollment(uuid, bigint, text[]) from public;
revoke all on function core.totp_register_success(uuid, bigint) from public;
revoke all on function core.totp_register_failure(uuid) from public;
revoke all on function core.totp_consume_backup_code(uuid, text) from public;
revoke all on function core.totp_replace_backup_codes(uuid, text[]) from public;
revoke all on function core.totp_disable(uuid) from public;
revoke all on function core.change_staff_password(uuid, text) from public;
revoke all on function core.create_password_reset_token(uuid, text, timestamptz) from public;
revoke all on function core.consume_password_reset_token(text, text) from public;
revoke all on function core.create_email_verification_token(uuid, text, timestamptz) from public;
revoke all on function core.consume_email_verification_token(text) from public;

grant execute on function core.totp_get_status(uuid) to authenticated;
grant execute on function core.totp_get_secret(uuid) to authenticated;
grant execute on function core.totp_begin_enrollment(uuid, text) to authenticated;
grant execute on function core.totp_confirm_enrollment(uuid, bigint, text[]) to authenticated;
grant execute on function core.totp_register_success(uuid, bigint) to authenticated;
grant execute on function core.totp_register_failure(uuid) to authenticated;
grant execute on function core.totp_consume_backup_code(uuid, text) to authenticated;
grant execute on function core.totp_replace_backup_codes(uuid, text[]) to authenticated;
grant execute on function core.totp_disable(uuid) to authenticated;
grant execute on function core.change_staff_password(uuid, text) to authenticated;
grant execute on function core.create_password_reset_token(uuid, text, timestamptz) to authenticated;
grant execute on function core.consume_password_reset_token(text, text) to authenticated;
grant execute on function core.create_email_verification_token(uuid, text, timestamptz) to authenticated;
grant execute on function core.consume_email_verification_token(text) to authenticated;
