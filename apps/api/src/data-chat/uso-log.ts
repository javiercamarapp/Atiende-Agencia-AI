// Medicion de uso de "Chatea con tus datos" (CHAT-05, spec g.5): una linea estructurada por turno con la ruta por la que salio
// el texto (directa, barato, escalado, determinista), las llamadas al modelo y el costo reportado por el proveedor. Solo cifras
// operativas: nunca la pregunta, filas, nombres ni PII (y `logEvent` ademas pasa los campos por el scrub de PII).
// Persistirlo por organizacion/rol/mes requiere columnas nuevas en core.data_chat_query_log (migracion fuera de este lote).
import type { DataChatUsage } from "@atiende/agent-core/data-chat";
import { logEvent } from "../logger.ts";

export function logUsoDataChat(c: Parameters<typeof logEvent>[0], vertical: string): (uso: DataChatUsage) => void {
  return (uso) =>
    logEvent(c, "info", "data_chat_uso", {
      vertical,
      route: uso.route,
      llmCalls: uso.llmCalls,
      escalated: uso.escalated,
      costUsd: uso.costUsd,
      ...(uso.model ? { model: uso.model } : {}),
    });
}
