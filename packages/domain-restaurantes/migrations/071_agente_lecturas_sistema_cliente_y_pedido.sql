-- PARTE A -- QA-PM-R2-whatsapp-02 (P1, cuenta real de PM): el agente de WhatsApp y el de voz NO veian a ningun cliente ni su pedido anterior.
-- PARTE B (al final) -- los contadores del agente de WhatsApp dejan de bloquear la fila de la conversacion (deadlock entre dos sesiones de la misma request).
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

-- =====================================================================================================================================
-- PARTE B: contadores del agente de WhatsApp SIN bloquear la fila de la conversacion
-- =====================================================================================================================================
-- DEFECTO (encontrado al medir main en la ronda 2 del loop de PM): `restaurantes.whatsapp_contador_agente` (047) hacia `select ... for update` sobre la fila de
-- `whatsapp_conversations`. El webhook de WhatsApp tiene esa fila bloqueada en SU transaccion (reclama el turno de la conversacion) y el turno del agente corre en
-- OTRA sesion (`turnHandler` abre su propia `withAppSession`): en cuanto el agente contaba algo (`ubicacion_solicitada` al cotizar a domicilio, `colonia_no_reconocida`,
-- `no_entiende`) esperaba un lock que su propia request no suelta hasta el final => `canceling statement due to statement timeout` (30 s) en CADA turno con
-- contador, el webhook respondia 500 y el cliente nunca recibia respuesta. Las pruebas en memoria y la verificacion de una sola conexion de la 047 no lo veian.
--
-- REMEDIO: los contadores viven en su propia tabla (una fila por organizacion + telefono (hash) + clave); la funcion conserva firma y contrato (incrementar devuelve la
-- cuenta, reiniciar devuelve 0, un contador de mas de 2 h cuenta como 0) y solo bloquea SU fila de contador. `agent_counters` de la 047 queda sin uso.
--
-- JUSTIFICACION DE SEGURIDAD: tabla con RLS activada, sin policies ni GRANT (nadie la lee ni escribe directo; ni siquiera el staff); solo la funcion `security definer`
-- (fija `search_path`, solo-sistema: `auth.uid() is null`, `revoke ... from public, anon`) la toca. Guarda el HASH sha256 del telefono (no el numero) y se purga sola: cada
-- llamada borra las filas de esa organizacion con mas de 1 dia.
create table if not exists restaurantes.whatsapp_contadores_agente (
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone_hash text not null check (char_length(phone_hash) = 64),
  clave text not null check (clave in ('colonia_no_reconocida', 'no_entiende', 'ubicacion_solicitada')),
  n integer not null check (n >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, phone_hash, clave)
);
alter table restaurantes.whatsapp_contadores_agente enable row level security;
revoke all on table restaurantes.whatsapp_contadores_agente from public, anon, authenticated;

create or replace function restaurantes.whatsapp_contador_agente(
  p_organization_id uuid,
  p_phone text,
  p_clave text,
  p_accion text
) returns integer
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_n integer;
  v_hash text;
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_contador_agente es solo de sistema' using errcode = '42501';
  end if;
  if p_clave is null or p_clave not in ('colonia_no_reconocida', 'no_entiende', 'ubicacion_solicitada') then
    raise exception 'whatsapp_contador_agente: clave invalida' using errcode = '22023';
  end if;
  if p_accion is null or p_accion not in ('incrementar', 'reiniciar') then
    raise exception 'whatsapp_contador_agente: accion invalida' using errcode = '22023';
  end if;
  if p_organization_id is null or p_phone is null or btrim(p_phone) = '' then
    return null;
  end if;
  -- Una organizacion que no es de restaurantes no existe para quien llama (devuelve null, no sondea).
  if not exists (select 1 from core.organization o where o.id = p_organization_id and o.vertical = 'restaurantes') then
    return null;
  end if;

  v_hash := encode(sha256(convert_to(p_phone, 'UTF8')), 'hex');

  if p_accion = 'reiniciar' then
    delete from restaurantes.whatsapp_contadores_agente c
     where c.organization_id = p_organization_id and c.phone_hash = v_hash and c.clave = p_clave;
    return 0;
  end if;

  -- Purga oportunista (acotada a la organizacion): un contador de mas de 1 dia no sirve para nada.
  delete from restaurantes.whatsapp_contadores_agente c
   where c.organization_id = p_organization_id and c.updated_at < now() - interval '1 day';

  insert into restaurantes.whatsapp_contadores_agente as c (organization_id, phone_hash, clave, n, updated_at)
  values (p_organization_id, v_hash, p_clave, 1, now())
  on conflict (organization_id, phone_hash, clave) do update
    set n = case when c.updated_at > now() - interval '2 hours' then c.n + 1 else 1 end,
        updated_at = now()
  returning c.n into v_n;
  return v_n;
end;
$$;

revoke all on function restaurantes.whatsapp_contador_agente(uuid, text, text, text) from public, anon;
grant execute on function restaurantes.whatsapp_contador_agente(uuid, text, text, text) to authenticated, service_role;
