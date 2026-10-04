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

## Cierre del día (R-42)

`pages/Cierres.tsx` (`/restaurantes/:orgSlug/cierres`, solo owner/admin): cierre del día y resumen semanal con ventas, canales, cancelaciones, tiempos de entrega
y comparativo; los periodos terminados sin cierre se generan con un botón que llama al API real (`lib/cierres-client.ts`). Base sin migrar: estado honesto
"no disponible todavía". Prueba: `apps/web/tests/restaurantes-cierres.spec.tsx`.
