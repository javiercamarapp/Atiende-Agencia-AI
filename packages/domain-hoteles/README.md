# @atiende/domain-hoteles

Fase 1 de la migración del vertical hoteles — construido (ver `docs/REQUISITOS.md`
para el detalle de diseño y el commit que lo introdujo).

Subconjunto real (no la totalidad de `hoteles/packages/domain-hotel`, 34 archivos)
portado para sostener los 3 flujos elegidos:

- `folioEngine.ts` — cálculo de cargos por concepto, autorización de descuentos, la
  guarda anti-fraude de identidad de un cargo a habitación (REQ-AB-012:
  `assertRoomChargeIdentityVerified`/`ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY`) y las
  reglas de cierre de folio.
- `taxes.ts` / `money.ts` — IVA/ISH paramétricos por property + redondeo centralizado.
- `fnbAllergyGuard.ts` — guardia de alergias de F&B (REQ-AB-004): sin confirmación
  humana de cocina, ningún endpoint puede afirmar que un platillo es seguro.
- `quote.ts` — motor de cotización determinista (REQ-REV-001/REQ-RES-002), guardia
  anti-alucinación de precio: `parseQuoteInput` nunca hace spread del body de entrada,
  arma el objeto campo por campo desde las columnas reales de `hoteles.rate_plan` — un
  precio "sugerido" externo es estructuralmente imposible que llegue a `computeQuote`.
  Adaptación deliberada del origen: sin `zod` (ninguna otra ruta/paquete de
  atiende-fusion lo usa), la misma garantía se logra por construcción del objeto.
- `overbooking.ts` — soporte de dominio de disponibilidad (sin ruta propia expuesta).
- `roles.ts` — mapeo `HOTEL_ROLES` (8 roles finos) -> `platformRole`/`verticalRole` de
  `@atiende/core-tenancy` (ver diseño Fase 1 §2 — decisión propia de este paquete, no
  1:1 con restaurantes por tener un rol de origen más plano).

Adaptadores duales (mismo patrón que `@atiende/domain-restaurantes`):
`InMemoryHotelesRepository` (tests, dev sin Postgres real) y
`PostgresHotelesRepository` (producción, sobre `TenantDbSession`).

Migraciones SQL reales en `migrations/` (schema `hoteles.*`, requiere
`packages/db/migrations/0001_core_schema.sql` aplicada antes) — incluye el port
literal del índice único parcial anti-doble-captura de night-audit
(`charge_folio_stay_date_hospedaje_idx`) y de la función `mark_charge_reversed()`
(SECURITY DEFINER). Idempotencia genérica de mutaciones de dinero/F&B vía
`hoteles.idempotency_key`, scope `charge.create|charge.discount|charge.reverse|
charge.transfer|folio.split|payment.create` — mismo patrón que
`restaurantes.create_order_idempotent`, cada vertical mantiene su propia tabla.

Explícitamente fuera de Fase 1 (ver diseño Fase 1 §6): agente de voz ElevenLabs,
dashboards de KPIs/ROI/P&L, panel de superadmin, `mensajeria.ts`/`agent-core` completo
de hoteles, máquina de estados completa de reservas, housekeeping, night-audit, CFDI,
identidad/MRZ, fraude, reputación, UGC, disponibilidad como ruta propia.

## Fase 2 — agente de voz (ElevenLabs) + agente de WhatsApp con LLM real

Construido sobre el diseño Fase 2 hoteles (ver conversación de diseño — hallazgo
central: el agente conversacional real del origen, `recepcion_virtual`, tiene un
catálogo CERRADO de 5 tools sin folios/disponibilidad/reserva/cotización, límite de
seguridad documentado explícitamente en el origen). Catálogo reducido a 2 tools
(diseño §5.2 — housekeeping/mantenimiento/dinero/plantillas de WhatsApp no tienen
dominio construido en atiende-fusion):

- `src/whatsapp/` — plomería nueva completa (Fase 1 de hoteles NO traía ningún
  módulo de WhatsApp, a diferencia de `domain-restaurantes`):
  - `meta-signature.ts` — verificación HMAC (port literal, sin negocio de vertical).
  - `channel-config.ts` — resuelve un `phone_number_id` de Meta directo a
    **PROPERTY** (no a organización: 1 número real = 1 property en hoteles, así que
    nunca hace falta resolver "sucursal más cercana" como en restaurantes).
  - `inbound.ts` — dedupe/lease/append atómico, mismo contrato que
    `domain-restaurantes/whatsapp/inbound.ts`.
  - `turn-handler.ts` — seam `HotelesWhatsAppTurnHandler`/`acknowledgeOnlyTurnHandler`.
  - `llm-turn-handler.ts` — `createLlmHotelesWhatsAppTurnHandler`: loop de tool-use
    real sobre `@atiende/agent-core`'s `LlmGateway` (tool-calling ya existente,
    reutilizado sin extender), con 2 tools: `crear_ticket_huesped_fnb` (reutiliza
    `fnbAllergyGuard` + `insertFnbOrder` — REQ-AB-004 sin excepción, nunca expone un
    parámetro de "seguridad asegurada") y `registrar_contacto_no_operativo`.
- `rate-limit.ts` — port de `domain-restaurantes/rate-limit.ts` (segunda copia real
  del mismo mecanismo, flag explícita en el diseño §4 como candidata a paquete
  compartido, no resuelta en esta fase).
- `contacto-no-operativo.ts` — mismo rol que `registerCallbackRequest` de
  restaurantes.

Server Tools HTTP de voz en `apps/api/src/routes/verticals/hoteles/voice-tools.ts`
(`POST .../voz/tickets-fnb`, `POST .../voz/contacto-no-operativo`) — este es el
patrón OFICIAL de voz del monorepo (ver docs/CREDENCIALES.md §"Voz (ElevenLabs)").
Divergencia deliberada de restaurantes: el secreto es **por property**
(`hoteles.voice_agent_config`, tabla + endpoint de rotación en `voice-tools.ts`), no
compartido de plataforma — el origen real documenta el aislamiento por tenant como
el eje de seguridad central de este vertical.

Migración nueva: `migrations/004_voz_whatsapp_fase2.sql` (`voice_agent_config`,
`whatsapp_channel_config`, `whatsapp_conversations`, `whatsapp_inbound_events`,
`whatsapp_conversation_leases`, `api_rate_limits`, `contacto_no_operativo`, y las
funciones atómicas `whatsapp_append_turn`/`claim_whatsapp_message`/
`claim_whatsapp_conversation`/`finish_whatsapp_message`/`consume_api_rate_limit`).

Deliberadamente fuera de Fase 2 (ver diseño §5.2/§6): `registrar_evento_roi` (requiere
una tabla `hoteles.roi_event` que no existe), housekeeping/mantenimiento (sin dominio
construido), dinero/quotes por voz o WhatsApp (mismo límite de seguridad que el
catálogo real del origen), panel admin de sesión/config de voz saliente (existió un
paquete `@atiende/voice-gateway` para esto, retirado del árbol por falta de
consumidor real — ver docs/CREDENCIALES.md), y el mecanismo de aprobación humana tipo
`ApprovalQueue`/gate shadow (solo necesario si se porta
`enviar_mensaje_whatsapp_plantilla` en una fase futura — el `LlmGateway` fusionado no
lo tiene todavía).

## Fase 5 — CFDI de hospedaje (H5/REQ-BO-001/002) + fraude interno (H16-014/REQ-REC-014)

- `cfdi/reglas-fiscales-hospedaje.ts` — extensión de hospedaje sobre el núcleo
  genérico de `@atiende/billing` (RFC/catálogos SAT reutilizados directo, nunca
  reescritos), MISMO patrón que
  `@atiende/domain-despachos/src/cfdi/reglas-fiscales-avanzadas.ts` (leído como
  plantilla). ISH (residuo `taxTotal - ivaAmount`, nunca recalculado desde cero
  sobre el subtotal agregado), DSA (monto fijo por cuarto-noche, port literal de
  `fiscalHospedaje.ts::computeDsa`), RFC genérico extranjero (`XEXX010101000`)/
  público en general (`XAXX010101000`), CfdiRelacionados tipo 07 para aplicación de
  anticipos (gap que el original dejaba "PENDIENTE" por límite del `CfdiPort` de
  entonces — cerrado aquí a propósito), propina SIEMPRE excluida
  (`summarizeFacturableCharges`). NO compone sobre `validarCfdi()` completo como
  despachos sí hace — ver NOTA DE FIDELIDAD en la cabecera del archivo: ese
  validador asume un comprobante YA timbrado (sello/certificado/folio fiscal reales),
  mientras que aquí NUESTRO hotel es el emisor y la validación corre ANTES de
  timbrar, cuando esos 3 campos todavía no existen.
- `fraude/deteccion.ts` — 2 de los 4 patrones de detección de fraude interno del
  criterio original (descuento fuera de política, folio reabierto después de
  cerrado), puros y deterministas, operando SOLO sobre datos de folio/charge YA
  reales (Fase 1). Los otros 2 (`cargo_fnb_no_posteado`, `reembolso_tarjeta_distinta`)
  requieren un conector PMS/POS real — explícitamente fuera de esta fase, ver
  comentario de cabecera del archivo para el detalle completo.
- `HospedajeFiscalConfig`/`loadHospedajeFiscalConfig` — RFC emisor + DSA por
  cuarto-noche, ADITIVO sobre `hoteles.tax_config` (nunca reemplaza
  `TaxConfigRecord`, para no forzar a los seeds/tests ya escritos de Fase 1-4 a
  aportar campos que solo necesita el CFDI de esta fase).
- `FraudAlertRecord` — a diferencia de `domain-despachos` (separa `invoice`/
  `invoice_review` en dos tablas), aquí la alerta de fraude ES el sujeto de la cola
  de revisión humana (una sola tabla con `status`/`resolvedBy`/`resolvedAt`).

Transporte PAC real (dual Finkok/SW Sapien, con adaptador fake para tests) en el
paquete nuevo `@atiende/mcp-cfdi` (`packages/mcp-servers/cfdi`), NO en este paquete
— `domain-hoteles` solo conoce el resultado ya calculado, ningún cálculo fiscal ni
llamada de red vive fuera de aquí/de ese puerto.

Migraciones nuevas: `migrations/006_cfdi_hospedaje.sql`, `migrations/007_fraude_alerta.sql`.

## Fase 9 — motor de revenue management / pricing (REQ-REV-003/004/005/007)

Gap real verificado contra el original: `domain-hoteles` no tenía ninguna carpeta
`revenue/` antes de esta fase (ni ninguna ruta relacionada). Port de la pieza de
negocio más grande pendiente del vertical:

- `revenue/revenueEngineGate.ts` (REQ-REV-003, P0/GOB) — máquina de estados
  shadow/propone/autopilot. La autoridad final es el trigger de Postgres
  (`migrations/011_revenue_engine_gate.sql::revenue_engine_gate_transition_guard`),
  NUNCA un flag de aplicación: exige 90 días mínimos en shadow, un backtest
  walk-forward vigente que pase, y una aprobación explícita del rol `owner`
  registrada en un UPDATE previo, antes de dejar pasar a autopilot pleno. Este
  módulo TS es solo el espejo de aplicación (valida/explica una transición antes del
  round-trip a la base), mismo patrón que `reservationStateMachine.ts` frente a
  `005_reservas_estado.sql`.
- `revenue/walkForwardBacktest.ts` (REQ-REV-003) — backtest walk-forward SIN fuga de
  información: cada ventana de prueba solo se compara contra datos de ANTES de sí
  misma. Cálculo puro completo; el pipeline que alimenta `WindowEvaluation` con
  datos reales de producción queda pendiente (requiere 90 días de datos reales en
  shadow primero).
- `revenue/priceRecommendationExplainer.ts` (REQ-REV-005) — explicador de precio en
  español, dominio puro determinista: SIN LLM. Redacta por qué se recomienda un
  precio (pick-up/compset/evento/tipo de cambio) a partir de factores YA calculados
  que recibe, nunca inventa una razón.
- `revenue/parity-guard.ts` (REQ-REV-007) — parity guard configurable por hotel vs.
  OTAs: decide si una tarifa directa propuesta rompe la paridad pactada con cada
  canal (bloquea o solo alerta, según el modo configurado), a partir de tarifas de
  referencia YA obtenidas por quien llama.
- `revenue/compsetGuard.ts` (REQ-REV-004) — guarda negativa de benchmarking de
  compset: exige k≥10 hoteles competidores, ≥12 meses de histórico y opinión
  antimonopolio documentada antes de dejar avanzar cualquier consulta de agregado de
  red.

Diferencia deliberada del port de `revenueEngineGate.ts` frente al original: el
original exige también una "aprobación del fundador" (REQ-GOB-012,
`founder_reserved_category`) que este repo no ha portado (no existe rol "founder"
distinto de "owner" en `HOTEL_ROLES`). Este port exige en su lugar una aprobación
explícita de `owner` (el rol más alto que SÍ existe aquí) con el mismo nivel de
exigencia de gobierno — ver comentario de cabecera de `revenueEngineGate.ts` y de
`migrations/011_revenue_engine_gate.sql` para el detalle completo.

Pendiente honesto de esta fase (no fingido como completo): el conector/channel
manager real que alimentaría `parity-guard.ts` con tarifas OTA en vivo (REQ-REV-
008..011), el motor de recomendación de tarifas en sí (lo que produciría
`PriceRecommendationInput` y correría en shadow), y el pipeline de ingesta de datos
reales para `walkForwardBacktest.ts` — los tres, deliberadamente fuera de esta fase
(mismo patrón que el resto del vertical: cada guarda/explicador es dominio puro,
la orquestación que la alimenta con datos reales de negocio vive en fases futuras
de `apps/api`).

Migración nueva: `migrations/011_revenue_engine_gate.sql`.

## Fase 11 — reputación/CRM: clasificador de reseñas por tema + sentimiento + inbox unificado + índice agregado (REQ-CRM-002/003)

Gap real verificado contra el original y contra el código de main antes de esta
fase: ningún archivo bajo `packages/domain-hoteles` mencionaba reputación/reseñas/
CRM, y este mismo README (ver "Explícitamente fuera de Fase 1" arriba) ya listaba
"reputación" fuera de alcance, sin que ninguna fase posterior la retomara.

- `reputacion/clasificador.ts` — port literal de
  `hoteles/packages/domain-hotel/src/reputacion/clasificador.ts` (verificado regla
  por regla contra el original: ninguna regla de negocio se cambió). Dominio puro
  determinista, SIN LLM ni dependencia de ninguna API de Google/Booking/TripAdvisor
  (clasifica CUALQUIER texto de reseña/encuesta que ya llegó al sistema, sin
  importar el canal): `detectarTemas` (diccionario base de 12 temas + diccionario
  propio configurable por hotel + descubrimiento heurístico de temas locales NUNCA
  entrenados previamente, p.ej. una plaga o un olor específico de esa property),
  `analizarSentimiento` (léxico ponderado español con negación e intensificadores,
  combinable con una calificación de 1-5 estrellas), y `decidirAcciones`
  (ticket de mantenimiento / mensaje proactivo / compensación reglada, cada una con
  su propia condición determinista — ver comentarios del archivo).
- `reputacion/indice.ts` — índice de reputación agregado (construcción NUEVA de esta
  fase, sin equivalente 1:1 en el original — verificado por grep antes de
  escribirse: el original nunca aisló este cálculo en un archivo propio). Dominio
  puro determinista que agrega reseñas YA clasificadas (nunca vuelve a correr el
  clasificador): distribución de sentimiento, promedio de calificación/puntaje,
  un `puntajeIndice` 0-100 para tablero, y los temas más frecuentes/críticos
  (mínimo de reseñas configurable para no confundir una queja aislada con un
  problema sistémico).
- Modelo de datos (`migrations/013_reputacion.sql`): `hoteles.guest_review` (la
  reseña/encuesta + su clasificación) y `hoteles.guest_review_action` (cada acción
  disparada), pensado para captura MANUAL (encuesta propia del staff) o un futuro
  webhook — nunca para una ingesta automática real de Google/Booking/TripAdvisor
  (REQ-CRM-001 en el original, "pendiente-credenciales" ahí también). RLS propia
  (`hoteles.can_submit_reputacion`/`hoteles.can_view_reputacion`/
  `hoteles.can_resolve_reputacion_accion`, espejo de `REPUTACION_SUBMIT_ROLES`/
  `REPUTACION_VIEW_ROLES`/`REPUTACION_ACTION_RESOLVE_ROLES` en `roles.ts`).

Deliberadamente FUERA de esta fase (mismo patrón que Fase 9 revenue: dominio puro +
modelo de datos completo primero, la orquestación de negocio real vive en una fase
futura de `apps/api`):

- **Ingesta automática real** desde Google/Booking/TripAdvisor — requiere
  credenciales de esas plataformas que este repo no tiene; `source`/`external_id`
  quedan listos en el modelo de datos para cuando exista ese conector, pero no se
  fabrica ni se simula aquí. Esto SIGUE fuera de alcance hoy.

**Los siguientes 3 puntos describían el estado al cerrar la Fase 11 — ya NO son
ciertos, cerrados en la Fase 13 (barrido de documentación, 19-sep-2026, se
conservan tachados en espíritu, no en forma, como registro histórico):**

- ~~La ruta HTTP de `apps/api` que capturaría una reseña, correría
  `clasificarResena()`, y persistiría el resultado — sin exponer el endpoint
  todavía.~~ **Ya existe**: `apps/api/src/routes/verticals/hoteles/reputacion.ts`
  (`POST`/`GET .../reputacion/resenas`, `GET .../resenas/:reviewId`,
  `POST`/`GET .../respuestas`, `POST .../acciones/:actionId/resolver`,
  `GET .../indice`).
- ~~La orquestación que EJECUTA cada acción: crear de verdad el ticket contra
  `hoteles.maintenance_ticket`... `guest_review_action.ticket_id` por eso queda
  siempre `null`.~~ **Parcialmente cerrado**: resolver una acción tipo
  `ticket_mantenimiento` SÍ inserta un ticket real hoy
  (`reputacion.ts::insertMaintenanceTicket`). Siguen sin ejecutarse de verdad
  `mensaje_proactivo` (falta plantilla aprobada de WhatsApp/Meta) y
  `compensacion_reglada` (mueve dinero, exige aprobación humana explícita) —
  esas dos SÍ siguen pendientes.
- ~~Panel/UI de `apps/web` para el inbox unificado y el tablero del índice
  agregado.~~ **Ya existe**: `apps/web/src/verticals/hoteles/pages/Reputacion.tsx`,
  ruteada y en el nav de `HotelesShell.tsx`.

Ni `apps/api/src/routes/verticals/hoteles/README.md` ni
`apps/web/src/verticals/hoteles/README.md` mencionan reputación (ni revenue,
ver Fase 9 arriba) todavía — ver esos dos archivos para el resto de fases del
vertical.

Migración nueva: `migrations/013_reputacion.sql` (Fase 11) +
`migrations/021_reputacion_respuestas.sql` (Fase 13, columna/tabla de
respuesta del staff a una reseña, la pieza que faltaba para "responder").

## FASE 3 (producto) — zona horaria por negocio

Gap real verificado antes de esta tarea (documentado explícito en el comentario de
cabecera de `@atiende/core-tenancy::resolverZonaHorariaNegocio`, fecha-negocio.ts):
`hoteles.*` no tenía NINGUNA columna de zona horaria por property — night-audit
(`night-audit/engine.ts::DEFAULT_PROPERTY_TIMEZONE`), el motor de recomendaciones
de tarifa (revenue-recommendations-cron.ts) y no-show (reservas.ts) calculaban
"hoy" SIEMPRE con `America/Mexico_City`, sin importar que la property real
estuviera en Cancún, Los Cabos, Tijuana o Puerto Vallarta.

- `migrations/030_zona_horaria_property.sql` — `hoteles.property_config`
  (`property_id` PK, `timezone` IANA NULLABLE **sin default en SQL** — el default
  de plataforma vive únicamente en `resolverZonaHorariaNegocio()`, nunca duplicado
  aquí). RLS: owner/gm configura (`hoteles.can_manage_catalog()`, ya existente
  desde `018_admin_catalogo_alta.sql`), cualquier staff con acceso o la sesión de
  SISTEMA lee (necesario para el `LEFT JOIN` de `listActiveHotelProperties()`).
- `HotelesRepository.findPropertyTimezone`/`upsertPropertyTimezone` — REGLA DURA de
  compatibilidad: degradan honesto (`null` / `PropertyConfigUnavailableError`) si
  la migración 030 aún no está aplicada (42883/42P01/42703, vía
  `runWithSavepointFallback` + `isMigrationPendingError`, mismo patrón que
  `findPricingRule` de la Fase 10).
- `ActiveHotelProperty.timezone` — `listActiveHotelProperties()` ahora trae el
  valor crudo por property (LEFT JOIN); `runNightAuditSweep`
  (`apps/worker/src/jobs/hoteles/night-audit.ts`) y `runRateRecommendationSweep`
  (`apps/api/src/routes/verticals/hoteles/revenue-recommendations-cron.ts`)
  resuelven la zona real POR CADA property DENTRO de su propio loop, nunca una
  sola vez para todo el barrido.
- `GET`/`PUT /hoteles/:propertyId/configuracion`
  (`apps/api/src/routes/verticals/hoteles/property-config.ts`, owner/gm) — misma
  validación IANA que `citas/admin.ts::optionalTimeZone` (`Intl.DateTimeFormat`,
  nunca restringida a una lista cerrada). Pantalla: sección "Zona horaria" de
  `apps/web/src/verticals/hoteles/pages/Catalogo.tsx` (mismo nav/rol que
  gestión de catálogo) — el `<select>` solo ofrece los 6 timezones IANA más
  comunes de México como conveniencia de UI.
- No conectado en esta tarea (fuera de alcance, no un olvido): `citas`/`rentas` YA
  tenían su propia columna real desde antes (`citas.property_config.timezone`,
  `rentas.property_config.zona_horaria`) — esta tarea es la parte hoteles de una
  serie de 4 (las otras 3 cubren despachos+restaurantes y licitaciones).

Migración nueva: `migrations/030_zona_horaria_property.sql`. Verificación contra
Postgres real: `scripts/verify-hoteles-zona-horaria/`.

## H-01 — bóveda de identidad: política de retención (ajuste según México)

Código en `src/identity/service.ts`; modelo SQL en `migrations/031_hoteles_boveda_identidad.sql`
(sin cambios en este ajuste: el plazo se calcula por fila en código, `retention_until`).

**Aviso:** los plazos de abajo son **decisiones de producto, NO un mandato legal ni asesoría
legal**. Salen de una investigación documental a 30-sep-2026
(`atiende-loop/expertos/retencion-identidad-hoteles-mx.md`, borrador) que NO encontró una norma
federal verificada que obligue a conservar la **imagen** del documento.

| Elemento | Default | Tope editable | Base (según el informe) |
|---|---|---|---|
| Imagen/documento cifrado (`identity_vault`) | **30 días después del check-out** de la reserva ligada; sin reserva, 30 días desde la captura | **0 a 365** días por captura (`retentionDays`, fuera de rango -> error "entre 0 y 365") | Minimización: LFPDPPP (DOF 20-mar-2025) arts. 10-12; art. 9 fr. IV; art. 18 |
| Registro de huéspedes/migratorio **sin imagen** (`migratory_registration`: nacionalidad, llegada, salida, constancia) | **365 días** desde la salida (`MIGRATORY_RETENTION_DAYS_DEFAULT`) | `resolveMigratoryRetentionDays({ stateCode, overrideDays })`: piso 365 en CDMX, máx. 1825 | CDMX, Ley de Establecimientos Mercantiles art. 23 fr. II (control de llegadas y salidas; texto verificado, sin plazo) |

- La purga por retención **solo anula el sobre cifrado, los últimos 4 y la nacionalidad de
  `identity_vault`**; el registro migratorio textual y la bitácora de accesos/purgas se conservan (el
  test `service.spec.ts` lo verifica con el repositorio en memoria; la función SQL ya actuaba así
  desde 031). **Desde H-02 (migración 032) la purga ya no es directa: pasa por un estado `bloqueada`
  (ver la sección H-02 de abajo).**
- `retention_until` se compara con `<`: la imagen se purga en el primer barrido posterior a esa
  fecha (con 0 días, el día siguiente al check-out a las 02:00 CDMX).
- Un decreto CDMX del 19-dic-2025 que fijaría 1 año de conservación **NO está verificado en
  fuente primaria** (solo análisis de despachos); por eso 365 es el default del registro, no una
  afirmación legal.
- El aviso de privacidad y el consentimiento se registran desde H-02 (ledger de consentimientos
  ligado a la captura; ver abajo).

### Un abogado debe confirmar

- Texto íntegro y artículos del decreto CDMX del 19-dic-2025 (plazo de 1 año, alcance de
  "identificación", si exige copia o solo exhibir).
- Si hay normas estatales análogas (Yucatán, Quintana Roo, Jalisco y otras) y reglamentos municipales.
- Vigencia del Reglamento de la LFPDPPP de 2011 y de los Lineamientos del aviso, plazo de
  notificación de vulneraciones y si hay aviso a la Secretaría.
- Si la imagen de pasaporte/ID de extranjero tiene obligación ante el INM bajo lineamientos internos
  (no se encontró; el INM no regula hoteles en los textos leídos).
- Alcance de LGP art. 91 Sexies (obligación de solicitar CURP) para hoteles.
- Si un rostro/huella o la imagen del documento es dato sensible bajo la nueva ley.
- Plazos de prescripción mercantiles (Código de Comercio) y penales estatales aplicables.
- Calificación fiscal del registro (CFF art. 30) y del CFDI.

## H-02 — Privacidad: consentimiento, ARCO, bloqueo previo a la purga, retención legal e incidentes

Código en `src/privacy/` (+ `src/identity/` extendido); modelo SQL en
`migrations/032_hoteles_consentimiento_arco_incidentes.sql` (espejo byte-idéntico
`supabase/migrations/20240101000201_032_hoteles_consentimiento_arco_incidentes.sql`); verificación
contra Postgres real en `scripts/verify-hoteles-privacidad-arco/` (103 chequeos) y el verify de
031 actualizado (62). Rutas HTTP: `apps/api/src/routes/verticals/hoteles/privacidad.ts`.

> **No es asesoría legal.** Es una implementación técnica de decisiones de producto tomadas de un
> informe documental no vinculante (`atiende-loop/expertos/retencion-identidad-hoteles-mx.md`,
> 30-sep-2026). `GET /hoteles/:propertyId/privacidad/info` y la pestaña Privacidad lo repiten junto
> con la lista de abajo. Ningún plazo debe presentarse al hotel como cumplimiento sin que un abogado lo
> confirme.

| Pieza | Qué hace | Decisión de producto (no mandato legal) |
|---|---|---|
| Aviso versionado (`privacy_notice`) | Versión, aviso simplificado, enlace al integral (https), finalidades obligatorias vs opcionales; una sola vigente; un aviso publicado es inmutable | Informe §5: aviso integral y simplificado; finalidades separadas, opcionales sin marcar |
| Ledger de consentimientos (`identity_consent`) | Fecha-hora, **versión del aviso aceptado** (la copia la base), finalidades obligatorias (deben aceptarse TODAS) y opcionales (subconjunto), canal, evidencia, quién capturó, ligado a la identidad; append-only; revocable una sola vez | Informe §5: registro con fecha, hora, versión e ID. Datos sensibles: solo firma o mecanismo de autenticación (art. 8) |
| Ventana de bloqueo (`privacy_settings`) | Default **7 días**, editable **3 a 30** por property; el cambio queda en la bitácora | Informe §4: ventana de bloqueo 7 días (3-30); el doble control es práctica de seguridad, no requisito legal |
| Estado `bloqueada` (`identity_vault`) | Una identidad vencida, con purga aprobada o con ARCO de cancelación procedente **no se purga de golpe**: pasa a `bloqueada` (conserva el sobre cifrado, sin acceso operativo: no se revela ni verifica) y se purga al vencer la ventana y solo sin retención legal. A nivel de datos (trigger) solo se puede pasar a `purgado` desde `bloqueada` con la ventana vencida y sin retención legal activa | Informe: art. 2 fr. III y art. 24 (bloqueo antes de supresión) |
| Acceso excepcional (`identity_blocked_access_request`) | Para leer una identidad bloqueada: pide owner/gm con motivo; **otra persona** aprueba (doble control, también por CHECK); la aprobación caduca a las 2 horas, se usa una sola vez y solo por quien la pidió; deja huella | Práctica de seguridad |
| ARCO (`arco_request`) | Folio, derecho, canal, plazos **20 días** de respuesta + **15** de ejecución (desde la decisión de procedencia), prórroga **una sola vez** por igual plazo con motivo, estados `recibida → en_revisión → procedente/improcedente → ejecutada`, nota obligatoria en cada decisión, bitácora (`privacy_event_log`). Una **cancelación procedente bloquea** la identidad ligada (o las activas del huésped) | Informe §2: art. 31 (20+15, prorrogable una vez). **Días naturales** (cómputo más conservador) |
| Retención legal (`legal_hold`) | Folio del caso + motivo + quién autoriza (obligatorios); impide purgar mientras dure; opcionalmente ligada a un incidente; revisión anual; liberar exige nota | Informe §4: legal hold con folio y autorización; revisión anual |
| Incidentes (`privacy_incident`) | Folio, tipo, severidad, riesgo significativo, estados `detectada → contenida → cerrada`, registro de la notificación al titular (canal + constancia) o del motivo de no notificar para poder cerrar; **recordatorio** "notifica de inmediato" mientras haya riesgo significativo sin notificación. **El sistema NO envía nada**: solo registra | Informe §2: art. 19 (notificar de forma inmediata) |

Roles: front-of-house (owner/gm/frontdesk/reservations) captura/lee consentimientos, lee el aviso y
**reporta** incidentes; todo lo demás (ARCO, retención legal, bloqueo, acceso excepcional, ajustes,
bitácora, gestión de incidentes) es owner/gm. La base lo hace cumplir (RLS + funciones `security definer`
con `search_path` fijo + GRANT por columna); la API es la segunda capa.

Compatibilidad con la base sin migrar (regla dura): todo el TypeScript captura 42883/42P01/42703 con
`runWithSavepointFallback` (una sola transacción por request). Lecturas de privacidad → `disponible:false`;
escrituras → 503; la captura de identidad con consentimiento sigue valiendo sin ledger
(`consentimiento: {estado: "no_disponible"}`); el barrido de retención cae a la purga directa de 031
(`viaBloqueo:false`); las lecturas de la bóveda repiten con las columnas de 031 si faltan las de bloqueo.
Tests con `AbortAwareFakeSession` en `tests/identity/postgres-repository-032-compat.spec.ts` y
`tests/privacy/postgres-repository-savepoint.spec.ts`.

### Un abogado debe confirmar (H-02, además de lo de H-01)

- Si los plazos ARCO (20 y 15 días) se cuentan en días **naturales o hábiles** (aquí, naturales).
- Cómo se aplica la prórroga "por igual plazo" (aquí: +20 días en la fase de respuesta o +15 en la de
  ejecución, una sola vez).
- Plazo, forma y destinatarios de la notificación de vulneraciones (art. 19) y cuándo una vulneración
  "afecta de forma significativa derechos patrimoniales o morales" (la bandera la decide el hotel).
- Si la imagen del documento, el rostro o la huella son datos sensibles (consentimiento expreso y por
  escrito) bajo la ley de 2025.
- Contenido mínimo del aviso integral/simplificado (arts. 15-16) y la redacción de las finalidades
  obligatorias frente a las opcionales; consentimiento de menores y tutores.
- Si la ventana de bloqueo debe igualar el plazo de prescripción de las acciones de la relación jurídica
  (art. 24) en lugar de los 7 días por defecto, y cuándo un legal hold es obligatorio y cada cuánto revisarlo.
- Que la base legal del registro de huéspedes (art. 9 fr. I y IV) dispense o no el consentimiento para la
  finalidad de identificación (por eso el consentimiento ligado a la captura es **opcional**).

## Housekeeping completo (H-04)

Código en `src/housekeeping/` (`tareas.ts` reglas puras, `repository.ts` puerto,
`postgres-repository.ts` y `in-memory-repository.ts`); modelo SQL en
`migrations/033_housekeeping_completo.sql` (`hoteles.housekeeping_task`,
`hoteles.room_out_of_service`, UPDATE de solo `hoteles.room.status`). Ciclo de una tarea:
pendiente -> en_progreso -> terminada (espera inspección) -> inspeccionada; una inspección
rechazada devuelve la tarea a pendiente con `rejections + 1`. Quien limpió no inspecciona su
propio trabajo (CHECK en la migración y regla en la ruta). Contra una base sin la migración las
lecturas degradan (`tareasDisponibles: false`) y las escrituras responden 503
(`runWithSavepointFallback`). Verificación contra Postgres real:
`scripts/verify-hoteles-housekeeping/`. Fuera de esta entrega: inspección con visión/fotos,
conteo de blancos, opt-out de limpieza y asignación automática (optimizador).

## Tickets de huésped con SLA (H-05)

Código en `src/tickets/` (`sla.ts` reglas puras: clasificación de un mensaje libre, SLA, estado de
SLA, transiciones y ticket desde reseña; `tipos.ts`, `repository.ts` puerto, `postgres-repository.ts` e
`in-memory-repository.ts`); modelo SQL en `migrations/034_guest_ticket_sla_escalacion.sql`
(`hoteles.guest_ticket`, `hoteles.guest_ticket_event` bitácora escrita por trigger, `hoteles.ticket_sla_policy`
y la función de sistema `hoteles.sweep_guest_ticket_sla`). Ciclo: abierto -> en_progreso -> cerrado; al
vencer el SLA sin cierre pasa a `escalado` (sube a gerencia/dirección) y desde ahí puede volver a
en_progreso o cerrarse; cerrado/cancelado son terminales. El SLA se resuelve y congela al crear
(la política de la property manda sobre lo que mande el cliente; reasignar el departamento no lo
reinicia). Un ticket puede nacer de una reseña negativa de `hoteles.guest_review` (canal `resena`, a lo
sumo un ticket activo por reseña). El barrido (`/internal/hoteles/tickets-sla`) escala los vencidos y avisa
al 75% del SLA, es idempotente y corre una transacción por property. Contra una base sin la migración las
lecturas degradan (`disponible: false`) y las escrituras responden 503 (`runWithSavepointFallback`).
Verificación contra Postgres real: `scripts/verify-hoteles-tickets-sla/`. Fuera de esta entrega: ingesta
automática desde WhatsApp/voz/QR (el canal queda declarado en el modelo), notificación activa (correo/push)
al escalar, y escalación por activo crítico de mantenimiento.

## Catálogo de agentes, aprobaciones humanas, plantillas y guardrails (H-03)

Código en `src/agentes/` (`guardrails.ts` reglas puras con casos de borde —topes inclusivos, palabras bloqueadas
como palabra completa sin acentos ni mayúsculas, ventana de envío en la hora local de la property—,
`gobernanza.ts` compuerta de agente: kill switch + presupuesto + registro de costo fail-open, `tipos.ts`,
`repository.ts` puerto, `postgres-repository.ts` e `in-memory-repository.ts`); modelo SQL en
`migrations/035_hoteles_agentes_aprobaciones.sql` (`hoteles.agent_config`, `agent_usage_monthly`,
`agent_guardrail`, `agent_action_policy`, `agent_approval_request`, `agent_wa_template` y la bitácora
`agent_event` escrita por funciones/triggers). El agente PROPONE (sesión de sistema) y una persona con rol
decide con motivo; sin política configurada toda acción sensible exige humano, vence a las 24 h y la deciden
owner/gm. Lo propuesto es inmutable, una aprobación se consume una sola vez, quien propone no decide lo suyo y
un guardrail endurecido después de aprobar también frena la ejecución. Solo el dueño puede permitir ejecución
automática bajo umbral (y nunca para respuestas a reseñas ni mensajes masivos). Los relojes que recibe una
función solo se respetan en sesión de sistema (un usuario no puede rebobinar la expiración). Verificación
contra Postgres real: `scripts/verify-hoteles-agentes-aprobaciones/`. Fuera de esta entrega: ejecutores
automáticos de descuento/reembolso/cargo/mensaje masivo (hoy una persona aplica el cambio y registra la
referencia), envío real de plantillas a Meta, y que el agente de WhatsApp proponga acciones sensibles.

**H-28 recepción y H-27 ficha de huésped (migración 038).** `src/recepcion/` (clasificación pura del día en llegadas/salidas/en casa, puerto
`RecepcionRepository`, Postgres con SAVEPOINT contra base sin migrar e in-memory) y `src/huespedes/` (ficha, notas, errores de dominio).
Modelo SQL en `migrations/038_hoteles_recepcion_ficha_huesped.sql`: `hoteles.guest_note` (GRANT de columna, minimización, bloqueo por ARCO),
`hoteles.reservation_room_change` (append-only) y las funciones `security definer` `change_reservation_room` (misma categoría, sin traslape,
habitación apta, bitácora, advisory lock por habitación) y `guest_has_arco_restriction` (solo un booleano). Verificación contra Postgres
real: `scripts/verify-hoteles-recepcion-ficha/`. Fuera de esta entrega: cambio de habitación a OTRA categoría (mueve inventario y tarifa: es una
reserva nueva), edición del perfil del huésped (la rectificación sigue el flujo ARCO) y exportación de datos del huésped (H-30).
