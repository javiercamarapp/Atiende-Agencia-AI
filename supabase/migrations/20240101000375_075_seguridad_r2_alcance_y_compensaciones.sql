-- QA restaurantes ronda 2, lote seguridad (hallazgos QA-restaurantes-R2-seguridad-02, 03, 04, 05, 06 y 08). Endurecimientos de
-- defensa en profundidad y de integridad; ninguno cambia el contrato de las funciones (mismas firmas, mismos GRANT).
--
-- Requiere: 010 (promotions), 028 (handoff_actor_en_sucursal), 043/0039 (core.emit_notification), 049 (cliente_*), 050 (solicitud_*),
-- 062 (storefront_marca_sello) y 063 (order_privacy_consent). NO duplica el PR #403 (migracion 064, lote R1): esta migracion no toca
-- orders/customers/whatsapp_conversations ni las policies de escritura de promotions; coexiste con ella en cualquier orden (los
-- nombres de policy son distintos y todas las sentencias son create or replace / drop if exists).
--
-- Compatibilidad con la base sin migrar: solo cambia el CUERPO de funciones existentes y una policy; el TypeScript que las llama no
-- cambia de firma. Contra una base sin esta migracion el comportamiento es el de antes (sin las nuevas negativas 42501/22023).
--
--  1) R2-seguridad-02 (P1) promotions: se elimina la policy "cualquiera puede ver promociones activas" (is_active = true, sin
--     organizacion ni usuario): cualquier sesion autenticada -- y anon, por la llave publica -- leia los codigos activos de TODAS las
--     organizaciones, incluidos los GRACIAS-* de un solo uso. Nueva policy: SOLO la sesion de sistema (auth.uid() is null: checkout web,
--     WhatsApp y voz resuelven el codigo por su texto) ve promociones activas. Los owner/admin siguen viendo las de SU organizacion por la
--     policy de 065 ("duenos y admins ven las promociones de su organizacion"). Como la sesion de sistema y anon comparten
--     auth.uid() is null, tambien se revoca el SELECT de anon sobre la tabla (la sesion de sistema corre como authenticated sin usuario).
--  2) R2-seguridad-03 (P2) separacion de funciones en compensaciones: solicitud_crear exige sistema u owner/admin para el tipo
--     'compensacion' (antes cualquier staff con alcance); solicitud_resolver exige owner/admin para reponer_producto y descuento_proximo
--     (las dos decisiones que mueven dinero), y agrega topes: una reposicion y un codigo por pedido original, y hasta 20 unidades por
--     reposicion sin costo. "Sin compensacion" y pedido grande/cancelacion siguen abiertos al staff con alcance.
--  3) R2-seguridad-04 (P2) core.emit_notification: una SESION DE USUARIO en una organizacion de restaurantes (no sistema, no superadmin)
--     ya no puede emitir avisos criticos, ni de otro vertical, ni con una clave de dedupe ajena a su tipo; un repartidor solo emite la
--     incidencia de repartidor; y su tope por hora es de 30 por destinatario (el del sistema sigue en 100): el relleno de un usuario ya
--     no agota el cupo con el que el sistema avisa pedidos grandes, cancelaciones y compensaciones. Las demas verticales no cambian.
--  4) R2-seguridad-05 (P2) cliente_marcar_pedido_falso respeta el alcance por sucursal de la membresia (handoff_actor_en_sucursal
--     sobre la sucursal DEL PEDIDO, no la que diga el llamador).
--  5) R2-seguridad-06 (P2) cliente_exportar_arco entrega todo lo que se trata del titular (LFPDPPP art. 23): ademas de ficha, domicilios,
--     gustos y pedidos, ahora incluye las conversaciones de WhatsApp, las solicitudes de contacto, las llamadas de voz con sus turnos,
--     la direccion/notas/transcripcion/consentimiento de cada pedido y el historial de solicitudes ARCO, y DECLARA lo que no incluye y
--     por que (clave `no_incluido`). Sigue siendo solo owner/admin, security definer y de la organizacion indicada.
--  6) R2-seguridad-08 (P3) storefront_marca_sello (funcion de trigger de 062) sin EXECUTE para public/anon. Un trigger no necesita
--     EXECUTE del usuario que dispara la sentencia; solo se corrige la higiene de GRANT de la casa.
--
-- Justificacion de seguridad de cada objeto (todas las funciones: security definer con search_path fijo, `revoke ... from public, anon`,
-- `grant execute ... to authenticated`; la autorizacion real esta dentro de cada una; ningun using (true); ningun GRANT a anon):
--  * policy "sistema resuelve promociones activas (r2)": using (auth.uid() is null and is_active). Un usuario nunca la satisface; el
--    sistema solo ve lo activo, igual que 014 hizo con el catalogo.
--  * solicitud_crear / solicitud_resolver: mismas firmas y mismo GRANT; solo se agregan negativas (42501) y topes (22023).
--  * core.emit_notification: la rama nueva solo REDUCE lo que un usuario puede hacer; la sesion de sistema y los superadmin no cambian.
--  * cliente_marcar_pedido_falso: la sucursal del pedido sale de la base; sin alcance = 42501 (igual que pedido inexistente: no revela
--    si el pedido existe en otra sucursal).
--  * cliente_exportar_arco: solo owner/admin (cliente_es_admin); toda lectura filtra por la organizacion indicada; la ruta de voz
--    compara hashes sha256 del telefono (no lee telefonos de otras personas).

create or replace function restaurantes.solicitud_crear(
  p_organization_id uuid,
  p_property_id uuid,
  p_tipo text,
  p_order_id uuid,
  p_detalle jsonb
) returns table (id uuid, creada boolean)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  if p_tipo not in ('cancelacion', 'compensacion', 'pausa_sucursal') then
    raise exception 'solicitud_crear: tipo invalido (el pedido grande se crea con solicitud_pedido_grande_retener)' using errcode = '22023';
  end if;
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'solicitud_crear: sucursal ajena' using errcode = '42501';
  end if;
  if auth.uid() is not null and not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'solicitud_crear: sin acceso a la sucursal' using errcode = '42501';
  end if;
  -- QA R2 seguridad-03: una compensacion nace de la queja de un cliente (la crea el sistema/agente). Un usuario solo puede
  -- crearla si es owner/admin de la sucursal; un staff no se la crea a si mismo para luego aprobarla.
  if p_tipo = 'compensacion' and auth.uid() is not null and not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'solicitud_crear: la compensacion solo la crea el sistema o un owner/admin' using errcode = '42501';
  end if;
  if p_order_id is not null and not exists (
    select 1 from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id and o.property_id = p_property_id
  ) then
    raise exception 'solicitud_crear: pedido ajeno' using errcode = '42501';
  end if;
  insert into restaurantes.solicitud_aprobacion (organization_id, property_id, tipo, order_id, detalle)
  values (p_organization_id, p_property_id, p_tipo, p_order_id, coalesce(p_detalle, '{}'::jsonb))
  on conflict do nothing
  returning solicitud_aprobacion.id into v_id;
  if v_id is not null then
    return query select v_id, true;
    return;
  end if;
  return query
    select s.id, false from restaurantes.solicitud_aprobacion s
     where s.organization_id = p_organization_id and s.estado = 'pendiente' and s.tipo = p_tipo
       and ((p_order_id is not null and s.order_id = p_order_id) or (p_order_id is null and s.property_id = p_property_id))
     limit 1;
end;
$$;

create or replace function restaurantes.solicitud_resolver(
  p_organization_id uuid,
  p_solicitud_id uuid,
  p_decision text,
  p_motivo text,
  p_valor integer default null,
  p_item_indices integer[] default null
) returns table (
  aplicado boolean, estado text, decision text, tipo text, order_id uuid, property_id uuid,
  estado_pedido text, codigo_descuento text, reposicion_order_id uuid
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
      (select o.status from restaurantes.orders o where o.id = v_s.order_id), v_s.codigo_descuento, v_s.reposicion_order_id;
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
      return query select false, 'resuelta'::text, p_decision, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, null::text, null::uuid;
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
      return query select false, 'resuelta'::text, 'mantener'::text, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, null::text, null::uuid;
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
  return query select true, 'resuelta'::text, p_decision, v_s.tipo, v_s.order_id, v_s.property_id, v_o.status, v_codigo, v_repo;
end;
$$;

create or replace function restaurantes.cliente_marcar_pedido_falso(p_organization_id uuid, p_order_id uuid, p_falso boolean)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
  v_prop uuid;
begin
  if not restaurantes.cliente_es_gestor(p_organization_id) then
    raise exception 'cliente_marcar_pedido_falso: solo owner/admin/staff de la organizacion' using errcode = '42501';
  end if;
  -- QA R2 seguridad-05: ademas del rol, el alcance por sucursal de la membresia (un staff acotado a A1 no marca pedidos de A2).
  -- La sucursal sale del pedido (no del llamador). Pedido inexistente en la organizacion = el mismo 42501 de siempre.
  select o.property_id into v_prop from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id;
  if not found or not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_prop, false) then
    raise exception 'pedido inexistente en la organizacion o fuera de su sucursal' using errcode = '42501';
  end if;
  update restaurantes.orders o
     set pedido_falso_at = case when coalesce(p_falso, true) then now() else null end,
         pedido_falso_por = case when coalesce(p_falso, true) then auth.uid() else null end
   where o.id = p_order_id and o.organization_id = p_organization_id
  returning o.id into v_id;
  if v_id is null then
    raise exception 'pedido inexistente en la organizacion' using errcode = '42501';
  end if;
  return coalesce(p_falso, true);
end;
$$;

create or replace function core.emit_notification(
  p_organization_id uuid,
  p_property_id uuid,
  p_tipo text,
  p_categoria text,
  p_severidad text,
  p_titulo text,
  p_cuerpo text,
  p_enlace text,
  p_entidad_tipo text,
  p_entidad_id uuid,
  p_dedupe_key text,
  p_roles text[],
  p_expires_in interval
) returns integer
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_vertical text;
  v_slug text;
  v_enlace text := p_enlace;
  v_recipients uuid[];
  v_staff uuid;
  v_inserted integer;
  v_expires interval := coalesce(p_expires_in, interval '90 days');
  v_acotado boolean := false;
  v_rol text;
  v_tope integer := 100;
begin
  if p_dedupe_key is null or length(p_dedupe_key) = 0 then
    raise exception 'emit_notification: la clave de dedupe es obligatoria' using errcode = '22023';
  end if;
  if p_titulo is null or length(p_titulo) = 0 or length(p_titulo) > 160 then
    raise exception 'emit_notification: titulo vacio o de mas de 160 caracteres' using errcode = '22023';
  end if;
  if p_cuerpo is not null and length(p_cuerpo) > 500 then
    raise exception 'emit_notification: cuerpo de mas de 500 caracteres' using errcode = '22023';
  end if;
  -- Misma validacion que los CHECK de la tabla, hecha ANTES de resolver destinatarios: una llamada
  -- invalida falla igual aunque no haya a quien notificar (un productor con bug no pasa desapercibido).
  if p_tipo is null or p_tipo !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' then
    raise exception 'emit_notification: tipo con formato invalido' using errcode = '22023';
  end if;
  if p_categoria is null or p_categoria !~ '^[a-z][a-z_]{1,39}$' then
    raise exception 'emit_notification: categoria con formato invalido' using errcode = '22023';
  end if;
  if coalesce(p_severidad, 'info') not in ('info', 'atencion', 'critica') then
    raise exception 'emit_notification: severidad fuera de catalogo' using errcode = '22023';
  end if;
  if p_enlace is not null and (p_enlace !~ '^/[A-Za-z0-9_{][A-Za-z0-9_{}/.?&=#%:@+~-]*$' or length(p_enlace) > 300) then
    raise exception 'emit_notification: el enlace debe ser una ruta interna relativa' using errcode = '22023';
  end if;
  if v_expires <= interval '0' or v_expires > interval '365 days' then
    raise exception 'emit_notification: la vigencia debe estar entre 0 y 365 dias' using errcode = '22023';
  end if;

  if p_organization_id is null then
    -- Notificacion de PLATAFORMA: sesion de sistema o superadmin real.
    if v_uid is not null and not exists (select 1 from core.platform_superadmin where staff_user_id = v_uid) then
      raise exception 'emit_notification: solo el sistema o un superadmin emiten notificaciones de plataforma' using errcode = '42501';
    end if;
    select coalesce(array_agg(sa.staff_user_id), '{}') into v_recipients from core.platform_superadmin sa;
  else
    select o.vertical, o.slug into v_vertical, v_slug from core.organization o where o.id = p_organization_id;
    if v_vertical is null then
      raise exception 'emit_notification: organizacion inexistente' using errcode = 'P0002';
    end if;
    if v_uid is not null
       and not exists (select 1 from core.membership m where m.user_id = v_uid and m.organization_id = p_organization_id)
       and not exists (select 1 from core.platform_superadmin where staff_user_id = v_uid) then
      raise exception 'emit_notification: el usuario no pertenece a la organizacion' using errcode = '42501';
    end if;
    if p_property_id is not null
       and not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
      raise exception 'emit_notification: la propiedad no pertenece a la organizacion' using errcode = '22023';
    end if;
    -- QA R2 seguridad-04: en una organizacion de restaurantes una SESION DE USUARIO (no sistema, no superadmin) emite solo avisos de
    -- su vertical, nunca criticos, con la clave de dedupe de su propio tipo (el productor TypeScript siempre usa `<tipo>:<clave>`), un
    -- repartidor solo el aviso de incidencia, y con un tope por hora MENOR que el del sistema: el relleno de un usuario nunca agota el
    -- cupo con el que el sistema avisa pedidos grandes, cancelaciones y compensaciones.
    if v_uid is not null and v_vertical = 'restaurantes' and not exists (select 1 from core.platform_superadmin where staff_user_id = v_uid) then
      v_acotado := true;
      select m.vertical_role into v_rol from core.membership m where m.user_id = v_uid and m.organization_id = p_organization_id limit 1;
      if coalesce(p_severidad, 'info') = 'critica' then
        raise exception 'emit_notification: un aviso critico solo lo emite el sistema' using errcode = '42501';
      end if;
      if p_tipo not like 'restaurantes.%' or left(p_dedupe_key, length(p_tipo) + 1) <> p_tipo || ':' then
        raise exception 'emit_notification: el tipo y la clave de dedupe deben ser del vertical y del tipo del aviso' using errcode = '42501';
      end if;
      if coalesce(v_rol, '') not in ('owner', 'admin', 'staff') and p_tipo <> 'restaurantes.pedido.incidencia_repartidor' then
        raise exception 'emit_notification: este rol solo puede emitir el aviso de incidencia de repartidor' using errcode = '42501';
      end if;
      v_tope := 30;
    end if;
    -- El marcador {orgSlug} del enlace se resuelve aqui con el slug real de la organizacion: el
    -- productor no necesita conocerlo y el enlace nunca lleva un dato que no salga de la base.
    v_enlace := replace(p_enlace, '{orgSlug}', v_slug);
    select coalesce(array_agg(m.user_id), '{}') into v_recipients
    from core.membership m
    where m.organization_id = p_organization_id
      and (m.platform_role in ('owner', 'admin') or (p_roles is not null and m.vertical_role = any (p_roles)))
      and (p_property_id is null or m.property_ids is null or p_property_id = any (m.property_ids))
      -- R-16: quien apago este tipo de aviso en sus preferencias no lo recibe (sin fila = encendido).
      and not exists (
        select 1 from core.notification_preference np
        where np.organization_id = m.organization_id and np.user_id = m.user_id and np.tipo = p_tipo and np.enabled = false
      );
  end if;

  v_inserted := 0;
  foreach v_staff in array v_recipients loop
    -- Retencion: vencidas o de mas de 180 dias de ESTE destinatario (acotado, usa el indice).
    delete from core.notification
    where id in (
      select n.id from core.notification n
      where n.staff_user_id = v_staff
        and (n.expires_at < now() or n.created_at < now() - interval '180 days')
      limit 200
    );

    -- Tope de volumen: maximo 100 por destinatario por hora (30 para una sesion de usuario de restaurantes, ver arriba).
    if (select count(*) from core.notification x where x.staff_user_id = v_staff and x.created_at > now() - interval '1 hour') >= v_tope then
      continue;
    end if;

    insert into core.notification (
      staff_user_id, organization_id, vertical, tipo, categoria, severidad, titulo, cuerpo, enlace,
      entidad_tipo, entidad_id, dedupe_key, expires_at
    ) values (
      v_staff, p_organization_id, v_vertical, p_tipo, p_categoria, coalesce(p_severidad, 'info'), p_titulo, p_cuerpo, v_enlace,
      p_entidad_tipo, p_entidad_id, p_dedupe_key, now() + v_expires
    )
    on conflict (staff_user_id, dedupe_key) where dedupe_key is not null do nothing;
    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return v_inserted;
end;
$$;
-- ---------------------------------------------------------------------------
-- 1) R2-seguridad-02 -- promotions: solo el sistema resuelve promociones activas; anon sin SELECT
-- ---------------------------------------------------------------------------
drop policy if exists "cualquiera puede ver promociones activas" on restaurantes.promotions;
drop policy if exists "sistema resuelve promociones activas (r2)" on restaurantes.promotions;
create policy "sistema resuelve promociones activas (r2)" on restaurantes.promotions for select
  using (auth.uid() is null and is_active = true);
revoke select on restaurantes.promotions from anon;

-- ---------------------------------------------------------------------------
-- 5) R2-seguridad-06 -- cliente_exportar_arco completo (derecho de acceso)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_exportar_arco(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_c restaurantes.customers;
  v_digitos text;
  v_clave text;
  v_hashes text[];
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'cliente_exportar_arco: solo owner/admin de la organizacion (derechos ARCO)' using errcode = '42501';
  end if;
  select * into v_c from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  -- Clave del titular: sus ultimos 10 digitos (mismo criterio que 040 para cruzar canales). Con menos de 7 digitos no se cruza nada
  -- por telefono (evita exportar datos de otra persona por un numero demasiado corto).
  v_digitos := regexp_replace(coalesce(v_c.phone, ''), '\D', '', 'g');
  v_clave := case when length(v_digitos) >= 7 then right(v_digitos, 10) else null end;
  v_hashes := case when v_clave is null then array[]::text[] else array[
    encode(sha256(convert_to(v_digitos, 'UTF8')), 'hex'),
    encode(sha256(convert_to(v_clave, 'UTF8')), 'hex'),
    encode(sha256(convert_to('52' || v_clave, 'UTF8')), 'hex'),
    encode(sha256(convert_to('521' || v_clave, 'UTF8')), 'hex')
  ] end;
  return jsonb_build_object(
    'nombre', v_c.name,
    'telefono', v_c.phone,
    'fecha_nacimiento_dia', v_c.fecha_nacimiento_dia,
    'fecha_nacimiento_mes', v_c.fecha_nacimiento_mes,
    'notas_del_restaurante', v_c.staff_notes,
    'primer_registro', v_c.created_at,
    'domicilios', restaurantes.cliente_direcciones_json(v_c.id),
    'gustos', restaurantes.cliente_gustos_json(v_c.id),
    'pedidos', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'numero', o.order_number, 'fecha', o.created_at, 'estado', o.status, 'total', o.total, 'productos', o.items, 'sucursal', o.branch,
        'nombre_en_el_pedido', o.customer_name, 'telefono_en_el_pedido', o.customer_phone, 'direccion_de_entrega', o.customer_address,
        'canal', o.canal, 'origen', o.source, 'notas', o.notes, 'nota_de_incidencia', o.incident_note,
        'transcripcion_de_llamada', o.call_transcript, 'grabacion_de_llamada', o.call_recording_url,
        'consentimiento_de_aviso', (
          select jsonb_build_object('version_del_aviso', pc.notice_version, 'canal', pc.channel, 'fecha', pc.accepted_at)
            from restaurantes.order_privacy_consent pc where pc.order_id = o.id and pc.organization_id = p_organization_id
        )
      ) order by o.created_at desc), '[]'::jsonb)
        from restaurantes.orders o
       where o.organization_id = p_organization_id
         and (o.customer_id = v_c.id or (v_clave is not null and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = v_clave))
    ),
    'conversaciones_whatsapp', (
      select coalesce(jsonb_agg(jsonb_build_object('desde', w.created_at, 'actualizada', w.updated_at, 'estado', w.status, 'mensajes', w.messages) order by w.created_at), '[]'::jsonb)
        from restaurantes.whatsapp_conversations w
       where w.organization_id = p_organization_id and v_clave is not null and right(regexp_replace(w.phone, '\D', '', 'g'), 10) = v_clave
    ),
    'solicitudes_de_contacto', (
      select coalesce(jsonb_agg(jsonb_build_object('fecha', r.created_at, 'nombre', r.customer_name, 'telefono', r.customer_phone, 'motivo', r.reason, 'mensaje', r.message, 'canal', r.source, 'atendida', r.resolved) order by r.created_at), '[]'::jsonb)
        from restaurantes.callback_requests r
       where r.organization_id = p_organization_id and v_clave is not null and right(regexp_replace(r.customer_phone, '\D', '', 'g'), 10) = v_clave
    ),
    'llamadas_de_voz', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'inicio', vc.started_at, 'fin', vc.ended_at, 'duracion_s', vc.duration_s, 'resultado', vc.resultado,
        'turnos', (select coalesce(jsonb_agg(jsonb_build_object('rol', t.rol, 'texto', t.texto, 'fecha', t.created_at) order by t.seq), '[]'::jsonb)
                     from restaurantes.voice_turn t where t.conversation_id = vc.id)
      ) order by vc.started_at), '[]'::jsonb)
        from restaurantes.voice_conversation vc
       where vc.organization_id = p_organization_id and vc.caller_hash = any (v_hashes)
    ),
    'solicitudes_arco', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'derecho', q.right_type, 'canal', q.channel, 'estado', q.status, 'detalle', q.detail, 'solicitada', q.requested_at, 'resuelta', q.resolved_at, 'nota_de_resolucion', q.resolution_note,
        'historial', (select coalesce(jsonb_agg(jsonb_build_object('evento', e.event, 'de', e.from_status, 'a', e.to_status, 'nota', e.note, 'fecha', e.created_at) order by e.created_at, e.seq), '[]'::jsonb)
                        from restaurantes.data_rights_events e where e.request_id = q.id)
      ) order by q.requested_at), '[]'::jsonb)
        from restaurantes.data_rights_requests q
       where q.organization_id = p_organization_id and v_clave is not null and right(regexp_replace(q.customer_phone, '\D', '', 'g'), 10) = v_clave
    ),
    'no_incluido', jsonb_build_array(
      'Colas de envio de WhatsApp y correo (mensajes pendientes o ya enviados): son una copia transitoria de lo ya incluido y se depuran por retencion.',
      'Bitacoras de seguridad y de limite de uso: guardan solo huellas irreversibles (hash) de un identificador, no datos legibles del titular.',
      'Llamadas de voz cuyo identificador se guardo con una huella distinta a la del telefono registrado (otro formato de numero o una llave de seudonimizacion): solicitelas por la via ARCO del canal de voz.'
    )
  );
end;
$$;
revoke all on function restaurantes.cliente_exportar_arco(uuid, uuid) from public, anon;
grant execute on function restaurantes.cliente_exportar_arco(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reafirmar permisos de las funciones redefinidas (create or replace conserva los GRANT; esto deja el contrato explicito)
-- ---------------------------------------------------------------------------
revoke all on function restaurantes.solicitud_crear(uuid, uuid, text, uuid, jsonb) from public, anon;
grant execute on function restaurantes.solicitud_crear(uuid, uuid, text, uuid, jsonb) to authenticated;
revoke all on function restaurantes.solicitud_resolver(uuid, uuid, text, text, integer, integer[]) from public, anon;
grant execute on function restaurantes.solicitud_resolver(uuid, uuid, text, text, integer, integer[]) to authenticated;
revoke all on function restaurantes.cliente_marcar_pedido_falso(uuid, uuid, boolean) from public, anon;
grant execute on function restaurantes.cliente_marcar_pedido_falso(uuid, uuid, boolean) to authenticated;
revoke all on function core.emit_notification(uuid, uuid, text, text, text, text, text, text, text, uuid, text, text[], interval) from public, anon;
grant execute on function core.emit_notification(uuid, uuid, text, text, text, text, text, text, text, uuid, text, text[], interval) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) R2-seguridad-08 -- storefront_marca_sello sin EXECUTE para public/anon
-- ---------------------------------------------------------------------------
revoke all on function restaurantes.storefront_marca_sello() from public, anon;
