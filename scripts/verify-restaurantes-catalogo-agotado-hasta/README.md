# verify-restaurantes-catalogo-agotado-hasta

Verificacion contra Postgres real de «Dejar de venderlo» del panel de Productos (import-orig-14) sobre
`branch_products.agotado_hasta` (migracion 050, espejo en `supabase/migrations/`) y el cron `restaurantes.agotados_reponer` (076).

Por que existe: el codigo no puede escribir `agotado_hasta` como `authenticated` (la 065 solo devuelve `grant update (price, is_available,
updated_at)`; escribirlo da 42501). `PostgresRestaurantesRepository.limpiarAgotadoHasta` hace dos UPDATE de columnas permitidas (encender y
apagar) y deja que el trigger de la 050 borre la fecha. Un doble en memoria no puede detectar un GRANT, por eso se prueba aqui con el rol real.

Cubre: control (sin «Dejar de venderlo» el cron reactiva), con «Dejar de venderlo» el cron NO lo reactiva, queda apagado y sin fecha, el
UPDATE directo de `agotado_hasta` falla con 42501 (no se agrega grant a la columna), un solo UPDATE no basta, y RLS entre organizaciones.

- Manual: `scripts/verify-restaurantes-catalogo-agotado-hasta/run.sh` (Postgres efimero con `initdb`).
- CI: lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs` (contrato de 3 archivos).
