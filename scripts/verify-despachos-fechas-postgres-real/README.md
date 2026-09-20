# verify-despachos-fechas-postgres-real

Cierra el hueco de test real señalado en la revisión r6 (seguimiento de PR #164,
punto 7): ningún test ejercía contra Postgres real el SQL nuevo de
`packages/domain-despachos/src/postgres-repository.ts`
(`FISCAL_DEADLINE_COLUMNS`/`RECEIVABLE_COLUMNS` — columnas explícitas con
`::text` sobre las columnas `date`, introducidas en PR #164 para reemplazar
`select */returning *`). El repositorio en memoria
(`InMemoryDespachosRepository`, usado por el 100% de la suite `npm test`) nunca
ejecuta SQL — un typo en esa lista de columnas (o un `select */returning *` que
se cuele de nuevo en el futuro en cualquier método nuevo) solo se vería como
error real en producción.

## Qué demuestra

1. (Escenarios 1, 4, 5) El `INSERT ... RETURNING`/`UPDATE ... RETURNING` de
   `createDeadline`/`markDeadlineCompleted`/`registerReceivable` — copiados
   literales del archivo fuente, no reescritos de memoria — corren sin error
   contra el esquema real de `despachos.fiscal_deadline`/`despachos.receivable`.
2. (Escenarios 2, 3, 6) Las columnas `date` (`fecha_limite`/
   `fecha_presentacion`/`fecha_vencimiento`) casteadas a `::text` devuelven,
   contra Postgres real, exactamente el formato `"YYYY-MM-DD"` que
   `apps/web/src/lib/formato-fecha.ts::formatFechaSolo`/
   `apps/api/.../despachos/vencimientos.ts::diasHasta` esperan — nunca un
   timestamp completo (`pg-types` sin `setTypeParser`, ver el comentario de
   cabecera de `formato-fecha.ts` para la evidencia completa de ESE bug, ya
   corregido en PR #164).
3. (Escenario 7) Canario negativo: una columna con typo real
   (`fecha_limite_typo`) SÍ falla contra Postgres real con un error de SQL
   claro — la razón de ser de este verify. Confirmado a mano introduciendo un
   typo real (`fecha_limite` → `fecha_limite_TYPO`) en escenarios 1/4:
   el gate baja de 7/7 a 5/7 y sale con código 1; restaurado el archivo, vuelve
   a 7/7 en verde.

## Por qué corre bajo `service_role`, no `authenticated`

A diferencia de `verify-outbox-grants`/`verify-rentas-cron-rls` (que ejercen
RLS/GRANT reales bajo `authenticated` con un JWT simulado), lo que este verify
verifica es la VALIDEZ SQL y el TIPO DE RETORNO de las columnas — no
autorización (eso ya está cubierto por los verify-* de RLS existentes, y por
`requirePropertyMembership`/`assertVerticalRole` en la capa HTTP, ya probados
por la suite en memoria). `post-migrations.sql` de este verify agrega, además
del `GRANT USAGE` estándar, un `GRANT SELECT, INSERT, UPDATE` explícito a
`service_role` sobre `despachos.fiscal_deadline`/`receivable`/`invoice` — en
Supabase real ese rol tiene acceso irrestricto de plataforma; el mock local
(`bootstrap.sql`, compartido con el resto de `scripts/verify-*/`) solo le da
`bypassrls`, así que hace falta completar el `GRANT` de tabla aquí.

## Correr a mano

```
scripts/verify-despachos-fechas-postgres-real/run.sh
```

(requiere `initdb`/`pg_ctl`/`psql` en PATH — instala Postgres localmente, p.ej.
`brew install postgresql`). Igual que el resto de `scripts/verify-*/`, queda
cubierto automáticamente por `scripts/verify-real-postgres-ci/run-gate.mjs` y
por `.github/workflows/postgres-real-gate.yml` — no requiere ningún cambio en
ninguno de los dos para quedar incluido.

## Verificado

Corrido de punta a punta contra un Postgres 17 local (Homebrew, vía
`initdb`/`pg_ctl`) con las 155 migraciones reales de `supabase/migrations/`
aplicadas: 7/7 escenarios en verde, código de salida 0. Regresión confirmada a
mano (ver arriba, "canario negativo").
