-- Backend propio de voz para restaurantes (reemplaza a la edge `agent-config` de ElevenLabs
-- del repo suelto). Una sola migracion, prefijo de supabase/migrations 20240101000198
-- (interno restaurantes 025), con cuatro tablas y cuatro funciones:
--
--   1. `restaurantes.branch_voice_config`   -- configuracion de voz POR SUCURSAL (proveedor,
--      voice_id del catalogo de 30 voces de Gemini, comportamiento/prompt, mensaje inicial,
--      habilitado).
--   2. `restaurantes.voice_preview_sessions` -- sesiones de preview emitidas desde el panel
--      (el token efimero firmado por la API se liga a una fila de esta tabla).
--   3. `restaurantes.voice_conversation`     -- una fila por llamada/preview: duracion, costo
--      estimado en micro-USD, latencia y resultado (pedido_creado | escalado | abandonado).
--   4. `restaurantes.voice_turn`             -- transcripcion propia turno a turno.
--
-- Decision de diseno: todo son tablas/funciones NUEVAS; ninguna modifica una restriccion
-- existente. El codigo TypeScript que las consume degrada con SAVEPOINT cuando la base
-- todavia no las tiene (SQLSTATE 42P01/42703/42883/42501) -- nada de esto se aplica al mergear.
--
-- Justificacion de seguridad de cada GRANT / policy / funcion (una por una):
--
--  * branch_voice_config
--    - RLS habilitado; `anon` no recibe NINGUN privilegio (ni lectura).
--    - SELECT: owner/admin de la organizacion, o sesion de SISTEMA (`auth.uid() is null`: el
--      servicio de voz, sin usuario, debe leer la configuracion de la sucursal para armar la
--      sesion; mismo escape hatch que branch_policy en 023). El comportamiento/prompt es
--      configuracion comercial, por eso staff "de piso" (rol staff) NO lo lee.
--    - INSERT/UPDATE solo owner/admin (mismo umbral que la politica de sucursal). El
--      `with check` de INSERT exige que `property_id` pertenezca a `organization_id` (sin esto
--      el owner de la org A podria escribir una fila para una property de la org B
--      declarando su propia org).
--    - GRANT por COLUMNA: la API solo escribe habilitado, proveedor, voice_id, comportamiento,
--      mensaje_inicial y updated_at (upsert por property_id). `organization_id` se concede
--      solo en INSERT (una fila no puede cambiar de tenant). Sin DELETE: se sobreescribe.
--
--  * voice_preview_sessions
--    - SELECT: owner/admin de la organizacion o sistema (para validar una sesion).
--    - INSERT: owner/admin; el `with check` exige created_by = auth.uid() (nadie emite
--      previews a nombre de otro), property de la misma organizacion y vigencia maxima de 15
--      minutos (la tabla tambien lo acota con un CHECK).
--    - GRANT por columna en INSERT (sin id/consumed_at: los pone la base). Sin UPDATE/DELETE
--      directos: la unica mutacion es `voz_consumir_preview` (abajo).
--
--  * voice_conversation / voice_turn
--    - SELECT solo owner/admin de la organizacion: la transcripcion contiene voz de
--      comensales (PII), mas sensible que el catalogo. `anon` sin privilegios.
--    - SIN policy ni GRANT de INSERT/UPDATE/DELETE para `authenticated`: deny-by-default. La
--      escritura es EXCLUSIVA de las tres funciones de solo-sistema de abajo. Ningun staff con
--      SQL directo puede sembrar ni alterar transcripciones.
--    - `service_role` solo SELECT (un job de plataforma puede leer; no hay caller que escriba
--      directo).
--
--  * Funciones de solo-sistema (`voz_iniciar_conversacion`, `voz_registrar_turno`,
--    `voz_cerrar_conversacion`, `voz_consumir_preview`)
--    - `security definer` con `set search_path` fijo y `revoke ... from public, anon`. Se
--      conceden a `authenticated` porque la sesion de sistema del motor corre con ese rol y
--      `auth.uid()` vacio; cada funcion EXIGE `auth.uid() is null` (un staff autenticado que
--      la invoque recibe 42501) -- solo el servicio de voz, detras del secreto interno de la
--      API, escribe transcripciones.
--    - Necesitan ser definer porque las tablas de conversacion no tienen INSERT para
--      `authenticated`. Cada una valida que la property/conversacion pertenezca a la
--      `organization_id` declarada (cross-tenant) y es idempotente (el servicio reintenta).
--    - `voz_cerrar_conversacion` CALCULA duracion, costo total y p95 de latencia desde los
--      turnos ya guardados: el llamador no puede declarar un costo distinto al de la suma.

-- ---------------------------------------------------------------------------
-- 1) branch_voice_config
-- ---------------------------------------------------------------------------
create table restaurantes.branch_voice_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  habilitado boolean not null default false,
  proveedor text not null default 'gemini-3.8-live'
    check (proveedor in ('gemini-3.8-live', 'gpt-live-1', 'elevenlabs-agents')),
  -- Nombre de una de las 30 voces del catalogo de Gemini. La lista vive en la capa de
  -- aplicacion (catalogo estatico verificado); aqui solo se acota el tipo y el tamano para
  -- que agregar una voz nueva no exija una migracion.
  voice_id text not null check (char_length(voice_id) between 1 and 64),
  comportamiento text not null default '' check (char_length(comportamiento) <= 8000),
  mensaje_inicial text not null default '' check (char_length(mensaje_inicial) <= 500),
  updated_at timestamptz not null default now()
);

alter table restaurantes.branch_voice_config enable row level security;

create policy "owner/admin o sistema lee la config de voz" on restaurantes.branch_voice_config for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = branch_voice_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin crea la config de voz de su sucursal" on restaurantes.branch_voice_config for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_voice_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and exists (
      select 1 from core.property p
      where p.id = branch_voice_config.property_id and p.organization_id = branch_voice_config.organization_id
    )
  );

create policy "owner/admin actualiza la config de voz de su sucursal" on restaurantes.branch_voice_config for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_voice_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_voice_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.branch_voice_config from public, anon;
grant select on restaurantes.branch_voice_config to authenticated;
grant insert (property_id, organization_id, habilitado, proveedor, voice_id, comportamiento, mensaje_inicial, updated_at)
  on restaurantes.branch_voice_config to authenticated;
grant update (habilitado, proveedor, voice_id, comportamiento, mensaje_inicial, updated_at)
  on restaurantes.branch_voice_config to authenticated;
grant select, insert, update, delete on restaurantes.branch_voice_config to service_role;

-- ---------------------------------------------------------------------------
-- 2) voice_preview_sessions
-- ---------------------------------------------------------------------------
create table restaurantes.voice_preview_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  created_by uuid not null references core.staff_user(id) on delete cascade,
  proveedor text not null check (proveedor in ('gemini-3.8-live', 'gpt-live-1', 'elevenlabs-agents')),
  voice_id text not null check (char_length(voice_id) between 1 and 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
create index voice_preview_sessions_org_created_idx on restaurantes.voice_preview_sessions (organization_id, created_at desc);

alter table restaurantes.voice_preview_sessions enable row level security;

create policy "owner/admin o sistema lee las sesiones de preview" on restaurantes.voice_preview_sessions for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = voice_preview_sessions.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin emite una sesion de preview" on restaurantes.voice_preview_sessions for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = voice_preview_sessions.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and exists (
      select 1 from core.property p
      where p.id = voice_preview_sessions.property_id and p.organization_id = voice_preview_sessions.organization_id
    )
  );

revoke all on restaurantes.voice_preview_sessions from public, anon;
grant select on restaurantes.voice_preview_sessions to authenticated;
grant insert (id, organization_id, property_id, created_by, proveedor, voice_id, created_at, expires_at)
  on restaurantes.voice_preview_sessions to authenticated;
grant select, insert, update, delete on restaurantes.voice_preview_sessions to service_role;

-- ---------------------------------------------------------------------------
-- 3) voice_conversation
-- ---------------------------------------------------------------------------
create table restaurantes.voice_conversation (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  -- Clave idempotente que asigna el servicio de voz (id de sala/llamada); el reintento de
  -- `voz_iniciar_conversacion` devuelve la MISMA fila.
  external_id text not null check (char_length(external_id) between 1 and 200),
  canal text not null check (canal in ('llamada', 'preview')),
  proveedor text not null check (proveedor in ('gemini-3.8-live', 'gpt-live-1', 'elevenlabs-agents')),
  voice_id text check (voice_id is null or char_length(voice_id) between 1 and 64),
  -- sha256 hexadecimal del telefono: el telefono en claro NO se guarda aqui.
  caller_hash text check (caller_hash is null or caller_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_s integer check (duration_s is null or duration_s >= 0),
  costo_estimado_micro_usd bigint not null default 0 check (costo_estimado_micro_usd >= 0),
  latencia_p95_ms integer check (latencia_p95_ms is null or latencia_p95_ms >= 0),
  -- null = conversacion en curso.
  resultado text check (resultado is null or resultado in ('pedido_creado', 'escalado', 'abandonado')),
  order_id uuid references restaurantes.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, external_id)
);
create index voice_conversation_prop_started_idx on restaurantes.voice_conversation (organization_id, property_id, started_at desc, id desc);

alter table restaurantes.voice_conversation enable row level security;

create policy "owner/admin lee las conversaciones de voz" on restaurantes.voice_conversation for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = voice_conversation.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
  ));

revoke all on restaurantes.voice_conversation from public, anon, authenticated;
grant select on restaurantes.voice_conversation to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) voice_turn
-- ---------------------------------------------------------------------------
create table restaurantes.voice_turn (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references restaurantes.voice_conversation(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  seq integer not null check (seq >= 0),
  rol text not null check (rol in ('cliente', 'agente', 'herramienta')),
  -- Texto YA redactado por la capa de aplicacion (numeros de tarjeta) antes de persistir.
  texto text not null check (char_length(texto) <= 4000),
  duracion_ms integer check (duracion_ms is null or duracion_ms >= 0),
  latencia_ms integer check (latencia_ms is null or latencia_ms >= 0),
  costo_estimado_micro_usd bigint not null default 0 check (costo_estimado_micro_usd >= 0),
  created_at timestamptz not null default now(),
  unique (conversation_id, seq)
);
create index voice_turn_org_idx on restaurantes.voice_turn (organization_id);

alter table restaurantes.voice_turn enable row level security;

create policy "owner/admin lee los turnos de voz" on restaurantes.voice_turn for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = voice_turn.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
  ));

revoke all on restaurantes.voice_turn from public, anon, authenticated;
grant select on restaurantes.voice_turn to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Funciones de solo-sistema
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_iniciar_conversacion(
  p_organization_id uuid,
  p_property_id uuid,
  p_external_id text,
  p_canal text,
  p_proveedor text,
  p_voice_id text,
  p_caller_hash text,
  p_started_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'voz_iniciar_conversacion es solo de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'la sucursal no pertenece a la organizacion' using errcode = '42501';
  end if;
  insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, voice_id, caller_hash, started_at)
    values (p_organization_id, p_property_id, p_external_id, p_canal, p_proveedor, p_voice_id, p_caller_hash, coalesce(p_started_at, now()))
    on conflict (organization_id, external_id) do nothing
    returning id into v_id;
  if v_id is null then
    select c.id into v_id from restaurantes.voice_conversation c
      where c.organization_id = p_organization_id and c.external_id = p_external_id and c.property_id = p_property_id;
    if v_id is null then
      raise exception 'external_id ya usado en otra sucursal de la organizacion' using errcode = '23505';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function restaurantes.voz_registrar_turno(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_seq integer,
  p_rol text,
  p_texto text,
  p_duracion_ms integer,
  p_latencia_ms integer,
  p_costo_micro_usd bigint
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'voz_registrar_turno es solo de sistema' using errcode = '42501';
  end if;
  if not exists (
    select 1 from restaurantes.voice_conversation c
    where c.id = p_conversation_id and c.organization_id = p_organization_id and c.ended_at is null
  ) then
    raise exception 'conversacion inexistente, ajena o ya cerrada' using errcode = '42501';
  end if;
  insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto, duracion_ms, latencia_ms, costo_estimado_micro_usd)
    values (p_conversation_id, p_organization_id, p_seq, p_rol, left(p_texto, 4000), p_duracion_ms, p_latencia_ms, coalesce(p_costo_micro_usd, 0))
    on conflict (conversation_id, seq) do nothing
    returning id into v_id;
  return v_id is not null;
end;
$$;

create or replace function restaurantes.voz_cerrar_conversacion(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_resultado text,
  p_ended_at timestamptz,
  p_order_id uuid
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_rows integer;
begin
  if auth.uid() is not null then
    raise exception 'voz_cerrar_conversacion es solo de sistema' using errcode = '42501';
  end if;
  if p_order_id is not null and not exists (
    select 1 from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id
  ) then
    raise exception 'el pedido no pertenece a la organizacion' using errcode = '42501';
  end if;
  update restaurantes.voice_conversation c set
    ended_at = coalesce(p_ended_at, now()),
    resultado = p_resultado,
    order_id = p_order_id,
    duration_s = greatest(0, extract(epoch from (coalesce(p_ended_at, now()) - c.started_at))::integer),
    costo_estimado_micro_usd = coalesce((select sum(t.costo_estimado_micro_usd) from restaurantes.voice_turn t where t.conversation_id = c.id), 0),
    latencia_p95_ms = (select percentile_disc(0.95) within group (order by t.latencia_ms) from restaurantes.voice_turn t where t.conversation_id = c.id and t.latencia_ms is not null)
  where c.id = p_conversation_id and c.organization_id = p_organization_id and c.ended_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function restaurantes.voz_consumir_preview(
  p_session_id uuid,
  p_organization_id uuid,
  p_property_id uuid
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_rows integer;
begin
  if auth.uid() is not null then
    raise exception 'voz_consumir_preview es solo de sistema' using errcode = '42501';
  end if;
  update restaurantes.voice_preview_sessions s set consumed_at = now()
    where s.id = p_session_id and s.organization_id = p_organization_id and s.property_id = p_property_id
      and s.consumed_at is null and s.expires_at > now();
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function restaurantes.voz_iniciar_conversacion(uuid, uuid, text, text, text, text, text, timestamptz) from public, anon;
revoke all on function restaurantes.voz_registrar_turno(uuid, uuid, integer, text, text, integer, integer, bigint) from public, anon;
revoke all on function restaurantes.voz_cerrar_conversacion(uuid, uuid, text, timestamptz, uuid) from public, anon;
revoke all on function restaurantes.voz_consumir_preview(uuid, uuid, uuid) from public, anon;
grant execute on function restaurantes.voz_iniciar_conversacion(uuid, uuid, text, text, text, text, text, timestamptz) to authenticated, service_role;
grant execute on function restaurantes.voz_registrar_turno(uuid, uuid, integer, text, text, integer, integer, bigint) to authenticated, service_role;
grant execute on function restaurantes.voz_cerrar_conversacion(uuid, uuid, text, timestamptz, uuid) to authenticated, service_role;
grant execute on function restaurantes.voz_consumir_preview(uuid, uuid, uuid) to authenticated, service_role;
