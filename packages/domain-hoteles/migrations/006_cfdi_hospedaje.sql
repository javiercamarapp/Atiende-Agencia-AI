-- Fase 5 hoteles (H5, REQ-BO-001/002) — CFDI 4.0 de hospedaje. Port de
-- hoteles/packages/db/migrations/0032_cfdi_emision.sql, adaptado al esquema real de
-- atiende-fusion: `organization_id`/`property_id` (no `tenant_id`/`hotel_id` del
-- original) y `hoteles.can_access_money()` ya existente desde
-- migrations/001_hoteles_schema.sql (no se reinventa un helper de rol nuevo).
--
-- Requiere: 001_hoteles_schema.sql ya aplicada (hoteles.folio, hoteles.payment,
-- hoteles.tax_config, hoteles.can_access_money()).
--
-- El motor de reglas fiscales (`@atiende/domain-hoteles::validarCfdiHospedaje`,
-- `computeCfdiHospedajeBreakdown`) NUNCA vive en SQL — esta migración solo declara
-- dónde se guarda el resultado del timbrado (vía `@atiende/mcp-cfdi::CfdiPort`) y la
-- configuración fiscal de hospedaje que ese motor necesita por property.

-- ---------------------------------------------------------------------------
-- 1) Configuración fiscal de hospedaje — ADITIVO sobre hoteles.tax_config
--    (expand-only, mismo criterio que migrations/005_reservas_estado.sql): DSA
--    (Derecho de Saneamiento Ambiental, monto fijo por cuarto-noche, varía por
--    municipio) y el RFC emisor del hotel, SIN los cuales no se puede timbrar
--    ningún CFDI de hospedaje.
-- ---------------------------------------------------------------------------
alter table hoteles.tax_config
  add column dsa_per_night numeric(10, 2) not null default 0 check (dsa_per_night >= 0),
  add column rfc_emisor text;

-- ---------------------------------------------------------------------------
-- 2) Registro de emisiones CFDI de hospedaje sobre el `CfdiPort` de
--    `@atiende/mcp-cfdi` — esta tabla NO reimplementa el puerto, solo guarda el
--    resultado que devuelve con el estado de dominio (timbrado/cancelado) y el
--    desglose fiscal aplicado al folio.
-- ---------------------------------------------------------------------------
create table hoteles.cfdi_emision (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  folio_id uuid not null references hoteles.folio(id) on delete restrict,
  tipo text not null check (tipo in ('hospedaje', 'pago')),
  uuid_fiscal uuid,
  status text not null check (status in ('pendiente', 'timbrado', 'en_proceso_cancelacion', 'cancelado', 'rechazado')),
  pac text,
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  iva numeric(12, 2) not null default 0 check (iva >= 0),
  ish_tasa numeric(6, 4) not null default 0 check (ish_tasa >= 0),
  ish_monto numeric(12, 2) not null default 0 check (ish_monto >= 0),
  dsa_monto numeric(12, 2) not null default 0 check (dsa_monto >= 0),
  total numeric(12, 2) not null check (total >= 0),
  rfc_receptor text not null,
  uso_cfdi text not null,
  metodo_pago text not null,
  es_extranjero boolean not null default false,
  es_global boolean not null default false,
  es_no_show boolean not null default false,
  -- REQ-BO-001: CfdiRelacionados tipo 07 (aplicación de anticipo) — la relación se
  -- valida en `validarCfdiHospedaje()` ANTES de llegar aquí; esta columna solo
  -- persiste el UUID de nuestro propio `cfdi_emision` de anticipo.
  related_cfdi_id uuid references hoteles.cfdi_emision(id) on delete set null,
  payment_id uuid references hoteles.payment(id) on delete set null,
  created_at timestamptz not null default now(),
  canceled_at timestamptz
);
create index cfdi_emision_folio_idx on hoteles.cfdi_emision (folio_id);
create index cfdi_emision_property_idx on hoteles.cfdi_emision (organization_id, property_id);
-- Idempotencia a nivel de aplicación (REQ-BO-002): a lo más UN CFDI de tipo
-- 'hospedaje' por folio, y a lo más UNO de tipo 'pago' por pago — el endpoint
-- verifica esto ANTES de llamar al `CfdiPort`, este índice es la última línea de
-- defensa contra una carrera que lo intentara dos veces.
create unique index cfdi_emision_folio_hospedaje_unq on hoteles.cfdi_emision (folio_id)
  where tipo = 'hospedaje';
create unique index cfdi_emision_payment_unq on hoteles.cfdi_emision (payment_id)
  where tipo = 'pago';

alter table hoteles.cfdi_emision enable row level security;

create policy "dinero: staff con acceso ve cfdi de hospedaje" on hoteles.cfdi_emision for select
  using (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso inserta cfdi de hospedaje" on hoteles.cfdi_emision for insert
  with check (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso actualiza cfdi de hospedaje" on hoteles.cfdi_emision for update
  using (hoteles.can_access_money(property_id)) with check (hoteles.can_access_money(property_id));

revoke all on hoteles.cfdi_emision from public, anon;
grant select, insert, update on hoteles.cfdi_emision to authenticated;
grant select, insert, update, delete on hoteles.cfdi_emision to service_role;
