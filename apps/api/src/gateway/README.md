# Wiring del gateway LLM

Esta carpeta está vacía (solo este README) y así se queda a propósito — no es
una carpeta reservada pendiente de construir. El wiring real por
organización/carril ya existe, pero vive en
`apps/api/src/production/llm-gateway.ts` (`buildProductionLlmGateway()`), no
aquí: registra las escaleras de proveedor (roles) de las 6 verticales — los 3
agentes de WhatsApp con IA (restaurantes/hoteles/citas, más su variante
escalada), extracción de requisitos y redacción de propuesta de licitaciones,
mensajería de rentas, conciliación de despachos — cada una con presupuesto
por-organización real (`ProductionOrgMonthlyBudgetStore`, respaldado por
`TenancyEngine`). Se construye dentro de `buildProductionDeps()`
(`apps/api/src/production/deps.ts`) y se expone como `AppDeps.llmGateway`,
consumido por los turn handlers reales de WhatsApp.

La clase base que orquesta reintentos/fallback/circuit-breaker/presupuesto es
`LlmGateway` (`packages/agent-core/src/gateway/gateway.ts`) — no existe
ninguna clase `GatewayRouter` en este repo.
