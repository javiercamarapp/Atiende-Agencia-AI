-- Fase 2 (integridad) — "los reintentos de WhatsApp entrante no tienen tope, y
-- cada reintento de Meta vuelve a gastar un turno de LLM". `hoteles.
-- claim_whatsapp_message` (redefinida por última vez en
-- `017_rpc_anti_duplicado_authenticated_grants.sql`, sin cambios de fondo desde su
-- creación en `004_voz_whatsapp_fase2.sql`) re-reclama SIEMPRE un mensaje en
-- estado 'failed', sin importar cuántas veces ya se intentó: Meta reintenta un
-- webhook con 5xx/429 durante DÍAS (comportamiento documentado de Cloud API), y
-- `apps/api/src/routes/verticals/hoteles/whatsapp.ts` responde 500 mientras
-- `outcome.retryable` sea `true` (ver `handleInboundWhatsAppMessage`,
-- `packages/domain-hoteles/src/whatsapp/inbound.ts`) — cada uno de esos reintentos
-- vuelve a correr `turnHandler.handleInboundMessage` de punta a punta (llamada real
-- al LLM, gasto real), sin que el huésped reciba jamás una respuesta si la causa
-- del fallo es persistente (p. ej. el catch genérico que introdujo el PR #178).
--
-- Arreglo (mismo diseño que domain-restaurantes/migrations/020_whatsapp_retry_cap.sql):
--   1. `whatsapp_inbound_events.attempts` YA existe (desde 004) y YA se incrementa
--      atómicamente en cada claim — no hace falta agregar ninguna columna nueva.
--   2. `claim_whatsapp_message` deja de re-reclamar un mensaje 'failed' una vez que
--      `attempts` alcanza `v_max_attempts` (5 — mismo valor que
--      `MAX_EMAIL_DISPATCH_ATTEMPTS`/`attempts < 5` que este mismo repo ya trata
--      como razonable para un job que puede fallar por una causa transitoria real,
--      ver `014_email_outbox_dispatch.sql`).
--   3. Al agotar el tope, la función hace una transición EXPLÍCITA a un estado
--      terminal nuevo, `attempts_exhausted` (agregado al CHECK de `status` de esta
--      misma migración) — nunca deja el mensaje "silenciosamente" en 'failed' sin
--      que quede evidencia auditable de que se dejó de reintentar.
--
-- Por qué esto NO requiere ningún fallback de SQLSTATE 42883/42P01/42703 en
-- TypeScript (a diferencia de una migración que agrega una función/columna nueva):
-- el NOMBRE, los PARÁMETROS y el TIPO DE RETORNO de `claim_whatsapp_message` no
-- cambian — es un `CREATE OR REPLACE FUNCTION` sobre la misma firma
-- `(uuid, text, text) returns boolean` que `PostgresHotelesRepository.
-- claimWhatsAppMessage` ya invoca hoy. Contra un esquema de producción SIN esta
-- migración aplicada, la llamada SIGUE funcionando exactamente igual — solo que
-- con el comportamiento de HOY (sin tope) hasta que esta migración se despliegue,
-- nunca con un error de "función/columna no existe". Ver
-- `scripts/verify-hoteles-whatsapp-retry-cap/assertions.sql` escenario del
-- "esquema a medio migrar" para la prueba reproducible de ambos comportamientos
-- contra Postgres real.
alter table hoteles.whatsapp_inbound_events drop constraint whatsapp_inbound_events_status_check;
alter table hoteles.whatsapp_inbound_events add constraint whatsapp_inbound_events_status_check
  check (status in ('processing', 'processed', 'failed', 'attempts_exhausted'));

create or replace function hoteles.claim_whatsapp_message(
  p_property_id uuid,
  p_message_id text,
  p_phone_hash text
) returns boolean
language plpgsql
security definer
set search_path = hoteles
as $$
declare
  v_count integer;
  v_max_attempts constant integer := 5;
begin
  if auth.uid() is not null then
    raise exception 'claim_whatsapp_message es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_message_id is null or length(p_message_id) not between 1 and 255 or p_phone_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into hoteles.whatsapp_inbound_events(message_id, property_id, phone_hash)
  values (p_message_id, p_property_id, p_phone_hash)
  on conflict (message_id) do update
    set status = 'processing',
        attempts = whatsapp_inbound_events.attempts + 1,
        claimed_at = now(),
        last_error_class = null
  where whatsapp_inbound_events.property_id = excluded.property_id
    and (
      (whatsapp_inbound_events.status = 'failed' and whatsapp_inbound_events.attempts < v_max_attempts)
      or (whatsapp_inbound_events.status = 'processing' and whatsapp_inbound_events.claimed_at < now() - interval '5 minutes')
    );
  get diagnostics v_count = row_count;
  if v_count = 1 then
    return true;
  end if;

  -- No se reclamó. Si es porque el mensaje sigue 'failed' pero ya agotó el tope de
  -- intentos (la única rama nueva de la condición de arriba que puede rechazarlo
  -- sin que haya cambiado a otro estado mientras tanto), transición EXPLÍCITA a
  -- 'attempts_exhausted' — así el mensaje queda fuera del claim PARA SIEMPRE
  -- (ninguna rama de arriba hace match sobre ese estado) y la fila misma queda
  -- como evidencia auditable de que se dejó de reintentar, en vez de un "sigue en
  -- failed" indistinguible de "todavía reintentable". Acotado a
  -- `p_property_id`/`p_message_id` de este caller — nunca toca la fila de otra
  -- property (imposible de todos modos: `message_id` es la llave primaria y un
  -- mismatch de property_id ya lo excluyó de la rama de arriba).
  update hoteles.whatsapp_inbound_events
  set status = 'attempts_exhausted'
  where message_id = p_message_id
    and property_id = p_property_id
    and status = 'failed'
    and attempts >= v_max_attempts;

  return false;
end;
$$;

grant execute on function hoteles.claim_whatsapp_message(uuid, text, text) to authenticated;
