-- 037 (paridad3, L-P3-05/06/07) -- boveda de documentos de la convocatoria, matriz de requisitos estable,
-- conflictos persistidos y revision con comentarios.
--
-- Estado previo verificado: `licitaciones.tender_document` (001) no tenia NINGUN escritor (el texto de las
-- bases entraba en base64, se extraia y se descartaba), `requirement_item` se BORRABA y reinsertaba completa en
-- cada re-extraccion (perdiendo responsable/estado asignados a mano) y los conflictos regla-vs-LLM solo viajaban en
-- la respuesta HTTP. Requiere: 001, 002, 004, 006, 022 (file_blob).
--
-- Compatibilidad: todo es aditivo (columnas nuevas nullable o con default, tablas nuevas). El codigo TypeScript
-- que las usa captura 42703/42P01 y cae al camino anterior en una base sin esta migracion.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Boveda: columnas nuevas de tender_document
-- ---------------------------------------------------------------------------------------------------------------
alter table licitaciones.tender_document
  add column if not exists title text,
  add column if not exists filename text,
  add column if not exists mime_type text,
  add column if not exists file_blob_id uuid references licitaciones.file_blob(id) on delete restrict,
  add column if not exists sha256 text,
  add column if not exists size_bytes integer check (size_bytes is null or size_bytes >= 0),
  add column if not exists page_count integer check (page_count is null or page_count >= 0),
  -- null = fila anterior a esta migracion (sin informacion); nunca se inventa un estado para ella (REQ-166).
  add column if not exists extraction_status text check (extraction_status is null or extraction_status in ('extracted', 'requires_ocr', 'failed')),
  add column if not exists extraction_detail text,
  -- Texto por pagina {page,text}[] ya extraido: permite re-extraer y citar (pagina + extracto) sin volver a subir.
  add column if not exists extracted_pages jsonb,
  -- Version por documento: cada nueva version comparte `lineage_id` y suma 1 a `version`; las anteriores se conservan.
  add column if not exists lineage_id uuid not null default gen_random_uuid(),
  add column if not exists version integer not null default 1 check (version >= 1),
  add column if not exists uploaded_by uuid references core.staff_user(id) on delete set null;

-- NOT VALID: no revalida filas viejas (el default historico era 'other'), pero toda fila nueva debe usar un tipo conocido.
alter table licitaciones.tender_document
  add constraint tender_document_type_valido check (document_type in ('bases', 'anexo', 'acta_junta', 'modificacion', 'fallo', 'other')) not valid;

create unique index if not exists tender_document_lineage_version_uq on licitaciones.tender_document (lineage_id, version);
create index if not exists tender_document_org_tender_idx on licitaciones.tender_document (organization_id, tender_id, created_at desc);

-- Escritura: rol de escritura de la propia organizacion. Justificacion de seguridad: (a) el tender y el blob referenciados
-- deben pertenecer a la MISMA organizacion de la fila (sin esto un usuario autenticado podria enlazar el documento a una
-- convocatoria o archivo ajeno por PostgREST); (b) `uploaded_by` solo puede ser quien escribe. Sin policy de update ni de
-- delete: el documento es inmutable (una correccion es una version nueva), la bitacora del archivo no se reescribe.
create policy "escritura: roles de escritura suben documentos de bases" on licitaciones.tender_document for insert with check (
  licitaciones.can_write_org(organization_id)
  and (uploaded_by is null or uploaded_by = auth.uid())
  and exists (select 1 from licitaciones.tender t where t.id = tender_document.tender_id and t.organization_id = tender_document.organization_id)
  and (file_blob_id is null or exists (select 1 from licitaciones.file_blob b where b.id = tender_document.file_blob_id and b.organization_id = tender_document.organization_id))
);
-- GRANT a nivel columna: el escritor real solo inserta estas columnas (created_at queda con su default); nunca update/delete.
grant insert (id, organization_id, tender_id, document_type, storage_ref, title, filename, mime_type, file_blob_id, sha256, size_bytes, page_count,
              extraction_status, extraction_detail, extracted_pages, lineage_id, version, uploaded_by)
  on licitaciones.tender_document to authenticated;
grant insert on licitaciones.tender_document to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Matriz estable: requirement_item
-- ---------------------------------------------------------------------------------------------------------------
alter table licitaciones.requirement_item
  -- Clave estable de upsert (documento + tema + pagina/clausula + huella del texto): una re-extraccion actualiza la misma fila.
  add column if not exists stable_key text,
  -- "Retirado" reutiliza `invalidated_at` (ya excluido por todas las lecturas existentes) y suma la version de convocatoria.
  add column if not exists retired_in_version integer,
  add column if not exists assigned_to uuid references core.staff_user(id) on delete set null,
  -- Causa de desechamiento (REQ-101): si incumplir este requisito descalifica la propuesta.
  add column if not exists disqualifying boolean not null default false,
  -- Marca de edicion humana: una re-extraccion NUNCA pisa responsable/estado/asignacion/causa de una fila editada a mano.
  add column if not exists manually_edited_at timestamptz,
  add column if not exists manually_edited_by uuid references core.staff_user(id) on delete set null;

create unique index if not exists requirement_item_stable_key_uq on licitaciones.requirement_item (tender_id, stable_key)
  where stable_key is not null and invalidated_at is null;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Conflictos persistidos
-- ---------------------------------------------------------------------------------------------------------------
create table licitaciones.requirement_conflict (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  -- Huella del conflicto (tipo + tema + claves estables de los requisitos en disputa): re-extraer el mismo conflicto no
  -- lo duplica ni reabre uno ya resuelto; solo un conflicto con requisitos distintos es uno nuevo.
  conflict_key text not null,
  kind text not null check (kind in ('deadline_mismatch', 'obligatoriedad_mismatch', 'duplicate_ambiguous')),
  topic_key text,
  description text not null,
  item_ids uuid[] not null default '{}',
  status text not null default 'abierto' check (status in ('abierto', 'resuelto')),
  resolution_notes text,
  resolved_by uuid references core.staff_user(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tender_id, conflict_key),
  -- Resolver exige notas no vacias (no se cierra un conflicto en silencio).
  constraint requirement_conflict_resolucion_consistente check (
    (status = 'abierto' and resolved_at is null)
    or (status = 'resuelto' and resolved_at is not null and resolution_notes is not null and length(btrim(resolution_notes)) > 0)
  )
);
create index requirement_conflict_tender_idx on licitaciones.requirement_conflict (organization_id, tender_id, status);

alter table licitaciones.requirement_conflict enable row level security;
create policy "org ve sus conflictos de requisitos" on licitaciones.requirement_conflict for select using (licitaciones.can_access_org(organization_id));
-- Justificacion: detectar (insert) y resolver (update) son trabajo del rol de escritura de la propia organizacion; la
-- convocatoria debe ser de la misma organizacion; quien resuelve queda registrado y solo puede ser quien escribe
-- (`resolved_by = auth.uid()`, o null cuando la propia re-extraccion cierra un conflicto que ya no se detecta).
create policy "escritura: roles de escritura registran conflictos" on licitaciones.requirement_conflict for insert with check (
  licitaciones.can_write_org(organization_id)
  and exists (select 1 from licitaciones.tender t where t.id = requirement_conflict.tender_id and t.organization_id = requirement_conflict.organization_id)
);
create policy "escritura: roles de escritura resuelven conflictos" on licitaciones.requirement_conflict for update
  using (licitaciones.can_write_org(organization_id))
  with check (licitaciones.can_write_org(organization_id) and (resolved_by is null or resolved_by = auth.uid()));

revoke all on licitaciones.requirement_conflict from public, anon;
grant select on licitaciones.requirement_conflict to authenticated;
-- GRANT a nivel columna: las funciones reales solo escriben estas columnas; sin delete (el historial no se borra).
grant insert (id, organization_id, tender_id, conflict_key, kind, topic_key, description, item_ids, status) on licitaciones.requirement_conflict to authenticated;
grant update (description, item_ids, status, resolution_notes, resolved_by, resolved_at, updated_at) on licitaciones.requirement_conflict to authenticated;
grant select, insert, update on licitaciones.requirement_conflict to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Revision: comentarios por seccion o expediente (solo de adicion) y solicitud de revision
-- ---------------------------------------------------------------------------------------------------------------
create table licitaciones.proposal_comment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  proposal_id uuid not null references licitaciones.proposal(id) on delete cascade,
  scope text not null check (scope in ('seccion', 'expediente')),
  -- Misma convencion que `licitaciones.approval.scope_ref`: "expediente" o "seccion:<section_key>".
  scope_ref text not null,
  kind text not null default 'comentario' check (kind in ('comentario', 'solicitud_revision')),
  body text not null check (length(btrim(body)) between 1 and 4000),
  author_id uuid not null references core.staff_user(id) on delete restrict,
  author_role text not null,
  created_at timestamptz not null default now(),
  constraint proposal_comment_scope_ref_consistente check (
    (scope = 'expediente' and scope_ref = 'expediente') or (scope = 'seccion' and scope_ref like 'seccion:%')
  )
);
create index proposal_comment_proposal_idx on licitaciones.proposal_comment (organization_id, proposal_id, created_at);

alter table licitaciones.proposal_comment enable row level security;
create policy "org ve sus comentarios de revision" on licitaciones.proposal_comment for select using (licitaciones.can_access_org(organization_id));
-- Justificacion: comentar es del rol de escritura; el autor SIEMPRE es la sesion (`author_id = auth.uid()`, nadie comenta a
-- nombre de otro); la propuesta debe ser de la misma organizacion (sin cruce entre tenants). Solo de adicion: no hay policy
-- ni GRANT de update/delete (ni siquiera para service_role), asi el hilo de revision es un registro que no se reescribe.
create policy "escritura: roles de escritura comentan" on licitaciones.proposal_comment for insert with check (
  licitaciones.can_write_org(organization_id)
  and author_id = auth.uid()
  and exists (select 1 from licitaciones.proposal p where p.id = proposal_comment.proposal_id and p.organization_id = proposal_comment.organization_id)
);

revoke all on licitaciones.proposal_comment from public, anon;
grant select on licitaciones.proposal_comment to authenticated;
grant insert (id, organization_id, proposal_id, scope, scope_ref, kind, body, author_id, author_role) on licitaciones.proposal_comment to authenticated;
grant select, insert on licitaciones.proposal_comment to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Bitacora: nuevas acciones en tender_audit_log (la escribe solo la capa de aplicacion; el CHECK de 010 es cerrado)
-- ---------------------------------------------------------------------------------------------------------------
alter table licitaciones.tender_audit_log drop constraint tender_audit_log_action_check;
alter table licitaciones.tender_audit_log add constraint tender_audit_log_action_check
  check (action in (
    'tender.manual_upsert.created', 'tender.manual_upsert.updated', 'tender.version_recorded',
    'document.uploaded', 'requirements.extracted', 'requirement.edited', 'requirement.conflict_resolved', 'section.edited'
  ));
