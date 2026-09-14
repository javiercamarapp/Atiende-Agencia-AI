-- Cuarta migración del esquema `despachos.*` (Fase 10) — cobranza
-- automatizada de cuentas por cobrar (puerto de
-- `b2b_ai/services/collections.py`/`collections_report.py`, ver
-- `domain-despachos/src/cobranza/`). Mismo patrón RLS que
-- 001_despachos_schema.sql/003_cierre_mensual_schema.sql
-- (`core.has_property_access`).
--
-- Nota de numeración: ver el comentario de cabecera de
-- 003_cierre_mensual_schema.sql sobre por qué "002" no existe en este
-- directorio (solo su espejo en supabase/migrations/) — esta migración
-- simplemente toma el siguiente número libre ("004").
--
-- GAP REAL VERIFICADO (auditoría previa a esta fase): `despachos.*` no tenía
-- ninguna tabla de cobranza — ni seguimiento de vencimiento por invoice, ni
-- historial de recordatorios. `despachos.invoice` (migración 001) YA
-- documentaba en su comentario de cabecera que "cobranza" leería de ahí
-- ("DIOT/conciliación/declaraciones/cobranza todo lee de aquí") — esta
-- migración cierra esa referencia pendiente.
--
-- Diseño deliberado: la fecha de vencimiento y el estado de pago NO se
-- agregan como columnas de `despachos.invoice` (que no las tiene, y el CFDI
-- en sí no trae "condiciones de pago" utilizables como vencimiento real) —
-- viven en una tabla `receivable` aparte, 1:1 opcional con el invoice. Así
-- ingerir un CFDI (flujo 1, ya estable desde Fase 1) nunca se acopla a si
-- ese invoice también es una cuenta por cobrar con cobranza activa.

-- `receivable` — una fila por invoice tipo 'I' al que se le arrancó el
-- reloj de cobranza (registrar `fecha_vencimiento` es la acción que crea la
-- fila; un invoice sin fila aquí simplemente no está bajo seguimiento de
-- cobranza). `pagado_en is null` = cuenta pendiente (la cartera vigente).
create table despachos.receivable (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  invoice_id uuid not null references despachos.invoice(id) on delete cascade,
  fecha_vencimiento date not null,
  monto_pagado numeric(14, 2) check (monto_pagado is null or monto_pagado >= 0),
  pagado_en timestamptz,
  created_at timestamptz not null default now(),
  -- Un mismo invoice nunca arranca el reloj de cobranza dos veces (mismo
  -- criterio de idempotencia que `invoice.unique (organization_id,
  -- folio_fiscal)`).
  unique (invoice_id),
  constraint receivable_pago_consistente check (
    (pagado_en is null and monto_pagado is null) or (pagado_en is not null)
  )
);
create index receivable_property_idx on despachos.receivable (property_id);
create index receivable_pendientes_idx on despachos.receivable (property_id, fecha_vencimiento) where pagado_en is null;

-- `collection_event` — auditoría de cada recordatorio generado (o respuesta
-- del deudor registrada vía `etapa = 'respuesta'`) — port de
-- `collection_events` del origen. El CONTENIDO del recordatorio (subject/
-- body/whatsapp) lo genera `construirRecordatorioCobranza` (puro, sin DB,
-- ver `cobranza/engine.ts`) y NUNCA se envía por esta vía — igual que el
-- origen Python ("NO envía mensajes reales"), esta tabla solo dice QUÉ
-- etapa/canal se generó y CUÁNDO, para que `scoreCobrabilidadCartera` lo
-- use como historial. Conectar esto a un canal de envío real
-- (`messaging_outbox`/`whatsapp-gateway`) es trabajo de una fase futura, no
-- construido aquí — ver README del vertical.
create table despachos.collection_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  receivable_id uuid not null references despachos.receivable(id) on delete cascade,
  etapa text not null check (etapa in ('pre_vencimiento', 'vencimiento', 'recordatorio_formal', 'segundo_recordatorio', 'escalamiento', 'respuesta')),
  canal text not null check (canal in ('email', 'whatsapp')),
  respuesta text,
  created_at timestamptz not null default now()
);
create index collection_event_receivable_idx on despachos.collection_event (receivable_id);
create index collection_event_property_idx on despachos.collection_event (property_id);

alter table despachos.receivable enable row level security;
alter table despachos.collection_event enable row level security;

create policy "staff ve cuentas por cobrar de su property" on despachos.receivable for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta cuentas por cobrar de su property" on despachos.receivable for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza cuentas por cobrar de su property" on despachos.receivable for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve eventos de cobranza de su property" on despachos.collection_event for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta eventos de cobranza de su property" on despachos.collection_event for insert
  with check (core.has_property_access(auth.uid(), property_id));

grant select, insert, update on despachos.receivable to authenticated;
grant select, insert on despachos.collection_event to authenticated;
grant select, insert, update, delete on despachos.receivable to service_role;
grant select, insert, update, delete on despachos.collection_event to service_role;
