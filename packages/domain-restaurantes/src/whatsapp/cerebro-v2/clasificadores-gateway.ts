// Cerebro v2: los dos clasificadores LLM del suelto (intencion-pedido-aparte.ts y clasificador-alergia.ts) conectados al gateway del monorrepo. El suelto
// llamaba a OpenRouter con su llave y Gemini 3.5 Flash-Lite; aqui la llamada va por `LlmGateway.complete` con el rol que pasa quien conecta (en produccion
// `restaurantes:whatsapp_clasificador`, actividad `clasificacion_whatsapp` de la tabla central de modelos de apps/api), SIEMPRE con retencion cero
// (`zdrEstricto`), temperatura 0, salida estructurada y el plazo del suelto como AbortSignal. Cualquier falla (sin escalera, plazo, proveedor, JSON
// invalido) => null: el llamador queda en el camino conservador del suelto (solo la regex; la guarda del pedido aparte en modo R24).
import { randomUUID } from "node:crypto";
import type { LlmGateway, LlmMessage } from "@atiende/agent-core";
import { ESQUEMA_ALERGIA, mensajesClasificadorAlergia, NOMBRE_ESQUEMA_ALERGIA, parsearClasificadorAlergia, type ClasificadorAlergia } from "./clasificador-alergia.ts";
import { ESQUEMA_INTENCION, mensajesIntencionPedidoAparte, parsearIntencionPedidoAparte, type ClasificadorPedidoAparte } from "./pedido-aparte.ts";

export interface ConexionClasificador {
  readonly organizationId: string;
  /** Rol del gateway con escalera de retencion cero registrada. */
  readonly role: string;
}

async function llamar(gateway: LlmGateway, c: ConexionClasificador, mensajes: ReadonlyArray<{ role: string; content: string }>, formato: { name: string; schema: Record<string, unknown> }, plazoMs: number): Promise<string | null> {
  const system = mensajes.find((m) => m.role === "system")?.content ?? "";
  const resto: LlmMessage[] = mensajes.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  try {
    const r = await gateway.complete({
      tenantId: c.organizationId,
      runId: randomUUID(),
      lane: "interactive",
      role: c.role,
      zdrEstricto: true,
      request: { system, messages: resto, temperature: 0, maxOutputTokens: 200, responseFormat: formato, signal: AbortSignal.timeout(Math.max(1, Math.floor(plazoMs))) },
    });
    return typeof r.text === "string" ? r.text : null;
  } catch {
    return null;
  }
}

/** ClasificadorAlergia del suelto por el gateway. La «llave» del contexto no se usa (la tiene el gateway). */
export function clasificadorAlergiaPorGateway(gateway: LlmGateway, c: ConexionClasificador): ClasificadorAlergia {
  return async (texto, ctx) => parsearClasificadorAlergia(await llamar(gateway, c, mensajesClasificadorAlergia(texto), { name: NOMBRE_ESQUEMA_ALERGIA, schema: ESQUEMA_ALERGIA }, ctx.plazoMs));
}

/** ClasificadorPedidoAparte del suelto por el gateway. «indefinido» cuenta como sin decision (null), como en el suelto. */
export function clasificadorApartePorGateway(gateway: LlmGateway, c: ConexionClasificador): ClasificadorPedidoAparte {
  return async (entrada, ctx) => {
    const intencion = parsearIntencionPedidoAparte(await llamar(gateway, c, mensajesIntencionPedidoAparte(entrada), { name: "intencion_pedido_aparte", schema: ESQUEMA_INTENCION }, ctx.plazoMs));
    return intencion === "indefinido" ? null : intencion;
  };
}
