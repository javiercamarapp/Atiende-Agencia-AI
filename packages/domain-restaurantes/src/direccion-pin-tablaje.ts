// Paquete B (ubicacion y cobertura), piloto PM. En zonas sin calles (privadas, Temozon, "tablaje catastral") el cliente manda el pin de
// WhatsApp y a menudo no escribe direccion. El agente NO debe pedir la direccion dos veces ni rechazar un pin valido: con pin o con tablaje
// la direccion ya esta dada y solo falta la REFERENCIA (color de casa, porton, privada). Funciones puras, sin red ni base.
//
// Alcance: decide QUE falta; no valida que la direccion exista y no relaja el rechazo de relleno del servidor (`direccionUtilizable`, orders.ts).
import { direccionUtilizable } from "./orders.ts";

export type FaltanteDireccion = "referencia" | "direccion";

export interface EvaluacionDireccion {
  readonly suficiente: boolean;
  /** Que pedir (una sola vez): `null` si no falta nada. */
  readonly faltante: FaltanteDireccion | null;
  readonly tablaje: string | null;
  readonly usaPin: boolean;
}

const quitarAcentos = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// «tablaje 123», «tablaje catastral no. 123», «tablaje #123», «tablaje: 123». Sin numero no cuenta.
const TABLAJE_RE = /\btablajes?\s*(?:catastral(?:es)?)?\s*(?:numero|num|no|n)?\s*[.:#°º]*\s*(\d{1,7})\b/;

/** Numero de tablaje catastral del texto, o `null`. */
export function extraerTablaje(texto: string): string | null {
  const m = TABLAJE_RE.exec(quitarAcentos(texto ?? ""));
  return m ? (m[1] as string) : null;
}

const REFERENCIA_RE =
  /\b(?:porton(?:es)?|reja|rejas|casa\s+(?:de\s+color\s+)?\w+|color|privada|priv|edificio|depto|departamento|interior|local|frente\s+(?:a|al)|junto\s+(?:a|al)|enfrente|esquina|a\s+un\s+lado|cerca\s+(?:de|del)|entre\s+\w+\s+y\s+\w+|antes\s+(?:de|del)|despues\s+(?:de|del)|zaguan|caseta|portero)\b/;

/** `true` si el texto trae una referencia que el repartidor puede usar (color de casa, porton, privada, edificio, «frente a…»). */
export function tieneReferenciaDeCasa(texto: string): boolean {
  const t = quitarAcentos(texto ?? "").trim();
  return t.length > 0 && REFERENCIA_RE.test(t);
}

/**
 * Que falta de la direccion de entrega.
 *  - Con pin o con tablaje la direccion YA esta dada: solo se pide la referencia si no hay ninguna (y el texto no es una direccion normal).
 *  - Sin pin y sin tablaje rige lo de siempre: una direccion escrita utilizable.
 */
export function evaluarDireccionEntrega(args: { readonly direccion: string | null | undefined; readonly tienePin: boolean }): EvaluacionDireccion {
  const texto = (args.direccion ?? "").trim();
  const tablaje = extraerTablaje(texto);
  const usaPin = args.tienePin;
  const utilizable = texto.length > 0 && direccionUtilizable(texto);
  if (tablaje) return { suficiente: true, faltante: null, tablaje, usaPin };
  if (!usaPin) return utilizable ? { suficiente: true, faltante: null, tablaje, usaPin } : { suficiente: false, faltante: "direccion", tablaje, usaPin };
  // Con pin: una direccion normal (con numero) o una referencia bastan; un nombre de colonia suelto o relleno ⇒ pedir la referencia.
  const direccionConNumero = utilizable && /\d/.test(texto);
  if (direccionConNumero || (utilizable && tieneReferenciaDeCasa(texto))) return { suficiente: true, faltante: null, tablaje, usaPin };
  return { suficiente: false, faltante: "referencia", tablaje, usaPin };
}

/**
 * UN solo mensaje con SOLO lo que falta (nada de lo que el cliente ya dio en su rafaga). `null` si no falta nada.
 * Nunca pide «calle y numero»: con pin o tablaje la direccion ya esta dada.
 */
export function faltantesEnUnMensaje(falta: { readonly referencia?: boolean; readonly nombre?: boolean; readonly pago?: boolean }): string | null {
  const partes: string[] = [];
  if (falta.referencia) partes.push("una referencia de su casa (color de la casa, portón o privada)");
  if (falta.nombre) partes.push("su nombre");
  if (falta.pago) partes.push("la forma de pago (efectivo o tarjeta)");
  if (partes.length === 0) return null;
  const lista = partes.length === 1 ? (partes[0] as string) : `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1] as string}`;
  return `Ya tengo su ubicación. Para completar solo me falta ${lista}.`;
}
