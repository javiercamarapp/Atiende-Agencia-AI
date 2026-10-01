# verify-rentas-ical-sync-lease

Verificación contra Postgres real de
`packages/domain-rentas/migrations/024_rentas_ical_sync_lease_backoff_bitacora.sql`
(Rn-01: sync iCal como lote idempotente con claim/lease por feed, backoff por feed
fallido, bitácora/alertas del sync y resolución de conflictos de calendario).

Se auto-descubre en CI (`scripts/verify-real-postgres-ci/run-gate.mjs`, job
`postgres-real-gate`); a mano: `scripts/verify-rentas-ical-sync-lease/run.sh`
(requiere `initdb`/`pg_ctl`/`psql`).

## Qué cubre (43 escenarios en `assertions.sql`)

- A. claim/lease (1-11): la sesión de sistema reclama; un segundo claim no entrega el
  mismo feed; `p_limite`; staff y anon rechazados; lease expirado reclamable; lease
  vigente no reclamable; liberar solo con el token vigente; espaciamiento mínimo.
- B. backoff (12-15): tabla de la función pura, feed fallido fuera de la cola, éxito limpia.
- C. bitácora (16-29): solo el sistema escribe (tenant derivado del feed), cross-tenant,
  atender una alerta una sola vez y a nombre propio, GRANT por columna, append-only, anon.
- D. GRANT por columna en `canal_feed_externo` (30-35): el staff ya no escribe las columnas
  de lease; conectar/reconectar y el persistFeedSyncState del sistema siguen funcionando.
- E. conflictos (36-43): el staff de la property resuelve (una vez, a nombre propio);
  otra organización, la sesión de sistema y anon no.

## Qué NO cubre

- La concurrencia real de dos conexiones simultáneas sobre `for update skip locked`
  (cada escenario corre en una sola transacción); se comprobó aparte a mano con dos
  sesiones psql y se describe en el PR.
- La lógica TypeScript: eso lo cubren las pruebas de `@atiende/domain-rentas` y `apps/api`.
