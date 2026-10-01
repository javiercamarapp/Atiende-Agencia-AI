# Notificaciones in-app

Campana y página de notificaciones del panel de cada vertical y de superadmin. Este documento describe el modelo
(parte A, backend) y el **catálogo de eventos**. La campana con punto rojo y la página idéntica a Likida son la
parte B (ver "Estado").

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
- **Lectura**: `GET /notifications` (filtros `limit`, `before`, `unread=1`, `categoria`), `POST /notifications/:id/read`,
  `POST /notifications/read-all`. El contador de no leídas se calcula en SQL con el índice
  `(staff_user_id, created_at)`, sin N+1.
- **Compatibilidad con la base sin migrar**: la lectura cae a las funciones de 0013 y los productores devuelven
  `no_disponible`, ambos dentro de un `SAVEPOINT` (la transacción del request no queda abortada). Una emisión nunca
  rompe el flujo de negocio que la invoca.

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
| `restaurantes.pedido.nuevo` | operacion | info | owner/admin, staff | ShoppingBag | `/restaurantes/{orgSlug}/pedidos` | un aviso por pedido (clave = id del pedido) | 7 d | pendiente: alta de pedidos por checkout publico sin sesion de staff: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `restaurantes.handoff.solicitado` | agentes | atencion | owner/admin, staff | UserRoundCog | `/restaurantes/{orgSlug}/conversaciones` | una por conversacion derivada | 3 d | pendiente: handoff de conversaciones de WhatsApp/voz: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `restaurantes.voz.llamada_escalada` | agentes | atencion | owner/admin, staff | PhoneCall | `/restaurantes/{orgSlug}/agente-voz` | una por llamada | 3 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-interno.ts` |
| `restaurantes.voz.proveedor_con_fallas` | salud | atencion | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/agente-voz` | una por sucursal por hora | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-interno.ts` |
| `restaurantes.callback.pendiente` | agentes | atencion | owner/admin, staff | PhoneCall | `/restaurantes/{orgSlug}/conversaciones` | una por dia | 2 d | pendiente: estado de callbacks del agente de voz: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `restaurantes.proveedor.falla` | salud | critica | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/configuracion` | una por proveedor por dia | 7 d | pendiente: requiere el estado de salud por proveedor del gateway (PR de OpenRouter/gateway) |
| `restaurantes.costo.umbral_voz` | cierres | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/agente-voz` | una por umbral (80, 100) por mes | 31 d | pendiente: alertas de costo de voz (migracion 035) aun no escriben core.notification |

### hoteles

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `hoteles.ticket.sla_vencido` | operacion | atencion | owner/admin, gm, frontdesk | Clock | `/hoteles/{orgSlug}/tickets` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/tickets-sla-cron.ts` |
| `hoteles.aprobacion.expirada` | aprobaciones | atencion | owner/admin, gm, reservations | ShieldAlert | `/hoteles/{orgSlug}/aprobaciones` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/agentes-expiracion-cron.ts` |
| `hoteles.aprobacion.pendiente` | aprobaciones | atencion | owner/admin, gm, reservations | ShieldCheck | `/hoteles/{orgSlug}/aprobaciones` | una por solicitud | 3 d | pendiente: cola de aprobaciones del agente de reservas: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `hoteles.grupo.por_liberar` | cierres | atencion | owner/admin, gm, reservations | Users | `/hoteles/{orgSlug}/grupos` | una por propiedad por dia | 5 d | pendiente: cron grupos-liberacion: falta decidir el umbral de aviso con producto |
| `hoteles.night_audit.fallo` | cierres | critica | owner/admin, gm, accountant | MoonStar | `/hoteles/{orgSlug}/reservas` | una por propiedad por noche | 7 d | pendiente: night-audit corre en el worker: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |

### rentas

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `rentas.ical.sync_fallido` | salud | critica | owner/admin, admin_gestora, operador:acceso_total | RefreshCwOff | `/rentas/{orgSlug}/monitor-sync` | una por dia | 7 d | pendiente: cron ical-sync de rentas: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `rentas.reserva.nueva_ical` | operacion | info | owner/admin, admin_gestora, operador:acceso_total, operador:calendario_mensajeria | CalendarPlus | `/rentas/{orgSlug}/calendario` | una por corrida de sincronizacion y dia | 5 d | pendiente: importacion iCal: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `rentas.conflicto.detectado` | operacion | critica | owner/admin, admin_gestora, operador:acceso_total | CalendarX | `/rentas/{orgSlug}/calendario` | una por dia | 7 d | pendiente: deteccion de conflictos de calendario: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `rentas.aprobacion.pendiente` | aprobaciones | atencion | owner/admin, admin_gestora, operador:calendario_mensajeria | MessageSquareWarning | `/rentas/{orgSlug}/aprobaciones` | una por mensaje | 3 d | pendiente: cola de mensajeria con aprobacion humana: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |

### despachos

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `despachos.cobranza.recordatorios` | cobranza | atencion | owner/admin, contador | Receipt | `/despachos/{orgSlug}/cola-cobranza` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/despachos/notifications.ts` |
| `despachos.fiscal.vencimiento_proximo` | fiscal | atencion | owner/admin, contador | CalendarClock | `/despachos/{orgSlug}/vencimientos` | una por dia | 7 d | pendiente: calendario fiscal de vencimientos: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `despachos.efos.alerta` | fiscal | critica | owner/admin, contador, auditor | ShieldAlert | `/despachos/{orgSlug}/cfdi` | una por hallazgo | 30 d | pendiente: ingesta EFOS 69-B del worker: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |

### licitaciones

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `licitaciones.plazo.por_vencer` | operacion | atencion | owner/admin, analyst, writer, reviewer | Hourglass | `/licitaciones/{orgSlug}/seguimiento` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/discover.ts` |
| `licitaciones.convocatoria.nueva` | operacion | info | owner/admin, analyst | FilePlus2 | `/licitaciones/{orgSlug}/convocatorias` | una por dia | 7 d | pendiente: descubrimiento de convocatorias y alertas por perfil: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `licitaciones.fallo.publicado` | cierres | atencion | owner/admin, analyst, reviewer | Gavel | `/licitaciones/{orgSlug}/seguimiento` | una por convocatoria | 30 d | pendiente: requiere el detector de fallo en la fuente (depende de un agregador comercial sin proveedor elegido) |

### citas

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `citas.cita.nueva` | operacion | info | owner/admin, staff | CalendarPlus | `/citas/{orgSlug}/agenda` | una por cita | 7 d | pendiente: alta de citas por agenda publica/WhatsApp: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `citas.cita.cancelada` | operacion | atencion | owner/admin, staff | CalendarX | `/citas/{orgSlug}/agenda` | una por cita cancelada | 7 d | pendiente: cancelacion de citas con lista de espera: no se conecta en este PR (parte A); queda como siguiente paso en el flujo origen |
| `citas.recordatorio.fallido` | salud | atencion | owner/admin | BellOff | `/citas/{orgSlug}/mensajes-whatsapp` | una por dia | 5 d | pendiente: requiere el conteo de recordatorios agotados por reintentos (outbox de correo/WhatsApp) |

### superadmin

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `superadmin.cfo.alerta` | cobranza | critica | superadmins de plataforma | ChartNoAxesCombined | `/superadmin/cfo` | una por regla por mes | 31 d | conectado: `apps/api/src/routes/internal/superadmin-alertas-cfo.ts` |
| `superadmin.cron.fallo` | salud | critica | superadmins de plataforma | ServerCrash | `/superadmin/resumen` | una por cron por dia | 7 d | conectado: `apps/api/src/salud/with-heartbeat.ts` |
| `superadmin.costo.ia_umbral` | cobranza | atencion | superadmins de plataforma | Gauge | `/superadmin/gasto-api` | una por umbral (80, 100) por mes | 31 d | conectado: `apps/api/src/production/llm-usage-gateway-adapters.ts` emite el umbral 100 (tope mensual agotado, de organizacion o de plataforma); el aviso de 80 % queda pendiente: el guard no devuelve el uso acumulado y falta una funcion SQL de solo lectura que lo calcule |
| `superadmin.llm.modelo_caido` | salud | critica | superadmins de plataforma | TriangleAlert | `/superadmin/salud` | una por modelo por dia | 7 d | conectado: `apps/api/src/production/llm-gateway.ts` (cuando el circuit breaker de un modelo pasa a abierto) |
| `superadmin.organizacion.accion_pendiente` | aprobaciones | atencion | superadmins de plataforma | UserRoundCheck | `/superadmin/gestion-organizaciones` | una por solicitud | 2 d | pendiente: doble control de gestion de organizaciones (0038): falta emitir al solicitar |


## Estado

- **Parte A (este documento, backend)**: productor compartido, dedupe, RLS, leído por usuario, contador barato,
  API, catálogo y los productores marcados `conectado`.
- **Parte B (pendiente, segundo PR)**: la campana con punto rojo sin número (se apaga al leer) y la página de
  notificaciones idéntica a Likida en las 7 consolas. Hoy `NotificationBell` sigue mostrando el número.
- Los eventos `pendiente` son huecos declarados: la columna Productor dice qué falta.
