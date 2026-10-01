// Cuerpo comun de las rutas de "Chatea con tus datos": SOLO la pregunta y el historial de texto. Cualquier
// otro campo (organizacion, cliente, ids, rol, SQL...) se rechaza con 400: el alcance lo fija el servidor.
import type { DataChatHistoryTurn } from "@atiende/agent-core/data-chat";
import { Errors } from "../errors.ts";

export const MAX_BODY_HISTORY = 12;

export function parseDataChatBody(raw: unknown): { question: string; history: DataChatHistoryTurn[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo inválido: se esperaba un objeto JSON.");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "question" && key !== "history") throw Errors.validation(`Campo no permitido: ${key.slice(0, 40)}.`);
  }
  if (typeof body["question"] !== "string") throw Errors.validation("question: se esperaba texto.");
  const history: DataChatHistoryTurn[] = [];
  const rawHistory = body["history"];
  if (rawHistory !== undefined) {
    if (!Array.isArray(rawHistory) || rawHistory.length > MAX_BODY_HISTORY) throw Errors.validation(`history: se esperaba una lista de a lo mucho ${MAX_BODY_HISTORY} turnos.`);
    for (const item of rawHistory) {
      const t = item as { role?: unknown; text?: unknown };
      if ((t?.role !== "user" && t?.role !== "assistant") || typeof t.text !== "string") throw Errors.validation("history: cada turno debe ser {role: 'user'|'assistant', text}.");
      history.push({ role: t.role, text: t.text });
    }
  }
  return { question: body["question"], history };
}
