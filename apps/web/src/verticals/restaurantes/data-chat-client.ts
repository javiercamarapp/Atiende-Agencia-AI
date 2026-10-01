// Cliente de "Chatea con tus datos" (restaurantes): POST/GET a las rutas de apps/api
// `/v1/restaurantes/:propertyId/admin/chat-datos`. Solo manda la pregunta y el historial de texto: el
// alcance (organizacion, sucursales, rol) lo decide el servidor a partir del token, nunca el cliente.
// Mismo refresh de sesion que el resto de clientes de restaurantes (`withAuthRefresh`).
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../lib/authed-fetch.ts";
import { restaurantesAuthContext } from "./dashboard-client.ts";
import type { ChatDatosBloque, ChatDatosFuente } from "@atiende/ui";

export interface DataChatRespuesta {
  readonly status: string;
  readonly text: string;
  readonly blocks: readonly ChatDatosBloque[];
  readonly sources: readonly ChatDatosFuente[];
  readonly toolsUsed: readonly string[];
}

/** Preguntas de ejemplo: todas dicen su periodo y estan dentro del catalogo de restaurantes. */
export const SUGERENCIAS_RESTAURANTES: readonly string[] = [
  "¿Cuánto vendí esta semana?",
  "¿Cuáles son mis productos más vendidos este mes?",
  "¿A qué horas tengo más pedidos en los últimos 30 días?",
  "¿Qué canal me trae más pedidos este mes?",
];

const MAX_HISTORY = 12;
const MAX_TURN_CHARS = 600;

function chatUrl(apiBaseUrl: string, propertyId: string, suffix = ""): string {
  return `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/chat-datos${suffix}`;
}

/** true solo si el servidor confirma que el asistente esta activo; cualquier error cuenta como "no disponible". */
export async function fetchDataChatDisponible(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<boolean> {
  try {
    const url = chatUrl(apiBaseUrl, propertyId, "/estado");
    const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), restaurantesAuthContext(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
    if (!res.ok) return false;
    return ((await res.json()) as { available?: boolean }).available === true;
  } catch {
    return false;
  }
}

export async function preguntarDatos(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  question: string,
  history: readonly { role: "user" | "assistant"; text: string }[],
): Promise<DataChatRespuesta> {
  const url = chatUrl(apiBaseUrl, propertyId);
  try {
    const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), restaurantesAuthContext(), token, (t) =>
      fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ question, history: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, text: m.text.slice(0, MAX_TURN_CHARS) })) }) }),
    );
    if (res.status === 403) return respuestaLocal("unavailable", "Tu rol no tiene acceso a esta consulta.");
    if (!res.ok) return respuestaLocal("unavailable", "No pude consultar tus datos en este momento. Inténtalo de nuevo en unos minutos.");
    return (await res.json()) as DataChatRespuesta;
  } catch {
    return respuestaLocal("unavailable", "No pude conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
  }
}

function respuestaLocal(status: string, text: string): DataChatRespuesta {
  return { status, text, blocks: [], sources: [], toolsUsed: [] };
}
