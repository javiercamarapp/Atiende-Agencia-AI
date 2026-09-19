# Vertical: hoteles (api)

Fase 1 construida — los 3 flujos elegidos (ver diseño Fase 1 hoteles), montados con
`authMiddleware` + `dbSession` + `requirePropertyMembership("propertyId")` (sin
`allowedRoles` de plataforma) y `assertVerticalRole(...)` fino dentro de cada handler,
a diferencia de las rutas de restaurantes de esta misma fase (públicas/sin sesión de
staff):

- `folios.ts` — `GET/POST /hoteles/:propertyId/folios/...` +
  `GET /hoteles/:propertyId/reservas/:reservationId/folios`: cargos/descuentos/
  reverso/transferencia/split/pagos/cierre, con sus 3 capas anti-doble-captura +
  identidad (Idempotency-Key obligatorio, REQ-AB-012, impuesto siempre recalculado
  server-side).
- `pedidosFnb.ts` — `GET/POST /hoteles/:propertyId/pedidos-fnb/...`: guardia de
  alergias (REQ-AB-004).
- `quotes.ts` — `POST /hoteles/:propertyId/quotes`: motor de cotización determinista,
  guardia anti-alucinación de precio (REQ-REV-001/REQ-RES-002).
- `hoteles.ts` — agregador, montado en `apps/api/src/app.ts`.

## Fase 3 — máquina de estados de reservas (H02)

- `reservas.ts` — `GET/POST/PATCH /hoteles/:propertyId/reservas/...`: ciclo de vida
  completo de una reserva, motor en `@atiende/domain-hoteles::reservationStateMachine.ts`
  (espejo de la tabla real `hoteles.reservation_status_transition` + trigger, ver
  `migrations/005_reservas_estado.sql`):
  - `GET /reservas` / `GET /reservas/:id` — lectura, cualquier staff de la property.
  - `POST /reservas` — crea la reserva directo en `confirmada` (esta fase salta
    `cotizada`, ver diseño §3.2), cotiza con el motor real de `quotes.ts`, reserva
    inventario noche por noche (`bookAvailability`) y crea el folio primario en la
    misma operación (`ensurePrimaryFolio`) — `Idempotency-Key` obligatorio.
  - `PATCH /reservas/:id/transicion` — transición GENÉRICA
    (`check_in`/`en_estancia`/`check_out`/`cerrada`); el rol permitido depende de
    `(from,to)` (`canRolePerformTransition`), nunca un rol fijo por ruta.
    `cancelada`/`no_show` están excluidos deliberadamente (tienen efectos
    secundarios propios que solo garantizan sus rutas dedicadas).
  - `POST /reservas/:id/cancelar` — guardia `isCancellable` (después de check-in ya
    no se puede cancelar), aplica la política de cancelación de la property, libera
    TODAS las noches restantes y marca la penalización.
  - `POST /reservas/procesar-no-show` — job por HTTP (`ADMIN_ROLES`), reclamo
    atómico `WHERE status='confirmada'` por reserva, libera inventario y postea la
    penalización (`computeNoShowPenaltyAmounts`: IVA sí, ISH no — decisión §3.4) al
    folio primario; el actor de la transición es SIEMPRE el lógico `system`, nunca el
    admin humano que disparó el endpoint.

Toda la lógica de negocio vive en `@atiende/domain-hoteles` — ninguna ruta aquí toca
SQL directamente. `admin`/`backoffice` de superadmin quedan reservados para una fase
posterior (ver diseño Fase 1 hoteles §6).

## Fase 2 — agente de voz (ElevenLabs) + agente de WhatsApp con LLM real

Montadas directamente en `apps/api/src/app.ts` (no dentro de `hotelesRoutes`), mismo
criterio que restaurantes: son superficies sin sesión de staff, distintas de los 3
flujos de Fase 1.

- `voice-tools.ts` — Server Tools HTTP del agente de voz de ElevenLabs, **sin**
  `authMiddleware`/`originAllowed` (ElevenLabs no manda `Origin`/`Authorization`):
  - `POST /v1/hoteles/:propertyId/voz/tickets-fnb` (`crear_ticket_huesped_fnb`).
  - `POST /v1/hoteles/:propertyId/voz/contacto-no-operativo`
    (`registrar_contacto_no_operativo`).
  - Secreto **POR PROPERTY** (`hoteles.voice_agent_config.tool_webhook_secret`,
    divergencia deliberada del secreto compartido de plataforma que usa
    restaurantes — ver diseño Fase 2 §1/§5.1: el origen real trata el aislamiento
    por tenant como el eje de seguridad central de este vertical).
  - `POST /hoteles/:propertyId/voz/config` — rotación del secreto, SÍ requiere
    sesión de staff (`authMiddleware` + `requirePropertyMembership` +
    `assertVerticalRole(ADMIN_ROLES)`).
  - Housekeeping/mantenimiento/dinero (`autorizar_gasto_mantenimiento`)/quotes
    quedan deliberadamente fuera del catálogo (mismo límite de seguridad que el
    catálogo real del origen — folios/quotes nunca son alcanzables por voz/WhatsApp).
- `whatsapp.ts` — `GET|POST /v1/hoteles/whatsapp/webhook`, mismo patrón HMAC/body
  crudo que restaurantes; secreto de plataforma compartido (`WHATSAPP_APP_SECRET`,
  sin divergencia). Resuelve directo a PROPERTY (no a organización): cada número de
  WhatsApp real atiende una sola property, así que el agente nunca resuelve
  "sucursal más cercana" como en restaurantes.

Toda la lógica de negocio de Fase 2 (loop de tool-use, catálogo de 2 tools, guardia
de alergias) vive en `@atiende/domain-hoteles/src/whatsapp/*` — ver
`packages/domain-hoteles/migrations/004_voz_whatsapp_fase2.sql` para las tablas
nuevas.

## Fase 5 — CFDI de hospedaje (H5/REQ-BO-001/002) + fraude interno (H16-014/REQ-REC-014)

- `cfdi.ts` — `GET/POST /hoteles/:propertyId/cfdi/...` +
  `GET/POST /hoteles/:propertyId/folios/:folioId/cfdi[/pago]`: timbrado idempotente
  por folio (REQ-BO-002), RFC genérico extranjero (`XEXX010101000`)/público en
  general (`XAXX010101000`), CfdiRelacionados tipo 07 para aplicación de anticipos,
  propina SIEMPRE excluida del subtotal. El motor de reglas fiscales vive en
  `@atiende/domain-hoteles::validarCfdiHospedaje`/`computeCfdiHospedajeBreakdown`
  (nunca en esta ruta); el transporte PAC real es `@atiende/mcp-cfdi::CfdiPort`
  (dual-PAC Finkok/SW Sapien, inyectado como `deps.hotelesCfdiPort`). A diferencia de
  `despachos/cfdi.ts` (ingiere un comprobante YA timbrado por un tercero), aquí
  nuestro propio hotel es el EMISOR: un CFDI que no pasa `validarCfdiHospedaje()`
  nunca se envía al PAC (422, no se guarda). Roles: `CFDI_HOSPEDAJE_ROLES`
  (owner/gm/accountant — más estricto que `MONEY_ROLES`, nunca frontdesk/
  reservations/fnb).
- `fraude.ts` — `POST /hoteles/:propertyId/fraude/escaneos` +
  `GET .../fraude/alertas[/:alertId]` + `POST .../alertas/:alertId/confirmar|descartar`:
  detección determinista (nunca LLM) de 2 de los 4 patrones del criterio original —
  descuento fuera de política y folio reabierto después de cerrado — sobre datos YA
  reales de `folioEngine.ts`/`folios.ts` (Fase 1). Los otros 2 patrones
  (`cargo_fnb_no_posteado`, `reembolso_tarjeta_distinta`) requieren un conector
  PMS/POS real y quedan explícitamente fuera de esta fase — ver
  `@atiende/domain-hoteles/src/fraude/deteccion.ts`. Cola de revisión humana
  (confirmar=fraude real / descartar=falso positivo) auditada vía
  `@atiende/core-authz::AuditSink` (`deps.hotelesFraudeAuditSink`), MISMO patrón que
  `despachos/revisiones.ts`. Roles: `FRAUD_SCAN_ROLES`/`FRAUD_VIEW_ROLES`/
  `FRAUD_RESOLVER_ROLES` (owner/gm/accountant).

## Fase 9 — `revenue.ts` (no documentada hasta este barrido)

7 rutas sobre el gate de revenue management (`hoteles.revenue_engine_gate`,
máquina de estados shadow/propone/autopilot) y el historial de backtests:
crear/consultar/transicionar el gate, aprobación explícita de "owner" para
autopilot, listar/crear corridas de backtest walk-forward, explicación de
precio y verificación de paridad/compset. **Honesto: no existe ningún motor
que PRODUZCA una recomendación de tarifa** (pickup/compset/evento/tipo de
cambio reales) — ver el comentario de cabecera del propio archivo y
`packages/domain-hoteles/README.md` §Fase 9 para el detalle completo de qué sí
y qué no hay.

## Fase 11/13 — `reputacion.ts` (no documentada hasta este barrido)

Rutas sobre `hoteles.guest_review`/`guest_review_action`: capturar/listar
reseñas, ficha de una reseña, responder (Fase 13), resolver una acción
(crea un ticket de mantenimiento real si la acción es
`ticket_mantenimiento`; `mensaje_proactivo`/`compensacion_reglada` siguen sin
ejecutarse de verdad) e índice de reputación agregado. Ver
`packages/domain-hoteles/README.md` §Fase 11 para el detalle.

Migraciones nuevas: `migrations/006_cfdi_hospedaje.sql` (`hoteles.cfdi_emision` +
columnas `dsa_per_night`/`rfc_emisor` en `hoteles.tax_config`) y
`migrations/007_fraude_alerta.sql` (`hoteles.fraud_alert`).
