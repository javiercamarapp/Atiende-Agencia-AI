// Ejecucion de las herramientas pedidas por el LLM en un turno de la cascada v2: MISMA regla que la sesion de Gemini Live (`gemini-live-sesion.ts`):
// en SERIE y en el orden pedido (una cotizacion y un crear_pedido pedidos juntos nunca corren a la vez), salvo la racha INICIAL de herramientas de solo lectura
// declaradas en `enParalelo` (buscar cliente / sucursal / producto: sin estado compartido), que corre en paralelo conservando el orden de las respuestas.
import type { ToolCallLlmVoz } from "../cascada-openrouter.ts";
import type { ToolCallPedida } from "../sesion.ts";

export interface ResultadoHerramienta {
  readonly llamada: ToolCallLlmVoz;
  readonly salida: unknown;
}

function argumentosDe(argsJson: string): Record<string, unknown> {
  try {
    const p = JSON.parse(argsJson || "{}") as unknown;
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch {
    /* argumentos ilegibles: la herramienta los rechazara con su propio error */
  }
  return {};
}

export async function ejecutarHerramientas(
  llamadas: readonly ToolCallLlmVoz[],
  ejecutar: (llamada: ToolCallPedida) => Promise<unknown>,
  enParalelo?: ReadonlySet<string>,
): Promise<ResultadoHerramienta[]> {
  const una = async (tc: ToolCallLlmVoz): Promise<ResultadoHerramienta> => {
    try {
      return { llamada: tc, salida: await ejecutar({ id: tc.id, nombre: tc.nombre, args: argumentosDe(tc.argsJson) }) };
    } catch {
      return { llamada: tc, salida: { error: "herramienta_fallo" } };
    }
  };
  let racha = 0;
  while (enParalelo && racha < llamadas.length && enParalelo.has(llamadas[racha]?.nombre ?? "")) racha++;
  const resultados = racha > 1 ? await Promise.all(llamadas.slice(0, racha).map((tc) => una(tc))) : [];
  for (let i = resultados.length; i < llamadas.length; i++) resultados.push(await una(llamadas[i] as ToolCallLlmVoz));
  return resultados;
}
