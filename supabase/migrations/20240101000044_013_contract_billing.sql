-- Fase 6 pieza 1, ítem 2 (REQ-051 "agente de cobranza") — seguimiento
-- determinista de pagos pendientes contra el contrato. `amount`/montos en
-- `numeric` (nunca float) -- la aplicación siempre opera en `DecimalString`/
-- centavos vía `domain-licitaciones/src/money.ts` antes de persistir o leer
-- esta columna. `due_date` se calcula SIEMPRE server-side
-- (`contract-billing.ts::computePaymentDueDate`, Art. 73 LAASSP, 17 días
-- hábiles) al insertar -- nunca lo declara el cliente ni un LLM.
-- Requiere: 011_contract_lifecycle.sql.

create table licitaciones.contract_invoice (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_id uuid not null references licitaciones.contract(id) on delete cascade,
  concepto text not null,
  amount numeric(14, 2) not null check (amount >= 0),
  invoice_verified_on date not null,
  due_date date not null,
  legal_reference text not null,
  paid_at timestamptz,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index contract_invoice_contract_idx on licitaciones.contract_invoice (organization_id, contract_id);
create index contract_invoice_due_date_idx on licitaciones.contract_invoice (organization_id, due_date) where paid_at is null;

alter table licitaciones.contract_invoice enable row level security;
create policy "org ve las facturas de sus contratos" on licitaciones.contract_invoice for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran facturas" on licitaciones.contract_invoice for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura marcan facturas como pagadas" on licitaciones.contract_invoice for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.contract_invoice from public, anon;
grant select, insert, update on licitaciones.contract_invoice to authenticated;
grant select, insert, update, delete on licitaciones.contract_invoice to service_role;
