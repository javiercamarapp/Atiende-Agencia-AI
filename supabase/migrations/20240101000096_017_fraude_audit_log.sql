-- Hallazgo de auditoría (OBSERVABILIDAD): `hotelesFraudeAuditSink` seguía
-- `notProductionReady<AuditSink>` en `apps/api/src/production/deps.ts` -- CUALQUIER
-- llamada real a `POST .../fraude/escaneos` (cuando detecta un hallazgo NUEVO) o a
-- `POST .../fraude/alertas/:id/{confirmar,descartar}` (ver
-- `apps/api/src/routes/verticals/hoteles/fraude.ts`) ya llama a
-- `deps.hotelesFraudeAuditSink.record(...)` DESPUÉS de que la escritura de negocio
-- (`recordFraudAlert`/`resolveFraudAlert`) YA hizo su INSERT/UPDATE en la misma
-- transacción de request -- mientras el puerto siguiera lanzando siempre, esa
-- llamada tumbaba el request con un 500 sobre un cambio que ya había quedado
-- persistido (MISMA regresión, mismo patrón, que `despachos.audit_log`
-- -- ver `packages/domain-despachos/migrations/008_despachos_audit_log.sql`, cuyo
-- propio comentario de cabecera dejaba a `hotelesFraudeAuditSink` explícitamente
-- FUERA de esa migración como "gap propio de hoteles, no pedido en esa fase").
--
-- Esta migración cierra ese gap propio con el MISMO patrón exacto que
-- `despachos.audit_log`/`despachos.record_audit_log()` (que a su vez sigue el de
-- `core.accept_staff_invite`, `packages/db/migrations/0002_staff_invite_schema.sql`):
--
--   1. Tabla mínima `hoteles.fraude_audit_log` -- indexa lo que el propio dominio
--      necesita filtrar (property/actor/acción/cuándo) y guarda el resto de
--      `AuthzAuditEntry` (route/method/decision/reason/ip/userAgent/actorEmail/
--      metadata, ver packages/core-authz/src/audit.ts) tal cual en `payload`, sin
--      perder ninguna información del entry.
--
--      Por PROPERTY (no organización) a diferencia de `despachos.audit_log`
--      (organization-scoped): ambos escaneos de fraude (`detectDiscountOutsidePolicy`/
--      `detectFolioReopenedAfterAudit`) y sus resoluciones son siempre acciones
--      atadas a UNA property concreta (`hoteles.fraude.ts` exige
--      `requirePropertyMembership("propertyId")` en las 4 rutas) -- mismo eje de
--      partición que el resto del esquema de fraude (`hoteles.fraud_alert`,
--      migración 007).
--
--   2. Escritura SOLO vía función `security definer` (`hoteles.record_fraude_audit_log`)
--      -- sin policy de INSERT para `authenticated` (deny-by-default real): el
--      caller real (`ProductionHotelesFraudeAuditSink`, ver
--      `apps/api/src/production/hoteles-fraude-audit-sink.ts`) escribe desde la
--      sesión de SISTEMA (`ManagedPostgresEngine.withAppSession({userId: null},
--      ...)`, mismo patrón que `ProductionDespachosAuditSink`), donde `auth.uid()`
--      es NULL -- una policy de INSERT normal (`with check (... = auth.uid())`)
--      rechazaría SIEMPRE esa escritura, así que la función bypassa RLS con el
--      privilegio de su DUEÑO en vez de requerir `service_role` (que este monorepo
--      no aprovisiona, ver el mismo gap ya documentado en
--      `packages/domain-rentas/src/onboarding/repository.ts`).
--
--   3. Lectura: cualquier staff con acceso real a la property (mismo criterio que
--      `hoteles.fraud_alert` -- la bitácora de auditoría de fraude de una property
--      es información que cualquier miembro de ESA property puede consultar, no
--      solo quien resolvió cada alerta). Ninguna ruta HTTP la expone todavía; la
--      policy queda lista para un futuro panel de auditoría, mismo criterio que
--      `despachos.audit_log`.
create table hoteles.fraude_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  actor_user_id uuid references core.staff_user(id) on delete set null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index fraude_audit_log_property_created_idx on hoteles.fraude_audit_log (property_id, created_at desc);

alter table hoteles.fraude_audit_log enable row level security;

create policy "staff ve la bitacora de auditoria de fraude de su property" on hoteles.fraude_audit_log for select
  using (core.has_property_access(auth.uid(), property_id));

-- Deliberadamente sin policy de INSERT para `authenticated` -- ver punto 2 de
-- arriba (deny-by-default real, mismo criterio que `core.revoked_refresh_token`/
-- `despachos.audit_log`): ni siquiera un bug futuro que reutilice la sesión
-- por-request en vez de la de sistema podría escribir aquí sin pasar por la
-- función `security definer` de abajo.
revoke all on hoteles.fraude_audit_log from public, anon, authenticated;
grant select on hoteles.fraude_audit_log to authenticated;
grant select, insert, update, delete on hoteles.fraude_audit_log to service_role;

create or replace function hoteles.record_fraude_audit_log(
  p_organization_id uuid,
  p_property_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_payload jsonb
)
returns uuid
language sql
security definer
set search_path = hoteles, pg_temp
as $$
  insert into hoteles.fraude_audit_log (organization_id, property_id, actor_user_id, action, payload)
  values (p_organization_id, p_property_id, p_actor_user_id, p_action, coalesce(p_payload, '{}'::jsonb))
  returning id;
$$;

revoke all on function hoteles.record_fraude_audit_log(uuid, uuid, uuid, text, jsonb) from public;
-- Mismo rol bajo el que corre TODO este archivo vía `ManagedPostgresEngine.
-- withAppSession` (siempre `set local role authenticated`, con o sin `auth.uid()`
-- real) -- nunca `anon`, este monorepo no usa ese rol.
grant execute on function hoteles.record_fraude_audit_log(uuid, uuid, uuid, text, jsonb) to authenticated;
