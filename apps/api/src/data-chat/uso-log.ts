// Medicion de uso de "Chatea con tus datos" (CHAT-05, spec g.5): una linea estructurada por turno con la ruta por la que salio
// el texto (directa, barato, escalado, determinista), las llamadas al modelo y el costo reportado por el proveedor. Solo cifras
// operativas: nunca la pregunta, filas, nombres ni PII (y `logEvent` ademas pasa los campos por el scrub de PII).
// La persistencia por organizacion/rol/mes vive en core.data_chat_query_log (costo, modelo, rol y ruta: migracion 0046, via la
// fila de resumen del turno que escribe el motor) y en core.llm_usage_daily (gateway).
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
      costMicroUsd: uso.costMicroUsd,
      ...(uso.model ? { model: uso.model } : {}),
    });
}
