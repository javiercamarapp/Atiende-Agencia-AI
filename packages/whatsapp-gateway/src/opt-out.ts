// PL-32 -- deteccion DETERMINISTA de baja (BAJA/STOP) y reactivacion (ALTA/START) de avisos proactivos de WhatsApp.
// Modulo puro y compartido por las verticales: sin red, sin LLM, sin base de datos. El webhook de cada vertical
// lo llama ANTES del agente; que el mensaje sea una baja nunca depende de un modelo.
//
// Regla de oro anti falsos positivos: el mensaje COMPLETO (sin saludos ni relleno) debe ser la orden. Una palabra
// dentro de una frase ("no puedo ir, baja la cita", "stop por favor no, quiero reagendar") NUNCA dispara.
//
// CANCELAR: en citas/hoteles/restaurantes "cancelar" casi siempre significa cancelar la cita, la reserva o el
// pedido, asi que NO se trata como baja por omision (`cancelarEsBaja: false`). Quien lo necesite lo activa.

export type IntencionOptOut = "baja" | "alta" | null;

export interface OpcionesDeteccionOptOut {
  /** `true` = el mensaje "cancelar" cuenta como baja. Por omision `false` (ver cabecera). */
  readonly cancelarEsBaja?: boolean;
}

const FRASES_BAJA: ReadonlySet<string> = new Set([
  "baja",
  "stop",
  "alto",
  "unsubscribe",
  "darme de baja",
  "dar de baja",
  "darse de baja",
  "dame de baja",
  "quiero la baja",
  "no mas mensajes",
  "no quiero mas mensajes",
  "ya no quiero mensajes",
  "ya no quiero recibir mensajes",
  "no me escriban mas",
  "no me envien mas mensajes",
  "dejar de recibir mensajes",
  "cancelar suscripcion",
  "cancelar mensajes",
  "cancelar avisos",
]);

const FRASES_ALTA: ReadonlySet<string> = new Set([
  "alta",
  "start",
  "reactivar",
  "reactivar avisos",
  "reactivar mensajes",
  "quiero recibir mensajes",
  "quiero recibir avisos",
  "volver a recibir mensajes",
  "volver a recibir avisos",
  "suscribirme",
]);

/** Minusculas, sin acentos, sin signos ni emojis, espacios colapsados. NO quita cortesias: "stop por favor" ya es una frase, no la orden sola. */
export function normalizarTextoOptOut(texto: string): string {
  if (typeof texto !== "string") return "";
  let t = texto.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
  // Sustituye todo lo que no sea letra, numero o espacio por espacio: quita puntuacion, emojis y signos de apertura.
  t = t.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
  return t;
}

/** Clasifica un mensaje entrante: `"baja"`, `"alta"` o `null` (texto normal, sigue al agente). */
export function detectarOptOut(texto: string, opciones: OpcionesDeteccionOptOut = {}): IntencionOptOut {
  const t = normalizarTextoOptOut(texto);
  if (t === "" || t.length > 40) return null;
  if (FRASES_BAJA.has(t)) return "baja";
  if (opciones.cancelarEsBaja === true && t === "cancelar") return "baja";
  if (FRASES_ALTA.has(t)) return "alta";
  return null;
}
