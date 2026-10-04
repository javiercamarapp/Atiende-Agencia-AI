-- Handoff de WhatsApp: (1) la respuesta humana respeta la ventana de 24 h de Meta y (2) una toma pendiente que nadie atiende
-- le da al cliente un acuse honesto. Prefijo de supabase/migrations: 20240101000320 (interno restaurantes 044).
-- Requiere: 028 (restaurantes.conversation_handoff, handoff_responder_whatsapp, handoff_whatsapp_estado, whatsapp_conversations).
--
-- Defectos (QA R1, disponibilidad de la atencion al cliente):
--   * agentes-20: `handoff_responder_whatsapp` encolaba texto libre aunque el cliente hubiera escrito hace mas de 24 h. Meta rechaza
--     ese envio (131047), el outbox lo deja `dead` y el panel ya habia dicho "encolado": el cliente nunca recibia la respuesta.
--   * viaje-14: con una toma `pendiente` el agente calla (R-21) y el mensaje solo se guarda; si nadie la toma (noche, fin de semana,
--     personal ocupado) el cliente no recibia NINGUNA respuesta, ni un acuse, por horas.
--
-- Que cambia:
--   1) `restaurantes.handoff_responder_whatsapp` (misma firma): antes de encolar exige que el ultimo mensaje del CLIENTE tenga menos
--      de 24 h; si no, falla con SQLSTATE '55W24' (la API lo traduce a 409 con un mensaje claro). El ultimo mensaje del cliente es
--      `ultimo_cliente_at` (el ping que registra `handoff_whatsapp_estado` en cada mensaje mientras la toma esta abierta) y, si la
--      solicito el agente, `solicitada_at` (se pide en respuesta a un mensaje del cliente); sin ninguno de los dos, la ultima actividad
--      de la conversacion. La primera respuesta humana fija esa ancla en `ultimo_cliente_at` ANTES de tocar `updated_at`, para que la
--      propia respuesta del staff no reabra la ventana. Todo lo demas (autorizacion, validaciones, outbox) es identico a 028.
--   2) Columna `conversation_handoff.acuse_cliente_at` y funcion de SOLO SISTEMA `handoff_whatsapp_acuse_pendiente`: devuelve true UNA vez
--      cuando la toma sigue `pendiente` despues de `p_espera_min` minutos (y de nuevo cada `p_repetir_min`), y registra el instante del
--      acuse. El agente usa el `true` para mandar un aviso fijo y honesto; con `false` sigue callando como antes.
--
-- Seguridad (justificacion de cada pieza nueva):
--   * `handoff_responder_whatsapp`: `security definer` con `set search_path` fijo (igual que 028); `create or replace` conserva los
--     permisos (revoke a public y anon; execute a authenticated y service_role), que se repiten abajo para dejar explicito que no se
--     amplian. El rechazo es un RAISE antes de cualquier escritura. La excepcion no revela datos de otra organizacion: se evalua
--     despues de la autorizacion de 028 (actor en la sucursal, toma propia).
--   * `acuse_cliente_at`: columna nueva SIN GRANT adicional. `conversation_handoff` ya solo tiene `grant select` a authenticated con la
--     politica de lectura por sucursal (`handoff_actor_en_sucursal`); nadie puede insertar ni actualizar por DML directo.
--   * `handoff_whatsapp_acuse_pendiente`: solo-sistema -- exige `auth.uid() is null` (un staff autenticado recibe 42501), `security
--     definer`, `set search_path = restaurantes, core, pg_temp`, `revoke all from public, anon`, execute a authenticated y service_role
--     (la sesion de sistema del motor corre con ese rol, igual que `handoff_whatsapp_estado`). Filtra por organizacion Y telefono (no
--     toca la toma de otra organizacion), solo escribe `acuse_cliente_at` y `updated_at` de una toma `pendiente`, y los parametros se
--     acotan (1..1440 min). No lee ni devuelve texto de mensajes ni datos personales: devuelve un booleano.
--   * Cero politicas nuevas, ningun `using (true)`, ningun GRANT a anon.
-- Compatibilidad con la base sin migrar: el codigo TypeScript de esta rama NO depende de esta migracion. Sin ella, la respuesta humana
-- se comporta como antes (sin ventana) y `handoff_whatsapp_acuse_pendiente` no existe: el gate captura 42883 con SAVEPOINT y el agente
-- sigue callando (comportamiento anterior).

alter table restaurantes.conversation_handoff add column if not exists acuse_cliente_at timestamptz;

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
    set messages = messages || jsonb_build_array(jsonb_build_object('role', 'assistant', 'content', v_texto, 'autor', 'humano', 'staff_id', v_uid)),
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

-- Acuse al cliente cuando la toma sigue pendiente. Devuelve true UNA vez por intervalo (la primera cuando la toma lleva `p_espera_min`
-- minutos pendiente; luego cada `p_repetir_min`) y registra el instante; false = el agente sigue callando.
create or replace function restaurantes.handoff_whatsapp_acuse_pendiente(
  p_organization_id uuid,
  p_phone text,
  p_espera_min integer default 15,
  p_repetir_min integer default 60
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_espera integer := least(greatest(coalesce(p_espera_min, 15), 1), 1440);
  v_repetir integer := least(greatest(coalesce(p_repetir_min, 60), 1), 1440);
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'handoff_whatsapp_acuse_pendiente es solo de sistema' using errcode = '42501';
  end if;
  update restaurantes.conversation_handoff h
    set acuse_cliente_at = now(), updated_at = now()
    from restaurantes.whatsapp_conversations c
    where h.canal = 'whatsapp' and h.conversation_id = c.id and c.organization_id = p_organization_id and c.phone = p_phone
      and h.organization_id = p_organization_id and h.estado = 'pendiente'
      and h.solicitada_at <= now() - make_interval(mins => v_espera)
      and (h.acuse_cliente_at is null or h.acuse_cliente_at <= now() - make_interval(mins => v_repetir))
    returning h.id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function restaurantes.handoff_responder_whatsapp(uuid, uuid, uuid, text) from public, anon;
grant execute on function restaurantes.handoff_responder_whatsapp(uuid, uuid, uuid, text) to authenticated, service_role;
revoke all on function restaurantes.handoff_whatsapp_acuse_pendiente(uuid, text, integer, integer) from public, anon;
grant execute on function restaurantes.handoff_whatsapp_acuse_pendiente(uuid, text, integer, integer) to authenticated, service_role;
