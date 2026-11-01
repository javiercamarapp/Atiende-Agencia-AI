-- 144 (revision P-3): la lista de supresion ARCO ya NO guarda sha256(org:telefono) (invertible: el espacio de telefonos de 10 digitos es enumerable).
-- Ahora guarda HMAC-SHA256(org:telefono) con una pimienta secreta que NO vive en la tabla de supresion ni en el repositorio:
--   * tabla `historial_config` (una fila, sin ningun GRANT; solo las funciones definer la leen). La migracion GENERA una pimienta aleatoria de 32 bytes
--     dentro de la base (nunca pasa por el repo ni por un log). El operador puede rotarla/sustituirla con un UPDATE de superusuario (ver plan).
--   * limite conocido: un respaldo completo de la base contiene tambien la pimienta. Para protegerla de un dump de la lista, el siguiente paso es llevarla
--     a Supabase Vault o a una variable del servidor (pendiente, documentado en el informe de la rama).
-- Plan de transicion (sin romper hashes existentes): `import_historico_supresion.hash_version` 1 = sha256 heredado (140), 2 = HMAC.
--   * historial_suprimido() consulta AMBAS versiones (v1 por compatibilidad), asi que nadie suprimido antes queda revivible.
--   * historial_suprimir() escribe SOLO v2 y, como conoce el telefono, borra el v1 equivalente (migracion oportunista).
--   * Los v1 que nadie vuelva a tocar no se pueden re-hashear (el telefono no se guarda): quedan hasta que se importe de nuevo ese numero o hasta una
--     depuracion por retencion decidida por el responsable.
--   * Sin pimienta (fila ausente/corta) las funciones fallan cerrado (55000): jamas se escribe un hash debil.
-- REVERSA: drop function restaurantes.historial_suprimir(uuid, text), restaurantes.historial_suprimido(uuid, text), restaurantes.historial_phone_hash(uuid, text);
--          drop table restaurantes.historial_config; alter table restaurantes.import_historico_supresion drop column hash_version;
create extension if not exists pgcrypto;

create table if not exists restaurantes.historial_config (
  id smallint primary key check (id = 1),
  pepper text not null check (length(pepper) >= 32),
  created_at timestamptz not null default now()
);
alter table restaurantes.historial_config enable row level security;
revoke all on restaurantes.historial_config from public, anon, authenticated, service_role;
insert into restaurantes.historial_config (id, pepper) values (1, encode(gen_random_bytes(32), 'hex')) on conflict (id) do nothing;

alter table restaurantes.import_historico_supresion add column if not exists hash_version smallint not null default 1;
alter table restaurantes.import_historico_supresion drop constraint if exists import_historico_supresion_hash_version_check;
alter table restaurantes.import_historico_supresion add constraint import_historico_supresion_hash_version_check check (hash_version in (1, 2));

-- Internas (sin EXECUTE para nadie salvo el dueno: las llaman funciones definer ya autorizadas).
create or replace function restaurantes.historial_phone_hash(p_organization_id uuid, p_phone text)
returns text
language plpgsql
stable
security definer
set search_path = restaurantes, extensions, public, pg_temp
as $$
declare
  v_pepper text;
begin
  select c.pepper into v_pepper from restaurantes.historial_config c where c.id = 1;
  if v_pepper is null or length(v_pepper) < 32 then
    raise exception 'historial: pimienta de supresion no configurada' using errcode = '55000';
  end if;
  return encode(hmac(convert_to(p_organization_id::text || ':' || p_phone, 'utf8'), convert_to(v_pepper, 'utf8'), 'sha256'), 'hex');
end;
$$;
revoke all on function restaurantes.historial_phone_hash(uuid, text) from public, anon, authenticated;

create or replace function restaurantes.historial_suprimido(p_organization_id uuid, p_phone text)
returns boolean
language sql
stable
security definer
set search_path = restaurantes, extensions, public, pg_temp
as $$
  select exists (
    select 1 from restaurantes.import_historico_supresion s
     where s.organization_id = p_organization_id
       and ((s.hash_version = 2 and s.phone_hash = restaurantes.historial_phone_hash(p_organization_id, p_phone))
         or (s.hash_version = 1 and s.phone_hash = encode(sha256(convert_to(p_organization_id::text || ':' || p_phone, 'utf8')), 'hex')))
  );
$$;
revoke all on function restaurantes.historial_suprimido(uuid, text) from public, anon, authenticated;

create or replace function restaurantes.historial_suprimir(p_organization_id uuid, p_phone text)
returns void
language plpgsql
security definer
set search_path = restaurantes, extensions, public, pg_temp
as $$
begin
  insert into restaurantes.import_historico_supresion (organization_id, phone_hash, hash_version)
  values (p_organization_id, restaurantes.historial_phone_hash(p_organization_id, p_phone), 2)
  on conflict (organization_id, phone_hash) do nothing;
  delete from restaurantes.import_historico_supresion s
   where s.organization_id = p_organization_id and s.hash_version = 1
     and s.phone_hash = encode(sha256(convert_to(p_organization_id::text || ':' || p_phone, 'utf8')), 'hex');
end;
$$;
revoke all on function restaurantes.historial_suprimir(uuid, text) from public, anon, authenticated;

-- importar_historial: usa historial_suprimido (HMAC + heredado) y migra el v1 al aplicar.
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
      if restaurantes.historial_suprimido(p_organization_id, v_phone) then
        if p_aplicar then
          perform restaurantes.historial_suprimir(p_organization_id, v_phone); -- migra el hash heredado (v1) a HMAC (v2)
        end if;
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

-- historial_borrar: escribe la supresion con HMAC.
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
  perform restaurantes.historial_suprimir(p_organization_id, v_phone);
  delete from restaurantes.customer_historial_resumen where customer_id = p_customer_id;
  delete from restaurantes.customer_quejas_historicas where customer_id = p_customer_id;
  delete from restaurantes.customer_addresses where customer_id = p_customer_id and label = 'Histórico';
  update restaurantes.import_historico_fila set customer_id = null where customer_id = p_customer_id;
  return true;
end;
$$;
revoke all on function restaurantes.historial_borrar(uuid, uuid) from public, anon;
grant execute on function restaurantes.historial_borrar(uuid, uuid) to authenticated;
