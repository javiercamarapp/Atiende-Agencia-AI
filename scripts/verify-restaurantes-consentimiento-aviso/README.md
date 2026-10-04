# verify-restaurantes-consentimiento-aviso

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/042_consentimiento_checkout_aviso_programado.sql`
(espejo: `supabase/migrations/20240101000312_042_consentimiento_checkout_aviso_programado.sql`): consentimiento del aviso de privacidad
del checkout web (`restaurantes.order_privacy_consent`, `system_record_order_privacy_consent`) y el aviso al staff cuando un pedido
programado entra a cocina (evento `order.programado_promovido` en `staff_order_notification`, `enqueue_staff_order_notification`).

Cubre: registro solo de sistema con la version del aviso decidida por la base (v2 configurada, v1 por defecto), idempotencia por
pedido, sin columnas de PII; rechazos (usuario logueado, pedido de otra organizacion, pedido inexistente, canal invalido, anon);
lectura solo para owner/admin de la organizacion (staff de piso, otro tenant y anon no) y ninguna escritura directa (authenticated,
anon, service_role); el evento nuevo y los historicos del enqueue, evento invalido, staff de otra organizacion, pedido de otra
organizacion o sucursal, el CHECK de la tabla, y base sin migrar (42883 recuperable con subtransaccion).

- Manual: `scripts/verify-restaurantes-consentimiento-aviso/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
