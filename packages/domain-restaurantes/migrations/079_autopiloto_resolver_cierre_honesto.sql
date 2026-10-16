-- 079_autopiloto_resolver_cierre_honesto.sql
-- QA R2 (restaurantes, caos-09, PR #470) -- cierre honesto de una solicitud de cancelacion, SOBRE la 075 de seguridad (#474, ya aplicada).
-- (Antes vivia en la 073, que hacia DROP + CREATE de `solicitud_resolver` y habria borrado las guardas de la 075; la 073 se elimino y esta migracion
-- es POSTERIOR a la 075 y contiene UN solo cuerpo: el de la 075 LITERAL mas lo de abajo.)
--   * Cancelar un pedido que YA salio de cocina (en_camino, entregado...) cierra la solicitud como "mantener" y devuelve aplicado = true (la decision SI
--     se aplico en esta llamada: sale el aviso al cliente "no se pudo cancelar, sigue en proceso" y queda en la bitacora). Un doble clic posterior sigue
--     devolviendo aplicado = false, sin repetir nada.
--   * Nueva columna de salida `motivo_resolucion` (codigo de la lista cerrada o 'no_cancelable_<estado>' / 'pedido_ya_no_estaba_por_aprobar'): el panel
--     distingue "ya estaba resuelta", "el pedido ya no estaba por aprobar" y "ya salio, no se pudo cancelar". Solo expone codigos de lista cerrada o un
--     estado del pedido: nunca texto libre del staff ni datos personales.
--   * Se CONSERVAN TODAS las guardas de la 075: reponer_producto y descuento_proximo solo para owner/admin con alcance (42501), un solo codigo de
--     compensacion y una sola reposicion por pedido, tope de 20 unidades por reposicion, mas las de la 050 (security definer, search_path fijo, auth.uid(),
--     alcance a la sucursal, misma organizacion, decision y motivo de listas cerradas).
-- Cambia el tipo de retorno (columna nueva), por eso DROP + CREATE; la firma de entrada es identica. El revoke/grant se repite porque el DROP descarta los
-- permisos: nada a anon. Compatibilidad con la base sin migrar: el codigo TypeScript lee la columna nueva como opcional.

drop function if exists restaurantes.solicitud_resolver(uuid, uuid, text, text, integer, integer[]);

create function restaurantes.solicitud_resolver(
  p_organization_id uuid,
  p_solicitud_id uuid,
  p_decision text,
  p_motivo text,
  p_valor integer default null,
  p_item_indices integer[] default null
) returns table (
  aplicado boolean, estado text, decision text, tipo text, order_id uuid, property_id uuid,
  estado_pedido text, codigo_descuento text, reposicion_order_id uuid, motivo_resolucion text
)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_s restaurantes.solicitud_aprobacion;
  v_o restaurantes.orders;
  v_to text;
  v_codigo text;
  v_tope integer;
  v_repo uuid;
  v_items jsonb;
  v_uid uuid := auth.uid();
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
begin
  select * into v_s from restaurantes.solicitud_aprobacion s where s.id = p_solicitud_id and s.organization_id = p_organization_id for update;
  if not found or v_uid is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_s.property_id, false) then
    raise exception 'solicitud_resolver: inexistente o sin acceso' using errcode = '42501';
  end if;
  if v_s.estado = 'resuelta' then
    return query select false, v_s.estado, v_s.decision, v_s.tipo, v_s.order_id, v_s.property_id,
      (select o.status from restaurantes.orders o where o.id = v_s.order_id), v_s.codigo_descuento, v_s.reposicion_order_id, v_s.motivo_resolucion;
    return;
  end if;
  if (v_s.tipo = 'pedido_grande' and p_decision not in ('aprobar', 'rechazar'))
     or (v_s.tipo = 'cancelacion' and p_decision not in ('cancelar', 'mantener'))
     or (v_s.tipo = 'compensacion' and p_decision not in ('sin_compensacion', 'reponer_producto', 'descuento_proximo'))
     or (v_s.tipo = 'pausa_sucursal' and p_decision not in ('pausar', 'descartar')) then
    raise exception 'solicitud_resolver: decision invalida para %', v_s.tipo using errcode = '22023';
  end if;
  if v_motivo is not null and char_length(v_motivo) > 200 then
    raise exception 'solicitud_resolver: motivo demasiado largo' using errcode = '22023';
  end if;
  -- QA R2 seguridad-03: reponer producto (pedido de $0 a cocina) y emitir un codigo de descuento son decisiones de dinero: solo owner/admin
  -- con alcance a la sucursal. "Sin compensacion" y las decisiones de pedido grande/cancelacion siguen abiertas al staff con alcance.
  if v_s.tipo = 'compensacion' and p_decision in ('reponer_producto', 'descuento_proximo')
     and not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_s.property_id, true) then
    raise exception 'solicitud_resolver: reponer o descontar solo lo decide un owner/admin' using errcode = '42501';
  end if;

  if v_s.order_id is not null then
    select * into v_o from restaurantes.orders o where o.id = v_s.order_id and o.organization_id = p_organization_id for update;
  end if;

  if v_s.tipo = 'pedido_grande' then
    if v_o.status <> 'por_aprobar' then
      -- Ya no esta por aprobar (alguien lo cancelo o lo movio): se cierra la solicitud sin tocar el pedido.
      update restaurantes.solicitud_aprobacion s set estado = 'resuelta', decision = case when p_decision = 'aprobar' then 'aprobar' else 'rechazar' end,
        motivo_resolucion = 'pedido_ya_no_estaba_por_aprobar', resuelta_at = now(), resuelta_por = v_uid where s.id = v_s.id;
      return query select false, 'resuelta'::text, p_decision, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, null::text, null::uuid, 'pedido_ya_no_estaba_por_aprobar'::text;
      return;
    end if;
    if p_decision = 'aprobar' then
      v_to := case when v_o.programado_para is not null and v_o.programado_para > now() then 'programado' else 'pending' end;
      perform set_config('app.motivo', 'aprobado', true);
    else
      if v_motivo is null or v_motivo not in ('cliente_desistio', 'sin_producto', 'fuera_de_zona', 'duplicado', 'error_agente', 'otro') then
        raise exception 'solicitud_resolver: rechazar exige un motivo de la lista cerrada' using errcode = '22023';
      end if;
      v_to := 'cancelado';
      perform set_config('app.motivo', v_motivo, true);
    end if;
    update restaurantes.orders set status = v_to where orders.id = v_o.id and orders.status = 'por_aprobar';
    perform set_config('app.motivo', '', true);
    v_o.status := v_to;
  elsif v_s.tipo = 'cancelacion' and p_decision = 'cancelar' then
    if v_motivo is null or v_motivo not in ('cliente_desistio', 'sin_producto', 'fuera_de_zona', 'duplicado', 'error_agente', 'otro') then
      raise exception 'solicitud_resolver: cancelar exige un motivo de la lista cerrada' using errcode = '22023';
    end if;
    if v_o.status not in ('pending', 'programado', 'preparando', 'listo_para_recoger', 'no_recogido', 'problema', 'por_aprobar') then
      -- Ya salio o ya cerro: no se puede cancelar; la decision queda como mantener.
      update restaurantes.solicitud_aprobacion s set estado = 'resuelta', decision = 'mantener', motivo_resolucion = 'no_cancelable_' || v_o.status,
        resuelta_at = now(), resuelta_por = v_uid where s.id = v_s.id;
      -- CAMBIO de la 079 (cierre honesto de #470): la decision SI se aplico en esta llamada (la solicitud se cerro como "mantener" ahora mismo), asi que el
      -- llamador debe disparar el aviso al cliente "no se pudo cancelar" y la bitacora. Antes devolvia aplicado = false (indistinguible de un doble clic).
      return query select true, 'resuelta'::text, 'mantener'::text, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, null::text, null::uuid, ('no_cancelable_' || v_o.status)::text;
      return;
    end if;
    perform set_config('app.motivo', v_motivo, true);
    update restaurantes.orders set status = 'cancelado' where orders.id = v_o.id;
    perform set_config('app.motivo', '', true);
    v_o.status := 'cancelado';
  elsif v_s.tipo = 'compensacion' and p_decision = 'descuento_proximo' then
    -- QA R2 seguridad-03: un solo codigo de compensacion por pedido (sin esto, cada nueva queja del mismo pedido emitia otro).
    if exists (select 1 from restaurantes.solicitud_aprobacion x
                where x.organization_id = p_organization_id and x.order_id = v_s.order_id and x.id <> v_s.id and x.codigo_descuento is not null) then
      raise exception 'solicitud_resolver: este pedido ya recibio un codigo de compensacion' using errcode = '22023';
    end if;
    select c.compensacion_tope_pct into v_tope from restaurantes.autopiloto_config_leer(p_organization_id, v_s.property_id) c;
    if p_valor is null or p_valor < 1 or p_valor > coalesce(v_tope, 20) then
      raise exception 'solicitud_resolver: el descuento debe ser de 1 a % por ciento', coalesce(v_tope, 20) using errcode = '22023';
    end if;
    v_codigo := 'GRACIAS-' || upper(substr(md5(random()::text || clock_timestamp()::text || v_s.id::text), 1, 8));
    insert into restaurantes.promotions (organization_id, code, name, description, type, value, starts_at, ends_at, max_uses, is_active)
    values (p_organization_id, v_codigo, 'Compensacion de un solo uso', 'Compensacion por una queja; un solo uso.', 'percentage', p_valor,
            now(), now() + interval '30 days', 1, true);
  elsif v_s.tipo = 'compensacion' and p_decision = 'reponer_producto' then
    if v_o.id is null then
      raise exception 'solicitud_resolver: la compensacion no tiene pedido' using errcode = '22023';
    end if;
    -- QA R2 seguridad-03: una sola reposicion sin costo por pedido original.
    if exists (select 1 from restaurantes.solicitud_aprobacion x
                where x.organization_id = p_organization_id and x.order_id = v_s.order_id and x.id <> v_s.id and x.reposicion_order_id is not null) then
      raise exception 'solicitud_resolver: este pedido ya tuvo una reposicion sin costo' using errcode = '22023';
    end if;
    if p_item_indices is null or cardinality(p_item_indices) = 0 or cardinality(p_item_indices) > 20 then
      raise exception 'solicitud_resolver: elija al menos un renglon a reponer' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(jsonb_set(it.elem, '{price}', '0'::jsonb)), '[]'::jsonb) into v_items
      from jsonb_array_elements(v_o.items) with ordinality as it(elem, ord)
     where (it.ord - 1)::integer = any (p_item_indices);
    if jsonb_array_length(v_items) = 0 then
      raise exception 'solicitud_resolver: renglones a reponer invalidos' using errcode = '22023';
    end if;
    -- QA R2 seguridad-03: tope de unidades por reposicion sin costo (un renglon de cantidad enorme no se repone entero).
    if (select coalesce(sum(case when jsonb_typeof(e -> 'quantity') = 'number' then (e ->> 'quantity')::numeric else 1 end), 0)
          from jsonb_array_elements(v_items) as e) > 20 then
      raise exception 'solicitud_resolver: la reposicion sin costo admite hasta 20 unidades' using errcode = '22023';
    end if;
    insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, branch, total,
                                     status, items, source, notes, payment_method, canal, idempotency_key)
    values (p_organization_id, v_o.property_id, v_o.customer_id, v_o.customer_name, v_o.customer_phone, v_o.customer_address, v_o.branch, 0,
            'pending', v_items, 'admin', 'Reposicion sin costo del pedido #' || v_o.order_number::text || '.', null, v_o.canal,
            encode(sha256(convert_to('reposicion:' || v_s.id::text, 'utf8')), 'hex'))
    on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
    returning orders.id into v_repo;
    if v_repo is null then
      select o2.id into v_repo from restaurantes.orders o2
       where o2.organization_id = p_organization_id and o2.idempotency_key = encode(sha256(convert_to('reposicion:' || v_s.id::text, 'utf8')), 'hex');
    end if;
  end if;

  update restaurantes.solicitud_aprobacion s set
    estado = 'resuelta', decision = p_decision,
    -- Seguridad (defensa en profundidad de datos personales): el motivo solo se conserva si pertenece a la lista cerrada; un texto libre del staff
    -- (que podria incluir nombres o telefonos) en aprobar/mantener/sin_compensacion/etc. NO se guarda. Cancelar y rechazar ya lo exigen de la lista.
    motivo_resolucion = case when v_motivo in ('cliente_desistio', 'sin_producto', 'fuera_de_zona', 'duplicado', 'error_agente', 'otro') then v_motivo else null end,
    codigo_descuento = v_codigo,
    reposicion_order_id = v_repo, resuelta_at = now(), resuelta_por = v_uid
  where s.id = v_s.id;
  return query select true, 'resuelta'::text, p_decision, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, v_codigo, v_repo,
    case when v_motivo in ('cliente_desistio', 'sin_producto', 'fuera_de_zona', 'duplicado', 'error_agente', 'otro') then v_motivo else null end;
end;
$$;

revoke all on function restaurantes.solicitud_resolver(uuid, uuid, text, text, integer, integer[]) from public, anon;
grant execute on function restaurantes.solicitud_resolver(uuid, uuid, text, text, integer, integer[]) to authenticated;
