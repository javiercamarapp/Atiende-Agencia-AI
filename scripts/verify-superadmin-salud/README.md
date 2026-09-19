# verify-superadmin-salud

Verificación, contra un Postgres **real**, de las 4 funciones nuevas de
`packages/db/migrations/0014_superadmin_salud_operativa.sql` (pantalla
`/superadmin/salud` — latidos de los 18 crons de `vercel.json`, salud
agregada de las 6 colas de mensajería, última corrida por fuente de
licitaciones):

| Función | Qué expone |
|---|---|
| `core.record_cron_heartbeat` | Función de SISTEMA (guard `auth.uid() is null`) — registra el latido de un cron. Única llamadora real: `apps/api/src/salud/with-heartbeat.ts::withHeartbeat`. |
| `core.list_cron_heartbeats_for_superadmin` | Un latido por cron registrado — estado/último error/duración/fallos consecutivos. |
| `core.get_outbox_health_for_superadmin` | Una fila por cada una de las 6 colas reales (`citas`/`hoteles`/`restaurantes`/`despachos`/`rentas`/`licitaciones`.`messaging_outbox`), incluso vacías — conteo por estado, edad del pendiente más viejo, muertos, último enviado. |
| `core.list_licitaciones_source_runs_for_superadmin` | La corrida más reciente por (organización, fuente) de `licitaciones.source_run`. |

Las 4 siguen el MISMO patrón que el resto del back office de plataforma (ver
`scripts/verify-superadmin-facturacion/`): las 3 lecturas son `security
definer` con `p_caller_id` explícito atado a `auth.uid() is not null and
auth.uid() = p_caller_id` + `core.is_platform_superadmin(p_caller_id)`; la
función de escritura (`record_cron_heartbeat`) es de sistema, con el guard
INVERSO (`auth.uid() is not null -> raise 42501`, mismo criterio que
`core.record_llm_usage`).

## Qué demuestra

15 escenarios (ver `assertions.sql` para el detalle exacto):

1. **`record_cron_heartbeat`**: sesión de sistema SÍ puede escribir un
   latido real (se verifica leyendo la fila de vuelta); una sesión
   `authenticated` real (con `auth.uid()` de un superadmin de verdad) es
   RECHAZADA (42501) — nunca solo un chequeo de rol en la capa TS; `anon` no
   puede ni ejecutar la función.
2. **`list_cron_heartbeats_for_superadmin`**: el superadmin real, con **su
   propia sesión**, ve el latido real sembrado; un staff **normal y
   autenticado** que pasa el UUID de un superadmin como `p_caller_id`
   obtiene CERO filas; una sesión de **sistema** que pasa ese mismo UUID
   también obtiene CERO filas (el patrón que `apps/api` usaría si
   `ProductionSaludRepository` olvidara abrir la sesión como el caller);
   `anon` no puede ejecutar.
3. **`get_outbox_health_for_superadmin`**: el superadmin ve las 6 colas
   reales (incluso las vacías — `count(*) = 6`, nunca menos por una cola sin
   filas) Y el conteo real de un mensaje recién encolado en
   `citas.messaging_outbox` dentro de la MISMA transacción; un staff normal
   / una sesión de sistema pasando el UUID del superadmin obtienen CERO
   filas — la función NUNCA filtra filas de un tenant a nadie que no sea
   superadmin; `anon` no puede ejecutar.
4. **`list_licitaciones_source_runs_for_superadmin`**: mismos 4 escenarios
   que arriba, contra la corrida real sembrada (`compras_mx_historico`,
   `captcha_detected`).

## Por qué esto importa

`core.cron_heartbeat`/las 6 tablas `messaging_outbox`/`licitaciones.source_run`
no tienen NINGÚN GRANT directo a `authenticated` — sin la atadura a
`auth.uid()` dentro de cada función `security definer`, cualquier sesión
`authenticated` real (staff de CUALQUIER organización) podría haber llamado
estas funciones por RPC directo pasando el UUID de un superadmin (no es un
secreto fuerte) y leído el estado operativo de TODA la plataforma — o, peor,
`record_cron_heartbeat` sin su guard permitiría a cualquier sesión real
falsificar latidos ("todo corrió bien") sin ser el propio backend.

## Cómo correrlo

```
scripts/verify-superadmin-salud/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres local, p. ej.
`brew install postgresql`). Si faltan, falla explícito en vez de fingir que
corrió algo — no bloquea `npm test`.

`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio
automáticamente (cualquier `scripts/verify-*/` con
`bootstrap.sql`+`post-migrations.sql`+`assertions.sql`) y lo corre en CI
contra el servicio `postgres:` de GitHub Actions — sin intervención manual.
