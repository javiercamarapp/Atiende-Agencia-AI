// "Chatea con tus datos" de licitaciones: rutas de apps/api `/licitaciones/:propertyId/chat-datos` (ver
// apps/api/src/routes/verticals/licitaciones/chat-datos.ts). Reutiliza `fetchJson`/`postJson` de este
// vertical (mismo refresh-y-reintento de sesion ante 401 que el resto del panel).
import { crearConexionChatDatos } from "../../../lib/chat-datos-conexion.ts";
import type { ChatDatosConexion } from "../../../components/PanelChateaConTusDatos.tsx";
import { fetchJson, postJson } from "./admin-client.ts";

/** Preguntas de ejemplo: todas estan dentro del catalogo de licitaciones y dicen su horizonte o periodo. */
export const SUGERENCIAS_LICITACIONES: readonly string[] = [
  "¿Qué convocatorias vencen en los próximos 7 días?",
  "¿Cómo va el semáforo de mis plazos?",
  "¿Qué decisiones go/no-go tomé este mes?",
  "¿Cuántas propuestas tengo por estado?",
  "¿Qué contratos terminan su vigencia en los próximos 90 días?",
];

export function licitacionesChatBaseUrl(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/licitaciones/${encodeURIComponent(propertyId)}/chat-datos`;
}

export function conexionChatDatosLicitaciones(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): ChatDatosConexion {
  return crearConexionChatDatos({
    clave: propertyId,
    baseUrl: licitacionesChatBaseUrl(apiBaseUrl, propertyId),
    transporte: {
      getJson: <T,>(url: string) => fetchJson<T>(fetchImpl, url, token),
      postJson: <T,>(url: string, payload: unknown) => postJson<T>(fetchImpl, url, token, payload),
    },
    sugerencias: SUGERENCIAS_LICITACIONES,
  });
}
