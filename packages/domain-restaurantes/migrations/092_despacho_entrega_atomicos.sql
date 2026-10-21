-- 092 -- Panel movil del operador (PLAN-PANEL-OPERADOR §3), parte 3: despacho, entrega, deshacer y «listo» ATOMICOS.
--
-- Hoy «Salio» son dos PATCH no atomicos (asignar chofer + cambiar estado) y el chofer puede escribir el pedido entero. Estas funciones hacen cada
-- accion en UNA sentencia con compare-and-set (`WHERE status = <esperado>` bajo `FOR UPDATE`), verifican rol, alcance y pertenencia DENTRO de SQL y
-- devuelven jsonb. La notificacion al cliente la encola el TypeScript en la misma transaccion (estas funciones no conocen plantillas).
--
-- Codigos de error (SQLSTATE) que el TypeScript traduce a respuestas HTTP:
--   42501 sin permiso / sesion de sistema          P0404 pedido, chofer o usuario no encontrado (o de otra organizacion: nunca se distingue)
--   P0409 el estado cambio (`estado_cambio`)       P0410 fuera de la ventana de 60 s para deshacer (`fuera_de_ventana`)
--   P0422 no despachable (recoger, cancelado, etc.) 22023 argumento invalido
--
-- Funciones (todas SECURITY DEFINER, search_path fijo, revoke de public/anon, grant a authenticated; ninguna acepta la sesion de sistema):
--   despachar_pedido(org, pedido, chofer, eta_min)  preparando -> en_camino con chofer y salio_at; ya en camino con el mismo chofer = ya_aplicado (sin
--       cambio); con otro chofer = reasignado. Quien: operador_puede(...,'despachar') = owner/admin/encargado (el cajero NO).
--   marcar_listo(org, pedido)                        domicilio: fija listo_at; recoger: preparando -> listo_para_recoger. Quien: 'gestionar'.
--   marcar_entrega(org, pedido, cobrado)             en_camino -> entregado (delivered_at, cobrado_monto). Quien: SOLO el chofer asignado.
--   deshacer_entrega(org, pedido, forzar)            entregado -> en_camino si pasaron <= 60 s y es el chofer que lo marco; con forzar = true, un
--       gestor con permiso de despachar puede hacerlo fuera de la ventana. Borra el aviso «entregado» si sigue pendiente en la outbox; informa si ya salio.
--
-- Justificacion de seguridad:
--  * Aislamiento entre organizaciones: el pedido se busca por (id, organization_id); uno ajeno es P0404, igual que uno inexistente.
--  * Chofer: debe tener membresia vertical_role = 'repartidor' en la organizacion, con alcance a la sucursal del pedido, y ser el asignado; un chofer
--    no puede despachar ni marcar listo ni tocar un pedido ajeno. Staff no puede marcar entrega (usa el PATCH con motivo, que es otro camino).
--  * Carrera: FOR UPDATE + compare-and-set; dos llamadas simultaneas producen un solo cambio y la segunda recibe ya_aplicado o P0409.
--  * Monto: cobrado_monto limitado a 0..100000 (mismo CHECK de la columna). Sin SQL dinamico. Los mensajes de error no devuelven datos del pedido.
--  * El historial de estados lo escribe el trigger existente (orders_registrar_evento_estado) con actor staff:<uid>; la tabla sigue append-only.
--
-- Compatibilidad con la base SIN migrar: 42883 (funcion ausente) / 42703 (columna de 090 ausente) => el TypeScript cae al camino anterior (asignar +
-- cambiar estado) dentro de un SAVEPOINT (runWithSavepointFallback) y responde salioAt nulo.
-- REVERSA (ORDEN OBLIGATORIO 092 -> 091 -> 090; las funciones plpgsql no registran dependencias): se revierte PRIMERO esta migracion:
--     drop function if exists restaurantes.deshacer_entrega(uuid, uuid, boolean);
--     drop function if exists restaurantes.marcar_entrega(uuid, uuid, numeric);
--     drop function if exists restaurantes.marcar_listo(uuid, uuid);
--     drop function if exists restaurantes.despachar_pedido(uuid, uuid, uuid, integer);
--   No pierde datos: solo funciones. Los pedidos ya despachados/entregados conservan su estado.
--
-- RIESGO CONOCIDO HASTA QUE LLEGUE LA 093 (se prioriza para el final): `grant update on restaurantes.orders to authenticated` (migracion 007) es de TABLA
--   COMPLETA y la policy de UPDATE deja actualizar a CUALQUIER miembro de la organizacion, chofer incluido. Mientras no se aplique la 093, un chofer con
--   sesion viva puede escribir directo (PATCH a la tabla) cualquier columna de un pedido, tambien las nuevas (cobrado_monto, salio_at, listo_at). Estas
--   funciones NO cierran ese hueco: solo ofrecen el camino atomico y verificado. La defensa actual sigue siendo la capa TypeScript.

create or replace function restaurantes.despachar_pedido(
  p_organization_id uuid, p_order_id uuid, p_repartidor_id uuid, p_eta_min integer
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_ahora timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'despachar_pedido no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_eta_min is null or p_eta_min < 5 or p_eta_min > 240 then
    raise exception 'despachar_pedido: eta fuera de rango' using errcode = '22023';
  end if;

  -- Permiso ANTES de buscar el pedido: quien no es gestor de la organizacion recibe 42501 sin enterarse de si existe un (org, pedido).
  if not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
  ) then
    raise exception 'sin permiso para operar en esta organizacion' using errcode = '42501';
  end if;
  select * into v_order from restaurantes.orders where id = p_order_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'pedido no encontrado' using errcode = 'P0404';
  end if;
  if not restaurantes.operador_puede(v_order.organization_id, v_order.property_id, 'despachar') then
    raise exception 'sin permiso para despachar en esta sucursal' using errcode = '42501';
  end if;
  if coalesce(v_order.canal, 'domicilio') <> 'domicilio' then
    raise exception 'solo los pedidos a domicilio se despachan' using errcode = 'P0422';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.user_id = p_repartidor_id
      and m.organization_id = v_order.organization_id
      and m.vertical_role = 'repartidor'
      and (m.property_ids is null or v_order.property_id = any (m.property_ids))
  ) then
    raise exception 'repartidor no encontrado' using errcode = 'P0404';
  end if;

  if v_order.status = 'en_camino' then
    if v_order.assigned_repartidor_id is not distinct from p_repartidor_id then
      return jsonb_build_object('resultado', 'ya_aplicado', 'estado', 'en_camino', 'salio_at', v_order.salio_at, 'repartidor_id', p_repartidor_id);
    end if;
    update restaurantes.orders set assigned_repartidor_id = p_repartidor_id where id = v_order.id;
    -- Auditoria: el cambio de chofer no cambia el estado (el trigger no dispara), asi que deja su propio renglon en el historial append-only.
    insert into restaurantes.order_status_events (order_id, organization_id, property_id, from_status, to_status, actor, motivo)
    values (v_order.id, v_order.organization_id, v_order.property_id, 'en_camino', 'en_camino', 'staff:' || auth.uid()::text, 'reasignado:' || p_repartidor_id::text);
    return jsonb_build_object('resultado', 'reasignado', 'estado', 'en_camino', 'salio_at', v_order.salio_at, 'repartidor_id', p_repartidor_id);
  end if;
  if v_order.status <> 'preparando' then
    raise exception 'el estado del pedido cambio' using errcode = 'P0409';
  end if;

  update restaurantes.orders
  set status = 'en_camino',
      assigned_repartidor_id = p_repartidor_id,
      salio_at = v_ahora,
      estimated_delivery_at = v_ahora + make_interval(mins => p_eta_min)
  where id = v_order.id and status = 'preparando';
  return jsonb_build_object('resultado', 'despachado', 'estado', 'en_camino', 'salio_at', v_ahora, 'repartidor_id', p_repartidor_id);
end;
$$;

create or replace function restaurantes.marcar_listo(p_organization_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_ahora timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'marcar_listo no es para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
  ) then
    raise exception 'sin permiso para operar en esta organizacion' using errcode = '42501';
  end if;
  select * into v_order from restaurantes.orders where id = p_order_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'pedido no encontrado' using errcode = 'P0404';
  end if;
  if not restaurantes.operador_puede(v_order.organization_id, v_order.property_id, 'gestionar') then
    raise exception 'sin permiso para operar en esta sucursal' using errcode = '42501';
  end if;

  if coalesce(v_order.canal, 'domicilio') = 'recoger' then
    if v_order.status = 'listo_para_recoger' then
      return jsonb_build_object('resultado', 'ya_aplicado', 'estado', 'listo_para_recoger', 'listo_at', v_order.listo_at);
    end if;
    if v_order.status <> 'preparando' then
      raise exception 'el estado del pedido cambio' using errcode = 'P0409';
    end if;
    update restaurantes.orders set status = 'listo_para_recoger', listo_at = coalesce(listo_at, v_ahora)
    where id = v_order.id and status = 'preparando';
    return jsonb_build_object('resultado', 'listo', 'estado', 'listo_para_recoger', 'listo_at', v_ahora);
  end if;

  if v_order.listo_at is not null then
    return jsonb_build_object('resultado', 'ya_aplicado', 'estado', v_order.status, 'listo_at', v_order.listo_at);
  end if;
  if v_order.status <> 'preparando' then
    raise exception 'el estado del pedido cambio' using errcode = 'P0409';
  end if;
  update restaurantes.orders set listo_at = v_ahora where id = v_order.id and status = 'preparando' and listo_at is null;
  return jsonb_build_object('resultado', 'listo', 'estado', 'preparando', 'listo_at', v_ahora);
end;
$$;

create or replace function restaurantes.marcar_entrega(p_organization_id uuid, p_order_id uuid, p_cobrado numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_ahora timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'marcar_entrega no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_cobrado is not null and (p_cobrado < 0 or p_cobrado > 100000) then
    raise exception 'marcar_entrega: monto cobrado fuera de rango' using errcode = '22023';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role = 'repartidor'
  ) then
    raise exception 'solo el chofer marca la entrega' using errcode = '42501';
  end if;

  select * into v_order from restaurantes.orders
  where id = p_order_id and organization_id = p_organization_id and assigned_repartidor_id = auth.uid()
  for update;
  if not found then
    raise exception 'pedido no encontrado' using errcode = 'P0404';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = v_order.organization_id and m.vertical_role = 'repartidor'
      and (m.property_ids is null or v_order.property_id = any (m.property_ids))
  ) then
    raise exception 'pedido no encontrado' using errcode = 'P0404';
  end if;

  if v_order.status = 'entregado' then
    return jsonb_build_object('resultado', 'ya_aplicado', 'entregado_at', v_order.delivered_at,
                              'puede_deshacer_hasta', v_order.delivered_at + interval '60 seconds');
  end if;
  if v_order.status <> 'en_camino' then
    raise exception 'el estado del pedido cambio' using errcode = 'P0409';
  end if;
  update restaurantes.orders
  set status = 'entregado', delivered_at = v_ahora, cobrado_monto = p_cobrado
  where id = v_order.id and status = 'en_camino';
  return jsonb_build_object('resultado', 'entregado', 'entregado_at', v_ahora, 'puede_deshacer_hasta', v_ahora + interval '60 seconds');
end;
$$;

create or replace function restaurantes.deshacer_entrega(p_organization_id uuid, p_order_id uuid, p_forzar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_ahora timestamptz := now();
  v_es_chofer boolean;
  v_clave text;
  v_ya_enviado boolean;
begin
  if auth.uid() is null then
    raise exception 'deshacer_entrega no es para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff', 'repartidor')
  ) then
    raise exception 'sin permiso para operar en esta organizacion' using errcode = '42501';
  end if;
  select * into v_order from restaurantes.orders where id = p_order_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'pedido no encontrado' using errcode = 'P0404';
  end if;

  v_es_chofer := v_order.assigned_repartidor_id is not distinct from auth.uid()
    and exists (
      select 1 from core.membership m
      where m.user_id = auth.uid() and m.organization_id = v_order.organization_id and m.vertical_role = 'repartidor'
        and (m.property_ids is null or v_order.property_id = any (m.property_ids))
    );
  if not v_es_chofer then
    if not (coalesce(p_forzar, false) and restaurantes.operador_puede(v_order.organization_id, v_order.property_id, 'despachar')) then
      -- Un chofer ajeno o un gestor sin permiso no se distinguen de un pedido inexistente.
      raise exception 'pedido no encontrado' using errcode = 'P0404';
    end if;
  end if;

  if v_order.status = 'en_camino' then
    return jsonb_build_object('resultado', 'ya_aplicado', 'estado', 'en_camino', 'aviso_ya_enviado', false);
  end if;
  if v_order.status <> 'entregado' then
    raise exception 'el estado del pedido cambio' using errcode = 'P0409';
  end if;
  if v_es_chofer and (v_order.delivered_at is null or v_ahora - v_order.delivered_at > interval '60 seconds') then
    raise exception 'fuera de la ventana para deshacer la entrega' using errcode = 'P0410';
  end if;

  update restaurantes.orders
  set status = 'en_camino', delivered_at = null, cobrado_monto = null
  where id = v_order.id and status = 'entregado';

  -- Si el aviso «entregado» sigue pendiente en la outbox se borra (y asi una entrega posterior vuelve a poder avisar); si ya salio, solo se informa.
  v_clave := 'order-status:' || v_order.id::text || ':entregado';
  delete from restaurantes.messaging_outbox
  where organization_id = v_order.organization_id and channel = 'whatsapp' and dedupe_key = v_clave and status = 'pending';
  v_ya_enviado := exists (
    select 1 from restaurantes.messaging_outbox
    where organization_id = v_order.organization_id and channel = 'whatsapp' and dedupe_key = v_clave and status in ('processing', 'sent')
  );
  return jsonb_build_object('resultado', 'deshecho', 'estado', 'en_camino', 'aviso_ya_enviado', v_ya_enviado);
end;
$$;

revoke all on function restaurantes.despachar_pedido(uuid, uuid, uuid, integer) from public, anon;
revoke all on function restaurantes.marcar_listo(uuid, uuid) from public, anon;
revoke all on function restaurantes.marcar_entrega(uuid, uuid, numeric) from public, anon;
revoke all on function restaurantes.deshacer_entrega(uuid, uuid, boolean) from public, anon;
grant execute on function restaurantes.despachar_pedido(uuid, uuid, uuid, integer) to authenticated;
grant execute on function restaurantes.marcar_listo(uuid, uuid) to authenticated;
grant execute on function restaurantes.marcar_entrega(uuid, uuid, numeric) to authenticated;
grant execute on function restaurantes.deshacer_entrega(uuid, uuid, boolean) to authenticated;
