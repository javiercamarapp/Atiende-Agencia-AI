# simular-mes-hoteles

Evidencia de punta a punta de un hotel: un tenant sintetico (1 property de 40 habitaciones en 4 tipos, tarifas entre semana y fin de
semana, politica de cancelacion, staff por rol con correos `@example.test`, canal de WhatsApp) recorre **30 dias con reloj simulado** en la
zona de la property (America/Cancun) contra un **Postgres efimero con todas las migraciones reales**, manejando la **API Hono real**
(`buildApp(buildProductionDeps())`) en proceso. Sale un `ledger.json` con, por dia, los eventos, las filas creadas por tabla, el costo por
concepto y los asserts duros. Es el equivalente para hoteles de `docs/qa/2026-08-29-simulacion-mes/ledger.json` de Likida.

```
scripts/simular-mes-hoteles/run.sh                       # modo corto: 3 dias (el del job opcional de CI)
scripts/simular-mes-hoteles/run.sh --dias=30 --salida=docs/qa/<fecha>-simulacion-mes-hoteles   # mes completo, a mano
```

Sale con codigo distinto de 0 si falla **cualquier** assert duro. Pasos pesados (Postgres + 300 migraciones): en esta Mac, de uno en uno y
via `bash ~/atiende-loop/heavy.sh`. `SIM_DEV_DIR=<carpeta>` (solo para desarrollar el simulador) conserva el cluster y una base `plantilla`
ya migrada entre corridas; sin esa variable todo es efimero.

## Que es real y que es doble

| Borde | En la simulacion |
|---|---|
| API (rutas, RLS, roles, validacion, idempotencia, crons internos) | **Real**: `app.request` contra `buildApp(buildProductionDeps())`; staff entra por `/auth/login` con JWT real |
| Postgres | **Real** (efimero) con `supabase/migrations/*.sql`; el `now()` de SQL es el reloj real (ver "Limites") |
| Agente de WhatsApp | Webhook **real** (firma HMAC incluida), turn handler real y gateway LLM real (presupuesto, interruptor, registro de uso en `core.llm_usage_daily`) |
| LLM | **Guionado** (`llm-guionado.ts`): doble de `openrouter.ai` en el `fetch`; el `OpenRouterProvider` real arma la peticion. Decide la herramienta por lo que dice el huesped. Tokens = longitud/4 (estimados) |
| WhatsApp saliente | `WhatsAppOutboundDispatcher` real + `FakeWhatsAppGraphClient` |
| PAC (CFDI) | `DualPacCfdiPort(FakeFinkokAdapter, FakeSwSapienAdapter)` |
| Pagos con tarjeta | `InMemoryPaymentsPort` |
| Cualquier otro host (via `fetch`) | **Bloqueado y contado** (`guarda-red.ts`): el assert `cero-llamadas-externas` falla si algo intenta salir (Meta, PAC, Stripe, OpenRouter real, Resend) |

## Dia tipo (`dia.ts`)

Night audit de la noche anterior (cron real; si falla, disparo manual de gerencia) -> limpieza -> grupos (cron de liberacion, cotizaciones) ->
9 a 14 reservas directas -> check-out con pago (efectivo, tarjeta o transferencia) y cierre de folio -> CFDI de ~45% de las salidas ->
limpieza de tarde -> cancelaciones (libres y con penalizacion) -> check-in con captura de identidad -> revenue (reglas, competencia, cron) ->
cargos de F&B/extras -> mensajes de WhatsApp (pedidos, fallas, consultas y prospectos que piden apartar) -> personal atiende lo que dejo el
agente (cocina, mantenimiento, pre-reservas) -> resenas -> tickets de huesped y barrido de SLA -> ARCO y purga con doble control ->
despacho de WhatsApp.

## Asserts duros (`asserts.ts`, evaluados contra las tablas reales, no contra lo que el simulador "cree")

Cero sobreventa (por inventario y contando reservas + pre-reservas abiertas + cuartos de grupo), cero habitacion doble, cada noche posteada
una sola vez y completa, hospedaje igual a la tarifa del dia, IVA/ISH recalculados de forma independiente, folios en cero al check-out,
no-shows procesados, una corrida de night audit por noche, alergia sin promesa de seguridad sin cocinero, SLA vencido escalado, un CFDI
vigente por folio y total = subtotal + IVA + ISH + DSA, cero 5xx, cero rechazos inesperados, cero llamadas externas y uso LLM de la base =
uso reportado por el proveedor doble.

## Costos (`costos.ts`)

Cada tarifa o cita una fuente del repo, o queda `sin_verificar` y **no suma al total** (aparece con sus unidades). Hoy: LLM
(`packages/agent-core/src/gateway/prices.ts`, modelo de la ruta del agente) es `calculado`; WhatsApp (Meta), PAC, correo y voz son
`sin_verificar`. Ver `docs/COSTO-PUNTA-A-PUNTA-HOTELES.md`.

## Hallazgos

Un bug real que la simulacion expone **no se arregla aqui**: se registra en `ledger.hallazgos` con evidencia y camino alterno (el simulador
sigue por la ruta manual para poder seguir) y se reporta en el PR.

## Limites declarados

- El `now()` de Postgres (defaults de columnas, SLA, vigencias calculadas en SQL, y validaciones de fecha de ARCO/grupos) es el reloj **real**;
  el reloj simulado (`reloj.ts`, sustituye `Date` global) solo gobierna el codigo de la API y del worker. Por eso el mes arranca **hoy**
  (las validaciones "no en el pasado" de grupos lo exigen), el avance de una solicitud ARCO solo se recorre completo el dia 1 (la base exige
  fecha de negocio = fecha del servidor) y los SLA de tickets, que nacen de `now()`, vencen todos en el siguiente barrido una vez que el reloj simulado pasa
  de la hora real.
- Voz (llamadas) y conectores PMS no se simulan; el CFDI usa PAC falso, asi que ningun timbre es fiscal.
- El LLM guionado prueba la plomeria (herramientas, presupuesto, registro de uso, costos), no la calidad de las respuestas de un modelo real.
