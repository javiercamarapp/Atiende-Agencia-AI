-- Control de gasto de API de LLM — primera pieza del "cerebro" de backoffice
-- pedido por el dueño (ver el comentario de cabecera de
-- `apps/api/src/routes/superadmin-llm-usage.ts` para el diseño completo de las
-- rutas). Auditoría previa de este gateway (packages/agent-core/src/gateway):
--
--   - `budget.ts`/`gateway.ts` YA miden tokens in/out, costo estimado (USD,
--     float) y modelo/proveedor POR LLAMADA, y YA reservan-antes-de-gastar --
--     pero el `BudgetLedgerStore` real usado en producción
--     (`InMemoryBudgetLedgerStore`, ver `apps/api/src/production/llm-gateway.ts`)
--     vive en memoria de PROCESO: un tope diario/de-corrida que reinicia cada
--     vez que Vercel Fluid Compute recicla el contenedor, y que NO es
--     compartido entre instancias concurrentes -- sirve como defensa en
--     profundidad, nunca como fuente de verdad de un tope de negocio real.
--   - Ninguna llamada se PERSISTÍA en ningún lado: cero observabilidad de
--     gasto real, y el superadmin (`apps/web/src/superadmin/`) no mostraba
--     nada de gasto.
--
-- Esta migración agrega, deliberadamente en `core` (no en un domain-<vertical>):
-- mismo criterio que `core.organization`/`core.platform_superadmin`/
-- `core.organization_billing` -- el gasto de LLM cruza las 6 verticales, nunca
-- es dato de negocio de una sola.
--
--   1. `core.llm_usage_daily` -- AGREGADO diario (no una fila por llamada: a la
--      escala de un agente de WhatsApp conversacional, una fila por llamada
--      crecería sin límite útil para el caso de uso real, que es "cuánto
--      gastó cada organización/vertical/proveedor/modelo en un rango de
--      fechas" -- un agregado por día ya responde eso sin perder ninguna
--      dimensión que el back office necesite). Puramente OBSERVACIONAL --
--      alimentado best-effort desde `core.record_llm_usage` (ver abajo), un
--      fallo de esta tabla NUNCA debe poder tumbar una llamada real al LLM
--      (mismo criterio que `hoteles.fraude_audit_log`/`despachos.audit_log`).
--   2. `core.llm_org_budget` / `core.llm_platform_budget` -- el tope MENSUAL
--      configurable por organización + el tope GLOBAL de plataforma, editable
--      por el superadmin.
--   3. `core.llm_monthly_reservation` -- el ledger AUTORITATIVO de
--      reserva-antes-de-gastar mensual (dos fases, igual que
--      `InMemoryBudgetLedgerStore` en agent-core, pero persistente en
--      Postgres: sobrevive a un reinicio y es compartido entre instancias).
--      Separada de `llm_usage_daily` a propósito: la reserva es la fuente de
--      verdad de "¿se puede gastar?" (nunca falla silenciosamente, se exige
--      que exista ANTES de llamar al proveedor); el agregado diario es
--      observabilidad best-effort (puede perder una fila si Postgres está
--      caído en ese instante exacto, sin que eso bloquee nada).
--
-- Mismo criterio de acceso que el resto del back office de plataforma: SIN
-- policy de RLS basada en `auth.uid()` (ninguna de estas filas "pertenece" a
-- un usuario autenticado por columna), SIN GRANT directo de tabla --
-- acceso exclusivamente vía funciones `security definer`. Las funciones que
-- expone el back office de plataforma (lectura/escritura de tope, desgloses)
-- validan `core.is_platform_superadmin(p_caller_id)` DENTRO de la función,
-- nunca solo en la capa TS (mismo criterio que
-- `core.list_prospectos_for_superadmin`/`core.create_prospecto_for_superadmin`).
-- Las funciones INTERNAS (`record_llm_usage`/`reserve_llm_monthly_budget`/
-- `settle_llm_monthly_budget`), llamadas únicamente desde el propio backend
-- (sesión de sistema, `auth.uid()` null, JAMÁS desde una ruta HTTP que reciba
-- un `p_caller_id` de un request) siguen el mismo patrón que
-- `hoteles.record_fraude_audit_log`: `security definer` para poder escribir
-- pese a que no hay `service_role` aprovisionado en este monorepo, GRANT a
-- `authenticated` (nunca solo a `service_role`, que no existe aquí -- bug ya
-- corregido 7 veces en este repo). Reciben `p_organization_id` como parámetro
-- plano (sin `p_caller_id` que autorizar, a diferencia de las funciones del
-- back office de abajo) — así que, a diferencia de
-- `hoteles.record_fraude_audit_log` (auditoría append-only, de bajo impacto si
-- se abusa), SÍ EXIGEN por dentro `auth.uid() is null` (hallazgo real de
-- revisión de PR: `core` está expuesto por PostgREST vía
-- `supabase/config.toml::api.schemas`, y estas 3 funciones controlan gasto y
-- topes reales — sin el guard, cualquier sesión `authenticated` de cualquier
-- tenant podía invocarlas por RPC directo con la `organization_id` de OTRO
-- tenant y agotar su tope mensual, o el de plataforma completa, por DoS).
-- Mismo patrón EXACTO que las 6 funciones de
-- `packages/domain-hoteles/migrations/004_voz_whatsapp_fase2.sql`
-- (endurecidas en `017_rpc_anti_duplicado_authenticated_grants.sql`) y
-- `hoteles.apply_cfdi_webhook_status`: `if auth.uid() is not null then raise
-- exception ... using errcode = '42501'; end if;` como primera línea del
-- cuerpo. Verificado (no asumido): las 3 SIEMPRE se invocan dentro de
-- `engine.withAppSession({ userId: null }, ...)` — ver
-- `apps/api/src/production/llm-usage-gateway-adapters.ts`/
-- `llm-usage-repository.ts`, únicos call sites de `PostgresLlmUsageRepository`
-- en todo el repo — así que el guard nunca frena una llamada real del gateway.

create table core.llm_usage_daily (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  usage_date date not null,
  vertical text not null check (vertical = any (array['hoteles','restaurantes','rentas','licitaciones','citas','despachos'])),
  role text not null,
  provider_id text not null,
  model text not null,
  lane text not null check (lane = any (array['interactive','batch','background'])),
  tokens_in bigint not null default 0 check (tokens_in >= 0),
  tokens_out bigint not null default 0 check (tokens_out >= 0),
  -- Entero SIEMPRE (micro-USD, 1 USD = 1_000_000) -- nunca un float de
  -- dólares, mismo motivo que cualquier columna de dinero de este monorepo
  -- (ver `core.organization_billing`/`hoteles.folio_charge` -- ningún costo
  -- real se guarda como float en este repo).
  cost_micro_usd bigint not null default 0 check (cost_micro_usd >= 0),
  call_count bigint not null default 0 check (call_count >= 0),
  fallback_call_count bigint not null default 0 check (fallback_call_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, usage_date, vertical, role, provider_id, model, lane)
);

create index llm_usage_daily_organization_date_idx on core.llm_usage_daily (organization_id, usage_date);
create index llm_usage_daily_date_idx on core.llm_usage_daily (usage_date);

-- Tope mensual por organización, editable por el superadmin. Sin fila propia
-- -> usa el default de plataforma (`core.default_llm_org_monthly_cap_micro_usd()`,
-- ver abajo) -- nunca "sin tope" (fail-closed: toda organización tiene UN tope
-- real, configurado o por default, jamás un límite infinito implícito).
create table core.llm_org_budget (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  monthly_cap_micro_usd bigint not null check (monthly_cap_micro_usd > 0),
  alert_threshold_pct numeric(5, 2) not null default 80 check (alert_threshold_pct > 0 and alert_threshold_pct <= 100),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);

-- Tope GLOBAL de plataforma -- fila única (patrón `id boolean primary key
-- default true check (id)`, mismo truco que cualquier tabla de configuración
-- singleton). Protege el gasto TOTAL entre TODAS las organizaciones,
-- independiente de que cada una individualmente esté por debajo de su propio
-- tope -- ver el comentario de cabecera de
-- `packages/agent-core/src/gateway/org-monthly-budget.ts`.
create table core.llm_platform_budget (
  id boolean primary key default true check (id),
  monthly_cap_micro_usd bigint not null check (monthly_cap_micro_usd > 0),
  alert_threshold_pct numeric(5, 2) not null default 80 check (alert_threshold_pct > 0 and alert_threshold_pct <= 100),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);

-- Semilla real: $1,000 USD/mes de tope global por defecto (1_000_000_000
-- micro-USD) -- un operador con tráfico real más alto lo ajusta desde el
-- panel de superadmin (`PUT /superadmin/gasto-api/plataforma/tope`), no un
-- límite técnico del sistema.
insert into core.llm_platform_budget (id, monthly_cap_micro_usd, alert_threshold_pct)
values (true, 1000000000, 80)
on conflict (id) do nothing;

-- Ledger AUTORITATIVO de reserva-antes-de-gastar mensual -- puerto Postgres de
-- `OrgMonthlyBudgetStore` (agent-core). Cada fila es UNA reserva (una llamada
-- al LLM en curso, o ya liquidada al costo real) -- nunca un agregado, a
-- propósito: sumar por `(organization_id, month)` en el momento de reservar,
-- bajo un lock, es lo que hace atómico el chequeo de los dos topes (ver
-- `core.reserve_llm_monthly_budget` abajo).
create table core.llm_monthly_reservation (
  id text primary key,
  organization_id uuid not null references core.organization(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  amount_micro_usd bigint not null check (amount_micro_usd >= 0),
  created_at timestamptz not null default now()
);

create index llm_monthly_reservation_org_month_idx on core.llm_monthly_reservation (organization_id, month);
create index llm_monthly_reservation_month_idx on core.llm_monthly_reservation (month);

alter table core.llm_usage_daily enable row level security;
alter table core.llm_org_budget enable row level security;
alter table core.llm_platform_budget enable row level security;
alter table core.llm_monthly_reservation enable row level security;

revoke all on core.llm_usage_daily, core.llm_org_budget, core.llm_platform_budget, core.llm_monthly_reservation from public, anon, authenticated;

-- Tope por defecto para una organización SIN fila propia en `llm_org_budget`
-- -- $100 USD/mes (100_000_000 micro-USD), mismo orden de magnitud que
-- `DEFAULT_LLM_GATEWAY_BUDGET_LIMITS.maxTenantDailyUsd` ($50/día) en
-- `apps/api/src/production/llm-gateway.ts`. `immutable` -- constante pura, sin
-- I/O -- para que el planner la trate como cualquier literal.
create or replace function core.default_llm_org_monthly_cap_micro_usd()
returns bigint
language sql
immutable
as $$
  select 100000000::bigint;
$$;

-- ── Funciones INTERNAS (solo el backend las invoca, sesión de sistema, sin
-- `p_caller_id` -- ver el comentario de cabecera de esta migración). Las 3
-- EXIGEN `auth.uid() is null` (revisión de PR -- antes solo lo decía el
-- comentario, ahora lo hace cumplir la propia función, mismo patrón que
-- `004_voz_whatsapp_fase2.sql`/`017_rpc_anti_duplicado_authenticated_grants.sql`
-- de domain-hoteles) ──────────

-- Registro de uso best-effort -- UPSERT que ACUMULA sobre el agregado del día
-- (nunca reemplaza). `p_fallback_used`: true si el proveedor que respondió no
-- era el primero de la escalera (ver `GatewayCallResult.fallbackUsed`).
--
-- Guard `auth.uid() is not null -> 42501`: MISMO patrón EXACTO que las 6
-- funciones de `packages/domain-hoteles/migrations/004_voz_whatsapp_fase2.sql`
-- (endurecidas en `017_rpc_anti_duplicado_authenticated_grants.sql`) y
-- `hoteles.apply_cfdi_webhook_status`
-- (`020_cfdi_webhook_status_security_definer.sql`). Hallazgo real (revisión de
-- PR): esta función es `security definer` + GRANT a `authenticated` y recibe
-- `p_organization_id` como parámetro plano, SIN este guard -- cualquier sesión
-- autenticada (staff de CUALQUIER tenant, o cualquier cliente con un JWT
-- `authenticated` de Supabase, ver `supabase/config.toml::api.schemas` que
-- expone `core` por PostgREST) podía invocarla por RPC directo para inflar
-- `llm_usage_daily` de una organización ajena -- el comentario de cabecera de
-- esta migración YA decía "solo el backend las invoca, sesión de sistema" pero
-- nada lo hacía cumplir. Verificado (`apps/api/src/production/llm-usage-
-- gateway-adapters.ts`/`llm-usage-repository.ts`): las tres funciones internas
-- de esta migración SIEMPRE se llaman dentro de
-- `engine.withAppSession({ userId: null }, ...)` -- nunca dentro de una sesión
-- de staff -- así que el guard es seguro (nunca frena una llamada real del
-- gateway, solo bloquea un RPC directo con `auth.uid()` real).
create or replace function core.record_llm_usage(
  p_organization_id uuid,
  p_vertical text,
  p_role text,
  p_provider_id text,
  p_model text,
  p_lane text,
  p_tokens_in bigint,
  p_tokens_out bigint,
  p_cost_micro_usd bigint,
  p_fallback_used boolean
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'record_llm_usage es solo para la sesión de sistema' using errcode = '42501';
  end if;

  insert into core.llm_usage_daily (
    organization_id, usage_date, vertical, role, provider_id, model, lane,
    tokens_in, tokens_out, cost_micro_usd, call_count, fallback_call_count
  )
  values (
    p_organization_id, current_date, p_vertical, p_role, p_provider_id, p_model, p_lane,
    greatest(0, p_tokens_in), greatest(0, p_tokens_out), greatest(0, p_cost_micro_usd), 1,
    case when p_fallback_used then 1 else 0 end
  )
  on conflict (organization_id, usage_date, vertical, role, provider_id, model, lane)
  do update set
    tokens_in = core.llm_usage_daily.tokens_in + excluded.tokens_in,
    tokens_out = core.llm_usage_daily.tokens_out + excluded.tokens_out,
    cost_micro_usd = core.llm_usage_daily.cost_micro_usd + excluded.cost_micro_usd,
    call_count = core.llm_usage_daily.call_count + 1,
    fallback_call_count = core.llm_usage_daily.fallback_call_count + excluded.fallback_call_count,
    updated_at = now();
end;
$$;

revoke all on function core.record_llm_usage(uuid, text, text, text, text, text, bigint, bigint, bigint, boolean) from public;
grant execute on function core.record_llm_usage(uuid, text, text, text, text, text, bigint, bigint, bigint, boolean) to authenticated;

-- Reserva-antes-de-gastar MENSUAL, atómica: chequeo de los dos topes (de la
-- organización y de la plataforma completa) + INSERT de la reserva, todo
-- dentro de la misma transacción -- si cualquiera de los dos topes se
-- excede, lanza y NO INSERTA nada (nunca queda una reserva fantasma).
--
-- `pg_advisory_xact_lock` serializa las reservas del MISMO mes (liberado
-- automáticamente al terminar la transacción) -- necesario porque el chequeo
-- de plataforma suma entre TODAS las organizaciones: sin el lock, dos
-- llamadas concurrentes de organizaciones distintas podrían leer el mismo
-- total de plataforma antes de que ninguna de las dos hubiera insertado
-- todavía (TOCTOU clásico), dejando pasar más gasto del que el tope global
-- permite. El costo es serializar TODAS las reservas de TODO el mes entre
-- TODAS las organizaciones -- aceptable a este volumen (una reserva es un
-- INSERT + dos SUM ya indexados, del orden de milisegundos); si el volumen
-- real de llamadas a LLM de la plataforma completa lo justifica algún día,
-- la optimización natural es un lock por-organización más un contador
-- agregado de plataforma actualizado con `for update`, no una reescritura de
-- este contrato.
-- Guard `auth.uid() is not null -> 42501`: ver el comentario de
-- `core.record_llm_usage` arriba -- mismo hallazgo, mismo remedio. Sin este
-- guard, cualquier sesión autenticada podía llamar
-- `reserve_llm_monthly_budget(<organización ajena>, <id>, <monto enorme>)` por
-- RPC directo y agotar el tope MENSUAL de otra organización (o el de
-- plataforma completa, que es compartido entre todas) -- denegación de
-- servicio real del LLM para el resto de las organizaciones.
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
declare
  v_month text := to_char(now(), 'YYYY-MM');
  v_org_cap bigint;
  v_platform_cap bigint;
  v_org_total bigint;
  v_platform_total bigint;
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
    from core.llm_monthly_reservation
    where organization_id = p_organization_id and month = v_month;

  select coalesce(sum(amount_micro_usd), 0) into v_platform_total
    from core.llm_monthly_reservation
    where month = v_month;

  if v_org_total + p_amount_micro_usd > v_org_cap then
    raise exception 'llm_monthly_budget_exceeded:organization:%:%:%', p_organization_id, (v_org_total + p_amount_micro_usd), v_org_cap
      using errcode = 'P0001';
  end if;

  if v_platform_total + p_amount_micro_usd > v_platform_cap then
    raise exception 'llm_monthly_budget_exceeded:platform:%:%:%', p_organization_id, (v_platform_total + p_amount_micro_usd), v_platform_cap
      using errcode = 'P0001';
  end if;

  insert into core.llm_monthly_reservation (id, organization_id, month, amount_micro_usd)
  values (p_reservation_id, p_organization_id, v_month, p_amount_micro_usd);
end;
$$;

revoke all on function core.reserve_llm_monthly_budget(uuid, text, bigint) from public;
grant execute on function core.reserve_llm_monthly_budget(uuid, text, bigint) to authenticated;

-- Liquida una reserva ya hecha al costo real -- no-op (idempotente) si
-- `p_reservation_id` no existe, mismo criterio que
-- `InMemoryBudgetLedgerStore.settle`/`InMemoryOrgMonthlyBudgetStore.settle`.
--
-- Guard `auth.uid() is not null -> 42501`: ver el comentario de
-- `core.record_llm_usage` más arriba -- mismo hallazgo, mismo remedio. Pasa de
-- `language sql` a `language plpgsql` únicamente para poder expresar el `if`
-- del guard (un solo `update`, sin cambio de comportamiento del UPDATE en sí).
create or replace function core.settle_llm_monthly_budget(
  p_reservation_id text,
  p_actual_micro_usd bigint
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'settle_llm_monthly_budget es solo para la sesión de sistema' using errcode = '42501';
  end if;

  update core.llm_monthly_reservation
  set amount_micro_usd = greatest(0, coalesce(p_actual_micro_usd, amount_micro_usd))
  where id = p_reservation_id;
end;
$$;

revoke all on function core.settle_llm_monthly_budget(text, bigint) from public;
grant execute on function core.settle_llm_monthly_budget(text, bigint) to authenticated;

-- ── Funciones del BACK OFFICE de plataforma (superadmin) ─────────────────────
-- Mismo criterio que `core.list_prospectos_for_superadmin`: validan
-- `core.is_platform_superadmin(p_caller_id)` DENTRO de la función. Las de
-- LECTURA devuelven cero filas para un caller no-superadmin (nunca un error
-- que confirme/niegue si hay datos); las de ESCRITURA lanzan `errcode 42501`.

create or replace function core.get_llm_usage_summary_for_superadmin(p_caller_id uuid, p_from date, p_to date)
returns table (tokens_in bigint, tokens_out bigint, cost_micro_usd bigint, call_count bigint, fallback_call_count bigint)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    coalesce(sum(u.tokens_in), 0),
    coalesce(sum(u.tokens_out), 0),
    coalesce(sum(u.cost_micro_usd), 0),
    coalesce(sum(u.call_count), 0),
    coalesce(sum(u.fallback_call_count), 0)
  from core.llm_usage_daily u
  where core.is_platform_superadmin(p_caller_id)
    and u.usage_date between p_from and p_to;
$$;

revoke all on function core.get_llm_usage_summary_for_superadmin(uuid, date, date) from public;
grant execute on function core.get_llm_usage_summary_for_superadmin(uuid, date, date) to authenticated;

-- Desglose por organización -- incluye el tope configurado (o el default) y
-- el gasto REAL del mes en curso (para la barra de "% de tope usado" del
-- panel), además del gasto del RANGO de fechas pedido (que puede no coincidir
-- con "el mes en curso" -- son dos preguntas distintas: "cuánto cabe todavía
-- este mes" vs. "cuánto gastó en el rango que estoy mirando").
create or replace function core.list_llm_usage_by_organization_for_superadmin(p_caller_id uuid, p_from date, p_to date)
returns table (
  organization_id uuid,
  organization_name text,
  organization_slug text,
  vertical text,
  tokens_in bigint,
  tokens_out bigint,
  cost_micro_usd bigint,
  call_count bigint,
  monthly_cap_micro_usd bigint,
  alert_threshold_pct numeric,
  spend_this_month_micro_usd bigint
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    o.id,
    o.name,
    o.slug,
    o.vertical,
    coalesce(r.tokens_in, 0),
    coalesce(r.tokens_out, 0),
    coalesce(r.cost_micro_usd, 0),
    coalesce(r.call_count, 0),
    coalesce(b.monthly_cap_micro_usd, core.default_llm_org_monthly_cap_micro_usd()),
    coalesce(b.alert_threshold_pct, 80),
    coalesce(m.spend_this_month_micro_usd, 0)
  from core.organization o
  left join lateral (
    select sum(u.tokens_in) as tokens_in, sum(u.tokens_out) as tokens_out, sum(u.cost_micro_usd) as cost_micro_usd, sum(u.call_count) as call_count
    from core.llm_usage_daily u
    where u.organization_id = o.id and u.usage_date between p_from and p_to
  ) r on true
  left join core.llm_org_budget b on b.organization_id = o.id
  left join lateral (
    select sum(u.cost_micro_usd) as spend_this_month_micro_usd
    from core.llm_usage_daily u
    where u.organization_id = o.id and date_trunc('month', u.usage_date) = date_trunc('month', current_date)
  ) m on true
  where core.is_platform_superadmin(p_caller_id)
  order by coalesce(r.cost_micro_usd, 0) desc;
$$;

revoke all on function core.list_llm_usage_by_organization_for_superadmin(uuid, date, date) from public;
grant execute on function core.list_llm_usage_by_organization_for_superadmin(uuid, date, date) to authenticated;

-- Desglose por vertical + proveedor + modelo -- `p_organization_id` opcional
-- (null = plataforma completa, mismo criterio de filtro opcional que el resto
-- de este monorepo, ej. `packages/db/src/*` con parámetros `is null or`).
create or replace function core.list_llm_usage_by_provider_model_for_superadmin(p_caller_id uuid, p_from date, p_to date, p_organization_id uuid default null)
returns table (
  vertical text,
  provider_id text,
  model text,
  tokens_in bigint,
  tokens_out bigint,
  cost_micro_usd bigint,
  call_count bigint
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    u.vertical,
    u.provider_id,
    u.model,
    sum(u.tokens_in),
    sum(u.tokens_out),
    sum(u.cost_micro_usd),
    sum(u.call_count)
  from core.llm_usage_daily u
  where core.is_platform_superadmin(p_caller_id)
    and u.usage_date between p_from and p_to
    and (p_organization_id is null or u.organization_id = p_organization_id)
  group by u.vertical, u.provider_id, u.model
  order by sum(u.cost_micro_usd) desc;
$$;

revoke all on function core.list_llm_usage_by_provider_model_for_superadmin(uuid, date, date, uuid) from public;
grant execute on function core.list_llm_usage_by_provider_model_for_superadmin(uuid, date, date, uuid) to authenticated;

create or replace function core.get_llm_platform_budget_for_superadmin(p_caller_id uuid)
returns table (monthly_cap_micro_usd bigint, alert_threshold_pct numeric, spend_this_month_micro_usd bigint)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    pb.monthly_cap_micro_usd,
    pb.alert_threshold_pct,
    coalesce((select sum(u.cost_micro_usd) from core.llm_usage_daily u where date_trunc('month', u.usage_date) = date_trunc('month', current_date)), 0)
  from core.llm_platform_budget pb
  where core.is_platform_superadmin(p_caller_id) and pb.id = true;
$$;

revoke all on function core.get_llm_platform_budget_for_superadmin(uuid) from public;
grant execute on function core.get_llm_platform_budget_for_superadmin(uuid) to authenticated;

-- Escritura del tope por organización -- upsert real (`insert ... on conflict
-- do update`), nunca "crea si no existe, ignora si ya existe" (el superadmin
-- SIEMPRE espera que su edición tome efecto).
create or replace function core.set_llm_org_monthly_cap_for_superadmin(
  p_caller_id uuid,
  p_organization_id uuid,
  p_monthly_cap_micro_usd bigint,
  p_alert_threshold_pct numeric
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_monthly_cap_micro_usd <= 0 then
    raise exception 'el tope mensual debe ser positivo' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organization where id = p_organization_id) then
    raise exception 'organización no encontrada' using errcode = 'P0002';
  end if;

  insert into core.llm_org_budget (organization_id, monthly_cap_micro_usd, alert_threshold_pct, updated_by)
  values (p_organization_id, p_monthly_cap_micro_usd, coalesce(p_alert_threshold_pct, 80), p_caller_id)
  on conflict (organization_id) do update set
    monthly_cap_micro_usd = excluded.monthly_cap_micro_usd,
    alert_threshold_pct = excluded.alert_threshold_pct,
    updated_by = excluded.updated_by,
    updated_at = now();
end;
$$;

revoke all on function core.set_llm_org_monthly_cap_for_superadmin(uuid, uuid, bigint, numeric) from public;
grant execute on function core.set_llm_org_monthly_cap_for_superadmin(uuid, uuid, bigint, numeric) to authenticated;

create or replace function core.set_llm_platform_monthly_cap_for_superadmin(
  p_caller_id uuid,
  p_monthly_cap_micro_usd bigint,
  p_alert_threshold_pct numeric
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_monthly_cap_micro_usd <= 0 then
    raise exception 'el tope mensual debe ser positivo' using errcode = '22023';
  end if;

  insert into core.llm_platform_budget (id, monthly_cap_micro_usd, alert_threshold_pct, updated_by)
  values (true, p_monthly_cap_micro_usd, coalesce(p_alert_threshold_pct, 80), p_caller_id)
  on conflict (id) do update set
    monthly_cap_micro_usd = excluded.monthly_cap_micro_usd,
    alert_threshold_pct = excluded.alert_threshold_pct,
    updated_by = excluded.updated_by,
    updated_at = now();
end;
$$;

revoke all on function core.set_llm_platform_monthly_cap_for_superadmin(uuid, bigint, numeric) from public;
grant execute on function core.set_llm_platform_monthly_cap_for_superadmin(uuid, bigint, numeric) to authenticated;
