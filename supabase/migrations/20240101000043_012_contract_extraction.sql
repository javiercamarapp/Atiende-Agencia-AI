-- Fase 6 pieza 2 (REQ-052) — extracción determinista (sin LLM) de campos
-- estructurados de un contrato firmado. `contract_document` registra el
-- TEXTO YA EXTRAÍDO por página (no los bytes del PDF: este monorepo no
-- tiene, en ningún vertical, un pipeline de texto-desde-PDF/OCR -- ver
-- `domain-licitaciones/src/contract-extraction.ts` para el límite completo
-- documentado, mismo contrato de entrada que
-- `licitaciones.requirement_item`/`RuleBasedExtractor`).
-- Requiere: 011_contract_lifecycle.sql.

create table licitaciones.contract_document (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_id uuid not null references licitaciones.contract(id) on delete cascade,
  document_label text not null,
  page_count integer not null,
  uploaded_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index contract_document_contract_idx on licitaciones.contract_document (organization_id, contract_id);

-- `contract_extracted_field`: campos detectados por el extractor
-- determinista (regex, sin LLM). REQ-052: "el usuario confirma o corrige;
-- nunca se dan por válidos sin confirmación" -- `status` empieza SIEMPRE en
-- 'sugerido'; solo `POST .../fields/:fieldId/confirm` puede moverlo a
-- 'confirmado'/'corregido'.
create table licitaciones.contract_extracted_field (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_document_id uuid not null references licitaciones.contract_document(id) on delete cascade,
  field_key text not null check (field_key in (
    'numero_contrato', 'monto_total', 'plazo_entrega', 'garantia_cumplimiento',
    'pena_convencional', 'deductiva', 'forma_pago', 'administrador_contrato', 'cesion_cobro'
  )),
  extracted_value text not null,
  source_page integer,
  source_clause text,
  confidence numeric(3, 2) not null,
  status text not null default 'sugerido' check (status in ('sugerido', 'confirmado', 'corregido')),
  confirmed_value text,
  confirmed_by uuid references core.staff_user(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create index contract_extracted_field_document_idx on licitaciones.contract_extracted_field (organization_id, contract_document_id);

alter table licitaciones.contract_document enable row level security;
create policy "org ve los documentos de sus contratos" on licitaciones.contract_document for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura suben documentos de contrato" on licitaciones.contract_document for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.contract_document from public, anon;
grant select, insert on licitaciones.contract_document to authenticated;
grant select, insert, update, delete on licitaciones.contract_document to service_role;

alter table licitaciones.contract_extracted_field enable row level security;
create policy "org ve los campos extraídos de sus contratos" on licitaciones.contract_extracted_field for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran campos extraídos" on licitaciones.contract_extracted_field for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura confirman/corrigen campos extraídos" on licitaciones.contract_extracted_field for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.contract_extracted_field from public, anon;
grant select, insert, update on licitaciones.contract_extracted_field to authenticated;
grant select, insert, update, delete on licitaciones.contract_extracted_field to service_role;
