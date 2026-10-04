-- P0 (PM, cuenta real): la sesion de sistema (webhook de WhatsApp, herramientas de voz, checkout web) no podia
-- crear clientes, direcciones ni avisos de contacto, y por tanto ningun pedido nuevo por ningun canal.
--
-- CAUSA RAIZ (defensa en profundidad, disponibilidad): el motor de produccion abre TODA sesion con
-- `set local role authenticated` y `request.jwt.claim.sub = ''` (ver `packages/db/src/managed-postgres-engine.ts`),
-- y los canales publicos y de agentes usan `withAppSession({ userId: null })` (auth.uid() NULL). Los pedidos y las
-- conversaciones ya pasan por funciones `security definer` solo-sistema (003/004/013), pero tres escrituras del
-- repositorio eran INSERT/UPDATE directos sobre tablas donde `authenticated` solo tiene SELECT (001) y sin policy de
-- escritura: `restaurantes.customers` (alta/actualizacion del cliente), `restaurantes.customer_addresses` (direccion de
-- entrega) y `restaurantes.callback_requests` (aviso "devolver la llamada" / escalar a humano), mas el UPDATE de
-- `restaurantes.whatsapp_inbound_events` al marcar un mensaje como fallido por conversacion ocupada (sin ningun GRANT).
-- Resultado: "permission denied for table customers" en la primera escritura de cualquier pedido nuevo.
--
-- REMEDIO: cuatro funciones `security definer`, solo para la sesion de sistema, que hacen exactamente esas
-- escrituras con la organizacion como argumento explicito. NO se concede ningun GRANT de tabla (ni a `anon` ni a
-- `authenticated`): el rol de la API sigue sin poder escribir directo en esas tablas, solo por estas funciones.
-- Se eligio funcion en vez de GRANT de columna + policy porque la sesion de sistema no trae organizacion en su
-- contexto (auth.uid() es NULL): una policy de escritura para ella no podria acotar por organizacion sin `using (true)`.
--
-- JUSTIFICACION DE SEGURIDAD (cada funcion / GRANT):
--   * Las cuatro son `security definer` con `set search_path = restaurantes, pg_temp` (fijo; sin camino de busqueda
--     controlable por el llamador) y `revoke all ... from public, anon` explicito antes del `grant execute ... to
--     authenticated, service_role`. `anon` nunca recibe EXECUTE.
--   * Las cuatro exigen `auth.uid() is null` (sesion de sistema): un staff autenticado que las invoque recibe 42501.
--     El staff no escribe estas filas por ninguna ruta (los pedidos solo los crea el sistema), asi que nada se pierde.
--   * Aislamiento entre organizaciones: `upsert_customer` y `create_callback_request` solo operan sobre la organizacion
--     recibida y exigen que sea una organizacion del vertical `restaurantes`; `create_callback_request` ademas exige que
--     la sucursal (si viene) pertenezca a esa organizacion; `add_customer_address_if_new` exige que el cliente pertenezca
--     a la organizacion recibida (si no, 42501, sin insertar). Ninguna funcion lee ni devuelve filas de otra organizacion.
--   * No se agregan tablas, columnas, policies ni GRANT de tabla. Las policies de SELECT de 001 (y las que otras
--     migraciones acoten) siguen siendo la unica via de lectura del staff.
--   * `mark_whatsapp_inbound_failed` solo toca la fila del mensaje en estado `processing` de ESA organizacion (nunca
--     degrada un `processed` ni un `attempts_exhausted`) y recorta la clase de error a 120 caracteres (el CHECK de la tabla).
--   * El telefono y el nombre solo se almacenan en las tablas que ya los guardaban (misma retencion/purga que antes).
--
-- COMPATIBILIDAD: el codigo TypeScript llama estas funciones dentro de un SAVEPOINT (`runWithSavepointFallback`) y,
-- contra una base que aun no tiene esta migracion (42883), cae al camino directo anterior (el que ya existia).

-- 1) Cliente: alta o actualizacion atomica por (organizacion, telefono). Nunca sobreescribe un nombre ya conocido.
create or replace function restaurantes.upsert_customer(
  p_organization_id uuid,
  p_phone text,
  p_name text
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
declare
  v_row restaurantes.customers;
begin
  if auth.uid() is not null then
    raise exception 'upsert_customer es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_phone is null or btrim(p_phone) = '' then
    raise exception 'invalid customer' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_organization_id and o.vertical = 'restaurantes') then
    raise exception 'organización inexistente o de otro vertical' using errcode = '42501';
  end if;

  insert into restaurantes.customers (organization_id, phone, name, order_count)
  values (p_organization_id, p_phone, p_name, 0)
  on conflict (organization_id, phone) do update
    set name = coalesce(restaurantes.customers.name, excluded.name),
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'organization_id', v_row.organization_id,
    'phone', v_row.phone,
    'name', v_row.name,
    'order_count', v_row.order_count
  );
end;
$$;

-- 2) Direccion de entrega del cliente: idempotente; la primera direccion queda como predeterminada.
create or replace function restaurantes.add_customer_address_if_new(
  p_organization_id uuid,
  p_customer_id uuid,
  p_address text
) returns void
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'add_customer_address_if_new es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_customer_id is null or p_address is null or btrim(p_address) = '' then
    raise exception 'invalid address' using errcode = '22023';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    raise exception 'el cliente no pertenece a la organización' using errcode = '42501';
  end if;

  insert into restaurantes.customer_addresses (customer_id, address, is_default)
  values (
    p_customer_id,
    p_address,
    not exists (select 1 from restaurantes.customer_addresses a where a.customer_id = p_customer_id)
  )
  on conflict (customer_id, address) do nothing;
end;
$$;

-- 3) Aviso "devolver la llamada" / escalar a humano (agentes de voz y WhatsApp).
create or replace function restaurantes.create_callback_request(
  p_organization_id uuid,
  p_property_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_reason text,
  p_message text,
  p_source text
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
declare
  v_row restaurantes.callback_requests;
begin
  if auth.uid() is not null then
    raise exception 'create_callback_request es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null
     or p_customer_name is null or btrim(p_customer_name) = ''
     or p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception 'invalid callback request' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_organization_id and o.vertical = 'restaurantes') then
    raise exception 'organización inexistente o de otro vertical' using errcode = '42501';
  end if;
  if p_property_id is not null
     and not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'la sucursal no pertenece a la organización' using errcode = '42501';
  end if;

  insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, message, source)
  values (p_organization_id, p_property_id, p_customer_name, p_customer_phone, p_reason, p_message, p_source)
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'resolved', v_row.resolved, 'created_at', v_row.created_at);
end;
$$;

-- 4) Mensaje de WhatsApp que no pudo atenderse por conversacion ocupada: queda `failed` para que Meta lo reintente.
create or replace function restaurantes.mark_whatsapp_inbound_failed(
  p_organization_id uuid,
  p_message_id text,
  p_error_class text
) returns void
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'mark_whatsapp_inbound_failed es solo para la sesión de sistema' using errcode = '42501';
  end if;
  update restaurantes.whatsapp_inbound_events
     set status = 'failed',
         last_error_class = left(p_error_class, 120)
   where message_id = p_message_id
     and organization_id = p_organization_id
     and status = 'processing';
end;
$$;

revoke all on function restaurantes.upsert_customer(uuid, text, text) from public, anon;
revoke all on function restaurantes.add_customer_address_if_new(uuid, uuid, text) from public, anon;
revoke all on function restaurantes.create_callback_request(uuid, uuid, text, text, text, text, text) from public, anon;
revoke all on function restaurantes.mark_whatsapp_inbound_failed(uuid, text, text) from public, anon;
grant execute on function restaurantes.upsert_customer(uuid, text, text) to authenticated, service_role;
grant execute on function restaurantes.add_customer_address_if_new(uuid, uuid, text) to authenticated, service_role;
grant execute on function restaurantes.create_callback_request(uuid, uuid, text, text, text, text, text) to authenticated, service_role;
grant execute on function restaurantes.mark_whatsapp_inbound_failed(uuid, text, text) to authenticated, service_role;
