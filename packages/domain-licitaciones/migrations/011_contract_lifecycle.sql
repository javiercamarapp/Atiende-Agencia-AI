-- Fase 6 pieza 1 (REQ-050/REQ-051) — máquina de estados del contrato
-- post-adjudicación. El CATÁLOGO de transiciones válidas vive en código
-- (`domain-licitaciones/src/contract-lifecycle.ts::CONTRACT_TRANSITIONS`),
-- mismo precedente que `licitaciones.tender.status`/go-no-go — esta
-- migración solo persiste el CONTRATO (una fila por convocatoria) y su
-- HISTORIAL de transiciones ejecutadas (append-only, sin política de
-- UPDATE/DELETE: con RLS habilitada y ninguna política para esas
-- operaciones, Postgres las deniega para cualquier rol sin excepción).
-- Requiere: 001_licitaciones_schema.sql..010_source_runs_and_tender_versions.sql.

create table licitaciones.contract (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  status text not null default 'adjudicado' check (status in (
    'adjudicado', 'contrato_firmado_declarado', 'en_ejecucion', 'entregado',
    'facturado', 'pagado', 'cerrado', 'modificado', 'penalizado', 'rescindido', 'en_inconformidad'
  )),
  -- REQ-055: insumo directo del radar de renovaciones (fecha de fin
  -- conocida -> candidato a alerta). NULL mientras no se declare (bases sin
  -- vigencia fija, o contrato recién adjudicado).
  end_date date,
  contract_number text,
  has_renewal_option boolean not null default false,
  renewal_option_notes text,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, tender_id)
);
create index contract_organization_idx on licitaciones.contract (organization_id);
create index contract_end_date_idx on licitaciones.contract (organization_id, end_date) where end_date is not null;

create table licitaciones.contract_status_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_id uuid not null references licitaciones.contract(id) on delete cascade,
  -- NULL únicamente en la fila de creación del contrato (transición
  -- "inicial" hacia 'adjudicado', sin estado previo real).
  from_status text,
  to_status text not null,
  reason text not null,
  actor_id uuid references core.staff_user(id) on delete set null,
  evidence_ref text,
  created_at timestamptz not null default now()
);
create index contract_status_history_contract_idx on licitaciones.contract_status_history (organization_id, contract_id, created_at);

alter table licitaciones.contract enable row level security;
create policy "org ve sus contratos" on licitaciones.contract for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran/actualizan contratos" on licitaciones.contract for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan contratos" on licitaciones.contract for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.contract from public, anon;
grant select, insert, update on licitaciones.contract to authenticated;
grant select, insert, update, delete on licitaciones.contract to service_role;

-- Historial append-only por diseño (inmutable): deliberadamente SIN
-- políticas de UPDATE/DELETE.
alter table licitaciones.contract_status_history enable row level security;
create policy "org ve el historial de sus contratos" on licitaciones.contract_status_history for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran transiciones" on licitaciones.contract_status_history for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.contract_status_history from public, anon;
grant select, insert on licitaciones.contract_status_history to authenticated;
grant select, insert, update, delete on licitaciones.contract_status_history to service_role;
