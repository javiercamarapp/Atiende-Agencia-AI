# verify-licitaciones-autopiloto

Verificacion contra Postgres REAL (RLS, GRANT, funciones `security definer` y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/039_licitaciones_autopiloto.sql` (paridad3 L-P3-08/09/11).

Cubre:

- `system_record_ingested_tender_version` / `system_latest_tender_version` (vigilante de la ingesta automatica): version
  linea base silenciosa, cambio con cascada de invalidacion de aprobaciones + notificacion de cambio, idempotencia por hash,
  cross-tenant (la convocatoria de otra organizacion se rechaza con 42501), usuario con sub rechazado (42501) y anon.
- `tenant_config.new_match_min_score`: owner/admin escribe solo a nivel columna, rango 0-100 (CHECK), viewer y otro tenant no.
- `new_match_notice` + `system_get_new_match_context` / `system_record_new_match` / `system_list_new_matches`: dedupe por
  organizacion y convocatoria, cross-tenant, RLS de lectura, escritura directa denegada, anon.
- `expediente_auditoria`: el staff de escritura registra/actualiza el estado del checklist; viewer y otro tenant no.

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-autopiloto/run.sh`.
