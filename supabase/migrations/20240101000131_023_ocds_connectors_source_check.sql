-- Fase 9 — conectores OCDS reales de licitaciones VIGENTES (Nuevo León /
-- CDMX) + agregador comercial gateado por credenciales. Requiere:
-- 001_licitaciones_schema.sql..022_persistent_file_storage.sql.
--
-- Agrega 'nl_ocds', 'cdmx_ocds' y 'aggregator' a los valores permitidos de
-- `source_run.source` (CHECK ya extendido una vez en la migración 017 para
-- 'compras_mx_historico') -- sin esto, `recordSourceRun` para cualquiera de
-- estos 3 conectores nuevos (`packages/domain-licitaciones/src/connectors/
-- ocds/nl-ocds-connector.ts`, `.../cdmx-ocds-connector.ts`,
-- `.../aggregator.ts`) violaría el CHECK existente.
alter table licitaciones.source_run drop constraint source_run_source_check;
alter table licitaciones.source_run add constraint source_run_source_check
  check (source in ('manual', 'comprasmx', 'dof', 'ocds_shcp', 'pdn_s6', 'state_portal', 'compras_mx_historico', 'nl_ocds', 'cdmx_ocds', 'aggregator'));
