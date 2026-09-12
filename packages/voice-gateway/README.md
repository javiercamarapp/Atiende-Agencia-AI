# `@atiende/voice-gateway`

Capa de voz intercambiable: un solo contrato (`VoiceProvider`) que cualquier
vertical (hoteles, restaurantes, rentas, citas, licitaciones) consume sin
saber si detrás hay ElevenLabs, GPT-Live-1, o lo que venga después.

Mismo espíritu que `packages/agent-core/src/gateway` (`LlmGateway` +
`LlmProvider`), con una diferencia deliberada: **no hay escalera de
fallback entre proveedores de voz**. Una sesión de voz full-duplex en curso
no tiene un análogo razonable a "reintenta este mismo turno en otro
proveedor" — la selección es por sesión, no por request.

## Estado de los proveedores

| Proveedor | Estado | Superficie servidor | Superficie cliente |
| --- | --- | --- | --- |
| `elevenlabs` (`ElevenLabsVoiceProvider`) | **Real, en producción** | Sí | Sí |
| `gptlive` (`GptLiveVoiceProvider`) | **Real, activado 12-sep-2026** | Sí (con límites documentados abajo) | Sí (WebRTC) |

---

## Usar ElevenLabs hoy

`ElevenLabsVoiceProvider` es un puerto 1:1 de la integración real que ya
corre en `restaurantes/supabase/functions/agent-config/index.ts` (backend)
y `restaurantes/src/pages/AdminDashboard.tsx` (navegador).

### 1. Modo servidor (Edge Function / `apps/*/api`) — el único que toca la API key

La API key **nunca** vive en una variable de entorno de la función ni se
manda al navegador — vive en **Supabase Vault**, igual que hoy en
`agent-config/index.ts`:

```ts
import { ElevenLabsVoiceProvider } from '@atiende/voice-gateway';

const provider = new ElevenLabsVoiceProvider({
  mode: 'server',
  // Puerto directo de `getApiKey(supabase)` en agent-config/index.ts:
  // supabase.rpc('get_secret', { secret_name: 'ELEVENLABS_API_KEY' })
  apiKeyProvider: async () => {
    const { data, error } = await supabase.rpc('get_secret', { secret_name: 'ELEVENLABS_API_KEY' });
    if (error) throw error;
    return data as string;
  },
});

// Firma una URL para que el navegador abra la sesión de voz.
const { url } = await provider.getSignedUrl(tenant);

// Lista voces en español latino (filtro real por substring de acento).
const voces = await provider.listVoices('es');

// Lee y actualiza la config del agente (voz, idioma, prompt, temperatura, primer mensaje).
const config = await provider.getAgentConfig(tenant);
await provider.updateAgentConfig({ agentId: tenant.agentId, voiceId: 'voice_xxx', temperature: 0.6 });
```

Para desarrollo local / scripts (fuera de una Edge Function con Vault),
`apiKeyProvider` puede leer de una env var en vez de Vault — la interfaz no
le importa la fuente:

```ts
apiKeyProvider: async () => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('falta ELEVENLABS_API_KEY');
  return key;
},
```

**Variable de entorno para desarrollo/scripts:** `ELEVENLABS_API_KEY`. En
producción real (Edge Function), la key vive en Supabase Vault bajo el
nombre de secreto `ELEVENLABS_API_KEY` — nunca se hardcodea ni se pasa por
env var de la función.

### 2. Modo cliente (navegador / bridge de telefonía) — nunca recibe la key

El navegador **nunca** ve la API key. En vez de eso, `resolveSignedUrl`
llama a tu propio backend (el que corre la instancia en modo `'server'`
de arriba) — puerto directo de
`supabase.functions.invoke('agent-config', { action: 'signed_url', agent_id })`
en `AdminDashboard.tsx`:

```ts
import { ElevenLabsVoiceProvider } from '@atiende/voice-gateway';

const provider = new ElevenLabsVoiceProvider({
  mode: 'client',
  resolveSignedUrl: async (tenant) => {
    const { data, error } = await supabase.functions.invoke('agent-config', {
      body: { action: 'signed_url', agent_id: tenant.agentId },
    });
    if (error) throw error;
    return { url: data.signed_url };
  },
});

const handle = await provider.startSession({
  tenant,
  dynamicVariables: { saludo: 'Buenas tardes' },
  onConnect: (info) => console.log('conectado', info.conversationId),
  onTranscript: (event) => console.log(event.role, event.text),
  onError: (msg) => console.error('voz:', msg),
  onDisconnect: () => console.log('sesión terminada'),
});

// ...cuando el usuario cuelga:
await handle.endSession();
```

`startSession` carga `@elevenlabs/client` con `import()` **dinámico** — el
mismo patrón que `AdminDashboard.tsx`, para no meter ese SDK pesado en el
bundle inicial. Por eso `@elevenlabs/client` es una **`peerDependency`
opcional** de este paquete, no una dependencia directa: instálala en la app
que de verdad ejecuta `startSession` en el navegador:

```bash
npm install @elevenlabs/client
```

Si llamas `startSession` sin tenerlo instalado, el `import()` dinámico falla
con el error normal de "módulo no encontrado" de Node/el bundler — no un
fallo silencioso.

---

## Usar GPT-Live-1 hoy

`GptLiveVoiceProvider` es una implementación **real** contra la API pública
de OpenAI, lanzada el 10-sep-2026 y activada en este paquete el 12-sep-2026.
GPT-Live-1 es **full-duplex** (escucha y habla al mismo tiempo, a diferencia
de ElevenLabs, que es por turnos) y **delega razonamiento/tool-calling a un
modelo backend separado** — ver la sección del bridge más abajo.

### 1. Modo servidor — el único que toca `OPENAI_API_KEY`

```ts
import { GptLiveVoiceProvider } from '@atiende/voice-gateway';

const provider = new GptLiveVoiceProvider({
  mode: 'server',
  apiKeyProvider: async () => {
    // Mismo secreto de Vault que ya usarías para OPENAI_API_KEY del
    // LlmGateway de texto (ver decisión de scope de la key más abajo).
    const { data, error } = await supabase.rpc('get_secret', { secret_name: 'OPENAI_API_KEY' });
    if (error) throw error;
    return data as string;
  },
});

// Crea un ephemeral client secret real (POST /v1/realtime/client_secrets)
// para que el navegador abra la sesión WebRTC. NO es una URL — ver nota en
// el código fuente (`gptlive-provider.ts`) sobre por qué se reutiliza el
// campo `url` del contrato compartido para transportar este secreto.
const { url: clientSecret, expiresAt } = await provider.getSignedUrl(tenant);

// Catálogo FIJO de voces multilingües (no hay endpoint de catálogo dinámico
// ni filtro real por idioma en la API — `languageFilter` se ignora a propósito).
const voces = await provider.listVoices('es');
```

Para desarrollo local / scripts:

```ts
apiKeyProvider: async () => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('falta OPENAI_API_KEY');
  return key;
},
```

**Variable de entorno:** `OPENAI_API_KEY` — **la misma** que ya usa
`@atiende/agent-core` (`LlmGateway`) para el proveedor OpenAI de texto (ver
`apps/api/src/env.ts`). **Decisión de scope tomada y verificada, no
inventada**: la documentación real de OpenAI (`developers.openai.com/api/docs/guides/realtime`,
`.../guides/live`, `.../api/reference/.../client_secrets`) no menciona un
scope/permiso de API key separado para Realtime/Live frente al resto de la
API — crear un ephemeral client secret es una llamada de servidor estándar
con `Authorization: Bearer <API key de proyecto>`. Por eso **no se introduce
una env var nueva** (`OPENAI_VOICE_API_KEY` o similar) — habría sido
inventar una distinción que la documentación no respalda. Si OpenAI publica
un scope dedicado en el futuro, el único punto de cambio es este
`apiKeyProvider`.

### 2. Modo cliente (navegador) — WebRTC real, sin key

```ts
import { GptLiveVoiceProvider } from '@atiende/voice-gateway';

const provider = new GptLiveVoiceProvider({
  mode: 'client',
  resolveSignedUrl: async (tenant) => {
    const { data, error } = await supabase.functions.invoke('gptlive-config', {
      body: { action: 'signed_url', tenant },
    });
    if (error) throw error;
    return { url: data.client_secret };
  },
});

const handle = await provider.startSession({
  tenant,
  onConnect: (info) => console.log('conectado', info.conversationId),
  onTranscript: (event) => console.log(event.role, event.text),
  onError: (msg) => console.error('voz:', msg),
  onDisconnect: () => console.log('sesión terminada'),
});

await handle.endSession();
```

`startSession` negocia WebRTC real: crea un `RTCPeerConnection`, agrega el
micrófono (`navigator.mediaDevices.getUserMedia`), abre un data channel de
eventos, arma el SDP offer/answer contra `POST /v1/realtime/calls` con el
client secret efímero como `Authorization: Bearer`, y traduce el evento
`session.started` (y cualquier frame con `role`+texto reconocible) del data
channel a `onConnect`/`onTranscript`. A diferencia de ElevenLabs, **no hay un
SDK propietario de navegador confirmado** para GPT-Live-1 — por eso esta
implementación usa solo APIs web estándar (`RTCPeerConnection`,
`getUserMedia`), inyectables como `createPeerConnection`/`requestMicrophone`
para pruebas (mismo patrón que `fetchImpl` en el resto del monorepo). Correr
`startSession` en Node sin navegador falla explícito con
`VoiceProviderConfigError` — nunca simula audio.

### Presupuesto — facturación por SEGUNDO, no por tokens

GPT-Live-1 cobra **$0.05/min de la capa de voz, por segundo** — muy distinto
al `LlmCostEstimator` de `agent-core/gateway/budget.ts` (que estima en
tokens). `voice-gateway` **no tiene** (todavía) su propio store de
presupuesto tipo reserva-antes-de-gastar — es independiente del de
`agent-core`. Este paquete exporta `estimateGptLiveCostUsd(durationSeconds)`
como estimador puro, listo para conectarse a un ledger real el día que uno
exista para voz; no se fabrica aquí infraestructura de reserva que este
paquete no tiene hoy.

### Límites conocidos — fail-closed deliberado (no inventado)

Dos superficies quedan **fail-closed explícito**, con un mensaje que dice
por qué, porque la búsqueda de documentación real (12-sep-2026) no fue
concluyente:

1. **`getAgentConfig` / `updateAgentConfig`** — no se encontró un recurso
   persistente de "agente"/"assistant" con GET/PATCH por id para GPT-Live-1
   (a diferencia del `agent_id` de ElevenLabs Conversational AI). La config
   real (voz, instrucciones, temperatura) se manda **por sesión**, al pedir
   el ephemeral client secret — no se lee/actualiza contra un id guardado
   del lado de OpenAI. Ambos métodos lanzan `VoiceProviderConfigError`
   explícito en vez de inventar un endpoint.
2. **Telefonía SIP nativa** (`GptLiveVoiceProvider.assertNativeSipTelephonySupported()`,
   extensión fuera de la interfaz `VoiceProvider` compartida) — OpenAI
   documenta integraciones de **socio** (LiveKit, Twilio, Telnyx,
   Daily/Pipecat) para telefonía con GPT-Live-1
   (`/api/docs/guides/live-partner-integrations`), pero la búsqueda no pudo
   confirmar un SIP trunk **nativo y directo** de OpenAI para `gpt-live-1`
   específicamente (análogo a `realtime-sip` de los modelos `gpt-realtime`
   anteriores) sin pasar por el media server de un socio. Este método
   siempre lanza `VoiceProviderConfigError` — una vertical que necesite
   telefonía real hoy debe integrar uno de esos partners directamente,
   fuera de este paquete. `tests/gptlive-provider.spec.ts` confirma este
   fail-closed explícitamente.

### Fuentes reales consultadas (12-sep-2026)

- `https://developers.openai.com/api/docs/guides/live` — flujo general de GPT-Live
- `https://developers.openai.com/api/docs/guides/realtime` — ephemeral client secrets, header `OpenAI-Safety-Identifier`
- `https://developers.openai.com/api/docs/models/gpt-live-1` — model id, precio, delegación a backend
- `https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create` — shape real de `POST /v1/realtime/client_secrets`
- `https://developers.openai.com/api/docs/guides/live-partner-integrations` — integraciones de socio para telefonía
- Hilos de la comunidad de desarrolladores de OpenAI + LiteLLM/webrtchacks (sep-2026) — intercambio SDP real vía `POST /v1/realtime/calls`

### Selección por config

```ts
import { selectVoiceProvider, readVoiceProviderFromEnv } from '@atiende/voice-gateway';

const provider = selectVoiceProvider(readVoiceProviderFromEnv(), {
  elevenlabs: { mode: 'server', apiKeyProvider: async () => await leerDeVault('ELEVENLABS_API_KEY') },
  gptlive: { mode: 'server', apiKeyProvider: async () => await leerDeVault('OPENAI_API_KEY') },
});
```

`VOICE_PROVIDER` no definida (o `"elevenlabs"`) construye
`ElevenLabsVoiceProvider`. `VOICE_PROVIDER=gptlive` construye
`GptLiveVoiceProvider` real — ya no lanza `VoiceProviderNotActivatableError`
por selección; si falta `opts.gptlive`, lanza `VoiceProviderConfigError`
explícito (nunca adivina la config).

## Activar el bridge de tool-calling (`bridge/gptlive-agent-bridge.ts`)

Activo desde el 12-sep-2026 — conecta las decisiones de tool-calling que
GPT-Live-1 delega a un backend con el `LlmGateway` real de
`@atiende/agent-core`:

```ts
import { createGptLiveAgentBridge, VOICE_TOOL_PLANNER_ROLE } from '@atiende/voice-gateway/bridge';
import { LlmGateway } from '@atiende/agent-core/gateway';

const gateway = new LlmGateway({ breaker, budgetStore, budgetLimits });
// Igual que cualquier otro rol de LlmGateway: registra la escalera de
// proveedores de TEXTO que atienden las decisiones de voz.
gateway.registerLadder(VOICE_TOOL_PLANNER_ROLE, [openAiProvider, anthropicProvider]);

const bridge = createGptLiveAgentBridge(gateway);

// Desde el orquestador de la vertical, con la transcripción acumulada de
// `onTranscript` de `startSession`:
const { spokenResponse } = await bridge.handleToolCall({
  conversationId: handle.conversationId,
  tenantId: tenant.organizationId,
  transcriptSoFar: transcripcionAcumulada,
});
```

`gateway.registerLadder` y la construcción del `LlmGateway` son
responsabilidad de la app (igual que cualquier otro rol) — el bridge no
impone qué proveedores de texto usa cada vertical. El payload EXACTO que
GPT-Live-1 dispararía por un webhook/evento de tool-calling nativo (si
expone uno) no se pudo confirmar contra documentación real hoy — este
bridge asume que el orquestador de la vertical arma `transcriptSoFar` desde
el contrato ya real de `onTranscript`, no un webhook inventado.

## Estructura

```
packages/voice-gateway/
  src/
    index.ts                      → export público del paquete
    types.ts                      → interfaz VoiceProvider + tipos compartidos
    errors.ts                     → jerarquía de errores (puerto de agent-core/gateway/errors.ts)
    router.ts                     → selección por config (VOICE_PROVIDER), default elevenlabs
    providers/
      elevenlabs-provider.ts      → ElevenLabsVoiceProvider (real)
      elevenlabs-client.d.ts      → shim de tipos para @elevenlabs/client (peer opcional)
      gptlive-provider.ts         → GptLiveVoiceProvider (real, activado 12-sep-2026)
    bridge/
      gptlive-agent-bridge.ts     → conexión real hacia @atiende/agent-core (LlmGateway)
  tests/
    elevenlabs-provider.spec.ts   → mocks de la API HTTP real de ElevenLabs
    gptlive-provider.spec.ts      → mocks de la API HTTP real de OpenAI + WebRTC fake
    gptlive-agent-bridge.spec.ts  → LlmGateway real + FakeLlmProvider determinista
    router.spec.ts                → selección por config, ambos proveedores reales
```
