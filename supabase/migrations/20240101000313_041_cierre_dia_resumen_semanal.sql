-- R-42: cierre del dia y resumen semanal por sucursal, idempotentes por fecha de negocio.
-- Prefijo de supabase/migrations: 20240101000313 (interno restaurantes 041).
-- Requiere: 001 (orders), 022 (branch_detail.zona_horaria), 028 (handoff_actor_en_sucursal), 034 (programado/promovido_at),
-- 035 (voz_zona_horaria), 037 (demo_organization).
--
-- Que agrega (todo NUEVO; ninguna tabla ni restriccion existente se modifica):
--   * restaurantes.cierre_reporte                -- un reporte congelado por (sucursal, tipo, fecha de negocio de inicio).
--   * restaurantes.cierre_agregados(...)         -- helper interno: agregados de un rango (ventas, canales, cancelaciones, tiempos).
--   * restaurantes.generar_cierre(...)           -- genera UNA vez el cierre del dia o de la semana; reintentar devuelve el mismo.
--   * restaurantes.cierre_sucursales_sistema()   -- lista de sucursales a barrer (solo sistema, sin demo).
--
-- Definiciones (los rotulos de la pantalla las repiten tal cual):
--   * Fecha de negocio = dia calendario en la zona horaria de la SUCURSAL (restaurantes.voz_zona_horaria). Un cierre "dia"
--     es de UNA fecha; un cierre "semana" va de lunes a domingo (fecha_inicio = lunes) y se calcula sobre pedidos, no sumando
--     cierres diarios (asi no depende de que existan todos).
--   * Un pedido cuenta en la fecha en que ENTRA a operar: promovido_at si fue programado (034), si no created_at.
--   * Venta = pedido que no es cancelado, programado (aun no entra a operar) ni no_recogido. ventas_centavos = suma de
--     orders.total en centavos (entero). Ticket promedio = ventas / pedidos (null sin pedidos). Cancelados y no_recogidos se
--     reportan aparte; cancelacion_pct = cancelados / (pedidos + cancelados), null sin ninguno.
--   * Tiempo de entrega = delivered_at - inicio, solo de pedidos con status 'entregado' y delivered_at no nulo; promedio,
--     mediana y p90 en minutos (null si no hubo). Es el unico tiempo que la base registra con exactitud.
--   * Comparativo = mismo periodo anterior (dia: mismo dia de la semana pasada; semana: semana anterior).
--   * Trafico demo (telefono del rango 0009) se excluye; las organizaciones demo no se barren.
--   * Sin PII: solo agregados; no se lee ni se guarda nombre, telefono ni direccion.
--   * Congelado: un cierre ya generado NO se recalcula (si un pedido cambia de estado despues, el reporte conserva lo
--     reportado ese dia). Es el comportamiento buscado de un cierre; el panel lo rotula con la hora de generacion.
--   * Un cierre solo se genera de un periodo YA TERMINADO en la zona de la sucursal (fecha_fin < hoy local); asi nunca se
--     congela un dia a medias.
--
-- Justificacion de seguridad (una por una):
--  * restaurantes.cierre_reporte -- RLS activa. SELECT para authenticated solo via la policy `owner/admin lee los cierres`
--    (handoff_actor_en_sucursal(org, property, true): owner/admin de ESA organizacion con alcance a la sucursal; el cierre es
--    informacion comercial, igual que 035/040). Sin GRANT de INSERT/UPDATE/DELETE a authenticated ni a anon: la unica escritura
--    es generar_cierre (definer). service_role conserva acceso total por convencion del esquema (no lo usa el backend).
--  * restaurantes.cierre_agregados -- helper de lectura sin guard propio; `revoke all from public, anon, authenticated`: solo
--    lo ejecuta el duenio de la funcion invocante (generar_cierre), que ya valido el acceso. Todo filtro lleva organization_id
--    Y property_id.
--  * restaurantes.generar_cierre -- SECURITY DEFINER, search_path fijo (restaurantes, core, pg_temp), `revoke ... from public,
--    anon`, `grant execute` a authenticated (la sesion de sistema del backend corre con ese rol sin usuario). Doble puerta:
--      - sesion de sistema (auth.uid() nulo): permitida SOLO si la sucursal pertenece a la organizacion declarada (un barrido
--        no puede cruzar tenants por un parametro mal armado); es el camino del endpoint interno.
--      - usuario: exige owner/admin con alcance a la sucursal; 42501 igual para sucursal ajena o inexistente.
--    Inserta con ON CONFLICT DO NOTHING sobre la llave unica (idempotente aun con dos llamadas simultaneas).
--  * restaurantes.cierre_sucursales_sistema -- solo sistema: exige auth.uid() is null (un usuario recibe 42501); definer con
--    search_path fijo; revoke de public/anon; grant a authenticated por la misma razon que arriba. Devuelve ids y zona, sin PII.

create table restaurantes.cierre_reporte (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  tipo text not null check (tipo in ('dia', 'semana')),
  fecha_inicio date not null,
  fecha_fin date not null,
  zona_horaria text not null check (char_length(zona_horaria) between 1 and 64),
  datos jsonb not null check (jsonb_typeof(datos) = 'object'),
  generado_por text not null check (generado_por in ('sistema', 'staff')),
  generado_at timestamptz not null default now(),
  unique (property_id, tipo, fecha_inicio),
  check (
    (tipo = 'dia' and fecha_fin = fecha_inicio)
    or (tipo = 'semana' and fecha_fin = fecha_inicio + 6 and extract(isodow from fecha_inicio) = 1)
  )
);
create index cierre_reporte_org_prop_fecha_idx on restaurantes.cierre_reporte (organization_id, property_id, tipo, fecha_inicio desc);

alter table restaurantes.cierre_reporte enable row level security;

create policy "owner/admin lee los cierres" on restaurantes.cierre_reporte for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

revoke all on restaurantes.cierre_reporte from public, anon, authenticated;
grant select on restaurantes.cierre_reporte to authenticated;
grant select, insert, update, delete on restaurantes.cierre_reporte to service_role;

-- ---------------------------------------------------------------------------
-- Agregados de un rango [p_ini, p_fin) de una sucursal.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cierre_agregados(
  p_organization_id uuid,
  p_property_id uuid,
  p_ini timestamptz,
  p_fin timestamptz
) returns jsonb
language sql
stable
set search_path = restaurantes, core, pg_temp
as $$
  with base as (
    select o.status, o.source, o.total,
           coalesce(o.promovido_at, o.created_at) as inicio,
           o.delivered_at
    from restaurantes.orders o
    where o.organization_id = p_organization_id and o.property_id = p_property_id
      and o.status <> 'programado'
      and coalesce(o.promovido_at, o.created_at) >= p_ini and coalesce(o.promovido_at, o.created_at) < p_fin
      and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) not like '0009%'
  ),
  ventas as (
    select * from base where status not in ('cancelado', 'no_recogido')
  ),
  canales as (
    select c.canal,
           (select count(*) from ventas v where v.source = c.canal) as pedidos,
           (select coalesce(round(sum(v.total) * 100), 0) from ventas v where v.source = c.canal) as ventas_centavos,
           (select count(*) from base b where b.source = c.canal and b.status = 'cancelado') as cancelados
    from (values ('web'), ('whatsapp'), ('voice'), ('admin')) as c(canal)
  ),
  tiempos as (
    select count(*) as n,
           avg(extract(epoch from (delivered_at - inicio)) / 60.0) as prom,
           percentile_cont(0.5) within group (order by extract(epoch from (delivered_at - inicio)) / 60.0) as med,
           percentile_cont(0.9) within group (order by extract(epoch from (delivered_at - inicio)) / 60.0) as p90
    from base
    where status = 'entregado' and delivered_at is not null and delivered_at >= inicio
  )
  select jsonb_build_object(
    'pedidos', (select count(*) from ventas),
    'ventas_centavos', (select coalesce(round(sum(total) * 100), 0)::bigint from ventas),
    'ticket_promedio_centavos', (select case when count(*) = 0 then null else round(sum(total) * 100 / count(*))::bigint end from ventas),
    'con_problema', (select count(*) from ventas where status = 'problema'),
    'cancelados', (select count(*) from base where status = 'cancelado'),
    'cancelados_centavos', (select coalesce(round(sum(total) * 100), 0)::bigint from base where status = 'cancelado'),
    'no_recogidos', (select count(*) from base where status = 'no_recogido'),
    'cancelacion_pct', (select case when (select count(*) from ventas) + count(*) = 0 then null
                                    else round(count(*) * 100.0 / ((select count(*) from ventas) + count(*)), 1) end
                        from base where status = 'cancelado'),
    'por_canal', (select jsonb_agg(jsonb_build_object('canal', canal, 'pedidos', pedidos, 'ventas_centavos', ventas_centavos, 'cancelados', cancelados) order by canal) from canales),
    'tiempos', (select jsonb_build_object(
                  'entregados', n,
                  'promedio_min', case when n = 0 then null else round(prom::numeric, 1) end,
                  'mediana_min', case when n = 0 then null else round(med::numeric, 1) end,
                  'p90_min', case when n = 0 then null else round(p90::numeric, 1) end) from tiempos),
    'pedidos_totales_incl_cancelados', (select count(*) from base)
  );
$$;

revoke all on function restaurantes.cierre_agregados(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Genera (una sola vez) el cierre de un periodo terminado.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.generar_cierre(
  p_organization_id uuid,
  p_property_id uuid,
  p_tipo text,
  p_fecha_inicio date,
  p_omitir_sin_actividad boolean default false
) returns table (
  creado boolean,
  id uuid,
  tipo text,
  fecha_inicio date,
  fecha_fin date,
  zona_horaria text,
  datos jsonb,
  generado_por text,
  generado_at timestamptz
)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_tz text;
  v_fin date;
  v_ini_ts timestamptz;
  v_fin_ts timestamptz;
  v_datos jsonb;
  v_ant jsonb;
  v_comp_ini date;
  v_comp_fin date;
  v_dias jsonb;
  v_hoy date;
  v_row restaurantes.cierre_reporte;
  v_creado boolean := false;
  v_por text;
begin
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'generar_cierre: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if auth.uid() is null then
    v_por := 'sistema';
  else
    if not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
      raise exception 'generar_cierre: sin acceso a la sucursal' using errcode = '42501';
    end if;
    v_por := 'staff';
  end if;
  if p_tipo not in ('dia', 'semana') or p_fecha_inicio is null then
    raise exception 'generar_cierre: tipo o fecha invalidos' using errcode = '22023';
  end if;
  if p_tipo = 'semana' and extract(isodow from p_fecha_inicio) <> 1 then
    raise exception 'generar_cierre: la semana empieza en lunes' using errcode = '22023';
  end if;

  v_tz := restaurantes.voz_zona_horaria(p_property_id);
  v_fin := case when p_tipo = 'dia' then p_fecha_inicio else p_fecha_inicio + 6 end;
  v_hoy := (now() at time zone v_tz)::date;
  if v_fin >= v_hoy then
    raise exception 'generar_cierre: el periodo aun no termina en la zona de la sucursal' using errcode = '22023';
  end if;

  select * into v_row from restaurantes.cierre_reporte r where r.property_id = p_property_id and r.tipo = p_tipo and r.fecha_inicio = p_fecha_inicio;
  if not found then
    v_ini_ts := p_fecha_inicio::timestamp at time zone v_tz;
    v_fin_ts := (v_fin + 1)::timestamp at time zone v_tz;
    v_datos := restaurantes.cierre_agregados(p_organization_id, p_property_id, v_ini_ts, v_fin_ts);

    if p_omitir_sin_actividad and (v_datos ->> 'pedidos_totales_incl_cancelados')::int = 0 then
      return query select false, null::uuid, p_tipo, p_fecha_inicio, v_fin, v_tz, v_datos, v_por, null::timestamptz;
      return;
    end if;

    v_comp_ini := p_fecha_inicio - 7;
    v_comp_fin := case when p_tipo = 'dia' then v_comp_ini else v_comp_ini + 6 end;
    v_ant := restaurantes.cierre_agregados(
      p_organization_id, p_property_id,
      v_comp_ini::timestamp at time zone v_tz, (v_comp_fin + 1)::timestamp at time zone v_tz);
    v_datos := v_datos || jsonb_build_object(
      'version', 1,
      'comparativo', jsonb_build_object(
        'fecha_inicio', v_comp_ini, 'fecha_fin', v_comp_fin,
        'pedidos', v_ant -> 'pedidos', 'ventas_centavos', v_ant -> 'ventas_centavos'));

    if p_tipo = 'semana' then
      select jsonb_agg(jsonb_build_object(
               'fecha', d::date,
               'pedidos', (a -> 'pedidos'),
               'ventas_centavos', (a -> 'ventas_centavos')) order by d)
        into v_dias
        from generate_series(p_fecha_inicio::timestamp, v_fin::timestamp, interval '1 day') d
        cross join lateral restaurantes.cierre_agregados(
          p_organization_id, p_property_id,
          d::date::timestamp at time zone v_tz, (d::date + 1)::timestamp at time zone v_tz) a;
      v_datos := v_datos || jsonb_build_object('por_dia', v_dias);
    end if;

    insert into restaurantes.cierre_reporte (organization_id, property_id, tipo, fecha_inicio, fecha_fin, zona_horaria, datos, generado_por)
    values (p_organization_id, p_property_id, p_tipo, p_fecha_inicio, v_fin, v_tz, v_datos, v_por)
    on conflict (property_id, tipo, fecha_inicio) do nothing
    returning * into v_row;
    if found then
      v_creado := true;
    else
      select * into v_row from restaurantes.cierre_reporte r where r.property_id = p_property_id and r.tipo = p_tipo and r.fecha_inicio = p_fecha_inicio;
    end if;
  end if;

  return query select v_creado, v_row.id, v_row.tipo, v_row.fecha_inicio, v_row.fecha_fin, v_row.zona_horaria, v_row.datos, v_row.generado_por, v_row.generado_at;
end;
$$;

revoke all on function restaurantes.generar_cierre(uuid, uuid, text, date, boolean) from public, anon;
grant execute on function restaurantes.generar_cierre(uuid, uuid, text, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Sucursales a barrer (solo sistema).
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cierre_sucursales_sistema()
returns table (organization_id uuid, property_id uuid, zona_horaria text)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'cierre_sucursales_sistema: solo la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select b.organization_id, b.property_id, restaurantes.voz_zona_horaria(b.property_id)
    from restaurantes.branch_detail b
    where not exists (select 1 from restaurantes.demo_organization d where d.organization_id = b.organization_id)
    order by b.organization_id, b.property_id;
end;
$$;

revoke all on function restaurantes.cierre_sucursales_sistema() from public, anon;
grant execute on function restaurantes.cierre_sucursales_sistema() to authenticated;
