# Vertical: restaurantes (web)

Ya NO es solo Fase 1 (`Login.tsx`) — este README nunca se actualizó tras el
port inicial. Panel completo real hoy: `pages/Dashboard.tsx`, `Pedidos.tsx`,
`Productos.tsx`, `Clientes.tsx`, `Historial.tsx`, `Promociones.tsx`,
`Repartidor.tsx`, `Staff.tsx`, `Sucursales.tsx` — cada una con su cliente HTTP
tipado en `lib/` (`catalog-client.ts`, `orders-client.ts`,
`customers-client.ts`, `promotions-client.ts`, `repartidor-client.ts`,
`staff-client.ts`, `branches-client.ts`).

Ver `apps/api/src/routes/verticals/restaurantes/README.md` y
`packages/domain-restaurantes/README.md` para el backend real que consumen
estas pantallas.
