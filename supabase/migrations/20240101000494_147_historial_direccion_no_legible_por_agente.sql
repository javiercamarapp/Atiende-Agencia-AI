-- 147 (revision P-5): la calle y el numero importados NO quedan en `customer_addresses`, que lee buscar_cliente (cliente_memoria/cliente_direcciones_json).
-- Antes de este cambio un telefono reasignado o un tercero con acceso al numero podia recibir la calle de otra persona por el flujo normal del agente.
--  * La direccion importada vive en `customer_historial_resumen.direccion_importada` (+ colonia_importada): solo se lee por ARCO (exportar) y por funciones de staff.
--  * `cliente_perfil_historico` (solo sistema) expone al agente UNICAMENTE etiqueta y colonia del domicilio historico; la calle se vuelve a pedir al cliente.
--  * importar_historial deja de insertar en customer_addresses.
-- REVERSA: volver a las definiciones de 144 (importar_historial) y 140 (cliente_perfil_historico); alter table ... drop column direccion_importada, colonia_importada.
alter table restaurantes.customer_historial_resumen
  add column if not exists direccion_importada text check (direccion_importada is null or char_length(direccion_importada) <= 300),
  add column if not exists colonia_importada text check (colonia_importada is null or char_length(colonia_importada) <= 120);

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
           primer_pedido, ultimo_pedido, estado, revision_humana, banderas, origen_lote, huella, direccion_importada, colonia_importada)
        values
          (v_cust, p_organization_id, nullif(v_row.j ->> 'canal', ''), nullif(v_row.j ->> 'pago', ''), nullif(v_row.j ->> 'tortilla', ''),
           restaurantes.hist_texto_array(v_row.j -> 'salsas'), restaurantes.hist_texto_array(v_row.j -> 'omisiones'), restaurantes.hist_texto_array(v_row.j -> 'favoritos'),
           v_pedidos, v_gasto, v_ticket, v_kilos, v_primer, v_ultimo, nullif(v_row.j ->> 'estado', ''),
           'revision_humana' = any (v_banderas), v_banderas, v_lote, v_huella, v_dir, v_col)
        on conflict (customer_id) do update set
          canal = excluded.canal, pago = excluded.pago, tortilla = excluded.tortilla, salsas = excluded.salsas, omisiones = excluded.omisiones,
          favoritos = excluded.favoritos, pedidos = excluded.pedidos, gasto_mxn = excluded.gasto_mxn, ticket_mxn = excluded.ticket_mxn,
          kilos_totales = excluded.kilos_totales, primer_pedido = excluded.primer_pedido, ultimo_pedido = excluded.ultimo_pedido,
          estado = excluded.estado, revision_humana = excluded.revision_humana, banderas = excluded.banderas,
          origen_lote = excluded.origen_lote, huella = excluded.huella,
          direccion_importada = excluded.direccion_importada, colonia_importada = excluded.colonia_importada, updated_at = now();

        delete from restaurantes.customer_quejas_historicas where customer_id = v_cust;
        insert into restaurantes.customer_quejas_historicas (customer_id, organization_id, categoria, origen_lote)
        select v_cust, p_organization_id, q, v_lote from unnest(v_quejas) q on conflict do nothing;

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
      select coalesce(jsonb_agg(d.j order by d.orden), '[]'::jsonb) from (
        select 0 as orden, jsonb_build_object('etiqueta', 'Histórico', 'colonia', v_h.colonia_importada, 'importado', true, 'ultimo_uso', null,
                 'colonia_inferida', (v_h.banderas && array['colonia_inferida_alta', 'colonia_inferida_media']),
                 'sin_colonia', v_h.colonia_importada is null) as j
         where v_h.colonia_importada is not null or v_h.direccion_importada is not null
        union all
        select 1, jsonb_build_object('etiqueta', a.label, 'colonia', a.colonia, 'importado', false, 'ultimo_uso', a.last_used_at, 'colonia_inferida', false, 'sin_colonia', a.colonia is null)
          from restaurantes.customer_addresses a where a.customer_id = v_cust and coalesce(a.label, '') <> 'Histórico'
      ) d),
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
