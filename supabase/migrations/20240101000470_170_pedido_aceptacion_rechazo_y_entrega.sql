-- 170 -- Ciclo operativo del pedido por la sucursal (F4b, pasos del dia manuales): ACEPTAR / RECHAZAR con tiempo prometido y motivo,
-- y ENTREGA marcada por la sucursal con hora real. Prefijo de supabase/migrations: 20240101000470.
-- Requiere: 090 (salio_at, listo_at, operador_puede), 092 (despachar_pedido: la salida con chofer YA existe y no se duplica), 050 (trigger de eventos).
--
-- Que agrega (todo aditivo e idempotente; nada existente cambia de tipo ni de regla):
--   1. restaurantes.orders: aceptado_at, aceptado_por, tiempo_prometido_min (5..240), rechazado_at, rechazo_motivo (lista cerrada), rechazo_nota (<= 240).
--   2. restaurantes.pedido_aceptar(org, pedido, minutos): pending -> preparando en UNA sentencia con compare-and-set; guarda quien, cuando y el tiempo
--      prometido; si el pedido no traia hora estimada, la fija (aceptado_at + minutos) para que la alerta de entrega tardia (043) use la promesa real.
--   3. restaurantes.pedido_rechazar(org, pedido, motivo, nota): pending -> cancelado con motivo de lista cerrada; el motivo queda en el historial de estados.
--   4. restaurantes.pedido_entregar_staff(org, pedido, ocurrio_en, cobrado): en_camino -> entregado con la HORA REAL en que ocurrio (puede ser pasada, nunca
--      futura ni anterior a la salida). El chofer sigue usando marcar_entrega (092).
--   5. restaurantes.operacion_tiempos(org, sucursal, desde, hasta): agregados de tiempo real vs prometido (solo conteos y promedios, sin PII).
--
-- Justificacion de seguridad (una por una):
--  * Columnas nuevas de orders: heredan el GRANT/policy de 007 (no se concede nada nuevo, ningun GRANT a anon). Las escriben SOLO las funciones de abajo.
--  * Las cuatro funciones de escritura son SECURITY DEFINER con `set search_path = restaurantes, core, pg_temp`, `revoke all from public, anon`, GRANT EXECUTE solo
--    a `authenticated`, y exigen auth.uid() no nulo (la sesion de sistema recibe 42501: aceptar/rechazar es una decision humana de la sucursal).
--  * Permiso ANTES de buscar el pedido: membresia owner/admin/staff de la organizacion; despues restaurantes.operador_puede(...) con la accion de la
--    matriz (aceptar = 'gestionar', que incluye al cajero; rechazar = 'cancelar' y entregar = 'despachar', que excluyen al cajero, igual que 090/092).
--  * Aislamiento: el pedido se busca por (id, organization_id); uno ajeno es P0404, igual que uno inexistente. Carrera: FOR UPDATE + compare-and-set.
--  * operacion_tiempos: definer, mismo guard de membresia con alcance a la sucursal, rango maximo 63 dias; devuelve solo agregados.
-- Codigos: 42501 sin permiso/sistema, P0404 no encontrado, P0409 el estado cambio, 22023 argumento invalido.
-- Compatibilidad con la base SIN migrar: el TypeScript captura 42883/42703 en SAVEPOINT y responde 503 honesto («requiere actualizar la base»).
-- REVERSA (solo pierde datos nuevos):
--     drop function if exists restaurantes.operacion_tiempos(uuid, uuid, timestamptz, timestamptz);
--     drop function if exists restaurantes.pedido_entregar_staff(uuid, uuid, timestamptz, numeric);
--     drop function if exists restaurantes.pedido_rechazar(uuid, uuid, text, text);
--     drop function if exists restaurantes.pedido_aceptar(uuid, uuid, integer);
--     alter table restaurantes.orders drop column if exists aceptado_at, drop column if exists aceptado_por, drop column if exists tiempo_prometido_min,
--       drop column if exists rechazado_at, drop column if exists rechazo_motivo, drop column if exists rechazo_nota;

alter table restaurantes.orders
  add column if not exists aceptado_at timestamptz,
  add column if not exists aceptado_por uuid references core.staff_user(id) on delete set null,
  add column if not exists tiempo_prometido_min integer check (tiempo_prometido_min is null or tiempo_prometido_min between 5 and 240),
  add column if not exists rechazado_at timestamptz,
  add column if not exists rechazo_motivo text check (rechazo_motivo is null or rechazo_motivo in ('sin_insumos', 'cerrado', 'fuera_de_zona', 'saturado', 'datos_incompletos', 'otro')),
  add column if not exists rechazo_nota text check (rechazo_nota is null or length(rechazo_nota) <= 240);

create or replace function restaurantes.pedido_aceptar(p_organization_id uuid, p_order_id uuid, p_minutos integer)
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
    raise exception 'pedido_aceptar no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_minutos is null or p_minutos < 5 or p_minutos > 240 then
    raise exception 'pedido_aceptar: tiempo prometido fuera de rango (5 a 240 minutos)' using errcode = '22023';
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
  if v_order.aceptado_at is not null and v_order.status <> 'pending' then
    return jsonb_build_object('resultado', 'ya_aplicado', 'estado', v_order.status, 'aceptado_at', v_order.aceptado_at, 'tiempo_prometido_min', v_order.tiempo_prometido_min);
  end if;
  if v_order.status <> 'pending' then
    raise exception 'el estado del pedido cambio' using errcode = 'P0409';
  end if;
  update restaurantes.orders
  set status = 'preparando',
      aceptado_at = v_ahora,
      aceptado_por = auth.uid(),
      tiempo_prometido_min = p_minutos,
      estimated_delivery_at = coalesce(estimated_delivery_at, v_ahora + make_interval(mins => p_minutos))
  where id = v_order.id and status = 'pending';
  return jsonb_build_object('resultado', 'aceptado', 'estado', 'preparando', 'aceptado_at', v_ahora, 'tiempo_prometido_min', p_minutos);
end;
$$;

create or replace function restaurantes.pedido_rechazar(p_organization_id uuid, p_order_id uuid, p_motivo text, p_nota text default null)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_ahora timestamptz := now();
  v_nota text := nullif(btrim(coalesce(p_nota, '')), '');
begin
  if auth.uid() is null then
    raise exception 'pedido_rechazar no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_motivo is null or p_motivo not in ('sin_insumos', 'cerrado', 'fuera_de_zona', 'saturado', 'datos_incompletos', 'otro') then
    raise exception 'pedido_rechazar: motivo invalido' using errcode = '22023';
  end if;
  if v_nota is not null and length(v_nota) > 240 then
    raise exception 'pedido_rechazar: la nota excede 240 caracteres' using errcode = '22023';
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
  if not restaurantes.operador_puede(v_order.organization_id, v_order.property_id, 'cancelar') then
    raise exception 'sin permiso para rechazar en esta sucursal' using errcode = '42501';
  end if;
  if v_order.status = 'cancelado' and v_order.rechazado_at is not null then
    return jsonb_build_object('resultado', 'ya_aplicado', 'estado', 'cancelado', 'rechazado_at', v_order.rechazado_at, 'motivo', v_order.rechazo_motivo);
  end if;
  if v_order.status <> 'pending' then
    raise exception 'el estado del pedido cambio' using errcode = 'P0409';
  end if;
  -- El trigger de eventos (050) lee este ajuste local: el motivo queda en el historial append-only.
  perform set_config('app.motivo', 'rechazo:' || p_motivo, true);
  update restaurantes.orders
  set status = 'cancelado', rechazado_at = v_ahora, rechazo_motivo = p_motivo, rechazo_nota = v_nota
  where id = v_order.id and status = 'pending';
  perform set_config('app.motivo', '', true);
  return jsonb_build_object('resultado', 'rechazado', 'estado', 'cancelado', 'rechazado_at', v_ahora, 'motivo', p_motivo);
end;
$$;

create or replace function restaurantes.pedido_entregar_staff(p_organization_id uuid, p_order_id uuid, p_ocurrio_en timestamptz default null, p_cobrado numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_ahora timestamptz := now();
  v_hora timestamptz;
begin
  if auth.uid() is null then
    raise exception 'pedido_entregar_staff no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_cobrado is not null and (p_cobrado < 0 or p_cobrado > 100000) then
    raise exception 'pedido_entregar_staff: monto cobrado fuera de rango' using errcode = '22023';
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
  if not restaurantes.operador_puede(v_order.organization_id, v_order.property_id, 'despachar') then
    raise exception 'sin permiso para marcar entregas en esta sucursal' using errcode = '42501';
  end if;
  v_hora := coalesce(p_ocurrio_en, v_ahora);
  if v_hora > v_ahora + interval '1 minute' then
    raise exception 'pedido_entregar_staff: la hora real no puede ser futura' using errcode = '22023';
  end if;
  if v_hora < v_ahora - interval '12 hours' then
    raise exception 'pedido_entregar_staff: la hora real no puede ser anterior a 12 horas' using errcode = '22023';
  end if;
  if v_order.status = 'entregado' then
    return jsonb_build_object('resultado', 'ya_aplicado', 'entregado_at', v_order.delivered_at);
  end if;
  if v_order.status <> 'en_camino' then
    raise exception 'el estado del pedido cambio' using errcode = 'P0409';
  end if;
  if v_hora < coalesce(v_order.salio_at, v_order.created_at) then
    raise exception 'pedido_entregar_staff: la hora real es anterior a la salida del pedido' using errcode = '22023';
  end if;
  update restaurantes.orders
  set status = 'entregado', delivered_at = v_hora, cobrado_monto = coalesce(p_cobrado, cobrado_monto)
  where id = v_order.id and status = 'en_camino';
  return jsonb_build_object('resultado', 'entregado', 'entregado_at', v_hora, 'salio_at', v_order.salio_at,
    'minutos_desde_aceptado', case when v_order.aceptado_at is null then null else round((extract(epoch from (v_hora - v_order.aceptado_at)) / 60.0)::numeric, 1) end,
    'tiempo_prometido_min', v_order.tiempo_prometido_min);
end;
$$;

create or replace function restaurantes.operacion_tiempos(p_organization_id uuid, p_property_id uuid, p_desde timestamptz, p_hasta timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_res jsonb;
begin
  if auth.uid() is null then
    raise exception 'operacion_tiempos no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde or p_hasta - p_desde > interval '63 days' then
    raise exception 'operacion_tiempos: rango invalido (maximo 63 dias)' using errcode = '22023';
  end if;
  if not exists (
    select 1 from core.membership m
    join core.property p on p.id = p_property_id and p.organization_id = p_organization_id
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
      and (m.property_ids is null or p_property_id = any (m.property_ids))
  ) then
    raise exception 'sin permiso para esta sucursal' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'pedidos', count(*),
    'aceptados', count(*) filter (where o.aceptado_at is not null),
    'rechazados', count(*) filter (where o.rechazado_at is not null),
    'entregados_con_promesa', count(*) filter (where o.delivered_at is not null and o.aceptado_at is not null and o.tiempo_prometido_min is not null),
    'a_tiempo', count(*) filter (where o.delivered_at is not null and o.aceptado_at is not null and o.tiempo_prometido_min is not null
                                   and o.delivered_at <= o.aceptado_at + make_interval(mins => o.tiempo_prometido_min)),
    'real_min_prom', round((avg(extract(epoch from (o.delivered_at - o.aceptado_at)) / 60.0)
                              filter (where o.delivered_at is not null and o.aceptado_at is not null and o.tiempo_prometido_min is not null))::numeric, 1),
    'prometido_min_prom', round((avg(o.tiempo_prometido_min) filter (where o.delivered_at is not null and o.aceptado_at is not null and o.tiempo_prometido_min is not null))::numeric, 1),
    'aceptacion_seg_prom', round((avg(extract(epoch from (o.aceptado_at - coalesce(o.promovido_at, o.created_at))))
                                    filter (where o.aceptado_at is not null))::numeric, 0),
    'salida_min_prom', round((avg(extract(epoch from (o.salio_at - o.aceptado_at)) / 60.0)
                                filter (where o.salio_at is not null and o.aceptado_at is not null))::numeric, 1),
    'rechazos_por_motivo', coalesce((select jsonb_object_agg(x.rechazo_motivo, x.n) from (
        select r.rechazo_motivo, count(*) as n from restaurantes.orders r
        where r.organization_id = p_organization_id and r.property_id = p_property_id and r.created_at >= p_desde and r.created_at < p_hasta and r.rechazado_at is not null and r.rechazo_motivo is not null
        group by r.rechazo_motivo) x), '{}'::jsonb)
  ) into v_res
  from restaurantes.orders o
  where o.organization_id = p_organization_id and o.property_id = p_property_id and o.created_at >= p_desde and o.created_at < p_hasta;
  return v_res;
end;
$$;

revoke all on function restaurantes.pedido_aceptar(uuid, uuid, integer) from public, anon;
revoke all on function restaurantes.pedido_rechazar(uuid, uuid, text, text) from public, anon;
revoke all on function restaurantes.pedido_entregar_staff(uuid, uuid, timestamptz, numeric) from public, anon;
revoke all on function restaurantes.operacion_tiempos(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function restaurantes.pedido_aceptar(uuid, uuid, integer) to authenticated;
grant execute on function restaurantes.pedido_rechazar(uuid, uuid, text, text) to authenticated;
grant execute on function restaurantes.pedido_entregar_staff(uuid, uuid, timestamptz, numeric) to authenticated;
grant execute on function restaurantes.operacion_tiempos(uuid, uuid, timestamptz, timestamptz) to authenticated;
