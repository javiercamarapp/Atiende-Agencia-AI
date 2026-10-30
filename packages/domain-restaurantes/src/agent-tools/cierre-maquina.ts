// ARQUITECTURA B (R11): el CIERRE del pedido como maquina de estados DETERMINISTA en el servidor.
//
// Objetivo: que el tramo critico  resumen -> «si» explicito -> crear_pedido  no dependa de que el LLM acierte el orden ni de que lea bien el «si».
//
//   borrador --cotizar_pedido--> cotizado --(el asistente MUESTRA el resumen)--> resumen_mostrado
//   resumen_mostrado --(su ULTIMA pregunta es de confirmacion)--> esperando_confirmacion
//   esperando_confirmacion --(ultimo mensaje del cliente = «si» explicito)--> confirmado --crear_pedido--> creado
//
// Los estados borrador/cotizado/confirmado/creado viven en `order-flow.ts` (fila persistida con CAS). `resumen_mostrado` y `esperando_confirmacion` NO se
// guardan: se DERIVAN del historial de la conversacion (`estadoDeCierre`), de modo que no hay un estado que pueda quedar desincronizado con lo que el
// cliente realmente vio. Reglas que hace cumplir (todas desactivadas por omision; ver `cierreMaquinaActiva`):
//   * confirmar_resumen solo procede si el ULTIMO mensaje del asistente es el resumen vigente (trae el total de la cotizacion y su ultima pregunta es la
//     de confirmar) Y el ultimo mensaje del cliente es un «si» explicito. Pago, propina, efectivo, cambios de cantidad, «no» y preguntas NO confirman.
//   * «No gracias» / «nada mas» contestados al resumen (que pregunta si esta correcto o si desea cambiar algo) SI son el visto bueno; contestados a una
//     pregunta de propina son una respuesta de propina. Se decide por la ULTIMA pregunta del asistente (bloqueante de la revision de #566).
//   * crear_pedido exige que pago / efectivo / propina coincidan con los de la confirmacion; si cambian, se vuelve a cotizar y a mostrar el resumen.
//   * SALIDA SEGURA: toda negativa del servidor entrega el resumen canonico listo para pegar y deja un contador acotado: un titubeo INOCUO («mmm», «a ver») pasa en el SEGUNDO intento
//     despues de haber vuelto a mostrar el resumen, y un «sí» claro pasa un turno despues de un rechazo por «resumen no mostrado» (falso negativo del texto). Preguntas, dudas,
//     negaciones, datos y cambios NUNCA pasan por la salida. El cierre nunca se traba mas de un turno.
//   * El texto del resumen lo arma el SERVIDOR (`resumenCanonico`): el LLM solo redacta el tono, no el total.
//
// Limite honesto: el servidor no puede oir al cliente; clasifica TEXTO. La clasificacion es conservadora (ante la duda NO confirma y pide un «si»).
import { componentesLocales, fechaLocal } from "../horarios.ts";
import { etiquetaOrdenConPiezas } from "../order-quote.ts";
import { afirmaPedidoRegistrado } from "../whatsapp/guards.ts";
import { rechazaElResumen, resumenMostradoEnHistorial, type OrderFlowContext, type OrderFlowSnapshot } from "./order-flow.ts";

/** Variable de entorno que activa la maquina de estados del cierre. Por omision DESACTIVADA (camino anterior intacto). */
export const CIERRE_MAQUINA_ENV = "RESTAURANTES_CIERRE_MAQUINA_ESTADOS";

export function cierreMaquinaActiva(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = (env[CIERRE_MAQUINA_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "si";
}

export type EstadoCierre = "borrador" | "cotizado" | "resumen_mostrado" | "esperando_confirmacion" | "confirmado" | "creado";

export type RespuestaCierre = "si" | "no" | "cambio" | "dato" | "ambiguo";

export type MensajeHistorial = { readonly role: string; readonly content: string };

// ---------------------------------------------------------------------------------------------------------------------
// Normalizacion
// ---------------------------------------------------------------------------------------------------------------------

/** Largo maximo que se analiza de un mensaje del cliente: una respuesta al resumen es corta; lo demas se recorta (acota el costo de las expresiones regulares sobre texto no confiable). */
const MAX_MENSAJE = 600;

function sinMarcadores(texto: string): string {
  // Toques de boton: «[boton:rp1:...]» viaja pegado al titulo; el titulo es lo que cuenta. Recorrido lineal (sin expresion regular con retroceso).
  const t = texto.length > 4 * MAX_MENSAJE ? texto.slice(0, 4 * MAX_MENSAJE) : texto;
  let out = "";
  let i = 0;
  while (i < t.length) {
    if (t.startsWith("[boton:", i)) {
      const fin = t.indexOf("]", i);
      if (fin >= 0) {
        out += " ";
        i = fin + 1;
        continue;
      }
    }
    out += t[i];
    i += 1;
  }
  return out;
}

function normalizar(texto: string): string {
  return sinMarcadores(texto)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%$.,?!¿¡\s]/gu, " ") // emojis y simbolos fuera (los pulgares se tratan antes)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MENSAJE);
}

const EMOJIS_AFIRMATIVOS: ReadonlySet<string> = new Set(["👍", "👌", "✅", "🙌", "🤝", "💯", "👏"]);

/** El mensaje son SOLO pulgares / palomas (con o sin tono de piel). Sin clases de caracteres con emojis (no-misleading-character-class): se parte por caracteres. */
function esSoloPulgarOPaloma(crudo: string): boolean {
  const quitado = crudo.replace(/\p{Emoji_Modifier}|\u200d|\ufe0f|\s/gu, "");
  if (!quitado) return false;
  return Array.from(quitado).every((c) => EMOJIS_AFIRMATIVOS.has(c));
}

// ---------------------------------------------------------------------------------------------------------------------
// Clasificacion del ultimo mensaje del cliente
// ---------------------------------------------------------------------------------------------------------------------

const PAGO_O_PROPINA = [
  /\b(?:efectivo|tarjeta|transferencia|terminal|cash|debito|credito)\b/,
  /\bpropina\b/,
  /\bsin\s+propina\b/,
  /\bcon\s+\$?\s*\d/, // «con 500»
  /^\W*\$?\s*\d+(?:[.,]\d+)?\s*(?:pesos|varos|mxn)?\W*$/, // «500», «$600»
  /\b\d{1,3}\s*%/, // «10%»
  /\bcambio\s+de\s+\$?\s*\d/,
  /\bpago\s+con\b/,
  /\bpaga(?:re|ria)?\s+con\b/,
];

const MARCADORES_DE_CAMBIO = /\b(?:pero|mejor|cambia(?:r|me|le)?|cambio\s+(?:el|la|los|las|mi|de\s+producto)|quita(?:r|le|me)?|agrega(?:r|le|me)?|anade|anadele|ponle|pon(?:me)?|aumenta(?:r|le)?|en\s+vez\s+de|en\s+lugar\s+de|sin\s+(?!propina)\w+|otr[oa]s?\b|mas\s+\w+|menos\s+\w+|falto|falta|olvide|se\s+me\s+olvido|tambien|ademas)\b|\by\s+(?:un|una|unos|unas|dos|tres|cuatro|cinco|\d+)\b|\bcon\s+(?:un|una|unos|unas|dos|tres|cuatro|cinco)\b/;

const PREGUNTA = /\?|^\W*(?:cuanto|cuando|cual|cuales|que|como|donde|quien|por\s*que|porque|hay|tienen|incluye|aceptan)\b/;

const AFIRMACION = /^\W*(?:si+|sii+|sip|sep|simon|sale|dale|va|vale|ok(?:ey|ay)?|okis|listo|claro|correcto|correcta|confirmo|confirmado|confirmada|confirmalo|confirmelo|confirmar(?:\s+pedido)?|de\s+acuerdo|adelante|perfecto|asi\s+es|asi\s+esta\s+bien|esta\s+bien|esta\s+correcto|todo\s+bien|todo\s+correcto|andale|hazlo|procede|proceda|exacto|eso\s+es|de\s+una|va\s+que\s+va|jalo|cierto|asi\s+quedo|bien)\b/;

/** Rechazo corto y suelto («no», «nop», «nel», «ya no», «mejor no», «claro que no», «no no», con cortesia final). Nunca confirma. */
const NEGACIONES_SUELTAS: ReadonlySet<string> = new Set(["nop", "nope", "nel", "nah", "nanai", "nanay", "negativo"]);
const RECHAZO_CON_CORTESIA = /^\W*(?:ya no(?: quiero| lo quiero)?|olvidalo|olvida|mejor no|para nada|claro que no|ni madres|de ninguna manera)(?:[\s,]+(?:gracias|por favor|porfa|porfis))?\W*$/;

function esRechazoSuelto(t: string): boolean {
  const palabras = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (palabras.length > 0 && palabras.length <= 6 && palabras.every((w) => /^no+$/.test(w) || NEGACIONES_SUELTAS.has(w))) return true;
  return RECHAZO_CON_CORTESIA.test(t);
}

/** Dudas y titubeos: «sí, creo», «tal vez», «no sé». Nunca confirman ni se aceptan por la salida segura. */
const TITUBEO = /\b(?:creo|supongo|tal\s+vez|quiza|quizas|a\s+lo\s+mejor|igual\s+y|no\s+se|no\s+estoy|dejame\s+pensar|dejame\s+ver|no\s+tengo\s+claro|puede\s+ser|depende)\b/;

/** Direccion o referencias de entrega dichas DESPUES del resumen: es un cambio y exige volver a confirmar. */
const DIRECCION = /\b(?:direccion|calle|avenida|colonia|fraccionamiento|fracc|entre\s+calles|esquina|referencias?|mandalo\s+a|llevalo\s+a|enviarlo\s+a|a\s+la\s+otra)\b|#\s*\d+|\bav\.\s|\bcol\.\s/;

/** Cantidad dicha suelta: «dos mas», «que sean 3», «solo uno». */
const CANTIDAD = /\b(?:un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+mas\b|\bque\s+sean\b|\bsolo\s+(?:un|una|uno|dos|tres|cuatro|cinco|\d+)\b/;

/** Visto bueno al resumen expresado en negativo («no gracias», «nada mas»): SOLO cuenta cuando se contesta a un resumen que pregunta si esta correcto o si desea cambiar algo. */
const VISTO_BUENO_EN_NEGATIVO = /^\W*(?:no+\s*,?\s*(?:gracias|nada\s*mas|asi\s*esta(?:\s*bien)?|es\s*todo|eso\s*es\s*todo|todo\s*bien)|nada\s*mas|eso\s*es\s*todo|es\s*todo|asi\s*esta(?:\s*bien|\s*perfecto)?|ninguno|nada\s*que\s*cambiar|no\s*cambio\s*nada)\W*$/;

/**
 * R22 «sí + pregunta lateral» (SIM-WA-140, T7-026). REVERSION DE ESPECIFICACION: antes «las preguntas ni confirman ni cambian» (un «sí, ¿y cuánto tarda?» era ambiguo y el pedido no se creaba);
 * ahora un «sí» fuerte al INICIO seguido de una pregunta PURAMENTE INFORMATIVA confirma. LISTA BLANCA: el resto del mensaje debe ser, completo, una de las preguntas informativas de abajo
 * (tiempo de entrega, hora de llegada, costo del envio, si el pedido esta correcto/confirmado, donde esta la sucursal, si aceptan tarjeta). Cualquier otra pregunta (producto, precio, extras,
 * «¿y si agrego...?», «¿puedo cancelar?»), cualquier frase extra («quiero papas») o negacion => «ambiguo»: el modelo contesta y vuelve a pedir el sí. En duda, ambiguo.
 */
const AFIRMACION_FUERTE_CON_PAUSA = /^\W*(?:si+|sip|sii+|dale|ok(?:ey|ay)?|claro|correcto|confirmo|confirmado|de\s+acuerdo|adelante|perfecto|andale|listo|sale)(?:\s*[,.!;:\-]+\s*|\s+(?=\u00bf)|\s+y\s+(?=\u00bf|cuanto\b|a\s+que\s+hora\b))/;
const PREGUNTAS_INFORMATIVAS: readonly RegExp[] = [
  /^(?:y\s+)?cuanto\s+(?:tarda|tardan|demora|demoran|se\s+tarda|se\s+tardan|se\s+demora|falta)(?:\s+en\s+llegar)?(?:\s+(?:mi|el)\s+pedido)?$/,
  /^(?:y\s+)?cuanto\s+tiempo\s+(?:tarda|tardan|demora|demoran|falta)(?:\s+(?:mi|el)\s+pedido)?$/,
  /^(?:y\s+)?a\s+que\s+hora\s+(?:llega|llegan|llegaria|estara\s+listo|estaria\s+listo|sale)(?:\s+(?:mi|el)\s+pedido)?$/,
  /^(?:y\s+)?(?:cuanto\s+(?:cuesta|es|seria|sale|cobran)\s+(?:el\s+)?envio|cuanto\s+es\s+el\s+costo\s+del\s+envio|cual\s+es\s+el\s+costo\s+del\s+envio|tiene\s+costo\s+el\s+envio)$/,
  /^(?:y\s+)?(?:es|esta|queda|ya\s+quedo)\s+(?:todo\s+)?(?:correcto|confirmado|registrado)(?:\s+(?:mi|el)\s+pedido)?$/,
  /^(?:y\s+)?donde\s+(?:esta|queda)\s+la\s+sucursal$/,
  /^(?:y\s+)?cual\s+es\s+la\s+direccion\s+de\s+la\s+sucursal$/,
  /^(?:y\s+)?(?:aceptan|reciben)\s+tarjeta$/,
];
function esSiConPreguntaLateral(t: string): boolean {
  const m = t.match(AFIRMACION_FUERTE_CON_PAUSA);
  if (!m) return false;
  const resto = t.slice(m[0].length);
  if (!resto.includes("?")) return false;
  const limpio = resto.replace(/[\u00bf?!.,;:]/g, " ").replace(/\s+/g, " ").trim();
  return PREGUNTAS_INFORMATIVAS.some((re) => re.test(limpio));
}

export interface OpcionesClasificar {
  /** El ultimo mensaje del asistente fue el resumen y su ultima pregunta es de confirmacion / «desea cambiar algo». */
  readonly despuesDelResumen: boolean;
  /** Pago / efectivo / propina que muestra el resumen vigente y total cotizado: «sí, efectivo» a un resumen que YA dice efectivo es un sí; «sí, tarjeta» a uno que dice efectivo es un cambio de dato. */
  readonly datosCotizados?: DatosDeCierre;
  readonly total?: number;
}

/** Lo que el mensaje del cliente dice de pago, efectivo y propina (solo lo que dice; `undefined` = no lo menciona). `sinPropina` = dijo que no deja propina. */
export interface DatosDelMensaje {
  readonly pago?: "efectivo" | "tarjeta";
  readonly efectivoCon?: number;
  readonly propinaMxn?: number;
  readonly propinaPct?: number;
  readonly sinPropina?: boolean;
}

// Monto en cifras («600», «$1,000», «1,000.50», «1000 pesos») o en palabras («mil», «dos mil», «mil quinientos», «quinientos»).
const CIFRA = String.raw`\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const CENTENAS: Record<string, number> = { cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900 };
const UNIDADES_MIL: Record<string, number> = { un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
const PALABRA_MONTO = String.raw`((?:(?:${Object.keys(UNIDADES_MIL).join("|")})\s+)?mil(?:\s+(?:${Object.keys(CENTENAS).join("|")}))?|${Object.keys(CENTENAS).join("|")})`;
const MONTO = String.raw`(?:${CIFRA}|${PALABRA_MONTO})`;
const NO_ES_PROPINA = String.raw`(?!\s*(?:%|por\s*ciento|(?:pesos\s*)?de\s+propina))`;

function numeroDeCifra(c: string): number {
  return /^\d{1,3}(?:,\d{3})+/.test(c) ? Number(c.replace(/,/g, "")) : Number(c.replace(",", "."));
}

function numeroDePalabras(p: string): number {
  const w = p.trim().split(/\s+/);
  let total = 0;
  const iMil = w.indexOf("mil");
  if (iMil >= 0) {
    total += (iMil > 0 ? (UNIDADES_MIL[w[0]!] ?? 1) : 1) * 1000;
    const resto = w[iMil + 1];
    if (resto) total += CENTENAS[resto] ?? 0;
  } else total += CENTENAS[w[0]!] ?? 0;
  return total;
}

function valorDeMonto(m: RegExpExecArray, desde: number): number {
  return m[desde] !== undefined ? numeroDeCifra(m[desde]!) : numeroDePalabras(m[desde + 1]!);
}

/** Monto «con el que paga» el cliente: tras «con», «pago con», «cambio de», «billete de»... en cualquier parte del mensaje; o una cifra que cierra el mensaje. */
export function montoDePago(t: string): number | undefined {
  const explicito = new RegExp(String.raw`(?:\bcon|\bcambio\s+de|\bpago\s+con|\bpagare\s+con|\bpaga(?:ria)?\s+con|\bbillete\s+de|\bmanejo|\btraigo)\s+${MONTO}\s*(?:pesos|varos|mxn)?${NO_ES_PROPINA}\b`).exec(t);
  if (explicito) return valorDeMonto(explicito, 1);
  const final = new RegExp(String.raw`(?:^|\s)${MONTO}\s*(?:pesos|varos|mxn)?\s*(?:porfa|por favor|gracias|ok)?\W*$`).exec(t);
  if (final) return valorDeMonto(final, 1);
  return undefined;
}

/** Extrae pago / efectivo / propina del texto del cliente. Un monto solo cuenta como «efectivo con» si alcanza el total (si se conoce). */
export function datosDelMensaje(mensaje: string, total?: number): DatosDelMensaje {
  const t = normalizar(mensaje);
  const out: { -readonly [K in keyof DatosDelMensaje]: DatosDelMensaje[K] } = {};
  const tarjeta = /\b(?:tarjeta|terminal|debito|credito)\b/.test(t);
  const efectivoPalabra = /\b(?:efectivo|cash)\b/.test(t);
  if (tarjeta && !efectivoPalabra) out.pago = "tarjeta";
  else if (efectivoPalabra && !tarjeta) out.pago = "efectivo";
  const dicePropina = /\bpropina\b|\d\s*%|\bpor\s*ciento\b/.test(t);
  if (/\bsin\s+propina\b|\bno\s+(?:quiero|dejo|voy\s+a\s+dejar|le\s+(?:quiero|dejo))\s+(?:dejar\s+)?propina\b|\bno\s+propina\b/.test(t)) out.sinPropina = true;
  else {
    const pct = /\b(\d{1,3}(?:[.,]\d{1,2})?)\s*%/.exec(t) ?? /\b(\d{1,3})\s*por\s*ciento\b/.exec(t);
    if (pct) out.propinaPct = Number(pct[1]!.replace(",", "."));
    else {
      const mxn = /\bpropina\s+(?:de|del)?\s*\$?\s*(\d{1,5}(?:[.,]\d{1,2})?)\b/.exec(t) ?? /\b(\d{1,5})\s*(?:pesos\s*)?de\s+propina\b/.exec(t);
      if (mxn) out.propinaMxn = Number(mxn[1]!.replace(",", "."));
    }
  }
  if (out.pago !== "tarjeta" && !(dicePropina && out.sinPropina !== true)) {
    const n = montoDePago(t);
    if (n !== undefined && Number.isFinite(n) && n > 0 && (total === undefined || n >= total)) {
      out.efectivoCon = n;
      out.pago = out.pago ?? "efectivo";
    }
  }
  // «No gracias, pago con 1000»: el «no gracias» contesta la pregunta de propina.
  if (out.sinPropina === undefined && out.propinaMxn === undefined && out.propinaPct === undefined && out.pago !== undefined && /^\W*no\s*,?\s*gracias\b/.test(t)) out.sinPropina = true;
  return out;
}

/** ¿Todo lo que dice el mensaje coincide con lo que el resumen vigente ya muestra? */
function coincideConElResumen(d: DatosDelMensaje, c: DatosDeCierre | undefined): boolean {
  if (!c) return false;
  if (d.pago === undefined && d.efectivoCon === undefined && d.propinaMxn === undefined && d.propinaPct === undefined && d.sinPropina === undefined) return false;
  if (d.pago !== undefined && d.pago !== c.pago) return false;
  if (d.efectivoCon !== undefined && d.efectivoCon !== c.efectivoCon) return false;
  if (d.propinaMxn !== undefined && d.propinaMxn !== c.propinaMxn) return false;
  if (d.propinaPct !== undefined && d.propinaPct !== c.propinaPct) return false;
  if (d.sinPropina === true && (c.propinaMxn !== undefined || c.propinaPct !== undefined)) return false;
  return true;
}

/** Mezcla lo que dijo el cliente con los datos cotizados (la propina dicha reemplaza la anterior; «sin propina» la quita). */
export function aplicarDatosDelMensaje(base: DatosDeCierre, d: DatosDelMensaje): DatosDeCierre {
  const pago = d.pago ?? base.pago;
  return {
    pago,
    efectivoCon: pago === "tarjeta" ? undefined : (d.efectivoCon ?? base.efectivoCon),
    propinaMxn: d.sinPropina ? undefined : d.propinaPct !== undefined ? undefined : (d.propinaMxn ?? base.propinaMxn),
    propinaPct: d.sinPropina ? undefined : d.propinaMxn !== undefined ? undefined : (d.propinaPct ?? base.propinaPct),
  };
}

/** Clasifica el mensaje del cliente frente a un resumen. SOLO `si` confirma. */
export function clasificarRespuestaCierre(mensaje: unknown, opciones: OpcionesClasificar): RespuestaCierre {
  if (typeof mensaje !== "string") return "ambiguo";
  const crudo = sinMarcadores(mensaje).trim();
  if (!crudo) return "ambiguo";
  if (esSoloPulgarOPaloma(crudo)) return "si";
  const t = normalizar(crudo);
  if (!t) return "ambiguo";
  // Botones del resumen.
  if (/^confirmar pedido$/.test(t)) return "si";
  if (/^cambiar algo$/.test(t)) return "cambio";
  // Rechazo o correccion explicita del resumen.
  if (rechazaElResumen(crudo)) return "no";
  if (esRechazoSuelto(t) || /^(?:no|nel|nop|nope)\s*,?\s*(?:todavia|aun)?\s*no\W*$/.test(t) || /^\W*(?:no\s+lo\s+(?:confirmo|quiero)|espera|esperate|alto|cancela|cancelar|cancelalo)\b/.test(t)) return "no";
  // Visto bueno en negativo: solo si contesta al resumen.
  if (VISTO_BUENO_EN_NEGATIVO.test(t)) return opciones.despuesDelResumen ? "si" : "dato";
  const palabras = t.split(" ").length;
  const conAfirmacion = AFIRMACION.test(t);
  // Preguntas: ni confirman ni cambian; el modelo debe contestarlas y volver a pedir el si.
  if (CANTIDAD.test(t)) return "cambio";
  if (opciones.despuesDelResumen && esSiConPreguntaLateral(t)) return "si";
  if (PREGUNTA.test(t)) return "ambiguo";
  if (TITUBEO.test(t)) return "ambiguo";
  if (MARCADORES_DE_CAMBIO.test(t) || DIRECCION.test(t) || CANTIDAD.test(t)) return "cambio";
  const dichos = datosDelMensaje(crudo, opciones.total);
  const datoPagoOPropina = PAGO_O_PROPINA.some((re) => re.test(t)) || Object.values(dichos).some((v) => v !== undefined);
  // «si, con tarjeta» / «ok, 500»: el cliente da un dato; el si no responde a un resumen con ese dato. No confirma.
  if (datoPagoOPropina) {
    // «sí, efectivo» / «sí confirmo, pago en efectivo» a un resumen que YA muestra efectivo es un sí; si el dato es otro (o el resumen no lo traia) es un dato nuevo: no confirma.
    if (conAfirmacion && coincideConElResumen(dichos, opciones.datosCotizados)) return "si";
    return "dato";
  }
  // Una negacion que no es un dato de pago: «claro que no», «ya no quiero», «no, mejor otro dia». Con un sí por delante («sí, no hay problema») queda ambigua; sin él es un rechazo.
  if (/\bno\b/.test(t)) return conAfirmacion && !/\b(?:que|pero|pues|eso)\s+no\b/.test(t) ? "ambiguo" : "no";
  if (conAfirmacion && palabras <= 7) return "si";
  return "ambiguo";
}

/**
 * ¿Un mensaje clasificado «ambiguo» es tan inocuo («mmm», «a ver», «pues») que la salida segura puede aceptarlo en el segundo intento? Preguntas, titubeos, negaciones, cambios y
 * datos NUNCA se aceptan por esa salida: el cliente que sigue dudando sigue hablando con el asistente (o con una persona), no se le crea un pedido.
 */
export function ambiguoAceptablePorSalida(mensaje: unknown): boolean {
  if (typeof mensaje !== "string") return false;
  const t = normalizar(mensaje);
  if (!t) return false;
  if (PREGUNTA.test(t) || TITUBEO.test(t) || /\bno\b|\bnada\b|\bnunca\b|\bni\b/.test(t)) return false;
  if (MARCADORES_DE_CAMBIO.test(t) || DIRECCION.test(t) || CANTIDAD.test(t) || PAGO_O_PROPINA.some((re) => re.test(t))) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// ¿El asistente mostro el resumen y pregunto por la confirmacion?
// ---------------------------------------------------------------------------------------------------------------------

const PREGUNTA_DE_PROPINA_O_PAGO = /propina|con\s+cuanto|cu[aá]nto\s+(?:paga|pagar[aá]|traer[aá])|c[oó]mo\s+(?:desea|va\s+a|quiere|prefiere)\s+pagar|efectivo\s+o\s+tarjeta|tarjeta\s+o\s+efectivo|forma\s+de\s+pago|m[eé]todo\s+de\s+pago|a\s+nombre\s+de|direcci[oó]n|d[oó]nde\s+(?:se\s+lo|le)\s+(?:llevamos|enviamos)|cambio\s+de\s+cu[aá]nto/i;
const PREGUNTA_DE_CONFIRMACION = /correct[oa]|confirm|todo\s+bien|as[ií]\s+est[aá]\s+bien|as[ií]\s+lo\s+(?:dejamos|registramos|mandamos|enviamos)|desea\s+(?:cambiar|modificar|agregar|a[nñ]adir)|algo\s+m[aá]s|alg[uú]n\s+cambio|est[aá]\s+bien|procedemos|lo\s+registro|lo\s+mando|lo\s+anoto/i;

/** Ultima pregunta del texto (desde el ultimo «¿» o, si no hay, la ultima oracion con «?»). `""` si no pregunta nada. */
export function ultimaPregunta(texto: string): string {
  const t = sinMarcadores(texto).trim();
  const iguales = t.lastIndexOf("¿");
  if (iguales >= 0) return t.slice(iguales);
  const q = t.lastIndexOf("?");
  if (q < 0) return "";
  const previo = Math.max(t.lastIndexOf(".", q), t.lastIndexOf("\n", q), t.lastIndexOf("!", q));
  return t.slice(previo + 1, q + 1);
}

/** La ULTIMA pregunta del mensaje es de confirmacion del resumen (no de propina, pago, nombre ni direccion). */
export function terminaEnPreguntaDeConfirmacion(texto: string | undefined): boolean {
  if (!texto) return false;
  const q = ultimaPregunta(texto);
  if (!q) {
    // Sin signos de interrogacion: «Responda *si* para confirmar su pedido» tambien es una pregunta de confirmacion.
    const cola = sinMarcadores(texto).trim().split(/\n/).pop() ?? "";
    return /responda\s+\W*s[ií]\W*\s+para\s+confirmar/i.test(cola);
  }
  return !PREGUNTA_DE_PROPINA_O_PAGO.test(q) && PREGUNTA_DE_CONFIRMACION.test(q);
}

/** El mensaje del asistente ES el resumen vigente: trae el total de la cotizacion y termina pidiendo la confirmacion. */
export function esResumenParaConfirmar(total: number | undefined, mensajeAsistente: string | undefined): boolean {
  if (!mensajeAsistente || typeof total !== "number") return false;
  const trae = resumenMostradoEnHistorial(total, [{ role: "assistant", content: mensajeAsistente }]);
  return trae === true && terminaEnPreguntaDeConfirmacion(mensajeAsistente);
}

function ultimoDe(historial: readonly MensajeHistorial[], role: "user" | "assistant"): string | undefined {
  for (let i = historial.length - 1; i >= 0; i--) if (historial[i]!.role === role) return historial[i]!.content;
  return undefined;
}

/**
 * Estado del cierre VISTO POR EL CLIENTE. Con historial (WhatsApp) distingue resumen_mostrado / esperando_confirmacion; sin historial (voz, pruebas) no puede
 * saber que oyo el cliente y devuelve el estado de la fila.
 */
export function estadoDeCierre(snap: OrderFlowSnapshot | null, historial: readonly MensajeHistorial[] | undefined): EstadoCierre {
  if (!snap || !snap.state || !snap.context) return "borrador";
  if (snap.state === "creado" || snap.state === "creando") return "creado";
  if (snap.state === "confirmado") return "confirmado";
  if (historial === undefined) return "cotizado";
  const ultimoAsistente = ultimoDe(historial, "assistant");
  const total = snap.context.quotedTotal;
  if (typeof total !== "number" || !ultimoAsistente) return "cotizado";
  if (resumenMostradoEnHistorial(total, [{ role: "assistant", content: ultimoAsistente }]) !== true) return "cotizado";
  return terminaEnPreguntaDeConfirmacion(ultimoAsistente) ? "esperando_confirmacion" : "resumen_mostrado";
}

// ---------------------------------------------------------------------------------------------------------------------
// Firma de los datos de cierre (pago / efectivo / propina) y resumen canonico
// ---------------------------------------------------------------------------------------------------------------------

export interface DatosDeCierre {
  readonly pago?: "efectivo" | "tarjeta";
  readonly efectivoCon?: number;
  readonly propinaMxn?: number;
  readonly propinaPct?: number;
}

/** Firma estable de lo que el cliente acepto ademas del carrito. Dos firmas iguales = el mismo cierre. */
export function firmaDeCierre(d: DatosDeCierre): string {
  return [d.pago ?? "-", d.pago === "tarjeta" ? "-" : (d.efectivoCon ?? "-"), d.propinaMxn ?? "-", d.propinaPct ?? "-"].join("|");
}

export function datosDeCierreDeContexto(ctx: OrderFlowContext): DatosDeCierre {
  return { pago: ctx.quotedPago, efectivoCon: ctx.quotedEfectivoCon, propinaMxn: ctx.quotedPropinaMxn, propinaPct: ctx.quotedPropinaPct };
}

export interface LineaResumen {
  readonly name: string;
  readonly quantity: number;
  readonly lineTotal?: number;
  readonly tortilla?: string | null;
  /** R22 (R4): piezas por orden del catalogo (`packSize`) cuando el renglon se vende por ordenes; el resumen muestra «1 orden (2 piezas)». Ausente = sin dato: se muestra «N × nombre». */
  readonly piezasPorOrden?: number | null;
}

export interface EntradaResumen {
  readonly lineas: readonly LineaResumen[];
  readonly total: number;
  readonly descuento?: number;
  readonly canal?: string;
  readonly datos: DatosDeCierre;
  /** Etiqueta de la hora de entrega/recogida YA en la zona de la sucursal («para las 7:00 pm»); ver `etiquetaHoraEntrega`. Sin hora = «en cuanto esté». */
  readonly hora?: string;
  /** Solo a domicilio: lo que el servidor sabe del destino al cotizar (colonia y si llego el pin), p. ej. «colonia Centro». La calle completa se pide al crear. */
  readonly direccion?: string;
  /** R15/T7-001: salsas que el cliente PIDIO ademas de las basicas (sin costo), ya con su nombre para el cliente («crema de ajo»). */
  readonly salsas?: readonly string[];
  /** R15: salsas basicas que el cliente quito («salsa verde»). */
  readonly sinSalsas?: readonly string[];
  /** R21 (T7-038): salsas BASICAS que van en el pedido (las del perfil menos las que el cliente quito), con su nombre para el cliente. Sin ellas el cliente confirmaba sin ver roja y verde. */
  readonly basicas?: readonly string[];
  /** R15: notas ya capturadas (ajustes como «sin cebolla»), saneadas por `sanearNotaDeResumen`: una linea, sin telefonos ni correos, acotada. */
  readonly notas?: string;
}

const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/**
 * Hora de entrega/recogida para el resumen, en la zona de la SUCURSAL y en 12 horas («para las 7:00 pm», «para la 1:40 pm», «para mañana a las 12:00 pm», «para el vie 09/10 a las 2:30 pm»).
 * R13/T7-026: el resumen que el cliente confirmaba no traia la hora y un pedido quedo a las 18:00 cuando pidio 7 pm. `ahoraMs` decide hoy / mañana.
 */
export function etiquetaHoraEntrega(instanteMs: number, zonaHoraria: string, ahoraMs: number): string {
  const instante = new Date(instanteMs);
  const { dia, minutos } = componentesLocales(instante, zonaHoraria);
  const h24 = Math.floor(minutos / 60);
  const reloj = `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(minutos % 60).padStart(2, "0")} ${h24 >= 12 ? "pm" : "am"}`;
  const articulo = h24 % 12 === 1 ? "la" : "las";
  const fecha = fechaLocal(instante, zonaHoraria);
  const hoy = fechaLocal(new Date(ahoraMs), zonaHoraria);
  const diasDeDiferencia = Math.round((Date.parse(`${fecha}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);
  if (diasDeDiferencia === 0) return `para ${articulo} ${reloj}`;
  if (diasDeDiferencia === 1) return `para mañana a ${articulo} ${reloj}`;
  return `para el ${DIAS_CORTOS[dia]} ${fecha.slice(8, 10)}/${fecha.slice(5, 7)} a ${articulo} ${reloj}`;
}

/**
 * R22 (R3): el mensaje final de un pedido para recoger debe decir la hora GUARDADA en el pedido, no la que el modelo recordo («en 20 minutos», «de 25 a 35 minutos» o «a las 2:02 pm» con el
 * pedido guardado a otra hora). Solo se tocan las frases del mensaje que hablan de la espera / recogida (y no de horarios de la sucursal): un plazo («en N minutos», «de N a M minutos») que
 * no alcanza la espera real (+-2 min) se sustituye por los minutos reales, y una hora de reloj («a las 2:02 pm», «para las 2») distinta de la guardada, por la guardada. Pura.
 */
export function corregirHoraDeRecogidaEnRespuesta(respuesta: string, hora: { readonly instanteMs: number; readonly zonaHoraria: string; readonly ahoraMs: number }): string {
  if (!Number.isFinite(hora.instanteMs)) return respuesta;
  const { minutos } = componentesLocales(new Date(hora.instanteMs), hora.zonaHoraria);
  const h24 = Math.floor(minutos / 60);
  const reloj = `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(minutos % 60).padStart(2, "0")} ${h24 >= 12 ? "pm" : "am"}`;
  const articulo = h24 % 12 === 1 ? "la" : "las";
  const esperaReal = Math.round((hora.instanteMs - hora.ahoraMs) / 60_000);
  const habla = /esper|recog|pas(?:a|ar|e|ara|aria)\b|list[oa]|prepar|tiempo|estimad|quedar[aá]/i;
  const ajena = /cierr|abre\b|abrimos|horario|apertura/i;
  return respuesta
    .split(/(?<=[.!?\n])(\s+)/)
    .map((frase) => {
      if (!habla.test(frase) || ajena.test(frase)) return frase;
      let f = frase;
      if (esperaReal >= 1) {
        f = f.replace(/\b(en|de)\s+(\d{1,3})(?:\s*(?:a|-|–)\s*(\d{1,3}))?\s*minutos?\b/gi, (todo, prep: string, a: string, b: string | undefined) => {
          const lo = Number(a);
          const hi = b === undefined ? lo : Number(b);
          return esperaReal >= lo - 2 && esperaReal <= hi + 2 ? todo : `${prep} ${esperaReal} minutos`;
        });
      }
      f = f.replace(/\b(a|para)\s+las?\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?![\d:])/gi, (todo, prep: string, hh: string, mm: string | undefined, mer: string | undefined) => {
        const h = Number(hh);
        if (h < 1 || h > 24) return todo;
        const m = mm === undefined ? 0 : Number(mm);
        const meridiano = mer === undefined ? null : /^a/i.test(mer) ? "am" : "pm";
        const coincide = h % 12 === h24 % 12 && m === minutos % 60 && (meridiano === null || meridiano === (h24 >= 12 ? "pm" : "am"));
        return coincide ? todo : `${prep} ${articulo} ${reloj}${todo.endsWith(".") ? "." : ""}`;
      });
      return f;
    })
    .join("");
}

/**
 * R21 (T7-026): la hora que el CLIENTE dijo mas recientemente en un mensaje que no es pregunta ("a las 5 pm", "mejor a las 6:30", "5pm"), como minutos del dia en reloj de 12 horas
 * (`minuto12` = (hora % 12) * 60 + minutos; `meridiano` solo si lo dijo). `null` si ningun mensaje del cliente da una hora. Sin plazos ("en 40 minutos") ni horarios preguntados.
 * Pura; el texto es no confiable (se acota el largo).
 */
export function horaDichaPorElCliente(historial: readonly MensajeHistorial[]): { readonly minuto12: number; readonly meridiano: "am" | "pm" | null } | null {
  // Atada al pedido VIGENTE: la hora de un pedido anterior (el asistente ya le dijo «su pedido quedó registrado») no vale para el nuevo; solo cuentan los mensajes del cliente posteriores a esa afirmacion.
  let inicioPedidoVigente = 0;
  for (let i = historial.length - 1; i >= 0; i--) {
    const m = historial[i]!;
    if (m.role === "assistant" && typeof m.content === "string" && m.content.split(/(?<=[.!?\n])\s+/).some((f) => afirmaPedidoRegistrado(f))) { inicioPedidoVigente = i + 1; break; }
  }
  let vistos = 0;
  for (let i = historial.length - 1; i >= inicioPedidoVigente && vistos < 8; i--) {
    const m = historial[i]!;
    if (m.role !== "user" || typeof m.content !== "string") continue;
    vistos += 1;
    const crudo = m.content.slice(0, 600);
    // Un plazo («en 40 minutos», «en cuanto esté») mas reciente que cualquier hora exacta la sustituye: no hay hora que comparar.
    if (/\b(?:en\s+\d+\s*(?:min|minutos|hora|horas)|en\s+media\s+hora|en\s+una\s+hora|en\s+cuanto|ahorita|ya\s+mismo|para\s+ya)\b/i.test(crudo.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) return null;
    if (/[?¿]/.test(crudo) || /\b(?:abren|abre|cierran|cierra|horario|hasta\s+que\s+hora)\b/i.test(crudo)) continue;
    const t = crudo.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let ultima: { minuto12: number; meridiano: "am" | "pm" | null } | null = null;
    for (const r of t.matchAll(/(\b(?:a|para)\s+las?\s+)?(?<![\d:.$])(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|de\s+la\s+(?:manana|tarde|noche))?(?![\d:])/g)) {
      const tienePrefijo = r[1] !== undefined;
      const tag = r[4] ?? "";
      if (!tienePrefijo && tag === "") continue;
      const h = Number(r[2]);
      const min = r[3] ? Number(r[3]) : 0;
      if (h > 23 || min > 59) continue;
      // «a las 5 tacos», «5 kg»: un numero seguido de una unidad o producto no es una hora (salvo con minutos o meridiano).
      const despues = t.slice((r.index ?? 0) + r[0].length);
      if (tag === "" && r[3] === undefined && /^\s*(?:kg|kilos?|g|gr|gramos?|tacos?|ordenes|orden|piezas?|personas?|pesos|min|minutos|horas?|hrs?)\b/.test(despues)) continue;
      const meridiano = /^p/.test(tag) || /tarde|noche/.test(tag) ? "pm" : /^a/.test(tag) || /manana/.test(tag) ? "am" : null;
      ultima = { minuto12: (h % 12) * 60 + min, meridiano: h >= 13 ? "pm" : meridiano };
    }
    if (ultima) return ultima;
  }
  return null;
}

/** R21 (T7-026): ¿la hora cotizada (ms, zona de la sucursal) contradice la que el cliente dijo por ultima vez? Solo cuenta si hay una hora clara del cliente; con meridiano, tambien am/pm. */
export function horaCotizadaContradiceAlCliente(instanteMs: number, zonaHoraria: string, historial: readonly MensajeHistorial[]): { readonly dicha: string } | null {
  const dicha = horaDichaPorElCliente(historial);
  if (!dicha) return null;
  const { minutos } = componentesLocales(new Date(instanteMs), zonaHoraria);
  const coincide12 = ((Math.floor(minutos / 60) % 12) * 60 + (minutos % 60)) === dicha.minuto12;
  const coincideMeridiano = dicha.meridiano === null || (dicha.meridiano === "pm") === (minutos >= 12 * 60);
  if (coincide12 && coincideMeridiano) return null;
  const h = Math.floor(dicha.minuto12 / 60) || 12;
  const mm = dicha.minuto12 % 60;
  return { dicha: `${h}:${String(mm).padStart(2, "0")}${dicha.meridiano ? ` ${dicha.meridiano}` : ""}` };
}

function pesos(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export const PREGUNTA_CANONICA_DE_CONFIRMACION = "¿Está correcto? Responda *sí* para confirmar su pedido o dígame qué desea cambiar.";

/**
 * Largo maximo del resumen canonico. WhatsApp admite 4096 caracteres, pero el LIMITE REAL es el de la deteccion: `sinMarcadores` solo analiza los primeros 4 × MAX_MENSAJE (2400) caracteres
 * de un mensaje, asi que un resumen mas largo perdia la pregunta de confirmacion (y el total) para `esResumenParaConfirmar` / `terminaEnPreguntaDeConfirmacion`. Se deja margen para la frase
 * de tono (hasta 160 caracteres) que `componerRespuestaConResumen` antepone.
 */
export const LIMITE_RESUMEN_CANONICO = 4 * MAX_MENSAJE - 200;
const MAX_NOTA_RESUMEN = 120;
const MAX_LISTA_SALSAS_RESUMEN = 300;

/**
 * Nota libre del pedido ya capturada (`notes`) lista para el resumen que ve el cliente: una sola linea, sin correos ni numeros largos (telefonos, tarjetas) que el modelo
 * haya colado, y acotada. Devuelve `undefined` si no queda nada.
 */
export function sanearNotaDeResumen(nota: unknown, opciones: { readonly direccion?: boolean } = {}): string | undefined {
  if (typeof nota !== "string") return undefined;
  // Recorrido lineal (sin expresiones regulares con repeticiones anidadas: la nota es texto no confiable). Una racha de digitos y separadores con 7 o mas digitos es un telefono o
  // una tarjeta y se quita; una palabra con «@» es un correo y se quita.
  const texto = nota.length > 1000 ? Array.from(nota).slice(0, 1000).join("") : nota;
  let sinNumeros = "";
  let racha = "";
  let digitos = 0;
  let contiguos = 0;
  let maxContiguos = 0;
  // En una DIRECCION («Calle 60 #123 x 21», «No. 1234 97000») los numeros separados por espacios no son un telefono: solo se quita una racha de 10 o mas digitos o 7 o mas digitos SEGUIDOS.
  // Excepcion: un telefono local escrito en dos grupos («123 4567», «9999-9999») es una racha de EXACTAMENTE dos grupos de 3-4 y 4 digitos; «No. 123 21 45» (grupos 3-2-2) y «Calle 60 #123 x 21»
  // no coinciden. Limite conocido: «No. 123 4567» como numero exterior en dos grupos se recorta (preferible a dejar pasar un telefono).
  const esTelefonoLocalEnDosGrupos = (): boolean => {
    const grupos = racha.split(/[^0-9]+/).filter((g) => g !== "");
    return grupos.length === 2 && grupos[1]?.length === 4 && (grupos[0]?.length === 3 || grupos[0]?.length === 4);
  };
  const esTelefonoOTarjeta = (): boolean => (opciones.direccion === true ? digitos >= 10 || maxContiguos >= 7 || esTelefonoLocalEnDosGrupos() : digitos >= 7);
  const cerrarRacha = (): void => {
    if (!esTelefonoOTarjeta()) sinNumeros += racha;
    else sinNumeros += " ";
    racha = "";
    digitos = 0;
    contiguos = 0;
    maxContiguos = 0;
  };
  for (const ch of texto) {
    const esDigito = ch >= "0" && ch <= "9";
    if (esDigito || (racha !== "" && (ch === " " || ch === "-" || ch === "(" || ch === ")" || ch === "." || ch === "+"))) {
      racha += ch;
      if (esDigito) { digitos += 1; contiguos += 1; if (contiguos > maxContiguos) maxContiguos = contiguos; } else contiguos = 0;
    } else {
      cerrarRacha();
      sinNumeros += ch;
    }
  }
  cerrarRacha();
  const limpia = sinNumeros
    .split(/\s/)
    .filter((palabra) => palabra !== "" && !palabra.includes("@"))
    .join(" ")
    .trim();
  if (!limpia) return undefined;
  const puntos = Array.from(limpia);
  return puntos.length > MAX_NOTA_RESUMEN ? `${puntos.slice(0, MAX_NOTA_RESUMEN - 1).join("").trimEnd()}…` : limpia;
}

function acotarLista(items: readonly string[]): string {
  const puntos = Array.from(items.join(", "));
  return puntos.length > MAX_LISTA_SALSAS_RESUMEN ? `${puntos.slice(0, MAX_LISTA_SALSAS_RESUMEN - 1).join("").trimEnd()}…` : puntos.join("");
}

/**
 * Resumen del pedido armado por el SERVIDOR: renglones (con la tortilla de cada uno), salsas pedidas, notas, entrega, pago, terminal, propina y TOTAL tal cual los cotizo. El LLM puede anteponer
 * una frase de tono, nunca cambiar esto. R15/T7-001: antes omitia salsas, tortilla de un kilo y la terminal, y el cliente confirmaba un resumen incompleto. Sin esos datos el texto es el de siempre.
 * Un pedido enorme se acota a `LIMITE_RESUMEN_CANONICO`: se recortan renglones (con un aviso «y N renglones más»), nunca el total, el pago ni la pregunta de confirmacion.
 */
export function resumenCanonico(e: EntradaResumen): string {
  // Un nombre que ya dice sus piezas («Tacos de Bistec (orden de 3)») no se repite: sale «1 × nombre» como siempre.
  const piezasEnElNombre = (l: LineaResumen): boolean => new RegExp(String.raw`\(orden de ${l.piezasPorOrden ?? 0}\)`, "i").test(l.name);
  const etiquetaDe = (l: LineaResumen): string | null => (piezasEnElNombre(l) ? null : etiquetaOrdenConPiezas(l.quantity, l.piezasPorOrden));
  const renglones = e.lineas.map((l) => `• ${etiquetaDe(l) ? `${etiquetaDe(l)} de` : `${l.quantity} ×`} ${l.name}${l.tortilla ? ` (${l.tortilla})` : ""}${typeof l.lineTotal === "number" ? ` — ${pesos(l.lineTotal)}` : ""}`);
  const detalles: string[] = [];
  if (e.basicas && e.basicas.length > 0) detalles.push(`Salsas básicas incluidas: ${acotarLista(e.basicas)}`);
  if (e.salsas && e.salsas.length > 0) detalles.push(`Salsas pedidas (sin costo): ${acotarLista(e.salsas)}`);
  if (e.sinSalsas && e.sinSalsas.length > 0) detalles.push(`Sin: ${acotarLista(e.sinSalsas)}`);
  const nota = sanearNotaDeResumen(e.notas);
  if (nota) detalles.push(`Notas: ${nota}`);
  if (typeof e.descuento === "number" && e.descuento > 0) detalles.push(`Descuento: -${pesos(e.descuento)}`);
  detalles.push(`Entrega: ${e.canal === "recoger" ? "recoger en sucursal" : "a domicilio"}${e.hora ? ` (${e.hora})` : ""}`);
  if (e.canal !== "recoger" && e.direccion) detalles.push(`Dirección: ${e.direccion}`);
  const d = e.datos;
  if (d.pago === "efectivo") detalles.push(`Pago: efectivo${d.efectivoCon ? ` (paga con ${pesos(d.efectivoCon)})` : ""}`);
  else if (d.pago === "tarjeta") detalles.push("Pago: tarjeta");
  // Politica operativa (#598) y decision NU-3: con tarjeta SIEMPRE se lleva terminal (a domicilio y al recoger); el cliente debe verlo antes de aceptar. Va en `detalles`, que nunca se recorta.
  if (d.pago === "tarjeta") detalles.push(e.canal === "recoger" ? "Tendremos terminal para cobrar con tarjeta al recoger" : "Llevará terminal para cobrar con tarjeta");
  if (d.propinaMxn) detalles.push(`Propina: ${pesos(d.propinaMxn)} (no suma al total)`);
  else if (d.propinaPct) detalles.push(`Propina: ${d.propinaPct}% (no suma al total)`);
  detalles.push(`Total a pagar: ${pesos(e.total)}`);
  const cola = ["", PREGUNTA_CANONICA_DE_CONFIRMACION];
  const armar = (visibles: readonly string[]): string => ["Resumen de su pedido:", ...visibles, ...detalles, ...cola].join("\n");
  const completo = armar(renglones);
  if (completo.length <= LIMITE_RESUMEN_CANONICO) return completo;
  // Pedido grande: caben los renglones que alcancen y el resto se resume en una linea (el total ya los incluye).
  const avisoDe = (n: number): string => `• … y ${n} ${n === 1 ? "renglón" : "renglones"} más (incluidos en el total)`;
  const presupuesto = LIMITE_RESUMEN_CANONICO - armar([avisoDe(renglones.length)]).length;
  const visibles: string[] = [];
  let usado = 0;
  for (const r of renglones) {
    if (usado + r.length + 1 > presupuesto) break;
    visibles.push(r);
    usado += r.length + 1;
  }
  const ocultos = renglones.length - visibles.length;
  return armar(ocultos > 0 ? [...visibles, avisoDe(ocultos)] : visibles);
}

/**
 * Respuesta final del turno de WhatsApp: si el modelo cerro su mensaje pidiendo la confirmacion pero SIN el total de la cotizacion (el patron «¿Confirma su pedido?»
 * sin cifras que dejaba al cliente aceptando a ciegas), se sustituye por el resumen canonico. Si ya trae el total y la pregunta de confirmacion se respeta tal cual (el tono es
 * del modelo; la guardia de cifras corrige un total inventado). Si el mensaje pregunta otra cosa (propina, pago, nombre) NO se toca: aun no es el momento del resumen.
 */
export function componerRespuestaConResumen(respuesta: string, canonico: string, total: number): string {
  if (!terminaEnPreguntaDeConfirmacion(respuesta)) return respuesta;
  if (resumenMostradoEnHistorial(total, [{ role: "assistant", content: respuesta }]) === true) return respuesta;
  const primerParrafo = respuesta.split(/\n\s*\n/)[0]?.trim() ?? "";
  const preludio = primerParrafo && !/[$?¿]/.test(primerParrafo) && primerParrafo.length <= 160 && primerParrafo !== respuesta.trim() ? `${primerParrafo}\n\n` : "";
  return `${preludio}${canonico}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Decision de confirmar
// ---------------------------------------------------------------------------------------------------------------------

export type CodigoCierre = "cierre_resumen_no_mostrado" | "cierre_sin_si_explicito" | "cierre_datos_cambiaron";

export type DecisionConfirmacion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: CodigoCierre;
      readonly mensaje: string;
      readonly respuesta: RespuestaCierre | "sin_resumen";
      readonly marcarAmbiguo: boolean;
      /** El resumen no se reconocio como mostrado: el llamador guarda el turno para abrir la salida segura en el turno siguiente. */
      readonly marcarNoVisto?: boolean;
      /** Respuesta de pago / propina: el servidor adopta estos datos y rearma el resumen (no confirma). */
      readonly datosNuevos?: DatosDeCierre;
    };

export interface EntradaDecision {
  readonly ctx: OrderFlowContext;
  readonly historial: readonly MensajeHistorial[];
  readonly turn: string | null;
  readonly canonico?: string;
}

const COMO_MOSTRAR = (canonico: string | undefined): string =>
  canonico
    ? ` Muéstrele AHORA este resumen, copiado tal cual, y espere su respuesta en el mensaje siguiente:\n${canonico}`
    : " Muéstrele ahora el resumen completo (renglones, entrega, pago y total a pagar), pregúntele si está correcto y espere su sí en el mensaje siguiente.";

/** ¿Puede confirmarse el resumen con lo que el cliente vio y dijo? Pura: no escribe nada. El llamador persiste `marcarAmbiguo`. */
export function decidirConfirmacion(e: EntradaDecision): DecisionConfirmacion {
  const ultimoAsistente = ultimoDe(e.historial, "assistant");
  const ultimoCliente = ultimoDe(e.historial, "user");
  const salidaNoVisto = e.ctx.cierreNoVistoTurn !== undefined && e.turn !== null && e.ctx.cierreNoVistoTurn !== e.turn;
  // SALIDA SEGURA contra la heuristica de texto (falso negativo: el resumen salio con el total en letras, otra pregunta final o fuera de la ventana de historial): si ya se rechazo UNA vez por
  // «resumen no mostrado» y en un turno POSTERIOR el cliente contesta un «si» claro, se acepta. El cierre se retrasa a lo mucho un turno y nunca se queda trabado.
  if (salidaNoVisto && !esResumenParaConfirmar(e.ctx.quotedTotal, ultimoAsistente)) {
    const totalVisto = resumenMostradoEnHistorial(e.ctx.quotedTotal, [{ role: "assistant", content: ultimoAsistente ?? "" }]) === true;
    if (clasificarRespuestaCierre(ultimoCliente, { despuesDelResumen: totalVisto, datosCotizados: datosDeCierreDeContexto(e.ctx), total: e.ctx.quotedTotal }) === "si") return { ok: true };
  }
  if (!esResumenParaConfirmar(e.ctx.quotedTotal, ultimoAsistente)) {
    // El cliente contesto un dato de pago / propina antes de ver el resumen: el servidor lo adopta para que el resumen que se le muestre ya lo lleve.
    const previos = datosDeCierreDeContexto(e.ctx);
    const claseFuera = clasificarRespuestaCierre(ultimoCliente, { despuesDelResumen: false, datosCotizados: previos, total: e.ctx.quotedTotal });
    const nuevos = claseFuera === "dato" && ultimoCliente ? aplicarDatosDelMensaje(previos, datosDelMensaje(ultimoCliente, e.ctx.quotedTotal)) : undefined;
    return {
      ok: false,
      code: "cierre_resumen_no_mostrado",
      respuesta: "sin_resumen",
      marcarAmbiguo: false,
      marcarNoVisto: true,
      ...(nuevos && firmaDeCierre(nuevos) !== firmaDeCierre(previos) ? { datosNuevos: nuevos } : {}),
      mensaje: `NO se confirmó el pedido: el cliente todavía no ha visto el resumen final con el total de $${e.ctx.quotedTotal ?? "?"} y la pregunta de confirmación (un sí a otra pregunta, como el pago o la propina, no es la confirmación).${COMO_MOSTRAR(e.canonico)}`,
    };
  }
  const clase = clasificarRespuestaCierre(ultimoCliente, { despuesDelResumen: true, datosCotizados: datosDeCierreDeContexto(e.ctx), total: e.ctx.quotedTotal });
  if (clase === "si") return { ok: true };
  if (clase === "ambiguo") {
    // Salida segura: la primera vez se pide un si claro; si el cliente vuelve a contestar algo ambiguo DESPUES de que se le mostro el resumen otra vez, el modelo decide.
    if (e.ctx.cierreAmbiguoTurn !== undefined && e.turn !== null && e.ctx.cierreAmbiguoTurn !== e.turn && ambiguoAceptablePorSalida(ultimoCliente)) return { ok: true };
    return {
      ok: false,
      code: "cierre_sin_si_explicito",
      respuesta: clase,
      marcarAmbiguo: true,
      mensaje: "NO se confirmó el pedido: el último mensaje del cliente no es un sí claro al resumen. Contéstele lo que haya preguntado (si preguntó algo) y pídale que responda «sí» para confirmar o que le diga qué desea cambiar. Si su siguiente mensaje sigue siendo un titubeo inocuo (sin preguntas, negaciones ni cambios), el sistema lo aceptará; si duda, rechaza o pregunta, siga conversando con él.",
    };
  }
  const guia: Record<Exclude<RespuestaCierre, "si" | "ambiguo">, string> = {
    no: "El cliente NO aceptó el resumen. No confirme ni cree el pedido: pregúntele qué desea cambiar (sin discutir el precio), vuelva a cotizar con lo que corrija y pida su confirmación otra vez.",
    cambio: "El cliente quiere cambiar algo del pedido. No confirme: aplique el cambio, vuelva a llamar cotizar_pedido con el pedido corregido y muéstrele el resumen nuevo para que lo confirme.",
    dato: "El último mensaje del cliente es un dato de pago o propina, NO el sí al resumen. No confirme: guarde el dato, vuelva a llamar cotizar_pedido con el pago (y la propina si la dio) y muéstrele el resumen completo con ese dato para que diga sí.",
  };
  const mensaje = `NO se confirmó el pedido. ${guia[clase]}`;
  // Un dato de pago o propina dicho junto con un cambio («mejor con tarjeta», «sí, pero con 600»): tampoco confirma, y el servidor igual adopta el dato.
  if ((clase === "dato" || clase === "cambio") && ultimoCliente) {
    const d = datosDelMensaje(ultimoCliente, e.ctx.quotedTotal);
    const nuevos = aplicarDatosDelMensaje(datosDeCierreDeContexto(e.ctx), d);
    if (firmaDeCierre(nuevos) !== firmaDeCierre(datosDeCierreDeContexto(e.ctx))) return { ok: false, code: "cierre_sin_si_explicito", respuesta: clase, marcarAmbiguo: false, mensaje, datosNuevos: nuevos };
  }
  return { ok: false, code: "cierre_sin_si_explicito", respuesta: clase, marcarAmbiguo: false, mensaje };
}

/**
 * Datos de cierre de `crear_pedido`, normalizados para compararlos con los confirmados. Pago y efectivo: lo que manda el modelo; si omite el pago se entiende el cotizado.
 * Propina: SOLO un valor positivo cuenta como dato nuevo; vacia, 0 o ausente (el relleno habitual del modelo) hereda la cotizada, de modo que olvidar repetirla no
 * traba el cierre (ni crea el pedido sin la propina que el cliente ya vio en el resumen).
 */
export function datosDeCierreDeEntrada(input: Record<string, unknown>, ctx: OrderFlowContext): DatosDeCierre & { readonly heredaPropina: boolean } {
  const pago = input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? input.payment_method : ctx.quotedPago;
  const efectivoCon = pago === "tarjeta" ? undefined : typeof input.efectivo_con === "number" && input.efectivo_con > 0 ? input.efectivo_con : ctx.quotedEfectivoCon;
  let propinaMxn = typeof input.propina === "number" && input.propina > 0 ? input.propina : undefined;
  let propinaPct: number | undefined;
  const crudo = input.propina_porcentaje;
  if (propinaMxn === undefined && typeof crudo === "number" && crudo > 0) propinaPct = crudo;
  else if (propinaMxn === undefined && typeof input.propina === "string") {
    const m = /^\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|por\s*ciento)\s*$/i.exec(input.propina);
    if (m) propinaPct = Number(m[1]!.replace(",", "."));
  }
  const heredaPropina = propinaMxn === undefined && propinaPct === undefined;
  if (heredaPropina) {
    propinaMxn = ctx.quotedPropinaMxn;
    propinaPct = ctx.quotedPropinaPct;
  }
  return { pago, efectivoCon, propinaMxn, propinaPct, heredaPropina };
}

/** Mensaje cuando crear_pedido llega con pago / efectivo / propina distintos a los del resumen confirmado. El servidor ya adopto el dato y rearmo el resumen. */
export function mensajeDatosCambiaron(canonicoNuevo?: string): string {
  return `NO se creó el pedido: el pago, el efectivo o la propina que intenta registrar NO son los del resumen que el cliente confirmó. El sistema ya actualizó el resumen con ese dato.${canonicoNuevo ? ` Muéstreselo AHORA al cliente, copiado tal cual, y espere su sí en el mensaje siguiente (no vuelva a llamar crear_pedido en este turno):\n${canonicoNuevo}` : " Vuelva a llamar cotizar_pedido con esos datos (payment_method, efectivo_con, propina o propina_porcentaje), muéstrele el resumen nuevo y espere su sí."}`;
}
