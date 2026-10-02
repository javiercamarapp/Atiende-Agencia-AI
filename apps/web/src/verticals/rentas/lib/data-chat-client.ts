// "Chatea con tus datos" de RENTAS (solo admin_gestora/contador en el servidor): cliente generico
// (src/lib/data-chat-client.ts) con la sesion de rentas. El shell solo llama a `crearChatConexionRentas`.
import { crearChatConexion, crearClienteDataChat } from "../../../lib/data-chat-client.ts";
import { defaultBrowserStorage } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearRentasSession, persistRentasSession, readPersistedRentasSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";

export function rentasAuthContext(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "rentas",
    store: {
      read: () => (storage ? readPersistedRentasSession(storage) : null),
      persist: (session) => {
        if (storage) persistRentasSession(storage, session);
      },
      clear: () => {
        if (storage) clearRentasSession(storage);
      },
    },
  };
}

export const rentasDataChat = crearClienteDataChat({ vertical: "rentas", authContext: rentasAuthContext });

/** Preguntas de ejemplo: todas dicen su periodo (o no lo necesitan) y estan dentro del catalogo de rentas. */
export const SUGERENCIAS_RENTAS: readonly string[] = [
  "¿Cuál fue la ocupación por unidad el mes pasado?",
  "¿Cuánto ingresé por canal este mes?",
  "¿Qué conflictos de calendario siguen abiertos?",
  "¿Qué limpiezas están pendientes hasta hoy?",
];

export function crearChatConexionRentas(apiBaseUrl: string, token: string, propertyId: string) {
  return crearChatConexion(rentasDataChat, apiBaseUrl, token, propertyId, SUGERENCIAS_RENTAS);
}
