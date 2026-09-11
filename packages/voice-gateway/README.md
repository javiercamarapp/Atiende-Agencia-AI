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
| `gptlive` (`GptLiveVoiceProvider`) | **Inerte** — sin API pública | Falla cerrado | Falla cerrado |

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

### Selección por config

```ts
import { selectVoiceProvider, readVoiceProviderFromEnv } from '@atiende/voice-gateway';

const provider = selectVoiceProvider(readVoiceProviderFromEnv(), {
  elevenlabs: { mode: 'server', apiKeyProvider: async () => await leerDeVault() },
});
```

`VOICE_PROVIDER` no definida (o `"elevenlabs"`) construye
`ElevenLabsVoiceProvider`. `VOICE_PROVIDER=gptlive` hace que la selección
misma **lance de inmediato** `VoiceProviderNotActivatableError` — nunca cae
en silencio a ElevenLabs cuando alguien pidió GPT-Live-1 explícito.

---

## Por qué `GptLiveVoiceProvider` está inerte

GPT-Live-1 (OpenAI) se lanzó el **10 de septiembre de 2026** — el día antes
de que este paquete se construyera. Verificado en ese momento: **no tiene
API pública todavía**, solo un formulario de lista de espera. OpenAI dice
"semanas, no meses", no una fecha.

Construir una implementación real hoy sería inventar un contrato contra una
API que no existe. En vez de eso, `GptLiveVoiceProvider` implementa
`VoiceProvider` completo, pero **cada método falla cerrado** con
`VoiceProviderNotActivatableError` — nunca simula una respuesta, nunca
degrada en silencio a ElevenLabs. El test
`tests/gptlive-provider.spec.ts` confirma explícitamente que los 7 métodos
(los 6 de `VoiceProvider` + `assertAvailable()`) fallan, cada uno con un
mensaje que nombra el método, para que un uso accidental en producción sea
inmediato y diagnosticable, no un silencio confuso.

`selectVoiceProvider('gptlive', …)` llama `assertAvailable()` en el momento
de la **selección** (no solo en el primer uso) — mismo principio que
`ResidencyGateBlockedError` en `agent-core/gateway/residency.ts`: un
proveedor pedido explícito que no puede activarse debe fallar ahí mismo.

## Activar GPT-Live-1 el día que haya API pública

Cuando OpenAI publique la API real, esto es lo que hay que llenar — **sin
rediseñar nada del contrato compartido**:

1. **Confirmar el shape real contra la documentación oficial** antes de
   escribir una sola línea — no adivinar campos (ver la nota en
   `src/bridge/gptlive-agent-bridge.ts` sobre `GptLiveToolCallEvent`, que
   hoy es un placeholder deliberadamente mínimo).

2. **`src/providers/gptlive-provider.ts`** — llenar cada método (ya no
   llamar `this.fail(...)`):
   - `getSignedUrl` — probablemente un endpoint REST que firma una sesión
     realtime, análogo a `get-signed-url` de ElevenLabs.
   - `listVoices` — catálogo de voces/idiomas de GPT-Live-1.
   - `getAgentConfig` / `updateAgentConfig` — lectura/escritura de la
     config del "assistant" de voz (nombre exacto de la entidad TBD).
   - `startSession` / `endSession` — el SDK realtime de GPT-Live-1 es
     **full-duplex** (a diferencia de ElevenLabs, por turnos). El contrato
     de `VoiceProvider` NO cambia — `VoiceTranscriptEvent` ya modela
     `role: 'user' | 'agent'` de forma agnóstica al proveedor — lo que
     cambia es la implementación interna (streaming continuo, no eventos
     por turno).
   - Quitar `assertAvailable()` del bloqueo duro en `router.ts` una vez
     que el proveedor sea real (o dejarlo como health-check si la API
     expone uno).

3. **`src/bridge/gptlive-agent-bridge.ts`** — llenar `handleToolCall`:
   traducir el evento de tool-calling de GPT-Live-1 a una
   `LlmCompletionRequest` de `@atiende/agent-core/gateway` y llamar
   `LlmGateway.complete({ tenantId, runId, lane: 'interactive', role: 'voice-tool-planner', request })`
   — mismo gateway, mismo circuit breaker, mismo presupuesto que ya usa el
   resto del monorepo para texto. Cero infraestructura nueva: el diseño ya
   referencia el tipo real `LlmGateway`, no un stub.

4. **Variables de entorno que hará falta agregar** (nombres exactos TBD
   hasta que exista la documentación oficial — no se inventan aquí; seguir
   el mismo patrón de `apiKeyProvider` async de `ElevenLabsVoiceProvider`,
   nunca una key hardcodeada):
   - Una API key de OpenAI con scope para GPT-Live-1 (probablemente
     reutiliza `OPENAI_API_KEY` si el endpoint cuelga de la misma cuenta
     que el resto de OpenAI, o una key separada si GPT-Live-1 tiene su
     propio scope — confirmar contra la documentación real).
   - Si telefonía entra vía Twilio Agent Connect (mencionado en el
     lanzamiento): credenciales de Twilio, ya probablemente presentes en
     el monorepo si algún dominio usa Twilio para SMS/voz.
   - Guardarlas en Supabase Vault, igual que `ELEVENLABS_API_KEY` — nunca
     en una env var estática de una Edge Function ni en el navegador.

5. **Presupuesto/costo** — GPT-Live-1 se factura a $0.05/min **por
   segundo**, no por tokens. Si este monorepo conecta voz a
   `agent-core/gateway/budget.ts` (reserva-antes-de-gastar), el
   cost-estimator de GPT-Live-1 debe estimar en segundos de audio, a
   diferencia del estimador de tokens que ya existe para LLM de texto.

6. **Correr `tests/gptlive-provider.spec.ts`** — al llenar los métodos,
   ese archivo deja de tener sentido tal cual (hoy prueba que TODO falla);
   reemplazarlo por tests reales contra mocks de la API real de GPT-Live-1,
   siguiendo el mismo patrón que `tests/elevenlabs-provider.spec.ts`
   (inyección de `fetchImpl`, sin tocar la red real).

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
      gptlive-provider.ts         → GptLiveVoiceProvider (inerte, falla cerrado)
    bridge/
      gptlive-agent-bridge.ts     → conexión diseñada (no implementada) hacia @atiende/agent-core
  tests/
    elevenlabs-provider.spec.ts   → mocks de la API HTTP real de ElevenLabs
    gptlive-provider.spec.ts      → confirma que los 7 métodos fallan cerrado
    router.spec.ts                → selección por config + rechazo explícito de gptlive
```
