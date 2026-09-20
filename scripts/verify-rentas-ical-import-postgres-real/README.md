# verify-rentas-ical-import-postgres-real

Verificación, contra un Postgres **real**, de
`packages/domain-rentas/src/sync/postgres-repository.ts::upsertEventoImportado` —
hallazgo de auditoría a3 (ALTA): el INSERT original omitía `organization_id`/
`property_id`, columnas `NOT NULL` sin default de `rentas.evento_canal_importado`
(`supabase/migrations/20240101000057_008_ical_sync_schema.sql:56-75`), así que
**todo** upsert con `sobrescribirVersion=true` (el camino real de
"aplicar"/"eco") disparaba `23502` contra Postgres real — el import iCal de
rentas nunca funcionó contra la base real desde que se introdujo (`edf6cdf`,
2026-09-12), solo contra el repositorio en memoria de los tests (que nunca
valida `NOT NULL`).

Este directorio ejecuta **el SQL real del repositorio** — a diferencia de
`scripts/verify-rentas-cron-rls/assertions.sql` (escenario 12, corregido en
este mismo PR), que insertaba `organization_id`/`property_id` A MANO y por eso
nunca detectó el bug. Corrección de revisión de PR #175: los escenarios 2-3
(evento nuevo/eco) SÍ reproducen el JOIN a `rentas.unidad` y el `ON CONFLICT`
completos, literales. Los escenarios 4-7 (aislamiento por evento y
cross-tenant) usan un `INSERT` más simple (sin `ON CONFLICT`, con literales en
vez de parámetros) porque solo necesitan demostrar el NOT NULL/FK/tenant, no
el camino de conflicto — ver "Qué NO cubre" más abajo.

## Qué demuestra (`assertions.sql`, 7 escenarios)

1. **(documental)** El INSERT viejo (sin `organization_id`/`property_id`) SIGUE
   rechazado por la tabla real con `23502` — prueba que el `NOT NULL` es real,
   no una preferencia de estilo.
2. Un evento nuevo se importa y persiste con el tenant derivado correctamente
   de `rentas.unidad` (columna por columna).
3. Un eco del mismo evento (mismo UID, dos upserts con
   `sobrescribirVersion=true`) es idempotente: sigue siendo UNA fila, con los
   valores del intento más reciente.
4-5. Un evento "venenoso" (`ocupacion_id` que viola el FK real hacia
   `rentas.ocupacion`) en medio del feed **nunca** persiste, y el evento sano
   que sigue en el MISMO feed **sí** se aplica — reproduce, con una
   subtransacción PL/pgSQL (`EXCEPTION WHEN OTHERS`, equivalente a nivel de
   recuperación de transacción a `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`/`RELEASE
   SAVEPOINT`), el aislamiento por evento que
   `motor.ts::procesarEventoDelCicloAislado` agrega.
6-7. Cross-tenant: un evento de la unidad de la Org A jamás puede terminar con
   el `organization_id`/`property_id` de la Org B, y dos unidades de distinta
   organización con el MISMO `canal_id`/UID producen dos filas independientes,
   cada una con su propio tenant — nunca colisionan ni se mezclan.

## Cómo correrlo

```
scripts/verify-rentas-ical-import-postgres-real/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente).
Levanta un cluster Postgres efímero, aplica todas las migraciones reales de
`supabase/migrations/` en orden, corre los 7 escenarios, y apaga/borra el
cluster al salir.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`) sigue
el mismo contrato que el resto de `scripts/verify-*/` — se auto-descubre y
corre automáticamente en cada PR/push vía
`scripts/verify-real-postgres-ci/run-gate.mjs`
(`.github/workflows/postgres-real-gate.yml`), sin tocar el workflow.

## Limitación conocida (heredada de TODO `scripts/verify-*/` de este repo)

Igual que los demás `scripts/verify-*/assertions.sql` del monorepo, este gate corre
SQL puro contra `psql` — nunca importa ni ejecuta el código TypeScript compilado del
repositorio. Los escenarios 2-3 son una copia LITERAL (mismas columnas, mismo `JOIN`,
mismo `ON CONFLICT`) del SQL real de `upsertEventoImportado` al momento de escribir
este gate; los escenarios 4-7 (aislamiento/cross-tenant) simplifican ese SQL (sin
`ON CONFLICT`, con literales en vez de `$1`..`$8`) porque el `ON CONFLICT` no
participa del NOT NULL/FK/tenant que esos escenarios verifican — así que la
inferencia de tipos real de esos parámetros ($1 usado dos veces, $4 `int`, $5
`timestamptz`, $7 `uuid` nullable) nunca se ejerce contra Postgres real en esos 4
escenarios. Ninguna llamada de este gate es una llamada en vivo a la función `.ts`
misma. Si alguien modifica el SQL de `postgres-repository.ts` sin actualizar
`assertions.sql` a la par, este gate NO lo detecta — sigue verificando el contrato
SQL que documenta, no el archivo `.ts` en sí. Esto es una limitación estructural de
este tier de pruebas en todo el repo (ningún `scripts/verify-*/` tiene un tier de
integración que ejecute TypeScript contra Postgres real todavía), no algo específico
de este script.

## Qué NO cubre

- El SAVEPOINT-por-evento REAL de `motor.ts::procesarEventoDelCicloAislado`
  (la sintaxis `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`/`RELEASE SAVEPOINT` exacta
  que emite `ctx.db.exec`, y que la sesión realmente quede recuperada tras un
  `25P02`) tiene su propio test con un `AbortAwareFakeSession` real (mismo
  patrón que `reserva-email-notifications-savepoint.spec.ts`) en
  `packages/domain-rentas/tests/sync-motor.spec.ts` — este gate solo
  demuestra, con una subtransacción PL/pgSQL equivalente, que el MECANISMO de
  aislamiento por fila funciona contra Postgres real (mismo principio que
  `scripts/verify-fallback-savepoint/` demuestra para
  `runWithSavepointFallback`).
- El SEQUENCE fuera de rango de `int32` (BUG 2 de la auditoría) es una
  validación puramente en JS del parser
  (`packages/domain-rentas/src/ical/parser.ts`) — cubierta por
  `packages/domain-rentas/tests/ical-parser.spec.ts`. El año `"0000"` (mismo
  BUG 2) se valida por EVENTO en `motor.ts::procesarEventoDelCiclo` (junto a
  `esRangoValido`, no en el parser — un año inválido descarta solo ese evento,
  nunca el feed completo) — cubierto por
  `packages/domain-rentas/tests/sync-motor.spec.ts`, tampoco por este gate de
  SQL.
- El SAVEPOINT best-effort de `tryEnqueueReservaEmail` (BUG 3) — cubierto por
  `packages/domain-rentas/tests/reserva-email-notifications-savepoint.spec.ts`
  con `AbortAwareFakeSession`.

## Por qué no es parte de `npm test`

Mismo motivo que `scripts/verify-rentas-cron-rls/README.md`: este monorepo
no tiene todavía ningún tier de pruebas contra Postgres real dentro de
`npm test`/`vitest` — el gate de CI descrito arriba cubre este fix sin
depender de ese tier general.
