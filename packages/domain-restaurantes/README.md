# @atiende/domain-restaurantes

Fase 1 de la migración del vertical restaurantes — construido (ver `docs/REQUISITOS.md`
para el detalle de diseño y `.claude` del commit que lo introdujo).

Tipos, roles, lógica de negocio (búsqueda/cotización de productos con guardia
anti-alucinación de precio, memoria de cliente por teléfono, pedidos idempotentes,
plomería de WhatsApp) portados de `restaurantes/src` +
`restaurantes/supabase/functions`, adaptados al modelo de tenancy de
`@atiende/core-tenancy` (`core.organization`/`core.property`, no una tabla
`restaurants` aislada).

Adaptadores duales (mismo patrón que `@atiende/core-conversation`):
`InMemoryRestaurantesRepository` (tests, dev sin Postgres real) y
`PostgresRestaurantesRepository` (producción, sobre `TenantDbSession`).

Migraciones SQL reales en `migrations/` (schema `restaurantes.*`, requiere
`packages/db/migrations/0001_core_schema.sql` aplicada antes).

Explícitamente fuera de esta fase: agente de voz ElevenLabs completo, agente de
WhatsApp con LLM real (el seam `WhatsAppTurnHandler` ya queda listo para Fase 2),
panel de superadmin, dashboards de KPIs.
