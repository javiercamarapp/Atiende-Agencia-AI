-- Migración 006 (hallazgo de auditoría, severidad ALTA — "despachos.invoice nunca
-- persiste la fecha real de emisión del CFDI"): la ingesta (`POST
-- /despachos/:propertyId/cfdi`, ver apps/api/src/routes/verticals/despachos/cfdi.ts)
-- SIEMPRE recibe `fecha` (fecha de emisión del CFDI) y ya la usaba para el bloqueo de
-- período cerrado (migración 003), pero nunca la persistía en `despachos.invoice` --
-- la única fecha que sobrevivía por invoice era `created_at` (fecha de INGESTA, no de
-- emisión del comprobante) o, indirectamente, `diot.proveedoresReportables[0].fecha`,
-- que SOLO existe para un CFDI tipo 'I' con subtotal>0 (ver
-- cfdi/reglas-fiscales-avanzadas.ts). Esto rompía 3 flujos reales que sí necesitan la
-- fecha real del comprobante:
--   - Conciliación bancaria (conciliacion.ts): conciliaba contra `created_at` de
--     ingesta -- un CFDI cargado días después del movimiento bancario real nunca
--     hacía match dentro de la tolerancia de días del motor de matching.
--   - DIOT (declaraciones.ts) y devolución de IVA (devolucion-iva.ts): el filtro por
--     período (`listInvoices({ periodo })`) resolvía contra ese mismo jsonb de DIOT --
--     cualquier CFDI que no fuera tipo 'I' con subtotal>0 (E/T/P/N, o un 'I' con
--     subtotal=0) desaparecía del período por completo en vez de aparecer con su
--     fecha real.
-- Esta migración agrega la columna real (NOT NULL, poblada por la propia ingesta de
-- aquí en adelante -- ver cfdi.ts, ahora exige `fecha` en el body) + el índice que
-- sostiene el filtro por (property, período) una vez que repository.ts deja de
-- resolverlo contra el jsonb de DIOT. El default `current_date` es solo la red de
-- seguridad de un ADD COLUMN NOT NULL sobre una tabla que ya pudiera tener filas --
-- el camino feliz (`repo.insertInvoice`) siempre manda la fecha real del CFDI
-- explícitamente, nunca depende del default.
alter table despachos.invoice
  add column fecha date not null default current_date;

create index invoice_fecha_idx on despachos.invoice (property_id, fecha);
