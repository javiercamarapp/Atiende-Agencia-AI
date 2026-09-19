# @atiende/domain-restaurantes

Empezó como el port de Fase 1 del vertical restaurantes (ver
`docs/REQUISITOS.md` para el detalle de diseño original), pero eso quedó
desactualizado hace varias fases: hoy también incluye KPIs (`kpis.ts` +
`006_kpi_aggregates.sql`), promociones (`promotions.ts`), notificaciones
reales de WhatsApp al cliente por cambio de estado de pedido
(`order-notifications.ts`), asignación de repartidor, correo transaccional
(`email-dispatch.ts`) y 15 migraciones — ver
`apps/api/src/routes/verticals/restaurantes/README.md` para el mapa completo
de fases (3/5/8/9/11/12) que fue agregando cada pieza.

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

Explícitamente fuera de alcance de este paquete todavía: agente de voz
ElevenLabs completo, panel de superadmin propio (el back office cruzado de
plataforma vive en `apps/api/src/routes/superadmin*.ts`/
`apps/web/src/superadmin/`, no aquí). El agente de WhatsApp con LLM real y los
dashboards de KPIs, que esta nota marcaba como "fuera de Fase 1", ya se
construyeron en fases posteriores (ver arriba) — dejaron de estar fuera de
alcance.
