// H-P3-03 -- primer contacto por WhatsApp: el PRIMER mensaje de una conversacion nueva lleva la linea de IA y el enlace del aviso de privacidad
// publico del hotel (/hoteles/:orgSlug/aviso, H-30). Lo pone el CODIGO, no el LLM: no depende de que el modelo lo recuerde ni de que lo cite
// bien (el enlace sale de la base, nunca del modelo). Puro; sin I/O.
const LINEA_IA = "Este número es atendido por un asistente automático (inteligencia artificial), no por una persona.";

export const LINEA_IA_PRIMER_CONTACTO = LINEA_IA;

/** `true` si el texto ya declara que lo atiende una IA (el prompt del agente puede haberlo dicho): no se repite la linea. */
function yaDeclaraIA(texto: string): boolean {
  const t = texto.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
  return t.includes("inteligencia artificial") || t.includes("asistente automatico");
}

/** Encabezado fijo del primer mensaje: linea de IA (si la respuesta aun no la trae) + enlace del aviso de privacidad (si se conoce). */
export function encabezadoPrimerContacto(respuesta: string, avisoUrl: string | null): string {
  const partes: string[] = [];
  if (!yaDeclaraIA(respuesta)) partes.push(LINEA_IA);
  if (avisoUrl) partes.push(`Aviso de privacidad: ${avisoUrl}`);
  return partes.join(" ");
}

/** Antepone el encabezado a la respuesta del agente. Sin nada que agregar, devuelve la respuesta tal cual. */
export function anteponerPrimerContacto(respuesta: string, avisoUrl: string | null): string {
  const encabezado = encabezadoPrimerContacto(respuesta, avisoUrl);
  return encabezado === "" ? respuesta : `${encabezado}\n\n${respuesta}`;
}
