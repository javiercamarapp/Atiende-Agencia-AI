# verify-rentas-cron-rls

Verificación de
`packages/domain-rentas/migrations/015_cron_publico_rls_escape_hatch.sql` contra un
Postgres **real** — algo que el resto de la suite (`npm test`) no puede hacer, porque
usa el repositorio en memoria de `domain-rentas`, que nunca aplica RLS ni GRANT (ver
el comentario de cabecera de `packages/db/src/managed-postgres-engine.ts`). Mismo
patrón exacto que `scripts/verify-outbox-grants/` (Ronda 14, migraciones 86-91) — ver
ese directorio para el precedente. Corre a mano vía `run.sh` (ver abajo) Y
automáticamente en cada PR/push vía `.github/workflows/postgres-real-gate.yml`
(ver sección "CI" abajo).

## Qué demuestra

Antes de esta migración, `checkout-sweep-cron.ts`/`ical-sync-cron.ts`/
`checkin-recordatorio.ts` (sesión de sistema, `withAppSession({userId: null})`, que
SIEMPRE conecta como `authenticated` con `auth.uid()` NULL — nunca `service_role`
real, mismo hallazgo raíz que `scripts/verify-outbox-grants/`) y el feed público
`ical-feed-publico.ts` recorrían la plataforma completa y encontraban SIEMPRE 0 filas
EN SILENCIO: toda policy RLS de estas tablas exigía
`core.has_property_access(auth.uid(), property_id)`, que con `auth.uid()` NULL es
SIEMPRE `false` — a diferencia del hallazgo de la migración 014 (GRANT EXECUTE
faltante), esto nunca lanzaba un error explícito.

Este script demuestra, con Postgres real, los 18 escenarios de `assertions.sql`:

1. La sesión de sistema ahora SÍ puede leer/escribir exactamente las tablas que cada
   una de las 4 rutas toca (`rentas.ocupacion`/`tarea_operativa`/
   `checklist_item_tarea` insert/`unidad`/`property_config`/`conflicto_calendario`/
   `canal_feed_externo` select+update/`evento_canal_importado`/`bloqueo_exportado`).
2. El escape hatch `auth.uid() is null` NUNCA se convierte en una fuga cross-tenant: un
   staff real sin membership/acceso a la property objetivo sigue RECHAZADO
   exactamente igual que antes (escenarios 7-8).
3. Las policies que la migración NO tocó a propósito siguen intactas: la sesión de
   sistema sigue SIN poder insertar `rentas.canal_feed_externo` (`connectFeed` es
   solo-staff) ni leer `rentas.checklist_item_tarea` (solo "Mis tareas", staff real) —
   escenarios 17-18.
4. El hallazgo adicional no anticipado por el reporte de la ronda anterior:
   `rentas.evento_canal_importado`/`rentas.bloqueo_exportado` nunca tuvieron policy de
   INSERT/UPDATE (solo SELECT) — ahora la sesión de sistema SÍ puede escribirlas, pero
   CUALQUIER staff real (incluso uno con membership real de la property) sigue
   RECHAZADO (escenario 13) — nunca fue parte del diseño que el staff escriba
   bookkeeping de sync directamente.

## Cómo correrlo

```
scripts/verify-rentas-cron-rls/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p. ej.
`brew install postgresql@17`). El script levanta un cluster Postgres efímero en un
directorio temporal, aplica las 94 migraciones reales de `supabase/migrations/` en
orden, corre los 18 escenarios de `assertions.sql`, y apaga/borra el cluster al
salir — no toca ningún Postgres existente ni dato real.

## Qué NO demuestra (fuera de alcance, documentado honestamente)

`checkin-recordatorio.ts` también hace `JOIN core.organization` (tabla CORE, no de
`domain-rentas`) para el nombre del tenant del correo transaccional — ese JOIN sigue
bloqueado por RLS (`core.organization` no recibió ningún escape hatch aquí, ver el
comentario de cabecera de la migración 015 y de `supabase/migrations/README.md`
entrada 94). Este script no lo cubre porque la migración no lo toca a propósito: es
el mismo gap ya documentado y aceptado en
`packages/domain-hoteles/migrations/008_night_audit.sql` (`citasRepo.
listActiveOrganizations()`), una decisión de plataforma que afecta a las 6
verticales por igual.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`) SÍ
corre en CI, automáticamente, en cada PR/push — ver
`.github/workflows/postgres-real-gate.yml` y
`scripts/verify-real-postgres-ci/README.md`. Ese runner ejecuta cada uno de los
18 escenarios de `assertions.sql` como su propia verificación pass/fail (no una
lectura humana de la salida de `psql`), así que una policy RLS que se rompa en
esta migración falla el build.

`run.sh` (este directorio) sigue existiendo por separado para correr la misma
verificación a mano contra un Postgres local efímero — útil para investigar un
fallo con más detalle o releer el comportamiento real sin depender de GitHub
Actions.

## Por qué no es parte de `npm test`

Mismo motivo que `scripts/verify-outbox-grants/README.md`: este monorepo no
tiene todavía ningún tier de pruebas contra Postgres real dentro de
`npm test`/`vitest` — agregarlo ahí es una decisión de plataforma más amplia,
fuera del alcance de este hallazgo. El gate de CI descrito arriba cubre
específicamente este fix sin depender de ese tier general.
