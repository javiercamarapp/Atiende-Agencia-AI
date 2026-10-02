-- CHAT-06 / MOD-05 / CHAT-15 -- Copiloto "Chatea con tus datos": cache de resultados, ruta en la bitacora y tablero de fijados.
--
-- Que agrega (todo aditivo; ninguna tabla ni funcion existente cambia de comportamiento):
--   1. core.data_chat_query_log.route + core.record_data_chat_query (sobrecarga de 8 argumentos): la bitacora registra por
--      que ruta salio cada consulta ('directa' = chip sin modelo, 'cache' = resultado guardado, 'llm' = la pidio el modelo).
--   2. core.data_chat_cache + core.data_chat_cache_get / _put / _purge: cache de RESULTADOS DETERMINISTAS de herramientas
--      (nunca texto del modelo). Solo funciones de SISTEMA.
--   3. core.copiloto_pin + core.copiloto_pin_create + core.copiloto_pin_author_is_admin: resultados fijados en el tablero.
--
-- Compatibilidad con la base SIN migrar: el codigo TypeScript (apps/api/src/data-chat/cache.ts, pins.ts, deps.ts) corre cada
-- acceso en SU PROPIA transaccion de sistema o en SAVEPOINT y, si falta la tabla o funcion (42P01 / 42883 / 42703), la cache
-- degrada a "miss", la bitacora a la sobrecarga de 7 argumentos (o a un log estructurado) y los fijados a "no disponible aun".
--
-- Requiere: 0001_core_schema.sql, 0029_data_chat_query_log.sql, 0041_copiloto_conversaciones.sql.
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, policy y funcion nueva):
--   * core.data_chat_query_log.route: columna nueva con CHECK de tres valores; la tabla ya es append-only (triggers) y su
--     escritura sigue siendo SOLO por funcion definer. La sobrecarga de 8 argumentos conserva TODAS las defensas de la de 7
--     (actor = auth.uid(), 28000 sin actor, 42501 sin membresia, vertical tomada de core.organization) y solo agrega route.
--   * core.data_chat_cache: RLS activa SIN ninguna policy y `revoke all` a public/anon/authenticated/service_role => ningun
--     rol de aplicacion lee ni escribe la tabla de forma directa. Solo se toca via las tres funciones definer de abajo.
--   * data_chat_cache_get / _put / _purge: security definer con `set search_path = core, pg_temp`, `revoke ... from public,
--     anon` y GRANT execute a authenticated (el rol de BD de TODAS las sesiones de la API). Son funciones de SOLO SISTEMA:
--     exigen `auth.uid() is null` (42501 si hay un usuario real), asi que ningun usuario autenticado puede leer ni sembrar
--     la cache desde su sesion; la API las llama desde una sesion de sistema propia. La clave es un hash que incluye la
--     organizacion, el alcance de sucursales y el rol (lo arma el servidor), nunca un dato que el cliente controle.
--     _put acota TTL (1 s .. 24 h) y tamano (64 KB) y purga de forma oportunista hasta 200 filas vencidas por llamada.
--   * core.copiloto_pin: RLS activa; `revoke all` a public/anon/authenticated/service_role; `anon` no recibe nada.
--       - GRANT select a authenticated: la policy deja ver (a) los fijados propios del autor con membresia vigente y (b) los
--         COMPARTIDOS de la organizacion SOLO cuando su autor es hoy owner/admin de ella (si lo degradan, sus compartidos
--         dejan de verse sin tocar datos). Un usuario de otra organizacion no ve nada (cross-tenant).
--       - GRANT delete a authenticated: policy = solo el autor con membresia vigente.
--       - GRANT update (title, shared) a nivel COLUMNA: lo unico editable es el titulo y la bandera de compartido; la policy
--         exige autor + membresia y, para compartir (shared = true), que el autor sea owner/admin. Tool, args y alcance no
--         son escribibles por el cliente.
--       - SIN grant de insert: los fijados nacen solo en core.copiloto_pin_create (la API deriva tool y args del mensaje
--         guardado del propio autor; el cliente no los envia).
--   * core.copiloto_pin_create: security definer, search_path fijo, revoke de public/anon, grant a authenticated. Autor SIEMPRE
--     auth.uid() (28000 sin actor), exige membresia (42501), vertical tomada de core.organization, conversacion (si se da) del
--     propio autor y de la misma organizacion (P0002 si no, indistinguible de inexistente), tope de 50 fijados por autor y
--     organizacion (54000), argumentos acotados (objeto jsonb plano, 2000 bytes) y nombre de herramienta [a-z0-9_] (22023).
--     Un fijado repetido (misma herramienta y argumentos) devuelve el existente en vez de duplicar.
--   * core.copiloto_pin_author_is_admin: security definer porque la policy necesita saber si el AUTOR es owner/admin y la RLS
--     de core.membership solo deja ver la propia fila. Solo responde true/false y SOLO si quien pregunta es miembro de la
--     organizacion (si no, false): no sirve para enumerar roles de organizaciones ajenas.

-- ---------------------------------------------------------------------------
-- 1) Ruta en la bitacora
-- ---------------------------------------------------------------------------
alter table core.data_chat_query_log
  add column route text check (route is null or route in ('directa', 'cache', 'llm'));

create or replace function core.record_data_chat_query(
  p_organization_id uuid,
  p_tool text,
  p_params jsonb,
  p_outcome text,
  p_row_count integer,
  p_duration_ms integer,
  p_error_code text,
  p_route text
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_vertical text;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'core.record_data_chat_query: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;

  if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_actor) then
    raise exception 'core.record_data_chat_query: el actor % no pertenece a la organizacion %.', v_actor, p_organization_id
      using errcode = '42501';
  end if;

  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;

  insert into core.data_chat_query_log (organization_id, user_id, vertical, tool, params, outcome, row_count, duration_ms, error_code, route)
  values (
    p_organization_id,
    v_actor,
    v_vertical,
    nullif(regexp_replace(lower(left(p_tool, 80)), '[^a-z0-9_]', '_', 'g'), ''),
    case when p_params is not null and jsonb_typeof(p_params) = 'object' then p_params else '{}'::jsonb end,
    p_outcome,
    greatest(coalesce(p_row_count, 0), 0),
    greatest(coalesce(p_duration_ms, 0), 0),
    left(p_error_code, 60),
    case when p_route in ('directa', 'cache', 'llm') then p_route else null end
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text) from public, anon;
grant execute on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text) to authenticated;

comment on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text) is
  'Como la de 7 argumentos (actor = auth.uid(), membership, vertical de core.organization) y ademas registra la ruta: directa, cache o llm.';

-- ---------------------------------------------------------------------------
-- 2) Cache de resultados de herramientas (solo funciones de sistema)
-- ---------------------------------------------------------------------------
create table core.data_chat_cache (
  cache_key text primary key check (char_length(cache_key) between 8 and 200),
  organization_id uuid not null references core.organization(id) on delete cascade,
  value jsonb not null check (pg_column_size(value) <= 65536),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index data_chat_cache_expires_idx on core.data_chat_cache (expires_at);
create index data_chat_cache_org_idx on core.data_chat_cache (organization_id);

alter table core.data_chat_cache enable row level security;
revoke all on core.data_chat_cache from public, anon, authenticated, service_role;

create or replace function core.data_chat_cache_get(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare
  v_value jsonb;
begin
  if auth.uid() is not null then
    raise exception 'core.data_chat_cache_get: solo la sesion de sistema (auth.uid() debe ser NULL).' using errcode = '42501';
  end if;
  select c.value into v_value from core.data_chat_cache c where c.cache_key = p_key and c.expires_at > now();
  return v_value;
end;
$$;

create or replace function core.data_chat_cache_put(p_key text, p_organization_id uuid, p_value jsonb, p_ttl_seconds integer)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 300), 1), 86400);
begin
  if auth.uid() is not null then
    raise exception 'core.data_chat_cache_put: solo la sesion de sistema (auth.uid() debe ser NULL).' using errcode = '42501';
  end if;
  if p_key is null or p_organization_id is null or p_value is null or jsonb_typeof(p_value) <> 'object' or pg_column_size(p_value) > 65536 then
    raise exception 'core.data_chat_cache_put: argumentos invalidos.' using errcode = '22023';
  end if;
  -- Purga oportunista (TTL): acota el crecimiento sin necesitar un cron.
  delete from core.data_chat_cache where ctid in (select ctid from core.data_chat_cache where expires_at <= now() limit 200);
  insert into core.data_chat_cache (cache_key, organization_id, value, created_at, expires_at)
  values (p_key, p_organization_id, p_value, now(), now() + make_interval(secs => v_ttl))
  on conflict (cache_key) do update set value = excluded.value, organization_id = excluded.organization_id, created_at = excluded.created_at, expires_at = excluded.expires_at;
end;
$$;

create or replace function core.data_chat_cache_purge()
returns integer
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'core.data_chat_cache_purge: solo la sesion de sistema (auth.uid() debe ser NULL).' using errcode = '42501';
  end if;
  delete from core.data_chat_cache where expires_at <= now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function core.data_chat_cache_get(text) from public, anon;
revoke all on function core.data_chat_cache_put(text, uuid, jsonb, integer) from public, anon;
revoke all on function core.data_chat_cache_purge() from public, anon;
grant execute on function core.data_chat_cache_get(text) to authenticated;
grant execute on function core.data_chat_cache_put(text, uuid, jsonb, integer) to authenticated;
grant execute on function core.data_chat_cache_purge() to authenticated;

comment on table core.data_chat_cache is
  'Cache de resultados deterministas de herramientas del Copiloto (TTL 5 min / 24 h). RLS sin policies: solo funciones definer de sistema.';

-- ---------------------------------------------------------------------------
-- 3) Fijados (CHAT-15)
-- ---------------------------------------------------------------------------
create table core.copiloto_pin (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  vertical text not null check (vertical in ('restaurantes', 'hoteles', 'rentas', 'despachos', 'licitaciones', 'citas')),
  author_id uuid not null references core.staff_user(id) on delete cascade,
  -- Origen (informativo): la conversacion puede borrarse sin perder el fijado.
  conversation_id uuid references core.data_chat_conversation(id) on delete set null,
  message_seq integer check (message_seq is null or message_seq between 1 and 100),
  block_index integer check (block_index is null or block_index between 0 and 20),
  -- Herramienta del catalogo cerrado y argumentos tipados canonicos (periodo incluido). NUNCA ids de organizacion ni de
  -- sucursal: el alcance se recalcula con la membresia vigente cada vez que se abre el tablero.
  tool text not null check (tool ~ '^[a-z0-9_]{1,80}$'),
  args jsonb not null default '{}'::jsonb check (jsonb_typeof(args) = 'object' and pg_column_size(args) <= 2000),
  title text not null check (char_length(title) between 1 and 80 and btrim(title) <> ''),
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  unique (author_id, organization_id, tool, args)
);

create index copiloto_pin_org_idx on core.copiloto_pin (organization_id, shared, created_at desc);
create index copiloto_pin_author_idx on core.copiloto_pin (author_id, organization_id, created_at desc);

alter table core.copiloto_pin enable row level security;

create or replace function core.copiloto_pin_author_is_admin(p_organization_id uuid, p_author_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select exists (
    select 1 from core.membership me where me.organization_id = p_organization_id and me.user_id = auth.uid()
  ) and exists (
    select 1 from core.membership a
    where a.organization_id = p_organization_id and a.user_id = p_author_id and a.platform_role in ('owner', 'admin')
  );
$$;

revoke all on function core.copiloto_pin_author_is_admin(uuid, uuid) from public, anon;
grant execute on function core.copiloto_pin_author_is_admin(uuid, uuid) to authenticated;

create policy "autor y organizacion leen los fijados del copiloto" on core.copiloto_pin for select
  using (
    exists (select 1 from core.membership m where m.user_id = auth.uid() and m.organization_id = copiloto_pin.organization_id)
    and (
      author_id = auth.uid()
      or (shared and core.copiloto_pin_author_is_admin(copiloto_pin.organization_id, copiloto_pin.author_id))
    )
  );

create policy "autor edita su fijado del copiloto" on core.copiloto_pin for update
  using (
    author_id = auth.uid()
    and exists (select 1 from core.membership m where m.user_id = auth.uid() and m.organization_id = copiloto_pin.organization_id)
  )
  with check (
    author_id = auth.uid()
    and exists (select 1 from core.membership m where m.user_id = auth.uid() and m.organization_id = copiloto_pin.organization_id)
    and (not shared or core.copiloto_pin_author_is_admin(copiloto_pin.organization_id, auth.uid()))
  );

create policy "autor borra su fijado del copiloto" on core.copiloto_pin for delete
  using (
    author_id = auth.uid()
    and exists (select 1 from core.membership m where m.user_id = auth.uid() and m.organization_id = copiloto_pin.organization_id)
  );

revoke all on core.copiloto_pin from public, anon, authenticated, service_role;
grant select, delete on core.copiloto_pin to authenticated;
grant update (title, shared) on core.copiloto_pin to authenticated;

-- Unica via de alta. Errores con SQLSTATE propio:
--   28000 sin actor | 42501 sin membresia | P0002 conversacion ajena/inexistente | 22023 argumentos invalidos |
--   54000 tope de 50 fijados por autor y organizacion.
create or replace function core.copiloto_pin_create(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_seq integer,
  p_block_index integer,
  p_tool text,
  p_args jsonb,
  p_title text
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_vertical text;
  v_title text := left(btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), 80);
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_id uuid;
  v_count integer;
begin
  if v_actor is null then
    raise exception 'core.copiloto_pin_create: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;
  if p_organization_id is null or not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_actor) then
    raise exception 'core.copiloto_pin_create: el actor no pertenece a la organizacion.' using errcode = '42501';
  end if;
  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
  if v_vertical is null or v_vertical not in ('restaurantes', 'hoteles', 'rentas', 'despachos', 'licitaciones', 'citas') then
    raise exception 'core.copiloto_pin_create: vertical no soportada.' using errcode = '22023';
  end if;
  if p_tool is null or p_tool !~ '^[a-z0-9_]{1,80}$' or jsonb_typeof(v_args) <> 'object' or pg_column_size(v_args) > 2000 or v_title = '' then
    raise exception 'core.copiloto_pin_create: argumentos invalidos.' using errcode = '22023';
  end if;
  if p_conversation_id is not null and not exists (
    select 1 from core.data_chat_conversation c
    where c.id = p_conversation_id and c.user_id = v_actor and c.scope = 'vertical' and c.organization_id = p_organization_id
  ) then
    raise exception 'core.copiloto_pin_create: la conversacion no existe.' using errcode = 'P0002';
  end if;

  -- Serializa las altas del mismo autor para que el tope no se rebase por carreras.
  perform pg_advisory_xact_lock(hashtextextended('copiloto_pin:' || v_actor::text || ':' || p_organization_id::text, 0));

  select p.id into v_id from core.copiloto_pin p
  where p.author_id = v_actor and p.organization_id = p_organization_id and p.tool = p_tool and p.args = v_args;
  if v_id is not null then
    return v_id;
  end if;

  select count(*) into v_count from core.copiloto_pin p where p.author_id = v_actor and p.organization_id = p_organization_id;
  if v_count >= 50 then
    raise exception 'core.copiloto_pin_create: limite_fijados (50).' using errcode = '54000';
  end if;

  insert into core.copiloto_pin (organization_id, vertical, author_id, conversation_id, message_seq, block_index, tool, args, title)
  values (p_organization_id, v_vertical, v_actor, p_conversation_id, p_message_seq, p_block_index, p_tool, v_args, v_title)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function core.copiloto_pin_create(uuid, uuid, integer, integer, text, jsonb, text) from public, anon;
grant execute on function core.copiloto_pin_create(uuid, uuid, integer, integer, text, jsonb, text) to authenticated;

comment on table core.copiloto_pin is
  'Resultados del Copiloto fijados en el tablero: herramienta + argumentos canonicos (sin alcance). El autor ve los suyos; los compartidos los ve la organizacion solo si el autor es owner/admin.';
comment on function core.copiloto_pin_create(uuid, uuid, integer, integer, text, jsonb, text) is
  'Unica via de alta de fijados: actor = auth.uid(), membresia, conversacion propia, tope de 50, deduplica por herramienta + argumentos.';
