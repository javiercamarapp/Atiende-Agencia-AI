# verify-orden-redefiniciones

Guard de Ola 4 (G3). `supabase db push` aplica en producción las migraciones que **faltan, en el orden en que llegan**;
el gate de Postgres real y cualquier base nueva las aplican **por versión**. Si una rama trae una migración con versión
**menor** que otra ya fusionada y las dos hacen `create or replace function` de la misma función, en CI gana la nueva
(todo verde) pero en producción gana la vieja: la función queda revertida en silencio.

Regla: una migración **agregada** por la rama no puede (re)definir una función (`esquema.nombre`, sin argumentos) que
también define una migración ya existente con versión mayor. Arreglo: renumerar la agregada (y su espejo) por encima
de la mayor versión existente.

- Lógica pura: `redefinicionesFueraDeOrden` / `funcionesDefinidas` en `check-orden-redefiniciones.ts`,
  probadas en `packages/db/tests/orden-redefiniciones-guard.spec.ts`.
- CLI: `npm run verify:orden-redefiniciones`. Calcula las agregadas con `git diff --diff-filter=A <base>...HEAD`;
  base = `origin/$GITHUB_BASE_REF` en un PR, si no `origin/main` (o `ORDEN_REDEFINICIONES_BASE`). Sin historial sale con 2.
- CI: job `orden-redefiniciones` de `.github/workflows/postgres-real-gate.yml` (checkout con `fetch-depth: 0`).
