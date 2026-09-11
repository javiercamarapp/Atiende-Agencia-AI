-- Ported de restaurantes/supabase/migrations/20260904055000_order_idempotency.sql.
-- Cambia únicamente: `public.orders` -> `restaurantes.orders`, `restaurant_id` ->
-- `organization_id`, `branch_id` -> `property_id`. La protección real (dos niveles:
-- idempotency_key explícito + dedupe_fingerprint automático de 5 minutos, serializados
-- con pg_advisory_xact_lock) NO se rediseña — es la parte del origen que ya resolvió
-- correctamente la condición de carrera real de doble-pedido (auditoría 3-sep-2026).
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
    customer_name, customer_phone, customer_address, customer_id,
    organization_id, branch, property_id, total, status, items, source,
    call_transcript, call_recording_url, notes, payment_method,
    dedupe_fingerprint, idempotency_key
  ) values (
    p_order->>'customer_name', p_order->>'customer_phone', nullif(p_order->>'customer_address', ''), v_customer_id,
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

revoke all on function restaurantes.create_order_idempotent(jsonb, text, text) from public, anon, authenticated;
grant execute on function restaurantes.create_order_idempotent(jsonb, text, text) to service_role;
