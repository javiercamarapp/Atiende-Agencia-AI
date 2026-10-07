# Vertical: licitaciones (api)

Rutas Hono de la vertical licitaciones, portadas de `licitaciones/apps/api/src/routes` — ver `docs/REQUISITOS.md` para el catálogo formal de requisitos (REQ-001..131).

## Fase 6 — seguimiento post-adjudicación (REQ-051..055)

Archivos: `contracts.ts` (REQ-050/051, máquina de estados del contrato + metadatos), `contractDocuments.ts` (REQ-052, extracción determinista del contrato firmado), `contractBilling.ts` (REQ-051, cobranza/facturas), `inconformidad.ts` (REQ-053, redactor de inconformidades), `falloAutopsy.ts` (REQ-054, autopsia del fallo + lecciones aprendidas) y `renewalRadar.ts` (REQ-055, radar de renovaciones). Lógica de dominio en `@atiende/domain-licitaciones` (`contract-lifecycle.ts`, `contract-extraction.ts`, `contract-billing.ts`, `business-days.ts`, `inconformidad.ts`, `fallo-autopsy.ts`, `renewal-radar.ts`).

**Explícitamente fuera de esta fase (huecos honestos, no fingidos):**

- **REQ-056** (calendario oficial de días inhábiles SABG): no construido -- requiere una fuente externa oficial. `business-days.ts` solo excluye sábados/domingos, más feriados que el llamador declare explícitamente (`holidays: string[]`); expuesto en cada respuesta como `calendarNote`/`CALENDAR_LIMITATION_NOTE` para que ningún cliente asuma un calendario oficial completo.
- **OCR/texto-desde-PDF real (CERRADO en Fase 11)**: hasta Fase 10 este monorepo no tenía, en NINGÚN vertical, un pipeline que convirtiera bytes de un PDF (nativo o escaneado) en texto -- ni para bases de licitación (`requirements/extract`, Fase 2) ni para el contrato firmado (`contract/documents`, Fase 6); ambas rutas solo aceptaban el texto YA EXTRAÍDO por página (`{pages:[{page,text}]}`). Fase 11 agrega `@atiende/domain-licitaciones::extractDocumentText` (`packages/domain-licitaciones/src/text-extraction.ts`, port ~literal del motor real del repo original -- `pdfjs-dist`, extracción página por página, límites anti "PDF bomb", saneamiento anti-XSS) y lo conecta en AMBAS rutas: cada documento ahora puede traer `contentBase64` (+ `mimeType`/`filename` opcionales) EN VEZ DE `pages` ya extraído; `requirements/extract` corre la extracción y alimenta el mismo `RequirementMatrixBuilder`/`LlmRequirementExtractor` de siempre (un documento sin texto extraíble se excluye y se reporta en `skippedDocuments`, nunca se inventa), `contract/documents` alimenta `extractContractFields` igual (un documento sin texto extraíble se rechaza 422 explícito). **Sigue sin haber OCR real de imagen** -- un PDF escaneado sin capa de texto queda `"requires_ocr"` explícito: ninguna librería/servicio de OCR de imagen está disponible en este monorepo, y esta fase NO inventa uno; ese caso sigue requiriendo texto pegado a mano (`pages`) como antes.
- **Step-up/2FA (L-01, construido)**: las transiciones sensibles del contrato (rescindir, penalizar, marcar en inconformidad, modificar y marcar pago, `CONTRACT_STEP_UP_TRANSITIONS`) exigen, además del rol (`DECISION_ROLES`/`WRITE_ROLES`), un token de step-up (header `X-Step-Up-Token`, emitido por `POST /auth/step-up` tras un código TOTP o de respaldo; vive 5 min, atado a usuario+organización+alcance). Alta/estado/respaldos/desactivación en `/auth/2fa/*` (`apps/api/src/routes/auth-2fa.ts`). Con la base sin la migración `0025` (o sin puerto de seguridad) NO se exige step-up y queda solo el control por rol. **Sigue pendiente**: "marcar revisado" de una inconformidad (`INCONFORMIDAD_REVIEW_ROLES`) todavía no pide step-up.
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

## L-04 — sala de guerra y junta de aclaraciones (`salaGuerra.ts`)

Bajo `/licitaciones/:propertyId/tenders/:tenderId/`: `GET sala-guerra` (tablero, bitácora, requisitos
importables, go/no-go ya registrado), `POST sala-guerra/items`, `POST sala-guerra/items/import-requirements`,
`PATCH sala-guerra/items/:itemId`, `GET|POST sala-guerra/entries` (una `decision` exige los roles de
go/no-go), `GET junta`, `PUT junta/config`, `POST junta/questions` (409 si ya existe una equivalente),
`POST junta/questions/draft` (borrador asistido; 503 sin proveedor LLM), `PATCH junta/questions/:id`,
`POST junta/questions/:id/transition` (aprobar exige owner/admin/analyst) y
`POST junta/reminders/:id/acknowledge`. Con la migración 029 pendiente las lecturas responden 200
con `available: false` y las escrituras 503. `AppDeps.licitacionesSalaGuerraRepo` es opcional (lo
cablea `production/deps.ts`); sin él las rutas responden 503 y el cron omite la junta.
El cron `/internal/licitaciones/deadline-reminders` vigila también el límite de envío de preguntas.

**L-25 — gate final** (`GET sala-guerra/gate`, cualquier miembro, solo lectura): checklist de integridad vivo, paquete
re-derivado contra el expediente vivo, sha256 de los bytes del ZIP guardado contra el manifiesto guardado, doble
aprobación (2/2, L-26; la aprobación única de la base sin migración 033 se muestra en ámbar declarado) y holgura al cierre
(24 h) en la zona horaria de la organización. Veredicto `listo`/`no_listo` con motivos. A menos de 24 h del cierre, sin
presentación declarada y con el paquete no listo emite `licitaciones.sala_guerra.paquete_no_listo` (dedupe por convocatoria,
mejor esfuerzo en SAVEPOINT). No presenta nada ante ningún portal.

**L-29 — bitácora** (`GET bitacora?fuente=&desde=&hasta=&limit=&offset=`, cualquier miembro, solo lectura): mezcla en orden
temporal la auditoría de alta/edición (`tender_audit_log`, orden total), las anotaciones de la sala, go/no-go, aprobaciones
vigentes del expediente y la declaración de presentación. Sin ids ni correos de otras personas (solo `esTuyo` y rol). Cada
fuente ausente en una base sin migrar aporta una lista vacía (SAVEPOINT), nunca un 500.

## L-05 — WhatsApp (`whatsapp.ts`)

- `GET|POST /v1/licitaciones/whatsapp/webhook`: público, firmado (`X-Hub-Signature-256` sobre los bytes crudos, verificador compartido `@atiende/domain-citas::verifyMetaSignature`), tope de 256 KB y límite de ritmo. Solo atiende mensajes del número remitente `LICITACIONES_WHATSAPP_PHONE_NUMBER_ID`; sin él (o sin repositorio) acusa recibo sin procesar. `SI`/`BAJA` (opt-in/opt-out) y botones `lic-wa:<token>` (decisión go/no-go).
- `GET|PUT /licitaciones/:propertyId/whatsapp/settings` y `POST .../whatsapp/opt-out`: el contacto del propio usuario.
- `POST /licitaciones/:propertyId/tenders/:tenderId/whatsapp/request-decision` (`GO_NO_GO_ROLES`): emite tokens y encola el mensaje con botones Go / No-Go.
- Base sin la migración 030: lecturas `available: false`, escrituras 503, webhook 200 sin procesar; nunca 500. El envío real sale por `POST /internal/whatsapp/dispatch` (ahora también drena `licitaciones`) y de forma inmediata best-effort tras encolar; nada de esto corre contra Graph API en tests ni en CI.

## L-08 — KYC negativo 69-B del SAT (`kyc69b.ts`)

- `GET /licitaciones/:propertyId/kyc-69b`: fichas de proveedores y competidores con semáforo, alertas (proveedor propio presunto/definitivo) y estado de la lista (cualquier rol).
- `POST .../kyc-69b/consultar` (`WRITE_ROLES`): `{ rfcs: string[] }` (1 a 50; el RFC viaja en el cuerpo, nunca en la URL ni en los logs). Un RFC inválido o genérico rechaza todo el lote (400); tope diario por organización → 429; ritmo por usuario 20/min.
- `POST .../kyc-69b/fichas` y `DELETE .../kyc-69b/fichas/:id` (`WRITE_ROLES`); `GET .../kyc-69b/consultas` (`DECISION_ROLES`): bitácora privada de la organización.
- La lista 69-B no se duplica: la migración 031 expone un lector definer sobre `despachos.efos_*`. Base sin la 031 (o sin la 014 de despachos): lecturas `available: false`, escrituras 503; nunca 500. `AppDeps.licitacionesKycRepo` es opcional (lo cablea `production/deps.ts`).

## L-30 / L-32 — campana de licitaciones y re-tamizado KYC (`avisos-campana.ts`, `alertNotifications.ts`)

- Avisos in-app (`core.notification`, catálogo `licitaciones.*`) en el punto de escritura o en el barrido existente, nunca en un GET, sin PII (solo conteos) y con clave de dedupe estable: `renovacion.por_vencer` (por organización y día) y `cobranza.factura_vencida` / `documentos.por_vencer` (por organización y semana) salen del barrido `/internal/licitaciones/alert-notifications`; `convocatoria.bases_modificadas` sale de la escritura que crea una versión NUEVA (≥ 2) de una convocatoria (alta manual con cambios, recálculo, re-extracción de requisitos); `kyc.proveedor_empeoro` sale del re-tamizado.
- `GET|POST /internal/licitaciones/kyc-69b/retamizar` (secreto interno): re-evalúa la **cartera** (fichas de `kyc_party`: proveedores y competidores registrados; no la bitácora de consultas) contra la edición más reciente de la lista 69-B, guarda el resultado por edición (`licitaciones.kyc_retamizado`, migración 034) y alerta SOLO cuando el semáforo de un proveedor empeora respecto de la evaluación anterior. La primera evaluación de un RFC es línea base (no alerta). Idempotente. No es un cron de `vercel.json`; la descarga automática de la lista queda fuera (tarea l21).
- Base sin la migración 034: el re-tamizado responde `disponible: false` y los documentos por vencer no emiten; nunca 500. `AppDeps.licitacionesAvisosRepo` es opcional (lo cablea `production/deps.ts`).

## L-27 — post-adjudicación estructurada (`postAdjudicacion.ts`, migración 035)

Garantías (cumplimiento, anticipo, vicios ocultos), hitos con responsable, convenios modificatorios y plazos de firma/entrega de garantía, por contrato (`.../tenders/:tenderId/contract/post-award`).

- `GET` resumen completo (cualquier miembro; trae `puedeEscribir`/`puedeDecidir` y la vigencia derivada de cada garantía y hito); `GET .../bitacora` (append-only) y `GET .../responsables` (staff de la organización, sin correo).
- `PUT .../plazos` (`WRITE_ROLES`): días hábiles que declara la organización; el servidor calcula la fecha límite de firma y de entrega con el calendario efectivo (L-22) y mueve la fecha límite de las garantías de cumplimiento aún pendientes. **Plazo legal no verificado contra la fuente primaria** (ficha `laassp-2025-plazos-firma-garantia` del registro normativo): no se fija ningún número de días ni artículo; validar con abogado.
- `POST .../garantias`, `POST .../hitos` (`WRITE_ROLES` + `Idempotency-Key`), `PATCH .../garantias/:id` y `.../hitos/:id`. Liberar o ejecutar una garantía exige `DECISION_ROLES`; una garantía liberada/ejecutada y un hito cumplido/cancelado ya no se editan (409). Montos como cadena decimal → centavos.
- `POST .../convenios` (`DECISION_ROLES` + `Idempotency-Key` + step-up `contract_sensitive` cuando la base ya tiene el 2FA): historial inmutable numerado por contrato; si cambia el plazo, el contrato toma la nueva fecha de fin en la misma transacción.
- Base sin la migración 035: lecturas `available: false`, escrituras 503, nunca 500 (`AppDeps.licitacionesPostAdjudicacionRepo` es opcional; lo cablea `production/deps.ts`).
- Alertas de campana (`avisos-campana.ts::avisarPostAdjudicacion`) desde el barrido existente `/internal/licitaciones/alert-notifications`; el cuerpo de respuesta trae `avisos_post_adjudicacion`. Sin crons nuevos.

## L-P3-12/17 — step-up de un solo uso y bitácora de escrituras

`requireStepUp(deps, { userId, organizationId, scope, token, db })` (`apps/api/src/second-factor.ts`) consume el `jti` del token en la sesión `db` de la acción (misma transacción). `auditoria.ts` es el puente de las rutas con `licitaciones.audit_trail`: `auditar(...)` tras cada escritura (datos de empresa —alta, edición y decisión—, configuración, perfil de matching, invitaciones y roles de staff, convocatoria y versiones, etapas de aprobación del expediente y manifiesto), `correlationDe`/`correlationParaConvocatoria` (header `X-Correlation-Id` saneado, herencia de la convocatoria, eco en la respuesta). `bitacoraOrganizacion.ts`: `GET .../audit-trail` (filtros, paginación por llave) y `GET .../audit-trail/tenders/:tenderId/trace`, solo owner/admin. Matriz de requisitos y mapeos: sin ruta de escritura en esta rama (llegan con la boveda de bases); cuando existan deben llamar a `auditar` (hueco declarado).
