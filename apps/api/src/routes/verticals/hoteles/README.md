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

## Fase 2 — agente de voz (ahora sobre `@atiende/voice-core`, sin ElevenLabs) + agente de WhatsApp con LLM real

Montadas directamente en `apps/api/src/app.ts` (no dentro de `hotelesRoutes`), mismo
criterio que restaurantes: son superficies sin sesión de staff, distintas de los 3
flujos de Fase 1.

- `voice-tools.ts` — rutas HTTP del agente de voz de hoteles que ejecuta el worker de `voice-core` (antes, Server Tools de ElevenLabs), las de tool **sin**
  `authMiddleware`/`originAllowed` (el worker no manda `Origin`/`Authorization`) y las de staff con sesión (`ADMIN_ROLES`):
  - `POST /v1/hoteles/:propertyId/voz/reservas/:herramienta` — las 6 herramientas de reservas (H-25), las mismas que WhatsApp.
  - `GET /hoteles/:propertyId/voz/estado` y `POST /hoteles/:propertyId/voz/preview/sesion` — estado honesto de la escalera y sesión de vista previa.
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

## H-01 — bóveda de identidad + registro migratorio + purga con doble control

Modelo en `packages/domain-hoteles/migrations/031_hoteles_boveda_identidad.sql`; dominio en
`@atiende/domain-hoteles::identity`; verificación contra Postgres real en
`scripts/verify-hoteles-boveda-identidad/`.

- `identidad.ts` — `GET/POST /hoteles/:propertyId/identidad` (captura cifrada AES-256-GCM en la
  API; la base solo guarda el sobre), `POST .../identidad/:id/verificar`, `.../revelar` (motivo
  obligatorio, huella en la bitácora, `Cache-Control: no-store`), `GET .../accesos` (owner/gm),
  `POST .../solicitar-purga`, `GET /identidad-purgas`, `POST /identidad-purgas/:id/decidir`
  (doble control: decide otra persona), y `GET/POST /registro-migratorio` + `.../reportar`.
- `identidad-purga-cron.ts` — `GET|POST /internal/hoteles/identidad-purga`: barrido de retención,
  una transacción por property con su fecha de negocio. **Desde H-02 BLOQUEA lo vencido y solo purga
  al vencer la ventana de bloqueo y sin retención legal** (`bloqueadas_total`/`purgadas_total`);
  contra una base sin 032 cae a la purga directa de 031 (`via_bloqueo:false`). Protegido con el secreto interno (401 sin
  él; Vercel lo manda como `Authorization: Bearer $CRON_SECRET`). Programado en `vercel.json`
  una vez al día a las `0 8 * * *` (08:00 UTC = 02:00 CDMX); ya son 21 crons. Con la base sin la
  migración 031 la property se omite (`omitida: migracion_pendiente`) y el cron responde 200.
- Llave: `HOTELES_IDENTITY_KEY` (base64, 32 bytes). Sin ella captura/revelación responden 503.
- **Plazos de retención (decisión de producto, NO mandato legal)** — ver
  `packages/domain-hoteles/README.md` §H-01 para la justificación y la lista "un abogado debe
  confirmar". Imagen/documento cifrado: **30 días después del check-out** de la reserva ligada
  (sin reserva, 30 días desde la captura), editable por captura de **0 a 365** (`retentionDays`;
  fuera de rango -> 400 "entre 0 y 365"). Registro migratorio/de huéspedes sin imagen: se conserva
  **365 días** desde la salida (`retencionRegistroHasta` en `GET/POST /registro-migratorio`) y la
  purga de la imagen NO lo toca.
- Base sin la migración 031: lecturas `disponible:false`, escrituras 503, el cron omite la property.

## H-02 — privacidad: consentimiento, ARCO, bloqueo, retención legal, incidentes

Modelo en `packages/domain-hoteles/migrations/032_hoteles_consentimiento_arco_incidentes.sql`; dominio en
`@atiende/domain-hoteles::privacy`; verificación contra Postgres real en
`scripts/verify-hoteles-privacidad-arco/`. **No es asesoría legal** (ver
`packages/domain-hoteles/README.md` §H-02, con la lista "un abogado debe confirmar").

- `privacidad.ts` — todo bajo `/hoteles/:propertyId/privacidad/`: `GET info` (aviso de no-asesoría-legal,
  lista para el abogado y plazos), `GET/PUT configuracion` (ventana de bloqueo 3-30, owner/gm),
  `GET/POST avisos`, `GET/POST consentimientos` y `POST consentimientos/:id/revocar` (front-of-house),
  `GET/POST arco`, `POST arco/:id/avanzar` y `.../prorroga` (owner/gm), `GET/POST incidentes` (reportar:
  front-of-house; leer y gestionar: owner/gm), `POST incidentes/:id/accion` (contener, registrar la
  notificación al titular, cerrar), `GET retenciones`, `POST identidades/:id/{bloquear,retencion,acceso-excepcional}`,
  `POST retenciones/:id/liberar`, `GET accesos-excepcionales`, `POST accesos-excepcionales/:id/{decidir,revelar}`
  y `GET bitacora`.
- `identidad.ts` — `POST /hoteles/:propertyId/identidad` acepta un `consentimiento` opcional (aviso, finalidades,
  canal, método, datos sensibles) que se valida contra el aviso ANTES de capturar y se registra en la misma
  transacción; la respuesta trae `consentimiento` (`registrado` | `no_disponible` | `null`). Aprobar una purga
  responde `en_bloqueo` (la identidad queda `bloqueada`; la purga llega al vencer la ventana). Una identidad
  bloqueada no se revela ni verifica (409).
- El sistema **no envía ninguna notificación** a titulares ni autoridades: el recordatorio del art. 19 es un
  campo calculado (`recordatorio`) de `GET incidentes`.
- Base sin la migración 032: lecturas `disponible:false`, escrituras 503, la captura de identidad sigue sin ledger.

## Tickets de huésped (H-05, migración 034)

- `tickets.ts` — `GET/POST /hoteles/:propertyId/tickets` (cualquier rol hotelero; la RLS filtra por rol),
  `GET .../tickets/:ticketId` (con bitácora), `POST .../iniciar|cerrar|cancelar` (manager, el departamento del
  ticket o el responsable), `POST .../escalar` y `.../reasignar` (owner/gm/frontdesk), `POST .../asignar`,
  `GET/PUT .../tickets/sla` (la política la escribe owner/gm), `GET .../tickets/resenas-pendientes` y
  `POST .../tickets/desde-resena` (reutiliza `hoteles.guest_review`; solo reseñas negativas).
- `tickets-sla-cron.ts` — `GET|POST /internal/hoteles/tickets-sla`: barrido de SLA (escala vencidos y avisa
  al 75%), sesión de sistema y una transacción por property. Protegido con el secreto interno. **No está en
  `vercel.json`**: programarlo es una decisión de despliegue (ver `docs/DEPLOY.md`).
- Base sin la migración 034: lecturas `disponible:false`, escrituras 503, el cron omite la property
  (`omitida: migracion_pendiente`).
- `holds-vencidos-cron.ts` (H-P3-03) — `GET|POST /internal/hoteles/holds-vencidos` (`*/15 * * * *` en `vercel.json`): libera el inventario de las
  pre-reservas del agente cuyo plazo venció (`booking_hold_expire_due`, migración 037), sesión de sistema y una transacción por property, reloj
  inyectable e idempotente. Base sin la 037: la property se omite (`omitida: migracion_pendiente`).
- `agentes.ts` (H-03, migración 035) — `GET /hoteles/:propertyId/agentes` (catálogo con estado, presupuesto y
  costo del mes), `PUT .../agentes/:agentKey` (kill switch con motivo y presupuesto en USD; owner/gm),
  `GET/PUT .../agentes/guardrails`, `GET .../agentes/politicas` + `PUT .../agentes/politicas/:accion`,
  `GET/POST .../agentes/plantillas` + `POST .../plantillas/:id/enviar|aprobar|rechazar|archivar` (versionadas;
  quien la envió no la aprueba salvo el dueño) y la cola `GET/POST .../aprobaciones`, `GET .../aprobaciones/:id`,
  `POST .../aprobaciones/:id/aprobar|rechazar|cancelar` (motivo obligatorio; roles según la política de la
  acción; quien propone no decide lo suyo) y `POST .../aprobaciones/:id/ejecutar` (owner/gm: consume una
  aprobación UNA vez; `respuesta_resena` aplica el efecto en la misma transacción, el resto exige referencia).
- `agentes-expiracion-cron.ts` — `GET|POST /internal/hoteles/aprobaciones-expiracion`: expira las solicitudes
  abiertas vencidas, sesión de sistema y una transacción por property. Protegido con el secreto interno. **No
  está en `vercel.json`** (ver `docs/DEPLOY.md`).
- `grupos.ts` (H-06, migración 036) — `GET/POST /hoteles/:propertyId/grupos/cotizaciones` (cotización de grupo con
  vigencia; montos en centavos enteros MXN, un decimal responde 400), `GET .../cotizaciones/:id`,
  `POST .../cotizaciones/:id/enviar|cerrar|aceptar|anticipos`. Aceptar BLOQUEA los cuartos (atómico y sin
  sobreventa; sin cupo en una noche = 409 y no retiene nada); el anticipo SOLO se registra (no cobra; owner/gm/
  accountant). `GET .../grupos/bloqueos[/:id]` (pickup confirmados vs bloqueados y rooming list),
  `POST .../bloqueos/:id/huespedes|liberar|cancelar` y `POST .../grupos/huespedes/:entryId/confirmar|cancelar`.
  Roles: ven owner/gm/frontdesk/reservations/accountant; gestionan owner/gm/reservations; rooming además frontdesk.
- `grupos-liberacion-cron.ts` — `GET|POST /internal/hoteles/grupos-liberacion`: libera lo NO confirmado de los
  bloqueos cuya fecha de liberación ya llegó en la zona horaria de CADA property y vence propuestas fuera de
  vigencia; sesión de sistema y una transacción por property. Protegido con el secreto interno. **No está en
  `vercel.json`** (programarlo es decisión de producto; ver `docs/DEPLOY.md`).
- `reservas-agente.ts` (H-25, migración 037) — lado staff del AGENTE DE RESERVAS: `GET /hoteles/:propertyId/reservas-agente/holds`
  (pre-reservas que apartó el agente; `?estado=` y `?abiertas=1`), `POST .../holds/:id/decidir` (`aprobar|rechazar` con motivo),
  `POST .../holds/:id/link-pago` (SOLO registra la referencia de un link que el hotel generó por fuera; rechaza números con forma de
  tarjeta), `POST .../holds/:id/confirmar` (crea la reserva y su folio; el inventario ya estaba retenido por el hold) y
  `POST .../holds/:id/cancelar`; `GET|PUT .../reservas-agente/politica` (habilitado, modo `aprobacion_humana|link_pago`, vigencia, topes).
  Ven owner/gm/frontdesk/reservations/accountant; deciden, confirman y cancelan owner/gm/reservations; la política la escriben owner/gm.
  Sin política habilitada (default) el agente NO expone herramientas de reservas. Base sin la 037: lecturas `disponible:false`, escrituras 503.
- `voice-tools.ts` — además de las 2 herramientas de F&B/contacto, `POST /v1/hoteles/:propertyId/voz/reservas/:herramienta`
  (`consultar_disponibilidad|cotizar_estancia|crear_pre_reserva|estado_pre_reserva|cancelar_pre_reserva|derivar_a_humano`) con el mismo núcleo que
  el agente de WhatsApp y el secreto dedicado por property; cuerpo = argumentos + `telefono` (+ `llamada_id` opcional). Nunca acepta un precio.
- Gobierno de agentes: el turno de WhatsApp (`production/hoteles-agentes-gobierno.ts`) y el barrido de revenue
  consultan el kill switch y el presupuesto de su agente por property; pausado o sin presupuesto, el mensaje
  se deriva a una persona. Base sin la 035: lecturas `disponible:false`, escrituras 503, comportamiento previo.
- `recepcion.ts` (H-28, migración 038) — vista de RECEPCIÓN: `GET /hoteles/:propertyId/recepcion?fecha=` (llegadas, salidas y en casa del día en
  la zona horaria de la property; rack de habitaciones con el estado de limpieza de `housekeeping/tablero` y la ocupación por reservas; solo
  la bandera `identidadRegistrada`, nunca el documento), `POST .../recepcion/reservas/:id/check-in` (confirmada → check_in → en_estancia de
  un clic; exige llegada no futura, estancia vigente, habitación del mismo tipo, limpia y sin traslape con otra reserva activa),
  `POST .../check-out` (en_estancia → check_out, la habitación queda sucia; NO cierra el folio, avisa cuántos siguen abiertos) y
  `POST .../cambiar-habitacion` (función atómica `hoteles.change_reservation_room` con bitácora). Ven owner/gm/frontdesk/reservations; operan
  owner/gm/frontdesk. Base sin la 038: tablero y check-out igual, check-in cae a la asignación simple con revisión de traslape en la
  aplicación, cambio de habitación responde 503 "no disponible aún".
- `huespedes.ts` (H-27, migración 038) — FICHA DE HUÉSPED: `GET /hoteles/:propertyId/huespedes/:guestId/ficha` (perfil, resumen e historial de
  estancias con monto neto en centavos, notas y preferencias, solicitudes de contacto de voz/WhatsApp enlazadas por teléfono, consentimientos,
  bandera de identidad y de ARCO) y `POST .../notas` / `.../notas/:id/archivar`. Minimización: nunca el documento; una nota con 13 a 19
  dígitos (tarjeta/documento; solo se ignoran espacios y guiones: es minimización de mejor esfuerzo, NO una garantía, un número con otros separadores puede pasar) se rechaza; con ARCO de cancelación u oposición en curso no se agregan notas (409 `arco_en_curso`). Roles:
  owner/gm/frontdesk/reservations. La ficha lee sus partes EN SECUENCIA (una sola transaccion por request; en paralelo los SAVEPOINT se intercalan). Base sin la 031/032/038: perfil e historial siguen, lo que falta va como `null` o `disponible:false`.
