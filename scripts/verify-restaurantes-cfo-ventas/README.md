# verify-restaurantes-cfo-ventas

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/081_cfo_ventas_productos.sql`
(espejo: `supabase/migrations/20240101000391_081_cfo_ventas_productos.sql`): SQL de ventas, cortesias, horas, productos, canasta, detalle de
pedidos y cobertura del modulo CFO de restaurantes (`restaurantes.cfo_*`).

Dataset a mano con 3 sucursales en la organizacion A (A1 Mexico con corte 01:00, A2 Mexico sin corte, A3 Pacific/Auckland) y una sucursal de la
organizacion B. Cubre:

- Reglas de datos: dia de negocio con corte (00:30 cuenta en el dia anterior, 01:05 en el nuevo), programado excluido y programado promovido
  incluido (creado dias antes), trafico demo `0009`, `por_aprobar` y pedido falso fuera de la venta, reposicion fuera de ventas y dentro de cortesias
  (valorada con el precio de la sucursal), bruta - neta = descuento, compensacion `GRACIAS-` aparte, propina aparte, tiempos de entrega y entregas tarde.
- Aditividad: para `cfo_ventas_diarias`, `cfo_productos` y `cfo_ventas_hora`, el resultado con `p_props = null` (owner) es EXACTAMENTE la union
  de las llamadas por cada sucursal (todas las columnas), y no hay fila `property_id = null` (la fila «No asignado» la pone la 082).
- Canasta (pares, totales, distribucion del ticket), detalle sin PII (columnas, alias, filtros de lista cerrada, cursor sin repetir filas) y cobertura.
- Seguridad: owner ve las 3 sucursales; admin acotado solo la suya (otra => 42501); staff, repartidor y otra organizacion => 42501 en las 7
  funciones; anon sin execute; sistema (sin usuario) con sucursal de otra organizacion => 42501; rango de 401 dias, lista vacia o con nulos => 22023;
  los helpers `cfo_resolver_sucursales` y `cfo_pedidos_base` no son ejecutables por authenticated; grants, SECURITY DEFINER, search_path fijo y STABLE.
- Idempotencia (re-ejecutar las definiciones no cambia nada; `run.sh` ademas aplica el archivo de la migracion una segunda vez) y base sin migrar
  (42883 recuperable con subtransaccion).

- Manual: `scripts/verify-restaurantes-cfo-ventas/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
