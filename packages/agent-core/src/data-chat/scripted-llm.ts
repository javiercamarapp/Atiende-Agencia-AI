// Proveedor simulado/guion para pruebas y demos: NUNCA toca la red ni gasta. Cada llamada
// consume el siguiente paso del guion y guarda la petición para que el test inspeccione
// exactamente lo que el motor le mandó al modelo.
import type { LlmCompletionRequest, LlmToolCall } from "../gateway/types.js";
import type { DataChatCompletion } from "./types.js";

export interface ScriptData {
  readonly text?: string;
  readonly toolCalls?: readonly Omit<LlmToolCall, "id">[];
}

export type ScriptStep = ScriptData | ((req: LlmCompletionRequest) => ScriptData | Error);

export interface ScriptedCompletion {
  readonly complete: DataChatCompletion;
  readonly requests: LlmCompletionRequest[];
}

export function scriptedCompletion(steps: readonly ScriptStep[]): ScriptedCompletion {
  const requests: LlmCompletionRequest[] = [];
  let i = 0;
  const complete: DataChatCompletion = async (req) => {
    requests.push(req);
    const raw = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const step: ScriptData | Error | undefined = typeof raw === "function" ? raw(req) : raw;
    if (step instanceof Error) throw step;
    const s = step ?? {};
    return {
      text: s.text ?? "",
      toolCalls: s.toolCalls?.map((c, n) => ({ id: `call_${i}_${n}`, ...c })),
      model: "scripted/data-chat",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
  };
  return { complete, requests };
}
