# Consola de superadmin: Resumen y actividad de agentes (SA-L-05, SA-L-06)

Backend que alimenta el Resumen de la consola. La pantalla la construye otra tarea (uni-res-superadmin-resumen).
Solo lectura. Migración: `packages/db/migrations/0042_superadmin_consola_resumen.sql` (espejo `supabase/migrations/20240101000270_0042_...`).

## Endpoints

Ambos van detrás de la cadena de `routes/superadmin.ts` (sesión, superadmin, guard de impersonación, zona CFO, step-up). No están
en `RUTAS_FINANCIERAS`: el rol `finanzas` (lista blanca) recibe 403.

### `GET /superadmin/consola/resumen`
Cada campo es `{ valor, codigo?, razon? }`. Si su fuente falla, `valor` es `null` y `razon` explica; los demás siguen.
Sin la migración 0042: 200 con `disponible: false` y `mensaje` (`disponible` describe solo las fuentes de 0042; el `mrr` sale con su valor si 0030 está aplicada, o con su razón). Nunca 500 ni un 0 inventado.

| Campo | Fuente |
|---|---|
| `organizaciones` | `core.organization` por vertical; demo = `restaurantes.demo_organization` o slug `demo-*` (heurística frágil: una organización real con ese prefijo contaría como demo) |
| `gastoIa` | `core.llm_usage_daily.cost_micro_usd` + `core.usage_cost_event` por categoría; `serie14d` y `delta7d` (7 días contra los 7 previos, en USD) |
| `tokens` | `llm_usage_daily.tokens_in + tokens_out` |
| `operaciones` | por vertical: pedidos (restaurantes, sin cancelados), reservas (hoteles, sin cancelada/cotizada/no_show; rentas, capa reserva sin cancelar), citas (sin cancelled/no_show), convocatorias analizadas (licitaciones con requisitos extraídos). Serie diaria de 14 días |
| `vozMinutos` | `usage_cost_event` categoría voz (minutos, o segundos/60) |
| `sucursales` | `core.property` activas |
| `usuarios` | personas distintas con membresía en organizaciones no suspendidas + superadmins (sin doble conteo) |
| `conversacionesWa` | conteo por vertical (nunca contenido) |
| `resueltasSinHumano` | "X de N" del día de México, solo restaurantes: conversaciones con actividad hoy; X = `completed` sin fila en `conversation_handoff` |
| `mrr` | reutiliza `core.get_cfo_dashboard_for_superadmin`: solo total, con precio y sin precio |

Día de negocio: `America/Mexico_City`. El API calcula "hoy" con `Intl` y lo pasa a SQL; a las 23:30 de México (05:30 UTC del día siguiente) "hoy" sigue siendo el día de México.

### `GET /superadmin/consola/agentes-actividad`
`agentes`: llamadas, costo (USD) y fallbacks por vertical y rol, histórico y últimos 30 días. `ultimaCorrida`: `core.cron_heartbeat`
(vía `list_cron_heartbeats_for_superadmin`) con el mapa `apps/api/src/consola/agentes-cron.ts` (ruta de cron a vertical y nombre humano).
Las tareas x/y salen `"no medido"`. Un test obliga a nombrar todo cron nuevo de `vercel.json`.

## Política del MRR (decisión pendiente de Javier)
Solo el total, sin desglose por cliente, sin step-up, y cada lectura deja una fila `consulta` con recurso `resumen_mrr` en `core.cfo_access_log`
(se escribe antes de leer; si registrarla lanza, el MRR sale `null` con `sin_bitacora`; sin 0034 aplicada o sin `cfoZoneRepo`, `logAccess` no lanza y el MRR se sirve sin fila, igual que `zona-cfo.ts`; si la fuente del MRR falla, sale `null` con `error`).
El gasto de IA total (USD) del Resumen se sirve sin step-up ni bitácora, a diferencia de `/superadmin/costos/resumen` y gasto-api (en `RUTAS_FINANCIERAS`): es una decisión de política pendiente de Javier, igual que la del MRR. Vive en `POLITICA_MRR_RESUMEN`
(`routes/superadmin-consola.ts`): `requiereStepUp` y `recursoBitacora`.

## Huecos conocidos
- Operaciones sin fuente: despachos (la conciliación bancaria no se persiste; no hay CFDI conciliados registrados). Rentas, citas, hoteles, restaurantes y licitaciones tienen fuente; si la migración de una vertical falta, solo esa fila sale `fuente_no_migrada`.
- Operación de restaurantes: cuenta todo status distinto de `cancelado` (incluye `programado` y `problema`) como operación atendida; es una decisión de producto por confirmar.
- Conversaciones de WhatsApp: rentas (`rentas.conversacion` es mensajería de canal OTA), licitaciones y despachos no guardan conversaciones de WhatsApp.
- "Resueltas sin humano" solo se mide en restaurantes (depende de PL-14).
- La bitácora de corridas real y las tareas x/y son SA-L-07.
- Notificaciones: sin eventos nuevos; endpoints de solo lectura.

## Verificación
`scripts/verify-superadmin-consola/` (Postgres real, lo corre `scripts/verify-real-postgres-ci/run-gate.mjs`): agregados con datos sembrados y corte de día de México, fuente ausente por vertical, rechazo de staff normal, uid ajeno, sistema y anon, rangos inválidos y bitácora `resumen_mrr`.
Fixtures de la UI: `apps/web/e2e/mock-api/fixtures/superadmin.ts`.
