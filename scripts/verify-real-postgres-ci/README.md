# verify-real-postgres-ci

`run-gate.mjs` convierte cualquier `scripts/verify-*/` (el patrón ya establecido
por `scripts/verify-outbox-grants/` y `scripts/verify-rentas-cron-rls/`: un
`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`, ya auditados y
verificados a mano) en un **gate de CI automático**, sin que nadie tenga que leer
la salida de `psql` para juzgar si algo pasó o no. Lo corre
`.github/workflows/postgres-real-gate.yml`.

## Qué hace

Contra un Postgres **ya corriendo** (host/puerto vía las variables de entorno
estándar de `psql` — `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`; en GitHub Actions lo
da el `services: postgres:` del workflow; en local, cualquier Postgres que ya
tengas arrancado):

1. Crea una base de datos efímera dedicada (`atiende_ci_<nombre-del-verify>`) —
   drop + create, nunca toca una base existente con otro nombre.
2. Aplica `bootstrap.sql` (mismo mock mínimo de plataforma que usa el `run.sh`
   manual de cada `verify-*/`), ANTES de las migraciones — mismo orden que
   `run.sh` (`auth.uid()` y los roles `anon`/`authenticated`/`service_role`
   tienen que existir antes de que cualquier migración los use).
3. Aplica **todas** las migraciones reales de `supabase/migrations/`, en orden.
4. Aplica `post-migrations.sql` (el `GRANT USAGE` de schema que en Supabase real
   pone la plataforma, no una migración).
5. Parsea `assertions.sql` **sin modificarlo** y ejecuta cada escenario
   `begin; ... rollback;` como su propia conexión `psql`, determinando el
   resultado esperado a partir de las convenciones que el propio archivo ya usa
   (ver "Cómo deriva el resultado esperado" abajo) — nunca por lectura humana de
   la salida.
6. Imprime un reporte `[PASS]`/`[FAIL]` por escenario y sale con código != 0 si
   cualquier paso no se comportó como el `assertions.sql` documenta.

Sin argumento, descubre automáticamente **todo** `scripts/verify-*/` que tenga
los 3 archivos — un `verify-*` nuevo queda cubierto por el gate de CI sin tocar
este script ni el workflow. También se puede apuntar a uno solo:

```
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-outbox-grants
```

## Cómo deriva el resultado esperado de cada escenario

Estas convenciones **ya existían** en los `assertions.sql` (no las inventó este
script, solo las generaliza):

- Un escenario cuya consulta usa el alias de columna `as should_fail` debe
  terminar en `ERROR` de Postgres (la conexión se corre con `ON_ERROR_STOP=1`;
  un `ERROR` ahí es el resultado esperado y correcto).
- Un escenario cuyo alias contiene `deberia_ser_N` (p. ej.
  `filas_visibles_deberia_ser_1`) espera que esa consulta puntual — aislada del
  resto del bloque, reejecutada sola con el mismo `set local role`/
  `set_config` — devuelva exactamente el valor `N`. `deberia_fallar` se trata
  igual que `deberia_ser_0` (RLS filtra en silencio, sin lanzar excepción).
- Cualquier otro escenario debe completar **sin** error (no se valida un valor
  puntual, solo ausencia de excepción).
- Si el `assertions.sql` remata con una línea explícita tipo *"los escenarios
  2/4/7/10/11/14/16 deben terminar en ERROR"* (como
  `verify-outbox-grants/assertions.sql`), esa lista es la fuente de verdad
  definitiva y cubre los escenarios que esperan `ERROR` pero cuya consulta no
  admite un alias de columna (p. ej. `select * from fn(...)`).

Si en el futuro un `assertions.sql` nuevo necesita una convención que no encaja
en ninguna de estas, el escenario cae en "debe completar sin error" por
default — conviene entonces o bien darle un alias `should_fail`/
`..._deberia_ser_N`, o bien extender `deriveExpectation()` en `run-gate.mjs`.

## Qué NO hace

- No reemplaza `scripts/verify-*/run.sh` — ese sigue sirviendo para correr la
  misma verificación a mano contra un Postgres local efímero (vía
  `initdb`/`pg_ctl`), útil para investigar un fallo con más detalle o releer el
  comportamiento real sin tocar GitHub Actions.
- No modifica ni reinterpreta el contenido SQL de `bootstrap.sql`/
  `post-migrations.sql`/`assertions.sql` de ningún `verify-*/` — son la fuente
  de verdad auditada, este script solo los orquesta y verifica su resultado.
- No corre `npm run typecheck`/`npx vitest run`/lint — ese tier (repositorio en
  memoria) es un workflow de CI separado (todavía no existe), no este.
- Solo cubre lo que cada `assertions.sql` ya cubre — ver el `README.md` de cada
  `scripts/verify-*/` para el alcance exacto de cada fix verificado.

## Correrlo en local

Necesitas un Postgres ya corriendo y accesible con las variables de entorno
`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` (o los defaults `127.0.0.1:5432`/
`postgres`/`postgres`). Por ejemplo, con Postgres de Homebrew ya arrancado:

```
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres \
  node scripts/verify-real-postgres-ci/run-gate.mjs
```

Usa `--keep-db` para no borrar la base de datos efímera al terminar (útil para
inspeccionar un fallo con `psql` directamente después de la corrida).

## Verificado

Corrido de punta a punta contra un Postgres 17 local (Homebrew, vía
`initdb`/`pg_ctl`) con las 95 migraciones reales de `supabase/migrations/`:
34/34 escenarios (`verify-outbox-grants` 16/16 + `verify-rentas-cron-rls` 18/18)
en verde, código de salida 0. Se probó además la detección de regresión real:
al comentar temporalmente un `grant execute ... to authenticated;` de la
migración 88 (hoteles), el gate detectó exactamente el escenario roto
(`[FAIL] #6`) y salió con código 1; al restaurar el archivo, volvió a 16/16 en
verde.
