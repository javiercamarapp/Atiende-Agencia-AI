-- Fase 9 hoteles (REQ-REV-003, P0/GOB, fuentes BP-053/BP-054/BP-056/H02-003/H07-007/
-- BP-016): el motor de revenue (recomendación/ejecución de tarifas BAR) debe operar
-- en "shadow" (solo registra lo que habría hecho, nunca ejecuta) un mínimo de 90
-- días, con backtesting walk-forward obligatorio que exija mejora vs. baseline antes
-- de habilitar autopilot; después de shadow pasa a "propone y ejecuta" (con
-- aprobación humana por cambio) con un límite de variación ±10-15% hasta autopilot
-- pleno. Espejo de base de datos de
-- `packages/domain-hoteles/src/revenue/revenueEngineGate.ts` (mismo patrón que
-- 005_reservas_estado.sql / reservationStateMachine.ts).
--
-- Autoridad real: el trigger `revenue_engine_gate_transition_guard_trg` de abajo, no
-- la aplicación — ninguna sesión (ni siquiera owner/gm, que sí pueden escribir la
-- fila por RLS) puede saltarse el mínimo de 90 días, el backtest, o la aprobación
-- explícita de "owner" escribiendo directamente a esta tabla.
--
-- Diferencia deliberada con el original (hoteles/packages/db/migrations/
-- 0082_revenue_engine_gate.sql): el original condiciona propone->autopilot también a
-- `require_founder_decision_approval('shadow_a_autopilot_revenue', ...)`, una tabla
-- de decisiones reservadas al fundador que fusion NO ha portado (no existe ningún
-- `founder_reserved_category` ni rol "founder" distinto de "owner" en este repo —
-- ver `domain-hoteles/src/roles.ts::HOTEL_ROLES`). Esta migración exige en su lugar
-- una aprobación explícita del rol real más alto que SÍ existe aquí (`owner`),
-- registrada en la columna `owner_approved_autopilot_at` de esta misma tabla,
-- guardada por el propio trigger de transición (sección 3) usando el helper de
-- autorización `hoteles.can_approve_revenue_autopilot()` (sección 5) — mismo nivel de
-- exigencia de gobierno (P0/GOB: "reservado a una decisión de alto nivel, nunca
-- self-service de un cambio de gate"), sin fingir una integración cruzada con infra
-- que este repo no tiene todavía.
--
-- Requiere: 001_hoteles_schema.sql (core.property, core.staff_user,
-- core.has_property_access).

-- ---------------------------------------------------------------------------
-- 1) Estado del gate por property (un hotel = un `core.property`).
-- ---------------------------------------------------------------------------
create type hoteles.revenue_gate_state as enum ('shadow', 'propone', 'autopilot');

create table hoteles.revenue_engine_gate (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  gate hoteles.revenue_gate_state not null default 'shadow',
  -- Momento en que la property entró (o volvió a entrar, tras una democión) en shadow.
  shadow_started_at timestamptz not null default now(),
  propone_started_at timestamptz,
  autopilot_started_at timestamptz,
  -- REQ-REV-003 "límite de variación (±10-15%)" vigente mientras gate = 'propone'.
  propone_max_variation_pct numeric(4, 1) not null default 15.0
    check (propone_max_variation_pct >= 10.0 and propone_max_variation_pct <= 15.0),
  -- Aprobación explícita de "owner" (ver comentario de cabecera) requerida ANTES de
  -- poder promover propone->autopilot. NULL = sin aprobación vigente. El trigger de
  -- la sección 4 es quien decide QUIÉN puede escribir este campo (solo owner), y el
  -- trigger de la sección 3 lo limpia en cada democión (una aprobación vieja no
  -- sobrevive a un ciclo shadow/propone nuevo).
  owner_approved_autopilot_at timestamptz,
  updated_by uuid references core.staff_user(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (property_id),
  check ((gate = 'shadow') or (propone_started_at is not null)),
  check ((gate <> 'autopilot') or (autopilot_started_at is not null)),
  check ((gate <> 'shadow') or (owner_approved_autopilot_at is null))
);

create index revenue_engine_gate_org_idx on hoteles.revenue_engine_gate (organization_id);

-- ---------------------------------------------------------------------------
-- 2) Backtests walk-forward corridos por property (histórico completo, nunca se
--    sobrescribe -- el trigger de la sección 3 solo mira el más reciente para
--    decidir si autopilot es elegible, pero conservar el historial permite auditar
--    por qué una promoción se aprobó/bloqueó en su momento).
-- ---------------------------------------------------------------------------
create table hoteles.revenue_backtest_run (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  -- Espejo de `CounterfactualMethod` (walkForwardBacktest.ts) -- catálogo cerrado, no
  -- texto libre, para que un método inventado sobre la marcha (nunca documentado) no
  -- pueda colarse como si fuera uno de los 3 métodos honestos del dominio.
  counterfactual_method text not null
    check (counterfactual_method in ('misma_tarifa_periodo_anterior', 'tarifa_estatica_pre_motor', 'modelo_elasticidad_declarado')),
  windows_evaluated integer not null check (windows_evaluated >= 0),
  windows_engine_won integer not null check (windows_engine_won >= 0 and windows_engine_won <= windows_evaluated),
  engine_total_revenue numeric(14, 2) not null,
  baseline_total_revenue numeric(14, 2) not null,
  improvement_pct numeric(8, 3) not null,
  passes boolean not null,
  -- Códigos de falla (espejo de `WalkForwardBacktestResult.failureReasons`) -- '[]' si
  -- `passes = true`.
  failure_reasons jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  run_by uuid references core.staff_user(id),
  run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((passes = true) = (failure_reasons = '[]'::jsonb))
);

create index revenue_backtest_run_property_idx on hoteles.revenue_backtest_run (property_id, run_at desc);

-- ---------------------------------------------------------------------------
-- 3) Trigger de transición del gate (la máquina de estados REAL).
-- ---------------------------------------------------------------------------
create or replace function hoteles.revenue_engine_gate_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = core, hoteles
as $$
declare
  v_now timestamptz := now();
  v_org uuid;
  v_order_from integer;
  v_order_to integer;
  v_days_in_shadow integer;
  v_latest_backtest record;
begin
  select organization_id into v_org from core.property where id = new.property_id;
  if v_org is null then
    raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
  end if;
  new.organization_id := v_org;

  if TG_OP = 'INSERT' then
    -- BP-016: ninguna property entra en un gate distinto de shadow por omisión ni
    -- por inserción directa -- la única forma de llegar a "propone"/"autopilot" es
    -- promover una fila ya existente a través de este mismo trigger.
    if new.gate <> 'shadow' then
      raise exception 'gate_inicial_invalido: toda property nueva debe comenzar en "shadow" (REQ-REV-003/BP-016), no en "%"', new.gate
        using errcode = 'P0001';
    end if;
    new.shadow_started_at := coalesce(new.shadow_started_at, v_now);
    new.propone_started_at := null;
    new.autopilot_started_at := null;
    new.owner_approved_autopilot_at := null;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  -- TG_OP = 'UPDATE' -----------------------------------------------------------------

  v_order_from := case old.gate when 'shadow' then 0 when 'propone' then 1 when 'autopilot' then 2 end;
  v_order_to := case new.gate when 'shadow' then 0 when 'propone' then 1 when 'autopilot' then 2 end;

  if new.gate = old.gate then
    -- Sin cambio de fase: los timestamps de fase son inmutables fuera de una
    -- transición real (evita que alguien "reescriba" cuánto tiempo lleva en shadow
    -- sin pasar por una transición de gate de verdad).
    if new.shadow_started_at is distinct from old.shadow_started_at
      or new.propone_started_at is distinct from old.propone_started_at
      or new.autopilot_started_at is distinct from old.autopilot_started_at
    then
      raise exception 'timestamps_de_fase_inmutables: shadow_started_at/propone_started_at/autopilot_started_at solo los fija este trigger durante una transición real de gate'
        using errcode = 'P0001';
    end if;
    -- Único lugar donde `owner_approved_autopilot_at` puede cambiar por decisión
    -- deliberada de un llamador (registrar/revocar la aprobación ANTES de reintentar
    -- la promoción propone->autopilot en un UPDATE posterior -- mismo patrón de dos
    -- pasos que el original exigía vía `require_founder_decision_approval`: la
    -- aprobación es un hecho previo y auditable, nunca algo que se cuele en el mismo
    -- UPDATE que hace la promoción, ver abajo). Solo "owner" puede tocarla, tanto
    -- para otorgarla como para revocarla -- evita que "gm" silenciosamente limpie la
    -- aprobación de un owner para reintentar con otra sesión.
    if new.owner_approved_autopilot_at is distinct from old.owner_approved_autopilot_at then
      if not hoteles.can_approve_revenue_autopilot(new.property_id) then
        raise exception 'aprobacion_requiere_owner: solo el rol "owner" puede registrar o revocar la aprobacion para habilitar autopilot (REQ-REV-003 P0/GOB)'
          using errcode = 'P0001';
      end if;
      if new.gate <> 'propone' and new.owner_approved_autopilot_at is not null then
        raise exception 'aprobacion_fuera_de_propone: la aprobacion de autopilot solo puede registrarse mientras el gate esta en "propone"'
          using errcode = 'P0001';
      end if;
    end if;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  -- A partir de aquí SIEMPRE hay un cambio real de gate: `owner_approved_autopilot_at`
  -- nunca lo decide directamente el llamador en el mismo UPDATE que mueve el gate --
  -- en una democión se fuerza a null sin importar quién la ejecuta (ver abajo, mismo
  -- criterio que los demás timestamps de fase); en una promoción se conserva
  -- exactamente el valor previo (`old.`), así que solo cuenta una aprobación YA
  -- registrada en un UPDATE anterior, nunca una que llegue agazapada en este mismo
  -- UPDATE.
  if v_order_to < v_order_from then
    -- DEMOCIÓN ("freno de emergencia"): siempre permitida, sin ninguna de las
    -- condiciones de abajo -- un gerente que baja el motor a shadow porque sospecha
    -- algo no necesita pedirle permiso a nadie. Volver a shadow reinicia el reloj de
    -- 90 días (es un shadow NUEVO, no una pausa) y limpia la aprobación de owner
    -- (una aprobación vieja no debe sobrevivir a un ciclo nuevo); volver a propone
    -- desde autopilot conserva (o fija, si faltaba) su propio started_at pero exige
    -- una aprobación y un backtest nuevos para volver a subir.
    new.owner_approved_autopilot_at := null;
    if new.gate = 'shadow' then
      new.shadow_started_at := v_now;
      new.propone_started_at := null;
      new.autopilot_started_at := null;
    elsif new.gate = 'propone' then
      new.propone_started_at := v_now;
      new.autopilot_started_at := null;
    end if;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  if v_order_to > v_order_from + 1 then
    raise exception 'transicion_no_permitida: no se puede saltar directamente de "%" a "%" (REQ-REV-003 exige pasar por "propone")', old.gate, new.gate
      using errcode = 'P0001';
  end if;

  -- PROMOCIÓN: ignora cualquier valor de owner_approved_autopilot_at que el
  -- llamador haya enviado en ESTE UPDATE -- solo cuenta lo que ya estaba en `old.`.
  new.owner_approved_autopilot_at := old.owner_approved_autopilot_at;

  -- PROMOCIÓN shadow -> propone: mínimo 90 días en shadow.
  if old.gate = 'shadow' and new.gate = 'propone' then
    v_days_in_shadow := floor(extract(epoch from (v_now - old.shadow_started_at)) / 86400);
    if v_days_in_shadow < 90 then
      raise exception 'shadow_insuficiente: se requieren 90 dias en shadow antes de pasar a "propone" (REQ-REV-003), van % dias', v_days_in_shadow
        using errcode = 'P0001';
    end if;
    new.propone_started_at := v_now;
    new.autopilot_started_at := null;
  end if;

  -- PROMOCIÓN propone -> autopilot: backtest walk-forward vigente que pase +
  -- aprobación de "owner" YA registrada (ver bloque de arriba -- se exige que sea
  -- `old.owner_approved_autopilot_at`, nunca solo `new.`, para forzar el paso
  -- previo auditable, mismo criterio que el original con `require_founder_decision_
  -- approval`).
  if old.gate = 'propone' and new.gate = 'autopilot' then
    select * into v_latest_backtest
      from hoteles.revenue_backtest_run
      where property_id = new.property_id
      order by run_at desc
      limit 1;

    if v_latest_backtest is null or v_latest_backtest.passes is not true then
      raise exception 'backtest_no_supera_baseline: no existe un backtest walk-forward vigente que demuestre mejora vs. baseline para la property % (REQ-REV-003)', new.property_id
        using errcode = 'P0001';
    end if;
    if old.propone_started_at is not null and v_latest_backtest.run_at < old.propone_started_at then
      raise exception 'backtest_obsoleto: el ultimo backtest walk-forward es anterior a que esta property entrara en modo "propone" -- se requiere uno corrido durante/despues de "propone"'
        using errcode = 'P0001';
    end if;

    if old.owner_approved_autopilot_at is null then
      raise exception 'aprobacion_owner_requerida: se requiere una aprobacion vigente del rol "owner" antes de habilitar autopilot (REQ-REV-003 P0/GOB) -- registrala primero (owner_approved_autopilot_at) y reintenta la promocion'
        using errcode = 'P0001';
    end if;

    new.autopilot_started_at := v_now;
  end if;

  new.updated_by := auth.uid();
  new.updated_at := v_now;
  return new;
end;
$$;

create trigger revenue_engine_gate_transition_guard_trg
  before insert or update on hoteles.revenue_engine_gate
  for each row execute function hoteles.revenue_engine_gate_transition_guard();

-- ---------------------------------------------------------------------------
-- 4) Guard de property/org para revenue_backtest_run.
-- ---------------------------------------------------------------------------
create or replace function hoteles.revenue_backtest_run_guard()
returns trigger
language plpgsql
security definer
set search_path = core, hoteles
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from core.property where id = new.property_id;
  if v_org is null then
    raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
  end if;
  new.organization_id := v_org;
  new.run_by := coalesce(new.run_by, auth.uid());
  return new;
end;
$$;

create trigger revenue_backtest_run_guard_trg
  before insert on hoteles.revenue_backtest_run
  for each row execute function hoteles.revenue_backtest_run_guard();

-- ---------------------------------------------------------------------------
-- 5) Autorización -- mismo patrón que `hoteles.can_manage_reservations()`
--    (migrations/005) / `hoteles.can_manage_attendance()` (migrations/010).
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_manage_revenue_gate(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm')
  )
$$;

-- Más estricto que `can_manage_revenue_gate`: registrar la aprobación que exige
-- REQ-REV-003 (P0/GOB) para habilitar autopilot pleno queda reservado SOLO a
-- "owner" -- ni siquiera "gm" (ver comentario de cabecera de este archivo y
-- REVENUE_AUTOPILOT_APPROVAL_ROLES en domain-hoteles/src/roles.ts).
create or replace function hoteles.can_approve_revenue_autopilot(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role = 'owner'
  )
$$;

-- ---------------------------------------------------------------------------
-- 6) RLS.
-- ---------------------------------------------------------------------------
alter table hoteles.revenue_engine_gate enable row level security;

-- SELECT: cualquier rol de staff de la property puede ver el gate vigente
-- (transparencia, mismo criterio que reservation_status_event).
create policy "revenue_engine_gate: staff con acceso ve el gate" on hoteles.revenue_engine_gate for select
  using (core.has_property_access(auth.uid(), property_id));

-- INSERT/UPDATE: cambiar el gate del motor de revenue (o su límite de variación) es
-- una decisión de gobierno reservada a owner/gm -- el trigger de la sección 3 impone
-- además las condiciones REALES de promoción/aprobación, esto solo decide quién
-- puede intentarlo.
create policy "revenue_engine_gate: owner/gm crea el gate" on hoteles.revenue_engine_gate for insert
  with check (hoteles.can_manage_revenue_gate(property_id));
create policy "revenue_engine_gate: owner/gm actualiza el gate" on hoteles.revenue_engine_gate for update
  using (hoteles.can_manage_revenue_gate(property_id)) with check (hoteles.can_manage_revenue_gate(property_id));

revoke all on hoteles.revenue_engine_gate from public, anon;
grant select, insert, update on hoteles.revenue_engine_gate to authenticated;
grant select, insert, update, delete on hoteles.revenue_engine_gate to service_role;

alter table hoteles.revenue_backtest_run enable row level security;

-- SELECT: igual transparencia que el gate -- cualquier rol de staff de la property
-- puede ver el historial de backtests (es la evidencia de por qué el gate está
-- donde está).
create policy "revenue_backtest_run: staff con acceso ve el historial" on hoteles.revenue_backtest_run for select
  using (core.has_property_access(auth.uid(), property_id));

-- INSERT: registrar la corrida de un backtest requiere el mismo nivel que decidir el
-- gate (owner/gm) o accountant (rol que ya opera night audit/cierre, REQ-REV-013) --
-- nunca frontdesk/housekeeping/maintenance/fnb, que no tienen ninguna injerencia
-- sobre revenue. Sin policy de UPDATE/DELETE: cada corrida es inmutable, igual que
-- attendance_log.
create policy "revenue_backtest_run: owner/gm/accountant registra una corrida" on hoteles.revenue_backtest_run for insert
  with check (
    exists (
      select 1 from core.membership m
      join core.property p on p.organization_id = m.organization_id
      where m.user_id = auth.uid() and p.id = revenue_backtest_run.property_id
        and (m.property_ids is null or revenue_backtest_run.property_id = any(m.property_ids))
        and m.vertical_role in ('owner', 'gm', 'accountant')
    )
  );

revoke all on hoteles.revenue_backtest_run from public, anon;
grant select, insert on hoteles.revenue_backtest_run to authenticated;
grant select, insert, update, delete on hoteles.revenue_backtest_run to service_role;
