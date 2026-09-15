-- Hallazgo de auditoría (severidad MEDIA, "restaurantes no envía ningún correo:
-- sin plantilla, sin dispatcher, sin remitente — solo WhatsApp"): a diferencia de
-- citas/rentas/licitaciones/despachos, `restaurantes.messaging_outbox`
-- (migrations/007_messaging_outbox.sql) YA soportaba `channel = 'email'` en su
-- CHECK desde el día uno — nunca hizo falta agregar `attempts`/`last_error*` (ya
-- existían ahí, a diferencia de `citas.messaging_outbox`, que sí los agregó en su
-- propia migración 009_email_outbox_dispatch.sql) — pero NINGÚN código real
-- reclamaba/completaba una fila `channel='email'`: `restaurantes.claim_
-- messaging_outbox_batch` (migración 007) está acotado a `channel='whatsapp'` a
-- propósito (dispatcher de WhatsApp saliente, ver @atiende/whatsapp-gateway), y
-- no existía ningún `restaurantes.claim_email_outbox_batch`/`complete_email_
-- outbox_job` equivalente. Mismo patrón EXACTO que
-- `packages/domain-citas/migrations/009_email_outbox_dispatch.sql` (claim con
-- `attempts < 5` + `for update skip locked`, complete que solo toca
-- `channel='email'`), portado 1:1 sobre el nombre de columna real de este
-- dominio (`last_error_class`, no `last_error`).
--
-- SEGUNDO GAP REAL que esta misma migración cierra (mismo criterio que la
-- migración 076 de despachos, que agregó `cliente_email` a `despachos.receivable`
-- en la MISMA migración que su outbox de correo, por la misma razón: sin una
-- columna de correo, ningún dispatcher tiene a quién escribirle): NINGUNA tabla
-- de este dominio tenía jamás una columna de correo — `restaurantes.customers`/
-- `restaurantes.orders` (migrations/001) solo capturan teléfono, el canal real de
-- voz/WhatsApp de este vertical. La plantilla de "confirmación de pedido por
-- correo" (ver ../src/emails/order-templates.ts) necesita un correo real del
-- cliente para tener a quién mandarle algo — se agrega NULLABLE a nivel de pedido
-- (no de `customers`, que es memoria de teléfono, ver customers.ts) porque hoy
-- solo `orders.ts::validateCreateOrderPayload` puede capturarlo, cuando el canal
-- de origen (web) se lo pasa; voz/WhatsApp no lo capturan todavía (fuera de
-- alcance de esta migración: seguirían sin activar el correo de confirmación, sin
-- que eso rompa nada — la plantilla ya está preparada para cuando esos canales lo
-- capturen).

alter table restaurantes.orders add column customer_email text
  check (customer_email is null or (length(customer_email) <= 320 and customer_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'));

-- create_order_idempotent (migrations/003) inserta una lista explícita de
-- columnas -- se reemplaza aquí (MISMA firma, MISMO cuerpo salvo la columna
-- nueva) para que un pedido con correo real lo persista. `to_jsonb(v_order)`
-- (la fila completa) ya viaja de vuelta sin tocar el resto de la función --
-- `customer_email` sale solo, igual que las 3 columnas de repartidor de la
-- migración 008 (ver comentario de `mapOrder` en postgres-repository.ts).
create or replace function restaurantes.create_order_idempotent(
  p_order jsonb,
  p_dedupe_fingerprint text,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_order restaurantes.orders;
  v_organization_id uuid := (p_order->>'organization_id')::uuid;
  v_customer_id uuid := (p_order->>'customer_id')::uuid;
begin
  if p_dedupe_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid idempotency input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_organization_id::text || ':' || coalesce(p_idempotency_key, p_dedupe_fingerprint),
    0
  ));

  if p_idempotency_key is not null then
    select * into v_order from restaurantes.orders
    where organization_id = v_organization_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_order.id is not null and v_order.dedupe_fingerprint is distinct from p_dedupe_fingerprint then
      raise sqlstate 'PT409' using message = 'idempotency key was already used with a different order payload';
    end if;
  else
    select * into v_order from restaurantes.orders
    where organization_id = v_organization_id
      and dedupe_fingerprint = p_dedupe_fingerprint
      and status = 'pending'
      and created_at >= now() - interval '5 minutes'
    order by created_at desc
    limit 1;
  end if;

  if v_order.id is not null then return to_jsonb(v_order); end if;

  insert into restaurantes.orders(
    customer_name, customer_phone, customer_address, customer_email, customer_id,
    organization_id, branch, property_id, total, status, items, source,
    call_transcript, call_recording_url, notes, payment_method,
    dedupe_fingerprint, idempotency_key
  ) values (
    p_order->>'customer_name', p_order->>'customer_phone', nullif(p_order->>'customer_address', ''), nullif(p_order->>'customer_email', ''), v_customer_id,
    v_organization_id, p_order->>'branch', (p_order->>'property_id')::uuid,
    (p_order->>'total')::numeric, 'pending', p_order->'items', p_order->>'source',
    nullif(p_order->>'call_transcript', ''), nullif(p_order->>'call_recording_url', ''),
    nullif(p_order->>'notes', ''), nullif(p_order->>'payment_method', ''),
    p_dedupe_fingerprint, p_idempotency_key
  ) returning * into v_order;

  update restaurantes.customers
  set order_count = order_count + 1, last_order_at = now()
  where id = v_customer_id and organization_id = v_organization_id;

  return to_jsonb(v_order);
end;
$$;

-- Tope real de reintentos del dispatcher de correo (ver
-- ../src/email-dispatch.ts::MAX_EMAIL_DISPATCH_ATTEMPTS) — mismo valor que
-- citas.claim_email_outbox_batch (migración 51 global) por consistencia.
create or replace function restaurantes.claim_email_outbox_batch(p_limit integer default 25)
returns setof restaurantes.messaging_outbox
language sql
security definer
set search_path = restaurantes
as $$
  update restaurantes.messaging_outbox
  set status = 'processing', attempts = attempts + 1
  where id in (
    select id from restaurantes.messaging_outbox
    where channel = 'email'
      and status in ('pending', 'failed')
      and attempts < 5
    order by created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
$$;

create or replace function restaurantes.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = restaurantes
as $$
begin
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update restaurantes.messaging_outbox
  set status = p_status, last_error_class = left(p_error, 120)
  where id = p_id and channel = 'email';
end;
$$;

revoke all on function restaurantes.claim_email_outbox_batch(integer) from public, anon, authenticated;
revoke all on function restaurantes.complete_email_outbox_job(uuid, text, text) from public, anon, authenticated;
grant execute on function restaurantes.claim_email_outbox_batch(integer) to service_role;
grant execute on function restaurantes.complete_email_outbox_job(uuid, text, text) to service_role;
