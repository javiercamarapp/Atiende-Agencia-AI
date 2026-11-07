-- 149 (revision P-10): toda importacion que ESCRIBE debe declarar la base legal y el origen del archivo; quedan en el lote (auditoria).
--  * import_historico_lote.base_legal in (aviso_privacidad_vigente, consentimiento_titular, relacion_comercial_previa, otra_documentada)
--  * import_historico_lote.origen_declarado: texto de 5 a 300 caracteres (de donde salio el archivo y bajo que aviso se capturo; SIN datos personales).
--  * La vista previa (p_aplicar = false) no los exige. Sin ellos, aplicar falla con 22023 antes de escribir nada.
--  * Se reemplaza la firma de 4 argumentos por una de 6 (los dos nuevos con default null, para que la vista previa de 4 argumentos siga funcionando).
-- Es documentacion operativa, no asesoria legal: el responsable (PM) valida la base legal con su asesor antes de una carga real.
-- REVERSA: volver a 147; alter table ... drop column base_legal, origen_declarado.
alter table restaurantes.import_historico_lote
  add column if not exists base_legal text,
  add column if not exists origen_declarado text;
alter table restaurantes.import_historico_lote drop constraint if exists import_historico_lote_base_legal_check;
alter table restaurantes.import_historico_lote add constraint import_historico_lote_base_legal_check
  check (base_legal is null or base_legal in ('aviso_privacidad_vigente', 'consentimiento_titular', 'relacion_comercial_previa', 'otra_documentada'));

drop function if exists restaurantes.importar_historial(uuid, text, boolean, jsonb);
create or replace function restaurantes.importar_historial(p_organization_id uuid, p_archivo_sha256 text, p_aplicar boolean, p_filas jsonb, p_base_legal text default null, p_origen_declarado text default null)
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
    if p_base_legal is null or p_base_legal not in ('aviso_privacidad_vigente', 'consentimiento_titular', 'relacion_comercial_previa', 'otra_documentada') then
      raise exception 'importar_historial: declara la base legal del archivo (aviso_privacidad_vigente, consentimiento_titular, relacion_comercial_previa u otra_documentada)' using errcode = '22023';
    end if;
    if p_origen_declarado is null or char_length(btrim(p_origen_declarado)) not between 5 and 300 then
      raise exception 'importar_historial: declara el origen del archivo (5 a 300 caracteres, sin datos personales)' using errcode = '22023';
    end if;
    insert into restaurantes.import_historico_lote (organization_id, archivo_sha256, filas_total, creado_por, base_legal, origen_declarado)
    values (p_organization_id, p_archivo_sha256, jsonb_array_length(p_filas), auth.uid(), p_base_legal, btrim(p_origen_declarado))
    on conflict (organization_id, archivo_sha256) do update set creado_at = now(), filas_total = excluded.filas_total,
      base_legal = excluded.base_legal, origen_declarado = excluded.origen_declarado
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
revoke all on function restaurantes.importar_historial(uuid, text, boolean, jsonb, text, text) from public, anon;
grant execute on function restaurantes.importar_historial(uuid, text, boolean, jsonb, text, text) to authenticated;
