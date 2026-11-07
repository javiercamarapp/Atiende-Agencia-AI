# Costo del huesped de punta a punta - Hoteles

Cuanto cuesta atender un mes de un hotel de 40 habitaciones y cuanto sale **por estancia**, separando lo **medido**, lo **calculado** y lo que **no tiene
tarifa verificada**. Origen: el mismo ledger que [CICLO-PUNTA-A-PUNTA-HOTELES.md](CICLO-PUNTA-A-PUNTA-HOTELES.md),
[`docs/qa/2026-10-03-simulacion-mes-hoteles/ledger.json`](qa/2026-10-03-simulacion-mes-hoteles/ledger.json) (30 dias, 246 estancias cerradas con check-out, 339 reservas directas aceptadas + 29 pre-reservas del agente confirmadas).

**Regla**: una tarifa o cita una fuente del repo, o queda `sin_verificar` y **no se suma al total**; aparece con sus unidades para saber que hay que cotizar.
Nada se redondea a favor del hotel. Codigo: `scripts/simular-mes-hoteles/costos.ts`.

## Costo del mes

| Concepto | Unidades medidas | Tarifa | Estado | Costo del mes (USD) |
|---|---|---|---|---|
| LLM del agente de WhatsApp (634 llamadas) | 1 950 492 tokens (entrada + salida, estimados por longitud) | 0.1 / 0.5 USD por millon (entrada/salida); packages/agent-core/src/gateway/prices.ts (openai/gpt-6-luna, verificado 2026-10-01, catalogo OpenRouter) | **CALCULADO** (tokens estimados x precio verificado). El gateway real registro lo mismo en `core.llm_usage_daily` (assert `llm-uso-registrado-coincide`) | 0.2027 |
| WhatsApp saliente (Meta) | 258 mensajes despachados por el despachador real | sin fuente primaria (el unico numero del repo es una referencia interna de Likida, 0.008 USD/mensaje) | **SIN VERIFICAR** (unidades MEDIDAS) | no suma |
| Timbres CFDI (PAC) | 112 timbres | sin cuenta de PAC contratada | **SIN VERIFICAR** (unidades MEDIDAS; el timbre fue falso) | no suma |
| Correo transaccional (Resend) | 697 correos encolados | sin tarifa contratada; el envio requiere `RESEND_API_KEY` | **SIN VERIFICAR** (unidades MEDIDAS; no se enviaron) | no suma |
| Voz (llamadas) | 0 minutos | sin tarifa de proveedor | **NO SIMULADO** | no suma |
| **Total calculable hoy** | | | | **0.2027** |

## Costo por estancia (medido vs calculado)

Estancia = una reserva con check-out en el mes. Los promedios dividen el mes entre ese numero; una parte del costo (p. ej. el agente atendiendo a prospectos que no reservan) se reparte entre todas.

| Concepto | Por estancia | Estado |
|---|---|---|
| LLM | 0.0008 USD (7 929 tokens; 2.58 llamadas) | CALCULADO |
| WhatsApp saliente | 1.05 mensajes | unidades MEDIDAS; costo SIN VERIFICAR |
| Timbre CFDI | 0.46 timbres (se factura 46% de las estancias) | unidades MEDIDAS; costo SIN VERIFICAR |
| Correo | 2.83 correos | unidades MEDIDAS; costo SIN VERIFICAR |
| **Total calculable hoy** | **0.0008 USD** | solo lo CALCULADO |

## Que falta para un costo por estancia completo

1. **Tarifa de Meta** por conversacion/mensaje (Mexico) con fuente primaria: hoy solo hay una referencia interna. Hasta tenerla, el costo de WhatsApp queda fuera del total; las unidades ya se miden.
2. **Tarifa del PAC** (Finkok o SW Sapien) por timbre y la cuenta contratada: los adaptadores reales lanzan `PortUnavailableError` sin credenciales (`apps/api/src/production/deps.ts`).
3. **Tarifa de Resend** y la llave: los correos solo se encolan en la simulacion.
4. **Voz**: no hay llamadas en la simulacion; el costo depende del proveedor contratado.
5. **Tokens reales**: aqui son estimados por longitud sobre una peticion real y una respuesta guionada. Con `OPENROUTER_API_KEY` real, `core.llm_usage_daily` registra los tokens y el costo que reporta el proveedor y este documento se rehace con ese dato.

## Como reproducirlo

```
bash ~/atiende-loop/heavy.sh bash scripts/simular-mes-hoteles/run.sh --dias=30 --salida=docs/qa/<fecha>-simulacion-mes-hoteles
```

El ledger lleva, por dia, las lineas de costo con `unidades`, `precioUnitarioUsd`, `costoUsd`, `estado` y `fuente`; la prueba `apps/api/tests/simular-mes-hoteles-ledger.spec.ts` valida su esquema y su aritmetica.
