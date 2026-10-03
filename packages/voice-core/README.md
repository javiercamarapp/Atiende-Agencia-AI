# @atiende/voice-core

Esqueleto de voz compartido por las verticales con agente de voz. Cada vertical (restaurantes, hoteles y, despues, citas y licitaciones) tiene
SU propio agente (persona, prompt, herramientas y guardias propias), pero todos corren sobre el mismo esqueleto: **LiveKit + Gemini Live
(`gemini-3.8-live`)**, escalera **Gemini -> gpt-live-1 -> persona/buzon con callback**, **sin ElevenLabs**. Sin dependencias de otros
paquetes del monorepo: el core no sabe de pedidos, menus, reservas ni citas.

## Que contiene

| Pieza | Archivo |
|---|---|
| Contrato `VoiceAgentProvider` (preview, salud, `abrirLlamada`), `GeminiLiveProvider`, `FakeVoiceProvider` | `src/provider.ts`, `src/gemini-live-provider.ts`, `src/fake-voice-provider.ts` |
| Sesion de llamada con Gemini Live (WebSocket, tools, transcripcion, reanudacion, caidas) | `src/llamada/gemini-live-sesion.ts` |
| Maquina de estados de la llamada (barge-in, silencio, ruido, DTMF, limites de duracion y costo, reconexion, escalada) | `src/llamada/maquina.ts` |
| Controlador (cola de eventos, ejecutor de tools, KPI, log sin PII) | `src/llamada/controlador.ts`, `ejecutor-tools.ts`, `log-sin-pii.ts` |
| Decision de inicio (deshabilitada / tope mensual) y saludo por hora | `src/llamada/inicio.ts`, `mensajes.ts` |
| Caller ID del SIP From (la regla de telefono la inyecta la vertical) | `src/llamada/sip.ts` |
| Token efimero de preview, catalogo de 30 voces, transcripcion redactada (PAN/CVV) | `src/preview-token.ts`, `catalogo-voces.ts`, `transcripcion.ts` |
| KPI, costo y alertas (capa pura) | `src/kpi.ts` |
| Puertos de repositorio de llamadas y de KPI, parametrizados por vertical | `src/repositorios.ts` |
| Simulador y graders genericos (`@atiende/voice-core/simulador`) | `src/simulador/` |

## Como una vertical monta su agente

1. **Reglas de cierre** (`ReglasCierreLlamada<R>`): la herramienta objetivo (`crear_pedido`, `apartar_habitacion`...), el resultado de cierre propio
   de la vertical (`pedido_creado`, `reserva_apartada`...) y la herramienta con la que el agente pasa a una persona. Una llamada ya lograda nunca se
   escala: solo se despide. `escalado` y `abandonado` los decide el core.
2. **Registro de tools** (`RegistroToolsVoz`): las `ToolDefinicion` que se le declaran al proveedor, cuales son de escritura con resultado incierto si
   expiran (`herramientasInciertas`) y el aviso al modelo en ese caso. SOLO corre lo que el registro declara; el telefono nunca sale de los argumentos.
3. **Transporte** (`TransporteTools`): `transporteHttp({ raiz, ruta, cabeceras, entidadId })` contra la API de la vertical (token firmado por llamada o
   secreto por property en cabeceras, nunca en el cuerpo) o uno en proceso para el simulador.
4. **Perfil**: el texto del comportamiento (prompt) y el catalogo de pregrabados (`CatalogoMensajes`: todos los `MENSAJE_IDS`, con el nombre del negocio).
5. **Repositorio**: implementa `RepositorioLlamadasVoz` y `RepositorioKpiVoz` sobre SUS tablas. El core no impone un esquema.
6. **Guiones y graders**: guiones es-MX como dato (`GuionLlamada<R, Esperado, Memoria>`), un `AdaptadorSimulador` (mundo sembrado, memoria del agente
   guionado, transporte en proceso) y los graders propios mas los genericos (`G_RESULTADO`, `G_PREGRABADOS`, `G_BARGE_IN`, `graderTools`,
   `graderSinPiiLog`, `G_SIN_TARJETA`, `G_TONO_USTED`). Corren en CI con el proveedor falso y, a mano, contra Gemini real.

Ejemplos reales: `packages/domain-restaurantes/src/voz/` (pedido) y `packages/domain-hoteles/src/voz/` (reserva). El test de contrato
`tests/contrato-vertical-juguete.spec.ts` monta una vertical de juguete con 2 tools y corre guiones de punta a punta.

## Contrato de costos (SA-02, `core.usage_cost_event`)

- Todo el dinero es entero: micro-USD (como `core.llm_usage_daily`); el core nunca convierte moneda.
- El controlador acumula `costo` de la sesion y la maquina corta al llegar a `costoMaxMicroUsd` (por defecto US$0.10) y a `duracionMaxS` (8 min).
- Al cerrar una llamada, la vertical registra UN evento por llamada con `core.record_usage_cost_event` (solo sistema, `auth.uid() is null`):
  `categoria = 'voz'`, `unidad = 'segundo'`, `cantidad = duracion`, `costo_micro_usd` = costo de la sesion, `costo_estimado = true`,
  `ref_tipo = 'voz_<vertical>'` y `ref_id = <id de la llamada>` (idempotente: reintentar no cuenta dos veces). La tabla ya admite las seis verticales.
- La telefonia se registra aparte con `categoria = 'telefonia'`; el KPI suma voz y telefonia por sucursal (`kpi.ts`, `VozKpiDia`) y NO suma
  la categoria `voz` de `usage_cost_event` si ya viene en `voice_conversation` (seria contarla dos veces).

## Escalera de proveedores

1. **Gemini 3.8 Live** (`gemini-3.8-live`): principal. El nombre sale del ADR; el protocolo se escribio segun la documentacion publica y esta probado
   contra un WebSocket falso, **no contra la API real**.
2. **gpt-live-1**: respaldo. Hoy existe el contrato (`VoiceAgentProvider.abrirLlamada`) pero no el adaptador.
3. **Persona / buzon con callback**: cuando el proveedor cae mas de `reconexionesMax` veces, la maquina dice el pregrabado `proveedor_caido` y escala
   (`falla_sistema`). Si la llamada ya logro su objetivo, solo se despide.

## Lo que NO hay (todavia)

- El **worker de telefonia** (LiveKit SIP -> `ControladorLlamada`) no existe en el repo: sin el, ningun agente atiende llamadas reales.
- La tabla generica `core.voice_call` (hoy cada vertical guarda las llamadas en sus tablas). Es el siguiente paso.
