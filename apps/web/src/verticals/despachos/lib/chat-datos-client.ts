// "Chatea con tus datos" de despachos: rutas de apps/api `/despachos/:propertyId/chat-datos` (ver
// apps/api/src/routes/verticals/despachos/chat-datos.ts). Reutiliza `fetchJson`/`postJson` de este vertical
// (mismo refresh-y-reintento de sesion ante 401 que el resto del panel).
import { crearConexionChatDatos } from "../../../lib/chat-datos-conexion.ts";
import type { ChatDatosConexion } from "../../../components/PanelChateaConTusDatos.tsx";
import { fetchJson, postJson } from "./admin-client.ts";

/** Preguntas de ejemplo: todas dicen su periodo (o no lo necesitan) y estan dentro del catalogo de despachos. */
export const SUGERENCIAS_DESPACHOS: readonly string[] = [
  "¿Cuánto me deben mis clientes hoy?",
  "¿Cuánta cobranza tengo vencida por antigüedad?",
  "¿Cuántos CFDI se recibieron este mes?",
  "¿Qué obligaciones fiscales vencen este mes?",
  "¿Algún proveedor de mis clientes aparece en la lista 69-B del SAT?",
];

export function despachosChatBaseUrl(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/despachos/${encodeURIComponent(propertyId)}/chat-datos`;
}

export function conexionChatDatosDespachos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): ChatDatosConexion {
  return crearConexionChatDatos({
    clave: propertyId,
    baseUrl: despachosChatBaseUrl(apiBaseUrl, propertyId),
    transporte: {
      getJson: <T,>(url: string) => fetchJson<T>(fetchImpl, url, token),
      postJson: <T,>(url: string, payload: unknown) => postJson<T>(fetchImpl, url, token, payload),
    },
    sugerencias: SUGERENCIAS_DESPACHOS,
  });
}
