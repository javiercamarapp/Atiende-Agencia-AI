# verify-superadmin-resumen

Verificación, contra un Postgres **real**, de las 15 funciones nuevas de
`packages/db/migrations/0015_superadmin_resumen_diario.sql` (resumen diario
automático — `core.daily_ops_summary` + 11 lecturas de SOLO-SISTEMA + 2
escrituras de SOLO-SISTEMA + 2 lecturas para el back office).

| Función | Qué expone |
|---|---|
| `core.list_cron_heartbeats_for_system` / `core.get_outbox_health_for_system` / `core.list_licitaciones_source_runs_for_system` / `core.get_llm_platform_budget_for_system` | Equivalentes de SOLO-SISTEMA (`auth.uid() is null`) de las 4 funciones `*_for_superadmin` ya existentes (Salud operativa/Gasto de API) — el agregador del resumen diario corre en sesión de sistema, así que las originales (atadas a `auth.uid() = p_caller_id`) nunca le devolverían nada. |
| `core.get_llm_usage_total_for_system` / `core.list_llm_usage_top_organizaciones_for_system` | Gasto de LLM del día (total de plataforma + top organizaciones). |
| `core.get_organizaciones_staff_nuevos_for_system` / `core.get_prospectos_agregado_for_system` / `core.get_facturacion_agregado_for_system` / `core.count_break_glass_abiertos_for_system` | Secciones nuevas del resumen — todas filtran por la ventana `[p_desde, p_hasta)` de un día calendario en America/Mexico_City, resuelta en TS (`apps/api/src/resumen-diario/motor.ts::ventanaDiaMexico`). |
| `core.list_platform_superadmin_emails_for_system` | Destinatarios reales del correo del resumen. |
| `core.upsert_daily_ops_summary` / `core.mark_daily_ops_summary_email_sent` | Escritura de SOLO-SISTEMA, idempotentes por `fecha` (upsert) y por "un solo envío" (marcado de correo). |
| `core.list_daily_ops_summaries_for_superadmin` / `core.get_daily_ops_summary_for_superadmin` | Lecturas del back office — MISMO patrón que el resto de plataforma (`auth.uid() = p_caller_id` + `core.is_platform_superadmin`). |

## Qué demuestra

38 escenarios (ver `assertions.sql` para el detalle exacto):

1. **Las 11 funciones `*_for_system`**: una sesión de SISTEMA (`auth.uid()`
   null) SÍ puede leer — verificado contra datos reales sembrados (un latido
   de cron, las 6 colas de mensajería, una corrida de licitaciones, el tope
   semilla de $1000 USD/mes de plataforma, un gasto de LLM real registrado
   vía `core.record_llm_usage`, una organización/staff/prospecto/factura
   dentro y fuera de la ventana de prueba, un acceso break-glass real, el
   correo real de un superadmin). Una sesión **REAL** (`auth.uid()` de un
   superadmin de verdad) es RECHAZADA con `42501` — nunca solo un chequeo de
   rol en la capa TS; `anon` no puede ni ejecutar (sin GRANT).
2. **Filtrado por ventana**: `get_organizaciones_staff_nuevos_for_system` /
   `get_prospectos_agregado_for_system` / `get_facturacion_agregado_for_system`
   / `count_break_glass_abiertos_for_system` SOLO cuentan lo que cae dentro
   de `[p_desde, p_hasta)` — verificado con fixtures deliberadamente DENTRO y
   FUERA de la ventana de prueba (una organización/staff/prospecto/factura
   viejos, de hace 30-60 días, NUNCA aparecen en los conteos "de hoy").
3. **`upsert_daily_ops_summary` es idempotente por fecha**: una segunda
   llamada con la MISMA fecha ACTUALIZA la fila existente (mismo
   `creado_en`, `narrativa`/`generado_por` nuevos) — nunca duplica. Verificado
   leyendo de vuelta con `get_daily_ops_summary_for_system` — `core.
   daily_ops_summary` NO tiene NINGÚN GRANT directo (ni para
   `authenticated`), confirmado real (`permission denied for table
   daily_ops_summary` al intentar un `select` directo durante el desarrollo
   de este script, ver "Hallazgo real" abajo).
4. **`mark_daily_ops_summary_email_sent` es "un solo envío por fecha"**: la
   primera llamada marca (retorna `true`), una segunda llamada la MISMA
   fecha NO vuelve a marcar (retorna `false`).
5. **`list_daily_ops_summaries_for_superadmin` / `get_daily_ops_summary_for_superadmin`**:
   el superadmin real, con SU PROPIA sesión, ve el resumen real; un staff
   normal (autenticado, NO superadmin) o una sesión de SISTEMA que pasan el
   UUID del superadmin como `p_caller_id` obtienen CERO filas (nunca un
   error que confirme/niegue si hay datos); `anon` no puede ejecutar.
6. **Hallazgo endurecido del 19-sep (rubro B) -- SQLSTATE 42883 no es solo
   "function does not exist"**: escenarios 37/38 confirman contra Postgres
   REAL que "operator does not exist: uuid = text" (comparar tipos
   incompatibles, un bug real) y "function ... does not exist" (una función
   genuinamente inexistente, el caso normal de "migración pendiente")
   comparten el MISMO SQLSTATE 42883 pero un mensaje MUY distinto -- la base
   real que `packages/db/src/sql-errors.ts::isUndefinedFunctionError`/
   `isMigrationPendingError` usan para no confundir un bug real de tipos con
   una migración sin aplicar (ver `packages/db/tests/sql-errors.spec.ts` para
   la prueba unitaria que fija el texto exacto de ambos mensajes).

## Hallazgos reales durante el desarrollo de este script (ambos corregidos)

- **Cast implícito faltante en `get_llm_platform_budget_for_system`**: la
  columna `spend_this_month_micro_usd` (declarada `bigint`) se calculaba con
  `coalesce(sum(...), 0)` sin `::bigint` explícito — `sum()` de una columna
  `bigint` devuelve `numeric` en Postgres, y a diferencia de una función
  `language sql` (donde el motor coacciona el resultado final de forma más
  laxa), un `return query` de `language plpgsql` exige que los tipos de la
  consulta calcen EXACTO con los del `returns table`. Sin el cast, la función
  fallaba en tiempo de ejecución con `structure of query does not match
  function result type` — nunca detectado por `InMemoryResumenDiarioRepository`
  (que no ejecuta SQL real), exactamente el tipo de hueco que este script
  existe para atrapar.
- **Confirmado (no un bug, el diseño esperado)**: `core.daily_ops_summary` no
  tiene GRANT directo ni para `authenticated` — un `select` directo contra la
  tabla (incluso en sesión de sistema) falla con `permission denied`; todo
  acceso real pasa por las funciones `security definer`. El escenario 26 de
  `assertions.sql` originalmente intentaba verificar la idempotencia con un
  `select count(*) from core.daily_ops_summary`, y ese intento fallando así
  fue la confirmación en vivo de que el diseño "sin acceso directo" sí se
  cumple — se corrigió para leer vía `get_daily_ops_summary_for_system` en
  vez de la tabla.

## Por qué esto importa

`core.daily_ops_summary`/`core.cron_heartbeat`/las 6 tablas
`messaging_outbox`/`licitaciones.source_run`/`core.organization_billing`/
`core.prospecto`/`rentas.break_glass_session` no tienen GRANT directo a
`authenticated` para este feature — sin la atadura a `auth.uid()` dentro de
cada función `security definer`, cualquier sesión `authenticated` real
(staff de CUALQUIER organización) podría haber llamado estas funciones por
RPC directo pasando el UUID de un superadmin (no es un secreto fuerte) y
leído el estado operativo completo de la plataforma — o, peor,
`upsert_daily_ops_summary`/`mark_daily_ops_summary_email_sent` sin su guard
permitirían a cualquier sesión real falsificar el resumen que ve el dueño
cada mañana, o disparar un correo falso.

## Cómo correrlo

```
scripts/verify-superadmin-resumen/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres local, p. ej.
`brew install postgresql`). Si faltan, falla explícito en vez de fingir que
corrió algo — no bloquea `npm test`.

`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio
automáticamente (cualquier `scripts/verify-*/` con
`bootstrap.sql`+`post-migrations.sql`+`assertions.sql`) y lo corre en CI
contra el servicio `postgres:` de GitHub Actions — sin intervención manual.

Corrida real más reciente (local, Postgres efímero vía `initdb`/`pg_ctl`):
**36/36 escenarios pasaron** — los 12 marcados `should_fail` terminaron en
`ERROR` (código `42501` para las funciones de sistema, "permission denied"
para `anon`), los 24 restantes devolvieron los valores reales esperados.
