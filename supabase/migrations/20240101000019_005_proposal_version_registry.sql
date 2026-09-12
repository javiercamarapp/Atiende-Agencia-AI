-- Fase 2 pieza 2 — historial de versiones de insumos
-- (`ProposalVersionRegistry`, ver domain-licitaciones/src/proposal-version-registry.ts).
-- Poblada solo cuando el hash combinado de insumos CAMBIA respecto de la
-- última versión registrada (nunca en cada lectura) — ver
-- PostgresLicitacionesRepository::syncExpedienteApprovalWithCurrentHash.
-- Requiere: 001_licitaciones_schema.sql, 004_granular_approvals.sql.

create table licitaciones.proposal_version (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  version integer not null,
  hash text not null,
  -- Snapshot de `ProposalInputRecord[]` ({key, hash} por insumo individual) —
  -- permite a `ProposalVersionRegistry.diff` decir QUÉ insumo cambió entre
  -- dos versiones, no solo que el hash combinado difiere.
  inputs jsonb not null,
  created_at timestamptz not null default now(),
  unique (proposal_id, version)
);
create index proposal_version_proposal_idx on licitaciones.proposal_version (organization_id, proposal_id, version desc);

alter table licitaciones.proposal_version enable row level security;

create policy "org ve sus versiones de propuesta" on licitaciones.proposal_version for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran versiones" on licitaciones.proposal_version for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.proposal_version from public, anon;
grant select on licitaciones.proposal_version to authenticated;
grant insert on licitaciones.proposal_version to authenticated;
grant select, insert, update, delete on licitaciones.proposal_version to service_role;
