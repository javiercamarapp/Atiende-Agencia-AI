-- ---------------------------------------------------------------------------
-- Rentas 037 (paridad3, Rn-13 / Rn-P3-23): URL de exportacion iCal con token opaco y rotable, y
-- "Sincronizar ahora" con el lease existente.
--
-- Contexto. El feed publico de exportacion (GET /rentas/:propertyId/unidades/:unidadId/canales/
-- :canalCodigo/feed.ics) se identifica solo por UUIDs: la URL no se puede rotar y su limite por IP
-- (30 consultas cada 5 min) puede dejar sin respuesta a una OTA que consulta desde rangos de IP
-- compartidos, con riesgo de que la noche no se cierre. Esta migracion agrega:
--   1. rentas.feed_export_token: un token por (unidad, canal), guardado SOLO como hash SHA-256; el
--      valor en claro se muestra una vez al crearlo o rotarlo y nunca se guarda.
--   2. rentas.rotar_feed_export_token (staff): revoca el token vigente y crea uno nuevo, en una
--      sola operacion atomica.
--   3. rentas.resolver_feed_export_token (solo sistema): resuelve un hash a (unidad, canal) y
--      registra el ultimo acceso.
--   4. rentas.claim_ical_feed_manual (solo sistema): reclama UN feed concreto con el lease de 024
--      para "Sincronizar ahora".
--
-- Es aditiva: el codigo TypeScript que la usa cae a la URL por UUID y a un "aun no disponible"
-- honesto si la base todavia no la tiene (SQLSTATE 42883 / 42P01 / 42703). Requiere 001, 008 y 024.
--
-- Seguridad (cada tabla, policy, GRANT y funcion lleva su justificacion):
--   * Tabla: RLS habilitada. Unica policy: SELECT para staff con acceso a la property
--     (core.has_property_access, la misma autoridad que el resto de rentas.*). NO hay policy de
--     INSERT, UPDATE ni DELETE para authenticated: el token solo cambia por las funciones de abajo.
--   * GRANT: SELECT por COLUMNA a authenticated, SIN token_hash. El hash no es reversible, pero
--     tampoco hace falta que lo lea ningun staff: la pantalla solo necesita saber si hay token
--     vigente, cuando se creo y cuando lo consulto la OTA. anon no recibe nada. service_role
--     conserva todo (mismo criterio que 008/024).
--   * rotar_feed_export_token: security definer porque authenticated no puede escribir la tabla.
--     Exige auth.uid() no nulo, que el staff tenga acceso a la property de la unidad y un
--     vertical_role de escritura de calendario (admin_gestora, operador:acceso_total o
--     operador:calendario_mensajeria; el mismo conjunto que SYNC_CALENDARIO_ESCRITURA_ROLES), de modo
--     que un rol de solo lectura no rote la URL llamando la funcion directo. organization_id y
--     property_id se derivan SIEMPRE de la unidad, nunca de parametros (no se puede escribir una fila
--     con el tenant de otra organizacion). search_path fijo; EXECUTE revocado a public.
--   * resolver_feed_export_token: security definer porque lee y actualiza una tabla que el rol de la
--     sesion de sistema no ve. Exige auth.uid() is null (la sesion de sistema de la ruta publica; un
--     staff autenticado recibe 42501). Solo resuelve tokens NO revocados y solo devuelve ids, nunca
--     datos de huesped. search_path fijo; EXECUTE revocado a public.
--   * claim_ical_feed_manual: security definer porque las columnas de lease no son escribibles por
--     authenticated (024). Exige auth.uid() is null: la ruta de staff valida rol y membresia con la
--     sesion del usuario y luego reclama en una sesion de sistema aparte, igual que el cron. Ignora el
--     backoff y el piso de espaciamiento (el usuario pidio sincronizar ahora) pero NUNCA el lease
--     vigente: si otro proceso tiene el feed, no lo entrega. search_path fijo; EXECUTE revocado a public.
-- ---------------------------------------------------------------------------

create table rentas.feed_export_token (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  -- SHA-256 hexadecimal del token en claro. El token en claro (43 caracteres base64url, 256 bits)
  -- nunca se guarda ni se registra.
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  creado_en timestamptz not null default now(),
  creado_por uuid references core.staff_user(id) on delete set null,
  revocado_en timestamptz,
  -- Ultima vez que una OTA (o cualquiera con la URL) consulto el feed por este token.
  ultimo_acceso_en timestamptz,
  constraint feed_export_token_hash_unico unique (token_hash),
  constraint feed_export_token_revocacion_coherente check (revocado_en is null or revocado_en >= creado_en)
);
-- A lo mas un token vigente por (unidad, canal): rotar revoca el anterior.
create unique index feed_export_token_vigente_uniq on rentas.feed_export_token (unidad_id, canal_id) where revocado_en is null;
create index feed_export_token_property_idx on rentas.feed_export_token (property_id);

alter table rentas.feed_export_token enable row level security;

create policy "staff ve los tokens de feed de su property" on rentas.feed_export_token for select
  using (core.has_property_access(auth.uid(), property_id));

revoke all on rentas.feed_export_token from public, anon, authenticated;
grant select (id, organization_id, property_id, unidad_id, canal_id, creado_en, creado_por, revocado_en, ultimo_acceso_en)
  on rentas.feed_export_token to authenticated;
grant select, insert, update, delete on rentas.feed_export_token to service_role;

-- ---------------------------------------------------------------------------
-- Rotar (o crear) el token de exportacion de una (unidad, canal). Staff.
-- ---------------------------------------------------------------------------
create function rentas.rotar_feed_export_token(p_unidad_id uuid, p_canal_id uuid, p_token_hash text)
returns table (token_id uuid, creado_en timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
  v_property uuid;
  v_id uuid;
  v_creado timestamptz;
begin
  if auth.uid() is null then
    raise exception 'rentas.rotar_feed_export_token: requiere un usuario autenticado.' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'rentas.rotar_feed_export_token: hash de token invalido.' using errcode = '22023';
  end if;

  select u.organization_id, u.property_id into v_org, v_property from rentas.unidad u where u.id = p_unidad_id;
  -- Misma respuesta para "no existe" y "no es de tu property": no revela unidades de otro tenant.
  if v_property is null or not core.has_property_access(auth.uid(), v_property) then
    raise exception 'rentas.rotar_feed_export_token: sin acceso a la unidad.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid()
      and m.organization_id = v_org
      and m.vertical_role in ('admin_gestora', 'operador:acceso_total', 'operador:calendario_mensajeria')
  ) then
    raise exception 'rentas.rotar_feed_export_token: tu rol no puede rotar la URL de exportacion.' using errcode = '42501';
  end if;
  if not exists (select 1 from rentas.canal c where c.id = p_canal_id) then
    raise exception 'rentas.rotar_feed_export_token: canal desconocido.' using errcode = 'P0002';
  end if;

  -- Serializa rotaciones concurrentes de la misma (unidad, canal): sin esto, dos rotaciones a la vez
  -- chocarian con el indice unico parcial en vez de quedar una despues de la otra.
  perform pg_advisory_xact_lock(hashtextextended('rentas.feed_export_token:' || p_unidad_id::text || ':' || p_canal_id::text, 0));

  update rentas.feed_export_token t
  set revocado_en = now()
  where t.unidad_id = p_unidad_id and t.canal_id = p_canal_id and t.revocado_en is null;

  insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash, creado_por)
  values (v_org, v_property, p_unidad_id, p_canal_id, p_token_hash, auth.uid())
  returning id, rentas.feed_export_token.creado_en into v_id, v_creado;

  return query select v_id, v_creado;
end;
$$;

revoke all on function rentas.rotar_feed_export_token(uuid, uuid, text) from public;
grant execute on function rentas.rotar_feed_export_token(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Resolver un token (por su hash) para la ruta publica del feed. Solo sistema.
-- ---------------------------------------------------------------------------
create function rentas.resolver_feed_export_token(p_token_hash text)
returns table (token_id uuid, token_hash text, organization_id uuid, property_id uuid, unidad_id uuid, canal_id uuid, canal_codigo text)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'rentas.resolver_feed_export_token: solo la sesion de sistema (auth.uid() es NULL) resuelve tokens de feed.' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select t.id into v_id from rentas.feed_export_token t where t.token_hash = p_token_hash and t.revocado_en is null;
  if v_id is null then
    return;
  end if;

  -- Ultimo acceso, a lo mas una escritura por minuto y token (una OTA que consulta cada pocos
  -- segundos no genera una escritura por consulta).
  update rentas.feed_export_token t
  set ultimo_acceso_en = now()
  where t.id = v_id and (t.ultimo_acceso_en is null or t.ultimo_acceso_en < now() - interval '1 minute');

  return query
  select t.id, t.token_hash, t.organization_id, t.property_id, t.unidad_id, t.canal_id, c.codigo
  from rentas.feed_export_token t
  join rentas.canal c on c.id = t.canal_id
  where t.id = v_id;
end;
$$;

revoke all on function rentas.resolver_feed_export_token(text) from public;
grant execute on function rentas.resolver_feed_export_token(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reclamar UN feed concreto para "Sincronizar ahora". Solo sistema.
-- ---------------------------------------------------------------------------
-- Devuelve el token del lease, o ninguna fila si el feed no existe, esta inactivo o ya tiene un lease
-- vigente (otro proceso lo esta sincronizando). Ignora proximo_intento_en (backoff) y el piso de
-- espaciamiento a proposito: el usuario pidio reintentar ya; el limite de 1 por minuto por feed lo
-- pone la ruta. Se libera con rentas.liberar_ical_feed (024), que ademas fija el backoff si falla.
create function rentas.claim_ical_feed_manual(p_feed_id uuid, p_lease_segundos integer default 120)
returns table (feed_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_lease integer := least(greatest(coalesce(p_lease_segundos, 120), 30), 900);
begin
  if auth.uid() is not null then
    raise exception 'rentas.claim_ical_feed_manual: solo la sesion de sistema (auth.uid() es NULL) puede reclamar un feed.' using errcode = '42501';
  end if;

  return query
  with candidato as (
    select f.id
    from rentas.canal_feed_externo f
    where f.id = p_feed_id
      and f.activo
      and (f.lease_hasta is null or f.lease_hasta <= now())
    for update skip locked
  ), reclamado as (
    update rentas.canal_feed_externo f
    set lease_hasta = now() + make_interval(secs => v_lease),
        lease_token = gen_random_uuid(),
        ultimo_intento_en = now()
    from candidato c
    where f.id = c.id
    returning f.id, f.lease_token
  )
  select r.id, r.lease_token from reclamado r;
end;
$$;

revoke all on function rentas.claim_ical_feed_manual(uuid, integer) from public;
grant execute on function rentas.claim_ical_feed_manual(uuid, integer) to authenticated, service_role;
