-- Investigación de seguridad (no asumida, verificada línea por línea antes de
-- escribir este fix): TODO el back office de plataforma (`0010_platform_
-- superadmin.sql`, `0012_superadmin_prospectos.sql`, `0014_superadmin_demo_
-- access.sql`, `0010_llm_usage_budget_schema.sql`) expone funciones `security
-- definer` del estilo `core.<algo>_for_superadmin(p_caller_id uuid, ...)` que
-- autorizan con `core.is_platform_superadmin(p_caller_id)` -- es decir,
-- confían en que el `p_caller_id` recibido como PARÁMETRO PLANO es honesto.
-- Nada dentro de la función ataba ese parámetro a `auth.uid()` (la identidad
-- real de la sesión Postgres que hace la llamada).
--
-- `supabase/config.toml::api.schemas` expone el schema `core` por PostgREST
-- (`["public","core","restaurantes","hoteles"]`), y las 12 funciones de abajo
-- tienen `grant execute ... to authenticated` -- así que CUALQUIER sesión
-- Postgres con rol `authenticated` (no necesariamente superadmin) que pudiera
-- invocarlas por RPC directo (nunca a través de `apps/api`) pasando el UUID de
-- un superadmin real como `p_caller_id` habría leído/escrito datos de
-- PLATAFORMA completa sin serlo -- el mismo hallazgo, mismo remedio, que ya se
-- aplicó en la migración anterior (`0010_llm_usage_budget_schema.sql`) a las 3
-- funciones INTERNAS de gasto de LLM (esas exigen sesión de SISTEMA,
-- `auth.uid() is null`, porque nunca reciben `p_caller_id`; estas 12 son
-- distintas: SÍ reciben `p_caller_id`, así que el remedio correcto es atarlo a
-- `auth.uid()`, no prohibirlo).
--
-- Verificado (no asumido) contra el código real antes de decidir el remedio:
--   1. `packages/db/src/managed-postgres-engine.ts::withAppSession({userId})`
--      fija `set local role authenticated` + `set_config('request.jwt.claim.sub',
--      userId ?? '', true)` -- exactamente el claim que Supabase usa para
--      resolver `auth.uid()`. Sesión de sistema (`userId: null`) -> `auth.uid()`
--      NULL; sesión de un caller real (`userId: <uuid>`) -> `auth.uid()` =
--      ese uuid.
--   2. `apps/api/src/production/core-repository.ts` y
--      `apps/api/src/production/llm-usage-repository.ts` invocan las 12
--      funciones de abajo SIEMPRE dentro de `engine.withAppSession({ userId:
--      null }, ...)` -- sesión de SISTEMA, aunque el `callerId` real del
--      superadmin autenticado YA está disponible en cada ruta (`c.get("userId")`
--      de `authMiddleware`, ver `apps/api/src/routes/superadmin.ts`/
--      `superadmin-llm-usage.ts`) y se pasa como argumento SQL de todas formas.
--      Es decir: hoy `auth.uid()` es SIEMPRE NULL en la única forma real en que
--      el backend las invoca -- el guard de este archivo (`auth.uid() =
--      p_caller_id`) habría bloqueado esas llamadas legítimas si no se
--      corrigiera también la sesión con la que se abren (ver el commit que
--      acompaña este archivo: pasan a `withAppSession({ userId: callerId },
--      ...)`, único cambio de TypeScript de este fix).
--   3. `apps/web` nunca usa Supabase Auth (confirmado: `grep -rn
--      "supabase\.auth\.\|GoTrue\|signInWithCustomToken"` no matchea nada) --
--      el único cliente `@supabase/supabase-js` del frontend
--      (`apps/web/src/verticals/citas/lib/realtime-client.ts`) solo abre un
--      WebSocket de Realtime con `client.realtime.setAuth(<JWT propio de
--      @atiende/core-auth, HS256>)`, nunca llama `.rpc()`/REST de PostgREST.
--      Ese JWT propio NO lleva claim `role` (ver
--      `packages/core-auth/src/jwt.ts::AccessTokenClaims`) -- así que, aunque
--      el proyecto Supabase real alineara su "JWT Secret"/"verify custom JWTs"
--      con el `JWT_SECRET` de `apps/api` (alineación que el propio comentario
--      de `realtime-client.ts` documenta como "BLOQUEO REAL... no resuelto"),
--      PostgREST no tiene forma de resolver ese token como rol `authenticated`
--      sin una configuración adicional de "Third-Party Auth" que este repo no
--      controla ni puede verificar desde el código. CONCLUSIÓN (b): no se
--      pudo demostrar explotación HOY contra este código (ningún flujo real
--      emite un JWT `authenticated` de Supabase a un cliente), pero CERO
--      defensa en profundidad -- el día en que esa alineación de plataforma
--      exista (el propio código del repo la está preparando activamente para
--      Realtime), las 12 funciones de abajo quedan explotables sin tocar una
--      sola línea más. Por eso este fix se aplica igual que si fuera (a),
--      exactamente como pide el criterio de "defensa en profundidad barata"
--      ya usado en `0010_llm_usage_budget_schema.sql`.
--
-- Remedio: `create or replace` de las 12 funciones, agregando la atadura
-- `auth.uid() = p_caller_id` (con `auth.uid() is not null` explícito, mismo
-- estilo que el resto del repo) ANTES/JUNTO al chequeo de superadmin ya
-- existente -- firma, tipo de retorno, `language`, `security definer`,
-- `search_path` y GRANTs sin cambios; el contrato observable para el caller
-- LEGÍTIMO (superadmin real, ahora con sesión atada a su propio `auth.uid()`)
-- es idéntico al de antes. Las funciones de LECTURA conservan su contrato
-- "cero filas si no autoriza" (nunca un error que confirme/niegue datos); las
-- de ESCRITURA conservan su `raise exception ... using errcode = '42501'`.
--
-- Funciones de escritura de PROSPECTO (`create_prospecto_for_superadmin`)
-- graban `p_caller_id` en `creado_por` -- con la atadura ya aplicada, esa
-- columna vuelve a significar lo que su nombre dice ("quién creó esto de
-- verdad"), no un valor que el propio caller puede falsificar.

-- ── 0010_platform_superadmin.sql ──────────────────────────────────────────

create or replace function core.list_all_organizations_for_superadmin(p_caller_id uuid)
returns setof core.organization
language sql stable security definer set search_path = core, pg_temp
as $$
  select o.* from core.organization o
  where auth.uid() is not null and auth.uid() = p_caller_id
    and exists (select 1 from core.platform_superadmin ps where ps.staff_user_id = p_caller_id)
  order by o.created_at desc;
$$;

create or replace function core.count_staff_by_organization_for_superadmin(p_caller_id uuid)
returns table (organization_id uuid, staff_count bigint)
language sql stable security definer set search_path = core, pg_temp
as $$
  select m.organization_id, count(*)::bigint as staff_count
  from core.membership m
  where auth.uid() is not null and auth.uid() = p_caller_id
    and exists (select 1 from core.platform_superadmin ps where ps.staff_user_id = p_caller_id)
  group by m.organization_id;
$$;

-- ── 0012_superadmin_prospectos.sql ────────────────────────────────────────

create or replace function core.list_prospectos_for_superadmin(p_caller_id uuid)
returns setof core.prospecto
language sql stable security definer set search_path = core, pg_temp
as $$
  select p.* from core.prospecto p
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by p.updated_at desc;
$$;

create or replace function core.create_prospecto_for_superadmin(
  p_caller_id uuid,
  p_empresa text,
  p_vertical text,
  p_ciudad text,
  p_contacto_nombre text,
  p_telefono text,
  p_correo text,
  p_fuente text,
  p_notas text
)
returns core.prospecto
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_row core.prospecto;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'create_prospecto_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into core.prospecto (empresa, vertical, ciudad, contacto_nombre, telefono, correo, fuente, notas, creado_por)
  values (p_empresa, p_vertical, p_ciudad, p_contacto_nombre, p_telefono, p_correo, p_fuente, p_notas, p_caller_id)
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function core.update_prospecto_for_superadmin(
  p_caller_id uuid,
  p_prospecto_id uuid,
  p_estado text,
  p_notas text
)
returns core.prospecto
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_row core.prospecto;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'update_prospecto_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update core.prospecto
  set estado = coalesce(p_estado, estado),
      notas = coalesce(p_notas, notas),
      updated_at = now()
  where id = p_prospecto_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'prospecto not found' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

-- ── 0014_superadmin_demo_access.sql ───────────────────────────────────────

create or replace function core.ensure_demo_access_for_superadmin(p_caller_id uuid, p_vertical text)
returns table (demo_organization_id uuid, demo_slug text)
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_org_id uuid;
  v_slug text;
  v_vertical_role text;
  v_org_name text;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'ensure_demo_access_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_vertical not in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos') then
    raise exception 'vertical inválida' using errcode = '22023';
  end if;

  v_vertical_role := case p_vertical
    when 'hoteles' then 'owner'
    when 'restaurantes' then 'owner'
    when 'citas' then 'owner'
    when 'licitaciones' then 'owner'
    when 'despachos' then 'admin'
    when 'rentas' then 'admin_gestora'
  end;

  v_slug := 'demo-' || p_vertical;
  v_org_name := 'Demo — Vista previa (' || p_vertical || ')';

  select o.id into v_org_id from core.organization o where o.slug = v_slug;

  if v_org_id is null then
    insert into core.organization (vertical, name, slug, status)
    values (p_vertical, v_org_name, v_slug, 'active')
    returning id into v_org_id;
  end if;

  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
  values (p_caller_id, v_org_id, null, 'owner', v_vertical_role)
  on conflict (user_id, organization_id) do nothing;

  return query select v_org_id as demo_organization_id, v_slug as demo_slug;
end;
$$;

-- ── 0010_llm_usage_budget_schema.sql (funciones del BACK OFFICE de
-- plataforma -- distintas de las 3 funciones INTERNAS `record_llm_usage`/
-- `reserve_llm_monthly_budget`/`settle_llm_monthly_budget`, ya endurecidas con
-- `auth.uid() is null` en esa misma migración: esas nunca reciben
-- `p_caller_id`, estas 6 sí) ──────────────────────────────────────────────

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
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
    and u.usage_date between p_from and p_to;
$$;

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
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by coalesce(r.cost_micro_usd, 0) desc;
$$;

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
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
    and u.usage_date between p_from and p_to
    and (p_organization_id is null or u.organization_id = p_organization_id)
  group by u.vertical, u.provider_id, u.model
  order by sum(u.cost_micro_usd) desc;
$$;

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
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id) and pb.id = true;
$$;

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
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'set_llm_org_monthly_cap_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
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
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'set_llm_platform_monthly_cap_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
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

-- Sin cambios de GRANT: las 12 funciones ya tenían exactamente
-- `revoke all on function ... from public;` + `grant execute on function ...
-- to authenticated;` desde su migración original -- este archivo solo
-- reemplaza el CUERPO (agrega la atadura a `auth.uid()`), nunca quién puede
-- ejecutarlas. `anon` sigue sin poder llamar ninguna (confirmado: ninguna de
-- las 12 tiene `grant ... to anon` en ningún archivo de `supabase/migrations/`).
