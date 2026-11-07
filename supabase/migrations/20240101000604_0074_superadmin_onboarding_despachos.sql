-- Onboarding P0: la medicion de onboarding del superadmin (0052) cubre despachos.
--
-- Problema: core.org_onboarding_pasos (0052) no tenia fuente de "primera operacion" para despachos (core.org_conteo_vertical devolvia
-- 'sin_fuente', el paso quedaba siempre 'no_se_pudo_medir') ni de catalogo ('no_aplica'). Un despacho nunca llegaba a 100 % en la columna
-- «Onboarding x/y» de la consola ni disparaba el aviso superadmin.organizacion.onboarding_listo (investigacion B §1.2, §3.4).
--
-- Que cambia (create or replace con la MISMA firma; 0052 no se edita):
--   * core.org_conteo_vertical: despachos
--       - 'operaciones' = CFDI importados (despachos.invoice de la organizacion, por dia de Mexico como el resto);
--       - 'catalogo'    = clientes con ficha fiscal (despachos.cliente_ficha, RFC obligatorio).
--     El resto de verticales y metricas queda identico a 0052. Nota: las metricas de operaciones que ya consumen esta funcion (consola del
--     superadmin) pasan a mostrar el conteo de CFDI de despachos en vez de "sin fuente".
--   * core.org_onboarding_pasos: titulos de despachos ('Clientes con ficha fiscal', 'Primeros CFDI importados'); los pasos y su orden no
--     cambian para las demas verticales.
--
-- Requiere: 0052 (funciones que se reemplazan) y las tablas de despachos 001/018 (sin ellas el conteo cae, como antes, a
-- 'fuente_no_migrada' por el bloque de excepcion existente).
--
-- Justificacion de seguridad: mismas propiedades que 0052. Ambas siguen siendo helpers internos security invoker con
-- `set search_path = core, pg_temp`, tablas calificadas y REVOKE ALL a public, anon y authenticated: solo las invocan, como dueño, las
-- funciones definer de superadmin de 0052 (que ya validan auth.uid() = p_caller_id y superadmin). Devuelven conteos, nunca filas con datos
-- personales. No se crea ninguna tabla, policy ni GRANT.

create or replace function core.org_conteo_vertical(p_org uuid, p_vertical text, p_metrica text, p_desde date, p_hasta date)
returns table (o_cantidad bigint, o_razon text)
language plpgsql stable set search_path = core, pg_temp as $$
declare
  v_desde date := coalesce(p_desde, '-infinity'::date);
  v_hasta date := coalesce(p_hasta, 'infinity'::date);
  v_n bigint;
begin
  begin
    if p_metrica = 'operaciones' then
      if p_vertical = 'restaurantes' then
        select count(*) into v_n from restaurantes.orders x
          where x.organization_id = p_org and x.status <> 'cancelado' and (x.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      elsif p_vertical = 'hoteles' then
        select count(*) into v_n from hoteles.reservation x
          where x.organization_id = p_org and x.status::text not in ('cancelada', 'cotizada', 'no_show') and (x.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      elsif p_vertical = 'rentas' then
        select count(*) into v_n from rentas.ocupacion x
          where x.organization_id = p_org and x.capa = 'reserva' and x.estado <> 'cancelado' and (x.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      elsif p_vertical = 'citas' then
        select count(*) into v_n from citas.appointments x
          where x.organization_id = p_org and x.status not in ('cancelled', 'no_show') and (x.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      elsif p_vertical = 'despachos' then
        -- 0074: la primera operacion de un despacho es un CFDI importado de alguno de sus clientes (antes: 'sin_fuente', nunca 100 %).
        select count(*) into v_n from despachos.invoice x
          where x.organization_id = p_org and (x.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      elsif p_vertical = 'licitaciones' then
        select count(*) into v_n from licitaciones.tender t
          where t.organization_id = p_org and exists (select 1 from licitaciones.requirement_item ri where ri.tender_id = t.id)
            and (t.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      else
        return query select null::bigint, 'sin_fuente'::text;
        return;
      end if;
    elsif p_metrica = 'conversaciones' then
      if p_vertical = 'restaurantes' then
        select count(*) into v_n from restaurantes.whatsapp_conversations x
          where x.organization_id = p_org and (x.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      elsif p_vertical = 'hoteles' then
        select count(*) into v_n from hoteles.whatsapp_conversations x
          where x.organization_id = p_org and (x.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      elsif p_vertical = 'citas' then
        select count(*) into v_n from citas.whatsapp_conversations x
          where x.organization_id = p_org and (x.created_at at time zone 'America/Mexico_City')::date between v_desde and v_hasta;
      else
        return query select null::bigint, 'sin_whatsapp'::text;
        return;
      end if;
    elsif p_metrica = 'catalogo' then
      if p_vertical = 'restaurantes' then
        select count(*) into v_n from restaurantes.products x where x.organization_id = p_org and x.is_available;
      elsif p_vertical = 'hoteles' then
        select count(*) into v_n from hoteles.room x where x.organization_id = p_org;
      elsif p_vertical = 'citas' then
        select count(*) into v_n from citas.services x where x.organization_id = p_org and x.is_active;
      elsif p_vertical = 'rentas' then
        select count(*) into v_n from rentas.unidad x where x.organization_id = p_org;
      elsif p_vertical = 'despachos' then
        -- 0074: el "catalogo" de un despacho es su cartera: clientes (core.property) con ficha fiscal (RFC obligatorio en la tabla).
        select count(*) into v_n from despachos.cliente_ficha x where x.organization_id = p_org;
      else
        return query select null::bigint, 'no_aplica'::text;
        return;
      end if;
    elsif p_metrica = 'whatsapp' then
      if p_vertical = 'restaurantes' then
        select (select count(*) from restaurantes.whatsapp_channel_config x where x.organization_id = p_org)
             + (select count(*) from restaurantes.whatsapp_branch_channel x where x.organization_id = p_org) into v_n;
      elsif p_vertical = 'hoteles' then
        select count(*) into v_n from hoteles.whatsapp_channel_config x where x.organization_id = p_org and x.enabled;
      elsif p_vertical = 'citas' then
        select count(*) into v_n from citas.whatsapp_config x where x.organization_id = p_org and x.is_active;
      else
        return query select null::bigint, 'no_aplica'::text;
        return;
      end if;
    else
      raise exception 'org_conteo_vertical: metrica desconocida' using errcode = '22023';
    end if;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select null::bigint, 'fuente_no_migrada'::text;
    return;
  end;
  return query select v_n, null::text;
end;
$$;
revoke all on function core.org_conteo_vertical(uuid, text, text, date, date) from public, anon, authenticated;

create or replace function core.org_onboarding_pasos(p_org uuid)
returns table (orden integer, paso text, titulo text, estado text, razon text)
language plpgsql stable set search_path = core, pg_temp as $$
declare
  v_vertical text;
  v_c record;
  v_n bigint;
begin
  select o.vertical into v_vertical from core.organization o where o.id = p_org;
  if v_vertical is null then
    return;
  end if;

  -- 1) WhatsApp configurado (solo verticales con WhatsApp propio)
  select * into v_c from core.org_conteo_vertical(p_org, v_vertical, 'whatsapp', null, null);
  if v_c.o_razon is distinct from 'no_aplica' then
    return query select 1, 'whatsapp'::text, 'WhatsApp configurado'::text,
      case when v_c.o_cantidad is null then 'no_se_pudo_medir' when v_c.o_cantidad > 0 then 'hecho' else 'pendiente' end,
      v_c.o_razon;
  end if;

  -- 2) Catalogo / menu / habitaciones / unidades cargados
  select * into v_c from core.org_conteo_vertical(p_org, v_vertical, 'catalogo', null, null);
  if v_c.o_razon is distinct from 'no_aplica' then
    return query select 2, 'catalogo'::text,
      case v_vertical when 'restaurantes' then 'Menú cargado' when 'hoteles' then 'Habitaciones cargadas' when 'citas' then 'Servicios cargados'
        when 'despachos' then 'Clientes con ficha fiscal' else 'Propiedades cargadas' end,
      case when v_c.o_cantidad is null then 'no_se_pudo_medir' when v_c.o_cantidad > 0 then 'hecho' else 'pendiente' end,
      v_c.o_razon;
  end if;

  -- 3) Staff invitado (mas de una membresia)
  select count(*) into v_n from core.membership m where m.organization_id = p_org;
  return query select 3, 'staff_invitado'::text, 'Staff invitado'::text, case when v_n > 1 then 'hecho' else 'pendiente' end, null::text;

  -- 4) Primera operacion real
  select * into v_c from core.org_conteo_vertical(p_org, v_vertical, 'operaciones', null, null);
  return query select 4, 'primera_operacion'::text, case v_vertical when 'despachos' then 'Primeros CFDI importados' else 'Primera operación real' end,
    case when v_c.o_cantidad is null then 'no_se_pudo_medir' when v_c.o_cantidad > 0 then 'hecho' else 'pendiente' end,
    v_c.o_razon;

  -- 5) Plan asignado
  begin
    select count(*) into v_n from core.organization_plan op where op.organization_id = p_org;
    return query select 5, 'plan_asignado'::text, 'Plan asignado'::text, case when v_n > 0 then 'hecho' else 'pendiente' end, null::text;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 5, 'plan_asignado'::text, 'Plan asignado'::text, 'no_se_pudo_medir'::text, 'fuente_no_migrada'::text;
  end;

  -- 6) Contrato registrado
  begin
    select count(*) into v_n from core.customer_contract_version v where v.organization_id = p_org;
    return query select 6, 'contrato_registrado'::text, 'Contrato registrado'::text, case when v_n > 0 then 'hecho' else 'pendiente' end, null::text;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 6, 'contrato_registrado'::text, 'Contrato registrado'::text, 'no_se_pudo_medir'::text, 'fuente_no_migrada'::text;
  end;
end;
$$;
revoke all on function core.org_onboarding_pasos(uuid) from public, anon, authenticated;
