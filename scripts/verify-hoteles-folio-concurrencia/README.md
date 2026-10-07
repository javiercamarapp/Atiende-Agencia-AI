# verify-hoteles-folio-concurrencia (H-P3-01)

Verifica contra Postgres real que `packages/domain-hoteles/migrations/045_hoteles_folio_cierre_carrera.sql` cierra la
carrera "folio cerrado admite cargo/pago" y el cierre `saldo_cero` sin guarda de saldo.

- `assertions.sql` (16 escenarios, una conexion cada uno; lo auto-descubre `scripts/verify-real-postgres-ci/run-gate.mjs`
  en CI): camino normal, cargo/pago en folio cerrado (P0001 `folio_cerrado`), cierre `saldo_cero` con saldo (P0001
  `cierre_saldo_distinto_de_cero`), pagos no capturados, `cuenta_por_cobrar`, doble cierre, aislamiento entre folios,
  cross-tenant/anon (42501), folio inexistente, lista de night audit sin folio cerrado y revoke de las funciones de trigger.
- `run.sh` (local, opt-in; necesita `initdb`/`pg_ctl`/`psql`): corre lo anterior y ademas la concurrencia REAL, dos
  sesiones psql simultaneas, 20 repeticiones (`REPS=N`) de cargo + cierre, pago + cierre y cierre + cierre, con retardos
  aleatorios para barrer ambos ordenes de llegada.
- `VERIFY_SIN_MIGRACION=1 ./run.sh` omite la 045 para reproducir el defecto: sin ella las carreras dejan folios
  cerrados como `saldo_cero` con saldo distinto de cero (20/20 en cargo + cierre y 20/20 en pago + cierre).
