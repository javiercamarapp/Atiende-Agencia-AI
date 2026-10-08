-- CFO + renglones regalados por la promocion (restaurantes 086): restaurantes.cfo_renglones devuelve el PRECIO DE LISTA de un renglon regalado.
-- Prefijo de supabase/migrations: 20240101000397 (interno restaurantes 086). Forward-only; solo redefine UNA funcion de ayuda, con la misma firma de salida.
--
-- Por que: la regla D12 (decision de Javier) pide que el total de un pedido sea la suma de sus renglones con las cortesias aplicadas. Desde este cambio, createOrder guarda
-- la unidad regalada por la promocion (cortesia o 2x1) en un renglon aparte con price 0 y listPrice = su precio de lista. El CFO deriva la venta bruta como
-- suma(renglones) y el descuento de promocion como bruta - neta (ver 081): sin esta funcion, bruta bajaria y el descuento de promocion quedaria en 0 para esos pedidos
-- (el filtro «con descuento» y la alerta p90 de 084 tampoco los verian). Con ella, bruta, descuento y neta quedan IGUALES a los de antes de D12.
--
-- Compatibilidad: un renglon sin listPrice (todos los pedidos anteriores y los renglones pagados) devuelve su price, exactamente como en 081. Un listPrice que no sea un numero
-- no negativo bien formado se ignora y se usa price. Orden de despliegue: aplicar ESTA migracion antes de desplegar el codigo que escribe listPrice; si el codigo corriera primero,
-- la bruta de esos pedidos quedaria sin la unidad regalada hasta aplicarla (sin error). No toca cfo_pedidos_detalle ni sr_resumen_leer (084): solo llaman a esta funcion.
--
-- Justificacion de seguridad: sin GRANT nuevos. La funcion sigue siendo interna: immutable, search_path fijo (restaurantes, core, pg_temp) y revoke de public, anon y authenticated, como en 081.
create or replace function restaurantes.cfo_renglones(p_items jsonb)
returns table (producto_ref text, nombre text, precio numeric, cantidad numeric)
language sql
immutable
set search_path = restaurantes, core, pg_temp
as $$
  select nullif(btrim(e.value ->> 'id'), ''),
         nullif(btrim(e.value ->> 'name'), ''),
         case when (e.value ->> 'listPrice') ~ '^[0-9]{1,8}(\.[0-9]{1,6})?$' then (e.value ->> 'listPrice')::numeric else (e.value ->> 'price')::numeric end,
         (e.value ->> 'quantity')::numeric
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as e(value)
  where jsonb_typeof(e.value) = 'object'
    and (e.value ->> 'price') ~ '^[0-9]{1,8}(\.[0-9]{1,6})?$'
    and (e.value ->> 'quantity') ~ '^[0-9]{1,6}$';
$$;
revoke all on function restaurantes.cfo_renglones(jsonb) from public, anon, authenticated;
