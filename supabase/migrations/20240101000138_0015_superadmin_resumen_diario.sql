-- Back office de plataforma — segunda pieza del "cerebro" de backoffice del
-- superadmin: el RESUMEN DIARIO AUTOMÁTICO. Ya en `main` (PR #140): Gasto de
-- API (`0010_llm_usage_budget_schema.sql`), Facturación
-- (`0013_superadmin_facturacion.sql`), Prospectos (`0012_superadmin_
-- prospectos.sql`, solo en `supabase/migrations/`) y Salud operativa
-- (`0014_superadmin_salud_operativa.sql`). Esta migración NO relee ninguna de
-- esas 4 tablas fuente por su cuenta con una consulta nueva improvisada — para
-- crons/colas/fuentes de licitaciones/tope de plataforma reutiliza EXACTAMENTE
-- el mismo criterio de esas 4 funciones (`list_cron_heartbeats_for_superadmin`/
-- `get_outbox_health_for_superadmin`/`list_licitaciones_source_runs_for_
-- superadmin`/`get_llm_platform_budget_for_superadmin`), solo que atado a
-- `auth.uid() is null` en vez de `auth.uid() = p_caller_id` — ver el porqué
-- abajo.
--
-- Principio rector del producto (repetido aquí porque esta migración es la
-- base de datos de ese principio): el resumen es INFORMATIVO, para el
-- superadmin únicamente — no ejecuta ninguna acción, no contacta a ningún
-- cliente ni tenant. Los NÚMEROS y ALERTAS son SIEMPRE deterministas
-- (calculados en código/SQL, ver `apps/api/src/resumen-diario/motor.ts`); un
-- LLM, si se usa, SOLO redacta un párrafo narrativo a partir de esos números
-- ya calculados — nunca decide qué es una alerta, nunca ve un dato personal
-- (ver `apps/api/src/resumen-diario/redaccion.ts`).
--
-- CUATRO piezas:
--
--   1. `core.daily_ops_summary` — una fila por FECHA (día calendario en
--      America/Mexico_City, resuelto en TS antes de tocar esta tabla, ver
--      `apps/api/src/resumen-diario/motor.ts::ventanaDiaMexico`): el JSON de
--      agregados ya calculados, la narrativa (plantilla determinista o
--      párrafo de LLM), `generado_por` ('llm'|'determinista'), y el costo/
--      modelo/proveedor de la llamada de LLM cuando la hubo. Sin RLS de
--      `auth.uid()` ni GRANT directo — mismo criterio EXACTO que
--      `core.llm_usage_daily`/`core.cron_heartbeat`: todo acceso pasa por
--      funciones `security definer`.
--
--   2. Funciones de LECTURA de FUENTE, de SOLO-SISTEMA (`_for_system`, sin
--      `p_caller_id`, atadas a `auth.uid() is null`) — el agregador
--      (`apps/api/src/resumen-diario/agregador.ts`) SIEMPRE corre en sesión
--      de sistema, tanto desde el cron (`/internal/superadmin/resumen-diario`)
--      como desde "generar ahora" (`POST /superadmin/resumen/generar`, que ya
--      verificó que el caller es superadmin en la capa HTTP antes de invocar
--      el MISMO agregador — un solo camino de código, nunca dos
--      implementaciones del mismo cálculo). Las funciones `*_for_superadmin`
--      existentes (crons/colas/fuentes/tope de plataforma) exigen `auth.uid()
--      = p_caller_id`, así que una sesión de sistema (`auth.uid()` null)
--      SIEMPRE obtendría 0 filas de ellas — de ahí que existan estas 4
--      equivalentes `_for_system`, MISMO cuerpo SQL, guard invertido (`if
--      auth.uid() is not null then raise ... 42501`), nunca una relajación de
--      las originales (que siguen intactas, sin tocar esta migración).
--      `get_outbox_health_for_system` además agrega actividad DEL DÍA
--      (enviados/fallidos/muertos) que las funciones de salud no necesitaban.
--      Las 6 funciones de sección nueva (organizaciones/staff, prospectos,
--      facturación, gasto de LLM del día + top organizaciones, break-glass,
--      correos de superadmins) siguen el MISMO patrón.
--
--      Ventana de "ese día calendario en America/Mexico_City": TS calcula
--      `[p_desde, p_hasta)` como el rango `timestamptz` UTC exacto de ese día
--      (México no observa horario de verano desde 2022 — UTC-6 fijo, ver
--      `ventanaDiaMexico`) y lo pasa ya resuelto — estas funciones NUNCA
--      hacen su propia aritmética de zona horaria, un filtro `>= / <` directo
--      sobre una columna `timestamptz` indexada, nada de `at time zone`
--      envolviendo la columna (que impediría usar el índice).
--
--   3. Funciones de ESCRITURA de SOLO-SISTEMA sobre `daily_ops_summary`
--      (`upsert_daily_ops_summary`/`mark_daily_ops_summary_email_sent`) —
--      mismo guard `auth.uid() is null`, mismo criterio que
--      `core.record_cron_heartbeat`/`core.record_llm_usage`. El upsert es
--      idempotente por `fecha` (re-ejecutar el cron el mismo día ACTUALIZA,
--      nunca duplica) — requisito explícito del diseño.
--
--   4. Funciones de LECTURA para el BACK OFFICE (`_for_superadmin`, con
--      `p_caller_id uuid`, atadas a `auth.uid() is not null and auth.uid() =
--      p_caller_id` + `core.is_platform_superadmin(p_caller_id)`) — MISMO
--      patrón EXACTO que el resto del back office de plataforma
--      (PRs #127/#130/#132/#140).
create table core.daily_ops_summary (
  -- Día calendario en America/Mexico_City (ver el comentario de cabecera) —
  -- llave real, NUNCA un timestamptz: un resumen es de UN día, no de un
  -- instante.
  fecha date primary key,
  -- Todos los números y alertas ya calculados de forma determinista (ver
  -- `apps/api/src/resumen-diario/motor.ts::DiarioAgregados`) — la ÚNICA
  -- fuente de verdad de lo que se muestra/manda por correo; la narrativa de
  -- abajo es prosa DERIVADA de este JSON, nunca al revés.
  agregados jsonb not null,
  -- Párrafo narrativo — SIEMPRE presente (la plantilla determinista en
  -- español es el fallback incondicional, ver `redaccion.ts`); nunca vacío.
  narrativa text not null check (length(narrativa) > 0),
  generado_por text not null check (generado_por in ('llm', 'determinista')),
  -- Costo/modelo/proveedor de la llamada de LLM que redactó la narrativa —
  -- `null` cuando `generado_por = 'determinista'` (sin llamada real que
  -- costear). Se guarda AQUÍ (no en `core.llm_usage_daily`, que exige
  -- `organization_id not null references core.organization` — ver el
  -- comentario largo de `apps/api/src/resumen-diario/redaccion.ts` para la
  -- decisión completa de atribución de gasto de plataforma) porque este
  -- resumen ES el registro de uso de plataforma de esa llamada — la forma
  -- más simple y correcta de no inventar una organización que no existe.
  costo_llm_micro_usd bigint check (costo_llm_micro_usd is null or costo_llm_micro_usd >= 0),
  modelo_llm text,
  proveedor_llm text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  -- `null` = correo todavía no enviado para esta fecha. Se marca UNA sola vez
  -- (ver `core.mark_daily_ops_summary_email_sent` abajo) — "un solo envío por
  -- fecha" es un requisito explícito del diseño.
  correo_enviado_en timestamptz,
  check (generado_por = 'llm' or (costo_llm_micro_usd is null and modelo_llm is null and proveedor_llm is null))
);

alter table core.daily_ops_summary enable row level security;
revoke all on core.daily_ops_summary from public, anon, authenticated;

-- ── Funciones de LECTURA DE FUENTE, de SOLO-SISTEMA ─────────────────────────

-- Espejo de `core.list_cron_heartbeats_for_superadmin` (`0014_superadmin_
-- salud_operativa.sql`), guard invertido — ver el comentario de cabecera.
create or replace function core.list_cron_heartbeats_for_system()
returns table (
  cron_name text,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text,
  last_error text,
  last_duration_ms integer,
  consecutive_failures integer
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'list_cron_heartbeats_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select h.cron_name, h.last_started_at, h.last_finished_at, h.last_status, h.last_error, h.last_duration_ms, h.consecutive_failures
    from core.cron_heartbeat h
    order by h.cron_name;
end;
$$;

revoke all on function core.list_cron_heartbeats_for_system() from public;
grant execute on function core.list_cron_heartbeats_for_system() to authenticated;

-- Espejo de `core.get_outbox_health_for_superadmin` MÁS actividad del día
-- (`sent_hoy`/`fallidos_hoy`/`muertos_hoy`, ventana `[p_desde, p_hasta)`) —
-- ninguna de las 6 tablas de outbox tiene una columna de timestamp propia
-- para "cuándo pasó a failed/dead" (ver el comentario largo de
-- `0014_superadmin_salud_operativa.sql` sobre las diferencias reales de
-- columnas entre verticales) — `fallidos_hoy`/`muertos_hoy` usan `created_at`
-- como la mejor aproximación determinista disponible (documentado, NUNCA
-- escondido): un mensaje encolado ayer que falló/murió hoy no se cuenta hoy,
-- se cuenta el día en que se encoló. `sent_hoy` SÍ usa `sent_at` (columna
-- real) para las 3 verticales que la tienen (hoteles/restaurantes/rentas);
-- para citas/despachos/licitaciones (sin `sent_at`, ver la migración 0014)
-- `sent_hoy` es `null` honesto -- NUNCA se infiere de `created_at`, mismo
-- criterio que `last_sent_at` en la función original.
create or replace function core.get_outbox_health_for_system(p_desde timestamptz, p_hasta timestamptz)
returns table (
  queue_name text,
  pending_count bigint,
  processing_count bigint,
  sent_count bigint,
  failed_count bigint,
  dead_count bigint,
  oldest_pending_seconds bigint,
  last_sent_at timestamptz,
  sent_hoy bigint,
  fallidos_hoy bigint,
  muertos_hoy bigint
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'get_outbox_health_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
  with queues (queue_name) as (
    values ('citas'), ('hoteles'), ('restaurantes'), ('despachos'), ('rentas'), ('licitaciones')
  ),
  unioned as (
    select 'citas' as queue_name, status, created_at, null::timestamptz as sent_at from citas.messaging_outbox
    union all
    select 'hoteles', status, created_at, sent_at from hoteles.messaging_outbox
    union all
    select 'restaurantes', status, created_at, sent_at from restaurantes.messaging_outbox
    union all
    select 'despachos', status, created_at, null::timestamptz from despachos.messaging_outbox
    union all
    select 'rentas', status, created_at, sent_at from rentas.messaging_outbox
    union all
    select 'licitaciones', status, created_at, null::timestamptz from licitaciones.messaging_outbox
  ),
  -- Si la propia vertical no tiene columna sent_at (citas/despachos/licitaciones
  -- -- ver el comentario de arriba), `sent_hoy` debe ser `null`, no `0` (que
  -- confundiría "no se sabe" con "cero enviados hoy") -- `bool_and` sobre "esta
  -- fila tiene sent_at no nulo" nunca aplica porque puede que la vertical no
  -- tenga NINGUNA fila; en vez de eso se resuelve por el nombre de cola fijo.
  sent_at_disponible (queue_name, disponible) as (
    values ('citas', false), ('hoteles', true), ('restaurantes', true), ('despachos', false), ('rentas', true), ('licitaciones', false)
  )
  select
    q.queue_name,
    coalesce(count(*) filter (where u.status = 'pending'), 0)::bigint,
    coalesce(count(*) filter (where u.status = 'processing'), 0)::bigint,
    coalesce(count(*) filter (where u.status = 'sent'), 0)::bigint,
    coalesce(count(*) filter (where u.status = 'failed'), 0)::bigint,
    coalesce(count(*) filter (where u.status = 'dead'), 0)::bigint,
    (extract(epoch from (now() - min(u.created_at) filter (where u.status = 'pending'))))::bigint,
    max(u.sent_at),
    case when d.disponible then coalesce(count(*) filter (where u.status = 'sent' and u.sent_at >= p_desde and u.sent_at < p_hasta), 0)::bigint else null end,
    coalesce(count(*) filter (where u.status = 'failed' and u.created_at >= p_desde and u.created_at < p_hasta), 0)::bigint,
    coalesce(count(*) filter (where u.status = 'dead' and u.created_at >= p_desde and u.created_at < p_hasta), 0)::bigint
  from queues q
  join sent_at_disponible d on d.queue_name = q.queue_name
  left join unioned u on u.queue_name = q.queue_name
  group by q.queue_name, d.disponible
  order by q.queue_name;
end;
$$;

revoke all on function core.get_outbox_health_for_system(timestamptz, timestamptz) from public;
grant execute on function core.get_outbox_health_for_system(timestamptz, timestamptz) to authenticated;

-- Espejo de `core.list_licitaciones_source_runs_for_superadmin`, guard
-- invertido.
create or replace function core.list_licitaciones_source_runs_for_system()
returns table (
  organization_id uuid,
  organization_name text,
  source text,
  state text,
  finished_at timestamptz,
  message text
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'list_licitaciones_source_runs_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select distinct on (r.organization_id, r.source)
      r.organization_id, o.name, r.source, r.state, r.finished_at, r.message
    from licitaciones.source_run r
    join core.organization o on o.id = r.organization_id
    order by r.organization_id, r.source, r.finished_at desc;
end;
$$;

revoke all on function core.list_licitaciones_source_runs_for_system() from public;
grant execute on function core.list_licitaciones_source_runs_for_system() to authenticated;

-- Espejo de `core.get_llm_platform_budget_for_superadmin`, guard invertido —
-- alimenta tanto la alerta de salud (motor puro reutilizado) como el "% del
-- tope de plataforma" del propio resumen.
create or replace function core.get_llm_platform_budget_for_system()
returns table (monthly_cap_micro_usd bigint, alert_threshold_pct numeric, spend_this_month_micro_usd bigint)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'get_llm_platform_budget_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select
      pb.monthly_cap_micro_usd,
      pb.alert_threshold_pct,
      coalesce((select sum(u.cost_micro_usd) from core.llm_usage_daily u where date_trunc('month', u.usage_date) = date_trunc('month', current_date)), 0)::bigint
    from core.llm_platform_budget pb
    where pb.id = true;
end;
$$;

revoke all on function core.get_llm_platform_budget_for_system() from public;
grant execute on function core.get_llm_platform_budget_for_system() to authenticated;

-- Gasto de LLM del día (agregado de plataforma, TODAS las organizaciones) —
-- `usage_date` es la fecha que Postgres ya asignó en `core.record_llm_usage`
-- (`current_date` del servidor al momento de la llamada, ver
-- `0010_llm_usage_budget_schema.sql`) -- limitación preexistente heredada tal
-- cual (no introducida por esta migración): ese bucket puede no coincidir
-- exactamente con el día calendario de America/Mexico_City si el servidor de
-- Postgres corre en otra zona horaria. Se documenta aquí, no se intenta
-- "corregir" retroactivamente un dato que ya se guardó con ese criterio.
create or replace function core.get_llm_usage_total_for_system(p_fecha date)
returns table (cost_micro_usd bigint, tokens_in bigint, tokens_out bigint, call_count bigint)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'get_llm_usage_total_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select coalesce(sum(u.cost_micro_usd), 0)::bigint, coalesce(sum(u.tokens_in), 0)::bigint, coalesce(sum(u.tokens_out), 0)::bigint, coalesce(sum(u.call_count), 0)::bigint
    from core.llm_usage_daily u
    where u.usage_date = p_fecha;
end;
$$;

revoke all on function core.get_llm_usage_total_for_system(date) from public;
grant execute on function core.get_llm_usage_total_for_system(date) to authenticated;

-- Top organizaciones por gasto de LLM del día — mismo criterio de "el
-- listado, tomando los primeros N, ES el top" que
-- `list_llm_usage_by_organization_for_superadmin`.
create or replace function core.list_llm_usage_top_organizaciones_for_system(p_fecha date, p_limit integer)
returns table (organization_id uuid, organization_name text, vertical text, cost_micro_usd bigint, call_count bigint)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'list_llm_usage_top_organizaciones_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select o.id, o.name, o.vertical, sum(u.cost_micro_usd)::bigint, sum(u.call_count)::bigint
    from core.llm_usage_daily u
    join core.organization o on o.id = u.organization_id
    where u.usage_date = p_fecha
    group by o.id, o.name, o.vertical
    order by sum(u.cost_micro_usd) desc
    limit greatest(1, least(coalesce(p_limit, 5), 50));
end;
$$;

revoke all on function core.list_llm_usage_top_organizaciones_for_system(date, integer) from public;
grant execute on function core.list_llm_usage_top_organizaciones_for_system(date, integer) to authenticated;

-- Altas de organizaciones y de staff del día -- una sola fila. `nombres_
-- organizaciones_nuevas` es un array de nombres de ORGANIZACIÓN (dato de
-- negocio, no personal -- explícitamente permitido en el prompt del LLM, ver
-- `redaccion.ts`); NUNCA se incluye aquí ningún nombre/correo de staff
-- (dato de la propia plataforma, pero sin necesidad real de mostrarlo en un
-- resumen ejecutivo -- el conteo basta).
create or replace function core.get_organizaciones_staff_nuevos_for_system(p_desde timestamptz, p_hasta timestamptz)
returns table (organizaciones_nuevas bigint, nombres_organizaciones_nuevas text[], staff_nuevos bigint)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'get_organizaciones_staff_nuevos_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select
      (select count(*) from core.organization o where o.created_at >= p_desde and o.created_at < p_hasta)::bigint,
      coalesce((select array_agg(o.name order by o.created_at) from core.organization o where o.created_at >= p_desde and o.created_at < p_hasta), array[]::text[]),
      (select count(*) from core.staff_user s where s.created_at >= p_desde and s.created_at < p_hasta)::bigint;
end;
$$;

revoke all on function core.get_organizaciones_staff_nuevos_for_system(timestamptz, timestamptz) from public;
grant execute on function core.get_organizaciones_staff_nuevos_for_system(timestamptz, timestamptz) to authenticated;

-- Prospectos: altas del día (`created_at` en la ventana), cambios de estado
-- del día (`updated_at` en la ventana pero NO dado de alta ese mismo día --
-- así una alta no se cuenta dos veces como "cambio de estado", su primer
-- `updated_at` coincide con `created_at`) y prospectos sin movimiento
-- (`updated_at < p_umbral_sin_movimiento`, en un estado NO terminal --
-- `ganado`/`perdido`/`descartado` son el final natural del embudo, no una
-- alerta de abandono). `p_umbral_sin_movimiento` se calcula en TS (`ahora -
-- N días`, ver `motor.ts`), nunca hardcodeado aquí.
create or replace function core.get_prospectos_agregado_for_system(p_desde timestamptz, p_hasta timestamptz, p_umbral_sin_movimiento timestamptz)
returns table (altas bigint, cambios_estado bigint, sin_movimiento bigint)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'get_prospectos_agregado_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select
      (select count(*) from core.prospecto p where p.created_at >= p_desde and p.created_at < p_hasta)::bigint,
      (select count(*) from core.prospecto p where p.updated_at >= p_desde and p.updated_at < p_hasta and not (p.created_at >= p_desde and p.created_at < p_hasta))::bigint,
      (select count(*) from core.prospecto p where p.updated_at < p_umbral_sin_movimiento and p.estado not in ('ganado', 'perdido', 'descartado'))::bigint;
end;
$$;

revoke all on function core.get_prospectos_agregado_for_system(timestamptz, timestamptz, timestamptz) from public;
grant execute on function core.get_prospectos_agregado_for_system(timestamptz, timestamptz, timestamptz) to authenticated;

-- Facturación SaaS de Atiende: altas/bajas/morosos NUEVOS del día, más
-- totales vigentes por estado. `core.organization_billing` no guarda una
-- bitácora de transiciones (solo `updated_at`, ver `0009_billing_saas_
-- schema.sql`) -- la única escritura de esa tabla es el webhook de Stripe
-- (`apps/api/src/routes/billing.ts`), así que "el estado actual cambió hoy"
-- (`updated_at` en la ventana Y el estado actual es el que se cuenta) es la
-- aproximación determinista más honesta disponible sin una bitácora real —
-- documentado, no escondido: dos transiciones el mismo día (p. ej.
-- activa->pago_pendiente->activa) solo dejan ver la última.
create or replace function core.get_facturacion_agregado_for_system(p_desde timestamptz, p_hasta timestamptz)
returns table (
  altas bigint,
  bajas bigint,
  morosos_nuevos bigint,
  activas_total bigint,
  pago_pendiente_total bigint,
  cancelada_total bigint,
  sin_suscripcion_total bigint
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'get_facturacion_agregado_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select
      (select count(*) from core.organization_billing b where b.status = 'activa' and b.updated_at >= p_desde and b.updated_at < p_hasta)::bigint,
      (select count(*) from core.organization_billing b where b.status = 'cancelada' and b.updated_at >= p_desde and b.updated_at < p_hasta)::bigint,
      (select count(*) from core.organization_billing b where b.status = 'pago_pendiente' and b.updated_at >= p_desde and b.updated_at < p_hasta)::bigint,
      (select count(*) from core.organization_billing b where b.status = 'activa')::bigint,
      (select count(*) from core.organization_billing b where b.status = 'pago_pendiente')::bigint,
      (select count(*) from core.organization_billing b where b.status = 'cancelada')::bigint,
      (select count(*) from core.organization o left join core.organization_billing b on b.organization_id = o.id where coalesce(b.status, 'sin_suscripcion') = 'sin_suscripcion')::bigint;
end;
$$;

revoke all on function core.get_facturacion_agregado_for_system(timestamptz, timestamptz) from public;
grant execute on function core.get_facturacion_agregado_for_system(timestamptz, timestamptz) to authenticated;

-- Accesos break-glass abiertos ese día — HOY solo existe en `rentas`
-- (`rentas.break_glass_session`, ver `018_break_glass_wiring.sql`); esta
-- función cruza a ese esquema desde `core` con el MISMO criterio ya
-- establecido (`get_outbox_health_for_superadmin` cruzando a las 6
-- verticales). Si algún día otra vertical agrega su propio break-glass, se
-- suma aquí -- nunca se inventa un dato de una vertical que no lo tiene.
create or replace function core.count_break_glass_abiertos_for_system(p_desde timestamptz, p_hasta timestamptz)
returns bigint
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
declare
  v_count bigint;
begin
  if auth.uid() is not null then
    raise exception 'count_break_glass_abiertos_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select count(*) into v_count from rentas.break_glass_session s where s.opened_at >= p_desde and s.opened_at < p_hasta;
  return v_count;
end;
$$;

revoke all on function core.count_break_glass_abiertos_for_system(timestamptz, timestamptz) from public;
grant execute on function core.count_break_glass_abiertos_for_system(timestamptz, timestamptz) to authenticated;

-- Correos de los superadmins de plataforma vigentes — únicos destinatarios
-- válidos del correo del resumen (ver `apps/api/src/resumen-diario/
-- correo.ts`): NUNCA una lista hardcodeada ni una variable de entorno nueva,
-- siempre `core.platform_superadmin` -> `core.staff_user.email` en vivo.
create or replace function core.list_platform_superadmin_emails_for_system()
returns table (email text)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'list_platform_superadmin_emails_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select s.email
    from core.platform_superadmin ps
    join core.staff_user s on s.id = ps.staff_user_id
    order by s.email;
end;
$$;

revoke all on function core.list_platform_superadmin_emails_for_system() from public;
grant execute on function core.list_platform_superadmin_emails_for_system() to authenticated;

-- ── Funciones de ESCRITURA de SOLO-SISTEMA sobre daily_ops_summary ─────────

-- Idempotente por `fecha` -- re-ejecutar el cron el MISMO día actualiza en
-- vez de duplicar (requisito explícito del diseño). Guard `auth.uid() is not
-- null -> 42501`, mismo patrón que `core.record_cron_heartbeat`/`core.
-- record_llm_usage`: esta función corre SIEMPRE dentro de `engine.
-- withAppSession({ userId: null }, ...)` (ver `apps/api/src/resumen-diario/
-- agregador.ts`), nunca desde una sesión de staff.
create or replace function core.upsert_daily_ops_summary(
  p_fecha date,
  p_agregados jsonb,
  p_narrativa text,
  p_generado_por text,
  p_costo_llm_micro_usd bigint,
  p_modelo_llm text,
  p_proveedor_llm text
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'upsert_daily_ops_summary es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_generado_por not in ('llm', 'determinista') then
    raise exception 'p_generado_por inválido: %, se esperaba llm|determinista', p_generado_por using errcode = '22023';
  end if;

  insert into core.daily_ops_summary (fecha, agregados, narrativa, generado_por, costo_llm_micro_usd, modelo_llm, proveedor_llm, creado_en, actualizado_en)
  values (
    p_fecha, p_agregados, p_narrativa, p_generado_por,
    case when p_generado_por = 'llm' then p_costo_llm_micro_usd else null end,
    case when p_generado_por = 'llm' then p_modelo_llm else null end,
    case when p_generado_por = 'llm' then p_proveedor_llm else null end,
    now(), now()
  )
  on conflict (fecha) do update set
    agregados = excluded.agregados,
    narrativa = excluded.narrativa,
    generado_por = excluded.generado_por,
    costo_llm_micro_usd = excluded.costo_llm_micro_usd,
    modelo_llm = excluded.modelo_llm,
    proveedor_llm = excluded.proveedor_llm,
    actualizado_en = now();
end;
$$;

revoke all on function core.upsert_daily_ops_summary(date, jsonb, text, text, bigint, text, text) from public;
grant execute on function core.upsert_daily_ops_summary(date, jsonb, text, text, bigint, text, text) to authenticated;

-- Marca el envío UNA sola vez -- no-op (retorna false) si ya estaba marcado o
-- si la fecha no existe, mismo criterio idempotente que `core.settle_llm_
-- monthly_budget`. El llamador (`apps/api/src/resumen-diario/correo.ts`)
-- SIEMPRE llama esta función justo DESPUÉS de que Resend aceptó el envío,
-- nunca antes -- así un fallo de red entre el envío y el marcado dejaría
-- `correo_enviado_en` en null y el próximo intento reenviaría (mejor un
-- posible reenvío raro que un "enviado" falso que nunca salió).
create or replace function core.mark_daily_ops_summary_email_sent(p_fecha date)
returns boolean
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_updated boolean;
begin
  if auth.uid() is not null then
    raise exception 'mark_daily_ops_summary_email_sent es solo para la sesión de sistema' using errcode = '42501';
  end if;

  update core.daily_ops_summary
  set correo_enviado_en = now()
  where fecha = p_fecha and correo_enviado_en is null;
  get diagnostics v_updated = row_count;
  return coalesce(v_updated, false);
end;
$$;

revoke all on function core.mark_daily_ops_summary_email_sent(date) from public;
grant execute on function core.mark_daily_ops_summary_email_sent(date) to authenticated;

-- Lectura de SOLO-SISTEMA de una fecha puntual -- el agregador la usa para
-- traer el resumen YA persistido del día calendario ANTERIOR y calcular las
-- deltas (ver `apps/api/src/resumen-diario/agregador.ts`); corre en sesión de
-- sistema tanto desde el cron como desde "generar ahora" (un solo camino de
-- código, ver el comentario de cabecera), así que las 2 funciones de lectura
-- `_for_superadmin` de abajo (que exigen `auth.uid() = p_caller_id`) NUNCA
-- podrían usarse aquí -- MISMO motivo que el resto de las funciones
-- `_for_system` de esta migración.
create or replace function core.get_daily_ops_summary_for_system(p_fecha date)
returns setof core.daily_ops_summary
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'get_daily_ops_summary_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query select d.* from core.daily_ops_summary d where d.fecha = p_fecha;
end;
$$;

revoke all on function core.get_daily_ops_summary_for_system(date) from public;
grant execute on function core.get_daily_ops_summary_for_system(date) to authenticated;

-- ── Funciones de LECTURA para el BACK OFFICE (superadmin real) ─────────────

create or replace function core.list_daily_ops_summaries_for_superadmin(p_caller_id uuid, p_limit integer)
returns setof core.daily_ops_summary
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select d.* from core.daily_ops_summary d
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by d.fecha desc
  limit greatest(1, least(coalesce(p_limit, 30), 365));
$$;

revoke all on function core.list_daily_ops_summaries_for_superadmin(uuid, integer) from public;
grant execute on function core.list_daily_ops_summaries_for_superadmin(uuid, integer) to authenticated;

create or replace function core.get_daily_ops_summary_for_superadmin(p_caller_id uuid, p_fecha date)
returns setof core.daily_ops_summary
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select d.* from core.daily_ops_summary d
  where d.fecha = p_fecha
    and auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id);
$$;

revoke all on function core.get_daily_ops_summary_for_superadmin(uuid, date) from public;
grant execute on function core.get_daily_ops_summary_for_superadmin(uuid, date) to authenticated;
