# Vertical: restaurantes (api)

Fase 1 construida: `public.ts` (`POST /v1/restaurantes/:orgSlug/orders`,
`POST /v1/restaurantes/:orgSlug/customers/lookup` — sin `authMiddleware`, canales
públicos/de sistema, ver diseño Fase 1 §3) y `whatsapp.ts`
(`GET|POST /v1/restaurantes/whatsapp/webhook`, verificación HMAC sobre bytes crudos).

**Problema conocido (verificado contra Postgres real, 19-sep-2026, arreglo en
curso en otra rama — ver `scripts/verify-restaurantes-sql/README.md`):** la
policy de SELECT de `core.property` nunca contempló la sesión de sistema
(`auth.uid()` NULL) que usan estas rutas públicas — `findBranch()`
(`postgres-repository.ts`, usada por `orders.ts::prepareCreateOrder`) hace
JOIN contra `core.property` y devuelve `null` siempre bajo esa sesión. Efecto
real: `POST /v1/restaurantes/:orgSlug/orders` (web, voz y WhatsApp por igual)
falla con "Sucursal no encontrada" contra Postgres real, para cualquier
organización. Invisible para los tests de este repo (corren contra el
repositorio en memoria, que nunca aplica RLS real).

Fase 3 agregó las primeras rutas de staff autenticado: `admin-kpis.ts` (dashboards de
KPIs — ver `restaurantes-admin-kpis.spec.ts`).

Fase 5 agrega el back-office CORE (CRUD real, con `authMiddleware` +
`requirePropertyMembership` + `assertVerticalRole(MANAGER_ROLES)`, mismo patrón que
`admin-kpis.ts`):

- `admin-catalog.ts` — categorías (`GET/POST .../admin/categories`,
  `PATCH .../admin/categories/:categoryId`) y productos (`GET/POST
  .../admin/products`, `PATCH .../admin/products/:productId`,
  `PATCH .../admin/products/:productId/branch-availability` — la única forma real de
  activar/desactivar+fijar precio de un producto EN una sucursal).
- `admin-branches.ts` — ficha de sucursal (`GET .../admin/sucursales`,
  `GET/PATCH .../admin/sucursales/:branchId`). Deliberadamente SIN crear sucursal ni
  activar/desactivarla: eso requiere escribir `core.property` (compartida por todas
  las verticales), cuyo GRANT de escritura hoy es exclusivo de `service_role` — ver
  el comentario de cabecera de ese archivo y de
  `packages/domain-restaurantes/migrations/007_admin_backoffice_grants_and_policies.sql`.
- `admin-orders.ts` — pedidos en operación + historial (mismo endpoint de listado,
  `GET .../admin/orders`, filtrable por status/sucursal/rango de fechas y paginado
  por cursor) y cambio de estado real (`PATCH
  .../admin/orders/:orderId/status`, validado por la máquina de estados de
  `@atiende/domain-restaurantes::order-lifecycle.ts`).
- `admin-customers.ts` — listado/búsqueda (`GET .../admin/customers`) y ficha
  (`GET .../admin/customers/:customerId`, mismo shape que `lookupCustomer`).

Cuentas/accesos de staff, notificaciones, promociones/marketing, panel de
superadmin, "pregunta a tus datos" y configuración del agente de voz/WhatsApp
quedan explícitamente fuera de esta fase — ver el brief de Fase 5.

Fase 8 agrega la superficie real del rol `repartidor` (ver
`domain-restaurantes/src/roles.ts::REPARTIDOR_ROLES` — hasta esta fase el rol
existía en el enum pero `assertVerticalRole(MANAGER_ROLES)` lo excluía de TODA
ruta de este vertical por diseño, sin ninguna alternativa):

- `repartidor-orders.ts` — acotado a SUS PROPIOS pedidos asignados, nunca
  gestión: `GET .../repartidor/orders` (lista, sin paginación — ver comentario
  de `listOrdersForRepartidor`), `GET .../repartidor/orders/:orderId` (ficha,
  404 uniforme si el pedido no existe o no es suyo — nunca distingue ambos
  casos), `PATCH .../repartidor/orders/:orderId/status` (solo
  en_camino/entregado/problema, vía
  `@atiende/domain-restaurantes::order-lifecycle.ts::changeAssignedOrderStatus`
  — `incidentNote` obligatorio si y solo si el nuevo estado es "problema").
  Usa `assertVerticalRole(c, REPARTIDOR_ROLES)`, nunca `MANAGER_ROLES`.
- `admin-orders.ts` — se agrega `PATCH
  .../admin/orders/:orderId/assign-repartidor` (MANAGER_ROLES): el ÚNICO
  lugar que despacha un pedido (escribe `assigned_repartidor_id`/
  `estimated_delivery_at`), validando que `repartidorId` sea staff real de
  esta organización con `verticalRole === "repartidor"` antes de escribir.
  `serializeOrder` ahora también expone `assignedRepartidorId`/
  `estimatedDeliveryAt`/`incidentNote` en las vistas de operación/historial
  existentes.

Pendiente, fuera de alcance de esta fase (documentado, no fingido): alta de
cuentas de repartidor (el origen lo resuelve con la Edge Function
`crear-repartidor` + `repartidor_perfil` — fusion no tiene TODAVÍA un mecanismo
genérico de invitación/alta de staff para NINGÚN rol de NINGUNA vertical, no es
un hueco específico de restaurantes) y el panel visual completo del origen
(RepartidorDashboard.tsx: stats del día, perfil con datos operativos del
repartidor, centro de ayuda, nav móvil) — `apps/web` sí agrega una página
mínima y real (`RepartidorPedidosPage`, ver `apps/web/src/verticals/
restaurantes/README.md` si existe o `pages/Repartidor.tsx`) para no dejar el
endpoint sin ningún consumidor de UI, pero no reconstruye esa riqueza visual.

Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
no tiene UI: el panel de repartidor siempre estará vacío"): `assign-repartidor`
(Fase 8) era el ÚNICO lugar que despacha un pedido, pero no existía ni un
endpoint para listar QUÉ staff tiene `verticalRole === "repartidor"` ni un
selector real en `Pedidos.tsx` que lo consumiera. Se agrega:

- `admin-staff.ts` — `GET .../admin/staff/repartidores` (`MANAGER_ROLES`, no
  `STAFF_INVITE_ROLES`: un manager "staff" despacha pedidos día a día y
  necesita este selector aunque no pueda invitar). Lista miembros YA
  ACEPTADOS (`core.membership`) con `verticalRole === "repartidor"` — nunca
  invitaciones pendientes, que `GET .../admin/staff/invitaciones` ya cubre.
- Gap real de RLS descubierto y corregido de paso (verificado contra Postgres,
  nunca contra los tests que usan el repo en memoria sin RLS): la validación
  de `assign-repartidor` corría en la sesión de SISTEMA de `coreRepo`
  (`auth.uid()` siempre null), contra una tabla cuya policy de SELECT exige
  `user_id = auth.uid()` — esa validación era SIEMPRE falsa en producción
  real, así que el dispatch nunca lograba completarse. Ambos endpoints ahora
  comparten `deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(...)`
  (sesión REAL por-request) sobre la función `security definer`
  `core.list_org_members_by_vertical_role` (ver
  `packages/db/migrations/0004_list_org_members_by_vertical_role.sql`).
- `apps/web` — `Pedidos.tsx` agrega un `<select>` real por pedido (dispara el
  PATCH en cuanto se elige un repartidor) alimentado por
  `lib/staff-client.ts::fetchRepartidores` — sin endpoint de "desasignar" en
  el backend, elegir "Sin asignar" es deliberadamente un no-op.

FASE 3 (producto) — bitácora de auditoría del staff (copiada del patrón ya en
`main` para rentas, `021_rentas_audit_log.sql`/`022_..._orden_determinista.sql`,
PR #165/#173 — ver `packages/domain-restaurantes/migrations/
019_restaurantes_audit_log.sql` para el diseño completo, incluida la validación
de rol que rentas dejó pendiente):

- `auditoria.ts` — `GET .../admin/auditoria` (paginado, filtro `tipo`/`desde`/
  `hasta`), solo `owner`/`admin` de la organización (más estricto que
  `MANAGER_ROLES`: un `staff` real SÍ puede escribir en la bitácora vía las
  rutas de abajo, pero no leerla).
- Instrumentado (`registrarAuditoria`, best-effort, nunca revierte la acción de
  negocio si la bitácora falla — ver el SAVEPOINT en
  `PostgresRestaurantesRepository.registrarAuditoria`): `admin-catalog.ts`
  (precio/disponibilidad de producto, `entityType="producto"`),
  `admin-promotions.ts` (alta/cambio/activación/baja, `entityType="promocion"`),
  `admin-orders.ts` (cancelación de pedido `entityType="pedido"`; asignación/
  reasignación de repartidor `entityType="repartidor"`), `admin-staff.ts`
  (invitación/revocación/cambio de rol/**baja de un staff ya aceptado**,
  `entityType="staff"`), `admin-config.ts` (**configuración de WhatsApp/zonas
  conocidas**, `entityType="configuracion"` — nuevo, ver abajo).

FASE 3 (producto) — cierre de 2 de los 3 huecos que la ronda anterior dejaba
documentados aquí mismo:

- **Baja de staff ya aceptado**: `admin-staff.ts::DELETE .../admin/staff/
  miembros/:userId`, mismo umbral que el `PATCH` de cambio de rol
  (`STAFF_INVITE_ROLES` + jerarquía real de `canInviteStaff`). Autoridad real
  en `core.remove_membership` (`security definer`, genérico de `core` — ver
  `packages/db/migrations/0024_remove_membership.sql`): bloquea auto-baja
  SIEMPRE, y el caso límite "no dejar la organización sin ningún owner"
  (demostrado por exhaustividad en
  `scripts/verify-restaurantes-config-staff-baja/README.md` — con la
  combinación "nunca auto-baja" + "solo un owner toca a otro owner", esa
  invariante se sostiene incluso sin necesitar disparar jamás el chequeo
  explícito de conteo).
- **Configuración de WhatsApp/zonas conocidas editable**: `admin-config.ts`
  (nuevo) — `GET`/`PUT .../admin/config/whatsapp` (conecta/rota el
  `phone_number_id`) y `GET`/`POST`/`DELETE .../admin/config/zonas` (alta/baja
  de zonas conocidas para `nearest_branch_by_colonia`). Ambas tablas
  (`restaurantes.whatsapp_channel_config`/`restaurantes.known_zone`) YA
  EXISTÍAN desde Fase 1/2 sin ninguna ruta de escritura — ver
  `packages/domain-restaurantes/migrations/
  021_restaurantes_config_editable_y_search_path_fix.sql`. Solo owner/admin
  (`STAFF_INVITE_ROLES`), tanto en la policy RLS (SQL, autoridad real) como en
  `assertVerticalRole` (TS, defensa en profundidad) — deliberadamente MÁS
  angosto que `MANAGER_ROLES`.
- Hueco conocido que SIGUE abierto (deliberado, no inventado sin dirección de
  producto): horarios de atención editables — hoy NO existe ninguna
  tabla/columna de horarios en el schema base de restaurantes (verificado
  antes de escribir la migración de esta fase). Construirlo exige una decisión
  de producto real (¿por organización o por sucursal? ¿excepciones, como
  `citas`?) fuera del alcance de "conectar lo ya construido" de esta fase.
  Configuración de voz tampoco tiene tabla (a diferencia de hoteles/citas),
  mismo criterio.

## Voz propia (migración 025)

- `voz-admin.ts` (panel, owner/admin, por sucursal `:propertyId`): `GET .../admin/voz/catalogo`,
  `GET|PUT .../admin/voz/config`, `POST .../admin/voz/preview/sesion`,
  `GET .../admin/voz/conversaciones[/:id]`. Base sin migrar: lecturas -> `disponible: false`,
  escrituras y preview -> 503. Sin `GEMINI_API_KEY` / `VOICE_PREVIEW_TOKEN_SECRET`: 503 "voz no
  configurada", nunca un falso éxito.
- `voz-interno.ts` (sistema, header `x-atiende-internal-secret`): `POST /internal/restaurantes/voz/
  conversaciones[/:id/turnos|/:id/cerrar]` y `.../previews/consumir`. Lo consumirá el servicio de
  voz (otra tarea); escribe por funciones SQL de solo-sistema.
- Contrato `VoiceAgentProvider` (emitirSesionPreview / catalogoVoces / salud) en
  `packages/domain-restaurantes/src/voz/`: adaptador Gemini 3.8 Live y adaptador falso.

## Privacidad (PM PR-9, migración 030)

- `privacidad.ts` -- panel (owner/admin, sobre `:propertyId`): `GET .../admin/privacidad/solicitudes`,
  `GET .../solicitudes/:id/eventos`, `PATCH .../solicitudes/:id/estado`, `GET|PUT .../admin/privacidad/configuracion`.
- `privacidad-interno.ts` -- lado sistema (secreto interno): `GET|POST /internal/restaurantes/privacidad-retencion`
  (purga por retención; NO está en `vercel.json`, programarlo es una decisión de despliegue),
  `POST /internal/restaurantes/voz/privacidad/apertura`, `.../voz/conversaciones/:id/consentimiento-grabacion`,
  `POST /internal/restaurantes/voz/arco`.
- Base sin migrar: lecturas con `disponible:false`, escrituras 503; nunca 500.

## Pedidos programados (R-11, migración 034)

- Alta: `POST /v1/restaurantes/:orgSlug/orders` acepta `programado_para` (ISO 8601 CON zona). El pedido nace en
  estado `programado` (fuera de cocina y sin comanda al POS; los KPIs de la 006 no filtran por estado, así que el pedido cuenta en ingresos y conteo desde su creación, como cualquier pedido, incluidos los cancelados). Se rechaza (400) una hora sin zona, a
  menos de 30 minutos, a más de 7 días o fuera del horario de la sucursal evaluado en SU zona horaria
  (incluye cruces de medianoche y puentes). Contra la base sin migrar responde 503 y no crea nada.
- Panel (owner/admin): `GET .../admin/scheduled-orders` (pestaña Programados) y `GET .../admin/orders`
  (sin filtro de estado, `pending` o `programado`) PROMUEVEN a `pending` los programados cuya hora cae dentro
  de la anticipación (30 min) o ya pasó. Idempotente; un pedido cancelado nunca se promueve. Un fallo al
  promover se registra y no rompe el listado. Base sin migrar: `disponible:false` y lista vacía.
- Interno: `GET|POST /internal/restaurantes/promover-programados` (secreto interno o `Authorization: Bearer
  <CRON_SECRET>`) barre TODAS las organizaciones. NO está en `vercel.json` (decisión de costo: sin crons nuevos);
  programarlo desde un scheduler externo es una decisión de despliegue. Respuesta: `{ ok, status: "ok" |
  "not_available", promoted, orderIds }`.
- Pendiente conocido: la comanda al POS (SoftRestaurant) no se encola al promover (hoy se omite al crear un
  programado); la captura manual de la comanda sigue disponible.

## Cierre del día y resumen semanal (R-42, migración 041)

- Panel (owner/admin, `cierres.ts`): `GET /v1/restaurantes/:propertyId/admin/cierres?tipo=dia|semana&limite=N` devuelve los cierres ya
  generados y los periodos terminados que aún no tienen cierre (`pendientes`); `POST .../admin/cierres/generar` `{ tipo, fecha }` genera el
  de un periodo TERMINADO (dia = día calendario en la zona horaria de la sucursal; semana = lunes a domingo, se manda el lunes). Hoy y la
  semana en curso se rechazan (400). Idempotente por fecha de negocio: repetir devuelve el mismo cierre (`estado: "existente"`, 200); uno
  nuevo es 201, deja rastro en la bitácora (`cierre.dia_generado` / `cierre.semana_generada`) y avisa en la campana
  (`restaurantes.cierre.dia_listo` / `semana_lista`, sin PII). Un cierre generado NO se recalcula.
- Interno (`cierres-interno.ts`): `GET|POST /internal/restaurantes/cierres-dia?dias=N` (1..14, por defecto 3; secreto interno o
  `Authorization: Bearer <CRON_SECRET>`) asegura el cierre de los últimos N días cerrados (y, por cada domingo cerrado, la semana) de TODAS las
  sucursales de organizaciones reales; omite los periodos sin pedidos; una transacción por sucursal (una que falle se reporta en `fallos` y no frena
  a las demás). NO está en `vercel.json` (decisión de costo: sin crons nuevos): agendarlo es una decisión de despliegue; mientras tanto el
  botón del panel genera los cierres. Respuesta: `{ ok, status: "ok" | "not_available", sucursales, creados, existentes, sinActividad, avisos, fallos }`.
- Base sin migrar: la lectura responde `disponible: false` con listas vacías, la escritura 503 y el barrido `not_available` (SAVEPOINT en el
  repositorio; `packages/domain-restaurantes/tests/cierres-savepoint.spec.ts`). SQL y permisos verificados contra Postgres real en
  `scripts/verify-restaurantes-cierre-dia/`. Pruebas HTTP: `apps/api/tests/restaurantes-cierres.spec.ts`.

## Cliente 360 (migración 049)

- Panel (`admin-customers.ts`, MANAGER_ROLES salvo lo marcado; todas las escrituras dejan huella en la bitácora sin PII):
  `GET .../admin/customers/:id/ficha`, `PATCH .../admin/customers/:id` (nombre, notas, cumpleaños día+mes),
  `POST|PATCH|DELETE .../admin/customers/:id/addresses[/:addressId]`, `POST .../admin/customers/:id/preferences` (`accion`: agregar, descartar,
  reactivar, eliminar), `POST .../admin/customers/:id/orders/:orderId/falso`, `GET .../admin/customers/policy` y `PUT` (solo owner/admin),
  `GET .../admin/customers/:id/arco-export` y `POST .../borrar-memoria` (solo owner/admin). Cada función SQL vuelve a validar rol y organización;
  un id de otra organización responde 404. Base sin migrar: 503 "no disponible aún".
- Voz (`voice-tools.ts`, exigen token de llamada: el teléfono sale del token): `POST /v1/restaurantes/:orgSlug/customers/orders`
  (`historial_pedidos`) y `POST .../orders/repeat` (`repetir_pedido`).
- Pruebas: `apps/api/tests/restaurantes-admin-ficha-cliente.spec.ts`.
