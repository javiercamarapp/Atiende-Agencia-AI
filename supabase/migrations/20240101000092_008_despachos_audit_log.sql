-- Corrige una REGRESIÓN real introducida por la propia Ronda 12: `cierre-mensual.ts`
-- (`completar-tarea`/`cerrar-periodo`) y `migracion-catalogo.ts`
-- (`aprobar`/`rechazar`/`editar`) ya llaman a `deps.despachosAuditSink.record(...)`,
-- pero en producción ese puerto seguía siendo `notProductionReady<AuditSink>`
-- (`apps/api/src/production/deps.ts`) -- CUALQUIER llamada real a esos 5 endpoints
-- lanzaba DESPUÉS de que la escritura de negocio (completar tarea / cerrar un
-- período fiscal, irreversible / aprobar-rechazar-editar un mapeo contable) YA había
-- hecho su INSERT/UPDATE dentro de la MISMA transacción de request. Como Hono
-- captura el error del handler en su propio dispatch y `ManagedPostgresEngine.
-- withAppSession` ya había hecho `commit;` antes de que el 500 llegara al cliente,
-- el cambio de negocio quedaba persistido mientras la UI mostraba error -- el peor
-- caso posible para "cerrar un período fiscal".
--
-- Se aparta deliberadamente del comentario de cierre de
-- `001_despachos_schema.sql` ("Auditoría: NO se crea una tabla propia de
-- despachos -- se reutiliza @atiende/core-authz::AuditSink... una implementación
-- real es responsabilidad de core-authz/packages/db, no de este paquete"): el
-- `AppDeps` real de esta app YA modela cada auditoría de vertical como su PROPIO
-- slot tipado (`despachosAuditSink` aquí, `hotelesFraudeAuditSink` para fraude de
-- hoteles -- cada uno con su propio ciclo de vida/decisión de adaptador, ver
-- `apps/api/src/deps.ts`), y hoy no hay un segundo consumidor cross-vertical de
-- `AuditSink` que justifique construir ya una tabla compartida en `core` --
-- inventar esa infraestructura genérica sin un segundo caller real sería el mismo
-- tipo de sobre-ingeniería que este monorepo evita en otras fases. `despachos.
-- audit_log` es, por eso, el adaptador MÍNIMO concreto que el gap de esta fase
-- pide -- `hotelesFraudeAuditSink` queda deliberadamente FUERA de esta migración
-- (gap propio, no pedido aquí -- sigue `notProductionReady` en
-- `apps/api/src/production/not-ready.ts`).
--
-- Tabla mínima: guarda lo que el propio dominio necesita indexar/filtrar
-- (organización/actor/acción/cuándo) y el resto de `AuthzAuditEntry`
-- (route/method/decision/reason/ip/userAgent/actorEmail/metadata, ver
-- packages/core-authz/src/audit.ts) tal cual en `payload` -- ninguna información
-- del entry se pierde, solo se elige qué se puede indexar por columna propia.
--
-- Insert desde la SESIÓN DE SISTEMA (`ManagedPostgresEngine.withAppSession({userId:
-- null}, ...)`, mismo patrón que `ProductionCoreRepository` en
-- `apps/api/src/production/core-repository.ts`): bajo esa sesión `auth.uid()` es
-- NULL (`request.jwt.claim.sub` se fija a `''`), así que una policy de INSERT
-- normal (`with check (... = auth.uid())`) rechazaría SIEMPRE la escritura. Mismo
-- problema, mismo remedio EXACTO que `core.accept_staff_invite`/
-- `core.revoke_refresh_token` (`packages/db/migrations/0002_staff_invite_schema.sql`/
-- `0003_refresh_token_revocation.sql`): una función `security definer` que inserta
-- bypassing RLS, sin exponer ninguna policy de INSERT directa a `authenticated`.
create table despachos.audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  actor_user_id uuid references core.staff_user(id) on delete set null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index despachos_audit_log_org_created_idx on despachos.audit_log (organization_id, created_at desc);

alter table despachos.audit_log enable row level security;

-- Lectura: cualquier staff con membership de la organización -- mismo criterio que
-- `despachos.tenant_profile` (001_despachos_schema.sql): la bitácora de acciones
-- fiscales de un despacho es información que cualquier miembro de ESE despacho
-- puede consultar, no solo owner/admin. Ninguna ruta HTTP la expone todavía; la
-- policy queda lista para cuando exista un endpoint/panel de auditoría real.
create policy "staff ve la bitacora de auditoria de su organizacion" on despachos.audit_log for select
  using (exists (select 1 from core.membership m where m.organization_id = audit_log.organization_id and m.user_id = auth.uid()));

-- Escritura: SOLO vía la función `security definer` de abajo -- deliberadamente sin
-- policy de INSERT para `authenticated` (deny-by-default real, mismo criterio que
-- `core.revoked_refresh_token`): ni siquiera un bug futuro que reutilice la sesión
-- por-request en vez de la de sistema podría escribir aquí sin pasar por la función.
revoke all on despachos.audit_log from public, anon, authenticated;
grant select on despachos.audit_log to authenticated;
grant select, insert, update, delete on despachos.audit_log to service_role;

create or replace function despachos.record_audit_log(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_payload jsonb
)
returns uuid
language sql
security definer
set search_path = despachos, pg_temp
as $$
  insert into despachos.audit_log (organization_id, actor_user_id, action, payload)
  values (p_organization_id, p_actor_user_id, p_action, coalesce(p_payload, '{}'::jsonb))
  returning id;
$$;

revoke all on function despachos.record_audit_log(uuid, uuid, text, jsonb) from public;
-- Mismo rol que TODO el resto de este archivo corre bajo
-- `ManagedPostgresEngine.withAppSession` (siempre `set local role authenticated`,
-- con o sin `auth.uid()` real) -- nunca `anon`, este monorepo no usa ese rol.
grant execute on function despachos.record_audit_log(uuid, uuid, text, jsonb) to authenticated;
