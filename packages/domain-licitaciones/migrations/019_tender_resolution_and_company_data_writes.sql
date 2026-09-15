-- Fase 16 (post-adjudicación, pieza 0) -- dos gaps que dejaban todo el flujo
-- de post-adjudicación y de propuestas inalcanzable en producción:
--
-- 1. `licitaciones.tender.status` podía llegar a 'won'/'lost' (el CHECK ya
--    los admite desde 007_matching_profile.sql) pero ningún endpoint HTTP
--    escribía esa transición -- se agrega `licitaciones.tender_resolution`,
--    tabla de historial INMUTABLE (mismo patrón que `go_no_go_decision`,
--    008), gateada por `can_decide_org` (DECISION_ROLES, ver
--    tender-resolution.ts) porque declarar ganada/perdida una licitación es
--    una decisión comercial/legal, igual que aprobar el expediente completo.
--    La actualización de `tender.status` en sí sigue pasando por la policy
--    de UPDATE ya existente sobre `licitaciones.tender`
--    ("escritura: roles de escritura actualizan convocatorias",
--    002_compliance_and_package.sql, `can_write_org`) -- DECISION_ROLES es
--    subconjunto de WRITE_ROLES, así que ninguna policy nueva hace falta ahí.
--
-- 2. `licitaciones.company_document`/`licitaciones.approved_rate` (001) SOLO
--    tenían policy de SELECT desde su creación -- a diferencia de
--    `company_capability`/`company_experience`/`company_signer`
--    (009_company_capabilities_experience_signers.sql), que SÍ recibieron
--    INSERT/UPDATE con `can_write_org` en su propia migración. Sin esto,
--    ningún endpoint de escritura sobre esos dos (por más que la aplicación
--    los expusiera) habría podido insertar/actualizar una fila real: RLS
--    los habría bloqueado en silencio. Se cierra el mismo hueco aquí, con
--    EXACTAMENTE el mismo criterio (`can_write_org`, nunca `can_decide_org`:
--    capturar/corregir un dato de empresa es captura, no una decisión de
--    riesgo -- la decisión de riesgo es a qué se usa ese dato, que sigue
--    viviendo en `requirement_fulfillment_mapping`, DECISION_ROLES,
--    006_technical_proposal.sql).
--
-- Requiere: 001 (company_document/approved_rate), 002
-- (can_access_org/can_write_org/can_decide_org), 008 (mismo patrón de tabla
-- de decisión inmutable que replica tender_resolution).

create table licitaciones.tender_resolution (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  resolution text not null check (resolution in ('won', 'lost')),
  -- Estado desde el que se resolvió -- auditoría de que la transición fue
  -- válida en el momento de decidir (nunca se recalcula retroactivamente).
  from_status text not null,
  -- Nunca una resolución sin motivo explícito, mismo criterio que
  -- `go_no_go_decision.reasons`.
  reason text not null check (length(trim(reason)) > 0),
  resolved_by uuid not null references core.staff_user(id) on delete restrict,
  resolved_at timestamptz not null default now()
);
create index tender_resolution_tender_idx on licitaciones.tender_resolution (tender_id, resolved_at asc);

alter table licitaciones.tender_resolution enable row level security;

create policy "org ve resoluciones de sus convocatorias" on licitaciones.tender_resolution for select using (licitaciones.can_access_org(organization_id));

-- Decisión: INSERT restringido a DECISION_ROLES (owner/admin/analyst) -- sin
-- UPDATE/DELETE, mismo criterio que `go_no_go_decision`: una resolución
-- registrada es un hecho histórico inmutable.
create policy "decisión: roles de decisión registran la resolución" on licitaciones.tender_resolution for insert with check (licitaciones.can_decide_org(organization_id));

revoke all on licitaciones.tender_resolution from public, anon;
grant select on licitaciones.tender_resolution to authenticated;
grant insert on licitaciones.tender_resolution to authenticated;
grant select, insert, update, delete on licitaciones.tender_resolution to service_role;

-- ---------------------------------------------------------------------
-- Gap 2: INSERT/UPDATE de company_document/approved_rate, faltante desde 001.
-- ---------------------------------------------------------------------

create policy "escritura: roles de escritura registran documentos de empresa" on licitaciones.company_document for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan documentos de empresa" on licitaciones.company_document for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

create policy "escritura: roles de escritura registran tarifas aprobadas" on licitaciones.approved_rate for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan tarifas aprobadas" on licitaciones.approved_rate for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

grant insert, update on licitaciones.company_document, licitaciones.approved_rate to authenticated;
