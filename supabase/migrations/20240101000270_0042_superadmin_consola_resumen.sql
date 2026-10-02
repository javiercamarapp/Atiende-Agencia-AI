-- Superadmin "Resumen de la consola" (SA-L-05) y "Actividad de agentes" (SA-L-06): agregados de
-- plataforma que alimentan GET /superadmin/consola/resumen y GET /superadmin/consola/agentes-actividad
-- (ver apps/api/src/routes/superadmin-consola.ts y docs/SUPERADMIN_CONSOLA.md).
--
-- Solo LECTURA: ninguna tabla nueva, ninguna escritura, ningun cambio a tablas existentes. Cada fuente es su
-- PROPIA funcion para que el API pueda dejar en null solo el campo cuya fuente falla (el resto sigue).
--
--   core.get_consola_organizaciones_for_superadmin  -- organizaciones por vertical y cuantas son demo
--   core.get_consola_costo_diario_for_superadmin    -- serie diaria de gasto de IA y tokens (rango acotado)
--   core.get_consola_costo_historico_for_superadmin -- gasto de IA, tokens y minutos de voz historicos
--   core.get_consola_operaciones_for_superadmin     -- operaciones atendidas por vertical (total y diario)
--   core.get_consola_alcance_for_superadmin         -- sucursales/propiedades y usuarios con acceso
--   core.get_consola_conversaciones_wa_for_superadmin -- conversaciones de WhatsApp por vertical
--   core.get_consola_resueltas_sin_humano_for_superadmin -- "X de N" del dia, medido solo en restaurantes
--   core.get_consola_agentes_actividad_for_superadmin -- llamadas, costo y fallbacks por rol, historico y 30 dias
--
-- El MRR NO tiene funcion nueva: el API reutiliza core.get_cfo_dashboard_for_superadmin (0030) y solo expone el
-- total; cada lectura se registra en core.cfo_access_log (0034) como 'resumen_mrr'.
--
-- Requiere: 0001, 0010 (core.llm_usage_daily), 0012 (core.is_platform_superadmin), 0028 (core.usage_cost_event).
-- Las tablas de cada vertical (restaurantes, hoteles, rentas, citas, licitaciones) se leen con
-- EXCEPTION WHEN undefined_table/undefined_column/insufficient_privilege POR vertical: una vertical cuya
-- migracion no se aplico devuelve una fila con `razon = 'fuente_no_migrada'`, nunca un error ni un 0 inventado.
--
-- Dia de negocio: America/Mexico_City (las marcas de tiempo se convierten con AT TIME ZONE; las columnas `date`
-- como llm_usage_daily.usage_date se usan tal cual). El rango "hoy" lo decide el API y lo pasa como parametro
-- (p_hoy / p_desde / p_hasta): estas funciones no leen current_date, asi que son deterministas y probables
-- con un reloj fijo (incluido el caso 23:30 hora de Mexico, que en UTC ya es el dia siguiente).
--
-- Justificacion de seguridad (cada funcion trae su razon):
--   * Las ocho funciones son `security definer` con `search_path = core, pg_temp` fijo y todas las tablas de
--     vertical calificadas con su esquema. Razon: `authenticated` no tiene GRANT sobre core.llm_usage_daily,
--     core.usage_cost_event ni sobre las tablas de las verticales; solo estas funciones las leen, y solo
--     para agregarlas (conteos y sumas, nunca filas con datos personales: no se lee ningun nombre, telefono,
--     mensaje ni contenido de conversacion).
--   * Todas exigen `auth.uid() = p_caller_id` y `core.is_platform_superadmin(p_caller_id)` (mismo patron que
--     0030/0014). Un caller que no es superadmin, un uid que no coincide o una sesion de sistema (auth.uid()
--     null) recibe CERO filas, nunca un error que confirme o niegue si hay datos.
--   * REVOKE ALL de public y anon + GRANT EXECUTE solo a authenticated. Razon: anon nunca ejecuta nada de
--     plataforma; el cierre real es el guard interno de cada funcion.
--   * Rango de la serie diaria acotado a 400 dias (22023 si se excede): evita que un caller superadmin
--     materialice una serie arbitrariamente larga por error.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) Organizaciones por vertical (y cuantas son demo)
-- ═══════════════════════════════════════════════════════════════════════════
-- Demo = marcada en restaurantes.demo_organization (R-19/R-20) o con el slug `demo-<vertical>` que crea
-- core.ensure_demo_access_for_superadmin (0011). Sin la tabla de restaurantes, solo cuenta el slug.
create or replace function core.get_consola_organizaciones_for_superadmin(p_caller_id uuid)
returns table (vertical text, total bigint, demo bigint, activas bigint)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
declare
  v_demo_ids uuid[] := '{}';
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  begin
    select coalesce(array_agg(d.organization_id), '{}') into v_demo_ids from restaurantes.demo_organization d;
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_demo_ids := '{}';
  end;
  return query
    select o.vertical, count(*)::bigint,
      (count(*) filter (where o.id = any (v_demo_ids) or o.slug like 'demo-%'))::bigint,
      (count(*) filter (where o.status = 'active'))::bigint
    from core.organization o
    group by o.vertical
    order by o.vertical;
end;
$$;
revoke all on function core.get_consola_organizaciones_for_superadmin(uuid) from public, anon;
grant execute on function core.get_consola_organizaciones_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Serie diaria de gasto de IA y tokens
-- ═══════════════════════════════════════════════════════════════════════════
-- Una fila por dia del rango [p_desde, p_hasta], incluidos los dias sin consumo (0 real: la fuente SI se leyo).
-- LLM = core.llm_usage_daily; eventos = core.usage_cost_event (voz, whatsapp, telefonia, sms, email, storage;
-- no se solapan con el LLM: son registros distintos, igual que en core.cfo_org_rows).
create or replace function core.get_consola_costo_diario_for_superadmin(p_caller_id uuid, p_desde date, p_hasta date)
returns table (dia date, llm_micro_usd bigint, eventos_micro_usd bigint, tokens bigint)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 400 then
    raise exception 'get_consola_costo_diario_for_superadmin: rango invalido (maximo 400 dias)' using errcode = '22023';
  end if;
  return query
    with dias as (
      select (p_desde + n)::date as dia from generate_series(0, p_hasta - p_desde) n
    ),
    llm as (
      select u.usage_date as dia, sum(u.cost_micro_usd)::bigint as costo, sum(u.tokens_in + u.tokens_out)::bigint as tokens
      from core.llm_usage_daily u
      where u.usage_date between p_desde and p_hasta
      group by u.usage_date
    ),
    ev as (
      select (e.occurred_at at time zone 'America/Mexico_City')::date as dia, sum(e.costo_micro_usd)::bigint as costo
      from core.usage_cost_event e
      where e.occurred_at >= (p_desde::timestamp at time zone 'America/Mexico_City')
        and e.occurred_at < ((p_hasta + 1)::timestamp at time zone 'America/Mexico_City')
      group by 1
    )
    select d.dia, coalesce(l.costo, 0)::bigint, coalesce(v.costo, 0)::bigint, coalesce(l.tokens, 0)::bigint
    from dias d
    left join llm l on l.dia = d.dia
    left join ev v on v.dia = d.dia
    order by d.dia;
end;
$$;
revoke all on function core.get_consola_costo_diario_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.get_consola_costo_diario_for_superadmin(uuid, date, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Gasto de IA, tokens y minutos de voz historicos
-- ═══════════════════════════════════════════════════════════════════════════
-- Una fila 'llm' (core.llm_usage_daily) mas una fila por categoria de core.usage_cost_event que tenga eventos.
-- Los minutos de voz salen de la categoria 'voz' (unidad minuto o segundo/60), mismo criterio que
-- core.cfo_org_rows.
create or replace function core.get_consola_costo_historico_for_superadmin(p_caller_id uuid)
returns table (fuente text, costo_micro_usd bigint, tokens_in bigint, tokens_out bigint, eventos bigint, minutos_voz numeric)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select 'llm'::text, coalesce(sum(u.cost_micro_usd), 0)::bigint, coalesce(sum(u.tokens_in), 0)::bigint,
      coalesce(sum(u.tokens_out), 0)::bigint, coalesce(sum(u.call_count), 0)::bigint, null::numeric
    from core.llm_usage_daily u
    union all
    select e.categoria, coalesce(sum(e.costo_micro_usd), 0)::bigint, null::bigint, null::bigint, count(*)::bigint,
      case when e.categoria = 'voz'
        then coalesce(sum(case e.unidad when 'minuto' then e.cantidad when 'segundo' then e.cantidad / 60 else 0 end), 0)::numeric
        else null::numeric end
    from core.usage_cost_event e
    group by e.categoria;
end;
$$;
revoke all on function core.get_consola_costo_historico_for_superadmin(uuid) from public, anon;
grant execute on function core.get_consola_costo_historico_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) Operaciones atendidas por vertical
-- ═══════════════════════════════════════════════════════════════════════════
-- Salida: `dia is null` = total historico de la vertical; `dia` no nulo = operaciones creadas ese dia
-- (dia de Mexico), una fila por dia del rango. `cantidad is null` + `razon` = la vertical NO tiene fuente.
--   restaurantes: restaurantes.orders con status <> 'cancelado' (pedidos).
--   hoteles:      hoteles.reservation con status fuera de cancelada/cotizada/no_show (reservas).
--   rentas:       rentas.ocupacion con capa 'reserva' y estado <> 'cancelado' (reservas de canal).
--   citas:        citas.appointments con status fuera de cancelled/no_show (citas).
--   licitaciones: licitaciones.tender con al menos un requirement_item (convocatorias analizadas: ya se
--                 extrajeron sus requisitos).
--   despachos:    SIN FUENTE ('sin_fuente'): la conciliacion bancaria de despachos es un calculo puro sin
--                 persistencia (ver domain-despachos/migrations/002), no queda registro de CFDI conciliados.
create or replace function core.get_consola_operaciones_for_superadmin(p_caller_id uuid, p_desde date, p_hasta date)
returns table (vertical text, dia date, cantidad bigint, razon text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 400 then
    raise exception 'get_consola_operaciones_for_superadmin: rango invalido (maximo 400 dias)' using errcode = '22023';
  end if;

  -- restaurantes
  begin
    return query
      with ev as (select (o.created_at at time zone 'America/Mexico_City')::date as dia from restaurantes.orders o where o.status <> 'cancelado')
      select 'restaurantes'::text, null::date, (select count(*) from ev)::bigint, null::text
      union all
      select 'restaurantes'::text, (p_desde + n)::date, (select count(*) from ev where ev.dia = (p_desde + n)::date)::bigint, null::text
      from generate_series(0, p_hasta - p_desde) n;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 'restaurantes'::text, null::date, null::bigint, 'fuente_no_migrada'::text;
  end;

  -- hoteles
  begin
    return query
      with ev as (select (r.created_at at time zone 'America/Mexico_City')::date as dia from hoteles.reservation r where r.status::text not in ('cancelada', 'cotizada', 'no_show'))
      select 'hoteles'::text, null::date, (select count(*) from ev)::bigint, null::text
      union all
      select 'hoteles'::text, (p_desde + n)::date, (select count(*) from ev where ev.dia = (p_desde + n)::date)::bigint, null::text
      from generate_series(0, p_hasta - p_desde) n;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 'hoteles'::text, null::date, null::bigint, 'fuente_no_migrada'::text;
  end;

  -- rentas
  begin
    return query
      with ev as (select (o.created_at at time zone 'America/Mexico_City')::date as dia from rentas.ocupacion o where o.capa = 'reserva' and o.estado <> 'cancelado')
      select 'rentas'::text, null::date, (select count(*) from ev)::bigint, null::text
      union all
      select 'rentas'::text, (p_desde + n)::date, (select count(*) from ev where ev.dia = (p_desde + n)::date)::bigint, null::text
      from generate_series(0, p_hasta - p_desde) n;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 'rentas'::text, null::date, null::bigint, 'fuente_no_migrada'::text;
  end;

  -- citas
  begin
    return query
      with ev as (select (a.created_at at time zone 'America/Mexico_City')::date as dia from citas.appointments a where a.status not in ('cancelled', 'no_show'))
      select 'citas'::text, null::date, (select count(*) from ev)::bigint, null::text
      union all
      select 'citas'::text, (p_desde + n)::date, (select count(*) from ev where ev.dia = (p_desde + n)::date)::bigint, null::text
      from generate_series(0, p_hasta - p_desde) n;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 'citas'::text, null::date, null::bigint, 'fuente_no_migrada'::text;
  end;

  -- licitaciones
  begin
    return query
      with ev as (
        select (t.created_at at time zone 'America/Mexico_City')::date as dia
        from licitaciones.tender t
        where exists (select 1 from licitaciones.requirement_item ri where ri.tender_id = t.id)
      )
      select 'licitaciones'::text, null::date, (select count(*) from ev)::bigint, null::text
      union all
      select 'licitaciones'::text, (p_desde + n)::date, (select count(*) from ev where ev.dia = (p_desde + n)::date)::bigint, null::text
      from generate_series(0, p_hasta - p_desde) n;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 'licitaciones'::text, null::date, null::bigint, 'fuente_no_migrada'::text;
  end;

  -- despachos: sin fuente persistida
  return query select 'despachos'::text, null::date, null::bigint, 'sin_fuente'::text;
end;
$$;
revoke all on function core.get_consola_operaciones_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.get_consola_operaciones_for_superadmin(uuid, date, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) Sucursales / propiedades y usuarios con acceso
-- ═══════════════════════════════════════════════════════════════════════════
-- Sucursales = core.property con status 'active'. Usuarios con acceso = personas DISTINTAS con membresia en una
-- organizacion que no esta suspendida, mas los superadmins de plataforma (una persona que es ambas cosas se
-- cuenta una sola vez).
create or replace function core.get_consola_alcance_for_superadmin(p_caller_id uuid)
returns table (sucursales_activas bigint, staff_con_membresia bigint, superadmins bigint, usuarios_con_acceso bigint)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    with staff as (
      select distinct m.user_id from core.membership m join core.organization o on o.id = m.organization_id where o.status <> 'suspended'
    ),
    sa as (select ps.staff_user_id as user_id from core.platform_superadmin ps)
    select
      (select count(*) from core.property p where p.status = 'active')::bigint,
      (select count(*) from staff)::bigint,
      (select count(*) from sa)::bigint,
      (select count(*) from (select user_id from staff union select user_id from sa) u)::bigint;
end;
$$;
revoke all on function core.get_consola_alcance_for_superadmin(uuid) from public, anon;
grant execute on function core.get_consola_alcance_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6) Conversaciones de WhatsApp por vertical
-- ═══════════════════════════════════════════════════════════════════════════
-- Solo CONTEO (nunca contenido: ni telefonos ni mensajes). restaurantes, hoteles y citas tienen
-- <vertical>.whatsapp_conversations. rentas.conversacion es mensajeria de canal (Airbnb/VRBO/Booking), no
-- WhatsApp; licitaciones y despachos no guardan conversaciones de WhatsApp: esas tres devuelven
-- `razon = 'sin_whatsapp'`, no un 0.
create or replace function core.get_consola_conversaciones_wa_for_superadmin(p_caller_id uuid)
returns table (vertical text, total bigint, razon text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  begin
    return query select 'restaurantes'::text, count(*)::bigint, null::text from restaurantes.whatsapp_conversations;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 'restaurantes'::text, null::bigint, 'fuente_no_migrada'::text;
  end;
  begin
    return query select 'hoteles'::text, count(*)::bigint, null::text from hoteles.whatsapp_conversations;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 'hoteles'::text, null::bigint, 'fuente_no_migrada'::text;
  end;
  begin
    return query select 'citas'::text, count(*)::bigint, null::text from citas.whatsapp_conversations;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select 'citas'::text, null::bigint, 'fuente_no_migrada'::text;
  end;
  return query
    select v.vertical, null::bigint, 'sin_whatsapp'::text
    from (values ('rentas'::text), ('licitaciones'::text), ('despachos'::text)) v (vertical);
end;
$$;
revoke all on function core.get_consola_conversaciones_wa_for_superadmin(uuid) from public, anon;
grant execute on function core.get_consola_conversaciones_wa_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7) Conversaciones resueltas sin humano ("X de N"), medido SOLO en restaurantes
-- ═══════════════════════════════════════════════════════════════════════════
-- N = conversaciones de WhatsApp de restaurantes con actividad en [p_desde, p_hasta) (el dia de Mexico que
-- calcula el API). X = de esas, las 'completed' que NUNCA tuvieron una toma humana (sin fila en
-- restaurantes.conversation_handoff). Las otras cinco verticales no tienen handoff (PL-14): no se miden.
create or replace function core.get_consola_resueltas_sin_humano_for_superadmin(p_caller_id uuid, p_desde timestamptz, p_hasta timestamptz)
returns table (total bigint, resueltas_sin_humano bigint, razon text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde then
    raise exception 'get_consola_resueltas_sin_humano_for_superadmin: rango invalido' using errcode = '22023';
  end if;
  begin
    return query
      select count(*)::bigint,
        (count(*) filter (where c.status = 'completed'
          and not exists (select 1 from restaurantes.conversation_handoff h where h.canal = 'whatsapp' and h.conversation_id = c.id)))::bigint,
        null::text
      from restaurantes.whatsapp_conversations c
      where c.updated_at >= p_desde and c.updated_at < p_hasta;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select null::bigint, null::bigint, 'fuente_no_migrada'::text;
  end;
end;
$$;
revoke all on function core.get_consola_resueltas_sin_humano_for_superadmin(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function core.get_consola_resueltas_sin_humano_for_superadmin(uuid, timestamptz, timestamptz) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8) Actividad de agentes (core.llm_usage_daily por vertical y rol)
-- ═══════════════════════════════════════════════════════════════════════════
-- Historico y ultimos 30 dias (usage_date en (p_hoy - 30, p_hoy]). `p_hoy` lo calcula el API en hora de Mexico.
create or replace function core.get_consola_agentes_actividad_for_superadmin(p_caller_id uuid, p_hoy date)
returns table (
  vertical text, role text,
  llamadas_hist bigint, costo_hist_micro_usd bigint, fallback_hist bigint,
  llamadas_30d bigint, costo_30d_micro_usd bigint, fallback_30d bigint
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_hoy is null then
    raise exception 'get_consola_agentes_actividad_for_superadmin: p_hoy obligatorio' using errcode = '22023';
  end if;
  return query
    select u.vertical, u.role,
      coalesce(sum(u.call_count), 0)::bigint, coalesce(sum(u.cost_micro_usd), 0)::bigint, coalesce(sum(u.fallback_call_count), 0)::bigint,
      coalesce(sum(u.call_count) filter (where u.usage_date > p_hoy - 30 and u.usage_date <= p_hoy), 0)::bigint,
      coalesce(sum(u.cost_micro_usd) filter (where u.usage_date > p_hoy - 30 and u.usage_date <= p_hoy), 0)::bigint,
      coalesce(sum(u.fallback_call_count) filter (where u.usage_date > p_hoy - 30 and u.usage_date <= p_hoy), 0)::bigint
    from core.llm_usage_daily u
    group by u.vertical, u.role
    order by 4 desc, u.vertical, u.role;
end;
$$;
revoke all on function core.get_consola_agentes_actividad_for_superadmin(uuid, date) from public, anon;
grant execute on function core.get_consola_agentes_actividad_for_superadmin(uuid, date) to authenticated;
