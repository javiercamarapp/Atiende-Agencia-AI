// Cerebro v2, bloque 4 (SUELTO-VS-718-V2.md): el hilo de WhatsApp del monorrepo guarda solo texto, y las guardas de sesión del suelto (motivoOtroPedidoEnSesion,
// idsPedidosCreadosEnSesion) leen los tool_calls y los resultados del hilo. ADITIVO: el mensaje del asistente de un turno v2 guarda en `herramientas` (campo nuevo y
// opcional del jsonb del hilo; sin migración) las llamadas que esas guardas leen, con su resultado RECORTADO a lo que leen; aquí el hilo se expande al formato del
// suelto ({role:"assistant", tool_calls} + {role:"tool", tool_call_id, content, at}). Nunca se manda al modelo ni a la bandeja (toLlmHistory lee rol y texto). Pura.
import type { ConversationMessage, HerramientaDelHilo } from "../../repository.ts";
import type { MensajeHilo } from "./texto-plano.ts";

/** Las herramientas que leen las guardas de sesión del suelto (leerPedidosDeSesion). */
export const HERRAMIENTAS_DEL_HILO: ReadonlySet<string> = new Set(["cotizar_pedido", "crear_pedido", "estado_pedido"]);
const TOPE_ARGUMENTOS = 4000;

/** El resultado de una herramienta con solo lo que leen las guardas (sin datos del cliente de más): null si no se guarda (error o ilegible). */
export function resultadoParaElHilo(nombre: string, resultado: unknown): string | null {
  const r = resultado as { error?: unknown; quote?: { lines?: unknown; total?: unknown }; order?: { id?: unknown; items?: unknown; created_at?: unknown }; pedidos?: unknown; aclarar_unidad?: unknown } | null;
  if (!r || typeof r !== "object" || "error" in r) return null;
  if (nombre === "cotizar_pedido" && r.quote && !("aclarar_unidad" in r)) {
    const lines = Array.isArray(r.quote.lines) ? r.quote.lines.map((l: { product_id?: unknown; name?: unknown; quantity?: unknown }) => ({ product_id: l?.product_id, name: l?.name, quantity: l?.quantity })) : [];
    return JSON.stringify({ quote: { lines, total: r.quote.total } });
  }
  if (nombre === "crear_pedido" && r.order?.id) {
    const items = Array.isArray(r.order.items) ? r.order.items.map((i: { id?: unknown; productId?: unknown; name?: unknown; quantity?: unknown }) => ({ id: i?.id ?? i?.productId, name: i?.name, quantity: i?.quantity })) : [];
    return JSON.stringify({ order: { id: r.order.id, items } });
  }
  if (nombre === "estado_pedido" && Array.isArray(r.pedidos)) {
    return JSON.stringify({ pedidos: r.pedidos.map((p: { folio?: unknown; estado?: unknown }) => ({ folio: p?.folio, estado: p?.estado })) });
  }
  return null;
}

/** Una llamada para guardar en el hilo, o null. */
export function herramientaParaElHilo(id: string, nombre: string, argumentos: unknown, resultado: unknown, at: string): HerramientaDelHilo | null {
  if (!HERRAMIENTAS_DEL_HILO.has(nombre)) return null;
  const res = resultadoParaElHilo(nombre, resultado);
  if (res === null) return null;
  const args = JSON.stringify(argumentos ?? {});
  return { id, nombre, argumentos: args.length > TOPE_ARGUMENTOS ? "{}" : args, resultado: res, at };
}

/** El hilo del monorrepo en el formato del suelto: cada mensaje con `herramientas` se antepone con sus llamadas y resultados (van ANTES del texto, como en el turno). */
export function hiloDelSuelto(messages: readonly Pick<ConversationMessage, "role" | "content" | "at" | "herramientas">[]): MensajeHilo[] {
  const out: MensajeHilo[] = [];
  for (const m of messages) {
    const hs = m.role === "assistant" ? (m.herramientas ?? []) : [];
    if (hs.length > 0) {
      out.push({ role: "assistant", content: "", tool_calls: hs.map((h) => ({ id: h.id, type: "function", function: { name: h.nombre, arguments: h.argumentos } })) });
      for (const h of hs) out.push({ role: "tool", tool_call_id: h.id, content: h.resultado, at: h.at });
    }
    out.push({ role: m.role, content: m.content, ...(m.at ? { at: m.at } : {}) });
  }
  return out;
}
