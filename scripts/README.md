# scripts

Reservado para `check-migraciones.ts` y `check-runtime-flags.ts` (portados de `hoteles/scripts`) cuando exista `packages/db` con migraciones reales que revisar. Aún no construido.

## verify-outbox-grants/, verify-rentas-cron-rls/

Verificaciones contra Postgres **real** (RLS + GRANT reales — no el repositorio
en memoria que usa `npm test`) de fixes puntuales ya auditados. Cada una trae su
propio `run.sh` para correrla a mano localmente — ver el `README.md` de cada
directorio.

## verify-real-postgres-ci/

Convierte cualquier `verify-*/` de arriba (y cualquier `verify-*/` que se agregue
después con el mismo contrato de 3 archivos) en el gate automático de CI que
corre `.github/workflows/postgres-real-gate.yml` en cada PR/push — ver su propio
README.
