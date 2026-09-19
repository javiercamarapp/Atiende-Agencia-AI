-- Back office de plataforma — primera pieza de "Salud operativa": el
-- superadmin hoy NO tiene forma de saber si los 17 crons de `vercel.json`
-- corrieron, si una cola de mensajería (WhatsApp/email) está atascada o con
-- mensajes muertos, o si una fuente de licitaciones está caída. Prueba viva
-- del hueco, ya documentada en el propio código
-- (`apps/api/src/routes/internal/whatsapp-dispatch.ts`): una cola de
-- WhatsApp existió sin cron y nunca se drenó en producción hasta que alguien
-- lo notó leyendo código, no por ninguna alerta.
--
-- Tres piezas:
--
--   1. `core.cron_heartbeat` — una fila por cron (llave = el path EXACTO de
--      `vercel.json::crons`, p. ej. `/internal/licitaciones/discover-tenders`),
--      escrita por `core.record_cron_heartbeat` (función de SISTEMA, invocada
--      SOLO por `apps/api/src/salud/with-heartbeat.ts::withHeartbeat`, que
--      envuelve los 17 handlers `/internal/*` de forma uniforme). Sin RLS
--      ni GRANT directo de tabla -- mismo criterio EXACTO que
--      `core.llm_usage_daily`/`core.billing_webhook_event`: todo acceso pasa
--      por funciones `security definer`.
--
--   2. `core.list_cron_heartbeats_for_superadmin` / `core.get_outbox_health_
--      for_superadmin` / `core.list_licitaciones_source_runs_for_superadmin`
--      -- las 3 funciones de LECTURA del back office, MISMO patrón EXACTO
--      que el resto de plataforma (PRs #127/#130/#137,
--      `0013_superadmin_facturacion.sql`): `security definer` con
--      `p_caller_id uuid` explícito, atado a `auth.uid() is not null and
--      auth.uid() = p_caller_id` + `core.is_platform_superadmin(p_caller_id)`
--      DENTRO de la función (nunca solo en la capa TS), `revoke all ... from
--      public` + `grant execute ... to authenticated`, cero filas para un
--      caller no autorizado (nunca un error que confirme/niegue si hay
--      datos).
--
--   3. `core.get_outbox_health_for_superadmin` / `core.list_licitaciones_
--      source_runs_for_superadmin` CRUZAN esquemas de vertical
--      (`citas`/`hoteles`/`restaurantes`/`despachos`/`rentas`/`licitaciones`)
--      -- por eso fijan `search_path = core, pg_temp` explícito y CALIFICAN
--      cada tabla referenciada con su esquema completo (nunca confían en que
--      `search_path` resuelva un nombre corto). Corren con el privilegio del
--      DUEÑO de la función (security definer), así que un caller
--      `authenticated` sin GRANT directo sobre esas tablas de vertical de
--      todos modos puede leerlas a través de esta función -- exactamente el
--      mismo mecanismo que ya usa `core.list_organization_billing_for_
--      superadmin` para leer `core.organization_billing`.
--
-- Colas de mensajería reales (verificado leyendo cada migración, NUNCA
-- asumido que las 6 verticales comparten esquema): las 6 verticales usan el
-- MISMO nombre de tabla `<vertical>.messaging_outbox`, pero con columnas
-- DISTINTAS:
--   - `citas.messaging_outbox`       (003_waitlist_and_rate_limit.sql):      sin `attempts`/`next_attempt_at`/`claimed_at`/`sent_at`/`last_error*`.
--   - `hoteles.messaging_outbox`     (008_messaging_outbox.sql):             `attempts`, `claimed_at`, `next_attempt_at`, `sent_at`, `last_error_class`.
--   - `restaurantes.messaging_outbox`(007_messaging_outbox.sql):             igual que hoteles (sin `property_id`).
--   - `despachos.messaging_outbox`   (005_email_outbox_and_notificaciones.sql): `attempts`, `last_error` — sin `claimed_at`/`next_attempt_at`/`sent_at`.
--   - `rentas.messaging_outbox`      (011_rentas_email_outbox.sql):          igual que hoteles pero `last_error` (no `_class`).
--   - `licitaciones.messaging_outbox`(018_alert_notifications.sql):          igual que despachos.
-- `get_outbox_health_for_superadmin` de abajo solo agrega lo que TODAS
-- comparten (`status`/`created_at`) más `sent_at` cuando existe (`null::timestamptz`
-- explícito en las 3 que no lo tienen) -- "último enviado" para
-- citas/despachos/licitaciones es entonces `null` honesto (columna que esta
-- migración no inventa), nunca una fecha inferida de `created_at`.
create table core.cron_heartbeat (
  -- El path EXACTO de `vercel.json::crons` (p. ej.
  -- "/internal/licitaciones/discover-tenders") -- MISMA llave que
  -- `apps/api/src/salud/cadencia.ts::cadenciaMinutosPorRuta()` deriva del
  -- mismo `vercel.json`, para que agregar un cron nuevo (una entrada más en
  -- `vercel.json`, un handler más envuelto con `withHeartbeat`) aparezca
  -- solo en el panel como "sin latido todavía" sin tocar esta migración.
  cron_name text primary key,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text check (last_status is null or last_status in ('ok', 'error')),
  -- Truncado a 500 caracteres -- tanto por `left(...)` dentro de
  -- `record_cron_heartbeat` como por este CHECK (defensa en profundidad: un
  -- caller que de algún modo llamara la función con un texto más largo sin
  -- pasar por el `left()` de la función igual no podría insertar la fila).
  last_error text check (last_error is null or length(last_error) <= 500),
  last_duration_ms integer check (last_duration_ms is null or last_duration_ms >= 0),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  updated_at timestamptz not null default now()
);

alter table core.cron_heartbeat enable row level security;
-- Sin NINGUNA policy -- ni `authenticated` ni `service_role` (que no existe
-- como rol real aprovisionado en este monorepo, ver comentario de
-- `0010_llm_usage_budget_schema.sql`) leen/escriben esta tabla directo, todo
-- acceso pasa por las funciones `security definer` de abajo.
revoke all on core.cron_heartbeat from public, anon, authenticated;

-- Función de SISTEMA -- invocada ÚNICAMENTE desde `apps/api/src/salud/
-- with-heartbeat.ts::withHeartbeat` dentro de `engine.withAppSession({
-- userId: null }, ...)` (verificado: ningún call site pasa un `p_caller_id`,
-- a diferencia de las 3 funciones "for_superadmin" de abajo). Mismo patrón
-- EXACTO que `core.record_llm_usage` (`0010_llm_usage_budget_schema.sql`):
-- guard `if auth.uid() is not null then raise ... 42501` como primera línea
-- -- sin este guard, cualquier sesión `authenticated` de CUALQUIER tenant
-- podría escribir latidos falsos por RPC directo (PostgREST expone el
-- esquema `core`, ver `supabase/config.toml::api.schemas`) y esconder un
-- cron muerto real, o inflar `consecutive_failures` de un cron ajeno.
--
-- UPSERT por `cron_name`: `consecutive_failures` se incrementa solo cuando
-- el nuevo estado también es 'error' (encadenado, nunca reinicia el conteo a
-- 1 en cada llamada) y se reinicia a 0 en cualquier corrida 'ok' -- esto
-- alimenta la alerta de "N fallos consecutivos" del motor puro
-- (`apps/api/src/salud/motor.ts::calcularAlertas`).
create or replace function core.record_cron_heartbeat(
  p_cron_name text,
  p_status text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_duration_ms integer,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'record_cron_heartbeat es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('ok', 'error') then
    raise exception 'p_status inválido: %, se esperaba ok|error', p_status using errcode = '22023';
  end if;

  insert into core.cron_heartbeat (cron_name, last_started_at, last_finished_at, last_status, last_error, last_duration_ms, consecutive_failures, updated_at)
  values (
    p_cron_name,
    p_started_at,
    p_finished_at,
    p_status,
    case when p_error is null then null else left(p_error, 500) end,
    greatest(0, coalesce(p_duration_ms, 0)),
    case when p_status = 'error' then 1 else 0 end,
    now()
  )
  on conflict (cron_name) do update set
    last_started_at = excluded.last_started_at,
    last_finished_at = excluded.last_finished_at,
    last_status = excluded.last_status,
    last_error = excluded.last_error,
    last_duration_ms = excluded.last_duration_ms,
    consecutive_failures = case
      when excluded.last_status = 'error' then core.cron_heartbeat.consecutive_failures + 1
      else 0
    end,
    updated_at = now();
end;
$$;

revoke all on function core.record_cron_heartbeat(text, text, timestamptz, timestamptz, integer, text) from public;
grant execute on function core.record_cron_heartbeat(text, text, timestamptz, timestamptz, integer, text) to authenticated;

-- Listado completo de latidos (un cron nuevo agregado a `vercel.json` que
-- todavía no corrió ni una vez simplemente no aparece aquí -- el panel lo
-- trata como "sin_latido todavía", ver `apps/api/src/salud/motor.ts`, nunca
-- como error).
create or replace function core.list_cron_heartbeats_for_superadmin(p_caller_id uuid)
returns table (
  cron_name text,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text,
  last_error text,
  last_duration_ms integer,
  consecutive_failures integer
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select h.cron_name, h.last_started_at, h.last_finished_at, h.last_status, h.last_error, h.last_duration_ms, h.consecutive_failures
  from core.cron_heartbeat h
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by h.cron_name;
$$;

revoke all on function core.list_cron_heartbeats_for_superadmin(uuid) from public;
grant execute on function core.list_cron_heartbeats_for_superadmin(uuid) to authenticated;

-- Lectura agregada de las 6 colas reales en UNA sola consulta SQL (evita 6
-- round-trips desde TypeScript). `queues` fija la lista de colas conocidas
-- (mismas 6 verticales de arriba) para que una cola real pero VACÍA (cero
-- filas insertadas nunca) siga apareciendo con conteos en cero -- un LEFT
-- JOIN, nunca un UNION ALL directo de agregados por vertical (que omitiría
-- silenciosamente una cola sin filas).
--
-- `where (select ok from authorized)` se evalúa una sola vez y filtra TODO
-- el resultado -- caller no autorizado obtiene 0 filas (nunca 6 filas en
-- ceros, que sería indistinguible de "sí autorizado, todo vacío").
create or replace function core.get_outbox_health_for_superadmin(p_caller_id uuid)
returns table (
  queue_name text,
  pending_count bigint,
  processing_count bigint,
  sent_count bigint,
  failed_count bigint,
  dead_count bigint,
  oldest_pending_seconds bigint,
  last_sent_at timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  with authorized as (
    select (auth.uid() is not null and auth.uid() = p_caller_id and core.is_platform_superadmin(p_caller_id)) as ok
  ),
  queues (queue_name) as (
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
  )
  select
    q.queue_name,
    coalesce(count(*) filter (where u.status = 'pending'), 0)::bigint as pending_count,
    coalesce(count(*) filter (where u.status = 'processing'), 0)::bigint as processing_count,
    coalesce(count(*) filter (where u.status = 'sent'), 0)::bigint as sent_count,
    coalesce(count(*) filter (where u.status = 'failed'), 0)::bigint as failed_count,
    coalesce(count(*) filter (where u.status = 'dead'), 0)::bigint as dead_count,
    (extract(epoch from (now() - min(u.created_at) filter (where u.status = 'pending'))))::bigint as oldest_pending_seconds,
    max(u.sent_at) as last_sent_at
  from queues q
  left join unioned u on u.queue_name = q.queue_name
  where (select ok from authorized)
  group by q.queue_name
  order by q.queue_name;
$$;

revoke all on function core.get_outbox_health_for_superadmin(uuid) from public;
grant execute on function core.get_outbox_health_for_superadmin(uuid) to authenticated;

-- Última corrida por (organización, fuente) de `licitaciones.source_run`
-- (`010_source_runs_and_tender_versions.sql`) -- `distinct on` + `order by
-- ... finished_at desc` es el idiom estándar de Postgres para "la fila más
-- reciente por grupo". Una fuente `not_configured` (ver
-- `packages/domain-licitaciones/src/connector-registry.ts`) SÍ aparece aquí
-- si algún día se registró una corrida con ese estado -- la decisión de
-- "esto no es una alerta" vive en el motor puro
-- (`apps/api/src/salud/motor.ts::calcularAlertas`, nunca aquí), esta función
-- solo expone el historial real tal cual.
create or replace function core.list_licitaciones_source_runs_for_superadmin(p_caller_id uuid)
returns table (
  organization_id uuid,
  organization_name text,
  source text,
  state text,
  finished_at timestamptz,
  message text
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select distinct on (r.organization_id, r.source)
    r.organization_id, o.name, r.source, r.state, r.finished_at, r.message
  from licitaciones.source_run r
  join core.organization o on o.id = r.organization_id
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by r.organization_id, r.source, r.finished_at desc;
$$;

revoke all on function core.list_licitaciones_source_runs_for_superadmin(uuid) from public;
grant execute on function core.list_licitaciones_source_runs_for_superadmin(uuid) to authenticated;
