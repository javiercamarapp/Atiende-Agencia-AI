# Notificaciones in-app

Campana y página de notificaciones del panel de cada vertical y de superadmin. Este documento describe el modelo
(parte A, backend), el **catálogo de eventos** y la campana y la página (parte B, ver "Campana y página").

## Modelo

- `core.notification`: una fila **por destinatario** (`staff_user_id`), con `organization_id`, `vertical`, `tipo`
  (id del evento), `categoria`, `severidad` (`info` | `atencion` | `critica`), `titulo`, `cuerpo`, `enlace` (ruta
  interna relativa), `entidad_tipo`/`entidad_id`, `dedupe_key` y `expires_at`.
- `core.notification_read`: estado **leído por usuario** (marcar a uno no apaga a otro).
- RLS habilitada sin policy y sin GRANT a `anon`/`authenticated`: todo el acceso pasa por funciones
  `security definer` con `search_path` fijo (migración `packages/db/migrations/0039_notificaciones_productor_dedupe.sql`).
- **Un solo productor**: `core.emit_notification` (SQL) detrás de `emitirNotificacion` (`@atiende/db`,
  `packages/db/src/notificaciones/productor.ts`). Resuelve los destinatarios en la base, aplica dedupe
  (`unique (staff_user_id, dedupe_key)`), tope de 100 por destinatario por hora y retención (borra vencidas y de más
  de 180 días del destinatario al emitir).
- **Destinatarios**: owner/admin de la organización más los `roles` de vertical del evento (y solo quienes tienen
  acceso a la propiedad si se indica una); los eventos de superadmin van a `core.platform_superadmin`.
- **Quién puede emitir**: la sesión de sistema (crons, agentes, webhooks) o un miembro de la propia organización;
  nunca a otra organización. Las de plataforma, solo sistema o superadmin.
- **Sin PII**: título y cuerpo salen del catálogo; los parámetros solo pueden ser números o códigos cortos sin
  espacios. El enlace usa `{orgSlug}`, que resuelve la base.
- **Lectura**: `GET /notifications` (filtros `limit`, `before`, `unread=1`, `categoria`), `GET /notifications/unread-count`
  (solo el número, para el sondeo de la campana), `POST /notifications/:id/read`, `POST /notifications/read-all`. El contador de no leídas se calcula en SQL con el índice
  `(staff_user_id, created_at)`, sin N+1.
- **Compatibilidad con la base sin migrar**: la lectura cae a las funciones de 0013 y los productores devuelven
  `no_disponible`, ambos dentro de un `SAVEPOINT` (la transacción del request no queda abortada). Una emisión nunca
  rompe el flujo de negocio que la invoca.

## Preferencias por persona (R-16, migración 043)

Cada persona puede apagar un tipo de aviso (`core.notification_preference`: organización + usuario + tipo, sin fila = encendido).
`core.emit_notification` conserva su firma y su autorización; solo omite al destinatario que apagó ese `tipo`, así que los productores
de las 6 verticales no cambian. La lectura y la escritura pasan por `core.list_notification_preferences` / `core.set_notification_preference`
(cada quien edita las suyas; owner/admin las de su equipo, un admin no las de un owner). Hoy la pantalla Avisos de restaurantes
(`/restaurantes/{orgSlug}/avisos`) es la única que las edita; el `tipo` debe empezar por el vertical de la organización.

## Cómo agregar un evento

1. Agregarlo a `CATALOGO_NOTIFICACIONES` (`packages/db/src/notificaciones/catalogo.ts`).
2. Llamar `emitirNotificacion(db, { evento: "<id>", ... })` desde el flujo origen, con una clave de dedupe estable.
3. Marcar `productor.estado: "conectado"` con el archivo. `packages/db/tests/notificaciones-catalogo.spec.ts` falla si el
   archivo no existe o no contiene el id, si el enlace no es una ruta real de `apps/web`, si el texto admite PII o
   si el evento no aparece en este documento.

## Catálogo

### restaurantes

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `restaurantes.pedido.nuevo` | operacion | info | owner/admin, staff | ShoppingBag | `/restaurantes/{orgSlug}/pedidos` | un aviso por pedido (clave = id del pedido) | 7 d | conectado: `packages/domain-restaurantes/src/postgres-repository.ts` |
| `restaurantes.pedido.programado_en_cocina` | operacion | atencion | owner/admin, staff | CalendarRange | `/restaurantes/{orgSlug}/pedidos` | un aviso por pedido (clave = id del pedido) | 3 d | conectado: `packages/domain-restaurantes/src/pedidos-programados-avisos.ts` (sale al promover el pedido a pending: cron promover-programados, el panel de pedidos al consultar o el adelanto manual) |
| `restaurantes.pedido.programado_atrasado` | operacion | atencion | owner/admin, staff | TriangleAlert | `/restaurantes/{orgSlug}/pedidos` | un aviso por pedido atrasado (clave = id del pedido); sustituye al aviso normal de entrada a cocina | 3 d | conectado: `packages/domain-restaurantes/src/pedidos-programados-avisos.ts` (sale en lugar del aviso normal si el pedido entra a cocina con mas de 1 h de retraso (cron promover-programados, promocion al consultar el panel o adelanto manual)) |
| `restaurantes.whatsapp.mensaje_muerto` | salud | atencion | owner/admin, staff | MessageSquareWarning | `/restaurantes/{orgSlug}/pedidos` | un aviso por mensaje muerto (clave = id del mensaje del outbox) | 3 d | conectado: `apps/api/src/routes/internal/whatsapp-dispatch.ts` |
| `restaurantes.whatsapp.entrega_fallida_pedido` | salud | atencion | owner/admin, staff | MessageSquareWarning | `/restaurantes/{orgSlug}/pedidos` | un aviso por mensaje fallido (clave = id del mensaje del outbox) | 3 d | conectado: `apps/api/src/routes/verticals/restaurantes/whatsapp.ts` (sale cuando Meta reporta `failed` por el webhook (statuses); el aviso de estado de un pedido tambien se respalda por correo si el cliente dejo uno) |
| `restaurantes.whatsapp.entrega_fallida` | salud | atencion | owner/admin, staff | MessageSquareWarning | `/restaurantes/{orgSlug}/conversaciones` | un aviso por mensaje fallido (clave = id del mensaje del outbox) | 3 d | conectado: `apps/api/src/routes/verticals/restaurantes/whatsapp.ts` (mismo productor que el aviso de pedido, para los mensajes que no son un aviso de estado de pedido) |
| `restaurantes.whatsapp.entregas_fallidas_varias` | salud | critica | owner/admin, staff | MessageSquareWarning | `/restaurantes/{orgSlug}/agente-whatsapp` | un aviso por organizacion por hora (clave = organizacion + hora UTC); sustituye a los avisos individuales cuando hay mas de 5 fallos en una hora | 3 d | conectado: `apps/api/src/routes/verticals/restaurantes/whatsapp.ts` (agrupa los fallos de entrega para no inundar la campana) |
| `restaurantes.handoff.solicitado` | agentes | atencion | owner/admin, staff | UserRoundCog | `/restaurantes/{orgSlug}/conversaciones` | una por conversacion derivada | 3 d | conectado: `packages/domain-restaurantes/src/conversaciones/postgres-repository.ts` (`PostgresHandoffAgentGate.solicitarHumano`: la toma abierta por el agente de WhatsApp real o por el widget de la demo) |
| `restaurantes.voz.llamada_escalada` | agentes | atencion | owner/admin, staff | PhoneCall | `/restaurantes/{orgSlug}/agente-voz` | una por llamada | 3 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-interno.ts` |
| `restaurantes.voz.proveedor_con_fallas` | salud | atencion | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/agente-voz` | una por sucursal por hora | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-interno.ts` |
| `restaurantes.callback.pendiente` | agentes | atencion | owner/admin, staff | PhoneCall | `/restaurantes/{orgSlug}/conversaciones` | una por solicitud de contacto (clave = id) | 3 d | conectado: `packages/domain-restaurantes/src/postgres-repository.ts` |
| `restaurantes.cliente.llego` | operacion | critica | owner/admin, staff | MapPin | `/restaurantes/{orgSlug}/pedidos` | una por aviso de llegada (clave = id de la solicitud de contacto) | 1 d | conectado: `packages/domain-restaurantes/src/postgres-repository.ts` (sale con registrar_contacto(reason: cliente_llego) del agente de WhatsApp) |
| `restaurantes.voz.tope_mensual_80` | cobranza | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/agente-voz` | una por organizacion por mes (clave = organizacion + periodo) | 10 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-llamada.ts` (lo avisa el worker de telefonia al abrir una llamada; el tope vive en su configuracion (VOICE_TOPE_MENSUAL_USD / tabla DNIS)) |
| `restaurantes.voz.tope_mensual_alcanzado` | cobranza | critica | owner/admin | Gauge | `/restaurantes/{orgSlug}/agente-voz` | una por organizacion por mes (clave = organizacion + periodo) | 10 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-llamada.ts` (lo avisa el worker de telefonia cuando rechaza una llamada por el tope) |
| `restaurantes.voz.worker_sin_latido` | salud | critica | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/agente-voz` | una por organizacion por hora | 2 d | pendiente: requiere el latido del worker (AP2 §2): el worker todavia no reporta presencia a la API ni hay un cron que lo vigile; hoy solo responde /salud 503 en su propio host |
| `restaurantes.evento.solicitud` | operacion | atencion | owner/admin, staff | PartyPopper | `/restaurantes/{orgSlug}/conversaciones` | una por solicitud de evento (clave = id de la solicitud) | 7 d | conectado: `packages/domain-restaurantes/src/postgres-repository.ts` |
| `restaurantes.pedido.entrega_tardia` | operacion | atencion | owner/admin, staff | Clock | `/restaurantes/{orgSlug}/pedidos` | una por pedido (clave = id del pedido) | 2 d | conectado: `packages/domain-restaurantes/src/avisos-operativos.ts` (sale en el tick /internal/restaurantes/promover-programados (cada 5 min); la hora prometida es estimated_delivery_at, la hora de recogida o la creacion/hora programada mas el umbral de la sucursal (45 min por defecto)) |
| `restaurantes.pedido.programado_por_vencer` | operacion | atencion | owner/admin, staff | CalendarClock | `/restaurantes/{orgSlug}/pedidos` | una por pedido (clave = id del pedido) | 2 d | conectado: `packages/domain-restaurantes/src/avisos-operativos.ts` (sale en el tick /internal/restaurantes/promover-programados (cada 5 min)) |
| `restaurantes.pedido.incidencia_repartidor` | operacion | atencion | owner/admin, staff | Truck | `/restaurantes/{orgSlug}/pedidos` | una por incidencia (clave = id del pedido + minuto UTC del reporte) | 3 d | conectado: `apps/api/src/routes/verticals/restaurantes/repartidor-orders.ts` |
| `restaurantes.comanda.captura_manual_vencida` | operacion | atencion | owner/admin, staff | ClipboardList | `/restaurantes/{orgSlug}/comandas-pos` | una por comanda (clave = id de la comanda) | 2 d | conectado: `packages/domain-restaurantes/src/softrestaurant/alerta-vencida.ts` (sale en el tick /internal/restaurantes/softrestaurant-dispatch (cada 5 min), antes de revisar si hay adaptador real; el umbral por sucursal (5 min por omision) se fija en Comandas al POS) |
| `restaurantes.proveedor.falla` | salud | critica | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/configuracion` | una por proveedor por dia | 7 d | conectado: `packages/domain-restaurantes/src/alertas-duenio/proveedor.ts` (sale en el despachador /internal/whatsapp/dispatch (cada 5 min) cuando una organizacion acumula 3 o mas fallas de Meta o de la red en la corrida y ningun envio exitoso; la ventana es la corrida, no hay estado entre ticks) |
| `restaurantes.whatsapp.token_invalido` | salud | critica | owner/admin | KeyRound | `/restaurantes/{orgSlug}/configuracion` | una por organizacion por dia (clave = proveedor y fecha de Merida) | 7 d | conectado: `packages/domain-restaurantes/src/alertas-duenio/proveedor.ts` (sale de inmediato en el despachador /internal/whatsapp/dispatch al recibir el error 190 de Graph API; los avisos a 14, 7 y 1 dia de la expiracion requieren que la expiracion sea conocida (no se guarda hoy)) |
| `restaurantes.marketing.borrador_listo` | aprobaciones | atencion | owner/admin | Megaphone | `/restaurantes/{orgSlug}/campanas` | una por campana (clave = id de la campana) | 7 d | conectado: `packages/domain-restaurantes/src/marketing/campanas.ts` (sale en el tick /internal/restaurantes/promover-programados (cada 5 min; la base crea a lo sumo un borrador por organizacion, segmento y dia); apagado por omision: requiere activar marketing_config y la migracion 052) |
| `restaurantes.whatsapp.silencio` | salud | atencion | owner/admin | PhoneOff | `/restaurantes/{orgSlug}/configuracion` | una por organizacion por dia (clave = fecha de Merida) | 2 d | conectado: `packages/domain-restaurantes/src/alertas-duenio/silencio.ts` (sale en el tick /internal/restaurantes/promover-programados (cada 5 min): 0 mensajes entrantes en la ventana (60 min por omision) cuando el mismo dia y hora de las 4 semanas previas promediaron 3 o mas; el horario de servicio se infiere del historico; umbrales por organizacion en alertas_duenio_config; requiere la migracion 052) |
| `restaurantes.ia.presupuesto_umbral` | cierres | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/configuracion` | una por umbral (80, 100) por mes de Merida | 31 d | conectado: `packages/domain-restaurantes/src/alertas-duenio/presupuesto.ts` (sale desde la reserva mensual de IA (apps/api/src/production/llm-usage-gateway-adapters.ts) al 80 por ciento y al agotarse el tope; solo organizaciones de restaurantes; requiere la migracion 052 (es_organizacion_restaurantes)) |
| `restaurantes.demo.tope_diario_alcanzado` | cierres | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/configuracion` | una por dia | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/demo-widget.ts` (el chat público de la demo llegó al tope diario de mensajes de la organización: tope de costo) |
| `restaurantes.voz.tope_notas_alcanzado` | cierres | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/configuracion` | una por dia | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/whatsapp.ts` (tope de costo de transcripcion por organizacion (R-32)) |
| `restaurantes.costo.umbral_voz` | cierres | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/agente-voz` | una por sucursal por dia | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-kpi.ts` (depende de accion manual: sale cuando alguien evalua las alertas (POST .../alertas/evaluar), no hay cron) |
| `restaurantes.onboarding.listo` | onboarding | info | owner/admin | CircleCheckBig | `/restaurantes/{orgSlug}/primeros-pasos` | una por organizacion, al completarse el ultimo punto obligatorio (no al leer el checklist) | 30 d | conectado: `apps/api/src/routes/verticals/restaurantes/onboarding-aviso.ts` (se emite en la escritura que lo completa: disponibilidad de menu por sucursal, politica/horario de sucursal o configuracion del agente) |
| `restaurantes.cierre.dia_listo` | cierres | info | owner/admin | ReceiptText | `/restaurantes/{orgSlug}/cierres` | una por sucursal por dia de negocio (clave = sucursal + fecha); reintentar el cierre no repite el aviso | 14 d | conectado: `packages/domain-restaurantes/src/cierres/barrido.ts` (sale al generar el cierre (boton del panel o POST /internal/restaurantes/cierres-dia); no hay cron en vercel.json (decision de costo): hasta que alguien agende el endpoint, solo sale con el boton) |
| `restaurantes.cierre.semana_lista` | cierres | info | owner/admin | CalendarRange | `/restaurantes/{orgSlug}/cierres` | una por sucursal por semana (clave = sucursal + lunes de la semana) | 30 d | conectado: `packages/domain-restaurantes/src/cierres/barrido.ts` (mismo productor y misma limitacion de cron que el cierre del dia) |
| `restaurantes.aprobacion.pedido_grande` | aprobaciones | atencion | owner/admin, staff | ShieldCheck | `/restaurantes/{orgSlug}/pedidos` | una por solicitud (clave = id de la solicitud) | 3 d | pendiente: El productor existe y esta probado (packages/domain-restaurantes/src/autopiloto/servicio.ts) pero nadie lo invoca aun: requiere cablear el agente de WhatsApp y voz sobre B2 y B1 (PR 421 y 424), que `crear_pedido` llame a `retenerPedidoGrande` al detectar un pedido grande |
| `restaurantes.aprobacion.cancelacion` | aprobaciones | atencion | owner/admin, staff | CircleX | `/restaurantes/{orgSlug}/pedidos` | una por solicitud (clave = id de la solicitud) | 2 d | conectado: `packages/domain-restaurantes/src/autopiloto/servicio.ts` (sale cuando el agente de WhatsApp recibe una cancelacion con la bandera de la organizacion encendida (Reglas del autopiloto, apagada por omision); la voz todavia no) |
| `restaurantes.aprobacion.compensacion` | aprobaciones | atencion | owner/admin, staff | HandCoins | `/restaurantes/{orgSlug}/pedidos` | una por solicitud (clave = id de la solicitud) | 7 d | conectado: `packages/domain-restaurantes/src/autopiloto/servicio.ts` (sale cuando el clasificador de WhatsApp detecta una queja y el cliente tiene un pedido reciente entregado; la voz todavia no) |
| `restaurantes.aprobacion.vencida` | aprobaciones | critica | owner/admin | AlarmClock | `/restaurantes/{orgSlug}/pedidos` | una por solicitud (clave = id de la solicitud); solo owner/admin | 3 d | conectado: `packages/domain-restaurantes/src/autopiloto/servicio.ts` (sale en el tick /internal/restaurantes/promover-programados (cada 5 min)) |
| `restaurantes.pedido.cancelado_por_cliente` | operacion | atencion | owner/admin, staff | Ban | `/restaurantes/{orgSlug}/pedidos` | una por pedido (clave = id del pedido) | 2 d | conectado: `packages/domain-restaurantes/src/autopiloto/servicio.ts` (solo con la bandera de la organizacion y la cancelacion automatica de la sucursal encendidas (ambas apagadas por omision), pedido sin comanda en el POS) |
| `restaurantes.pedido.no_recogido` | operacion | atencion | owner/admin, staff | PackageX | `/restaurantes/{orgSlug}/pedidos` | una por pedido (clave = id del pedido) | 2 d | conectado: `packages/domain-restaurantes/src/autopiloto/servicio.ts` (sale en el tick /internal/restaurantes/promover-programados (cada 5 min); no se avisa al cliente) |
| `restaurantes.handoff.devuelto_automatico` | agentes | info | owner/admin, staff | Undo2 | `/restaurantes/{orgSlug}/conversaciones` | una por toma (clave = id del handoff) | 3 d | conectado: `packages/domain-restaurantes/src/autopiloto/servicio.ts` (sale en el tick /internal/restaurantes/promover-programados (cada 5 min)) |
| `restaurantes.repartidor.licencia_por_vencer` | operacion | atencion | owner/admin | IdCard | `/restaurantes/{orgSlug}/staff` | una por repartidor por mes | 30 d | conectado: `packages/domain-restaurantes/src/repartidor-perfil/notificar.ts` (sale al guardar el perfil con la licencia a menos de 30 dias y en el barrido POST /internal/restaurantes/repartidor-licencias; no hay cron en vercel.json (decision de costo): hasta que alguien agende el endpoint, solo sale al guardar el perfil) |
| `restaurantes.repartidor.licencia_vencida` | operacion | critica | owner/admin | IdCard | `/restaurantes/{orgSlug}/staff` | una por repartidor por mes | 30 d | conectado: `packages/domain-restaurantes/src/repartidor-perfil/notificar.ts` (mismo productor y misma limitacion de cron que la licencia por vencer) |
| `restaurantes.voz.tasa_error_alta` | salud | atencion | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/agente-voz` | una por sucursal por dia | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-kpi.ts` (depende de accion manual: sale cuando alguien evalua las alertas (POST .../alertas/evaluar), no hay cron) |
| `restaurantes.agente.whatsapp_apagado` | agentes | atencion | owner/admin, staff | PowerOff | `/restaurantes/{orgSlug}/conversaciones` | una por sucursal por dia (clave = id de la sucursal y fecha UTC) | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/admin-conocimiento.ts` (sale al apagar el agente de WhatsApp de una sucursal; requiere la migracion 053 para que el interruptor exista) |
| `restaurantes.plan.mensajes_80` | cobranza | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `restaurantes.plan.mensajes_excedido` | cobranza | critica | owner/admin | Gauge | `/restaurantes/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `restaurantes.plan.prueba_por_vencer` | cobranza | atencion | owner/admin | Clock | `/restaurantes/{orgSlug}/plan` | una por organizacion por umbral (7, 3 y 1 dia) y fecha de fin | 8 d | conectado: `apps/api/src/plan-topes/aviso-prueba.ts` (sale en el cron diario /internal/plataforma/prueba-avisos (vercel.json, 14:00 UTC)) |

### hoteles

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `hoteles.ticket.sla_vencido` | operacion | atencion | owner/admin, gm, frontdesk | Clock | `/hoteles/{orgSlug}/tickets` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/tickets-sla-cron.ts` |
| `hoteles.aprobacion.expirada` | aprobaciones | atencion | owner/admin, gm, reservations | ShieldAlert | `/hoteles/{orgSlug}/aprobaciones` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/agentes-expiracion-cron.ts` |
| `hoteles.aprobacion.pendiente` | aprobaciones | atencion | owner/admin, gm, reservations | ShieldCheck | `/hoteles/{orgSlug}/aprobaciones` | una por solicitud | 3 d | conectado: `packages/domain-hoteles/src/agentes/postgres-repository.ts` |
| `hoteles.conversacion.handoff` | agentes | atencion | owner/admin, frontdesk, reservations | UserRoundCog | `/hoteles/{orgSlug}/conversaciones` | una por conversacion derivada (clave = id de la conversacion + numero de derivacion) | 3 d | conectado: `packages/domain-hoteles/src/conversaciones/postgres-repository.ts` (se emite cuando el agente pide una persona o el gobierno lo bloquea (pausado o sin presupuesto); los mensajes nuevos con la conversacion ya en humano solo suman no leidos en la bandeja) |
| `hoteles.grupo.por_liberar` | cierres | atencion | owner/admin, gm, reservations | Users | `/hoteles/{orgSlug}/grupos` | una por propiedad por dia | 5 d | pendiente: cron grupos-liberacion: falta decidir el umbral de aviso con producto |
| `hoteles.lista_espera.disponible` | operacion | atencion | owner/admin, gm, frontdesk, reservations | Hourglass | `/hoteles/{orgSlug}/reservas` | una por entrada ofrecida (clave = id de la entrada) | 3 d | conectado: `apps/api/src/routes/verticals/hoteles/lista-espera-ofertas.ts` (se emite al cancelar una reserva o acortar fechas y encontrar una entrada compatible; el aviso al huesped por WhatsApp no esta conectado (depende de Meta, H-23)) |
| `hoteles.night_audit.fallo` | cierres | critica | owner/admin, gm, accountant | MoonStar | `/hoteles/{orgSlug}/reservas` | una por propiedad por noche | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/night-audit.ts` |
| `hoteles.grupo.liberado` | cierres | atencion | owner/admin, gm, reservations | Users | `/hoteles/{orgSlug}/grupos` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/grupos-liberacion-cron.ts` |
| `hoteles.housekeeping.inspeccion_rechazada` | operacion | atencion | owner/admin, gm, frontdesk, housekeeping | ClipboardX | `/hoteles/{orgSlug}/housekeeping` | una por tarea y por rechazo | 3 d | conectado: `apps/api/src/routes/verticals/hoteles/housekeeping.ts` |
| `hoteles.housekeeping.dia_generado` | automatizaciones | info | owner/admin, gm, frontdesk, housekeeping | ClipboardList | `/hoteles/{orgSlug}/housekeeping` | una por propiedad por dia | 2 d | conectado: `apps/api/src/routes/verticals/hoteles/housekeeping-dia-cron.ts` |
| `hoteles.housekeeping.sin_cupo` | operacion | atencion | owner/admin, gm, frontdesk | UsersRound | `/hoteles/{orgSlug}/housekeeping` | una por propiedad por dia | 2 d | conectado: `apps/api/src/routes/verticals/hoteles/housekeeping-residual.ts` (tambien la emite el arranque automatico del dia (housekeeping-dia-cron.ts) cuando la asignacion automatica deja tareas sin camarista) |
| `hoteles.tarifa.aplicacion_rechazada` | operacion | atencion | owner/admin, gm | Gauge | `/hoteles/{orgSlug}/revenue` | una por propiedad por dia | 5 d | conectado: `apps/api/src/routes/verticals/hoteles/revenue-recommendations-cron.ts` |
| `hoteles.canal.whatsapp_actualizado` | seguridad | atencion | owner/admin, gm | MessageSquareLock | `/hoteles/{orgSlug}/mensajeria` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/mensajeria-config.ts` |
| `hoteles.arco.solicitud_publica` | operacion | atencion | owner/admin, gm | ShieldAlert | `/hoteles/{orgSlug}/identidad` | una por solicitud (clave = id) | 14 d | conectado: `apps/api/src/routes/verticals/hoteles/privacidad-publica.ts` (se emite cuando el titular confirma el codigo de su correo (la solicitud publica pasa de pendiente_verificacion a recibida)) |
| `hoteles.plan.mensajes_80` | cobranza | atencion | owner/admin | Gauge | `/hoteles/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `hoteles.plan.mensajes_excedido` | cobranza | critica | owner/admin | Gauge | `/hoteles/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `hoteles.plan.prueba_por_vencer` | cobranza | atencion | owner/admin | Clock | `/hoteles/{orgSlug}/plan` | una por organizacion por umbral (7, 3 y 1 dia) y fecha de fin | 8 d | conectado: `apps/api/src/plan-topes/aviso-prueba.ts` (sale en el cron diario /internal/plataforma/prueba-avisos (vercel.json, 14:00 UTC)) |

### rentas

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `rentas.ical.sync_fallido` | salud | critica | owner/admin, admin_gestora, operador:acceso_total | RefreshCwOff | `/rentas/{orgSlug}/monitor-sync` | una por property por dia (clave = property + dia) | 7 d | conectado: `apps/api/src/routes/verticals/rentas/ical-sync-cron.ts` |
| `rentas.reserva.nueva_ical` | operacion | info | owner/admin, admin_gestora, operador:acceso_total, operador:calendario_mensajeria | CalendarPlus | `/rentas/{orgSlug}/calendario` | una por property por dia (clave = property + dia) | 5 d | conectado: `apps/api/src/routes/verticals/rentas/ical-sync-cron.ts` |
| `rentas.conflicto.detectado` | operacion | critica | owner/admin, admin_gestora, operador:acceso_total | CalendarX | `/rentas/{orgSlug}/calendario` | una por property por dia (clave = property + dia) | 7 d | conectado: `apps/api/src/routes/verticals/rentas/ical-sync-cron.ts` |
| `rentas.aprobacion.pendiente` | aprobaciones | atencion | owner/admin, admin_gestora, operador:calendario_mensajeria | MessageSquareWarning | `/rentas/{orgSlug}/aprobaciones` | una por mensaje | 3 d | conectado: `apps/api/src/routes/verticals/rentas/mensajeria-borradores.ts` |
| `rentas.aprobacion.urgente` | aprobaciones | critica | owner/admin, admin_gestora, operador:calendario_mensajeria | Siren | `/rentas/{orgSlug}/aprobaciones/{entidadId}` | una por borrador (clave = id del borrador; se emite en lugar de rentas.aprobacion.pendiente) | 3 d | conectado: `apps/api/src/routes/verticals/rentas/mensajeria-borradores.ts` (entidadId = id de la conversacion) |
| `rentas.limpieza.tarea_asignada` | operacion | info | owner/admin, limpieza | ClipboardCheck | `/rentas/{orgSlug}/mis-tareas` | una por tarea y persona asignada (clave = tarea + persona) | 3 d | conectado: `apps/api/src/routes/verticals/rentas/limpieza-avisos.ts` (llega a owner/admin y a todo el rol limpieza de la propiedad, no solo a quien recibe la tarea (core.emit_notification no admite destinatario)) |
| `rentas.limpieza.sin_asignar` | operacion | atencion | owner/admin, admin_gestora, operador:acceso_total | UserX | `/rentas/{orgSlug}/mis-tareas` | una por propiedad por dia de la tarea (clave = propiedad + dia) | 2 d | conectado: `apps/api/src/routes/verticals/rentas/limpieza-avisos.ts` |
| `rentas.privacidad.arco_registrada` | seguridad | atencion | owner/admin, admin_gestora | ShieldAlert | `/rentas/{orgSlug}/privacidad` | una por solicitud | 30 d | conectado: `apps/api/src/routes/verticals/rentas/privacidad.ts` |
| `rentas.privacidad.arco_por_vencer` | seguridad | critica | owner/admin, admin_gestora | CalendarClock | `/rentas/{orgSlug}/privacidad` | una por organizacion por dia (clave = organizacion + dia) | 7 d | pendiente: Requiere un cron diario que revise los plazos de las solicitudes abiertas; no se agenda en este PR (decision de costo, igual que la purga PL-13). |
| `rentas.plan.mensajes_80` | cobranza | atencion | owner/admin | Gauge | `/rentas/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `rentas.plan.mensajes_excedido` | cobranza | critica | owner/admin | Gauge | `/rentas/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `rentas.plan.prueba_por_vencer` | cobranza | atencion | owner/admin | Clock | `/rentas/{orgSlug}/plan` | una por organizacion por umbral (7, 3 y 1 dia) y fecha de fin | 8 d | conectado: `apps/api/src/plan-topes/aviso-prueba.ts` (sale en el cron diario /internal/plataforma/prueba-avisos (vercel.json, 14:00 UTC)) |

### despachos

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `despachos.cobranza.recordatorios` | cobranza | atencion | owner/admin, contador | Receipt | `/despachos/{orgSlug}/cola-cobranza` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/despachos/notifications.ts` |
| `despachos.fiscal.vencimiento_proximo` | fiscal | atencion | owner/admin, contador | CalendarClock | `/despachos/{orgSlug}/vencimientos` | una por property por dia | 7 d | conectado: `packages/domain-despachos/src/vencimientos/procesos.ts` (lo dispara el boton del panel y el cron diario /internal/despachos/vencimientos-barrido (D-26)) |
| `despachos.efos.alerta` | fiscal | critica | owner/admin, contador, auditor | ShieldAlert | `/despachos/{orgSlug}/cfdi` | una por CFDI ingerido (clave = id del CFDI) | 30 d | conectado: `apps/api/src/routes/verticals/despachos/cfdi.ts` (tambien lo emite el cron mensual /internal/despachos/efos-69b/descarga, apps/api/src/routes/verticals/despachos/cron-sat.ts, con la misma clave: un CFDI no se avisa dos veces) |
| `despachos.fiscal.vencimiento_vencido` | fiscal | critica | owner/admin, contador | CalendarX | `/despachos/{orgSlug}/vencimientos` | una por property por dia | 14 d | conectado: `packages/domain-despachos/src/vencimientos/procesos.ts` (lo dispara el boton del panel y el cron diario /internal/despachos/vencimientos-barrido (D-26)) |
| `despachos.fiscal.vencimiento_escalado` | fiscal | atencion | owner/admin, contador | ArrowUpFromLine | `/despachos/{orgSlug}/vencimientos` | una por vencimiento y nivel | 14 d | conectado: `apps/api/src/routes/verticals/despachos/vencimientos.ts` (depende de accion manual: sale al escalar a mano un vencimiento desde el panel, no hay cron) |
| `despachos.rep.incoherente` | fiscal | atencion | owner/admin, contador, auditor | FileWarning | `/despachos/{orgSlug}/cfdi` | una por complemento de pago guardado (clave = property + folio fiscal del REP) | 14 d | pendiente: el analisis de REP (POST .../cfdi/rep/analizar) no guarda nada y lo pueden llamar roles de solo lectura: emitir ahi llenaria la campana con XML arbitrario; se conecta cuando el REP se persista |
| `despachos.cfdi.lote_importado` | fiscal | info | owner/admin, contador | FileStack | `/despachos/{orgSlug}/cfdi` | una por lote importado (clave = identificador aleatorio del lote, generado por la peticion) | 14 d | conectado: `apps/api/src/routes/verticals/despachos/cfdi-lote.ts` (POST .../cfdi/importar-lote (carga masiva de XML o ZIP, D-13): una por peticion con al menos un CFDI o REP nuevo; no se emite si todo fue duplicado o rechazado) |
| `despachos.cfdi.cancelado` | fiscal | critica | owner/admin, contador | FileX | `/despachos/{orgSlug}/cfdi/{entidadId}` | una por CFDI (clave = id del CFDI; la cancelacion es terminal) | 30 d | conectado: `apps/api/src/routes/verticals/despachos/cfdi-estatus-sat.ts` (tambien lo emite el cron semanal de estatus SAT (apps/worker/src/jobs/despachos/cfdi-estatus-sat.ts, via cron-sat.ts); el mismo CFDI no se avisa dos veces) |
| `despachos.pago_provisional.por_vencer` | fiscal | atencion | owner/admin, contador | CalendarClock | `/despachos/{orgSlug}/pagos-provisionales` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/despachos/pagos-provisionales-aviso.ts` |
| `despachos.conciliacion.sugerencias_pendientes` | aprobaciones | atencion | owner/admin, contador | Sparkles | `/despachos/{orgSlug}/conciliacion` | una por sesion de conciliacion (clave = id de la sesion) | 7 d | conectado: `apps/api/src/routes/verticals/despachos/conciliacion-persistida.ts` |
| `despachos.plan.mensajes_80` | cobranza | atencion | owner/admin | Gauge | `/despachos/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `despachos.plan.mensajes_excedido` | cobranza | critica | owner/admin | Gauge | `/despachos/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `despachos.plan.prueba_por_vencer` | cobranza | atencion | owner/admin | Clock | `/despachos/{orgSlug}/plan` | una por organizacion por umbral (7, 3 y 1 dia) y fecha de fin | 8 d | conectado: `apps/api/src/plan-topes/aviso-prueba.ts` (sale en el cron diario /internal/plataforma/prueba-avisos (vercel.json, 14:00 UTC)) |

### licitaciones

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `licitaciones.plazo.por_vencer` | operacion | atencion | owner/admin, analyst, writer, reviewer | Hourglass | `/licitaciones/{orgSlug}/seguimiento` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/discover.ts` |
| `licitaciones.convocatoria.nueva` | operacion | info | owner/admin, analyst | FilePlus2 | `/licitaciones/{orgSlug}/convocatorias` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/discover.ts` |
| `licitaciones.fallo.publicado` | cierres | atencion | owner/admin, analyst, reviewer | Gavel | `/licitaciones/{orgSlug}/seguimiento` | una por convocatoria | 30 d | pendiente: requiere el detector de fallo en la fuente (depende de un agregador comercial sin proveedor elegido) |
| `licitaciones.expediente.aprobacion_pendiente` | aprobaciones | atencion | owner/admin, analyst | ShieldCheck | `/licitaciones/{orgSlug}/convocatorias` | una por propuesta y estado de insumos (clave = id de la propuesta + prefijo del hash de insumos) | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/cierre.ts` |
| `licitaciones.expediente.aprobado` | cierres | info | owner/admin, analyst, writer | CircleCheckBig | `/licitaciones/{orgSlug}/convocatorias` | una por propuesta y estado de insumos (clave = id de la propuesta + prefijo del hash de insumos) | 14 d | conectado: `apps/api/src/routes/verticals/licitaciones/cierre.ts` |
| `licitaciones.presentacion.declarada` | cierres | info | owner/admin, analyst, reviewer | FileCheck2 | `/licitaciones/{orgSlug}/convocatorias` | una por propuesta (clave = id de la propuesta) | 30 d | conectado: `apps/api/src/routes/verticals/licitaciones/cierre.ts` |
| `licitaciones.plan.mensajes_80` | cobranza | atencion | owner/admin | Gauge | `/licitaciones/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `licitaciones.plan.mensajes_excedido` | cobranza | critica | owner/admin | Gauge | `/licitaciones/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `licitaciones.plan.prueba_por_vencer` | cobranza | atencion | owner/admin | Clock | `/licitaciones/{orgSlug}/plan` | una por organizacion por umbral (7, 3 y 1 dia) y fecha de fin | 8 d | conectado: `apps/api/src/plan-topes/aviso-prueba.ts` (sale en el cron diario /internal/plataforma/prueba-avisos (vercel.json, 14:00 UTC)) |
| `licitaciones.sala_guerra.paquete_no_listo` | cierres | critica | owner/admin, analyst, writer, reviewer | TimerReset | `/licitaciones/{orgSlug}/convocatorias` | una por convocatoria (clave = id de la convocatoria) | 3 d | conectado: `apps/api/src/routes/verticals/licitaciones/salaGuerra.ts` |
| `licitaciones.renovacion.por_vencer` | operacion | atencion | owner/admin, analyst | CalendarClock | `/licitaciones/{orgSlug}/radar-renovaciones` | una por organizacion por dia (solo cuando el barrido creo alertas nuevas) | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts` (sale del barrido /internal/licitaciones/alert-notifications (cron existente de vercel.json)) |
| `licitaciones.cobranza.factura_vencida` | cobranza | atencion | owner/admin, analyst | Receipt | `/licitaciones/{orgSlug}/radar-renovaciones` | una por organizacion por semana (mientras sigan vencidas) | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts` (sale del barrido /internal/licitaciones/alert-notifications (cron existente de vercel.json)) |
| `licitaciones.convocatoria.bases_modificadas` | operacion | atencion | owner/admin, analyst, writer, reviewer | FileDiff | `/licitaciones/{orgSlug}/seguimiento` | una por convocatoria y version (clave = id de la convocatoria + numero de version) | 14 d | conectado: `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts` (se emite en la escritura que crea la nueva version (alta manual, recalculo y re-extraccion de requisitos), nunca en una lectura) |
| `licitaciones.documentos.por_vencer` | operacion | atencion | owner/admin, analyst, writer | FileClock | `/licitaciones/{orgSlug}/datos-empresa` | una por organizacion por semana (mientras haya documentos por vencer) | 14 d | conectado: `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts` (sale del barrido /internal/licitaciones/alert-notifications; requiere la migracion 034 (sin ella no emite)) |
| `licitaciones.datos_empresa.aprobacion_pendiente` | aprobaciones | atencion | owner/admin, analyst | ShieldCheck | `/licitaciones/{orgSlug}/datos-empresa` | una por dato y hora (clave = tipo + id del dato + hora) | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/companyData.ts` (se emite al crear o editar un dato de empresa (queda pendiente de aprobacion)) |
| `licitaciones.kyc.proveedor_empeoro` | fiscal | critica | owner/admin, analyst, reviewer | ShieldAlert | `/licitaciones/{orgSlug}/kyc-69b` | una por organizacion y edicion de la lista (clave = organizacion + periodo) | 30 d | conectado: `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts` (sale de POST /internal/licitaciones/kyc-69b/retamizar (ruta interna idempotente; sin cron en vercel.json, la invoca quien ingiere la lista); requiere la migracion 034) |
| `licitaciones.contrato.garantia_por_vencer` | operacion | atencion | owner/admin, analyst, reviewer | ShieldAlert | `/licitaciones/{orgSlug}/convocatorias/{entidadId}/post-adjudicacion` | una por garantia y fecha de fin de vigencia (clave = id de la garantia + fecha) | 30 d | conectado: `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts` (sale del barrido /internal/licitaciones/alert-notifications (cron existente de vercel.json); requiere la migracion 035 (sin ella no emite)) |
| `licitaciones.contrato.garantia_no_entregada` | operacion | critica | owner/admin, analyst, reviewer | FileWarning | `/licitaciones/{orgSlug}/convocatorias/{entidadId}/post-adjudicacion` | una por garantia y fecha limite de entrega (clave = id de la garantia + fecha) | 14 d | conectado: `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts` (sale del barrido /internal/licitaciones/alert-notifications (cron existente de vercel.json); requiere la migracion 035 (sin ella no emite)) |
| `licitaciones.contrato.hito_vencido` | operacion | atencion | owner/admin, analyst, writer, reviewer | ListChecks | `/licitaciones/{orgSlug}/convocatorias/{entidadId}/post-adjudicacion` | una por hito y fecha comprometida (clave = id del hito + fecha) | 14 d | conectado: `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts` (sale del barrido /internal/licitaciones/alert-notifications (cron existente de vercel.json); requiere la migracion 035 (sin ella no emite)) |

### citas

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `citas.cita.nueva` | operacion | info | owner/admin, staff | CalendarPlus | `/citas/{orgSlug}/agenda` | una por cita | 7 d | conectado: `packages/domain-citas/src/postgres-repository.ts` |
| `citas.cita.cancelada` | operacion | atencion | owner/admin, staff | CalendarX | `/citas/{orgSlug}/agenda` | una por cita cancelada | 7 d | conectado: `packages/domain-citas/src/postgres-repository.ts` |
| `citas.recordatorio.fallido` | salud | atencion | owner/admin | BellOff | `/citas/{orgSlug}/mensajes-whatsapp` | una por dia | 5 d | conectado: `apps/api/src/routes/verticals/citas/reminders.ts` |
| `citas.whatsapp.sin_plantilla` | salud | atencion | owner/admin | BellOff | `/citas/{orgSlug}/mensajes-whatsapp` | una por organizacion por evento y dia | 5 d | conectado: `apps/api/src/routes/verticals/citas/reminders.ts` |
| `citas.escalacion.crisis` | agentes | critica | owner/admin | LifeBuoy | `/citas/{orgSlug}/avisos` | una por escalacion (clave = id de la escalacion) | 14 d | conectado: `packages/domain-citas/src/postgres-repository.ts` |
| `citas.escalacion.sin_seguimiento` | agentes | critica | owner/admin | Siren | `/citas/{orgSlug}/avisos` | una por dia | 3 d | conectado: `apps/api/src/routes/verticals/citas/avisos-ciclo.ts` |
| `citas.cita.por_confirmar` | operacion | atencion | owner/admin, staff | CalendarClock | `/citas/{orgSlug}/avisos` | una por dia | 3 d | conectado: `apps/api/src/routes/verticals/citas/avisos-ciclo.ts` |
| `citas.recordatorio.agotado` | salud | atencion | owner/admin | BellOff | `/citas/{orgSlug}/avisos` | una por cada recordatorio nuevo agotado (clave = instante del ultimo) | 5 d | conectado: `apps/api/src/routes/verticals/citas/avisos-ciclo.ts` |
| `citas.conversacion.handoff` | agentes | atencion | owner/admin, staff | UserRoundCog | `/citas/{orgSlug}/conversaciones` | una por conversacion derivada (clave = id del handoff) | 3 d | conectado: `packages/domain-citas/src/conversaciones/postgres-repository.ts` (se emite cuando el agente pide una persona (hoy: una escalacion de crisis); en ese caso sube a severidad critica. Una toma iniciada por el propio personal no avisa) |
| `citas.plan.mensajes_80` | cobranza | atencion | owner/admin | Gauge | `/citas/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `citas.plan.mensajes_excedido` | cobranza | critica | owner/admin | Gauge | `/citas/{orgSlug}/plan` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `citas.plan.prueba_por_vencer` | cobranza | atencion | owner/admin | Clock | `/citas/{orgSlug}/plan` | una por organizacion por umbral (7, 3 y 1 dia) y fecha de fin | 8 d | conectado: `apps/api/src/plan-topes/aviso-prueba.ts` (sale en el cron diario /internal/plataforma/prueba-avisos (vercel.json, 14:00 UTC)) |

### superadmin

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `superadmin.cfo.alerta` | cobranza | critica | superadmins de plataforma | ChartNoAxesCombined | `/superadmin/ejecutivo` | una por regla por mes | 31 d | conectado: `apps/api/src/routes/internal/superadmin-alertas-cfo.ts` |
| `superadmin.agente.fallo` | agentes | critica | superadmins de plataforma | Bot | `/superadmin/agentes` | una por agente por dia | 7 d | conectado: `apps/api/src/agentes/corridas.ts` (una corrida en `fallo` de un agente marcado `vivo` en `core.agent_definition`; los crons ya avisan con `superadmin.cron.fallo`) |
| `superadmin.cron.fallo` | salud | critica | superadmins de plataforma | ServerCrash | `/superadmin/resumen` | una por cron por dia | 7 d | conectado: `apps/api/src/salud/with-heartbeat.ts` |
| `superadmin.salud.cron_sin_latido` | salud | critica | superadmins de plataforma | ServerCrash | `/superadmin/salud` | una por dia | 7 d | conectado: `apps/api/src/salud/alerta-crons-sin-latido.ts` (la emite el cron diario /internal/superadmin/resumen-diario cuando algun cron de cadencia <= 15 min no tiene ningun latido) |
| `superadmin.costo.ia_umbral` | cobranza | atencion | superadmins de plataforma | Gauge | `/superadmin/consumo-ia` | una por umbral (80, 100) por mes | 31 d | conectado: `apps/api/src/production/llm-usage-gateway-adapters.ts` emite el umbral 100 (tope mensual agotado, de organizacion o de plataforma) y, con la migracion 0047 aplicada, el umbral 80 (clave `org:<organizacion>:80:<mes>` y `plataforma:80:<mes>`; sin la migracion la reserva no devuelve el uso acumulado y el aviso de 80 % no se emite) |
| `superadmin.copiloto.tope_mensual` | cobranza | atencion | superadmins de plataforma | Gauge | `/superadmin/consumo-ia` | una por umbral (80, 100) por mes | 31 d | conectado: `apps/api/src/routes/superadmin-copiloto.ts` emite el umbral 80 y el 100 cuando el gasto del mes del Copiloto (bitacora y acumulador de la instancia) los alcanza; clave `<umbral>:<mes>` |
| `superadmin.copiloto.accion_propuesta` | aprobaciones | atencion | superadmins de plataforma | UserRoundCheck | `/superadmin/acciones` | una por propuesta (clave = id del intent o nonce de la propuesta) | 1 d | conectado: `apps/api/src/routes/superadmin-copiloto.ts` se emite al crear la propuesta con `proponer_accion` (apps/api/src/superadmin-copiloto/acciones.ts); sin PII: solo el tipo de aviso |
| `superadmin.llm.fallback_alto` | salud | atencion | superadmins de plataforma | Shuffle | `/superadmin/consumo-ia` | una por hora | 3 d | conectado: `apps/api/src/production/llm-usage-gateway-adapters.ts` (mas del 5 % de las llamadas de la hora, con al menos 20, cayo a un modelo de respaldo; requiere la migracion 0047) |
| `superadmin.llm.modelo_caido` | salud | critica | superadmins de plataforma | TriangleAlert | `/superadmin/salud` | una por modelo por dia | 7 d | conectado: `apps/api/src/production/llm-gateway.ts` (cuando el circuit breaker de un modelo pasa a abierto) |
| `superadmin.organizacion.onboarding_listo` | onboarding | info | superadmins de plataforma | CircleCheckBig | `/superadmin/organizaciones/{entidadId}` | una por organizacion, para siempre (marcador persistente `core.org_onboarding_aviso`) | 30 d | conectado: `apps/api/src/routes/internal/superadmin-mantenimiento.ts` (el cron de mantenimiento llama a core.avisar_organizaciones_listas_for_system (0052), que marca el marcador persistente y devuelve las organizaciones a avisar, y emite una notificacion por cada una en la misma transaccion; nunca desde un GET; solo cuando TODOS los pasos del checklist estan `hecho`: uno `pendiente` o `no_se_pudo_medir` lo impide) |
| `superadmin.organizacion.accion_pendiente` | aprobaciones | atencion | superadmins de plataforma | UserRoundCheck | `/superadmin/organizaciones?tab=gestion` | una por solicitud | 2 d | conectado: `apps/api/src/routes/superadmin-organizaciones.ts` |
| `superadmin.organizacion.miembro_aceptado` | onboarding | info | superadmins de plataforma | UserRoundCheck | `/superadmin/organizaciones/{entidadId}` | una por invitacion | 14 d | conectado: `apps/api/src/routes/superadmin-organizaciones-equipo.ts` (POST /auth/accept-invite llama a core.superadmin_invite_acceptance_for_system (0053, solo sistema) y emite en su propia transaccion; solo para invitaciones creadas por un superadmin) |
| `superadmin.plan.mensajes_80` | cobranza | atencion | superadmins de plataforma | Gauge | `/superadmin/planes` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |
| `superadmin.plan.mensajes_excedido` | cobranza | atencion | superadmins de plataforma | Gauge | `/superadmin/planes` | una por organizacion por mes | 10 d | conectado: `apps/api/src/plan-topes/medidor.ts` (solo mide el WhatsApp saliente de citas, hoteles y restaurantes) |


## Campana y página

Idénticas a Likida (`admin/notificaciones.tsx`, `dashboard/notificaciones/lista.tsx`), en las 7 consolas.

- **Campana** (`packages/ui/src/components/NotificationBell.tsx`): enlace a la página de notificaciones de la consola
  (`/<vertical>/<orgSlug>/notificaciones`, `/superadmin/notificaciones`), `h-8 w-8 rounded-lg` con borde, `Bell` de 14 px y
  un **punto rojo sin número** (`size-1.5`, `bg-destructive`, sin animación) cuando hay al menos una notificación sin leer.
  Se apaga al leerlas. Ya no abre un dropdown.
- **Sondeo** (`apps/web/src/lib/useNotifications.ts`): `GET /notifications/unread-count` cada 30 s; se pausa con la pestaña
  oculta y se refresca al mostrarse o recuperar el foco; tras fallos espera el doble (tope 5 min); un 401 lo detiene. No hay
  realtime en el backend. Cuando el sondeo ve subir el contador, anuncia el cambio y la página abierta recarga su lista.
- **Página** (`apps/web/src/components/NotificacionesPagina.tsx`, una sola para las 7 consolas): tarjetas con badge de
  severidad («Aviso», «Requiere atención», «Crítica»), categoría y hora relativa, «Resolver» a la pantalla de origen
  (solo si el enlace es una ruta interna; abrirlo marca el aviso como leído) y «Marcar leído»; «Marcar todas»; filtros
  «Sin leer»/«Todas» y por categoría (en el servidor); «Cargar más» por fecha; estados vacío, cargando y error con
  «Reintentar». Si el servidor rechaza marcar, la tarjeta y el punto de la campana se revierten y se avisa inline.
- **Leído**: estado por usuario en el servidor (`core.notification_read`), no localStorage como en Likida (sus alertas son un
  cálculo en vivo; aquí cada aviso es una fila real).
- **Sin migrar**: la lectura cae a las funciones de 0013 (ver Modelo); en esa base las filas no traen categoría, severidad ni
  enlace, así que la página las muestra como «Aviso» sin «Resolver».

## Entrega de WhatsApp de restaurantes

Tres eventos (`restaurantes.whatsapp.entrega_fallida_pedido`, `restaurantes.whatsapp.entrega_fallida` y `restaurantes.whatsapp.entregas_fallidas_varias`) los emite
`apps/api/src/routes/verticals/restaurantes/whatsapp.ts` cuando Meta reporta `failed` por el webhook (statuses). Dedupe por mensaje (clave = id del mensaje del
outbox); con mas de 5 fallos en una hora de la misma organizacion sale solo el aviso agrupado (una fila por destinatario y hora UTC). El texto lleva unicamente un
codigo de motivo o un conteo. Detalle de los motivos y del respaldo por correo en `docs/PLANTILLAS-WHATSAPP.md` ("Estados de entrega"). No se emite nada si la
base no tiene la migracion `066` (la emision y el registro del status degradan con SAVEPOINT).

## Estado

- **Parte A (backend)**: productor compartido, dedupe, RLS, leído por usuario, contador barato, API, catálogo y los
  productores marcados `conectado`.
- **NOTIF-C (eventos de ciclo de vida)**: el catálogo tiene 43 eventos, 39 con productor conectado y 4 pendientes (tras traer main, que sumó `despachos.pago_provisional.por_vencer` y los 4 avisos de citas de C-16; D-02 suma `despachos.conciliacion.sugerencias_pendientes`). Los que se agregaron
  (`despachos.fiscal.vencimiento_vencido`, `despachos.fiscal.vencimiento_escalado`,
  `restaurantes.onboarding.listo`, `restaurantes.voz.tasa_error_alta`, `hoteles.grupo.liberado`) y los que se conectaron salen
  del flujo real (post-commit o dentro de `emitirNotificacion`, que usa SAVEPOINT), con clave de dedupe y sin PII.
- **D-26/D-27/D-28 (crons de despachos)**: suma `despachos.cfdi.cancelado` (critica, owner/admin y contador, enlace al DETALLE del CFDI con el marcador
  `{entidadId}`, que `emitirNotificacion` sustituye por el `entidadId` de la emision) y conecta los productores de `despachos.efos.alerta`,
  `despachos.fiscal.vencimiento_proximo` y `despachos.fiscal.vencimiento_vencido` a los crons nuevos (`apps/api/src/routes/verticals/despachos/cron-sat.ts`).
- **D-13 (carga masiva de CFDI)**: suma `despachos.cfdi.lote_importado` (info, owner/admin y contador, enlace a la lista de CFDI), conectado en
  `apps/api/src/routes/verticals/despachos/cfdi-lote.ts`: una por peticion `POST .../cfdi/importar-lote` que ingiere al menos un CFDI o REP nuevo.
- **L-26/L-28 (cierre del expediente de licitaciones)**: suma 3 eventos conectados en `apps/api/src/routes/verticals/licitaciones/cierre.ts`:
  `licitaciones.expediente.aprobacion_pendiente` (se dio la 1/2 técnico-legal y falta la 2/2 económica, por otra persona),
  `licitaciones.expediente.aprobado` (2/2 completa) y `licitaciones.presentacion.declarada`. Los tres enlazan a la lista de
  convocatorias: el catálogo solo admite `{orgSlug}`, no el id de la convocatoria concreta.
- **L-25 (gate final de la sala de guerra)**: suma `licitaciones.sala_guerra.paquete_no_listo`, conectado en
  `apps/api/src/routes/verticals/licitaciones/salaGuerra.ts`: se emite cuando `GET .../sala-guerra/gate` detecta que faltan
  menos de 24 horas para el cierre, aun no se declaro la presentacion y el paquete no esta listo. Dedupe por convocatoria;
  el enlace va a la lista de convocatorias (el catalogo solo admite `{orgSlug}`).
- **L-30/L-32 (campana de licitaciones y re-tamizado KYC)**: suma 5 eventos conectados en
  `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts`: renovacion por vencer, factura de cobranza vencida, documentos de
  empresa por vencer (incluye la opinion 32-D cuando esta registrada), bases modificadas de una convocatoria ya versionada y
  proveedor de la cartera KYC que empeoro en la lista 69-B. Los tres primeros salen del barrido existente
  `/internal/licitaciones/alert-notifications`; el de bases, de la escritura que crea la version; el KYC, de
  `POST /internal/licitaciones/kyc-69b/retamizar` (migracion 034). Sin PII: solo conteos. Sin productor y por que:
  `licitaciones.fallo.publicado` (depende de un agregador comercial sin proveedor elegido). No se agrego ningun cron a `vercel.json`.
- **L-27 (post-adjudicacion de licitaciones)**: suma 3 eventos conectados en
  `apps/api/src/routes/verticals/licitaciones/avisos-campana.ts`: garantia de contrato por vencer (30 dias), garantia no entregada
  dentro de su plazo e hito vencido. Salen del barrido existente `/internal/licitaciones/alert-notifications` (migracion 035; sin ella
  no emiten). UN aviso por garantia o hito y fecha (clave = id + fecha), con enlace a la post-adjudicacion de la convocatoria
  (`{entidadId}` = id de la convocatoria) y sin PII: ningun monto, afianzadora ni titulo. No se agrego ningun cron a `vercel.json`.
- **Parte B**: la campana con punto rojo sin número (se apaga al leer) y la página de notificaciones en las 7 consolas.
- Los eventos `pendiente` son huecos declarados: la columna Productor dice qué falta. Siguen sin conectar y por lo tanto
  la página los mostrará vacíos hasta que su flujo origen emita.
