# verify-fallback-savepoint

Verificación, contra un Postgres **real**, del mecanismo que motiva
`packages/db/src/savepoint-fallback.ts` (`runWithSavepointFallback`) —
corrector prioritario de los hallazgos CRITICO/ALTO de la auditoría a1
("una fila venenosa revierte citas en silencio" / "invitar staff sigue roto
contra la base sin migrar").

## Qué demuestra (`assertions.sql`, tres escenarios)

1. **SIN SAVEPOINT**: un error cualquiera (`select 1/0`) dentro de un bloque
   `begin;...` deja la transacción **abortada** — cualquier consulta
   posterior falla con `25P02` ("current transaction is aborted"), y el
   `commit;` final **no lanza ningún error**: Postgres lo trata como
   `ROLLBACK` implícito y ese es el tag de comando que devuelve (nunca
   `COMMIT`). Se verifica además que TODA la transacción se revirtió —la
   tabla temporal creada dentro del bloque ni siquiera existe después.
2. **CON SAVEPOINT**: el mismo error, pero protegido por `SAVEPOINT`/
   `ROLLBACK TO SAVEPOINT`/`RELEASE SAVEPOINT` — la sesión queda recuperada,
   el camino de respaldo SÍ corre, y el `COMMIT` final es real.
3. **`citas.appointments` contra el CHECK viejo (`23514`)**: reproduce
   exactamente el hallazgo CRÍTICO — `markAppointmentGoogleSyncInvalid`
   intentando `google_sync_status = 'invalid'` contra la base **sin la
   migración `019_calendar_sync_error_visibility.sql` aplicada** (`run.sh`
   la excluye a propósito de la lista de migraciones que aplica — ver su
   comentario). Sin SAVEPOINT, falla 23514 sin más. Con SAVEPOINT (el fix
   real de este PR), degrada a `google_sync_status = 'error'` conservando el
   motivo en `google_sync_error`, con un `COMMIT` real al final.

## Por qué este script NO usa `scripts/verify-real-postgres-ci/run-gate.mjs`

El resto de `scripts/verify-*/` de este repo sigue el contrato genérico de
ese runner (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`, cada
escenario envuelto SIEMPRE en `begin;...rollback;`, TODAS las migraciones de
`supabase/migrations/` aplicadas). Dos cosas que este script necesita
demostrar son incompatibles con ese contrato:

- **Un `COMMIT` real.** El runner genérico envuelve cada escenario en
  `rollback;`, así que un `COMMIT` de verdad (y el tag de comando que
  devuelve) nunca ocurre ahí.
- **La base SIN la migración 019.** El runner genérico aplica SIEMPRE
  TODAS las migraciones de `supabase/migrations/` — no hay forma de pedirle
  que se salte una a propósito.

Por eso `assertions.sql` de este directorio corre en **una sola sesión de
psql** (para que `BEGIN`/`COMMIT` reales se vean de verdad, marcados con
`\echo` antes/después de cada escenario) y `run.sh` hace su **propio**
pass/fail: aplica `supabase/migrations/*.sql` en orden salvo el archivo
`*_019_calendar_sync_error_visibility.sql`, corre `assertions.sql`, y
verifica con `grep` (entre los marcadores `\echo`) que cada tag de comando/
mensaje de error/resultado sea el esperado.

## Uso

```
scripts/verify-fallback-savepoint/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente —
`brew install postgresql` en macOS). Levanta un Postgres efímero real,
corre los 15 checks, y limpia todo al salir (incluso si falla).

## CI

Integrado como un paso aparte del job "Postgres real (gate)" en
`.github/workflows/postgres-real-gate.yml` (no vía la auto-detección de
`run-gate.mjs`, por las razones de arriba) — cualquier regresión en el
mecanismo SAVEPOINT o en el fix real de `markAppointmentGoogleSyncInvalid`
rompe el build.
