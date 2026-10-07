# verify-restaurantes-ajustes-agente

Verificación, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/055_ajustes_agente_modelo_voz_fondo.sql`
(espejo: `supabase/migrations/20240101000330_055_ajustes_agente_modelo_voz_fondo.sql`): ajustes del agente por
organización (modelo y temperatura de WhatsApp, modelo de la cascada de voz, temperatura, ritmo y estilo de habla y
sonido de fondo opcional). El repositorio en memoria nunca aplica RLS, GRANT ni `auth.uid()`, así que no podría detectar
un hueco de este tipo.

## Qué demuestra (29 escenarios)

- **A. Lectura:** owner/admin de la organización y la sesión de SISTEMA (`auth.uid()` NULL: webhook de WhatsApp y
  servicio de llamadas) ven la fila; staff y repartidor no; otra organización (cross-tenant) no; `anon` ni siquiera SELECT.
- **B. Escritura:** solo owner/admin de SU organización (upsert y update); staff, repartidor, otra organización, sesión de
  sistema y `anon` rechazados; `updated_by` debe ser quien escribe (sin suplantación); `organization_id` no cambia
  (GRANT por columna) y no hay DELETE.
- **C. CHECK por columna:** formato del id de modelo, temperatura 0..1, ritmo y estilo de listas cerradas, volumen del
  fondo 0..20 (el fondo nunca tapa la voz); una organización nueva nace con el fondo apagado y sin modelo propio.
- **D. Base sin migrar:** con la tabla eliminada dentro de la transacción, SQLSTATE 42P01 se recupera con SAVEPOINT /
  ROLLBACK TO SAVEPOINT (lo que hace `runWithSavepointFallback`) y, sin SAVEPOINT, la transacción queda abortada (25P02).

## Cómo correrlo

- Local: `scripts/verify-restaurantes-ajustes-agente/run.sh` (requiere `initdb`/`pg_ctl`/`psql`; con el semáforo:
  `bash /Users/.../atiende-loop/heavy.sh scripts/verify-restaurantes-ajustes-agente/run.sh`).
- CI: lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs` (job `postgres-real-gate`).
