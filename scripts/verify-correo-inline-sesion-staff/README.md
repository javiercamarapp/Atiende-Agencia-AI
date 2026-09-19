# verify-correo-inline-sesion-staff

Verificación ANTES/DESPUÉS contra Postgres **real** del hallazgo confirmado de la
auditoría a2 (severidad CRÍTICA, `auditoria-a2-resultado.json::confirmed[0]`): el
disparo INLINE de correo (`triggerXEmailDispatchInline`, ver `apps/api/src/routes/
verticals/*/{email-dispatch,notifications,alertNotifications}.ts`) corre sobre la
MISMA transacción que la ruta de staff que lo invoca. Con sesión de staff
(`auth.uid()` no nulo), `<vertical>.claim_email_outbox_batch` SIEMPRE lanza `42501`
(guard correcto y necesario — la función es cross-tenant, drena de TODAS las
organizaciones; **no se afloja**). Sin un `SAVEPOINT` alrededor, esa excepción deja
la transacción COMPLETA abortada, y el `commit;` que corre después (en
`packages/db/src/managed-postgres-engine.ts`, que nunca revisa el resultado del
`commit;`) le devuelve "ROLLBACK" a Postgres en silencio — cualquier escritura de
negocio de ESE MISMO request (folio cerrado, reserva creada, cita confirmada...) se
pierde con una respuesta 2xx, o -- si la ruta corre dentro de `withIdempotency` --
el cliente recibe 500.

Ni el repositorio en memoria (`npm test`) ni el resto de `scripts/verify-*/`
(verificaciones de GRANT/RLS puntuales, cada escenario aislado en su propio
`begin;...rollback;`) demuestran este mecanismo — hace falta un `commit;` real para
poder verificar qué sobrevivió, así que este verify es distinto: cada bloque
ANTES/DESPUÉS hace su propio commit real dentro de la misma base efímera antes de
que el siguiente escenario lea el resultado.

## Qué demuestra

Para hoteles (`hoteles.guest`), citas (`citas.providers`) y rentas
(`rentas.guest_minimo`) — las 3 tablas más simples de cada vertical con `GRANT
INSERT` real a `authenticated` (elegidas para no necesitar la cadena completa de
FKs de una reserva/folio/cita real; el mecanismo que se prueba es independiente de
qué tabla se escriba):

1. **ANTES** (sin el hotfix): sesión de staff inserta una fila de negocio, llama
   `claim_email_outbox_batch` (falla `42501`), y hace `commit;` sobre la transacción
   ya abortada — la fila de negocio se PIERDE (`count(*)` = 0 tras el commit).
2. **DESPUÉS** (con el hotfix, mismo patrón que
   `packages/domain-citas/src/postgres-repository.ts:467-483`): el mismo drenado,
   ahora envuelto en `SAVEPOINT sp_inline_email_dispatch` / `ROLLBACK TO SAVEPOINT` +
   `RELEASE SAVEPOINT` en el catch — la fila de negocio PERSISTE (`count(*)` = 1 tras
   el commit).

Este verify demuestra el mecanismo a nivel SQL (idéntico al que ejecutan los 6
triggers inline vía `db.exec(...)` sobre `c.get("db")`); los tests unitarios de cada
trigger (`apps/api/tests/*-email-dispatch.spec.ts` y nuevos específicos del fix)
cubren la capa TypeScript con un doble de sesión que reproduce el estado abortado
(`AbortAwareFakeSession`, patrón local por archivo — ver
`packages/domain-citas/tests/upsert-customer-savepoint.spec.ts`).

## Cómo correrlo

```
scripts/verify-correo-inline-sesion-staff/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p. ej.
`brew install postgresql@17`). Levanta un cluster Postgres efímero en un directorio
temporal, aplica todas las migraciones reales de `supabase/migrations/` en orden,
corre los escenarios de `assertions.sql`, y apaga/borra el cluster al salir — no
toca ningún Postgres existente ni dato real.

## CI

Mismo contrato de 3 archivos (`bootstrap.sql` + `post-migrations.sql` +
`assertions.sql`) que el resto de `scripts/verify-*/` — `scripts/verify-real-
postgres-ci/run-gate.mjs` lo descubre solo (no hace falta tocar el workflow) y lo
corre en `.github/workflows/postgres-real-gate.yml` en cada PR/push.

## Por qué no es parte de `npm test`

Igual que el resto de `scripts/verify-*/` contra Postgres real (ver el README de
`verify-outbox-grants` para el detalle) — este monorepo no tiene todavía un tier de
pruebas contra Postgres real dentro de `vitest`.
