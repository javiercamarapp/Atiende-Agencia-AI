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
  (invitación/revocación/cambio de rol, `entityType="staff"`).
- Huecos conocidos (ver el cuerpo del PR para el detalle completo): sin ruta
  real de "baja" de un miembro YA ACEPTADO (solo existe revocar una invitación
  pendiente); sin ninguna ruta que edite WhatsApp/voz/horarios/zonas de entrega
  todavía, así que `entityType="configuracion"` queda reservado sin caller.
