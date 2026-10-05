-- QA-PM-R2-whatsapp-02 (P1, cuenta real de PM): el agente de WhatsApp y el de voz NO veian a ningun cliente ni su pedido anterior.
--
-- CAUSA RAIZ: el motor de produccion abre TODA sesion con `set local role authenticated` y `request.jwt.claim.sub = ''`, y los canales del agente
-- (webhook de WhatsApp, herramientas de voz) usan `withAppSession({ userId: null })` (auth.uid() NULL). Las policies de SELECT de
-- `restaurantes.customers`, `customer_addresses` y `orders` (001) solo dejan leer al STAFF de la organizacion (membresia por auth.uid()); para la
-- sesion de sistema devuelven 0 filas SIN error. La 048 resolvio las ESCRITURAS con funciones `security definer` solo-sistema, pero las LECTURAS
-- siguieron siendo SELECT directos: `buscar_cliente` devolvia siempre `isNew: true` (el cliente existia con order_count = 1), "repiteme mi ultimo
-- pedido" respondia "no aparece un pedido anterior", el pedido reciente / estado del pedido / VIP no funcionaban y la regla de pedido grande
-- trataba a todos como clientes nuevos.
--
-- REMEDIO: cinco funciones de LECTURA `security definer`, solo para la sesion de sistema, con la organizacion como argumento explicito (mismo patron y
-- misma justificacion de seguridad que 048). NO se concede ningun GRANT de tabla ni se ensancha ninguna policy (una policy `using (auth.uid() is null)`
-- dejaria a CUALQUIER sesion publica sin usuario leer los clientes de todas las organizaciones).
--
-- JUSTIFICACION DE SEGURIDAD (cada funcion):
--   * `security definer`, `set search_path = restaurantes, pg_temp` (fijo), `revoke all ... from public, anon` y `grant execute ... to authenticated,
--     service_role`. `anon` nunca recibe EXECUTE.
--   * Exigen `auth.uid() is null` (sesion de sistema): un staff autenticado recibe 42501 y su lectura sigue siendo la directa, acotada por sus policies.
--   * Aislamiento entre organizaciones: cada funcion filtra por `organization_id` recibido; las que reciben un id de cliente exigen que pertenezca a esa
--     organizacion (si no, devuelven vacio, nunca filas ajenas). Solo devuelven las columnas que el repositorio ya leia directamente.
--   * Solo lectura: no escriben ni modifican nada.
--
-- COMPATIBILIDAD: el TypeScript llama estas funciones dentro de un SAVEPOINT (`runWithSavepointFallback`) y, contra una base que aun no tiene esta
-- migracion (42883) o con una sesion de staff (42501), cae a la lectura directa de siempre.

create or replace function restaurantes.sistema_buscar_cliente_por_telefono(p_organization_id uuid, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, pg_temp
as $$
declare
  v_row restaurantes.customers;
begin
  if auth.uid() is not null then
    raise exception 'sistema_buscar_cliente_por_telefono es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_phone is null then
    return null;
  end if;
  select * into v_row from restaurantes.customers c where c.organization_id = p_organization_id and c.phone = p_phone;
  if not found then
    return null;
  end if;
  return jsonb_build_object('id', v_row.id, 'organization_id', v_row.organization_id, 'phone', v_row.phone, 'name', v_row.name, 'order_count', v_row.order_count);
end;
$$;

create or replace function restaurantes.sistema_direcciones_cliente(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'sistema_direcciones_cliente es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('address', a.address, 'label', a.label, 'is_default', a.is_default) order by a.is_default desc)
       from restaurantes.customer_addresses a
       join restaurantes.customers c on c.id = a.customer_id
      where a.customer_id = p_customer_id and c.organization_id = p_organization_id),
    '[]'::jsonb
  );
end;
$$;

create or replace function restaurantes.sistema_historial_pedidos_cliente(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'sistema_historial_pedidos_cliente es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return coalesce(
    (select jsonb_agg(jsonb_build_object('items', o.items, 'created_at', o.created_at) order by o.created_at desc)
       from restaurantes.orders o
      where o.customer_id = p_customer_id
        and o.organization_id = p_organization_id
        and o.status in ('pending', 'preparando', 'en_camino', 'entregado', 'completado')),
    '[]'::jsonb
  );
end;
$$;

create or replace function restaurantes.sistema_pedido_reciente_por_telefono(p_organization_id uuid, p_phone text, p_since timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, pg_temp
as $$
declare
  v_row restaurantes.orders;
begin
  if auth.uid() is not null then
    raise exception 'sistema_pedido_reciente_por_telefono es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_phone is null then
    return null;
  end if;
  select * into v_row
    from restaurantes.orders o
   where o.organization_id = p_organization_id
     and right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 10) = p_phone
     and o.created_at >= p_since
     and o.status <> 'cancelado'
   order by o.created_at desc, o.id desc
   limit 1;
  if not found then
    return null;
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function restaurantes.sistema_pedido_por_id(p_organization_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, pg_temp
as $$
declare
  v_row restaurantes.orders;
begin
  if auth.uid() is not null then
    raise exception 'sistema_pedido_por_id es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select * into v_row from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  return to_jsonb(v_row);
end;
$$;

revoke all on function restaurantes.sistema_buscar_cliente_por_telefono(uuid, text) from public, anon;
revoke all on function restaurantes.sistema_direcciones_cliente(uuid, uuid) from public, anon;
revoke all on function restaurantes.sistema_historial_pedidos_cliente(uuid, uuid) from public, anon;
revoke all on function restaurantes.sistema_pedido_reciente_por_telefono(uuid, text, timestamptz) from public, anon;
revoke all on function restaurantes.sistema_pedido_por_id(uuid, uuid) from public, anon;
grant execute on function restaurantes.sistema_buscar_cliente_por_telefono(uuid, text) to authenticated, service_role;
grant execute on function restaurantes.sistema_direcciones_cliente(uuid, uuid) to authenticated, service_role;
grant execute on function restaurantes.sistema_historial_pedidos_cliente(uuid, uuid) to authenticated, service_role;
grant execute on function restaurantes.sistema_pedido_reciente_por_telefono(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function restaurantes.sistema_pedido_por_id(uuid, uuid) to authenticated, service_role;
