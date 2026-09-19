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
- **`alert-notifications.ts`** (Fase 10) — el gap que cerraba esta fase:
  `deadline-reminders.ts` de arriba (Fase 8) y las alertas de renovación
  (Fase 6, `scanRenewalAlerts`) creaban registros REALES, pero nada los
  despachaba proactivamente ni las revisaba con un barrido periódico
  transversal (renovación solo se disparaba a mano desde el panel, `POST
  .../renewals/scan`); las facturas vencidas de cobranza (Fase 6) ni
  siquiera tenían una lectura transversal, solo un `status` calculado en
  vivo por contrato. Expone `runRenewalAlertSweep`/`runCollectionAlertSweep`
  (los 2 barridos transversales nuevos) y `runAlertNotificationSweep` (el
  orquestador real: las 3 fuentes + encola un correo por cada alerta al
  responsable de la organización, vía
  `@atiende/domain-licitaciones::alert-notifications.ts`/`email-dispatch.ts`
  — el mismo motor de correo por Resend que citas/rentas ya tienen, nunca
  reinventado; licitaciones no es una de las 3 verticales con WhatsApp, ver
  `packages/whatsapp-gateway/README.md`).

## Cómo se invocan (sin scheduler en proceso)

Mismo patrón que `jobs/hoteles/night-audit.ts` (leído primero como
plantilla): `apps/worker` no corre como proceso propio, así que estos
archivos exponen solo la lógica de orquestación. Las rutas HTTP internas que
los invocan viven en
`apps/api/src/routes/verticals/licitaciones/discover.ts` y
`.../alertNotifications.ts` (Fase 10):

- `POST /internal/licitaciones/discover-tenders` — barrido de TODAS las
  organizaciones (`runDiscoverTendersSweep`).
- `POST /internal/licitaciones/deadline-reminders` — barrido de recordatorios
  (`runDeadlineReminderSweep`).
- `POST /internal/licitaciones/alert-notifications` (Fase 10) — el barrido
  combinado real (`runAlertNotificationSweep`): recordatorios de plazo +
  alertas de renovación + facturas vencidas, con ENCOLADO de correo real por
  cada alerta nueva.
- `POST /internal/licitaciones/email-dispatch` (Fase 10) — drena
  `licitaciones.messaging_outbox` (`channel='email'`) vía Resend
  (`dispatchPendingEmailJobs`).

Las 4 gateadas por `internalOrCronSecretMatches` (`x-atiende-internal-secret`
o `Authorization: Bearer`, ver `apps/api/src/http-security.ts`), pensadas
para un cron EXTERNO (Vercel Cron/Supabase Cron).

**Actualizado (Fase 12, cierre del hallazgo ALTA "sin cron configurado")**:
`vercel.json` (raíz del repo) ya declara `crons` reales apuntando a las 4 --
ver `apps/api/src/routes/verticals/licitaciones/README.md` sección "Fase 12"
para el detalle completo del mecanismo (GET vs POST, `CRON_SECRET` de Vercel,
límites del plan Hobby). Este gap YA NO aplica aquí; sigue aplicando IGUAL
que antes a `citasRemindersRoutes`/`hotelesNightAuditRoutes` (otras
verticales, fuera de alcance de esta fase).

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

## Fase 9 — cobertura real de licitaciones VIGENTES (OCDS + agregador)

Hasta la Fase 8, NINGÚN conector veía una licitación vigente (el único real,
`compras_mx_historico`, es histórico). Esta fase agrega 3 conectores más al
registro único (`packages/domain-licitaciones/src/connector-registry.ts`),
descubiertos con peticiones GET/POST REALES contra cada fuente (no solo
investigación de documentación) — estado honesto por fuente:

| id | `connector` real | `liveVerification.verified` | Produce vigentes hoy | Motivo |
|---|:-:|:-:|:-:|---|
| `nl_ocds` | Sí | **true** | **Sí** | API OCDS pública de Nuevo León (`https://api-ocds.nl.gob.mx/api/releases`). Verificado 2026-09-19: 2 páginas reales leídas, 1938 ocids únicos, 333 vigentes (todas por `tender.status === "active"`; NINGUNA de las verificadas traía además un `tenderPeriod.endDate` futuro — gap real: hoy este conector alimenta sobre todo convocatorias vigentes SIN fecha límite conocida, así que rara vez dispara `deadline-reminders.ts` por sí solo). |
| `cdmx_ocds` | Sí | false | No (hoy) | Implementación real y completa (CSV de `datos.cdmx.gob.mx`, recurso `concursos-compras-publicas`) — pero el recurso verificado está ESTANCADO (última fila real `2023-11-29` de 6917 filas descargadas y revisadas completas el 2026-09-19, pese a que el catálogo reporta "modificado 2026-08-28": un refresco de metadatos, no de contenido). El dashboard OCDS-branded de Tianguis Digital (`datosabiertostianguisdigital.cdmx.gob.mx`) SÍ muestra cifras 2026 recientes, pero su descarga es una acción Livewire gateada por sesión sin contrato público estable — un intento real de reproducirla devolvió `500` (ver `packages/domain-licitaciones/src/connectors/ocds/cdmx-ocds-connector.ts` para la evidencia completa de ambos intentos). |
| `compras_mx_historico` | Sí (Fase 8) | false (403) | No (por diseño) | Histórico, contratos ya concluidos. |
| `aggregator` | Sí | false (`not_configured`) | No | Sin proveedor de agregación elegido — gateado por `LICITACIONES_AGGREGATOR_API_KEY`/`LICITACIONES_AGGREGATOR_BASE_URL` (ver `docs/CREDENCIALES.md`); es la única vía realista a cobertura nacional amplia (ComprasMX en vivo/DOF no se automatizan — ver decisión ya tomada, evadir reCAPTCHA/Akamai o scrapear prosa libre sin API queda fuera de alcance). |
| `comprasmx`/`dof`/`ocds_shcp`/`pdn_s6`/`state_portal` | No | false | No | Siguen siendo placeholders deliberados (sin `connector`), sin cambios en esta fase. |

Decisión CPV/CUCOP (ver `packages/domain-licitaciones/src/connectors/ocds/map-ocds-release.ts`):
`TenderSourceIngestCandidate.cpvCodes` es `string[]` plano sin campo
`scheme` — el código de cada fuente se conserva TAL CUAL (numérico,
jerárquico, tipo CUCoP/partida en Nuevo León) porque
`matching-engine.ts::scoreClassifiers` ya compara por prefijo jerárquico
numérico, agnóstico del esquema; no se reetiqueta ni normaliza.

Un run real del conector `nl_ocds` (sin `fetchImpl` inyectado, contra la API
real) hoy: 2 páginas × ~10 MB, ~1800 releases/página, 333 convocatorias
vigentes detectadas de 1938 ocids únicos en 2 páginas — ninguna con
`submissionDeadline` real todavía (ver tabla arriba).
