# verify-restaurantes-voz-seguridad

Verificación, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/026_voz_secretos_sucursal_y_estado_pedido.sql`
(secretos de voz por sucursal, estado del pedido en el servidor y bitácora de voz).
El repositorio en memoria nunca aplica RLS, GRANT ni `auth.uid()`, así que no podría
detectar un hueco de este tipo.

## Qué demuestra (44 escenarios)

- **A. `verify_voice_branch_secret` (solo-sistema):** coincide solo dentro de SU organización
  (el mismo secreto contra otra organización da NULL); el secreto anterior vale solo dentro de
  la ventana de gracia; un staff autenticado y `anon` son rechazados.
- **B. `rotate_voice_branch_secret` (staff):** solo owner/admin de la organización, solo sobre
  sucursales de esa organización; staff, repartidor, otra organización, sucursal ajena, sesión de
  sistema, hash inválido y `anon` son rechazados.
- **C. `voice_branch_secret`:** ni `authenticated` ni `anon` leen ni escriben la tabla (ni el hash);
  un mismo hash no puede asignarse a dos sucursales.
- **D. `order_flow_state` (solo-sistema):** crear con `expected=0`, avanzar con la versión correcta,
  conflicto con versión vieja, un estado vencido se lee como "sin estado" conservando su versión,
  aislamiento entre organizaciones, CHECK de estado, staff y `anon` rechazados, tabla no legible.
- **E. `voice_tool_audit`:** escritura solo-sistema, teléfono solo como sha256 (un número en claro
  viola el CHECK), truncado del detalle, append-only (UPDATE/DELETE bloqueados incluso para el
  superusuario), lectura solo owner/admin de la organización (sin lectura cross-tenant ni `anon`).
- **F. Base sin migrar:** con la función eliminada dentro de la transacción, SQLSTATE 42883 se
  recupera con SAVEPOINT / ROLLBACK TO SAVEPOINT (lo que hace `runWithSavepointFallback`) y, sin
  SAVEPOINT, la transacción queda abortada (25P02).

## Cómo correrlo

- Local: `scripts/verify-restaurantes-voz-seguridad/run.sh` (requiere `initdb`/`pg_ctl`/`psql`).
- CI: lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs` (job `postgres-real-gate`).
