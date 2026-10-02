// "Chatea con tus datos" de HOTELES (solo owner/gm en el servidor): cliente generico (src/lib/data-chat-client.ts) con la
// sesion de hoteles. El shell solo llama a `crearChatConexionHoteles`.
import { crearChatConexion, crearClienteDataChat } from "../../../lib/data-chat-client.ts";
import { defaultBrowserStorage } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearHotelesSession, persistHotelesSession, readPersistedHotelesSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";

export function hotelesAuthContext(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "hoteles",
    store: {
      read: () => (storage ? readPersistedHotelesSession(storage) : null),
      persist: (session) => {
        if (storage) persistHotelesSession(storage, session);
      },
      clear: () => {
        if (storage) clearHotelesSession(storage);
      },
    },
  };
}

export const hotelesDataChat = crearClienteDataChat({ vertical: "hoteles", authContext: hotelesAuthContext });

/** Preguntas de ejemplo: todas dicen su periodo y estan dentro del catalogo de hoteles. */
export const SUGERENCIAS_HOTELES: readonly string[] = [
  "¿Cómo va la ocupación esta semana?",
  "¿Cuál fue el ADR y el RevPAR de los últimos 30 días?",
  "¿Qué llegadas y salidas tengo mañana?",
  "¿Cuántos tickets abiertos tengo con el SLA vencido?",
];

export function crearChatConexionHoteles(apiBaseUrl: string, token: string, propertyId: string) {
  return crearChatConexion(hotelesDataChat, apiBaseUrl, token, propertyId, SUGERENCIAS_HOTELES);
}
