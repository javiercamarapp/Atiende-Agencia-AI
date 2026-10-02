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
| `restaurantes.handoff.solicitado` | agentes | atencion | owner/admin, staff | UserRoundCog | `/restaurantes/{orgSlug}/conversaciones` | una por conversacion derivada | 3 d | conectado: `packages/domain-restaurantes/src/conversaciones/postgres-repository.ts` (`PostgresHandoffAgentGate.solicitarHumano`: la toma abierta por el agente de WhatsApp real o por el widget de la demo) |
| `restaurantes.voz.llamada_escalada` | agentes | atencion | owner/admin, staff | PhoneCall | `/restaurantes/{orgSlug}/agente-voz` | una por llamada | 3 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-interno.ts` |
| `restaurantes.voz.proveedor_con_fallas` | salud | atencion | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/agente-voz` | una por sucursal por hora | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-interno.ts` |
| `restaurantes.callback.pendiente` | agentes | atencion | owner/admin, staff | PhoneCall | `/restaurantes/{orgSlug}/conversaciones` | una por solicitud de contacto (clave = id) | 3 d | conectado: `packages/domain-restaurantes/src/postgres-repository.ts` |
| `restaurantes.proveedor.falla` | salud | critica | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/configuracion` | una por proveedor por dia | 7 d | pendiente: requiere el estado de salud por proveedor del gateway (PR de OpenRouter/gateway) |
| `restaurantes.demo.tope_diario_alcanzado` | cierres | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/configuracion` | una por dia | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/demo-widget.ts` (el chat público de la demo llegó al tope diario de mensajes de la organización: tope de costo) |
| `restaurantes.costo.umbral_voz` | cierres | atencion | owner/admin | Gauge | `/restaurantes/{orgSlug}/agente-voz` | una por sucursal por dia | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-kpi.ts` |
| `restaurantes.onboarding.listo` | onboarding | info | owner/admin | CircleCheckBig | `/restaurantes/{orgSlug}/primeros-pasos` | una por organizacion | 30 d | conectado: `apps/api/src/routes/verticals/restaurantes/admin-onboarding.ts` |
| `restaurantes.voz.tasa_error_alta` | salud | atencion | owner/admin | TriangleAlert | `/restaurantes/{orgSlug}/agente-voz` | una por sucursal por dia | 2 d | conectado: `apps/api/src/routes/verticals/restaurantes/voz-kpi.ts` |

### hoteles

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `hoteles.ticket.sla_vencido` | operacion | atencion | owner/admin, gm, frontdesk | Clock | `/hoteles/{orgSlug}/tickets` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/tickets-sla-cron.ts` |
| `hoteles.aprobacion.expirada` | aprobaciones | atencion | owner/admin, gm, reservations | ShieldAlert | `/hoteles/{orgSlug}/aprobaciones` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/agentes-expiracion-cron.ts` |
| `hoteles.aprobacion.pendiente` | aprobaciones | atencion | owner/admin, gm, reservations | ShieldCheck | `/hoteles/{orgSlug}/aprobaciones` | una por solicitud | 3 d | conectado: `packages/domain-hoteles/src/agentes/postgres-repository.ts` |
| `hoteles.grupo.por_liberar` | cierres | atencion | owner/admin, gm, reservations | Users | `/hoteles/{orgSlug}/grupos` | una por propiedad por dia | 5 d | pendiente: cron grupos-liberacion: falta decidir el umbral de aviso con producto |
| `hoteles.night_audit.fallo` | cierres | critica | owner/admin, gm, accountant | MoonStar | `/hoteles/{orgSlug}/reservas` | una por propiedad por noche | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/night-audit.ts` |
| `hoteles.grupo.liberado` | cierres | atencion | owner/admin, gm, reservations | Users | `/hoteles/{orgSlug}/grupos` | una por propiedad por dia | 7 d | conectado: `apps/api/src/routes/verticals/hoteles/grupos-liberacion-cron.ts` |

### rentas

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `rentas.ical.sync_fallido` | salud | critica | owner/admin, admin_gestora, operador:acceso_total | RefreshCwOff | `/rentas/{orgSlug}/monitor-sync` | una por dia | 7 d | conectado: `apps/api/src/routes/verticals/rentas/ical-sync-cron.ts` |
| `rentas.reserva.nueva_ical` | operacion | info | owner/admin, admin_gestora, operador:acceso_total, operador:calendario_mensajeria | CalendarPlus | `/rentas/{orgSlug}/calendario` | una por corrida de sincronizacion y dia | 5 d | conectado: `apps/api/src/routes/verticals/rentas/ical-sync-cron.ts` |
| `rentas.conflicto.detectado` | operacion | critica | owner/admin, admin_gestora, operador:acceso_total | CalendarX | `/rentas/{orgSlug}/calendario` | una por dia | 7 d | conectado: `apps/api/src/routes/verticals/rentas/ical-sync-cron.ts` |
| `rentas.aprobacion.pendiente` | aprobaciones | atencion | owner/admin, admin_gestora, operador:calendario_mensajeria | MessageSquareWarning | `/rentas/{orgSlug}/aprobaciones` | una por mensaje | 3 d | conectado: `apps/api/src/routes/verticals/rentas/mensajeria-borradores.ts` |

### despachos

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `despachos.cobranza.recordatorios` | cobranza | atencion | owner/admin, contador | Receipt | `/despachos/{orgSlug}/cola-cobranza` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/despachos/notifications.ts` |
| `despachos.fiscal.vencimiento_proximo` | fiscal | atencion | owner/admin, contador | CalendarClock | `/despachos/{orgSlug}/vencimientos` | una por property por dia | 7 d | conectado: `packages/domain-despachos/src/vencimientos/procesos.ts` |
| `despachos.efos.alerta` | fiscal | critica | owner/admin, contador, auditor | ShieldAlert | `/despachos/{orgSlug}/cfdi` | una por CFDI ingerido (clave = id del CFDI) | 30 d | conectado: `apps/api/src/routes/verticals/despachos/cfdi.ts` |
| `despachos.fiscal.vencimiento_vencido` | fiscal | critica | owner/admin, contador | CalendarX | `/despachos/{orgSlug}/vencimientos` | una por property por dia | 14 d | conectado: `packages/domain-despachos/src/vencimientos/procesos.ts` |
| `despachos.fiscal.vencimiento_escalado` | fiscal | atencion | owner/admin, contador | ArrowUpFromLine | `/despachos/{orgSlug}/vencimientos` | una por vencimiento y nivel | 14 d | conectado: `apps/api/src/routes/verticals/despachos/vencimientos.ts` |
| `despachos.rep.incoherente` | fiscal | atencion | owner/admin, contador, auditor | FileWarning | `/despachos/{orgSlug}/cfdi` | una por complemento de pago guardado (clave = property + folio fiscal del REP) | 14 d | pendiente: el analisis de REP (POST .../cfdi/rep/analizar) no guarda nada y lo pueden llamar roles de solo lectura: emitir ahi llenaria la campana con XML arbitrario; se conecta cuando el REP se persista |

### licitaciones

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `licitaciones.plazo.por_vencer` | operacion | atencion | owner/admin, analyst, writer, reviewer | Hourglass | `/licitaciones/{orgSlug}/seguimiento` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/discover.ts` |
| `licitaciones.convocatoria.nueva` | operacion | info | owner/admin, analyst | FilePlus2 | `/licitaciones/{orgSlug}/convocatorias` | una por organizacion por dia | 7 d | conectado: `apps/api/src/routes/verticals/licitaciones/discover.ts` |
| `licitaciones.fallo.publicado` | cierres | atencion | owner/admin, analyst, reviewer | Gavel | `/licitaciones/{orgSlug}/seguimiento` | una por convocatoria | 30 d | pendiente: requiere el detector de fallo en la fuente (depende de un agregador comercial sin proveedor elegido) |

### citas

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `citas.cita.nueva` | operacion | info | owner/admin, staff | CalendarPlus | `/citas/{orgSlug}/agenda` | una por cita | 7 d | conectado: `packages/domain-citas/src/postgres-repository.ts` |
| `citas.cita.cancelada` | operacion | atencion | owner/admin, staff | CalendarX | `/citas/{orgSlug}/agenda` | una por cita cancelada | 7 d | conectado: `packages/domain-citas/src/postgres-repository.ts` |
| `citas.recordatorio.fallido` | salud | atencion | owner/admin | BellOff | `/citas/{orgSlug}/mensajes-whatsapp` | una por dia | 5 d | conectado: `apps/api/src/routes/verticals/citas/reminders.ts` |

### superadmin

| Evento | Categoría | Severidad | Destinatarios | Ícono | Enlace | Dedupe | Vigencia | Productor |
|---|---|---|---|---|---|---|---|---|
| `superadmin.cfo.alerta` | cobranza | critica | superadmins de plataforma | ChartNoAxesCombined | `/superadmin/cfo` | una por regla por mes | 31 d | conectado: `apps/api/src/routes/internal/superadmin-alertas-cfo.ts` |
| `superadmin.cron.fallo` | salud | critica | superadmins de plataforma | ServerCrash | `/superadmin/resumen` | una por cron por dia | 7 d | conectado: `apps/api/src/salud/with-heartbeat.ts` |
| `superadmin.costo.ia_umbral` | cobranza | atencion | superadmins de plataforma | Gauge | `/superadmin/gasto-api` | una por umbral (80, 100) por mes | 31 d | conectado: `apps/api/src/production/llm-usage-gateway-adapters.ts` emite el umbral 100 (tope mensual agotado, de organizacion o de plataforma); el aviso de 80 % queda pendiente: el guard no devuelve el uso acumulado y falta una funcion SQL de solo lectura que lo calcule |
| `superadmin.llm.modelo_caido` | salud | critica | superadmins de plataforma | TriangleAlert | `/superadmin/salud` | una por modelo por dia | 7 d | conectado: `apps/api/src/production/llm-gateway.ts` (cuando el circuit breaker de un modelo pasa a abierto) |
| `superadmin.organizacion.accion_pendiente` | aprobaciones | atencion | superadmins de plataforma | UserRoundCheck | `/superadmin/gestion-organizaciones` | una por solicitud | 2 d | conectado: `apps/api/src/routes/superadmin-organizaciones.ts` |


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

## Estado

- **Parte A (backend)**: productor compartido, dedupe, RLS, leído por usuario, contador barato, API, catálogo y los
  productores marcados `conectado`.
- **NOTIF-C (eventos de ciclo de vida)**: el catálogo tiene 37 eventos, 33 con productor conectado y 4 pendientes. Los que se agregaron
  (`despachos.fiscal.vencimiento_vencido`, `despachos.fiscal.vencimiento_escalado`,
  `restaurantes.onboarding.listo`, `restaurantes.voz.tasa_error_alta`, `hoteles.grupo.liberado`) y los que se conectaron salen
  del flujo real (post-commit o dentro de `emitirNotificacion`, que usa SAVEPOINT), con clave de dedupe y sin PII.
- **Parte B**: la campana con punto rojo sin número (se apaga al leer) y la página de notificaciones en las 7 consolas.
- Los eventos `pendiente` son huecos declarados: la columna Productor dice qué falta. Siguen sin conectar y por lo tanto
  la página los mostrará vacíos hasta que su flujo origen emita.
