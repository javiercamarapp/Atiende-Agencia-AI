# Vertical: restaurantes (api)

Fase 1 construida: `public.ts` (`POST /v1/restaurantes/:orgSlug/orders`,
`POST /v1/restaurantes/:orgSlug/customers/lookup` — sin `authMiddleware`, canales
públicos/de sistema, ver diseño Fase 1 §3) y `whatsapp.ts`
(`GET|POST /v1/restaurantes/whatsapp/webhook`, verificación HMAC sobre bytes crudos).

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
