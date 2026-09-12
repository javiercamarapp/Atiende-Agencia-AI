-- Fase 5 — andamiaje de ingesta (REQ-004/005/146..150) + historial de
-- versiones de convocatoria con cascada de invalidación (REQ-017/041/151..
-- 155). Requiere: 001_licitaciones_schema.sql..009_company_capabilities_experience_signers.sql.
--
-- Contexto (igual que 007_matching_profile.sql): B-02 (portales oficiales
-- bloqueados por reCAPTCHA/bot-detection) sigue sin resolverse -- ninguna
-- tabla de aquí depende de una ingesta automática real. `source_run` registra
-- corridas del ÚNICO conector real hoy ("manual", ver
-- domain-licitaciones/src/connector-registry.ts) con el mismo esquema que
-- sostendría un conector automatizado futuro, para no requerir otra
-- migración cuando se enchufe uno.

-- ---------------------------------------------------------------------------
-- Pieza 1: source_run (REQ-146/147/148/149) -- historial de corridas de
-- ingesta, con estado explícito (nunca "silencio == cero oportunidades").
-- ---------------------------------------------------------------------------
create table licitaciones.source_run (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  source text not null check (source in ('manual', 'comprasmx', 'dof', 'ocds_shcp', 'pdn_s6', 'state_portal')),
  state text not null check (state in ('ok', 'down', 'captcha_detected', 'interface_changed', 'permission_missing', 'rate_limited', 'not_configured')),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  http_status integer,
  response_hash text,
  message text not null,
  coverage_expected integer,
  coverage_obtained integer,
  correlation_id text,
  created_at timestamptz not null default now()
);
create index source_run_org_source_idx on licitaciones.source_run (organization_id, source, finished_at desc);

alter table licitaciones.source_run enable row level security;
create policy "org ve sus corridas de ingesta" on licitaciones.source_run for select using (licitaciones.can_access_org(organization_id));
-- Escritura: registrar una corrida es una acción de sistema disparada por un
-- flujo de escritura ya autorizado (p. ej. `upsertTenderManual`) -- mismo
-- criterio de defensa en profundidad que `tender_audit_log`/`approval_change`.
create policy "escritura: roles de escritura registran corridas de ingesta" on licitaciones.source_run for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.source_run from public, anon;
grant select on licitaciones.source_run to authenticated;
grant insert on licitaciones.source_run to authenticated;
grant select, insert, update, delete on licitaciones.source_run to service_role;

-- ---------------------------------------------------------------------------
-- Pieza 2: tender_version (REQ-017/041/151/152/153/154) -- historial
-- COMPLETO de versiones de convocatoria (bases + requisitos vigentes al
-- momento), con el diff estructurado contra la versión anterior ya calculado
-- y persistido (nunca se recalcula "a mano" contra texto plano). Mismo
-- patrón que `proposal_version` (005_proposal_version_registry.sql): fila
-- nueva únicamente cuando el hash del snapshot CAMBIA respecto de la última
-- versión registrada.
-- ---------------------------------------------------------------------------
create table licitaciones.tender_version (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  version integer not null,
  hash text not null,
  -- `TenderVersionSnapshot`: { fields: TenderFieldSnapshot, requirements: RequirementSnapshot[] }.
  snapshot jsonb not null,
  -- `TenderVersionDiff` contra la versión anterior (o "todo nuevo" si es la versión 1).
  diff jsonb not null,
  created_at timestamptz not null default now(),
  unique (tender_id, version)
);
create index tender_version_tender_idx on licitaciones.tender_version (organization_id, tender_id, version desc);

alter table licitaciones.tender_version enable row level security;
create policy "org ve el historial de versiones de sus convocatorias" on licitaciones.tender_version for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran versiones de convocatoria" on licitaciones.tender_version for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.tender_version from public, anon;
grant select on licitaciones.tender_version to authenticated;
grant insert on licitaciones.tender_version to authenticated;
grant select, insert, update, delete on licitaciones.tender_version to service_role;

-- ---------------------------------------------------------------------------
-- Pieza 3: tender_change_notification (REQ-151/155) -- notificación
-- inmediata de una convocatoria nueva o de un cambio detectado, dirigida a
-- los roles responsables (WRITE_ROLES). Sin canal de envío real (email/SMS,
-- fuera de alcance) -- registro consultable/reconocible, mismo criterio
-- "honesto" que el resto del backoffice de licitaciones (nunca se finge una
-- integración de envío que no existe).
-- ---------------------------------------------------------------------------
create table licitaciones.tender_change_notification (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  tender_version integer not null,
  reason text not null,
  changed_field_names text[] not null default '{}',
  affected_section_keys text[] not null default '{}',
  notified_roles text[] not null default '{}',
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references core.staff_user(id) on delete set null
);
create index tender_change_notification_org_idx on licitaciones.tender_change_notification (organization_id, created_at desc);
create index tender_change_notification_tender_idx on licitaciones.tender_change_notification (organization_id, tender_id, created_at desc);

alter table licitaciones.tender_change_notification enable row level security;
create policy "org ve sus notificaciones de cambio de convocatoria" on licitaciones.tender_change_notification for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran notificaciones" on licitaciones.tender_change_notification for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura reconocen notificaciones" on licitaciones.tender_change_notification for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.tender_change_notification from public, anon;
grant select on licitaciones.tender_change_notification to authenticated;
grant insert, update on licitaciones.tender_change_notification to authenticated;
grant select, insert, update, delete on licitaciones.tender_change_notification to service_role;

-- ---------------------------------------------------------------------------
-- Pieza 4: nueva acción de auditoría -- `recordTenderVersion` deja un rastro
-- en `tender_audit_log` (007_matching_profile.sql) de quién disparó la
-- operación (alta manual o re-extracción de requisitos) que produjo cada
-- versión, reutilizando la tabla existente en vez de inventar una nueva.
-- ---------------------------------------------------------------------------
alter table licitaciones.tender_audit_log drop constraint tender_audit_log_action_check;
alter table licitaciones.tender_audit_log add constraint tender_audit_log_action_check
  check (action in ('tender.manual_upsert.created', 'tender.manual_upsert.updated', 'tender.version_recorded'));
