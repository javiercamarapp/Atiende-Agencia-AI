-- CHAT-07 / MOD-12 -- Presupuesto y costo del Copiloto por organizacion/rol/mes, tope diario de turnos LLM por rol y
-- ventana horaria de fallbacks.
--
-- Que agrega (todo aditivo; ninguna funcion o tabla existente cambia de comportamiento observable):
--   1. core.llm_monthly_reservation.role + core.reserve_llm_monthly_budget (sobrecarga de 4 argumentos): ademas de los topes
--      mensuales de organizacion y plataforma, el Copiloto ("<vertical>:data_chat" y "<vertical>:data_chat_retry") tiene un
--      SUBTOPE del 30 % del tope mensual de su organizacion (core.copiloto_subtope_pct), reservado ANTES de gastar bajo el mismo
--      lock. Devuelve los totales tras reservar para que la API avise al 80 %. La de 3 argumentos queda como envoltorio.
--   2. core.llm_org_role_limit + core.llm_role_daily_turns + core.consume_llm_role_turn: tope diario de turnos LLM por
--      organizacion y rol (configurable por organizacion; sin fila usa el default que manda la API). Atomico: el contador sube
--      solo si no llega al tope, asi que el turno N+1 se rechaza aunque lleguen en paralelo.
--   3. core.llm_usage_hourly + core.record_llm_hour_window: conteo por hora de llamadas y de llamadas que cayeron a un modelo de
--      respaldo (aviso cuando el respaldo supera el 5 % en una hora).
--   4. core.data_chat_query_log.{costo_micro_usd, modelo, rol} + route ampliada ('escalado', 'sin_ia') +
--      core.record_data_chat_query (sobrecarga de 11 argumentos).
--   5. core.get_llm_usage_by_org_role_month_for_superadmin, core.list_llm_org_role_limits_for_superadmin y
--      core.set_llm_org_role_limit_for_superadmin: reporte de gasto por organizacion/rol/mes y edicion del tope diario por rol.
--
-- Compatibilidad con la base SIN migrar: el codigo TypeScript (production/llm-usage-gateway-adapters.ts, data-chat/deps.ts,
-- routes/superadmin-llm-usage.ts) corre cada acceso nuevo en su PROPIA transaccion de sistema o en SAVEPOINT y, si falta la
-- funcion, tabla o columna (42883 / 42P01 / 42703), cae al camino anterior (reserva de 3 argumentos, sin tope diario por rol, sin
-- ventana horaria, bitacora de 7/8 argumentos) o a "no disponible aun" (reporte).
--
-- Requiere: 0001, 0010 (core.llm_*), 0012 (core.is_platform_superadmin), 0029 y 0045 (core.data_chat_query_log).
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, policy y funcion nueva):
--   * core.llm_org_role_limit, core.llm_role_daily_turns, core.llm_usage_hourly: RLS activa SIN ninguna policy y `revoke all` a
--     public/anon/authenticated/service_role => ningun rol de aplicacion lee ni escribe estas tablas directo; todo pasa por las
--     funciones definer de abajo. `anon` no recibe nada. Las tablas no guardan texto de usuarios ni PII: solo ids, rol y contadores.
--   * core.copiloto_subtope_pct: funcion `immutable` sin I/O (constante 30), sin datos que proteger; GRANT execute a authenticated.
--   * core.reserve_llm_monthly_budget (4 args), core.consume_llm_role_turn, core.record_llm_hour_window: SOLO SISTEMA. Security
--     definer con `set search_path = core, pg_temp`, `revoke ... from public, anon`, GRANT execute a authenticated (el rol de
--     BD de todas las sesiones de la API) y guard `auth.uid() is not null -> 42501`: un usuario real (staff de cualquier
--     organizacion) no puede reservar, consumir ni inflar contadores de otra organizacion por RPC directo (mismo hallazgo y
--     remedio que la migracion 0010). La API las llama desde su sesion de sistema.
--   * core.record_data_chat_query (11 args): conserva TODAS las defensas de la de 8 (actor = auth.uid(), 28000 sin actor, 42501 sin
--     membresia, vertical tomada de core.organization). Los tres datos nuevos estan acotados por CHECK de forma y tamano
--     (costo >= 0, modelo <= 80, rol con forma `vertical:nombre`); la tabla sigue siendo append-only.
--   * Funciones *_for_superadmin: security definer, search_path fijo, revoke de public/anon, exigen `auth.uid() = p_caller_id` y
--     `core.is_platform_superadmin(p_caller_id)` (esta ultima delega en core.platform_superadmin). Las de lectura devuelven cero
--     filas a quien no es superadmin; la de escritura lanza 42501. La de escritura acota el tope a 1..100000 turnos y el rol a
--     la forma `vertical:nombre`.

-- ---------------------------------------------------------------------------
-- 1) Subtope del Copiloto dentro del tope mensual de la organizacion
-- ---------------------------------------------------------------------------
alter table core.llm_monthly_reservation add column role text check (role is null or role ~ '^[a-z0-9_]+:[a-z0-9_]+$');

create or replace function core.copiloto_subtope_pct()
returns integer
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$ select 30; $$;

revoke all on function core.copiloto_subtope_pct() from public, anon;
grant execute on function core.copiloto_subtope_pct() to authenticated;

create or replace function core.reserve_llm_monthly_budget(
  p_organization_id uuid,
  p_reservation_id text,
  p_amount_micro_usd bigint,
  p_role text
)
returns table (org_total_micro_usd bigint, org_cap_micro_usd bigint, platform_total_micro_usd bigint, platform_cap_micro_usd bigint)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_month text := to_char(now(), 'YYYY-MM');
  v_org_cap bigint;
  v_platform_cap bigint;
  v_org_total bigint;
  v_platform_total bigint;
  v_copiloto boolean := p_role is not null and p_role ~ ':data_chat(_retry)?$';
  v_copiloto_total bigint;
  v_copiloto_cap bigint;
begin
  if auth.uid() is not null then
    raise exception 'reserve_llm_monthly_budget es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_amount_micro_usd <= 0 then
    raise exception 'reserve_llm_monthly_budget: el monto a reservar debe ser positivo' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('core.llm_monthly_reservation:' || v_month));

  select coalesce(
    (select monthly_cap_micro_usd from core.llm_org_budget where organization_id = p_organization_id),
    core.default_llm_org_monthly_cap_micro_usd()
  ) into v_org_cap;

  select monthly_cap_micro_usd into v_platform_cap from core.llm_platform_budget where id = true;
  if v_platform_cap is null then
    raise exception 'reserve_llm_monthly_budget: no hay tope de plataforma configurado (fila semilla ausente)' using errcode = 'P0002';
  end if;

  select coalesce(sum(amount_micro_usd), 0) into v_org_total
    from core.llm_monthly_reservation where organization_id = p_organization_id and month = v_month;
  select coalesce(sum(amount_micro_usd), 0) into v_platform_total
    from core.llm_monthly_reservation where month = v_month;

  if v_org_total + p_amount_micro_usd > v_org_cap then
    raise exception 'llm_monthly_budget_exceeded:organization:%:%:%', p_organization_id, (v_org_total + p_amount_micro_usd), v_org_cap
      using errcode = 'P0001';
  end if;
  if v_platform_total + p_amount_micro_usd > v_platform_cap then
    raise exception 'llm_monthly_budget_exceeded:platform:%:%:%', p_organization_id, (v_platform_total + p_amount_micro_usd), v_platform_cap
      using errcode = 'P0001';
  end if;

  if v_copiloto then
    v_copiloto_cap := (v_org_cap * core.copiloto_subtope_pct()) / 100;
    select coalesce(sum(amount_micro_usd), 0) into v_copiloto_total
      from core.llm_monthly_reservation
      where organization_id = p_organization_id and month = v_month and role ~ ':data_chat(_retry)?$';
    if v_copiloto_total + p_amount_micro_usd > v_copiloto_cap then
      raise exception 'llm_monthly_budget_exceeded:copiloto:%:%:%', p_organization_id, (v_copiloto_total + p_amount_micro_usd), v_copiloto_cap
        using errcode = 'P0001';
    end if;
  end if;

  insert into core.llm_monthly_reservation (id, organization_id, month, amount_micro_usd, role)
  values (p_reservation_id, p_organization_id, v_month, p_amount_micro_usd, p_role);

  return query select v_org_total + p_amount_micro_usd, v_org_cap, v_platform_total + p_amount_micro_usd, v_platform_cap;
end;
$$;

revoke all on function core.reserve_llm_monthly_budget(uuid, text, bigint, text) from public, anon;
grant execute on function core.reserve_llm_monthly_budget(uuid, text, bigint, text) to authenticated;

comment on function core.reserve_llm_monthly_budget(uuid, text, bigint, text) is
  'Reserva-antes-de-gastar con tope de organizacion, de plataforma y, para roles *:data_chat(_retry), subtope del Copiloto (30 % del tope de la organizacion). Solo sistema.';

-- La de 3 argumentos queda como envoltorio (misma firma, mismo guard, mismo error): una reserva sin rol no cuenta para el subtope.
create or replace function core.reserve_llm_monthly_budget(
  p_organization_id uuid,
  p_reservation_id text,
  p_amount_micro_usd bigint
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'reserve_llm_monthly_budget es solo para la sesión de sistema' using errcode = '42501';
  end if;
  perform * from core.reserve_llm_monthly_budget(p_organization_id, p_reservation_id, p_amount_micro_usd, null::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Tope diario de turnos LLM por organizacion y rol
-- ---------------------------------------------------------------------------
create table core.llm_org_role_limit (
  organization_id uuid not null references core.organization(id) on delete cascade,
  role text not null check (role ~ '^[a-z0-9_]+:[a-z0-9_]+$'),
  max_turnos_dia integer not null check (max_turnos_dia between 1 and 100000),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null,
  primary key (organization_id, role)
);

create table core.llm_role_daily_turns (
  organization_id uuid not null references core.organization(id) on delete cascade,
  usage_date date not null,
  role text not null check (role ~ '^[a-z0-9_]+:[a-z0-9_]+$'),
  turns integer not null default 0 check (turns >= 0),
  primary key (organization_id, usage_date, role)
);
create index llm_role_daily_turns_date_idx on core.llm_role_daily_turns (usage_date);

alter table core.llm_org_role_limit enable row level security;
alter table core.llm_role_daily_turns enable row level security;
revoke all on core.llm_org_role_limit, core.llm_role_daily_turns from public, anon, authenticated, service_role;

-- Consume UN turno del dia para (organizacion, rol). Devuelve allowed=false (sin consumir) si ya se llego al tope.
create or replace function core.consume_llm_role_turn(p_organization_id uuid, p_role text, p_default_limit integer)
returns table (allowed boolean, used integer, max_turnos integer)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_limit integer;
  v_used integer;
  v_day date := current_date;
begin
  if auth.uid() is not null then
    raise exception 'consume_llm_role_turn es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_role is null or p_role !~ '^[a-z0-9_]+:[a-z0-9_]+$' or p_default_limit is null or p_default_limit < 1 then
    raise exception 'consume_llm_role_turn: rol o tope por defecto invalido' using errcode = '22023';
  end if;

  select coalesce((select l.max_turnos_dia from core.llm_org_role_limit l where l.organization_id = p_organization_id and l.role = p_role), p_default_limit)
    into v_limit;

  insert into core.llm_role_daily_turns (organization_id, usage_date, role, turns)
  values (p_organization_id, v_day, p_role, 0)
  on conflict (organization_id, usage_date, role) do nothing;

  -- El UPDATE condicionado toma el candado de la fila: dos turnos en paralelo se serializan y solo suben mientras haya cupo.
  update core.llm_role_daily_turns t
     set turns = t.turns + 1
   where t.organization_id = p_organization_id and t.usage_date = v_day and t.role = p_role and t.turns < v_limit
  returning t.turns into v_used;

  if v_used is not null then
    return query select true, v_used, v_limit;
  else
    select t.turns into v_used from core.llm_role_daily_turns t where t.organization_id = p_organization_id and t.usage_date = v_day and t.role = p_role;
    return query select false, coalesce(v_used, 0), v_limit;
  end if;
end;
$$;

revoke all on function core.consume_llm_role_turn(uuid, text, integer) from public, anon;
grant execute on function core.consume_llm_role_turn(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Ventana horaria de fallbacks
-- ---------------------------------------------------------------------------
create table core.llm_usage_hourly (
  hour_start timestamptz primary key,
  call_count integer not null default 0 check (call_count >= 0),
  fallback_call_count integer not null default 0 check (fallback_call_count >= 0)
);
alter table core.llm_usage_hourly enable row level security;
revoke all on core.llm_usage_hourly from public, anon, authenticated, service_role;

create or replace function core.record_llm_hour_window(p_fallback boolean)
returns table (calls integer, fallbacks integer)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_hour timestamptz := date_trunc('hour', now());
begin
  if auth.uid() is not null then
    raise exception 'record_llm_hour_window es solo para la sesión de sistema' using errcode = '42501';
  end if;
  -- Retencion: solo se conservan 48 horas.
  delete from core.llm_usage_hourly where hour_start < v_hour - interval '48 hours';
  return query
    insert into core.llm_usage_hourly as h (hour_start, call_count, fallback_call_count)
    values (v_hour, 1, case when coalesce(p_fallback, false) then 1 else 0 end)
    on conflict (hour_start) do update
      set call_count = h.call_count + 1,
          fallback_call_count = h.fallback_call_count + case when coalesce(p_fallback, false) then 1 else 0 end
    returning h.call_count, h.fallback_call_count;
end;
$$;

revoke all on function core.record_llm_hour_window(boolean) from public, anon;
grant execute on function core.record_llm_hour_window(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Costo, modelo y rol en la bitacora del Copiloto
-- ---------------------------------------------------------------------------
alter table core.data_chat_query_log
  add column costo_micro_usd bigint check (costo_micro_usd is null or costo_micro_usd >= 0),
  add column modelo text check (modelo is null or char_length(modelo) <= 80),
  add column rol text check (rol is null or rol ~ '^[a-z0-9_]+:[a-z0-9_]+$');

alter table core.data_chat_query_log drop constraint if exists data_chat_query_log_route_check;
alter table core.data_chat_query_log
  add constraint data_chat_query_log_route_check check (route is null or route in ('directa', 'cache', 'llm', 'escalado', 'sin_ia'));

create or replace function core.record_data_chat_query(
  p_organization_id uuid,
  p_tool text,
  p_params jsonb,
  p_outcome text,
  p_row_count integer,
  p_duration_ms integer,
  p_error_code text,
  p_route text,
  p_costo_micro_usd bigint,
  p_modelo text,
  p_rol text
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_vertical text;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'core.record_data_chat_query: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;
  if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_actor) then
    raise exception 'core.record_data_chat_query: el actor % no pertenece a la organizacion %.', v_actor, p_organization_id
      using errcode = '42501';
  end if;

  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;

  insert into core.data_chat_query_log (organization_id, user_id, vertical, tool, params, outcome, row_count, duration_ms, error_code, route, costo_micro_usd, modelo, rol)
  values (
    p_organization_id,
    v_actor,
    v_vertical,
    nullif(regexp_replace(lower(left(p_tool, 80)), '[^a-z0-9_]', '_', 'g'), ''),
    case when p_params is not null and jsonb_typeof(p_params) = 'object' then p_params else '{}'::jsonb end,
    p_outcome,
    greatest(coalesce(p_row_count, 0), 0),
    greatest(coalesce(p_duration_ms, 0), 0),
    left(p_error_code, 60),
    case when p_route in ('directa', 'cache', 'llm', 'escalado', 'sin_ia') then p_route else null end,
    case when p_costo_micro_usd is null then null else greatest(p_costo_micro_usd, 0) end,
    left(p_modelo, 80),
    case when p_rol ~ '^[a-z0-9_]+:[a-z0-9_]+$' then p_rol else null end
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text, bigint, text, text) from public, anon;
grant execute on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text, bigint, text, text) to authenticated;

comment on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text, bigint, text, text) is
  'Como la de 8 argumentos y ademas registra costo real (micro-USD), modelo y rol del turno; route admite escalado y sin_ia.';

-- ---------------------------------------------------------------------------
-- 5) Back office: reporte por organizacion/rol/mes y tope diario por rol
-- ---------------------------------------------------------------------------
create or replace function core.get_llm_usage_by_org_role_month_for_superadmin(p_caller_id uuid, p_from date, p_to date)
returns table (
  organization_id uuid,
  organization_name text,
  role text,
  month text,
  cost_micro_usd bigint,
  call_count bigint,
  fallback_call_count bigint,
  tokens_in bigint,
  tokens_out bigint
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select u.organization_id, o.name, u.role, to_char(u.usage_date, 'YYYY-MM'),
           sum(u.cost_micro_usd)::bigint, sum(u.call_count)::bigint, sum(u.fallback_call_count)::bigint,
           sum(u.tokens_in)::bigint, sum(u.tokens_out)::bigint
      from core.llm_usage_daily u
      join core.organization o on o.id = u.organization_id
     where u.usage_date between p_from and p_to
     group by u.organization_id, o.name, u.role, to_char(u.usage_date, 'YYYY-MM')
     order by to_char(u.usage_date, 'YYYY-MM') desc, sum(u.cost_micro_usd) desc, o.name, u.role
     limit 1000;
end;
$$;

revoke all on function core.get_llm_usage_by_org_role_month_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.get_llm_usage_by_org_role_month_for_superadmin(uuid, date, date) to authenticated;

create or replace function core.list_llm_org_role_limits_for_superadmin(p_caller_id uuid, p_organization_id uuid)
returns table (role text, max_turnos_dia integer, turnos_hoy integer)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select r.role, r.max_turnos_dia, coalesce(t.turns, 0)
      from core.llm_org_role_limit r
      left join core.llm_role_daily_turns t on t.organization_id = r.organization_id and t.role = r.role and t.usage_date = current_date
     where r.organization_id = p_organization_id
     order by r.role;
end;
$$;

revoke all on function core.list_llm_org_role_limits_for_superadmin(uuid, uuid) from public, anon;
grant execute on function core.list_llm_org_role_limits_for_superadmin(uuid, uuid) to authenticated;

create or replace function core.set_llm_org_role_limit_for_superadmin(p_caller_id uuid, p_organization_id uuid, p_role text, p_max_turnos_dia integer)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    raise exception 'No tienes autoridad para cambiar el tope diario por rol.' using errcode = '42501';
  end if;
  if p_role is null or p_role !~ '^[a-z0-9_]+:[a-z0-9_]+$' then
    raise exception 'Rol invalido.' using errcode = '22023';
  end if;
  if p_max_turnos_dia is null or p_max_turnos_dia < 1 or p_max_turnos_dia > 100000 then
    raise exception 'El tope diario debe estar entre 1 y 100000 turnos.' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization where id = p_organization_id) then
    raise exception 'La organización no existe.' using errcode = 'P0002';
  end if;
  insert into core.llm_org_role_limit as l (organization_id, role, max_turnos_dia, updated_by)
  values (p_organization_id, p_role, p_max_turnos_dia, p_caller_id)
  on conflict (organization_id, role) do update set max_turnos_dia = excluded.max_turnos_dia, updated_at = now(), updated_by = excluded.updated_by;
end;
$$;

revoke all on function core.set_llm_org_role_limit_for_superadmin(uuid, uuid, text, integer) from public, anon;
grant execute on function core.set_llm_org_role_limit_for_superadmin(uuid, uuid, text, integer) to authenticated;
