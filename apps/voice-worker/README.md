# @atiende/voice-worker — worker de telefonía de voz (restaurantes)

Proceso de **larga vida** (Node) que atiende las llamadas reales de Los Taquitos de PM: recibe el SIP de LiveKit, puentea el audio y conduce el
`ControladorLlamada` que ya vive en `@atiende/domain-restaurantes` / `@atiende/voice-core`. Una llamada termina creando el pedido y el cliente con el
**mismo motor** que WhatsApp (`invokeAgentTool` → `createOrder` → `upsertCustomer`). **No usa ElevenLabs.** Vercel no sirve para esto
(audio continuo por WebSocket): vive en un host de procesos largos (ver «Dónde vive el proceso»).

## Estado honesto

| Pieza | Estado |
|---|---|
| Lógica de la llamada (DNIS, token, privacidad, escalera, puente de audio, cierre con costo y latencia) | Hecha y probada de punta a punta **sin red** (telefonía falsa + proveedor guionado + la API real en proceso) |
| Adaptador `LiveKitTelefonia` (`@livekit/rtc-node`) | Compila contra el SDK oficial; la lectura de atributos SIP está probada. **No se ha probado contra un servidor LiveKit real** (no hay cuenta ni número) |
| Protocolo de Gemini Live y TTS/STT de OpenRouter | Heredados de `voice-core`: probados contra dobles, **no** contra las APIs reales |
| Imagen Docker | Etapas **replicadas con node** (`npm ci --workspace` + bundle de ~396 kB + instalación de runtime + arranque con `/salud` 503); sin `docker build` (daemon apagado); el binario nativo de LiveKit para Linux no se verificó |
| Despliegue | `fly.toml` (Dallas, una máquina siempre encendida, latido en `/salud`) y `scripts/voz/desplegar-worker.sh` (ensayo por omisión), probados contra un `fly` falso; **sin cuenta de Fly no se ha desplegado** |
| Audios pregrabados | Generador y verificador (`--verificar`) probados con `fetch` falso; **los 15 WAV no existen todavía** (los genera Javier con su llave, una sola vez; viven en `assets/*.wav`, ignorados por git, y viajan en la imagen) |

Sin configuración completa el worker **arranca igual**, registra los motivos (nombres de variables, nunca valores), responde **503 en `/salud`** y **no
contesta llamadas**: nunca atiende a medias.

## Cómo funciona una llamada

1. LiveKit crea una sala por llamada (regla de despacho SIP con prefijo `llamada-`); el worker la encuentra, entra y se suscribe al audio del llamante.
2. **DNIS → sucursal**: el número marcado (`sip.trunkPhoneNumber`) se busca en `VOICE_DNIS_MAP`. Un número desconocido se cuelga sin tocar nada.
3. **Teléfono** del llamante solo del SIP From (`extraerTelefonoSipFrom`) y solo si es **confiable** (`telefono-llamante.ts`): un From vacío, anónimo o que es un número puente, una línea de la sucursal
   (`numerosSucursal`) o el número del encabezado de desvío (`Diversion` / `History-Info`) NO es del cliente (un desvío puede re-originar la llamada). En ese caso no se emite token: el agente **pide el
   teléfono, lo repite en grupos y lo registra** con `confirmar_telefono_llamante` (herramienta solo del worker, una vez por llamada; mientras tanto ninguna otra herramienta corre); recién entonces se emite el token.
4. `POST /internal/restaurantes/voz/llamada/contexto` (secreto interno): interruptor de la sucursal, instrucción del agente (perfil de PM + sucursal marcada, con las reglas H1-H18 al final)
   y gasto de voz del mes. Después, **en paralelo**: la conversación, el aviso de privacidad y `POST .../voice/call-token` (secreto de la sucursal: el token por llamada). El modelo nunca decide la sucursal;
   el teléfono sale del From confiable o de lo que el cliente dicta y confirma. Modo de entrada y aviso de tope corren en segundo plano (no retrasan el saludo: el arranque bajó de ~800 a ~335 ms con 150 ms por viaje).
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
| `VOICE_COSTO_MAX_LLAMADA_USD` | no | Tope de costo por llamada (por omisión US$0.50; máximo 20). El costo es el REAL de `usageMetadata` |
| `VOICE_VAD_SILENCIO_MS`, `VOICE_VAD_SENSIBILIDAD_FIN` | no | VAD de Gemini: silencio que cierra el turno (100-3000, por omisión 500) y sensibilidad de fin (`alta`, `baja`, `omitir`) |
| `GEMINI_BACKEND`, `VERTEX_PROJECT`, `VERTEX_LOCATION`, `VERTEX_SERVICE_ACCOUNT_JSON` | no | `GEMINI_BACKEND=vertex` mueve el escalón 1 a Vertex AI (cuenta de servicio; sin verificar; **no activar** hasta ~10 restaurantes) |
| `VOICE_DNIS_MAP` | sí | JSON `{ "<número>": { "orgSlug", "organizationId", "propertyId", "branchSlug", "secretoEnv", "topeMensualUsd"?, "modoEntrada"?, "numerosSucursal"? } }` (`numerosSucursal`: líneas de la sucursal que desvían al puente). `secretoEnv` **nombra** la variable que trae el secreto de la sucursal (nunca va en el JSON) |
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

## Pasos para la primera llamada real

Todo el recorrido, con cada llave, comando y verificación, está en **`docs/VOZ-ACTIVACION.md`** (checklist «pega aquí»). Resumen: pregrabados (`npm run voz:pregrabados`, luego `-- --verificar`) -> prueba ciega
contra Gemini real -> `npm run voz:livekit` y `npm run voz:twilio` (ensayo y `--ejecutar`) -> `VOICE_DNIS_MAP` -> `bash scripts/voz/desplegar-worker.sh --ejecutar` -> 5 llamadas de prueba -> desvío condicional.

## Dónde vive el proceso

Es un proceso Node normal que **consulta las salas** de LiveKit y entra a las de su prefijo; no usa el framework `@livekit/agents`. **Decisión: Fly.io, región `dfw`**, **una sola máquina siempre encendida**
(`fly.toml`: sin servicio HTTP público, reinicio siempre, health check de `/salud`). Dos instancias tomarían la misma sala: el script despliega con `--ha=false`. `/salud` da 200 solo si el worker está configurado
**y** el último sondeo de LiveKit es de hace menos de 60 s; si el sondeo lleva 2 minutos mudo y no hay llamadas, el proceso sale con error y Fly lo reinicia (las health checks de Fly solo informan).

- Despliegue: `bash scripts/voz/desplegar-worker.sh` (ensayo) y `--ejecutar`. Los secretos viajan por entrada estándar a `fly secrets import`, nunca como argumentos.
- Otros hosts de contenedor (Railway, Cloud Run con instancia mínima 1) sirven con `docker build -f apps/voice-worker/Dockerfile -t atiende-voice-worker .` desde la raíz.
- Si algún día se migra a Vertex, Cloud Run en `us-central1` queda junto al modelo.

## Comandos

```
bash scripts/voz/desplegar-worker.sh        # ensayo del despliegue en Fly (--ejecutar para aplicar)
npm run voz:livekit / npm run voz:twilio    # idempotentes; ensayo por omisión, --ejecutar para aplicar
npm run voz:pregrabados -- --verificar      # comprueba los 15 WAV sin llave ni costo
npm run bundle -w @atiende/voice-worker     # dist/main.mjs (los SDK de LiveKit quedan fuera; dist/package.json fija sus versiones)
npm run start  -w @atiende/voice-worker     # node dist/main.mjs
npm run voz:pregrabados -- --tope-usd=0.25  # desde la raíz: genera assets/*.wav una sola vez
npx vitest run apps/voice-worker --maxWorkers=2
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-voz-worker   # SQL contra Postgres real
```

## Huecos conocidos

- Latencia **por llamada** (p50/p95 de una conversación) solo queda en el log y como eventos ligados a la conversación; la vista por llamada en Conversaciones es el
  siguiente paso. El KPI por día sí está en el panel.
- El costo del escalón de Gemini sale de `usageMetadata` (real, `costo_estimado = false`); su forma (por turno o acumulada) está **sin verificar** y se concilia contra la primera factura (`docs/VOZ-ACTIVACION.md`, sección 6).
- El turno del cliente (`x-atiende-call-turn`) no se reenvía a la API: la defensa «no confirmar en el mismo turno que se cotiza» no actúa en telefonía (hallazgo; activarlo exige una llamada real).
- No se detecta ruido ni «no entendido» desde el audio (la máquina los admite, pero nadie los emite todavía); el silencio, el reloj, el barge-in y el DTMF sí.
- WhatsApp Calling API como segundo canal de voz: idea de los informes 13/18, **no se construyó**.
