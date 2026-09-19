-- Hallazgo de auditoría (severidad CRÍTICA, auditoría de fusión 2026-09-18):
-- mismo bug raíz que ya cerraron 016_email_outbox_authenticated_grants.sql
-- (outbox de correo) y 017_rpc_anti_duplicado_authenticated_grants.sql
-- (whatsapp inbound/rate-limit) -- `packages/db/src/managed-postgres-engine.ts
-- ::withAppSession` SIEMPRE conecta como `set local role authenticated`, este
-- monorepo nunca aprovisiona `service_role` contra Postgres real.
--
-- `claim_messaging_outbox_batch`/`complete_messaging_outbox_{sent,retry,dead}`
-- (migrations/008_messaging_outbox.sql, el dispatcher de WhatsApp SALIENTE)
-- quedaron fuera de esas dos rondas de fix -- verificado que siguen con
-- `grant execute ... to service_role;` a secas en el HEAD actual. Mismo
-- llamador único que la versión de citas (`apps/api/src/routes/internal/
-- whatsapp-dispatch.ts`, ruta de PLATAFORMA gateada por secreto compartido,
-- SIEMPRE `deps.engine.withAppSession({ userId: null }, ...)`) -- verificación
-- interna "auth.uid() is null" a secas, mismo criterio ya usado en
-- 017_rpc_anti_duplicado_authenticated_grants.sql.

create or replace function hoteles.claim_messaging_outbox_batch(
  p_limit integer, p_lease_seconds integer default 120
) returns setof hoteles.messaging_outbox
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_messaging_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'invalid claim limit'; end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'invalid lease seconds'; end if;

  return query
    update hoteles.messaging_outbox
    set status = 'processing', claimed_at = now()
    where id in (
      select id from hoteles.messaging_outbox
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

create or replace function hoteles.complete_messaging_outbox_sent(p_id uuid) returns void
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_messaging_outbox_sent es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update hoteles.messaging_outbox set status = 'sent', sent_at = now()
  where id = p_id and status = 'processing';
end;
$$;

create or replace function hoteles.complete_messaging_outbox_retry(
  p_id uuid, p_attempts integer, p_error_class text, p_next_attempt_at timestamptz
) returns void
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_messaging_outbox_retry es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update hoteles.messaging_outbox
  set status = 'pending', attempts = p_attempts, last_error_class = left(p_error_class, 120), next_attempt_at = p_next_attempt_at, claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

create or replace function hoteles.complete_messaging_outbox_dead(
  p_id uuid, p_attempts integer, p_error_class text
) returns void
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_messaging_outbox_dead es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update hoteles.messaging_outbox
  set status = 'dead', attempts = p_attempts, last_error_class = left(p_error_class, 120), claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

grant execute on function hoteles.claim_messaging_outbox_batch(integer, integer) to authenticated;
grant execute on function hoteles.complete_messaging_outbox_sent(uuid) to authenticated;
grant execute on function hoteles.complete_messaging_outbox_retry(uuid, integer, text, timestamptz) to authenticated;
grant execute on function hoteles.complete_messaging_outbox_dead(uuid, integer, text) to authenticated;
