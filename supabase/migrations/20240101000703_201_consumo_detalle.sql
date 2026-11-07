-- 201: detalle del CONSUMO de un restaurante para la pantalla «Consumo y facturación» y la proyeccion de cierre de mes.
-- Requiere 200 (restaurantes.uso_facturable_mes) y 0080/0081.
--
-- restaurantes.consumo_detalle_mes(p_caller_id, p_organization_id, p_mes, p_meses_historial) devuelve, con las MISMAS
-- unidades que 200 (llamadas reales sin previews ni llamadas en curso; conversacion = cliente distinto por dia del negocio):
--   * totales del mes: llamadas, segundos y minutos de voz, duracion promedio por llamada, conversaciones de WhatsApp y
--     pedidos atendidos por los agentes (`orders.source` in ('voice','whatsapp'), sin cancelados);
--   * por dia del mes (zona del negocio): minutos y conversaciones -> la proyeccion usa el ritmo diario;
--   * por sucursal: llamadas, minutos, duracion promedio y pedidos de los agentes. Las conversaciones de WhatsApp NO se
--     desglosan por sucursal: el evento entrante no guarda la sucursal (se dice asi, no se reparte inventando);
--   * historial de los `p_meses_historial` meses anteriores (maximo 12): llamadas, minutos y conversaciones por mes.
--
-- Seguridad: security definer con search_path fijo; solo devuelve AGREGADOS (sin telefonos, hashes ni ids de llamada).
-- Sesion de usuario: auth.uid() = p_caller_id y (miembro de la organizacion o superadmin) -> si no, null. Sesion de sistema
-- (auth.uid() is null): cron de avisos de bolsa. Ningun GRANT a anon.
--
-- Rollback: drop function if exists restaurantes.consumo_detalle_mes(uuid, uuid, date, integer);
create or replace function restaurantes.consumo_detalle_mes(p_caller_id uuid, p_organization_id uuid, p_mes date, p_meses_historial integer default 6)
returns jsonb language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
declare
  v_tz text;
  v_vertical text;
  v_mes date;
  v_desde timestamptz;
  v_hasta timestamptz;
  v_meses integer := least(greatest(coalesce(p_meses_historial, 6), 0), 12);
  v_totales jsonb;
  v_dias jsonb;
  v_sucursales jsonb;
  v_historial jsonb;
  v_pedidos integer;
begin
  if auth.uid() is not null then
    if auth.uid() <> p_caller_id then
      raise exception 'consumo_detalle_mes: caller binding invalido' using errcode = '42501';
    end if;
    if not (
      exists (select 1 from core.membership m where m.user_id = p_caller_id and m.organization_id = p_organization_id)
      or core.is_platform_superadmin(p_caller_id)
    ) then
      return null;
    end if;
  end if;
  if p_mes is null then
    raise exception 'consumo_detalle_mes: indica el mes' using errcode = '22023';
  end if;
  select o.timezone, o.vertical into v_tz, v_vertical from core.organization o where o.id = p_organization_id;
  if v_tz is null then
    return null;
  end if;
  if v_vertical <> 'restaurantes' then
    raise exception 'consumo_detalle_mes: la organizacion no es de restaurantes' using errcode = '22023';
  end if;

  v_mes := date_trunc('month', p_mes::timestamp)::date;
  v_desde := v_mes::timestamp at time zone v_tz;
  v_hasta := (v_mes + interval '1 month')::timestamp at time zone v_tz;

  select count(*)::integer into v_pedidos
  from restaurantes.orders o
  where o.organization_id = p_organization_id and o.source in ('voice', 'whatsapp') and o.status <> 'cancelado'
    and o.created_at >= v_desde and o.created_at < v_hasta;

  with llamadas as (
    select vc.property_id, vc.duration_s, (vc.started_at at time zone v_tz)::date as dia
    from restaurantes.voice_conversation vc
    where vc.organization_id = p_organization_id and vc.canal = 'llamada' and vc.duration_s is not null
      and vc.started_at >= v_desde and vc.started_at < v_hasta
  ),
  conv as (
    select distinct e.phone_hash, (e.claimed_at at time zone v_tz)::date as dia
    from restaurantes.whatsapp_inbound_events e
    where e.organization_id = p_organization_id and e.status = 'processed'
      and e.claimed_at >= v_desde and e.claimed_at < v_hasta
  ),
  dias as (
    select d::date as dia from generate_series(v_mes::timestamp, (v_mes + interval '1 month' - interval '1 day')::timestamp, interval '1 day') d
  )
  select
    jsonb_build_object(
      'llamadas', (select count(*) from llamadas),
      'segundosVoz', (select coalesce(sum(duration_s), 0) from llamadas),
      'minutosVoz', (select ceil(coalesce(sum(duration_s), 0) / 60.0)::bigint from llamadas),
      'duracionPromedioS', (select case when count(*) = 0 then null else round(avg(duration_s))::integer end from llamadas),
      'conversacionesWa', (select count(*) from conv),
      'pedidosAgentes', v_pedidos
    ),
    (select jsonb_agg(jsonb_build_object(
        'dia', to_char(d.dia, 'YYYY-MM-DD'),
        'segundosVoz', coalesce((select sum(l.duration_s) from llamadas l where l.dia = d.dia), 0),
        'llamadas', (select count(*) from llamadas l where l.dia = d.dia),
        'conversacionesWa', (select count(*) from conv c where c.dia = d.dia)
      ) order by d.dia) from dias d)
  into v_totales, v_dias;

  select coalesce(jsonb_agg(x order by x->>'nombre'), '[]'::jsonb) into v_sucursales
  from (
    select jsonb_build_object(
      'propertyId', p.id,
      'nombre', p.name,
      'activa', p.status = 'active',
      'llamadas', count(vc.id),
      'minutosVoz', ceil(coalesce(sum(vc.duration_s), 0) / 60.0)::bigint,
      'duracionPromedioS', case when count(vc.id) = 0 then null else round(avg(vc.duration_s))::integer end,
      'pedidosAgentes', (select count(*) from restaurantes.orders o where o.organization_id = p_organization_id and o.property_id = p.id
                          and o.source in ('voice', 'whatsapp') and o.status <> 'cancelado' and o.created_at >= v_desde and o.created_at < v_hasta)
    ) as x
    from core.property p
    left join restaurantes.voice_conversation vc
      on vc.property_id = p.id and vc.organization_id = p_organization_id and vc.canal = 'llamada' and vc.duration_s is not null
     and vc.started_at >= v_desde and vc.started_at < v_hasta
    where p.organization_id = p_organization_id
    group by p.id, p.name, p.status
  ) s;

  select coalesce(jsonb_agg(h order by h->>'mes' desc), '[]'::jsonb) into v_historial
  from (
    select jsonb_build_object(
      'mes', to_char(m.mes, 'YYYY-MM-DD'),
      'llamadas', (select count(*) from restaurantes.voice_conversation vc where vc.organization_id = p_organization_id and vc.canal = 'llamada' and vc.duration_s is not null
                    and vc.started_at >= (m.mes::timestamp at time zone v_tz) and vc.started_at < ((m.mes + interval '1 month')::timestamp at time zone v_tz)),
      'minutosVoz', (select ceil(coalesce(sum(vc.duration_s), 0) / 60.0)::bigint from restaurantes.voice_conversation vc where vc.organization_id = p_organization_id and vc.canal = 'llamada' and vc.duration_s is not null
                    and vc.started_at >= (m.mes::timestamp at time zone v_tz) and vc.started_at < ((m.mes + interval '1 month')::timestamp at time zone v_tz)),
      'conversacionesWa', (select count(*) from (select distinct e.phone_hash, (e.claimed_at at time zone v_tz)::date from restaurantes.whatsapp_inbound_events e
                    where e.organization_id = p_organization_id and e.status = 'processed'
                      and e.claimed_at >= (m.mes::timestamp at time zone v_tz) and e.claimed_at < ((m.mes + interval '1 month')::timestamp at time zone v_tz)) q)
    ) as h
    from (select (v_mes - make_interval(months => g))::date as mes from generate_series(1, v_meses) g) m
  ) hh;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'mes', to_char(v_mes, 'YYYY-MM-DD'),
    'zonaHoraria', v_tz,
    'desde', v_desde,
    'hasta', v_hasta,
    'totales', v_totales,
    'dias', coalesce(v_dias, '[]'::jsonb),
    'sucursales', v_sucursales,
    'historial', v_historial
  );
end;
$$;
revoke all on function restaurantes.consumo_detalle_mes(uuid, uuid, date, integer) from public, anon;
-- authenticated: la autoridad real es el caller binding + membresia/superadmin de arriba.
grant execute on function restaurantes.consumo_detalle_mes(uuid, uuid, date, integer) to authenticated;
