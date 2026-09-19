# verify-crons-transaccion-por-unidad

Demuestra, contra Postgres **real** (nunca el repositorio en memoria, que no es
transaccional -- ver `apps/worker/tests/support/fake-transactional-engine.ts`
para la reproducción del mismo bug a nivel de test unitario), el **mecanismo
exacto** detrás del hallazgo de auditoría a1b:

- **#1 (ALTA)**: `apps/worker/src/jobs/hoteles/night-audit.ts::runNightAuditSweep`
- **#2 (MEDIA)**: `apps/worker/src/jobs/despachos/cobranza-reminders.ts::runCobranzaReminderSweep`
  y `apps/worker/src/jobs/licitaciones/alert-notifications.ts::runAlertNotificationSweep`
- Más `apps/api/src/routes/verticals/citas/reminders.ts` y
  `apps/api/src/routes/verticals/rentas/ical-sync-cron.ts` (mismo patrón,
  encontrado en la búsqueda del punto 4 de la tarea)
- Corrección posterior (revisor independiente, mismo PR): `packages/domain-rentas/src/checkin-reminders.ts::runRecordatorioCheckInCore`
  (el cuerpo original de este PR afirmaba, FALSO, que este cron "no requiere
  el fix"), `apps/worker/src/jobs/licitaciones/deadline-reminders.ts::runDeadlineReminderSweep`
  y `apps/worker/src/jobs/licitaciones/discover-tenders.ts::runDiscoverTendersSweep`
  (transacción por FUENTE, no solo por organización -- ver el comentario de
  cabecera de ese archivo)

Todos compartían el mismo defecto: **una sola transacción de Postgres para
TODO el barrido** (`engine.withAppSession`) + `try`/`catch` **por unidad**
(property/organización/feed) **sin SAVEPOINT**. Un error SQL real en una
unidad deja esa transacción **ABORTADA** (`25P02`); las unidades siguientes
fallan en cascada con ese error engañoso, y el `COMMIT` final -- sobre una
transacción abortada -- devuelve el tag `ROLLBACK` **sin lanzar** (comportamiento
documentado de Postgres, reproducido idéntico por el driver `pg` que usa
`packages/db/src/managed-postgres-engine.ts`). Resultado: un error real en
**una sola** unidad revierte en silencio el trabajo de **todas**, la ruta
responde `200`/`ok:true` (antes de este PR), y el latido de salud queda `ok`.

Este script **no depende de ninguna migración de negocio** de hoteles/
despachos/licitaciones -- el mecanismo que prueba es una propiedad de
Postgres/del patrón de transacciones, no de una tabla de vertical concreta.
Usa un schema propio (`demo`, ver `bootstrap.sql`) con una sola tabla,
`demo.unit_result`, para comparar dentro de la MISMA base efímera:

- **Escenario 1** ("antes"): reconstruye el patrón pre-fix -- 1 transacción
  para 3 unidades A/B/C, B dispara un error SQL real (`select 1/0`, simula
  P0001/57014/40P01 del hallazgo real). C falla en cascada con `25P02`. El
  `COMMIT` final devuelve `ROLLBACK` sin lanzar.
- **Escenario 2**: verifica que, tras el escenario 1, **0 filas** persisten --
  ni A (que "ya había cerrado bien"), ni C.
- **Escenario 3** ("después", el patrón real de este PR): 3 transacciones
  **separadas**, una por unidad. B falla en la SUYA (mismo error SQL real).
- **Escenario 4**: verifica que, tras el escenario 3, **A y C SÍ persisten**
  (2 filas) -- solo B se perdió, y solo B se reportaría como fallo.
- **Escenario 5**: control -- B nunca persiste en ningún patrón (consistente
  con que su propia sentencia siempre fue la que falló).

Ver el comentario de cabecera de `assertions.sql` para la nota técnica sobre
por qué el archivo desactiva `ON_ERROR_STOP` de `psql` momentáneamente
(reproduce que el driver `pg` real nunca aborta el proceso Node por un error
de sentencia, solo relanza hacia el `catch` de JS) y por qué el `ROLLBACK`
interno del escenario 3 va en MAYÚSCULAS (evita que el parser del gate de CI
confunda ese rollback interno con el cierre del bloque del escenario).

## Cómo correrlo

```
scripts/verify-crons-transaccion-por-unidad/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente --
`brew install postgresql`). Arranca un cluster Postgres efímero en un puerto
dedicado, aplica el mock mínimo de plataforma + las migraciones reales +
`post-migrations.sql`, corre los 5 escenarios de `assertions.sql`, y apaga/
borra el cluster al salir -- no toca ningún Postgres existente ni dato real.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`) corre
en CI automáticamente, igual que los demás `scripts/verify-*/` -- ver
`.github/workflows/postgres-real-gate.yml` y
`scripts/verify-real-postgres-ci/README.md`. Ese runner ejecuta cada uno de
los 5 escenarios como su propia verificación pass/fail (no una lectura humana
de la salida de `psql`).

## Qué NO prueba

No repite la cobertura de los tests unitarios de
`apps/worker/tests/{night-audit-job,despachos-cobranza-reminders-job,
alert-notifications-job,deadline-reminders-job,discover-tenders-job}.spec.ts`
y `packages/domain-rentas/tests/checkin-reminders.spec.ts` (describe
`"r4-fix-crons-transaccion-por-unidad"` en cada uno), que ejercitan el código
TypeScript real (`runNightAuditSweep`/`runCobranzaReminderSweep`/
`runAlertNotificationSweep`/`runDeadlineReminderSweep`/`runDiscoverTendersSweep`/
`runRecordatorioCheckInCore`) contra un engine fake transaccional. Este script
prueba el mecanismo de Postgres puro, sin TypeScript de por medio -- las dos
verificaciones son complementarias, no redundantes (el test unitario prueba
que el CÓDIGO llama a `withRepo` correctamente; este script prueba que la
PREMISA sobre la que se basa el fix -- COMMIT-tras-abort-devuelve-ROLLBACK --
es real).
