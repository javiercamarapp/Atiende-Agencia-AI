-- Fase 3 — Matching/Scoring y Go/No-Go, pieza 1: extiende `licitaciones.tender`
-- con los campos que el motor de matching necesita (fuente, clasificador,
-- presupuesto, entidad convocante, cobertura geográfica), agrega el estado del
-- ciclo de vida de la convocatoria, y crea el perfil de matching de la
-- organización. Requiere: 001_licitaciones_schema.sql..006_technical_proposal.sql.
--
-- Contexto (ver diseño Fase 3 §0/§1): B-02 (ComprasMX/OCDS-SHCP/PDN-S6/
-- portales estatales bloqueados por reCAPTCHA/bot-detection) sigue ABIERTO —
-- ver docs/BLOQUEOS.md fila B-02, INC-18 (2026-09-10). No hay conector real
-- verificado, así que NINGUNA convocatoria de esta fase se descubre sola:
-- `source` es SIEMPRE 'manual' mientras B-02 no lo resuelva un acceso
-- autorizado. Antes de esta migración no existía NINGÚN camino de escritura
-- productivo para `licitaciones.tender` (solo `seedTender` en el repositorio
-- de pruebas) — el endpoint de alta manual que consume estas columnas es el
-- primer escritor real del vertical.

alter table licitaciones.tender
  add column source text not null default 'manual',
  add column external_id text,
  add column contracting_body text,
  add column cpv_codes text[] not null default '{}',
  add column budget_amount numeric,
  add column currency text not null default 'MXN',
  add column state text,
  add column procedure_type_raw text,
  add column status text not null default 'discovered'
    check (status in ('discovered', 'in_review', 'go', 'no_go', 'in_progress', 'submitted', 'won', 'lost', 'cancelled')),
  -- Trazabilidad de quién dio de alta/actualizó la convocatoria a mano —
  -- nunca `null` como haría una ingesta de sistema, porque en esta fase
  -- siempre hay una persona detrás (mismo criterio que `tender_audit_log`
  -- más abajo). Nullable solo porque las convocatorias ya existentes de
  -- Fase 1/2 (creadas por `seedTender` en pruebas, antes de que existiera un
  -- endpoint de alta) no tienen un actor real que atribuirles.
  add column created_by uuid references core.staff_user(id) on delete set null;

-- Clave natural de deduplicación (REQ-004 del origen, adaptado a
-- tenancy-por-organización): reingestar la misma convocatoria (mismo
-- `external_id` que el staff capturó a mano) actualiza en vez de duplicar.
-- Parcial: una organización puede dar de alta cuantas convocatorias quiera
-- sin `external_id` (el llamador es responsable de no duplicar a mano en ese
-- caso, ver diseño §6) sin que la ausencia de esa clave choque entre sí.
create unique index tender_org_source_external_idx
  on licitaciones.tender (organization_id, source, external_id)
  where external_id is not null;

-- Auditoría del alta/actualización manual (§6 del diseño): a diferencia de
-- `core-authz::AuditSink` (auditoría de DECISIONES de autorización,
-- permitido/denegado) esto audita una ACCIÓN de negocio ya autorizada —
-- ningún mecanismo genérico equivalente existe todavía en el monorepo (se
-- buscó explícitamente: `core-authz/src/audit.ts` es de otro alcance,
-- ninguna otra vertical tiene una tabla `*_audit_log` de negocio reutilizable
-- hoy). Tabla mínima, scoped a este dominio -- no se inventa un mecanismo
-- transversal que ninguna otra vertical necesita todavía.
create table licitaciones.tender_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  action text not null check (action in ('tender.manual_upsert.created', 'tender.manual_upsert.updated')),
  actor_id uuid not null references core.staff_user(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index tender_audit_log_tender_idx on licitaciones.tender_audit_log (organization_id, tender_id, created_at desc);

-- Perfil de matching de la organización (§5 del diseño): tabla propia y
-- autocontenida -- se verificó que `CompanyCapability`/`getCapabilities()`
-- (domain-licitaciones/src/company-data.ts) sigue siendo un stub `[]` sin
-- ningún `insert`/`select` real en `postgres-repository.ts`, así que derivar
-- `keywords` de ahí (como hace el origen) habría dependido de una feature que
-- Fase 1/2 nunca construyó. Singleton por organización, mismo criterio de
-- tenancy que el resto del vertical (§2.1: "una organización de licitaciones
-- opera como una sola Property implícita"). Todos los campos de criterio son
-- opcionales por diseño del motor (matching-engine.ts): una organización que
-- aún no configuró nada obtiene `eligibility.status = 'no_evaluable'` en
-- todo, nunca un falso "cumple".
create table licitaciones.matching_profile (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  keywords text[] not null default '{}',
  excluded_keywords text[] not null default '{}',
  classifier_codes text[] not null default '{}',
  entities text[] not null default '{}',
  states text[] not null default '{}',
  budget_min numeric,
  budget_max numeric,
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table licitaciones.tender_audit_log enable row level security;
alter table licitaciones.matching_profile enable row level security;

-- Lectura: cualquier miembro de la organización (mismo patrón que el resto
-- del vertical, ver 002_compliance_and_package.sql).
create policy "org ve su bitacora de alta de convocatorias" on licitaciones.tender_audit_log for select using (licitaciones.can_access_org(organization_id));
create policy "org ve su perfil de matching" on licitaciones.matching_profile for select using (licitaciones.can_access_org(organization_id));

-- Escritura: configurar criterios de búsqueda es captura de datos, no una
-- decisión de riesgo -- mismo criterio que el resto de WRITE_ROLES en
-- Fase 1/2 (nunca DECISION_ROLES para esto). La bitácora de auditoría la
-- escribe únicamente la capa de aplicación (el propio repositorio, nunca un
-- cliente directo) -- WRITE_ROLES aquí es defensa en profundidad, igual que
-- `section_author`/`approval_change` en 004_granular_approvals.sql.
create policy "escritura: roles de escritura registran alta de convocatorias" on licitaciones.tender_audit_log for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura configuran su perfil de matching" on licitaciones.matching_profile for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan su perfil de matching" on licitaciones.matching_profile for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.tender_audit_log, licitaciones.matching_profile from public, anon;
grant select on licitaciones.tender_audit_log, licitaciones.matching_profile to authenticated;
grant insert on licitaciones.tender_audit_log to authenticated;
grant insert, update on licitaciones.matching_profile to authenticated;
grant select, insert, update, delete on licitaciones.tender_audit_log, licitaciones.matching_profile to service_role;
