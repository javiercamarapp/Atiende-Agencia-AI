-- 044_voz_modo_entrada_gasto_mes_y_latencia.sql
-- Worker de telefonia de voz (VT, apps/voice-worker): tres piezas ADITIVAS sobre la voz de restaurantes (migraciones 025 y 035).
--
--   A) restaurantes.voice_conversation.modo_entrada / franja: como llego la llamada (desborde | total | prueba) y la franja del dia (manana |
--      tarde | noche) segun la hora local de la sucursal. El plan real de Los Taquitos de PM es el DESBORDE (desvio condicional del conmutador):
--      toda llamada que llega al agente en ese modo es una que el personal no contesto. La marca la pone el worker de telefonia.
--   B) restaurantes.voz_marcar_modo_entrada(...): funcion de SOLO SISTEMA que escribe esas dos columnas.
--   C) restaurantes.voz_gasto_mes_micro_usd(...): funcion de SOLO SISTEMA que suma el gasto de voz del mes (zona America/Merida) de una
--      organizacion desde core.usage_cost_event (categoria 'voz'); es lo que el worker compara contra el tope mensual antes de abrir sesion.
--   D) voice_event admite el tipo 'latencia_voz' (latencia de voz a voz de UNA respuesta del agente: del fin de la voz del cliente al primer
--      audio del agente). Va como EVENTO operativo, no como turno: los turnos llevan la transcripcion y solo se guardan con el consentimiento de
--      grabacion de la migracion 030; la latencia es una metrica sin contenido y debe medirse tambien en llamadas sin grabar.
--   E) restaurantes.voz_modo_entrada_kpi(...): lectura para el panel (owner/admin con alcance de la sucursal): por dia local, llamadas y pedidos
--      de las llamadas en modo desborde (ventas recuperadas = suma de los pedidos de esas llamadas, sin cancelados) y latencia de voz a voz
--      p50/p95 (eventos 'latencia_voz').
--
-- Seguridad (cada funcion y cada GRANT con su razon):
--   * Ninguna tabla nueva ni GRANT nuevo a nivel tabla: las dos columnas se agregan a voice_conversation, cuyo GRANT (select a authenticated y
--     service_role) y cuya policy de select (owner/admin de la organizacion) de la migracion 025 ya las cubren. No hay GRANT de escritura: las
--     columnas solo las escribe la funcion B (security definer), nunca un `authenticated` por DML directo. Nada se otorga a anon.
--   * B y C son de SOLO SISTEMA (`auth.uid() is null`, igual que voz_iniciar_conversacion de la 025): reciben organization_id como parametro plano,
--     asi que si aceptaran a un `authenticated`, un tenant podria marcar conversaciones ajenas o leer el gasto de OTRA organizacion por RPC
--     directo. `security definer` + `set search_path` fijo + `revoke all ... from public, anon`; el `grant execute ... to authenticated` es solo
--     para que la sesion de sistema de la API (que corre con ese rol sin usuario) la pueda llamar; la guardia auth.uid() is null es la que protege.
--   * B valida que la conversacion pertenezca a la organizacion declarada (cross-tenant -> false, nunca una fila ajena) y que modo/franja esten en
--     la lista cerrada (22023).
--   * D solo ensancha dos CHECK de voice_event (la lista de tipos y la regla de campos por tipo); ni GRANT ni policy cambian: el unico
--     escritor sigue siendo voz_registrar_evento (solo sistema, 035) y el unico lector la policy de owner/admin de la 035. 'latencia_voz'
--     exige latencia_ms y no lleva texto ni identificadores del cliente.
--   * E es security definer porque lee voice_conversation, voice_event y orders de la organizacion: la autorizacion se hace DENTRO con
--     restaurantes.handoff_actor_en_sucursal(org, sucursal, true) (owner/admin con alcance de ESA sucursal, el mismo contrato que
--     voz_kpis_diarios de la 035) y el filtro por organizacion y sucursal en cada consulta. Sin acceso: 42501. Rango invalido: 22023.

-- ---------------------------------------------------------------------------
-- A) Columnas
-- ---------------------------------------------------------------------------
alter table restaurantes.voice_conversation
  add column if not exists modo_entrada text check (modo_entrada is null or modo_entrada in ('desborde', 'total', 'prueba')),
  add column if not exists franja text check (franja is null or franja in ('manana', 'tarde', 'noche'));

-- ---------------------------------------------------------------------------
-- B) Marcar el modo de entrada (solo sistema)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_marcar_modo_entrada(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_modo text,
  p_franja text
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_rows integer;
begin
  if auth.uid() is not null then
    raise exception 'voz_marcar_modo_entrada es solo de sistema' using errcode = '42501';
  end if;
  if p_modo is null or p_modo not in ('desborde', 'total', 'prueba') then
    raise exception 'voz_marcar_modo_entrada: modo invalido' using errcode = '22023';
  end if;
  if p_franja is null or p_franja not in ('manana', 'tarde', 'noche') then
    raise exception 'voz_marcar_modo_entrada: franja invalida' using errcode = '22023';
  end if;
  update restaurantes.voice_conversation c
     set modo_entrada = p_modo, franja = p_franja
   where c.id = p_conversation_id and c.organization_id = p_organization_id and c.canal = 'llamada';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- C) Gasto de voz del mes de la organizacion (solo sistema)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_gasto_mes_micro_usd(
  p_organization_id uuid,
  p_ahora timestamptz default now()
) returns bigint
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_ini timestamptz;
  v_fin timestamptz;
  v_total bigint;
begin
  if auth.uid() is not null then
    raise exception 'voz_gasto_mes_micro_usd es solo de sistema' using errcode = '42501';
  end if;
  -- Mes calendario en la zona del negocio (Merida), no en UTC: una llamada del 31 a las 20:00 locales es del mes que cierra.
  v_ini := date_trunc('month', coalesce(p_ahora, now()) at time zone 'America/Merida') at time zone 'America/Merida';
  v_fin := v_ini + interval '1 month';
  select coalesce(sum(u.costo_micro_usd), 0)::bigint into v_total
    from core.usage_cost_event u
   where u.organization_id = p_organization_id and u.vertical = 'restaurantes' and u.categoria = 'voz'
     and u.occurred_at >= v_ini and u.occurred_at < v_fin;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- D) voice_event: tipo 'latencia_voz'
-- ---------------------------------------------------------------------------
do $$
declare
  v_nombre text;
begin
  -- Los dos CHECK de la 035 (lista de tipos y regla de campos por tipo) llevan nombre autogenerado: se buscan por su definicion.
  for v_nombre in
    select c.conname from pg_constraint c
     where c.conrelid = 'restaurantes.voice_event'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%tool_call%'
  loop
    execute format('alter table restaurantes.voice_event drop constraint %I', v_nombre);
  end loop;
end $$;

alter table restaurantes.voice_event
  add constraint voice_event_tipo_check check (tipo in ('tool_call', 'error_proveedor', 'latencia_voz')),
  add constraint voice_event_campos_por_tipo_check check (
    (tipo = 'tool_call' and herramienta is not null and latencia_ms is not null)
    or (tipo = 'error_proveedor' and proveedor is not null)
    or (tipo = 'latencia_voz' and latencia_ms is not null)
  );

-- ---------------------------------------------------------------------------
-- E) KPI por dia local: llamadas en desborde, ventas recuperadas y latencia de voz a voz
-- ---------------------------------------------------------------------------
create or replace function restaurantes.voz_modo_entrada_kpi(
  p_organization_id uuid,
  p_property_id uuid,
  p_desde date,
  p_hasta date
) returns table (
  fecha date,
  zona_horaria text,
  llamadas_desborde integer,
  pedidos_desborde integer,
  ventas_recuperadas numeric,
  llamadas_con_modo integer,
  llamadas_con_latencia integer,
  latencia_p50_ms integer,
  latencia_p95_ms integer
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_tz text;
  v_ini timestamptz;
  v_fin timestamptz;
begin
  if not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'voz_modo_entrada_kpi: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 62 then
    raise exception 'voz_modo_entrada_kpi: rango de fechas invalido (maximo 63 dias)' using errcode = '22023';
  end if;
  v_tz := restaurantes.voz_zona_horaria(p_property_id);
  v_ini := p_desde::timestamp at time zone v_tz;
  v_fin := (p_hasta + 1)::timestamp at time zone v_tz;

  return query
  with dias as (
    select d::date as dia from generate_series(p_desde::timestamp, p_hasta::timestamp, interval '1 day') d
  ),
  conv as (
    select (c.started_at at time zone v_tz)::date as dia,
           count(*) filter (where c.modo_entrada is not null)::integer as con_modo,
           count(*) filter (where c.modo_entrada = 'desborde')::integer as desborde,
           count(*) filter (where c.modo_entrada = 'desborde' and c.resultado = 'pedido_creado' and o.id is not null and o.status <> 'cancelado')::integer as pedidos,
           coalesce(sum(o.total) filter (where c.modo_entrada = 'desborde' and c.resultado = 'pedido_creado' and o.id is not null and o.status <> 'cancelado'), 0) as ventas
    from restaurantes.voice_conversation c
    left join restaurantes.orders o on o.id = c.order_id and o.organization_id = c.organization_id
    where c.organization_id = p_organization_id and c.property_id = p_property_id
      and c.canal = 'llamada' and c.started_at >= v_ini and c.started_at < v_fin
    group by 1
  ),
  lat as (
    select (e.ocurrido_at at time zone v_tz)::date as dia,
           count(distinct e.conversation_id)::integer as llamadas,
           (percentile_disc(0.5) within group (order by e.latencia_ms))::integer as p50,
           (percentile_disc(0.95) within group (order by e.latencia_ms))::integer as p95
    from restaurantes.voice_event e
    where e.organization_id = p_organization_id and e.property_id = p_property_id
      and e.tipo = 'latencia_voz' and e.ocurrido_at >= v_ini and e.ocurrido_at < v_fin
    group by 1
  )
  select d.dia, v_tz,
         coalesce(conv.desborde, 0), coalesce(conv.pedidos, 0), coalesce(conv.ventas, 0)::numeric,
         coalesce(conv.con_modo, 0), coalesce(lat.llamadas, 0), lat.p50, lat.p95
  from dias d
  left join conv on conv.dia = d.dia
  left join lat on lat.dia = d.dia
  order by d.dia;
end;
$$;

revoke all on function restaurantes.voz_marcar_modo_entrada(uuid, uuid, text, text) from public, anon;
revoke all on function restaurantes.voz_gasto_mes_micro_usd(uuid, timestamptz) from public, anon;
revoke all on function restaurantes.voz_modo_entrada_kpi(uuid, uuid, date, date) from public, anon;
grant execute on function restaurantes.voz_marcar_modo_entrada(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function restaurantes.voz_gasto_mes_micro_usd(uuid, timestamptz) to authenticated, service_role;
grant execute on function restaurantes.voz_modo_entrada_kpi(uuid, uuid, date, date) to authenticated, service_role;
