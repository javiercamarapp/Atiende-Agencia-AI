-- 145 (revision P-1 y P-2): los derechos ARCO cubren el historial importado y el borrado es real.
-- Requiere 049/075 (cliente_exportar_arco, cliente_borrar_memoria), 140 y 144.
--  * cliente_exportar_arco / cliente_borrar_memoria (las que usa la API) se ENVUELVEN sin copiar ni tocar su cuerpo: las definiciones vigentes se
--    renombran a *_base (una sola vez, idempotente; conservan su validacion de owner/admin con alcance de organizacion) y las funciones publicas
--    del mismo nombre y firma las llaman y ANADEN lo nuevo. Asi no se redefine mal nada de 049/075 y una redefinicion futura de la base sigue valiendo.
--  * Exportar agrega: resumen historico (con la direccion y la colonia importadas), categorias de queja, numero de importaciones y el consentimiento de
--    marketing (estado actual + historial de eventos).
--  * Borrar agrega: resumen, quejas, domicilios historicos, vinculo de filas de importacion, REVOCACION del consentimiento de marketing (con evento),
--    la supresion (HMAC) para que reimportar el archivo no reviva al titular, y -- P-2 -- si el cliente existe solo por la importacion y no tiene
--    pedidos, la fila de `customers` (nombre y telefono) se ELIMINA; si tiene pedidos (retencion legitima) se anonimiza (nombre, notas y fecha de nacimiento).
--  * historial_exportar / historial_borrar (140) quedan como el mismo comportamiento por una puerta que solo toca el historial.
-- REVERSA: renombrar *_base a su nombre original (drop de las envolventes) y volver a las definiciones de 140 de historial_exportar/borrar.
do $$
begin
  if to_regprocedure('restaurantes.cliente_exportar_arco_base(uuid,uuid)') is null then
    alter function restaurantes.cliente_exportar_arco(uuid, uuid) rename to cliente_exportar_arco_base;
  end if;
  if to_regprocedure('restaurantes.cliente_borrar_memoria_base(uuid,uuid)') is null then
    alter function restaurantes.cliente_borrar_memoria(uuid, uuid) rename to cliente_borrar_memoria_base;
  end if;
end $$;
revoke all on function restaurantes.cliente_exportar_arco_base(uuid, uuid) from public, anon, authenticated;
revoke all on function restaurantes.cliente_borrar_memoria_base(uuid, uuid) from public, anon, authenticated;

create or replace function restaurantes.historial_exportar_interno(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select jsonb_build_object(
    'resumen', (select to_jsonb(h) - 'organization_id' from restaurantes.customer_historial_resumen h where h.customer_id = p_customer_id),
    'quejas', (select coalesce(jsonb_agg(q.categoria order by q.categoria), '[]'::jsonb) from restaurantes.customer_quejas_historicas q where q.customer_id = p_customer_id),
    'importaciones', (select count(*) from restaurantes.import_historico_fila f where f.customer_id = p_customer_id),
    'consentimiento_marketing', jsonb_build_object(
      'actual', (select coalesce(jsonb_agg(jsonb_build_object('canal', m.canal, 'estado', m.estado, 'fuente', m.fuente, 'version_aviso', m.version_aviso,
                                                              'otorgado_at', m.otorgado_at, 'revocado_at', m.revocado_at) order by m.canal), '[]'::jsonb)
                   from restaurantes.marketing_consentimiento m where m.organization_id = p_organization_id and m.customer_id = p_customer_id),
      'eventos', (select coalesce(jsonb_agg(jsonb_build_object('canal', e.canal, 'estado', e.estado, 'fuente', e.fuente, 'version_aviso', e.version_aviso,
                                                               'fecha', e.ocurrido_at) order by e.ocurrido_at), '[]'::jsonb)
                    from restaurantes.marketing_consentimiento_evento e where e.organization_id = p_organization_id and e.customer_id = p_customer_id)
    )
  );
$$;
revoke all on function restaurantes.historial_exportar_interno(uuid, uuid) from public, anon, authenticated;

create or replace function restaurantes.historial_borrar_interno(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_phone text;
  v_origen text;
  v_resumen integer;
  v_quejas integer;
  v_domicilios integer;
  v_consent integer;
  v_eliminado boolean := false;
begin
  select c.phone, c.origen into v_phone, v_origen from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id;
  if v_phone is null then
    return null;
  end if;
  -- La supresion va PRIMERO: aunque algo falle despues, un re-run del archivo no revive al titular.
  perform restaurantes.historial_suprimir(p_organization_id, v_phone);

  delete from restaurantes.customer_historial_resumen where customer_id = p_customer_id;
  get diagnostics v_resumen = row_count;
  delete from restaurantes.customer_quejas_historicas where customer_id = p_customer_id;
  get diagnostics v_quejas = row_count;
  delete from restaurantes.customer_addresses where customer_id = p_customer_id and label = 'Histórico';
  get diagnostics v_domicilios = row_count;
  update restaurantes.import_historico_fila set customer_id = null where customer_id = p_customer_id;

  -- Consentimiento de marketing: se REVOCA (con evento) en vez de dejarlo vigente.
  with u as (
    update restaurantes.marketing_consentimiento m
       set estado = 'revocado', revocado_at = coalesce(m.revocado_at, now()), updated_at = now()
     where m.organization_id = p_organization_id and m.customer_id = p_customer_id and m.estado <> 'revocado'
    returning m.canal, m.version_aviso
  ), ev as (
    insert into restaurantes.marketing_consentimiento_evento (organization_id, customer_id, canal, estado, fuente, version_aviso)
    select p_organization_id, p_customer_id, u.canal, 'revocado', 'panel', u.version_aviso from u
    returning 1
  )
  select count(*) into v_consent from ev;

  if v_origen = 'importacion_historica' and not exists (select 1 from restaurantes.orders o where o.customer_id = p_customer_id) then
    delete from restaurantes.customers where id = p_customer_id;
    v_eliminado := true;
  else
    update restaurantes.customers
       set name = null, notes = null, staff_notes = null, import_nombre = null, import_notas = null,
           fecha_nacimiento_dia = null, fecha_nacimiento_mes = null, updated_at = now()
     where id = p_customer_id;
  end if;
  return jsonb_build_object('resumen_borrado', v_resumen, 'quejas_borradas', v_quejas, 'domicilios_historicos_borrados', v_domicilios,
                            'consentimientos_revocados', v_consent, 'cliente_eliminado', v_eliminado);
end;
$$;
revoke all on function restaurantes.historial_borrar_interno(uuid, uuid) from public, anon, authenticated;

create or replace function restaurantes.cliente_exportar_arco(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_base jsonb;
begin
  v_base := restaurantes.cliente_exportar_arco_base(p_organization_id, p_customer_id); -- valida owner/admin con alcance de organizacion
  if v_base is null then
    return null;
  end if;
  return v_base || jsonb_build_object('historial_importado', restaurantes.historial_exportar_interno(p_organization_id, p_customer_id));
end;
$$;
revoke all on function restaurantes.cliente_exportar_arco(uuid, uuid) from public, anon;
grant execute on function restaurantes.cliente_exportar_arco(uuid, uuid) to authenticated;

create or replace function restaurantes.cliente_borrar_memoria(p_organization_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_base jsonb;
begin
  v_base := restaurantes.cliente_borrar_memoria_base(p_organization_id, p_customer_id); -- valida owner/admin y que el cliente sea de la organizacion
  return v_base || jsonb_build_object('historial_importado', restaurantes.historial_borrar_interno(p_organization_id, p_customer_id));
end;
$$;
revoke all on function restaurantes.cliente_borrar_memoria(uuid, uuid) from public, anon;
grant execute on function restaurantes.cliente_borrar_memoria(uuid, uuid) to authenticated;

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
  return restaurantes.historial_exportar_interno(p_organization_id, p_customer_id);
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
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'historial_borrar: solo owner/admin' using errcode = '42501';
  end if;
  return restaurantes.historial_borrar_interno(p_organization_id, p_customer_id) is not null;
end;
$$;
revoke all on function restaurantes.historial_borrar(uuid, uuid) from public, anon;
grant execute on function restaurantes.historial_borrar(uuid, uuid) to authenticated;
