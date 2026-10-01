-- Voz y agente de restaurantes: aislamiento por sucursal, estado del pedido en el servidor y bitacora.
--
-- Que agrega (3 tablas, 5 funciones):
--   1. restaurantes.voice_branch_secret  -- un secreto por sucursal para las herramientas de voz
--      (se guarda SOLO el hash sha256; el secreto en claro se muestra una vez al rotarlo).
--   2. restaurantes.order_flow_state     -- maquina de estados del pedido (cotizado -> confirmado ->
--      creando -> creado) por clave de conversacion (`wa:<telefono>` o `call:<id de llamada>`), con
--      contador de version (CAS) y vencimiento.
--   3. restaurantes.voice_tool_audit     -- bitacora append-only de las herramientas de voz
--      (emision de token, uso, denegaciones, limites). Nunca guarda telefono en claro, solo su hash.
--   Funciones: verify_voice_branch_secret, record_voice_tool_audit, read_order_flow_state,
--   write_order_flow_state (solo-sistema) y rotate_voice_branch_secret (staff owner/admin).
--
-- Compatibilidad con la base SIN migrar: el codigo TypeScript que llama a estas funciones captura
-- SQLSTATE 42883/42P01/42703 dentro de un SAVEPOINT (runWithSavepointFallback) y cae al camino
-- anterior (secreto global + sin estado + sin bitacora). Esta migracion solo AGREGA objetos nuevos:
-- no altera ni reemplaza nada existente, asi que aplicarla no cambia el comportamiento de lo
-- que ya corre.
--
-- Modelo de seguridad (cada GRANT/policy/funcion lleva su justificacion):
--   * La sesion "de sistema" de la API (webhooks/herramientas de voz, sin usuario) corre con el rol
--     `authenticated` y `auth.uid()` NULL (mismo patron que claim_whatsapp_message, 020). Las funciones
--     de solo-sistema exigen `auth.uid() is null`: un staff autenticado (auth.uid() no nulo) NO puede
--     llamarlas aunque tenga EXECUTE, y `anon` no tiene EXECUTE (nunca se otorga a anon).
--   * Las tres tablas tienen RLS habilitada y NINGUNA policy de escritura: la unica via de escritura
--     son las funciones `security definer` (search_path fijo, revoke de public/anon).
--   * voice_branch_secret no otorga NINGUN privilegio de tabla a nadie (ni select): ni siquiera el hash
--     es legible por PostgREST; solo las funciones definer lo tocan.
--   * Ningun `using (true)`.
--
-- Requiere: core.organization, core.property, core.staff_user, core.membership (0001) y el esquema
-- restaurantes (001).

-- ---------------------------------------------------------------------------
-- 1) restaurantes.voice_branch_secret
-- ---------------------------------------------------------------------------
create table restaurantes.voice_branch_secret (
  -- Una fila por sucursal; borrar la sucursal borra su secreto (no hay historia que conservar).
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- sha256 hex del secreto (256 bits aleatorios): una comparacion de igualdad sobre el hash no filtra
  -- nada util por temporizacion.
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  -- Ultimos caracteres del secreto para que el staff reconozca cual esta vigente. Nunca el secreto.
  secret_hint text not null check (char_length(secret_hint) between 1 and 8),
  -- Rotacion sin corte: el secreto anterior sigue valido hasta previous_valid_until.
  previous_hash text check (previous_hash is null or previous_hash ~ '^[0-9a-f]{64}$'),
  previous_valid_until timestamptz,
  rotated_at timestamptz not null default now(),
  rotated_by uuid references core.staff_user(id) on delete set null,
  check ((previous_hash is null) = (previous_valid_until is null))
);

-- Un hash no puede repetirse entre sucursales: verify_voice_branch_secret devuelve UNA sucursal.
create unique index restaurantes_voice_branch_secret_hash_uniq on restaurantes.voice_branch_secret (secret_hash);
create index restaurantes_voice_branch_secret_org_idx on restaurantes.voice_branch_secret (organization_id);

alter table restaurantes.voice_branch_secret enable row level security;
-- Sin policies y sin GRANTs: deny-by-default total. Solo las funciones definer (dueño de la tabla) acceden.
revoke all on restaurantes.voice_branch_secret from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) restaurantes.order_flow_state
-- ---------------------------------------------------------------------------
create table restaurantes.order_flow_state (
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- `wa:<telefono>` (WhatsApp) o `call:<id de llamada>` (voz).
  flow_key text not null check (char_length(flow_key) between 1 and 200),
  state text not null check (state in ('cotizado', 'confirmado', 'creando', 'creado')),
  context jsonb not null check (octet_length(context::text) <= 8192),
  -- Contador de concurrencia optimista: write_order_flow_state solo avanza si coincide.
  version integer not null default 1 check (version >= 1),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, flow_key)
);
create index restaurantes_order_flow_state_expires_idx on restaurantes.order_flow_state (organization_id, expires_at);

alter table restaurantes.order_flow_state enable row level security;
revoke all on restaurantes.order_flow_state from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) restaurantes.voice_tool_audit (append-only)
-- ---------------------------------------------------------------------------
create table restaurantes.voice_tool_audit (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  -- restrict (no cascade): el trigger de abajo prohibe todo DELETE, asi que la FK expresa lo mismo.
  organization_id uuid not null references core.organization(id) on delete restrict,
  -- Sin FK: un SET NULL al borrar la sucursal seria un UPDATE y el trigger append-only lo bloquea.
  property_id uuid,
  call_id text check (call_id is null or char_length(call_id) <= 128),
  tool text not null check (char_length(tool) between 1 and 100),
  outcome text not null check (outcome in ('ok', 'denied', 'error', 'rate_limited', 'token_issued')),
  -- sha256 del telefono del llamante. Nunca el numero.
  phone_hash text check (phone_hash is null or phone_hash ~ '^[0-9a-f]{64}$'),
  detail text check (detail is null or char_length(detail) <= 300),
  created_at timestamptz not null default now()
);
create index restaurantes_voice_tool_audit_org_created_idx on restaurantes.voice_tool_audit (organization_id, created_at desc, seq desc);

alter table restaurantes.voice_tool_audit enable row level security;
-- Lectura solo para owner/admin de la organizacion (mismo criterio que restaurantes.audit_log).
create policy "owner/admin lee la bitacora de voz de su organizacion" on restaurantes.voice_tool_audit for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = voice_tool_audit.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));
revoke all on restaurantes.voice_tool_audit from public, anon, authenticated, service_role;
grant select on restaurantes.voice_tool_audit to authenticated, service_role;

create or replace function restaurantes.voice_tool_audit_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'restaurantes_voice_tool_audit_append_only: % no esta permitido sobre restaurantes.voice_tool_audit', tg_op
    using errcode = '0A000';
end;
$$;
create trigger restaurantes_voice_tool_audit_block_update_trg
  before update on restaurantes.voice_tool_audit
  for each row execute function restaurantes.voice_tool_audit_block_mutation();
create trigger restaurantes_voice_tool_audit_block_delete_trg
  before delete on restaurantes.voice_tool_audit
  for each row execute function restaurantes.voice_tool_audit_block_mutation();

-- ---------------------------------------------------------------------------
-- 4) verify_voice_branch_secret -- SOLO SISTEMA. Devuelve la sucursal dueña del secreto (vigente o
--    anterior dentro de su ventana de gracia) DENTRO de la organizacion indicada, o NULL.
--    Justificacion: la herramienta de voz se autentica antes de que exista un usuario; el secreto de
--    otra organizacion nunca coincide porque la busqueda esta acotada por p_organization_id.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.verify_voice_branch_secret(p_organization_id uuid, p_secret_hash text)
returns uuid
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_property uuid;
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.verify_voice_branch_secret: solo la sesion de sistema (auth.uid() es NULL).'
      using errcode = '42501';
  end if;
  if p_organization_id is null or p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select s.property_id into v_property
  from restaurantes.voice_branch_secret s
  where s.organization_id = p_organization_id
    and (s.secret_hash = p_secret_hash or (s.previous_hash = p_secret_hash and s.previous_valid_until > now()))
  limit 1;
  return v_property;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) rotate_voice_branch_secret -- STAFF owner/admin. Crea o rota el secreto de UNA sucursal de su
--    organizacion. El actor sale de auth.uid() (nunca de un parametro); se valida rol y que la
--    sucursal pertenezca a la organizacion y sea de restaurantes.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.rotate_voice_branch_secret(
  p_organization_id uuid,
  p_property_id uuid,
  p_secret_hash text,
  p_secret_hint text,
  p_grace_seconds integer
)
returns timestamptz
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_grace integer := least(greatest(coalesce(p_grace_seconds, 0), 0), 86400);
  v_rotated_at timestamptz := now();
begin
  if v_actor is null then
    raise exception 'restaurantes.rotate_voice_branch_secret: requiere un actor autenticado (auth.uid() es NULL).'
      using errcode = '28000';
  end if;
  select m.vertical_role into v_role
  from core.membership m
  where m.organization_id = p_organization_id and m.user_id = v_actor;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'restaurantes.rotate_voice_branch_secret: el actor no es owner/admin de la organizacion.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.property p
    where p.id = p_property_id and p.organization_id = p_organization_id and p.vertical = 'restaurantes'
  ) then
    raise exception 'restaurantes.rotate_voice_branch_secret: la sucursal no pertenece a la organizacion.'
      using errcode = '42501';
  end if;
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'restaurantes.rotate_voice_branch_secret: hash invalido (se espera sha256 hex).'
      using errcode = '22023';
  end if;

  insert into restaurantes.voice_branch_secret as s (property_id, organization_id, secret_hash, secret_hint, rotated_at, rotated_by)
  values (p_property_id, p_organization_id, p_secret_hash, left(coalesce(nullif(p_secret_hint, ''), '?'), 8), v_rotated_at, v_actor)
  on conflict (property_id) do update
    set previous_hash = s.secret_hash,
        previous_valid_until = v_rotated_at + make_interval(secs => v_grace),
        secret_hash = excluded.secret_hash,
        secret_hint = excluded.secret_hint,
        rotated_at = excluded.rotated_at,
        rotated_by = excluded.rotated_by;
  return v_rotated_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) record_voice_tool_audit -- SOLO SISTEMA. Unica via de escritura de la bitacora de voz.
--    Trunca defensivamente (left) para que los CHECK de longitud nunca hagan perder la fila.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.record_voice_tool_audit(
  p_organization_id uuid,
  p_property_id uuid,
  p_call_id text,
  p_tool text,
  p_outcome text,
  p_phone_hash text,
  p_detail text
)
returns void
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.record_voice_tool_audit: solo la sesion de sistema (auth.uid() es NULL).'
      using errcode = '42501';
  end if;
  insert into restaurantes.voice_tool_audit (organization_id, property_id, call_id, tool, outcome, phone_hash, detail)
  values (p_organization_id, p_property_id, left(p_call_id, 128), left(p_tool, 100), p_outcome, p_phone_hash, left(p_detail, 300));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) read_order_flow_state / write_order_flow_state -- SOLO SISTEMA.
--    read: SIEMPRE devuelve una fila. Un estado vencido se ve como "sin estado" pero conserva su
--    version, para que el siguiente write (expected = esa version) sea un CAS valido.
--    write: CAS por version. expected = 0 crea la fila; expected > 0 la avanza. Devuelve
--    'written' o 'conflict' (otra peticion llego primero).
-- ---------------------------------------------------------------------------
create or replace function restaurantes.read_order_flow_state(p_organization_id uuid, p_flow_key text)
returns table (state text, context jsonb, version integer)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  r restaurantes.order_flow_state%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.read_order_flow_state: solo la sesion de sistema (auth.uid() es NULL).'
      using errcode = '42501';
  end if;
  select * into r from restaurantes.order_flow_state f
  where f.organization_id = p_organization_id and f.flow_key = p_flow_key;
  if not found then
    return query select null::text, null::jsonb, 0;
  elsif r.expires_at <= now() then
    return query select null::text, null::jsonb, r.version;
  else
    return query select r.state, r.context, r.version;
  end if;
end;
$$;

create or replace function restaurantes.write_order_flow_state(
  p_organization_id uuid,
  p_flow_key text,
  p_expected_version integer,
  p_state text,
  p_context jsonb,
  p_ttl_seconds integer
)
returns text
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_count integer;
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 7200), 1), 86400);
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.write_order_flow_state: solo la sesion de sistema (auth.uid() es NULL).'
      using errcode = '42501';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    return 'conflict';
  end if;

  if p_expected_version = 0 then
    -- Limpieza oportunista y acotada a la organizacion: filas vencidas hace mas de un dia.
    delete from restaurantes.order_flow_state f
    where f.organization_id = p_organization_id and f.expires_at < now() - interval '1 day';
    insert into restaurantes.order_flow_state (organization_id, flow_key, state, context, version, expires_at)
    values (p_organization_id, p_flow_key, p_state, p_context, 1, now() + make_interval(secs => v_ttl))
    on conflict (organization_id, flow_key) do nothing;
  else
    update restaurantes.order_flow_state f
    set state = p_state, context = p_context, version = f.version + 1,
        expires_at = now() + make_interval(secs => v_ttl), updated_at = now()
    where f.organization_id = p_organization_id and f.flow_key = p_flow_key and f.version = p_expected_version;
  end if;
  get diagnostics v_count = row_count;
  return case when v_count = 1 then 'written' else 'conflict' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Permisos de ejecucion. `revoke ... from public, anon` explicito (un ALTER DEFAULT PRIVILEGES de
--    Supabase puede dar EXECUTE a anon sobre funciones nuevas). Nunca GRANT a anon.
-- ---------------------------------------------------------------------------
revoke all on function restaurantes.verify_voice_branch_secret(uuid, text) from public, anon;
revoke all on function restaurantes.rotate_voice_branch_secret(uuid, uuid, text, text, integer) from public, anon;
revoke all on function restaurantes.record_voice_tool_audit(uuid, uuid, text, text, text, text, text) from public, anon;
revoke all on function restaurantes.read_order_flow_state(uuid, text) from public, anon;
revoke all on function restaurantes.write_order_flow_state(uuid, text, integer, text, jsonb, integer) from public, anon;
-- `authenticated` porque la sesion de sistema corre con ese rol; el guard auth.uid() is null de cada
-- funcion de solo-sistema impide que un staff real las use.
grant execute on function restaurantes.verify_voice_branch_secret(uuid, text) to authenticated;
grant execute on function restaurantes.rotate_voice_branch_secret(uuid, uuid, text, text, integer) to authenticated;
grant execute on function restaurantes.record_voice_tool_audit(uuid, uuid, text, text, text, text, text) to authenticated;
grant execute on function restaurantes.read_order_flow_state(uuid, text) to authenticated;
grant execute on function restaurantes.write_order_flow_state(uuid, text, integer, text, jsonb, integer) to authenticated;
