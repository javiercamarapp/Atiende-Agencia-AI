-- Fase 2 pieza 3 — RequirementMatrix + TechnicalProposalBuilder. Amplía
-- `licitaciones.requirement_item` (001_licitaciones_schema.sql), que hasta
-- ahora era SOLO LECTURA (comentario de esa migración: "la extracción real
-- vía LLM/reglas... no se porta en esta fase") con las columnas que
-- `RequirementItem` necesita para persistirse completo: página/cláusula de
-- origen, rol responsable, fecha límite, estado (incluye "bloqueado" por
-- conflicto sin resolver) y confianza del extractor. Requiere:
-- 001_licitaciones_schema.sql.

alter table licitaciones.requirement_item
  add column page integer,
  add column clause text,
  add column responsible_role text not null default 'licitador',
  add column deadline timestamptz,
  add column status text not null default 'pendiente' check (status in ('pendiente', 'en_progreso', 'cumplido', 'bloqueado', 'no_evaluable')),
  add column confidence numeric(3, 2) check (confidence is null or (confidence >= 0 and confidence <= 1));

-- 001_licitaciones_schema.sql dejó `requirement_item` deliberadamente
-- SOLO LECTURA (ninguna policy de insert/update/delete, ningún grant de
-- escritura) porque nada la escribía todavía. Pieza 3 es el primer escritor
-- real -- se agrega aquí la escritura que faltaba, con WRITE_ROLES (mismo
-- nivel que el resto de la extracción/redacción del expediente, nunca
-- DECISION_ROLES: extraer requisitos no es una decisión editorial).
create policy "escritura: roles de escritura registran requisitos" on licitaciones.requirement_item for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan requisitos" on licitaciones.requirement_item for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura eliminan requisitos" on licitaciones.requirement_item for delete using (licitaciones.can_write_org(organization_id));
grant insert, update, delete on licitaciones.requirement_item to authenticated;

-- Nota deliberada (simplificación de fase, ver diseño §4.3): los `Conflict`
-- que `detectConflicts` produce NO se persisten en una tabla propia -- son
-- una función PURA de los `requirement_item` ya guardados (mismo `topicKey`,
-- deadline/obligatoriedad distintos) y se recalculan en vivo cada vez que
-- hacen falta (misma filosofía que "ready" en PackageAssembler: nunca se
-- confía en un valor persistido que pueda desincronizarse del estado
-- actual). No hay historial de auditoría de conflictos en esta fase -- a
-- diferencia de `licitaciones.approval_change` (Pieza 1), que sí necesita
-- historial porque una aprobación humana es un evento irrepetible; un
-- conflicto de requisitos es, en cambio, siempre reproducible desde los
-- datos vigentes.

-- Mapeo requisito -> dato de empresa (ver diseño §4.2:
-- `RequirementFulfillmentMapping`), editable por DECISION_ROLES. Clave por
-- `topic_key` (no por requirement_id individual): el mismo tema
-- ("garantia_cumplimiento", "acta_constitutiva") se repite entre
-- convocatorias distintas y el mapeo de qué documento de empresa lo cubre no
-- cambia por convocatoria.
create table licitaciones.requirement_fulfillment_mapping (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  topic_key text not null,
  kind text not null check (kind in ('capability', 'experience', 'document', 'signer')),
  ref_key text not null,
  -- Interpolación de texto DELIBERADAMENTE simple (reemplazo literal de
  -- "{value}", nunca un motor de plantillas) -- coherente con el resto de
  -- domain-licitaciones, que nunca introduce dependencias nuevas sin
  -- justificación fuerte.
  statement_template text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, topic_key)
);

alter table licitaciones.requirement_fulfillment_mapping enable row level security;

create policy "org ve sus mapeos de cumplimiento" on licitaciones.requirement_fulfillment_mapping for select using (licitaciones.can_access_org(organization_id));
-- Decisión: configurar de qué dato de empresa se redacta un requisito es una
-- decisión editorial/de riesgo (afecta qué se afirma ante un ente público),
-- no redacción -- exige DECISION_ROLES, mismo criterio que aprobar el
-- expediente (Pieza 1).
create policy "decisión: roles de decisión configuran mapeos" on licitaciones.requirement_fulfillment_mapping for insert with check (licitaciones.can_decide_org(organization_id));
create policy "decisión: roles de decisión actualizan mapeos" on licitaciones.requirement_fulfillment_mapping for update using (licitaciones.can_decide_org(organization_id)) with check (licitaciones.can_decide_org(organization_id));

revoke all on licitaciones.requirement_fulfillment_mapping from public, anon;
grant select on licitaciones.requirement_fulfillment_mapping to authenticated;
grant insert, update on licitaciones.requirement_fulfillment_mapping to authenticated;
grant select, insert, update, delete on licitaciones.requirement_fulfillment_mapping to service_role;
