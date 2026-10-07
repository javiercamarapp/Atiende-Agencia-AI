# @atiende/voice-worker — worker de telefonía de voz (restaurantes)

Proceso de **larga vida** (Node) que atiende las llamadas reales de Los Taquitos de PM: recibe el SIP de LiveKit, puentea el audio y conduce el
`ControladorLlamada` que ya vive en `@atiende/domain-restaurantes` / `@atiende/voice-core`. Una llamada termina creando el pedido y el cliente con el
**mismo motor** que WhatsApp y el storefront (`invokeAgentTool` → `createOrder` → `upsertCustomer`). **No usa ElevenLabs.** Vercel no sirve para esto
(audio continuo por WebSocket): vive en un host de procesos largos (ver «Dónde vive el proceso»).

## Estado honesto

| Pieza | Estado |
|---|---|
| Lógica de la llamada (DNIS, token, privacidad, escalera, puente de audio, cierre con costo y latencia) | Hecha y probada de punta a punta **sin red** (telefonía falsa + proveedor guionado + la API real en proceso) |
| Adaptador `LiveKitTelefonia` (`@livekit/rtc-node`) | Compila contra el SDK oficial; la lectura de atributos SIP está probada. **No se ha probado contra un servidor LiveKit real** (no hay cuenta ni número) |
| Protocolo de Gemini Live y TTS/STT de OpenRouter | Heredados de `voice-core`: probados contra dobles, **no** contra las APIs reales |
| Imagen Docker | Receta escrita; **no construida** en esta máquina |
| Audios pregrabados | El generador está probado con `fetch` falso; **los 15 WAV no existen todavía** (los genera Javier con su llave, una sola vez) |

Sin configuración completa el worker **arranca igual**, registra los motivos (nombres de variables, nunca valores), responde **503 en `/salud`** y **no
contesta llamadas**: nunca atiende a medias.

## Cómo funciona una llamada

1. LiveKit crea una sala por llamada (regla de despacho SIP con prefijo `llamada-`); el worker la encuentra, entra y se suscribe al audio del llamante.
2. **DNIS → sucursal**: el número marcado (`sip.trunkPhoneNumber`) se busca en `VOICE_DNIS_MAP`. Un número desconocido se cuelga sin tocar nada.
3. **Teléfono** del llamante solo del SIP From (`extraerTelefonoSipFrom`). Un llamante **anónimo** no obtiene token ni herramientas: se le dice el
   pregrabado de persona y la conversación queda cerrada como `escalado` para que el personal la vea (hueco de producto: no hay a dónde devolver la llamada).
4. `POST /internal/restaurantes/voz/llamada/contexto` (secreto interno): interruptor de la sucursal, instrucción del agente (perfil de PM + sucursal marcada)
   y gasto de voz del mes. `POST .../voice/call-token` (secreto de la sucursal): el token por llamada; el modelo nunca decide el teléfono ni la sucursal.
5. `evaluarInicioLlamada`: si la sucursal está **deshabilitada** (`voz_config.habilitado = false`) o el gasto del mes alcanzó el **tope mensual**, no se abre
   sesión con el proveedor: se dice el pregrabado (`saludo_respaldo_*` según la hora de Mérida, o `tope_mensual`) y se deja un callback.
6. **Aviso de privacidad** (migración 030): el worker pide el guion de apertura (`privacidad/apertura`, que además guarda la evidencia de entrega) y le pide al
   agente decirlo tal cual; la primera respuesta clara del cliente sobre la grabación se manda a `consentimiento-grabacion`. Sin un «sí» claro la llamada se
   atiende **sin guardar la transcripción** (lo hace cumplir la base).
7. Escalera Gemini Live → cascada OpenRouter → persona/buzón (`crearEscaleraPlataforma`). Si un escalón cae a media llamada, el siguiente continúa **sin volver a
   saludar** (recibe un resumen redactado de lo dicho).
8. Al colgar: se registran los turnos, el **costo por escalón** (`core.usage_cost_event`, calculado en el servidor desde los tramos), la **latencia de voz a voz**
   por respuesta (evento `latencia_voz`) y el cierre de la conversación. Si el proceso muere antes de cerrar, el barrido de llamadas huérfanas de la API (QA lote C,
   PR #415) cierra la conversación: **no se duplica aquí**.

Logs solo con `eventoSinPII` (lista cerrada de campos; la llamada se correlaciona por un hash opaco). Nunca se registra texto del cliente, teléfono, nombre ni dirección.

## Variables de entorno

| Variable | Obligatoria | Qué es |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | sí | Proyecto de LiveKit (Cloud o autoalojado) |
| `ATIENDE_API_URL` | sí | URL base de la API de Atiende (la del despliegue en Vercel) |
| `INTERNAL_SECRET` | sí | El mismo de la API: registra conversaciones, costos y contexto |
| `GEMINI_API_KEY` y/o `OPENROUTER_API_KEY` | al menos una | Escalón 1 (Gemini Live) y/o escalón 2 (cascada, misma llave del texto) |
| `VOICE_DNIS_MAP` | sí | JSON `{ "<número>": { "orgSlug", "organizationId", "propertyId", "branchSlug", "secretoEnv", "topeMensualUsd"?, "modoEntrada"? } }`. `secretoEnv` **nombra** la variable que trae el secreto de la sucursal (nunca va en el JSON) |
| `<secretoEnv>` | sí, una por sucursal | Secreto de la sucursal (`POST /v1/restaurantes/:propertyId/admin/config/sucursales/:branchId/voz/secreto`, se muestra una vez) |
| `VOICE_TOPE_MENSUAL_USD` | no | Tope de gasto de voz **de plataforma** por organización y mes. Sin valor no hay tope. Un `topeMensualUsd` en la tabla DNIS lo sobreescribe por organización |
| `VOICE_ROOM_PREFIX` | no | Prefijo de las salas SIP (por defecto `llamada-`) |
| `VOICE_ASSETS_DIR` | no | Carpeta de los pregrabados (por defecto `assets/`) |
| `PORT` | no | Puerto de `/salud` (por defecto 8080) |

Ejemplo (sin valores reales):

```
VOICE_DNIS_MAP={"+529990000000":{"orgSlug":"los-taquitos-de-pm","organizationId":"<uuid>","propertyId":"<uuid>","branchSlug":"fco-montejo","secretoEnv":"VOICE_SECRET_FCO","modoEntrada":"desborde"}}
VOICE_SECRET_FCO=<secreto de la sucursal>
```

`modoEntrada`: `desborde` (desvío condicional del conmutador: toda llamada que llega es una que el personal no contestó), `total` o `prueba`. Si la llamada trae un
encabezado de desvío (`Diversion` / `History-Info`) se marca `desborde` (salvo `prueba`). Alimenta el KPI «ventas recuperadas» del panel de voz.

## Pasos para la primera llamada real (decisiones y credenciales de Javier)

1. Decidir **dónde vive** el proceso (abajo). No se contrata nada sin su OK.
2. Generar los pregrabados: `OPENROUTER_API_KEY=... npm run voz:pregrabados -- --tope-usd=0.25` y **escuchar los 15 audios** (`assets/`). Es una sola vez.
3. Twilio: número mexicano + Elastic SIP Trunk → LiveKit inbound trunk; LiveKit: regla de despacho **individual** con `roomPrefix: "llamada-"` y los encabezados SIP
   como atributos (para leer el desvío). Detalle de Twilio/LiveKit: `docs/VOZ-PM.md` §3 y §6.
4. Crear el secreto de la sucursal y llenar `VOICE_DNIS_MAP`; poner `VOICE_REQUIRE_CALL_TOKEN=true` en la API cuando se compruebe que el worker pide su token.
5. Arrancar el worker y comprobar `GET /salud` → 200; hacer las 5 llamadas de prueba de `docs/VOZ-PM.md` §6 paso 8.
6. Confirmar contra la primera llamada real los nombres de los atributos SIP (`sip.phoneNumber`, `sip.trunkPhoneNumber`, `sip.h.*`) y el protocolo de Gemini Live.

## Dónde vive el proceso (decisión de Javier)

Es un proceso Node normal que **consulta las salas** de LiveKit y entra a las de su prefijo; no usa el framework `@livekit/agents`. Corre en cualquier host de
procesos largos con **1 instancia mínima siempre encendida**:

- **Contenedor propio** (Fly.io, Railway, Cloud Run con instancia mínima 1, ECS o un VPS): `docker build -f apps/voice-worker/Dockerfile -t atiende-voice-worker .`
  desde la raíz. La imagen es una receta sin verificar.
- **Despliegue de agentes de LiveKit Cloud** (mismo proveedor ya elegido): exige envolver `atenderLlamada` en un entrypoint de `@livekit/agents` (un job por sala
  en vez del sondeo). **No está construido**; es un paso corto, pero requiere cuenta y costo nuevos.

Mientras se decide, todo se prueba sin host: `npx vitest run apps/voice-worker --maxWorkers=2`.

## Comandos

```
npm run bundle -w @atiende/voice-worker     # dist/main.mjs (los SDK de LiveKit quedan fuera; dist/package.json fija sus versiones)
npm run start  -w @atiende/voice-worker     # node dist/main.mjs
npm run voz:pregrabados -- --tope-usd=0.25  # desde la raíz: genera assets/*.wav una sola vez
npx vitest run apps/voice-worker --maxWorkers=2
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-voz-worker   # SQL contra Postgres real
```

## Huecos conocidos

- Latencia **por llamada** (p50/p95 de una conversación) solo queda en el log y como eventos ligados a la conversación; la vista por llamada en Conversaciones es el
  siguiente paso. El KPI por día sí está en el panel.
- Los costos del escalón de Gemini usan el precio de lista por minuto (`VOZ_PLATAFORMA`); se concilian contra la factura en otra tarea.
- No se detecta ruido ni «no entendido» desde el audio (la máquina los admite, pero nadie los emite todavía); el silencio, el reloj, el barge-in y el DTMF sí.
- WhatsApp Calling API como segundo canal de voz: idea de los informes 13/18, **no se construyó**.
