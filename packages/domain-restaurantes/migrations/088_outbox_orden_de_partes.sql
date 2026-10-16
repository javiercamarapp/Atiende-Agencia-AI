-- Orden de salida de las partes de una respuesta larga de WhatsApp (R12, hallazgo del revisor de R11-12). Prefijo de supabase/migrations asignado:
-- 20240101000399 (interno 088).
--
-- Problema: una respuesta de mas de 4096 caracteres se encola en partes (`inbound-reply:<id>`, `:1`, `:2`..., y el aviso de botones `inbound-botones:<id>`)
-- dentro de la MISMA transaccion del webhook. `created_at` tomaba `default now()` = inicio de la transaccion, asi que todas las filas de una respuesta
-- compartian `created_at`, y `claim_messaging_outbox_batch` (migracion 0031) ordena por (turno, created_at, id) con `id = gen_random_uuid()`: el desempate
-- era al azar y el cliente recibia la respuesta partida y REVUELTA (medido en un Postgres 17 efimero: con 3 filas por transaccion, solo 9 de 100 transacciones
-- salieron en orden).
--
-- Arreglo: `enqueue_messaging_outbox` fija `created_at = clock_timestamp()` al insertar. `clock_timestamp()` avanza dentro de la transaccion (a diferencia de
-- `now()`), asi que las filas encoladas una tras otra quedan con `created_at` estrictamente creciente en el orden en que se encolaron y el claim las ofrece en
-- ese orden (la numeracion por turno de la 0031 ya se hace por `created_at` dentro de la organizacion). El resto de la funcion es IDENTICO al de la migracion
-- 012 (guard de membresia, validacion de canal, upsert por llave de idempotencia); firma, `security definer`, `search_path` y GRANT no cambian (`create or
-- replace` conserva los GRANT; no se concede nada nuevo).
--
-- Compatibilidad con la base SIN migrar: el TypeScript no llama a ninguna funcion ni columna nueva; sin esta migracion el comportamiento es el de hoy (orden
-- no garantizado entre las partes de una misma respuesta). Aplicarla a la base real requiere OK de Javier.
--
-- Limites que esta migracion NO cierra (documentados, no ocultos):
--  * Si la parte n falla y queda en espera de reintento (backoff), la n+1 sigue siendo elegible y puede salir antes. Es un caso de falla de Graph API, no del
--    orden normal.
--  * Dos corridas concurrentes del despachador pueden tener en vuelo partes consecutivas a la vez. El cron reclama de a una por sesion y envia en serie.
--  * Un conflicto de `dedupe_key` sobre una fila `pending`/`failed` reescribe su payload; si una misma llave base se re-encolara con OTRO numero de partes
--    quedarian partes huerfanas de la primera tanda. Hoy no ocurre: el encolado va en la transaccion unica del webhook, que el dedupe por `message.id` no repite.

create or replace function restaurantes.enqueue_messaging_outbox(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = restaurantes as $$
declare v_id uuid;
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'sin acceso a esta organización' using errcode = '42501';
  end if;

  if p_channel not in ('whatsapp', 'email') then raise exception 'invalid outbox channel'; end if;
  insert into restaurantes.messaging_outbox(organization_id, channel, event_type, dedupe_key, payload, created_at)
  values (p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload, clock_timestamp())
  on conflict (organization_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from restaurantes.messaging_outbox
    where organization_id = p_organization_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;
