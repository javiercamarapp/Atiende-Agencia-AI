# Gasto del agente de WhatsApp (restaurantes): avisos por umbral y corte opcional

Ola 4 (H1). Migración `packages/db/migrations/0102_whatsapp_agente_techo.sql` (espejo `supabase/migrations/20240101000902_0102_whatsapp_agente_techo.sql`),
código `apps/api/src/costos/techo-whatsapp.ts`, verificación `scripts/verify-techo-gasto-whatsapp/` (Postgres real, en el gate de CI).

## Decisión (Omar, 9-nov-2026)

«No hay techo, es lo que necesite PM o el cliente.» Por eso:

- **Por omisión no se corta nunca.** El agente sigue atendiendo, gaste lo que gaste.
- Solo se **avisa**: notificación in-app al dueño/admin de la organización (`restaurantes.whatsapp.gasto_umbral`) y al superadmin
  (`superadmin.whatsapp.gasto_umbral`) al cruzar cada umbral informativo, una vez por organización, mes y umbral.
- El **corte** existe solo si un superadmin lo configura explícitamente para una organización.

## Qué mide

Gasto del mes calendario en la zona del negocio (America/Merida) de cada organización:

- LLM del agente: `core.llm_usage_daily` de los roles `restaurantes:whatsapp_agent` y `restaurantes:whatsapp_agent_escalated`;
- WhatsApp (Meta): `core.usage_cost_event` con categoría `whatsapp`.

No incluye voz (`VOICE_TOPE_MENSUAL_USD`, que tampoco tiene tope por omisión) ni el Copiloto. Es independiente del tope mensual de LLM de la
organización (`core.llm_org_budget`).

## Qué hace antes de cada turno (no en la vista previa del panel)

| Situación | Resultado |
|---|---|
| Gasto bajo el primer umbral | atiende |
| Gasto cruza un umbral (el más alto cruzado) | atiende + aviso informativo al dueño y al superadmin |
| Corte configurado para la organización y gasto ≥ corte | **no llama al modelo**: texto fijo, pasa a una persona (`corte_gasto_whatsapp`) + aviso crítico al dueño y al superadmin (`*.whatsapp.gasto_corte`) |
| Base sin la 0102 o error al leer el gasto | atiende (nunca un cliente sin respuesta por un fallo del medidor) |

## Configuración

- **Sin fila** en `core.whatsapp_agente_techo`: umbrales informativos de **50, 100, 250 y 500 USD/mes** (`UMBRALES_AVISO_POR_OMISION_USD`) y **sin corte**.
- **Por organización** (superadmin real, no restringido; cada cambio queda en `core.whatsapp_agente_techo_evento`):

  ```sql
  -- umbrales propios (micro-USD), sin corte:
  select core.superadmin_set_whatsapp_agente_techo('<mi staff_user_id>', '<organization_id>', '{100000000,300000000}', null);
  -- poner un corte explícito (p. ej. 1,000 USD/mes), con los umbrales de omisión:
  select core.superadmin_set_whatsapp_agente_techo('<mi staff_user_id>', '<organization_id>', null, 1000000000);
  -- volver a la omisión (sin corte):
  select core.superadmin_set_whatsapp_agente_techo('<mi staff_user_id>', '<organization_id>', null, null);
  ```

  Se ejecuta con la sesión del superadmin (caller-binding: `auth.uid()` debe ser el primer argumento). Todavía no hay pantalla (hueco conocido).

## Pendiente (para Javier/Omar)

- Si los umbrales de omisión (50/100/250/500 USD) son los adecuados; cambiarlos es cambiar `UMBRALES_AVISO_POR_OMISION_USD`.
- Pantalla de superadmin para umbrales y corte por organización.
