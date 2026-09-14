-- Fase 10 hoteles (REQ-BO-010, P0/BP-024/BP-041/BP-071/H16-016/H16-017/H07-032/
-- H17-002/H04-023) — P&L en formato-resumen USALI ("Uniform System of Accounts for
-- the Lodging Industry") 12ª edición y punto de equilibrio dinámico.
--
-- Alcance real de "formato USALI 12ª edición" en este esquema: el Summary Operating
-- Statement (jerarquía Ingresos por departamento -> Utilidad departamental -> Gastos
-- no distribuidos -> GOP -> cuota de administración -> EBITDA -> gastos no operativos
-- -> Utilidad neta), NO los 11 Schedules departamentales completos del manual USALI
-- (eso exigiría un catálogo contable completo fuera de alcance de este sistema hoy).
-- Documentado explícitamente para no sobre-prometer, mismo criterio que el original
-- (`hoteles/packages/db/migrations/0115_pl_usali.sql`, comentario de cabecera).
--
-- Los INGRESOS por departamento YA existen en el esquema (`hoteles.charge.concept`,
-- 001_hoteles_schema.sql): 'hospedaje' -> Rooms, 'ab' -> Food & Beverage,
-- 'extras'/'otro' -> Otros Departamentos Operados, 'ajuste'/'descuento' se atribuyen a
-- Rooms (limitación conocida, mismo criterio que el original: la API de folios no
-- registra a qué departamento aplica un descuento/ajuste genérico -- ver
-- `apps/api/src/routes/verticals/hoteles/pl.ts`), 'reverso' se resuelve al
-- departamento del cargo original vía `reverses_charge_id`, y 'propina' se EXCLUYE
-- por completo (no es contraprestación del hotel, mismo criterio que folioEngine.ts
-- ya aplica para impuestos). Esta migración solo agrega lo que NO existe todavía: el
-- lado de GASTOS reales por departamento -- sin esto, cualquier P&L sería ingresos
-- reales contra costos inventados ("P&L de mentiras"), exactamente lo que el
-- original documentó como razón de NO implementarlo antes.
--
-- GAP REAL verificado contra el original: `packages/domain-hoteles` no tenía NINGÚN
-- archivo de P&L/USALI/forecast antes de esta fase (domain-hoteles/README.md lo
-- listaba explícitamente fuera de Fase 1, ninguna fase posterior lo retomó). Forecast
-- de 90 días y proyección de caja a 13 semanas quedan DELIBERADAMENTE fuera de esta
-- migración (dependen de un motor de forecast de series de tiempo que domain-hoteles
-- tampoco tiene portado todavía -- ver header de
-- `packages/domain-hoteles/src/pl/usaliPL.ts`).
--
-- Requiere: 001_hoteles_schema.sql (core.organization, core.property,
-- core.staff_user, core.membership, core.has_property_access).
-- Expand-only (mismo criterio que el resto de este monorepo): ninguna migración ya
-- aplicada se edita.

create type hoteles.usali_department as enum (
  -- Departamentos operados (tienen ingreso propio vía hoteles.charge.concept).
  'rooms',
  'food_beverage',
  'otros_departamentos',
  -- Gastos no distribuidos (Undistributed Operating Expenses, sin ingreso propio).
  'admin_general',
  'ventas_marketing',
  'operacion_mantenimiento',
  'utilities',
  -- Debajo de GOP.
  'cuota_administracion',
  'no_operativo'
);

create type hoteles.usali_expense_category as enum ('costo_ventas', 'nomina', 'otros_gastos');

create table hoteles.expense_entry (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  department hoteles.usali_department not null,
  category hoteles.usali_expense_category not null,
  description text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  expense_date date not null,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index expense_entry_property_date_idx on hoteles.expense_entry (property_id, expense_date);
create index expense_entry_property_department_date_idx on hoteles.expense_entry (property_id, department, expense_date);

alter table hoteles.expense_entry enable row level security;

-- Ver/registrar el lado de gastos del P&L es más sensible que un cargo de folio
-- (revela costos/nómina/márgenes del negocio, no solo un cobro al huésped) -- por eso
-- NO reutiliza `hoteles.can_access_money()` (que incluye frontdesk/reservations/fnb),
-- sino un rol propio más estricto (owner/gm/accountant), mismo criterio de
-- "destinatario correspondiente" que `hoteles.fraud_alert` (007) ya aplicó para datos
-- financieros sensibles. Mismo shape que `hoteles.can_access_money()`
-- (001_hoteles_schema.sql), acotando `m.vertical_role`.
create or replace function hoteles.can_access_pl(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'accountant')
  )
$$;

create policy "dinero_pl: staff con acceso ve gastos del P&L" on hoteles.expense_entry for select
  using (hoteles.can_access_pl(property_id));
create policy "dinero_pl: staff con acceso registra gastos del P&L" on hoteles.expense_entry for insert
  with check (hoteles.can_access_pl(property_id));
-- Sin policy de update/delete: un gasto registrado no se edita ni se borra -- se
-- corrige con una contrapartida nueva (misma disciplina append-only que
-- `hoteles.charge`, REQ-REC-004), evitando que el P&L de un periodo ya cerrado cambie
-- por debajo del reporte ya emitido al owner.

revoke all on hoteles.expense_entry from public, anon;
grant select, insert on hoteles.expense_entry to authenticated;
grant select, insert, update, delete on hoteles.expense_entry to service_role;
