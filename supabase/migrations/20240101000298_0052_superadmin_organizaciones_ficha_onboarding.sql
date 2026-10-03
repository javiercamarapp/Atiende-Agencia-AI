-- Superadmin: tabla de Organizaciones con metricas (SA-L-20), Ficha 360 de una organizacion (SA-07) y onboarding
-- medido por organizacion (SA-18). Alimenta GET /superadmin/organizaciones/resumen, GET /superadmin/organizaciones/:id/ficha
-- (ver apps/api/src/routes/superadmin-organizaciones-ficha.ts) y el aviso 'organizacion lista' del cron de mantenimiento.
--
-- Solo LECTURA salvo UNA tabla nueva (core.org_onboarding_aviso, el marcador del aviso). Cada fuente de un dato es una lectura
-- con EXCEPTION WHEN undefined_table/undefined_column/insufficient_privilege: una vertical (o una migracion) que no esta
-- aplicada devuelve `razon = 'fuente_no_migrada'`, NUNCA un error ni un 0 inventado. Un paso de onboarding que no se puede
-- medir sale `no_se_pudo_medir` con su razon: es distinto de `pendiente` (pendiente = se midio y falta; no_se_pudo_medir =
-- no hay forma de saberlo todavia).
--
--   core.org_conteo_vertical                         -- (interno) conteo por organizacion/vertical/metrica con rango en dia de Mexico
--   core.org_onboarding_pasos                        -- (interno) checklist por vertical con hecho / pendiente / no_se_pudo_medir
--   core.get_org_onboarding_for_superadmin           -- checklist de UNA organizacion
--   core.get_orgs_onboarding_resumen_for_superadmin  -- 'x/y' de TODAS las organizaciones (columna Onboarding de la tabla)
--   core.get_orgs_metricas_for_superadmin            -- operaciones y costo de IA a 30 dias por organizacion
--   core.get_org_ficha_for_superadmin                -- Ficha 360 (uso, costo, membresias, errores, facturacion, onboarding)
--   core.avisar_organizaciones_listas_for_system     -- solo-sistema: marca 'organizacion lista' UNA sola vez y devuelve cuales avisar
--
-- El margen NO se calcula aqui: el API reutiliza core.get_cost_margin_report_for_superadmin (0028) y packages/billing.
--
-- Criterio del checklist (replica en SQL, para el superadmin, los mismos criterios de las verticales que ya tienen onboarding:
-- apps/api/src/routes/verticals/{restaurantes/admin-onboarding.ts,citas/onboarding.ts,rentas/onboarding.ts}; esas rutas corren
-- con la sesion RLS de un staff de la organizacion y no sirven para el back office):
--   whatsapp           restaurantes (numero general o por sucursal), hoteles (canal habilitado), citas (config activa)
--   catalogo           restaurantes (productos disponibles), hoteles (habitaciones), citas (servicios activos), rentas (unidades)
--   staff_invitado     mas de una membresia en core.membership (la persona que dio de alta la organizacion + al menos una invitada)
--   primera_operacion  al menos una operacion real (mismas definiciones que core.get_consola_operaciones_for_superadmin, 0042)
--   plan_asignado      fila en core.organization_plan (0028)
--   contrato_registrado  alguna version en core.customer_contract_version (0037)
-- licitaciones y despachos no tienen WhatsApp ni catalogo propios: esos pasos no aplican y NO se listan. despachos no persiste
-- operaciones (igual que en 0042): su 'primera_operacion' sale no_se_pudo_medir con razon 'sin_fuente'.
--
-- Requiere: 0001, 0010, 0012 (core.is_platform_superadmin), 0021 (core.authz_audit_log), 0028, 0037; el aviso usa ademas 0039 (core.emit_notification) desde TypeScript.
-- Dia de negocio: America/Mexico_City; `p_hoy` lo decide el API (estas funciones no leen current_date).
--
-- Justificacion de seguridad (cada tabla, funcion y GRANT trae su razon):
--   * core.org_onboarding_aviso: RLS habilitada SIN policy y REVOKE ALL a public/anon/authenticated. Razon: es un marcador
--     interno; nadie la lee ni la escribe directo, solo la funcion de sistema (definer). PK = organization_id: la base garantiza
--     que el aviso sale UNA sola vez por organizacion (insert ... on conflict do nothing), aunque dos crons corran a la vez.
--     ON DELETE CASCADE: al borrar la organizacion se va su marcador (sin FK cruzada de dominio).
--   * core.org_conteo_vertical y core.org_onboarding_pasos: helpers internos, security invoker con search_path fijo y REVOKE ALL
--     a public, anon y authenticated. Razon: solo los invocan, como DUEÑO, las funciones definer de abajo (que ya validaron al
--     superadmin); ningun rol de la aplicacion las ejecuta. Devuelven conteos, nunca filas con datos personales.
--   * Las cuatro funciones *_for_superadmin: security definer, search_path fijo `core, pg_temp`, tablas calificadas con su
--     esquema, REVOKE ALL a public y anon, GRANT EXECUTE solo a authenticated. Razon: `authenticated` no tiene GRANT sobre
--     core.llm_usage_daily, core.usage_cost_event, core.authz_audit_log ni las tablas de las verticales. Todas exigen
--     `auth.uid() = p_caller_id` y core.is_platform_superadmin(p_caller_id); un caller que no es superadmin, un uid que no
--     coincide o una sesion de sistema (auth.uid() null) recibe CERO filas, nunca un error que confirme o niegue datos.
--     La ficha no devuelve nombres, correos, telefonos, IP ni contenido: solo conteos, roles, rutas y fechas.
--   * core.avisar_organizaciones_listas_for_system: security definer, search_path fijo, REVOKE ALL a public y anon, GRANT a
--     authenticated (las sesiones de sistema corren con ese rol y `auth.uid()` nulo, igual que 0030); la autorizacion real esta
--     DENTRO: con un uid real (cualquier usuario) no hace nada y devuelve cero filas. No emite nada ella misma: solo devuelve ids; la
--     notificacion (a core.platform_superadmin, sin PII: el texto es fijo y el enlace lleva solo el uuid) la emite el cron con el productor
--     compartido core.emit_notification, en la misma transaccion.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0) Marcador persistente del aviso 'organizacion lista'
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.org_onboarding_aviso (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  avisado_en timestamptz not null default now(),
  -- false = la organizacion ya estaba completa cuando se desplego esta funcion (o es antigua): se marca para no avisarla
  -- jamas, pero no se emite una notificacion de algo que ya no es noticia.
  notificado boolean not null default true
);
alter table core.org_onboarding_aviso enable row level security;
revoke all on core.org_onboarding_aviso from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) Conteo por organizacion / vertical / metrica (interno)
-- ═══════════════════════════════════════════════════════════════════════════
-- p_metrica: 'operaciones' | 'conversaciones' | 'catalogo' | 'whatsapp'. p_desde/p_hasta (dia de Mexico, ambos incluidos; null =
-- sin limite) solo aplican a operaciones y conversaciones. Devuelve (o_cantidad, o_razon): cantidad null + razon = no medible;
-- razon 'no_aplica' / 'sin_whatsapp' = la vertical no tiene esa fuente (no es un fallo).
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Checklist de onboarding por vertical (interno)
-- ═══════════════════════════════════════════════════════════════════════════
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
      case v_vertical when 'restaurantes' then 'Menú cargado' when 'hoteles' then 'Habitaciones cargadas' when 'citas' then 'Servicios cargados' else 'Propiedades cargadas' end,
      case when v_c.o_cantidad is null then 'no_se_pudo_medir' when v_c.o_cantidad > 0 then 'hecho' else 'pendiente' end,
      v_c.o_razon;
  end if;

  -- 3) Staff invitado (mas de una membresia)
  select count(*) into v_n from core.membership m where m.organization_id = p_org;
  return query select 3, 'staff_invitado'::text, 'Staff invitado'::text, case when v_n > 1 then 'hecho' else 'pendiente' end, null::text;

  -- 4) Primera operacion real
  select * into v_c from core.org_conteo_vertical(p_org, v_vertical, 'operaciones', null, null);
  return query select 4, 'primera_operacion'::text, 'Primera operación real'::text,
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Checklist de UNA organizacion (superadmin)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.get_org_onboarding_for_superadmin(p_caller_id uuid, p_organization_id uuid)
returns table (orden integer, paso text, titulo text, estado text, razon text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select p.orden, p.paso, p.titulo, p.estado, p.razon from core.org_onboarding_pasos(p_organization_id) p order by p.orden;
end;
$$;
revoke all on function core.get_org_onboarding_for_superadmin(uuid, uuid) from public, anon;
grant execute on function core.get_org_onboarding_for_superadmin(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) 'x/y' de onboarding de TODAS las organizaciones (superadmin)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.get_orgs_onboarding_resumen_for_superadmin(p_caller_id uuid)
returns table (organization_id uuid, hechos integer, total integer, no_medibles integer)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select o.id,
      (count(*) filter (where p.estado = 'hecho'))::integer,
      (count(*))::integer,
      (count(*) filter (where p.estado = 'no_se_pudo_medir'))::integer
    from core.organization o
    cross join lateral core.org_onboarding_pasos(o.id) p
    group by o.id
    order by o.id;
end;
$$;
revoke all on function core.get_orgs_onboarding_resumen_for_superadmin(uuid) from public, anon;
grant execute on function core.get_orgs_onboarding_resumen_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) Operaciones y costo de IA a 30 dias por organizacion (superadmin)
-- ═══════════════════════════════════════════════════════════════════════════
-- Ventana: dias de Mexico en (p_hoy - 30, p_hoy]. operaciones null + razon = no medible. Costos null = la fuente no existe
-- todavia (0 = se leyo y no hubo consumo). Incluye el plan asignado (id y nombre, sin precios).
create or replace function core.get_orgs_metricas_for_superadmin(p_caller_id uuid, p_hoy date)
returns table (organization_id uuid, operaciones_30d bigint, operaciones_razon text, llm_30d_micro_usd bigint, eventos_30d_micro_usd bigint, plan_id text, plan_nombre text, plan_razon text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_org record;
  v_c record;
  v_llm bigint;
  v_ev bigint;
  v_plan_id text;
  v_plan_nombre text;
  v_plan_razon text;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_hoy is null then
    raise exception 'get_orgs_metricas_for_superadmin: p_hoy obligatorio' using errcode = '22023';
  end if;
  for v_org in select o.id, o.vertical from core.organization o order by o.id loop
    select * into v_c from core.org_conteo_vertical(v_org.id, v_org.vertical, 'operaciones', p_hoy - 29, p_hoy);
    begin
      select coalesce(sum(u.cost_micro_usd), 0)::bigint into v_llm from core.llm_usage_daily u
        where u.organization_id = v_org.id and u.usage_date > p_hoy - 30 and u.usage_date <= p_hoy;
    exception when undefined_table or undefined_column or insufficient_privilege then
      v_llm := null;
    end;
    begin
      select coalesce(sum(e.costo_micro_usd), 0)::bigint into v_ev from core.usage_cost_event e
        where e.organization_id = v_org.id
          and e.occurred_at >= ((p_hoy - 29)::timestamp at time zone 'America/Mexico_City')
          and e.occurred_at < ((p_hoy + 1)::timestamp at time zone 'America/Mexico_City');
    exception when undefined_table or undefined_column or insufficient_privilege then
      v_ev := null;
    end;
    -- Plan asignado (solo id y nombre: ningun precio; el margen vive en la zona CFO).
    v_plan_id := null; v_plan_nombre := null; v_plan_razon := null;
    begin
      select pl.id, pl.nombre into v_plan_id, v_plan_nombre from core.organization_plan op join core.plan pl on pl.id = op.plan_id where op.organization_id = v_org.id;
    exception when undefined_table or undefined_column or insufficient_privilege then
      v_plan_razon := 'fuente_no_migrada';
    end;
    organization_id := v_org.id;
    plan_id := v_plan_id;
    plan_nombre := v_plan_nombre;
    plan_razon := v_plan_razon;
    operaciones_30d := v_c.o_cantidad;
    operaciones_razon := v_c.o_razon;
    llm_30d_micro_usd := v_llm;
    eventos_30d_micro_usd := v_ev;
    return next;
  end loop;
end;
$$;
revoke all on function core.get_orgs_metricas_for_superadmin(uuid, date) from public, anon;
grant execute on function core.get_orgs_metricas_for_superadmin(uuid, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6) Ficha 360 de una organizacion (superadmin)
-- ═══════════════════════════════════════════════════════════════════════════
-- Una fila jsonb. Cero filas = no es superadmin O la organizacion no existe (el API responde 404 honesto en el segundo caso
-- porque la ruta ya exige superadmin). Cada bloque trae su propia `razon` cuando su fuente no se pudo leer; los demas siguen.
--   uso:          operaciones, conversaciones y minutos de voz a 30 dias
--   costo:        gasto LLM y de eventos a 30 dias, cantidad de eventos
--   membresias:   conteo por rol y ultimo acceso (staff_session.issued_at, sin nombre ni correo)
--   errores:      mensajes muertos del outbox de la vertical, denegaciones de acceso (30 d) y crons (sin fuente por organizacion)
--   facturacion:  plan, estado de cobro y contrato vigente
--   onboarding:   el checklist de 3)
create or replace function core.get_org_ficha_for_superadmin(p_caller_id uuid, p_organization_id uuid, p_hoy date)
returns table (ficha jsonb)
language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_org record;
  v_desde date;
  v_ops record;
  v_conv record;
  v_voz numeric;
  v_voz_razon text;
  v_llm bigint;
  v_ev bigint;
  v_ev_n bigint;
  v_costo_razon text;
  v_roles jsonb;
  v_roles_razon text;
  v_accesos jsonb;
  v_accesos_razon text;
  v_muertos bigint;
  v_muertos_razon text;
  v_den bigint;
  v_den_ultimas jsonb;
  v_den_razon text;
  v_plan jsonb;
  v_billing jsonb;
  v_contrato jsonb;
  v_pasos jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_hoy is null then
    raise exception 'get_org_ficha_for_superadmin: p_hoy obligatorio' using errcode = '22023';
  end if;
  select o.id, o.name, o.slug, o.vertical, o.status, o.created_at into v_org from core.organization o where o.id = p_organization_id;
  if v_org.id is null then
    return;
  end if;
  v_desde := p_hoy - 29;

  -- uso
  select * into v_ops from core.org_conteo_vertical(v_org.id, v_org.vertical, 'operaciones', v_desde, p_hoy);
  select * into v_conv from core.org_conteo_vertical(v_org.id, v_org.vertical, 'conversaciones', v_desde, p_hoy);
  begin
    select coalesce(sum(case e.unidad when 'minuto' then e.cantidad when 'segundo' then e.cantidad / 60 else 0 end), 0)::numeric
      into v_voz from core.usage_cost_event e
      where e.organization_id = v_org.id and e.categoria = 'voz'
        and e.occurred_at >= (v_desde::timestamp at time zone 'America/Mexico_City')
        and e.occurred_at < ((p_hoy + 1)::timestamp at time zone 'America/Mexico_City');
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_voz := null; v_voz_razon := 'fuente_no_migrada';
  end;

  -- costo
  begin
    select coalesce(sum(u.cost_micro_usd), 0)::bigint into v_llm from core.llm_usage_daily u
      where u.organization_id = v_org.id and u.usage_date > p_hoy - 30 and u.usage_date <= p_hoy;
    select coalesce(sum(e.costo_micro_usd), 0)::bigint, count(*)::bigint into v_ev, v_ev_n from core.usage_cost_event e
      where e.organization_id = v_org.id
        and e.occurred_at >= (v_desde::timestamp at time zone 'America/Mexico_City')
        and e.occurred_at < ((p_hoy + 1)::timestamp at time zone 'America/Mexico_City');
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_llm := null; v_ev := null; v_ev_n := null; v_costo_razon := 'fuente_no_migrada';
  end;

  -- membresias
  select coalesce(jsonb_agg(jsonb_build_object('rol', r.rol, 'cantidad', r.cantidad) order by r.rol), '[]'::jsonb) into v_roles
  from (select m.platform_role || ' / ' || m.vertical_role as rol, count(*)::int as cantidad from core.membership m where m.organization_id = v_org.id group by 1) r;
  begin
    select coalesce(jsonb_agg(jsonb_build_object('rol', a.rol, 'ultimoAcceso', a.ultimo) order by a.ultimo desc nulls last), '[]'::jsonb) into v_accesos
    from (
      select m.platform_role as rol, (select max(s.issued_at) from core.staff_session s where s.staff_user_id = m.user_id) as ultimo
      from core.membership m where m.organization_id = v_org.id
      order by 2 desc nulls last limit 5
    ) a;
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_accesos := null; v_accesos_razon := 'fuente_no_migrada';
  end;

  -- errores: outbox muerto de la vertical de la organizacion
  begin
    execute format('select count(*) from %I.messaging_outbox x where x.organization_id = $1 and x.status = ''dead''', v_org.vertical) into v_muertos using v_org.id;
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_muertos := null; v_muertos_razon := 'fuente_no_migrada';
  end;
  begin
    select count(*)::bigint,
      coalesce(jsonb_agg(jsonb_build_object('ruta', d.route, 'motivo', d.reason, 'cuando', d.occurred_at) order by d.occurred_at desc) filter (where d.rn <= 5), '[]'::jsonb)
      into v_den, v_den_ultimas
    from (
      select l.route, l.reason, l.occurred_at, row_number() over (order by l.occurred_at desc) as rn
      from core.authz_audit_log l
      where l.organization_id = v_org.id and l.decision = 'denied'
        and l.occurred_at >= (v_desde::timestamp at time zone 'America/Mexico_City')
    ) d;
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_den := null; v_den_ultimas := null; v_den_razon := 'fuente_no_migrada';
  end;

  -- facturacion y contrato
  begin
    select jsonb_build_object('id', pl.id, 'nombre', pl.nombre) into v_plan
    from core.organization_plan op join core.plan pl on pl.id = op.plan_id where op.organization_id = v_org.id;
    select jsonb_build_object('estado', ob.status, 'periodoHasta', ob.current_period_end, 'asientos', ob.seats) into v_billing
    from core.organization_billing ob where ob.organization_id = v_org.id;
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_plan := null; v_billing := null;
  end;
  begin
    select jsonb_build_object('contractId', c.contract_id, 'version', c.version) into v_contrato from core.org_contrato_vigente(v_org.id) c limit 1;
  exception when undefined_table or undefined_column or undefined_function or insufficient_privilege then
    v_contrato := null;
  end;

  -- onboarding
  select coalesce(jsonb_agg(jsonb_build_object('paso', p.paso, 'titulo', p.titulo, 'estado', p.estado, 'razon', p.razon) order by p.orden), '[]'::jsonb) into v_pasos
  from core.org_onboarding_pasos(v_org.id) p;

  ficha := jsonb_build_object(
    'organizacion', jsonb_build_object('id', v_org.id, 'nombre', v_org.name, 'slug', v_org.slug, 'vertical', v_org.vertical, 'estado', v_org.status, 'creadaEn', v_org.created_at),
    'uso', jsonb_build_object(
      'operaciones30d', jsonb_build_object('valor', v_ops.o_cantidad, 'razon', v_ops.o_razon),
      'conversaciones30d', jsonb_build_object('valor', v_conv.o_cantidad, 'razon', v_conv.o_razon),
      'minutosVoz30d', jsonb_build_object('valor', v_voz, 'razon', v_voz_razon)),
    'costo', jsonb_build_object('llm30dMicroUsd', v_llm, 'eventos30dMicroUsd', v_ev, 'eventos30dTotal', v_ev_n, 'razon', v_costo_razon),
    'membresias', jsonb_build_object('porRol', v_roles, 'ultimosAccesos', v_accesos, 'ultimosAccesosRazon', v_accesos_razon),
    'errores', jsonb_build_object(
      'outboxMuerto', jsonb_build_object('valor', v_muertos, 'razon', v_muertos_razon),
      'denegaciones30d', jsonb_build_object('valor', v_den, 'ultimas', v_den_ultimas, 'razon', v_den_razon),
      'crons', jsonb_build_object('valor', null, 'razon', 'sin_fuente_por_organizacion')),
    'facturacion', jsonb_build_object('plan', v_plan, 'cobro', v_billing, 'contrato', v_contrato),
    'onboarding', v_pasos
  );
  return next;
end;
$$;
revoke all on function core.get_org_ficha_for_superadmin(uuid, uuid, date) from public, anon;
grant execute on function core.get_org_ficha_for_superadmin(uuid, uuid, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7) Marcador del aviso 'organizacion lista' (solo-sistema, una sola vez, nunca desde un GET)
-- ═══════════════════════════════════════════════════════════════════════════
-- Lo llama el cron /internal/superadmin/mantenimiento. Para cada organizacion NO suspendida y sin marcador cuyo checklist esta
-- COMPLETO (todos sus pasos 'hecho'; uno 'pendiente' o 'no_se_pudo_medir' lo impide) inserta el marcador (la PK garantiza una sola vez) y
-- DEVUELVE el id de las que hay que avisar: el cron emite entonces UNA notificacion de plataforma por cada una con el productor compartido
-- (emitirNotificacion, evento superadmin.organizacion.onboarding_listo) EN LA MISMA TRANSACCION: si la emision falla el cron revierte todo,
-- marcador incluido, y se reintenta en la siguiente corrida (nunca queda una organizacion marcada sin aviso). Las organizaciones con mas de
-- 30 dias de alta se marcan SIN devolverse (ya no son noticia: evita inundar la campana el dia que se aplica la migracion).
create or replace function core.avisar_organizaciones_listas_for_system()
returns table (organization_id uuid)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_org record;
  v_marcadas integer;
  v_reciente boolean;
begin
  if auth.uid() is not null then
    return;
  end if;
  for v_org in
    select o.id, o.created_at from core.organization o
    where o.status <> 'suspended' and not exists (select 1 from core.org_onboarding_aviso a where a.organization_id = o.id)
    order by o.created_at
    limit 500
  loop
    if exists (select 1 from core.org_onboarding_pasos(v_org.id))
       and not exists (select 1 from core.org_onboarding_pasos(v_org.id) p where p.estado <> 'hecho') then
      v_reciente := v_org.created_at > now() - interval '30 days';
      insert into core.org_onboarding_aviso (organization_id, notificado) values (v_org.id, v_reciente) on conflict on constraint org_onboarding_aviso_pkey do nothing;
      get diagnostics v_marcadas = row_count;
      if v_marcadas = 1 and v_reciente then
        organization_id := v_org.id;
        return next;
      end if;
    end if;
  end loop;
end;
$$;
revoke all on function core.avisar_organizaciones_listas_for_system() from public, anon;
grant execute on function core.avisar_organizaciones_listas_for_system() to authenticated;
