# .github/workflows

Dos workflows, deliberadamente separados (no se mezclan responsabilidades en
un solo job): `postgres-real-gate.yml` (Postgres real, RLS/GRANT) y
`ci-checks.yml` (typecheck/lint/tests en memoria/build). Ambos disparan en
`pull_request`, en `push` a `main`, y manualmente (`workflow_dispatch`), y
corren en paralelo — ninguno espera al otro.

## ci-checks.yml

Agregado 19-sep-2026, para cerrar un hueco que `postgres-real-gate.yml` (ver
abajo) documentaba explícitamente en su propio comentario de cabecera desde
que existe: **ningún** workflow de este repo corría `npm run typecheck`,
`npm run lint` ni `npm run test:unit` — ese tier corría solo a mano por quien
hacía el cambio, así que un PR con "tests en verde" era solo la palabra local
de quien lo construyó. Corre, en un solo job sin matriz sobre `ubuntu-latest`:
`npm ci` → `npm run typecheck` → `npm run lint` → `npm run test:unit` →
`npm run build --workspace apps/web`. Frugal a propósito: `concurrency` con
`cancel-in-progress` por rama, `timeout-minutes: 15`,
`permissions: contents: read`, cache de npm, `paths-ignore` para cambios solo
de docs/markdown, sin servicios externos ni secretos. Ver el comentario de
cabecera del propio workflow para el detalle completo de qué cubre y qué no.

## postgres-real-gate.yml

Es **solo de tests contra Postgres real** — no tiene ningún paso de build,
deploy, publicación, ni integración con Vercel u otro servicio con costo o
efectos de producción. Dispara en `pull_request`, en `push` a `main`, y
manualmente (`workflow_dispatch`).

### Qué cubre

Cierra el hallazgo de la auditoría final de 20 rubros (rubros 9 y 20): el 0% de
la suite de tests de este monorepo (4089+ specs) ejercitaba Postgres real — todo
corría contra el repositorio en memoria de cada `domain-<vertical>`, que nunca
aplica RLS ni GRANT. Este job:

1. Levanta un Postgres real (servicio `postgres:16` de GitHub Actions).
2. Aplica, en orden, las migraciones reales de `supabase/migrations/`.
3. Corre `scripts/verify-real-postgres-ci/run-gate.mjs`, que ejecuta como gate
   automático (pass/fail por escenario, sin lectura humana de salida) cada
   `scripts/verify-*/assertions.sql` existente — se descubren solos (ver
   "Agregar un `verify-*` nuevo" abajo), así que esta lista se desactualiza
   fácil; al 19-sep-2026 son:
   - `scripts/verify-outbox-grants/` (GRANT + autorización del email outbox,
     6 verticales).
   - `scripts/verify-rentas-cron-rls/` (escape hatch de sesión-de-sistema en
     RLS para los crons de `domain-rentas`).
   - `scripts/verify-llm-usage-budget-guard/` (control de gasto de LLM del
     superadmin).
   - `scripts/verify-superadmin-caller-binding/` (12 funciones
     `*_for_superadmin` atadas a `auth.uid()`).
   - `scripts/verify-caller-binding-fase2/` (14 funciones más de `core` con el
     mismo patrón).
   - `scripts/verify-rentas-break-glass/` (acceso auditado de superadmin a
     reservas de rentas).
   - `scripts/verify-superadmin-facturacion/` (lecturas de MRR/reconciliación
     de la suscripción SaaS).
   - `scripts/verify-hoteles-sql-critico/` (trigger del gate de revenue,
     índice anti-doble-captura de night-audit, `mark_charge_reversed()`, RLS
     de reputación).
   - `scripts/verify-restaurantes-sql/` (RPC/reglas SQL que el repositorio
     Postgres real de restaurantes usa, incluida la zona conocida sin
     GRANT/policy que esta verificación encontró).
   - `scripts/verify-superadmin-salud/` (latidos de crons, salud de colas
     `messaging_outbox`, última corrida por fuente de licitaciones).

Ver `scripts/verify-real-postgres-ci/README.md` para el detalle de cómo el
runner deriva el resultado esperado de cada escenario, y el `README.md` de cada
`scripts/verify-*/` para el alcance exacto de lo que cada uno verifica.

### Qué NO cubre

- `npm run typecheck`, `npm run lint` y `npm run test:unit` — desde
  19-sep-2026 corren en `ci-checks.yml` (ver arriba), workflow separado de
  este.
- `npm run test:integration` sigue **sin ningún trigger de CI** — ni este
  workflow ni `ci-checks.yml` lo corren; sigue corriéndose a mano por quien
  hace el cambio. Agregarlo es una decisión de plataforma más amplia (qué
  runner, si necesita su propio servicio de Postgres o Redis, tiempo de
  corrida), fuera del alcance del hallazgo que motivó `ci-checks.yml`.
- No ejercita ninguna tabla/función/policy de las 6 verticales que no esté ya
  cubierta por un `scripts/verify-*/assertions.sql` existente. No es un fuzz ni
  un test de regresión general del esquema — es exactamente, y solamente, lo
  que cada `assertions.sql` documenta que verifica.
- No corre contra un proyecto Supabase real ni contra staging/producción — el
  Postgres del job es efímero, vive solo durante el job, y se descarta al
  terminar.

### Agregar un `verify-*` nuevo

`run-gate.mjs` descubre automáticamente cualquier `scripts/verify-<algo>/` que
tenga `bootstrap.sql` + `post-migrations.sql` + `assertions.sql` — no hace falta
tocar este workflow. Ver `scripts/verify-real-postgres-ci/README.md` para el
contrato exacto que esos 3 archivos deben cumplir.
