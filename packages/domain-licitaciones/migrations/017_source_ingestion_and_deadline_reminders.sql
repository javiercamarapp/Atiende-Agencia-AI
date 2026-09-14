-- Fase 8 — ingesta automática real (compras_mx_historico) + recordatorios
-- automáticos de plazo. Requiere: 001_licitaciones_schema.sql..016_renewal_radar.sql.
--
-- Contexto (ver auditoría que originó esta fase): `apps/worker/src` no tenía
-- NINGUNA referencia a licitaciones y `connector-registry.ts` documentaba sus
-- 5 conectores automatizados como PLACEHOLDERS deliberados, sin
-- `discover()`/`fetchDetail()` real. Esta migración habilita el primer
-- conector automatizado REAL del vertical
-- (`packages/domain-licitaciones/src/connectors/compras-mx-historico.ts`,
-- dataset histórico de contratos de ComprasMX vía datos.gob.mx) y persiste
-- recordatorios de vencimiento próximo (equivalente honesto de
-- `enqueueUpcomingDeadlineReminders` del repo origen, adaptado al patrón
-- "registro consultable sin canal de envío real" que ya usa
-- `tender_change_notification`, ver migración 010).

-- ---------------------------------------------------------------------------
-- Pieza 1: agrega 'compras_mx_historico' a los valores permitidos de
-- `source_run.source` (migración 010) -- sin esto, `recordSourceRun` para el
-- nuevo conector violaría el CHECK existente.
-- ---------------------------------------------------------------------------
alter table licitaciones.source_run drop constraint source_run_source_check;
alter table licitaciones.source_run add constraint source_run_source_check
  check (source in ('manual', 'comprasmx', 'dof', 'ocds_shcp', 'pdn_s6', 'state_portal', 'compras_mx_historico'));

-- ---------------------------------------------------------------------------
-- Pieza 2: tender_deadline_reminder -- recordatorio persistido de un
-- vencimiento (`tender.submission_deadline`) próximo. Mismo criterio
-- "honesto" que `tender_change_notification` (migración 010): SIN canal de
-- envío real (email/SMS/WhatsApp, fuera de alcance de esta fase) -- un
-- registro consultable/reconocible, nunca se finge una integración de envío
-- que no existe. Deduplicado por (tender_id, deadline_date) -- reescanear
-- dentro de la misma ventana de anticipación nunca duplica un recordatorio ya
-- emitido para el mismo (convocatoria, día calendario de vencimiento), mismo
-- criterio que `enqueueUpcomingDeadlineReminders` del repo origen
-- (`vencimiento:${tenderId}:${dedupeDate}`).
-- ---------------------------------------------------------------------------
create table licitaciones.tender_deadline_reminder (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  submission_deadline timestamptz not null,
  -- Fecha calendario (no hora) del vencimiento -- la clave de dedupe real (evita re-encolar en cada corrida del mismo día).
  deadline_date date not null,
  days_remaining integer not null,
  message text not null,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references core.staff_user(id) on delete set null,
  unique (tender_id, deadline_date)
);
create index tender_deadline_reminder_org_idx on licitaciones.tender_deadline_reminder (organization_id, created_at desc);
create index tender_deadline_reminder_tender_idx on licitaciones.tender_deadline_reminder (organization_id, tender_id, created_at desc);

alter table licitaciones.tender_deadline_reminder enable row level security;
create policy "org ve sus recordatorios de vencimiento" on licitaciones.tender_deadline_reminder for select using (licitaciones.can_access_org(organization_id));
-- Escritura: un recordatorio lo genera el barrido interno del worker
-- (gateado por secreto compartido, sin sesión de usuario real -- mismo
-- criterio que `citasRemindersRoutes`/`hotelesNightAuditRoutes`), así que la
-- policy de INSERT se basa en `can_write_org` (igual que `source_run`,
-- migración 010) en vez de exigir una sesión de `staff_user` autenticada.
create policy "escritura: roles de escritura registran recordatorios de vencimiento" on licitaciones.tender_deadline_reminder for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura reconocen recordatorios de vencimiento" on licitaciones.tender_deadline_reminder for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.tender_deadline_reminder from public, anon;
grant select on licitaciones.tender_deadline_reminder to authenticated;
grant insert, update on licitaciones.tender_deadline_reminder to authenticated;
grant select, insert, update, delete on licitaciones.tender_deadline_reminder to service_role;
