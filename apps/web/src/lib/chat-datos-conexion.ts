// Conexion generica de "Chatea con tus datos" para las verticales cuyo cliente HTTP ya trae el refresh de
// sesion (despachos, licitaciones): arma el `ChatDatosConexion` que consumen `BotonChatDatos` y
// `MobileHeaderActions`. SOLO manda la pregunta y el historial de texto: el alcance (organizacion,
// clientes, rol, zona horaria) lo decide el servidor a partir del token, nunca el cliente. Cualquier error
// degrada a un aviso honesto, nunca a una excepcion ni a una respuesta simulada.
import type { ChatDatosBloque, ChatDatosFuente, ChatDatosSinIa } from "@atiende/ui";
import type { ChatDatosConexion } from "../components/PanelChateaConTusDatos.tsx";

export interface DataChatRespuesta {
  readonly status: string;
  readonly text: string;
  readonly blocks: readonly ChatDatosBloque[];
  readonly sources: readonly ChatDatosFuente[];
  readonly toolsUsed?: readonly string[];
  /** Modo sin IA: consultas directas que ofrece el servidor (se muestran como botones). */
  readonly noAi?: ChatDatosSinIa;
}

/** Mismos topes que valida el servidor (12 turnos de historial; 600 caracteres por turno). */
export const MAX_HISTORY = 12;
export const MAX_TURN_CHARS = 600;

export interface TransporteChatDatos {
  readonly getJson: <T>(url: string) => Promise<T>;
  readonly postJson: <T>(url: string, payload: unknown) => Promise<T>;
}

function respuestaLocal(status: string, text: string): DataChatRespuesta {
  return { status, text, blocks: [], sources: [], toolsUsed: [] };
}

/** true solo si el servidor confirma que el asistente esta activo; cualquier error cuenta como "no disponible". */
export async function consultarDisponibilidad(transporte: TransporteChatDatos, baseUrl: string): Promise<boolean> {
  try {
    return (await transporte.getJson<{ available?: boolean }>(`${baseUrl}/estado`)).available === true;
  } catch {
    return false;
  }
}

export async function enviarPregunta(
  transporte: TransporteChatDatos,
  baseUrl: string,
  question: string,
  history: readonly { role: "user" | "assistant"; text: string }[],
): Promise<DataChatRespuesta> {
  try {
    return await transporte.postJson<DataChatRespuesta>(baseUrl, {
      question,
      history: history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, text: m.text.slice(0, MAX_TURN_CHARS) })),
    });
  } catch (err) {
    // Un fallo de red del navegador ("Failed to fetch"/TypeError) se distingue de una respuesta HTTP de error.
    if (err instanceof TypeError) return respuestaLocal("unavailable", "No pude conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
    return respuestaLocal("unavailable", "No pude consultar tus datos en este momento. Inténtalo de nuevo en unos minutos.");
  }
}

/** MODO SIN IA: ejecuta una consulta del catalogo directo (cuerpo `{ tool }`, sin modelo). Mismos errores honestos. */
export async function ejecutarConsultaDirecta(transporte: TransporteChatDatos, baseUrl: string, tool: string): Promise<DataChatRespuesta> {
  try {
    return await transporte.postJson<DataChatRespuesta>(baseUrl, { tool });
  } catch (err) {
    if (err instanceof TypeError) return respuestaLocal("unavailable", "No pude conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
    return respuestaLocal("unavailable", "No pude consultar tus datos en este momento. Inténtalo de nuevo en unos minutos.");
  }
}

export function crearConexionChatDatos(opts: { clave: string; baseUrl: string; transporte: TransporteChatDatos; sugerencias: readonly string[] }): ChatDatosConexion {
  return {
    clave: opts.clave,
    disponible: () => consultarDisponibilidad(opts.transporte, opts.baseUrl),
    enviar: (pregunta, historial) => enviarPregunta(opts.transporte, opts.baseUrl, pregunta, historial),
    ejecutarOpcion: (tool) => ejecutarConsultaDirecta(opts.transporte, opts.baseUrl, tool),
    sugerencias: opts.sugerencias,
  };
}
