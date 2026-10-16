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
}

export interface EntradaResumen {
  readonly lineas: readonly LineaResumen[];
  readonly total: number;
  readonly descuento?: number;
  readonly canal?: string;
  readonly datos: DatosDeCierre;
  readonly hora?: string;
}

function pesos(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export const PREGUNTA_CANONICA_DE_CONFIRMACION = "¿Está correcto? Responda *sí* para confirmar su pedido o dígame qué desea cambiar.";

/** Resumen del pedido armado por el SERVIDOR: renglones, entrega, pago, propina y TOTAL tal cual los cotizo. El LLM puede anteponer una frase de tono, nunca cambiar esto. */
export function resumenCanonico(e: EntradaResumen): string {
  const renglones = e.lineas.map((l) => `• ${l.quantity} × ${l.name}${l.tortilla ? ` (${l.tortilla})` : ""}${typeof l.lineTotal === "number" ? ` — ${pesos(l.lineTotal)}` : ""}`);
  const filas: string[] = ["Resumen de su pedido:", ...renglones];
  if (typeof e.descuento === "number" && e.descuento > 0) filas.push(`Descuento: -${pesos(e.descuento)}`);
  filas.push(`Entrega: ${e.canal === "recoger" ? "recoger en sucursal" : "a domicilio"}${e.hora ? ` (${e.hora})` : ""}`);
  const d = e.datos;
  if (d.pago === "efectivo") filas.push(`Pago: efectivo${d.efectivoCon ? ` (paga con ${pesos(d.efectivoCon)})` : ""}`);
  else if (d.pago === "tarjeta") filas.push("Pago: tarjeta");
  if (d.propinaMxn) filas.push(`Propina: ${pesos(d.propinaMxn)} (no suma al total)`);
  else if (d.propinaPct) filas.push(`Propina: ${d.propinaPct}% (no suma al total)`);
  filas.push(`Total a pagar: ${pesos(e.total)}`);
  filas.push("", PREGUNTA_CANONICA_DE_CONFIRMACION);
  return filas.join("\n");
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
