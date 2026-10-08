# verify-restaurantes-cfo-captura

Verificacion contra Postgres real (rol REAL `authenticated`, RLS, GRANT por columna y `auth.uid()`) de
`packages/domain-restaurantes/migrations/083_cfo_captura_y_softrestaurant_import.sql`
(espejo: `supabase/migrations/20240101000393_083_cfo_captura_y_softrestaurant_import.sql`), CFO paquete 03.

Cubre (230 escenarios):
- **Configuracion** (`cfo_config`, `cfo_config_leer`, `cfo_config_guardar`): defaults sin fila (y que coinciden con los DEFAULT de la
  tabla), guardado parcial, rangos (22023), admin acotado / staff / repartidor / otra organizacion / sistema / anon, bitacora, sin DML directo.
- **Costos** (`cfo_costo_captura`, `cfo_costo_guardar`, `cfo_costos_leer`, `cfo_costo_historial`): una version vigente y una reemplazada,
  historial, filas de organizacion solo para organizacion completa, alcance por sucursal, validaciones (22023), append-only (0A000),
  indice unico parcial (23505), aditividad (todas = sucursales + no asignado).
- **SoftRestaurant** (`sr_import_lote`, `sr_resumen_dia`, `sr_ticket`, `sr_importar`, `sr_resumen_leer`, `sr_lotes_listar`, `sr_cobertura`):
  idempotencia por huella, reemplazo por dias (se marca, no se borra), resumen derivado de cuentas, llaves de cliente rechazadas (22023),
  topes de renglones (20000 / 2000), errores acotados a 50 y sin contenido, folio unico entre vigentes, roles y alcance, sin DML directo.
- **Bitacora de exportaciones** (`cfo_registrar_exportacion`) y **seguridad transversal** (search_path fijo, anon sin execute, helpers internos
  sin execute, RLS, sin DML ni columnas de actor para `authenticated`).

Los archivos de SoftRestaurant de los fixtures son SINTETICOS y viven solo en `assertions.sql`.

- Manual: `scripts/verify-restaurantes-cfo-captura/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (contrato de 3 archivos).
