// Cuerpo comun de las rutas de "Chatea con tus datos": SOLO la pregunta y el historial de texto. Cualquier
// otro campo (organizacion, cliente, ids, rol, SQL...) se rechaza con 400: el alcance lo fija el servidor.
import type { DataChatHistoryTurn } from "@atiende/agent-core/data-chat";
import { Errors } from "../errors.ts";

const CONVERSATION_ID_RE = /^(?:new|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface DataChatRequestBody {
  readonly question: string;
  readonly history: DataChatHistoryTurn[];
  readonly tool?: string;
  /** `"new"` = guardar este turno en una conversacion nueva; un uuid = continuar esa conversacion (el historial sale
   *  de la base). Ausente = el comportamiento de siempre: nada se guarda y el historial lo aporta el cuerpo. */
  readonly conversationId?: string;
}

export const MAX_BODY_HISTORY = 12;

const TOOL_NAME_RE = /^[a-z0-9_]{1,60}$/;

/** `tool` (opcional) es el boton del MODO SIN IA: nombre de una herramienta del catalogo, que el motor ejecuta
 *  directo sin llamar al modelo. Va en lugar de `question` (no ambos); el motor valida que exista en el catalogo. */
export function parseDataChatBody(raw: unknown): DataChatRequestBody {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo inválido: se esperaba un objeto JSON.");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "question" && key !== "history" && key !== "tool" && key !== "conversationId") throw Errors.validation(`Campo no permitido: ${key.slice(0, 40)}.`);
  }
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
  let conversationId: string | undefined;
  if (body["conversationId"] !== undefined) {
    if (typeof body["conversationId"] !== "string" || !CONVERSATION_ID_RE.test(body["conversationId"])) throw Errors.validation("conversationId: se esperaba 'new' o el id de una conversación.");
    // El historial del modelo sale de la base: el cliente no puede aportar turnos propios (ni falsificar los del asistente).
    if (history.length > 0) throw Errors.validation("history no se acepta junto con conversationId: el historial sale de la conversación guardada.");
    conversationId = body["conversationId"].toLowerCase();
  }
  const extra = conversationId === undefined ? {} : { conversationId };
  if (body["tool"] !== undefined) {
    if (body["question"] !== undefined) throw Errors.validation("Usa 'question' o 'tool', no ambos.");
    if (typeof body["tool"] !== "string" || !TOOL_NAME_RE.test(body["tool"])) throw Errors.validation("tool: se esperaba el nombre de una consulta del catálogo.");
    return { question: "", history, tool: body["tool"], ...extra };
  }
  if (typeof body["question"] !== "string") throw Errors.validation("question: se esperaba texto.");
  return { question: body["question"], history, ...extra };
}

/** Lee y valida el cuerpo de la peticion. UNICO punto para las seis rutas del chat: mismo mensaje de JSON invalido y
 *  mismas reglas de campos, para que ninguna vertical se desvie. */
export async function parseDataChatRequest(c: { req: { json(): Promise<unknown> } }): Promise<DataChatRequestBody> {
  const raw: unknown = await c.req.json().catch(() => {
    throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
  });
  return parseDataChatBody(raw);
}
