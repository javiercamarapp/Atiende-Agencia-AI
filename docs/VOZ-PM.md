# Voz de Los Taquitos de PM (restaurantes): LiveKit + Gemini Live

Decisión de Javier (1-oct-2026): la voz de PM corre con **Gemini 3.8 Live** sobre telefonía **LiveKit SIP + Twilio**. La
escalera de degradación es **Gemini 3.8 Live -> gpt-live-1 -> persona / buzón con callback**. Este documento es solo de restaurantes
(hoteles y citas tienen su propio agente sobre `packages/voice-core`).

> Honestidad primero: este runbook separa lo que **ya está en el repo y probado** de lo que **falta para recibir la primera llamada real**.
>
> **Para encender la voz, empieza por `docs/VOZ-ACTIVACION.md`** (checklist «pega aquí» con cada llave, el orden de activación, el guion del desvío, las 5 llamadas de prueba, cómo apagarlo y el tope
> mensual). Este documento es la referencia de diseño.

## 1. Qué hay y qué falta

| Pieza | Estado | Dónde |
|---|---|---|
| Registro único de herramientas (WhatsApp y voz) con máquina de estados del pedido (cotizado -> confirmado -> creado) | Hecho (ya en main) | `packages/domain-restaurantes/src/agent-tools/` |
| Token por llamada firmado (caller ID del SIP From, sucursal, callId), secretos por sucursal, bitácora | Hecho (ya en main) | `apps/api/src/voice-call-token.ts`, `.../restaurantes/voice-auth.ts` |
| Núcleo de la llamada: máquina de estados con barge-in, silencio, ruido, DTMF, límites de duración/costo, reanudación, escalada | Hecho en este PR | `packages/voice-core/src/llamada/` (esqueleto compartido, extraido de restaurantes) |
| Sesión de llamada con Gemini Live (WebSocket, herramientas, transcripciones, reanudación) | Hecho; protocolo corregido con la investigación del 4-oct (idioma por instrucción, sin `thinkingLevel`, VAD afinado, costo real por `usageMetadata`, adaptador de Vertex AI listo y sin activar); **sigue sin verificarse contra la API real** | `packages/voice-core/src/llamada/gemini-live-sesion.ts` |
| Simulador local de llamadas + prueba ciega es-MX (21 guiones, 11 graders), en CI contra el proveedor falso | Hecho en este PR | `.../voz/simulador/`, `tests/voz-simulador-*.spec.ts` |
| Corrida de la prueba ciega contra Gemini real (manual) | Hecho en este PR; **sin ejecutar (no hay `GEMINI_API_KEY` en este entorno)** | `npm run evals:voz:real -w @atiende/domain-restaurantes` |
| Llamada de prueba desde el panel (orbe, token efímero, estado honesto) | Hecho en este PR; **sin probar en un navegador con credencial real** | `apps/web/src/verticals/restaurantes/voz/` |
| Mensajes pregrabados | Textos listos; generador (`npm run voz:pregrabados`) y verificador (`-- --verificar`) probados con `fetch` falso; **los WAV no se han generado** (los genera Javier con su llave, una vez; viven en la imagen del worker, ignorados por git) | `.../voz/llamada/mensajes.ts`, `scripts/voz-pregrabados.ts` |
| **Worker de telefonía** (proceso de larga vida que recibe el SIP de LiveKit, puentea el audio y conduce `ControladorLlamada`) | Hecho en este PR y probado de punta a punta **sin red** (telefonía falsa + proveedor guionado + la API real en proceso); el adaptador de LiveKit compila pero **no se probó contra un servidor real**; la imagen Docker se verificó replicando sus etapas con node (sin daemon). **Dónde corre: Fly.io `dfw`** (`apps/voice-worker/fly.toml`, `scripts/voz/desplegar-worker.sh`; sin cuenta, no se ha desplegado) | `apps/voice-worker` (README propio), ADR-PM-001 |
| Adaptador de gpt-live-1 | **NO existe**: solo el contrato (`VoiceAgentProvider.abrirLlamada`) y el `FakeVoiceProvider` | |
| Tope mensual de gasto de voz | Lectura del gasto del mes: hecha (`restaurantes.voz_gasto_mes_micro_usd`, migración 067, suma `core.usage_cost_event` de categoría `voz`). Tope: de plataforma (`VOICE_TOPE_MENSUAL_USD`, sin valor = sin tope) con sobreescritura por organización en la tabla DNIS del worker (`topeMensualUsd`). **Sin tabla de topes por organización**: guardarlos en la base para editarlos desde el panel es el siguiente paso | `apps/voice-worker/src/config.ts` |

Con el worker construido, el agente de voz atiende llamadas telefónicas **en cuanto Javier lo despliega y conecta Twilio/LiveKit** (pasos en `apps/voice-worker/README.md`);
mientras tanto no atiende ninguna. Lo que sí se puede hacer hoy: configurar la voz y el comportamiento, hacer la llamada de prueba desde el panel, correr la prueba
ciega y probar el worker sin red con `npx vitest run apps/voice-worker --maxWorkers=2`.

## 2. Proveedor de voz de PM: qué cambió

- `VozProveedorId` queda `gemini-3.8-live | gpt-live-1`. La API rechaza el valor histórico `elevenlabs-agents`; una fila antigua con ese valor se lee como
  Gemini (`proveedorDeFila`). La migración 025 conserva el valor en sus CHECK solo por filas históricas (no se tocó SQL).
- Los errores de proveedor de los KPI de voz se desglosan en Twilio y "Gemini y otros". La columna histórica `errores_elevenlabs` de la
  migración 035 queda sin leer.
- La vista previa del panel ya no es una simulación: es una llamada real de prueba, o dice "No disponible: <motivo>".
- Reparto A/B `pct_trafico_ab`: **no existía en main**, no hay nada que retirar.
- El otro proyecto (`okvxavwijqacomgtyyou`) no se tocó.
- Queda el camino de compatibilidad `VOICE_TOOL_SECRET` (secreto global sin token): lo usan también citas y hoteles y la base sin migrar.
  Para PM se cierra con `VOICE_REQUIRE_CALL_TOKEN=true` (paso 6 de la activación).

## 3. Variables y credenciales a pegar

Ningún valor real vive en el repo. Nombres, de dónde sale cada uno y dónde se pega:

| Variable | De dónde sale | Dónde se pega | Para qué |
|---|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio | Vercel (API) **y** el host del worker | Token efímero del panel; sesión de llamada del worker. Sin ella: 503 "voz no configurada" y el panel dice "No disponible" |
| `VOICE_PREVIEW_TOKEN_SECRET` | `openssl rand -hex 32` | Vercel (API) | Firma el token de la llamada de prueba |
| `VOICE_TOOL_SECRET` | `openssl rand -hex 32` (ya existe) | Vercel (API); el worker lo usa solo para pedir el token de llamada | Emitir `POST /v1/restaurantes/:org/voice/call-token` |
| `VOICE_REQUIRE_CALL_TOKEN` | `true` | Vercel (API) | Las herramientas de voz exigen el token por llamada |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Proyecto de LiveKit Cloud | Host del worker | Recibir el SIP y entrar a las salas. Las lee `apps/voice-worker` |
| `ATIENDE_API_URL`, `INTERNAL_SECRET`, `VOICE_DNIS_MAP`, `VOICE_TOPE_MENSUAL_USD` | URL de la API; el mismo secreto interno de la API; JSON número marcado → sucursal | Host del worker | Tabla DNIS, registrador de conversaciones y costos, tope mensual (ver `apps/voice-worker/README.md`) |
| Twilio: SIP trunk + número mexicano | Consola de Twilio (Elastic SIP Trunking) | Twilio y LiveKit (inbound trunk + dispatch rule) | Un número por sucursal (DNIS -> sucursal) |
| Secreto por sucursal | `POST /v1/restaurantes/:propertyId/admin/config/sucursales/:branchId/voz/secreto` (se muestra una vez) | Host del worker | Emitir el token de llamada de esa sucursal |
| Tope mensual (US$) | Decisión de Javier | `VOICE_TOPE_MENSUAL_USD` (plataforma) y `topeMensualUsd` en `VOICE_DNIS_MAP` (por organización) | Argumento `topeMensualMicroUsd` de `evaluarInicioLlamada`; el gasto sale de la base (migración 067) |

El número y la sucursal de cada llamada salen de la telefonía (DNIS y SIP From), nunca del modelo: `extraerTelefonoSipFrom` convierte el From
en el teléfono del token firmado. Si el From **no es confiable** (vacío, anónimo, o es un número puente, una línea de la sucursal declarada en `numerosSucursal` o el número del encabezado
de desvío) el worker no emite token: el agente pide el teléfono, lo confirma y lo registra con `confirmar_telefono_llamante` (una vez por llamada; mientras tanto ninguna otra herramienta corre).

## 4. Política por llamada (valores por defecto, `LIMITES_POR_DEFECTO`)

| Política | Valor | Qué pasa al cumplirse |
|---|---|---|
| Duración máxima | 8 min (aviso a los 7) | Pregrabado + callback a una persona (`no_puedo_resolver`) y cuelga; con pedido ya creado solo se despide |
| Costo máximo por llamada | US$0.50 (500 000 micro-USD; `VOICE_COSTO_MAX_LLAMADA_USD`). Antes US$0.10, que con la facturación compuesta de Gemini Live cortaba una llamada media (~US$0.17) | Igual que la duración |
| Silencio del cliente | 7 s, 1 re-pregunta (`LIMITES_VOZ_PM`; voice-core deja 2 para las otras verticales) | Al segundo silencio se despide (resultado `abandonado`) |
| Ruido | 3 eventos sin habla inteligible = 1 malentendido | Pide repetir |
| Malentendidos seguidos | 2 | Pasa a una persona (`no_entiende`) |
| DTMF | `0` = persona, `*` = repetir | |
| Timeout por herramienta | 4 s | Aviso; 2 seguidos pasan a una persona (`falla_sistema`). Un `crear_pedido` que expira queda como **incierto** (no se le asegura al cliente) |
| Reanudación del proveedor | 1 (con el handle de sesión) | A la segunda caída: pregrabado + persona (`falla_sistema`) |
| Tope mensual | lo pasa el worker | Si el gasto del mes alcanza el tope, **no se abre sesión con Gemini**: pregrabado + callback |

Logs sin PII: solo una lista cerrada de campos (ids opacos, estados, conteos, duraciones); la transcripción se guarda aparte, con PAN y CVV
redactados.

### Instruccion y parametros del agente (rescate-orig-restaurantes-1)

- **Reglas duras no borrables.** `branch_voice_config.comportamiento` es texto libre editable por sucursal (tope 8000). La instruccion que recibe el
  proveedor la arma el servidor con `instruccionVozConReglas` (`voz/perfil-voz-pm.ts`): texto editable + saludo inicial + **bloque al final** con las
  reglas H1-H18, el flujo y la seguridad del mismo perfil que WhatsApp, las reglas vivas del agente (precios solo de herramientas de ESTA llamada, un
  solo "¿sigue ahi?", no repetir datos, reintento honesto de `crear_pedido`, reservaciones) y el apendice de la llamada. El bloque no cuenta para el tope
  del panel. Lo usa la vista previa del panel (solo organizaciones con perfil `taqueria_pm`; las demas conservan su texto tal cual) **y la instruccion de la llamada real**:
  `armarInstruccionLlamada` delega en ella cuando el dueno edito el comportamiento (el bloque de reglas va despues de su texto).
- **Temperatura 0** (`VOZ_PLATAFORMA.gemini.temperatura` y `.cascada.temperatura`): va en `generationConfig` del setup de Gemini Live y en la peticion del
  LLM de la cascada (`PeticionLlmVoz.temperatura`; el puerto que la implemente debe respetarla).
- **Idioma:** los modelos de audio nativo de la **Gemini API** eligen el idioma solos y no admiten `languageCode` (investigación 4-oct): `VOZ_PLATAFORMA.gemini.idioma` es `null` y el español de México
  y el trato de usted van en la primera línea de la instrucción (`instruccionIdioma`). El adaptador de **Vertex AI** sí manda `es-US`. `gemini-3.8-live` no admite `thinkingLevel`: el setup nunca lo manda
  (prueba en `parametros-voz.spec.ts`). **Sin verificar contra la API real.**
- **VAD del servidor:** `silenceDurationMs` 500, `prefixPaddingMs` 60 y sensibilidad de fin alta (`VOZ_PLATAFORMA.gemini.vad`; `VOICE_VAD_SILENCIO_MS` y `VOICE_VAD_SENSIBILIDAD_FIN` lo ajustan sin tocar código).
- **Costo real:** cada mensaje `usageMetadata` se cobra por modalidad (`costoDeUsoGeminiMicroUsd`: audio entrada US$3, texto entrada US$0.75, audio salida US$12, texto salida US$4.50 por millón de tokens) y llega
  a `core.usage_cost_event` con `costo_estimado = false`; sin `usageMetadata` queda el piso de US$0.075 por minuto (`precioMicroUsdPorMinuto`, el caso medio de la facturación compuesta).
- **Herramientas en serie** (equivale a `parallel_tool_calls: false` del agente vivo): `gemini-live-sesion.ts` ejecuta los `functionCalls` de un turno uno tras
  otro, en el orden pedido, igual que la cascada. **Única excepción (latencia):** la racha inicial de herramientas de solo lectura (`HERRAMIENTAS_VOZ_SOLO_LECTURA`: buscar cliente/sucursal/producto,
  historial y consultar sucursal) corre en paralelo; cotizar, confirmar, crear y repetir pedido nunca. Lo fija `packages/voice-core/tests/parametros-voz.spec.ts`.
- **Vocabulario para el STT de la cascada:** `AperturaLlamada.vocabulario` (nombres y apodos del menu, sin repetidos, hasta
  `VOZ_PLATAFORMA.cascada.vocabularioMax` = 200) viaja como `prompt` de `/audio/transcriptions`. **No probado contra OpenRouter real**; el worker debe llenar el
  campo con el menu de la sucursal.

### Mensajes pregrabados

Ids y textos en `mensajes.ts` (`saludo_respaldo` sin hora y sus tres variantes `saludo_respaldo_dias`, `_tardes` y `_noches`, que elige `mensajeSaludoRespaldo(hora local de Mérida)`; `silencio_reprompt`, `silencio_despedida`, `pedir_repetir`, `handoff`, `aviso_duracion`,
`limite_duracion`, `limite_costo`, `tope_mensual`, `proveedor_caido`, `tool_timeout`, `despedida`). El worker debe reproducirlos desde audio local,
porque la síntesis del proveedor puede ser justo lo que falló. **Pendiente: grabar/sintetizar los 15 audios una vez y publicarlos con el worker.**

## 5. Prueba ciega es-MX, paso a paso

Objetivo (ADR): >= 95 % de comandas correctas (sin error de producto, cantidad, precio ni sucursal) y **0** violaciones de reglas duras.

**A. En CI y en local, sin proveedor ni costo** (el proveedor es el falso con un agente guionado; prueba la plomería, las reglas del servidor
y los graders, **no** que un modelo entienda es-MX):

```
npx vitest run packages/domain-restaurantes/tests/voz-simulador-prueba-ciega.spec.ts --maxWorkers=2
```

Los 21 guiones (`guiones-es-mx.ts`) cubren: jerga ("bistec", "chela", "me das"), números y direcciones dichos en palabras, correcciones a mitad
de pedido, interrupciones (barge-in), alcohol a domicilio, mínimo de $200, queja con handoff, DTMF 0, silencio, ruido, proveedor caído con y sin
reanudación, límites de duración y de costo, tope mensual, herramienta lenta, teléfono ajeno e inyección, tarjeta dictada, herramienta inventada,
crear sin confirmar y zona de otra sucursal. Los graders (`graders-voz.ts`) revisan el estado real: pedido final, reglas duras, callbacks,
teléfono del SIP, pregrabados, barge-in, herramientas del registro, log sin PII, sin tarjeta y trato de usted.

**B. Contra Gemini real, a mano (cuesta dinero; nunca corre en CI):**

```
VOZ_EVALS_REAL=1 GEMINI_API_KEY=... VOZ_EVALS_MAX_USD=1 npm run evals:voz:real -w @atiende/domain-restaurantes
```

- Variables opcionales: `GEMINI_LIVE_MODEL` (por defecto `gemini-3.8-live`, **id tomado del ADR, no verificado contra la API**),
  `VOZ_EVALS_GUIONES=V01,V03`, `VOZ_EVALS_VOZ`, `VOZ_EVALS_USD_POR_MIN` (por defecto 0.04, la estimación del ADR).
- El tope de gasto es **estimado** (minutos de pared x USD por minuto): corta al alcanzarlo y lista los guiones sin correr.
- Omite los guiones `soloFalso` (V11, V12: dependen de provocar caídas del proveedor).
- Los turnos del cliente son fijos; si el modelo pregunta algo distinto a lo esperado, el guion puede fallar sin que el modelo esté mal. Revise la
  traza antes de concluir, y repita con `VOZ_EVALS_GUIONES` el guion dudoso.
- **La primera corrida real es también la verificación del protocolo de `gemini-live-sesion.ts`.** Si falla al abrir (código de cierre del
  WebSocket), el problema es del protocolo/modelo, no de los guiones.

**C. Con teléfono real (cuando exista el worker):** 30-50 llamadas grabadas de PM reproducidas contra el proveedor, mismo criterio de aprobación.

## 6. Orden de activación por sucursal, modo "desborde", en horario valle

La primera sucursal entra en modo **desborde**: el conmutador de la sucursal sigue contestando; solo si está ocupado o no contesta tras N timbres,
el desvío condicional manda la llamada al número de Twilio. El resto del tiempo el agente no recibe nada. Se activa en horario **valle** (propuesta a
confirmar con el dueño: lunes a jueves de 16:00 a 18:00; el pico es sábado y domingo de 13 a 16 y de 18 a 22).

1. Código desplegado; migraciones 025, 026 y 035 aplicadas por Javier (todas aditivas).
2. Pegar `GEMINI_API_KEY` y `VOICE_PREVIEW_TOKEN_SECRET` en Vercel. En el panel, Agente de voz > Voz: elegir voz y guardar; Comportamiento y Mensaje
   inicial (debe decir "asistente virtual").
3. **Llamada de prueba** (botón "Vista previa"): debe conectar, oírse la voz elegida y mostrar la transcripción. Si dice "No disponible: ...", falta
   una credencial del paso 2.
4. Prueba ciega B con Gemini real; aprobar el criterio de la sección 5.
5. Crear el secreto de la sucursal (tabla de la sección 3) y ponerlo en el worker.
6. `VOICE_REQUIRE_CALL_TOKEN=true` en Vercel (después de comprobar que el worker pide su token de llamada).
7. Twilio: número mexicano de la sucursal + SIP trunk; LiveKit: inbound trunk + dispatch rule (una sala por llamada; el DNIS elige la sucursal).
8. Marcar el número directo y hacer 5 llamadas de prueba (pedido a domicilio, para recoger, queja, DTMF 0, colgar a medias). Verificar en Pedidos
   y en Agente de voz > Conversaciones.
9. Activar el desvío condicional del conmutador **solo en el horario valle**. Vigilar el panel Indicadores durante 3 días.
10. Si las métricas pasan, ampliar el horario y luego las demás sucursales (T1, T2, T3, T7, T8) de una en una.

## 7. Métricas y rollback

Se miran en Agente de voz > Indicadores (hoy y mes) y en las alertas de costo/error de la migración 035:

| Métrica | Meta | Rollback si... |
|---|---|---|
| Resolución (pedidos por voz / llamadas cerradas) | sin meta fija: comparar contra la base | cae por debajo de lo esperado 3 días seguidos |
| Pasadas a una persona (handoff) | revisar motivos; `no_entiende` y `falla_sistema` no deben dominar | `falla_sistema` > 5 % de las llamadas |
| Errores de proveedor / llamadas | < 3 % | > 10 % en un día |
| p95 de herramientas | <= 1.5 s | > 4 s sostenido |
| Costo por llamada (Gemini real) | <= US$0.25 (el caso medio de la investigación es ~US$0.17) | > US$0.35 promedio |
| Violaciones de reglas duras (alcohol a domicilio, promo a domicilio, mínimo $200) | **0** | cualquiera: apagar de inmediato |

Los umbrales numéricos son una propuesta inicial; se ajustan con los datos del piloto.

**Rollback (de menos a más drástico):** (1) quitar el desvío condicional del conmutador (efecto inmediato; el teléfono vuelve a la sucursal);
(2) apagar "Agente habilitado" en el panel (la sucursal deja de aceptar llamadas del agente); (3) quitar `GEMINI_API_KEY` en Vercel (la vista previa
y las sesiones nuevas dejan de emitirse con 503 honesto); (4) revertir el despliegue. Ninguno borra pedidos ni conversaciones.

## 8. Huecos conocidos

- El worker de telefonía existe pero **no se ha probado con una llamada real** (ver sección 1 y `apps/voice-worker/README.md`); `gpt-live-1` salió de la escalera.
- La latencia de voz a voz se mide por respuesta (evento `latencia_voz`, migración 067) y se muestra por día en Indicadores contra el objetivo de p95 < 1.5 s; la vista por
  llamada queda como siguiente paso. Con la base sin la 067 el worker atiende igual y la latencia queda «no disponible aún».
- Modo de entrada (`desborde` | `total` | `prueba`) y KPI «ventas recuperadas» (pedidos de llamadas en desborde, sin cancelados): requieren la migración 067. El worker lo
  decide por la configuración de la sucursal o por el encabezado de desvío de la llamada (`Diversion` / `History-Info`; nombres sin confirmar contra la primera llamada real).
- El protocolo de Gemini Live y el nombre del modelo no están verificados contra la API real.
- La llamada de prueba del panel no se ha probado en un navegador con credencial real (micrófono y reproducción detrás de `entorno-navegador.ts`).
- Un llamante sin caller ID confiable (anónimo, vacío o el número de la sucursal tras un desvío) ya no se manda a una persona: el agente le **pide el teléfono**, lo confirma y el worker emite el token con ESE
  número (una vez por llamada). El teléfono dictado es una declaración del cliente, no una verificación (como en cualquier pedido telefónico); un llamante que invente un número ajeno solo ve lo que
  `buscar_cliente` devuelve para ese número. Si el cliente no quiere darlo, el agente se despide sin tomar el pedido (sin teléfono no hay callback).
- El worker **no reenvía** el turno del cliente (`x-atiende-call-turn`) a la API (comportamiento heredado): la defensa «no confirmar en el mismo turno que se cotiza» no actúa en telefonía. Activarlo exige comprobar
  con una llamada real que la transcripción de entrada de Gemini llega antes que la herramienta.
- Una llamada queda fijada a la sucursal que marcó el cliente: si su colonia es de otra sucursal, las herramientas no operan en la otra (el agente
  pasa a una persona con `zona_ambigua`). Lo cierra la decisión de producto sobre el número único o el traspaso entre sucursales.
- Tope mensual por organización sin tabla (vive en la configuración del worker). Notificaciones in-app: conectadas "llamada pasó a una persona" y "el proveedor de voz registra errores"
  (`docs/NOTIFICACIONES.md`); siguen pendientes el umbral de costo de voz (80 y 100 % del tope), los callbacks pendientes y el handoff de WhatsApp.
