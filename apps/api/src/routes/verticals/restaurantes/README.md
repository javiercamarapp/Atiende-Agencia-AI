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

`repartidores`, cuentas/accesos de staff, notificaciones, promociones/marketing,
panel de superadmin, "pregunta a tus datos" y configuración del agente de voz/
WhatsApp quedan explícitamente fuera de esta fase — ver el brief de Fase 5.
