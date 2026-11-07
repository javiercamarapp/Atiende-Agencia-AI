-- Barredor de turnos HUERFANOS del webhook de WhatsApp de restaurantes (turno asincrono del cerebro v2).
-- Prefijo de supabase/migrations asignado: 20240101000492 (interno 192).
--
-- Contexto: con el turno asincrono el webhook responde 200 a Meta al confirmar la fase A (mensaje reclamado + turno de conversacion tomado) y el turno del
-- agente corre DESPUES (`waitUntil` de Vercel, 60 s). Si la funcion muere (timeout, crash) o la fase B falla, Meta ya no reintenta: el mensaje queda
-- 'processing' con el lease vencido o 'failed', y el cliente se quedaria sin respuesta hasta que vuelva a escribir. Esta funcion los RECLAMA de forma
-- atomica para que el barredor (`/internal/restaurantes/whatsapp/turnos-huerfanos` y el propio webhook al terminar su turno) los re-ejecute con
-- `responderTrasEspera`, que relee el historial y solo contesta lo pendiente (nunca dos veces).
--
-- Que agrega (1 funcion, 0 tablas):
--   restaurantes.reclamar_turnos_whatsapp_huerfanos(p_organization_id, p_todas, p_limite) -- SOLO SISTEMA. Toma hasta p_limite (1..10) mensajes de los
--   ultimos 10 min que esten 'processing' con mas de 90 s (el lease del turno asincrono: la funcion de 60 s ya murio) o 'failed' reintentable (intentos < 5,
--   y no un fallo de la fase A, que Meta si reintenta porque se le respondio 500), de organizaciones con cerebro_v2 (o de todas con p_todas). Los marca
--   'processing' con claimed_at = now() e intentos + 1 (mismo efecto que claim_whatsapp_message) con FOR UPDATE SKIP LOCKED: dos barredores concurrentes
--   nunca toman el mismo. Devuelve el telefono y el phone_number_id con que contestar (la tabla de eventos solo guarda el hash del telefono).
--
-- Compatibilidad: solo AGREGA una funcion; aplicarla no cambia nada de lo que ya corre. El TypeScript la llama en SAVEPOINT y trata 42883 como «barredor no
-- disponible» (no reclama nada). Requiere la 190 (columna cerebro_v2).
--
-- Justificacion de seguridad:
--   * `security definer` con search_path fijo (restaurantes, core, pg_temp): el rol de la API no tiene GRANT sobre whatsapp_inbound_events ni necesita
--     leer conversaciones de otras organizaciones; la funcion es la unica puerta y solo devuelve lo minimo para contestar (organizacion, mensaje,
--     telefono, sucursal, numero emisor).
--   * Exige auth.uid() IS NULL (solo la sesion de sistema de la API; un staff autenticado recibe 42501). `revoke` de public y anon; execute a
--     `authenticated` (la sesion de sistema corre con ese rol) y `service_role`.
--   * p_limite se acota a 1..10 y la ventana a 10 min: un barrido nunca recorre la tabla completa ni re-ejecuta mensajes viejos.
--   * El telefono sale de whatsapp_conversations de la MISMA organizacion del evento (sha256 del telefono = phone_hash del evento): nunca cruza tenants.

create or replace function restaurantes.reclamar_turnos_whatsapp_huerfanos(p_organization_id uuid, p_todas boolean, p_limite integer)
returns table (organization_id uuid, message_id text, phone text, property_id uuid, phone_number_id text)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.reclamar_turnos_whatsapp_huerfanos: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  return query
  with candidatos as (
    select e.message_id
    from restaurantes.whatsapp_inbound_events e
    where e.claimed_at >= now() - interval '10 minutes'
      and (p_organization_id is null or e.organization_id = p_organization_id)
      and (
        (e.status = 'processing' and e.claimed_at < now() - interval '90 seconds')
        or (
          e.status = 'failed'
          and e.attempts < 5
          and coalesce(e.last_error_class, '') not in ('RecepcionConEsperaFallo', 'ConversationBusy', 'HuerfanoSinConversacion')
        )
      )
      and (
        coalesce(p_todas, false)
        or exists (select 1 from restaurantes.agent_runtime_settings s where s.organization_id = e.organization_id and s.cerebro_v2)
      )
    order by e.claimed_at
    limit least(greatest(coalesce(p_limite, 1), 1), 10)
    for update of e skip locked
  ),
  reclamados as (
    update restaurantes.whatsapp_inbound_events ev
    set status = 'processing', attempts = ev.attempts + 1, claimed_at = now(), last_error_class = null
    from candidatos c
    where ev.message_id = c.message_id
    returning ev.organization_id as org, ev.message_id as mid, ev.phone_hash as hash
  )
  select r.org, r.mid, conv.phone, conv.property_id, coalesce(b.phone_number_id, o.phone_number_id)
  from reclamados r
  left join lateral (
    select cv.phone, cv.property_id
    from restaurantes.whatsapp_conversations cv
    where cv.organization_id = r.org and encode(sha256(convert_to(cv.phone, 'UTF8')), 'hex') = r.hash
    order by cv.updated_at desc
    limit 1
  ) conv on true
  left join restaurantes.whatsapp_branch_channel b on b.property_id = conv.property_id
  left join restaurantes.whatsapp_channel_config o on o.organization_id = r.org;
end;
$$;

revoke all on function restaurantes.reclamar_turnos_whatsapp_huerfanos(uuid, boolean, integer) from public, anon;
-- authenticated: la sesion de sistema de la API (la funcion rechaza a todo staff con auth.uid() no nulo).
grant execute on function restaurantes.reclamar_turnos_whatsapp_huerfanos(uuid, boolean, integer) to authenticated, service_role;
