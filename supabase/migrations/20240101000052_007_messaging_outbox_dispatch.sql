-- Dispatcher REAL de messaging_outbox — la pieza que migrations/003 documentó
-- explícitamente como "fuera de alcance de Fase 1: el dispatcher que drena
-- messaging_outbox hacia Graph API real". Este archivo agrega SOLO lo que faltaba
-- para reclamar/cerrar filas (`claim_messaging_outbox_batch`,
-- `complete_messaging_outbox_sent`, `complete_messaging_outbox_retry`,
-- `complete_messaging_outbox_dead`) — el envío real vía HTTP vive en
-- @atiende/whatsapp-gateway (TS), nunca en SQL.
--
-- Mismo idioma de "claim con lease reclamable" que ya usan
-- `citas.claim_whatsapp_message`/`whatsapp_conversation_leases` (migrations/004):
-- una fila `pending` cuyo `next_attempt_at` ya se cumplió, o `processing` cuyo
-- lease expiró, es elegible; una fila `sent` o `dead` NUNCA vuelve a serlo — esa es
-- la garantía de idempotencia central de este cambio.

alter table citas.messaging_outbox
  add column if not exists attempts integer not null default 0 check (attempts >= 0),
  add column if not exists claimed_at timestamptz,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists sent_at timestamptz,
  add column if not exists last_error_class text check (last_error_class is null or length(last_error_class) <= 120);

-- El índice de despacho original (status, created_at) ya no basta para el filtro
-- real de `claim_messaging_outbox_batch` (channel + next_attempt_at) — se agrega
-- uno nuevo, se conserva el viejo (otros lectores/reportes lo siguen usando).
create index if not exists messaging_outbox_claim_idx
  on citas.messaging_outbox (channel, status, next_attempt_at)
  where status in ('pending', 'processing');

-- Reclama hasta p_limit mensajes de WhatsApp pendientes de envío, atómico vía
-- FOR UPDATE SKIP LOCKED (dos corridas concurrentes del job nunca reclaman la
-- misma fila). Devuelve el set completo de columnas que
-- @atiende/whatsapp-gateway::WhatsAppOutboundDispatcher necesita.
create or replace function citas.claim_messaging_outbox_batch(
  p_limit integer, p_lease_seconds integer default 120
) returns setof citas.messaging_outbox
language plpgsql security definer set search_path = citas as $$
begin
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

-- Envío confirmado — status = 'sent' para siempre. Guardado por id + status
-- 'processing' en el WHERE: si el lease ya expiró y otro worker reclamó esta fila
-- mientras tanto, esta llamada (tardía) no pisa el trabajo del nuevo dueño.
create or replace function citas.complete_messaging_outbox_sent(p_id uuid) returns void
language plpgsql security definer set search_path = citas as $$
begin
  update citas.messaging_outbox set status = 'sent', sent_at = now()
  where id = p_id and status = 'processing';
end;
$$;

-- Falla reintentable dentro del tope — vuelve a 'pending' con el `attempts`/
-- `next_attempt_at` YA calculados por el dispatcher (backoff exponencial capado,
-- ver @atiende/whatsapp-gateway::computeBackoffSeconds).
create or replace function citas.complete_messaging_outbox_retry(
  p_id uuid, p_attempts integer, p_error_class text, p_next_attempt_at timestamptz
) returns void
language plpgsql security definer set search_path = citas as $$
begin
  update citas.messaging_outbox
  set status = 'pending', attempts = p_attempts, last_error_class = left(p_error_class, 120), next_attempt_at = p_next_attempt_at, claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

-- Falla PERMANENTE — tope de intentos agotado, o error no reintentable
-- (payload inválido, 4xx de negocio de Graph API). Nunca se vuelve a reclamar.
create or replace function citas.complete_messaging_outbox_dead(
  p_id uuid, p_attempts integer, p_error_class text
) returns void
language plpgsql security definer set search_path = citas as $$
begin
  update citas.messaging_outbox
  set status = 'dead', attempts = p_attempts, last_error_class = left(p_error_class, 120), claimed_at = null
  where id = p_id and status = 'processing';
end;
$$;

revoke all on function citas.claim_messaging_outbox_batch(integer, integer) from public, anon, authenticated;
revoke all on function citas.complete_messaging_outbox_sent(uuid) from public, anon, authenticated;
revoke all on function citas.complete_messaging_outbox_retry(uuid, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function citas.complete_messaging_outbox_dead(uuid, integer, text) from public, anon, authenticated;
grant execute on function citas.claim_messaging_outbox_batch(integer, integer) to service_role;
grant execute on function citas.complete_messaging_outbox_sent(uuid) to service_role;
grant execute on function citas.complete_messaging_outbox_retry(uuid, integer, text, timestamptz) to service_role;
grant execute on function citas.complete_messaging_outbox_dead(uuid, integer, text) to service_role;
