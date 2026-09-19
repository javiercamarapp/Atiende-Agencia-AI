-- Bloque C del roadmap -- impersonación de soporte: conecta el mecanismo de
-- "ver como" ya construido en `packages/core-authz/src/impersonation/*`
-- (commit 103fec0, ya en main desde el 11-sep) a una SESIÓN real verificada en
-- Postgres, con motivo obligatorio, duración corta, expiración verificada en
-- SQL (no solo en la aplicación) y bitácora append-only inalterable.
--
-- GAP VERIFICADO ANTES DE CONSTRUIR (no se asumió la descripción del hallazgo
-- sin leer el código real primero):
--   1. `packages/core-authz/src/impersonation/*` resuelve "a qué organización
--      apunta esta petición" (cookie HMAC firmada, TTL app-side de 12h) y
--      anota una bitácora EN MEMORIA con dedupe DIARIO -- ver el comentario de
--      cabecera de `audit.ts`: "un fallo de auditoría nunca debe bloquear al
--      superadmin", diseñado a propósito para el caso "navegar el panel como
--      si fueras el tenant", no para "romper cristal"/impersonación con
--      motivo por evento. CERO tabla Postgres, CERO ruta HTTP lo invoca
--      todavía (confirmado con `grep -rln` sobre `apps/` antes de empezar).
--   2. `packages/core-authz/src/admin-middleware.ts` (`requireOrganizationMembership`
--      + `requireAdminAccess`) generaliza el gateo de `/admin/*` para el STAFF
--      PROPIO de una organización (roles `owner|admin|member|viewer` de
--      `@atiende/core-tenancy`, atados a una fila de `core.membership`) --
--      CERO caller real hoy (cada `admin-staff.ts` de cada vertical usa su
--      propio chequeo a medida). Un superadmin de PLATAFORMA nunca tiene fila
--      de `core.membership` por diseño (ver comentario de cabecera de
--      `impersonation/resolve.ts`: "el superadmin... no pertenece a NINGUNA
--      organización"), así que `requireOrganizationMembership` no aplica
--      tal cual a esta pieza -- se conecta `requireAdminAccess` (audit-on-
--      denial + rate-limit reales, la parte de valor) a la ruta nueva de esta
--      migración con un `platformRole` sintético resuelto por
--      `core.is_platform_superadmin`, documentado en el PR. Conectar
--      `requireOrganizationMembership` a un `/admin/*` real de alguna
--      vertical es un rediseño de varios archivos de otros builders --
--      deliberadamente NO se inventa aquí, ver `knownGaps` del PR.
--
-- MODELO DE SEGURIDAD COPIADO de `packages/domain-rentas/migrations/
-- 012_break_glass_audit.sql` (PR #132): motivo obligatorio (mínimo 20
-- caracteres), bitácora INMUTABLE encadenada por hash POR ORGANIZACIÓN
-- (mismo razonamiento de alcance que ese archivo: "el tenant afectado
-- pregunta por SU organización"), triggers que bloquean UPDATE/DELETE
-- incondicionalmente -- incluso para `service_role` --, RLS con policy de
-- SELECT para cualquier superadmin real vigente (`core.is_platform_
-- superadmin(auth.uid())`, oversight de plataforma) y GRANT mínimo (sin
-- INSERT/UPDATE/DELETE para `authenticated`: solo las funciones `security
-- definer` de abajo escriben, corriendo como el DUEÑO de la migración, que
-- por default NO tiene RLS forzada -- ver `alter table ... force row level
-- security` ausente a propósito, mismo criterio que rentas).
--
-- DIFERENCIA DELIBERADA frente al mecanismo de "ver como" (cookie) existente:
-- esta migración agrega el concepto de SESIÓN con estado verificado EN SQL --
-- `core.impersonation_session` (una fila = una sesión declarada, INSERT-ONLY,
-- nunca se actualiza) + `core.impersonation_audit_log` (evento `start`/`end`,
-- INSERT-ONLY). "¿Está activa?" se calcula SIEMPRE en SQL, nunca en TS:
-- `expires_at > now()` Y no existe un evento `end` para esa sesión -- así
-- NINGUNA de las dos tablas necesita jamás un UPDATE (ni para "cerrar" la
-- sesión), lo que hace el append-only trivialmente cierto por construcción,
-- no solo por trigger (el trigger es defensa en profundidad adicional, igual
-- que en break_glass_access_log).
--
-- "Nunca impersonar a otro superadmin" (requisito no negociable de la tarea)
-- -- a nivel de organización (el objetivo de esta impersonación, NO una
-- identidad de usuario específica: ver el comentario de cabecera de
-- `resolve.ts`, "este módulo nunca decide QUIÉN es superadmin... solo A QUÉ
-- ORGANIZACIÓN apunta esta petición") esto se traduce en la única regla
-- verificable en SQL que tiene sentido con ese diseño: no se puede abrir una
-- sesión de impersonación contra una organización que tiene a OTRO superadmin
-- de plataforma como miembro -- protege los datos personales/de prueba de un
-- superadmin par de ser vistos por otro superadmin vía este mecanismo sin su
-- consentimiento, incluso aunque un superadmin normalmente no tenga
-- membership (el caso real que sí puede pasar: una cuenta de plataforma que
-- ADEMÁS es staff de una organización propia/de prueba).
--
-- Requiere: 0001_core_schema.sql (core.staff_user, core.organization,
-- core.membership), 0012_caller_binding_fase2.sql (core.is_platform_
-- superadmin(p_staff_id) -- se REUTILIZA tal cual, nunca se reimplementa).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) core.impersonation_session -- una fila = una sesión declarada. INSERT-ONLY.
--    `expires_at` es SIEMPRE calculado dentro de `start_impersonation_session`
--    (nunca recibido del cliente) -- el CHECK de abajo es defensa en
--    profundidad adicional contra un INSERT directo futuro que se saltara la
--    función (ej. una migración de datos a mano).
-- ═══════════════════════════════════════════════════════════════════════════
create table core.impersonation_session (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references core.staff_user(id) on delete restrict,
  -- Snapshot al momento de abrir -- igual criterio que `actor_email` en
  -- `break_glass_access_log`/`impersonation/audit.ts::ImpersonationAuditEntry`.
  actor_email text,
  organization_id uuid not null references core.organization(id) on delete restrict,
  -- Motivo obligatorio -- mismo umbral (20 caracteres tras `btrim`) que
  -- `rentas.break_glass_access_log.reason`, defensa en profundidad DB-side.
  reason text not null check (char_length(btrim(reason)) >= 20),
  started_at timestamptz not null default now(),
  -- Duración máxima corta: 20 minutos de techo absoluto (la función que
  -- inserta usa 15 minutos fijos, nunca un valor pasado por el cliente) --
  -- ver `core.start_impersonation_session` abajo.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint impersonation_session_expira_despues_de_empezar check (expires_at > started_at),
  constraint impersonation_session_duracion_maxima_20_min check (expires_at <= started_at + interval '20 minutes')
);
create index impersonation_session_actor_idx on core.impersonation_session (actor_user_id, started_at desc);
create index impersonation_session_org_idx on core.impersonation_session (organization_id, started_at desc);

create or replace function core.impersonation_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'impersonation_append_only: % no está permitido sobre %', tg_op, tg_table_name
    using errcode = '0A000';
end;
$$;

create trigger impersonation_session_block_update_trg
  before update on core.impersonation_session
  for each row execute function core.impersonation_block_mutation();
create trigger impersonation_session_block_delete_trg
  before delete on core.impersonation_session
  for each row execute function core.impersonation_block_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) core.impersonation_audit_log -- un evento por fila (`start`/`end`),
--    INSERT-ONLY, encadenado por hash POR ORGANIZACIÓN -- mismo patrón EXACTO
--    que `rentas.break_glass_access_log`/`rentas.break_glass_chain_head`
--    (packages/domain-rentas/migrations/012_break_glass_audit.sql), que a su
--    vez copia `hoteles.attendance_log_chain_head`.
-- ═══════════════════════════════════════════════════════════════════════════
create table core.impersonation_audit_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references core.impersonation_session(id) on delete restrict,
  event_type text not null check (event_type in ('start', 'end')),
  actor_user_id uuid not null references core.staff_user(id) on delete restrict,
  actor_email text,
  organization_id uuid not null references core.organization(id) on delete restrict,
  -- Motivo -- presente en el evento `start` (copia del de la sesión), null en `end`.
  reason text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  seq bigint generated always as identity,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create unique index impersonation_audit_log_seq_idx on core.impersonation_audit_log (seq);
create index impersonation_audit_log_org_seq_idx on core.impersonation_audit_log (organization_id, seq);
create index impersonation_audit_log_session_idx on core.impersonation_audit_log (session_id, occurred_at);
create index impersonation_audit_log_actor_idx on core.impersonation_audit_log (actor_user_id, occurred_at desc);

create table core.impersonation_chain_head (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  hash text
);
revoke all on core.impersonation_chain_head from public, anon, authenticated;
alter table core.impersonation_chain_head enable row level security;
-- Sin ninguna policy: solo el trigger de abajo (SECURITY DEFINER) la toca.

create or replace function core.impersonation_log_set_hash()
returns trigger
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_prev_hash text;
  v_occurred_at timestamptz;
  v_canonical text;
begin
  insert into core.impersonation_chain_head (organization_id, hash)
  values (new.organization_id, null)
  on conflict (organization_id) do nothing;

  select hash into v_prev_hash
  from core.impersonation_chain_head
  where organization_id = new.organization_id
  for update;

  v_occurred_at := coalesce(new.occurred_at, now());

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.session_id::text
    || '|' || new.event_type
    || '|' || new.actor_user_id::text
    || '|' || coalesce(new.actor_email, '')
    || '|' || new.organization_id::text
    || '|' || coalesce(new.reason, '')
    || '|' || new.detail::text
    || '|' || v_occurred_at::text;

  new.prev_hash := v_prev_hash;
  new.occurred_at := v_occurred_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  update core.impersonation_chain_head set hash = new.hash where organization_id = new.organization_id;

  return new;
end;
$$;

create trigger impersonation_audit_log_set_hash_trg
  before insert on core.impersonation_audit_log
  for each row execute function core.impersonation_log_set_hash();

create trigger impersonation_audit_log_block_update_trg
  before update on core.impersonation_audit_log
  for each row execute function core.impersonation_block_mutation();
create trigger impersonation_audit_log_block_delete_trg
  before delete on core.impersonation_audit_log
  for each row execute function core.impersonation_block_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) RLS -- lectura: cualquier superadmin de plataforma VIGENTE ve TODA la
--    bitácora/sesiones (oversight real de plataforma -- un superadmin puede
--    ver lo que hizo otro, a propósito: es la misma plataforma auditándose a
--    sí misma). Escritura: NINGUNA policy de INSERT/UPDATE/DELETE para
--    `authenticated` ni `service_role` -- las únicas escritoras son las
--    funciones `security definer` de abajo, que corren como el DUEÑO de la
--    tabla (no sujeto a RLS por default, sin `force row level security`),
--    mismo criterio documentado en el comentario de cabecera de esta
--    migración. Fail-closed real: ni siquiera un bug futuro que reutilizara
--    `service_role` para un INSERT directo pasaría la ausencia total de
--    policy de escritura.
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.impersonation_session enable row level security;
alter table core.impersonation_audit_log enable row level security;

create policy "impersonation_session: cualquier superadmin vigente ve todas las sesiones" on core.impersonation_session for select
  using (core.is_platform_superadmin(auth.uid()));

create policy "impersonation_audit_log: cualquier superadmin vigente ve toda la bitácora" on core.impersonation_audit_log for select
  using (core.is_platform_superadmin(auth.uid()));

revoke all on core.impersonation_session from public, anon;
revoke all on core.impersonation_audit_log from public, anon;
grant select on core.impersonation_session to authenticated;
grant select on core.impersonation_audit_log to authenticated;
-- `service_role` conserva acceso total a nivel de GRANT (mismo criterio que
-- break_glass_access_log: los triggers de arriba bloquean UPDATE/DELETE
-- incondicionalmente de todas formas, incluido `service_role` -- defensa en
-- profundidad, no ausencia de permiso).
grant select, insert, update, delete on core.impersonation_session to service_role;
grant select, insert, update, delete on core.impersonation_audit_log to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) Funciones `security definer` -- ÚNICA superficie de escritura real.
--    Caller-binding SIEMPRE primero (mismo orden que las 12 funciones de
--    `0011_superadmin_caller_binding.sql`): `auth.uid() is not null and
--    auth.uid() = p_caller_id`, luego `core.is_platform_superadmin(p_caller_id)`
--    -- reutilizada tal cual, nunca reimplementada.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.start_impersonation_session(
  p_caller_id uuid,
  p_organization_id uuid,
  p_reason text
)
returns core.impersonation_session
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_session core.impersonation_session;
  v_email text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_started timestamptz := now();
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'start_impersonation_session: caller binding inválido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;

  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'start_impersonation_session: solo un superadmin de plataforma real puede iniciar una impersonación' using errcode = '42501';
  end if;

  if char_length(v_reason) < 20 then
    raise exception 'start_impersonation_session: motivo obligatorio (mínimo 20 caracteres)' using errcode = '22023';
  end if;

  if not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'start_impersonation_session: la organización % no existe', p_organization_id using errcode = 'P0002';
  end if;

  -- "Nunca impersonar a otro superadmin" -- ver comentario de cabecera de
  -- esta migración para el razonamiento completo de por qué esto se traduce
  -- a nivel de organización.
  if exists (
    select 1
    from core.membership m
    join core.platform_superadmin ps on ps.staff_user_id = m.user_id
    where m.organization_id = p_organization_id
  ) then
    raise exception 'start_impersonation_session: no se puede impersonar una organización que tiene a otro superadmin de plataforma como miembro' using errcode = '42501';
  end if;

  if exists (
    select 1
    from core.impersonation_session s
    where s.actor_user_id = p_caller_id
      and s.expires_at > v_started
      and not exists (
        select 1 from core.impersonation_audit_log a
        where a.session_id = s.id and a.event_type = 'end'
      )
  ) then
    raise exception 'start_impersonation_session: ya existe una sesión de impersonación activa para este superadmin -- termínala antes de abrir otra' using errcode = '55006';
  end if;

  select s.email into v_email from core.staff_user s where s.id = p_caller_id;

  insert into core.impersonation_session (actor_user_id, actor_email, organization_id, reason, started_at, expires_at)
  values (p_caller_id, v_email, p_organization_id, v_reason, v_started, v_started + interval '15 minutes')
  returning * into v_session;

  insert into core.impersonation_audit_log (session_id, event_type, actor_user_id, actor_email, organization_id, reason, detail, occurred_at)
  values (v_session.id, 'start', p_caller_id, v_email, p_organization_id, v_reason, jsonb_build_object('expiresAt', v_session.expires_at), v_started);

  return v_session;
end;
$$;
revoke all on function core.start_impersonation_session(uuid, uuid, text) from public;
grant execute on function core.start_impersonation_session(uuid, uuid, text) to authenticated;

create or replace function core.end_impersonation_session(
  p_caller_id uuid,
  p_session_id uuid
)
returns core.impersonation_audit_log
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_session core.impersonation_session;
  v_entry core.impersonation_audit_log;
  v_now timestamptz := now();
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'end_impersonation_session: caller binding inválido (auth.uid() no coincide con p_caller_id)' using errcode = '42501';
  end if;

  select * into v_session from core.impersonation_session where id = p_session_id;
  if v_session.id is null then
    raise exception 'end_impersonation_session: la sesión % no existe', p_session_id using errcode = 'P0002';
  end if;

  if v_session.actor_user_id <> p_caller_id then
    raise exception 'end_impersonation_session: solo el superadmin que abrió la sesión puede terminarla' using errcode = '42501';
  end if;

  if exists (select 1 from core.impersonation_audit_log a where a.session_id = p_session_id and a.event_type = 'end') then
    raise exception 'end_impersonation_session: la sesión % ya fue terminada', p_session_id using errcode = '55006';
  end if;

  if v_session.expires_at <= v_now then
    raise exception 'end_impersonation_session: la sesión % ya expiró -- no requiere cierre explícito', p_session_id using errcode = '55006';
  end if;

  insert into core.impersonation_audit_log (session_id, event_type, actor_user_id, actor_email, organization_id, reason, detail, occurred_at)
  values (p_session_id, 'end', p_caller_id, v_session.actor_email, v_session.organization_id, null, '{}'::jsonb, v_now)
  returning * into v_entry;

  return v_entry;
end;
$$;
revoke all on function core.end_impersonation_session(uuid, uuid) from public;
grant execute on function core.end_impersonation_session(uuid, uuid) to authenticated;

-- Lectura caller-bound: "¿tengo YO una sesión activa ahora mismo?" -- la
-- fuente de verdad real para el banner permanente de la UI (nunca solo la
-- cookie de `packages/core-authz/src/impersonation/cookie.ts`, que sigue
-- siendo TTL de aplicación -- esta función es la verificación en SQL que
-- exige la tarea).
create or replace function core.get_active_impersonation_session_for_superadmin(p_caller_id uuid)
returns core.impersonation_session
language sql stable security definer set search_path = core, pg_temp
as $$
  select s.*
  from core.impersonation_session s
  where auth.uid() is not null and auth.uid() = p_caller_id
    and s.actor_user_id = p_caller_id
    and s.expires_at > now()
    and not exists (select 1 from core.impersonation_audit_log a where a.session_id = s.id and a.event_type = 'end')
  order by s.started_at desc
  limit 1;
$$;
revoke all on function core.get_active_impersonation_session_for_superadmin(uuid) from public;
grant execute on function core.get_active_impersonation_session_for_superadmin(uuid) to authenticated;

-- Building block genérico reusable por CUALQUIER ruta futura (de esta tarea o
-- de una siguiente) que necesite, antes de servir una escritura, preguntar
-- "¿este caller está impersonando ESTA organización ahora mismo?" -- la
-- verificación real en SQL detrás del write-guard de
-- `packages/core-authz/src/impersonation/write-guard.ts`.
create or replace function core.is_impersonation_active_for_caller_and_org(p_caller_id uuid, p_organization_id uuid)
returns boolean
language sql stable security definer set search_path = core, pg_temp
as $$
  select exists (
    select 1
    from core.impersonation_session s
    where auth.uid() is not null and auth.uid() = p_caller_id
      and s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.expires_at > now()
      and not exists (select 1 from core.impersonation_audit_log a where a.session_id = s.id and a.event_type = 'end')
  );
$$;
revoke all on function core.is_impersonation_active_for_caller_and_org(uuid, uuid) from public;
grant execute on function core.is_impersonation_active_for_caller_and_org(uuid, uuid) to authenticated;

-- Bitácora completa (oversight de plataforma) -- ambas funciones exigen ser
-- superadmin además del caller-binding (a diferencia de "mi sesión activa"
-- arriba, que solo exige ser YO): ver policy de RLS equivalente arriba, esto
-- es la misma regla aplicada dos veces (defensa en profundidad, igual
-- criterio que el resto del back office de plataforma).
create or replace function core.list_impersonation_sessions_for_superadmin(p_caller_id uuid, p_limit int default 100)
returns setof core.impersonation_session
language sql stable security definer set search_path = core, pg_temp
as $$
  select s.*
  from core.impersonation_session s
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by s.started_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function core.list_impersonation_sessions_for_superadmin(uuid, int) from public;
grant execute on function core.list_impersonation_sessions_for_superadmin(uuid, int) to authenticated;

create or replace function core.list_impersonation_audit_log_for_superadmin(p_caller_id uuid, p_limit int default 200)
returns setof core.impersonation_audit_log
language sql stable security definer set search_path = core, pg_temp
as $$
  select a.*
  from core.impersonation_audit_log a
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by a.occurred_at desc
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function core.list_impersonation_audit_log_for_superadmin(uuid, int) from public;
grant execute on function core.list_impersonation_audit_log_for_superadmin(uuid, int) to authenticated;
