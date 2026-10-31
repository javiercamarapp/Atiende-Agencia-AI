-- 101 (PM PR-2, coexistencia): el ECO de la app silencia al asistente.
-- Cuando el personal contesta desde la app de WhatsApp Business (webhook `smb_message_echoes`) el asistente debe callar en esa conversacion
-- y volver solo tras inactividad humana (misma devolucion automatica de la 076). Esto agrega:
--  * conversation_handoff.tomada_por_app (la toma la abrio el eco, sin persona del panel) y ultima_humana_at (ultimo mensaje humano desde la app).
--  * restaurantes.handoff_eco_app: solo sistema. Abre la toma `tomada` por la app (o convierte una `pendiente`, o refresca `ultima_humana_at` si ya es `tomada`).
--    Sin conversacion o sin sucursal determinable devuelve null (nunca inventa una).
--  * restaurantes.handoff_whatsapp_toma_por_app: solo sistema; true si la toma abierta de ese telefono viene de la app (el agente lo consulta antes de enviar).
--  * handoff_tomar: una toma de la app la puede tomar una persona del panel (antes: 55006 «ya la tiene otra persona»).
--  * handoff_liberar (devolver/cerrar): cualquier staff de la sucursal puede liberar una toma de la app (antes solo quien la tomo o un admin).
--  * handoffs_devolver_vencidos: cuenta ultima_humana_at como actividad humana y NO manda la frase fija si la toma era de la app.
--  * GRANT: el webhook corre con withAppSession({userId:null}) = rol `authenticated` SIN usuario (auth.uid() nulo), igual que 013/045/048: las funciones de sistema se conceden a
--    `authenticated, service_role` y el guard `auth.uid() is not null` las limita a la sesion de sistema (un staff con JWT recibe 42501).
--  * whatsapp_eco_append: guarda el eco en el hilo SIN tocar updated_at (ancla de la ventana de 24 h de handoff_responder_whatsapp), SIN reescribir property_id, sin crear la
--    conversacion (sin conversacion devuelve 'sin_conversacion') e idempotente por wamid. El telefono se compara por sus ultimos 10 digitos (521... vs 52...).
--  * wamid_saliente_conocido: true si el wamid ya esta en el outbox ENVIADO de la organizacion (066): es un eco de lo que mando la propia plataforma (asistente, acuse,
--    plantilla o respuesta del panel), no del personal. Interruptor por organizacion: whatsapp_channel_config.descartar_ecos_propios (default true = descartar).
--  * autopiloto_config.handoff_regreso_app_minutos (default 5 si es null): ventana de silencio de una toma de la app, menor que la de una toma del panel.
--  * handoffs_devolver_vencidos: agrega la columna cliente_sin_responder (el ultimo mensaje del hilo es del cliente y la toma era de la app) para avisar a la campana.
-- Compatibilidad: base sin esta migracion (42703/42883) -> el TypeScript degrada a «sin eco»: el mensaje del personal sigue guardandose en el hilo (PR-1), el asistente no calla.
-- REVERSA: drop function if exists restaurantes.handoff_eco_app(uuid, uuid, text, timestamptz); drop function if exists restaurantes.handoff_whatsapp_toma_por_app(uuid, text);
--          alter table restaurantes.conversation_handoff drop column if exists tomada_por_app, drop column if exists ultima_humana_at; (y restaurar handoff_tomar y handoff_liberar de la 028 y handoffs_devolver_vencidos de la 076)
alter table restaurantes.conversation_handoff add column if not exists tomada_por_app boolean not null default false;
alter table restaurantes.conversation_handoff add column if not exists ultima_humana_at timestamptz;
alter table restaurantes.whatsapp_channel_config add column if not exists descartar_ecos_propios boolean not null default true;
alter table restaurantes.autopiloto_config add column if not exists handoff_regreso_app_minutos smallint check (handoff_regreso_app_minutos is null or handoff_regreso_app_minutos between 1 and 240);

create or replace function restaurantes.handoff_eco_app(p_organization_id uuid, p_property_id uuid, p_phone text, p_ahora timestamptz default now())
returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_conv_id uuid;
  v_conv_prop uuid;
  v_prop uuid;
  v_h restaurantes.conversation_handoff;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'handoff_eco_app es solo de sistema' using errcode = '42501';
  end if;
  select c.id, c.property_id into v_conv_id, v_conv_prop from restaurantes.whatsapp_conversations c
    where c.organization_id = p_organization_id
      and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
    order by c.updated_at desc limit 1;
  v_prop := coalesce(p_property_id, v_conv_prop);
  if v_conv_id is null or v_prop is null then
    return null;
  end if;
  -- La sucursal tiene que ser de la organizacion (el numero firmado la resolvio, pero no se confia): sin esto un property_id ajeno abriria la toma.
  if not exists (select 1 from core.property pr where pr.id = v_prop and pr.organization_id = p_organization_id) then
    return null;
  end if;
  if not restaurantes.handoff_conversacion_valida(p_organization_id, v_prop, 'whatsapp', v_conv_id) then
    return null;
  end if;
  for i in 1..2 loop
    select * into v_h from restaurantes.conversation_handoff h
      where h.canal = 'whatsapp' and h.conversation_id = v_conv_id and h.organization_id = p_organization_id and h.estado in ('pendiente', 'tomada')
      for update;
    if found then
      if v_h.estado = 'pendiente' then
        update restaurantes.conversation_handoff
          set estado = 'tomada', tomada_por_app = true, tomada_at = p_ahora, ultima_humana_at = p_ahora, updated_at = now()
          where id = v_h.id;
      else
        update restaurantes.conversation_handoff set ultima_humana_at = greatest(coalesce(ultima_humana_at, p_ahora), p_ahora), updated_at = now() where id = v_h.id;
      end if;
      return v_h.id;
    end if;
    begin
      insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo, tomada_at, tomada_por_app, ultima_humana_at)
        values (p_organization_id, v_prop, 'whatsapp', v_conv_id, 'tomada', 'staff', 'personal_app', p_ahora, true, p_ahora)
        returning id into v_id;
      return v_id;
    exception when unique_violation then
      null; -- otra sesion abrio la toma entre el select y el insert: reintenta.
    end;
  end loop;
  return null;
end;
$$;
revoke all on function restaurantes.handoff_eco_app(uuid, uuid, text, timestamptz) from public, anon;
grant execute on function restaurantes.handoff_eco_app(uuid, uuid, text, timestamptz) to authenticated, service_role;

create or replace function restaurantes.whatsapp_eco_append(p_organization_id uuid, p_phone text, p_message jsonb)
returns text
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
  v_wamid text := p_message ->> 'wamid';
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_eco_append es solo de sistema' using errcode = '42501';
  end if;
  if p_phone is null or btrim(p_phone) = '' or jsonb_typeof(p_message) <> 'object' or v_wamid is null or v_wamid = '' then
    raise exception 'whatsapp_eco_append: eco invalido' using errcode = '22023';
  end if;
  select c.id into v_id from restaurantes.whatsapp_conversations c
    where c.organization_id = p_organization_id
      and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
    order by c.updated_at desc limit 1
    for update;
  if v_id is null then
    return 'sin_conversacion'; -- un eco NUNCA crea la conversacion (contaria en los KPIs y fijaria el ancla de la ventana de 24 h)
  end if;
  if exists (select 1 from restaurantes.whatsapp_conversations c, jsonb_array_elements(c.messages) m where c.id = v_id and m ->> 'wamid' = v_wamid) then
    return 'duplicado';
  end if;
  -- Sin tocar updated_at (ancla de la ventana de 24 h) ni property_id.
  update restaurantes.whatsapp_conversations set messages = messages || jsonb_build_array(p_message) where id = v_id;
  return 'guardado';
end;
$$;
revoke all on function restaurantes.whatsapp_eco_append(uuid, text, jsonb) from public, anon;
grant execute on function restaurantes.whatsapp_eco_append(uuid, text, jsonb) to authenticated, service_role;

create or replace function restaurantes.wamid_saliente_conocido(p_organization_id uuid, p_wamid text)
returns boolean
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'wamid_saliente_conocido es solo de sistema' using errcode = '42501';
  end if;
  if coalesce((select cfg.descartar_ecos_propios from restaurantes.whatsapp_channel_config cfg where cfg.organization_id = p_organization_id), true) is not true then
    return false;
  end if;
  return exists (
    select 1 from restaurantes.messaging_outbox m
     where m.organization_id = p_organization_id and m.provider_message_id = left(p_wamid, 255)
  );
end;
$$;
revoke all on function restaurantes.wamid_saliente_conocido(uuid, text) from public, anon;
grant execute on function restaurantes.wamid_saliente_conocido(uuid, text) to authenticated, service_role;

create or replace function restaurantes.handoff_whatsapp_toma_por_app(p_organization_id uuid, p_phone text)
returns boolean
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'handoff_whatsapp_toma_por_app es solo de sistema' using errcode = '42501';
  end if;
  return exists (
    select 1 from restaurantes.conversation_handoff h
      join restaurantes.whatsapp_conversations c on c.id = h.conversation_id and c.organization_id = h.organization_id
     where h.organization_id = p_organization_id and h.canal = 'whatsapp'
       and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10) and h.estado = 'tomada' and h.tomada_por_app
  );
end;
$$;
revoke all on function restaurantes.handoff_whatsapp_toma_por_app(uuid, text) from public, anon;
grant execute on function restaurantes.handoff_whatsapp_toma_por_app(uuid, text) to authenticated, service_role;

create or replace function restaurantes.handoff_tomar(
  p_organization_id uuid,
  p_property_id uuid,
  p_canal text,
  p_conversation_id uuid
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_h restaurantes.conversation_handoff;
  v_id uuid;
begin
  if v_uid is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'handoff_tomar: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if not restaurantes.handoff_conversacion_valida(p_organization_id, p_property_id, p_canal, p_conversation_id) then
    raise exception 'handoff_tomar: la conversacion no pertenece a la sucursal' using errcode = '42501';
  end if;
  for i in 1..2 loop
    select * into v_h from restaurantes.conversation_handoff h
      where h.canal = p_canal and h.conversation_id = p_conversation_id and h.estado in ('pendiente', 'tomada')
      for update;
    if found then
      if v_h.organization_id <> p_organization_id or v_h.property_id <> p_property_id then
        raise exception 'handoff_tomar: la toma abierta es de otra sucursal' using errcode = '42501';
      end if;
      if v_h.estado = 'tomada' then
        if v_h.tomada_por = v_uid then return v_h.id; end if;
        -- Toma abierta por el eco de la app (sin persona del panel): quien la pide desde el panel se la queda.
        if v_h.tomada_por is null and v_h.tomada_por_app then
          update restaurantes.conversation_handoff
            set tomada_por = v_uid, tomada_por_app = false, ultima_humana_at = now(), updated_at = now()
            where id = v_h.id;
          return v_h.id;
        end if;
        raise exception 'handoff_tomar: la conversacion ya la tiene otra persona' using errcode = '55006';
      end if;
      update restaurantes.conversation_handoff
        set estado = 'tomada', tomada_por = v_uid, tomada_por_app = false, tomada_at = now(), updated_at = now()
        where id = v_h.id;
      return v_h.id;
    end if;
    begin
      insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, tomada_por, tomada_at)
        values (p_organization_id, p_property_id, p_canal, p_conversation_id, 'tomada', 'staff', v_uid, now())
        returning id into v_id;
      return v_id;
    exception when unique_violation then
      null; -- otra sesion abrio la toma entre el select y el insert: reintenta por el camino de arriba.
    end;
  end loop;
  raise exception 'handoff_tomar: no se pudo tomar la conversacion' using errcode = '55006';
end;
$$;
revoke all on function restaurantes.handoff_tomar(uuid, uuid, text, uuid) from public, anon;
grant execute on function restaurantes.handoff_tomar(uuid, uuid, text, uuid) to authenticated, service_role;

create or replace function restaurantes.handoff_liberar(
  p_organization_id uuid,
  p_property_id uuid,
  p_handoff_id uuid,
  p_nuevo_estado text
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_h restaurantes.conversation_handoff;
begin
  if v_uid is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'handoff: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_nuevo_estado not in ('devuelta', 'cerrada') then
    raise exception 'handoff: estado final invalido' using errcode = '22023';
  end if;
  select * into v_h from restaurantes.conversation_handoff h
    where h.id = p_handoff_id and h.organization_id = p_organization_id and h.property_id = p_property_id
    for update;
  if not found then
    raise exception 'handoff: inexistente o ajeno' using errcode = '42501';
  end if;
  if v_h.estado not in ('pendiente', 'tomada') then
    return false; -- ya estaba devuelta/cerrada (idempotente)
  end if;
  -- Solo quien la tomo, o un owner/admin, la libera. Una pendiente la puede cerrar cualquier staff de la sucursal.
  -- Una toma abierta por el eco de la app (sin persona del panel) la puede devolver o cerrar cualquier staff de la sucursal.
  if v_h.estado = 'tomada' and v_h.tomada_por is distinct from v_uid and not (v_h.tomada_por is null and v_h.tomada_por_app)
     and not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'handoff: la conversacion la tiene otra persona' using errcode = '42501';
  end if;
  update restaurantes.conversation_handoff set
    estado = p_nuevo_estado,
    devuelta_at = case when p_nuevo_estado = 'devuelta' then now() else devuelta_at end,
    cerrada_at = case when p_nuevo_estado = 'cerrada' then now() else cerrada_at end,
    updated_at = now()
  where id = v_h.id;
  return true;
end;
$$;
revoke all on function restaurantes.handoff_liberar(uuid, uuid, uuid, text) from public, anon;
grant execute on function restaurantes.handoff_liberar(uuid, uuid, uuid, text) to authenticated, service_role;

-- El tipo de retorno cambia (columna nueva): hay que soltar la funcion anterior.
drop function if exists restaurantes.handoffs_devolver_vencidos(timestamptz, integer);
create or replace function restaurantes.handoffs_devolver_vencidos(p_ahora timestamptz, p_limite integer default 50)
returns table (handoff_id uuid, organization_id uuid, property_id uuid, conversation_id uuid, minutos integer, avisado boolean, cliente_sin_responder boolean)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
  v_pnid text;
  v_texto constant text := 'Gracias por esperar; le sigo atendiendo yo.';
  v_avisado boolean;
begin
  if auth.uid() is not null then
    raise exception 'handoffs_devolver_vencidos: solo la sesion de sistema' using errcode = '42501';
  end if;
  for r in
    select h.id as hid, h.organization_id as org, h.property_id as prop, h.conversation_id as conv, h.ultimo_cliente_at,
           c.phone, case when h.tomada_por_app then coalesce(cfg.handoff_regreso_app_minutos, 5) else coalesce(cfg.handoff_regreso_minutos, 15) end as mins,
           (c.messages -> -1 ->> 'role') = 'user' as sin_resp,
           h.tomada_por_app,
           greatest(h.tomada_at, coalesce(h.ultima_humana_at, h.tomada_at), coalesce((
             select max(m.created_at) from restaurantes.messaging_outbox m
              where m.organization_id = h.organization_id and m.event_type = 'whatsapp.handoff_reply'
                and m.dedupe_key like 'handoff-reply:' || h.id::text || ':%'
           ), h.tomada_at)) as ultima_humana
      from restaurantes.conversation_handoff h
      join restaurantes.whatsapp_conversations c on c.id = h.conversation_id and c.organization_id = h.organization_id
      left join restaurantes.autopiloto_config cfg on cfg.property_id = h.property_id
     where h.canal = 'whatsapp' and h.estado = 'tomada' and h.tomada_at is not null
       and not exists (
         select 1 from restaurantes.whatsapp_sucursal_control w
          where w.property_id = h.property_id and w.agente_activo = false
       )
       and not exists (
         select 1 from restaurantes.solicitud_aprobacion s
           join restaurantes.orders o on o.id = s.order_id
          where s.organization_id = h.organization_id and s.estado = 'pendiente' and s.tipo = 'pedido_grande'
            and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10)
       )
     order by h.tomada_at
     limit least(greatest(coalesce(p_limite, 50), 1), 200)
     for update of h skip locked
  loop
    if r.ultima_humana > p_ahora - make_interval(mins => r.mins) then
      continue;
    end if;
    update restaurantes.conversation_handoff set estado = 'devuelta', devuelta_at = p_ahora, updated_at = p_ahora
     where id = r.hid and estado = 'tomada';
    insert into restaurantes.conversation_note (organization_id, property_id, handoff_id, autor_id, texto)
    values (r.org, r.prop, r.hid, null, 'Devuelta al agente automaticamente: sin respuesta humana en ' || r.mins::text || ' minutos.');
    v_avisado := false;
    -- La frase fija solo sale dentro de la ventana de 24 h del cliente (fuera de ella haria falta plantilla).
    -- Una toma abierta por el eco de la app (coexistencia) NO manda la frase: el personal ya venia hablando con el cliente desde su telefono.
    if not r.tomada_por_app and r.ultimo_cliente_at is not null and r.ultimo_cliente_at > p_ahora - interval '24 hours' then
      select b.phone_number_id into v_pnid from restaurantes.whatsapp_branch_channel b where b.property_id = r.prop;
      if v_pnid is null then
        select o.phone_number_id into v_pnid from restaurantes.whatsapp_channel_config o where o.organization_id = r.org;
      end if;
      if v_pnid is not null then
        update restaurantes.whatsapp_conversations
           set messages = messages || jsonb_build_array(jsonb_build_object('role', 'assistant', 'content', v_texto, 'autor', 'agente', 'at', to_char(p_ahora at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
               updated_at = p_ahora
         where id = r.conv and organization_id = r.org;
        perform restaurantes.enqueue_messaging_outbox(
          r.org, 'whatsapp', 'whatsapp.handoff_reply', 'handoff-regreso:' || r.hid::text,
          jsonb_build_object('to', r.phone, 'phone_number_id', v_pnid, 'body', v_texto)
        );
        v_avisado := true;
      end if;
    end if;
    return query select r.hid, r.org, r.prop, r.conv, r.mins, v_avisado, (r.tomada_por_app and coalesce(r.sin_resp, false));
  end loop;
end;
$$;
revoke all on function restaurantes.handoffs_devolver_vencidos(timestamptz, integer) from public, anon;
grant execute on function restaurantes.handoffs_devolver_vencidos(timestamptz, integer) to authenticated;
