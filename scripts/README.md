# scripts

Ya NO es una carpeta reservada — este README decía "Reservado para
`check-migraciones.ts`/`check-runtime-flags.ts`... Aún no construido", lo cual
dejó de ser cierto hace varias fases. Contenido real hoy:

## `build-vercel-function.mjs`

Empaqueta `apps/api` como la función serverless de Vercel (`api/index.ts` →
`apps/api/src/vercel.ts`) — ver el comentario de cabecera del propio archivo y
`docs/DEPLOY.md`.

## `verify-migration-versions/`

Guard puro (sin Postgres) que corre dentro de `npm run test:unit` Y como su
propio paso de CI (`npm run verify:migration-versions`, antes de levantar
Postgres): detecta prefijos de timestamp duplicados en `supabase/migrations/`
y divergencias entre esa carpeta y su fuente real en `packages/*/migrations/`.
Ver su propio `README.md`.

## `verify-env/`

`npm run verify:env` — expone en CLI el mismo cálculo que
`GET /superadmin/integraciones` (`apps/api/src/integrations-status.ts`): qué
variables de entorno reales hacen falta en ESTE entorno, sin imprimir valores.
Ver `docs/CREDENCIALES.md` y su propio `README.md`.

## `verify-outbox-grants/`, `verify-rentas-cron-rls/`, `verify-llm-usage-budget-guard/`, `verify-superadmin-caller-binding/`, `verify-caller-binding-fase2/`, `verify-rentas-break-glass/`, `verify-superadmin-facturacion/`, `verify-hoteles-sql-critico/`, `verify-restaurantes-sql/`, `verify-superadmin-salud/`, `verify-crons-transaccion-por-unidad/`, `verify-correo-inline-sesion-staff/`, `verify-rentas-bitacora-auditoria/`

`verify-correo-inline-sesion-staff/` (auditoría a2, CRÍTICO) es distinto de los
demás de esta lista: no verifica un GRANT/policy puntual aislado en su propio
`begin;...rollback;`, sino un mecanismo de dos pasos que necesita un `commit;`
real (drenado inline de correo dentro de la transacción de una ruta de staff,
sin SAVEPOINT aborta esa transacción entera; con SAVEPOINT la fila de negocio
sobrevive) — ver su propio `README.md`.

Verificaciones contra Postgres **real** (RLS + GRANT reales — no el repositorio
en memoria que usa `npm test`) de fixes puntuales ya auditados. Cada una trae su
propio `run.sh` para correrla a mano localmente — ver el `README.md` de cada
directorio. `verify-crons-transaccion-por-unidad/` es distinta de las demás: no
verifica RLS/GRANT de ninguna tabla de negocio, sino el MECANISMO de
transacciones de Postgres (COMMIT sobre una transacción abortada devuelve
ROLLBACK sin lanzar) detrás del fix "una transacción por unidad" en los crons
de barrido (night-audit/cobranza-reminders/alert-notifications/etc.).

## `verify-real-postgres-ci/`

Convierte cualquier `verify-*/` de arriba (y cualquier `verify-*/` que se agregue
después con el mismo contrato de 3 archivos — `bootstrap.sql`/
`post-migrations.sql`/`assertions.sql`) en el gate automático de CI que corre
`.github/workflows/postgres-real-gate.yml` en cada PR/push, descubriéndolas
solas sin tocar el workflow — ver su propio README.

Si agregas un `verify-*/` nuevo con ese mismo contrato, súmalo a la lista de
arriba en tu misma pasada de documentación.
