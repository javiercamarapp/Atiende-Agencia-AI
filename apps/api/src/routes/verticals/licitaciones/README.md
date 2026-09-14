# Vertical: licitaciones (api)

Rutas Hono de la vertical licitaciones, portadas de `licitaciones/apps/api/src/routes` — ver `docs/REQUISITOS.md` para el catálogo formal de requisitos (REQ-001..131).

## Fase 6 — seguimiento post-adjudicación (REQ-051..055)

Archivos: `contracts.ts` (REQ-050/051, máquina de estados del contrato + metadatos), `contractDocuments.ts` (REQ-052, extracción determinista del contrato firmado), `contractBilling.ts` (REQ-051, cobranza/facturas), `inconformidad.ts` (REQ-053, redactor de inconformidades), `falloAutopsy.ts` (REQ-054, autopsia del fallo + lecciones aprendidas) y `renewalRadar.ts` (REQ-055, radar de renovaciones). Lógica de dominio en `@atiende/domain-licitaciones` (`contract-lifecycle.ts`, `contract-extraction.ts`, `contract-billing.ts`, `business-days.ts`, `inconformidad.ts`, `fallo-autopsy.ts`, `renewal-radar.ts`).

**Explícitamente fuera de esta fase (huecos honestos, no fingidos):**

- **REQ-056** (calendario oficial de días inhábiles SABG): no construido -- requiere una fuente externa oficial. `business-days.ts` solo excluye sábados/domingos, más feriados que el llamador declare explícitamente (`holidays: string[]`); expuesto en cada respuesta como `calendarNote`/`CALENDAR_LIMITATION_NOTE` para que ningún cliente asuma un calendario oficial completo.
- **OCR/texto-desde-PDF real (CERRADO en Fase 11)**: hasta Fase 10 este monorepo no tenía, en NINGÚN vertical, un pipeline que convirtiera bytes de un PDF (nativo o escaneado) en texto -- ni para bases de licitación (`requirements/extract`, Fase 2) ni para el contrato firmado (`contract/documents`, Fase 6); ambas rutas solo aceptaban el texto YA EXTRAÍDO por página (`{pages:[{page,text}]}`). Fase 11 agrega `@atiende/domain-licitaciones::extractDocumentText` (`packages/domain-licitaciones/src/text-extraction.ts`, port ~literal del motor real del repo original -- `pdfjs-dist`, extracción página por página, límites anti "PDF bomb", saneamiento anti-XSS) y lo conecta en AMBAS rutas: cada documento ahora puede traer `contentBase64` (+ `mimeType`/`filename` opcionales) EN VEZ DE `pages` ya extraído; `requirements/extract` corre la extracción y alimenta el mismo `RequirementMatrixBuilder`/`LlmRequirementExtractor` de siempre (un documento sin texto extraíble se excluye y se reporta en `skippedDocuments`, nunca se inventa), `contract/documents` alimenta `extractContractFields` igual (un documento sin texto extraíble se rechaza 422 explícito). **Sigue sin haber OCR real de imagen** -- un PDF escaneado sin capa de texto queda `"requires_ocr"` explícito: ninguna librería/servicio de OCR de imagen está disponible en este monorepo, y esta fase NO inventa uno; ese caso sigue requiriendo texto pegado a mano (`pages`) como antes.
- **Step-up/2FA real**: el repo original protegía las transiciones sensibles del contrato (rescindir/penalizar/marcar en inconformidad/modificar) y "marcar revisado" de una inconformidad con verificación en dos pasos (`lib/step-up.ts`). Este monorepo fusionado no tiene esa infraestructura para ningún vertical todavía -- el equivalente de esta fase es exigir `DECISION_ROLES`/`INCONFORMIDAD_REVIEW_ROLES` (más estrictos que `WRITE_ROLES`) en su lugar, documentado como un control más débil que 2FA real.
- **REQ-054 "ronda 7" del origen** (análisis automatizado de causas de no adjudicación contra la matriz de requisitos, y el enlace automático autopsia→inconformidad vía `sourceAutopsyId`): no portado -- es valor agregado sobre el REQ-054 base (registrar la autopsia + lecciones aprendidas), no el requisito mismo.
- **REQ-055 "convocatorias históricas de la misma entidad"**: el repo original enriquecía cada alerta de renovación con hasta 5 convocatorias previas de la misma `contracting_body` como contexto de apoyo. Esta fase detecta alertas únicamente a partir de `contracts.end_date` propio, sin ese enriquecimiento.
- **Sin cola de trabajos (`jobs`)**: a diferencia del repo original, este monorepo no tiene un sistema de colas genérico para ningún vertical -- las "alertas" de cobranza (facturas vencidas) se calculan en vivo en cada lectura (`GET .../contract/receivables`), y las alertas de renovación se persisten directamente como filas consultables (`GET .../renewals/alerts`). **Actualizado en Fase 10** (ver sección propia abajo): ambas, más `tender_deadline_reminder` (Fase 8), ya tienen un barrido periódico real que las despacha proactivamente por correo -- lo que seguía faltando no era una cola de trabajos genérica (ese patrón de "ruta interna + scheduler externo" ya existía desde Fase 8), sino el DESPACHO -- que alguien tuviera que abrir el panel y consultarlas a mano.

## Fase 7 — endpoints nuevos para el backoffice web (gap: "el panel casi no existe")

El panel web (`apps/web/src/verticals/licitaciones/`, ver su propio README)
llegaba a Fase 6 con solo una pantalla de login SIN MONTAR en `App.tsx` -- ni
siquiera el login era alcanzable, y todo lo de abajo (checklist/matching/
go-no-go/contratos/...) solo era operable vía API cruda. Esta fase agrega los
endpoints de LECTURA que faltaban para que el panel pudiera existir de verdad,
sin inventar ninguna regla de negocio nueva -- solo exponer lo que
`domain-licitaciones` ya calculaba:

- **`admin.ts`** (archivo nuevo): `GET /v1/licitaciones/:orgSlug/admin/branches`
  -- resuelve propertyId(s) desde el slug de la organización, mismo patrón
  exacto que `GET /v1/citas/:orgSlug/admin/branches`. Requirió agregar
  `findOrganizationBySlug`/`listPropertiesForOrganization` a
  `LicitacionesRepository` (interfaz en `repository.ts`, implementación real
  en `in-memory-repository.ts` y `postgres-repository.ts` -- esta última lee
  directo de `core.organization`/`core.property`, sin tabla propia de
  licitaciones y sin migración SQL nueva, esas tablas del núcleo ya existían
  desde `0001_core_schema.sql`).
- **`tenders.ts`** (2 rutas nuevas, mismo archivo ya existente): `GET
  /licitaciones/:propertyId/tenders` (lista TODAS las convocatorias de la
  organización con su `TenderRecord` completo) y `GET
  /licitaciones/:propertyId/tenders/:tenderId` (detalle de una). Antes de esta
  fase, `GET .../tenders/matching` (Fase 3, matching.ts) era el ÚNICO
  endpoint de lectura de convocatorias y solo trae `MatchResult`
  (score/elegibilidad), sin título ni fecha límite -- insuficiente para
  pintar cualquier lista o ficha real en un panel. El segmento `:tenderId` de
  la ruta de detalle está restringido a forma de UUID
  (`:tenderId{[0-9a-fA-F-]{36}}`) porque, sin esa restricción, esta ruta
  también capturaba `GET .../tenders/matching` tratando "matching" como un
  tenderId literal -- dos sub-apps Hono montadas en "/" resuelven ambigüedades
  de ruta por orden de registro, no por especificidad, en este proyecto.
  Ambas rutas son de solo lectura, sin restricción de rol más allá de
  membership (mismo criterio que matching.ts: ver el listado no es una
  decisión).

Ningún endpoint de escritura nuevo en esta fase. El resto del panel visual
(propuesta técnica/económica, cierre, ejecución del checklist con carga real
de documentos, contratos/cobranza/inconformidades/autopsia/renovación) sigue
sin pantalla -- ver la sección "Explícitamente fuera de esta fase" del README
del lado web.

## Fase 10 — despacho proactivo real de alertas (gap: "nadie las consulta")

**`alertNotifications.ts`** (archivo nuevo): 2 rutas internas, mismo patrón
gateado por `internalOrCronSecretMatches` (`x-atiende-internal-secret` o
`Authorization: Bearer`, ver `../../../http-security.ts`) que `discover.ts`
(Fase 8) -- pensadas para un scheduler externo (Vercel Cron/Supabase Cron).

- **`GET`/`POST /internal/licitaciones/alert-notifications`** -- el barrido
  real (`@atiende/worker::runAlertNotificationSweep`): por cada organización
  activa, escanea `tender_deadline_reminder` (Fase 8) + `renewal_alert`
  (Fase 6) + facturas vencidas de `contract_invoice` (Fase 6) y ENCOLA un
  correo real por cada alerta nueva al responsable (`owner`/`admin`) de la
  organización -- antes de Fase 10, las 3 eran solo registros que alguien
  debía abrir el panel para consultar.
- **`GET`/`POST /internal/licitaciones/email-dispatch`** -- drena
  `licitaciones.messaging_outbox` (`channel='email'`, migración 018) vía
  Resend, MISMO motor real (`dispatchPendingEmailJobs`) que
  `../citas/email-dispatch.ts`/`../rentas/email-dispatch.ts`, nunca
  reinventado.

Licitaciones NO es una de las 3 verticales con agente de WhatsApp
(`@atiende/whatsapp-gateway` -- solo citas/hoteles/restaurantes, ver ese
paquete), así que correo es el ÚNICO canal real disponible aquí; ver
`packages/domain-licitaciones/src/alert-notifications.ts` para el detalle
completo de esa decisión.

## Fase 12 — cierre del hallazgo ALTA "sin cron configurado" (las 4 rutas internas)

Hasta Fase 11, estas 2 rutas y las 2 de `discover.ts` (Fase 8) existían y
funcionaban invocadas a mano (curl/tests), pero `vercel.json` no tenía
ninguna entrada `crons` apuntándoles -- el pipeline de correo (barrido +
outbox + dispatcher por Resend) quedaba probado pero nunca disparado en
producción, así que ningún responsable recibía nada (ver
`apps/worker/src/jobs/licitaciones/README.md` para el gap tal como estaba
declarado antes de esta fase).

Cerrado así:

1. **`vercel.json`** ahora declara `crons` reales para las 4 rutas (una
   entrada por hora, 05:00-08:00 UTC, en el orden
   discover-tenders→deadline-reminders→alert-notifications→email-dispatch --
   la separación de una hora entre cada una es intencional: da margen a que
   la corrida anterior termine, dado que el plan Hobby de Vercel no
   garantiza precisión de minuto, solo la hora exacta ±59min, ver
   `docs/DEPLOY.md`).
2. Vercel Cron dispara SIEMPRE con `GET` y no permite headers custom en su
   configuración -- por eso las 4 rutas (2 aquí + 2 en `discover.ts`) ahora
   se registran con `app.on(["GET", "POST"], ...)` en vez de solo
   `app.post(...)`. `POST` con el header `x-atiende-internal-secret` sigue
   funcionando exactamente igual que antes (curl manual, los tests de
   integración existentes no cambiaron su forma de invocar).
3. El secreto que Vercel Cron manda automáticamente en esa request `GET` es
   `Authorization: Bearer $CRON_SECRET` (env var propia de Vercel, **solo**
   si existe en el proyecto -- Vercel nunca la inventa). `internalOrCronSecretMatches`
   (`../../../http-security.ts`) acepta esa forma ADEMÁS del header custom de
   siempre, ambas verificadas contra el mismo `INTERNAL_SECRET`/`ApiEnv.internalSecret`
   -- **requiere que el operador dé de alta `CRON_SECRET` en el dashboard de
   Vercel con el MISMO valor que `INTERNAL_SECRET`** (documentado en
   `.env.example`); sin ese paso de configuración externa (fuera de alcance
   de este cambio de código, igual que pegar cualquier otra env var real en
   Vercel) el cron dispara pero cada corrida recibe 401.

**Sigue sin resolver, declarado honestamente:** el plan Hobby de Vercel limita
cron jobs a una corrida diaria por ruta (ver `docs/DEPLOY.md`), así que en ese
plan el correo de alerta puede tardar hasta ~24h en despacharse desde que se
crea la alerta -- para despacho casi en tiempo real (cada minuto) hace falta
plan Pro, cambio de infraestructura/costo fuera de alcance de este cambio de
código.
