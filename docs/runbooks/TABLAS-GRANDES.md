# Tablas grandes: índices sin bloquear, retención y particionado

Estado: **propuesta**. Nada de la sección «Retención y particionado» está aplicado ni tiene migración; requiere
decisión de Javier. Lo que sí está en el repo es la política de índices (Ola 4, G2).

## 1. Índices sobre tablas grandes (vigente)

Tablas cubiertas (`TABLAS_GRANDES` en `scripts/verify-indices-tablas-grandes/check-indices-tablas-grandes.ts`):
`rentas.mensaje`, `core.llm_usage_daily`, `core.billing_webhook_log`, toda `*.*audit_log` y toda `*.*outbox`.

Un `create index` normal toma un lock SHARE: mientras construye, ningún INSERT/UPDATE de esa tabla avanza.
`create index concurrently` no bloquea escrituras, pero no puede ir dentro de una transacción. Por eso, desde
la versión `20240101000900`, todo índice nuevo sobre esas tablas va en dos archivos:

1. `scripts/indices-concurrentes/<NNNN_nombre>.sql`: `create index concurrently if not exists <nombre> …`.
   Se corre en producción **antes** de la migración, con autocommit:
   `psql "$URL" -v ON_ERROR_STOP=1 -f scripts/indices-concurrentes/<archivo>.sql` (nunca con `-1`).
2. La migración (paquete + espejo): `set lock_timeout = '5s'`, guarda que aborta si el índice quedó INVALID,
   `create index if not exists <mismo nombre> …` y `reset lock_timeout`. En producción es un no-op; en una base
   chica (CI, local) crea el índice.

Guard: `node --experimental-strip-types scripts/verify-indices-tablas-grandes/check-indices-tablas-grandes.ts`
(también en `packages/db/tests/indices-tablas-grandes-guard.spec.ts`). Verificación contra Postgres real:
`scripts/verify-indices-tablas-grandes/run.sh`.

Si un build concurrente se interrumpe, deja un índice INVALID con el nombre ocupado:
`drop index concurrently if exists <esquema>.<nombre>;` y repetir el paso 1.

Índices de `0100_indices_tablas_grandes` y su rollback (`drop index concurrently if exists …`):

| Índice | Tabla | Consulta que lo motiva |
|---|---|---|
| `messaging_outbox_email_reintento_idx` | `citas`, `despachos`, `hoteles`, `licitaciones`, `rentas`, `restaurantes` `.messaging_outbox` | `claim_email_outbox_batch` (0031): el índice parcial existente cubre `pending/processing`, la consulta pide `pending/failed`, así que no era usable |
| `mensaje_conversacion_creado_idx` | `rentas.mensaje` | historial de conversación ordenado por `creado_en` |
| `authz_audit_log_org_denegado_idx` | `core.authz_audit_log` | denegados por organización en la ficha del superadmin (0052) |

Pendiente aparte (no incluido): borrar `rentas.mensaje_conversacion_idx` (lo cubre el compuesto) con
`drop index concurrently` cuando el nuevo lleve un tiempo en producción.

## 2. Retención y particionado (propuesta, sin aplicar)

Criterio general: **retención antes que particionado**. Ninguna de estas tablas tiene hoy un volumen que
justifique particionar (Postgres maneja bien decenas de millones de filas con buenos índices), y particionar
una tabla existente exige recrearla (no se puede convertir en sitio), mover datos y reescribir PK/unique para
que incluyan la llave de partición. Se propone particionar solo cuando una tabla pase ~50 M filas o su purga
diaria tarde más de unos minutos.

| Tabla | Crece por | Propuesta de retención | ¿Particionar? |
|---|---|---|---|
| `<vertical>.messaging_outbox` | cada mensaje enviado (filas `sent`/`dead` nunca se borran) | borrar `sent` con más de 30 días y `dead` con más de 90, por lotes (`limit` + `for update skip locked`), una transacción por lote; respetar el bloqueo por retención legal de 0036 | no; con la purga queda acotada |
| `rentas.mensaje` | conversación con huésped | alinear con la retención de conversaciones por organización de 0036 (hoy `rentas` no purga); vaciar `texto` al vencer y conservar la fila (métricas) | no |
| `core.llm_usage_daily` | 1 fila por org/día/rol/modelo/carril | conservar 25 meses (comparativo anual + cierre fiscal); después agregar a mensual en una tabla resumen y borrar el diario | si se queda todo el histórico: partición por rango de `usage_date` anual |
| `core.billing_webhook_log` | cada webhook de Stripe | 18 meses (disputas y auditoría de cobro); borrar `payload` a los 90 días y conservar metadatos | no |
| `*.audit_log`, `core.authz_audit_log`, `core.impersonation_audit_log`, `core.plan_audit_log` | cada acción auditada (append-only por trigger) | requiere decisión legal: la propuesta es 5 años para bitácoras de cumplimiento (impersonación, planes, `hoteles.attendance_log`) y 13 meses para `authz_audit_log` (`allowed` podría bajar a 90 días). Como son append-only, el borrado necesita una función `security definer` de sistema que desactive el trigger solo para la purga, registrada en el registro de purgas de 0036 | `core.authz_audit_log` es la candidata más probable: partición mensual por `occurred_at` y la purga pasa a ser `detach` + `drop` de particiones viejas, sin `delete` |

Pasos si se aprueba (cada uno su PR, con `scripts/verify-*` y orden de despliegue):

1. Medir en producción (`select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(oid)) from pg_class …`)
   para fijar el orden por tamaño real.
2. Purga del outbox (la de menor riesgo: las filas `sent` no tienen otro lector).
3. Retención de `billing_webhook_log` y `llm_usage_daily` (requiere confirmar plazos con contabilidad).
4. Política de bitácoras (requiere decisión legal) y, solo si el volumen lo pide, particionado de `authz_audit_log`.

Decisiones pendientes de Javier: plazos de retención de bitácoras y de `billing_webhook_log`; si se conserva el
uso de IA diario más de 25 meses.
