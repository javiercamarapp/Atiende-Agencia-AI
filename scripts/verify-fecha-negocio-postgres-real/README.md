# verify-fecha-negocio-postgres-real

Cierra el hueco de test real de `f2-current-date-fecha-negocio` (revisión del
19-sep): ningún test unitario puede correr el repositorio Postgres real desde
vitest (el 100% de `npm test` usa los repositorios en memoria de
`packages/domain-{hoteles,rentas,licitaciones}`), así que ninguno puede
demostrar contra Postgres real que una consulta parametrizada con el día de
negocio (`@atiende/core-tenancy::hoyFechaNegocio()`) se comporta distinto de
la misma consulta si cayera de vuelta a `current_date` de la sesión.

## Qué demuestra (8 escenarios)

Cuatro sitios corregidos por esta tarea, cada uno con un escenario "debería
ser 0/¬encontrado" (el día de negocio gana) + un control positivo
"debería ser 1/encontrado" (la query no quedó siempre-vacía):

1-2. `packages/domain-hoteles/src/postgres-repository.ts::findDueNoShowReservations`
— una reserva cuyo `check_in_date` cae en el `current_date` de la sesión
NUNCA se reclama como no-show cuando el parámetro explícito (`current_date -
1`, el "día de negocio real" en la ventana del bug) es un día antes.

3-4. `packages/domain-rentas/src/postgres-repository.ts::loadPricingContext`
— una tarifa nueva con `vigente_desde` = `current_date` de la sesión NUNCA se
usa todavía cuando el parámetro explícito es un día antes; la tarifa vieja
sigue ganando.

5-6. `packages/domain-rentas/src/limpieza/aplicacion/tareas.ts::procesarCheckoutsPendientes`
— un checkout (`upper(rango)`) que cae en `current_date` de la sesión NUNCA
se procesa todavía cuando el parámetro explícito es un día antes.

7-8. `packages/domain-licitaciones/src/postgres-repository.ts::createApprovedRate`
— el `INSERT` ya no hace `coalesce(valid_from, current_date)`: un
`valid_from` `NULL` (lo que pasaría si un caller futuro olvidara resolver el
default en TypeScript) **falla fuerte** contra la columna `not null`, nunca
cae en silencio al día de la sesión; con un valor explícito, `RETURNING`
conserva exactamente ese valor.

## Cómo reproduce la ventana del bug sin depender del reloj real

Cada escenario corre bajo `set local timezone to 'Etc/GMT-12'` (UTC+12,
exactamente 24h por delante de `'Etc/GMT+12'`) — así `current_date` de esa
sesión es, de forma determinista y sin depender de la hora real en que corre
el gate, un día calendario por delante de `current_date - 1`. Eso reproduce
el mecanismo exacto del bug (la sesión de Postgres, en UTC en Vercel, ve un
día calendario distinto al día de negocio real entre las 18:00 y las 23:59
CDMX) sin necesitar que el gate corra exactamente en esa ventana horaria.

## Por qué corre bajo `service_role`, no `authenticated`

Mismo criterio que `scripts/verify-despachos-fechas-postgres-real/`: lo que
este verify comprueba es el COMPORTAMIENTO del SQL en sí (parámetro vs.
`current_date`), no RLS/GRANT — eso ya lo cubren
`verify-rentas-cron-rls`/`verify-outbox-grants`/`verify-hoteles-sql-critico`.

## Correr a mano

```
scripts/verify-fecha-negocio-postgres-real/run.sh
```

(requiere `initdb`/`pg_ctl`/`psql` en PATH). Igual que el resto de
`scripts/verify-*/`, queda cubierto automáticamente por
`scripts/verify-real-postgres-ci/run-gate.mjs` y por
`.github/workflows/postgres-real-gate.yml` — no requiere ningún cambio en
ninguno de los dos para quedar incluido.

## Verificado

Corrido de punta a punta contra un Postgres 17 local (Homebrew) con las 157
migraciones reales de `supabase/migrations/` aplicadas: 8/8 escenarios en
verde tanto vía `run.sh` (manual) como vía `run-gate.mjs` (el mismo camino
que corre en CI), código de salida 0.
