-- Esquema `despachos.*` — mapeo de las tablas reales de negocio de
-- `despachos/b2b_ai/db/models.py` (SQL crudo versionado a mano, `MIGRATIONS` list, sin
-- RLS) al modelo de tenancy de `core` (`core.organization`/`core.property`) de
-- packages/db/migrations/0001_core_schema.sql. Requiere: 0001_core_schema.sql ya
-- aplicada, con 'despachos' ya en el check de `vertical` (prerequisito bloqueante,
-- ver diseño Fase 1 despachos §4).
--
-- Alcance de Fase 1 (§4 del diseño): solo lo necesario para sostener los 3 flujos
-- elegidos (ingesta/validación CFDI, cola de revisión humana, vencimientos fiscales
-- con escalamiento). Declaraciones ISR/IVA, DIOT agregado, nómina completa,
-- conciliación bancaria, FIEL/RPA al SAT quedan fuera — anotado, no diseñado (ver
-- diseño §4, "Explícitamente FUERA de Fase 1").
--
-- Mejora real de seguridad sobre el origen (que NO tiene RLS — el aislamiento ahí es
-- 100% disciplina de aplicación acordándose de filtrar por tenant_id en cada query):
-- aquí CADA tabla lleva RLS vía `core.has_property_access`, mismo patrón exacto que
-- `hoteles.folio`/`hoteles.charge` en packages/domain-hoteles/migrations/001.

create schema if not exists despachos;

-- ---------------------------------------------------------------------------
-- Perfil fiscal del despacho — campos que Organization/Property NO exponen (mismo
-- criterio que `hoteles.tax_config`/el `slug` ad-hoc de `core.organization`: cada
-- vertical extiende con su propia tabla en vez de inflar el modelo genérico de core).
-- ---------------------------------------------------------------------------
create table despachos.tenant_profile (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  rfc text not null check (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  razon_social text not null,
  regimen_fiscal text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Invoice — mapeo de `despachos.invoices` (origen: CFDI procesado, campo central del
-- producto: DIOT/conciliación/declaraciones/cobranza todo lee de aquí). El folio
-- fiscal (UUID del timbre SAT) es UNIQUE por organización: es la llave natural de
-- idempotencia de la ingesta (ver domain-despachos/src/repository.ts,
-- InvoiceAlreadyExistsError) — un mismo CFDI reenviado nunca produce dos filas.
-- `issues`/`warnings` persisten el resultado EXACTO de `validarCfdiDespachos()`
-- (packages/domain-despachos/src/cfdi/reglas-fiscales-avanzadas.ts) — nunca se
-- recalculan "a ojo" después, el invoice guarda el veredicto que se le dio en el
-- momento de la ingesta.
-- ---------------------------------------------------------------------------
create table despachos.invoice (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  folio_fiscal uuid not null,
  tipo text not null check (tipo in ('I', 'E', 'T', 'P', 'N')),
  rfc_emisor text not null,
  rfc_receptor text not null,
  emisor_nombre text,
  subtotal numeric(14, 2) not null check (subtotal >= 0),
  total numeric(14, 2) not null,
  iva numeric(14, 2),
  descuento numeric(14, 2) not null default 0 check (descuento >= 0),
  categoria text not null default 'sin_clasificar'
    check (categoria in ('gasto_operativo', 'activo_fijo', 'inversion', 'honorarios', 'nomina', 'sin_clasificar')),
  confianza numeric(4, 3) check (confianza is null or (confianza >= 0 and confianza <= 1)),
  valido boolean not null,
  issues jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  requires_human_review boolean not null default false,
  diot jsonb not null default '{"proveedoresReportables": [], "reportable": false}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organization_id, folio_fiscal)
);
create index invoice_property_idx on despachos.invoice (property_id);
create index invoice_review_pending_idx on despachos.invoice (property_id) where requires_human_review;

-- Historial de clasificación contable — Fase 1 solo persiste el resultado de una
-- clasificación ya hecha (manual o heurística simple vía CP_CATEGORIAS); el
-- classifier automático completo del origen (`b2b_ai/features/classifier`) es Fase 2.
-- El invoice nunca se re-clasifica en silencio: cada cambio deja una fila aquí.
create table despachos.invoice_classification (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references despachos.invoice(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  categoria text not null
    check (categoria in ('gasto_operativo', 'activo_fijo', 'inversion', 'honorarios', 'nomina', 'sin_clasificar')),
  confianza numeric(4, 3) check (confianza is null or (confianza >= 0 and confianza <= 1)),
  method text not null check (method in ('manual', 'heuristica_claveprodserv')),
  classified_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index invoice_classification_invoice_idx on despachos.invoice_classification (invoice_id);

-- ---------------------------------------------------------------------------
-- Cola de revisión humana — flujo 2, gateada por `invoice.requires_human_review`.
-- Patrón "anti-alucinación" de esta vertical (ver diseño Fase 1 §4): nunca se declara
-- un CFDI válido/clasificado sin que un humano confirme cuando el motor tiene dudas.
-- ---------------------------------------------------------------------------
create table despachos.invoice_review (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  invoice_id uuid not null references despachos.invoice(id) on delete cascade,
  reason text not null,
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobado', 'rechazado')),
  decision_note text,
  resolved_by uuid references core.staff_user(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invoice_review_resolution_consistent check (
    (status = 'pendiente' and resolved_by is null and resolved_at is null)
    or (status <> 'pendiente' and resolved_by is not null and resolved_at is not null)
  )
);
create index invoice_review_property_idx on despachos.invoice_review (property_id);
create index invoice_review_pending_by_property_idx on despachos.invoice_review (property_id) where status = 'pendiente';

-- ---------------------------------------------------------------------------
-- Vencimientos fiscales — flujo 3. Origen: `_deadlines: Dict[str, Deadline]` en
-- memoria (`VencimientosService`), aquí en Postgres real. `fecha_limite` es el día 17
-- del mes siguiente (motor determinista, ver vencimientos/engine.ts) — LIMITACIÓN
-- HEREDADA a propósito: no ajusta por día inhábil/sexto dígito del RFC (ver
-- diseño §5 punto 4, no es una mejora silenciosa de esta fase).
-- ---------------------------------------------------------------------------
create table despachos.fiscal_deadline (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  tipo text not null check (tipo in ('ISR', 'IVA', 'DIOT', 'Nómina')),
  periodo text not null check (periodo ~ '^\d{4}-\d{2}$'),
  fecha_limite date not null,
  prioridad text not null check (prioridad in ('critica', 'alta', 'media', 'baja')),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'en_proceso', 'completado', 'vencido', 'escalado')),
  fecha_presentacion date,
  comprobante_url text,
  created_at timestamptz not null default now(),
  unique (property_id, tipo, periodo)
);
create index fiscal_deadline_property_idx on despachos.fiscal_deadline (property_id);
create index fiscal_deadline_pendientes_idx on despachos.fiscal_deadline (property_id, fecha_limite) where estado not in ('completado');

create table despachos.deadline_escalation (
  id uuid primary key default gen_random_uuid(),
  deadline_id uuid not null references despachos.fiscal_deadline(id) on delete cascade,
  level text not null check (level in ('nivel_1', 'nivel_2', 'nivel_3', 'nivel_4')),
  sent_at timestamptz not null default now(),
  notes text not null default ''
);
create index deadline_escalation_deadline_idx on despachos.deadline_escalation (deadline_id);

-- ---------------------------------------------------------------------------
-- Auditoría: NO se crea una tabla propia de despachos — se reutiliza
-- `@atiende/core-authz::AuditSink` (packages/core-authz/src/audit.ts), mismo criterio
-- de "lo compartido vive en core, no se repite por vertical" ya aplicado al resto del
-- monorepo. Una implementación real de `AuditSink` para Postgres (si se decide
-- persistir auditoría en `core.authz_audit_log`) es responsabilidad de core-authz/
-- packages/db, no de este paquete.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- RLS — nunca se re-implementa aislamiento por tenant_id a mano en cada query (que es
-- justo el punto débil documentado del origen): la autoridad es SIEMPRE
-- `core.has_property_access`, mismo patrón exacto que packages/domain-hoteles/
-- migrations/001_hoteles_schema.sql.
-- ---------------------------------------------------------------------------
alter table despachos.tenant_profile enable row level security;
alter table despachos.invoice enable row level security;
alter table despachos.invoice_classification enable row level security;
alter table despachos.invoice_review enable row level security;
alter table despachos.fiscal_deadline enable row level security;
alter table despachos.deadline_escalation enable row level security;

create policy "staff ve el perfil fiscal de su organización" on despachos.tenant_profile for select
  using (exists (select 1 from core.membership m where m.organization_id = tenant_profile.organization_id and m.user_id = auth.uid()));

create policy "staff ve invoices de su property" on despachos.invoice for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta invoices de su property" on despachos.invoice for insert
  with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve clasificaciones de invoices de su organización" on despachos.invoice_classification for select
  using (exists (select 1 from core.membership m where m.organization_id = invoice_classification.organization_id and m.user_id = auth.uid()));
create policy "staff inserta clasificaciones de su organización" on despachos.invoice_classification for insert
  with check (exists (select 1 from core.membership m where m.organization_id = invoice_classification.organization_id and m.user_id = auth.uid()));

create policy "staff ve revisiones de su property" on despachos.invoice_review for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta revisiones de su property" on despachos.invoice_review for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza revisiones de su property" on despachos.invoice_review for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve vencimientos de su property" on despachos.fiscal_deadline for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta vencimientos de su property" on despachos.fiscal_deadline for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza vencimientos de su property" on despachos.fiscal_deadline for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve escalamientos de vencimientos de su property" on despachos.deadline_escalation for select
  using (exists (
    select 1 from despachos.fiscal_deadline d
    where d.id = deadline_escalation.deadline_id and core.has_property_access(auth.uid(), d.property_id)
  ));
create policy "staff inserta escalamientos de vencimientos de su property" on despachos.deadline_escalation for insert
  with check (exists (
    select 1 from despachos.fiscal_deadline d
    where d.id = deadline_escalation.deadline_id and core.has_property_access(auth.uid(), d.property_id)
  ));

revoke all on all tables in schema despachos from public, anon;
grant select, insert on despachos.tenant_profile to authenticated;
grant select, insert on despachos.invoice to authenticated;
grant select, insert on despachos.invoice_classification to authenticated;
grant select, insert, update on despachos.invoice_review to authenticated;
grant select, insert, update on despachos.fiscal_deadline to authenticated;
grant select, insert on despachos.deadline_escalation to authenticated;
grant select, insert, update, delete on all tables in schema despachos to service_role;
