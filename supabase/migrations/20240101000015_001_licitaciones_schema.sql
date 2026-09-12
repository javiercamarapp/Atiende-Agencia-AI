-- Esquema `licitaciones.*` — mapeo de las tablas reales de negocio de
-- `licitaciones/schema.sql` (tenders/tender_documents/requirement_items/
-- proposals/proposal_sections/company_documents/approved_rates) al modelo de
-- tenancy de `core` (`core.organization`) de
-- packages/db/migrations/0001_core_schema.sql. Requiere: 0001_core_schema.sql
-- ya aplicada.
--
-- CASO ESPECIAL de tenancy (ver diseño Fase 1 §2.1 y
-- core-tenancy/src/types.ts): licitaciones NO usa `core.property` para
-- particionar datos de negocio — una organización de licitaciones opera como
-- una sola Property implícita (singleton, ver comentario en
-- core-tenancy/src/types.ts). Por eso NINGUNA tabla de este archivo tiene
-- columna `property_id`: se filtra solo por `organization_id`, igual que el
-- origen filtraba solo por `org_id` (GUC de sesión propio, ver diseño §0 fila
-- 3) — la property singleton sigue existiendo a nivel de `core.property` por
-- consistencia de modelo (y para que `requirePropertyMembership("propertyId")`
-- funcione sin modificación), pero domain-licitaciones nunca la referencia en
-- su propio esquema.
--
-- Alcance de Fase 1 (§3.3 del diseño): solo lo necesario para sostener los 3
-- flujos elegidos (checklist de integridad / propuesta económica / cierre y
-- envío). El origen tiene ~70 tablas (matching, go/no-go, post-adjudicación,
-- inconformidad, fallo-autopsy, renewal-radar, company_profiles completo,
-- etc.) — deliberadamente NO portadas en esta fase, ver diseño §6.

create schema if not exists licitaciones;

-- Convocatoria. `submission_deadline` es el anclaje ÚNICO y obligatorio del
-- guardia anti-manipulación de fecha (REQ-LIC-001/AE-01 del origen,
-- domain-licitaciones/src/dates.ts::resolveExpedienteAsOfIso) — puede ser
-- NULL (bases aún no publican fecha límite), en cuyo caso los 3 flujos
-- bloquean explícitamente con 422 en vez de aproximar con "ahora".
create table licitaciones.tender (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  title text not null,
  submission_deadline timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tender_organization_idx on licitaciones.tender (organization_id);

-- Documentos de bases (pliegos) — mínimo necesario como FK de requirement_item;
-- extracción de texto/matching sobre estos documentos queda fuera de fase
-- (ver diseño §6, requirement-matrix.ts no portado).
create table licitaciones.tender_document (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  document_type text not null default 'other',
  storage_ref text not null,
  created_at timestamptz not null default now()
);
create index tender_document_tender_idx on licitaciones.tender_document (tender_id);

-- Requisitos de las bases — Fase 1 solo *lee* filas ya existentes
-- (requirement_kind='anexo' && obligatoriedad='obligatorio') para el Flujo 1;
-- la extracción real vía LLM/reglas (requirement-matrix.ts) no se porta en
-- esta fase, así que la escritura de estas filas queda fuera de las 3 rutas
-- Hono (se anota como dependencia de una fase futura, ver diseño §6).
create table licitaciones.requirement_item (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  document_id uuid references licitaciones.tender_document(id) on delete set null,
  description text not null,
  requirement_kind text not null default 'administrativo' check (requirement_kind in ('administrativo', 'legal', 'tecnico', 'anexo', 'economico')),
  obligatoriedad text not null default 'obligatorio' check (obligatoriedad in ('obligatorio', 'condicional', 'opcional')),
  topic_key text,
  required_evidence text[] not null default '{}',
  extracted_by text not null default 'rule' check (extracted_by in ('rule', 'llm')),
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);
create index requirement_item_tender_idx on licitaciones.requirement_item (organization_id, tender_id);

-- Propuesta (expediente). `inputs_hash` cachea el último hash de insumos
-- calculado (informativo; la fuente de verdad para "ready" siempre se
-- RE-DERIVA en vivo, nunca se confía en este campo — ver AE-14/§4.3).
create table licitaciones.proposal (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  title text not null,
  iva_rate numeric(5, 4) not null default 0.16 check (iva_rate >= 0 and iva_rate <= 1),
  economic_totals jsonb,
  generation_report jsonb,
  correlation_id text,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, tender_id)
);
create index proposal_organization_idx on licitaciones.proposal (organization_id);

-- Secciones redactadas del expediente (carta/anexo económico en Fase 1;
-- secciones técnicas quedan como "PENDIENTE..." hasta que se porte
-- TechnicalProposalBuilder, fuera de fase — ver diseño §4.3 paso 2).
create table licitaciones.proposal_section (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  section_key text not null,
  label text not null,
  filename text not null,
  content text not null default '',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proposal_id, section_key)
);
create index proposal_section_proposal_idx on licitaciones.proposal_section (organization_id, proposal_id);

-- Documentos de empresa (vigencia real) — Flujo 1/2 solo *leen* documentos ya
-- existentes; el CRUD de alta/verificación queda fuera de fase (§6).
create table licitaciones.company_document (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  document_type text not null,
  label text not null,
  issued_at timestamptz not null default now(),
  expires_at date,
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  created_at timestamptz not null default now()
);
create index company_document_organization_idx on licitaciones.company_document (organization_id);

-- Tarifas aprobadas — port de `approved_rates` del origen. Fase 1 no porta
-- `proposal_pricing_lines`/`enforce_approved_rate` (§6): el motor económico
-- escribe totales denormalizados en `licitaciones.proposal.economic_totals`,
-- no líneas de precio editables por separado.
create table licitaciones.approved_rate (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  concept text not null,
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  currency text not null default 'MXN' check (currency = 'MXN'),
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  valid_from date not null default current_date,
  valid_until date,
  created_at timestamptz not null default now(),
  unique (organization_id, concept)
);
create index approved_rate_organization_idx on licitaciones.approved_rate (organization_id, approval_status);
