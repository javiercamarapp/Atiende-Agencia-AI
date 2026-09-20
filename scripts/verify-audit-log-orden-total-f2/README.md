# verify-audit-log-orden-total-f2

Cierra el hallazgo de auditoría de fase 2 (integridad) sobre `despachos.
audit_log`, `hoteles.fraude_audit_log` y `licitaciones.tender_audit_log` —
mismo patrón que PR #173 (`rentas.audit_log`, ver
`scripts/verify-rentas-bitacora-auditoria/`): agrega una columna de secuencia
(`seq bigint generated always as identity`, migraciones 011/despachos,
028/hoteles y 026/licitaciones) para dar un orden TOTAL determinista
(`created_at desc, seq desc`), porque `now()` (`created_at`) es CONSTANTE
dentro de una transacción de Postgres.

## Hallazgo real (lee esto antes que el código)

A diferencia de `rentas.audit_log` en el momento de PR #173, **ninguna de las
3 tablas de esta fase tenía, antes de este PR, un consumidor de lectura
paginada real**:

- `despachos.audit_log` y `hoteles.fraude_audit_log` son sinks de solo
  escritura (`ProductionDespachosAuditSink`/`ProductionHotelesFraudeAuditSink`
  escriben con SQL directo, nunca vía el repositorio) con una policy `select`
  sin ningún consumidor.
- `licitaciones.tender_audit_log` se escribe desde `upsertTenderManual`/
  `recordTenderVersion` (sin cambios en este PR) pero tampoco se leía
  paginado en ningún lado.

Este verify **no reproduce un bug observado en producción** — confirma que el
`listAuditLogPage`/`listFraudeAuditLogPage`/`listTenderAuditLogPage` que este
PR agrega a cada repositorio nace con orden total desde el día uno, contra
Postgres real (RLS/triggers/índices reales), no solo contra el repositorio en
memoria de cada `domain-<vertical>`.

## Qué demuestra cada escenario

Para cada una de las 3 tablas (despachos: 1-2, hoteles: 3-4, licitaciones:
5-6):

1. **Confirma la premisa del bug**: N filas escritas en la MISMA transacción
   comparten `created_at` (`count(distinct created_at) = 1`) — si esto dejara
   de ser cierto, el resto del escenario dejaría de probar lo que dice
   probar.
2. **Orden total exacto**: `order by created_at desc, seq desc` da el orden
   EXACTO inverso de escritura (más reciente = escrita al último = `seq` más
   alto), nunca un orden físico arbitrario del heap.
3. **Paginación estable**: la misma consulta con `limit`/`offset` distintos
   (exactamente la forma que arman `PostgresDespachosRepository.
   listAuditLogPage`/`PostgresHotelesRepository.listFraudeAuditLogPage`/
   `PostgresLicitacionesRepository.listTenderAuditLogPage`) no repite ni
   pierde ninguna fila entre dos páginas consecutivas.

despachos/hoteles ejercitan la función `security definer` real
(`despachos.record_audit_log`/`hoteles.record_fraude_audit_log`, sesión de
sistema — `auth.uid()` es NULL para el superusuario que corre este script,
igual que en producción). licitaciones ejercita un INSERT directo con el
mismo shape exacto que el SQL real de `upsertTenderManual`/
`recordTenderVersion` (`postgres-repository.ts`).

## Qué NO cubre

- RLS/GRANT de lectura (staff de la organización/property) — sin cambios en
  esta fase, ya vive desde las migraciones originales (008/017/007) sin
  ningún consumidor real que las ejercite todavía.
- El esquema intermedio "008/017/007 aplicada, 011/028/026 no" (`seq` no
  existe todavía): este runner (`run-gate.mjs`) siempre aplica TODAS las
  migraciones de `supabase/migrations/`, sin forma de saltarse una a
  propósito — esa cobertura vive en los `AbortAwareFakeSession` de
  `packages/domain-despachos/tests/audit-log-orden-total.spec.ts`,
  `packages/domain-hoteles/tests/fraude-audit-log-orden-total.spec.ts` y
  `packages/domain-licitaciones/tests/tender-audit-log-orden-total.spec.ts`.

## Cómo correrlo

```
scripts/verify-audit-log-orden-total-f2/run.sh
```

Requiere Postgres local (`initdb`/`pg_ctl`/`psql` en PATH — `brew install
postgresql`). También corre automáticamente en CI vía
`scripts/verify-real-postgres-ci/run-gate.mjs` (auto-descubre cualquier
`scripts/verify-*/` con `bootstrap.sql` + `post-migrations.sql` +
`assertions.sql`, sin tocar el workflow YAML).
