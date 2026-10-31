-- 120 (PM R23, flujo del PANEL): el staff atiende lo escalado desde el software.
--  * conversation_handoff: asignada_por / asignada_at (quien la reparte y cuando), resumen (≤1000), telefono_devolucion (≤32) y callback_id (el callback de esa escalada).
--  * restaurantes.handoff_asignar: un staff de la sucursal reparte una escalada abierta (pendiente o tomada) a otra persona con acceso a ESA sucursal. La asignada queda `tomada`
--    por la persona elegida (el asistente calla, igual que con «tomar») y se deja una nota interna con quien asigno y a quien. Si la tiene otra persona del panel, solo ella o un
--    owner/admin la reasigna; una toma de la app (coexistencia) la reparte cualquier staff.
--  * restaurantes.handoff_solicitar_voz: solo sistema. La llamada que cierra `escalado` abre un handoff `pendiente` canal `voz` con el resumen y el telefono para devolver la llamada,
--    tomados del callback de esa misma llamada. El callback se liga SOLO si el telefono (sha256 de los digitos) coincide con `voice_conversation.caller_hash`; una llamada anonima
--    (sin hash) conserva el handoff y el motivo pero NUNCA copia el telefono ni el resumen de un callback ajeno. Idempotente: una segunda llamada completa lo que falte.
--  * restaurantes.handoff_extra: lectura de resumen, telefono, callback, quien asigno y toma de la app (aparte de handoff_detalle para no cambiar su tipo de retorno).
--  * restaurantes.panel_alertas: lo que el panel debe gritar: chats sin tomar o sin respuesta humana tras N minutos, llamadas escaladas por devolver y pedidos `por_aprobar` mayores
--    a un monto. Solo lectura, solo staff de la sucursal; no escribe ni notifica (la campana ya la alimentan los avisos existentes).
-- Compatibilidad: base sin esta migracion (42703/42883) -> el TypeScript degrada: sin asignar (503 honesto), sin resumen/telefono de voz, sin alertas. Nada del 028-102 cambia de firma.
-- REVERSA: drop function if exists restaurantes.panel_alertas(uuid, uuid, integer, numeric); drop function if exists restaurantes.handoff_extra(uuid, uuid, uuid);
--          drop function if exists restaurantes.handoff_solicitar_voz(uuid, uuid, text); drop function if exists restaurantes.handoff_asignar(uuid, uuid, uuid, uuid);
--          alter table restaurantes.conversation_handoff drop column if exists asignada_por, drop column if exists asignada_at, drop column if exists resumen, drop column if exists telefono_devolucion, drop column if exists callback_id;
alter table restaurantes.conversation_handoff add column if not exists asignada_por uuid references core.staff_user(id) on delete set null;
alter table restaurantes.conversation_handoff add column if not exists asignada_at timestamptz;
alter table restaurantes.conversation_handoff add column if not exists resumen text check (resumen is null or char_length(resumen) <= 1000);
alter table restaurantes.conversation_handoff add column if not exists telefono_devolucion text check (telefono_devolucion is null or char_length(telefono_devolucion) <= 32);
alter table restaurantes.conversation_handoff add column if not exists callback_id uuid references restaurantes.callback_requests(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 1) Asignar una escalada a otra persona
-- ---------------------------------------------------------------------------
create or replace function restaurantes.handoff_asignar(
  p_organization_id uuid,
  p_property_id uuid,
  p_handoff_id uuid,
  p_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_h restaurantes.conversation_handoff;
  v_destino text;
  v_actor text;
begin
  if v_uid is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'handoff_asignar: sin acceso a la sucursal' using errcode = '42501';
  end if;
  -- La persona elegida debe poder atender ESTA sucursal (owner/admin/staff de la organizacion con alcance a la sucursal): nunca un repartidor ni alguien de otra organizacion.
  if p_user_id is null or not exists (
    select 1 from core.membership m
     where m.user_id = p_user_id and m.organization_id = p_organization_id
       and m.vertical_role in ('owner', 'admin', 'staff')
       and (m.property_ids is null or p_property_id = any (m.property_ids))
  ) then
    raise exception 'handoff_asignar: la persona elegida no atiende esta sucursal' using errcode = '42501';
  end if;
  select * into v_h from restaurantes.conversation_handoff h
    where h.id = p_handoff_id and h.organization_id = p_organization_id and h.property_id = p_property_id
    for update;
  if not found then
    raise exception 'handoff_asignar: inexistente o ajena' using errcode = '42501';
  end if;
  if v_h.estado not in ('pendiente', 'tomada') then
    return false; -- ya estaba devuelta/cerrada (idempotente)
  end if;
  if v_h.estado = 'tomada' and v_h.tomada_por = p_user_id then
    return false; -- ya es de esa persona
  end if;
  if v_h.estado = 'tomada' and v_h.tomada_por is not null and v_h.tomada_por <> v_uid
     and not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'handoff_asignar: la conversacion la tiene otra persona' using errcode = '42501';
  end if;
  update restaurantes.conversation_handoff set
    estado = 'tomada',
    tomada_por = p_user_id,
    tomada_por_app = false,
    tomada_at = coalesce(tomada_at, now()),
    ultima_humana_at = now(),
    asignada_por = v_uid,
    asignada_at = now(),
    updated_at = now()
  where id = v_h.id;
  select su.full_name into v_destino from core.staff_user su where su.id = p_user_id;
  select su.full_name into v_actor from core.staff_user su where su.id = v_uid;
  insert into restaurantes.conversation_note (organization_id, property_id, handoff_id, autor_id, texto)
  values (p_organization_id, p_property_id, v_h.id, v_uid,
          left('Asignada a ' || coalesce(v_destino, 'otra persona') || case when p_user_id = v_uid then ' (por si misma).' else ' por ' || coalesce(v_actor, 'el equipo') || '.' end, 2000));
  return true;
end;
$$;
revoke all on function restaurantes.handoff_asignar(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function restaurantes.handoff_asignar(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Voz: la llamada escalada abre un handoff con resumen y telefono para devolver la llamada (solo sistema)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.handoff_solicitar_voz(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_motivo text
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_v restaurantes.voice_conversation;
  v_cb restaurantes.callback_requests;
  v_id uuid;
  v_motivo text;
begin
  if auth.uid() is not null then
    raise exception 'handoff_solicitar_voz es solo de sistema' using errcode = '42501';
  end if;
  select * into v_v from restaurantes.voice_conversation c
    where c.id = p_conversation_id and c.organization_id = p_organization_id and c.canal = 'llamada';
  if not found then
    return null;
  end if;
  -- El callback de ESTA llamada: de voz, de la sucursal, creado durante la llamada (o minutos despues) y con el MISMO telefono (hash). Sin hash (llamada anonima) no se liga ninguno.
  if v_v.caller_hash is not null then
    select cb.* into v_cb from restaurantes.callback_requests cb
     where cb.organization_id = p_organization_id and cb.source = 'voice'
       and (cb.property_id is null or cb.property_id = v_v.property_id)
       and cb.created_at >= v_v.started_at - interval '1 minute'
       and cb.created_at <= coalesce(v_v.ended_at, now()) + interval '10 minutes'
       and encode(sha256(convert_to(regexp_replace(cb.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex') = v_v.caller_hash
     order by cb.created_at desc limit 1;
  end if;
  v_motivo := left(coalesce(nullif(btrim(p_motivo), ''), v_cb.reason, 'llamada_escalada'), 500);
  insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo, resumen, telefono_devolucion, callback_id)
    values (p_organization_id, v_v.property_id, 'voz', p_conversation_id, 'pendiente', 'agente', v_motivo,
            left(v_cb.message, 1000), left(v_cb.customer_phone, 32), v_cb.id)
    on conflict (canal, conversation_id) where estado in ('pendiente', 'tomada') do nothing
    returning id into v_id;
  if v_id is null then
    select h.id into v_id from restaurantes.conversation_handoff h
      where h.canal = 'voz' and h.conversation_id = p_conversation_id and h.estado in ('pendiente', 'tomada') and h.organization_id = p_organization_id;
    if v_id is not null and v_cb.id is not null then
      update restaurantes.conversation_handoff set
        resumen = coalesce(resumen, left(v_cb.message, 1000)),
        telefono_devolucion = coalesce(telefono_devolucion, left(v_cb.customer_phone, 32)),
        callback_id = coalesce(callback_id, v_cb.id),
        updated_at = now()
      where id = v_id;
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function restaurantes.handoff_solicitar_voz(uuid, uuid, text) from public, anon;
-- Mismo criterio que 101: la sesion de sistema del servicio corre con rol `authenticated` SIN usuario; el guard `auth.uid() is not null` la limita.
grant execute on function restaurantes.handoff_solicitar_voz(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Lectura del resumen, telefono y asignacion de un handoff
-- ---------------------------------------------------------------------------
create or replace function restaurantes.handoff_extra(p_organization_id uuid, p_property_id uuid, p_handoff_id uuid)
returns table (resumen text, telefono_devolucion text, callback_id uuid, asignada_por uuid, asignada_por_nombre text, asignada_at timestamptz, tomada_por_app boolean)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'handoff_extra: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return query
  select h.resumen, h.telefono_devolucion, h.callback_id, h.asignada_por,
         (select su.full_name from core.staff_user su where su.id = h.asignada_por), h.asignada_at, h.tomada_por_app
    from restaurantes.conversation_handoff h
   where h.id = p_handoff_id and h.organization_id = p_organization_id and h.property_id = p_property_id;
end;
$$;
revoke all on function restaurantes.handoff_extra(uuid, uuid, uuid) from public, anon;
grant execute on function restaurantes.handoff_extra(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Alertas del panel
-- ---------------------------------------------------------------------------
-- tipo: 'sin_tomar' (escalada pendiente que nadie toma), 'sin_respuesta_humana' (la tiene una persona/la app pero el cliente escribio despues y nadie contesto),
--       'llamada_por_devolver' (llamada escalada abierta: resumen + telefono) y 'pedido_por_aprobar' (pedido `por_aprobar` con total mayor a p_monto_min).
-- `minutos` = antiguedad (desde la solicitud, el ultimo mensaje del cliente o la solicitud de aprobacion). Chats: solo los que ya pasaron p_sin_respuesta_min.
create or replace function restaurantes.panel_alertas(
  p_organization_id uuid,
  p_property_id uuid,
  p_sin_respuesta_min integer default 10,
  p_monto_min numeric default 4000
) returns table (
  tipo text, canal text, conversation_id uuid, handoff_id uuid, order_id uuid,
  referencia text, minutos integer, monto numeric, resumen text, telefono text
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_min integer := least(greatest(coalesce(p_sin_respuesta_min, 10), 1), 1440);
  v_monto numeric := greatest(coalesce(p_monto_min, 4000), 0);
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'panel_alertas: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return query
  select 'sin_tomar'::text, h.canal, h.conversation_id, h.id, null::uuid,
         coalesce(c.phone, 'llamada'), greatest(0, floor(extract(epoch from (now() - h.solicitada_at)) / 60))::integer, null::numeric, h.motivo, null::text
    from restaurantes.conversation_handoff h
    left join restaurantes.whatsapp_conversations c on h.canal = 'whatsapp' and c.id = h.conversation_id and c.organization_id = h.organization_id
   where h.organization_id = p_organization_id and h.property_id = p_property_id and h.canal = 'whatsapp'
     and h.estado = 'pendiente' and h.solicitada_at <= now() - make_interval(mins => v_min)
  union all
  select 'sin_respuesta_humana'::text, h.canal, h.conversation_id, h.id, null::uuid,
         c.phone, greatest(0, floor(extract(epoch from (now() - h.ultimo_cliente_at)) / 60))::integer, null::numeric, h.motivo, null::text
    from restaurantes.conversation_handoff h
    join restaurantes.whatsapp_conversations c on c.id = h.conversation_id and c.organization_id = h.organization_id
   where h.organization_id = p_organization_id and h.property_id = p_property_id and h.canal = 'whatsapp'
     and h.estado = 'tomada' and h.ultimo_cliente_at is not null
     and h.ultimo_cliente_at <= now() - make_interval(mins => v_min)
     -- «Respuesta humana» = la toma misma, el ultimo mensaje humano de la app o la ultima respuesta del panel (outbox); los mensajes del cliente ANTERIORES a eso ya los vio la persona.
     and h.ultimo_cliente_at > greatest(
           coalesce(h.tomada_at, h.solicitada_at), coalesce(h.ultima_humana_at, h.tomada_at, h.solicitada_at),
           coalesce((select max(m.created_at) from restaurantes.messaging_outbox m
                      where m.organization_id = h.organization_id and m.event_type = 'whatsapp.handoff_reply'
                        and m.dedupe_key like 'handoff-reply:' || h.id::text || ':%'), coalesce(h.tomada_at, h.solicitada_at)))
  union all
  select 'llamada_por_devolver'::text, h.canal, h.conversation_id, h.id, null::uuid,
         coalesce(h.telefono_devolucion, 'sin telefono'), greatest(0, floor(extract(epoch from (now() - h.solicitada_at)) / 60))::integer, null::numeric, h.resumen, h.telefono_devolucion
    from restaurantes.conversation_handoff h
   where h.organization_id = p_organization_id and h.property_id = p_property_id and h.canal = 'voz' and h.estado in ('pendiente', 'tomada')
  union all
  select 'pedido_por_aprobar'::text, null::text, null::uuid, null::uuid, o.id,
         '#' || o.order_number::text, greatest(0, floor(extract(epoch from (now() - s.solicitada_at)) / 60))::integer, o.total, null::text, null::text
    from restaurantes.solicitud_aprobacion s
    join restaurantes.orders o on o.id = s.order_id and o.organization_id = s.organization_id
   where s.organization_id = p_organization_id and s.property_id = p_property_id and s.tipo = 'pedido_grande' and s.estado = 'pendiente'
     and o.status = 'por_aprobar' and o.total > v_monto
  order by 7 desc
  limit 100;
end;
$$;
revoke all on function restaurantes.panel_alertas(uuid, uuid, integer, numeric) from public, anon;
grant execute on function restaurantes.panel_alertas(uuid, uuid, integer, numeric) to authenticated, service_role;
