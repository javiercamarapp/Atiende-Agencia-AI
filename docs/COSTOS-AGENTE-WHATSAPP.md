# Techo de gasto del agente de WhatsApp (restaurantes)

Ola 4 (H1). Migración `packages/db/migrations/0102_whatsapp_agente_techo.sql` (espejo `supabase/migrations/20240101000902_0102_whatsapp_agente_techo.sql`),
código `apps/api/src/costos/techo-whatsapp.ts`, verificación `scripts/verify-techo-gasto-whatsapp/` (Postgres real, en el gate de CI).

## Qué mide

Gasto del mes calendario en la zona del negocio (America/Merida) de cada organización:

- LLM del agente: `core.llm_usage_daily` de los roles `restaurantes:whatsapp_agent` y `restaurantes:whatsapp_agent_escalated`;
- WhatsApp (Meta): `core.usage_cost_event` con categoría `whatsapp`.

No incluye voz (tiene su propio tope, `VOICE_TOPE_MENSUAL_USD`) ni el Copiloto (sub-tope de 0047). Es independiente del tope mensual de LLM de la
organización (`core.llm_org_budget`), que sigue cortando todo el LLM al 100 %.

## Qué hace

Antes de cada turno del agente (no en la vista previa del panel):

| Gasto / techo | `avisar_y_cortar` (omisión) | `avisar` |
|---|---|---|
| < 100 % | atiende | atiende |
| ≥ 100 % y < corte | atiende + aviso `restaurantes.whatsapp.techo_gasto_alcanzado` (uno por mes) | atiende + aviso |
| ≥ corte (120 % por omisión) | **no llama al modelo**: contesta un texto fijo, escala a una persona (`techo_gasto_whatsapp`) + aviso `restaurantes.whatsapp.techo_gasto_corte` | atiende + aviso |

Base sin la 0102 o error al leer el gasto: el agente atiende igual (nunca se deja a un cliente sin respuesta por un fallo del medidor).

## Configuración

- Sin fila en `core.whatsapp_agente_techo`: **100 USD/mes, `avisar_y_cortar`, corte al 120 %** (`TECHO_WHATSAPP_POR_OMISION_USD`,
  `ACCION_TECHO_POR_OMISION`, `CORTE_PCT_POR_OMISION`).
- Por organización: `core.superadmin_set_whatsapp_agente_techo(caller, org, techo_micro_usd, accion, corte_pct)` (superadmin real, no
  restringido; techo nulo vuelve a la omisión; cada cambio queda en `core.whatsapp_agente_techo_evento`). Todavía no hay pantalla:
  se llama por SQL de soporte con la sesión del superadmin (hueco conocido).

## Decisión pendiente de Javier

1. **Valor del techo por omisión** (100 USD es una propuesta; el contrato de PM cobra 30,000 MXN + IVA al mes).
2. **Acción por omisión**: avisar y cortar (propuesta, protege el margen) o solo avisar (nunca deja a un cliente con el texto fijo).
3. **Porcentaje de corte** (120 % propuesto: deja un colchón entre el aviso y el corte).
4. Si el corte debe mandar además un aviso al superadmin.

Cambiar la omisión es cambiar las tres constantes de `techo-whatsapp.ts`; cambiar una organización no requiere despliegue.
