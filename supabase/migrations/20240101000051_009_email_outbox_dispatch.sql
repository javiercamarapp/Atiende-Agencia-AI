-- Fase 6 §3 — motor de envío real (fail-closed) del canal `email` de
-- `citas.messaging_outbox` (003_waitlist_and_rate_limit.sql ya trae la tabla + el
-- encolado genérico `enqueue_messaging_outbox`; lo que faltaba era CÓMO se drena).
-- Puerto de negocio de citas-reservaciones/supabase/functions/messaging-dispatcher/
-- (claim_messaging_outbox_batch/complete_messaging_outbox del origen), ACOTADO
-- deliberadamente a channel='email' — el dispatcher de WhatsApp saliente real es un
-- problema de plataforma compartido que se está construyendo por separado en otra
-- rama (ver encargo de Fase 6): estas dos funciones nunca tocan una fila
-- channel='whatsapp', así que no hay colisión posible con ese trabajo en paralelo.
--
-- `attempts`/`last_error` no existían todavía en messaging_outbox (003 solo
-- modela 'pending'|'processing'|'sent'|'failed'|'dead' sin contador) — se agregan
-- aquí porque el dispatcher de correo real (domain-citas/src/email-dispatch.ts)
-- necesita un backoff con tope real, mismo criterio que
-- `google_sync_attempts`/MAX_SYNC_ATTEMPTS de Fase 3.

alter table citas.messaging_outbox add column attempts integer not null default 0 check (attempts >= 0);
alter table citas.messaging_outbox add column last_error text;

-- Tope real de reintentos del dispatcher de correo (ver
-- domain-citas/src/email-dispatch.ts::MAX_EMAIL_DISPATCH_ATTEMPTS) — mismo valor
-- que MAX_SYNC_ATTEMPTS de Fase 3 por consistencia, sin que ninguno dependa del
-- otro.
create or replace function citas.claim_email_outbox_batch(p_limit integer default 25)
returns setof citas.messaging_outbox
language sql
security definer
set search_path = citas
as $$
  update citas.messaging_outbox
  set status = 'processing', attempts = attempts + 1
  where id in (
    select id from citas.messaging_outbox
    where channel = 'email'
      and status in ('pending', 'failed')
      and attempts < 5
    order by created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
$$;

create or replace function citas.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = citas
as $$
begin
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update citas.messaging_outbox
  set status = p_status, last_error = left(p_error, 500)
  where id = p_id and channel = 'email';
end;
$$;

revoke all on function citas.claim_email_outbox_batch(integer) from public, anon, authenticated;
revoke all on function citas.complete_email_outbox_job(uuid, text, text) from public, anon, authenticated;
grant execute on function citas.claim_email_outbox_batch(integer) to service_role;
grant execute on function citas.complete_email_outbox_job(uuid, text, text) to service_role;
