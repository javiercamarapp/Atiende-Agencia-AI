-- Superadmin "Bitacora de corridas" (SA-L-07) y "Panel de agentes" (SA-L-08).
--
-- Dos tablas y cinco funciones:
--
--   core.agent_run         -- una fila por corrida de un agente: cada corrida de cron envuelta con withHeartbeat y
--                             cada turno de los agentes de WhatsApp (restaurantes, hoteles, citas) y el borrador de
--                             mensajeria de rentas. Estado ok | parcial | fallo, tareas hechas/total (null = no
--                             medido), costo (null = no medido), error REDACTADO de 500 caracteres o menos.
--   core.agent_definition  -- catalogo declarativo: id = rol del gateway LLM. Dar de alta un agente es una FILA,
--                             no una migracion.
--
--   core.record_agent_run(...)                          -- SOLO SISTEMA: escribe una corrida.
--   core.system_purge_agent_runs(p_batch)               -- SOLO SISTEMA: purga lo que pasa de la retencion.
--   core.system_agent_is_live(p_agente)                 -- SOLO SISTEMA: true si el catalogo lo marca 'vivo' (decide el aviso in-app).
--   core.list_agent_runs_for_superadmin(...)            -- superadmin: bitacora filtrable (acotada).
--   core.get_agent_panel_for_superadmin(p_caller_id, p_hoy) -- superadmin: una fila por agente del catalogo con su
--                                                         ultima corrida, exito y costo de 30 dias.
--
-- Requiere: 0001, 0010 (core.llm_usage_daily), 0012 (core.is_platform_superadmin), 0025 (core.platform_switch;
-- el panel lo lee el API, no estas funciones), 0036 (core.retention_class).
--
-- Exito y costo de 30 dias CUADRAN con las fuentes: el exito sale de core.agent_run (corridas ok / corridas del
-- agente) y el costo de core.llm_usage_daily (rol del agente y su variante `_escalated`), con la MISMA ventana que
-- core.get_consola_agentes_actividad_for_superadmin (0042): usage_date en (p_hoy - 30, p_hoy], y el dia de las
-- corridas en America/Mexico_City.
--
-- Justificacion de seguridad (cada tabla, grant y funcion trae su razon):
--   * core.agent_run y core.agent_definition: RLS habilitado SIN ninguna politica y REVOKE ALL de public, anon y
--     authenticated. Razon: ningun rol de la aplicacion debe leer ni escribir estas tablas directo; todo acceso
--     pasa por las funciones `security definer` de abajo, cada una con su guard. No hay GRANT a anon ni a nivel
--     columna porque no hay acceso directo de tabla que otorgar.
--   * core.record_agent_run: `security definer`, search_path fijo, REVOKE de public y anon, GRANT EXECUTE a
--     authenticated (la sesion de sistema usa ese rol con sub vacio) y guard `auth.uid() is null`. Razon: sin el
--     guard, cualquier usuario autenticado de cualquier tenant podria escribir corridas falsas por RPC y esconder un
--     fallo real o inflar el exito de un agente. Redaccion defensiva en la propia funcion (correos y numeros largos
--     de telefono) ademas de la que hace el API, para que un texto con datos personales nunca se persista aunque un
--     caller de sistema olvide redactarlo.
--   * core.system_agent_is_live: mismo patron de solo-sistema. Razon: es la unica forma en que el API (sesion de sistema)
--     lee el catalogo para decidir si una corrida en 'fallo' debe avisar a los superadmins; devuelve un booleano, nunca filas.
--   * core.system_purge_agent_runs: mismo patron de solo-sistema. Razon: borra filas; un usuario de staff, aun
--     owner o superadmin, no debe dispararla. Solo borra lo anterior a la retencion registrada y por lotes.
--   * core.list_agent_runs_for_superadmin y core.get_agent_panel_for_superadmin: `security definer`, search_path
--     fijo, `auth.uid() = p_caller_id` y core.is_platform_superadmin(p_caller_id); un caller que no es superadmin,
--     un uid que no coincide o una sesion de sistema recibe CERO filas (nunca un error que confirme o niegue si hay
--     datos). REVOKE de public y anon + GRANT EXECUTE solo a authenticated. Razon: `authenticated` no tiene GRANT
--     sobre las tablas; la funcion es la unica puerta y la lectura de core.llm_usage_daily solo la agrega (sumas),
--     sin datos personales. La bitacora esta acotada a 200 filas y a un rango de 400 dias (22023 si se excede).
--   * Retencion: core.retention_class('plataforma_agent_run', 90 dias, minimo 30, maximo 365, executor 'vertical'):
--     la purga NO la hace core.system_run_retention_purge (que trabaja por organizacion y politica) sino
--     core.system_purge_agent_runs, que el cron de mantenimiento de plataforma invoca con el valor de esta clase.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) core.agent_definition -- catalogo declarativo (dar de alta = una fila)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.agent_definition (
  -- Rol del gateway LLM, con el MISMO formato que core.platform_switch(scope = 'agente'): asi la palanca del panel
  -- y el id del catalogo son la misma clave.
  id text primary key check (id ~ '^[a-z][a-z0-9_]{0,40}:[a-z][a-z0-9_]{0,60}$'),
  nombre text not null check (char_length(btrim(nombre)) between 3 and 80),
  vertical text not null check (vertical ~ '^[a-z][a-z0-9_]{0,39}$'),
  canal text not null check (canal in ('whatsapp', 'voz', 'cron', 'panel', 'api')),
  disparador text not null check (char_length(btrim(disparador)) between 3 and 160),
  -- Rol del gateway del que sale el modelo (la ruta de modelos vive en el API: llm-models.ts).
  modelo_rol text not null check (modelo_rol ~ '^[a-z][a-z0-9_]{0,40}:[a-z][a-z0-9_]{0,60}$'),
  -- Tope diario de gasto en micro-USD (1 USD = 1_000_000); null = sin tope declarado.
  presupuesto_dia_micro_usd bigint check (presupuesto_dia_micro_usd is null or presupuesto_dia_micro_usd >= 0),
  estado text not null default 'disenado' check (estado in ('vivo', 'pausado', 'disenado', 'retirado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table core.agent_definition enable row level security;
-- Sin NINGUNA politica: todo acceso pasa por core.get_agent_panel_for_superadmin.
revoke all on core.agent_definition from public, anon, authenticated;

-- Semilla: los roles reales que hoy existen en el gateway y tienen interruptor de plataforma
-- (apps/api/src/platform-switches.ts::SWITCHABLE_AGENT_ROLES). Todos 'vivo': cada uno esta cableado en el codigo.
insert into core.agent_definition (id, nombre, vertical, canal, disparador, modelo_rol, estado) values
  ('restaurantes:whatsapp_agent', 'Agente de WhatsApp de restaurantes', 'restaurantes', 'whatsapp', 'Mensaje entrante de un comensal', 'restaurantes:whatsapp_agent', 'vivo'),
  ('restaurantes:data_chat', 'Chatea con tus datos de restaurantes', 'restaurantes', 'panel', 'Pregunta del usuario en el panel', 'restaurantes:data_chat', 'vivo'),
  ('hoteles:whatsapp_agent', 'Agente de WhatsApp de hoteles', 'hoteles', 'whatsapp', 'Mensaje entrante de un huesped', 'hoteles:whatsapp_agent', 'vivo'),
  ('hoteles:data_chat', 'Chatea con tus datos de hoteles', 'hoteles', 'panel', 'Pregunta del usuario en el panel', 'hoteles:data_chat', 'vivo'),
  ('citas:whatsapp_agent', 'Agente de WhatsApp de citas', 'citas', 'whatsapp', 'Mensaje entrante de un cliente', 'citas:whatsapp_agent', 'vivo'),
  ('citas:data_chat', 'Chatea con tus datos de citas', 'citas', 'panel', 'Pregunta del usuario en el panel', 'citas:data_chat', 'vivo'),
  ('rentas:mensajeria_agent', 'Borradores de mensajeria de rentas', 'rentas', 'panel', 'El anfitrion pide un borrador con IA', 'rentas:mensajeria_agent', 'vivo'),
  ('rentas:data_chat', 'Chatea con tus datos de rentas', 'rentas', 'panel', 'Pregunta del usuario en el panel', 'rentas:data_chat', 'vivo'),
  ('despachos:data_chat', 'Chatea con tus datos de despachos', 'despachos', 'panel', 'Pregunta del usuario en el panel', 'despachos:data_chat', 'vivo'),
  ('despachos:conciliacion_llm_agent', 'Conciliacion bancaria con IA (nivel 4)', 'despachos', 'panel', 'Movimiento sin resolver por los niveles 1 a 3', 'despachos:conciliacion_llm_agent', 'vivo'),
  ('licitaciones:data_chat', 'Chatea con tus datos de licitaciones', 'licitaciones', 'panel', 'Pregunta del usuario en el panel', 'licitaciones:data_chat', 'vivo'),
  ('licitaciones:requirement_extractor', 'Extractor de requisitos de licitaciones', 'licitaciones', 'panel', 'Convocatoria con bases por analizar', 'licitaciones:requirement_extractor', 'vivo'),
  ('licitaciones:proposal_draft_agent', 'Borrador de propuesta tecnica', 'licitaciones', 'panel', 'El usuario pide un borrador de propuesta', 'licitaciones:proposal_draft_agent', 'vivo'),
  ('licitaciones:junta_question_agent', 'Preguntas para la junta de aclaraciones', 'licitaciones', 'panel', 'El usuario pide borradores de preguntas', 'licitaciones:junta_question_agent', 'vivo');

-- ═══════════════════════════════════════════════════════════════════════════
-- B) core.agent_run -- una fila por corrida
-- ═══════════════════════════════════════════════════════════════════════════
create table core.agent_run (
  id uuid primary key default gen_random_uuid(),
  -- Rol del gateway (agentes LLM: `restaurantes:whatsapp_agent`) o ruta exacta del cron (`/internal/...`).
  agente text not null check (char_length(agente) between 3 and 120),
  vertical text not null check (vertical ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- Null en los crons de plataforma. Si la organizacion se borra, la corrida se conserva sin el vinculo.
  organization_id uuid references core.organization(id) on delete set null,
  disparo text not null check (disparo in ('cron', 'whatsapp', 'voz', 'manual')),
  estado text not null check (estado in ('ok', 'parcial', 'fallo')),
  -- Null = no medido (un cron que no cuenta tareas, un turno de WhatsApp): nunca un 0 inventado.
  tareas_hechas integer check (tareas_hechas is null or tareas_hechas >= 0),
  tareas_total integer check (tareas_total is null or tareas_total >= 0),
  -- micro-USD; null = no medido (el costo real de los LLM vive en core.llm_usage_daily).
  costo_micro_usd bigint check (costo_micro_usd is null or costo_micro_usd >= 0),
  -- Redactado por el API y por record_agent_run; el CHECK es la defensa en profundidad.
  error text check (error is null or char_length(error) <= 500),
  iniciado_en timestamptz not null,
  terminado_en timestamptz not null,
  created_at timestamptz not null default now(),
  constraint agent_run_fin_despues_de_inicio check (terminado_en >= iniciado_en),
  constraint agent_run_tareas_coherentes check (tareas_hechas is null or tareas_total is null or tareas_hechas <= tareas_total)
);
create index agent_run_iniciado_idx on core.agent_run (iniciado_en desc);
create index agent_run_agente_idx on core.agent_run (agente, iniciado_en desc);
create index agent_run_fallo_idx on core.agent_run (iniciado_en desc) where estado <> 'ok';
alter table core.agent_run enable row level security;
revoke all on core.agent_run from public, anon, authenticated;

-- Retencion registrada: 90 dias por defecto (30 a 365). La purga la corre core.system_purge_agent_runs.
insert into core.retention_class (data_class, vertical, description, default_days, min_days, max_days, executor) values
  ('plataforma_agent_run', 'plataforma', 'Bitacora de corridas de agentes y crons (estado, duracion, tareas, costo y error redactado). La purga la corre core.system_purge_agent_runs desde el cron de mantenimiento de plataforma.', 90, 30, 365, 'vertical');

-- ═══════════════════════════════════════════════════════════════════════════
-- C) core.record_agent_run -- SOLO SISTEMA
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.record_agent_run(
  p_agente text,
  p_vertical text,
  p_organization_id uuid,
  p_disparo text,
  p_estado text,
  p_tareas_hechas integer,
  p_tareas_total integer,
  p_costo_micro_usd bigint,
  p_error text,
  p_iniciado_en timestamptz,
  p_terminado_en timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_error text;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'record_agent_run es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_estado not in ('ok', 'parcial', 'fallo') then
    raise exception 'record_agent_run: estado invalido (%), se esperaba ok|parcial|fallo', p_estado using errcode = '22023';
  end if;
  v_error := p_error;
  if v_error is not null then
    -- Defensa en profundidad: correos y secuencias largas de digitos (telefonos, tarjetas) nunca se persisten.
    v_error := regexp_replace(v_error, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[correo]', 'g');
    v_error := regexp_replace(v_error, '\+?[0-9]{7,}', '[numero]', 'g');
    v_error := regexp_replace(v_error, '\(?[0-9]{2,4}\)?[ -][0-9]{3,4}[ -][0-9]{4}', '[numero]', 'g');
    v_error := left(v_error, 500);
  end if;
  insert into core.agent_run (agente, vertical, organization_id, disparo, estado, tareas_hechas, tareas_total, costo_micro_usd, error, iniciado_en, terminado_en)
  values (p_agente, p_vertical, p_organization_id, p_disparo, p_estado, p_tareas_hechas, p_tareas_total, p_costo_micro_usd, v_error, p_iniciado_en, greatest(p_terminado_en, p_iniciado_en))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function core.record_agent_run(text, text, uuid, text, text, integer, integer, bigint, text, timestamptz, timestamptz) from public, anon;
grant execute on function core.record_agent_run(text, text, uuid, text, text, integer, integer, bigint, text, timestamptz, timestamptz) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) core.system_purge_agent_runs -- SOLO SISTEMA
-- ═══════════════════════════════════════════════════════════════════════════
-- Borra por lotes las corridas mas viejas que la retencion de la clase 'plataforma_agent_run'. Devuelve cuantas borro.
create or replace function core.system_purge_agent_runs(p_batch integer default 5000)
returns integer
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_dias integer;
  v_borradas integer;
begin
  if auth.uid() is not null then
    raise exception 'system_purge_agent_runs es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_batch is null or p_batch < 1 or p_batch > 50000 then
    raise exception 'system_purge_agent_runs: p_batch debe estar entre 1 y 50000' using errcode = '22023';
  end if;
  select c.default_days into v_dias from core.retention_class c where c.data_class = 'plataforma_agent_run';
  if v_dias is null then
    return 0;
  end if;
  with viejas as (
    select r.id from core.agent_run r where r.iniciado_en < now() - make_interval(days => v_dias) order by r.iniciado_en limit p_batch
  )
  delete from core.agent_run r using viejas where r.id = viejas.id;
  get diagnostics v_borradas = row_count;
  return v_borradas;
end;
$$;
revoke all on function core.system_purge_agent_runs(integer) from public, anon;
grant execute on function core.system_purge_agent_runs(integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D2) core.system_agent_is_live -- SOLO SISTEMA
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.system_agent_is_live(p_agente text)
returns boolean
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_agent_is_live es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return exists (select 1 from core.agent_definition d where d.id = p_agente and d.estado = 'vivo');
end;
$$;
revoke all on function core.system_agent_is_live(text) from public, anon;
grant execute on function core.system_agent_is_live(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) core.list_agent_runs_for_superadmin -- bitacora filtrable
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_agent_runs_for_superadmin(
  p_caller_id uuid,
  p_agente text default null,
  p_vertical text default null,
  p_estado text default null,
  p_desde timestamptz default null,
  p_hasta timestamptz default null,
  p_limit integer default 50
)
returns table (
  id uuid, agente text, vertical text, organization_id uuid, disparo text, estado text,
  tareas_hechas integer, tareas_total integer, costo_micro_usd bigint, error text,
  iniciado_en timestamptz, terminado_en timestamptz, duracion_ms bigint
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_estado is not null and p_estado not in ('ok', 'parcial', 'fallo') then
    raise exception 'list_agent_runs_for_superadmin: estado invalido' using errcode = '22023';
  end if;
  if p_desde is not null and p_hasta is not null and p_hasta - p_desde > interval '400 days' then
    raise exception 'list_agent_runs_for_superadmin: el rango maximo es de 400 dias' using errcode = '22023';
  end if;
  return query
    select r.id, r.agente, r.vertical, r.organization_id, r.disparo, r.estado,
      r.tareas_hechas, r.tareas_total, r.costo_micro_usd, r.error,
      r.iniciado_en, r.terminado_en,
      (extract(epoch from (r.terminado_en - r.iniciado_en)) * 1000)::bigint
    from core.agent_run r
    where (p_agente is null or r.agente = p_agente)
      and (p_vertical is null or r.vertical = p_vertical)
      and (p_estado is null or r.estado = p_estado)
      and (p_desde is null or r.iniciado_en >= p_desde)
      and (p_hasta is null or r.iniciado_en < p_hasta)
    order by r.iniciado_en desc, r.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;
revoke all on function core.list_agent_runs_for_superadmin(uuid, text, text, text, timestamptz, timestamptz, integer) from public, anon;
grant execute on function core.list_agent_runs_for_superadmin(uuid, text, text, text, timestamptz, timestamptz, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- F) core.get_agent_panel_for_superadmin -- una fila por agente del catalogo
-- ═══════════════════════════════════════════════════════════════════════════
-- `p_hoy` (YYYY-MM-DD, dia de Mexico) lo decide el API: la funcion no lee current_date, asi que es determinista.
create or replace function core.get_agent_panel_for_superadmin(p_caller_id uuid, p_hoy date)
returns table (
  id text, nombre text, vertical text, canal text, disparador text, modelo_rol text,
  presupuesto_dia_micro_usd bigint, estado text,
  ultima_corrida_en timestamptz, ultima_corrida_estado text,
  corridas_30d bigint, corridas_ok_30d bigint,
  llamadas_30d bigint, costo_30d_micro_usd bigint
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_hoy is null then
    raise exception 'get_agent_panel_for_superadmin: p_hoy obligatorio' using errcode = '22023';
  end if;
  return query
    select d.id, d.nombre, d.vertical, d.canal, d.disparador, d.modelo_rol, d.presupuesto_dia_micro_usd, d.estado,
      ult.iniciado_en, ult.estado,
      coalesce(run.total, 0)::bigint, coalesce(run.oks, 0)::bigint,
      coalesce(uso.llamadas, 0)::bigint, coalesce(uso.costo, 0)::bigint
    from core.agent_definition d
    left join lateral (
      select r.iniciado_en, r.estado from core.agent_run r where r.agente = d.id order by r.iniciado_en desc, r.id limit 1
    ) ult on true
    left join lateral (
      select count(*) as total, count(*) filter (where r.estado = 'ok') as oks
      from core.agent_run r
      where r.agente = d.id
        and (r.iniciado_en at time zone 'America/Mexico_City')::date > p_hoy - 30
        and (r.iniciado_en at time zone 'America/Mexico_City')::date <= p_hoy
    ) run on true
    left join lateral (
      select sum(u.call_count) as llamadas, sum(u.cost_micro_usd) as costo
      from core.llm_usage_daily u
      where (u.role = d.id or u.role = d.id || '_escalated')
        and u.usage_date > p_hoy - 30 and u.usage_date <= p_hoy
    ) uso on true
    order by d.vertical, d.id;
end;
$$;
revoke all on function core.get_agent_panel_for_superadmin(uuid, date) from public, anon;
grant execute on function core.get_agent_panel_for_superadmin(uuid, date) to authenticated;
