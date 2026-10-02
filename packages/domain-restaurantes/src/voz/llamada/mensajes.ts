// Mensajes PREGRABADOS de la llamada (es-MX, trato de usted). Son el texto de los avisos que el servicio de voz debe poder
// decir SIN depender del proveedor de voz: se reproducen desde un audio local (la sintesis del proveedor puede ser justo lo que
// fallo). Aqui vive el texto y el identificador; los archivos de audio los graba/sintetiza el equipo una sola vez y se
// publican junto al worker (ver docs/VOZ-PM.md, "Mensajes pregrabados"). Ningun mensaje lleva datos del cliente.
import { saludoPorHora } from "../../whatsapp/perfil-pm.ts";

export const MENSAJES_PREGRABADOS = {
  // Sin palabra de saludo: es el de reserva cuando NO se sabe la hora local (decir "buenas tardes" a toda hora era la regresion X40).
  saludo_respaldo: "Gracias por llamar a Los Taquitos de PM. En un momento le atendemos.",
  // Uno por franja: el audio es pregrabado, asi que el saludo segun la hora se elige entre archivos, no se sintetiza.
  saludo_respaldo_dias: "Buenos días, gracias por llamar a Los Taquitos de PM. En un momento le atendemos.",
  saludo_respaldo_tardes: "Buenas tardes, gracias por llamar a Los Taquitos de PM. En un momento le atendemos.",
  saludo_respaldo_noches: "Buenas noches, gracias por llamar a Los Taquitos de PM. En un momento le atendemos.",
  silencio_reprompt: "¿Sigue ahí? Si desea hacer un pedido, dígame con gusto qué se le antoja.",
  silencio_despedida: "No logro escucharle, así que voy a terminar la llamada. Puede volver a llamarnos cuando guste. Que tenga buen día.",
  pedir_repetir: "Disculpe, no le escuché bien. ¿Me lo puede repetir, por favor?",
  handoff: "Con gusto, voy a pasar su llamada con una persona del restaurante. Si no hay nadie disponible, le devolveremos la llamada en cuanto se pueda.",
  aviso_duracion: "Le comento que la llamada está por alcanzar su tiempo máximo. Vamos a cerrar su pedido o le devolvemos la llamada.",
  limite_duracion: "Llevamos bastante tiempo en la llamada. Una persona del restaurante le devolverá la llamada para terminar su pedido. Gracias por su paciencia.",
  limite_costo: "Para poder terminar bien su pedido, una persona del restaurante le devolverá la llamada en unos minutos. Gracias por su paciencia.",
  tope_mensual: "En este momento no podemos atender pedidos por llamada. Una persona del restaurante le devolverá la llamada en cuanto se pueda. Gracias.",
  proveedor_caido: "Tuvimos un problema con el sistema. Una persona del restaurante le devolverá la llamada en unos minutos. Disculpe las molestias.",
  tool_timeout: "Un momento, por favor, el sistema está tardando más de lo normal.",
  despedida: "Gracias por llamar a Los Taquitos de PM. Que tenga buen provecho.",
} as const;

export type MensajeId = keyof typeof MENSAJES_PREGRABADOS;
export const MENSAJE_IDS = Object.keys(MENSAJES_PREGRABADOS) as readonly MensajeId[];

/** Pregrabado de saludo de reserva que corresponde a la HORA LOCAL DE MERIDA (misma regla que el agente: `saludoPorHora`). */
export function mensajeSaludoRespaldo(horaLocalMerida: number | string): MensajeId {
  const saludo = saludoPorHora(horaLocalMerida);
  return saludo === "buenos días" ? "saludo_respaldo_dias" : saludo === "buenas tardes" ? "saludo_respaldo_tardes" : "saludo_respaldo_noches";
}
