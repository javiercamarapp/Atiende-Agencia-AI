-- 054 (restaurantes, Los Taquitos de PM): cartera de clientes por nivel + importacion de cartera + alerta de
-- comandas de SoftRestaurant que esperan captura manual. Interno 054, prefijo de supabase/migrations 20240101000327.
--
-- Piezas (todas ADITIVAS: no se cambia ni se elimina ninguna firma, columna ni policy existente):
--   A) restaurantes.customer_tiers(org): nivel (BLACK/PLATINUM/GOLD/BLUE) de TODOS los clientes de una organizacion
--      en una sola pasada. Misma formula que restaurantes.calc_customer_tier (002, cortes 95/90/70): el verify
--      compara ambas para cada cliente.
--   B) restaurantes.clientes_cartera(...): lista filtrada de clientes (nivel, frecuencia, dias sin pedir, sucursal,
--      busqueda) con paginacion por cursor de id, resuelta en el servidor.
--   C) restaurantes.cartera_kpis(org): total, recurrentes, ticket promedio y cliente mas frecuente.
--   D) restaurantes.customers.notes (columna nueva, nullable, <= 500) + restaurantes.customer_imports (huella por
--      archivo) + restaurantes.importar_clientes(org, huella, renglones): importacion de cartera (tope 5,000
--      renglones), upsert por (organizacion, telefono) que NO pisa el nombre ni la nota conocidos, SIN crear pedidos
--      y SIN mandar mensajes. Idempotente por huella del archivo.
--   E) restaurantes.pos_comanda_alerta_config + restaurantes.set_umbral_captura_manual(...) +
--      restaurantes.pos_comandas_captura_manual_vencidas(...): umbral por sucursal (default 5 min, la constante vive
--      en pos_comandas_captura_manual_vencidas) y candidatos de la alerta "comanda esperando captura manual" (solo sistema). La emision es
--      core.emit_notification desde TypeScript (evento restaurantes.comanda.captura_manual_vencida).
--
-- Compatibilidad con la base sin migrar: todo el TypeScript que llama a estas funciones/columnas captura SQLSTATE
-- 42883/42P01/42703 dentro de un SAVEPOINT (runWithSavepointFallback) y degrada al listado anterior o a "no disponible
-- aun". No se programa ningun cron (la alerta corre dentro del tick existente softrestaurant-dispatch).
--
-- JUSTIFICACION DE SEGURIDAD (cada funcion, tabla, policy y GRANT):
--   * customer_tiers / clientes_cartera / cartera_kpis: SECURITY INVOKER (el default), search_path fijo. Se ejecutan con
--     los privilegios del llamador, asi la RLS existente ("staff ve clientes de su organizacion" y la de pedidos)
--     sigue siendo la barrera: pasar el id de OTRA organizacion devuelve cero filas, nunca datos ajenos. GRANT EXECUTE
--     solo a authenticated; REVOKE de public/anon. No escriben nada. La ruta de la API exige ademas MANAGER_ROLES.
--   * customers.notes: columna nueva sin GRANT adicional (el SELECT de tabla ya cubre a staff por la policy existente;
--     anon no tiene acceso a la tabla). Texto acotado a 500 caracteres por CHECK.
--   * customer_imports: RLS habilitada, REVOKE ALL a public/anon/authenticated/service_role, GRANT SELECT A NIVEL
--     COLUMNA (sin created_by: id de staff) a authenticated y policy de SELECT por membresia owner/admin/staff de la
--     organizacion de la fila. SIN INSERT/UPDATE/DELETE para nadie: la unica escritura es importar_clientes.
--   * importar_clientes: SECURITY DEFINER con search_path fijo y REVOKE de public/anon. Exige auth.uid() (la sesion de
--     sistema recibe 42501), rol owner/admin/staff de ESA organizacion (repartidor y miembros de otra organizacion
--     reciben 42501: cross-tenant) y acota la entrada: arreglo de 1 a 5,000 renglones, huella sha-256 hex, telefono de
--     10 digitos (el resto se cuenta como rechazado), textos recortados. Escribe SOLO customers y customer_addresses de la
--     organizacion indicada; nunca toca pedidos ni mensajeria. DEFINER es necesario porque authenticated no tiene
--     INSERT sobre customers/customer_addresses (001: solo SELECT) y la importacion es una accion de staff.
--   * pos_comanda_alerta_config: RLS habilitada, REVOKE ALL a public/anon, GRANT SELECT a authenticated con policy por
--     membresia en la organizacion de la fila; sin escritura directa.
--   * set_umbral_captura_manual: SECURITY DEFINER, search_path fijo, REVOKE de public/anon. Exige owner/admin de la
--     organizacion DUENA de la sucursal (derivada de core.property, nunca del llamador); acota 1..240 minutos.
--   * pos_comandas_captura_manual_vencidas: SECURITY DEFINER, search_path fijo, REVOKE de public/anon, GRANT a
--     authenticated SOLO por consistencia con las demas funciones de sistema; la guarda interna `auth.uid() is null`
--     rechaza con 42501 a cualquier usuario. Solo lee, tope de 200 filas, y NO devuelve PII (ids y minutos).
--
-- Requiere: 001 (customers, customer_addresses, orders), 024 (pos_comanda_outbox).

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Nivel de todos los clientes de una organizacion (misma formula que calc_customer_tier, 002)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function restaurantes.customer_tiers(p_organization_id uuid)
returns table (customer_id uuid, tier text, percentile numeric)
language sql
stable
security invoker
set search_path = restaurantes, pg_temp
as $$
  with clientes as (
    select c.id, c.order_count, coalesce(g.gasto, 0) as gasto
    from restaurantes.customers c
    left join (
      select o.customer_id, sum(o.total) as gasto
      from restaurantes.orders o
      where o.organization_id = p_organization_id and o.customer_id is not null
      group by o.customer_id
    ) g on g.customer_id = c.id
    where c.organization_id = p_organization_id
  ),
  meta as (
    select
      count(*) as n,
      count(*) filter (where gasto > 0) as con_gasto,
      count(*) filter (where order_count > 0) as con_frecuencia
    from clientes
  ),
  metrica as (
    select case
      when (select n from meta) = 0 then 'sin_datos'
      when (select con_gasto from meta) >= greatest(1, ceil((select n from meta)::numeric * 0.3)) then 'gasto'
      when (select con_frecuencia from meta) > 0 then 'frecuencia'
      else 'sin_datos'
    end as elegida
  ),
  valores as (
    select id,
      case (select elegida from metrica)
        when 'gasto' then gasto
        when 'frecuencia' then order_count::numeric
        else 0::numeric
      end as valor
    from clientes
  ),
  ranked as (
    select id,
      (rank() over (order by valor asc) - 1) as rank_min,
      count(*) over (partition by valor) as tie_count,
      count(*) over () as n
    from valores
  ),
  percentiles as (
    select id,
      case
        when n = 1 then 100::numeric
        else (((rank_min::numeric + rank_min + tie_count - 1) / 2.0) / (n - 1)) * 100
      end as percentil
    from ranked
  )
  select p.id as customer_id,
    case
      when (select elegida from metrica) = 'sin_datos' then null
      when p.percentil >= 95 then 'BLACK'
      when p.percentil >= 90 then 'PLATINUM'
      when p.percentil >= 70 then 'GOLD'
      else 'BLUE'
    end as tier,
    case when (select elegida from metrica) = 'sin_datos' then null else round(p.percentil, 2) end as percentile
  from percentiles p;
$$;

revoke all on function restaurantes.customer_tiers(uuid) from public, anon;
grant execute on function restaurantes.customer_tiers(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Lista filtrada de la cartera
--    p_nivel: BLACK|PLATINUM|GOLD|BLUE. p_frecuencia: 'una_vez' (1 pedido) | 'recurrentes' (>= 2).
--    p_inactivo_dias: sin pedir en N dias (quien nunca ha pedido cuenta como "sin pedir").
--    p_property_id: clientes que han pedido en esa sucursal.
--    Orden y paginacion: por id (cursor = ultimo id), igual que el listado anterior.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function restaurantes.clientes_cartera(
  p_organization_id uuid,
  p_nivel text default null,
  p_frecuencia text default null,
  p_inactivo_dias integer default null,
  p_property_id uuid default null,
  p_search text default null,
  p_limit integer default 50,
  p_cursor uuid default null
)
returns table (customer_id uuid, phone text, name text, order_count integer, last_order_at timestamptz, tier text)
language plpgsql
stable
security invoker
set search_path = restaurantes, pg_temp
as $$
#variable_conflict use_column
begin
  if p_nivel is not null and p_nivel not in ('BLACK', 'PLATINUM', 'GOLD', 'BLUE') then
    raise exception 'clientes_cartera: nivel invalido' using errcode = '22023';
  end if;
  if p_frecuencia is not null and p_frecuencia not in ('una_vez', 'recurrentes') then
    raise exception 'clientes_cartera: frecuencia invalida' using errcode = '22023';
  end if;
  if p_inactivo_dias is not null and (p_inactivo_dias < 1 or p_inactivo_dias > 3650) then
    raise exception 'clientes_cartera: dias sin pedir fuera de rango' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'clientes_cartera: limite invalido' using errcode = '22023';
  end if;

  return query
    select c.id, c.phone, c.name, c.order_count, c.last_order_at, t.tier
    from restaurantes.customers c
    left join restaurantes.customer_tiers(p_organization_id) t on t.customer_id = c.id
    where c.organization_id = p_organization_id
      and (p_nivel is null or t.tier = p_nivel)
      and (p_frecuencia is null
           or (p_frecuencia = 'una_vez' and c.order_count = 1)
           or (p_frecuencia = 'recurrentes' and c.order_count >= 2))
      and (p_inactivo_dias is null
           or c.last_order_at is null
           or c.last_order_at < now() - make_interval(days => p_inactivo_dias))
      and (p_property_id is null
           or exists (select 1 from restaurantes.orders o where o.customer_id = c.id and o.property_id = p_property_id))
      and (p_search is null or p_search = ''
           or c.name ilike '%' || p_search || '%' or c.phone ilike '%' || p_search || '%')
      and (p_cursor is null or c.id > p_cursor)
    order by c.id asc
    limit p_limit;
end;
$$;

revoke all on function restaurantes.clientes_cartera(uuid, text, text, integer, uuid, text, integer, uuid) from public, anon;
grant execute on function restaurantes.clientes_cartera(uuid, text, text, integer, uuid, text, integer, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) KPIs de cartera (una fila). Ticket promedio = promedio del total de los pedidos vigentes (mismos estados
--    que "lo de siempre": pending, preparando, en_camino, entregado, completado) con cliente conocido.
--    Cliente mas frecuente = mayor order_count (desempate: pedido mas reciente, luego id).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function restaurantes.cartera_kpis(p_organization_id uuid)
returns table (
  total bigint,
  recurrentes bigint,
  ticket_promedio numeric,
  top_customer_id uuid,
  top_order_count integer,
  top_last_order_at timestamptz
)
language sql
stable
security invoker
set search_path = restaurantes, pg_temp
as $$
  select
    (select count(*) from restaurantes.customers c where c.organization_id = p_organization_id),
    (select count(*) from restaurantes.customers c where c.organization_id = p_organization_id and c.order_count >= 2),
    (select round(avg(o.total), 2) from restaurantes.orders o
       where o.organization_id = p_organization_id and o.customer_id is not null
         and o.status in ('pending', 'preparando', 'en_camino', 'entregado', 'completado')),
    t.id, t.order_count, t.last_order_at
  from (select 1) base
  left join lateral (
    select c.id, c.order_count, c.last_order_at
    from restaurantes.customers c
    where c.organization_id = p_organization_id and c.order_count > 0
    order by c.order_count desc, c.last_order_at desc nulls last, c.id asc
    limit 1
  ) t on true;
$$;

revoke all on function restaurantes.cartera_kpis(uuid) from public, anon;
grant execute on function restaurantes.cartera_kpis(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Importacion de cartera
-- ═══════════════════════════════════════════════════════════════════════════
alter table restaurantes.customers add column if not exists notes text;
alter table restaurantes.customers drop constraint if exists customers_notes_len_check;
alter table restaurantes.customers add constraint customers_notes_len_check check (notes is null or char_length(notes) <= 500);

create table if not exists restaurantes.customer_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references core.staff_user(id) on delete set null,
  total integer not null check (total between 1 and 5000),
  creados integer not null default 0,
  actualizados integer not null default 0,
  sin_cambios integer not null default 0,
  rechazados integer not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, file_hash)
);

alter table restaurantes.customer_imports enable row level security;
revoke all on restaurantes.customer_imports from public, anon, authenticated, service_role;
grant select (id, organization_id, file_hash, total, creados, actualizados, sin_cambios, rechazados, created_at)
  on restaurantes.customer_imports to authenticated;

drop policy if exists "staff ve las importaciones de clientes de su organizacion" on restaurantes.customer_imports;
create policy "staff ve las importaciones de clientes de su organizacion" on restaurantes.customer_imports
  for select to authenticated
  using (exists (
    select 1 from core.membership m
    where m.organization_id = customer_imports.organization_id and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin', 'staff')
  ));

create or replace function restaurantes.importar_clientes(p_organization_id uuid, p_file_hash text, p_rows jsonb)
returns table (ya_importado boolean, total integer, creados integer, actualizados integer, sin_cambios integer, rechazados integer)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_import uuid;
  v_total integer;
  v_creados integer := 0;
  v_actualizados integer := 0;
  v_sin_cambios integer := 0;
  v_rechazados integer := 0;
  e jsonb;
  v_phone text;
  v_name text;
  v_address text;
  v_notes text;
  v_id uuid;
  v_nuevo boolean;
begin
  if v_uid is null then
    raise exception 'importar_clientes: requiere un usuario autenticado' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_uid and m.vertical_role in ('owner', 'admin', 'staff')
  ) then
    raise exception 'importar_clientes: rol sin permiso en la organizacion' using errcode = '42501';
  end if;
  if p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'importar_clientes: huella invalida' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'importar_clientes: se esperaba un arreglo de renglones' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > 5000 then
    raise exception 'importar_clientes: entre 1 y 5000 renglones' using errcode = '22023';
  end if;

  -- Reclama la huella: el mismo archivo dos veces (o dos peticiones simultaneas) no duplica ni vuelve a escribir.
  insert into restaurantes.customer_imports (organization_id, file_hash, created_by, total)
  values (p_organization_id, p_file_hash, v_uid, v_total)
  on conflict (organization_id, file_hash) do nothing
  returning id into v_import;
  if v_import is null then
    return query
      select true, i.total, i.creados, i.actualizados, i.sin_cambios, i.rechazados
      from restaurantes.customer_imports i
      where i.organization_id = p_organization_id and i.file_hash = p_file_hash;
    return;
  end if;

  for e in select x from jsonb_array_elements(p_rows) x loop
    if jsonb_typeof(e) <> 'object' then
      v_rechazados := v_rechazados + 1;
      continue;
    end if;
    v_phone := e->>'phone';
    if v_phone is null or v_phone !~ '^[0-9]{10}$' then
      v_rechazados := v_rechazados + 1;
      continue;
    end if;
    v_name := nullif(btrim(left(coalesce(e->>'name', ''), 120)), '');
    v_address := nullif(btrim(left(coalesce(e->>'address', ''), 300)), '');
    v_notes := nullif(btrim(left(coalesce(e->>'notes', ''), 500)), '');

    -- Nunca pisa el nombre ni la nota que ya se conocen; solo completa lo que estaba vacio.
    v_id := null;
    insert into restaurantes.customers (organization_id, phone, name, notes)
    values (p_organization_id, v_phone, v_name, v_notes)
    on conflict (organization_id, phone) do update
      set name = coalesce(restaurantes.customers.name, excluded.name),
          notes = coalesce(restaurantes.customers.notes, excluded.notes),
          updated_at = now()
      where (restaurantes.customers.name is null and excluded.name is not null)
         or (restaurantes.customers.notes is null and excluded.notes is not null)
    returning id, (xmax = 0) into v_id, v_nuevo;
    if v_id is null then
      select c.id into v_id from restaurantes.customers c where c.organization_id = p_organization_id and c.phone = v_phone;
      v_nuevo := false;
      v_sin_cambios := v_sin_cambios + 1;
    elsif v_nuevo then
      v_creados := v_creados + 1;
    else
      v_actualizados := v_actualizados + 1;
    end if;

    if v_address is not null then
      insert into restaurantes.customer_addresses (customer_id, address, is_default)
      values (v_id, v_address, not exists (select 1 from restaurantes.customer_addresses a where a.customer_id = v_id))
      on conflict (customer_id, address) do nothing;
    end if;
  end loop;

  update restaurantes.customer_imports
  set creados = v_creados, actualizados = v_actualizados, sin_cambios = v_sin_cambios, rechazados = v_rechazados
  where id = v_import;

  return query select false, v_total, v_creados, v_actualizados, v_sin_cambios, v_rechazados;
end;
$$;

revoke all on function restaurantes.importar_clientes(uuid, text, jsonb) from public, anon;
grant execute on function restaurantes.importar_clientes(uuid, text, jsonb) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Alerta de comandas esperando captura manual
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists restaurantes.pos_comanda_alerta_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  captura_manual_min integer not null check (captura_manual_min between 1 and 240),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table restaurantes.pos_comanda_alerta_config enable row level security;
revoke all on restaurantes.pos_comanda_alerta_config from public, anon;
grant select on restaurantes.pos_comanda_alerta_config to authenticated;

drop policy if exists "staff ve el umbral de captura manual de su organizacion" on restaurantes.pos_comanda_alerta_config;
create policy "staff ve el umbral de captura manual de su organizacion" on restaurantes.pos_comanda_alerta_config
  for select to authenticated
  using (exists (
    select 1 from core.membership m
    where m.organization_id = pos_comanda_alerta_config.organization_id and m.user_id = auth.uid()
  ));

create or replace function restaurantes.set_umbral_captura_manual(p_property_id uuid, p_minutos integer)
returns void
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'set_umbral_captura_manual: requiere un usuario autenticado' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'restaurantes';
  if v_org is null or not exists (
    select 1 from core.membership m where m.organization_id = v_org and m.user_id = v_uid and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'set_umbral_captura_manual: requiere owner/admin de la organizacion de la sucursal' using errcode = '42501';
  end if;
  if p_minutos is null or p_minutos < 1 or p_minutos > 240 then
    raise exception 'set_umbral_captura_manual: los minutos deben estar entre 1 y 240' using errcode = '22023';
  end if;

  insert into restaurantes.pos_comanda_alerta_config (property_id, organization_id, captura_manual_min, updated_at, updated_by)
  values (p_property_id, v_org, p_minutos, now(), v_uid)
  on conflict (property_id) do update
    set captura_manual_min = excluded.captura_manual_min, updated_at = now(), updated_by = v_uid;
end;
$$;

revoke all on function restaurantes.set_umbral_captura_manual(uuid, integer) from public, anon;
grant execute on function restaurantes.set_umbral_captura_manual(uuid, integer) to authenticated;

-- F) Candidatos (solo sistema). Una comanda en 'captura_manual' desde hace mas que el umbral de su sucursal
--    (sin fila de configuracion = 5 minutos). `actualizado_en` es el momento en que entro a ese estado: cualquier
--    otra transicion (capturada a mano, reenviada) la saca de la lista.
create or replace function restaurantes.pos_comandas_captura_manual_vencidas(p_now timestamptz default null)
returns table (comanda_id uuid, order_id uuid, organization_id uuid, property_id uuid, minutos integer)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_ahora timestamptz := coalesce(p_now, now());
begin
  if auth.uid() is not null then
    raise exception 'pos_comandas_captura_manual_vencidas es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select x.id, x.order_id, x.organization_id, x.property_id,
           greatest(0, floor(extract(epoch from (v_ahora - x.actualizado_en)) / 60))::integer
    from restaurantes.pos_comanda_outbox x
    left join restaurantes.pos_comanda_alerta_config c on c.property_id = x.property_id
    where x.estado = 'captura_manual'
      and x.actualizado_en <= v_ahora - make_interval(mins => coalesce(c.captura_manual_min, 5))
    order by x.actualizado_en asc
    limit 200;
end;
$$;

revoke all on function restaurantes.pos_comandas_captura_manual_vencidas(timestamptz) from public, anon;
grant execute on function restaurantes.pos_comandas_captura_manual_vencidas(timestamptz) to authenticated;
