-- Fase 2 pieza 1 (AE-02/AE-11) — máquina de aprobaciones granular. Sustituye
-- `licitaciones.expediente_approval` (002_compliance_and_package.sql), que su
-- propio comentario de cabecera ya documentaba como limitación conocida: "la
-- máquina de invalidación granular por-sección/por-documento con autoría
-- (AE-02/AE-11) queda fuera de fase". Requiere: 001_licitaciones_schema.sql,
-- 002_compliance_and_package.sql.

create table licitaciones.approval (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  scope text not null check (scope in ('seccion', 'documento', 'expediente')),
  -- "expediente" o "seccion:<section_key>" — ver domain-licitaciones/src/approval-workflow.ts
  -- (árbol de 2 niveles, simplificación deliberada frente al origen de 3
  -- niveles: domain-licitaciones no modela documentos compuestos de varias
  -- secciones).
  scope_ref text not null,
  -- AE-02: scope='expediente' exige scope_ref='expediente' exacto (defensa en
  -- profundidad a nivel DB, además de la comprobación en ApprovalWorkflow.approve()).
  constraint approval_scope_ref_consistente check (
    (scope = 'expediente' and scope_ref = 'expediente') or scope <> 'expediente'
  ),
  status text not null default 'vigente' check (status in ('vigente', 'invalidada')),
  approver_id uuid not null references core.staff_user(id) on delete restrict,
  approver_role text not null,
  inputs_hash text not null,
  decided_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidated_reason text
);
create index approval_proposal_scope_idx on licitaciones.approval (organization_id, proposal_id, scope_ref, status);

-- AE-11: autoría acumulada por sección. `actor_id` se toma SIEMPRE de la
-- sesión autenticada en el momento de guardar contenido (nunca del cuerpo
-- del request) — ver PostgresLicitacionesRepository::recordSectionAuthor,
-- invocado automáticamente desde `saveEconomicGeneration`/`saveTechnicalSection`,
-- nunca dependiendo de que la ruta Hono se acuerde de llamarlo aparte.
create table licitaciones.section_author (
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  section_key text not null,
  actor_id uuid not null references core.staff_user(id) on delete cascade,
  first_edited_at timestamptz not null default now(),
  primary key (proposal_id, section_key, actor_id)
);

-- Auditoría de cambios detectados (ChangeDetected) — nunca se sobreescribe ni
-- se borra; cada invalidación de una aprobación vigente deja un rastro aquí.
create table licitaciones.approval_change (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  scope text not null,
  scope_ref text not null,
  reason text not null,
  invalidated_approval_ids uuid[] not null default '{}',
  detected_at timestamptz not null default now()
);
create index approval_change_proposal_idx on licitaciones.approval_change (organization_id, proposal_id, detected_at desc);

-- Migración de datos: `expediente_approval` (Fase 1) tenía a lo sumo una fila
-- 'vigente' por propuesta con scope='expediente' — se migra 1:1 sin pérdida.
insert into licitaciones.approval (id, organization_id, proposal_id, scope, scope_ref, status, approver_id, approver_role, inputs_hash, decided_at, invalidated_at, invalidated_reason)
select id, organization_id, proposal_id, 'expediente', 'expediente', status, approver_id, approver_role, inputs_hash, decided_at, invalidated_at, invalidated_reason
from licitaciones.expediente_approval;

-- La tabla anterior queda sustituida por completo — ningún código de
-- apps/api/domain-licitaciones la referencia después de esta migración.
drop policy if exists "org ve sus aprobaciones de expediente" on licitaciones.expediente_approval;
drop policy if exists "decisión: roles de decisión aprueban expediente" on licitaciones.expediente_approval;
drop policy if exists "decisión: roles de decisión invalidan aprobaciones" on licitaciones.expediente_approval;
drop table licitaciones.expediente_approval;

-- RLS — mismo patrón que 002 (`licitaciones.can_access_org`/`can_write_org`/
-- `can_decide_org`, ya definidos ahí). Aprobar (insert/update sobre
-- `approval`) sigue exigiendo DECISION_ROLES; `section_author`/
-- `approval_change` los escribe únicamente la capa de aplicación (nunca un
-- cliente directo), con WRITE_ROLES como defensa en profundidad.
alter table licitaciones.approval enable row level security;
alter table licitaciones.section_author enable row level security;
alter table licitaciones.approval_change enable row level security;

create policy "org ve sus aprobaciones" on licitaciones.approval for select using (licitaciones.can_access_org(organization_id));
create policy "org ve autoria de secciones" on licitaciones.section_author for select using (licitaciones.can_access_org(organization_id));
create policy "org ve cambios de aprobacion" on licitaciones.approval_change for select using (licitaciones.can_access_org(organization_id));

create policy "decisión: roles de decisión aprueban" on licitaciones.approval for insert with check (licitaciones.can_decide_org(organization_id));
create policy "decisión: roles de decisión invalidan aprobaciones" on licitaciones.approval for update using (licitaciones.can_decide_org(organization_id)) with check (licitaciones.can_decide_org(organization_id));
create policy "escritura: roles de escritura registran autoria" on licitaciones.section_author for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura registran cambios detectados" on licitaciones.approval_change for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.approval, licitaciones.section_author, licitaciones.approval_change from public, anon;
grant select on licitaciones.approval, licitaciones.section_author, licitaciones.approval_change to authenticated;
grant insert, update on licitaciones.approval to authenticated;
grant insert on licitaciones.section_author, licitaciones.approval_change to authenticated;
grant select, insert, update, delete on licitaciones.approval, licitaciones.section_author, licitaciones.approval_change to service_role;
