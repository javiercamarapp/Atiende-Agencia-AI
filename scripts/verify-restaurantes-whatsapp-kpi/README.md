# verify-restaurantes-whatsapp-kpi

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/040_whatsapp_kpis_diarios.sql`
(espejo: `supabase/migrations/20240101000292_040_whatsapp_kpis_diarios.sql`): KPI del agente de WhatsApp por dia local de la
sucursal (`restaurantes.whatsapp_kpis_diarios`).

Cubre: conteos exactos de conversaciones nuevas, conversaciones con pedido y con handoff (cohorte), pedidos y handoffs del dia,
pedido cancelado y pedido de otro canal excluidos, conversacion que entra justo a las 00:00 local, conversacion sin sucursal,
zona horaria de la sucursal (Auckland), dia sin datos, trafico demo (telefono del rango 0009) excluido, costo LLM solo de los dos
roles del agente de WhatsApp, centavos MXN con y sin tipo de cambio (NULL, nunca 0), costo y pedidos de la organizacion solo con
alcance de toda la organizacion, organizacion demo sin costo, staff de piso / repartidor / sucursal fuera de alcance / otro tenant /
anon / sesion de sistema / rango invalido rechazados (SQLSTATE exacto) y base sin migrar (42883 recuperable con subtransaccion).

- Manual: `scripts/verify-restaurantes-whatsapp-kpi/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
