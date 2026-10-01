-- KPI de voz, alertas operativas y costo por dia para el agente de voz de restaurantes (R-13).
-- Prefijo de supabase/migrations: 20240101000246 (interno restaurantes 035).
-- Requiere: 019 (restaurantes.audit_log), 022 (branch_detail.zona_horaria), 025 (voice_conversation),
-- 028 (restaurantes.handoff_actor_en_sucursal) y la plataforma de costos (core.fx_rate,
-- core.usage_cost_event, core.llm_usage_daily).
--
-- Que agrega (todo NUEVO; ninguna restriccion existente se modifica):
--   1. restaurantes.voice_alert_config -- umbrales configurables por sucursal (costo del dia, tasa de error).
--   2. restaurantes.voice_event        -- eventos que el servicio de voz reporta: llamada a herramienta
--      (con latencia) y error de proveedor (ElevenLabs / Twilio / otros). Hasta hoy nada los guardaba.
--   3. restaurantes.voice_alert        -- alertas internas ya disparadas (una por sucursal, dia y tipo).
--   4. restaurantes.voz_zona_horaria(property)            -- helper interno: zona de la sucursal.
--   5. restaurantes.voz_kpis_diarios(org, property, desde, hasta) -- KPI y costo POR DIA LOCAL.
--   6. restaurantes.voz_evaluar_alertas(org, property)    -- compara hoy contra los umbrales y registra.
--   7. restaurantes.voz_registrar_evento(...)             -- solo sistema: el servicio de voz reporta eventos.
--
-- Decisiones de diseno:
--   * "Dia" = dia calendario en la zona horaria de la SUCURSAL (branch_detail.zona_horaria; si esta vacia
--     o no es una zona valida, America/Mexico_City). Una llamada se cuenta en el dia en que EMPEZO,
--     aunque cruce la medianoche (una llamada, un dia: nada se cuenta dos veces).
--   * Solo canal 'llamada': los previews del panel no son trafico real ni costo del cliente.
--   * Resolucion vs handoff: se deriva de voice_conversation.resultado (pedido_creado | escalado |
--     abandonado). Una llamada sin resultado sigue en curso y no entra en "cerradas".
--   * Costo SIEMPRE en enteros: micro-USD (como core.llm_usage_daily) y centavos MXN. La conversion usa el
--     ultimo core.fx_rate con fecha <= el dia local; sin tipo de cambio, los centavos son NULL ("no
--     disponible"), jamas 0 ni un numero inventado. Redondeo: round() sobre numeric, una vez por dia.
--   * Costo por sucursal = voz en vivo (suma de voice_conversation.costo_estimado_micro_usd, que ya
--     incluye el modelo de voz) + telefonia (core.usage_cost_event categoria 'telefonia' de ESA
--     sucursal). La categoria 'voz' de usage_cost_event NO se suma: es el mismo gasto que ya viene en
--     voice_conversation y se contaria dos veces. El LLM de texto (core.llm_usage_daily) es de la
--     ORGANIZACION (no trae sucursal) y se devuelve aparte, solo a quien tiene alcance de toda la
--     organizacion (membership.property_ids nulo); nunca se reparte a una sucursal.
--   * Sin PII: todo es agregado. No se lee ni se devuelve caller_hash, texto de turnos ni telefonos.
--
-- Justificacion de seguridad de cada GRANT / policy / funcion (una por una):
--
--  * voice_alert_config
--    - RLS habilitado; anon sin ningun privilegio.
--    - SELECT / INSERT / UPDATE: solo owner/admin con alcance a ESA sucursal, via
--      restaurantes.handoff_actor_en_sucursal(org, property, true) (028), que ya valida que la
--      sucursal pertenezca a la organizacion y respeta membership.property_ids. Los umbrales son
--      configuracion comercial: el staff de piso no los ve ni los cambia.
--    - GRANT por COLUMNA: INSERT (property_id, organization_id, umbrales, updated_by, updated_at) y UPDATE
--      solo de umbrales/updated_by/updated_at -- property_id y organization_id no se pueden reescribir.
--      `updated_by` solo puede ser NULL o el propio auth.uid() (with check): nadie firma por otro.
--    - Sin DELETE para authenticated (apagar un umbral = ponerlo en NULL).
--  * voice_event
--    - RLS; SELECT solo owner/admin de la sucursal (misma funcion). SIN INSERT/UPDATE/DELETE para
--      authenticated: solo se escribe por voz_registrar_evento (solo sistema), porque un tenant que
--      pudiera insertar eventos podria disparar o apagar alertas a su favor. Los eventos de otra
--      organizacion son invisibles (cross-tenant) por la misma funcion.
--  * voice_alert
--    - RLS; SELECT solo owner/admin de la sucursal. Sin DML directo: solo voz_evaluar_alertas.
--  * voz_zona_horaria -- helper interno, security definer con search_path fijo, SIN execute para
--    public/anon/authenticated: solo lo invocan las otras funciones (corren como el dueno).
--  * voz_kpis_diarios -- security definer, search_path fijo, revoke de public/anon, execute a
--    authenticated. Guard dentro: auth.uid() no nulo + owner/admin con alcance a la sucursal
--    (42501 si no: misma respuesta para sucursal ajena e inexistente, no confirma su existencia).
--    Definer porque cruza voice_conversation, voice_event y tablas de core sin policy de tenant
--    (usage_cost_event / llm_usage_daily / fx_rate estan cerradas a authenticated); el guard y
--    los filtros por organization_id/property_id son la unica puerta. Rango maximo 62 dias.
--  * voz_evaluar_alertas -- security definer, search_path fijo, mismo guard (owner/admin). Escribe
--    voice_alert (idempotente por sucursal+dia+tipo) y una fila en restaurantes.audit_log con el actor
--    real (auth.uid()), solo la PRIMERA vez que se dispara. No envia nada fuera del sistema.
--  * voz_registrar_evento -- security definer, search_path fijo, SOLO sistema (auth.uid() is null,
--    42501 si no), valida que sucursal y conversacion pertenezcan a la organizacion declarada.
--    EXECUTE a authenticated + service_role, igual que voz_iniciar_conversacion (025): la sesion de
--    sistema del backend corre con el rol authenticated SIN usuario; el guard auth.uid() is null es lo
--    que rechaza a cualquier staff autenticado (un usuario real recibe 42501).
--    Texto libre acotado (herramienta/codigo) y sin mensajes de error del proveedor (podrian traer PII).
--
-- Compatibilidad con base sin migrar: todo es nuevo; el TypeScript degrada con SAVEPOINT ante
-- 42P01/42703/42883 (nada de esto se aplica al mergear).

-- ---------------------------------------------------------------------------
-- 1) Umbrales de alerta por sucursal
-- ---------------------------------------------------------------------------
create table restaurantes.voice_alert_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Centavos MXN enteros. NULL = alerta de costo apagada.
  umbral_costo_dia_centavos_mxn bigint check (umbral_costo_dia_centavos_mxn is null or umbral_costo_dia_centavos_mxn > 0),
  -- Porcentaje entero (errores de proveedor / llamadas del dia). NULL = alerta de error apagada.
  umbral_tasa_error_pct integer check (umbral_tasa_error_pct is null or umbral_tasa_error_pct between 1 and 100),
  -- Con pocas llamadas un solo error da 100%: la alerta de tasa solo evalua con al menos este volumen.
  min_llamadas_tasa_error integer not null default 5 check (min_llamadas_tasa_error between 1 and 1000),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table restaurantes.voice_alert_config enable row level security;

create policy "owner/admin lee los umbrales de alerta de voz" on restaurantes.voice_alert_config for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

create policy "owner/admin crea los umbrales de alerta de voz" on restaurantes.voice_alert_config for insert
  with check (
    restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true)
    and (updated_by is null or updated_by = auth.uid())
  );

create policy "owner/admin actualiza los umbrales de alerta de voz" on restaurantes.voice_alert_config for update
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true))
  with check (
    restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true)
    and (updated_by is null or updated_by = auth.uid())
  );

revoke all on restaurantes.voice_alert_config from public, anon;
grant select on restaurantes.voice_alert_config to authenticated;
grant insert (property_id, organization_id, umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error, updated_by, updated_at)
  on restaurantes.voice_alert_config to authenticated;
grant update (umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error, updated_by, updated_at)
  on restaurantes.voice_alert_config to authenticated;
grant select, insert, update, delete on restaurantes.voice_alert_config to service_role;

-- ---------------------------------------------------------------------------
-- 2) Eventos de voz (latencia de herramientas, errores de proveedor)
-- ---------------------------------------------------------------------------
create table restaurantes.voice_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  conversation_id uuid references restaurantes.voice_conversation(id) on delete cascade,
  tipo text not null check (tipo in ('tool_call', 'error_proveedor')),
  proveedor text check (proveedor is null or proveedor in ('elevenlabs', 'twilio', 'gemini', 'otro')),
  herramienta text check (herramienta is null or char_length(herramienta) between 1 and 80),
  latencia_ms integer check (latencia_ms is null or latencia_ms between 0 and 21600000),
  -- Codigo corto del proveedor (ej. un codigo HTTP o de Twilio), NUNCA el mensaje completo.
  codigo text check (codigo is null or char_length(codigo) between 1 and 80),
  ocurrido_at timestamptz not null default now(),
  check (
    (tipo = 'tool_call' and herramienta is not null and latencia_ms is not null)
    or (tipo = 'error_proveedor' and proveedor is not null)
  )
);
create index voice_event_prop_ocurrido_idx on restaurantes.voice_event (organization_id, property_id, ocurrido_at desc);

alter table restaurantes.voice_event enable row level security;

create policy "owner/admin lee los eventos de voz" on restaurantes.voice_event for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

revoke all on restaurantes.voice_event from public, anon, authenticated;
grant select on restaurantes.voice_event to authenticated;
grant select, insert, update, delete on restaurantes.voice_event to service_role;

-- ---------------------------------------------------------------------------
-- 3) Alertas internas disparadas
-- ---------------------------------------------------------------------------
create table restaurantes.voice_alert (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  fecha date not null,
  tipo text not null check (tipo in ('costo_dia', 'tasa_error')),
  -- costo_dia: centavos MXN; tasa_error: porcentaje entero.
  valor bigint not null check (valor >= 0),
  umbral bigint not null check (umbral > 0),
  created_at timestamptz not null default now(),
  unique (property_id, fecha, tipo)
);

alter table restaurantes.voice_alert enable row level security;

create policy "owner/admin lee las alertas de voz" on restaurantes.voice_alert for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

revoke all on restaurantes.voice_alert from public, anon, authenticated;
grant select on restaurantes.voice_alert to authenticated;
grant select, insert, update, delete on restaurantes.voice_alert to service_role;

-- ---------------------------------------------------------------------------
-- 4) Zona horaria de la sucursal (helper interno)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_zona_horaria(p_property_id uuid)
returns text
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select coalesce(
    (select bd.zona_horaria from restaurantes.branch_detail bd
      where bd.property_id = p_property_id
        and bd.zona_horaria is not null
        and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = bd.zona_horaria)),
    'America/Mexico_City'
  );
$$;

revoke all on function restaurantes.voz_zona_horaria(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) KPI y costo por dia local
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_kpis_diarios(
  p_organization_id uuid,
  p_property_id uuid,
  p_desde date,
  p_hasta date
) returns table (
  fecha date,
  zona_horaria text,
  llamadas integer,
  llamadas_cerradas integer,
  duracion_total_s bigint,
  pedidos_voz integer,
  escaladas integer,
  abandonadas integer,
  errores_proveedor integer,
  errores_elevenlabs integer,
  errores_twilio integer,
  errores_otros integer,
  tool_calls integer,
  tool_p95_ms integer,
  costo_voz_micro_usd bigint,
  costo_telefonia_micro_usd bigint,
  costo_total_centavos_mxn bigint,
  costo_llm_org_micro_usd bigint,
  costo_llm_org_centavos_mxn bigint,
  mxn_por_usd numeric
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_tz text;
  v_org_completa boolean;
  v_ini timestamptz;
  v_fin timestamptz;
begin
  if not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'voz_kpis_diarios: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 62 then
    raise exception 'voz_kpis_diarios: rango de fechas invalido (maximo 63 dias)' using errcode = '22023';
  end if;

  v_tz := restaurantes.voz_zona_horaria(p_property_id);
  v_ini := p_desde::timestamp at time zone v_tz;
  v_fin := (p_hasta + 1)::timestamp at time zone v_tz;

  -- El LLM es de la organizacion: solo con alcance de toda la organizacion (property_ids nulo).
  select exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id
      and m.vertical_role in ('owner', 'admin') and m.property_ids is null
  ) into v_org_completa;

  return query
  with dias as (
    select d::date as dia from generate_series(p_desde::timestamp, p_hasta::timestamp, interval '1 day') d
  ),
  conv as (
    select (c.started_at at time zone v_tz)::date as dia,
           count(*)::integer as llamadas,
           count(*) filter (where c.resultado is not null)::integer as cerradas,
           coalesce(sum(c.duration_s), 0)::bigint as duracion_s,
           count(*) filter (where c.resultado = 'pedido_creado')::integer as pedidos,
           count(*) filter (where c.resultado = 'escalado')::integer as escaladas,
           count(*) filter (where c.resultado = 'abandonado')::integer as abandonadas,
           coalesce(sum(c.costo_estimado_micro_usd), 0)::bigint as costo_voz
    from restaurantes.voice_conversation c
    where c.organization_id = p_organization_id and c.property_id = p_property_id
      and c.canal = 'llamada' and c.started_at >= v_ini and c.started_at < v_fin
    group by 1
  ),
  ev as (
    select (e.ocurrido_at at time zone v_tz)::date as dia,
           count(*) filter (where e.tipo = 'error_proveedor')::integer as errores,
           count(*) filter (where e.tipo = 'error_proveedor' and e.proveedor = 'elevenlabs')::integer as err_el,
           count(*) filter (where e.tipo = 'error_proveedor' and e.proveedor = 'twilio')::integer as err_tw,
           count(*) filter (where e.tipo = 'tool_call')::integer as tools,
           (percentile_disc(0.95) within group (order by e.latencia_ms) filter (where e.tipo = 'tool_call'))::integer as p95
    from restaurantes.voice_event e
    where e.organization_id = p_organization_id and e.property_id = p_property_id
      and e.ocurrido_at >= v_ini and e.ocurrido_at < v_fin
    group by 1
  ),
  tel as (
    select (u.occurred_at at time zone v_tz)::date as dia, sum(u.costo_micro_usd)::bigint as costo
    from core.usage_cost_event u
    where u.organization_id = p_organization_id and u.property_id = p_property_id
      and u.vertical = 'restaurantes' and u.categoria = 'telefonia'
      and u.occurred_at >= v_ini and u.occurred_at < v_fin
    group by 1
  ),
  llm as (
    select l.usage_date as dia, sum(l.cost_micro_usd)::bigint as costo
    from core.llm_usage_daily l
    where v_org_completa and l.organization_id = p_organization_id and l.vertical = 'restaurantes'
      and l.usage_date between p_desde and p_hasta
    group by 1
  )
  select
    d.dia,
    v_tz,
    coalesce(conv.llamadas, 0),
    coalesce(conv.cerradas, 0),
    coalesce(conv.duracion_s, 0)::bigint,
    coalesce(conv.pedidos, 0),
    coalesce(conv.escaladas, 0),
    coalesce(conv.abandonadas, 0),
    coalesce(ev.errores, 0),
    coalesce(ev.err_el, 0),
    coalesce(ev.err_tw, 0),
    (coalesce(ev.errores, 0) - coalesce(ev.err_el, 0) - coalesce(ev.err_tw, 0))::integer,
    coalesce(ev.tools, 0),
    ev.p95,
    coalesce(conv.costo_voz, 0)::bigint,
    coalesce(tel.costo, 0)::bigint,
    case when fx.mxn is null then null
         else round((coalesce(conv.costo_voz, 0) + coalesce(tel.costo, 0))::numeric * fx.mxn / 10000)::bigint end,
    case when v_org_completa then coalesce(llm.costo, 0)::bigint else null end,
    case when v_org_completa and fx.mxn is not null then round(coalesce(llm.costo, 0)::numeric * fx.mxn / 10000)::bigint else null end,
    fx.mxn
  from dias d
  left join conv on conv.dia = d.dia
  left join ev on ev.dia = d.dia
  left join tel on tel.dia = d.dia
  left join llm on llm.dia = d.dia
  left join lateral (
    select f.mxn_por_usd as mxn from core.fx_rate f where f.fecha <= d.dia order by f.fecha desc limit 1
  ) fx on true
  order by d.dia;
end;
$$;

revoke all on function restaurantes.voz_kpis_diarios(uuid, uuid, date, date) from public, anon;
grant execute on function restaurantes.voz_kpis_diarios(uuid, uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Evaluar alertas del dia contra los umbrales
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_evaluar_alertas(
  p_organization_id uuid,
  p_property_id uuid
) returns table (
  fecha date,
  tipo text,
  valor bigint,
  umbral bigint,
  nueva boolean
)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_cfg restaurantes.voice_alert_config%rowtype;
  v_hoy date;
  v_k record;
  v_id uuid;
  v_tasa bigint;
  v_nueva_costo boolean := false;
  v_nueva_tasa boolean := false;
begin
  if not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'voz_evaluar_alertas: sin acceso a la sucursal' using errcode = '42501';
  end if;

  select * into v_cfg from restaurantes.voice_alert_config c where c.property_id = p_property_id and c.organization_id = p_organization_id;
  if not found then
    return;
  end if;

  v_hoy := (now() at time zone restaurantes.voz_zona_horaria(p_property_id))::date;
  select * into v_k from restaurantes.voz_kpis_diarios(p_organization_id, p_property_id, v_hoy, v_hoy) k limit 1;

  if v_cfg.umbral_costo_dia_centavos_mxn is not null
     and v_k.costo_total_centavos_mxn is not null
     and v_k.costo_total_centavos_mxn >= v_cfg.umbral_costo_dia_centavos_mxn then
    insert into restaurantes.voice_alert (organization_id, property_id, fecha, tipo, valor, umbral)
      values (p_organization_id, p_property_id, v_hoy, 'costo_dia', v_k.costo_total_centavos_mxn, v_cfg.umbral_costo_dia_centavos_mxn)
      on conflict (property_id, fecha, tipo) do nothing
      returning id into v_id;
    if v_id is not null then
      v_nueva_costo := true;
      insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
        values (p_organization_id, auth.uid(), 'voz.alerta_costo_dia', 'configuracion', p_property_id, 'costo_dia_centavos_mxn',
                v_cfg.umbral_costo_dia_centavos_mxn::text, v_k.costo_total_centavos_mxn::text);
    end if;
  end if;

  if v_cfg.umbral_tasa_error_pct is not null and v_k.llamadas >= v_cfg.min_llamadas_tasa_error then
    v_tasa := least(100, round(v_k.errores_proveedor * 100.0 / v_k.llamadas))::bigint;
    if v_tasa >= v_cfg.umbral_tasa_error_pct then
      v_id := null;
      insert into restaurantes.voice_alert (organization_id, property_id, fecha, tipo, valor, umbral)
        values (p_organization_id, p_property_id, v_hoy, 'tasa_error', v_tasa, v_cfg.umbral_tasa_error_pct)
        on conflict (property_id, fecha, tipo) do nothing
        returning id into v_id;
      if v_id is not null then
        v_nueva_tasa := true;
        insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
          values (p_organization_id, auth.uid(), 'voz.alerta_tasa_error', 'configuracion', p_property_id, 'tasa_error_pct',
                  v_cfg.umbral_tasa_error_pct::text, v_tasa::text);
      end if;
    end if;
  end if;

  return query
    select a.fecha, a.tipo, a.valor, a.umbral, ((a.tipo = 'costo_dia' and v_nueva_costo) or (a.tipo = 'tasa_error' and v_nueva_tasa))
    from restaurantes.voice_alert a
    where a.organization_id = p_organization_id and a.property_id = p_property_id and a.fecha = v_hoy
    order by a.tipo;
end;
$$;

revoke all on function restaurantes.voz_evaluar_alertas(uuid, uuid) from public, anon;
grant execute on function restaurantes.voz_evaluar_alertas(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) El servicio de voz reporta un evento (solo sistema)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_registrar_evento(
  p_organization_id uuid,
  p_property_id uuid,
  p_conversation_id uuid,
  p_tipo text,
  p_proveedor text,
  p_herramienta text,
  p_latencia_ms integer,
  p_codigo text,
  p_ocurrido_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'voz_registrar_evento es solo de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'la sucursal no pertenece a la organizacion' using errcode = '42501';
  end if;
  if p_conversation_id is not null and not exists (
    select 1 from restaurantes.voice_conversation c
    where c.id = p_conversation_id and c.organization_id = p_organization_id and c.property_id = p_property_id
  ) then
    raise exception 'la conversacion no pertenece a la sucursal' using errcode = '42501';
  end if;
  insert into restaurantes.voice_event (organization_id, property_id, conversation_id, tipo, proveedor, herramienta, latencia_ms, codigo, ocurrido_at)
    values (p_organization_id, p_property_id, p_conversation_id, p_tipo, p_proveedor, left(p_herramienta, 80), p_latencia_ms, left(p_codigo, 80), coalesce(p_ocurrido_at, now()))
    returning id into v_id;
  return v_id;
end;
$$;

revoke all on function restaurantes.voz_registrar_evento(uuid, uuid, uuid, text, text, text, integer, text, timestamptz) from public, anon;
grant execute on function restaurantes.voz_registrar_evento(uuid, uuid, uuid, text, text, text, integer, text, timestamptz) to authenticated, service_role;
