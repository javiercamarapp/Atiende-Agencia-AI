-- Fix hallazgo de auditoría hoteles — reemisión de CFDI de hospedaje tras
-- cancelación quedaba bloqueada para siempre.
--
-- El índice único parcial de 006_cfdi_hospedaje.sql (`cfdi_emision_folio_hospedaje_unq
-- on hoteles.cfdi_emision (folio_id) where tipo = 'hospedaje'`) exigía A LO MÁS UN
-- CFDI de tipo 'hospedaje' por folio PARA SIEMPRE, sin importar su `status`. Eso
-- significa que una vez que ese único CFDI quedaba `cancelado`, ya no cabía otro:
-- tanto el endpoint (`POST .../folios/:folioId/cfdi` en cfdi.ts, que corta-circuita
-- devolviendo el existente sin llamar al PAC) como el `ON CONFLICT` de
-- `insertCfdiEmision` en postgres-repository.ts chocaban contra este índice y
-- devolvían/recreaban el mismo registro cancelado en vez de timbrar uno nuevo.
--
-- Verificación de la regla de negocio real: un CFDI cancelado SÍ debe poder
-- reemitirse con un folio fiscal (UUID) nuevo -- es la práctica estándar del SAT
-- tras cancelar por error de datos, cambio de receptor, etc. (motivos 01-04 en
-- MOTIVO_CANCELACION_LABELS, cfdi-client.ts). No hay ninguna razón de negocio para
-- bloquearlo de forma permanente -- este es el bug real, no una restricción
-- intencional.
--
-- Fix: el índice único ahora excluye los cancelados -- a lo más UN CFDI
-- 'hospedaje' VIGENTE (status <> 'cancelado') por folio a la vez, sin límite en
-- cuántos cancelados se acumulen en el historial de ese folio. El código de
-- aplicación (cfdi.ts, in-memory-repository.ts, postgres-repository.ts) y el panel
-- (Cfdi.tsx) se actualizaron en la misma rama para reflejar esta misma regla:
-- "existente" para efectos de idempotencia/UI significa "existente Y vigente".
drop index hoteles.cfdi_emision_folio_hospedaje_unq;
create unique index cfdi_emision_folio_hospedaje_unq on hoteles.cfdi_emision (folio_id)
  where tipo = 'hospedaje' and status <> 'cancelado';
