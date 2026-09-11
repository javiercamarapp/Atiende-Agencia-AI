-- Checklist de integridad (Flujo 1), aprobación de expediente y paquete de
-- cierre (Flujo 3) — ver diseño Fase 1 §3.3. Requiere: 001_licitaciones_schema.sql.

-- Snapshot persistido de la última corrida de `IntegrityChecklist` (7
-- dimensiones) — se reemplaza completo en cada `POST .../checklist/run`
-- (nunca se acumula historial de corridas, mismo criterio que el origen:
-- `delete ... where proposal_id = $1` antes de reinsertar).
create table licitaciones.compliance_item (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  dimension text not null check (dimension in ('formatos', 'limites', 'firmas', 'anexos_obligatorios', 'vigencias', 'calculos_economicos', 'consistencia_cruzada')),
  result text not null check (result in ('verde', 'ambar', 'rojo')),
  notes text not null default '',
  evidence_ref text,
  checked_at timestamptz not null default now()
);
create index compliance_item_proposal_idx on licitaciones.compliance_item (organization_id, proposal_id);

-- Versión REDUCIDA de `proposal_approvals` del origen (ver diseño §3.1): solo
-- aprobación de ALCANCE COMPLETO "expediente" (`scope`/`scope_ref` fijos) —
-- la máquina de invalidación granular por-sección/por-documento con autoría
-- (AE-02/AE-11) queda fuera de fase, documentada como limitación conocida.
-- `approve_expediente()` invalida (marca `status='invalidada'`) cualquier
-- aprobación `'vigente'` previa de la misma propuesta antes de insertar la
-- nueva — nunca coexisten dos aprobaciones vigentes para el mismo expediente.
create table licitaciones.expediente_approval (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  scope text not null default 'expediente' check (scope = 'expediente'),
  status text not null default 'vigente' check (status in ('vigente', 'invalidada')),
  approver_id uuid not null references core.staff_user(id) on delete restrict,
  approver_role text not null,
  inputs_hash text not null,
  decided_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidated_reason text
);
create index expediente_approval_proposal_idx on licitaciones.expediente_approval (organization_id, proposal_id, status);

-- Paquete final: manifiesto de archivos con hashes + snapshot del checklist
-- en el momento de generarse. `ready` exige `checklist_snapshot` no vacío —
-- mismo `CHECK package_ready_requires_checklist` que el origen (defensa en
-- profundidad a nivel DB, igual espíritu que `hoteles.mark_charge_reversed`):
-- la validación de COMPLETITUD real (checklist verde + sin faltantes +
-- aprobación vigente con hash coincidente) es lógica de aplicación
-- (`@atiende/domain-licitaciones::PackageAssembler`), pero el esquema impide
-- al menos el caso trivial de "ready" sin checklist siquiera capturado.
create table licitaciones.package_manifest (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'ready')),
  manifest jsonb not null,
  checklist_snapshot jsonb,
  storage_ref text not null,
  inputs_hash text not null,
  correlation_id text,
  generated_by uuid references core.staff_user(id) on delete set null,
  generated_at timestamptz not null default now(),
  constraint package_ready_requires_checklist check (status = 'draft' or checklist_snapshot is not null)
);
create index package_manifest_proposal_idx on licitaciones.package_manifest (organization_id, proposal_id, generated_at desc);

-- Entrega: SOLO registra que el usuario DECLARA haber presentado su
-- propuesta (fecha, acuse subido por el propio usuario) — este esquema
-- (igual que el módulo de ruta que lo escribe, ver cierre.ts) nunca modela
-- ni implica un envío real a un portal externo (REQ-LIC-011).
create table licitaciones.submission (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  status text not null default 'submitted' check (status = 'submitted'),
  submitted_by uuid references core.staff_user(id) on delete set null,
  submitted_at timestamptz not null,
  acknowledgement_storage_ref text,
  acknowledgement_file_hash text,
  notes text,
  created_at timestamptz not null default now()
);
create index submission_proposal_idx on licitaciones.submission (organization_id, proposal_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — nunca se reinventa el GUC de sesión propio del origen (`app.current_org_id()`,
-- ver diseño §0 fila 3/§3.4): se sigue la MISMA convención ya establecida dos
-- veces por hoteles/restaurantes, escrita contra `auth.uid()`. Como estas
-- tablas NO tienen `property_id` (singleton por organización, §2.1),
-- `core.has_property_access` no aplica aquí — se define en su lugar
-- `licitaciones.can_access_org(org_id)`, mismo patrón `security definer` que
-- `core.has_property_access`.
-- ---------------------------------------------------------------------------
create or replace function licitaciones.can_access_org(_organization_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id and m.user_id = auth.uid()
  )
$$;

-- Roles de escritura (WRITE_ROLES) vs. de decisión (DECISION_ROLES) — mirror
-- de domain-licitaciones/src/roles.ts, nunca se reinventan aquí: aprobar el
-- expediente completo es una decisión, no redacción.
create or replace function licitaciones.can_write_org(_organization_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin', 'analyst', 'writer', 'reviewer')
  )
$$;

create or replace function licitaciones.can_decide_org(_organization_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin', 'analyst')
  )
$$;

alter table licitaciones.tender enable row level security;
alter table licitaciones.tender_document enable row level security;
alter table licitaciones.requirement_item enable row level security;
alter table licitaciones.proposal enable row level security;
alter table licitaciones.proposal_section enable row level security;
alter table licitaciones.company_document enable row level security;
alter table licitaciones.approved_rate enable row level security;
alter table licitaciones.compliance_item enable row level security;
alter table licitaciones.expediente_approval enable row level security;
alter table licitaciones.package_manifest enable row level security;
alter table licitaciones.submission enable row level security;

-- Lectura: cualquier miembro de la organización (todas las tablas).
create policy "org ve sus convocatorias" on licitaciones.tender for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus documentos de bases" on licitaciones.tender_document for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus requisitos" on licitaciones.requirement_item for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus propuestas" on licitaciones.proposal for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus secciones de propuesta" on licitaciones.proposal_section for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus documentos de empresa" on licitaciones.company_document for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus tarifas aprobadas" on licitaciones.approved_rate for select using (licitaciones.can_access_org(organization_id));
create policy "org ve su checklist" on licitaciones.compliance_item for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus aprobaciones de expediente" on licitaciones.expediente_approval for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus manifiestos de paquete" on licitaciones.package_manifest for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus declaraciones de presentación" on licitaciones.submission for select using (licitaciones.can_access_org(organization_id));

-- Escritura: WRITE_ROLES para tender/proposal/proposal_section/compliance_item/
-- package_manifest/submission (mismo alcance que las 3 rutas Hono, que ya
-- exigen `assertVerticalRole(c, WRITE_ROLES)` en cada handler de escritura —
-- esta policy es defensa en profundidad, no la única capa).
create policy "escritura: roles de escritura crean convocatorias" on licitaciones.tender for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan convocatorias" on licitaciones.tender for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura crean propuestas" on licitaciones.proposal for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan propuestas" on licitaciones.proposal for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura crean secciones" on licitaciones.proposal_section for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan secciones" on licitaciones.proposal_section for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura escriben checklist" on licitaciones.compliance_item for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura borran checklist" on licitaciones.compliance_item for delete using (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura escriben manifiestos" on licitaciones.package_manifest for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura declaran presentación" on licitaciones.submission for insert with check (licitaciones.can_write_org(organization_id));

-- Decisión: aprobar el expediente completo exige DECISION_ROLES (subconjunto
-- estricto de WRITE_ROLES: owner/admin/analyst, nunca writer/reviewer solos).
create policy "decisión: roles de decisión aprueban expediente" on licitaciones.expediente_approval for insert with check (licitaciones.can_decide_org(organization_id));
create policy "decisión: roles de decisión invalidan aprobaciones" on licitaciones.expediente_approval for update using (licitaciones.can_decide_org(organization_id)) with check (licitaciones.can_decide_org(organization_id));

revoke all on all tables in schema licitaciones from public, anon;
grant select on all tables in schema licitaciones to authenticated;
grant insert, update on licitaciones.tender, licitaciones.proposal, licitaciones.proposal_section, licitaciones.compliance_item, licitaciones.package_manifest, licitaciones.submission to authenticated;
grant delete on licitaciones.compliance_item to authenticated;
grant insert, update on licitaciones.expediente_approval to authenticated;
grant select, insert, update, delete on all tables in schema licitaciones to service_role;
