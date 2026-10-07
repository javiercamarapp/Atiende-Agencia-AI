# Voz de PM: activación, paso a paso (solo falta pegar las llaves)

Este es el runbook ÚNICO para encender la voz de Los Taquitos de PM con su **número propio**: la sucursal conserva su línea (Telmex, Telcel o conmutador) y, cuando
no contesta o está ocupada, un **desvío condicional** manda la llamada a un número puente de Twilio que llega al agente de voz.

```
Línea de la sucursal -> desvío condicional (no contesta / ocupado) -> número puente en Twilio (Elastic SIP Trunk)
  -> LiveKit Cloud (inbound trunk + regla de despacho: una sala por llamada) -> apps/voice-worker en Fly.io (dfw) -> Gemini 3.8 Live
```

Decisiones de fondo, costos y fuentes: la investigación del 4-oct-2026 (`work/voz/investigacion-voz-gemini-pm.md`). Diseño del código: `docs/VOZ-PM.md` y
`apps/voice-worker/README.md`. Aquí solo está lo que hay que **hacer y pegar**.

> Honestidad primero. Nada de esto se ha ejecutado contra cuentas reales (no existen todavía): los scripts de Twilio, LiveKit y Fly están probados contra dobles,
> el worker contra telefonía falsa y Gemini no se ha probado con la API real. Lo que **no está verificado** va marcado como tal; la primera llamada real lo confirma.

## 0. Qué queda hecho y qué falta pegar

| Ya está hecho en el repo (probado sin red) | Falta (solo llaves y decisiones tuyas) |
|---|---|
| Protocolo de Gemini Live (español de México en la instrucción, sin `languageCode` ni `thinkingLevel`, VAD afinado) y adaptador de Vertex AI listo, sin activar | `GEMINI_API_KEY` de pago (nivel 2) |
| Reglas duras H1-H18 conectadas a la instrucción de la llamada | Aprobar el criterio de la prueba ciega con Gemini real |
| Costo real por llamada desde `usageMetadata` en `core.usage_cost_event`, tope por llamada y por mes | Confirmar el tope mensual (propuesta en la sección 6) |
| Guarda de caller ID: si llega el número de la sucursal, de un número puente o nada, el agente pide y confirma el teléfono | Probar el desvío con la compañía telefónica (sección 4) |
| `fly.toml`, Dockerfile verificado por réplica y `scripts/voz/desplegar-worker.sh` | Cuenta de Fly.io y su token |
| `npm run voz:twilio` y `npm run voz:livekit` (ensayo por omisión, idempotentes) | Cuenta de Twilio con Regulatory Bundle de México; proyecto de LiveKit Cloud |
| `npm run voz:pregrabados` (generar) y `-- --verificar` (comprobar) | Correr el generador UNA vez con tu llave de OpenRouter y escuchar los 15 audios |
| Latido en `/salud` y reinicio automático si el sondeo de LiveKit se muere | Método de pago en la cuenta de Meta (sección 7) |

## 1. Las llaves: de dónde sale cada una, dónde se pega y con qué comando

Los comandos que escriben secretos los corres TÚ en tu terminal (anteponiendo `!` en Claude Code). Ningún valor vive en el repo.

| # | Llave | De dónde sale | Dónde se pega | Comando exacto |
|---|---|---|---|---|
| 1 | `GEMINI_API_KEY` | Google AI Studio (https://aistudio.google.com/apikey) en un proyecto con **Cloud Billing activo**. El **nivel 1** tope en US$250/mes y US$10 por 10 min: paga US$100 y espera 3 días para el **nivel 2** *antes* de abrir PM completo | Fly (lo sube el script) **y** Vercel (API: la usa la vista previa del panel) | `! vercel env add GEMINI_API_KEY production` |
| 2 | `OPENROUTER_API_KEY` | Ya la tiene la API en Vercel (misma del texto). Es el escalón 2 de la escalera (cascada) y el generador de pregrabados | Fly (script) | En tu shell: `export OPENROUTER_API_KEY=...` antes del script |
| 3 | `INTERNAL_SECRET` | **El mismo** que ya tiene la API en Vercel (Settings > Environment Variables) | Fly (script) | `export INTERNAL_SECRET=...` |
| 4 | `ATIENDE_API_URL` | URL de producción de la API (la del despliegue en Vercel) | Fly (script) | `export ATIENDE_API_URL=https://...` |
| 5 | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit Cloud: proyecto > Settings > Keys (empieza en el plan Build; pasa a Ship de US$50 al abrir PM completo) | Fly (script) y tu shell para `npm run voz:livekit` | `export LIVEKIT_URL=wss://<proyecto>.livekit.cloud LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=...` |
| 6 | `LIVEKIT_SIP_URI` | LiveKit Cloud: ajustes del proyecto, host SIP (`<proyecto>.sip.livekit.cloud`) | Solo tu shell (`npm run voz:twilio`) | `export LIVEKIT_SIP_URI=<proyecto>.sip.livekit.cloud` |
| 7 | `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN` (o `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET`) | Consola de Twilio | Solo tu shell | `export TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=...` |
| 8 | `TWILIO_BUNDLE_SID` y `TWILIO_ADDRESS_SID` | Twilio > Regulatory Compliance: **Regulatory Bundle de México aprobado** (Constancia de Situación Fiscal de Atiende + comprobante de domicilio **en la localidad del prefijo**, de 12 meses o menos) y su Address. La aprobación tarda "hasta varios días hábiles" | Solo tu shell, solo para comprar | `export TWILIO_BUNDLE_SID=BU... TWILIO_ADDRESS_SID=AD...` |
| 9 | Secreto de la sucursal | `POST /v1/restaurantes/:propertyId/admin/config/sucursales/:branchId/voz/secreto` (se muestra **una sola vez**, con sesión de owner/admin) | Fly (el nombre de la variable lo elige `secretoEnv` en `VOICE_DNIS_MAP`) | `export VOICE_SECRET_T7=...` |
| 10 | `VOICE_DNIS_MAP` | Tú lo armas (sección 3, paso 5) | Fly (script) | `export VOICE_DNIS_MAP='{...}'` |
| 11 | `FLY_API_TOKEN` | Cuenta de Fly: `fly auth token` | Solo tu shell | `! fly auth login` y `export FLY_API_TOKEN=$(fly auth token)` |
| 12 | `VOICE_REQUIRE_CALL_TOKEN=true` | No es una llave: cierra el camino heredado | Vercel (API) | `! vercel env add VOICE_REQUIRE_CALL_TOKEN production` (valor `true`; **después** de la llamada de prueba del paso 8) |
| 13 | `VOICE_TOPE_MENSUAL_USD` (y `topeMensualUsd` por organización) | Decisión tuya (sección 6) | Fly (script) / `VOICE_DNIS_MAP` | `export VOICE_TOPE_MENSUAL_USD=100` |

Variables opcionales del worker (todas con un valor por omisión razonable): `VOICE_COSTO_MAX_LLAMADA_USD` (tope por llamada, por omisión **US$0.50**),
`VOICE_VAD_SILENCIO_MS` y `VOICE_VAD_SENSIBILIDAD_FIN` (`alta|baja|omitir`; por omisión 500 ms y `alta`), `GEMINI_BACKEND=vertex` con `VERTEX_PROJECT`, `VERTEX_LOCATION` y
`VERTEX_SERVICE_ACCOUNT_JSON` (Vertex AI: **no activar** hasta ~10 restaurantes o un cliente que pida residencia de datos; sin verificar contra Vertex real).

## 2. Antes de empezar

1. El PR está fusionado y la API desplegada (Vercel). El worker y la API pueden desplegarse en cualquier orden: la API acepta tramos con y sin `costoReal`.
2. Las migraciones de voz ya aplicadas por ti (025, 026, 030, 035, 067; ver `docs/VOZ-PM.md`). Este PR **no agrega SQL**.
3. En el panel, Agente de voz > Voz: voz elegida, Comportamiento y Mensaje inicial (debe decir "asistente virtual"). La sucursal con "Agente habilitado" encendido solo cuando llegues al paso 8.

## 3. Orden de activación (modo desborde, una sucursal: T7)

Empieza por **T7** (primera sucursal) en **horario valle** (propuesta a confirmar con PM: lunes a jueves de 16:00 a 18:00; el pico es sábado y domingo de 13 a 16 y de 18 a 22).

1. **Pregrabados (una vez, centavos).** `OPENROUTER_API_KEY=... npm run voz:pregrabados -- --tope-usd=0.25`; luego `npm run voz:pregrabados -- --verificar` (15 WAV
   válidos, mono, 8/16/24 kHz, más de 0.5 s) y **escúchalos** (`afplay apps/voice-worker/assets/handoff.wav`). Viven en `apps/voice-worker/assets/*.wav` (ignorados por git; los 15
   pesan unos 2 MB) y viajan **en la imagen del worker**: el script de Fly se niega a desplegar si faltan.
2. **Prueba ciega contra Gemini real (tope US$2).** `VOZ_EVALS_REAL=1 GEMINI_API_KEY=... VOZ_EVALS_MAX_USD=2 npm run evals:voz:real -w @atiende/domain-restaurantes`. Criterio del ADR:
   **>= 95 % de comandas correctas y 0 violaciones de reglas duras.** La primera corrida también verifica el protocolo (si falla al abrir, mira el código de cierre del WebSocket).
3. **LiveKit.** `npm run voz:livekit` (ensayo: solo lee y dice qué haría) y después `npm run voz:livekit -- --ejecutar`. Crea el *inbound trunk* (solo acepta los números de `VOICE_DNIS_MAP`,
   con los encabezados SIP como atributos `sip.h.*`) y la regla de despacho **individual** con prefijo `llamada-`. Recomendado: `LIVEKIT_ALLOWED_ADDRESSES` con las direcciones de
   Twilio (su lista pública de IPs de SIP; no verificada aquí) para que solo Twilio pueda entrar.
4. **Twilio.** `npm run voz:twilio -- --lada=999` (ensayo). Con el Regulatory Bundle aprobado: `npm run voz:twilio -- --ejecutar --comprar` (cuesta ~US$6.25 al mes por un local; lo decides tú).
   Crea el Elastic SIP Trunk, apunta el *origination* a `sip:<proyecto>.sip.livekit.cloud;transport=tcp` y asocia el número. Si Twilio no tiene 999 en MX: otra `--lada`, `--tipo=toll-free`
   (US$30 al mes, cualquier domicilio; confirma antes que Telmex no cobre el desvío a un 800) o Telnyx. **Anota el número puente.**
5. **`VOICE_DNIS_MAP`.** Una entrada por número puente; `numerosSucursal` lleva la(s) línea(s) de la sucursal que desvían (para reconocer un desvío que re-origina la llamada):
   ```
   export VOICE_DNIS_MAP='{"+52999XXXXXXX":{"orgSlug":"los-taquitos-de-pm","organizationId":"<uuid>","propertyId":"<uuid>","branchSlug":"<slug de T7>","secretoEnv":"VOICE_SECRET_T7","modoEntrada":"prueba","numerosSucursal":["+52999YYYYYYY"]}}'
   ```
   `modoEntrada: "prueba"` mantiene las llamadas de prueba fuera del KPI de ventas recuperadas; al terminar el paso 8 cámbialo a `desborde`.
6. **Fly.** `bash scripts/voz/desplegar-worker.sh` (ensayo: valida y lista los **nombres** de los secretos, nunca valores) y luego `bash scripts/voz/desplegar-worker.sh --ejecutar`: crea la app,
   sube los secretos por entrada estándar y despliega **una sola máquina** siempre encendida en Dallas. Comprueba: `fly checks list -a atiende-voice-worker` (salud en 200) y
   `fly logs -a atiende-voice-worker` (busca `worker_escuchando`). Si algo falta, `/salud` da 503 con los **nombres** de las variables.
7. **Una llamada directa al número puente** y mira en los logs `sip_atributos`: debe listar `sip.phoneNumber`, `sip.trunkPhoneNumber` (y, en un desvío, `sip.h.diversion` o `sip.h.history-info`).
   Si los nombres difieren, `apps/voice-worker/src/telefonia/sip-atributos.ts` es el único lugar a ajustar.
8. **Las 5 llamadas de prueba** (directas al número puente, desde un celular tuyo) y qué revisar en cada una:

   | Llamada | Qué revisar |
   |---|---|
   | 1. Pedido a domicilio completo | **Caller ID:** en los logs no aparece `telefono_no_confiable`; **pedido creado** en Pedidos con origen *voz*; **Cliente 360:** el cliente existe y `order_count` sube en 1 |
   | 2. Pedido para recoger | Pedido creado; comanda en el POS (si el outbox de SoftRestaurant está activo) |
   | 3. Queja / pedir persona | Conversación `escalado` con callback visible en Agente de voz > Conversaciones |
   | 4. DTMF `0` | Pasa a una persona; callback creado |
   | 5. Colgar a media llamada | Conversación cerrada como `abandonado` y sin pedido huérfano |

   Después de las 5: en Agente de voz > Indicadores revisa **latencia** (objetivo p95 < 1.5 s, p50 < 0.8 s), **costo por llamada** (`core.usage_cost_event` con `costo_estimado = false`: es el real de Gemini) y, **una vez en
   `desborde`**, el KPI de **ventas recuperadas**. Con `modoEntrada: "prueba"` las llamadas de prueba no cuentan ahí, a propósito. Pon `VOICE_REQUIRE_CALL_TOKEN=true` en Vercel.
9. **Desvío condicional con la compañía** (sección 4), solo en el horario valle, y vigila Indicadores 3 días (métricas y rollback: `docs/VOZ-PM.md` sección 7).
10. Si pasan, amplía el horario y después T8, T1, T2 y T3, una por una (un número puente y una fila de `VOICE_DNIS_MAP` por sucursal; pasa LiveKit al plan Ship).

## 4. Desvío condicional: guion para pedírselo a la compañía telefónica

Lo contrata y lo verifica **PM (titular de la línea)** con su compañía; los códigos de abajo salen de fuentes secundarias y **no están verificados en el sitio de Telmex**. La compañía confirma
códigos, costo y si el desvío a un número fijo (o a un 800) entra en el paquete de llamadas ilimitadas.

> «Quiero activar el desvío de llamadas **cuando no contestan** (a los 20 segundos) y **cuando la línea está ocupada** de la línea XXX-XXXX hacia el número +52 XXX XXX XXXX. Necesito
> el desvío **condicional**, no el total, y saber: (1) cuál es el código de activación y de cancelación para cada caso; (2) cuánto cuesta por mes y por llamada desviada; (3) si el
> tramo desviado lo paga la línea de la sucursal; (4) si al número que recibe la llamada le llega el **número del cliente** o el de la sucursal.»

| Compañía | Códigos reportados (confirmar con la compañía) |
|---|---|
| Telmex fija, servicio "Sígueme" | `*61*número` no contesta (~20 s), `*67*número` ocupado, `*21*número` todas; cancelar con `#21#` (aprox. MXN 29.87 al mes por línea, con varias líneas más) |
| Telcel | `**61*número#` no contesta, `**67*número#` ocupado, `**62*número#` apagado; cancelar con `##002#` |
| Izzi, Totalplay, conmutador IP (Grandstream, Yeastar, 3CX) | "Desvío de llamadas" / desvío por ocupado o sin respuesta hacia un número externo por su troncal; pregunta a PM si tienen conmutador IP (el SIP directo conserva el caller ID original) |

**Caller ID tras el desvío: no verificado para México.** Si la compañía re-origina la llamada, el puente puede recibir el número de la sucursal. El worker ya lo trata como «sin teléfono confiable»: el agente pide el
teléfono al cliente, se lo repite y lo confirma antes de tomar el pedido, y solo entonces se emite el token. En la **primera llamada desviada real**:
1. Mira en los logs `telefono_no_confiable` (con `motivo` y `desviada`): si no aparece, el caller ID del cliente sí llega; si aparece con `numero_sucursal` o `numero_de_desvio`, se confirma que la red re-origina.
2. Mira `sip_atributos` para ver si llegan `sip.h.diversion` o `sip.h.history-info`.
3. En Twilio (Monitor > Logs > Calls) revisa el `From` de la llamada entrante.

## 5. Cómo apagarlo en 1 minuto (de menos a más drástico; ninguno borra pedidos ni conversaciones)

1. **Quitar el desvío** marcando desde la línea el código de cancelación de la compañía (Telmex: `#21#`). Efecto inmediato: el teléfono vuelve a sonar solo en la sucursal.
2. **Apagar el agente:** Agente de voz > "Agente habilitado" en off (la sucursal responde con el pregrabado de desborde y deja callback).
3. **Parar el worker:** `fly scale count 0 -a atiende-voice-worker` (para volver: `fly scale count 1 -a atiende-voice-worker`).
4. **Quitar la llave:** `fly secrets unset GEMINI_API_KEY -a atiende-voice-worker` y `! vercel env rm GEMINI_API_KEY production`.

## 6. Tope mensual sugerido (cálculo)

El gasto que cuenta contra el tope es el de **Gemini** (el que el worker registra en `core.usage_cost_event`, categoría `voz`); Twilio, LiveKit y Fly se facturan aparte (~US$0.02 por minuto de infraestructura).
Costo de Gemini por llamada con la facturación compuesta (cada turno vuelve a cobrar el audio acumulado): **bajo US$0.091, medio US$0.172, alto US$0.423** (`packages/voice-core/src/costo-gemini.ts`).

| Etapa | Llamadas al mes | Gemini medio (rango) | Tope sugerido | Por qué |
|---|---|---|---|---|
| Piloto T7 | ~300 | US$52 (31-97) | **US$100** (`VOICE_TOPE_MENSUAL_USD=100`) | ~2x el medio y justo sobre el alto: corta un descontrol, no un mes caro; el aviso in-app sale al 80 % (US$80) |
| PM completo, 5 sucursales en desborde | ~3,000 | US$518 (311-973) | **US$750** | ~1.45x el medio; el aviso al 80 % (US$600) deja margen para revisar antes del corte |
| Por llamada | — | US$0.17 | **US$0.50** (`VOICE_COSTO_MAX_LLAMADA_USD`) | ~3x una llamada media y por encima del caso alto; antes eran US$0.10, que cortaba una llamada media a la mitad |

Ajusta con la **primera factura**: compara `core.usage_cost_event` (`costo_estimado = false`) con la factura de Gemini. `usageMetadata` viene **por turno** (verificado con la medición cruda de 7 llamadas: cada mensaje trae todo el contexto del turno), así que `usoReportado` se queda en `"por_turno"`. Si aun así
hay una diferencia grande, revisa primero el desglose por modalidad y los tokens sin desglose (se cobran a tarifa de audio) antes de tocar `usoReportado`. El nivel 2 de la Gemini API aguanta unas 40 llamadas simultáneas por su tope de gasto de US$50 por
10 minutos; con más carga, nivel 3 o Vertex.

## 7. Meta (WhatsApp): confirma el método de pago

Desde el **1-oct-2026** Meta cobra los mensajes de servicio de WhatsApp en México (US$0.0085 por mensaje a partir del 1,001 de cada número al mes; unos US$30 al mes para PM). Según los proveedores,
**sin método de pago en la cuenta de Meta esos mensajes dejan de entregarse**. Confirma en Meta Business > Facturación y pagos que la cuenta de Atiende tiene un método de pago activo. La página de
desarrolladores de Meta todavía dice que son gratis (contradicción sin resolver) y la política de precios para proveedores de IA (vigente desde 16-feb-2026) está **sin verificar**.

## 8. Qué NO está verificado (se confirma con la primera llamada real)

- El protocolo de Gemini Live con la API real: idioma por instrucción, VAD (`silenceDurationMs` 500 ms y sensibilidad de fin alta: **si corta a clientes que hacen pausas, sube `VOICE_VAD_SILENCIO_MS` a 700-800**),
  la forma de `usageMetadata` (por turno o acumulada) y que `temperature: 0` sea aceptada.
- Latencia: hoy p50 1.74 s / p95 3.43 s medidos **por texto**; el objetivo (p50 < 0.8 s) solo se mide con audio real de punta a punta. Lo que sí se redujo está en el PR (arranque de la llamada, lecturas en paralelo, VAD).
- El caller ID y los encabezados `Diversion`/`History-Info` desde la red mexicana, los códigos y costos de desvío de cada compañía, la disponibilidad de números 999 en Twilio.
- El binario nativo de LiveKit dentro de la imagen de Linux, el adaptador de LiveKit contra un servidor real y el adaptador de Vertex AI.
- El turno del cliente (`x-atiende-call-turn`) **no se reenvía** a la API desde el worker (comportamiento heredado): la defensa «no confirmar en el mismo turno que se cotiza» no actúa en telefonía. Activarlo exige comprobar con una
  llamada real que la transcripción de entrada de Gemini llega antes de la herramienta.
