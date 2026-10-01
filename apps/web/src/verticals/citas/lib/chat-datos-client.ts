// "Chatea con tus datos" de citas: rutas de apps/api `/citas/:propertyId/chat-datos` (ver
// apps/api/src/routes/verticals/citas/admin-data-chat.ts). Reutiliza `fetchJson`/`postJson` de este vertical (mismo
// refresh-y-reintento de sesion ante 401 que el resto del panel). El rol (owner/admin) lo decide el servidor: para otro rol
// `/estado` responde 403 y el boton sigue con el aviso honesto.
import { crearConexionChatDatos } from "../../../lib/chat-datos-conexion.ts";
import type { ChatDatosConexion } from "../../../components/PanelChateaConTusDatos.tsx";
import { fetchJson, postJson } from "./admin-client.ts";

/** Preguntas de ejemplo: todas dicen su periodo (o no lo necesitan) y estan dentro del catalogo de citas. */
export const SUGERENCIAS_CITAS: readonly string[] = [
  "¿Cuántas citas tengo esta semana?",
  "¿Cuál es la ocupación de cada profesional este mes?",
  "¿Cuántas citas se cancelaron o no asistieron el mes pasado?",
  "¿Cuánto facturé por servicio este mes?",
  "¿Cuántos clientes nuevos y recurrentes tuve este mes?",
  "¿Qué huecos libres tengo mañana?",
  "¿Cuántos recordatorios fallaron esta semana?",
];

export function citasChatBaseUrl(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/citas/${encodeURIComponent(propertyId)}/chat-datos`;
}

export function conexionChatDatosCitas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): ChatDatosConexion {
  return crearConexionChatDatos({
    clave: propertyId,
    baseUrl: citasChatBaseUrl(apiBaseUrl, propertyId),
    transporte: {
      getJson: <T,>(url: string) => fetchJson<T>(fetchImpl, url, token),
      postJson: <T,>(url: string, payload: unknown) => postJson<T>(fetchImpl, url, token, payload),
    },
    sugerencias: SUGERENCIAS_CITAS,
  });
}
