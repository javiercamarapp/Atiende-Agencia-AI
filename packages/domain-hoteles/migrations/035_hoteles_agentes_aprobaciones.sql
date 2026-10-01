-- H-03 (P0) hoteles -- CATALOGO DE AGENTES (estado, presupuesto mensual por agente, costo acumulado,
-- kill switch por property), PLANTILLAS DE WHATSAPP VERSIONADAS con aprobacion, GUARDRAILS configurables
-- y COLA DE APROBACIONES HUMANAS para acciones sensibles del agente (descuentos/cambios de tarifa,
-- reembolsos, respuestas a resenas, mensajes masivos, cargos al folio).
--
-- Principio de diseno: el agente PROPONE, un humano con rol APRUEBA o RECHAZA con motivo; la base es la
-- autoridad (no la app): el estado de una propuesta solo cambia por las funciones de abajo y un trigger
-- impide saltarse el ciclo de vida o alterar lo que se aprobo (anti-tamper), y cada aprobacion es de UN
-- solo uso (anti-replay). Complementa, sin tocarlas, la capa de plataforma ya en main: los topes de gasto
-- de la ORGANIZACION (core.llm_org_budget) y los interruptores globales (core.platform_switch) siguen
-- mandando; aqui el hotel agrega su propio presupuesto, su propia pausa y sus propias reglas POR PROPERTY.
--
-- Requiere: 001 (core.*), 030 (hoteles.property_config.timezone, para el horario de envio).
-- Expand-only: solo crea objetos nuevos; no toca ninguna tabla existente.
--
-- Reparto de autoridad (mismo criterio que 033/034): RLS = rol FINO por helper SQL (defensa en profundidad
-- si alguien le pega a PostgREST directo) + el mismo filtrado en apps/api (assertVerticalRole). Si el
-- espejo de la app se desincroniza, la peor consecuencia es un 403 de mas, nunca un acceso de mas.
--
-- Regla de seguridad que atraviesa TODA la migracion: las funciones que un usuario autenticado puede
-- invocar NUNCA confian en un reloj que reciban como parametro (un cliente que llame la RPC directo
-- podria "rebobinar" la expiracion): `hoteles.agent_clock` usa now() cuando hay sesion de usuario y solo
-- acepta el reloj de la aplicacion en sesion de SISTEMA (auth.uid() is null, el cron/agente), igual que
-- las demas funciones de sistema del repo (para poder probar con reloj simulado).

-- ---------------------------------------------------------------------------
-- 1) Helpers (security definer, search_path fijo; el rol sale de core.membership, nunca de un
--    parametro del cliente; todos revocan EXECUTE de public/anon).
--      agent_vertical_role : rol vertical del llamador en la property (o null).
--      can_view_agents     : owner, gm, frontdesk, reservations, accountant (ven catalogo y cola).
--      can_manage_agents   : owner, gm (configuran agentes, politicas, guardrails; aprueban plantillas).
--      can_author_agent_content : owner, gm, frontdesk, reservations (redactan plantillas / proponen).
--      agent_approver_ok   : owner siempre; el resto solo si su rol esta en la politica de la accion.
-- ---------------------------------------------------------------------------
create or replace function hoteles.agent_vertical_role(_property_id uuid)
returns text language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select m.vertical_role from core.membership m
  join core.property p on p.organization_id = m.organization_id
  where m.user_id = auth.uid() and p.id = _property_id
    and (m.property_ids is null or _property_id = any(m.property_ids))
  limit 1
$$;

create or replace function hoteles.can_view_agents(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select coalesce(hoteles.agent_vertical_role(_property_id) in ('owner', 'gm', 'frontdesk', 'reservations', 'accountant'), false)
$$;

create or replace function hoteles.can_manage_agents(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select coalesce(hoteles.agent_vertical_role(_property_id) in ('owner', 'gm'), false)
$$;

create or replace function hoteles.can_author_agent_content(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select coalesce(hoteles.agent_vertical_role(_property_id) in ('owner', 'gm', 'frontdesk', 'reservations'), false)
$$;

create or replace function hoteles.agent_approver_ok(_property_id uuid, _roles text[])
returns boolean language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select coalesce(hoteles.agent_vertical_role(_property_id) = 'owner' or hoteles.agent_vertical_role(_property_id) = any(_roles), false)
$$;

create or replace function hoteles.agent_clock(p_now timestamptz)
returns timestamptz language sql stable set search_path = pg_catalog as $$
  select case when auth.uid() is null then coalesce(p_now, now()) else now() end
$$;

-- Normaliza texto para comparar contra palabras bloqueadas: sin acentos (mayusculas y minusculas, mapa
-- explicito: no depende del locale de la base), en minusculas y con espacios colapsados (mismo mapa que el
-- espejo TypeScript guardrails.ts, para que ambos lados coincidan en los casos de borde).
create or replace function hoteles.guardrail_normalize(p_text text)
returns text language sql immutable set search_path = pg_catalog as $$
  select btrim(regexp_replace(lower(translate(coalesce(p_text, ''), 'áàäâéèëêíìïîóòöôúùüûñÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑ', 'aaaaeeeeiiiioooouuuunAAAAEEEEIIIIOOOOUUUUN')), '\s+', ' ', 'g'))
$$;

-- Primera palabra/frase bloqueada que aparece en el texto como palabra completa (no como subcadena:
-- bloquear "gratis" no debe bloquear "gratisimo"... ni "regratis"), o null. Las palabras ya vienen
-- normalizadas desde agent_guardrail (trigger).
create or replace function hoteles.guardrail_first_blocked_word(p_text text, p_words text[])
returns text language sql immutable set search_path = pg_catalog as $$
  select w from unnest(coalesce(p_words, '{}'::text[])) as w
  where w <> '' and hoteles.guardrail_normalize(p_text) ~ ('(^|[^a-z0-9])' || regexp_replace(w, '([.\\^$*+?()\[\]{}|-])', '\\\1', 'g') || '([^a-z0-9]|$)')
  limit 1
$$;

revoke all on function hoteles.agent_vertical_role(uuid) from public, anon;
revoke all on function hoteles.can_view_agents(uuid) from public, anon;
revoke all on function hoteles.can_manage_agents(uuid) from public, anon;
revoke all on function hoteles.can_author_agent_content(uuid) from public, anon;
revoke all on function hoteles.agent_approver_ok(uuid, text[]) from public, anon;
revoke all on function hoteles.agent_clock(timestamptz) from public, anon;
revoke all on function hoteles.guardrail_normalize(text) from public, anon;
revoke all on function hoteles.guardrail_first_blocked_word(text, text[]) from public, anon;
grant execute on function hoteles.agent_vertical_role(uuid) to authenticated, service_role;
grant execute on function hoteles.can_view_agents(uuid) to authenticated, service_role;
grant execute on function hoteles.can_manage_agents(uuid) to authenticated, service_role;
grant execute on function hoteles.can_author_agent_content(uuid) to authenticated, service_role;
grant execute on function hoteles.agent_approver_ok(uuid, text[]) to authenticated, service_role;
grant execute on function hoteles.agent_clock(timestamptz) to authenticated, service_role;
grant execute on function hoteles.guardrail_normalize(text) to authenticated, service_role;
grant execute on function hoteles.guardrail_first_blocked_word(text, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Bitacora unica e inmutable de todo lo de este modulo (configuracion, politicas, guardrails,
--    plantillas, aprobaciones). La escriben SOLO los triggers/funciones de abajo (security definer): el
--    cliente no tiene INSERT/UPDATE/DELETE, asi que no puede omitir ni falsificar una entrada.
--    actor_id null = el sistema (agente, cron).
-- ---------------------------------------------------------------------------
create table hoteles.agent_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  subject_type text not null check (subject_type in ('config', 'guardrail', 'politica', 'plantilla', 'aprobacion')),
  subject_id uuid not null,
  event_type text not null check (char_length(event_type) between 1 and 60),
  actor_id uuid references core.staff_user(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index agent_event_subject_idx on hoteles.agent_event (property_id, subject_type, subject_id, created_at);
create index agent_event_property_idx on hoteles.agent_event (property_id, created_at desc);

create or replace function hoteles.agent_log(p_org uuid, p_property uuid, p_subject_type text, p_subject_id uuid, p_event text, p_detail jsonb)
returns void language sql security definer set search_path = core, hoteles, pg_temp as $$
  insert into hoteles.agent_event (organization_id, property_id, subject_type, subject_id, event_type, actor_id, detail)
  values (p_org, p_property, p_subject_type, p_subject_id, p_event, auth.uid(), coalesce(p_detail, '{}'::jsonb))
$$;
-- Solo la invocan triggers/funciones definer de este modulo: ni anon ni authenticated pueden llamarla
-- directo (si pudieran, falsificarian entradas de la bitacora).
revoke all on function hoteles.agent_log(uuid, uuid, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function hoteles.agent_log(uuid, uuid, text, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Configuracion por agente y property: kill switch (`enabled`) + presupuesto mensual propio.
--    Sin fila = agente activo y sin tope propio (hereda el tope de organizacion de core.llm_org_budget).
--    `monthly_budget_micro_usd` en micro-USD (1 USD = 1_000_000), mismo criterio que core.llm_usage_daily.
-- ---------------------------------------------------------------------------
create table hoteles.agent_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  agent_key text not null check (agent_key in ('recepcion_whatsapp', 'revenue', 'reputacion', 'mantenimiento')),
  enabled boolean not null default true,
  monthly_budget_micro_usd bigint check (monthly_budget_micro_usd is null or monthly_budget_micro_usd > 0),
  paused_reason text check (paused_reason is null or char_length(paused_reason) between 5 and 300),
  paused_at timestamptz,
  paused_by uuid references core.staff_user(id) on delete set null,
  updated_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, agent_key),
  constraint agent_config_pause_consistency check (enabled or (paused_reason is not null and paused_at is not null))
);

-- Costo acumulado por (property, agente, mes calendario UTC 'YYYY-MM'). Solo lo escribe
-- hoteles.record_agent_usage (sistema); el cliente solo lo lee (RLS).
create table hoteles.agent_usage_monthly (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  agent_key text not null check (agent_key in ('recepcion_whatsapp', 'revenue', 'reputacion', 'mantenimiento')),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  tokens_in bigint not null default 0 check (tokens_in >= 0),
  tokens_out bigint not null default 0 check (tokens_out >= 0),
  cost_micro_usd bigint not null default 0 check (cost_micro_usd >= 0),
  call_count bigint not null default 0 check (call_count >= 0),
  updated_at timestamptz not null default now(),
  unique (property_id, agent_key, month)
);

-- Guardrails por property (una fila). Sin fila rigen estos mismos valores por defecto (los usan las
-- funciones de abajo con coalesce), nunca "sin tope".
create table hoteles.agent_guardrail (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null unique references core.property(id) on delete cascade,
  -- Topes DUROS: una propuesta por encima queda `bloqueada` (ni siquiera llega a un humano).
  max_discount_pct numeric(5, 2) not null default 30 check (max_discount_pct > 0 and max_discount_pct <= 100),
  max_refund_cents bigint not null default 500000 check (max_refund_cents > 0),
  max_folio_charge_cents bigint not null default 500000 check (max_folio_charge_cents > 0),
  max_mass_recipients integer not null default 200 check (max_mass_recipients between 1 and 100000),
  blocked_words text[] not null default '{}'::text[] check (cardinality(blocked_words) <= 100),
  -- Ventana de envio de mensajes masivos, en la hora LOCAL de la property (property_config.timezone, o
  -- America/Mexico_City). Sin ventanas nocturnas (inicio < fin).
  send_window_start time not null default '08:00',
  send_window_end time not null default '21:00',
  updated_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_guardrail_window check (send_window_start < send_window_end)
);

-- Politica de aprobacion por tipo de accion. Sin fila = SIEMPRE humano (fail-closed), expira en 24 h,
-- aprueban owner/gm. `auto_bajo_umbral` solo existe para descuento/reembolso/cargo (montos acotados);
-- el contenido de cara al huesped (resenas, masivos) exige humano SIEMPRE.
create table hoteles.agent_action_policy (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  action_type text not null check (action_type in ('descuento_tarifa', 'reembolso', 'respuesta_resena', 'mensaje_masivo', 'cargo_folio')),
  mode text not null default 'siempre_humano' check (mode in ('siempre_humano', 'auto_bajo_umbral')),
  auto_max_percent numeric(5, 2) check (auto_max_percent is null or (auto_max_percent > 0 and auto_max_percent <= 100)),
  auto_max_amount_cents bigint check (auto_max_amount_cents is null or auto_max_amount_cents > 0),
  expires_minutes integer not null default 1440 check (expires_minutes between 5 and 10080),
  approver_roles text[] not null default array['owner', 'gm']::text[]
    check (cardinality(approver_roles) >= 1 and approver_roles <@ array['owner', 'gm', 'frontdesk', 'reservations', 'accountant']::text[]),
  updated_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, action_type),
  constraint agent_policy_auto_scope check (mode = 'siempre_humano' or action_type in ('descuento_tarifa', 'reembolso', 'cargo_folio')),
  constraint agent_policy_auto_threshold check (
    mode = 'siempre_humano'
    or (action_type = 'descuento_tarifa' and auto_max_percent is not null)
    or (action_type in ('reembolso', 'cargo_folio') and auto_max_amount_cents is not null)
  )
);

-- Triggers de integridad de configuracion. Justificacion de seguridad: el GRANT de columna impide al
-- cliente mandar organization_id/updated_by/paused_*; por defensa en profundidad (un GRANT futuro,
-- service_role) esos valores se DERIVAN en el servidor: la organizacion sale de core.property (nunca de
-- otro tenant), la autoria de auth.uid(), y pausar exige motivo (el kill switch deja rastro).
create or replace function hoteles.agent_config_before_write()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
begin
  if tg_op = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property inexistente' using errcode = '23503';
    end if;
    new.organization_id := v_org;
  end if;
  if new.enabled = false then
    if new.paused_reason is null then
      raise exception 'pausar un agente exige un motivo (5 a 300 caracteres)' using errcode = '23514';
    end if;
    if tg_op = 'INSERT' then
      new.paused_at := now();
      new.paused_by := auth.uid();
    elsif old.enabled then
      new.paused_at := now();
      new.paused_by := auth.uid();
    else
      new.paused_at := old.paused_at;
      new.paused_by := old.paused_by;
    end if;
  else
    new.paused_reason := null;
    new.paused_at := null;
    new.paused_by := null;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function hoteles.agent_config_log()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := case when new.enabled then 'config_creada' else 'agente_pausado' end;
    perform hoteles.agent_log(new.organization_id, new.property_id, 'config', new.id, v_event,
      jsonb_build_object('agente', new.agent_key, 'activo', new.enabled, 'motivo', new.paused_reason, 'presupuestoMicroUsd', new.monthly_budget_micro_usd));
  elsif new.enabled is distinct from old.enabled or new.monthly_budget_micro_usd is distinct from old.monthly_budget_micro_usd then
    v_event := case
      when new.enabled is distinct from old.enabled then case when new.enabled then 'agente_reanudado' else 'agente_pausado' end
      else 'presupuesto_actualizado'
    end;
    perform hoteles.agent_log(new.organization_id, new.property_id, 'config', new.id, v_event,
      jsonb_build_object('agente', new.agent_key, 'activo', new.enabled, 'motivo', new.paused_reason,
        'presupuestoMicroUsd', new.monthly_budget_micro_usd, 'presupuestoAnteriorMicroUsd', old.monthly_budget_micro_usd));
  end if;
  return new;
end;
$$;

create or replace function hoteles.agent_guardrail_before_write()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_words text[];
begin
  if tg_op = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property inexistente' using errcode = '23503';
    end if;
    new.organization_id := v_org;
  end if;
  -- Normaliza (minusculas, sin acentos, espacios colapsados), descarta vacias y duplicadas; cada palabra o
  -- frase de 1 a 60 caracteres.
  select coalesce(array_agg(distinct w order by w), '{}'::text[]) into v_words
    from (select btrim(regexp_replace(hoteles.guardrail_normalize(x), '\s+', ' ', 'g')) as w from unnest(new.blocked_words) as x) s
   where w <> '';
  if exists (select 1 from unnest(v_words) as w where char_length(w) > 60) then
    raise exception 'cada palabra bloqueada admite maximo 60 caracteres' using errcode = '23514';
  end if;
  new.blocked_words := v_words;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function hoteles.agent_guardrail_log()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  perform hoteles.agent_log(new.organization_id, new.property_id, 'guardrail', new.id, case when tg_op = 'INSERT' then 'guardrails_creados' else 'guardrails_actualizados' end,
    jsonb_build_object('maxDescuentoPct', new.max_discount_pct, 'maxReembolsoCentavos', new.max_refund_cents,
      'maxCargoFolioCentavos', new.max_folio_charge_cents, 'maxDestinatarios', new.max_mass_recipients,
      'palabrasBloqueadas', cardinality(new.blocked_words), 'ventanaInicio', new.send_window_start, 'ventanaFin', new.send_window_end));
  return new;
end;
$$;

-- Aflojar una politica a "auto_bajo_umbral" (que el agente ejecute sin humano) es decision del DUENO:
-- gm puede endurecerla o ajustar vigencia/aprobadores, pero no relajarla.
create or replace function hoteles.agent_policy_before_write()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
begin
  if tg_op = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property inexistente' using errcode = '23503';
    end if;
    new.organization_id := v_org;
  end if;
  if new.mode = 'auto_bajo_umbral' and auth.uid() is not null and hoteles.agent_vertical_role(new.property_id) is distinct from 'owner' then
    -- gm solo puede tocar una politica automatica ya existente sin cambiar modo ni umbrales.
    if tg_op = 'INSERT' then
      raise exception 'solo el dueno habilita la ejecucion automatica bajo umbral' using errcode = '42501';
    elsif old.mode is distinct from 'auto_bajo_umbral' or new.auto_max_percent is distinct from old.auto_max_percent
          or new.auto_max_amount_cents is distinct from old.auto_max_amount_cents then
      raise exception 'solo el dueno habilita o amplia la ejecucion automatica bajo umbral' using errcode = '42501';
    end if;
  end if;
  if new.mode = 'siempre_humano' then
    new.auto_max_percent := null;
    new.auto_max_amount_cents := null;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function hoteles.agent_policy_log()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_prev text := null;
begin
  if tg_op = 'UPDATE' then
    v_prev := old.mode;
  end if;
  perform hoteles.agent_log(new.organization_id, new.property_id, 'politica', new.id, case when tg_op = 'INSERT' then 'politica_creada' else 'politica_actualizada' end,
    jsonb_build_object('accion', new.action_type, 'modo', new.mode, 'umbralPct', new.auto_max_percent, 'umbralCentavos', new.auto_max_amount_cents,
      'expiraMin', new.expires_minutes, 'aprobadores', new.approver_roles, 'modoAnterior', v_prev));
  return new;
end;
$$;

revoke all on function hoteles.agent_config_before_write() from public, anon;
revoke all on function hoteles.agent_config_log() from public, anon;
revoke all on function hoteles.agent_guardrail_before_write() from public, anon;
revoke all on function hoteles.agent_guardrail_log() from public, anon;
revoke all on function hoteles.agent_policy_before_write() from public, anon;
revoke all on function hoteles.agent_policy_log() from public, anon;

create trigger agent_config_before_write before insert or update on hoteles.agent_config
  for each row execute function hoteles.agent_config_before_write();
create trigger agent_config_log after insert or update on hoteles.agent_config
  for each row execute function hoteles.agent_config_log();
create trigger agent_guardrail_before_write before insert or update on hoteles.agent_guardrail
  for each row execute function hoteles.agent_guardrail_before_write();
create trigger agent_guardrail_log after insert or update on hoteles.agent_guardrail
  for each row execute function hoteles.agent_guardrail_log();
create trigger agent_policy_before_write before insert or update on hoteles.agent_action_policy
  for each row execute function hoteles.agent_policy_before_write();
create trigger agent_policy_log after insert or update on hoteles.agent_action_policy
  for each row execute function hoteles.agent_policy_log();

-- ---------------------------------------------------------------------------
-- 4) Cola de aprobaciones humanas.
--    Ciclo: pendiente -> aprobada | rechazada | expirada | cancelada ; aprobada -> ejecutada | expirada |
--    cancelada | bloqueada. `bloqueada` tambien nace asi (propuesta que viola un guardrail o llega de un
--    agente pausado). rechazada/expirada/ejecutada/cancelada/bloqueada son TERMINALES.
--    Lo propuesto (accion, montos, texto, payload) es INMUTABLE: lo que el humano aprobo es exactamente lo
--    que se ejecuta. Una aprobacion es de UN solo uso (aprobada -> ejecutada bajo lock de fila).
--    La llave (property_id, idempotency_key) hace que reintentar una propuesta no duplique la cola.
-- ---------------------------------------------------------------------------
create table hoteles.agent_approval_request (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  -- 'manual' = la propuso una persona (maker-checker); el resto = agente que la propone (sistema).
  agent_key text not null check (agent_key in ('recepcion_whatsapp', 'revenue', 'reputacion', 'mantenimiento', 'manual')),
  action_type text not null check (action_type in ('descuento_tarifa', 'reembolso', 'respuesta_resena', 'mensaje_masivo', 'cargo_folio')),
  summary text not null check (char_length(summary) between 1 and 300),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192),
  amount_cents bigint check (amount_cents is null or amount_cents > 0),
  currency text not null default 'MXN' check (currency ~ '^[A-Z]{3}$'),
  percent numeric(5, 2) check (percent is null or (percent > 0 and percent <= 100)),
  recipients integer check (recipients is null or recipients > 0),
  content_text text check (content_text is null or char_length(content_text) between 1 and 4000),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 120),
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobada', 'rechazada', 'expirada', 'ejecutada', 'cancelada', 'bloqueada')),
  proposed_by uuid references core.staff_user(id) on delete set null,
  auto_approved boolean not null default false,
  block_reason text check (block_reason is null or char_length(block_reason) <= 200),
  expires_at timestamptz not null,
  decided_by uuid references core.staff_user(id) on delete set null,
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or char_length(decision_reason) between 1 and 500),
  executed_at timestamptz,
  executed_by uuid references core.staff_user(id) on delete set null,
  execution_ref text check (execution_ref is null or char_length(execution_ref) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, idempotency_key),
  constraint agent_approval_required_fields check (
    (action_type = 'descuento_tarifa' and percent is not null)
    or (action_type in ('reembolso', 'cargo_folio') and amount_cents is not null)
    or (action_type = 'mensaje_masivo' and recipients is not null and content_text is not null)
    or (action_type = 'respuesta_resena' and content_text is not null)
  ),
  constraint agent_approval_status_consistency check (
    (status = 'bloqueada') = (block_reason is not null)
    and ((status = 'ejecutada') = (executed_at is not null))
    and (status not in ('rechazada') or (decided_at is not null and decided_by is not null and decision_reason is not null))
    and (status <> 'aprobada' or (decided_at is not null and (auto_approved or (decided_by is not null and decision_reason is not null))))
  )
);
create index agent_approval_property_status_idx on hoteles.agent_approval_request (property_id, status, created_at desc);
create index agent_approval_open_expiry_idx on hoteles.agent_approval_request (property_id, expires_at) where status in ('pendiente', 'aprobada');

alter table hoteles.agent_approval_request add constraint agent_approval_request_id_property_unique unique (id, property_id);

create or replace function hoteles.agent_approval_before_update()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  if old.status in ('rechazada', 'expirada', 'ejecutada', 'cancelada', 'bloqueada') then
    raise exception 'la solicitud ya esta % y no se puede modificar', old.status using errcode = '55000';
  end if;
  if new.organization_id is distinct from old.organization_id or new.property_id is distinct from old.property_id
     or new.agent_key is distinct from old.agent_key or new.action_type is distinct from old.action_type
     or new.summary is distinct from old.summary or new.payload is distinct from old.payload
     or new.amount_cents is distinct from old.amount_cents or new.currency is distinct from old.currency
     or new.percent is distinct from old.percent or new.recipients is distinct from old.recipients
     or new.content_text is distinct from old.content_text or new.idempotency_key is distinct from old.idempotency_key
     or new.proposed_by is distinct from old.proposed_by or new.expires_at is distinct from old.expires_at
     or new.auto_approved is distinct from old.auto_approved or new.created_at is distinct from old.created_at then
    raise exception 'lo propuesto es inmutable: lo aprobado es exactamente lo que se ejecuta' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'pendiente' and new.status in ('aprobada', 'rechazada', 'expirada', 'cancelada'))
    or (old.status = 'aprobada' and new.status in ('ejecutada', 'expirada', 'cancelada', 'bloqueada'))
  ) then
    raise exception 'transicion de estado invalida: % -> %', old.status, new.status using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function hoteles.agent_approval_log()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    perform hoteles.agent_log(new.organization_id, new.property_id, 'aprobacion', new.id,
      case when new.status = 'bloqueada' then 'bloqueada' when new.auto_approved then 'autoaprobada' else 'propuesta' end,
      jsonb_build_object('agente', new.agent_key, 'accion', new.action_type, 'montoCentavos', new.amount_cents, 'porcentaje', new.percent,
        'destinatarios', new.recipients, 'estado', new.status, 'motivoBloqueo', new.block_reason, 'expiraEn', new.expires_at));
  elsif new.status is distinct from old.status then
    perform hoteles.agent_log(new.organization_id, new.property_id, 'aprobacion', new.id, new.status,
      jsonb_build_object('de', old.status, 'motivo', coalesce(new.decision_reason, new.block_reason), 'referencia', new.execution_ref));
  end if;
  return new;
end;
$$;

revoke all on function hoteles.agent_approval_before_update() from public, anon;
revoke all on function hoteles.agent_approval_log() from public, anon;
create trigger agent_approval_before_update before update on hoteles.agent_approval_request
  for each row execute function hoteles.agent_approval_before_update();
create trigger agent_approval_log after insert or update on hoteles.agent_approval_request
  for each row execute function hoteles.agent_approval_log();

-- ---------------------------------------------------------------------------
-- 5) Plantillas de WhatsApp VERSIONADAS por agente, con aprobacion.
--    borrador -> pendiente -> aprobada | rechazada ; aprobada -> archivada ; rechazada -> archivada.
--    El texto es inmutable desde que existe (corregirlo = una VERSION nueva). A lo sumo una version
--    `aprobada` por (property, nombre, idioma): aprobar una nueva archiva la anterior.
--    Separacion de funciones: quien la envia a revision no la aprueba (salvo el dueno).
-- ---------------------------------------------------------------------------
create table hoteles.agent_wa_template (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  agent_key text not null check (agent_key in ('recepcion_whatsapp', 'revenue', 'reputacion', 'mantenimiento')),
  name text not null check (name ~ '^[a-z][a-z0-9_]{2,59}$'),
  language text not null default 'es_MX' check (language in ('es_MX', 'es', 'en_US', 'en')),
  category text not null default 'utility' check (category in ('utility', 'marketing')),
  body text not null check (char_length(body) between 1 and 1024),
  version integer not null check (version >= 1),
  status text not null default 'borrador' check (status in ('borrador', 'pendiente', 'aprobada', 'rechazada', 'archivada')),
  created_by uuid references core.staff_user(id) on delete set null,
  submitted_by uuid references core.staff_user(id) on delete set null,
  submitted_at timestamptz,
  reviewed_by uuid references core.staff_user(id) on delete set null,
  reviewed_at timestamptz,
  review_reason text check (review_reason is null or char_length(review_reason) between 5 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, name, language, version),
  constraint agent_wa_template_review_consistency check (
    (status in ('borrador')) = (submitted_at is null)
    and (status not in ('aprobada', 'rechazada') or (reviewed_at is not null and reviewed_by is not null))
    and (status <> 'rechazada' or review_reason is not null)
  )
);
create unique index agent_wa_template_one_approved_idx on hoteles.agent_wa_template (property_id, name, language) where status = 'aprobada';
create index agent_wa_template_property_idx on hoteles.agent_wa_template (property_id, agent_key, name, version desc);

create or replace function hoteles.agent_wa_template_before_update()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  if new.organization_id is distinct from old.organization_id or new.property_id is distinct from old.property_id
     or new.agent_key is distinct from old.agent_key or new.name is distinct from old.name or new.language is distinct from old.language
     or new.category is distinct from old.category or new.body is distinct from old.body or new.version is distinct from old.version
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'el texto de una plantilla es inmutable: crea una version nueva' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'borrador' and new.status = 'pendiente')
    or (old.status = 'pendiente' and new.status in ('aprobada', 'rechazada'))
    or (old.status in ('aprobada', 'rechazada') and new.status = 'archivada')
  ) then
    raise exception 'transicion de plantilla invalida: % -> %', old.status, new.status using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function hoteles.agent_wa_template_log()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    perform hoteles.agent_log(new.organization_id, new.property_id, 'plantilla', new.id, 'plantilla_creada',
      jsonb_build_object('agente', new.agent_key, 'nombre', new.name, 'idioma', new.language, 'version', new.version));
  elsif new.status is distinct from old.status then
    perform hoteles.agent_log(new.organization_id, new.property_id, 'plantilla', new.id, 'plantilla_' || new.status,
      jsonb_build_object('nombre', new.name, 'version', new.version, 'de', old.status, 'motivo', new.review_reason));
  end if;
  return new;
end;
$$;
revoke all on function hoteles.agent_wa_template_before_update() from public, anon;
revoke all on function hoteles.agent_wa_template_log() from public, anon;
create trigger agent_wa_template_before_update before update on hoteles.agent_wa_template
  for each row execute function hoteles.agent_wa_template_before_update();
create trigger agent_wa_template_log after insert or update on hoteles.agent_wa_template
  for each row execute function hoteles.agent_wa_template_log();

-- ---------------------------------------------------------------------------
-- 6) RLS + GRANTs. Sin `using (true)`, sin GRANT a anon, sin DELETE para authenticated. Lectura de
--    catalogo/cola/plantillas: roles de can_view_agents; la bitacora solo owner/gm. ESCRITURA directa solo
--    donde es configuracion simple (config, guardrail, politica) y con GRANT de COLUMNA: organization_id,
--    updated_by, paused_* los deriva el trigger. Aprobaciones y plantillas SOLO se mutan por las funciones
--    de abajo (sin INSERT/UPDATE para authenticated), uso de columnas = ninguna.
-- ---------------------------------------------------------------------------
alter table hoteles.agent_event enable row level security;
alter table hoteles.agent_config enable row level security;
alter table hoteles.agent_usage_monthly enable row level security;
alter table hoteles.agent_guardrail enable row level security;
alter table hoteles.agent_action_policy enable row level security;
alter table hoteles.agent_approval_request enable row level security;
alter table hoteles.agent_wa_template enable row level security;

create policy "agentes: owner/gm ven la bitacora" on hoteles.agent_event for select
  using (hoteles.can_manage_agents(property_id));

create policy "agentes: staff autorizado ve la configuracion" on hoteles.agent_config for select
  using (hoteles.can_view_agents(property_id));
create policy "agentes: owner/gm crea la configuracion" on hoteles.agent_config for insert
  with check (hoteles.can_manage_agents(property_id));
create policy "agentes: owner/gm ajusta la configuracion" on hoteles.agent_config for update
  using (hoteles.can_manage_agents(property_id)) with check (hoteles.can_manage_agents(property_id));

create policy "agentes: staff autorizado ve el costo acumulado" on hoteles.agent_usage_monthly for select
  using (hoteles.can_view_agents(property_id));

create policy "agentes: staff autorizado ve los guardrails" on hoteles.agent_guardrail for select
  using (hoteles.can_view_agents(property_id));
create policy "agentes: owner/gm crea los guardrails" on hoteles.agent_guardrail for insert
  with check (hoteles.can_manage_agents(property_id));
create policy "agentes: owner/gm ajusta los guardrails" on hoteles.agent_guardrail for update
  using (hoteles.can_manage_agents(property_id)) with check (hoteles.can_manage_agents(property_id));

create policy "agentes: staff autorizado ve las politicas" on hoteles.agent_action_policy for select
  using (hoteles.can_view_agents(property_id));
create policy "agentes: owner/gm crea las politicas" on hoteles.agent_action_policy for insert
  with check (hoteles.can_manage_agents(property_id));
create policy "agentes: owner/gm ajusta las politicas" on hoteles.agent_action_policy for update
  using (hoteles.can_manage_agents(property_id)) with check (hoteles.can_manage_agents(property_id));

create policy "agentes: staff autorizado ve la cola de aprobaciones" on hoteles.agent_approval_request for select
  using (hoteles.can_view_agents(property_id));
create policy "agentes: staff autorizado ve las plantillas" on hoteles.agent_wa_template for select
  using (hoteles.can_view_agents(property_id));

revoke all on hoteles.agent_event, hoteles.agent_config, hoteles.agent_usage_monthly, hoteles.agent_guardrail,
  hoteles.agent_action_policy, hoteles.agent_approval_request, hoteles.agent_wa_template from public, anon;
grant select on hoteles.agent_event, hoteles.agent_config, hoteles.agent_usage_monthly, hoteles.agent_guardrail,
  hoteles.agent_action_policy, hoteles.agent_approval_request, hoteles.agent_wa_template to authenticated;
grant insert (property_id, agent_key, enabled, monthly_budget_micro_usd, paused_reason) on hoteles.agent_config to authenticated;
grant update (enabled, monthly_budget_micro_usd, paused_reason) on hoteles.agent_config to authenticated;
grant insert (property_id, max_discount_pct, max_refund_cents, max_folio_charge_cents, max_mass_recipients, blocked_words, send_window_start, send_window_end)
  on hoteles.agent_guardrail to authenticated;
grant update (max_discount_pct, max_refund_cents, max_folio_charge_cents, max_mass_recipients, blocked_words, send_window_start, send_window_end)
  on hoteles.agent_guardrail to authenticated;
grant insert (property_id, action_type, mode, auto_max_percent, auto_max_amount_cents, expires_minutes, approver_roles) on hoteles.agent_action_policy to authenticated;
grant update (mode, auto_max_percent, auto_max_amount_cents, expires_minutes, approver_roles) on hoteles.agent_action_policy to authenticated;
grant select, insert, update, delete on hoteles.agent_event, hoteles.agent_config, hoteles.agent_usage_monthly, hoteles.agent_guardrail,
  hoteles.agent_action_policy, hoteles.agent_approval_request, hoteles.agent_wa_template to service_role;

-- ---------------------------------------------------------------------------
-- 7) Funciones de SISTEMA (auth.uid() is null: agente, cron). Justificacion de seguridad: security
--    definer para escribir tablas que el cliente no puede tocar (costo acumulado), search_path fijo, y el
--    guard `auth.uid() is not null -> 42501` las hace inalcanzables para un usuario final por RPC directo.
-- ---------------------------------------------------------------------------

-- Suma el costo de una llamada del agente al acumulado (property, agente, mes). Atomica (upsert aditivo).
create or replace function hoteles.record_agent_usage(p_property_id uuid, p_agent_key text, p_month text, p_tokens_in bigint, p_tokens_out bigint, p_cost_micro_usd bigint, p_calls bigint default 1)
returns void language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
begin
  if auth.uid() is not null then
    raise exception 'record_agent_usage: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if coalesce(p_tokens_in, -1) < 0 or coalesce(p_tokens_out, -1) < 0 or coalesce(p_cost_micro_usd, -1) < 0 or coalesce(p_calls, -1) < 0 then
    raise exception 'record_agent_usage: los acumulados no pueden ser negativos' using errcode = '22023';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null then
    raise exception 'property inexistente' using errcode = '23503';
  end if;
  insert into hoteles.agent_usage_monthly (organization_id, property_id, agent_key, month, tokens_in, tokens_out, cost_micro_usd, call_count)
  values (v_org, p_property_id, p_agent_key, p_month, p_tokens_in, p_tokens_out, p_cost_micro_usd, p_calls)
  on conflict (property_id, agent_key, month) do update
    set tokens_in = hoteles.agent_usage_monthly.tokens_in + excluded.tokens_in,
        tokens_out = hoteles.agent_usage_monthly.tokens_out + excluded.tokens_out,
        cost_micro_usd = hoteles.agent_usage_monthly.cost_micro_usd + excluded.cost_micro_usd,
        call_count = hoteles.agent_usage_monthly.call_count + excluded.call_count,
        updated_at = now();
end;
$$;

-- Estado del agente para decidir si puede correr: pausa (kill switch), presupuesto propio y gasto del mes.
-- Sin configuracion = activo y sin tope propio.
create or replace function hoteles.agent_gate(p_property_id uuid, p_agent_key text, p_month text)
returns table (out_enabled boolean, out_budget_micro_usd bigint, out_spent_micro_usd bigint, out_paused_reason text)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'agent_gate: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return query
  select coalesce(c.enabled, true), c.monthly_budget_micro_usd,
         coalesce((select u.cost_micro_usd from hoteles.agent_usage_monthly u where u.property_id = p_property_id and u.agent_key = p_agent_key and u.month = p_month), 0),
         c.paused_reason
    from (select 1) one left join hoteles.agent_config c on c.property_id = p_property_id and c.agent_key = p_agent_key;
end;
$$;

-- Expira las solicitudes abiertas (pendientes o aprobadas sin ejecutar) cuya vigencia ya paso. Una property
-- por llamada (transaccion por unidad en el cron). Idempotente.
create or replace function hoteles.expire_agent_approvals(p_property_id uuid, p_now timestamptz)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'expire_agent_approvals: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  with e as (
    update hoteles.agent_approval_request set status = 'expirada'
     where property_id = p_property_id and status in ('pendiente', 'aprobada') and expires_at <= p_now
    returning 1
  )
  select count(*) into v_n from e;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Aprobaciones: proponer / decidir / consumir / cancelar.
-- ---------------------------------------------------------------------------

-- Evalua una propuesta contra los guardrails VIGENTES y devuelve el motivo de bloqueo o null. La usan
-- propose (al nacer), decide (al aprobar) y consume (al ejecutar): un guardrail endurecido despues de la
-- propuesta tambien frena lo ya aprobado.
create or replace function hoteles.agent_guardrail_violation(p_property_id uuid, p_action_type text, p_amount_cents bigint, p_percent numeric, p_recipients integer, p_content text)
returns text language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  g hoteles.agent_guardrail;
  v_word text;
  v_max_discount numeric := 30;
  v_max_refund bigint := 500000;
  v_max_charge bigint := 500000;
  v_max_recipients integer := 200;
  v_words text[] := '{}';
begin
  select * into g from hoteles.agent_guardrail where property_id = p_property_id;
  if found then
    v_max_discount := g.max_discount_pct; v_max_refund := g.max_refund_cents; v_max_charge := g.max_folio_charge_cents;
    v_max_recipients := g.max_mass_recipients; v_words := g.blocked_words;
  end if;
  if p_action_type = 'descuento_tarifa' and p_percent > v_max_discount then
    return 'tope_descuento';
  end if;
  if p_action_type = 'reembolso' and p_amount_cents > v_max_refund then
    return 'tope_reembolso';
  end if;
  if p_action_type = 'cargo_folio' and p_amount_cents > v_max_charge then
    return 'tope_cargo_folio';
  end if;
  if p_action_type = 'mensaje_masivo' and p_recipients > v_max_recipients then
    return 'tope_destinatarios';
  end if;
  v_word := hoteles.guardrail_first_blocked_word(p_content, v_words);
  if v_word is not null then
    return 'palabra_bloqueada';
  end if;
  return null;
end;
$$;

-- Dentro de la ventana de envio (hora local de la property)? Sin ventana configurada rige 08:00-21:00.
create or replace function hoteles.within_send_window(p_property_id uuid, p_now timestamptz)
returns boolean language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_tz text;
  v_start time := '08:00';
  v_end time := '21:00';
  v_local time;
begin
  select send_window_start, send_window_end into v_start, v_end from hoteles.agent_guardrail where property_id = p_property_id;
  if not found then
    v_start := '08:00'; v_end := '21:00';
  end if;
  select timezone into v_tz from hoteles.property_config where property_id = p_property_id;
  begin
    v_local := (p_now at time zone coalesce(v_tz, 'America/Mexico_City'))::time;
  exception when others then
    v_local := (p_now at time zone 'America/Mexico_City')::time;
  end;
  -- Inicio inclusivo, fin exclusivo.
  return v_local >= v_start and v_local < v_end;
end;
$$;

create or replace function hoteles.propose_agent_action(
  p_property_id uuid, p_agent_key text, p_action_type text, p_summary text, p_payload jsonb,
  p_amount_cents bigint, p_percent numeric, p_recipients integer, p_content_text text,
  p_idempotency_key text, p_now timestamptz default now()
) returns hoteles.agent_approval_request
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_now timestamptz := hoteles.agent_clock(p_now);
  v_uid uuid := auth.uid();
  v_existing hoteles.agent_approval_request;
  v_policy hoteles.agent_action_policy;
  v_cfg_enabled boolean;
  v_block text;
  v_status text := 'pendiente';
  v_auto boolean := false;
  v_expires_min integer := 1440;
  v_row hoteles.agent_approval_request;
begin
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null then
    raise exception 'property inexistente' using errcode = '23503';
  end if;
  if v_uid is null then
    -- Sesion de sistema: es el agente quien propone (nunca 'manual').
    if p_agent_key is null or p_agent_key not in ('recepcion_whatsapp', 'revenue', 'reputacion', 'mantenimiento') then
      raise exception 'agent_key invalido para una propuesta de agente' using errcode = '22023';
    end if;
  else
    -- Staff: debe poder redactar contenido de agentes en esa property; su propuesta es 'manual' (la decide OTRA persona).
    if not hoteles.can_author_agent_content(p_property_id) then
      raise exception 'sin permiso para proponer acciones en esta property' using errcode = '42501';
    end if;
    p_agent_key := 'manual';
  end if;

  -- Reintento de la MISMA propuesta: devuelve la existente (no duplica la cola). Reusar la llave con
  -- contenido distinto es un error del llamador (no se puede "reemplazar" lo que ya estaba en revision).
  select * into v_existing from hoteles.agent_approval_request where property_id = p_property_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.action_type is distinct from p_action_type or v_existing.amount_cents is distinct from p_amount_cents
       or v_existing.percent is distinct from p_percent or v_existing.recipients is distinct from p_recipients
       or v_existing.content_text is distinct from p_content_text or v_existing.payload is distinct from coalesce(p_payload, '{}'::jsonb) then
      raise exception 'idempotency_key ya usada con contenido distinto' using errcode = '23505';
    end if;
    return v_existing;
  end if;

  select * into v_policy from hoteles.agent_action_policy where property_id = p_property_id and action_type = p_action_type;
  if found then
    v_expires_min := v_policy.expires_minutes;
  end if;

  -- Orden de bloqueo: agente pausado, cola llena, guardrails.
  if p_agent_key <> 'manual' then
    select c.enabled into v_cfg_enabled from hoteles.agent_config c where c.property_id = p_property_id and c.agent_key = p_agent_key;
    if v_cfg_enabled is false then
      v_block := 'agente_pausado';
    end if;
  end if;
  if v_block is null and (select count(*) from hoteles.agent_approval_request where property_id = p_property_id and status = 'pendiente' and expires_at > v_now) >= 200 then
    v_block := 'cola_llena';
  end if;
  if v_block is null then
    v_block := hoteles.agent_guardrail_violation(p_property_id, p_action_type, p_amount_cents, p_percent, p_recipients, coalesce(p_content_text, '') || ' ' || coalesce(p_summary, ''));
  end if;

  if v_block is not null then
    v_status := 'bloqueada';
  elsif v_policy.mode = 'auto_bajo_umbral' and p_agent_key <> 'manual'
        and ((p_action_type = 'descuento_tarifa' and p_percent <= v_policy.auto_max_percent)
          or (p_action_type in ('reembolso', 'cargo_folio') and p_amount_cents <= v_policy.auto_max_amount_cents)) then
    v_status := 'aprobada';
    v_auto := true;
  end if;

  insert into hoteles.agent_approval_request (
    organization_id, property_id, agent_key, action_type, summary, payload, amount_cents, percent, recipients, content_text,
    idempotency_key, status, proposed_by, auto_approved, block_reason, expires_at, decided_at, decision_reason
  ) values (
    v_org, p_property_id, p_agent_key, p_action_type, p_summary, coalesce(p_payload, '{}'::jsonb), p_amount_cents, p_percent, p_recipients, p_content_text,
    p_idempotency_key, v_status, v_uid, v_auto, v_block, v_now + v_expires_min * interval '1 minute',
    case when v_auto then v_now else null end, case when v_auto then 'politica_auto_bajo_umbral' else null end
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function hoteles.decide_agent_approval(p_request_id uuid, p_decision text, p_reason text, p_now timestamptz default now())
returns hoteles.agent_approval_request
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  r hoteles.agent_approval_request;
  v_roles text[];
  v_violation text;
begin
  if auth.uid() is null then
    raise exception 'decide_agent_approval: requiere una persona autenticada' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('aprobar', 'rechazar') then
    raise exception 'decision invalida (aprobar|rechazar)' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 5 or char_length(p_reason) > 500 then
    raise exception 'el motivo es obligatorio (5 a 500 caracteres)' using errcode = '22023';
  end if;
  select * into r from hoteles.agent_approval_request where id = p_request_id for update;
  -- Mismo error para "no existe" y "es de otro tenant" (no se enumeran solicitudes ajenas).
  if not found or hoteles.agent_vertical_role(r.property_id) is null then
    raise exception 'solicitud no encontrada' using errcode = 'P0002';
  end if;
  select approver_roles into v_roles from hoteles.agent_action_policy where property_id = r.property_id and action_type = r.action_type;
  if not hoteles.agent_approver_ok(r.property_id, coalesce(v_roles, array['owner', 'gm']::text[])) then
    raise exception 'tu rol no puede decidir esta accion' using errcode = '42501';
  end if;
  -- Anti-replay: una solicitud ya decidida (o ejecutada, expirada...) no se vuelve a decidir.
  if r.status <> 'pendiente' then
    raise exception 'la solicitud ya esta % y no admite una nueva decision', r.status using errcode = '55000';
  end if;
  if r.expires_at <= v_now then
    update hoteles.agent_approval_request set status = 'expirada' where id = r.id returning * into r;
    return r;
  end if;
  -- Maker-checker: nadie decide lo que el mismo propuso.
  if r.proposed_by is not null and r.proposed_by = auth.uid() then
    raise exception 'no puedes decidir una solicitud que tu mismo propusiste' using errcode = '42501';
  end if;
  if p_decision = 'aprobar' then
    v_violation := hoteles.agent_guardrail_violation(r.property_id, r.action_type, r.amount_cents, r.percent, r.recipients, coalesce(r.content_text, '') || ' ' || coalesce(r.summary, ''));
    if v_violation is not null then
      raise exception 'la solicitud excede un guardrail vigente (%)', v_violation using errcode = '23514';
    end if;
    update hoteles.agent_approval_request set status = 'aprobada', decided_by = auth.uid(), decided_at = v_now, decision_reason = btrim(p_reason)
     where id = r.id returning * into r;
  else
    update hoteles.agent_approval_request set status = 'rechazada', decided_by = auth.uid(), decided_at = v_now, decision_reason = btrim(p_reason)
     where id = r.id returning * into r;
  end if;
  return r;
end;
$$;

-- Consume (ejecuta UNA vez) una aprobacion. Quien lo llama (sistema o owner/gm) debe aplicar el efecto
-- usando EXACTAMENTE lo que devuelve esta fila (inmutable) y en la MISMA transaccion: si el efecto falla,
-- la transaccion revierte y la aprobacion sigue disponible. Devuelve la fila: solo si `status = 'ejecutada'`
-- hay que aplicar el efecto; `aprobada` = diferida (mensaje masivo fuera de horario); `expirada`/`bloqueada`
-- = ya no procede.
create or replace function hoteles.consume_agent_approval(p_request_id uuid, p_execution_ref text, p_now timestamptz default now())
returns hoteles.agent_approval_request
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  r hoteles.agent_approval_request;
  v_violation text;
begin
  select * into r from hoteles.agent_approval_request where id = p_request_id for update;
  if not found or (auth.uid() is not null and not hoteles.can_manage_agents(r.property_id)) then
    raise exception 'solicitud no encontrada' using errcode = 'P0002';
  end if;
  if r.status <> 'aprobada' then
    raise exception 'la solicitud esta % y no se puede ejecutar', r.status using errcode = '55000';
  end if;
  if r.expires_at <= v_now then
    update hoteles.agent_approval_request set status = 'expirada' where id = r.id returning * into r;
    return r;
  end if;
  v_violation := hoteles.agent_guardrail_violation(r.property_id, r.action_type, r.amount_cents, r.percent, r.recipients, coalesce(r.content_text, '') || ' ' || coalesce(r.summary, ''));
  if v_violation is not null then
    update hoteles.agent_approval_request set status = 'bloqueada', block_reason = v_violation where id = r.id returning * into r;
    return r;
  end if;
  if r.action_type = 'mensaje_masivo' and not hoteles.within_send_window(r.property_id, v_now) then
    return r;
  end if;
  update hoteles.agent_approval_request set status = 'ejecutada', executed_at = v_now, executed_by = auth.uid(), execution_ref = left(p_execution_ref, 200)
   where id = r.id returning * into r;
  return r;
end;
$$;

create or replace function hoteles.cancel_agent_approval(p_request_id uuid, p_reason text)
returns hoteles.agent_approval_request
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  r hoteles.agent_approval_request;
begin
  if auth.uid() is null then
    raise exception 'cancel_agent_approval: requiere una persona autenticada' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 5 or char_length(p_reason) > 500 then
    raise exception 'el motivo es obligatorio (5 a 500 caracteres)' using errcode = '22023';
  end if;
  select * into r from hoteles.agent_approval_request where id = p_request_id for update;
  if not found or hoteles.agent_vertical_role(r.property_id) is null then
    raise exception 'solicitud no encontrada' using errcode = 'P0002';
  end if;
  if not (hoteles.can_manage_agents(r.property_id) or r.proposed_by = auth.uid()) then
    raise exception 'solo owner/gm o quien la propuso cancelan una solicitud' using errcode = '42501';
  end if;
  if r.status not in ('pendiente', 'aprobada') then
    raise exception 'la solicitud ya esta % y no se puede cancelar', r.status using errcode = '55000';
  end if;
  update hoteles.agent_approval_request set status = 'cancelada', decision_reason = btrim(p_reason) where id = r.id returning * into r;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) Plantillas: crear version / enviar a revision / aprobar o rechazar / archivar.
-- ---------------------------------------------------------------------------
create or replace function hoteles.create_agent_wa_template(p_property_id uuid, p_agent_key text, p_name text, p_language text, p_category text, p_body text)
returns hoteles.agent_wa_template
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_version integer;
  v_blocked text;
  v_row hoteles.agent_wa_template;
begin
  if auth.uid() is null or not hoteles.can_author_agent_content(p_property_id) then
    raise exception 'sin permiso para redactar plantillas en esta property' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  -- Serializa la numeracion de versiones por (property, nombre, idioma).
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text || '|' || coalesce(p_name, '') || '|' || coalesce(p_language, ''), 0));
  select coalesce(max(version), 0) + 1 into v_version from hoteles.agent_wa_template where property_id = p_property_id and name = p_name and language = p_language;
  v_blocked := hoteles.guardrail_first_blocked_word(p_body, (select blocked_words from hoteles.agent_guardrail where property_id = p_property_id));
  if v_blocked is not null then
    raise exception 'la plantilla contiene una palabra bloqueada por los guardrails' using errcode = '23514';
  end if;
  insert into hoteles.agent_wa_template (organization_id, property_id, agent_key, name, language, category, body, version, created_by)
  values (v_org, p_property_id, p_agent_key, p_name, p_language, p_category, p_body, v_version, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function hoteles.submit_agent_wa_template(p_template_id uuid)
returns hoteles.agent_wa_template
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  r hoteles.agent_wa_template;
begin
  select * into r from hoteles.agent_wa_template where id = p_template_id for update;
  if auth.uid() is null or not found or not hoteles.can_author_agent_content(r.property_id) then
    raise exception 'plantilla no encontrada' using errcode = 'P0002';
  end if;
  if r.status <> 'borrador' then
    raise exception 'la plantilla ya esta % y no se puede enviar a revision', r.status using errcode = '55000';
  end if;
  update hoteles.agent_wa_template set status = 'pendiente', submitted_by = auth.uid(), submitted_at = now() where id = r.id returning * into r;
  return r;
end;
$$;

create or replace function hoteles.review_agent_wa_template(p_template_id uuid, p_decision text, p_reason text)
returns hoteles.agent_wa_template
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  r hoteles.agent_wa_template;
begin
  if p_decision is null or p_decision not in ('aprobar', 'rechazar') then
    raise exception 'decision invalida (aprobar|rechazar)' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 5 or char_length(p_reason) > 300 then
    raise exception 'el motivo es obligatorio (5 a 300 caracteres)' using errcode = '22023';
  end if;
  select * into r from hoteles.agent_wa_template where id = p_template_id for update;
  if auth.uid() is null or not found or hoteles.agent_vertical_role(r.property_id) is null then
    raise exception 'plantilla no encontrada' using errcode = 'P0002';
  end if;
  if not hoteles.can_manage_agents(r.property_id) then
    raise exception 'solo owner/gm aprueban o rechazan plantillas' using errcode = '42501';
  end if;
  if r.status <> 'pendiente' then
    raise exception 'la plantilla esta % y no admite una decision', r.status using errcode = '55000';
  end if;
  -- Separacion de funciones: quien la envio a revision no la aprueba, salvo el dueno.
  if r.submitted_by = auth.uid() and hoteles.agent_vertical_role(r.property_id) <> 'owner' then
    raise exception 'no puedes decidir una plantilla que tu mismo enviaste (solo el dueno)' using errcode = '42501';
  end if;
  if p_decision = 'aprobar' then
    update hoteles.agent_wa_template set status = 'archivada'
     where property_id = r.property_id and name = r.name and language = r.language and status = 'aprobada';
    update hoteles.agent_wa_template set status = 'aprobada', reviewed_by = auth.uid(), reviewed_at = now(), review_reason = btrim(p_reason)
     where id = r.id returning * into r;
  else
    update hoteles.agent_wa_template set status = 'rechazada', reviewed_by = auth.uid(), reviewed_at = now(), review_reason = btrim(p_reason)
     where id = r.id returning * into r;
  end if;
  return r;
end;
$$;

create or replace function hoteles.archive_agent_wa_template(p_template_id uuid)
returns hoteles.agent_wa_template
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  r hoteles.agent_wa_template;
begin
  select * into r from hoteles.agent_wa_template where id = p_template_id for update;
  if auth.uid() is null or not found or hoteles.agent_vertical_role(r.property_id) is null then
    raise exception 'plantilla no encontrada' using errcode = 'P0002';
  end if;
  if not hoteles.can_manage_agents(r.property_id) then
    raise exception 'solo owner/gm archivan plantillas' using errcode = '42501';
  end if;
  if r.status not in ('aprobada', 'rechazada') then
    raise exception 'la plantilla esta % y no se puede archivar', r.status using errcode = '55000';
  end if;
  update hoteles.agent_wa_template set status = 'archivada' where id = r.id returning * into r;
  return r;
end;
$$;

-- Permisos de funciones: revoke de public/anon en todas. Las de SISTEMA y las de usuario van a
-- authenticated (este monorepo no aprovisiona service_role como unico rol de backend: la sesion de sistema
-- es `authenticated` sin sub); cada una se protege por dentro (auth.uid()/rol), no por el GRANT.
revoke all on function hoteles.record_agent_usage(uuid, text, text, bigint, bigint, bigint, bigint) from public, anon;
revoke all on function hoteles.agent_gate(uuid, text, text) from public, anon;
revoke all on function hoteles.expire_agent_approvals(uuid, timestamptz) from public, anon;
revoke all on function hoteles.agent_guardrail_violation(uuid, text, bigint, numeric, integer, text) from public, anon, authenticated;
revoke all on function hoteles.within_send_window(uuid, timestamptz) from public, anon, authenticated;
revoke all on function hoteles.propose_agent_action(uuid, text, text, text, jsonb, bigint, numeric, integer, text, text, timestamptz) from public, anon;
revoke all on function hoteles.decide_agent_approval(uuid, text, text, timestamptz) from public, anon;
revoke all on function hoteles.consume_agent_approval(uuid, text, timestamptz) from public, anon;
revoke all on function hoteles.cancel_agent_approval(uuid, text) from public, anon;
revoke all on function hoteles.create_agent_wa_template(uuid, text, text, text, text, text) from public, anon;
revoke all on function hoteles.submit_agent_wa_template(uuid) from public, anon;
revoke all on function hoteles.review_agent_wa_template(uuid, text, text) from public, anon;
revoke all on function hoteles.archive_agent_wa_template(uuid) from public, anon;
grant execute on function hoteles.record_agent_usage(uuid, text, text, bigint, bigint, bigint, bigint) to authenticated, service_role;
grant execute on function hoteles.agent_gate(uuid, text, text) to authenticated, service_role;
grant execute on function hoteles.expire_agent_approvals(uuid, timestamptz) to authenticated, service_role;
grant execute on function hoteles.agent_guardrail_violation(uuid, text, bigint, numeric, integer, text) to service_role;
grant execute on function hoteles.within_send_window(uuid, timestamptz) to service_role;
grant execute on function hoteles.propose_agent_action(uuid, text, text, text, jsonb, bigint, numeric, integer, text, text, timestamptz) to authenticated, service_role;
grant execute on function hoteles.decide_agent_approval(uuid, text, text, timestamptz) to authenticated, service_role;
grant execute on function hoteles.consume_agent_approval(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function hoteles.cancel_agent_approval(uuid, text) to authenticated, service_role;
grant execute on function hoteles.create_agent_wa_template(uuid, text, text, text, text, text) to authenticated, service_role;
grant execute on function hoteles.submit_agent_wa_template(uuid) to authenticated, service_role;
grant execute on function hoteles.review_agent_wa_template(uuid, text, text) to authenticated, service_role;
grant execute on function hoteles.archive_agent_wa_template(uuid) to authenticated, service_role;
