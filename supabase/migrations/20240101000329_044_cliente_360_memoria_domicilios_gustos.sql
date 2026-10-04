-- Cliente 360 (restaurantes): memoria del cliente de punta a punta. Identificar por telefono en WhatsApp/voz/web,
-- recordar VARIOS domicilios con etiqueta y referencias, aprender gustos de pedidos CONFIRMADOS, repetir pedidos
-- anteriores y dar al staff una ficha completa, con la reincidencia de "no recogido" / pedido falso.
-- Prefijo de supabase/migrations asignado para esta tarea: 20240101000329 (interno 044).
--
-- CAUSA RAIZ QUE ESTA MIGRACION CIERRA (defensa en profundidad, disponibilidad): el motor de produccion abre toda sesion
-- con `set local role authenticated` y `auth.uid()` NULL para los canales publicos (WhatsApp, voz, checkout web). Las
-- policies de SELECT de `customers`, `customer_addresses` y `orders` (001) exigen `auth.uid()` con membresia, asi que la
-- sesion de sistema NO ve ninguna fila: `lookupCustomer` devolvia "cliente nuevo" siempre. La lectura de la memoria del
-- cliente pasa ahora por UNA funcion `security definer` solo-sistema, acotada por (organizacion, telefono), y la escritura
-- de su aprendizaje por otra. Ninguna tabla recibe GRANT nuevo para el rol de la API.
--
-- Piezas:
--   1. customer_addresses: columnas aditivas (referencias de acceso, link de Maps, colonia, sucursal, ultimo uso).
--   2. customers: fecha de nacimiento opcional (dia y mes) y notas del staff.
--   3. orders: marca de "pedido falso" puesta por el staff.
--   4. customer_preferences: gustos aprendidos (con fuente, conteo y fecha) o puestos por el staff.
--   5. customer_pedido_cierre: una fila por pedido ya aplicado a la ficha (idempotencia del cierre del ciclo).
--   6. cliente_politica: umbral configurable de reincidencia (por omision 2 en 90 dias; 0 = apagado).
--   7. Funciones de SISTEMA: cliente_memoria (lectura) y cliente_registrar_pedido (cierre del ciclo, idempotente).
--   8. Funciones de STAFF: cliente_ficha, cliente_actualizar, cliente_direccion_guardar/borrar,
--      cliente_preferencia_accion, cliente_marcar_pedido_falso, cliente_exportar_arco, cliente_borrar_memoria,
--      cliente_politica_leer/guardar.
--
-- COMPATIBILIDAD: solo se AGREGAN columnas, tablas y funciones; nada se elimina. El TypeScript llama las funciones dentro
-- de un SAVEPOINT (`runWithSavepointFallback`) y, contra una base sin esta migracion (SQLSTATE 42883/42P01/42703), cae
-- al camino anterior o a un vacio honesto ("no disponible aun"); nada de esto se aplica al mergear.
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, policy y funcion):
--  * Columnas nuevas (1-3): informativas, con CHECK de longitud/formato. No se agrega GRANT ni policy: heredan los GRANT y
--    las policies de su tabla (solo SELECT para `authenticated` bajo RLS; `anon` sin acceso). La unica escritura de las
--    columnas nuevas es por las funciones de abajo.
--  * customer_preferences y customer_pedido_cierre: RLS activo; policy de SELECT solo para owner/admin/staff de la
--    organizacion (nunca `using (true)`); `revoke all` de public/anon/authenticated y SOLO `grant select` por columna a
--    `authenticated` en preferencias (los datos de cliente son PII: el cierre no se concede a nadie). Sin policy ni GRANT
--    de escritura: toda escritura pasa por funciones `security definer`.
--  * cliente_politica: RLS, SELECT solo owner/admin/staff; escritura solo por `cliente_politica_guardar` (owner/admin).
--  * Todas las funciones son `security definer` con `set search_path = restaurantes, core, pg_temp` fijo, `revoke all ...
--    from public, anon` y `grant execute ... to authenticated` (el motor entra con ese rol). `anon` nunca recibe EXECUTE.
--  * Funciones de SISTEMA (cliente_memoria, cliente_registrar_pedido): exigen `auth.uid() is null`; un usuario autenticado
--    que las llame recibe 42501. Solo operan sobre la organizacion recibida (y exigen que sea del vertical restaurantes);
--    cliente_registrar_pedido ademas exige que el pedido sea de ESA organizacion y tenga cliente (cross-tenant -> 42501).
--    No devuelven filas de otra organizacion y el telefono es la unica llave de busqueda (nunca un id de cliente ajeno).
--  * Funciones de STAFF: exigen `auth.uid()` no nulo y membresia de la organizacion con vertical_role owner/admin/staff
--    (si no, 42501); el cliente/pedido/direccion/gusto se resuelve SIEMPRE dentro de la organizacion indicada, asi que un
--    staff de otra organizacion no puede leer ni escribir por id. La politica solo la cambia owner/admin.
--  * Minimizacion: los gustos solo guardan categoria + valor corto (<= 120 caracteres) y su fuente; el cierre del ciclo
--    cuenta pedidos confirmados, no suposiciones del modelo. cliente_exportar_arco entrega TODO lo que se guarda del
--    titular (incluidos los gustos) y cliente_borrar_memoria elimina domicilios, gustos, notas y fecha de nacimiento.

-- ---------------------------------------------------------------------------
-- 1) customer_addresses: domicilio con etiqueta, referencias, Maps, colonia, sucursal y ultimo uso
-- ---------------------------------------------------------------------------
alter table restaurantes.customer_addresses
  add column if not exists access_notes text check (access_notes is null or char_length(access_notes) <= 300),
  add column if not exists maps_url text check (maps_url is null or (maps_url ~ '^https://[^[:space:]]+$' and char_length(maps_url) <= 500)),
  add column if not exists colonia text check (colonia is null or char_length(colonia) between 1 and 120),
  add column if not exists property_id uuid references core.property(id) on delete set null,
  add column if not exists last_used_at timestamptz,
  add column if not exists times_used integer not null default 0 check (times_used >= 0),
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- 2) customers: fecha de nacimiento opcional (solo dia y mes) y notas del staff
-- ---------------------------------------------------------------------------
alter table restaurantes.customers
  add column if not exists fecha_nacimiento_dia smallint check (fecha_nacimiento_dia is null or fecha_nacimiento_dia between 1 and 31),
  add column if not exists fecha_nacimiento_mes smallint check (fecha_nacimiento_mes is null or fecha_nacimiento_mes between 1 and 12),
  add column if not exists staff_notes text check (staff_notes is null or char_length(staff_notes) <= 1000);
alter table restaurantes.customers drop constraint if exists customers_fecha_nacimiento_check;
alter table restaurantes.customers
  add constraint customers_fecha_nacimiento_check check (
    (fecha_nacimiento_dia is null and fecha_nacimiento_mes is null)
    or (
      fecha_nacimiento_dia is not null and fecha_nacimiento_mes is not null
      and fecha_nacimiento_dia <= case fecha_nacimiento_mes when 2 then 29 when 4 then 30 when 6 then 30 when 9 then 30 when 11 then 30 else 31 end
    )
  );

-- ---------------------------------------------------------------------------
-- 3) orders: pedido falso marcado por el staff
-- ---------------------------------------------------------------------------
alter table restaurantes.orders
  add column if not exists pedido_falso_at timestamptz,
  add column if not exists pedido_falso_por uuid references core.staff_user(id) on delete set null;
create index if not exists orders_customer_no_recogido_idx
  on restaurantes.orders (customer_id, created_at desc) where status = 'no_recogido' or pedido_falso_at is not null;

-- ---------------------------------------------------------------------------
-- 4) customer_preferences: gustos
-- ---------------------------------------------------------------------------
create table restaurantes.customer_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  kind text not null check (kind in ('tortilla', 'salsa', 'omision', 'nota', 'pago', 'propina', 'canal', 'sucursal')),
  value text not null check (char_length(value) between 1 and 120),
  -- pedido = aprendido de un pedido confirmado; staff = lo escribio una persona del restaurante.
  source text not null check (source in ('pedido', 'staff')),
  times_seen integer not null default 1 check (times_seen >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_order_id uuid references restaurantes.orders(id) on delete set null,
  -- descartada = el cliente o el staff pidio no volver a proponerlo.
  status text not null default 'activa' check (status in ('activa', 'descartada')),
  updated_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, kind, value)
);
create index customer_preferences_org_customer_idx on restaurantes.customer_preferences (organization_id, customer_id);

alter table restaurantes.customer_preferences enable row level security;
create policy "gestores ven los gustos de sus clientes" on restaurantes.customer_preferences for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = customer_preferences.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin', 'staff')
    )
  );
revoke all on restaurantes.customer_preferences from public, anon, authenticated;
grant select (id, organization_id, customer_id, kind, value, source, times_seen, first_seen_at, last_seen_at, status, created_at, updated_at)
  on restaurantes.customer_preferences to authenticated;
grant select, insert, update, delete on restaurantes.customer_preferences to service_role;

-- ---------------------------------------------------------------------------
-- 5) customer_pedido_cierre: idempotencia del cierre del ciclo (un pedido se aplica a la ficha UNA vez)
-- ---------------------------------------------------------------------------
create table restaurantes.customer_pedido_cierre (
  order_id uuid primary key references restaurantes.orders(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  applied_at timestamptz not null default now()
);
alter table restaurantes.customer_pedido_cierre enable row level security;
create policy "gestores ven el cierre de pedidos de su organizacion" on restaurantes.customer_pedido_cierre for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = customer_pedido_cierre.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin', 'staff')
    )
  );
revoke all on restaurantes.customer_pedido_cierre from public, anon, authenticated;
grant select on restaurantes.customer_pedido_cierre to service_role;

-- ---------------------------------------------------------------------------
-- 6) cliente_politica: reincidencia de "no recogido" y pedidos falsos
-- ---------------------------------------------------------------------------
create table restaurantes.cliente_politica (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  -- Cuantos "no recogido" (o pedidos falsos) en la ventana hacen que el siguiente pedido lo confirme la sucursal.
  -- 0 = apagado. Sin fila rige el valor por omision de la aplicacion (2 en 90 dias).
  umbral_no_recogidos smallint not null default 2 check (umbral_no_recogidos between 0 and 20),
  ventana_dias smallint not null default 90 check (ventana_dias between 7 and 365),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table restaurantes.cliente_politica enable row level security;
create policy "gestores ven la politica de clientes de su organizacion" on restaurantes.cliente_politica for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = cliente_politica.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin', 'staff')
    )
  );
revoke all on restaurantes.cliente_politica from public, anon, authenticated;
grant select (organization_id, umbral_no_recogidos, ventana_dias, updated_at) on restaurantes.cliente_politica to authenticated;
grant select, insert, update, delete on restaurantes.cliente_politica to service_role;

-- ---------------------------------------------------------------------------
-- 7a) Auxiliares internos. cliente_es_gestor solo evalua la membresia de quien llama (su propia sesion). Los otros cuatro
-- (politica efectiva, domicilios, gustos y confiabilidad) NO comprueban ningun permiso: se invocan unicamente desde funciones
-- security definer, que corren con los privilegios del dueno y por eso no necesitan EXECUTE de authenticated. Se revoca
-- EXECUTE a public, anon y authenticated: llamarlos directo por PostgREST leeria datos de cualquier cliente sin pasar por RLS.
-- ---------------------------------------------------------------------------
-- Rol de gestion en la organizacion. false (nunca error) sin sesion, asi la sesion de sistema nunca gana acceso por aqui.
create or replace function restaurantes.cliente_es_gestor(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from core.membership m
     where m.user_id = auth.uid()
       and m.organization_id = p_organization_id
       and m.vertical_role in ('owner', 'admin', 'staff')
  );
$$;
revoke all on function restaurantes.cliente_es_gestor(uuid) from public, anon;
grant execute on function restaurantes.cliente_es_gestor(uuid) to authenticated;

-- Igual que cliente_es_gestor pero solo owner/admin (derechos ARCO: exportar y borrar memoria). false sin sesion.
create or replace function restaurantes.cliente_es_admin(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from core.membership m
     where m.user_id = auth.uid()
       and m.organization_id = p_organization_id
       and m.vertical_role in ('owner', 'admin')
  );
$$;
revoke all on function restaurantes.cliente_es_admin(uuid) from public, anon;
grant execute on function restaurantes.cliente_es_admin(uuid) to authenticated;

-- Politica efectiva de la organizacion (valores por omision si no hay fila).
create or replace function restaurantes.cliente_politica_efectiva(p_organization_id uuid)
returns table (out_umbral integer, out_ventana integer)
language sql
stable
security definer
set search_path = restaurantes, pg_temp
as $$
  select coalesce((select p.umbral_no_recogidos from restaurantes.cliente_politica p where p.organization_id = p_organization_id), 2)::integer,
         coalesce((select p.ventana_dias from restaurantes.cliente_politica p where p.organization_id = p_organization_id), 90)::integer;
$$;
revoke all on function restaurantes.cliente_politica_efectiva(uuid) from public, anon, authenticated;

-- Direcciones de un cliente como jsonb, el ultimo usado primero.
create or replace function restaurantes.cliente_direcciones_json(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'label', a.label, 'address', a.address, 'is_default', a.is_default,
           'access_notes', a.access_notes, 'maps_url', a.maps_url, 'colonia', a.colonia,
           'branch_slug', bd.slug, 'last_used_at', a.last_used_at, 'times_used', a.times_used
         ) order by a.last_used_at desc nulls last, a.is_default desc, a.created_at desc), '[]'::jsonb)
    from restaurantes.customer_addresses a
    left join restaurantes.branch_detail bd on bd.property_id = a.property_id
   where a.customer_id = p_customer_id;
$$;
revoke all on function restaurantes.cliente_direcciones_json(uuid) from public, anon, authenticated;

-- Gustos de un cliente como jsonb (mas vistos primero).
create or replace function restaurantes.cliente_gustos_json(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = restaurantes, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'kind', p.kind, 'value', p.value, 'source', p.source, 'times_seen', p.times_seen,
           'first_seen_at', p.first_seen_at, 'last_seen_at', p.last_seen_at, 'status', p.status
         ) order by p.status, p.times_seen desc, p.last_seen_at desc), '[]'::jsonb)
    from restaurantes.customer_preferences p
   where p.customer_id = p_customer_id;
$$;
revoke all on function restaurantes.cliente_gustos_json(uuid) from public, anon, authenticated;

-- Conteos de confiabilidad (no recogidos dentro de la ventana y pedidos falsos marcados por el staff).
create or replace function restaurantes.cliente_confiabilidad_json(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = restaurantes, pg_temp
as $$
  select jsonb_build_object(
    'no_recogidos_90d', (
      select count(*) from restaurantes.orders o
       where o.customer_id = p_customer_id and o.organization_id = p_organization_id
         and o.status = 'no_recogido'
         and o.created_at >= now() - make_interval(days => (select out_ventana from restaurantes.cliente_politica_efectiva(p_organization_id)))
    ),
    'pedidos_falsos', (
      select count(*) from restaurantes.orders o
       where o.customer_id = p_customer_id and o.organization_id = p_organization_id and o.pedido_falso_at is not null
         and o.pedido_falso_at >= now() - make_interval(days => (select out_ventana from restaurantes.cliente_politica_efectiva(p_organization_id)))
    ),
    'umbral', (select out_umbral from restaurantes.cliente_politica_efectiva(p_organization_id)),
    'ventana_dias', (select out_ventana from restaurantes.cliente_politica_efectiva(p_organization_id))
  );
$$;
revoke all on function restaurantes.cliente_confiabilidad_json(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7b) cliente_memoria -- SOLO SISTEMA. Lectura de la memoria del cliente por (organizacion, telefono de 10 digitos).
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_memoria(p_organization_id uuid, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_customer restaurantes.customers;
begin
  if auth.uid() is not null then
    raise exception 'cliente_memoria es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_phone is null or btrim(p_phone) = '' then
    raise exception 'invalid args' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_organization_id and o.vertical = 'restaurantes') then
    raise exception 'organizacion inexistente o de otro vertical' using errcode = '42501';
  end if;

  select * into v_customer from restaurantes.customers c where c.organization_id = p_organization_id and c.phone = p_phone;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_customer.id, 'organization_id', v_customer.organization_id, 'phone', v_customer.phone,
      'name', v_customer.name, 'order_count', v_customer.order_count
    ),
    'addresses', restaurantes.cliente_direcciones_json(v_customer.id),
    -- Ultimos 30 pedidos que cuentan (sin cancelados ni problemas): base de "lo de siempre", "repetir" y los gustos.
    'orders', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', x.id, 'order_number', x.order_number, 'created_at', x.created_at, 'status', x.status, 'total', x.total,
               'items', x.items, 'branch', x.branch, 'property_id', x.property_id, 'payment_method', x.payment_method,
               'canal', x.canal, 'propina', x.propina, 'source', x.source
             ) order by x.created_at desc), '[]'::jsonb)
        from (
          select o.id, o.order_number, o.created_at, o.status, o.total, o.items, o.branch, o.property_id, o.payment_method, o.canal, o.propina, o.source
            from restaurantes.orders o
           where o.customer_id = v_customer.id and o.organization_id = p_organization_id
             and o.status in ('pending', 'preparando', 'en_camino', 'entregado', 'completado', 'listo_para_recoger')
           order by o.created_at desc
           limit 30
        ) x
    ),
    'preferences', restaurantes.cliente_gustos_json(v_customer.id),
    'confiabilidad', restaurantes.cliente_confiabilidad_json(p_organization_id, v_customer.id),
    -- Nivel del cliente (calc_customer_tier es de invocador y lee customers/orders: desde la sesion de sistema, bajo RLS,
    -- devolveria siempre null y el agente nunca vería a un cliente BLACK/PLATINUM; aqui corre con los privilegios del dueno
    -- de esta funcion, acotada a la MISMA organizacion y cliente ya resueltos arriba).
    'tier', restaurantes.calc_customer_tier(p_organization_id, v_customer.id) ->> 'tier'
  );
end;
$$;
revoke all on function restaurantes.cliente_memoria(uuid, text) from public, anon;
grant execute on function restaurantes.cliente_memoria(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7c) cliente_registrar_pedido -- SOLO SISTEMA. Cierra el ciclo del cliente tras crear un pedido: domicilio y gustos.
--     Idempotente por pedido: la segunda llamada con el mismo pedido no cuenta nada (devuelve aplicado=false).
--     p_domicilio: {address, label, access_notes, maps_url, colonia, property_id} o null.
--     p_observaciones: [{kind, value}] derivadas del pedido confirmado (maximo 20).
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_registrar_pedido(
  p_organization_id uuid,
  p_order_id uuid,
  p_domicilio jsonb,
  p_observaciones jsonb
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_claimed uuid;
  v_obs jsonb;
  v_kind text;
  v_value text;
  v_address text;
  v_label text;
  v_access text;
  v_maps text;
  v_colonia text;
  v_property uuid;
  v_first boolean;
  v_n integer := 0;
  v_prefs integer;
begin
  if auth.uid() is not null then
    raise exception 'cliente_registrar_pedido es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_order_id is null then
    raise exception 'invalid args' using errcode = '22023';
  end if;

  select * into v_order from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id;
  if not found or v_order.customer_id is null then
    raise exception 'el pedido no existe en la organizacion o no tiene cliente' using errcode = '42501';
  end if;

  insert into restaurantes.customer_pedido_cierre (order_id, organization_id, customer_id)
  values (p_order_id, p_organization_id, v_order.customer_id)
  on conflict (order_id) do nothing
  returning order_id into v_claimed;
  if v_claimed is null then
    return jsonb_build_object('aplicado', false);
  end if;

  -- Domicilio: alta o "usado otra vez" (el ultimo usado va primero); conserva etiqueta/referencias ya guardadas.
  if p_domicilio is not null and jsonb_typeof(p_domicilio) = 'object' then
    v_address := nullif(btrim(left(p_domicilio ->> 'address', 1000)), '');
    if v_address is not null then
      v_label := nullif(btrim(left(p_domicilio ->> 'label', 60)), '');
      v_access := nullif(btrim(left(p_domicilio ->> 'access_notes', 300)), '');
      v_maps := nullif(btrim(left(p_domicilio ->> 'maps_url', 500)), '');
      if v_maps is not null and v_maps !~ '^https://[^[:space:]]+$' then
        v_maps := null;
      end if;
      v_colonia := nullif(btrim(left(p_domicilio ->> 'colonia', 120)), '');
      v_property := null;
      if (p_domicilio ->> 'property_id') ~ '^[0-9a-fA-F-]{36}$' then
        select p.id into v_property from core.property p
         where p.id = (p_domicilio ->> 'property_id')::uuid and p.organization_id = p_organization_id;
      end if;
      v_first := not exists (select 1 from restaurantes.customer_addresses a where a.customer_id = v_order.customer_id);
      insert into restaurantes.customer_addresses (customer_id, address, label, is_default, access_notes, maps_url, colonia, property_id, last_used_at, times_used, updated_at)
      values (v_order.customer_id, v_address, v_label, v_first, v_access, v_maps, v_colonia, v_property, now(), 1, now())
      on conflict (customer_id, address) do update
        set last_used_at = now(),
            times_used = restaurantes.customer_addresses.times_used + 1,
            label = coalesce(excluded.label, restaurantes.customer_addresses.label),
            access_notes = coalesce(excluded.access_notes, restaurantes.customer_addresses.access_notes),
            maps_url = coalesce(excluded.maps_url, restaurantes.customer_addresses.maps_url),
            colonia = coalesce(excluded.colonia, restaurantes.customer_addresses.colonia),
            property_id = coalesce(excluded.property_id, restaurantes.customer_addresses.property_id),
            updated_at = now();
    end if;
  end if;

  -- Gustos: solo categorias conocidas y valores cortos; tope por cliente para no crecer sin limite.
  if p_observaciones is not null and jsonb_typeof(p_observaciones) = 'array' then
    select count(*) into v_prefs from restaurantes.customer_preferences cp where cp.customer_id = v_order.customer_id;
    for v_obs in select * from jsonb_array_elements(p_observaciones) limit 20 loop
      v_kind := v_obs ->> 'kind';
      v_value := nullif(btrim(left(v_obs ->> 'value', 120)), '');
      continue when v_value is null or v_kind is null
        or v_kind not in ('tortilla', 'salsa', 'omision', 'nota', 'pago', 'propina', 'canal', 'sucursal');
      if v_prefs >= 80 and not exists (
        select 1 from restaurantes.customer_preferences cp where cp.customer_id = v_order.customer_id and cp.kind = v_kind and cp.value = v_value
      ) then
        continue;
      end if;
      insert into restaurantes.customer_preferences (organization_id, customer_id, kind, value, source, last_order_id)
      values (p_organization_id, v_order.customer_id, v_kind, v_value, 'pedido', p_order_id)
      on conflict (customer_id, kind, value) do update
        set times_seen = restaurantes.customer_preferences.times_seen + 1,
            last_seen_at = now(),
            last_order_id = p_order_id,
            updated_at = now();
      v_n := v_n + 1;
    end loop;
  end if;

  return jsonb_build_object('aplicado', true, 'observaciones', v_n);
end;
$$;
revoke all on function restaurantes.cliente_registrar_pedido(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function restaurantes.cliente_registrar_pedido(uuid, uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8a) cliente_ficha -- STAFF. Ficha completa del cliente (datos, domicilios, gustos, pedidos, conversaciones, confiabilidad).
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_ficha(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_c restaurantes.customers;
  v_hashes text[];
begin
  if not restaurantes.cliente_es_gestor(p_organization_id) then
    raise exception 'cliente_ficha: solo owner/admin/staff de la organizacion' using errcode = '42501';
  end if;
  select * into v_c from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  -- whatsapp_conversations.phone se guarda como +<codigo de pais><numero> y customers.phone son los ultimos 10 digitos; el
  -- servicio de voz hashea TODOS los digitos que recibe del proveedor. Se aceptan las formas habituales de un mismo numero.
  v_hashes := array(
    select encode(sha256(convert_to(f, 'UTF8')), 'hex')
      from unnest(array[v_c.phone, '52' || v_c.phone, '521' || v_c.phone, '1' || v_c.phone, '01' || v_c.phone]) as f
  );

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_c.id, 'name', v_c.name, 'phone', v_c.phone, 'order_count', v_c.order_count, 'last_order_at', v_c.last_order_at,
      'created_at', v_c.created_at, 'fecha_nacimiento_dia', v_c.fecha_nacimiento_dia, 'fecha_nacimiento_mes', v_c.fecha_nacimiento_mes,
      'staff_notes', v_c.staff_notes
    ),
    'addresses', restaurantes.cliente_direcciones_json(v_c.id),
    'preferences', restaurantes.cliente_gustos_json(v_c.id),
    'confiabilidad', restaurantes.cliente_confiabilidad_json(p_organization_id, v_c.id),
    'orders', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', x.id, 'order_number', x.order_number, 'created_at', x.created_at, 'status', x.status, 'total', x.total,
               'items', x.items, 'branch', x.branch, 'source', x.source, 'payment_method', x.payment_method,
               'pedido_falso', x.pedido_falso_at is not null
             ) order by x.created_at desc), '[]'::jsonb)
        from (
          select o.id, o.order_number, o.created_at, o.status, o.total, o.items, o.branch, o.source, o.payment_method, o.pedido_falso_at
            from restaurantes.orders o
           where o.customer_id = v_c.id and o.organization_id = p_organization_id
           order by o.created_at desc
           limit 20
        ) x
    ),
    'whatsapp', (
      select jsonb_build_object('conversaciones', count(*), 'ultima_actividad', max(w.updated_at), 'mensajes', coalesce(sum(jsonb_array_length(w.messages)), 0))
        from restaurantes.whatsapp_conversations w
       where w.organization_id = p_organization_id and right(regexp_replace(w.phone, '\D', '', 'g'), 10) = v_c.phone
    ),
    'llamadas', (
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'started_at', x.started_at, 'duration_s', x.duration_s, 'resultado', x.resultado) order by x.started_at desc), '[]'::jsonb)
        from (
          select vc.id, vc.started_at, vc.duration_s, vc.resultado
            from restaurantes.voice_conversation vc
           where vc.organization_id = p_organization_id and vc.caller_hash = any (v_hashes) and vc.canal = 'llamada'
           order by vc.started_at desc
           limit 10
        ) x
    )
  );
end;
$$;
revoke all on function restaurantes.cliente_ficha(uuid, uuid) from public, anon;
grant execute on function restaurantes.cliente_ficha(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8b) cliente_actualizar -- STAFF. Parche de nombre, fecha de nacimiento (dia y mes) y notas. Solo las llaves presentes.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_actualizar(p_organization_id uuid, p_customer_id uuid, p_cambios jsonb)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_c restaurantes.customers;
  v_dia smallint;
  v_mes smallint;
begin
  if not restaurantes.cliente_es_gestor(p_organization_id) then
    raise exception 'cliente_actualizar: solo owner/admin/staff de la organizacion' using errcode = '42501';
  end if;
  if p_cambios is null or jsonb_typeof(p_cambios) <> 'object' then
    raise exception 'cambios invalidos' using errcode = '22023';
  end if;
  select * into v_c from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id for update;
  if not found then
    raise exception 'cliente inexistente en la organizacion' using errcode = '42501';
  end if;

  v_dia := v_c.fecha_nacimiento_dia;
  v_mes := v_c.fecha_nacimiento_mes;
  if p_cambios ? 'fecha_nacimiento_dia' or p_cambios ? 'fecha_nacimiento_mes' then
    v_dia := nullif(p_cambios ->> 'fecha_nacimiento_dia', '')::smallint;
    v_mes := nullif(p_cambios ->> 'fecha_nacimiento_mes', '')::smallint;
  end if;

  update restaurantes.customers c set
    name = case when p_cambios ? 'name' then nullif(btrim(left(p_cambios ->> 'name', 160)), '') else c.name end,
    staff_notes = case when p_cambios ? 'staff_notes' then nullif(btrim(left(p_cambios ->> 'staff_notes', 1000)), '') else c.staff_notes end,
    fecha_nacimiento_dia = v_dia,
    fecha_nacimiento_mes = v_mes,
    updated_at = now()
   where c.id = v_c.id;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function restaurantes.cliente_actualizar(uuid, uuid, jsonb) from public, anon;
grant execute on function restaurantes.cliente_actualizar(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8c) cliente_direccion_guardar / cliente_direccion_borrar -- STAFF.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_direccion_guardar(p_organization_id uuid, p_customer_id uuid, p_address_id uuid, p_cambios jsonb)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_address text;
  v_maps text;
  v_property uuid;
  v_id uuid := p_address_id;
  v_default boolean;
begin
  if not restaurantes.cliente_es_gestor(p_organization_id) then
    raise exception 'cliente_direccion_guardar: solo owner/admin/staff de la organizacion' using errcode = '42501';
  end if;
  if p_cambios is null or jsonb_typeof(p_cambios) <> 'object' then
    raise exception 'cambios invalidos' using errcode = '22023';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    raise exception 'cliente inexistente en la organizacion' using errcode = '42501';
  end if;

  v_maps := nullif(btrim(left(p_cambios ->> 'maps_url', 500)), '');
  if v_maps is not null and v_maps !~ '^https://[^[:space:]]+$' then
    raise exception 'el link de Maps debe empezar con https://' using errcode = '22023';
  end if;
  if (p_cambios ->> 'property_id') is not null and (p_cambios ->> 'property_id') <> '' then
    select p.id into v_property from core.property p
     where p.id = (p_cambios ->> 'property_id')::uuid and p.organization_id = p_organization_id;
    if v_property is null then
      raise exception 'sucursal inexistente en la organizacion' using errcode = '42501';
    end if;
  end if;
  v_default := coalesce((p_cambios ->> 'is_default')::boolean, false);

  if v_id is null then
    v_address := nullif(btrim(left(p_cambios ->> 'address', 1000)), '');
    if v_address is null then
      raise exception 'la direccion es requerida' using errcode = '22023';
    end if;
    insert into restaurantes.customer_addresses (customer_id, address, label, is_default, access_notes, maps_url, colonia, property_id, updated_at)
    values (
      p_customer_id, v_address, nullif(btrim(left(p_cambios ->> 'label', 60)), ''),
      not exists (select 1 from restaurantes.customer_addresses a where a.customer_id = p_customer_id),
      nullif(btrim(left(p_cambios ->> 'access_notes', 300)), ''), v_maps, nullif(btrim(left(p_cambios ->> 'colonia', 120)), ''), v_property, now()
    )
    returning id into v_id;
  else
    if not exists (select 1 from restaurantes.customer_addresses a where a.id = v_id and a.customer_id = p_customer_id) then
      raise exception 'direccion inexistente para el cliente' using errcode = '42501';
    end if;
    update restaurantes.customer_addresses a set
      address = case when p_cambios ? 'address' then coalesce(nullif(btrim(left(p_cambios ->> 'address', 1000)), ''), a.address) else a.address end,
      label = case when p_cambios ? 'label' then nullif(btrim(left(p_cambios ->> 'label', 60)), '') else a.label end,
      access_notes = case when p_cambios ? 'access_notes' then nullif(btrim(left(p_cambios ->> 'access_notes', 300)), '') else a.access_notes end,
      maps_url = case when p_cambios ? 'maps_url' then v_maps else a.maps_url end,
      colonia = case when p_cambios ? 'colonia' then nullif(btrim(left(p_cambios ->> 'colonia', 120)), '') else a.colonia end,
      property_id = case when p_cambios ? 'property_id' then v_property else a.property_id end,
      updated_at = now()
     where a.id = v_id;
  end if;

  if v_default then
    update restaurantes.customer_addresses a set is_default = (a.id = v_id) where a.customer_id = p_customer_id;
  end if;
  return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function restaurantes.cliente_direccion_guardar(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function restaurantes.cliente_direccion_guardar(uuid, uuid, uuid, jsonb) to authenticated;

create or replace function restaurantes.cliente_direccion_borrar(p_organization_id uuid, p_customer_id uuid, p_address_id uuid)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_deleted integer;
  v_was_default boolean;
begin
  if not restaurantes.cliente_es_gestor(p_organization_id) then
    raise exception 'cliente_direccion_borrar: solo owner/admin/staff de la organizacion' using errcode = '42501';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    raise exception 'cliente inexistente en la organizacion' using errcode = '42501';
  end if;
  select a.is_default into v_was_default from restaurantes.customer_addresses a where a.id = p_address_id and a.customer_id = p_customer_id;
  delete from restaurantes.customer_addresses a where a.id = p_address_id and a.customer_id = p_customer_id;
  get diagnostics v_deleted = row_count;
  if v_deleted > 0 and coalesce(v_was_default, false) then
    -- Si se borro la predeterminada, la mas reciente pasa a serlo.
    update restaurantes.customer_addresses a set is_default = true
     where a.id = (select a2.id from restaurantes.customer_addresses a2 where a2.customer_id = p_customer_id order by a2.last_used_at desc nulls last, a2.created_at desc limit 1);
  end if;
  return v_deleted > 0;
end;
$$;
revoke all on function restaurantes.cliente_direccion_borrar(uuid, uuid, uuid) from public, anon;
grant execute on function restaurantes.cliente_direccion_borrar(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8d) cliente_preferencia_accion -- STAFF. agregar | descartar | reactivar | eliminar un gusto.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_preferencia_accion(
  p_organization_id uuid,
  p_customer_id uuid,
  p_accion text,
  p_pref_id uuid,
  p_kind text,
  p_value text
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
  v_value text := nullif(btrim(left(p_value, 120)), '');
begin
  if not restaurantes.cliente_es_gestor(p_organization_id) then
    raise exception 'cliente_preferencia_accion: solo owner/admin/staff de la organizacion' using errcode = '42501';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    raise exception 'cliente inexistente en la organizacion' using errcode = '42501';
  end if;

  if p_accion = 'agregar' then
    if v_value is null or p_kind is null or p_kind not in ('tortilla', 'salsa', 'omision', 'nota', 'pago', 'propina', 'canal', 'sucursal') then
      raise exception 'categoria o valor invalido' using errcode = '22023';
    end if;
    insert into restaurantes.customer_preferences (organization_id, customer_id, kind, value, source, updated_by)
    values (p_organization_id, p_customer_id, p_kind, v_value, 'staff', auth.uid())
    on conflict (customer_id, kind, value) do update
      set status = 'activa', source = 'staff', updated_by = auth.uid(), updated_at = now()
    returning id into v_id;
    return jsonb_build_object('id', v_id);
  end if;

  if p_accion not in ('descartar', 'reactivar', 'eliminar') then
    raise exception 'accion invalida' using errcode = '22023';
  end if;
  if p_accion = 'eliminar' then
    delete from restaurantes.customer_preferences cp where cp.id = p_pref_id and cp.customer_id = p_customer_id returning cp.id into v_id;
  else
    update restaurantes.customer_preferences cp
       set status = case when p_accion = 'descartar' then 'descartada' else 'activa' end, updated_by = auth.uid(), updated_at = now()
     where cp.id = p_pref_id and cp.customer_id = p_customer_id
    returning cp.id into v_id;
  end if;
  if v_id is null then
    raise exception 'gusto inexistente para el cliente' using errcode = '42501';
  end if;
  return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function restaurantes.cliente_preferencia_accion(uuid, uuid, text, uuid, text, text) from public, anon;
grant execute on function restaurantes.cliente_preferencia_accion(uuid, uuid, text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8e) cliente_marcar_pedido_falso -- STAFF. Marca o desmarca un pedido como falso (cuenta para la reincidencia).
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_marcar_pedido_falso(p_organization_id uuid, p_order_id uuid, p_falso boolean)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if not restaurantes.cliente_es_gestor(p_organization_id) then
    raise exception 'cliente_marcar_pedido_falso: solo owner/admin/staff de la organizacion' using errcode = '42501';
  end if;
  update restaurantes.orders o
     set pedido_falso_at = case when coalesce(p_falso, true) then now() else null end,
         pedido_falso_por = case when coalesce(p_falso, true) then auth.uid() else null end
   where o.id = p_order_id and o.organization_id = p_organization_id
  returning o.id into v_id;
  if v_id is null then
    raise exception 'pedido inexistente en la organizacion' using errcode = '42501';
  end if;
  return coalesce(p_falso, true);
end;
$$;
revoke all on function restaurantes.cliente_marcar_pedido_falso(uuid, uuid, boolean) from public, anon;
grant execute on function restaurantes.cliente_marcar_pedido_falso(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8f) cliente_exportar_arco / cliente_borrar_memoria -- OWNER/ADMIN (derechos ARCO de acceso y cancelacion)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_exportar_arco(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_c restaurantes.customers;
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'cliente_exportar_arco: solo owner/admin de la organizacion (derechos ARCO)' using errcode = '42501';
  end if;
  select * into v_c from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'nombre', v_c.name,
    'telefono', v_c.phone,
    'fecha_nacimiento_dia', v_c.fecha_nacimiento_dia,
    'fecha_nacimiento_mes', v_c.fecha_nacimiento_mes,
    'notas_del_restaurante', v_c.staff_notes,
    'primer_registro', v_c.created_at,
    'domicilios', restaurantes.cliente_direcciones_json(v_c.id),
    'gustos', restaurantes.cliente_gustos_json(v_c.id),
    'pedidos', (
      select coalesce(jsonb_agg(jsonb_build_object('numero', o.order_number, 'fecha', o.created_at, 'estado', o.status, 'total', o.total, 'productos', o.items, 'sucursal', o.branch) order by o.created_at desc), '[]'::jsonb)
        from restaurantes.orders o where o.customer_id = v_c.id and o.organization_id = p_organization_id
    )
  );
end;
$$;
revoke all on function restaurantes.cliente_exportar_arco(uuid, uuid) from public, anon;
grant execute on function restaurantes.cliente_exportar_arco(uuid, uuid) to authenticated;

-- Borra la MEMORIA del cliente (domicilios, gustos, notas, nombre y fecha de nacimiento). Los pedidos ya cumplidos se
-- conservan por obligacion fiscal/operativa; su anonimizacion pertenece al flujo ARCO de cancelacion del restaurante.
create or replace function restaurantes.cliente_borrar_memoria(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_addr integer;
  v_pref integer;
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'cliente_borrar_memoria: solo owner/admin de la organizacion (derechos ARCO)' using errcode = '42501';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    raise exception 'cliente inexistente en la organizacion' using errcode = '42501';
  end if;
  delete from restaurantes.customer_addresses a where a.customer_id = p_customer_id;
  get diagnostics v_addr = row_count;
  delete from restaurantes.customer_preferences cp where cp.customer_id = p_customer_id;
  get diagnostics v_pref = row_count;
  update restaurantes.customers c
     set name = null, staff_notes = null, fecha_nacimiento_dia = null, fecha_nacimiento_mes = null, updated_at = now()
   where c.id = p_customer_id;
  return jsonb_build_object('domicilios_borrados', v_addr, 'gustos_borrados', v_pref);
end;
$$;
revoke all on function restaurantes.cliente_borrar_memoria(uuid, uuid) from public, anon;
grant execute on function restaurantes.cliente_borrar_memoria(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8g) cliente_politica_leer / cliente_politica_guardar -- STAFF (guardar: solo owner/admin)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_politica_leer(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if not restaurantes.cliente_es_gestor(p_organization_id) then
    raise exception 'cliente_politica_leer: solo owner/admin/staff de la organizacion' using errcode = '42501';
  end if;
  return (select jsonb_build_object('umbral_no_recogidos', e.out_umbral, 'ventana_dias', e.out_ventana) from restaurantes.cliente_politica_efectiva(p_organization_id) e);
end;
$$;
revoke all on function restaurantes.cliente_politica_leer(uuid) from public, anon;
grant execute on function restaurantes.cliente_politica_leer(uuid) to authenticated;

create or replace function restaurantes.cliente_politica_guardar(p_organization_id uuid, p_umbral integer, p_ventana_dias integer)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
begin
  if v_actor is null then
    raise exception 'cliente_politica_guardar: requiere un actor autenticado' using errcode = '28000';
  end if;
  select m.vertical_role into v_role from core.membership m where m.organization_id = p_organization_id and m.user_id = v_actor;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'cliente_politica_guardar: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_umbral is null or p_umbral < 0 or p_umbral > 20 or p_ventana_dias is null or p_ventana_dias < 7 or p_ventana_dias > 365 then
    raise exception 'umbral (0 a 20) o ventana (7 a 365 dias) fuera de rango' using errcode = '22023';
  end if;
  insert into restaurantes.cliente_politica as p (organization_id, umbral_no_recogidos, ventana_dias, updated_by, updated_at)
  values (p_organization_id, p_umbral, p_ventana_dias, v_actor, now())
  on conflict (organization_id) do update
    set umbral_no_recogidos = excluded.umbral_no_recogidos, ventana_dias = excluded.ventana_dias, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('umbral_no_recogidos', p_umbral, 'ventana_dias', p_ventana_dias);
end;
$$;
revoke all on function restaurantes.cliente_politica_guardar(uuid, integer, integer) from public, anon;
grant execute on function restaurantes.cliente_politica_guardar(uuid, integer, integer) to authenticated;
