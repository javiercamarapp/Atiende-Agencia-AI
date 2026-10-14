// Puerto LLM de la cascada (escalon 2) sobre el proveedor de OpenRouter del gateway de agent-core, con la MISMA `OPENROUTER_API_KEY` del texto.
// El worker no tiene presupuesto ni kill-switch del gateway completo (corre aparte de la API y sin base): el costo real de cada turno (`usage.cost`
// de OpenRouter) sube a la sesion, que lo suma al costo de la llamada y a los topes por llamada y mensual.
import { OpenRouterProvider } from "@atiende/agent-core";
import type { LlmMessage } from "@atiende/agent-core";
import { modeloAgentePorId } from "@atiende/domain-restaurantes";
import { VOZ_PLATAFORMA } from "@atiende/voice-core";
import type { ConfigPlataformaVoz, PuertoLlmVoz } from "@atiende/voice-core";

/** `temperature` del modelo de voz. La lista de modelos que la aceptan ya existe (`MODELOS_AGENTE.aceptaTemperatura`, verificada contra los endpoints permitidos de OpenRouter):
 * un modelo que la rechaza (Luna, Sonnet 5.5) o que NO esta verificado en esa lista (Haiku 5.5 y cualquier id nuevo) recibe `"omit"`, porque con `require_parameters: true`
 * mandarla deja la ruta sin endpoints (404, docs/LLM-GATEWAY.md). Para uno que la acepta, la temperatura pedida si es un numero finito (0 incluido) y, si no, no se manda.
 * NOTA para la cascada v2: este puerto no manda `provider.zdr` ni `only` (rutas de EE.UU.), y el modelo por omision `google/gemini-3.8-flash` con `temperature: 0` solo lo
 * aceptan los endpoints de Google AI Studio (no los de Vertex). */
export function temperaturaParaModelo(modelo: string, temperatura: number | null | undefined): number | "omit" | undefined {
  if (!modeloAgentePorId(modelo)?.aceptaTemperatura) return "omit";
  return typeof temperatura === "number" && Number.isFinite(temperatura) ? temperatura : undefined;
}

export function crearPuertoLlmOpenRouter(apiKey: string, fetchImpl?: typeof fetch, opciones: { modelo?: string; temperatura?: number | null } = {}): PuertoLlmVoz {
  const modelo = opciones.modelo ?? VOZ_PLATAFORMA.cascada.modeloLlm;
  const temperatura = temperaturaParaModelo(modelo, "temperatura" in opciones ? opciones.temperatura : VOZ_PLATAFORMA.cascada.temperatura);
  const proveedor = new OpenRouterProvider({
    apiKey,
    model: modelo,
    appName: "atiende-voice-worker",
    params: temperatura === undefined ? {} : { temperature: temperatura },
    // Un turno de voz que tarda mas de 8 s ya perdio al cliente: mejor fallar y que la escalera/maquina decidan.
    timeoutMs: 8_000,
    maxRetries: 0,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    async completar(p) {
      const mensajes: LlmMessage[] = p.mensajes.map((m) => {
        if (m.role === "assistant") return { role: "assistant", content: m.content, ...(m.toolCalls ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, name: t.nombre, argumentsJson: t.argsJson })) } : {}) };
        if (m.role === "tool") return { role: "tool", toolCallId: m.toolCallId, content: m.content };
        return { role: "user", content: m.content };
      });
      const r = await proveedor.complete({
        system: p.system,
        messages: mensajes,
        tools: p.herramientas.map((h) => ({ name: h.name, description: h.description, parameters: h.parameters as unknown as Record<string, unknown> })),
        maxOutputTokens: 400,
        ...(p.senal ? { signal: p.senal } : {}),
      });
      return {
        texto: r.text,
        toolCalls: (r.toolCalls ?? []).map((t) => ({ id: t.id, nombre: t.name, argsJson: t.argumentsJson })),
        costoMicroUsd: Math.max(0, Math.round(r.costUsd * 1_000_000)),
      };
    },
  };
}

/** Prefijos de modelos que aceptan `reasoning.effort` y el punto de cache explicito del system prompt (Anthropic en OpenRouter). Con `require_parameters: true` mandar `reasoning` a un modelo que no lo lista deja la ruta sin endpoints (404). */
const PREFIJOS_CON_ESFUERZO = ["anthropic/"] as const;

export interface OpcionesPuertoLlmVozV2 {
  /** Modelo cuando la peticion no trae `modeloPreferido`; por omision `VOZ_PLATAFORMA.cascadaV2.llm.modelo`. */
  readonly modelo?: string;
  readonly config?: ConfigPlataformaVoz;
}

/**
 * Puerto LLM de la cascada v2 (streaming) sobre OpenRouter, con la MISMA `OPENROUTER_API_KEY` del texto.
 *  - Streaming: pasa `onTextDelta` a `OpenRouterProvider` (SSE) para que el nucleo sintetice por frase mientras el modelo escribe.
 *  - Modelo POR PETICION (`modeloPreferido`): un proveedor por (modelo, esfuerzo), reutilizado entre turnos (P3 lo usara para escalar).
 *  - Esfuerzo bajo: `reasoning: { effort: "low" }` (Sonnet 5.5 tiene razonamiento obligatorio; `none` se rechazaria). Solo se manda a modelos Anthropic.
 *  - NUNCA manda `temperature` (Anthropic y OpenAI la rechazan con `require_parameters: true`; aqui ningun modelo la recibe).
 *  - Retencion cero (ZDR): `provider.zdr = true` y `only` = proveedores ZDR de la plataforma (Vertex, Bedrock); sin endpoint ZDR para el modelo, 404 -> `v2_llm_sin_zdr`.
 *  - Cache del system prompt: punto de cache explicito en modelos Anthropic; `tokensCache` de la respuesta permite verificar la lectura de cache.
 *  - Tope de salida corto (`topeSalidaTokens`, incluye el razonamiento).
 */
export function crearPuertoLlmVozV2(apiKey: string, fetchImpl?: typeof fetch, opciones: OpcionesPuertoLlmVozV2 = {}): PuertoLlmVoz {
  const cfg = (opciones.config ?? VOZ_PLATAFORMA).cascadaV2.llm;
  const modeloPorDefecto = opciones.modelo ?? cfg.modelo;
  const proveedores = new Map<string, OpenRouterProvider>();
  const proveedorDe = (modelo: string, esfuerzo: "low" | "medium" | "high"): OpenRouterProvider => {
    const esAnthropic = PREFIJOS_CON_ESFUERZO.some((p) => modelo.startsWith(p));
    const clave = `${modelo}|${esAnthropic ? esfuerzo : "-"}`;
    let p = proveedores.get(clave);
    if (!p) {
      p = new OpenRouterProvider({
        apiKey,
        model: modelo,
        appName: "atiende-voice-worker",
        // RETENCION CERO (14-oct-2026): solo endpoints ZDR de Vertex/Bedrock (`provider.zdr` + `only`). `allowFallbacks` queda en true SOLO para saltar entre esos dos
        // proveedores permitidos; nunca sale de la lista. Si OpenRouter no tiene endpoint ZDR para el modelo responde 404 y la sesion cae con `v2_llm_sin_zdr`.
        routing: { zdr: true, only: cfg.proveedoresZdr, allowFallbacks: true },
        params: { temperature: "omit", maxTokens: cfg.topeSalidaTokens, ...(esAnthropic ? { reasoningEffort: esfuerzo, cacheSystemPrompt: true } : {}) },
        // Un turno de voz que tarda mas de 10 s (el streaming cuenta hasta el ultimo trozo) ya perdio al cliente: mejor fallar y que la escalera decida.
        timeoutMs: 10_000,
        maxRetries: 0,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      proveedores.set(clave, p);
    }
    return p;
  };
  return {
    async completar(p) {
      const modelo = p.modeloPreferido && p.modeloPreferido.trim() !== "" ? p.modeloPreferido : modeloPorDefecto;
      const mensajes: LlmMessage[] = p.mensajes.map((m) => {
        if (m.role === "assistant") return { role: "assistant", content: m.content, ...(m.toolCalls ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, name: t.nombre, argumentsJson: t.argsJson })) } : {}) };
        if (m.role === "tool") return { role: "tool", toolCallId: m.toolCallId, content: m.content };
        return { role: "user", content: m.content };
      });
      const r = await proveedorDe(modelo, p.esfuerzo ?? cfg.esfuerzo).complete({
        system: p.system,
        messages: mensajes,
        tools: p.herramientas.map((h) => ({ name: h.name, description: h.description, parameters: h.parameters as unknown as Record<string, unknown> })),
        maxOutputTokens: cfg.topeSalidaTokens,
        ...(p.onTextDelta ? { onTextDelta: p.onTextDelta } : {}),
        ...(p.senal ? { signal: p.senal } : {}),
      });
      return {
        texto: r.text,
        toolCalls: (r.toolCalls ?? []).map((t) => ({ id: t.id, nombre: t.name, argsJson: t.argumentsJson })),
        costoMicroUsd: Math.max(0, Math.round(r.costUsd * 1_000_000)),
        costoReal: r.costSource === "provider",
        modelo,
        tokensEntrada: r.tokensIn,
        tokensSalida: r.tokensOut,
        ...(r.tokensCached !== undefined ? { tokensCache: r.tokensCached } : {}),
      };
    },
  };
}
