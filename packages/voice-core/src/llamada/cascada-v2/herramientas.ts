// Ejecucion de las herramientas pedidas por el LLM en un turno de la cascada v2: MISMA regla que la sesion de Gemini Live (`gemini-live-sesion.ts`):
// en SERIE y en el orden pedido (una cotizacion y un crear_pedido pedidos juntos nunca corren a la vez), salvo la racha INICIAL de herramientas de solo lectura
// declaradas en `enParalelo` (buscar cliente / sucursal / producto, sin estado compartido), que corre en paralelo conservando el orden de las respuestas.
// Dos guardas propias del streaming:
//  - `continuar`: se consulta ANTES de cada herramienta en serie. Si el cliente interrumpio ("no, espere") a media confirmar_resumen, lo que sigue NO corre
//    (respuesta `interrumpido_por_el_cliente`): un crear_pedido nunca se ejecuta sobre un resumen que el cliente acaba de rechazar.
//  - `confirmacionAntesDeCrear`: Anthropic en OpenRouter no admite `parallel_tool_calls` (con require_parameters daria 404), asi que el cliente impide que el modelo
//    confirme y cree en la MISMA respuesta: tras `confirmar`, un `crear` posterior espera la respuesta del cliente (`espera_confirmacion_del_cliente`).
import type { ToolCallLlmVoz } from "../cascada-openrouter.ts";
import type { ToolCallPedida } from "../sesion.ts";

export interface ResultadoHerramienta {
  readonly llamada: ToolCallLlmVoz;
  readonly salida: unknown;
}

export interface OpcionesHerramientas {
  readonly enParalelo?: ReadonlySet<string>;
  readonly confirmacionAntesDeCrear?: { readonly confirmar: string; readonly crear: string };
  /** Falso = el turno ya no esta vigente (el cliente interrumpio o la llamada cerro): no se inicia ninguna herramienta mas. */
  readonly continuar?: () => boolean;
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
  opciones: OpcionesHerramientas = {},
): Promise<ResultadoHerramienta[]> {
  const { enParalelo, confirmacionAntesDeCrear: regla, continuar } = opciones;
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
  let confirmoEnEstaRespuesta = resultados.some((r) => regla !== undefined && r.llamada.nombre === regla.confirmar);
  for (let i = resultados.length; i < llamadas.length; i++) {
    const tc = llamadas[i] as ToolCallLlmVoz;
    if (continuar && !continuar()) {
      resultados.push({ llamada: tc, salida: { error: "interrumpido_por_el_cliente", mensaje: "El cliente interrumpio: no se ejecuto. Escuche lo que dice antes de continuar." } });
      continue;
    }
    if (regla && confirmoEnEstaRespuesta && tc.nombre === regla.crear) {
      resultados.push({ llamada: tc, salida: { error: "espera_confirmacion_del_cliente", mensaje: "Lea el resumen al cliente y espere su respuesta antes de crear el pedido." } });
      continue;
    }
    resultados.push(await una(tc));
    if (regla && tc.nombre === regla.confirmar) confirmoEnEstaRespuesta = true;
  }
  return resultados;
}
