# verify-despachos-fiscal-deadline-unique

Cierra el hallazgo de auditoría "'Calcular vencimientos' en despachos duplica
filas si se pulsa dos veces" (f2-despachos-fiscal-deadline-unique). El
repositorio en memoria (`InMemoryDespachosRepository`, usado por el 100% de la
suite `npm test`) ya hacía el dedup a mano; el adaptador real de Postgres
(`PostgresDespachosRepository.createDeadline`) era un `INSERT` plano — este
verify ejerce, contra Postgres real, el SQL exacto de ese archivo antes y
después del fix.

## Hallazgo real (lee esto antes que el código)

`despachos.fiscal_deadline` **ya tenía** `unique (property_id, tipo, periodo)`
desde la migración **original** de la Fase 1
(`packages/domain-despachos/migrations/001_despachos_schema.sql` /
`supabase/migrations/20240101000009_001_despachos_schema.sql`) — verificado
con `git log -S"unique (property_id, tipo, periodo)"`: nunca se agregó ni se
quitó después. **Este PR no agrega ninguna migración nueva para el índice** —
no hacía falta.

Eso significa que pulsar "Calcular vencimientos" dos veces para el mismo
periodo **nunca duplicaba filas** (el índice ya lo impedía a nivel de base de
datos) — pero sí estaba roto de otra forma: el segundo `INSERT` lanzaba un
`unique_violation` (23505) **crudo**, sin manejar, que Postgres real deja sin
capturar. Como los 4 `INSERT` de un mismo "calcular" (ISR/IVA/DIOT/Nómina)
corren en la **misma transacción** de staff (`dbSession`,
`ManagedPostgresEngine.withAppSession` — una sola transacción por request), ese
error aborta **todo el lote**: el `commit;` real se convierte en `ROLLBACK`
silencioso (`AbortedTransactionCommitError`) y el staff ve un 500 en vez de un
resultado idempotente.

El fix (`ON CONFLICT (property_id, tipo, periodo) DO NOTHING` + relectura de
la fila existente cuando no hubo `INSERT`) hace que "calcular" sea idempotente
de verdad: la segunda llamada nunca duplica y nunca lanza.

## Qué demuestra cada escenario

1. El índice `unique (property_id, tipo, periodo)` existe (confirma la
   premisa de arriba contra el esquema real, no solo leyendo el `.sql`).
2. **Reproduce el bug ORIGINAL** (antes de este fix): `INSERT` plano dos veces
   para el mismo `(property_id, tipo, periodo)` — el 2do **debe fallar** con
   23505 crudo. Evidencia del "antes".
3. El SQL real de `insertDeadlineOnConflictDoNothing`/`findDeadlineByPeriodo`
   (copiado literal, no reescrito de memoria): dos llamadas para el mismo
   periodo, en la misma transacción, dejan **exactamente 1 fila**, ninguna
   lanza. Evidencia del "después".
4. El batch completo de 4 tipos (ISR/IVA/DIOT/Nómina) "calculado" dos veces en
   la misma transacción (el caso real de doble clic en `POST
   .../vencimientos/calcular`) deja **exactamente 4 filas**, nunca 8.
5. Verificación de duplicados **preexistentes**: la query que habría que correr
   contra Supabase real (vía dashboard/CLI — no accesible desde este entorno
   de build) para confirmar, antes de cualquier cambio, que ninguna fila real
   ya viola el índice. En esta base efímera recién creada el resultado es 0;
   si el mismo `SELECT ... GROUP BY ... HAVING count(*) > 1` devolviera algo
   contra la base real, esas filas duplicadas tendrían que resolverse a mano
   (decidir cuál conservar) ANTES de que cualquier código nuevo dependa del
   índice — el índice en sí ya está aplicado desde hace mucho, así que ese
   escenario es principalmente teórico a estas alturas, no una migración
   pendiente de este PR.
6. Canario negativo — SQLSTATE 42P10 (`ON CONFLICT` sin índice `unique` que lo
   respalde) contra una tabla temporal equivalente sin el índice. Esto es lo
   que `isNoUniqueOrExclusionConstraintError` (`packages/db/src/sql-errors.ts`)
   reconoce, y lo que dispara el `fallback` de `runWithSavepointFallback` en
   `createDeadline` — el camino que degrada al `INSERT` plano de antes de este
   fix si, pese a ser original de la Fase 1, el índice no existiera todavía en
   la base real que corre este código (REGLA DURA de compatibilidad del
   repo).

## Por qué corre bajo `service_role`, no `authenticated`

Mismo criterio que `verify-despachos-fechas-postgres-real`: lo que este verify
verifica es el comportamiento del SQL/índice, no autorización de staff (eso ya
lo cubren `verify-outbox-grants`/`verify-hoteles-sql-critico` con sesión de
staff real, y `requirePropertyMembership`/`assertVerticalRole` en la capa
HTTP, ya probados por la suite en memoria y por
`postgres-repository-create-deadline-savepoint.spec.ts`).

## Correr a mano

```
scripts/verify-despachos-fiscal-deadline-unique/run.sh
```

(requiere `initdb`/`pg_ctl`/`psql` en PATH — instala Postgres localmente, p.ej.
`brew install postgresql`). Igual que el resto de `scripts/verify-*/`, queda
cubierto automáticamente por `scripts/verify-real-postgres-ci/run-gate.mjs` y
por `.github/workflows/postgres-real-gate.yml` — no requiere ningún cambio en
ninguno de los dos para quedar incluido (descubrimiento automático de
`scripts/verify-*/`).

## Verificado

Corrido de punta a punta contra un Postgres 17 local (Homebrew, vía
`initdb`/`pg_ctl`) con las 160 migraciones reales de `supabase/migrations/`
aplicadas: 6/6 escenarios en verde tanto en el `run.sh` manual como en
`scripts/verify-real-postgres-ci/run-gate.mjs` (el gate automático que usa CI),
código de salida 0.
