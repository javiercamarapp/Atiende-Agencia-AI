-- Fase 4: implementación real de CompanyDataResolver.getCapabilities/getExperience/
-- getSigners (packages/domain-licitaciones/src/company-data.ts). Fase 1 §3.1 dejó estos
-- tres métodos como stub ([]) "hasta que se porte TechnicalProposalBuilder" -- ese motor
-- ya se portó y verificó en Fase 2, y de hecho SÍ llama
-- resolveCapability/resolveExperience/resolveAuthorizedSigner para los requisitos que
-- mapean a esos tipos (technical-proposal.ts). Sin esta migración, esos requisitos
-- siempre resuelven "missing" en producción, degradando en silencio la propuesta técnica.
--
-- Mismo patrón exacto que licitaciones.company_document/approved_rate (001):
-- organization_id -> core.organization, approval_status con el mismo check de 3 estados,
-- RLS vía las mismas funciones can_access_org/can_write_org (002).
--
-- Requiere: 001 (core.organization, licitaciones.company_document) y 002
-- (can_access_org/can_write_org) ya aplicadas.

create table licitaciones.company_capability (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  name text not null,
  description text not null,
  -- Referencia opcional a un documento de licitaciones.company_document que respalda
  -- la capacidad (p. ej. una certificación ISO escaneada). NULL es válido -- no toda
  -- capacidad requiere evidencia documental (CompanyCapability.evidenceDocId es
  -- opcional en el dominio, a diferencia de CompanyExperienceRecord.evidenceDocId que
  -- es obligatorio, ver abajo).
  evidence_doc_id uuid references licitaciones.company_document(id) on delete set null,
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
create index company_capability_organization_idx on licitaciones.company_capability (organization_id);

create table licitaciones.company_experience (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  description text not null,
  -- Obligatorio a nivel de negocio (CompanyDataService.resolveExperience bloquea con
  -- "evidencia_no_verificable" si está vacío o no corresponde a un documento real) --
  -- se deja `not null references` para que la base de datos misma haga imposible
  -- guardar una experiencia sin evidencia, en vez de confiar solo en la regla de
  -- dominio en TypeScript.
  evidence_doc_id uuid not null references licitaciones.company_document(id) on delete restrict,
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  created_at timestamptz not null default now()
);
create index company_experience_organization_idx on licitaciones.company_experience (organization_id);

create table licitaciones.company_signer (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  name text not null,
  role text not null,
  authorized boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, role)
);
create index company_signer_organization_idx on licitaciones.company_signer (organization_id);

alter table licitaciones.company_capability enable row level security;
alter table licitaciones.company_experience enable row level security;
alter table licitaciones.company_signer enable row level security;

create policy "org ve sus capacidades" on licitaciones.company_capability for select using (licitaciones.can_access_org(organization_id));
create policy "org ve su experiencia" on licitaciones.company_experience for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus firmantes" on licitaciones.company_signer for select using (licitaciones.can_access_org(organization_id));

create policy "escritura: roles de escritura registran capacidades" on licitaciones.company_capability for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan capacidades" on licitaciones.company_capability for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura registran experiencia" on licitaciones.company_experience for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan experiencia" on licitaciones.company_experience for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura registran firmantes" on licitaciones.company_signer for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan firmantes" on licitaciones.company_signer for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
