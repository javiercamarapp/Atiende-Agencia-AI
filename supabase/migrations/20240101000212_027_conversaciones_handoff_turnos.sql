-- R-21 (restaurantes): bandeja de conversaciones por sucursal (WhatsApp y voz), toma de la
-- conversacion por un humano (el agente deja de responder), devolucion al agente, cobertura por
-- TURNOS de personal por sucursal (PM trabaja 12 pm-1 am con doble turno), notas internas y
-- registro de intentos de callback. Prefijo de supabase/migrations 20240101000212 (interno 027).
--
--   1. `restaurantes.branch_shift` / `restaurantes.branch_shift_member` -- turnos de personal por
--      sucursal y quien cubre cada turno (orden 1 = principal, 2+ = respaldo).
--   2. `restaurantes.conversation_handoff` -- una fila por toma de una conversacion (WhatsApp o
--      voz): pendiente -> tomada -> devuelta | cerrada.
--   3. `restaurantes.conversation_note` -- notas internas sobre un handoff (nunca llegan al cliente).
--   4. `restaurantes.callback_attempt` -- bitacora de intentos de devolver la llamada a un
--      `callback_requests`.
--   5. Funciones: bandeja unificada, toma/devolucion/cierre, respuesta humana por WhatsApp, nota,
--      intento de callback (staff) y solicitud / consulta-con-ping (solo sistema).
--   6. Politicas ADITIVAS de lectura sobre voice_conversation / voice_turn (025) para el staff que
--      tomo la conversacion.
--
-- Decision de diseno: todo son tablas/funciones NUEVAS (mas dos politicas SELECT aditivas); ninguna
-- restriccion existente cambia. El codigo TypeScript que las consume degrada con SAVEPOINT cuando la
-- base todavia no las tiene (SQLSTATE 42P01/42703/42883) -- nada de esto se aplica al mergear.
--
-- Alcance por sucursal ("RLS por sucursal"): `core.membership.property_ids` null = todas las
-- sucursales de la organizacion; un arreglo acota. TODA politica y funcion de abajo exige
-- `restaurantes.handoff_actor_en_sucursal(...)`, que aplica esa misma regla (misma que
-- `core.has_property_access`) mas el rol vertical (owner/admin/staff; el repartidor nunca).
--
-- Justificacion de seguridad de cada GRANT / policy / funcion (una por una):
--
--  * handoff_actor_en_sucursal(org, property, solo_gestores) -- helper `security definer` con
--    `set search_path` fijo y `revoke ... from public, anon`. Necesita ser definer porque
--    `core.membership` solo deja ver la fila propia y la politica debe comparar contra la
--    pertenencia del usuario con RLS activo. Solo evalua `auth.uid()` (el llamador) contra SUS
--    propios datos y devuelve un booleano: no filtra informacion de terceros. Con `auth.uid()`
--    vacio (sistema/anon) devuelve false.
--
--  * turno_miembro_valido(org, property, user) -- helper definer (mismo blindaje). Exige que el
--    LLAMADOR sea owner/admin de esa sucursal y que el usuario asignado tenga membership en la
--    MISMA organizacion con acceso a esa sucursal: sin esto un owner podria asignar a un usuario
--    de otra organizacion a un turno propio (cross-tenant). Responde solo si el llamador es
--    gestor, asi no sirve para sondear membresias ajenas.
--
--  * branch_shift / branch_shift_member
--    - RLS habilitado; `anon` sin NINGUN privilegio.
--    - SELECT: staff de la sucursal (owner/admin/staff dentro del alcance); el repartidor no.
--    - INSERT/UPDATE/DELETE: solo owner/admin de la sucursal. El `with check` exige que la
--      property pertenezca a la organizacion declarada y, en miembros, `turno_miembro_valido`.
--      Una llave foranea compuesta (id, property_id, organization_id) impide que un miembro
--      apunte a un turno de otra sucursal u organizacion.
--    - GRANT por COLUMNA: `organization_id`/`property_id` solo en INSERT (una fila no cambia de
--      tenant ni de sucursal); UPDATE solo de los campos editables.
--
--  * conversation_handoff
--    - SELECT: staff de la sucursal (alcance por membership). SIN GRANT ni policy de
--      INSERT/UPDATE/DELETE para `authenticated`: deny-by-default; la escritura es EXCLUSIVA de
--      las funciones definer de abajo (un staff con SQL directo no puede fabricar ni robar una toma).
--    - `service_role` solo SELECT.
--
--  * conversation_note / callback_attempt
--    - SELECT: staff de la sucursal (en callbacks sin sucursal, solo membership sin acotar).
--    - Sin INSERT/UPDATE/DELETE directos: notas e intentos son append-only y se crean solo por las
--      funciones `handoff_agregar_nota` / `callback_registrar_intento`, que fijan el autor en
--      `auth.uid()` (nadie escribe a nombre de otro).
--
--  * Funciones de staff (`handoff_tomar`, `handoff_devolver`, `handoff_cerrar`,
--    `handoff_responder_whatsapp`, `handoff_agregar_nota`, `callback_registrar_intento`,
--    `bandeja_conversaciones`) -- `security definer` con `set search_path` fijo, `revoke from
--    public, anon`, GRANT EXECUTE a `authenticated`. Exigen `auth.uid()` no nulo y
--    `handoff_actor_en_sucursal`; validan que la conversacion / handoff / callback pertenezca a la
--    organizacion y sucursal declaradas (cross-tenant -> 42501). Son definer porque las tablas de
--    handoff no tienen DML para `authenticated` y porque la bandeja une conversaciones de voz
--    (solo owner/admin por 025) con metadatos NO sensibles (sin transcripcion, sin costo) para
--    que el staff de turno pueda decidir cual tomar. `handoff_devolver/cerrar` solo los puede
--    ejecutar quien tomo la conversacion o un owner/admin. `handoff_tomar` concurrente: la
--    segunda toma recibe 55006 (ya tomada) en vez de pisar la primera.
--
--  * Funciones de solo-sistema (`handoff_solicitar`, `handoff_solicitar_whatsapp`, `handoff_whatsapp_estado`) -- el agente (sin
--    usuario) pide un humano o consulta si debe callar. Exigen `auth.uid() is null` (un staff
--    autenticado recibe 42501), definer con search_path fijo, `revoke from public, anon`,
--    GRANT a `authenticated` porque la sesion de sistema del motor corre con ese rol, y validan
--    pertenencia organizacion/sucursal/conversacion.

-- ---------------------------------------------------------------------------
-- 0) Helpers de autorizacion
-- ---------------------------------------------------------------------------
create or replace function restaurantes.handoff_actor_en_sucursal(
  p_organization_id uuid,
  p_property_id uuid,
  p_solo_gestores boolean
) returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from core.membership m
    where m.user_id = auth.uid()
      and m.organization_id = p_organization_id
      and m.vertical_role = any (case when p_solo_gestores then array['owner', 'admin'] else array['owner', 'admin', 'staff'] end)
      and (m.property_ids is null or (p_property_id is not null and p_property_id = any (m.property_ids)))
      and (p_property_id is null or exists (
        select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
      ))
  );
$$;

create or replace function restaurantes.turno_miembro_valido(
  p_organization_id uuid,
  p_property_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = core, restaurantes, pg_temp
as $$
  select restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true)
    and exists (
      select 1 from core.membership m
      where m.user_id = p_user_id
        and m.organization_id = p_organization_id
        and m.vertical_role in ('owner', 'admin', 'staff')
        and (m.property_ids is null or p_property_id = any (m.property_ids))
    );
$$;

revoke all on function restaurantes.handoff_actor_en_sucursal(uuid, uuid, boolean) from public, anon;
revoke all on function restaurantes.turno_miembro_valido(uuid, uuid, uuid) from public, anon;
grant execute on function restaurantes.handoff_actor_en_sucursal(uuid, uuid, boolean) to authenticated, service_role;
grant execute on function restaurantes.turno_miembro_valido(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1) Turnos de personal por sucursal
-- ---------------------------------------------------------------------------
create table restaurantes.branch_shift (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  nombre text not null check (char_length(btrim(nombre)) between 1 and 60),
  -- Dias de la semana en que aplica (0 = domingo ... 6 = sabado), sin repetidos.
  dias smallint[] not null check (cardinality(dias) between 1 and 7 and dias <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  -- `termina <= inicia` = el turno cruza la medianoche (ej. 18:00 -> 01:00). Mismos HH:MM locales de la
  -- sucursal que `branch_policy.horario`; `inicia = termina` se rechaza (ambiguo: 0 h o 24 h).
  inicia time not null,
  termina time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (inicia <> termina),
  unique (property_id, nombre),
  unique (id, property_id, organization_id)
);

create table restaurantes.branch_shift_member (
  shift_id uuid not null,
  property_id uuid not null,
  organization_id uuid not null,
  user_id uuid not null references core.staff_user(id) on delete cascade,
  -- 1 = principal; 2.. = respaldo (escalacion).
  orden smallint not null default 1 check (orden between 1 and 5),
  primary key (shift_id, user_id),
  foreign key (shift_id, property_id, organization_id)
    references restaurantes.branch_shift (id, property_id, organization_id) on delete cascade
);
create index branch_shift_member_user_idx on restaurantes.branch_shift_member (user_id);

alter table restaurantes.branch_shift enable row level security;
alter table restaurantes.branch_shift_member enable row level security;

create policy "staff de la sucursal lee los turnos" on restaurantes.branch_shift for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, false));
create policy "owner/admin crea turnos de su sucursal" on restaurantes.branch_shift for insert
  with check (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));
create policy "owner/admin actualiza turnos de su sucursal" on restaurantes.branch_shift for update
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true))
  with check (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));
create policy "owner/admin elimina turnos de su sucursal" on restaurantes.branch_shift for delete
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

create policy "staff de la sucursal lee los miembros de turno" on restaurantes.branch_shift_member for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, false));
create policy "owner/admin asigna miembros a un turno" on restaurantes.branch_shift_member for insert
  with check (restaurantes.turno_miembro_valido(organization_id, property_id, user_id));
create policy "owner/admin reordena miembros de un turno" on restaurantes.branch_shift_member for update
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true))
  with check (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));
create policy "owner/admin quita miembros de un turno" on restaurantes.branch_shift_member for delete
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

revoke all on restaurantes.branch_shift, restaurantes.branch_shift_member from public, anon, authenticated;
grant select on restaurantes.branch_shift, restaurantes.branch_shift_member to authenticated;
grant insert (organization_id, property_id, nombre, dias, inicia, termina) on restaurantes.branch_shift to authenticated;
grant update (nombre, dias, inicia, termina, updated_at) on restaurantes.branch_shift to authenticated;
grant delete on restaurantes.branch_shift to authenticated;
grant insert (shift_id, property_id, organization_id, user_id, orden) on restaurantes.branch_shift_member to authenticated;
grant update (orden) on restaurantes.branch_shift_member to authenticated;
grant delete on restaurantes.branch_shift_member to authenticated;
grant select on restaurantes.branch_shift, restaurantes.branch_shift_member to service_role;

-- ---------------------------------------------------------------------------
-- 2) Handoff (toma de una conversacion por un humano)
-- ---------------------------------------------------------------------------
create table restaurantes.conversation_handoff (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  canal text not null check (canal in ('whatsapp', 'voz')),
  -- whatsapp_conversations.id o voice_conversation.id segun `canal`. Sin FK (es polimorfico): las
  -- funciones de abajo validan existencia y pertenencia antes de escribir.
  conversation_id uuid not null,
  -- pendiente = el agente (o un staff) pidio un humano y nadie lo ha tomado; tomada = un humano la
  -- atiende (el agente NO responde); devuelta = regresa al agente; cerrada = resuelta.
  estado text not null check (estado in ('pendiente', 'tomada', 'devuelta', 'cerrada')),
  solicitado_por text not null check (solicitado_por in ('agente', 'staff')),
  motivo text check (motivo is null or char_length(motivo) <= 500),
  solicitada_at timestamptz not null default now(),
  -- Ultimo mensaje del cliente mientras la toma estaba abierta (base de la escalacion).
  ultimo_cliente_at timestamptz,
  tomada_por uuid references core.staff_user(id) on delete set null,
  tomada_at timestamptz,
  devuelta_at timestamptz,
  cerrada_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((estado = 'tomada') = (tomada_at is not null) or estado in ('devuelta', 'cerrada'))
);
-- Una sola toma ABIERTA por conversacion.
create unique index conversation_handoff_abierta_uidx
  on restaurantes.conversation_handoff (canal, conversation_id) where estado in ('pendiente', 'tomada');
create index conversation_handoff_prop_idx
  on restaurantes.conversation_handoff (organization_id, property_id, estado, solicitada_at desc);
create index conversation_handoff_conv_idx on restaurantes.conversation_handoff (canal, conversation_id, created_at desc);

alter table restaurantes.conversation_handoff enable row level security;
create policy "staff de la sucursal lee los handoffs" on restaurantes.conversation_handoff for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, false));
revoke all on restaurantes.conversation_handoff from public, anon, authenticated;
grant select on restaurantes.conversation_handoff to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Notas internas y 4) intentos de callback
-- ---------------------------------------------------------------------------
create table restaurantes.conversation_note (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  handoff_id uuid not null references restaurantes.conversation_handoff(id) on delete cascade,
  autor_id uuid references core.staff_user(id) on delete set null,
  texto text not null check (char_length(btrim(texto)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index conversation_note_handoff_idx on restaurantes.conversation_note (handoff_id, created_at);
alter table restaurantes.conversation_note enable row level security;
create policy "staff de la sucursal lee las notas internas" on restaurantes.conversation_note for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, false));
revoke all on restaurantes.conversation_note from public, anon, authenticated;
grant select on restaurantes.conversation_note to authenticated, service_role;

create table restaurantes.callback_attempt (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete set null,
  callback_request_id uuid not null references restaurantes.callback_requests(id) on delete cascade,
  resultado text not null check (resultado in ('contactado', 'no_contesto', 'buzon', 'numero_invalido', 'reprogramar')),
  nota text check (nota is null or char_length(nota) <= 1000),
  proximo_intento_at timestamptz,
  autor_id uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index callback_attempt_cb_idx on restaurantes.callback_attempt (callback_request_id, created_at desc);
alter table restaurantes.callback_attempt enable row level security;
create policy "staff de la sucursal lee los intentos de callback" on restaurantes.callback_attempt for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, false));
revoke all on restaurantes.callback_attempt from public, anon, authenticated;
grant select on restaurantes.callback_attempt to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Politicas ADITIVAS de lectura de voz para el staff que tomo la conversacion (025 solo deja
--    leer a owner/admin: la transcripcion es voz de comensales). Un staff solo lee la
--    transcripcion de la conversacion que TIENE tomada.
-- ---------------------------------------------------------------------------
create policy "staff que tomo el handoff lee la conversacion de voz" on restaurantes.voice_conversation for select
  using (exists (
    select 1 from restaurantes.conversation_handoff h
    where h.canal = 'voz' and h.conversation_id = voice_conversation.id
      and h.estado = 'tomada' and h.tomada_por = auth.uid()
      and restaurantes.handoff_actor_en_sucursal(h.organization_id, h.property_id, false)
  ));
create policy "staff que tomo el handoff lee los turnos de voz" on restaurantes.voice_turn for select
  using (exists (
    select 1 from restaurantes.conversation_handoff h
    where h.canal = 'voz' and h.conversation_id = voice_turn.conversation_id
      and h.estado = 'tomada' and h.tomada_por = auth.uid()
      and restaurantes.handoff_actor_en_sucursal(h.organization_id, h.property_id, false)
  ));

-- ---------------------------------------------------------------------------
-- 6) Funciones de staff
-- ---------------------------------------------------------------------------

-- Pertenencia de la conversacion a la organizacion y sucursal declaradas. Una conversacion de
-- WhatsApp sin sucursal (numero de la organizacion) cuenta para cualquier sucursal de la org.
create or replace function restaurantes.handoff_conversacion_valida(
  p_organization_id uuid,
  p_property_id uuid,
  p_canal text,
  p_conversation_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if p_canal = 'whatsapp' then
    return exists (
      select 1 from restaurantes.whatsapp_conversations c
      where c.id = p_conversation_id and c.organization_id = p_organization_id
        and (c.property_id is null or c.property_id = p_property_id)
    );
  elsif p_canal = 'voz' then
    return exists (
      select 1 from restaurantes.voice_conversation c
      where c.id = p_conversation_id and c.organization_id = p_organization_id and c.property_id = p_property_id
    );
  end if;
  return false;
end;
$$;
revoke all on function restaurantes.handoff_conversacion_valida(uuid, uuid, text, uuid) from public, anon;
grant execute on function restaurantes.handoff_conversacion_valida(uuid, uuid, text, uuid) to authenticated, service_role;

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
        raise exception 'handoff_tomar: la conversacion ya la tiene otra persona' using errcode = '55006';
      end if;
      update restaurantes.conversation_handoff
        set estado = 'tomada', tomada_por = v_uid, tomada_at = now(), updated_at = now()
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
  if v_h.estado = 'tomada' and v_h.tomada_por is distinct from v_uid
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

create or replace function restaurantes.handoff_devolver(p_organization_id uuid, p_property_id uuid, p_handoff_id uuid)
returns boolean language sql security definer set search_path = restaurantes, core, pg_temp as $$
  select restaurantes.handoff_liberar(p_organization_id, p_property_id, p_handoff_id, 'devuelta');
$$;
create or replace function restaurantes.handoff_cerrar(p_organization_id uuid, p_property_id uuid, p_handoff_id uuid)
returns boolean language sql security definer set search_path = restaurantes, core, pg_temp as $$
  select restaurantes.handoff_liberar(p_organization_id, p_property_id, p_handoff_id, 'cerrada');
$$;

create or replace function restaurantes.handoff_agregar_nota(
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
  v_id uuid;
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'handoff_agregar_nota: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if not exists (
    select 1 from restaurantes.conversation_handoff h
    where h.id = p_handoff_id and h.organization_id = p_organization_id and h.property_id = p_property_id
  ) then
    raise exception 'handoff_agregar_nota: handoff inexistente o ajeno' using errcode = '42501';
  end if;
  insert into restaurantes.conversation_note (organization_id, property_id, handoff_id, autor_id, texto)
    values (p_organization_id, p_property_id, p_handoff_id, auth.uid(), btrim(p_texto))
    returning id into v_id;
  return v_id;
end;
$$;

-- Respuesta humana por WhatsApp: solo quien tiene la conversacion TOMADA. Guarda el mensaje en el
-- historial (rol assistant, autor humano: el agente lo vera como contexto al recibir la devolucion) y
-- lo encola en el outbox existente con el numero de la sucursal (o el de la organizacion).
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
  select c.phone into v_phone from restaurantes.whatsapp_conversations c
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

create or replace function restaurantes.callback_registrar_intento(
  p_organization_id uuid,
  p_callback_id uuid,
  p_resultado text,
  p_nota text,
  p_proximo_intento_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_cb restaurantes.callback_requests;
  v_id uuid;
begin
  select * into v_cb from restaurantes.callback_requests cb
    where cb.id = p_callback_id and cb.organization_id = p_organization_id for update;
  if not found or auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_cb.property_id, false) then
    raise exception 'callback_registrar_intento: inexistente o sin acceso' using errcode = '42501';
  end if;
  insert into restaurantes.callback_attempt (organization_id, property_id, callback_request_id, resultado, nota, proximo_intento_at, autor_id)
    values (p_organization_id, v_cb.property_id, p_callback_id, p_resultado, nullif(btrim(coalesce(p_nota, '')), ''), p_proximo_intento_at, auth.uid())
    returning id into v_id;
  if p_resultado in ('contactado', 'numero_invalido') then
    update restaurantes.callback_requests set resolved = true where id = p_callback_id;
  end if;
  return v_id;
end;
$$;

-- Bandeja unificada (WhatsApp + voz) de una sucursal. Solo metadatos: la transcripcion de voz y el
-- costo NO salen por aqui. Una conversacion de WhatsApp sin sucursal aparece en todas las de la org.
create or replace function restaurantes.bandeja_conversaciones(
  p_organization_id uuid,
  p_property_id uuid,
  p_estado text,
  p_canal text,
  p_limit integer,
  p_offset integer
) returns table (
  canal text,
  conversation_id uuid,
  property_id uuid,
  telefono text,
  vista_previa text,
  actividad_at timestamptz,
  estado text,
  handoff_id uuid,
  motivo text,
  solicitada_at timestamptz,
  ultimo_cliente_at timestamptz,
  tomada_por uuid,
  tomada_por_nombre text,
  tomada_at timestamptz,
  resultado_voz text,
  total bigint
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'bandeja_conversaciones: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return query
  with base as (
    select 'whatsapp'::text as canal, c.id as conversation_id, coalesce(c.property_id, p_property_id) as property_id,
           c.phone as telefono,
           left(coalesce(c.messages -> (jsonb_array_length(c.messages) - 1) ->> 'content', ''), 140) as vista_previa,
           c.updated_at as actividad_at, null::text as resultado_voz
      from restaurantes.whatsapp_conversations c
      where c.organization_id = p_organization_id and (c.property_id is null or c.property_id = p_property_id)
    union all
    select 'voz'::text, v.id, v.property_id, null::text,
           case v.resultado when 'pedido_creado' then 'Llamada: pedido creado' when 'escalado' then 'Llamada escalada a una persona'
                when 'abandonado' then 'Llamada abandonada' else 'Llamada en curso' end,
           coalesce(v.ended_at, v.started_at), v.resultado
      from restaurantes.voice_conversation v
      where v.organization_id = p_organization_id and v.property_id = p_property_id and v.canal = 'llamada'
  ), con_estado as (
    select b.*, h.id as h_id, coalesce(h.estado, 'agente') as h_estado, h.motivo as h_motivo, h.solicitada_at as h_solicitada_at,
           h.ultimo_cliente_at as h_ultimo_cliente_at, h.tomada_por as h_tomada_por, h.tomada_at as h_tomada_at
      from base b
      left join lateral (
        select x.* from restaurantes.conversation_handoff x
        where x.canal = b.canal and x.conversation_id = b.conversation_id and x.property_id = p_property_id
        order by x.created_at desc limit 1
      ) h on true
  )
  select e.canal, e.conversation_id, e.property_id, e.telefono, e.vista_previa, e.actividad_at, e.h_estado, e.h_id,
         e.h_motivo, e.h_solicitada_at, e.h_ultimo_cliente_at, e.h_tomada_por,
         (select su.full_name from core.staff_user su where su.id = e.h_tomada_por),
         e.h_tomada_at, e.resultado_voz, count(*) over ()
    from con_estado e
    where (p_estado is null or e.h_estado = p_estado) and (p_canal is null or e.canal = p_canal)
    order by (e.h_estado = 'pendiente') desc, (e.h_estado = 'tomada') desc, e.actividad_at desc, e.conversation_id
    limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Funciones de solo-sistema
-- ---------------------------------------------------------------------------
create or replace function restaurantes.handoff_solicitar(
  p_organization_id uuid,
  p_property_id uuid,
  p_canal text,
  p_conversation_id uuid,
  p_motivo text
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'handoff_solicitar es solo de sistema' using errcode = '42501';
  end if;
  if not restaurantes.handoff_conversacion_valida(p_organization_id, p_property_id, p_canal, p_conversation_id) then
    raise exception 'handoff_solicitar: la conversacion no pertenece a la sucursal' using errcode = '42501';
  end if;
  insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo)
    values (p_organization_id, p_property_id, p_canal, p_conversation_id, 'pendiente', 'agente', left(p_motivo, 500))
    on conflict (canal, conversation_id) where estado in ('pendiente', 'tomada') do nothing
    returning id into v_id;
  if v_id is null then
    select h.id into v_id from restaurantes.conversation_handoff h
      where h.canal = p_canal and h.conversation_id = p_conversation_id and h.estado in ('pendiente', 'tomada')
        and h.organization_id = p_organization_id;
  end if;
  return v_id;
end;
$$;

-- Variante para el agente de WhatsApp, que solo conoce el telefono: resuelve la conversacion por
-- (organizacion, telefono) y la sucursal (la del numero que recibio el mensaje, o la ya registrada en la
-- conversacion). Si no hay conversacion o no se puede determinar una sucursal (numero de la organizacion
-- sin sucursal elegida) devuelve null: el agente sigue su camino normal (el aviso de callback ya existe).
create or replace function restaurantes.handoff_solicitar_whatsapp(
  p_organization_id uuid,
  p_property_id uuid,
  p_phone text,
  p_motivo text
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_conv_id uuid;
  v_conv_prop uuid;
  v_prop uuid;
begin
  if auth.uid() is not null then
    raise exception 'handoff_solicitar_whatsapp es solo de sistema' using errcode = '42501';
  end if;
  select c.id, c.property_id into v_conv_id, v_conv_prop from restaurantes.whatsapp_conversations c
    where c.organization_id = p_organization_id and c.phone = p_phone;
  v_prop := coalesce(p_property_id, v_conv_prop);
  if v_conv_id is null or v_prop is null then
    return null;
  end if;
  return restaurantes.handoff_solicitar(p_organization_id, v_prop, 'whatsapp', v_conv_id, p_motivo);
end;
$$;

-- Consulta del agente de WhatsApp antes de responder: devuelve 'pendiente' | 'tomada' si hay una toma
-- abierta para ese telefono (el agente debe callar) o null. Si la hay, registra el ping del cliente
-- (`ultimo_cliente_at`), que alimenta la escalacion.
create or replace function restaurantes.handoff_whatsapp_estado(
  p_organization_id uuid,
  p_phone text
) returns text
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_estado text;
begin
  if auth.uid() is not null then
    raise exception 'handoff_whatsapp_estado es solo de sistema' using errcode = '42501';
  end if;
  update restaurantes.conversation_handoff h
    set ultimo_cliente_at = now(), updated_at = now()
    from restaurantes.whatsapp_conversations c
    where h.canal = 'whatsapp' and h.conversation_id = c.id and c.organization_id = p_organization_id and c.phone = p_phone
      and h.organization_id = p_organization_id and h.estado in ('pendiente', 'tomada')
    returning h.estado into v_estado;
  return v_estado;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Permisos de ejecucion
-- ---------------------------------------------------------------------------
revoke all on function restaurantes.handoff_tomar(uuid, uuid, text, uuid) from public, anon;
revoke all on function restaurantes.handoff_liberar(uuid, uuid, uuid, text) from public, anon;
revoke all on function restaurantes.handoff_devolver(uuid, uuid, uuid) from public, anon;
revoke all on function restaurantes.handoff_cerrar(uuid, uuid, uuid) from public, anon;
revoke all on function restaurantes.handoff_agregar_nota(uuid, uuid, uuid, text) from public, anon;
revoke all on function restaurantes.handoff_responder_whatsapp(uuid, uuid, uuid, text) from public, anon;
revoke all on function restaurantes.callback_registrar_intento(uuid, uuid, text, text, timestamptz) from public, anon;
revoke all on function restaurantes.bandeja_conversaciones(uuid, uuid, text, text, integer, integer) from public, anon;
revoke all on function restaurantes.handoff_solicitar(uuid, uuid, text, uuid, text) from public, anon;
revoke all on function restaurantes.handoff_whatsapp_estado(uuid, text) from public, anon;
revoke all on function restaurantes.handoff_solicitar_whatsapp(uuid, uuid, text, text) from public, anon;
grant execute on function restaurantes.handoff_tomar(uuid, uuid, text, uuid) to authenticated, service_role;
grant execute on function restaurantes.handoff_liberar(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function restaurantes.handoff_devolver(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function restaurantes.handoff_cerrar(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function restaurantes.handoff_agregar_nota(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function restaurantes.handoff_responder_whatsapp(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function restaurantes.callback_registrar_intento(uuid, uuid, text, text, timestamptz) to authenticated, service_role;
grant execute on function restaurantes.bandeja_conversaciones(uuid, uuid, text, text, integer, integer) to authenticated, service_role;
grant execute on function restaurantes.handoff_solicitar(uuid, uuid, text, uuid, text) to authenticated, service_role;
grant execute on function restaurantes.handoff_whatsapp_estado(uuid, text) to authenticated, service_role;
grant execute on function restaurantes.handoff_solicitar_whatsapp(uuid, uuid, text, text) to authenticated, service_role;
