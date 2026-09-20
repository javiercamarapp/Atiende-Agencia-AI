-- Fase 10 hoteles (motor de recomendaciones de tarifa, v1) — la pieza que faltaba a
-- la infraestructura de gobierno del PR #128 (011_revenue_engine_gate.sql +
-- revenueEngineGate.ts + walkForwardBacktest.ts): el gate shadow->propone->autopilot
-- y el backtest walk-forward YA EXISTEN y son la autoridad real; esta migración
-- agrega el ALMACENAMIENTO de lo que el motor de cómputo
-- (packages/domain-hoteles/src/revenue/rateRecommendationEngine.ts) produce, más las
-- dos fuentes de datos manuales que alimentan sus señales (eventos locales, tarifas
-- de competidor) y la configuración de reglas por property/room_type.
--
-- NO rediseña el gate ni el backtest -- los reutiliza tal cual (ver sección 5,
-- `hoteles.can_manage_revenue_gate` ya existe desde migrations/011, y el chequeo de
-- "último backtest pasa" de la sección 4 usa la MISMA fuente de verdad
-- (`hoteles.revenue_backtest_run`) que `revenue_engine_gate_transition_guard` ya
-- exige para promover a autopilot -- no se puede "llamar" un trigger como función,
-- así que se repite la MISMA consulta, nunca una condición distinta).
--
-- CLASIFICACIÓN DE SESIÓN (documentada aquí porque decide todo el diseño de RLS/
-- triggers de abajo):
--   - Insertar una recomendación nueva (el cron de cómputo): SIEMPRE sesión de
--     sistema (`auth.uid() is null`, mismo patrón que night-audit --
--     `packages/db/src/managed-postgres-engine.ts::withAppSession({ userId: null })`,
--     rol Postgres sigue siendo `authenticated`, nunca `service_role`).
--   - Aprobar/descartar una recomendación en gate "propone": sesión de STAFF
--     (owner/gm) -- SOLO cambia el estado a 'aprobada'/'descartada', NUNCA escribe
--     la tarifa real.
--   - Aplicar una recomendación (escribir `hoteles.rate_plan`): SIEMPRE sesión de
--     sistema -- ni siquiera owner/gm puede ejecutar esto directo, ver
--     `hoteles.system_apply_rate_recommendation` en la sección 6. En "propone" el
--     flujo correcto es: staff aprueba (sesión de staff, estado->'aprobada') y el
--     cron de sistema la aplica de verdad en su siguiente corrida (sesión de
--     sistema, estado 'aprobada'->'aplicada'). En "autopilot" el propio cron puede
--     ir directo de 'pendiente'->'aplicada' (dentro de los límites de la sección 4).
--
-- Requiere: 001_hoteles_schema.sql (core.property, hoteles.room_type,
-- hoteles.rate_plan, core.has_property_access), 011_revenue_engine_gate.sql
-- (hoteles.revenue_engine_gate, hoteles.revenue_backtest_run,
-- hoteles.can_manage_revenue_gate).

-- ---------------------------------------------------------------------------
-- 1) hoteles.pricing_rule — floor/ceiling/multiplicador DOW/LOS por room_type.
--    Una fila por room_type (no por property) porque el rango de precio razonable
--    de una suite y un cuarto estándar del MISMO hotel son distintos -- si un
--    room_type no tiene fila, el motor de cómputo usa
--    `DEFAULT_PRICING_RULES` (dominio puro, sin tocar la base).
-- ---------------------------------------------------------------------------
create table hoteles.pricing_rule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id) on delete cascade,
  floor_price numeric(12, 2) not null check (floor_price >= 0),
  ceiling_price numeric(12, 2) not null check (ceiling_price > 0),
  -- Un valor por día de la semana, domingo..sábado (mismo orden que
  -- `date_part('dow', ...)`/`Date.prototype.getUTCDay()` en el dominio puro).
  day_of_week_multiplier numeric(4, 2)[] not null check (array_length(day_of_week_multiplier, 1) = 7),
  min_stay_default integer not null default 1 check (min_stay_default >= 1),
  min_stay_on_high_demand integer not null default 2 check (min_stay_on_high_demand >= min_stay_default),
  updated_by uuid references core.staff_user(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (room_type_id),
  check (ceiling_price >= floor_price)
);
create index pricing_rule_property_idx on hoteles.pricing_rule (property_id);

create or replace function hoteles.pricing_rule_guard()
returns trigger
language plpgsql security definer set search_path = core, hoteles as $$
declare
  v_org uuid;
  v_property uuid;
  v_mult numeric;
begin
  select p.organization_id, p.id into v_org, v_property
    from hoteles.room_type rt join core.property p on p.id = rt.property_id
    where rt.id = new.room_type_id;
  if v_org is null then
    raise exception 'room_type_invalido: room_type % no existe', new.room_type_id using errcode = '23503';
  end if;
  if new.property_id is distinct from v_property then
    raise exception 'property_no_coincide: room_type % no pertenece a property %', new.room_type_id, new.property_id using errcode = 'P0001';
  end if;
  new.organization_id := v_org;
  foreach v_mult in array new.day_of_week_multiplier loop
    if v_mult is null or v_mult <= 0 then
      raise exception 'multiplicador_invalido: cada multiplicador de day_of_week_multiplier debe ser > 0' using errcode = 'P0001';
    end if;
  end loop;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger pricing_rule_guard_trg
  before insert or update on hoteles.pricing_rule
  for each row execute function hoteles.pricing_rule_guard();

alter table hoteles.pricing_rule enable row level security;
create policy "pricing_rule: staff con acceso ve las reglas" on hoteles.pricing_rule for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "pricing_rule: owner/gm crea reglas" on hoteles.pricing_rule for insert
  with check (hoteles.can_manage_revenue_gate(property_id));
create policy "pricing_rule: owner/gm actualiza reglas" on hoteles.pricing_rule for update
  using (hoteles.can_manage_revenue_gate(property_id)) with check (hoteles.can_manage_revenue_gate(property_id));

revoke all on hoteles.pricing_rule from public, anon;
grant select, insert, update on hoteles.pricing_rule to authenticated;
grant select, insert, update, delete on hoteles.pricing_rule to service_role;

-- ---------------------------------------------------------------------------
-- 2) hoteles.local_event — eventos locales que SOLO el staff de esa property
--    conoce (feria del pueblo, concierto, congreso) -- nunca inventados ni
--    scrapeados (a diferencia del calendario federal/temporada, que vive en
--    código puro, ver calendarioMexico.ts).
-- ---------------------------------------------------------------------------
create table hoteles.local_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  nombre text not null check (length(nombre) between 1 and 200),
  fecha_inicio date not null,
  fecha_fin date not null check (fecha_fin >= fecha_inicio),
  impacto text not null check (impacto in ('alza_demanda', 'baja_demanda')),
  magnitud_pct numeric(5, 2) not null check (magnitud_pct > 0),
  registrado_por uuid references core.staff_user(id),
  created_at timestamptz not null default now()
);
create index local_event_property_fechas_idx on hoteles.local_event (property_id, fecha_inicio, fecha_fin);

create or replace function hoteles.local_event_guard()
returns trigger
language plpgsql security definer set search_path = core, hoteles as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from core.property where id = new.property_id;
  if v_org is null then
    raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
  end if;
  new.organization_id := v_org;
  new.registrado_por := coalesce(new.registrado_por, auth.uid());
  return new;
end;
$$;

create trigger local_event_guard_trg
  before insert on hoteles.local_event
  for each row execute function hoteles.local_event_guard();

alter table hoteles.local_event enable row level security;
create policy "local_event: staff con acceso ve eventos locales" on hoteles.local_event for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "local_event: owner/gm/accountant registra un evento local" on hoteles.local_event for insert
  with check (
    exists (
      select 1 from core.membership m
      join core.property p on p.organization_id = m.organization_id
      where m.user_id = auth.uid() and p.id = local_event.property_id
        and (m.property_ids is null or local_event.property_id = any(m.property_ids))
        and m.vertical_role in ('owner', 'gm', 'accountant')
    )
  );
-- Sin UPDATE/DELETE: un evento local mal capturado se corrige registrando uno nuevo
-- (mismo criterio append-only que revenue_backtest_run) -- evita que alguien borre
-- silenciosamente la justificación de una recomendación ya calculada con ese evento.

revoke all on hoteles.local_event from public, anon;
grant select, insert on hoteles.local_event to authenticated;
grant select, insert, update, delete on hoteles.local_event to service_role;

-- ---------------------------------------------------------------------------
-- 3) hoteles.competitor_rate — captura MANUAL de tarifas de competidores. Sin
--    ningún scraper (mismo criterio que licitaciones/ComprasMX: evadir la
--    protección anti-bot de una OTA no es aceptable) -- diseñada para que un
--    proveedor de rate-shopping de pago (RateGain/OTA Insight) se pueda conectar
--    en el futuro como fuente ALTERNATIVA sin cambiar el resto del motor (ver
--    knownGaps del PR: mismo patrón de credencial-por-pegar que ya usa el resto
--    del repo, ej. LICITACIONES_AGGREGATOR_API_KEY -- NO se construye aquí sin la
--    credencial real).
--
--    DISTINTO de `compsetGuard.ts`/`assertBenchmarkQueryAllowed` (REQ-REV-004):
--    aquella es una guarda para un agregado de BENCHMARKING entre MUCHOS tenants
--    (k>=10, antitrust) -- esta tabla es solo la lista de tarifas de competidores
--    que ESTE hotel decidió anotar a mano para SU propia decisión de precio, sin
--    agregar datos de otros tenants de esta plataforma.
-- ---------------------------------------------------------------------------
create table hoteles.competitor_rate (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  competidor text not null check (length(competidor) between 1 and 200),
  fecha date not null,
  tarifa numeric(12, 2) not null check (tarifa > 0),
  capturada_por uuid references core.staff_user(id),
  capturada_en timestamptz not null default now()
);
create index competitor_rate_property_fecha_idx on hoteles.competitor_rate (property_id, fecha);

create or replace function hoteles.competitor_rate_guard()
returns trigger
language plpgsql security definer set search_path = core, hoteles as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from core.property where id = new.property_id;
  if v_org is null then
    raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
  end if;
  new.organization_id := v_org;
  new.capturada_por := coalesce(new.capturada_por, auth.uid());
  new.capturada_en := now();
  return new;
end;
$$;

create trigger competitor_rate_guard_trg
  before insert on hoteles.competitor_rate
  for each row execute function hoteles.competitor_rate_guard();

alter table hoteles.competitor_rate enable row level security;
create policy "competitor_rate: staff con acceso ve tarifas de competidor" on hoteles.competitor_rate for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "competitor_rate: owner/gm/accountant captura una tarifa" on hoteles.competitor_rate for insert
  with check (
    exists (
      select 1 from core.membership m
      join core.property p on p.organization_id = m.organization_id
      where m.user_id = auth.uid() and p.id = competitor_rate.property_id
        and (m.property_ids is null or competitor_rate.property_id = any(m.property_ids))
        and m.vertical_role in ('owner', 'gm', 'accountant')
    )
  );
-- Sin UPDATE/DELETE por el mismo criterio que local_event -- una captura errónea se
-- corrige con una fila nueva, nunca editando/borrando la evidencia histórica.

revoke all on hoteles.competitor_rate from public, anon;
grant select, insert on hoteles.competitor_rate to authenticated;
grant select, insert, update, delete on hoteles.competitor_rate to service_role;

-- ---------------------------------------------------------------------------
-- 4) hoteles.rate_recommendation — una fila por property/room_type/fecha futura,
--    con su desglose completo (jsonb) de las señales que la produjeron. Espejo de
--    persistencia de `rateRecommendationEngine.ts` (packages/domain-hoteles/src/
--    revenue/rateRecommendationEngine.ts::RateRecommendationResult).
-- ---------------------------------------------------------------------------
create type hoteles.rate_recommendation_status as enum ('pendiente', 'aprobada', 'aplicada', 'descartada', 'expirada');

create table hoteles.rate_recommendation (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id) on delete cascade,
  fecha date not null,
  current_bar_price numeric(12, 2) not null check (current_bar_price > 0),
  recommended_price numeric(12, 2) not null check (recommended_price >= 0),
  suggested_min_stay integer not null check (suggested_min_stay >= 1),
  -- Desglose COMPLETO de las señales (pickup/evento/compset/regla aplicada) --
  -- espejo de `RateRecommendationResult.desglose` -- para que la pantalla nunca
  -- sea una caja negra. Nunca se reconstruye a partir de otras tablas: es el
  -- congelado exacto de lo que el motor vio al momento de calcular.
  desglose jsonb not null,
  estado hoteles.rate_recommendation_status not null default 'pendiente',
  aprobada_por uuid references core.staff_user(id),
  aprobada_en timestamptz,
  -- null = aplicada por el sistema (cron), no null = aplicada por un humano (hoy
  -- nunca ocurre -- ver clasificación de sesión en la cabecera de este archivo --
  -- la columna existe para que el historial sea honesto incluso si en el futuro se
  -- permitiera una aplicación manual explícita fuera del flujo propone/autopilot).
  aplicada_por uuid references core.staff_user(id),
  aplicada_en timestamptz,
  descartada_por uuid references core.staff_user(id),
  descartada_en timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (estado <> 'aprobada' or (aprobada_por is not null and aprobada_en is not null)),
  check (estado <> 'aplicada' or aplicada_en is not null),
  check (estado <> 'descartada' or (descartada_por is not null and descartada_en is not null))
);
-- Orden total determinista para listas paginadas (REQ del brief) -- (fecha,
-- room_type_id, id) nunca empata: `id` (uuid) desempata en última instancia.
create index rate_recommendation_property_fecha_idx on hoteles.rate_recommendation (property_id, fecha desc, room_type_id, id);
create index rate_recommendation_estado_idx on hoteles.rate_recommendation (property_id, estado);
-- A lo sumo UNA recomendación "abierta" (pendiente o aprobada) por
-- property/room_type/fecha -- el cron de cómputo (ver
-- apps/api/.../revenue-recommendations-cron.ts) nunca recalcula una fecha que ya
-- tiene una decisión pendiente sin resolver; una vez aplicada/descartada/expirada,
-- SÍ puede volver a calcularse (ej. el día siguiente, con pickup fresco).
create unique index rate_recommendation_one_active_idx on hoteles.rate_recommendation (property_id, room_type_id, fecha)
  where estado in ('pendiente', 'aprobada');

-- ---------------------------------------------------------------------------
-- 5) Trigger de transición de `hoteles.rate_recommendation.estado` -- la máquina
--    de estados REAL (mismo patrón que `revenue_engine_gate_transition_guard`,
--    sección 3 de migrations/011).
-- ---------------------------------------------------------------------------
create or replace function hoteles.rate_recommendation_status_guard()
returns trigger
language plpgsql
security definer
set search_path = core, hoteles
as $$
declare
  v_now timestamptz := now();
  v_org uuid;
  v_gate hoteles.revenue_gate_state;
  v_max_variation_pct numeric;
  v_variation_pct numeric;
  v_latest_backtest_passes boolean;
begin
  if TG_OP = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
    end if;
    new.organization_id := v_org;
    if auth.uid() is not null then
      raise exception 'insercion_requiere_sistema: solo la sesion de sistema (el cron de computo) puede insertar una recomendacion nueva' using errcode = '42501';
    end if;
    if new.estado <> 'pendiente' then
      raise exception 'estado_inicial_invalido: toda recomendacion nueva debe insertarse en "pendiente", no en "%"', new.estado using errcode = 'P0001';
    end if;
    new.aprobada_por := null;
    new.aprobada_en := null;
    new.aplicada_por := null;
    new.aplicada_en := null;
    new.descartada_por := null;
    new.descartada_en := null;
    new.updated_at := v_now;
    return new;
  end if;

  -- TG_OP = 'UPDATE' -----------------------------------------------------------------

  -- Los datos calculados por el motor son INMUTABLES fuera de una transición real de
  -- estado -- preservan exactamente lo que el motor vio al momento del cálculo
  -- (integridad de auditoría, mismo criterio que "timestamps_de_fase_inmutables" de
  -- migrations/011).
  if new.property_id is distinct from old.property_id
    or new.room_type_id is distinct from old.room_type_id
    or new.fecha is distinct from old.fecha
    or new.current_bar_price is distinct from old.current_bar_price
    or new.recommended_price is distinct from old.recommended_price
    or new.suggested_min_stay is distinct from old.suggested_min_stay
    or new.desglose is distinct from old.desglose
  then
    raise exception 'datos_de_recomendacion_inmutables: los campos calculados por el motor no se pueden editar, solo transicionar el estado' using errcode = 'P0001';
  end if;

  if new.estado = old.estado then
    new.updated_at := v_now;
    return new;
  end if;

  if old.estado in ('aplicada', 'descartada', 'expirada') then
    raise exception 'estado_terminal: una recomendacion en estado "%" ya no puede transicionar', old.estado using errcode = 'P0001';
  end if;

  select gate, propone_max_variation_pct into v_gate, v_max_variation_pct
    from hoteles.revenue_engine_gate where property_id = new.property_id;
  if v_gate is null then
    raise exception 'gate_no_inicializado: la property % no tiene revenue_engine_gate inicializado', new.property_id using errcode = 'P0001';
  end if;

  v_variation_pct := abs(new.recommended_price - new.current_bar_price) / greatest(new.current_bar_price, 0.01) * 100;

  if old.estado = 'pendiente' and new.estado = 'aprobada' then
    if auth.uid() is null then
      raise exception 'aprobacion_requiere_staff: la aprobacion de una recomendacion la registra un humano, nunca la sesion de sistema' using errcode = '42501';
    end if;
    if not hoteles.can_manage_revenue_gate(new.property_id) then
      raise exception 'aprobacion_requiere_owner_gm: solo owner/gm puede aprobar una recomendacion (REQ-REV, mismo nivel que mover el gate)' using errcode = '42501';
    end if;
    if v_gate <> 'propone' then
      raise exception 'aprobacion_fuera_de_propone: aprobar una recomendacion individual solo aplica cuando el gate esta en "propone" (en "autopilot" el sistema aplica directo, en "shadow" nunca se ejecuta nada)' using errcode = 'P0001';
    end if;
    new.aprobada_por := auth.uid();
    new.aprobada_en := v_now;

  elsif old.estado in ('pendiente', 'aprobada') and new.estado = 'descartada' then
    if auth.uid() is null then
      raise exception 'descarte_requiere_staff: descartar una recomendacion lo hace un humano, nunca la sesion de sistema' using errcode = '42501';
    end if;
    if not hoteles.can_manage_revenue_gate(new.property_id) then
      raise exception 'descarte_requiere_owner_gm: solo owner/gm puede descartar una recomendacion' using errcode = '42501';
    end if;
    new.descartada_por := auth.uid();
    new.descartada_en := v_now;

  elsif old.estado in ('pendiente', 'aprobada') and new.estado = 'aplicada' then
    if auth.uid() is not null then
      raise exception 'aplicacion_requiere_sistema: aplicar una recomendacion (escribir la tarifa real) es SIEMPRE sesion de sistema, ni siquiera owner/gm puede hacerlo directo -- ver hoteles.system_apply_rate_recommendation' using errcode = '42501';
    end if;
    if old.estado = 'pendiente' and v_gate <> 'autopilot' then
      raise exception 'aplicacion_directa_solo_autopilot: pasar de "pendiente" a "aplicada" sin aprobacion previa solo es valido en gate "autopilot" (property en "%")', v_gate using errcode = 'P0001';
    end if;
    if old.estado = 'aprobada' and v_gate not in ('propone', 'autopilot') then
      raise exception 'gate_insuficiente_para_aplicar: la property retrocedio a "shadow" (gate actual "%") despues de la aprobacion -- esta recomendacion ya no puede aplicarse', v_gate using errcode = 'P0001';
    end if;
    -- Misma fuente de verdad que `revenue_engine_gate_transition_guard` exige para
    -- promover a autopilot (hoteles.revenue_backtest_run.passes del ultimo run) --
    -- se repite la consulta porque un trigger no se puede invocar como funcion, NUNCA
    -- una condicion distinta.
    select passes into v_latest_backtest_passes
      from hoteles.revenue_backtest_run where property_id = new.property_id order by run_at desc limit 1;
    if v_latest_backtest_passes is not true then
      raise exception 'backtest_no_supera_baseline: no hay un backtest walk-forward vigente que pase para la property %', new.property_id using errcode = 'P0001';
    end if;
    if v_variation_pct > v_max_variation_pct + 1e-6 then
      raise exception 'variacion_excede_limite: el cambio propuesto (% por ciento) excede el limite vigente de +-% por ciento (propone_max_variation_pct) incluso en autopilot -- guarda de seguridad deliberada de v1', round(v_variation_pct, 2), v_max_variation_pct using errcode = 'P0001';
    end if;
    new.aplicada_por := null;
    new.aplicada_en := v_now;

  elsif old.estado in ('pendiente', 'aprobada') and new.estado = 'expirada' then
    if auth.uid() is not null then
      raise exception 'expiracion_requiere_sistema: expirar una recomendacion vencida es solo del cron de limpieza de sistema' using errcode = '42501';
    end if;
    if new.fecha >= current_date then
      raise exception 'expiracion_prematura: solo se puede expirar una recomendacion cuya fecha (%) ya paso', new.fecha using errcode = 'P0001';
    end if;

  else
    raise exception 'transicion_no_permitida: no se puede pasar de "%" a "%"', old.estado, new.estado using errcode = 'P0001';
  end if;

  new.updated_at := v_now;
  return new;
end;
$$;

create trigger rate_recommendation_status_guard_trg
  before insert or update on hoteles.rate_recommendation
  for each row execute function hoteles.rate_recommendation_status_guard();

alter table hoteles.rate_recommendation enable row level security;

-- SELECT: cualquier rol de staff de la property ve sus recomendaciones
-- (transparencia -- "nunca una caja negra"), mismo criterio que
-- revenue_engine_gate; la sesión de sistema (auth.uid() is null) TAMBIÉN puede leer
-- -- necesario para que el propio cron liste sus pendientes por aplicar/expirar
-- entre properties, y para que "INSERT ... RETURNING" (gotcha real de RLS de
-- Postgres: RETURNING también exige que la fila pase la policy de SELECT, no solo
-- la de INSERT) no falle al insertar como sistema.
create policy "rate_recommendation: staff con acceso o sistema ve recomendaciones" on hoteles.rate_recommendation for select
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

-- INSERT: solo la sesion de sistema (el trigger de la seccion 5 ya rechaza
-- auth.uid() is not null, esta policy solo decide quien puede INTENTARLO).
create policy "rate_recommendation: sistema inserta recomendaciones" on hoteles.rate_recommendation for insert
  with check (auth.uid() is null);

-- UPDATE: owner/gm (aprobar/descartar) O sistema (aplicar/expirar) pueden INTENTAR
-- actualizar -- el trigger de la seccion 5 es la autoridad real de CUAL transicion
-- es valida para cada uno.
create policy "rate_recommendation: owner/gm o sistema actualizan estado" on hoteles.rate_recommendation for update
  using (auth.uid() is null or hoteles.can_manage_revenue_gate(property_id))
  with check (auth.uid() is null or hoteles.can_manage_revenue_gate(property_id));

revoke all on hoteles.rate_recommendation from public, anon;
grant select, insert, update on hoteles.rate_recommendation to authenticated;
grant select, insert, update, delete on hoteles.rate_recommendation to service_role;

-- ---------------------------------------------------------------------------
-- 6) hoteles.system_apply_rate_recommendation — ÚNICA vía para escribir la tarifa
--    BAR real (hoteles.rate_plan) a partir de una recomendación. Solo-sistema
--    (mismo patrón que hoteles.system_post_night_audit_charge de migrations/023):
--    ni siquiera owner/gm puede invocarla -- en "propone" el flujo correcto es
--    aprobar (sección 5) y dejar que el cron de sistema aplique de verdad en su
--    siguiente corrida.
-- ---------------------------------------------------------------------------
create or replace function hoteles.system_apply_rate_recommendation(p_recommendation_id uuid)
returns hoteles.rate_recommendation
language plpgsql security definer set search_path = core, hoteles as $$
declare
  v_rec hoteles.rate_recommendation;
begin
  if auth.uid() is not null then
    raise exception 'system_apply_rate_recommendation es solo para la sesion de sistema' using errcode = '42501';
  end if;

  select * into v_rec from hoteles.rate_recommendation where id = p_recommendation_id for update;
  if v_rec is null then
    raise exception 'recomendacion_invalida: % no existe', p_recommendation_id using errcode = 'P0001';
  end if;
  if v_rec.estado not in ('pendiente', 'aprobada') then
    raise exception 'estado_no_aplicable: la recomendacion % esta en estado "%", no se puede aplicar', p_recommendation_id, v_rec.estado using errcode = 'P0001';
  end if;

  -- Escribe la tarifa BAR real -- misma tabla que
  -- `HotelesRepository.upsertRatePlanRange` ya usa (hoteles.rate_plan, ver
  -- migrations/001), un solo día. Preserva currency/closed_to_arrival/
  -- closed_to_departure existentes si ya había una fila para esa fecha.
  insert into hoteles.rate_plan (organization_id, property_id, room_type_id, date, price, min_stay)
  values (v_rec.organization_id, v_rec.property_id, v_rec.room_type_id, v_rec.fecha, v_rec.recommended_price, v_rec.suggested_min_stay)
  on conflict (room_type_id, date) do update
    set price = excluded.price, min_stay = excluded.min_stay, updated_at = now();

  -- La transición de estado la valida el trigger de la sección 5 (misma autoridad
  -- que cualquier otro camino de escritura a esta tabla, incluida la ruta HTTP).
  update hoteles.rate_recommendation set estado = 'aplicada' where id = p_recommendation_id
    returning * into v_rec;

  return v_rec;
end;
$$;

revoke execute on function hoteles.system_apply_rate_recommendation(uuid) from public;
grant execute on function hoteles.system_apply_rate_recommendation(uuid) to authenticated;
