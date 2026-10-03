-- C-11 (citas): bandeja de conversaciones de WhatsApp con handoff a humano. Prefijo de supabase/migrations
-- 20240101000289 (interno 031). Patron probado de restaurantes R-21 (028), reducido al canal de WhatsApp de citas.
--
--   1. `citas.conversation_handoff` -- una fila por toma de una conversacion de `citas.whatsapp_conversations`:
--      pendiente -> tomada -> devuelta | cerrada. Mientras haya una toma ABIERTA (pendiente o tomada) el agente NO
--      responde: el entrante solo se guarda (el codigo lo consulta con `handoff_whatsapp_estado`).
--   2. `citas.conversation_note` -- notas internas sobre un handoff (nunca llegan al cliente).
--   3. Funciones de staff (bandeja, detalle, notas, tomar, devolver, cerrar, agregar nota, responder por el outbox)
--      y de SOLO-SISTEMA (el agente pide un humano, p. ej. por una escalacion de crisis; el agente consulta si debe callar).
--
-- Decision de compatibilidad: todo son tablas/funciones NUEVAS; ninguna restriccion ni policy existente cambia. El codigo
-- TypeScript que las usa corre dentro de SAVEPOINT (`runWithSavepointFallback`) y, con la base sin migrar (SQLSTATE
-- 42P01/42703/42883), las lecturas responden `disponible: false`, las escrituras 503 y el agente sigue respondiendo como
-- antes. Nada de esto se aplica al mergear.
--
-- Alcance por sucursal: `core.membership.property_ids` null = todas las sucursales de la organizacion; un arreglo acota.
-- `citas.whatsapp_conversations.property_id` es NULLABLE (el numero es de la organizacion y la sucursal solo se conoce al
-- reservar): una conversacion SIN sucursal pertenece a toda la organizacion, y su handoff hereda esa sucursal nula
-- (`property_id` null = visible para cualquier miembro owner/admin/staff de la organizacion, igual que la conversacion
-- misma, que ya leia cualquier miembro por la policy de 004). Una conversacion CON sucursal solo la gestiona quien tiene
-- acceso a esa sucursal. El handoff NUNCA cambia de sucursal.
--
-- Justificacion de seguridad de cada GRANT / policy / funcion (una por una):
--
--  * handoff_actor(org, property, solo_gestores) -- helper `security definer` con `set search_path` fijo y
--    `revoke ... from public, anon`. Necesita ser definer porque `core.membership` solo deja ver la fila propia y la
--    policy debe comparar contra la pertenencia del usuario con RLS activo. Solo evalua `auth.uid()` (el llamador) contra
--    SUS propios datos y devuelve un booleano: no filtra informacion de terceros. Con `auth.uid()` vacio (sistema/anon)
--    devuelve false.
--
--  * conversation_handoff
--    - RLS habilitado; `anon` sin NINGUN privilegio.
--    - SELECT: owner/admin/staff dentro del alcance (`handoff_actor`). SIN GRANT ni policy de INSERT/UPDATE/DELETE para
--      `authenticated`: deny-by-default; la escritura es EXCLUSIVA de las funciones definer de abajo (un staff con SQL
--      directo no puede fabricar ni robar una toma). `service_role` solo SELECT.
--    - Un trigger `before update` rechaza (55000) salir de un estado final (devuelta/cerrada) o saltarse el orden
--      pendiente -> tomada -> devuelta|cerrada: defensa en profundidad ante un bug futuro de una funcion definer.
--    - FK `conversation_id -> citas.whatsapp_conversations(id) on delete cascade`: la toma no puede apuntar a una
--      conversacion inexistente ni de otra organizacion (`organization_id` se valida contra la conversacion en cada funcion).
--
--  * conversation_note
--    - SELECT: mismo alcance que el handoff. Sin INSERT/UPDATE/DELETE directos: las notas son append-only y se crean solo
--      por `handoff_agregar_nota`, que fija el autor en `auth.uid()` (nadie escribe a nombre de otro). Tope de 2000
--      caracteres en la base (CHECK).
--
--  * Funciones de staff (`handoff_tomar`, `handoff_liberar`/`handoff_devolver`/`handoff_cerrar`, `handoff_agregar_nota`,
--    `handoff_responder`, `bandeja_conversaciones`, `handoff_detalle`, `handoff_notas`) -- `security definer` con
--    `set search_path` fijo, `revoke from public, anon`, GRANT EXECUTE a `authenticated` y `service_role`. Exigen
--    `auth.uid()` no nulo y `handoff_actor`; validan que la conversacion / handoff pertenezca a la organizacion y sucursal
--    declaradas (cross-tenant -> 42501, sin confirmar que existe). Son definer porque las tablas de handoff no tienen DML
--    para `authenticated` y porque `citas.whatsapp_conversations` no se actualiza desde el panel. `handoff_devolver` y
--    `handoff_cerrar` solo los ejecuta quien tomo la conversacion o un owner/admin. `handoff_tomar` concurrente: la segunda
--    toma recibe 55006 (ya tomada) en vez de pisar la primera. `handoff_responder` exige ser quien TIENE la toma; escribe
--    el mensaje humano en el historial y lo encola por `citas.enqueue_messaging_outbox` (que vuelve a exigir membership);
--    ninguna funcion habla con Meta.
--
--  * `bandeja_conversaciones` devuelve metadatos y una vista previa de 140 caracteres (el mismo texto que el staff ya puede
--    leer en `whatsapp_conversations`), la cita vinculada (id, inicio y estado: sin datos del cliente) y UN booleano `crisis`
--    (existe una escalacion de crisis del mismo telefono, de los ultimos 30 dias y sin resolver). El extracto del mensaje
--    de crisis, la palabra clave y el seguimiento siguen siendo solo de owner/admin por `citas.avisos`; aqui solo se
--    marca la conversacion para que cualquiera del equipo la priorice.
--
--  * Funciones de solo-sistema (`handoff_solicitar_whatsapp`, `handoff_whatsapp_estado`) -- el agente (sin usuario) pide un
--    humano o consulta si debe callar. Exigen `auth.uid() is null` (un staff autenticado recibe 42501), definer con
--    search_path fijo, `revoke from public, anon`, GRANT a `authenticated` porque la sesion de sistema del motor corre con
--    ese rol, y validan pertenencia organizacion/conversacion (por telefono dentro de SU organizacion).
--
-- PL-14 (handoff generico en core-conversation) sigue pendiente: cuando exista, esta tabla migra a `core` y estas
-- funciones se vuelven envoltorios finos. Punto de migracion futura marcado tambien en packages/domain-citas/src/conversaciones.

-- ---------------------------------------------------------------------------
-- 0) Helper de autorizacion
-- ---------------------------------------------------------------------------
create or replace function citas.handoff_actor(
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
      and (p_property_id is null or m.property_ids is null or p_property_id = any (m.property_ids))
      and (p_property_id is null or exists (
        select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
      ))
  );
$$;
revoke all on function citas.handoff_actor(uuid, uuid, boolean) from public, anon;
grant execute on function citas.handoff_actor(uuid, uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1) Handoff (toma de una conversacion por un humano)
-- ---------------------------------------------------------------------------
create table citas.conversation_handoff (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Sucursal de la conversacion (nula si la conversacion no tiene: pertenece a toda la organizacion).
  property_id uuid references core.property(id) on delete cascade,
  conversation_id uuid not null references citas.whatsapp_conversations(id) on delete cascade,
  -- pendiente = el agente (o un staff) pidio un humano y nadie lo ha tomado; tomada = un humano la atiende (el agente NO
  -- responde); devuelta = regresa al agente; cerrada = resuelta.
  estado text not null check (estado in ('pendiente', 'tomada', 'devuelta', 'cerrada')),
  solicitado_por text not null check (solicitado_por in ('agente', 'staff')),
  motivo text check (motivo is null or char_length(motivo) <= 500),
  -- La toma nacio de una escalacion de crisis (guardrail determinista): la bandeja la marca y la prioriza.
  crisis boolean not null default false,
  solicitada_at timestamptz not null default now(),
  -- Ultimo mensaje del cliente mientras la toma estaba abierta.
  ultimo_cliente_at timestamptz,
  tomada_por uuid references core.staff_user(id) on delete set null,
  tomada_at timestamptz,
  devuelta_at timestamptz,
  cerrada_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Una sola toma ABIERTA por conversacion.
create unique index conversation_handoff_abierta_uidx
  on citas.conversation_handoff (conversation_id) where estado in ('pendiente', 'tomada');
create index conversation_handoff_org_idx
  on citas.conversation_handoff (organization_id, estado, solicitada_at desc);
create index conversation_handoff_conv_idx on citas.conversation_handoff (conversation_id, created_at desc);

create or replace function citas.conversation_handoff_transicion() returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  if old.estado = new.estado then
    return new;
  end if;
  if (old.estado = 'pendiente' and new.estado in ('tomada', 'devuelta', 'cerrada'))
     or (old.estado = 'tomada' and new.estado in ('devuelta', 'cerrada')) then
    return new;
  end if;
  raise exception 'conversation_handoff: transicion invalida % -> %', old.estado, new.estado using errcode = '55000';
end;
$$;
create trigger conversation_handoff_transicion before update on citas.conversation_handoff
  for each row execute function citas.conversation_handoff_transicion();

alter table citas.conversation_handoff enable row level security;
create policy "staff del alcance lee los handoffs" on citas.conversation_handoff for select
  using (citas.handoff_actor(organization_id, property_id, false));
revoke all on citas.conversation_handoff from public, anon, authenticated;
grant select on citas.conversation_handoff to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Notas internas
-- ---------------------------------------------------------------------------
create table citas.conversation_note (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete cascade,
  handoff_id uuid not null references citas.conversation_handoff(id) on delete cascade,
  autor_id uuid references core.staff_user(id) on delete set null,
  texto text not null check (char_length(btrim(texto)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index conversation_note_handoff_idx on citas.conversation_note (handoff_id, created_at);
alter table citas.conversation_note enable row level security;
create policy "staff del alcance lee las notas internas" on citas.conversation_note for select
  using (citas.handoff_actor(organization_id, property_id, false));
revoke all on citas.conversation_note from public, anon, authenticated;
grant select on citas.conversation_note to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Funciones de staff
-- ---------------------------------------------------------------------------

-- Helper INTERNO (definer, sin guard propio): solo lo llaman las funciones definer de esta migracion, que ya validaron al
-- actor. NO se concede a authenticated ni a service_role: nadie puede sondear con UUIDs si una conversacion es de una
-- organizacion o sucursal. Devuelve la sucursal de la conversacion (null = sin sucursal) y si es valida.
create or replace function citas.handoff_conversacion_valida(
  p_organization_id uuid,
  p_property_id uuid,
  p_conversation_id uuid
) returns boolean
language sql
stable
security definer
set search_path = citas, pg_temp
as $$
  select exists (
    select 1 from citas.whatsapp_conversations c
    where c.id = p_conversation_id and c.organization_id = p_organization_id
      and (c.property_id is null or c.property_id = p_property_id)
  );
$$;
revoke all on function citas.handoff_conversacion_valida(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function citas.handoff_tomar(
  p_organization_id uuid,
  p_property_id uuid,
  p_conversation_id uuid
) returns uuid
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_h citas.conversation_handoff;
  v_id uuid;
  v_conv_prop uuid;
begin
  if v_uid is null or not citas.handoff_actor(p_organization_id, p_property_id, false) then
    raise exception 'handoff_tomar: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if not citas.handoff_conversacion_valida(p_organization_id, p_property_id, p_conversation_id) then
    raise exception 'handoff_tomar: la conversacion no pertenece a la organizacion o sucursal' using errcode = '42501';
  end if;
  select c.property_id into v_conv_prop from citas.whatsapp_conversations c where c.id = p_conversation_id;
  for i in 1..2 loop
    select * into v_h from citas.conversation_handoff h
      where h.conversation_id = p_conversation_id and h.estado in ('pendiente', 'tomada')
      for update;
    if found then
      if v_h.organization_id <> p_organization_id then
        raise exception 'handoff_tomar: la toma abierta es de otra organizacion' using errcode = '42501';
      end if;
      if v_h.estado = 'tomada' then
        if v_h.tomada_por = v_uid then return v_h.id; end if;
        raise exception 'handoff_tomar: la conversacion ya la tiene otra persona' using errcode = '55006';
      end if;
      update citas.conversation_handoff
        set estado = 'tomada', tomada_por = v_uid, tomada_at = now(), updated_at = now()
        where id = v_h.id;
      return v_h.id;
    end if;
    begin
      insert into citas.conversation_handoff (organization_id, property_id, conversation_id, estado, solicitado_por, tomada_por, tomada_at)
        values (p_organization_id, v_conv_prop, p_conversation_id, 'tomada', 'staff', v_uid, now())
        returning id into v_id;
      return v_id;
    exception when unique_violation then
      null; -- otra sesion abrio la toma entre el select y el insert: reintenta por el camino de arriba.
    end;
  end loop;
  raise exception 'handoff_tomar: no se pudo tomar la conversacion' using errcode = '55006';
end;
$$;

create or replace function citas.handoff_liberar(
  p_organization_id uuid,
  p_property_id uuid,
  p_handoff_id uuid,
  p_nuevo_estado text
) returns boolean
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_h citas.conversation_handoff;
begin
  if v_uid is null or not citas.handoff_actor(p_organization_id, p_property_id, false) then
    raise exception 'handoff: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_nuevo_estado not in ('devuelta', 'cerrada') then
    raise exception 'handoff: estado final invalido' using errcode = '22023';
  end if;
  select * into v_h from citas.conversation_handoff h
    where h.id = p_handoff_id and h.organization_id = p_organization_id
      and (h.property_id is null or h.property_id = p_property_id)
    for update;
  if not found then
    raise exception 'handoff: inexistente o ajeno' using errcode = '42501';
  end if;
  if v_h.estado not in ('pendiente', 'tomada') then
    return false; -- ya estaba devuelta/cerrada (idempotente)
  end if;
  -- Solo quien la tomo, o un owner/admin, la libera. Una pendiente la puede cerrar cualquier staff del alcance.
  if v_h.estado = 'tomada' and v_h.tomada_por is distinct from v_uid
     and not citas.handoff_actor(p_organization_id, p_property_id, true) then
    raise exception 'handoff: la conversacion la tiene otra persona' using errcode = '42501';
  end if;
  update citas.conversation_handoff set
    estado = p_nuevo_estado,
    devuelta_at = case when p_nuevo_estado = 'devuelta' then now() else devuelta_at end,
    cerrada_at = case when p_nuevo_estado = 'cerrada' then now() else cerrada_at end,
    updated_at = now()
  where id = v_h.id;
  return true;
end;
$$;

create or replace function citas.handoff_devolver(p_organization_id uuid, p_property_id uuid, p_handoff_id uuid)
returns boolean language sql security definer set search_path = citas, core, pg_temp as $$
  select citas.handoff_liberar(p_organization_id, p_property_id, p_handoff_id, 'devuelta');
$$;
create or replace function citas.handoff_cerrar(p_organization_id uuid, p_property_id uuid, p_handoff_id uuid)
returns boolean language sql security definer set search_path = citas, core, pg_temp as $$
  select citas.handoff_liberar(p_organization_id, p_property_id, p_handoff_id, 'cerrada');
$$;

create or replace function citas.handoff_agregar_nota(
  p_organization_id uuid,
  p_property_id uuid,
  p_handoff_id uuid,
  p_texto text
) returns uuid
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_id uuid;
  v_h citas.conversation_handoff;
begin
  if auth.uid() is null or not citas.handoff_actor(p_organization_id, p_property_id, false) then
    raise exception 'handoff_agregar_nota: sin acceso a la sucursal' using errcode = '42501';
  end if;
  select * into v_h from citas.conversation_handoff h
    where h.id = p_handoff_id and h.organization_id = p_organization_id
      and (h.property_id is null or h.property_id = p_property_id);
  if not found then
    raise exception 'handoff_agregar_nota: handoff inexistente o ajeno' using errcode = '42501';
  end if;
  insert into citas.conversation_note (organization_id, property_id, handoff_id, autor_id, texto)
    values (p_organization_id, v_h.property_id, p_handoff_id, auth.uid(), btrim(p_texto))
    returning id into v_id;
  return v_id;
end;
$$;

-- Respuesta humana por WhatsApp: solo quien tiene la conversacion TOMADA. Guarda el mensaje en el historial (rol assistant,
-- autor humano: el agente lo vera como contexto al recibir la devolucion) y lo encola en el outbox existente con el numero
-- de WhatsApp de la organizacion. Fuera de la ventana de 24 h de Meta el envio real requiere una plantilla HSM (PL-31): ahi
-- el despachador lo deja en `dead`; esta funcion no puede saberlo.
create or replace function citas.handoff_responder(
  p_organization_id uuid,
  p_property_id uuid,
  p_handoff_id uuid,
  p_texto text
) returns uuid
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_h citas.conversation_handoff;
  v_phone text;
  v_pnid text;
  v_texto text := btrim(p_texto);
  v_outbox uuid;
begin
  if v_uid is null or not citas.handoff_actor(p_organization_id, p_property_id, false) then
    raise exception 'handoff_responder: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if v_texto is null or char_length(v_texto) not between 1 and 1000 then
    raise exception 'handoff_responder: mensaje vacio o demasiado largo' using errcode = '22023';
  end if;
  select * into v_h from citas.conversation_handoff h
    where h.id = p_handoff_id and h.organization_id = p_organization_id
      and (h.property_id is null or h.property_id = p_property_id)
    for update;
  if not found or v_h.estado <> 'tomada' or v_h.tomada_por is distinct from v_uid then
    raise exception 'handoff_responder: solo quien tiene tomada la conversacion puede responder' using errcode = '42501';
  end if;
  select c.phone into v_phone from citas.whatsapp_conversations c
    where c.id = v_h.conversation_id and c.organization_id = p_organization_id;
  if v_phone is null then
    raise exception 'handoff_responder: conversacion inexistente' using errcode = '42501';
  end if;
  select w.phone_number_id into v_pnid from citas.whatsapp_config w
    where w.organization_id = p_organization_id and w.is_active;
  if v_pnid is null then
    raise exception 'handoff_responder: la organizacion no tiene numero de WhatsApp activo' using errcode = 'P0002';
  end if;
  update citas.whatsapp_conversations
    set messages = messages || jsonb_build_array(jsonb_build_object('role', 'assistant', 'content', v_texto, 'autor', 'humano', 'staff_id', v_uid)),
        updated_at = now()
    where id = v_h.conversation_id and organization_id = p_organization_id;
  v_outbox := citas.enqueue_messaging_outbox(
    p_organization_id, 'whatsapp', 'whatsapp.handoff_reply',
    'handoff-reply:' || p_handoff_id::text || ':' || gen_random_uuid()::text,
    jsonb_build_object('to', v_phone, 'phone_number_id', v_pnid, 'body', v_texto, 'transaccional', true)
  );
  return v_outbox;
end;
$$;

-- Bandeja de la organizacion (filtrada a la sucursal pedida). Una conversacion SIN sucursal aparece en todas.
create or replace function citas.bandeja_conversaciones(
  p_organization_id uuid,
  p_property_id uuid,
  p_estado text,
  p_limit integer,
  p_offset integer
) returns table (
  conversation_id uuid,
  property_id uuid,
  telefono text,
  vista_previa text,
  actividad_at timestamptz,
  estado text,
  handoff_id uuid,
  motivo text,
  crisis boolean,
  solicitada_at timestamptz,
  ultimo_cliente_at timestamptz,
  tomada_por uuid,
  tomada_por_nombre text,
  tomada_at timestamptz,
  cita_id uuid,
  cita_inicio timestamptz,
  cita_estado text,
  total bigint
)
language plpgsql
stable
security definer
set search_path = citas, core, pg_temp
as $$
begin
  if auth.uid() is null or not citas.handoff_actor(p_organization_id, p_property_id, false) then
    raise exception 'bandeja_conversaciones: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return query
  with base as (
    select c.id as conv_id, c.property_id as conv_prop, c.phone as tel, c.appointment_id as appt_id,
           left(coalesce(c.messages -> (jsonb_array_length(c.messages) - 1) ->> 'content', ''), 140) as preview,
           c.updated_at as act_at,
           exists (
             select 1 from citas.emergency_escalations e
             where e.organization_id = c.organization_id and e.customer_phone = c.phone
               and e.follow_up_status <> 'resolved' and e.created_at > now() - interval '30 days'
           ) as en_crisis
      from citas.whatsapp_conversations c
      where c.organization_id = p_organization_id and (c.property_id is null or c.property_id = p_property_id)
  ), con_estado as (
    select b.*, h.id as h_id, coalesce(h.estado, 'agente') as h_estado, h.motivo as h_motivo, h.crisis as h_crisis,
           h.solicitada_at as h_solicitada_at, h.ultimo_cliente_at as h_ultimo_cliente_at, h.tomada_por as h_tomada_por,
           h.tomada_at as h_tomada_at
      from base b
      left join lateral (
        select x.* from citas.conversation_handoff x
        where x.conversation_id = b.conv_id
        order by x.created_at desc limit 1
      ) h on true
  )
  select e.conv_id, coalesce(e.conv_prop, p_property_id), e.tel, e.preview, e.act_at, e.h_estado, e.h_id, e.h_motivo,
         (e.en_crisis or coalesce(e.h_crisis, false)), e.h_solicitada_at, e.h_ultimo_cliente_at, e.h_tomada_por,
         (select su.full_name from core.staff_user su where su.id = e.h_tomada_por), e.h_tomada_at,
         a.id, a.starts_at, a.status, count(*) over ()
    from con_estado e
    left join citas.appointments a on a.id = e.appt_id and a.organization_id = p_organization_id
    where (p_estado is null or e.h_estado = p_estado)
    order by (e.en_crisis or coalesce(e.h_crisis, false)) desc, (e.h_estado = 'pendiente') desc, (e.h_estado = 'tomada') desc, e.act_at desc, e.conv_id
    limit least(greatest(coalesce(p_limit, 25), 1), 100) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Lecturas con nombres de personas (core.staff_user solo deja ver la fila propia). Devuelven solo el nombre completo del
-- personal de la MISMA organizacion que el llamador ya ve en la bandeja; nunca correo ni telefono del personal.
create or replace function citas.handoff_detalle(
  p_organization_id uuid,
  p_property_id uuid,
  p_conversation_id uuid
) returns table (
  handoff_id uuid, estado text, solicitado_por text, motivo text, crisis boolean, solicitada_at timestamptz,
  ultimo_cliente_at timestamptz, tomada_por uuid, tomada_por_nombre text, tomada_at timestamptz
)
language plpgsql
stable
security definer
set search_path = citas, core, pg_temp
as $$
begin
  if auth.uid() is null or not citas.handoff_actor(p_organization_id, p_property_id, false) then
    raise exception 'handoff_detalle: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if not citas.handoff_conversacion_valida(p_organization_id, p_property_id, p_conversation_id) then
    raise exception 'handoff_detalle: la conversacion no pertenece a la organizacion o sucursal' using errcode = '42501';
  end if;
  return query
  select h.id, h.estado, h.solicitado_por, h.motivo, h.crisis, h.solicitada_at, h.ultimo_cliente_at, h.tomada_por,
         (select su.full_name from core.staff_user su where su.id = h.tomada_por), h.tomada_at
    from citas.conversation_handoff h
    where h.organization_id = p_organization_id and h.conversation_id = p_conversation_id
    order by h.created_at desc limit 1;
end;
$$;

create or replace function citas.handoff_notas(
  p_organization_id uuid,
  p_property_id uuid,
  p_handoff_id uuid
) returns table (id uuid, autor_id uuid, autor_nombre text, texto text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = citas, core, pg_temp
as $$
begin
  if auth.uid() is null or not citas.handoff_actor(p_organization_id, p_property_id, false) then
    raise exception 'handoff_notas: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return query
  select n.id, n.autor_id, (select su.full_name from core.staff_user su where su.id = n.autor_id), n.texto, n.created_at
    from citas.conversation_note n
    where n.handoff_id = p_handoff_id and n.organization_id = p_organization_id
      and (n.property_id is null or n.property_id = p_property_id)
    order by n.created_at, n.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Funciones de solo-sistema (el agente de WhatsApp, sin usuario)
-- ---------------------------------------------------------------------------

-- El agente (o el guardrail de crisis) pide un humano para la conversacion de ese telefono DENTRO de su organizacion. Si no
-- hay conversacion devuelve null (el agente sigue su camino normal). Idempotente: si ya hay una toma abierta devuelve su id.
create or replace function citas.handoff_solicitar_whatsapp(
  p_organization_id uuid,
  p_phone text,
  p_motivo text,
  p_crisis boolean
) returns uuid
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_conv_id uuid;
  v_conv_prop uuid;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'handoff_solicitar_whatsapp es solo de sistema' using errcode = '42501';
  end if;
  select c.id, c.property_id into v_conv_id, v_conv_prop from citas.whatsapp_conversations c
    where c.organization_id = p_organization_id and c.phone = p_phone;
  if v_conv_id is null then
    return null;
  end if;
  insert into citas.conversation_handoff (organization_id, property_id, conversation_id, estado, solicitado_por, motivo, crisis)
    values (p_organization_id, v_conv_prop, v_conv_id, 'pendiente', 'agente', left(p_motivo, 500), coalesce(p_crisis, false))
    on conflict (conversation_id) where estado in ('pendiente', 'tomada') do nothing
    returning id into v_id;
  if v_id is null then
    select h.id into v_id from citas.conversation_handoff h
      where h.conversation_id = v_conv_id and h.estado in ('pendiente', 'tomada') and h.organization_id = p_organization_id;
  end if;
  return v_id;
end;
$$;

-- Consulta del agente antes de responder: 'pendiente' | 'tomada' si hay una toma abierta para ese telefono (el agente debe
-- callar) o null. Si la hay, registra el ping del cliente (`ultimo_cliente_at`).
create or replace function citas.handoff_whatsapp_estado(
  p_organization_id uuid,
  p_phone text
) returns text
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_estado text;
begin
  if auth.uid() is not null then
    raise exception 'handoff_whatsapp_estado es solo de sistema' using errcode = '42501';
  end if;
  update citas.conversation_handoff h
    set ultimo_cliente_at = now(), updated_at = now()
    from citas.whatsapp_conversations c
    where h.conversation_id = c.id and c.organization_id = p_organization_id and c.phone = p_phone
      and h.organization_id = p_organization_id and h.estado in ('pendiente', 'tomada')
    returning h.estado into v_estado;
  return v_estado;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Permisos de ejecucion
-- ---------------------------------------------------------------------------
revoke all on function citas.handoff_tomar(uuid, uuid, uuid) from public, anon;
revoke all on function citas.handoff_liberar(uuid, uuid, uuid, text) from public, anon;
revoke all on function citas.handoff_devolver(uuid, uuid, uuid) from public, anon;
revoke all on function citas.handoff_cerrar(uuid, uuid, uuid) from public, anon;
revoke all on function citas.handoff_agregar_nota(uuid, uuid, uuid, text) from public, anon;
revoke all on function citas.handoff_responder(uuid, uuid, uuid, text) from public, anon;
revoke all on function citas.bandeja_conversaciones(uuid, uuid, text, integer, integer) from public, anon;
revoke all on function citas.handoff_detalle(uuid, uuid, uuid) from public, anon;
revoke all on function citas.handoff_notas(uuid, uuid, uuid) from public, anon;
revoke all on function citas.handoff_solicitar_whatsapp(uuid, text, text, boolean) from public, anon;
revoke all on function citas.handoff_whatsapp_estado(uuid, text) from public, anon;
grant execute on function citas.handoff_tomar(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function citas.handoff_liberar(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function citas.handoff_devolver(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function citas.handoff_cerrar(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function citas.handoff_agregar_nota(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function citas.handoff_responder(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function citas.bandeja_conversaciones(uuid, uuid, text, integer, integer) to authenticated, service_role;
grant execute on function citas.handoff_detalle(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function citas.handoff_notas(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function citas.handoff_solicitar_whatsapp(uuid, text, text, boolean) to authenticated, service_role;
grant execute on function citas.handoff_whatsapp_estado(uuid, text) to authenticated, service_role;
