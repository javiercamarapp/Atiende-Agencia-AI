-- 089 -- Defensa en profundidad de la capa SQL (PM, ronda 12; hallazgos R11-13, R11-15 y R11-16).
--
-- CONTEXTO. `restaurantes.create_order_idempotent` es SECURITY DEFINER y SOLO la llama la sesion de sistema (el backend), que ya valida todo esto en
-- TypeScript. Por eso no es un P0: es defensa en profundidad. El dia que un llamador nuevo (otro cron, otra ruta, un script) se salte esa validacion,
-- la base debe frenar por si misma lo que el TypeScript nunca manda.
--
-- QUE HACE (todo idempotente: se puede correr dos veces sin efecto):
--   1. `create_order_idempotent` -- `create or replace` con la MISMA firma, `security definer`, el MISMO `set search_path = restaurantes`, la MISMA guarda
--      `auth.uid() is not null -> 42501` y los MISMOS GRANT (no se tocan). Se agregan validaciones ANTES de bloquear/insertar:
--        * R11-15: la sucursal (`property_id`) debe existir en `core.property` y pertenecer a `organization_id`; el cliente (`customer_id`, si viene)
--          debe existir en `restaurantes.customers` y pertenecer a la misma organizacion. Si no: 42501 (mismo codigo que `callback_registrar_agente`).
--        * R11-16: `total` presente, >= 0 y distinto de NaN; `items` debe ser un arreglo NO vacio de objetos y, si un renglon trae `quantity`, un numero > 0. Si no: 22023.
--      Una repeticion idempotente de un pedido valido sigue devolviendo el mismo pedido (las validaciones no cambian el resultado de un pedido bueno).
--   2. CHECK en tablas, para quien escriba SIN pasar por la funcion (R11-13 y refuerzo de R11-16). Cada uno se agrega `NOT VALID` y despues se intenta `VALIDATE`
--      en la MISMA transaccion de la migracion: el ACCESS EXCLUSIVE del ADD se mantiene durante el escaneo del VALIDATE, asi que NO es sin bloqueo.
--      Es tolerable en orders y callback_requests, pero conviene aplicarla con poco trafico. Si ALGUNA fila existente de produccion lo viola, el CHECK se QUITA y la migracion NO falla (aviso):
--      un CHECK `NOT VALID` se vuelve a evaluar en cada UPDATE de la fila, y no queremos que una fila vieja mal formada bloquee un cambio de estado.
--        * callback_requests.message: largo <= 10000 caracteres (el agente agrega notas con tope de 4000 en total; el margen cubre el texto inicial).
--        * orders.total >= 0 (y no NaN) y orders.items es un arreglo JSON. (El "no vacio" y la cantidad > 0 se validan solo en la funcion, no como CHECK de tabla,
--          porque son reglas de creacion: un pedido historico ya existente no debe quedar bloqueado para actualizarse.)
--
-- ORDEN DE DESPLIEGUE: esta migracion es compatible hacia atras con el codigo actual (el TypeScript ya valida lo mismo). Se puede aplicar ANTES o
-- DESPUES del codigo; lo recomendado es aplicarla primero (la base endurecida no rompe al codigo viejo) y sin ventana de mantenimiento.
-- PLAN DE REVERSA: (a) alter table restaurantes.orders drop constraint if exists orders_total_no_negativo, drop constraint if exists orders_items_es_arreglo;
--   (b) alter table restaurantes.callback_requests drop constraint if exists callback_requests_message_largo;
--   (c) volver a ejecutar el `create or replace function restaurantes.create_order_idempotent` de la migracion 034_pedidos_programados.sql (sin los bloques R11-15/16).
--
-- Seguridad de la funcion: sigue siendo solo de sistema; sin SQL dinamico; los mensajes de error no devuelven datos del pedido.

-- ---------------------------------------------------------------------------
-- 1) create_order_idempotent con validacion de pertenencia y de forma
-- ---------------------------------------------------------------------------
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
  v_property_id uuid := (p_order->>'property_id')::uuid;
  v_programado_para timestamptz := nullif(p_order->>'programado_para', '')::timestamptz;
  v_total numeric;
  v_item jsonb;
begin
  if auth.uid() is not null then
    raise exception 'create_order_idempotent es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_dedupe_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid idempotency input';
  end if;

  -- R11-15: la sucursal y el cliente deben ser de la MISMA organizacion que el pedido.
  if v_organization_id is null then
    raise exception 'create_order_idempotent: falta organization_id' using errcode = '22023';
  end if;
  if v_property_id is null
     or not exists (select 1 from core.property p where p.id = v_property_id and p.organization_id = v_organization_id) then
    raise exception 'create_order_idempotent: la sucursal no pertenece a la organizacion' using errcode = '42501';
  end if;
  if v_customer_id is not null
     and not exists (select 1 from restaurantes.customers c where c.id = v_customer_id and c.organization_id = v_organization_id) then
    raise exception 'create_order_idempotent: el cliente no pertenece a la organizacion' using errcode = '42501';
  end if;

  -- R11-16: total no negativo e items = arreglo no vacio de objetos con cantidad positiva.
  v_total := (p_order->>'total')::numeric;
  if v_total is null or v_total < 0 or v_total = 'NaN'::numeric then
    raise exception 'create_order_idempotent: el total debe ser un numero >= 0' using errcode = '22023';
  end if;
  if jsonb_typeof(p_order->'items') is distinct from 'array' or jsonb_array_length(p_order->'items') = 0 then
    raise exception 'create_order_idempotent: items debe ser un arreglo con al menos un renglon' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_order->'items') loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception 'create_order_idempotent: cada renglon de items debe ser un objeto' using errcode = '22023';
    end if;
    if v_item ? 'quantity'
       and (jsonb_typeof(v_item->'quantity') is distinct from 'number' or (v_item->>'quantity')::numeric <= 0) then
      raise exception 'create_order_idempotent: la cantidad de cada renglon debe ser un numero > 0' using errcode = '22023';
    end if;
  end loop;

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
      and status in ('pending', 'programado')
      and created_at >= now() - interval '5 minutes'
    order by created_at desc
    limit 1;
  end if;

  if v_order.id is not null then return to_jsonb(v_order); end if;

  if v_programado_para is not null and v_programado_para <= now() then
    raise exception 'programado_para debe ser una hora futura' using errcode = '22023';
  end if;

  insert into restaurantes.orders(
    customer_name, customer_phone, customer_address, customer_email, customer_id,
    organization_id, branch, property_id, total, status, items, source,
    call_transcript, call_recording_url, notes, payment_method,
    dedupe_fingerprint, idempotency_key, canal, propina, hora_recogida, programado_para
  ) values (
    p_order->>'customer_name', p_order->>'customer_phone', nullif(p_order->>'customer_address', ''), nullif(p_order->>'customer_email', ''), v_customer_id,
    v_organization_id, p_order->>'branch', v_property_id,
    v_total, case when v_programado_para is not null then 'programado' else 'pending' end, p_order->'items', p_order->>'source',
    nullif(p_order->>'call_transcript', ''), nullif(p_order->>'call_recording_url', ''),
    nullif(p_order->>'notes', ''), nullif(p_order->>'payment_method', ''),
    p_dedupe_fingerprint, p_idempotency_key,
    nullif(p_order->>'canal', ''), nullif(p_order->>'propina', '')::numeric, nullif(p_order->>'hora_recogida', '')::timestamptz, v_programado_para
  ) returning * into v_order;

  update restaurantes.customers
  set order_count = order_count + 1, last_order_at = now()
  where id = v_customer_id and organization_id = v_organization_id;

  return to_jsonb(v_order);
end;
$$;

revoke all on function restaurantes.create_order_idempotent(jsonb, text, text) from public, anon;

-- ---------------------------------------------------------------------------
-- 2) CHECK de tabla: NOT VALID + VALIDATE; si hay filas que lo violan, se quita (sin fallar)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('callback_requests', 'callback_requests_message_largo', 'message is null or char_length(message) <= 10000'),
      ('orders', 'orders_total_no_negativo', $c$total >= 0 and total <> 'NaN'::numeric$c$),
      ('orders', 'orders_items_es_arreglo', $c$jsonb_typeof(items) = 'array'$c$)
    ) as t(tabla, nombre, condicion)
  loop
    if exists (
      select 1 from pg_constraint c
      where c.conname = r.nombre and c.conrelid = format('restaurantes.%I', r.tabla)::regclass
    ) then
      continue;  -- ya existe (migracion re-ejecutada)
    end if;
    execute format('alter table restaurantes.%I add constraint %I check (%s) not valid', r.tabla, r.nombre, r.condicion);
    begin
      execute format('alter table restaurantes.%I validate constraint %I', r.tabla, r.nombre);
    exception when check_violation then
      execute format('alter table restaurantes.%I drop constraint %I', r.tabla, r.nombre);
      raise warning '089: % NO se agrego a restaurantes.%: hay filas existentes que lo violan; revisar y corregir esas filas y volver a correr la migracion', r.nombre, r.tabla;
    end;
  end loop;
end $$;
