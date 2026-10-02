// "Pregunta a tus datos" de CITAS (solo owner/admin en el servidor): cliente generico (src/lib/data-chat-client.ts) con la sesion
// de citas. El shell lo usa solo para saber si el asistente esta activo (pildora del pie y boton del header); la conversacion
// vive en la pagina del Copiloto (pages/Copiloto.tsx), no en un dialogo.
import { crearChatConexion, crearClienteDataChat } from "../../../lib/data-chat-client.ts";
import { SUGERENCIAS_COPILOTO_CITAS } from "../../../lib/copiloto/config/citas.ts";
import { defaultAuthCtx } from "./admin-client.ts";

export const citasDataChat = crearClienteDataChat({ vertical: "citas", authContext: defaultAuthCtx });

export function crearChatConexionCitas(apiBaseUrl: string, token: string, propertyId: string) {
  return crearChatConexion(citasDataChat, apiBaseUrl, token, propertyId, SUGERENCIAS_COPILOTO_CITAS);
}
