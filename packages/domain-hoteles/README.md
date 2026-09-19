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
