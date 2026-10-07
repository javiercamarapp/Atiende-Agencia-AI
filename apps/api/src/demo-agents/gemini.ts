import { esVozDeGemini } from "@atiende/voice-core";
import { DEMO_PROFILES, demoInstruction } from "./profiles.ts";
import type { DemoInput, DemoVoiceSession } from "./types.ts";

/** Google REST AuthToken schema (not the SDK's liveConnectConstraints wrapper).
 * Verified: https://ai.google.dev/api/live#authtoken and /gemini-api/docs/models/gemini-3.8-live, 2026-10-06.
 * The public adapter is isolated from internal v1alpha preview callers.
 */
export const DEMO_GEMINI_MODEL = "gemini-3.8-live";
export const DEMO_GEMINI_SOCKET = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export function createDemoVoice(apiKey: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  return async (input: DemoInput): Promise<DemoVoiceSession> => {
    const voiceId = DEMO_PROFILES[input.solution].voice;
    if (!esVozDeGemini(voiceId)) throw new Error("Demo voice is not supported");
    const issued = now();
    const expiraEn = new Date(issued + 90_000).toISOString();
    const response = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        uses: 1,
        expireTime: expiraEn,
        newSessionExpireTime: new Date(issued + 30_000).toISOString(),
        // Empty fieldMask + setup locks the entire configuration; client setup cannot replace the prompt or add tools.
        bidiGenerateContentSetup: {
          model: `models/${DEMO_GEMINI_MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            maxOutputTokens: 512,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } },
          },
          systemInstruction: { parts: [{ text: demoInstruction(input.solution, input.locale) }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [],
        },
      }),
    });
    // Provider bodies may carry diagnostics/identifiers. Do not expose or log them.
    if (!response.ok) throw new Error(`Demo voice provider HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("name" in data) || typeof data.name !== "string" || !data.name) throw new Error("Demo voice token missing");
    return { sesionId: input.sessionId, proveedor: "gemini-3.8-live", modelo: DEMO_GEMINI_MODEL, voiceId, websocketUrl: DEMO_GEMINI_SOCKET, tokenProveedor: data.name, expiraEn, duracionMaxSegundos: 60, tokenCaducidadSegundos: 90 };
  };
}
