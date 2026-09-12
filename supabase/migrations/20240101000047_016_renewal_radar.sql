-- Fase 6 pieza 5 (REQ-055) — radar de renovaciones. `licitaciones.contract`
-- (migración 011) ya trae `end_date`/`contract_number` -- insumo directo del
-- radar (contrato con fecha de fin próxima -> alerta de renovación
-- probable). `renewal_alert` es un registro CONSULTABLE de la alerta, sin
-- canal de envío real (mismo criterio "honesto" que
-- `licitaciones.tender_change_notification`, Fase 5): el índice único
-- parcial evita alertar dos veces el MISMO umbral de antelación para el
-- MISMO contrato en escaneos repetidos.
-- Requiere: 011_contract_lifecycle.sql.

create table licitaciones.renewal_alert (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_id uuid not null references licitaciones.contract(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  predicted_date date not null,
  lead_days integer not null,
  confidence numeric(3, 2) not null,
  status text not null default 'pendiente' check (status in ('pendiente', 'reconocida')),
  acknowledged_at timestamptz,
  acknowledged_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index renewal_alert_contract_lead_idx on licitaciones.renewal_alert (organization_id, contract_id, lead_days);
create index renewal_alert_org_idx on licitaciones.renewal_alert (organization_id, created_at desc);

alter table licitaciones.renewal_alert enable row level security;
create policy "org ve sus alertas de renovación" on licitaciones.renewal_alert for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran alertas de renovación" on licitaciones.renewal_alert for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura reconocen alertas de renovación" on licitaciones.renewal_alert for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.renewal_alert from public, anon;
grant select, insert, update on licitaciones.renewal_alert to authenticated;
grant select, insert, update, delete on licitaciones.renewal_alert to service_role;
