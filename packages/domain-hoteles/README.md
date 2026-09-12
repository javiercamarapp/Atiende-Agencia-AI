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
(`POST .../voz/tickets-fnb`, `POST .../voz/contacto-no-operativo`) — **NO** montadas
sobre `@atiende/voice-gateway` (esa capa es config/sesión del agente — signed URL,
`listVoices` — una superficie distinta de recibir el webhook de tool call durante una
llamada en curso). Divergencia deliberada de restaurantes: el secreto es **por
property** (`hoteles.voice_agent_config`, tabla + endpoint de rotación en
`voice-tools.ts`), no compartido de plataforma — el origen real documenta el
aislamiento por tenant como el eje de seguridad central de este vertical.

Migración nueva: `migrations/004_voz_whatsapp_fase2.sql` (`voice_agent_config`,
`whatsapp_channel_config`, `whatsapp_conversations`, `whatsapp_inbound_events`,
`whatsapp_conversation_leases`, `api_rate_limits`, `contacto_no_operativo`, y las
funciones atómicas `whatsapp_append_turn`/`claim_whatsapp_message`/
`claim_whatsapp_conversation`/`finish_whatsapp_message`/`consume_api_rate_limit`).

Deliberadamente fuera de Fase 2 (ver diseño §5.2/§6): `registrar_evento_roi` (requiere
una tabla `hoteles.roi_event` que no existe), housekeeping/mantenimiento (sin dominio
construido), dinero/quotes por voz o WhatsApp (mismo límite de seguridad que el
catálogo real del origen), panel admin de voz sobre `voice-gateway`, y el mecanismo de
aprobación humana tipo `ApprovalQueue`/gate shadow (solo necesario si se porta
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
