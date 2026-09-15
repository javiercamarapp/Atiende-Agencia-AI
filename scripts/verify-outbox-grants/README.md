# verify-outbox-grants

Verificación de las migraciones 86-91
(`packages/domain-*/migrations/*_email_outbox_authenticated_grants.sql`) contra un
Postgres **real** — algo que el resto de la suite (`npm test`) no puede hacer, porque
usa el repositorio en memoria de cada `domain-*`, que nunca aplica RLS ni GRANT (ver
el resto de `*.spec.ts` del repo, y el comentario de cabecera de
`packages/db/src/managed-postgres-engine.ts`). Corre a mano vía `run.sh` (ver
abajo) Y automáticamente en cada PR/push vía
`.github/workflows/postgres-real-gate.yml` (ver sección "CI" abajo).

## Qué demuestra

Antes de las migraciones 86-91, `citas`/`hoteles`/`restaurantes`/`despachos`/
`licitaciones`/`rentas.enqueue_messaging_outbox`/`claim_email_outbox_batch`/
`complete_email_outbox_job` (+ `organization_notification_recipients` de
despachos/licitaciones) eran `security definer` pero el `GRANT EXECUTE` solo se le
había dado a `service_role` — un rol que este monorepo nunca aprovisiona contra
Postgres real (`withAppSession` siempre conecta como `authenticated`). Contra
Postgres real, CUALQUIER llamada fallaba con `permission denied for function...`.

Este script demuestra, con Postgres real:

1. Después del fix, `authenticated` SÍ puede llamar estas funciones.
2. La verificación interna que cada función agrega (para no abrir un hueco de
   seguridad al otorgar el EXECUTE) SÍ bloquea a un staff sin acceso real al
   organization/property objetivo — nunca una fuga cross-tenant silenciosa.
3. Un bug real que se coló en el borrador de la migración 88 (hoteles) —
   `complete_email_outbox_job` escribía `last_error_class = p_status` en vez de
   `p_error` — quedó corregido antes de aplicarse (ver escenario 15).

## Cómo correrlo

```
scripts/verify-outbox-grants/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p. ej.
`brew install postgresql@17`). El script levanta un cluster Postgres efímero en un
directorio temporal, aplica las 91 migraciones reales de `supabase/migrations/` en
orden, corre los 16 escenarios de `assertions.sql`, y apaga/borra el cluster al
salir — no toca ningún Postgres existente ni dato real.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`) SÍ
corre en CI, automáticamente, en cada PR/push — ver
`.github/workflows/postgres-real-gate.yml` y
`scripts/verify-real-postgres-ci/README.md`. Ese runner ejecuta cada uno de los
16 escenarios de `assertions.sql` como su propia verificación pass/fail (no una
lectura humana de la salida de `psql`), así que un GRANT o una verificación de
autorización que se rompa en esta migración falla el build.

`run.sh` (este directorio) sigue existiendo por separado para correr la misma
verificación a mano contra un Postgres local efímero — útil para investigar un
fallo con más detalle o releer el comportamiento real sin depender de GitHub
Actions.

## Por qué no es parte de `npm test`

Este monorepo no tiene todavía ningún tier de pruebas contra Postgres real
dentro de `npm test`/`vitest` (documentado también en
`apps/api/tests/vercel.spec.ts` y en el comentario de cabecera de
`managed-postgres-engine.ts`) — agregar ese tier de forma genérica (spin-up/
teardown de Postgres para TODA la suite de `vitest`, no solo este fix puntual)
es una decisión de plataforma más amplia, fuera del alcance de este hallazgo.
El gate de CI descrito arriba cubre específicamente este fix sin depender de
ese tier general.
