-- 140: importacion de historial de clientes (agregados por cliente, SIN pedidos individuales) y lectura del perfil historico por el agente.
-- Requiere: 001 (customers, customer_addresses), 049 (cliente_es_admin). Todo NUEVO y aditivo; ninguna tabla/funcion existente se redefine.
--
-- Decisiones (leer primero):
--  * El historial importado vive en SU PROPIA tabla (`customer_historial_resumen`); NO se escribe `customers.order_count` ni `last_order_at`
--    (los usan marketing_elegibles, el tier y el RFM del CFO) y NO se crean filas en `orders`. Importar jamas otorga consentimiento de marketing.
--  * Tortilla/salsas/pago/canal/favoritos importados NO se meten en `customer_preferences`: asi no pueden confundirse con gustos aprendidos de
--    pedidos confirmados ni activar el camino «como siempre» de 049 (que exige times_seen >= 2). El agente los lee por `cliente_perfil_historico`.
--  * Quejas: solo la CATEGORIA (demora, faltante, cobro, salsas, cancelado, equivocado, otra). Cero texto libre.
--  * Idempotencia: la huella de fila (sha-256, calculada por el importador sobre el contenido canonico) se guarda en el resumen; reimportar el mismo
--    archivo da creadas=0, actualizadas=0, sin_cambios=N. El lote es unico por (organizacion, sha-256 del archivo).
--  * Vista previa (p_aplicar=false): corre EXACTAMENTE la misma logica de decision y NO escribe nada.
--  * ARCO: `historial_exportar` y `historial_borrar`; borrar deja el hash del telefono en `import_historico_supresion` para que un re-run del
--    archivo no reviva al titular.
--  * Seguridad: funciones SECURITY DEFINER con search_path fijo, revoke de public/anon. importar_historial/exportar/borrar exigen owner/admin de la
--    organizacion (cliente_es_admin); cliente_perfil_historico es SOLO sistema (auth.uid() nulo) como cliente_memoria. Las tablas nuevas tienen RLS
--    activado y ningun grant a authenticated: solo se leen/escriben por estas funciones (y service_role para operacion).
-- Compatibilidad: base sin esta migracion => 42883/42P01; el TypeScript degrada (perfil historico ausente, el agente se comporta como antes).
-- REVERSA: drop function if exists restaurantes.cliente_perfil_historico(uuid, text), restaurantes.importar_historial(uuid, text, boolean, jsonb),
--          restaurantes.historial_exportar(uuid, uuid), restaurantes.historial_borrar(uuid, uuid), restaurantes.hist_texto_array(jsonb);
--          drop view if exists restaurantes.customer_ultimo_pedido_efectivo;
--          drop table if exists restaurantes.import_historico_fila, restaurantes.import_historico_lote, restaurantes.import_historico_supresion,
--          restaurantes.customer_quejas_historicas, restaurantes.customer_historial_resumen;
--          alter table restaurantes.customers drop column if exists origen, drop column if exists origen_lote, drop column if exists importado_at;

-- ---------------------------------------------------------------------------
-- 1) customers: trazabilidad de origen
-- ---------------------------------------------------------------------------
alter table restaurantes.customers
  add column if not exists origen text not null default 'canal',
  add column if not exists origen_lote uuid,
  add column if not exists importado_at timestamptz;
alter table restaurantes.customers drop constraint if exists customers_origen_check;
alter table restaurantes.customers add constraint customers_origen_check check (origen in ('canal', 'importacion_historica', 'panel'));

-- ---------------------------------------------------------------------------
-- 2) Tablas
-- ---------------------------------------------------------------------------
create table if not exists restaurantes.import_historico_lote (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  archivo_sha256 text not null check (archivo_sha256 ~ '^[0-9a-f]{64}$'),
  filas_total integer not null check (filas_total >= 0),
  creadas integer not null default 0,
  actualizadas integer not null default 0,
  sin_cambios integer not null default 0,
  rechazadas integer not null default 0,
  suprimidas integer not null default 0,
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_at timestamptz not null default now(),
  unique (organization_id, archivo_sha256)
);

create table if not exists restaurantes.customer_historial_resumen (
  customer_id uuid primary key references restaurantes.customers(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  canal text check (canal is null or canal in ('domicilio', 'recoger')),
  pago text check (pago is null or pago in ('efectivo', 'tarjeta')),
  tortilla text check (tortilla is null or tortilla in ('maiz', 'harina', 'mixta')),
  salsas text[] not null default '{}',
  omisiones text[] not null default '{}',
  favoritos text[] not null default '{}',
  pedidos integer not null default 0 check (pedidos >= 0),
  gasto_mxn numeric(12, 2) not null default 0 check (gasto_mxn >= 0),
  ticket_mxn numeric(10, 2) check (ticket_mxn is null or ticket_mxn >= 0),
  kilos_totales numeric(10, 2) check (kilos_totales is null or kilos_totales >= 0),
  primer_pedido date,
  ultimo_pedido date,
  estado text check (estado is null or estado in ('activo', 'dormido', 'queja_abierta', 'n/a')),
  revision_humana boolean not null default false,
  banderas text[] not null default '{}',
  origen_lote uuid references restaurantes.import_historico_lote(id) on delete set null,
  huella text not null check (huella ~ '^[0-9a-f]{64}$'),
  importado_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customer_historial_resumen_org_idx on restaurantes.customer_historial_resumen (organization_id);

create table if not exists restaurantes.customer_quejas_historicas (
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  categoria text not null check (categoria in ('demora', 'faltante', 'cobro', 'salsas', 'cancelado', 'equivocado', 'otra')),
  origen_lote uuid references restaurantes.import_historico_lote(id) on delete set null,
  primary key (customer_id, categoria)
);

create table if not exists restaurantes.import_historico_fila (
  lote_id uuid not null references restaurantes.import_historico_lote(id) on delete cascade,
  fila_n integer not null check (fila_n >= 1),
  customer_id uuid references restaurantes.customers(id) on delete set null,
  accion text not null check (accion in ('crear', 'actualizar', 'sin_cambio')),
  banderas text[] not null default '{}',
  huella_fila text not null check (huella_fila ~ '^[0-9a-f]{64}$'),
  primary key (lote_id, fila_n)
);

create table if not exists restaurantes.import_historico_supresion (
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (organization_id, phone_hash)
);

do $$
declare
  t text;
begin
  foreach t in array array['import_historico_lote', 'customer_historial_resumen', 'customer_quejas_historicas', 'import_historico_fila', 'import_historico_supresion'] loop
    execute format('alter table restaurantes.%I enable row level security', t);
    execute format('revoke all on restaurantes.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on restaurantes.%I to service_role', t);
  end loop;
end $$;

-- Ultimo pedido «efectivo»: el real o el historico importado, el mayor. Solo service_role (las funciones definer lo leen por dentro).
create or replace view restaurantes.customer_ultimo_pedido_efectivo as
  select c.id as customer_id, c.organization_id,
         greatest(c.last_order_at::date, h.ultimo_pedido) as ultimo_pedido_efectivo
    from restaurantes.customers c
    left join restaurantes.customer_historial_resumen h on h.customer_id = c.id;
revoke all on restaurantes.customer_ultimo_pedido_efectivo from public, anon, authenticated;
grant select on restaurantes.customer_ultimo_pedido_efectivo to service_role;

-- ---------------------------------------------------------------------------
-- 3) Auxiliar: jsonb array -> text[] (vacio si no es arreglo)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.hist_texto_array(j jsonb)
returns text[]
language sql
immutable
set search_path = pg_temp
as $$
  select case when jsonb_typeof(j) = 'array'
              then coalesce(array(select left(btrim(x), 120) from jsonb_array_elements_text(j) x where btrim(x) <> ''), '{}')
              else '{}'::text[] end;
$$;
revoke all on function restaurantes.hist_texto_array(jsonb) from public, anon;
grant execute on function restaurantes.hist_texto_array(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) importar_historial (owner/admin). p_aplicar=false => vista previa sin escrituras.
--    p_filas: arreglo de {fila, telefono (10 digitos), nombre, direccion, colonia, canal, pago, tortilla, salsas[], omisiones[], favoritos[],
--    pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, estado, quejas[], banderas[], huella}
-- ---------------------------------------------------------------------------
create or replace function restaurantes.importar_historial(p_organization_id uuid, p_archivo_sha256 text, p_aplicar boolean, p_filas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_row record;
  v_lote uuid;
  v_cust uuid;
  v_prev text;
  v_accion text;
  v_phone text;
  v_hash text;
  v_huella text;
  v_nombre text;
  v_dir text;
  v_col text;
  v_banderas text[];
  v_quejas text[];
  v_pedidos integer;
  v_gasto numeric;
  v_ticket numeric;
  v_kilos numeric;
  v_primer date;
  v_ultimo date;
  v_creadas integer := 0;
  v_actualizadas integer := 0;
  v_sin_cambios integer := 0;
  v_rechazadas integer := 0;
  v_suprimidas integer := 0;
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'importar_historial: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_archivo_sha256 is null or p_archivo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'importar_historial: huella de archivo invalida' using errcode = '22023';
  end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) > 20000 then
    raise exception 'importar_historial: se esperaba un arreglo de hasta 20000 filas' using errcode = '22023';
  end if;

  if p_aplicar then
    insert into restaurantes.import_historico_lote (organization_id, archivo_sha256, filas_total, creado_por)
    values (p_organization_id, p_archivo_sha256, jsonb_array_length(p_filas), auth.uid())
    on conflict (organization_id, archivo_sha256) do update set creado_at = now(), filas_total = excluded.filas_total
    returning id into v_lote;
  end if;

  for v_row in select e.value as j, e.ord::integer as n from jsonb_array_elements(p_filas) with ordinality as e(value, ord) loop
    begin
      if jsonb_typeof(v_row.j) <> 'object' then
        v_rechazadas := v_rechazadas + 1;
        continue;
      end if;
      v_phone := v_row.j ->> 'telefono';
      v_huella := v_row.j ->> 'huella';
      if v_phone is null or v_phone !~ '^[0-9]{10}$' or v_huella is null or v_huella !~ '^[0-9a-f]{64}$' then
        v_rechazadas := v_rechazadas + 1;
        continue;
      end if;
      v_hash := encode(sha256(convert_to(p_organization_id::text || ':' || v_phone, 'utf8')), 'hex');
      if exists (select 1 from restaurantes.import_historico_supresion s where s.organization_id = p_organization_id and s.phone_hash = v_hash) then
        v_suprimidas := v_suprimidas + 1;
        continue;
      end if;

      -- Conversiones (en vista previa tambien: un valor invalido rechaza la fila igual que al aplicar).
      v_nombre := nullif(btrim(left(coalesce(v_row.j ->> 'nombre', ''), 120)), '');
      v_dir := nullif(btrim(left(coalesce(v_row.j ->> 'direccion', ''), 300)), '');
      v_col := nullif(btrim(left(coalesce(v_row.j ->> 'colonia', ''), 120)), '');
      v_banderas := restaurantes.hist_texto_array(v_row.j -> 'banderas');
      v_quejas := array(select q from unnest(restaurantes.hist_texto_array(v_row.j -> 'quejas')) q
                         where q in ('demora', 'faltante', 'cobro', 'salsas', 'cancelado', 'equivocado', 'otra'));
      v_pedidos := coalesce(nullif(v_row.j ->> 'pedidos', '')::integer, 0);
      v_gasto := coalesce(nullif(v_row.j ->> 'gasto_mxn', '')::numeric, 0);
      v_ticket := nullif(v_row.j ->> 'ticket_mxn', '')::numeric;
      v_kilos := nullif(v_row.j ->> 'kilos_totales', '')::numeric;
      v_primer := nullif(v_row.j ->> 'primer_pedido', '')::date;
      v_ultimo := nullif(v_row.j ->> 'ultimo_pedido', '')::date;

      select c.id into v_cust from restaurantes.customers c where c.organization_id = p_organization_id and c.phone = v_phone;
      if v_cust is null then
        v_accion := 'crear';
      else
        select h.huella into v_prev from restaurantes.customer_historial_resumen h where h.customer_id = v_cust;
        v_accion := case when v_prev is not null and v_prev = v_huella then 'sin_cambio' else 'actualizar' end;
      end if;

      if p_aplicar and v_accion <> 'sin_cambio' then
        if v_cust is null then
          insert into restaurantes.customers (organization_id, phone, name, origen, origen_lote, importado_at)
          values (p_organization_id, v_phone, v_nombre, 'importacion_historica', v_lote, now())
          on conflict (organization_id, phone) do nothing
          returning id into v_cust;
          if v_cust is null then
            select c.id into v_cust from restaurantes.customers c where c.organization_id = p_organization_id and c.phone = v_phone;
            v_accion := 'actualizar';
          end if;
        end if;
        if v_accion = 'actualizar' and v_nombre is not null then
          -- No pisa un nombre que ya existe.
          update restaurantes.customers c set name = v_nombre, updated_at = now() where c.id = v_cust and (c.name is null or btrim(c.name) = '');
        end if;

        insert into restaurantes.customer_historial_resumen as h
          (customer_id, organization_id, canal, pago, tortilla, salsas, omisiones, favoritos, pedidos, gasto_mxn, ticket_mxn, kilos_totales,
           primer_pedido, ultimo_pedido, estado, revision_humana, banderas, origen_lote, huella)
        values
          (v_cust, p_organization_id, nullif(v_row.j ->> 'canal', ''), nullif(v_row.j ->> 'pago', ''), nullif(v_row.j ->> 'tortilla', ''),
           restaurantes.hist_texto_array(v_row.j -> 'salsas'), restaurantes.hist_texto_array(v_row.j -> 'omisiones'), restaurantes.hist_texto_array(v_row.j -> 'favoritos'),
           v_pedidos, v_gasto, v_ticket, v_kilos, v_primer, v_ultimo, nullif(v_row.j ->> 'estado', ''),
           'revision_humana' = any (v_banderas), v_banderas, v_lote, v_huella)
        on conflict (customer_id) do update set
          canal = excluded.canal, pago = excluded.pago, tortilla = excluded.tortilla, salsas = excluded.salsas, omisiones = excluded.omisiones,
          favoritos = excluded.favoritos, pedidos = excluded.pedidos, gasto_mxn = excluded.gasto_mxn, ticket_mxn = excluded.ticket_mxn,
          kilos_totales = excluded.kilos_totales, primer_pedido = excluded.primer_pedido, ultimo_pedido = excluded.ultimo_pedido,
          estado = excluded.estado, revision_humana = excluded.revision_humana, banderas = excluded.banderas,
          origen_lote = excluded.origen_lote, huella = excluded.huella, updated_at = now();

        delete from restaurantes.customer_quejas_historicas where customer_id = v_cust;
        insert into restaurantes.customer_quejas_historicas (customer_id, organization_id, categoria, origen_lote)
        select v_cust, p_organization_id, q, v_lote from unnest(v_quejas) q on conflict do nothing;

        if v_dir is not null then
          insert into restaurantes.customer_addresses (customer_id, address, label, colonia, is_default)
          values (v_cust, v_dir, 'Histórico', v_col,
                  not exists (select 1 from restaurantes.customer_addresses a where a.customer_id = v_cust))
          on conflict (customer_id, address) do update set colonia = coalesce(restaurantes.customer_addresses.colonia, excluded.colonia);
        end if;
      end if;

      if p_aplicar then
        insert into restaurantes.import_historico_fila (lote_id, fila_n, customer_id, accion, banderas, huella_fila)
        values (v_lote, v_row.n, v_cust, v_accion, v_banderas, v_huella)
        on conflict (lote_id, fila_n) do update set customer_id = excluded.customer_id, accion = excluded.accion, banderas = excluded.banderas, huella_fila = excluded.huella_fila;
      end if;

      if v_accion = 'crear' then v_creadas := v_creadas + 1;
      elsif v_accion = 'actualizar' then v_actualizadas := v_actualizadas + 1;
      else v_sin_cambios := v_sin_cambios + 1;
      end if;
    exception when invalid_text_representation or check_violation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
      v_rechazadas := v_rechazadas + 1;
    end;
  end loop;

  if p_aplicar then
    update restaurantes.import_historico_lote set creadas = v_creadas, actualizadas = v_actualizadas, sin_cambios = v_sin_cambios,
           rechazadas = v_rechazadas, suprimidas = v_suprimidas
     where id = v_lote;
  end if;

  return jsonb_build_object('modo', case when p_aplicar then 'aplicado' else 'vista_previa' end, 'lote_id', v_lote,
                            'creadas', v_creadas, 'actualizadas', v_actualizadas, 'sin_cambios', v_sin_cambios,
                            'rechazadas', v_rechazadas, 'suprimidas', v_suprimidas);
end;
$$;
revoke all on function restaurantes.importar_historial(uuid, text, boolean, jsonb) from public, anon;
grant execute on function restaurantes.importar_historial(uuid, text, boolean, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) cliente_perfil_historico -- SOLO SISTEMA (como cliente_memoria). null si el cliente no tiene historial importado.
--    Devuelve gasto y quejas para que el servidor calcule segmentos; el TypeScript NUNCA los pasa al prompt del agente.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cliente_perfil_historico(p_organization_id uuid, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_cust uuid;
  v_h restaurantes.customer_historial_resumen;
begin
  if auth.uid() is not null then
    raise exception 'cliente_perfil_historico es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_phone is null or btrim(p_phone) = '' then
    raise exception 'invalid args' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_organization_id and o.vertical = 'restaurantes') then
    raise exception 'organizacion inexistente o de otro vertical' using errcode = '42501';
  end if;
  select c.id into v_cust from restaurantes.customers c where c.organization_id = p_organization_id and c.phone = p_phone;
  if v_cust is null then
    return null;
  end if;
  select * into v_h from restaurantes.customer_historial_resumen h where h.customer_id = v_cust;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'nombre', (select c.name from restaurantes.customers c where c.id = v_cust),
    'domicilios', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'etiqueta', a.label, 'colonia', a.colonia, 'importado', a.label = 'Histórico',
               'ultimo_uso', a.last_used_at,
               'colonia_inferida', (a.label = 'Histórico' and (v_h.banderas && array['colonia_inferida_alta', 'colonia_inferida_media'])),
               'sin_colonia', a.colonia is null
             ) order by a.last_used_at desc nulls last, a.is_default desc, a.created_at desc), '[]'::jsonb)
        from restaurantes.customer_addresses a where a.customer_id = v_cust),
    'historico', jsonb_build_object(
      'canal', v_h.canal, 'pago', v_h.pago, 'tortilla', v_h.tortilla, 'salsas', to_jsonb(v_h.salsas), 'omisiones', to_jsonb(v_h.omisiones),
      'favoritos', to_jsonb(v_h.favoritos), 'pedidos', v_h.pedidos, 'gasto_mxn', v_h.gasto_mxn, 'ticket_mxn', v_h.ticket_mxn,
      'primer_pedido', v_h.primer_pedido, 'ultimo_pedido', v_h.ultimo_pedido, 'revision_humana', v_h.revision_humana,
      'quejas', (select coalesce(jsonb_agg(q.categoria order by q.categoria), '[]'::jsonb) from restaurantes.customer_quejas_historicas q where q.customer_id = v_cust)
    )
  );
end;
$$;
revoke all on function restaurantes.cliente_perfil_historico(uuid, text) from public, anon;
grant execute on function restaurantes.cliente_perfil_historico(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) ARCO: exportar y borrar lo importado de un titular (owner/admin). Borrar suprime la reimportacion.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.historial_exportar(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'historial_exportar: solo owner/admin' using errcode = '42501';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    return null;
  end if;
  return jsonb_build_object(
    'resumen', (select to_jsonb(h) - 'organization_id' from restaurantes.customer_historial_resumen h where h.customer_id = p_customer_id),
    'quejas', (select coalesce(jsonb_agg(q.categoria order by q.categoria), '[]'::jsonb) from restaurantes.customer_quejas_historicas q where q.customer_id = p_customer_id),
    'importaciones', (select count(*) from restaurantes.import_historico_fila f where f.customer_id = p_customer_id)
  );
end;
$$;
revoke all on function restaurantes.historial_exportar(uuid, uuid) from public, anon;
grant execute on function restaurantes.historial_exportar(uuid, uuid) to authenticated;

create or replace function restaurantes.historial_borrar(p_organization_id uuid, p_customer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_phone text;
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'historial_borrar: solo owner/admin' using errcode = '42501';
  end if;
  select c.phone into v_phone from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id;
  if v_phone is null then
    return false;
  end if;
  insert into restaurantes.import_historico_supresion (organization_id, phone_hash)
  values (p_organization_id, encode(sha256(convert_to(p_organization_id::text || ':' || v_phone, 'utf8')), 'hex'))
  on conflict do nothing;
  delete from restaurantes.customer_historial_resumen where customer_id = p_customer_id;
  delete from restaurantes.customer_quejas_historicas where customer_id = p_customer_id;
  delete from restaurantes.customer_addresses where customer_id = p_customer_id and label = 'Histórico';
  update restaurantes.import_historico_fila set customer_id = null where customer_id = p_customer_id;
  return true;
end;
$$;
revoke all on function restaurantes.historial_borrar(uuid, uuid) from public, anon;
grant execute on function restaurantes.historial_borrar(uuid, uuid) to authenticated;
