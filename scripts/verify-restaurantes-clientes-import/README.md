# verify-restaurantes-clientes-import

Verificacion, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/054_clientes_cartera_import_y_alerta_comandas.sql`:
cartera de clientes por nivel, importacion de cartera y alerta de comandas de SoftRestaurant que esperan captura manual.
El repositorio en memoria nunca aplica RLS ni GRANT, asi que solo esto detecta un hueco de autorizacion.

## Que demuestra (72 escenarios)

- **A) `customer_tiers`**: el nivel coincide con `calc_customer_tier` (002) para cada cliente; otra organizacion y anon no ven nada.
- **B) `clientes_cartera`**: filtros por nivel (BLACK/PLATINUM/GOLD/BLUE), frecuencia (1 pedido / recurrentes), dias sin pedir
  (30/60/90; quien nunca pidio cuenta como "sin pedir"), sucursal, busqueda y cursor; combinaciones; entradas invalidas rechazadas;
  cross-tenant y anon.
- **C) `cartera_kpis`**: total, recurrentes, ticket promedio (500.00) y cliente mas frecuente; cross-tenant y anon.
- **D) `importar_clientes`**: normal, tope exacto de 5,000 y rechazo de 5,001; telefono invalido rechazado; NO pisa el nombre ni la nota
  conocidos y NO crea pedidos ni mueve `order_count`; idempotente por huella; telefono repetido dentro del archivo; repartidor, otra
  organizacion, sesion de sistema y anon rechazados; escritura directa en `customers`/`customer_imports` rechazada.
- **E) Alerta de captura manual**: umbral por omision (5 min) y por sucursal; una comanda confirmada o ya capturada nunca es candidata; los
  candidatos son solo-sistema; fijar el umbral exige owner/admin de la organizacion de la sucursal.

## Como correrlo

```
scripts/verify-restaurantes-clientes-import/run.sh   # Postgres efimero local (incluye una prueba de concurrencia de dos importaciones)
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-clientes-import   # contra un Postgres ya corriendo
```

La prueba de **concurrencia** (dos importaciones simultaneas con los mismos telefonos y huellas distintas) vive solo en `run.sh`: el gate
ejecuta cada escenario en una conexion secuencial y no puede provocar la carrera.
