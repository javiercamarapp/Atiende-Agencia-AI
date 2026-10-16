# Agentes públicos de demostración

Namespace aislado `/v1/demo-agentes/:solution`. Los nueve perfiles son negocios/datos ficticios propios. Chat usa el gateway y la política de proveedores de Atiende; voz usa el protocolo Gemini Live y el catálogo de `voice-core`. No hay sesión de cliente, lecturas de organizaciones, herramientas ni acciones de negocio. Un modelo real conversa sobre un escenario demostrativo: no se crean pedidos, reservas, documentos ni mensajes externos.

## Configuración

- `PUBLIC_DEMO_AGENTS_ENABLED=true` habilita los dos canales que tengan proveedor configurado. Desactivado por defecto.
- `OPENROUTER_API_KEY` (o proveedor de texto existente) para chat; `GEMINI_API_KEY` para voz. Las claves nunca llegan al navegador.
- `DATABASE_URL` y la función ya existente `restaurantes.consume_api_rate_limit(text,text,integer,integer)` para contadores atómicos globales. No requiere Redis, nueva tabla ni organización demo. Una falla del contador devuelve 503 antes de contactar proveedores.
- Orígenes permitidos: `https://useatiende.ai`, `https://www.useatiende.ai`, `https://app.useatiende.ai`. POST exige Origin exacto. El origen limita navegadores; no sustituye los contadores de costo/abuso.
- El gateway de chat es de plataforma, separado del gateway de tenants. Reutiliza escalera/configuración/políticas OpenRouter sin asociar consumos a una organización de un cliente.

## Contrato cliente

Soluciones: `restaurantes`, `hoteles`, `rentas-vacacionales`, `despachos`, `licitaciones`, `citas-reservaciones`, `cobranzas`, `ventas`, `atencion-cliente`.

`GET /estado` -> `{ solution, entorno: "demostracion", accionesReales: false, chat: {disponible,motivo}, voz: {disponible,motivo}, limites: {caracteresPorMensaje:600,mensajesPorConversacion:12,vozDuracionSegundos:60} }`.
La disponibilidad indica que el canal tiene configuración y su contador duradero responde; el proveedor puede fallar al iniciar. No se abre una conversación ni se gasta en LLM al consultar estado.

`POST /chat` -> entrada `{ sessionId: crypto.randomUUID(), locale: "es"|"en", mensajes: [{rol:"usuario"|"agente",texto:string}] }`.
Historial alternado, comienza y termina con usuario, máximo 12 turnos del visitante / 23 mensajes. Máximo 600 caracteres por entrada del visitante, 3,000 por respuesta previa del agente y 48KiB total.
Salida `{ respuesta, modelo, proveedor, entorno:"demostracion", accionesReales:false }`.

`POST /voz/sesion` -> entrada `{sessionId,locale}`.
Salida HTTP201 `{sesionId,proveedor,modelo,voiceId,websocketUrl,tokenProveedor,expiraEn,duracionMaxSegundos:60,tokenCaducidadSegundos:90,entorno:"demostracion",accionesReales:false}`.
El token Gemini de un solo uso caduca 90s después de emitirse y admite una conexión nueva durante los primeros30s. Fija en servidor modelo, voz, instrucción, salida AUDIO, transcripción y herramientas vacías; no admite instrucciones o herramientas del cliente.

Navegador: WebSocket `websocketUrl + '?access_token=' + encodeURIComponent(tokenProveedor)`; enviar `{setup:{model:'models/'+modelo}}`, esperar `setupComplete`. Enviar audio PCM16 mono16k con `realtimeInput.audio`; reproducir PCM24k de `serverContent.modelTurn.parts[].inlineData`; mostrar input/outputTranscription. Puede enviar un saludo inicial con clientContent después de setupComplete. Cerrar WebSocket, micrófono y AudioContext a los60s y al desmontar/cambiar de solución. Micrófono solo tras click; no guardar grabaciones.

Errores `{code,message}`:400 entrada inválida,403 origen,404 solución desconocida,429 límite,503 no disponible/proveedor. UI debe conservar el ejemplo grabado como opción claramente identificada; jamás hacerlo pasar por agente en vivo.

## Límites

Contadores PG independientes del proceso, transacciones confirmadas antes del proveedor:

| Canal | IP | Sesión (todas las soluciones) | Plataforma (todas las soluciones) |
|---|---|---|---|
| Chat |12 turnos /10min|12 turnos /24h|200 turnos /24h|
| Voz |3 emisiones /1h|2 emisiones /24h|30 emisiones /24h|
| Estado |60 consultas /1min|—|—|

Las ventanas empiezan con el primer evento y duran el intervalo indicado; no son fechas calendario. Las solicitudes fallidas consumen cuota deliberadamente. El gateway añade presupuesto por ejecución USD0.08 y diario USD2 en memoria de proceso; los contadores PG son el control persistente. La salida pedida de texto es384 tokens (la escalera puede imponer su mínimo por modelo). No se anuncia un tope monetario absoluto de voz: emisión/TTL limitan acceso; corte60s es UX y el proveedor aplica caducidad, no un contador de dólares.

## Evidencia y despliegue

Documentación oficial consultada2026-10-06:
- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
- https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
- https://ai.google.dev/api/live#authtoken

El esquema REST de referencia usa `bidiGenerateContentSetup`; `liveConnectConstraints` es la representación expuesta por el SDK/guía. Se usa v1beta, sin cambiar el adaptador v1alpha del panel existente.

Pruebas: `vitest run apps/api/tests/demo-agents.spec.ts`; typecheck API; ESLint archivos tocados. Las pruebas unitarias usan puertos falsos y no certifican conectividad real. Antes de anunciar disponibilidad verificar en el despliegue una respuesta real de chat y una sesión de voz que devuelva audio/transcripción. Vercel Sensitive devuelve valores redactados en `env pull`; presencia en `env ls` no prueba validez.
