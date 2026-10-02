// Cliente de "Chatea con tus datos" para las verticales POR PROPIEDAD (hoteles, rentas): POST/GET a
// `${apiBaseUrl}/<vertical>/<propertyId>/chat-datos[/estado]` (apps/api/src/data-chat/vertical-routes.ts). Solo manda la
// pregunta y el historial de texto: el alcance (organizacion, propiedades, rol) lo decide el servidor a partir del
// token, nunca el cliente. Mismo refresh de sesion que el resto de clientes de cada vertical (`withAuthRefresh`).
// `fetchImpl` inyectado: ningun test toca la red.
import type { ChatDatosBloque, ChatDatosFuente, ChatDatosSinIa } from "@atiende/ui";
import type { ChatDatosConexion } from "../components/PanelChateaConTusDatos.tsx";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "./authed-fetch.ts";
import type { AuthedFetchContext, AuthedSession } from "./authed-fetch.ts";

export interface DataChatRespuesta {
  readonly status: string;
  readonly text: string;
  readonly blocks: readonly ChatDatosBloque[];
  readonly sources: readonly ChatDatosFuente[];
  readonly toolsUsed: readonly string[];
  /** Modo sin IA: consultas directas que ofrece el servidor (se muestran como botones). */
  readonly noAi?: ChatDatosSinIa;
}

export interface DataChatClientConfig<S extends AuthedSession> {
  readonly vertical: "hoteles" | "rentas" | "citas";
  /** Contexto de refresh de la sesion de ESA vertical (se construye en cada llamada: no toca localStorage hasta que hace falta). */
  readonly authContext: () => AuthedFetchContext<S>;
}

export const DATA_CHAT_MAX_HISTORY = 12;
export const DATA_CHAT_MAX_TURN_CHARS = 600;

function respuestaLocal(status: string, text: string): DataChatRespuesta {
  return { status, text, blocks: [], sources: [], toolsUsed: [] };
}

export function crearClienteDataChat<S extends AuthedSession>(cfg: DataChatClientConfig<S>) {
  const chatUrl = (apiBaseUrl: string, propertyId: string, suffix = "") => `${apiBaseUrl}/${cfg.vertical}/${encodeURIComponent(propertyId)}/chat-datos${suffix}`;

  return {
    /** true solo si el servidor confirma que el asistente esta activo para este rol; cualquier error cuenta como "no disponible". */
    async disponible(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<boolean> {
      try {
        const url = chatUrl(apiBaseUrl, propertyId, "/estado");
        const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), cfg.authContext(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
        if (!res.ok) return false;
        return ((await res.json()) as { available?: boolean }).available === true;
      } catch {
        return false;
      }
    },

    async preguntar(
      fetchImpl: typeof fetch,
      apiBaseUrl: string,
      token: string,
      propertyId: string,
      question: string,
      history: readonly { role: "user" | "assistant"; text: string }[],
    ): Promise<DataChatRespuesta> {
      const url = chatUrl(apiBaseUrl, propertyId);
      try {
        const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), cfg.authContext(), token, (t) =>
          fetchImpl(url, {
            method: "POST",
            headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
            body: JSON.stringify({ question, history: history.slice(-DATA_CHAT_MAX_HISTORY).map((m) => ({ role: m.role, text: m.text.slice(0, DATA_CHAT_MAX_TURN_CHARS) })) }),
          }),
        );
        if (res.status === 403) return respuestaLocal("unavailable", "Tu rol no tiene acceso a esta consulta.");
        if (!res.ok) return respuestaLocal("unavailable", "No pude consultar tus datos en este momento. Inténtalo de nuevo en unos minutos.");
        return (await res.json()) as DataChatRespuesta;
      } catch {
        return respuestaLocal("unavailable", "No pude conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
      }
    },

    /** MODO SIN IA: ejecuta una consulta del catalogo directo (cuerpo `{ tool }`, sin modelo). Mismo refresh y mismos errores honestos. */
    async ejecutarConsulta(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tool: string): Promise<DataChatRespuesta> {
      const url = chatUrl(apiBaseUrl, propertyId);
      try {
        const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), cfg.authContext(), token, (t) =>
          fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ tool }) }),
        );
        if (res.status === 403) return respuestaLocal("unavailable", "Tu rol no tiene acceso a esta consulta.");
        if (!res.ok) return respuestaLocal("unavailable", "No pude consultar tus datos en este momento. Inténtalo de nuevo en unos minutos.");
        return (await res.json()) as DataChatRespuesta;
      } catch {
        return respuestaLocal("unavailable", "No pude conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
      }
    },
  };
}

/** Arma la conexion que el shell le pasa a `BotonChatDatos`: solo la propiedad activa y el texto viajan al servidor. */
export function crearChatConexion<S extends AuthedSession>(
  cliente: ReturnType<typeof crearClienteDataChat<S>>,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  sugerencias: readonly string[],
): ChatDatosConexion {
  return {
    clave: propertyId,
    disponible: () => cliente.disponible(fetch, apiBaseUrl, token, propertyId),
    enviar: (pregunta, historial) => cliente.preguntar(fetch, apiBaseUrl, token, propertyId, pregunta, historial),
    ejecutarOpcion: (tool) => cliente.ejecutarConsulta(fetch, apiBaseUrl, token, propertyId, tool),
    sugerencias,
  };
}
