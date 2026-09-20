-- Ejerce, contra Postgres REAL (no el repositorio en memoria, que nunca ejecuta SQL),
-- el SQL EXACTO de `packages/domain-despachos/src/postgres-repository.ts`
-- (`FISCAL_DEADLINE_COLUMNS`/`RECEIVABLE_COLUMNS` -- copiados aquí literales, no
-- reescritos de memoria) para las columnas `date` de despachos
-- (`fecha_limite`/`fecha_presentacion`/`fecha_vencimiento`). REQ-r6 punto 7: cierra el
-- hueco de test real que dejó PR #164 -- un typo en esa lista de columnas (o un
-- `select */returning *` que se cuele de nuevo en el futuro) solo se vería como error
-- real en producción; nada en la suite unitaria (100% repositorio en memoria) puede
-- detectarlo.
--
-- Corre bajo `service_role` (bypassrls) a propósito: lo que este archivo verifica es
-- la VALIDEZ y el TIPO DE RETORNO del SQL (columnas explícitas + `::text`), no
-- RLS/GRANT (eso ya lo cubren scripts/verify-outbox-grants/ y
-- scripts/verify-hoteles-sql-critico/ con el mismo patrón de sesión de staff real).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada aquí persiste,
-- salvo el fixture de organización/property/invoice de arriba (compartido, fuera de
-- cualquier begin/rollback, igual que verify-outbox-grants/assertions.sql).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000d0', 'despachos', 'Despacho de Prueba SC', 'despacho-verify-fechas')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d0', 'despachos', 'Sede principal')
on conflict do nothing;

insert into despachos.invoice (
  id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor,
  subtotal, total, iva, valido
) values (
  '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000d1',
  '11111111-1111-1111-1111-111111111111', 'I', 'CON950820K12', 'XAXX010101000', 1000, 1160, 160, true
)
on conflict do nothing;

\echo '=== 1. INSERT ... RETURNING fiscal_deadline con FISCAL_DEADLINE_COLUMNS (fecha_limite::text) -- copiado literal de createDeadline ==='
begin;
set local role service_role;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
  values ('00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000d1', 'ISR', '2026-01', '2026-01-01', 'alta')
  returning id, organization_id, property_id, tipo, periodo, fecha_limite::text as fecha_limite, prioridad, estado,
            fecha_presentacion::text as fecha_presentacion, comprobante_url, created_at;
rollback;

\echo '=== 2. SELECT fiscal_deadline con FISCAL_DEADLINE_COLUMNS -- fecha_limite debe venir como TEXTO YYYY-MM-DD, nunca timestamp ==='
begin;
set local role service_role;
insert into despachos.fiscal_deadline (id, organization_id, property_id, tipo, periodo, fecha_limite, fecha_presentacion, prioridad, estado)
  values ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000d1', 'IVA', '2026-01', '2026-01-17', '2026-01-15', 'media', 'completado');
select case when (fecha_limite::text ~ '^\d{4}-\d{2}-\d{2}$') then 1 else 0 end as fecha_limite_es_texto_yyyy_mm_dd_deberia_ser_1
  from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-0000000000d1' and id = '00000000-0000-0000-0000-0000000000d3';
rollback;

\echo '=== 3. SELECT fiscal_deadline con FISCAL_DEADLINE_COLUMNS -- fecha_presentacion debe venir como TEXTO YYYY-MM-DD, nunca timestamp ==='
begin;
set local role service_role;
insert into despachos.fiscal_deadline (id, organization_id, property_id, tipo, periodo, fecha_limite, fecha_presentacion, prioridad, estado)
  values ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000d1', 'IVA', '2026-01', '2026-01-17', '2026-01-15', 'media', 'completado');
select case when (fecha_presentacion::text ~ '^\d{4}-\d{2}-\d{2}$') then 1 else 0 end as fecha_presentacion_es_texto_yyyy_mm_dd_deberia_ser_1
  from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-0000000000d1' and id = '00000000-0000-0000-0000-0000000000d3';
rollback;

\echo '=== 4. UPDATE ... RETURNING (markDeadlineCompleted) con FISCAL_DEADLINE_COLUMNS -- fecha_presentacion recién escrita ==='
begin;
set local role service_role;
insert into despachos.fiscal_deadline (id, organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
  values ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000d1', 'DIOT', '2026-01', '2026-01-17', 'alta');
update despachos.fiscal_deadline
   set estado = 'completado', comprobante_url = coalesce(null, comprobante_url), fecha_presentacion = '2026-01-16'
 where id = '00000000-0000-0000-0000-0000000000d4'
 returning id, organization_id, property_id, tipo, periodo, fecha_limite::text as fecha_limite, prioridad, estado,
           fecha_presentacion::text as fecha_presentacion, comprobante_url, created_at;
rollback;

\echo '=== 5. INSERT ... RETURNING receivable con RECEIVABLE_COLUMNS (fecha_vencimiento::text) -- copiado literal de registerReceivable ==='
begin;
set local role service_role;
insert into despachos.receivable (organization_id, property_id, invoice_id, fecha_vencimiento)
  values ('00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', '2026-02-01')
  returning id, organization_id, property_id, invoice_id, fecha_vencimiento::text as fecha_vencimiento,
            monto_pagado, pagado_en, cliente_nombre, cliente_email, created_at;
rollback;

\echo '=== 6. SELECT receivable con RECEIVABLE_COLUMNS -- fecha_vencimiento debe venir como TEXTO YYYY-MM-DD, nunca timestamp ==='
begin;
set local role service_role;
insert into despachos.receivable (id, organization_id, property_id, invoice_id, fecha_vencimiento)
  values ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', '2026-03-15');
select case when (fecha_vencimiento::text ~ '^\d{4}-\d{2}-\d{2}$') then 1 else 0 end as fecha_vencimiento_es_texto_yyyy_mm_dd_deberia_ser_1
  from despachos.receivable where property_id = '00000000-0000-0000-0000-0000000000d1' and id = '00000000-0000-0000-0000-0000000000d5';
rollback;

\echo '=== 7. CANARIO NEGATIVO -- un typo real en el nombre de columna (fecha_limite_typo) SI falla contra Postgres real (nunca en el repositorio en memoria) ==='
begin;
set local role service_role;
select fecha_limite_typo::text as should_fail from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-0000000000d1';
rollback;
