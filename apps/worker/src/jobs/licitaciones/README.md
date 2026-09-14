# Vertical: licitaciones (worker)

Fase 8 — primer código real de este vertical en `apps/worker` (hasta esta
fase, este directorio solo tenía este README reservado y `apps/worker/src`
no tenía NINGUNA referencia a licitaciones — gap identificado por una
auditoría de paridad contra el repo origen).

## Qué hay aquí

- **`discover-tenders.ts`** — invoca, para una organización, todos los
  conectores del registro único (`@atiende/domain-licitaciones`,
  `connector-registry.ts`) que ya traen una implementación REAL
  (`descriptor.connector` presente). Hoy eso es exactamente uno:
  `compras_mx_historico` (histórico de contratos de ComprasMX vía CSV
  abierto de `datos.gob.mx`, ver
  `packages/domain-licitaciones/src/connectors/compras-mx-historico.ts` para
  el detalle completo, incluidas las desviaciones deliberadas respecto del
  repo origen). Cada corrida se registra vía `recordSourceRun`
  (REQ-146..150: estado explícito, evidencia, cobertura — nunca "0
  registros" en silencio).
- **`deadline-reminders.ts`** — escanea `submissionDeadline` de todas las
  convocatorias activas y persiste un recordatorio (deduplicado) por cada
  vencimiento próximo, vía `LicitacionesRepository.scanUpcomingDeadlineReminders`.

## Cómo se invocan (sin scheduler en proceso)

Mismo patrón que `jobs/hoteles/night-audit.ts` (leído primero como
plantilla): `apps/worker` no corre como proceso propio, así que estos
archivos exponen solo la lógica de orquestación. Las rutas HTTP internas que
los invocan viven en
`apps/api/src/routes/verticals/licitaciones/discover.ts`:

- `POST /internal/licitaciones/discover-tenders` — barrido de TODAS las
  organizaciones (`runDiscoverTendersSweep`).
- `POST /internal/licitaciones/deadline-reminders` — barrido de recordatorios
  (`runDeadlineReminderSweep`).

Ambas gateadas por `x-atiende-internal-secret`, pensadas para un cron
EXTERNO (Vercel Cron/Supabase Cron) — **este monorepo no configura todavía
esa entrada de cron en `vercel.json`** (mismo estado que
`citasRemindersRoutes`/`hotelesNightAuditRoutes`: la ruta HTTP existe y
funciona invocada manualmente/por curl, pero el disparo periódico real es
responsabilidad de la capa de despliegue, fuera del alcance de código de
esta fase — gap declarado, no silenciado).

## Gaps declarados y pendientes (para no fingir que esta fase es 100% completa)

- **Sin cursor persistido entre corridas**: `discover-tenders.ts` limita cada
  corrida a `DEFAULT_DISCOVER_TENDERS_LIMIT` (200) filas del CSV histórico
  (que documenta ~950 MB / probablemente millones de filas) y siempre
  empieza a leer desde el inicio del archivo — nunca "continúa donde se
  quedó" la corrida anterior. Los registros ya ingeridos se actualizan (no se
  duplican, el upsert es por `externalId`), pero avanzar más allá del límite
  requiere subir `limit` explícitamente. Una versión productiva real
  necesitaría un cursor/offset persistido — no construido en esta fase.
- **No verificado en vivo desde este entorno**: un intento real (HEAD/GET,
  2026-09-14) contra la URL del CSV histórico fue bloqueado (403 Access
  Denied) — ver `connector-registry.ts` para la evidencia completa y por qué
  `liveVerification.verified` se registra `false` pese a que el código es
  una implementación real y completa.
- **Sin UI en `/back-office`**: esta fase no tocó `apps/web` — el backoffice
  de licitaciones no distingue visualmente todavía las convocatorias
  ingeridas automáticamente (histórico, `status` por defecto `discovered`)
  de las de alta manual, más allá del campo `source` ya expuesto por la API
  (`GET .../tenders`). Filtrar/distinguir en la UI queda pendiente.
- **`compras_mx_historico` es un dataset de CONTRATOS YA CONCLUIDOS**, no de
  convocatorias abiertas — `submissionDeadline` siempre se ingesta `null`
  (nunca se fabrica una fecha límite falsa). Por diseño, este conector NUNCA
  alimentará `deadline-reminders.ts` con nada (no tiene plazo que recordar):
  los recordatorios de plazo solo tienen efecto sobre convocatorias con
  `submissionDeadline` real (hoy, siempre de alta manual).
