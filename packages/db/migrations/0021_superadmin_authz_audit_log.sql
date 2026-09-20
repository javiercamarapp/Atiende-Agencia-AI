-- Sink de auditoría PERSISTENTE para `requireAdminAccess` (audit-on-denial) --
-- pendiente declarado explícitamente en el PR #162 (huecos conocidos): hoy
-- `superadminAdminAccessAudit` (apps/api/src/routes/superadmin.ts) es un
-- `InMemoryAuditSink` -- se pierde en cada reinicio/redeploy, y en serverless
-- cada instancia lambda tiene el suyo, así que la bitácora de intentos
-- DENEGADOS de acceso al back office de plataforma no existe de verdad en
-- producción. Esta migración cierra ese hueco con una tabla real.
--
-- PATRÓN COPIADO, no inventado -- misma estructura append-only que
-- `core.impersonation_audit_log` (0020_superadmin_impersonacion.sql) y
-- `rentas.audit_log` (packages/domain-rentas/migrations/021_rentas_audit_log.sql,
-- el más cercano de los dos: bitácora simple sin hash-chain, que es lo que
-- corresponde aquí -- un log de denegaciones de acceso, no un mecanismo de
-- "romper cristal"/impersonación con requisito de compliance tamper-evident):
-- tabla mínima, RLS de solo-lectura para superadmin, deny-by-default de
-- INSERT/UPDATE/DELETE a nivel de GRANT (sin policy de escritura para
-- `authenticated` ni `service_role`), triggers que bloquean UPDATE/DELETE
-- incondicionalmente como defensa en profundidad, y una ÚNICA función
-- `security definer` (search_path fijo, revoke de public) como vía de
-- escritura.
--
-- DIFERENCIA DELIBERADA frente a los dos patrones copiados (ambos caller-bound,
-- `auth.uid() = p_caller_id`): la función de escritura de aquí es de SOLO
-- SISTEMA (`auth.uid() is null`) -- mismo criterio ya establecido en este repo
-- para funciones sensibles invocadas sin sesión de usuario real (ver
-- `core._desatascar_outbox_colgados`/`core.desatascar_outbox_colgados_for_system`,
-- 0016_superadmin_acciones.sql, y el análisis largo de
-- 0015_core_rls_sesion_sistema.sql, camino B: "función security definer
-- acotada, con guard explícito de solo-sistema"). Tiene sentido aquí porque
-- `requireAdminAccess` corre DENTRO de `admin-middleware.ts`, genérico y sin
-- ningún concepto de sesión de negocio -- el actor denegado puede no tener
-- ninguna fila de membership resoluble, e incluso cuando SÍ hay un
-- `userId` real, éste viaja como PARÁMETRO (`p_actor_user_id`), nunca como
-- `auth.uid()` del caller (que aquí siempre es la sesión de SISTEMA que
-- escribe, no el actor auditado -- ver apps/api/src/production/deps.ts,
-- `PersistentAuthzAuditSink`, que abre su PROPIA `engine.withAppSession({
-- userId: null }, ...)` por escritura, nunca la transacción de negocio del
-- request denegado -- de ahí que un simple try/catch alrededor de TODA la
-- llamada baste como compatibilidad-sin-migrar: al ser una transacción propia
-- y aislada, ningún SAVEPOINT es necesario, no hay una transacción compartida
-- que un 42883/42P01/42703 pueda dejar abortada para nadie más).
--
-- TOPE DEFENSIVO (mandato explícito de la tarea -- "agrega un tope defensivo
-- para que una ráfaga de denegaciones no llene la tabla"): el rate-limiter de
-- `requireAdminAccess` (30 intentos/5min POR actor+ruta, ver superadmin.ts) ya
-- acota el volumen de un solo actor insistiendo contra una sola ruta, pero NO
-- protege contra muchos actores/rutas DISTINTOS denegados en paralelo. La
-- función de escritura de abajo cuenta cuántas filas caen dentro de la
-- ventana móvil de `AUTHZ_AUDIT_LOG_WINDOW_MINUTES` minutos (barato: un solo
-- `count(*)` con el índice de `occurred_at` de abajo, nunca un scan completo
-- de la tabla histórica) y, si ya se alcanzó `AUTHZ_AUDIT_LOG_MAX_PER_WINDOW`,
-- DESCARTA el INSERT en silencio (devuelve `null`, nunca lanza) -- mismo
-- criterio "best-effort real, nunca bloquea al caller" que el resto de este
-- mecanismo.
--
-- Requiere: 0001_core_schema.sql (core.staff_user, core.organization),
-- 0012_caller_binding_fase2.sql (core.is_platform_superadmin).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) core.authz_audit_log -- una fila = un intento de acceso a /superadmin/*
--    evaluado por `requireAdminAccess` (hoy solo se llama en la rama
--    DENEGADA, ver admin-middleware.ts -- `decision` queda como columna
--    genérica, fiel al tipo `AuthzAuditEntry` de core-authz, por si un
--    llamador futuro decide auditar también el camino feliz). INSERT-ONLY.
--
--    `actor_user_id`/`organization_id` nullable a propósito (a diferencia de
--    `core.impersonation_session`/`rentas.audit_log`, donde el actor SIEMPRE
--    existe): un intento denegado contra /superadmin/* puede venir de un
--    staff autenticado SIN ninguna membership de organización (`platformRole`
--    sintético `undefined`, ver superadmin.ts) -- `actor_user_id` sigue
--    presente en ese caso (siempre hay un JWT válido, `authMiddleware` ya
--    corrió), pero `organization_id` genuinamente no aplica.
--
--    `on delete restrict` (nunca `cascade`/`set null`) en `actor_user_id`/
--    `organization_id` -- mismo criterio que `core.impersonation_session`/
--    `rentas.audit_log`: es una tabla de auditoría/compliance, borrar un
--    `staff_user`/`organization` con historial de denegaciones perdería en
--    silencio el rastro de "quién intentó qué y cuándo".
-- ═══════════════════════════════════════════════════════════════════════════
create table core.authz_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references core.staff_user(id) on delete restrict,
  -- IP ya normalizada por el middleware existente (ver apps/api/src/
  -- http-security.ts::requestActor -- último salto de X-Forwarded-For, nunca
  -- el primero, que el cliente puede fabricar libremente) -- NUNCA una
  -- cabecera cruda ni un token. Nullable: un actor sin ninguna IP resoluble
  -- (tests, entornos sin proxy) no debe impedir el registro del intento.
  actor_ip text check (actor_ip is null or char_length(actor_ip) <= 64),
  organization_id uuid references core.organization(id) on delete restrict,
  -- "recurso:verbo" -- mismo formato que `AuthzAuditEntry.action` de
  -- core-authz/audit.ts (hoy siempre 'admin:access').
  action text not null check (char_length(btrim(action)) between 1 and 100),
  route text not null check (char_length(route) between 1 and 300),
  method text not null check (char_length(method) between 1 and 10),
  decision text not null check (decision in ('allowed', 'denied')),
  -- Solo presente cuando `decision = 'denied'` -- mismo catálogo CERRADO que
  -- `DenialReason` (core-authz/audit.ts), reforzado aquí como defensa en
  -- profundidad (no la única barrera: la función de escritura de abajo
  -- también lo valida antes del INSERT).
  reason text check (reason is null or reason in ('insufficient_role', 'route_not_mapped', 'rate_limited', 'no_membership')),
  -- Espejo acotado de `AuthzAuditEntry.metadata` (hoy `{ platformRole,
  -- allowedRoles }`, sin PII -- nunca `userAgent`/headers crudos). Tope de
  -- tamaño defensivo (nunca un jsonb sin límite): un `metadata` inesperado no
  -- debe poder inflar una fila de auditoría sin cota.
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 4000),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Patrón de acceso principal: "más reciente primero", paginado -- mismo
-- criterio que `impersonation_audit_log_org_seq_idx`/`rentas_audit_log_org_created_idx`.
create index authz_audit_log_occurred_idx on core.authz_audit_log (occurred_at desc);
-- Soporta el `count(*)` de la ventana móvil del tope defensivo (ver función de
-- escritura, abajo) sin escanear filas fuera de la ventana.
create index authz_audit_log_occurred_recent_idx on core.authz_audit_log (occurred_at);

alter table core.authz_audit_log enable row level security;

-- Lectura: cualquier superadmin de plataforma VIGENTE ve TODA la bitácora
-- (oversight real de plataforma, mismo criterio que
-- `core.impersonation_audit_log`/`core.impersonation_session`). Escritura:
-- NINGUNA policy de INSERT/UPDATE/DELETE para `authenticated` ni
-- `service_role` -- la única escritora es la función `security definer` de
-- abajo, que corre como el DUEÑO de la tabla (no sujeta a RLS por default,
-- sin `force row level security`).
create policy "authz_audit_log: cualquier superadmin vigente lee toda la bitacora" on core.authz_audit_log for select
  using (core.is_platform_superadmin(auth.uid()));

-- Fail-closed real a nivel de GRANT (no solo de policy) -- mismo criterio que
-- `core.impersonation_session`/`core.impersonation_audit_log` (corrección de
-- revisión de ese PR): `service_role` recibe SOLO SELECT, nunca INSERT --
-- `security definer` corre como el DUEÑO de la tabla, ningún GRANT de INSERT
-- sobre la tabla es necesario para que la función de abajo siga escribiendo,
-- y un GRANT de INSERT a `service_role` (que tiene `bypassrls`) sería una vía
-- de escritura DIRECTA con actor arbitrario que ningún caller real usa hoy.
revoke all on core.authz_audit_log from public, anon, authenticated, service_role;
grant select on core.authz_audit_log to authenticated, service_role;

create or replace function core.authz_audit_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'authz_audit_log_append_only: % no está permitido sobre core.authz_audit_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger authz_audit_log_block_update_trg
  before update on core.authz_audit_log
  for each row execute function core.authz_audit_log_block_mutation();
create trigger authz_audit_log_block_delete_trg
  before delete on core.authz_audit_log
  for each row execute function core.authz_audit_log_block_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) core.record_authz_audit_denial -- ÚNICA vía de escritura. Función de
--    SOLO SISTEMA (ver cabecera de esta migración para el porqué): rechaza
--    cualquier llamada con `auth.uid()` no nulo, nunca ata el actor a
--    `auth.uid()` (llega como parámetro -- es un dato a REGISTRAR, no la
--    identidad de quien escribe).
--
--    `security definer` con `search_path` fijo y `revoke` de `public` -- solo
--    `authenticated` puede ejecutarla (mismo rol bajo el que corre TODA
--    sesión de este monorepo, sistema incluida, ver `managed-postgres-
--    engine.ts::withAppSession`: siempre `set local role authenticated`).
--
--    Trunca DEFENSIVAMENTE cada campo de texto libre antes del INSERT (`left`
--    nunca falla sobre NULL) -- mismo criterio que `rentas.record_audit_log`
--    (021_rentas_audit_log.sql): esta función es la ÚNICA vía de escritura,
--    así que es el único lugar donde puede garantizarse, para todo caller
--    presente y futuro, que los CHECK de longitud de la tabla nunca se violan
--    por un valor de aplicación inesperadamente largo.
--
--    NUNCA lanza por "tabla llena de ráfaga" -- ver tope defensivo en la
--    cabecera de esta migración: descarta en silencio devolviendo `null`.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.record_authz_audit_denial(
  p_actor_user_id uuid,
  p_actor_ip text,
  p_organization_id uuid,
  p_action text,
  p_route text,
  p_method text,
  p_decision text,
  p_reason text,
  p_metadata jsonb,
  p_occurred_at timestamptz
)
returns uuid
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_id uuid;
  v_recent_count bigint;
  -- Ventana móvil + tope del punto "Tope defensivo" de la cabecera de esta
  -- migración -- ~500 filas/minuto sostenidas en el peor caso, muy por
  -- encima de cualquier ráfaga real (el rate-limiter de `requireAdminAccess`
  -- ya acota a 30/5min POR actor+ruta), pero con un techo duro para que
  -- ningún volumen de actores/rutas distintos en paralelo pueda llenar la
  -- tabla sin límite.
  c_window_minutes constant int := 10;
  c_max_per_window constant bigint := 5000;
begin
  if auth.uid() is not null then
    raise exception 'record_authz_audit_denial: solo puede invocarse desde una sesión de sistema (auth.uid() debe ser NULL)' using errcode = '28000';
  end if;

  if p_decision is null or p_decision not in ('allowed', 'denied') then
    raise exception 'record_authz_audit_denial: decision invalida (esperaba allowed|denied)' using errcode = '22023';
  end if;
  if p_reason is not null and p_reason not in ('insufficient_role', 'route_not_mapped', 'rate_limited', 'no_membership') then
    raise exception 'record_authz_audit_denial: reason invalido' using errcode = '22023';
  end if;

  select count(*) into v_recent_count
  from core.authz_audit_log
  where occurred_at > now() - make_interval(mins => c_window_minutes);
  if v_recent_count >= c_max_per_window then
    return null;
  end if;

  insert into core.authz_audit_log (
    actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, metadata, occurred_at
  )
  values (
    p_actor_user_id,
    left(p_actor_ip, 64),
    p_organization_id,
    left(coalesce(p_action, ''), 100),
    left(coalesce(p_route, ''), 300),
    left(coalesce(p_method, ''), 10),
    p_decision,
    p_reason,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_occurred_at, now())
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function core.record_authz_audit_denial(uuid, text, uuid, text, text, text, text, text, jsonb, timestamptz) from public;
grant execute on function core.record_authz_audit_denial(uuid, text, uuid, text, text, text, text, text, jsonb, timestamptz) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) core.list_authz_audit_log_for_superadmin -- lectura paginada, caller-bound
--    (`auth.uid() = p_caller_id`, delega en `core.platform_superadmin` vía
--    `core.is_platform_superadmin`, nunca reimplementada) -- mismo criterio
--    que `core.list_impersonation_audit_log_for_superadmin`
--    (0020_superadmin_impersonacion.sql), con `p_offset` agregado (esa
--    función solo pagina por `limit`; el panel de auditoría de denegaciones
--    sí necesita "cargar más" real).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_authz_audit_log_for_superadmin(
  p_caller_id uuid,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  actor_user_id uuid,
  actor_ip text,
  organization_id uuid,
  action text,
  route text,
  method text,
  decision text,
  reason text,
  metadata jsonb,
  occurred_at timestamptz,
  created_at timestamptz
)
language sql stable security definer set search_path = core, pg_temp
as $$
  select a.id, a.actor_user_id, a.actor_ip, a.organization_id, a.action, a.route, a.method, a.decision, a.reason, a.metadata, a.occurred_at, a.created_at
  from core.authz_audit_log a
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by a.occurred_at desc, a.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function core.list_authz_audit_log_for_superadmin(uuid, int, int) from public;
grant execute on function core.list_authz_audit_log_for_superadmin(uuid, int, int) to authenticated;
