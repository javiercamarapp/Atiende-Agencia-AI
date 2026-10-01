-- Superadmin "CFO" -- tres piezas de plataforma en una sola migracion:
--   A) MFA TOTP del superadmin (factor, intentos, bloqueo, anti-reuso, bitacora)
--      -- base del step-up de las acciones sensibles (la verificacion del codigo y
--      la emision del token de step-up viven en apps/api; aqui vive el ESTADO
--      que no se puede confiar al cliente: secreto cifrado, contador de
--      intentos, ultimo paso usado).
--   B) Interruptores (kill switches) de plataforma por agente / cron / global.
--   C) Gestion de organizaciones (alta, suspender, reactivar, cambiar plan de
--      cuenta) con DOS pasos (solicitar -> confirmar), motivo obligatorio y
--      bitacora -- mismo principio rector que docs/SUPERADMIN_ACCIONES.md:
--      nada con efecto real se ejecuta con un solo POST.
--
-- Requiere: 0001_core_schema.sql (core.staff_user, core.organization),
-- 0010 platform_superadmin (core.platform_superadmin), 0012_caller_binding_fase2
-- (core.is_platform_superadmin: ata auth.uid() = p_staff_id).
--
-- Reglas de seguridad aplicadas (cada GRANT/policy/funcion trae su razon):
--   * NINGUNA tabla de esta migracion recibe GRANT para anon/authenticated/public
--     y todas llevan RLS habilitada SIN policies: todo acceso pasa por las
--     funciones security definer de abajo (corren como el DUEÑO, que no esta
--     sujeto a RLS). Por eso no hay GRANT a nivel columna: nadie escribe
--     columnas directo. No se otorga NADA a anon.
--   * Funciones de superadmin: security definer + set search_path fijo +
--     `revoke all ... from public` + `grant execute ... to authenticated`, con
--     `auth.uid() = p_caller_id` y `core.platform_superadmin` verificados
--     DENTRO de la funcion (nunca solo en TypeScript).
--   * Funciones de solo-sistema (MFA: leer factor / registrar intento / iniciar
--     enrolamiento; interruptores: leer bloqueados): exigen `auth.uid() is null`.
--     Razon: la verificacion del codigo TOTP ocurre en el servidor; si estas
--     funciones aceptaran a un `authenticated`, un cliente con RPC directo
--     podria declarar "el codigo fue correcto" (p_ok = true) sin conocerlo, o
--     reiniciar su propio contador de intentos fallidos. El backend las llama
--     desde una sesion de SISTEMA tras autenticar al usuario con su JWT.
--   * Bitacora `core.superadmin_security_event`: append-only (trigger que
--     bloquea UPDATE/DELETE aun para el dueño), sin GRANT directo.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0) Bitacora de seguridad del superadmin (mfa / interruptores / organizaciones)
-- ═══════════════════════════════════════════════════════════════════════════
create table core.superadmin_security_event (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  area text not null check (area in ('mfa', 'switch', 'org')),
  event text not null check (event in (
    'mfa_enroll_started', 'mfa_activated', 'mfa_verified', 'mfa_failed', 'mfa_locked', 'mfa_replay', 'mfa_reset',
    'switch_set',
    'org_action_requested', 'org_action_executed', 'org_action_cancelled', 'org_action_expired'
  )),
  -- Quien ejecuto la accion (null solo para eventos de sistema sin actor humano).
  actor_user_id uuid references core.staff_user(id) on delete set null,
  -- Sobre quien/que: usuario (mfa), organizacion (org).
  target_user_id uuid references core.staff_user(id) on delete set null,
  organization_id uuid references core.organization(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index superadmin_security_event_area_seq_idx on core.superadmin_security_event (area, seq desc);

create or replace function core.superadmin_security_event_block_mutation()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  raise exception 'superadmin_security_event_append_only: % no esta permitido sobre %', tg_op, tg_table_name using errcode = '0A000';
end;
$$;
create trigger superadmin_security_event_block_update_trg before update on core.superadmin_security_event
  for each row execute function core.superadmin_security_event_block_mutation();
create trigger superadmin_security_event_block_delete_trg before delete on core.superadmin_security_event
  for each row execute function core.superadmin_security_event_block_mutation();

alter table core.superadmin_security_event enable row level security;
revoke all on core.superadmin_security_event from public, anon, authenticated;

-- Guard interno compartido (NO expuesto): caller-binding + superadmin vigente.
-- Revocado a todos: solo lo invocan, como DUEÑO, las funciones security definer
-- de esta migracion (el dueño conserva EXECUTE).
create or replace function core.superadmin_require_caller(p_caller_id uuid, p_fn text)
returns void language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception '%: caller binding invalido (auth.uid() no coincide con p_caller_id)', p_fn using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception '%: solo un superadmin de plataforma real puede ejecutar esta accion', p_fn using errcode = '42501';
  end if;
end;
$$;
revoke all on function core.superadmin_require_caller(uuid, text) from public, anon, authenticated;

create or replace function core.list_superadmin_security_events(p_caller_id uuid, p_area text default null, p_limit int default 100)
returns table (
  id uuid, seq bigint, area text, event text, actor_user_id uuid, target_user_id uuid,
  organization_id uuid, detail jsonb, occurred_at timestamptz
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  -- Lectura: contrato "cero filas" para quien no es superadmin (como el resto de
  -- las lecturas *_for_superadmin), nunca un error que confirme si hay datos.
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select e.id, e.seq, e.area, e.event, e.actor_user_id, e.target_user_id, e.organization_id, e.detail, e.occurred_at
    from core.superadmin_security_event e
    where p_area is null or e.area = p_area
    order by e.seq desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke all on function core.list_superadmin_security_events(uuid, text, int) from public;
grant execute on function core.list_superadmin_security_events(uuid, text, int) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- A) MFA TOTP
-- ═══════════════════════════════════════════════════════════════════════════
create table core.superadmin_mfa_factor (
  user_id uuid primary key references core.staff_user(id) on delete cascade,
  -- Secreto TOTP CIFRADO por el servidor (AES-256-GCM, formato v1.iv.tag.ct);
  -- un volcado de esta tabla no revela el secreto sin la llave del servidor.
  secret_ciphertext text not null check (char_length(secret_ciphertext) between 20 and 600),
  status text not null default 'pending' check (status in ('pending', 'active')),
  -- Ultimo paso TOTP (floor(epoch/30)) aceptado: un paso <= a este es un reuso.
  last_used_step bigint check (last_used_step is null or last_used_step >= 0),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
alter table core.superadmin_mfa_factor enable row level security;
revoke all on core.superadmin_mfa_factor from public, anon, authenticated;

-- Solo-sistema: iniciar (o reiniciar, si sigue pendiente) el enrolamiento.
-- Si ya hay un factor ACTIVO no se puede reemplazar desde aqui: hay que
-- resetearlo con `superadmin_mfa_reset` (otro superadmin + step-up), para que
-- un token robado no pueda sustituir el factor de la victima.
create or replace function core.superadmin_mfa_begin_enrollment(p_user_id uuid, p_secret_ciphertext text)
returns text language plpgsql security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'superadmin_mfa_begin_enrollment: solo sesion de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.platform_superadmin ps where ps.staff_user_id = p_user_id) then
    raise exception 'superadmin_mfa_begin_enrollment: el usuario no es superadmin de plataforma' using errcode = '42501';
  end if;
  if exists (select 1 from core.superadmin_mfa_factor f where f.user_id = p_user_id and f.status = 'active') then
    raise exception 'superadmin_mfa_begin_enrollment: ya existe un factor activo' using errcode = '55006';
  end if;
  insert into core.superadmin_mfa_factor (user_id, secret_ciphertext, status)
  values (p_user_id, p_secret_ciphertext, 'pending')
  on conflict (user_id) do update
    set secret_ciphertext = excluded.secret_ciphertext, status = 'pending', last_used_step = null,
        failed_attempts = 0, locked_until = null, created_at = now(), confirmed_at = null
    where core.superadmin_mfa_factor.status = 'pending';
  insert into core.superadmin_security_event (area, event, actor_user_id, target_user_id)
  values ('mfa', 'mfa_enroll_started', p_user_id, p_user_id);
  return 'pending';
end;
$$;
revoke all on function core.superadmin_mfa_begin_enrollment(uuid, text) from public;
grant execute on function core.superadmin_mfa_begin_enrollment(uuid, text) to authenticated;

-- Solo-sistema: devuelve el factor (ciphertext) para que el servidor verifique el codigo.
create or replace function core.superadmin_mfa_get_factor(p_user_id uuid)
returns table (secret_ciphertext text, status text, last_used_step bigint, locked_until timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'superadmin_mfa_get_factor: solo sesion de sistema' using errcode = '42501';
  end if;
  return query
    select f.secret_ciphertext, f.status, f.last_used_step, f.locked_until
    from core.superadmin_mfa_factor f where f.user_id = p_user_id;
end;
$$;
revoke all on function core.superadmin_mfa_get_factor(uuid) from public;
grant execute on function core.superadmin_mfa_get_factor(uuid) to authenticated;

-- Solo-sistema: registra el resultado de UN intento de verificacion (el servidor
-- ya comparo el codigo). Atomico (FOR UPDATE): 5 fallos seguidos bloquean 15 min;
-- un paso TOTP ya usado se rechaza ('replay'); un acierto sobre un factor
-- pendiente lo activa ('activated'). Devuelve: ok | activated | invalid | locked | replay.
create or replace function core.superadmin_mfa_record_attempt(p_user_id uuid, p_ok boolean, p_step bigint)
returns text language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v core.superadmin_mfa_factor;
  v_failed integer;
begin
  if auth.uid() is not null then
    raise exception 'superadmin_mfa_record_attempt: solo sesion de sistema' using errcode = '42501';
  end if;
  select * into v from core.superadmin_mfa_factor f where f.user_id = p_user_id for update;
  if not found then
    raise exception 'superadmin_mfa_record_attempt: el usuario no tiene factor MFA' using errcode = 'P0002';
  end if;
  if v.locked_until is not null and v.locked_until > now() then
    return 'locked';
  end if;
  if not p_ok then
    v_failed := v.failed_attempts + 1;
    if v_failed >= 5 then
      update core.superadmin_mfa_factor set failed_attempts = 0, locked_until = now() + interval '15 minutes' where user_id = p_user_id;
      insert into core.superadmin_security_event (area, event, actor_user_id, target_user_id)
      values ('mfa', 'mfa_locked', p_user_id, p_user_id);
      return 'locked';
    end if;
    update core.superadmin_mfa_factor set failed_attempts = v_failed where user_id = p_user_id;
    insert into core.superadmin_security_event (area, event, actor_user_id, target_user_id, detail)
    values ('mfa', 'mfa_failed', p_user_id, p_user_id, jsonb_build_object('intentos', v_failed));
    return 'invalid';
  end if;
  if p_step is null then
    raise exception 'superadmin_mfa_record_attempt: p_step requerido cuando p_ok' using errcode = '22023';
  end if;
  if v.last_used_step is not null and p_step <= v.last_used_step then
    insert into core.superadmin_security_event (area, event, actor_user_id, target_user_id)
    values ('mfa', 'mfa_replay', p_user_id, p_user_id);
    return 'replay';
  end if;
  update core.superadmin_mfa_factor
     set last_used_step = p_step, failed_attempts = 0, locked_until = null, status = 'active',
         confirmed_at = coalesce(confirmed_at, now())
   where user_id = p_user_id;
  if v.status = 'pending' then
    insert into core.superadmin_security_event (area, event, actor_user_id, target_user_id)
    values ('mfa', 'mfa_activated', p_user_id, p_user_id);
    return 'activated';
  end if;
  insert into core.superadmin_security_event (area, event, actor_user_id, target_user_id)
  values ('mfa', 'mfa_verified', p_user_id, p_user_id);
  return 'ok';
end;
$$;
revoke all on function core.superadmin_mfa_record_attempt(uuid, boolean, bigint) from public;
grant execute on function core.superadmin_mfa_record_attempt(uuid, boolean, bigint) to authenticated;

-- Superadmin ve SU PROPIO estado (sin ciphertext).
create or replace function core.superadmin_mfa_status(p_caller_id uuid)
returns table (status text, locked_until timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select f.status, f.locked_until from core.superadmin_mfa_factor f where f.user_id = p_caller_id;
end;
$$;
revoke all on function core.superadmin_mfa_status(uuid) from public;
grant execute on function core.superadmin_mfa_status(uuid) to authenticated;

-- Un superadmin RESETEA el factor de OTRO superadmin (dispositivo perdido).
-- Nunca el propio: sin esto un token robado podria borrar el factor de la
-- victima y re-enrolar el suyo. Motivo >= 20 caracteres, queda en la bitacora.
-- El step-up del caller se exige en apps/api.
create or replace function core.superadmin_mfa_reset(p_caller_id uuid, p_target_user_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_mfa_reset');
  if p_target_user_id = p_caller_id then
    raise exception 'superadmin_mfa_reset: no puedes resetear tu propio factor; pide a otro superadmin' using errcode = '42501';
  end if;
  if char_length(v_reason) < 20 then
    raise exception 'superadmin_mfa_reset: motivo obligatorio (minimo 20 caracteres)' using errcode = '22023';
  end if;
  if not exists (select 1 from core.superadmin_mfa_factor f where f.user_id = p_target_user_id) then
    raise exception 'superadmin_mfa_reset: el usuario no tiene factor MFA' using errcode = 'P0002';
  end if;
  delete from core.superadmin_mfa_factor where user_id = p_target_user_id;
  insert into core.superadmin_security_event (area, event, actor_user_id, target_user_id, detail)
  values ('mfa', 'mfa_reset', p_caller_id, p_target_user_id, jsonb_build_object('motivo', v_reason));
end;
$$;
revoke all on function core.superadmin_mfa_reset(uuid, uuid, text) from public;
grant execute on function core.superadmin_mfa_reset(uuid, uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Interruptores de plataforma (kill switches)
--    Ausencia de fila = NO bloqueado. `blocked = true` = el agente/cron/global
--    queda detenido. El CHECK acota en la BASE las claves validas (no solo en TS).
-- ═══════════════════════════════════════════════════════════════════════════
create table core.platform_switch (
  scope text not null check (scope in ('global', 'agente', 'cron')),
  target text not null,
  blocked boolean not null,
  reason text not null check (char_length(btrim(reason)) >= 20),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (scope, target),
  constraint platform_switch_target_valido check (
    (scope = 'global' and target in ('llm', 'crons'))
    or (scope = 'agente' and target ~ '^[a-z][a-z0-9_]{0,40}:[a-z][a-z0-9_]{0,60}$')
    or (scope = 'cron' and target ~ '^/internal/[a-z0-9/_-]{1,120}$')
  )
);
alter table core.platform_switch enable row level security;
revoke all on core.platform_switch from public, anon, authenticated;

create or replace function core.set_platform_switch(p_caller_id uuid, p_scope text, p_target text, p_blocked boolean, p_reason text)
returns core.platform_switch language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row core.platform_switch;
begin
  perform core.superadmin_require_caller(p_caller_id, 'set_platform_switch');
  if char_length(v_reason) < 20 then
    raise exception 'set_platform_switch: motivo obligatorio (minimo 20 caracteres)' using errcode = '22023';
  end if;
  if p_blocked is null then
    raise exception 'set_platform_switch: p_blocked requerido' using errcode = '22023';
  end if;
  -- El CHECK de la tabla rechaza claves invalidas con 23514.
  insert into core.platform_switch as s (scope, target, blocked, reason, updated_by, updated_at)
  values (p_scope, p_target, p_blocked, v_reason, p_caller_id, now())
  on conflict (scope, target) do update
    set blocked = excluded.blocked, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now()
  returning s.* into v_row;
  insert into core.superadmin_security_event (area, event, actor_user_id, detail)
  values ('switch', 'switch_set', p_caller_id, jsonb_build_object('scope', p_scope, 'target', p_target, 'blocked', p_blocked, 'motivo', v_reason));
  return v_row;
end;
$$;
revoke all on function core.set_platform_switch(uuid, text, text, boolean, text) from public;
grant execute on function core.set_platform_switch(uuid, text, text, boolean, text) to authenticated;

create or replace function core.list_platform_switches_for_superadmin(p_caller_id uuid)
returns setof core.platform_switch language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select s.* from core.platform_switch s order by s.scope, s.target;
end;
$$;
revoke all on function core.list_platform_switches_for_superadmin(uuid) from public;
grant execute on function core.list_platform_switches_for_superadmin(uuid) to authenticated;

-- Solo-sistema: lo que el gateway LLM y los crons consultan (sin p_caller_id).
-- Devuelve unicamente los BLOQUEADOS (nunca el motivo ni quien: no es superficie
-- de lectura para tenants).
create or replace function core.get_blocked_platform_switches()
returns table (scope text, target text) language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'get_blocked_platform_switches: solo sesion de sistema' using errcode = '42501';
  end if;
  return query select s.scope, s.target from core.platform_switch s where s.blocked;
end;
$$;
revoke all on function core.get_blocked_platform_switches() from public;
grant execute on function core.get_blocked_platform_switches() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Gestion de organizaciones: solicitar -> confirmar
--    "Plan de cuenta" = core.organization.status (trial|active). NO toca
--    core.organization_billing ni Stripe (precio/asientos se mueven por el flujo
--    de suscripcion existente; un catalogo de planes pagados es decision de
--    producto pendiente).
-- ═══════════════════════════════════════════════════════════════════════════
create table core.org_admin_action (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('alta', 'suspender', 'reactivar', 'cambiar_plan')),
  -- Null en 'alta' hasta que se ejecuta (entonces vive en resultado.organization_id).
  organization_id uuid references core.organization(id) on delete restrict,
  payload jsonb not null default '{}'::jsonb,
  motivo text not null check (char_length(btrim(motivo)) >= 20),
  estado text not null default 'pending' check (estado in ('pending', 'executed', 'cancelled', 'expired')),
  creado_por uuid not null references core.staff_user(id) on delete restrict,
  creado_en timestamptz not null default now(),
  vence_en timestamptz not null,
  confirmado_por uuid references core.staff_user(id) on delete restrict,
  confirmado_en timestamptz,
  resultado jsonb,
  constraint org_admin_action_vence_despues check (vence_en > creado_en),
  constraint org_admin_action_alta_sin_org check ((tipo = 'alta') = (organization_id is null))
);
-- Una sola accion pendiente por organizacion: evita confirmar dos veces, o
-- suspender y cambiar plan al mismo tiempo sobre la misma organizacion.
create unique index org_admin_action_una_pendiente_por_org on core.org_admin_action (organization_id) where estado = 'pending' and organization_id is not null;
create index org_admin_action_creado_idx on core.org_admin_action (creado_en desc);

-- Inmutabilidad: tipo/organizacion/payload/motivo/autor nunca cambian, y un
-- estado terminal no se reabre -- la tabla ES la bitacora de gestion de orgs.
create or replace function core.org_admin_action_guard()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'org_admin_action_append_only: DELETE no permitido' using errcode = '0A000';
  end if;
  if new.tipo <> old.tipo or new.organization_id is distinct from old.organization_id
     or new.payload <> old.payload or new.motivo <> old.motivo or new.creado_por <> old.creado_por
     or new.creado_en <> old.creado_en or new.vence_en <> old.vence_en then
    raise exception 'org_admin_action_inmutable: solo cambian estado/confirmacion/resultado' using errcode = '0A000';
  end if;
  if old.estado <> 'pending' then
    raise exception 'org_admin_action_inmutable: un estado terminal no se modifica' using errcode = '0A000';
  end if;
  return new;
end;
$$;
create trigger org_admin_action_guard_trg before update or delete on core.org_admin_action
  for each row execute function core.org_admin_action_guard();

alter table core.org_admin_action enable row level security;
revoke all on core.org_admin_action from public, anon, authenticated;

create or replace function core.request_org_admin_action(p_caller_id uuid, p_tipo text, p_organization_id uuid, p_payload jsonb, p_motivo text)
returns core.org_admin_action language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_status text;
  v_row core.org_admin_action;
begin
  perform core.superadmin_require_caller(p_caller_id, 'request_org_admin_action');
  if char_length(v_motivo) < 20 then
    raise exception 'request_org_admin_action: motivo obligatorio (minimo 20 caracteres)' using errcode = '22023';
  end if;
  if p_tipo not in ('alta', 'suspender', 'reactivar', 'cambiar_plan') then
    raise exception 'request_org_admin_action: tipo invalido' using errcode = '22023';
  end if;

  if p_tipo = 'alta' then
    if p_organization_id is not null then
      raise exception 'request_org_admin_action: alta no recibe organization_id' using errcode = '22023';
    end if;
    if coalesce(v_payload->>'vertical', '') not in ('hoteles', 'restaurantes', 'rentas', 'licitaciones', 'citas', 'despachos')
       or char_length(btrim(coalesce(v_payload->>'name', ''))) not between 2 and 120
       or coalesce(v_payload->>'slug', '') !~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$' then
      raise exception 'request_org_admin_action: alta requiere payload {vertical, name (2-120), slug valido}' using errcode = '22023';
    end if;
    if exists (select 1 from core.organization o where o.slug = v_payload->>'slug') then
      raise exception 'request_org_admin_action: el slug ya existe' using errcode = '23505';
    end if;
    v_payload := jsonb_build_object('vertical', v_payload->>'vertical', 'name', btrim(v_payload->>'name'), 'slug', v_payload->>'slug');
  else
    select o.status into v_status from core.organization o where o.id = p_organization_id;
    if not found then
      raise exception 'request_org_admin_action: la organizacion no existe' using errcode = 'P0002';
    end if;
    if p_tipo = 'suspender' then
      if v_status = 'suspended' then
        raise exception 'request_org_admin_action: la organizacion ya esta suspendida' using errcode = '55006';
      end if;
      v_payload := '{}'::jsonb;
    elsif p_tipo = 'reactivar' then
      if v_status <> 'suspended' then
        raise exception 'request_org_admin_action: la organizacion no esta suspendida' using errcode = '55006';
      end if;
      v_payload := '{}'::jsonb;
    else
      if coalesce(v_payload->>'plan', '') not in ('trial', 'active') then
        raise exception 'request_org_admin_action: cambiar_plan requiere payload {plan: trial|active}' using errcode = '22023';
      end if;
      if v_status = 'suspended' then
        raise exception 'request_org_admin_action: reactiva la organizacion antes de cambiar su plan' using errcode = '55006';
      end if;
      if v_status = v_payload->>'plan' then
        raise exception 'request_org_admin_action: la organizacion ya tiene ese plan' using errcode = '55006';
      end if;
      v_payload := jsonb_build_object('plan', v_payload->>'plan');
    end if;
  end if;

  begin
    insert into core.org_admin_action (tipo, organization_id, payload, motivo, creado_por, vence_en)
    values (p_tipo, p_organization_id, v_payload, v_motivo, p_caller_id, now() + interval '10 minutes')
    returning * into v_row;
  exception when unique_violation then
    raise exception 'request_org_admin_action: ya hay una accion pendiente para esta organizacion' using errcode = '55006';
  end;
  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_action_requested', p_caller_id, p_organization_id, jsonb_build_object('action_id', v_row.id, 'tipo', p_tipo, 'motivo', v_motivo));
  return v_row;
end;
$$;
revoke all on function core.request_org_admin_action(uuid, text, uuid, jsonb, text) from public;
grant execute on function core.request_org_admin_action(uuid, text, uuid, jsonb, text) to authenticated;

-- Confirma y EJECUTA (re-valida el estado actual del mundo: pudo cambiar desde
-- la solicitud). Solo el MISMO superadmin que solicito. El step-up se exige en apps/api.
create or replace function core.confirm_org_admin_action(p_caller_id uuid, p_action_id uuid)
returns core.org_admin_action language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v core.org_admin_action;
  v_status text;
  v_new_org uuid;
  v_previo text;
  v_resultado jsonb;
begin
  perform core.superadmin_require_caller(p_caller_id, 'confirm_org_admin_action');
  select * into v from core.org_admin_action a where a.id = p_action_id for update;
  if not found then
    raise exception 'confirm_org_admin_action: la accion no existe' using errcode = 'P0002';
  end if;
  if v.creado_por <> p_caller_id then
    raise exception 'confirm_org_admin_action: solo quien solicito la accion puede confirmarla' using errcode = '42501';
  end if;
  if v.estado <> 'pending' then
    raise exception 'confirm_org_admin_action: la accion ya no esta pendiente (estado %)', v.estado using errcode = '55006';
  end if;
  if v.vence_en <= now() then
    update core.org_admin_action set estado = 'expired' where id = v.id returning * into v;
    insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
    values ('org', 'org_action_expired', p_caller_id, v.organization_id, jsonb_build_object('action_id', v.id));
    return v;
  end if;

  if v.tipo = 'alta' then
    if exists (select 1 from core.organization o where o.slug = v.payload->>'slug') then
      raise exception 'confirm_org_admin_action: el slug ya existe' using errcode = '23505';
    end if;
    insert into core.organization (vertical, name, slug, status)
    values (v.payload->>'vertical', v.payload->>'name', v.payload->>'slug', 'trial')
    returning id into v_new_org;
    v_resultado := jsonb_build_object('organization_id', v_new_org, 'status', 'trial');
  else
    select o.status into v_status from core.organization o where o.id = v.organization_id for update;
    if not found then
      raise exception 'confirm_org_admin_action: la organizacion ya no existe' using errcode = 'P0002';
    end if;
    if v.tipo = 'suspender' then
      if v_status = 'suspended' then
        raise exception 'confirm_org_admin_action: la organizacion ya esta suspendida' using errcode = '55006';
      end if;
      update core.organization set status = 'suspended' where id = v.organization_id;
      v_resultado := jsonb_build_object('status_previo', v_status, 'status', 'suspended');
    elsif v.tipo = 'reactivar' then
      if v_status <> 'suspended' then
        raise exception 'confirm_org_admin_action: la organizacion ya no esta suspendida' using errcode = '55006';
      end if;
      -- Restaura el estado previo a la ULTIMA suspension ejecutada (trial|active).
      select a.resultado->>'status_previo' into v_previo
      from core.org_admin_action a
      where a.organization_id = v.organization_id and a.tipo = 'suspender' and a.estado = 'executed'
      order by a.confirmado_en desc nulls last limit 1;
      if v_previo is null or v_previo not in ('trial', 'active') then v_previo := 'active'; end if;
      update core.organization set status = v_previo where id = v.organization_id;
      v_resultado := jsonb_build_object('status_previo', 'suspended', 'status', v_previo);
    else
      if v_status = 'suspended' then
        raise exception 'confirm_org_admin_action: la organizacion esta suspendida' using errcode = '55006';
      end if;
      if v_status = v.payload->>'plan' then
        raise exception 'confirm_org_admin_action: la organizacion ya tiene ese plan' using errcode = '55006';
      end if;
      update core.organization set status = v.payload->>'plan' where id = v.organization_id;
      v_resultado := jsonb_build_object('status_previo', v_status, 'status', v.payload->>'plan');
    end if;
  end if;

  update core.org_admin_action
     set estado = 'executed', confirmado_por = p_caller_id, confirmado_en = now(), resultado = v_resultado
   where id = v.id returning * into v;
  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_action_executed', p_caller_id, coalesce(v.organization_id, v_new_org),
          jsonb_build_object('action_id', v.id, 'tipo', v.tipo, 'resultado', v_resultado));
  return v;
end;
$$;
revoke all on function core.confirm_org_admin_action(uuid, uuid) from public;
grant execute on function core.confirm_org_admin_action(uuid, uuid) to authenticated;

create or replace function core.cancel_org_admin_action(p_caller_id uuid, p_action_id uuid)
returns core.org_admin_action language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v core.org_admin_action;
begin
  perform core.superadmin_require_caller(p_caller_id, 'cancel_org_admin_action');
  select * into v from core.org_admin_action a where a.id = p_action_id for update;
  if not found then
    raise exception 'cancel_org_admin_action: la accion no existe' using errcode = 'P0002';
  end if;
  if v.creado_por <> p_caller_id then
    raise exception 'cancel_org_admin_action: solo quien solicito la accion puede cancelarla' using errcode = '42501';
  end if;
  if v.estado <> 'pending' then
    raise exception 'cancel_org_admin_action: la accion ya no esta pendiente (estado %)', v.estado using errcode = '55006';
  end if;
  update core.org_admin_action set estado = 'cancelled' where id = v.id returning * into v;
  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_action_cancelled', p_caller_id, v.organization_id, jsonb_build_object('action_id', v.id));
  return v;
end;
$$;
revoke all on function core.cancel_org_admin_action(uuid, uuid) from public;
grant execute on function core.cancel_org_admin_action(uuid, uuid) to authenticated;

create or replace function core.list_org_admin_actions_for_superadmin(p_caller_id uuid, p_limit int default 50)
returns setof core.org_admin_action language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query select a.* from core.org_admin_action a order by a.creado_en desc limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke all on function core.list_org_admin_actions_for_superadmin(uuid, int) from public;
grant execute on function core.list_org_admin_actions_for_superadmin(uuid, int) to authenticated;
