# .github/workflows

## postgres-real-gate.yml

Único workflow de este repo. Es **solo de tests** — no tiene ningún paso de
build, deploy, publicación, ni integración con Vercel u otro servicio con costo
o efectos de producción. Dispara en `pull_request`, en `push` a `main`, y
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
   `scripts/verify-*/assertions.sql` existente — hoy:
   - `scripts/verify-outbox-grants/` (GRANT + autorización del email outbox,
     6 verticales).
   - `scripts/verify-rentas-cron-rls/` (escape hatch de sesión-de-sistema en
     RLS para los crons de `domain-rentas`).

Ver `scripts/verify-real-postgres-ci/README.md` para el detalle de cómo el
runner deriva el resultado esperado de cada escenario, y el `README.md` de cada
`scripts/verify-*/` para el alcance exacto de lo que cada uno verifica.

### Qué NO cubre

- El resto de la suite (`npm run typecheck`, `npx vitest run`, `npm run
  test:integration`, `npm run test:adversarial`, lint) **no tiene ningún
  trigger de CI todavía** — sigue corriéndose a mano por quien hace el cambio.
  Agregar ese tier es una decisión de plataforma más amplia (qué runner, qué
  triggers, cache de `node_modules`, tiempo de corrida de 4089+ specs), fuera
  del alcance de este hallazgo puntual sobre Postgres real.
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
