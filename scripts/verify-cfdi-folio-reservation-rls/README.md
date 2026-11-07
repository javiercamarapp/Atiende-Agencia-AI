# verify-cfdi-folio-reservation-rls

Verifica contra Postgres real `packages/mcp-servers/cfdi/migrations/002_folio_stamp_reservation_rls.sql`
(espejo `supabase/migrations/20240101000630_002_folio_stamp_reservation_rls.sql`).

## Qué cambia la migración

`mcp_cfdi.folio_stamp_reservation` era la única tabla de aplicación sin RLS y conservaba DML para
`authenticated`. Su único usuario es `ProductionCfdiFolioReservationStore`
(`apps/api/src/production/cfdi-folio-reservation-store.ts`), siempre con
`engine.withAppSession({ userId: null })`: rol `authenticated` y `auth.uid()` nulo (sesión de sistema).
El GRANT no se puede revocar (la sesión de sistema también es `authenticated`), así que se activa RLS con
una sola policy `for all to authenticated using (auth.uid() is null) with check (auth.uid() is null)`.

## Escenarios (`assertions.sql`)

| # | Qué comprueba | Esperado |
|---|---|---|
| 1 | RLS activa en la tabla | 1 |
| 2–5 | Sesión de sistema: `reserve()` (insert … on conflict … returning), lectura, `complete()`, `fail()` | 1 fila cada uno |
| 6 | Usuario con `auth.uid()` (staff de cualquier tenant) lee | 0 filas |
| 7 | Usuario inserta | ERROR (violación de RLS) |
| 8–9 | Usuario actualiza / borra una reserva existente | 0 filas |
| 10 | `anon` lee | ERROR (sin GRANT) |
| 11 | Trinquete: ninguna tabla de aplicación nueva sin RLS | 0 |

Con `FOLIO_RLS_SKIP_FIX=1 ./run.sh` (omite la migración) fallan 1, 6, 7, 8, 9 y 11: el usuario lee, inserta,
actualiza y borra reservas ajenas.

## Deriva conocida (escenario 11)

Aplicando solo las migraciones del repo quedan sin RLS dos catálogos estáticos sin columnas de tenant,
con solo `GRANT SELECT` a `authenticated`: `hoteles.reservation_status_transition` y `rentas.canal`.
En producción ambos ya tienen RLS y una policy de lectura aplicadas fuera de migración. El escenario 11 los
excluye por nombre; cualquier tabla nueva sin RLS lo hace fallar.

## Cómo correrlo

- CI: lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs` (job `postgres-real-gate`).
- Local: `scripts/verify-cfdi-folio-reservation-rls/run.sh` (requiere `initdb`, `pg_ctl` y `psql`).
