// Cliente OpenRouter minimo para el simulador de cliente y el juez. Lleva la cuenta del gasto REAL (usage.cost).
export const gasto = { usd: 0, calls: 0 };
const MODEL = process.env.QA_MODEL ?? "openai/gpt-6-luna";
export async function chat(messages: { role: string; content: string }[], opts: { max?: number; json?: boolean; model?: string } = {}): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model ?? MODEL, messages, max_tokens: opts.max ?? 1500, reasoning: { effort: "low" }, usage: { include: true }, provider: { data_collection: "deny" }, ...(opts.json ? { response_format: { type: "json_object" } } : {}) }),
    });
    if (!r.ok) { if (i === 3) throw new Error(`openrouter ${r.status} ${(await r.text()).slice(0, 200)}`); await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
    const j = (await r.json()) as { choices: { message: { content: string } }[]; usage?: { cost?: number } };
    gasto.usd += j.usage?.cost ?? 0; gasto.calls++;
    return j.choices[0]?.message.content ?? "";
  }
  return "";
}

// ---- Contador de gasto (ronda 9, falso reporte del arnes) ----
// `gasto.usd` solo suma lo que pasa por chat() de ESTE archivo: cliente simulado + juez. Las llamadas del AGENTE
// (el producto, por el gateway con la misma llave) NO pasan por aqui, asi que el contador subestima. Ronda 9 medido:
// contador 0.73 (WhatsApp) + 0.12 (juez de voz) = 0.85 contra 1.556 reales en OpenRouter (/auth/key) => factor ~1.83.
// El factor depende de cuantos turnos hace el agente por escenario: es solo una referencia, NO una medicion.
export const FACTOR_SUBESTIMACION_R9 = 1.83;
export const GASTO_CONTADOR_R9 = 0.85;
export const GASTO_REAL_R9 = 1.556;
/** Uso acumulado real de la llave en USD (GET /auth/key; no gasta nada). null si no hay llave o falla la consulta. */
export async function usoRealOpenRouter(): Promise<number | null> {
  if (!process.env.OPENROUTER_API_KEY) return null;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { usage?: number } };
    return typeof j.data?.usage === "number" ? j.data.usage : null;
  } catch { return null; }
}
/** Texto de cierre: contador del arnes, delta REAL medido (si hubo `antes`) y estimacion con el factor de la ronda 9. */
export async function resumenGasto(antes: number | null, conFactor = true): Promise<string> {
  const despues = await usoRealOpenRouter();
  const est = (gasto.usd * Number(process.env.QA_FACTOR_GASTO ?? FACTOR_SUBESTIMACION_R9)).toFixed(3);
  const real = antes !== null && despues !== null ? `REAL medido (/auth/key, delta) $${(despues - antes).toFixed(3)}` : "REAL no medido (sin llave o sin /auth/key)";
  // voz: el agente es Gemini (no pasa por OpenRouter); el contador ya incluye todo lo de OpenRouter (juez), asi que el factor no aplica.
  return `contador del arnes (cliente+juez) $${gasto.usd.toFixed(3)} | ${real}` + (conFactor ? ` | estimado = contador x ${process.env.QA_FACTOR_GASTO ?? FACTOR_SUBESTIMACION_R9} (factor R9, referencia; agrega las llamadas del agente) $${est}` : "");
}
