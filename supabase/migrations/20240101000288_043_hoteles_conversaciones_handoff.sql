-- H-20 (P1) -- BANDEJA DE CONVERSACIONES DE WHATSAPP CON HANDOFF A HUMANO (hoteles).
--
-- Hoy hoteles recibe WhatsApp (webhook + agente con herramientas) pero nadie del hotel puede ver la conversacion ni
-- tomarla. Esta migracion agrega, SOBRE las tablas existentes (004 / 008):
--   * el estado de la conversacion (`modo`: agente | humano | cerrada), su responsable, cuando se tomo y el motivo de la
--     derivacion, mas un contador de mensajes no leidos;
--   * notas internas por conversacion (`hoteles.conversacion_nota`, append-only);
--   * funciones `security definer` para listar, abrir, tomar, devolver, cerrar, anotar, marcar leida y RESPONDER (la
--     respuesta humana se encola en `hoteles.messaging_outbox`; el envio real lo hace el despachador existente);
--   * dos funciones de SOLO SISTEMA que usa el webhook: registrar el mensaje entrante (y reabrir una conversacion cerrada)
--     y derivar a humano cuando el agente lo pide o el gobierno lo bloquea.
--
-- Forma identica a restaurantes (028: bandeja / tomar / devolver / cerrar / notas / responder) pero LOCAL a hoteles (la
-- conversacion de hoteles es una por (property, telefono), no un handoff aparte): PL-14 podra absorberla.
--
-- ---------------------------------------------------------------------------------------------------------------------
-- JUSTIFICACION DE SEGURIDAD (cada GRANT / policy / funcion nueva)
-- ---------------------------------------------------------------------------------------------------------------------
--  * Columnas nuevas de `whatsapp_conversations`: heredan los GRANT de tabla que ya existian (SELECT a `authenticated`
--    bajo la policy de staff de la property; escritura SOLO service_role). NO se otorga ningun UPDATE/INSERT a
--    `authenticated`: el estado de la conversacion solo cambia por las funciones de abajo, que validan rol, property y
--    transicion. Sin GRANT de columna porque no hay escritura directa que acotar.
--  * `hoteles.conversacion_nota`: RLS con SELECT para quien gestiona reservas (owner, gm, frontdesk, reservations). Sin
--    GRANT de INSERT/UPDATE/DELETE a `authenticated` (la nota entra solo por `conversacion_agregar_nota`, que fija
--    organizacion y autor desde la base: el cliente no puede falsificarlos) y sin UPDATE/DELETE ni para service_role
--    (append-only). Nada para `anon`.
--  * Funciones de staff (`conversaciones_listar`, `conversacion_detalle`, `conversacion_notas`, `conversacion_leer`, `conversacion_tomar`,
--    `conversacion_devolver`, `conversacion_cerrar`, `conversacion_agregar_nota`, `conversacion_responder`):
--    `security definer` con `search_path` fijo; exigen `auth.uid()` (42501 sin sesion de usuario, sistema incluido) y rol
--    owner/gm/frontdesk/reservations en ESA property via `hoteles.agent_vertical_role`. Una conversacion de otra
--    property u organizacion responde P0002 (no se revela que existe). `revoke ... from public, anon`; EXECUTE solo a
--    `authenticated`.
--  * Reasignar una conversacion tomada por otra persona, y cerrar/devolver la de otro, solo owner/gm.
--  * `conversacion_responder` exige que quien responde sea el RESPONSABLE actual, que la conversacion este en `humano`, que
--    el ultimo mensaje del huesped tenga menos de 24 h (ventana de servicio de Meta), que la property tenga canal de
--    WhatsApp habilitado y que el texto no lleve numeros de tarjeta/documento. Fija `to` desde la conversacion (no del
--    cliente) y `phone_number_id` desde `whatsapp_channel_config`: el cliente solo elige el texto.
--  * Funciones de sistema (`conversacion_registrar_entrante`, `conversacion_derivar_a_humano`): solo con `auth.uid() is
--    null` (42501 para cualquier usuario real), mismo criterio que `whatsapp_append_turn` (017). EXECUTE a
--    `authenticated`/`service_role` porque la sesion de sistema del motor conecta como `authenticated` (ver 017).
--
-- Orden de despliegue: aplicar esta migracion ANTES de mergear el codigo. Con el codigo nuevo contra una base SIN esta
-- migracion el webhook sigue respondiendo como siempre (el puerto de sistema degrada a "agente") y la bandeja responde
-- `disponible: false` / 503 honesto: nunca un 500.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1) Estado de la conversacion
-- ---------------------------------------------------------------------------------------------------------------------
alter table hoteles.whatsapp_conversations
  add column modo text not null default 'agente' check (modo in ('agente', 'humano', 'cerrada')),
  add column responsable_id uuid references core.staff_user(id) on delete set null,
  add column tomada_en timestamptz,
  add column handoff_motivo text check (handoff_motivo is null or handoff_motivo ~ '^[a-z0-9_]{1,80}$'),
  add column handoff_en timestamptz,
  add column handoff_n integer not null default 0 check (handoff_n >= 0),
  add column ultimo_entrante_en timestamptz,
  add column no_leidos integer not null default 0 check (no_leidos >= 0),
  add column cerrada_en timestamptz,
  add constraint whatsapp_conversations_responsable_solo_humano check (modo = 'humano' or responsable_id is null);

create index whatsapp_conversations_bandeja_idx on hoteles.whatsapp_conversations (property_id, modo, updated_at desc);

-- ---------------------------------------------------------------------------------------------------------------------
-- 2) Notas internas (append-only)
-- ---------------------------------------------------------------------------------------------------------------------
create table hoteles.conversacion_nota (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  conversation_id uuid not null references hoteles.whatsapp_conversations(id) on delete cascade,
  author_id uuid references core.staff_user(id) on delete set null,
  body text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index conversacion_nota_conv_idx on hoteles.conversacion_nota (conversation_id, created_at);

alter table hoteles.conversacion_nota enable row level security;
create policy "conversaciones: staff de reservas ve las notas" on hoteles.conversacion_nota for select
  using (hoteles.can_manage_reservations(property_id));
revoke all on hoteles.conversacion_nota from public, anon;
grant select on hoteles.conversacion_nota to authenticated;
grant select, insert on hoteles.conversacion_nota to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3) Funciones de SISTEMA (webhook de WhatsApp)
-- ---------------------------------------------------------------------------------------------------------------------
-- Registra un mensaje entrante ya agregado al historial: marca la hora, suma un no leido y REABRE una conversacion
-- cerrada (vuelve al agente). Devuelve el modo resultante (null si no existe la fila).
create or replace function hoteles.conversacion_registrar_entrante(p_property_id uuid, p_phone text)
returns text
language plpgsql security definer set search_path = hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_modo text;
begin
  if auth.uid() is not null then
    raise exception 'conversacion_registrar_entrante es solo para la sesion de sistema' using errcode = '42501';
  end if;
  update hoteles.whatsapp_conversations c
     set ultimo_entrante_en = now(),
         no_leidos = least(c.no_leidos + 1, 9999),
         modo = case when c.modo = 'cerrada' then 'agente' else c.modo end,
         cerrada_en = case when c.modo = 'cerrada' then null else c.cerrada_en end
   where c.property_id = p_property_id and c.phone = p_phone
   returning c.modo into v_modo;
  return v_modo;
end;
$$;

-- Deriva la conversacion a una persona: solo si hoy la atiende el agente (idempotente: si ya esta en humano no cuenta
-- una derivacion nueva). `transicion` = true solo en la derivacion que cambia el estado (la que debe notificar).
create or replace function hoteles.conversacion_derivar_a_humano(p_property_id uuid, p_phone text, p_motivo text)
returns table (conversation_id uuid, organization_id uuid, handoff_n integer, transicion boolean)
language plpgsql security definer set search_path = hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_row record;
begin
  if auth.uid() is not null then
    raise exception 'conversacion_derivar_a_humano es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_motivo is null or p_motivo !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'motivo: codigo de 1 a 80 caracteres (a-z, 0-9, _)' using errcode = '22023';
  end if;
  update hoteles.whatsapp_conversations c
     set modo = 'humano', responsable_id = null, tomada_en = null,
         handoff_motivo = p_motivo, handoff_en = now(), handoff_n = c.handoff_n + 1
   where c.property_id = p_property_id and c.phone = p_phone and c.modo = 'agente'
   returning c.id, c.organization_id, c.handoff_n into v_row;
  if v_row.id is not null then
    return query select v_row.id, v_row.organization_id, v_row.handoff_n, true;
    return;
  end if;
  return query
    select c.id, c.organization_id, c.handoff_n, false
      from hoteles.whatsapp_conversations c
     where c.property_id = p_property_id and c.phone = p_phone;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4) Funciones de STAFF
-- ---------------------------------------------------------------------------------------------------------------------
-- Autoriza una conversacion: devuelve el rol del llamador en su property o lanza P0002 (no existe / otra property u
-- organizacion / sin rol de reservas) o 42501 (sin sesion de usuario). Un solo punto de verdad para todas las funciones.
create or replace function hoteles.conversacion_autorizar(p_conversation_id uuid, out o_property_id uuid, out o_role text)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'conversaciones: requiere un usuario autenticado' using errcode = '42501';
  end if;
  select c.property_id into o_property_id from hoteles.whatsapp_conversations c where c.id = p_conversation_id;
  if o_property_id is not null then
    o_role := hoteles.agent_vertical_role(o_property_id);
  end if;
  if o_property_id is null or o_role is null or o_role not in ('owner', 'gm', 'frontdesk', 'reservations') then
    raise exception 'conversacion no encontrada' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function hoteles.conversaciones_listar(
  p_property_id uuid,
  p_modo text default null,
  p_solo_no_leidas boolean default false,
  p_telefono_clave text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid, phone text, modo text, responsable_id uuid, responsable_nombre text, tomada_en timestamptz,
  handoff_motivo text, handoff_en timestamptz, no_leidos integer, ultimo_entrante_en timestamptz,
  actividad_en timestamptz, vista_previa text, ultimo_rol text, huesped_id uuid, huesped_nombre text, total bigint
)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'conversaciones_listar: requiere un usuario autenticado' using errcode = '42501';
  end if;
  v_role := hoteles.agent_vertical_role(p_property_id);
  if v_role is null or v_role not in ('owner', 'gm', 'frontdesk', 'reservations') then
    raise exception 'property no encontrada' using errcode = 'P0002';
  end if;
  if p_modo is not null and p_modo not in ('agente', 'humano', 'cerrada', 'por_atender') then
    raise exception 'modo invalido' using errcode = '22023';
  end if;
  if p_telefono_clave is not null and p_telefono_clave !~ '^[0-9]{7,10}$' then
    raise exception 'telefono_clave invalida' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 then
    raise exception 'paginacion invalida' using errcode = '22023';
  end if;

  return query
    with pagina as (
      select c.*, count(*) over () as total_filas
        from hoteles.whatsapp_conversations c
       where c.property_id = p_property_id
         and (p_modo is null
              or (p_modo = 'por_atender' and c.modo = 'humano' and c.responsable_id is null)
              or (p_modo in ('agente', 'humano', 'cerrada') and c.modo = p_modo))
         and (not coalesce(p_solo_no_leidas, false) or c.no_leidos > 0)
         and (p_telefono_clave is null or right(regexp_replace(c.phone, '[^0-9]', '', 'g'), length(p_telefono_clave)) = p_telefono_clave)
       order by (c.modo = 'humano' and c.responsable_id is null) desc, (c.no_leidos > 0) desc, c.updated_at desc
       limit p_limit offset p_offset
    )
    select p.id, p.phone, p.modo, p.responsable_id, su.full_name, p.tomada_en,
           p.handoff_motivo, p.handoff_en, p.no_leidos, p.ultimo_entrante_en,
           p.updated_at, left(p.messages -> -1 ->> 'content', 160), p.messages -> -1 ->> 'role',
           g.id, g.full_name, p.total_filas
      from pagina p
      left join core.staff_user su on su.id = p.responsable_id
      left join lateral (
        select gu.id, gu.full_name from hoteles.guest gu
         where gu.property_id = p.property_id and gu.phone is not null
           and right(regexp_replace(gu.phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 10)
         order by gu.created_at desc limit 1
      ) g on true
     order by (p.modo = 'humano' and p.responsable_id is null) desc, (p.no_leidos > 0) desc, p.updated_at desc;
end;
$$;

-- Detalle: ultimos 200 mensajes (con el estado de envio de las respuestas humanas) y datos del handoff.
create or replace function hoteles.conversacion_detalle(p_conversation_id uuid)
returns table (
  id uuid, property_id uuid, phone text, modo text, responsable_id uuid, responsable_nombre text, tomada_en timestamptz,
  handoff_motivo text, handoff_en timestamptz, handoff_n integer, no_leidos integer, ultimo_entrante_en timestamptz,
  cerrada_en timestamptz, actividad_en timestamptz, total_mensajes integer, mensajes jsonb, huesped_id uuid, huesped_nombre text
)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_auth record;
begin
  select * into v_auth from hoteles.conversacion_autorizar(p_conversation_id);
  return query
    select c.id, c.property_id, c.phone, c.modo, c.responsable_id, su.full_name, c.tomada_en,
           c.handoff_motivo, c.handoff_en, c.handoff_n, c.no_leidos, c.ultimo_entrante_en,
           c.cerrada_en, c.updated_at, jsonb_array_length(c.messages),
           (select coalesce(jsonb_agg(
                     case when m.msg ? 'outbox_id'
                          then m.msg || jsonb_build_object('envio', (select o.status from hoteles.messaging_outbox o where o.id::text = m.msg ->> 'outbox_id' and o.property_id = c.property_id))
                          else m.msg end
                     order by m.ord), '[]'::jsonb)
              from (select t.msg, t.ord from jsonb_array_elements(c.messages) with ordinality as t(msg, ord) order by t.ord desc limit 200) m),
           g.id, g.full_name
      from hoteles.whatsapp_conversations c
      left join core.staff_user su on su.id = c.responsable_id
      left join lateral (
        select gu.id, gu.full_name from hoteles.guest gu
         where gu.property_id = c.property_id and gu.phone is not null
           and right(regexp_replace(gu.phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)
         order by gu.created_at desc limit 1
      ) g on true
     where c.id = p_conversation_id;
end;
$$;

create or replace function hoteles.conversacion_leer(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_auth record;
begin
  select * into v_auth from hoteles.conversacion_autorizar(p_conversation_id);
  update hoteles.whatsapp_conversations set no_leidos = 0 where id = p_conversation_id and no_leidos <> 0;
end;
$$;

-- Tomar: UN solo UPDATE condicionado (atomico bajo el bloqueo de fila): si dos personas llegan a la vez, la segunda
-- espera, reevalua la condicion y no actualiza nada -> 55000 `ya_tomada`. Reasignar (p_reasignar) solo owner/gm.
create or replace function hoteles.conversacion_tomar(p_conversation_id uuid, p_reasignar boolean default false)
returns table (modo text, responsable_id uuid, tomada_en timestamptz)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_auth record;
  v_row record;
  v_actual record;
begin
  select * into v_auth from hoteles.conversacion_autorizar(p_conversation_id);
  if coalesce(p_reasignar, false) and v_auth.o_role not in ('owner', 'gm') then
    raise exception 'solo owner o gm pueden reasignar una conversacion' using errcode = '42501';
  end if;
  update hoteles.whatsapp_conversations c
     set modo = 'humano',
         handoff_motivo = case when c.modo = 'agente' then 'tomada_por_personal' else c.handoff_motivo end,
         handoff_en = coalesce(c.handoff_en, now()),
         tomada_en = case when c.responsable_id = auth.uid() then c.tomada_en else now() end,
         responsable_id = auth.uid()
   where c.id = p_conversation_id
     and (c.modo = 'agente'
          or (c.modo = 'humano' and (c.responsable_id is null or c.responsable_id = auth.uid() or coalesce(p_reasignar, false))))
   returning c.modo, c.responsable_id, c.tomada_en into v_row;
  if v_row.modo is not null then
    return query select v_row.modo, v_row.responsable_id, v_row.tomada_en;
    return;
  end if;
  select c.modo, c.responsable_id into v_actual from hoteles.whatsapp_conversations c where c.id = p_conversation_id;
  if v_actual.modo = 'cerrada' then
    raise exception 'cerrada: la conversacion esta cerrada; se reabre cuando el huesped vuelva a escribir' using errcode = '55000';
  end if;
  raise exception 'ya_tomada: otra persona ya tomo esta conversacion' using errcode = '55000';
end;
$$;

create or replace function hoteles.conversacion_devolver(p_conversation_id uuid)
returns text
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_auth record;
  v_actual record;
begin
  select * into v_auth from hoteles.conversacion_autorizar(p_conversation_id);
  select c.modo, c.responsable_id into v_actual from hoteles.whatsapp_conversations c where c.id = p_conversation_id for update;
  if v_actual.modo is distinct from 'humano' then
    raise exception 'no_en_humano: la conversacion no esta en atencion humana' using errcode = '55000';
  end if;
  if v_actual.responsable_id is not null and v_actual.responsable_id <> auth.uid() and v_auth.o_role not in ('owner', 'gm') then
    raise exception 'solo la persona responsable, owner o gm pueden devolver la conversacion' using errcode = '42501';
  end if;
  update hoteles.whatsapp_conversations c set modo = 'agente', responsable_id = null, tomada_en = null where c.id = p_conversation_id;
  return 'agente';
end;
$$;

create or replace function hoteles.conversacion_cerrar(p_conversation_id uuid)
returns text
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_auth record;
  v_actual record;
begin
  select * into v_auth from hoteles.conversacion_autorizar(p_conversation_id);
  select c.modo, c.responsable_id into v_actual from hoteles.whatsapp_conversations c where c.id = p_conversation_id for update;
  if v_actual.modo = 'cerrada' then
    raise exception 'ya_cerrada: la conversacion ya esta cerrada' using errcode = '55000';
  end if;
  if v_actual.modo = 'humano' and v_actual.responsable_id is not null and v_actual.responsable_id <> auth.uid() and v_auth.o_role not in ('owner', 'gm') then
    raise exception 'solo la persona responsable, owner o gm pueden cerrar la conversacion' using errcode = '42501';
  end if;
  update hoteles.whatsapp_conversations c
     set modo = 'cerrada', responsable_id = null, tomada_en = null, cerrada_en = now(), no_leidos = 0
   where c.id = p_conversation_id;
  return 'cerrada';
end;
$$;

create or replace function hoteles.conversacion_notas(p_conversation_id uuid)
returns table (id uuid, autor_id uuid, autor_nombre text, texto text, creada_en timestamptz)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_auth record;
begin
  select * into v_auth from hoteles.conversacion_autorizar(p_conversation_id);
  return query
    select n.id, n.author_id, su.full_name, n.body, n.created_at
      from hoteles.conversacion_nota n
      left join core.staff_user su on su.id = n.author_id
     where n.conversation_id = p_conversation_id
     order by n.created_at, n.id
     limit 200;
end;
$$;

create or replace function hoteles.conversacion_agregar_nota(p_conversation_id uuid, p_texto text)
returns uuid
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_auth record;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_id uuid;
  v_org uuid;
begin
  select * into v_auth from hoteles.conversacion_autorizar(p_conversation_id);
  if length(v_texto) not between 1 and 1000 then
    raise exception 'texto: de 1 a 1000 caracteres' using errcode = '22023';
  end if;
  if regexp_replace(v_texto, '[ -]', '', 'g') ~ '[0-9]{13,19}' then
    raise exception 'nota_con_dato_sensible: no captures numeros de tarjeta ni de documento' using errcode = '22023';
  end if;
  select p.organization_id into v_org from core.property p where p.id = v_auth.o_property_id;
  insert into hoteles.conversacion_nota (organization_id, property_id, conversation_id, author_id, body)
  values (v_org, v_auth.o_property_id, p_conversation_id, auth.uid(), v_texto)
  returning id into v_id;
  return v_id;
end;
$$;

-- Responder como humano: valida, agrega el mensaje al historial (para que el agente lo vea al recuperar la
-- conversacion) y lo ENCOLA en messaging_outbox. No envia nada: sin credenciales de Meta el despachador no lo drena y
-- queda `pending` (la bandeja lo muestra como "pendiente de envio").
create or replace function hoteles.conversacion_responder(p_conversation_id uuid, p_texto text)
returns table (outbox_id uuid, envio text)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
#variable_conflict use_column
declare
  v_auth record;
  v_conv record;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_phone_number_id text;
  v_outbox uuid;
  v_msg_id uuid := gen_random_uuid();
begin
  select * into v_auth from hoteles.conversacion_autorizar(p_conversation_id);
  select c.organization_id, c.property_id, c.phone, c.modo, c.responsable_id, coalesce(c.ultimo_entrante_en, c.updated_at) as ultima_actividad
    into v_conv from hoteles.whatsapp_conversations c where c.id = p_conversation_id for update;
  if v_conv.modo is distinct from 'humano' then
    raise exception 'no_en_humano: toma la conversacion antes de responder' using errcode = '55000';
  end if;
  if v_conv.responsable_id is distinct from auth.uid() then
    raise exception 'no_eres_responsable: solo la persona que tomo la conversacion puede responder' using errcode = '55000';
  end if;
  if length(v_texto) not between 1 and 1000 then
    raise exception 'texto: de 1 a 1000 caracteres' using errcode = '22023';
  end if;
  if regexp_replace(v_texto, '[ -]', '', 'g') ~ '[0-9]{13,19}' then
    raise exception 'texto_con_dato_sensible: no envies numeros de tarjeta ni de documento por WhatsApp' using errcode = '22023';
  end if;
  if v_conv.ultima_actividad < now() - interval '24 hours' then
    raise exception 'ventana_24h: pasaron mas de 24 horas desde el ultimo mensaje del huesped; WhatsApp solo permite plantillas' using errcode = '55000';
  end if;
  select cc.phone_number_id into v_phone_number_id
    from hoteles.whatsapp_channel_config cc where cc.property_id = v_conv.property_id and cc.enabled;
  if v_phone_number_id is null then
    raise exception 'canal_no_configurado: la propiedad no tiene un numero de WhatsApp habilitado' using errcode = '55000';
  end if;

  insert into hoteles.messaging_outbox (property_id, organization_id, channel, event_type, dedupe_key, payload)
  values (v_conv.property_id, v_conv.organization_id, 'whatsapp', 'whatsapp.respuesta_humana', 'humano:' || v_msg_id::text,
          jsonb_build_object('to', v_conv.phone, 'phone_number_id', v_phone_number_id, 'body', v_texto, 'transaccional', true))
  returning id into v_outbox;

  update hoteles.whatsapp_conversations c
     set messages = c.messages || jsonb_build_array(jsonb_build_object(
           'role', 'assistant', 'content', v_texto, 'origen', 'humano', 'autor_id', auth.uid(),
           'creado_en', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'outbox_id', v_outbox)),
         no_leidos = 0, updated_at = now()
   where c.id = p_conversation_id;
  return query select v_outbox, 'pending'::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5) GRANTs
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function hoteles.conversacion_registrar_entrante(uuid, text) from public, anon;
revoke all on function hoteles.conversacion_derivar_a_humano(uuid, text, text) from public, anon;
revoke all on function hoteles.conversacion_autorizar(uuid) from public, anon, authenticated;
revoke all on function hoteles.conversaciones_listar(uuid, text, boolean, text, integer, integer) from public, anon;
revoke all on function hoteles.conversacion_detalle(uuid) from public, anon;
revoke all on function hoteles.conversacion_leer(uuid) from public, anon;
revoke all on function hoteles.conversacion_tomar(uuid, boolean) from public, anon;
revoke all on function hoteles.conversacion_devolver(uuid) from public, anon;
revoke all on function hoteles.conversacion_cerrar(uuid) from public, anon;
revoke all on function hoteles.conversacion_notas(uuid) from public, anon;
revoke all on function hoteles.conversacion_agregar_nota(uuid, text) from public, anon;
revoke all on function hoteles.conversacion_responder(uuid, text) from public, anon;

grant execute on function hoteles.conversacion_registrar_entrante(uuid, text) to authenticated, service_role;
grant execute on function hoteles.conversacion_derivar_a_humano(uuid, text, text) to authenticated, service_role;
grant execute on function hoteles.conversaciones_listar(uuid, text, boolean, text, integer, integer) to authenticated;
grant execute on function hoteles.conversacion_detalle(uuid) to authenticated;
grant execute on function hoteles.conversacion_leer(uuid) to authenticated;
grant execute on function hoteles.conversacion_tomar(uuid, boolean) to authenticated;
grant execute on function hoteles.conversacion_devolver(uuid) to authenticated;
grant execute on function hoteles.conversacion_cerrar(uuid) to authenticated;
grant execute on function hoteles.conversacion_notas(uuid) to authenticated;
grant execute on function hoteles.conversacion_agregar_nota(uuid, text) to authenticated;
grant execute on function hoteles.conversacion_responder(uuid, text) to authenticated;
