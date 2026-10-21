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
-- Reversa: drop function para cada una de las cuatro firmas de abajo. Depende de 090 (columnas y operador_puede) y 091 no (solo toca la outbox por nombre).

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
