-- CHAT-04 -- Copiloto "Chatea con tus datos": PERSISTENCIA de conversaciones (side chats).
--
-- Que agrega (todo aditivo; ninguna tabla ni funcion existente cambia):
--   1. core.data_chat_conversation / core.data_chat_message: la conversacion de UN usuario con el Copiloto, dentro
--      de UNA organizacion (scope 'vertical') o de la plataforma (scope 'plataforma', solo superadmin).
--   2. core.append_data_chat_turn(...): UNICA via de escritura de mensajes (security definer).
--
-- Que se guarda: la pregunta ya redactada (sin correos, tarjetas, telefonos ni enlaces), el texto de la respuesta
-- y sus bloques de tabla (maximo 50 filas, celdas ya saneadas por el motor), las fuentes y las herramientas
-- ejecutadas con sus parametros tipados. NO se guardan prompts, salida cruda del modelo ni adjuntos.
-- Limites: 200 conversaciones por usuario y organizacion; 100 mensajes por conversacion (al llegar al tope el
-- siguiente turno abre una conversacion de continuacion).
--
-- Compatibilidad con la base SIN migrar: nada de lo existente depende de estas tablas. El codigo TypeScript
-- (apps/api/src/data-chat/conversaciones.ts) corre cada acceso en SAVEPOINT y, si falta la tabla o la funcion
-- (42P01 / 42883 / 42703), responde "no disponible aun" (lista vacia) o 404 sin romper el turno del chat.
--
-- Requiere: 0001_core_schema.sql (core.organization, core.property, core.staff_user, core.membership),
-- 0012_caller_binding_fase2.sql (core.is_platform_superadmin), 0029_data_chat_query_log.sql (mismo patron).
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, policy y funcion nueva):
--   * Tablas con RLS activa y `revoke all` a public/anon/authenticated/service_role. `anon` no recibe nada.
--   * GRANT `select` a authenticated en ambas tablas: la lectura la filtra la policy (solo el propio autor, con
--     membresia vigente en la organizacion o superadmin vigente para plataforma). El owner/admin TAMPOCO lee las
--     conversaciones de su staff: la auditoria vive en core.data_chat_query_log, que no guarda texto.
--   * GRANT `delete` a authenticated solo sobre la conversacion (los mensajes caen por ON DELETE CASCADE, que no
--     requiere privilegio sobre la tabla de mensajes): la policy exige el mismo criterio de autor + membresia.
--   * GRANT `update (title)` a nivel COLUMNA: lo unico que el usuario puede cambiar es el titulo (renombrar). La
--     policy de update exige autor + membresia, y el CHECK acota 1..80 caracteres no vacios. Contadores, fechas y
--     scope no son escribibles por el cliente.
--   * SIN grant ni policy de insert/update/delete sobre core.data_chat_message para nadie: los mensajes solo
--     nacen en core.append_data_chat_turn y no se editan (ni siquiera el propio autor).
--   * core.append_data_chat_turn es security definer (authenticated no tiene INSERT) con `set search_path = core,
--     pg_temp` fijo y `revoke ... from public, anon`. El autor SIEMPRE es auth.uid() (no hay parametro de usuario
--     que falsificar; nunca corre desde la sesion de sistema: 28000). Exige membresia del actor en la
--     organizacion (42501) o superadmin vigente para plataforma (42501); la vertical se toma de
--     core.organization, no de un parametro; la propiedad debe estar dentro del alcance de la membresia
--     (core.has_property_access). Una conversacion ajena o de otra organizacion es indistinguible de una
--     inexistente (P0002), nunca se confirma su existencia.

-- ---------------------------------------------------------------------------
-- 1) Tablas
-- ---------------------------------------------------------------------------
create table core.data_chat_conversation (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('vertical', 'plataforma')),
  organization_id uuid references core.organization(id) on delete cascade,
  vertical text not null check (vertical in ('restaurantes', 'hoteles', 'rentas', 'despachos', 'licitaciones', 'citas', 'plataforma')),
  -- Sucursal/propiedad desde la que se abrio (informativo; el alcance de lectura de datos lo recalcula el servidor
  -- en cada turno con la membresia vigente).
  property_id uuid references core.property(id) on delete set null,
  user_id uuid not null references core.staff_user(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80 and btrim(title) <> ''),
  message_count integer not null default 0 check (message_count between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'plataforma') = (organization_id is null)),
  check ((scope = 'plataforma') = (vertical = 'plataforma'))
);

create index data_chat_conversation_user_idx
  on core.data_chat_conversation (user_id, organization_id, updated_at desc, id);

create table core.data_chat_message (
  conversation_id uuid not null references core.data_chat_conversation(id) on delete cascade,
  seq integer not null check (seq between 1 and 100),
  role text not null check (role in ('user', 'assistant')),
  text text not null check (char_length(text) between 1 and 2000),
  status text check (status is null or char_length(status) <= 30),
  blocks jsonb not null default '[]'::jsonb check (jsonb_typeof(blocks) = 'array' and pg_column_size(blocks) <= 65536),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 8192),
  -- [{tool, args}] con parametros tipados del catalogo cerrado: nunca ids de organizacion ni de sucursal.
  tool_calls jsonb not null default '[]'::jsonb check (jsonb_typeof(tool_calls) = 'array' and pg_column_size(tool_calls) <= 8192),
  created_at timestamptz not null default now(),
  primary key (conversation_id, seq)
);

alter table core.data_chat_conversation enable row level security;
alter table core.data_chat_message enable row level security;

-- ---------------------------------------------------------------------------
-- 2) RLS y GRANT
-- ---------------------------------------------------------------------------
create policy "autor lee su conversacion del copiloto" on core.data_chat_conversation for select
  using (
    user_id = auth.uid()
    and (
      (scope = 'vertical' and exists (
        select 1 from core.membership m
        where m.user_id = auth.uid() and m.organization_id = data_chat_conversation.organization_id))
      or (scope = 'plataforma' and core.is_platform_superadmin(auth.uid()))
    )
  );

create policy "autor renombra su conversacion del copiloto" on core.data_chat_conversation for update
  using (
    user_id = auth.uid()
    and (
      (scope = 'vertical' and exists (
        select 1 from core.membership m
        where m.user_id = auth.uid() and m.organization_id = data_chat_conversation.organization_id))
      or (scope = 'plataforma' and core.is_platform_superadmin(auth.uid()))
    )
  )
  with check (
    user_id = auth.uid()
    and (
      (scope = 'vertical' and exists (
        select 1 from core.membership m
        where m.user_id = auth.uid() and m.organization_id = data_chat_conversation.organization_id))
      or (scope = 'plataforma' and core.is_platform_superadmin(auth.uid()))
    )
  );

create policy "autor borra su conversacion del copiloto" on core.data_chat_conversation for delete
  using (
    user_id = auth.uid()
    and (
      (scope = 'vertical' and exists (
        select 1 from core.membership m
        where m.user_id = auth.uid() and m.organization_id = data_chat_conversation.organization_id))
      or (scope = 'plataforma' and core.is_platform_superadmin(auth.uid()))
    )
  );

-- Los mensajes se leen solo si la conversacion padre es visible para el usuario (la RLS del padre aplica dentro
-- del subselect: el mismo criterio de autor + membresia, sin duplicarlo).
create policy "autor lee los mensajes de su conversacion del copiloto" on core.data_chat_message for select
  using (exists (select 1 from core.data_chat_conversation c where c.id = data_chat_message.conversation_id));

revoke all on core.data_chat_conversation from public, anon, authenticated, service_role;
revoke all on core.data_chat_message from public, anon, authenticated, service_role;
grant select, delete on core.data_chat_conversation to authenticated;
grant update (title) on core.data_chat_conversation to authenticated;
grant select on core.data_chat_message to authenticated;

-- ---------------------------------------------------------------------------
-- 3) core.append_data_chat_turn -- UNICA via de escritura de mensajes.
--    Agrega DOS filas (pregunta y respuesta) bajo FOR UPDATE de la conversacion. p_conversation_id null = abre una
--    conversacion nueva (titulo = la pregunta de 60 caracteres o menos mas "..." si se recorta). Si la conversacion
--    ya tiene 100 mensajes (o 99), abre una de continuacion. Devuelve (conversacion, seq del mensaje del asistente).
--    Errores con SQLSTATE propio para que la API los distinga:
--      28000 sin actor | 42501 sin membresia/superadmin/propiedad fuera de alcance | P0002 conversacion inexistente o
--      ajena | 22023 texto vacio o argumento incoherente | 54000 llego al tope de 200 conversaciones.
-- ---------------------------------------------------------------------------
create or replace function core.append_data_chat_turn(
  p_organization_id uuid,
  p_property_id uuid,
  p_conversation_id uuid,
  p_user_text text,
  p_assistant_text text,
  p_status text,
  p_blocks jsonb,
  p_sources jsonb,
  p_tool_calls jsonb
)
returns table (out_conversation_id uuid, out_seq integer)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_scope text;
  v_vertical text;
  v_conv core.data_chat_conversation%rowtype;
  v_found boolean := false;
  v_flat text;
  v_title text;
  v_user_text text := left(coalesce(p_user_text, ''), 2000);
  v_assistant_text text := left(coalesce(p_assistant_text, ''), 2000);
  v_blocks jsonb := case when p_blocks is not null and jsonb_typeof(p_blocks) = 'array' then p_blocks else '[]'::jsonb end;
  v_sources jsonb := case when p_sources is not null and jsonb_typeof(p_sources) = 'array' then p_sources else '[]'::jsonb end;
  v_tools jsonb := case when p_tool_calls is not null and jsonb_typeof(p_tool_calls) = 'array' then p_tool_calls else '[]'::jsonb end;
  v_count integer;
  v_seq integer;
begin
  if v_actor is null then
    raise exception 'core.append_data_chat_turn: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;

  if p_organization_id is null then
    if not core.is_platform_superadmin(v_actor) then
      raise exception 'core.append_data_chat_turn: el actor no es superadmin de plataforma.' using errcode = '42501';
    end if;
    if p_property_id is not null then
      raise exception 'core.append_data_chat_turn: una conversacion de plataforma no lleva propiedad.' using errcode = '22023';
    end if;
    v_scope := 'plataforma';
    v_vertical := 'plataforma';
  else
    if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_actor) then
      raise exception 'core.append_data_chat_turn: el actor no pertenece a la organizacion.' using errcode = '42501';
    end if;
    select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
    if p_property_id is not null and not (
      core.has_property_access(v_actor, p_property_id)
      and exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id)
    ) then
      raise exception 'core.append_data_chat_turn: la propiedad esta fuera del alcance del actor.' using errcode = '42501';
    end if;
    v_scope := 'vertical';
  end if;

  if btrim(v_user_text) = '' or btrim(v_assistant_text) = '' then
    raise exception 'core.append_data_chat_turn: pregunta y respuesta no pueden estar vacias.' using errcode = '22023';
  end if;
  -- Respaldo: la API ya recorta los bloques; un jsonb fuera de tope nunca debe perder el texto del turno.
  if pg_column_size(v_blocks) > 65536 then v_blocks := '[]'::jsonb; end if;
  if pg_column_size(v_sources) > 8192 then v_sources := '[]'::jsonb; end if;
  if pg_column_size(v_tools) > 8192 then v_tools := '[]'::jsonb; end if;

  v_flat := btrim(regexp_replace(v_user_text, '\s+', ' ', 'g'));
  v_title := case when char_length(v_flat) > 60 then left(v_flat, 60) || '…' else v_flat end;

  if p_conversation_id is not null then
    select c.* into v_conv
    from core.data_chat_conversation c
    where c.id = p_conversation_id
      and c.user_id = v_actor
      and c.scope = v_scope
      and c.organization_id is not distinct from p_organization_id
    for update;
    v_found := found;
    if not v_found then
      raise exception 'core.append_data_chat_turn: la conversacion no existe.' using errcode = 'P0002';
    end if;
    if v_conv.message_count + 2 > 100 then
      -- Tope de mensajes: la conversacion de continuacion hereda el titulo y arranca vacia.
      v_title := left(v_conv.title, 70) || ' (cont.)';
      v_found := false;
    end if;
  end if;

  if not v_found then
    -- Serializa las altas del mismo autor para que el tope de 200 no se rebase por carreras.
    perform pg_advisory_xact_lock(hashtextextended('data_chat_conversation:' || v_actor::text || ':' || coalesce(p_organization_id::text, 'plataforma'), 0));
    select count(*) into v_count
    from core.data_chat_conversation c
    where c.user_id = v_actor and c.scope = v_scope and c.organization_id is not distinct from p_organization_id;
    if v_count >= 200 then
      raise exception 'core.append_data_chat_turn: limite_conversaciones (200).' using errcode = '54000';
    end if;
    insert into core.data_chat_conversation (scope, organization_id, vertical, property_id, user_id, title, message_count)
    values (v_scope, p_organization_id, v_vertical, p_property_id, v_actor, v_title, 0)
    returning * into v_conv;
  end if;

  v_seq := v_conv.message_count + 1;
  insert into core.data_chat_message (conversation_id, seq, role, text) values (v_conv.id, v_seq, 'user', v_user_text);
  insert into core.data_chat_message (conversation_id, seq, role, text, status, blocks, sources, tool_calls)
  values (v_conv.id, v_seq + 1, 'assistant', v_assistant_text, left(p_status, 30), v_blocks, v_sources, v_tools);
  update core.data_chat_conversation set message_count = v_seq + 1, updated_at = now() where id = v_conv.id;

  out_conversation_id := v_conv.id;
  out_seq := v_seq + 1;
  return next;
end;
$$;

revoke all on function core.append_data_chat_turn(uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function core.append_data_chat_turn(uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb) to authenticated;

comment on table core.data_chat_conversation is
  'Conversaciones del Copiloto: una por usuario y organizacion (o plataforma). Solo el autor las ve; el owner tampoco lee las de su staff.';
comment on table core.data_chat_message is
  'Mensajes del Copiloto (pregunta redactada, respuesta con tablas). Solo nacen en core.append_data_chat_turn; sin edicion.';
comment on function core.append_data_chat_turn(uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb) is
  'Unica via de escritura de mensajes del Copiloto: actor = auth.uid(), membresia o superadmin, 200 conversaciones y 100 mensajes como tope.';
