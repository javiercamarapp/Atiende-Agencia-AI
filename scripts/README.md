# scripts

Ya NO es una carpeta reservada — este README decía "Reservado para
`check-migraciones.ts`/`check-runtime-flags.ts`... Aún no construido", lo cual
dejó de ser cierto hace varias fases. Contenido real hoy:

## `build-vercel-function.mjs`

Empaqueta `apps/api` como la función serverless de Vercel (`api/index.ts` →
`apps/api/src/vercel.ts`) — ver el comentario de cabecera del propio archivo y
`docs/DEPLOY.md`.

## `lint-ratchet/`, `health-check/`, `rollback/` (PL-12)

`lint-ratchet/ratchet.ts` (`npm run lint:ratchet`): falla si las advertencias de ESLint superan
`baseline.json`. `health-check/check.ts`: sondeo de `/health` de una URL (lo usa `prod-health.yml`; no envía
nada). `rollback/rollback.sh`: envoltorio manual de `vercel rollback`, ver `docs/ROLLBACK.md`. Pruebas:
`packages/db/tests/ci-pl12-guards.spec.ts`.

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

## `verify-outbox-grants/`, `verify-rentas-cron-rls/`, `verify-llm-usage-budget-guard/`, `verify-superadmin-caller-binding/`, `verify-caller-binding-fase2/`, `verify-rentas-break-glass/`, `verify-superadmin-facturacion/`, `verify-hoteles-sql-critico/`, `verify-restaurantes-sql/`, `verify-superadmin-salud/`, `verify-crons-transaccion-por-unidad/`, `verify-correo-inline-sesion-staff/`, `verify-whatsapp-inline-sesion-staff/`, `verify-rentas-bitacora-auditoria/`, `verify-restaurantes-audit-log/`, `verify-restaurantes-voz-seguridad/`, `verify-restaurantes-softrestaurant-outbox/`, `verify-restaurantes-privacidad-arco/`, `verify-restaurantes-conversaciones-handoff/`, `verify-restaurantes-voz-kpi/`, `verify-restaurantes-whatsapp-kpi/`, `verify-restaurantes-cierre-dia/`, `verify-restaurantes-canales-escritura/`, `verify-restaurantes-voz-huerfanas/`, `verify-restaurantes-repartidor-perfil/`, `verify-restaurantes-cliente-360/`, `verify-restaurantes-ajustes-agente/`, `verify-plataforma-privacidad/`

`verify-correo-inline-sesion-staff/` (auditoría a2, CRÍTICO) y
`verify-whatsapp-inline-sesion-staff/` (auditoría a2b, CRÍTICO, mismo bug con el
canal de WhatsApp) son distintos de los demás de esta lista: no verifican un
GRANT/policy puntual aislado en su propio `begin;...rollback;`, sino un
mecanismo de dos pasos que necesita un `commit;` real (drenado inline dentro de
la transacción de una ruta de staff, sin SAVEPOINT aborta esa transacción
entera; con SAVEPOINT la escritura de negocio sobrevive) — ver el `README.md`
de cada uno.

Verificaciones contra Postgres **real** (RLS + GRANT reales — no el repositorio
en memoria que usa `npm test`) de fixes puntuales ya auditados. Cada una trae su
propio `run.sh` para correrla a mano localmente — ver el `README.md` de cada
directorio. `verify-crons-transaccion-por-unidad/` es distinta de las demás: no
verifica RLS/GRANT de ninguna tabla de negocio, sino el MECANISMO de
transacciones de Postgres (COMMIT sobre una transacción abortada devuelve
ROLLBACK sin lanzar) detrás del fix "una transacción por unidad" en los crons
de barrido (night-audit/cobranza-reminders/alert-notifications/etc.).

## `verify-outbox-backoff-equidad/`

Postgres real, mismo contrato de 3 archivos que los demás `verify-*/` (lo corre el gate de
CI): backoff exponencial del correo del outbox y equidad por tenant de los
`claim_*_outbox_batch` de las 6 verticales (PL-07, migración
`packages/db/migrations/0031_outbox_backoff_y_equidad_por_tenant.sql`). Ver su `README.md`.

## `respaldo/` y `verify-respaldo-drill/`

Respaldo lógico de la base (`backup.sh`), restauración a una base nueva (`restore.sh`) y drill
con reporte pass/fail y RPO/RTO medidos (`drill.sh`, modo `--synthetic` sin credenciales). Lo
corre el workflow `.github/workflows/respaldo-drill.yml`; runbook en
`docs/RESPALDO-Y-RESTAURACION.md`. `verify-respaldo-drill/run.sh` es su gate (casos negativos);
no usa el contrato de 3 archivos de `verify-real-postgres-ci/`, levanta sus propios Postgres.

## `verify-real-postgres-ci/`

Convierte cualquier `verify-*/` de arriba (y cualquier `verify-*/` que se agregue
después con el mismo contrato de 3 archivos — `bootstrap.sql`/
`post-migrations.sql`/`assertions.sql`) en el gate automático de CI que corre
`.github/workflows/postgres-real-gate.yml` en cada PR/push, descubriéndolas
solas sin tocar el workflow — ver su propio README.

Si agregas un `verify-*/` nuevo con ese mismo contrato, súmalo a la lista de
arriba en tu misma pasada de documentación.

## `verify-whatsapp-concurrencia/`

Prueba de carga reproducible del webhook de WhatsApp de restaurantes (P0 "6+ mensajes simultáneos → HTTP 500"): API real de
producción contra Postgres real con TLS, OpenRouter y Meta simulados; exige 200 en todos, ningún mensaje perdido ni
duplicado y reenvío idempotente. No usa `assertions.sql` (job propio `whatsapp-concurrencia-gate` en
`.github/workflows/postgres-real-gate.yml`). Ver su `README.md`.
