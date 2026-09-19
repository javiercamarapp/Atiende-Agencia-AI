-- Hallazgo de auditoría (severidad CRÍTICA, "12 funciones SQL de outbox de
-- WhatsApp (citas/hoteles/restaurantes) con GRANT solo a service_role" + "2
-- funciones de refresh token de Google Calendar", auditoría de fusión
-- 2026-09-18): mismo bug raíz que ya cerraron 014/016/012_email_outbox_
-- authenticated_grants.sql (email) y 015/017/013_rpc_anti_duplicado_
-- authenticated_grants.sql (citas/hoteles.appointments/whatsapp inbound) --
-- `packages/db/src/managed-postgres-engine.ts::withAppSession` SIEMPRE conecta
-- como `set local role authenticated`, este monorepo nunca aprovisiona
-- `service_role` contra Postgres real -- cualquier función `security definer`
-- cuyo único GRANT EXECUTE sea a `service_role` es literalmente inalcanzable en
-- producción.
--
-- A diferencia de los outbox de EMAIL (ya cerrados) y las RPC de citas/
-- appointments/whatsapp-inbound (ya cerradas), el dispatcher de WhatsApp
-- (`claim_messaging_outbox_batch`/`complete_messaging_outbox_{sent,retry,dead}`,
-- migrations/007_messaging_outbox_dispatch.sql) y el par de funciones de
-- Google Calendar (`set_provider_calendar_refresh_token`/
-- `get_provider_calendar_refresh_token`, migrations/005_google_calendar_sync.sql)
-- quedaron fuera de esas dos rondas de fix -- verificado que siguen con
-- `grant execute ... to service_role;` a secas en el HEAD actual.
--
-- Verificado con `grep -rn` sobre `apps/api/src`/`packages/domain-citas/src`
-- (antes de decidir la verificación interna a agregar -- nunca un GRANT plano
-- sin reponer la autorización que la policy de RLS bypasseada habría exigido):
-- las 4 funciones de dispatch SOLO se llaman desde
-- `apps/api/src/routes/internal/whatsapp-dispatch.ts` (ruta de PLATAFORMA,
-- gateada por `internalOrCronSecretMatches`/`x-atiende-internal-secret` o
-- `Authorization: Bearer <CRON_SECRET>`, NUNCA por `authMiddleware`), que abre
-- `deps.engine.withAppSession({ userId: null }, ...)` -- sesión de sistema, sin
-- excepción. Las 2 funciones de calendario SOLO se llaman desde
-- `google-calendar-oauth.ts` (el callback público al que Google redirige
-- directo, "sin authMiddleware/dbSession, abre su propia sesión de sistema" --
-- comentario ya existente en ese archivo) y desde `calendar-sync.ts`
-- (reconciliación por cron) -- ninguna ruta de staff con JWT real las alcanza.
-- Mismo criterio "solo sesión de sistema" que ya usan `create_appointment_
-- idempotent`/`claim_whatsapp_message` etc. en 015_rpc_anti_duplicado_
-- authenticated_grants.sql: la verificación interna es "auth.uid() is null" a
-- secas.

create or replace function citas.claim_messaging_outbox_batch(
  p_limit integer, p_lease_seconds integer default 120
) returns setof citas.messaging_outbox
language plpgsql security definer set search_path = citas as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_messaging_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'invalid claim limit'; end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid lease seconds'; end if;

  return query
    update citas.messaging_outbox
    set status = 'processing', claimed_at = now()
    where id in (
      select id from citas.messaging_outbox
      where channel = 'whatsapp'
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'processing' and claimed_at < now() - make_interval(secs => p_lease_seconds))
        )
      order by created_at
      limit p_limit
      for update skip locked
    )
    returning *;
end;
$$;

create or replace function citas.complete_messaging_outbox_sent(p_id uuid) returns void
language plpgsql security definer set search_path = citas as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_messaging_outbox_sent es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update citas.messaging_outbox set status = 'sent', sent_at = now()
  where id = p_id and status = 'processing';
end;
$$;

create or replace function citas.complete_messaging_outbox_retry(
  p_id uuid, p_attempts integer, p_error_class text, p_next_attempt_at timestamptz
) returns void
language plpgsql security definer set search_path = citas as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_messaging_outbox_retry es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update citas.messaging_outbox
  set status = 'pending', attempts = p_attempts, last_error_class = left(p_error_class, 120), next_attempt_at = p_next_attempt_at, claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

create or replace function citas.complete_messaging_outbox_dead(
  p_id uuid, p_attempts integer, p_error_class text
) returns void
language plpgsql security definer set search_path = citas as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_messaging_outbox_dead es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update citas.messaging_outbox
  set status = 'dead', attempts = p_attempts, last_error_class = left(p_error_class, 120), claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

grant execute on function citas.claim_messaging_outbox_batch(integer, integer) to authenticated;
grant execute on function citas.complete_messaging_outbox_sent(uuid) to authenticated;
grant execute on function citas.complete_messaging_outbox_retry(uuid, integer, text, timestamptz) to authenticated;
grant execute on function citas.complete_messaging_outbox_dead(uuid, integer, text) to authenticated;

-- Google Calendar: mismo bug, mismo remedio -- ambas SOLO alcanzables desde
-- sesión de sistema (ver justificación de arriba).

create or replace function citas.set_provider_calendar_refresh_token(p_secret_id uuid, p_refresh_token text)
returns uuid
language plpgsql
security definer
set search_path = citas, vault, public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'set_provider_calendar_refresh_token es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_refresh_token is null or length(p_refresh_token) = 0 then
    raise exception 'refresh_token vacío' using errcode = 'AT400';
  end if;
  if p_secret_id is null then
    v_id := vault.create_secret(p_refresh_token, 'citas_provider_calendar_refresh_token_' || gen_random_uuid()::text, 'Fase 3 citas — refresh token OAuth de Google Calendar de un provider_calendar_accounts.');
  else
    perform vault.update_secret(p_secret_id, p_refresh_token);
    v_id := p_secret_id;
  end if;
  return v_id;
end;
$$;

create or replace function citas.get_provider_calendar_refresh_token(p_secret_id uuid)
returns text
language plpgsql
security definer
set search_path = citas, vault, public
as $$
declare
  v_token text;
begin
  if auth.uid() is not null then
    raise exception 'get_provider_calendar_refresh_token es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where id = p_secret_id;
  return v_token;
end;
$$;

grant execute on function citas.set_provider_calendar_refresh_token(uuid, text) to authenticated;
grant execute on function citas.get_provider_calendar_refresh_token(uuid) to authenticated;
