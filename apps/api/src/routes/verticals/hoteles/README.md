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
