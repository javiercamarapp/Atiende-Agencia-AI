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

## Cerebro «suelto» (`VOZ_CEREBRO=suelto`)

Por omisión (`VOZ_CEREBRO` ausente o `actual`) nada cambia: Gemini Live / cascada con el LLM y las herramientas de este monorrepo. Con `VOZ_CEREBRO=suelto` el
CEREBRO es la Edge Function `voz-turno` del repo suelto (atiende-restaurantes): el worker conserva telefonía (LiveKit/Twilio), Deepgram STT/TTS y el puente de audio, pero **no usa
LLM ni herramientas propias**; manda lo que dijo el cliente y habla lo que regresa el servidor. Contrato: `docs/agente-voz/CONTRATO-HERRAMIENTAS.md` y `RUNBOOK-VOZ.md` del repo suelto.
Solo corre la cascada propia (escalón `cascada-v2`); Gemini Live y OpenRouter no se usan en este modo.

| Variable | Obligatoria con `suelto` | Qué es |
|---|---|---|
| `VOZ_CEREBRO` | no | `actual` (por omisión) o `suelto` |
| `VOZ_TURNO_URL` | sí (o `SUPABASE_URL`) | URL completa de la función, `${SUPABASE_URL}/functions/v1/voz-turno`. Con solo `SUPABASE_URL` se arma sola |
| `VOZ_TURNO_SECRET` | sí | Secreto de `voz-turno` (header `x-voz-turno-secret`). Mismo valor que en las variables de la Edge Function; nunca en el repo ni en logs |
| `DEEPGRAM_API_KEY` | sí | STT y TTS de la cascada propia |
| `VOZ_TURNO_SILENCIO_MS` | no | Silencio antes de mandar `[silencio]` (3000-30000; por omisión 8000) |
| `VOZ_TURNO_TIMEOUT_MS` | no | Tiempo máximo de una petición (30000-60000; por omisión 35000; el contrato pide >= 30 s) |
| `VOICE_TOOL_SECRET` | **sí para operar** (el worker arranca sin él, pero registra la advertencia `config_advertencia` / `voice_tool_secret_ausente`) | Secreto de las herramientas sueltas (header `x-atiende-tool-secret`) para `registrar-contacto`: con él, cuando el worker dice «una persona le devolverá la llamada» por una falla (error técnico, 409 agotado, 400/401/409 de bug, tope por 429 con Retry-After largo) deja el aviso en el servidor. Sin él solo queda el log `aviso_devolver_llamada_no_configurado` y nadie devuelve la llamada. Con número oculto y sin teléfono confirmado no hay a dónde devolver la llamada: el worker dice «por favor vuelva a llamar o escríbanos por WhatsApp» y no registra aviso |
| `VOZ_REGISTRAR_CONTACTO_URL` | no | URL de `registrar-contacto`; por omisión se deriva de `VOZ_TURNO_URL` (`.../voz-turno` → `.../registrar-contacto`) |
| `VOZ_AVISO_GRABACION` | no | Aviso de grabación que dice el worker MISMO con número oculto; debe coincidir con `AVISO_VOZ_INICIAL` del servidor |

Qué hace el worker en este modo (`src/cerebro-voz-turno.ts`, `src/cerebro-suelto.ts`):

- `seq` por llamada: apertura `seq 0` con texto vacío (el disparador del saludo se traduce a ella), turnos `1..n`; el mismo `seq` en todos los reintentos de un turno; apertura repetida con `seq_ultimo` continúa desde `seq_ultimo + 1`.
- 5xx / red / tiempo agotado: un reintento del mismo `seq`; si falla otra vez, «problema técnico, una persona le devolverá la llamada» y cuelga.
- Barge-in: interrumpir al agente solo corta el audio; la petición HTTP en vuelo **no se aborta** (el servidor la sigue procesando y puede haber creado el pedido). El texto nuevo espera la respuesta del turno anterior, la habla y recién entonces se manda como `seq + 1` (así no hay 409 y el cliente oye el total/la confirmación).
- 409 «en proceso»: el primero espera 0.7 s y reintenta sin decir nada; luego «Un momento, por favor» y reintento del mismo `seq` cada 2 s hasta 65 s reales (luego «una persona le devolverá la llamada» y cuelga). Otros 409 y 400/401 son bugs: no se reintentan.
- Cuando se cuelga con «una persona le devolverá la llamada» por una falla, el worker registra el aviso en `registrar-contacto` (motivo `otro`, `conversation_id` = call_id; idempotente y una sola vez por llamada, también en el cierre `tope`, porque el cupo por teléfono no lo registra el servidor; sin bloquear el colgado). Es un aviso `otro` sin sucursal ni alerta inmediata: llega a la bandeja y al cron de avisos. Un 401 de ese endpoint deja el evento `aviso_devolver_llamada_config_rota` (secreto mal configurado). Tras cualquier cierre se cuelga a más tardar 20 s después aunque la síntesis no avise que terminó.
- 429: `Retry-After` <= 5 s espera y repite; > 5 s dice «Por ahora no puedo atenderle; una persona le devolverá la llamada» y cuelga. 503 con `fin:true` habla y cuelga; 503 sin `fin` reintenta.
- Relleno «Un momento, por favor» si el servidor tarda ~4 s y, en esperas largas, otra frase cada ~15 s (máximo 3). Tras un tiempo agotado el segundo intento del mismo `seq` espera 20 s. `[silencio]` tras ~8 s sin voz (una vez por episodio; no mientras hay un turno en curso); el servidor decide el «¿sigue ahí?» y el cierre.
- `fin:true` => hablar y colgar. Con `pedido_id` y una despedida del modelo (sin pregunta), el worker cuelga él mismo. Resultado de la conversación: `pedido_creado` con el `pedido_id`.
- Número oculto o de la sucursal: el worker dice el aviso de grabación, pide el teléfono, lo repite en grupos y, con el «sí», lo valida (nunca un número puente/sucursal; tampoco uno que empiece con 0 o 1 ni de un solo dígito repetido; la validación es local, no emite token) y **recién entonces** abre (`seq 0`) con `aviso_dado: true` para que el servidor salude corto sin repetir el aviso (si el servidor aún no lo soporta y lo repite, el worker quita el aviso y el preámbulo conocidos). Un `call_id` de menos de 6 caracteres se rellena (`llamada_<id>`) en vez de fallar. Tres fallos o dos silencios: devolver la llamada y colgar.
- Este modo no guarda la transcripción en la base del worker (vive en `voz_hilos` del servidor, con su retención) ni pide el consentimiento de grabación por su cuenta (lo cubre el aviso). La guardia de «quiero una persona» del worker sigue activa.
- Logs solo con códigos, conteos y ms (`eventoSinPII`); nunca texto, teléfono ni secreto.

**Costo:** el costo por llamada que calcula el worker (STT/TTS/telefonía) **no incluye el costo del modelo** de `voz-turno`: ese gasto ocurre en el servidor (repo suelto, `voz_hilos` / sus propios contadores y topes de turnos) y no se suma a `costoMicroUsd` del worker ni cuenta contra su tope mensual ni `VOICE_COSTO_MAX_LLAMADA_USD`. Revísalo en el servidor.

Pendiente para una llamada real: cuenta/proyecto de LiveKit y número (Twilio), `DEEPGRAM_API_KEY`, desplegar `voz-turno` y aplicar la migración `voz_hilos` en el Supabase vivo, crear `VOZ_TURNO_SECRET`, desplegar el worker en Fly con estas variables, y probar con llamadas supervisadas. Nada de esto se ha probado contra proveedores reales (solo dobles).

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
