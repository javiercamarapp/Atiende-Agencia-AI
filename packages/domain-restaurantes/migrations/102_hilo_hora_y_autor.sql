-- 102 (PM PR-4): hora real y autor visibles en el hilo de WhatsApp de Conversaciones.
--  * handoff_responder_whatsapp: igual que la 045, pero el mensaje de la persona del panel guarda ademas `at` (ISO 8601 UTC). Ya guardaba `autor: 'humano'` y `staff_id`.
--  * handoff_staff_nombres: nombre (core.staff_user.full_name) de las personas que contestaron en el hilo, para mostrarlo. Solo staff con acceso a la sucursal pide nombres, y solo de
--    personas con membresia en la MISMA organizacion (limita por ORGANIZACION, no por sucursal: un staff de otra sucursal de la misma organizacion si aparece, y es el mismo alcance
--    que ya tiene el nombre de quien tomo la conversacion); no devuelve ningun otro dato.
-- Compatibilidad: base sin esta migracion -> el TypeScript muestra la hora de los mensajes nuevos del asistente/cliente (la guarda el codigo) y el autor «Persona del equipo» sin nombre.
-- REVERSA: drop function if exists restaurantes.handoff_staff_nombres(uuid, uuid, uuid[]); y restaurar handoff_responder_whatsapp de la 045.
create or replace function restaurantes.handoff_responder_whatsapp(
  p_organization_id uuid,
  p_property_id uuid,
  p_handoff_id uuid,
  p_texto text
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_h restaurantes.conversation_handoff;
  v_phone text;
  v_pnid text;
  v_texto text := btrim(p_texto);
  v_outbox uuid;
  v_conv_actividad timestamptz;
  v_ancla timestamptz;
begin
  if v_uid is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'handoff_responder_whatsapp: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if v_texto is null or char_length(v_texto) not between 1 and 1000 then
    raise exception 'handoff_responder_whatsapp: mensaje vacio o demasiado largo' using errcode = '22023';
  end if;
  select * into v_h from restaurantes.conversation_handoff h
    where h.id = p_handoff_id and h.organization_id = p_organization_id and h.property_id = p_property_id and h.canal = 'whatsapp'
    for update;
  if not found or v_h.estado <> 'tomada' or v_h.tomada_por is distinct from v_uid then
    raise exception 'handoff_responder_whatsapp: solo quien tiene tomada la conversacion puede responder' using errcode = '42501';
  end if;
  select c.phone, c.updated_at into v_phone, v_conv_actividad from restaurantes.whatsapp_conversations c
    where c.id = v_h.conversation_id and c.organization_id = p_organization_id;
  if v_phone is null then
    raise exception 'handoff_responder_whatsapp: conversacion inexistente' using errcode = '42501';
  end if;
  select b.phone_number_id into v_pnid from restaurantes.whatsapp_branch_channel b where b.property_id = p_property_id;
  if v_pnid is null then
    select o.phone_number_id into v_pnid from restaurantes.whatsapp_channel_config o where o.organization_id = p_organization_id;
  end if;
  if v_pnid is null then
    raise exception 'handoff_responder_whatsapp: la sucursal no tiene numero de WhatsApp configurado' using errcode = 'P0002';
  end if;
  -- Ventana de 24 h de WhatsApp: fuera de ella solo Meta admite una plantilla aprobada, no texto libre.
  v_ancla := coalesce(
    greatest(v_h.ultimo_cliente_at, case when v_h.solicitado_por = 'agente' then v_h.solicitada_at end),
    v_conv_actividad
  );
  if v_ancla < now() - interval '24 hours' then
    raise exception 'handoff_responder_whatsapp: pasaron mas de 24 horas desde el ultimo mensaje del cliente' using errcode = '55W24';
  end if;
  -- Fija el ancla antes de que la respuesta toque `updated_at` de la conversacion (si no, el propio staff reabriria la ventana).
  if v_h.ultimo_cliente_at is null then
    update restaurantes.conversation_handoff set ultimo_cliente_at = v_ancla, updated_at = now() where id = v_h.id;
  end if;
  update restaurantes.whatsapp_conversations
    set messages = messages || jsonb_build_array(jsonb_build_object('role', 'assistant', 'content', v_texto, 'autor', 'humano', 'staff_id', v_uid, 'at', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
        updated_at = now()
    where id = v_h.conversation_id and organization_id = p_organization_id;
  v_outbox := restaurantes.enqueue_messaging_outbox(
    p_organization_id, 'whatsapp', 'whatsapp.handoff_reply',
    'handoff-reply:' || p_handoff_id::text || ':' || gen_random_uuid()::text,
    jsonb_build_object('to', v_phone, 'phone_number_id', v_pnid, 'body', v_texto)
  );
  return v_outbox;
end;
$$;
revoke all on function restaurantes.handoff_responder_whatsapp(uuid, uuid, uuid, text) from public, anon;
grant execute on function restaurantes.handoff_responder_whatsapp(uuid, uuid, uuid, text) to authenticated, service_role;

create or replace function restaurantes.handoff_staff_nombres(p_organization_id uuid, p_property_id uuid, p_ids uuid[])
returns table (id uuid, nombre text)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'handoff_staff_nombres: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return query
  select su.id, su.full_name
    from core.staff_user su
   where su.id = any (coalesce(p_ids, '{}'::uuid[]))
     and exists (select 1 from core.membership m where m.user_id = su.id and m.organization_id = p_organization_id)
   limit 50;
end;
$$;
revoke all on function restaurantes.handoff_staff_nombres(uuid, uuid, uuid[]) from public, anon;
grant execute on function restaurantes.handoff_staff_nombres(uuid, uuid, uuid[]) to authenticated, service_role;
