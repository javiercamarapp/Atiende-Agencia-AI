// Cancelación, retractación, posible baja y «¿mantengo o cancelo?» del cerebro «suelto» (wt-suelto-voz, e69279e), canal
// WhatsApp (sin las variantes *Voz). Port literal de whatsapp-agent-core.ts (patrones de cancelar, R25–R93) y de
// cancelacionReply de pm-policies.ts. Todo es puro: sin base, sin red, sin reloj implícito (la hora llega por parámetro).
// La orquestación de runAgentTurn queda resumida en decidirCancelacion (al final del archivo).

import {
  RAZON_MODIFICACION_PEDIDO,
  RAZON_POSIBLE_BAJA,
  RAZON_RECLAMO_PEDIDO,
  TOPE_MENSAJE_AVISO,
  VENTANA_CONFIRMA_CANCELACION_MIN,
} from "./avisos.ts";
import { CANCELACION_VENTANA_MIN, cancelacionReply } from "./politicas-pm.ts";
import { citaDelCliente, esMarcadorSesion, type MensajeHilo, normAviso } from "./texto-plano.ts";

export type { MensajeHilo };

// La política (pm-policies.ts: ventana ~10 min y la respuesta fija) vive en politicas-pm.ts y los motivos y ventanas de los
// avisos en avisos.ts (ports hermanos): se reutilizan tal cual.
/** El aviso de cancelación (alto riesgo, con alerta inmediata). */
export const RAZON_CANCELACION = "alto_riesgo:cancelacion";

/** Opciones del clasificador de riesgo que usa la cancelación (OpcionesRiesgo del núcleo, sin las de voz). */
export interface OpcionesCancelacion {
  /** La sesión tiene un pedido a medias (buscar_producto/cotizar_pedido sin crear_pedido posterior): el carrito. */
  readonly pedidoEnCurso?: boolean;
  /**
   * Revisión 78 (R78-9): extras (cubiertos, servilletas, popotes…) que la última respuesta del asistente ofrece en una
   * pregunta (ver extrasOfrecidos).
   */
  readonly extrasOfrecidos?: readonly string[];
  /** Revisión 93 (R93-3): dos o más pedidos vivos: solo entonces «cancela el de mi hermana» es cancelar ese pedido. */
  readonly variosPedidosVivos?: boolean;
}

/**
 * «si» / «no» si la respuesta es UNA sola palabra (o «👍») sin ambigüedad y no es pregunta; si no, null (siNoDeUnaPalabra de
 * intencion-pedido-aparte.ts). Pura.
 */
function siNoDeUnaPalabra(texto: string): "si" | "no" | null {
  if (/[¿?]/.test(String(texto ?? ""))) return null;
  const n = String(texto ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}]|️|‍/gu, "")
    .toLowerCase()
    .replace(/[¡!.,;:…"'«»()-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^([a-z]*?)([a-z])\2+$/, "$1$2");
  if (!n || /\s/.test(n)) return null;
  if (["si", "sip", "va", "ok", "okay", "dale", "yes", "\u{1F44D}"].includes(n)) return "si";
  if (["no", "nel", "nop"].includes(n)) return "no";
  return null;
}

/**
 * Respaldo de declaraAlergia (el clasificador de alergias del núcleo, otro bloque): esSiQueConfirmaCancelar no confirma un
 * «sí, soy alérgico…». Sin el clasificador real se usa PATRON_ALERGIA (cualquier mención), que solo manda más casos al modelo.
 */
const PATRON_ALERGIA =
  /\baler[gj]i[a-z]*\b|\baleg(?:i[ck][a-z]*|ias?)\b|\balerg\.|\balergenos?\b|\banafila[a-z]*|\bintoleran(?:te|cia|tes|t|ts|ce)\b|\bceliac(?:[oa]s?)?\b|\bceliaquia\b|\ballerg[a-z]*|\banaphyla[a-z]*|\bcoeliac\b/;
export function mencionaAlergia(texto: string): boolean {
  return PATRON_ALERGIA.test(String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase());
}

/** Revisión R28-7c: sin caracteres de control (U+0000–U+001F salvo el salto de línea, y U+007F). Pura. */
function sinControles(texto: string): string {
  // eslint-disable-next-line no-control-regex
  return texto.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ");
}
/** Revisión R28-7c: los primeros `tope` puntos de código (nunca deja medio emoji). Pura. */
function hastaPuntosDeCodigo(texto: string, tope: number): string {
  const cp = Array.from(texto);
  return cp.length <= tope ? texto : cp.slice(0, Math.max(0, tope)).join("");
}
/** Revisión 91 (R91-3): a quién va el otro pedido («para mi mamá / papá / oficina / hermana…»). Texto plano. */
/** Revisión 92 (R92-4): a quién puede ir un pedido (personas y lugares), texto plano. */
const DESTINATARIOS_PEDIDO =
  "mama|mamas|papa|papas|madre|padre|padres|hermano|hermana|hermanos|hermanas|esposa|esposo|hijo|hija|hijos|hijas|tia|tio|abuela|abuelo|suegra|suegro|novia|novio|amigo|amiga|amigos|amigas|prima|primo|jefe|jefa|vecino|vecina|cunada|cunado|comadre|compadre|oficina|trabajo|familia";
// Revisión 79 (R79-C): también lo que se vende por kilo («el kilo de pastor», «el medio kilo», «la carne»).
const COMIDA_RECLAMO =
  "kilo|kilos|carne|carnes|coca|cocas|refresco|refrescos|bebida|bebidas|agua|cerveza|taco|tacos|orden|ordenes|salsa|salsas|guacamole|queso|quesadilla|quesadillas|gringa|gringas|alambre|alambres|suizo|suizos|mestiza|mestizas|papa|papas|frijoles|tortilla|tortillas|limon|limones|cebolla|nachos|torta|tortas|postre|complemento|complementos|pastor|bistec|pollo|pechuga|chorizo|cochinita|res|" +
  // Revisión 40 (P2): lo que faltaba del menú de PM (sopa de lima, arrachera, chuleta, flautas, postres, bebidas…).
  "sopa|sopas|arrachera|chuleta|costilla|champinon|champinones|rajas|flauta|flautas|fajita|fajitas|alitas|papadzules|codzitos|hamburguesa|hamburguesas|chetaco|chetacos|quesobich|parrillada|ensalada|flan|jericalla|jericallas|horchata|limonada|limonadas|naranjada|naranjadas|sprite|fanta|michelada|chelada|cafe";
const PROTEINA_RECLAMO = "pastor|bistec|pechuga|pollo|res|chorizo|cochinita|suadero|campechano";
// Cancelación: frases donde «cancelar» está NEGADO DIRECTAMENTE («no quiero que lo cancelen», «no lo cancelen»,
// «no he dicho que se cancele», «sin cancelar»). Eso no es una petición de cancelar: es el cliente pidiendo que
// NO se cancele (ciego C2: PED-29 rep4 repetía 4 veces «ya avisé de su cancelación»). Sobre texto sin acentos.
// Las condicionales y cortesías («si no llega a tiempo cancelen», «si es posible quiero cancelar», «si pueden
// cancelen») SÍ son peticiones: un falso negativo cuesta un pedido cobrado y no deseado; un falso positivo,
// un aviso de más. La única condicional neutralizada es «si no se puede ajustar/cambiar…, cancélenlo» cuando
// hay un pedido a medias SIN crear (no hay nada que cancelar todavía).
const CLITICOS_CANCEL = String.raw`(?:(?:lo|la|los|las|se|me|nos|le)\s+){0,2}(?:(?:vayan?|vaya)\s+a\s+)?`;
// Retractación de una cancelación ya pedida: «olvida lo de cancelar», «no era para cancelar», «ya no cancelen».
// Tampoco es una petición de cancelar (y, con un aviso de cancelación abierto, se le anexa).
// Revisión 33: también con «anular» («ya no lo anulen»).
const RETRACTACION_CANCEL = [
  String.raw`\b(?:olvid\w*|ignor\w*)\s+(?:lo\s+de\s+|eso\s+de\s+|lo\s+que\s+(?:dije\s+)?(?:de\s+)?|que\s+)?${CLITICOS_CANCEL}(?:cancel|anul)\w*`,
  String.raw`\b(?:olvid\w*|ignor\w*)\s+(?:lo\s+de\s+|eso\s+de\s+|lo\s+que\s+(?:dije\s+)?(?:de\s+)?|que\s+)?${CLITICOS_CANCEL}cancel\w*`,
  String.raw`\bno\s+(?:era|fue|iba|queria|queriamos|quise|quisimos)\s+(?:(?:para|a|que)\s+)?${CLITICOS_CANCEL}(?:cancel|anul)\w*`,
  String.raw`\bya\s+no\s+${CLITICOS_CANCEL}(?:cancel|anul)\w*`,
  // Revisión 34: «ya no lo quiero cancelar» («no, ya no lo quiero cancelar, gracias»): antes «ya no lo quiero» lo volvía
  // una cancelación.
  String.raw`\bya\s+no\s+${CLITICOS_CANCEL}(?:quiero|queremos|quisiera)\s+(?:que\s+)?${CLITICOS_CANCEL}(?:cancel|anul)\w*`,
];
const RETRACTACION_CANCELACION = new RegExp(RETRACTACION_CANCEL.join("|"));
/** El texto retira una cancelación pedida antes («olvida lo de cancelar, espero»). */
export function esRetractacionDeCancelacion(texto: string): boolean {
  return RETRACTACION_CANCELACION.test(normAviso(texto));
}
/**
 * Revisión 33: retractaciones que solo lo son justo después del aviso de cancelación o de la pregunta del alcance
 * (esRetractacionEnContexto).
 * Revisión 34: solo las EXPLÍCITAS, que nombran el cancelar: «no quiero cancelar», «no lo cancele(n)», «mejor no lo
 * cancele», «no lo quiero cancelar», «don't cancel». Un «no» o «no, gracias» suelto contesta la pregunta del alcance (se
 * anexa literal y el modelo pregunta) y «no, mejor no» / «olvídelo» van al modelo: tomarlos por retractación podía dejar
 * a la sucursal sin cancelar un pedido que el cliente sí quería cancelar.
 */
const RETRACTACION_CORTA = new RegExp(
  String.raw`^(?:(?:no|oiga|oye|oigan|perdon|disculpe|mejor|ok|sabe\s+que|esper\w*|(?:un\s+)?momento|aguant\w*)[\s,.;:!]+)*(?:(?:ya\s+)?no\s+(?:(?:lo|la|me\s+lo|me\s+la)\s+)?(?:quiero|queremos|quisiera)\s+(?:que\s+)?(?:(?:lo|la|se|me\s+lo|me\s+la)\s+)?cancel\w*|no\s+(?:(?:lo|la|me\s+lo|me\s+la|se)\s+)?cancel(?:e|en|es)\b|(?:don['’]?\s*t|do\s+not)\s+cancel\w*)`,
);
/**
 * Revisión 33: ¿la última respuesta del asistente es el aviso de cancelación o la pregunta del alcance? Ahí un «no lo
 * cancele» o «no quiero cancelar» retira la cancelación. Pura.
 */
export function contextoDeAvisoDeCancelacion(messages: readonly MensajeHilo[]): boolean {
  const ultima = ultimaRespuestaDelAsistente(messages);
  // Revisión 91 (R91-6): también el acuse en inglés (CANCELACION_REPLY_EN).
  // Revisión 92 (R92-2): también la pregunta «¿Entonces mantengo su pedido o lo cancelo?» (el aviso sigue abierto).
  return ultima.includes(PREFIJO_PREGUNTA_ALCANCE_CANCELACION) || /\bde su cancelaci[oó]n\b|\bof your cancellation\b/.test(ultima) ||
    ultima.includes(PREGUNTA_MANTENER_O_CANCELAR) || ultima.includes(PREGUNTA_MANTENER_O_CANCELAR_EN);
}
/** Revisión 33: retractación (siempre) o retractación corta en el contexto de un aviso de cancelación recién dado. Pura. */
export function esRetractacionEnContexto(texto: string, contextoCancelacion: boolean): boolean {
  if (esRetractacionDeCancelacion(texto)) return true;
  if (!contextoCancelacion) return false;
  // Revisión 87 (R87-Q): tras el aviso de cancelación, «no espera, sí lo quiero», «siempre sí mándenlo», «mejor sí lo
  // quiero», «olvídalo, sí lo quiero», «me equivoqué, sí quiero mi pedido» también retiran la cancelación.
  if (SI_LO_QUIERE_TRAS_CANCELAR.test(normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim())) return true;
  // Con los signos: «no, cancele todo» (coma) es cancelar, «no cancele» no.
  return RETRACTACION_CORTA.test(normAviso(texto).replace(/[¿¡"“”«»]+/g, "").replace(/\s+/g, " ").trim());
}
/** Revisión 88 (R88-7): ¿es un «sí lo quiero» (SI_LO_QUIERE_TRAS_CANCELAR) y no una retractación que nombra el cancelar? Pura. */
function esSiLoQuieroTrasCancelar(texto: string): boolean {
  return !esRetractacionDeCancelacion(texto) &&
    SI_LO_QUIERE_TRAS_CANCELAR.test(normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim());
}
/** Revisión 87 (R87-Q): «sí lo quiero» tras el aviso de cancelación (texto plano sin signos). */
// Revisión 91 (R91-2): también en inglés («actually I still want it», «never mind, send it»).
const PREFIJO_SI_LO_QUIERE =
  String.raw`^(?:(?:no|oiga|oye|oigan|perdon|perdone|disculpe|disculpa|ok|okay|ah|ay|oh|olvidalo|olvidelo|olviden\s+eso|me\s+equivoque|sabe\s+que|esper\w*|(?:un\s+)?momento|actually|wait|sorry)\s+)*`;
// Revisión 93 (R93-3): también en tercera persona («no espera, sí lo quiere»: el pedido cancelado era de otra persona).
const SI_LO_QUIERE_ES =
  String.raw`(?:(?:mejor|siempre)\s+)?si\s+(?:(?:lo|la)\s+(?:quiero|queremos|quiere|quieren|espero)|quiero\s+(?:mi|el)\s+pedido|(?:mand|envi|trai)\w*(?:lo|la|los|las|melo|mela)\b)`;
const SI_LO_QUIERE_EN = String.raw`(?:i\s+)?still\s+want\s+(?:it|my\s+order|the\s+order)|never\s*mind\s+(?:please\s+)?send\s+it(?:\s+anyway)?`;
const CORTESIA_SI_LO_QUIERE = String.raw`(?:\s+(?:perdon|gracias|porfa|por\s+favor|si|mandenlo|mandalo|mandemelo|please|thanks|thank\s+you))*`;
const SI_LO_QUIERE_TRAS_CANCELAR = new RegExp(
  PREFIJO_SI_LO_QUIERE + String.raw`(?:${SI_LO_QUIERE_ES}|${SI_LO_QUIERE_EN})` + CORTESIA_SI_LO_QUIERE + "$",
);
/**
 * Revisión 89 (R89-6): «siempre sí lo quiero, pero agrégale 2 cocas»: el «sí lo quiero» (SI_LO_QUIERE_TRAS_CANCELAR) con algo
 * más pegado («pero / y …»). Retira la cancelación y lo demás va al modelo. Pura.
 */
// Revisión 91 (R91-2, invierte R90-3): «sí lo quiero / siempre sí / todavía lo quiero, pero …» RETIRA la cancelación por
// defecto (la prisa, el pago, la harina o la dirección van al modelo); solo no la retira si lo pegado niega quererlo
// (NIEGA_QUERERLO).
const SI_LO_QUIERE_CON_MAS = new RegExp(
  PREFIJO_SI_LO_QUIERE +
    String.raw`(?:${SI_LO_QUIERE_ES}|siempre\s+si|todavia\s+(?:lo|la)\s+(?:quiero|queremos)|${SI_LO_QUIERE_EN})` + CORTESIA_SI_LO_QUIERE +
    String.raw`\s+(?:pero|y|e|nada\s+mas|solo|ademas|tambien|but|and)\s+(\S.*)$`,
);
/**
 * Revisión 91 (R91-2): lo pegado que niega quererlo: «mejor no», «ya no» (solo o con «lo quiero / me lo mandes / me
 * alcanza»), «no hoy», «en otra ocasión», «otro día», «no me alcanza», «no me lo mandes»; en inglés «not today», «another
 * time», «can't afford», «don't send it», «no longer», «not anymore». «ya no tarden» no niega. Texto plano sin signos.
 */
const NIEGA_QUERERLO = new RegExp(
  String.raw`\bmejor\s+no(?:\s+(?:lo|la|me|gracias)\b|$)|\bya\s+no(?:\s+(?:lo|la|me|quiero|gracias)\b|$)|\bno\s+hoy\b|\ben\s+otra\s+ocasion\b|\botro\s+dia\b|\bno\s+me\s+alcanza\b|\bno\s+me\s+lo\s+mand\w*|` +
    String.raw`\bnot\s+today\b|\banother\s+(?:time|day)\b|\b(?:can\s?t|cannot)\s+afford\b|\bdon\s?t\s+send\s+it\b|\bno\s+longer\b|\bnot\s+any\s?more\b`,
);
/**
 * Revisión 92 (R92-2): lo pegado al «sí lo quiero, pero …» que es un cambio CONCRETO al pedido: quitar / agregar / poner / sin /
 * con / cambiar + un producto o cantidad, la tortilla («de harina»), la dirección, recoger o la forma de pago. Texto plano.
 */
const PRODUCTO_TRAS_SI_LO_QUIERE = String.raw`\d|\b(?:${COMIDA_RECLAMO}|${PROTEINA_RECLAMO}|harina|maiz|cilantro|chile|picante|verduras?|cokes?|sodas?|drinks?)\b`;
const CAMBIO_CONCRETO_TRAS_SI = new RegExp(
  String.raw`\b(?:quit\w*|agreg\w*|aument\w*|anad\w*|sum\w*|pon\w*|cambi\w*|sin|con|mas|extra|add|remove|without|with|change|switch|plus)\b.*?(?:${PRODUCTO_TRAS_SI_LO_QUIERE})` +
    String.raw`|\b(?:de|en)\s+(?:harina|maiz)\b` +
    String.raw`|\b(?:calle|domicilio|direccion|colonia|col|avenida|av|fracc\w*|cruzamientos?|address)\b` +
    String.raw`|\b(?:recog\w*|recoj\w*|pick\s*up|para\s+llevar)\b` +
    String.raw`|\b(?:pago|pagar|pagare|pagaria|efectivo|tarjeta|transferencia|cash|card|pay)\b`,
);
/**
 * Revisión 92 (R92-2): qué es un «sí lo quiero / todavía lo quiero, pero <X>» tras el aviso de cancelación: «retira» si X es
 * un cambio concreto (CAMBIO_CONCRETO_TRAS_SI), «niega» si X niega quererlo o vuelve a cancelar, «ambiguo» en lo demás («pero
 * mañana», «pero ya me voy a dormir», «pero que llegue rápido»): ahí ni se retira ni se calla, se pregunta. null si no es
 * esa forma. Pura.
 */
function sentidoSiLoQuieroConMas(texto: string): "retira" | "niega" | "ambiguo" | null {
  if (esRetractacionDeCancelacion(texto)) return null;
  const m = SI_LO_QUIERE_CON_MAS.exec(normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim());
  if (!m) return null;
  const resto = m[m.length - 1] ?? "";
  if (NIEGA_QUERERLO.test(resto) || /\b(?:cancel|anul)\w*/.test(resto)) return "niega";
  return CAMBIO_CONCRETO_TRAS_SI.test(resto) ? "retira" : "ambiguo";
}
/** Revisión 89 (R89-6) / 92 (R92-2): «sí lo quiero, pero <cambio concreto>»: retira la cancelación. Pura. */
export function esSiLoQuieroConMas(texto: string): boolean {
  return sentidoSiLoQuieroConMas(texto) === "retira";
}
/** Revisión 92 (R92-2): «sí lo quiero, pero <algo que no es un cambio ni una negación>»: se pregunta. Pura. */
export function esSiLoQuieroAmbiguo(texto: string): boolean {
  return sentidoSiLoQuieroConMas(texto) === "ambiguo";
}
/** Revisión 92 (R92-2): la pregunta fija ante el «sí lo quiero, pero …» ambiguo (el aviso de cancelación sigue como está). */
export const PREGUNTA_MANTENER_O_CANCELAR = "¿Entonces mantengo su pedido o lo cancelo?";
export const PREGUNTA_MANTENER_O_CANCELAR_EN = "So should I keep your order or cancel it?";
/** Revisión 92 (R92-2): «no» (o «mejor no», «nel») a PREGUNTA_MANTENER_O_CANCELAR: la cancelación sigue. */
export const CANCELACION_SIGUE_REPLY = "Entendido, su cancelación sigue en pie; la sucursal ya la tiene.";
export const CANCELACION_SIGUE_REPLY_EN = "Understood, your cancellation stands; the branch already has it.";
/** Revisión 92 (R92-2): ¿la última respuesta del asistente trae PREGUNTA_MANTENER_O_CANCELAR? Pura. */
export function preguntoMantenerOCancelar(messages: readonly MensajeHilo[]): boolean {
  const ultima = ultimaRespuestaDelAsistente(messages);
  return ultima.includes(PREGUNTA_MANTENER_O_CANCELAR) || ultima.includes(PREGUNTA_MANTENER_O_CANCELAR_EN);
}
/** Revisión 92 (R92-2): «mantenlo», «mantener», «sí, mándalo», «que sí», «keep it» contestando la pregunta. Texto plano. */
const RESPUESTA_MANTENER = new RegExp(
  String.raw`^(?:(?:si|ok|okay|va|sale|claro|mejor|ah|bueno)\s+)*(?:mantenlo|mantengalo|mantenganlo|mantenerlo|mantener|mantenga|mantengan|que\s+si|(?:mand|envi)\w*(?:lo|la|melo|mela)|keep\s+it|keep|yes\s+keep\s+it)` +
    String.raw`(?:\s+(?:porfa|por\s+favor|gracias|please|thanks|mandalo|mandenlo|si))*$`,
);
/**
 * Revisión 93 (R93-2): ¿está pendiente la pregunta «¿Entonces mantengo su pedido o lo cancelo?»? «ultima» si es la última
 * respuesta del asistente; «reciente» si se hizo a lo más 3 turnos del cliente atrás (contando el actual) y desde entonces
 * no se acusó ni el retiro ni la cancelación; null en lo demás. Pura.
 */
export function preguntaMantenerPendiente(messages: readonly MensajeHilo[]): "ultima" | "reciente" | null {
  let bloques = 0;
  let enCliente = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (esMarcadorSesion(m)) return null;
    if (m?.role === "user") {
      if (!enCliente) bloques++;
      enCliente = true;
      continue;
    }
    enCliente = false;
    if (m?.role !== "assistant" || typeof m.content !== "string") continue;
    if (m.content.includes(PREGUNTA_MANTENER_O_CANCELAR) || m.content.includes(PREGUNTA_MANTENER_O_CANCELAR_EN)) {
      return bloques <= 1 ? "ultima" : bloques <= 3 ? "reciente" : null;
    }
    if (/sigue\s+en\s+pie|still\s+on|prefiere\s+esperar|de\s+su\s+cancelaci[oó]n|of\s+your\s+cancellation|cancellation\s+stands/i.test(m.content)) {
      return null;
    }
  }
  return null;
}
/** Revisión 93 (R93-2): ¿ya se hizo en esta sesión la pregunta «mantengo o cancelo»? Pura. */
function yaSePreguntoMantener(messages: readonly MensajeHilo[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (esMarcadorSesion(m)) return false;
    if (
      m?.role === "assistant" && typeof m.content === "string" &&
      (m.content.includes(PREGUNTA_MANTENER_O_CANCELAR) || m.content.includes(PREGUNTA_MANTENER_O_CANCELAR_EN))
    ) return true;
  }
  return false;
}
const planoRespuesta = (texto: string) => normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
/** Revisión 93 (R93-2): «sí», «sí porfa», «claro» a secas contestando la pregunta: mantener. Pura. */
function diceSiSolo(texto: string): boolean {
  return /^(?:si|sip|simon|si si|claro(?: que si)?|yes|yep|yeah)(?: (?:porfa|por favor|gracias|please|thanks|claro))*$/.test(planoRespuesta(texto));
}
/**
 * Revisión 93 (R93-2): mantener dicho con su verbo, en cualquier parte: «mantén mi pedido», «lo mantengo», «que siga», «déjalo
 * así», «no, mantenlo», «sí, mantenlo pero que llegue rápido», «keep it». No si lo niega («no lo mantengas») ni si cancela.
 */
function diceMantenerAmplio(texto: string): boolean {
  const p = planoRespuesta(texto);
  if (/\bno (?:lo |la )?(?:mantenga\w*|mantener)\b|\b(?:cancel|anul)\w*/.test(p) || NIEGA_QUERERLO.test(p)) return false;
  return /\b(?:manten\w*|mantengo|mantener|que siga|que sigua|dej[ae]lo asi|dejenlo asi|asi dejalo|keep it|keep my order)\b/.test(p);
}
/** Revisión 93 (R93-2): agregar algo contestando la pregunta («agrégale 2 cocas», «y 2 cocas», «sí, y agrégale 2 cocas»). */
function diceAgregarTrasPregunta(texto: string): boolean {
  const p = planoRespuesta(texto);
  if (/\b(?:cancel|anul)\w*/.test(p) || NIEGA_QUERERLO.test(p)) return false;
  const cantidad = /\d|\b(?:un|una|unos|unas|dos|tres|cuatro|cinco|seis|otra|otro|otras|otros)\b/.test(p);
  return cantidad &&
    (/\b(?:agreg\w*|anad\w*|sumale|sumele|ponle|ponme|pongale|tambien|ademas|add)\b/.test(p) || /^(?:(?:si|ok|va|y|e) )*(?:y|e) /.test(p));
}
/** Revisión 92 (R92-2): «no», «mejor no», «nel» contestando la pregunta: la cancelación sigue. Texto plano. */
const RESPUESTA_NO_MANTENER = /^(?:no|nel|nop|nope|mejor\s+no|ya\s+no|no\s+gracias|no\s+thanks)(?:\s+(?:gracias|porfa|thanks))*$/;
/** Revisión 92 (R92-2): ¿el texto, contestando PREGUNTA_MANTENER_O_CANCELAR, dice que lo mantenga? Pura. */
function diceMantener(texto: string): boolean {
  return RESPUESTA_MANTENER.test(normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim());
}
/** Revisión 92 (R92-2): ¿el texto, contestando PREGUNTA_MANTENER_O_CANCELAR, dice que no lo mantenga? Pura. */
function diceNoMantener(texto: string): boolean {
  return RESPUESTA_NO_MANTENER.test(normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim());
}
/**
 * Revisión 70 (R70-3): en la MISMA ráfaga, después de «cancelen mi pedido», un mensaje que retira la cancelación («mejor
 * no, ya llega», «no lo cancelen», «siempre no», «olvídalo»). Un «no» / «no, gracias» suelto no cuenta. Pura.
 */
export function retiraCancelacionEnRafaga(texto: string): boolean {
  if (esRetractacionEnContexto(texto, true)) return true;
  const p = normAviso(texto).replace(/^[^a-z0-9ñ]+/, "");
  return NO_CANCELA_INICIAL.test(p) || /^no[\s,.;:!]+(?:mejor\s+no\b|ya\s+(?:llega|llego|viene|casi)\b|(?:mejor\s+)?(?:lo\s+)?espero\b)/.test(p) ||
    SI_LO_QUIERE_EN_RAFAGA.test(p);
}
/**
 * Revisión 71 (R71-5e): «cancelen mi pedido, mejor no, ya llega» / «cancelen, no, mejor lo espero»: lo que sigue a la primera
 * cláusula retira la cancelación (retiraCancelacionEnRafaga) Y dice que el pedido sigue («ya llega», «lo espero», «mejor
 * sí…», «no lo cancelen»), sin otro cancelar ni «ya no lo quiero». «cancelen, mejor no lo quiero» sigue cancelando. Pura.
 */
export function retiraCancelacionEnElMismoMensaje(texto: string): boolean {
  const p = normAviso(texto);
  const corte = p.search(/[,.;!\n]/);
  if (corte < 0) return false;
  const resto = p.slice(corte).replace(/^[^a-z0-9ñ]+/, "").trim();
  if (resto === "" || /\b(?:cancel|anul)\w*/.test(resto.replace(/\bno\s+(?:(?:lo|la|me\s+lo|me\s+la|se)\s+)?cancel\w*/g, " "))) return false;
  if (/\bno\s+(?:lo|la)\s+(?:quiero|queremos)\b|\bya\s+no\b/.test(resto)) return false;
  return retiraCancelacionEnRafaga(resto) &&
    /\bya\s+(?:llega|llego|viene|casi)\b|\b(?:lo\s+)?espero\b|\b(?:mejor|siempre)\s+si\b|\bno\s+(?:(?:lo|la|me\s+lo|me\s+la|se)\s+)?cancel\w*/.test(resto);
}
/**
 * Revisión 71 (R71-4): «no espera, mejor sí llegue», «mejor sí lo quiero», «sí mándenlo», «siempre sí» tras «cancelen mi
 * pedido» en la misma ráfaga: el cliente se retracta (quiere el pedido). Texto plano sin signos al inicio.
 */
const SI_LO_QUIERE_EN_RAFAGA = new RegExp(
  String.raw`^(?:(?:no|oiga|oye|oigan|perdon|disculpe|ok|ah|sabe\s+que|esper\w*|(?:un\s+)?momento|aguant\w*)[\s,.;:!]+)*` +
    String.raw`(?:(?:mejor|siempre)\s+si\b[\s,]*(?:que\s+)?(?:llegue|lleguen|venga|lo\s+(?:mand|envi|trai|quier|esper|recoj)\w*|(?:mand|envi|trai)\w*(?:lo|la|los|las)\b|me\s+lo\s+(?:mand|envi|trai)\w*)` +
    String.raw`|si\s+(?:mand|envi|trai)\w*(?:lo|la|los|las)\b|siempre\s+si\b[\s.!]*$)`,
);
const CANCELACION_NEGADA = new RegExp(
  [
    ...RETRACTACION_CANCEL,
    String.raw`\b(?:no|nunca|jamas)\s+(?:quiero|queremos|quisiera|deseo|pido|pedi|pedimos|pretendo|he\s+dicho|dije|dijimos|digo|es\s+necesario|hace\s+falta|vayan?\s+a|vaya\s+a|se\s+vaya\s+a|tienen\s+que|tiene\s+que|deben?|debe)\s+(?:que\s+)?${CLITICOS_CANCEL}cancel\w*`,
    String.raw`\b(?:no|nunca|jamas)\s+${CLITICOS_CANCEL}(?:cancel|anul)\w*`,
    String.raw`\bsin\s+(?:cancel|anul)\w*`,
    // Revisión 34: con el pronombre antes del verbo («no lo quiero cancelar», «no la queremos anular»).
    String.raw`\b(?:no|nunca|jamas)\s+(?:(?:lo|la|los|las|me\s+lo|me\s+la)\s+)(?:quiero|queremos|quisiera|deseo)\s+(?:que\s+)?${CLITICOS_CANCEL}(?:cancel|anul)\w*`,
    // Revisión 33: en inglés («don't cancel my order», «do not cancel»).
    String.raw`\b(?:don['’]?t|do\s+not|never)\s+cancel\w*`,
    // Revisión 69 (R69-3): la negación después del verbo («cancelar no», «no, cancelar no», «cancelar no, gracias»), al
    // final o seguida solo de cortesía o «todavía / por ahora». «cancélenlo, no lo quiero» no es esto.
    // Revisión 70 (R70-4): solo en la misma cláusula: «cancelen. No, gracias» (punto, «!», «?» o salto de línea entre el verbo
    // y el «no») es cancelar y luego otra cosa.
    String.raw`\b(?:cancel|anul)\w*[ \t,;:]+no\b(?=[\s,.;:!]*(?:$|gracias\b|por\s+favor\b|porfa\b|todavia\b|aun\b|por\s+ahora\b|ahorita\b))`,
  ].join("|"),
  "g",
);
const CANCELACION_CONDICIONAL_SIN_CREAR = new RegExp(
  String.raw`\bsi\s+(?:ya\s+)?no\s+se\s+(?:puede|pueden)\b(?:\s+(?:ajustar|cambiar|modificar|corregir|arreglar|agregar|quitar|poner|hacer|dejar|armar|preparar)\w*)?[^.!?\n]{0,40}?\bcancel\w*`,
  "g",
);
// Revisión 26: lo que va después de «cancelo/cancela/cancelen…» y lo vuelve quitar un PRODUCTO (una modificación), no
// cancelar el pedido: determinante, posesivo o cantidad seguido de algo que no es el pedido («mi coca», «2 tacos», «los
// tacos», «el de pastor»), «lo de <algo que no es el pedido>» o un producto sin artículo («cancelo coca»).
const DETERMINANTE_CANCEL =
  String.raw`(?:el|la|los|las|un|una|unos|unas|mi|mis|su|sus|tu|tus|este|esta|estos|estas|ese|esa|esos|esas|todos|todas|\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)`;
const PEDIDO_CANCEL = String.raw`(?:pedido|orden|compra|servicio)\b`;
const PRODUCTO_CANCEL = COMIDA_RECLAMO.split("|").filter((p) => !p.startsWith("orden")).join("|");
// Revisión 28 (revierte R27-7): «quiero cancelar mi pedido de tacos», «cancelen el pedido de la coca» son cancelar el
// pedido COMPLETO: «pedido/orden de <producto>» es como el cliente nombra su pedido. Quitar un producto exige nombrarlo
// SIN la palabra pedido/orden («cancelo mi coca», «cancela 2 tacos»); lo dudoso va a la sucursal, que confirma.
// Revisión 29: también «lo del <producto>» («cancelo lo del pollo»), no solo «lo de».
/**
 * Revisión 58 (R58-6): «el pedido de la coca nada más / nomás / solo / solamente» nombra UN producto (quitarlo), no el
 * pedido completo: se reescribe «la coca nada más» antes de buscar la cancelación o el producto quitado. Texto plano.
 */
const PEDIDO_DE_PRODUCTO_SOLO = new RegExp(
  String.raw`\b(?:el|mi|su)\s+(?:pedido|orden)\s+del?\s+((?:(?:${DETERMINANTE_CANCEL})\s+)*(?:${PRODUCTO_CANCEL})\b)(?=\s+(?:nada\s+mas|nomas|solo|solamente)\b)`,
  "g",
);
const sinPedidoDeProductoSolo = (plano: string) => plano.replace(PEDIDO_DE_PRODUCTO_SOLO, "$1");
/**
 * Revisión 64 (R64-1): «cancelen el segundo / el otro / el último / el primer pedido», «cancelen la segunda orden», «cancelen
 * los dos pedidos» nombran un PEDIDO completo (ordinal, «otro», «último» o plural), no un producto: cancelan y el aviso
 * lleva el texto literal para que la sucursal sepa cuál. «cancelen la otra coca» / «2 órdenes de tacos» siguen siendo
 * quitar un producto.
 */
const ORDINAL_PEDIDO_CANCEL =
  String.raw`(?:primer|primero|primera|segundo|segunda|tercer|tercero|tercera|otro|otra|otros|otras|ultimo|ultima|ultimos|ultimas)`;
const PEDIDO_CON_ORDINAL = String.raw`(?:(?:${DETERMINANTE_CANCEL}|${ORDINAL_PEDIDO_CANCEL})\s+)*(?:${PEDIDO_CANCEL}|(?:pedidos|compras)\b|ordenes\b(?!\s+del?\b))`;
/**
 * Revisión 65 (R65-2): «cancelen los dos», «cancelen ambos / todos / todo», «las dos órdenes» (con dos pedidos vivos) nombran
 * los PEDIDOS, nunca un producto, salvo que sigan con un producto («los dos tacos», «todos los tacos», «las dos órdenes de
 * tacos»). Texto plano.
 */
const TODOS_LOS_PEDIDOS = String.raw`(?:(?:los|las)\s+)?(?:dos|ambos|ambas|todo|todos|todas)\b(?!\s+(?:(?:${DETERMINANTE_CANCEL})\s+)*(?:ordenes?\s+del?\s+)?(?:(?:${DETERMINANTE_CANCEL})\s+)*(?:${PRODUCTO_CANCEL})\b)`;
/**
 * Revisión 70 (R70-5): «pedido» mal escrito («pedidoo», «pedio», «pdido», «peddido», «pedidp») o en diminutivo
 * («pedidito») tras el determinante sigue siendo el pedido, no un producto. Texto plano.
 */
const PEDIDO_CON_TYPO = String.raw`(?:pe?d+i?d?[oi][a-z]*|pedid[a-z]+)\b`;
/**
 * Revisión 71 (R71-5b): «cancelen el anterior», «cancelen el de antes», «lo de antes» nombran el PEDIDO anterior, no un
 * producto (salvo que sigan con uno: «la anterior coca»). Texto plano.
 */
const PEDIDO_ANTERIOR = String.raw`(?:(?:el|la)\s+(?:anterior|de\s+antes|de\s+hace\s+rato)|lo\s+de\s+antes)\b(?!\s+(?:(?:${DETERMINANTE_CANCEL})\s+)*(?:${PRODUCTO_CANCEL})\b)`;
const OBJETO_NO_PEDIDO = String.raw`\s+(?!${TODOS_LOS_PEDIDOS}|${PEDIDO_ANTERIOR})(?:${DETERMINANTE_CANCEL}\s+)+(?!${PEDIDO_CON_ORDINAL}|${PEDIDO_CON_TYPO})|\s+lo\s+del?\s+(?!(?:(?:mi|el|la|su)\s+)?(?:${PEDIDO_CANCEL}|${PEDIDO_CON_TYPO})|antes\b)|\s+(?:${PRODUCTO_CANCEL})\b`;
// Revisión 33: cancelaciones de primer mensaje que no se veían: «anulen mi pedido», «anule mi orden», «anúlenlo» (mismas
// reglas que «cancel…»: «anulen la coca» es quitar un producto), «ya no lo mande»,
// «ya no me lo manden», «ya no me manden nada» y en inglés «cancel my order», «cancel it».
// Revisión 34: «ya no quiero nada» ya NO es cancelación: contestando «¿algo más?» o con «gracias» («ya no quiero nada,
// muchas gracias») es «nada más» y cancelaba un pedido vivo. Lo ve el modelo (puede llamar a registrar_contacto).
// Revisión 34: tampoco «no lo mande(s)» / «no me lo manden» sin «ya»: «no lo mande, es para las 2», «no lo mande ahora»,
// «no lo mandes todavía» son cambiar la hora, no cancelar.
// Revisión 39: tampoco «ya no (me) lo mande(n/s) / envíe / traiga»: «ya no lo mande, es para mañana / el domingo / mejor en
// la tarde / lo recojo yo» cambian la entrega. Se QUITA el disparador (no se enumeran excepciones): suelto con un pedido
// vivo el modelo pregunta «¿Quiere cancelar su pedido?» (esYaNoLoMandeSuelto); cancelan «ya no me manden nada», «ya no me
// manden el pedido» o el mensaje con su propio «cancélenlo».
const YA_NO_MANDE_PEDIDO = String.raw`\bya\s+no\s+(?:me\s+)?(?:mande|manden|mandes|envie|envien|envies|traiga|traigan)\s+(?:nada|(?:mi|el|su)\s+(?:pedido|orden|comida))\b`;
/**
 * Revisión 56 (R56-5): en el MISMO mensaje, «mejor» + un producto, recoger, a domicilio u otra hora («ya no mande el
 * pedido, mejor 2 tacos para recoger», «…, mejor lo paso a recoger», «…, mejor a otra hora»): el cliente cambia su pedido,
 * no lo cancela. Texto plano.
 */
const MEJOR_CAMBIA_PEDIDO = new RegExp(
  String.raw`\bmejor\b(?:\s+[a-z0-9]+){0,3}?\s+(?:(?:${DETERMINANTE_CANCEL}\s+)?(?:${PRODUCTO_CANCEL})\b|(?:para\s+|a\s+)?recog\w*|recoj\w*|(?:para\s+)?(?:a\s+)?domicilio\b|(?:a|para|en)\s+otra\s+hora\b|otra\s+hora\b|mas\s+tarde\b|(?:para|a)\s+las?\s+(?:\d|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b)`,
);
/**
 * Revisión 64: cancelaciones comunes que no se veían. Texto plano.
 * - R64-2: «me cancelan el pedido», «cancelan mi pedido», «¿me cancelan mi orden?», «me lo cancelan» (no tras «no / que / porque» ni
 *   con un «si / cuando» antes en la frase: «¿por qué me cancelan el pedido?», «si no pago me cancelan el pedido?» no piden cancelar).
 * - R64-3: «no quiero el pedido / mi pedido / la orden» sin «ya», solo si el mensaje termina ahí (o con «gracias / por
 *   favor»): «no quiero el pedido todavía / ahorita / a esa hora / para las 2» siguen sin cancelar.
 * - R64-4: «ya no quiero lo que pedí», «(ya) no quiero nada de lo que pedí», salvo con un cambio en el mismo mensaje
 *   («…, mejor 2 gringas», «…, quiero otra cosa»).
 */
/**
 * Revisión 65 (R65-4): un pedido nombrado con determinante + ordinal / «otro» / «dos» («el segundo pedido», «el otro
 * pedido», «los dos pedidos») o con «ambos»: con dos pedidos vivos es cancelar uno (o los dos). Sin determinante («no
 * quiero otro pedido», contestando «¿algo más?») NO. Texto plano.
 */
const PEDIDO_NOMBRADO_R65 =
  String.raw`(?:(?:mi|mis|el|la|los|las|ese|este|esa|esta|esos|estos)\s+(?:${ORDINAL_PEDIDO_CANCEL}|dos)\s+|(?:los|las|mis)\s+|(?:ambos|ambas)\s+)(?:pedidos?|ordenes|orden)\b`;
/**
 * Revisión 65 (R65-1): las formas en «-an» y «van a cancelar» («me cancelan el pedido», «me lo cancelan», «¿me van a
 * cancelar el pedido?») piden cancelar solo como afirmación: en una frase con «?» / «¿» o con un «si / cuando» (antes o
 * después) son una pregunta o una condición y se quitan; lo ve el modelo (puede preguntar si desea cancelar). Texto plano.
 */
const FORMA_CANCELAN = /\b(?:(?:me|nos|se)\s+)?(?:(?:lo|la|los|las)\s+)?(?:cancelan|van\s+a\s+cancelar\w*)\b/g;
/**
 * Revisión 66 (R66-1, generaliza R65-1): CUALQUIER forma de cancelar («cancelan», «cancelen», «cancela», «cancelo»,
 * «pueden cancelar», «anulan»…) en una frase que pregunta («?» / «¿», o «cómo cancelo / cómo le hago para cancelar» sin
 * signos) o que pone una condición («si / cuando») es ambigua: «me lo cancelan por favor?» (petición cortés) y «¿cómo
 * cancelo mi pedido?» (información) se escriben igual. Se quita de la detección de cancelación y, con un pedido vivo, se
 * trata como «ya no lo quiero» suelto: aviso de baja (posible_baja_pedido) y la pregunta fija «¿Quiere cancelar su
 * pedido?» (esCancelacionEnPregunta). Con «si / cuando» sin signos solo las formas en «-an» / «van a cancelar» (como
 * R65): «si no llega a tiempo cancelen mi pedido» sigue cancelando. Un «sí,» / «si,» al INICIO del mensaje es afirmación,
 * no condición («si, me lo cancelan porfa» cancela). Texto plano.
 */
const VERBO_CANCELAR_EN_PREGUNTA =
  /\b(?:cancel|anul)\w*|\bno\s+(?:quiero|queremos|necesito|requiero)\b(?=\s+(?:(?:nada\s+de\s+)?lo\s+que\b|(?:mi|mis|el|la|los|las|ese|este|esa|esta|esos|estos|ambos|ambas)\s+(?:\w+\s+)?(?:pedidos?|ordenes|orden)\b))/g;
const AFIRMACION_INICIAL = /^[\s¡!]*(?:si\s*[,.;:!]+\s*)+/;
const COMO_CANCELAR =
  /\bcomo\s+(?:(?:le\s+)?(?:hago|hacemos|puedo|podemos|debo|se\s+puede)\s+(?:para\s+)?)?(?:(?:me|nos|se|lo|la|le)\s+)*(?:cancel|anul)/;
/** Un trozo entre comas que es solo cortesía o vocativo («porfa», «por favor», «oigan»): no cierra la pregunta. */
/** Palabras de cortesia/relleno de un trozo (R66): sin expresion regular con cuantificadores anidados (CodeQL js/redos). */
const PALABRAS_CORTESIA = new Set(["porfa", "porfavor", "plis", "pls", "gracias", "oigan", "oiga", "oye", "amigo", "amiga", "joven", "senorita", "senor", "ok", "ya", "y", "pues"]);
/** ¿El trozo es solo cortesia («porfa», «gracias», «por favor», «ok?») seguida de signos de pregunta? Misma salida que la expresion del suelto. Pura. */
function esTrozoCortesia(trozo: string): boolean {
  let t = trozo;
  let fin = t.length;
  while (fin > 0 && /[¿?\s]/.test(t[fin - 1] ?? "")) fin--;
  t = t.slice(0, fin);
  const palabras = t.split(/\s+/).filter((p) => p !== "");
  for (let i = 0; i < palabras.length; i++) {
    const p = palabras[i]!;
    if (p === "por" && palabras[i + 1] === "favor") { i++; continue; }
    if (!PALABRAS_CORTESIA.has(p)) return false;
  }
  return true;
}
/**
 * La parte de una frase que pregunta: desde el «¿» (si lo hay) o, con solo «?», el último trozo entre comas con contenido
 * y la cortesía que lo sigue («cancelen mi pedido, ¿cuánto tardan?» pregunta solo «¿cuánto tardan?»; «oye, me lo cancelan,
 * porfa?» pregunta «me lo cancelan, porfa?»). Con «cómo cancelo» es toda la frase.
 */
function partePregunta(frase: string): [string, string] {
  if (COMO_CANCELAR.test(frase)) return ["", frase];
  if (!/[¿?]/.test(frase)) return [frase, ""];
  const abre = frase.indexOf("¿");
  if (abre >= 0) return [frase.slice(0, abre), frase.slice(abre)];
  const trozos = frase.split(/(?<=,)/);
  let k = trozos.length - 1;
  while (k > 0 && esTrozoCortesia(trozos[k] ?? "")) k--;
  return [trozos.slice(0, k).join(""), trozos.slice(k).join("")];
}
export function sinCancelacionEnPregunta(plano: string): string {
  // La marca de la confirmación («sí» a «¿Quiere cancelar su pedido?» + SUFIJO_CONFIRMA_CANCELACION) no es una condición.
  const sufijo = plano.endsWith(SUFIJO_CONFIRMA_CANCELACION) ? SUFIJO_CONFIRMA_CANCELACION : "";
  const texto = plano.slice(0, plano.length - sufijo.length);
  const afirmacion = texto.match(AFIRMACION_INICIAL)?.[0] ?? "";
  return afirmacion + texto.slice(afirmacion.length).split(/(?<=[.;!?\n])/).map((frase) => {
    // Con «si / cuando» solo las formas en «-an» / «van a cancelar» (R65): «si no llega a tiempo cancelen mi pedido» es
    // una instrucción y cancela (fallos-c2); «si no pago, me cancelan el pedido» pregunta.
    const condicion = /\b(?:si|cuando)\b/.test(frase) ? frase.replace(FORMA_CANCELAN, " ") : frase;
    const [antes, pregunta] = partePregunta(condicion);
    return antes + pregunta.replace(VERBO_CANCELAR_EN_PREGUNTA, " ");
  }).join("") + sufijo;
}
/**
 * Revisión 67 (R67-2): un motivo PURO para no querer el pedido (sin cambio de hora, entrega ni producto): «ya comí», «(ya)
 * se me quitó el hambre», «ya no tengo hambre», «cambié de opinión / de idea / de planes», «ya es (muy) tarde», «lo pedí
 * en otro lado». Texto plano (sin acentos), con o sin «porque / pues» delante.
 */
const MOTIVO_PURO_CANCELAR = String.raw`(?:(?:porque|pues|es\s+que)\s+)?(?:ya\s+(?:comi|comimos|cene|cenamos|desayune|desayunamos|almorce|almorzamos)|(?:ya\s+)?se\s+(?:me|nos)\s+(?:quito|fue)\s+el\s+hambre|ya\s+no\s+(?:tengo|tenemos)\s+hambre|cambie\s+de\s+(?:opinion|idea|planes?)|(?:ya\s+)?es\s+(?:muy\s+)?tarde|(?:ya\s+)?(?:lo|la)\s+(?:pedi|pedimos)\s+en\s+otr[oa]\s+(?:lado|lugar|parte|restaurante))`;
const CANCELACION_R64 = [
  String.raw`(?<!\b(?:no|que|porque)\s(?:me\s)?)(?<!\b(?:si|cuando)\b[^.,;!?\n]*)\b(?:me\s+)?cancelan\s+(?:mi|el|la|su)\s+(?:${ORDINAL_PEDIDO_CANCEL}\s+)?(?:pedido|orden)\b`,
  String.raw`(?<!\b(?:no|que|porque)\s)(?<!\b(?:si|cuando)\b[^.,;!?\n]*)\bme\s+(?:lo|la)\s+cancelan\b`,
  // Revisión 67 (R67-2): también con un MOTIVO puro detrás («no quiero el pedido, ya comí / ya se me quitó el hambre /
  // cambié de opinión / ya es tarde / lo pedí en otro lado»): el motivo no cambia nada, es la misma cancelación.
  String.raw`(?<!\bya\s)\bno\s+(?:quiero|queremos)\s+(?:(?:mi|el|la|ese|este|esa|esta)\s+(?:pedido|orden)\b|${PEDIDO_NOMBRADO_R65})\s*[.!]*(?:\s*,?\s*(?:gracias|por\s+favor|porfa(?:vor)?|${MOTIVO_PURO_CANCELAR})\b[.!]*)*\s*$`,
  String.raw`\b(?:ya\s+no\s+(?:quiero|queremos)\s+(?:nada\s+de\s+)?|no\s+(?:quiero|queremos)\s+nada\s+de\s+)lo\s+que\s+(?:pedi|pedimos|ordene|ordenamos)\b(?!\s+(?:de|del)\b)(?![^.!?\n]*\b(?:mejor|en\s+vez|en\s+lugar|cambi\w*|quiero\s+otr\w*)\b)`,
].join("|");
// Revisión 57 (R57-6): «no quiero el pedido ya». Revisión 65 (R65-3): se quita si el mismo mensaje cambia la entrega o el
// producto (CAMBIA_ENTREGA_O_PRODUCTO): «no quiero el pedido ya, mejor en la tarde / lo recojo yo / mejor 2 gringas».
const NO_QUIERO_PEDIDO_YA = String.raw`\bno\s+(?:quiero|queremos)\s+(?:mi\s+|el\s+|ese\s+|este\s+)?(?:pedido|orden)\s+ya\b(?!\s+(?:mismo|para|a\s+las)|\s*,?\s*(?:ya\s+)?(?:lleg\w*|vien\w*|va\b|sali\w*|est[aá]\b))`;
// Revisión 75 (R75-4) / 76 (R76-6): cancelar en inglés solo «don't send it anymore», «don't send my order», «forget the
// order / my order», y no seguido de «to / there / yet / with / without» («don't send it to the old address», «don't send
// anything with onion», «do not send the food yet» no cancelan).
const CANCELA_EN = String.raw`(?:\b(?:don\W?t|do\s+not|dont)\s+send\s+(?:it\s+any\s?more|(?:my|the)\s+order)|\bforget\s+(?:about\s+)?(?:the|my)\s+order)\b(?!\s+(?:to|there|yet|with|without)\b)`;
/**
 * Revisión 77 (R77-5): lo que se QUEDA del pedido («solo la coca», «déjenme las cocas», «nomás 2 tacos»): con eso, quitar
 * el pedido es quitar una parte. «solo quiero mi dinero de vuelta» no. Texto plano.
 */
const QUEDA_PRODUCTO = String.raw`\b(?:solo|solamente|nomas|nada\s+mas|dejen\w*|dejame|dejeme|dejenme)\s+(?:(?:${DETERMINANTE_CANCEL})\s+)*(?:${PRODUCTO_CANCEL})\b`;
/** Revisión 77 (R77-5): de dónde se quita el pedido completo («del sistema», «de la lista»): no es un producto. */
const LUGAR_DEL_PEDIDO = String.raw`(?:sistema|lista|app|aplicacion|registro|plataforma|pantalla)\b`;
/**
 * Revisión 75/76/77: el objeto de «quiten / borren / eliminen» que es el pedido completo: «(mi|el) pedido» (no «de la coca»,
 * sí «del sistema»), «mi orden» (no «de tacos»), «todo mi / el pedido», «toda la / mi orden», «la orden / el pedido
 * completo(a) / entero(a)». Texto plano.
 */
const PEDIDO_COMPLETO_QUITAR = String.raw`(?:(?:tod[oa]\s+)?(?:la|mi|el|su)\s+(?:pedido|orden)\s+(?:complet[oa]|enter[oa])\b|todo\s+(?:el|mi)\s+pedido\b|toda\s+(?:la|mi)\s+orden\b(?!\s+de\s+(?!(?:la\s+)?${LUGAR_DEL_PEDIDO}))|(?:mi|el)\s+pedido\b(?!\s+(?:del|de\s+(?:la|las|los|el))\s+(?!${LUGAR_DEL_PEDIDO}))|mi\s+orden\b(?!\s+del?\s+(?!(?:la\s+)?${LUGAR_DEL_PEDIDO})))`;
const CANCELACION_R33 = [
  String.raw`(?<!\bno\s)(?<!\bnunca\s)\banul(?:ar|a|e|en|o|amos|ame|enlo|enla|elo|ela|alo|ala|arlo|arla|enme|eme)\b(?!${OBJETO_NO_PEDIDO})`,
  YA_NO_MANDE_PEDIDO,
  String.raw`\bcancel\s+(?:my|the|our|this|that)\s+(?:order|food|delivery|purchase)\b|\bcancel\s+it\b`,
  // Revisión 75 (R75-4): «quítenme el pedido (de tacos)», «quiten mi pedido», «bórrenme el pedido», «elimínenme la orden»:
  // solo con «pedido/orden» (regla de pedido/orden); «quítenme la coca» sigue siendo quitar un producto.
  // Revisión 76 (R76-1): «orden» es un producto en la taquería («quiten la orden de tacos»): solo «(mi|el|todo el) pedido»
  // o «mi orden», y solo si nada del pedido se queda («quite mi pedido de la coca», «…y déjenme solo las cocas» no).
  // Revisión 77 (R77-5): también el pedido COMPLETO («la orden completa», «todo mi pedido», «mi pedido del sistema / de la
  // lista»); y «solo / déjenme» excluye solo seguido de un producto («solo la coca»; «solo quiero mi dinero» cancela). «mi
  // orden de tacos» es un producto (la orden de tacos). Lo dudoso pregunta (esCancelacionDudosa).
  String.raw`(?<!\b(?:no|nunca)\s+(?:(?:me|nos|le|les)\s+)?)(?<!${QUEDA_PRODUCTO}[^\n]*)\b(?:quit|borr|elimin)(?:a|e|en|ame|eme|enme|enlo|enla|alo|ala)\s+${PEDIDO_COMPLETO_QUITAR}(?![^\n]*${QUEDA_PRODUCTO})`,
  // Y en inglés (Revisión 76, R76-6: CANCELA_EN).
  String.raw`${CANCELA_EN}`,
  // Revisión 77 (R77-6): «don't send it, cancel», «cancel please»: el «cancel» suelto al final de una frase (no «don't cancel»).
  String.raw`(?<!\b(?:don\W?t|do\s+not|dont|not|to|no)\s+)\bcancel(?=\s*(?:$|[,.;!?]|\s+(?:please|pls|thanks|thank\s+you)\b))`,
].join("|");
// Revisión 33: «cancelen la coca, ya no la quiero», «quite la coca, ya no la quiero»: con un producto quitado y sin
// nombrar el pedido («pedido/orden/compra/todo»), el «ya no lo/la quiero» habla de ESE producto (una modificación), no
// del pedido completo: se quita antes de buscar la cancelación.
const QUITA_PRODUCTO = new RegExp(String.raw`\b(?:cancel|anul|quit)\w*(?=${OBJETO_NO_PEDIDO})`);
const YA_NO_LO_QUIERO = /\bya\s+no\s+(?:lo|la|los|las)\s+(?:quiero|queremos|necesito|requiero)\b/g;
// Revisión 35: «ya no lo quiero, cámbielo por agua», «ya no la quiero, mejor dame 2 gringas»: con un cambio o reemplazo
// en el mismo mensaje (y sin nombrar el pedido) es una MODIFICACIÓN, no una cancelación: el «ya no lo quiero» se quita.
// «ya no lo quiero, cancélenlo» sigue cancelando (por el «cancel…»); «ya no lo quiero por la tardanza» también.
// Revisión 36: el cambio exige su OBJETO: «cámbielo por agua», «cambiar la coca por agua», «en vez/lugar de», «mejor
// dame/quiero + producto», «por + producto». Un «cambi…» suelto NO: «ya no lo quiero, cambié de opinión / de idea», «me
// cambió el plan», «cambiaron los planes, mejor no» son cancelaciones.
const CAMBIO_DE_PRODUCTO = new RegExp(
  String.raw`\ben\s+(?:vez|lugar)\s+de\b|\bmejor\s+(?:(?:dame|deme|denme|me\s+(?:da|das|de|den)|mandame|mandeme|mandenme|traigame|traiganme|quiero|queremos|ponme|pongame|ponganme)\s+)?(?:${DETERMINANTE_CANCEL}\s+)?(?:${PRODUCTO_CANCEL})\b|\bpor\s+(?:${DETERMINANTE_CANCEL}\s+)?(?:${PRODUCTO_CANCEL})\b`,
);
/** Revisión 65 (R65-3): cambio de entrega u horario, o de producto, en el mismo mensaje. Texto plano. */
const CAMBIA_ENTREGA_O_PRODUCTO = new RegExp(
  String.raw`\b(?:mejor|recog\w*|recoj\w*|(?:en|para|por)\s+la\s+(?:tarde|noche|manana)|(?:a|para)\s+las?\s+\d|(?:a|para)\s+las\b|otra\s+hora|mas\s+tarde|domicilio)\b|${CAMBIO_DE_PRODUCTO.source}`,
);
const PEDIDO_NOMBRADO_CAMBIO = /\b(?:pedido|compra|todo|toda|completo|completa)\b|\b(?:la|mi|su|esta|esa)\s+orden\b/;
/**
 * Revisión 36: «ya no lo quiero, cámbielo por agua», «ya no quiero la coca, mejor dame una gringa»: el cliente cambia un
 * producto (no cancela). No se avisa nada desde el servidor (no se agregan patrones de aviso): el modelo recibe una nota
 * para registrar modificacion_pedido si hay un pedido ya creado. Pura.
 */
export function esCambioDeProductoYaNoQuiero(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ");
  return /\bya\s+no\s+(?:(?:lo|la|los|las)\s+)?(?:quiero|queremos)\b/.test(plano) && CAMBIO_DE_PRODUCTO.test(plano) &&
    !PEDIDO_NOMBRADO_CAMBIO.test(plano);
}
/**
 * Revisión 56 (R56-5): «ya no (me) lo mande / ya no mande el pedido» + «mejor» con un producto, recoger, a domicilio u otra
 * hora en el mismo mensaje, sin su propio «cancel…/anul…»: es modificar el pedido, no cancelarlo. Pura.
 */
export function esYaNoLoMandeConCambio(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:cancel|anul)\w*/.test(plano)) return esCancelarParaRecoger(plano);
  const yaNoMande = new RegExp(String.raw`${YA_NO_MANDE_PEDIDO}|\b${YA_NO_LO_MANDE}\b`).test(plano);
  if (yaNoMande && MEJOR_CAMBIA_PEDIDO.test(plano)) return true;
  // Revisión 75 (R75-3): «ya no me lo manden, lo recojo yo», «no lo manden, mejor paso por él», «ya no lo traigan, voy yo»:
  // cambiar la entrega a recoger (también sin «ya» ni «mejor»), no una posible cancelación. Con una queja de demora sigue
  // preguntando si cancela (R41).
  if (esCancelarParaRecoger(plano)) return true;
  return new RegExp(String.raw`\b(?:ya\s+)?no\s+(?:me\s+)?(?:lo|la|los|las)\s+(?:mande|manden|mandes|envie|envien|envies|traiga|traigan|traigas)\b`).test(plano) &&
    YO_LO_RECOJO.test(plano) && !esQuejaDeDemora(plano);
}
/**
 * Revisión 75 (R75-7): «cancelen mi pedido de tacos y mejor recojo», «cancelen el pedido, mejor lo paso a recoger», «…, lo
 * recojo yo»: el cliente no deja el pedido, cambia la entrega a recoger. Sin «no» entre «mejor» y recoger («mejor no lo
 * recojo» sí cancela). Pura.
 */
function esCancelarParaRecoger(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  // Revisión 76 (R76-2): solo si recoge ESE pedido. Con queja de demora (R41), otro día o por otra cosa / en otro lugar
  // («ya tardaron, mejor voy yo», «mejor paso por unas tortas al oxxo», «mejor recojo otro día») sigue cancelando.
  if (!/\b(?:cancel|anul)\w*/.test(plano) && !CANCELA_EN_RE.test(plano)) return false;
  if (esQuejaDeDemora(plano) || OTRO_LUGAR_U_OTRA_COSA.test(plano)) return false;
  // Revisión 77 (R77-8): otro día u otra hora solo cancela si no nombra ESE pedido: «mejor lo recojo mañana», «mejor paso
  // por el pedido luego» cambian la entrega y la hora; «mejor recojo otro día» sigue cancelando.
  if (OTRO_DIA_RECOGER.test(plano) && !RECOJO_POR_PRONOMBRE.test(plano)) return false;
  return RECOJO_ESE_PEDIDO.test(plano);
}
// Revisión 76 (R76-6): «forget my order, I'll pick it up» cambia la entrega como en español.
const CANCELA_EN_RE = new RegExp(CANCELA_EN);
/** Revisión 76 (R76-2): ir por otra cosa / a otro lugar (texto plano). */
const OTRO_LUGAR_U_OTRA_COSA =
  /\b(?:otro\s+lado|otra\s+parte|otro\s+lugar|otro\s+restaurante|oxxo)\b|\b(?:paso|pasamos|voy|vamos|recojo)\s+(?:yo\s+)?(?:por|a|al|x)\s+(?:un|una|unos|unas|otr[oa]s?|algo)\b/;
/** Revisión 78 (R78-3): lo que se cancela es solo el envío («cancelen el envío / el domicilio, …»). Texto plano. */
const CANCELA_SOLO_LA_ENTREGA =
  /\b(?:cancel|anul)\w*\s+(?:(?:el|la|mi|su|lo\s+del?)\s+)?(?:envio|domicilio|entrega|reparto|delivery|servicio\s+a\s+domicilio)\b/;
/** Revisión 76 (R76-2): recoger otro día o más tarde (texto plano). */
const OTRO_DIA_RECOGER = /\b(?:otro\s+dia|manana|luego|despues|tomorrow|later|another\s+day)\b/;
/**
 * Revisión 77 (R77-8): el cliente nombra ESE pedido al recogerlo, con pronombre o «el / mi pedido»: «lo recojo», «la paso a
 * recoger», «paso por él», «voy yo por el pedido», «I'll pick it up». Texto plano.
 */
const RECOJO_POR_PRONOMBRE = new RegExp([
  String.raw`(?<!\b(?:no|nunca)\s)\b(?:lo|la)\s+(?:recojo|recogemos|(?:paso|pasamos|voy|vamos)\s+a\s+recoger)\b`,
  String.raw`(?<!\b(?:no|nunca)\s)\b(?:paso|pasamos|voy|vamos)\s+(?:yo\s+)?(?:por|x)\s+(?:el|ella|mi\s+pedido|el\s+pedido|mi\s+orden)\b`,
  String.raw`\bpick\s+(?:it|my\s+order|the\s+order)\s+up\b|\bpick\s+up\s+(?:it|my\s+order|the\s+order)\b`,
].join("|"));
/** Revisión 76 (R76-2): el cliente recoge el MISMO pedido: «lo recojo (yo)», «paso por él / mi pedido», «mejor recojo» suelto. */
// Sin «no / nunca» antes («mejor no lo recojo» sí cancela).
const RECOJO_ESE_PEDIDO = new RegExp([
  String.raw`(?<!\b(?:no|nunca)\s)\b(?:lo|la)\s+(?:recojo|recogemos)\b|\byo\s+(?:lo|la)\s+recojo\b`,
  String.raw`(?<!\b(?:no|nunca)\s)\b(?:lo|la)\s+(?:paso|pasamos|voy|vamos)\s+a\s+recoger\b`,
  String.raw`(?<!\b(?:no|nunca)\s)\b(?:paso|pasamos|voy|vamos)\s+(?:yo\s+)?(?:por|x)\s+(?:el|ella|mi\s+pedido|el\s+pedido|mi\s+orden)\b`,
  String.raw`\bmejor\s+(?:yo\s+)?(?:recojo|recogemos|paso\s+a\s+recoger(?:lo|la)?|voy\s+yo|voy\s+a\s+recoger(?:lo|la)?)(?:\s+yo)?(?=\s*$|\s+(?:por\s+favor|porfa|gracias|entonces|y)\b)`,
  // Inglés (R76-6): «I'll pick it up (myself)», «I will come get it».
  String.raw`\bi\s*(?:ll|will)\s+(?:pick\s+(?:it|my\s+order|the\s+order)\s+up|pick\s+up\s+(?:it|my\s+order|the\s+order)|come\s+(?:get|for|pick\s+up)\s+(?:it|my\s+order|the\s+order))\b(?!\s+(?:tomorrow|later)\b)`,
].join("|"));
/** Revisión 75 (R75-3): el cliente pasa él por su pedido («lo recojo yo», «paso por él», «voy yo», «lo paso a recoger»). Texto plano. */
const YO_LO_RECOJO =
  /\b(?:lo|la|los|las)\s+(?:recojo|recogemos|recoge|recojemos)\b|\b(?:lo|la|los|las)\s+(?:paso|pasamos|voy|vamos)\s+a\s+(?:recoger|buscar|traer)\b|\b(?:paso|pasamos|voy|vamos)\s+(?:yo\s+)?(?:por|x)\s+(?:el|ella|ellos|mi\s+pedido|el\s+pedido|mi\s+orden)\b|\b(?:voy|paso|vamos|pasamos)\s+yo\b|\byo\s+(?:voy|paso|lo\s+recojo|la\s+recojo)\b|\bpaso\s+a\s+recoger(?:lo|la)?\b/;
/** Revisión 56 (R56-5): lo que el modelo sabe de «ya no mande el pedido, mejor …» con pedido vivo. */
function bloqueModificacionYaNoLoMande(textos: string[]): string {
  const dijo = citaDelCliente(textos.join(" / "), 300);
  return `CAMBIO EN UN PEDIDO YA CREADO: el cliente tiene un pedido en curso y escribió «${dijo}»: NO cancela su pedido, quiere cambiarlo (lo que dice después de «mejor»: otro producto, recogerlo, a domicilio u otra hora). No lo dé por cancelado ni le pregunte si cancela. Registre el cambio como modificación: llame a registrar_contacto con reason «${RAZON_MODIFICACION_PEDIDO}» y en message el cambio con sus palabras. No cree un pedido aparte, salvo que el cliente pida expresamente un pedido aparte. Dígale que ya le pasó el cambio a la sucursal y que ahí se lo confirman.`;
}
/** Revisión 36: lo que el modelo sabe de un cambio de producto con pedido vivo (esCambioDeProductoYaNoQuiero). */
function bloqueCambioDeProducto(textos: string[]): string {
  const dijo = citaDelCliente(textos.join(" / "), 300);
  return `CAMBIO DE PRODUCTO EN UN PEDIDO YA CREADO: el cliente tiene un pedido en curso y escribió «${dijo}»: pide cambiar un producto de ese pedido, NO cancela todo el pedido. No lo dé por cancelado. Registre el cambio como modificación: llame a registrar_contacto con reason «${RAZON_MODIFICACION_PEDIDO}» y en message el cambio con sus palabras. No cree un pedido aparte con el producto nuevo, salvo que el cliente pida expresamente un pedido aparte. Dígale que ya le pasó el cambio a la sucursal y que ahí le confirman el cambio y el nuevo total.`;
}
function sinYaNoLoQuieroDeProducto(plano: string): string {
  if (CAMBIO_DE_PRODUCTO.test(plano) && !PEDIDO_NOMBRADO_CAMBIO.test(plano)) return plano.replace(YA_NO_LO_QUIERO, " ");
  if (!QUITA_PRODUCTO.test(plano) || /\b(?:pedido|orden|compra|todo|toda|completo|completa)\b/.test(plano)) return plano;
  return plano.replace(YA_NO_LO_QUIERO, " ");
}
/** Revisión 34: el aviso de quitar un producto que registra el servidor (encabezado + palabras del cliente). Pura. */
export function avisoQuitarProducto(textos: string[]): string {
  const dijo = citaDelCliente(textos.join(" / "), TOPE_MENSAJE_AVISO);
  return hastaPuntosDeCodigo(`Modificación: quitar un producto del pedido (el cliente NO cancela todo el pedido). El cliente dijo: «${dijo}»`, TOPE_MENSAJE_AVISO);
}
/** Texto sin acentos y en minúsculas, con el índice en el original de cada carácter (y uno más al final). Pura. */
function planoConMapa(original: string, padres = false): { plano: string; mapa: number[] } {
  let plano = "";
  const mapa: number[] = [];
  let i = 0;
  for (const ch of original) {
    let p = ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    // Revisión 54: como planoAlergia, «papá(s)» => «papi(s)» (mismo largo: el mapa no cambia).
    if (padres && p === "a" && ch.normalize("NFD") !== ch.normalize("NFD").replace(/\u0301/g, "") && /(?:^|[^a-z0-9])pap$/.test(plano)) p = "i";
    for (let k = 0; k < p.length; k++) mapa.push(i);
    plano += p;
    i += ch.length;
  }
  mapa.push(original.length);
  return { plano, mapa };
}
/**
 * Revisión 70 (R70-6): errores comunes al escribir cancelar/anular (k por c, s por c, letras cambiadas, una de más o de
 * menos): «kancelen», «canselen», «cansen», «cnacelen», «canclen», «cancelenm», «kiero kancelar», «annulen». Se corrigen
 * antes de buscar los avisos; las negaciones («no lo kancelen») siguen valiendo porque se miran sobre el texto corregido.
 * Texto plano (minúsculas, sin acentos).
 */
export function corregirTyposCancelar(plano: string): string {
  return plano
    .replace(/\bk(?=an[cs]el)/g, "c")
    .replace(/\bcansel/g, "cancel")
    .replace(/\bcnacel/g, "cancel")
    .replace(/\bcancl(?=[aeo])/g, "cancel")
    // Revisión 71 (R71-5c): «cansen» solo con el pedido u orden después («cansen mi pedido»); «los cansen de esperar» no.
    .replace(/\bcansen\b(?=\s+(?:(?:mi|el|la|su|mis|sus|los|las|ese|este|esa|esta)\s+)?(?:pedido|orden|pedidos|ordenes|compra)\b)/g, "cancelen")
    // Revisión 71 (R71-5a): «cancel mi pedido / el pedido / mi orden» (el verbo cortado) es cancelar el pedido.
    .replace(/\bcancel(?=\s+(?:mi|el|la|su|mis|sus)\s+(?:pedido|orden|pedidos|ordenes)\b)/g, "cancelen")
    .replace(/\bcancel(en|e|a|ar)m\b/g, "cancel$1")
    .replace(/\bh?annul/g, "anul")
    .replace(/\bhanul/g, "anul")
    .replace(/\bkier(o|en|e)\b/g, "quier$1");
}
/** El patrón de cancelar el pedido (texto plano, ya neutralizado). */
/**
 * Revisión 92 (R92-4): «cancela el de mi hermana», «cancelen el pedido de mi mamá», «ya no quiero el de mi mamá»: cancelar el
 * pedido de una persona (con dos pedidos, el aviso lleva sus palabras y la sucursal sabe cuál). Texto plano.
 */
const CANCELA_EL_DE_PERSONA = String.raw`\b(?:cancel\w*|anul\w*|ya\s+no\s+(?:quiero|queremos|necesito|voy\s+a\s+querer))\s+(?:el|la)\s+(?:(?:pedido|orden)\s+)?(?:de|para)\s+(?:mi|mis|su|sus|la|el)\s+(?:${DESTINATARIOS_PEDIDO})\b`;
/** Revisión 93 (R93-3): el patrón de cancelar sin «cancela el de mi <persona>» (el de antes de R92-4). */
const PATRON_CANCELACION_SIN_PERSONA = new RegExp(
  String.raw`(?<!\bno\s)(?<!\bnunca\s)\bcancel(?:ar|a|e|en|o|amos|amoslo|amosla|ame|amelo|ela|elo|arlo|arla|enlo|enla|alo|ala|alos|alas|elos|elas|enlos|enlas|eme|enme|enmelo|enmela|enmelos|enmelas|emelo|emela|amela)\b(?!${OBJETO_NO_PEDIDO})|${CANCELACION_R33}|\bya\s+no\s+(?:lo|la)\s+(?:quiero|voy\s+a\s+(?:querer|requerir|necesitar))\b|\bya\s+no\s+(?:quiero|necesito|requiero)\s+(?:(?:mi\s+|el\s+|la\s+|ese\s+|este\s+)?(?:pedido|orden|comida)\b|${PEDIDO_NOMBRADO_R65})|${NO_QUIERO_PEDIDO_YA}|${CANCELACION_R64}`,
);
const PATRON_CANCELACION_PEDIDO = new RegExp(
  String.raw`${PATRON_CANCELACION_SIN_PERSONA.source}|${CANCELA_EL_DE_PERSONA}`,
);
/**
 * Lo que anula una coincidencia de cancelar antes de probar PATRON_CANCELACION_PEDIDO. Revisión 66 (R66-1): con
 * `quitarPreguntas` (lo normal) se quitan las formas de cancelar en una frase de pregunta o condición
 * (sinCancelacionEnPregunta); sin él se ve si el texto las traía (esCancelacionEnPregunta).
 */
function neutralizarCancelacion(t: string, o: OpcionesCancelacion, quitarPreguntas = true): string {
  // Revisión 37: «ya no lo/la quiero» ya NO cancela por sí solo: «ya no lo quiero, cambie la hora para las 3», «…, mejor
  // pago en efectivo», «…, lo quiero para llevar», «no gracias, ya no la quiero» (a una oferta) cancelaban un pedido
  // vivo. Solo cuenta SUELTO (esYaNoLoQuieroSuelto: el turno decide si pregunta, es la confirmación o un «no» a una
  // oferta); con más contenido se quita y cancela solo si el mensaje trae su propio «cancélenlo / cancelen el pedido».
  // Revisión 56 (R56-5): «ya no mande el pedido, mejor 2 tacos para recoger» es cambiar el pedido (sin su propio
  // «cancélenlo» no cancela; el modelo recibe la nota de registrar la modificación).
  t = sinPedidoDeProductoSolo(t);
  if (quitarPreguntas) t = sinCancelacionEnPregunta(t);
  if (CAMBIA_ENTREGA_O_PRODUCTO.test(t)) t = t.replace(new RegExp(NO_QUIERO_PEDIDO_YA, "g"), " ");
  // Revisión 75 (R75-7): «cancelen mi pedido y mejor recojo» cambia la entrega: el «cancel…» no cuenta.
  if (esCancelarParaRecoger(t)) t = t.replace(/\b(?:cancel|anul)\w*/g, " ").replace(new RegExp(CANCELA_EN, "g"), " ");
  const sinNegadas0 = esYaNoLoMandeConCambio(t) ? t.replace(CANCELACION_NEGADA, " ").replace(new RegExp(YA_NO_MANDE_PEDIDO, "g"), " ") : t.replace(CANCELACION_NEGADA, " ");
  const sinNegadas = sinYaNoLoQuieroDeProducto(
    esYaNoLoQuieroSuelto(sinNegadas0) ? sinNegadas0 : sinNegadas0.replace(YA_NO_LO_QUIERO, " "),
  );
  const neutro = o.pedidoEnCurso ? sinNegadas.replace(CANCELACION_CONDICIONAL_SIN_CREAR, " ") : sinNegadas;
  // Revisión 93 (R93-3): «cancela el de mi X» solo cancela con dos o más pedidos vivos; con uno, si nada más lo cancela
  // («cancela el pedido de mi mamá, el mío no» sigue como antes de R92-4), se quita.
  return o.variosPedidosVivos || PATRON_CANCELACION_SIN_PERSONA.test(neutro)
    ? neutro
    : neutro.replace(new RegExp(CANCELA_EL_DE_PERSONA, "g"), " ");
}
/**
 * Revisión 66 (R66-1): el texto pide cancelar SOLO dentro de una pregunta o condición («me lo cancelan por favor?», «¿cómo
 * cancelo mi pedido?», «¿me cancelan el pedido si no pago?»): sin esas frases ya no es cancelación, con ellas sí. Con un
 * pedido vivo el turno registra el aviso de baja y pregunta «¿Quiere cancelar su pedido?» (el «sí» lo cancela). Pura.
 */
export function esCancelacionEnPregunta(texto: string, opciones: OpcionesCancelacion = {}): boolean {
  const plano = String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // Revisión 67 (R67-7): la pregunta contestada por el mismo cliente con un «no» («cancelar? no, gracias», «¿me cancelan
  // el pedido? no, mejor no»): declina, no hay nada que preguntar.
  if (DECLINA_TRAS_PREGUNTA.test(plano)) return false;
  if (PATRON_CANCELACION_PEDIDO.test(neutralizarCancelacion(plano, opciones))) return false;
  if (PATRON_CANCELACION_PEDIDO.test(neutralizarCancelacion(plano, opciones, false))) return true;
  // «si no llega, ¿me cancelan el pedido?»: la forma en «-an» tras un «si» no la ve el patrón (R64), pero en una frase de
  // pregunta también es ambigua. «¿por qué me cancelan…?» y «no me lo cancelan» no.
  const afirmacion = plano.match(AFIRMACION_INICIAL)?.[0] ?? "";
  return plano.slice(afirmacion.length).split(/(?<=[.;!?\n])/).some((frase) => {
    const pregunta = partePregunta(frase)[1];
    return /[¿?]/.test(pregunta) && FORMA_CANCELAN_PREGUNTA.test(pregunta);
  });
}
/**
 * Revisión 77 (R77-5): «quiten / borren / eliminen la orden / el pedido» que no es claramente el pedido completo ni una
 * parte (sin «solo la coca», sin reemplazo como «y pongan 2 gringas», sin «de <producto>»): ante la duda se pregunta
 * «¿Quiere cancelar su pedido?» con su aviso de baja, nunca silencio. Texto plano.
 */
const QUITAR_PEDIDO_DUDOSO = new RegExp(
  String.raw`(?<!\b(?:no|nunca)\s+(?:(?:me|nos|le|les)\s+)?)\b(?:quit|borr|elimin)\w*\s+(?:(?:la|mi|el|su|esa|esta|ese|este|todo|toda)\s+)*(?:pedido|orden\b(?!\s+\d))\b(?!\s+del?\s+(?!(?:la\s+)?${LUGAR_DEL_PEDIDO}))|\b(?:quit|borr|elimin)(?:a|e|en|ame|eme|enme|alo|ala|enlo|enla)\s+todo(?:\s+(?:por\s+favor|porfa|porfavor|plis|gracias))*\s*$`,
);
/**
 * Reemplazo o cambio en el mismo mensaje («y pongan 2 gringas», «mejor…», «en vez de», «cámbienlo por…»). Texto plano.
 * Revisión 78 (R78-7): también la orden dicha otra vez («que sean 3 gringas», «que sea de bistec», «estaba mal», «te mando
 * la buena: …»); y «la orden 2» (un renglón) no es el pedido (QUITAR_PEDIDO_DUDOSO).
 */
const REEMPLAZA_ALGO = new RegExp(
  String.raw`\b(?:pong\w*|agreg\w*|anad\w*|mejor|cambi\w*|en\s+(?:vez|lugar)\s+de|que\s+sean?\s+(?:\d+|de|del|un|una|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|puros?|puras?|solo)|estaba\s+mal|(?:te|le|les)\s+(?:mando|paso|escribo|envio)\s+(?:la|el)\s+(?:buena|bueno|correcta|correcto|bien|nueva|nuevo)|mand\w*\s+(?:(?:${DETERMINANTE_CANCEL})\s+)+(?:${PRODUCTO_CANCEL}))\b|${CAMBIO_DE_PRODUCTO.source}`,
);
/**
 * Revisión 77 (R77-6): «don't send it», «please don't send it», «forget it, don't send the food» a secas (sin «to / there /
 * yet / with…» ni nada más después): puede ser cancelar. Texto sin acentos y en minúsculas, con signos.
 */
const DONT_SEND_SUELTO =
  /\b(?:don\W?t|do\s+not|dont)\s+send\b(?:\s+(?:it|them|the\s+food|my\s+food|the\s+order|my\s+order|anything))?(?=\s*(?:$|[,.;!]|\s+(?:please|pls|anymore|any\s+more|thanks|thank\s+you|cancel\w*)\b))/;
/** Revisión 78 (R78-9): extras que se mandan con el pedido (no son el pedido). Texto sin acentos y en minúsculas. */
const EXTRA_NOMBRADO =
  /\b(?:napkins?|straws?|cutlery|utensils?|silverware|forks?|spoons?|knives|plates?|cups?|receipts?|bags?|ice|ketchup|sauces?|salsas?|servilletas?|popotes?|cubiertos?|tenedores|cucharas?|platos?|vasos?|bolsas?|ticket|recibo|hielo|desechables)\b/;
/** Revisión 80 (R80-3): extras que admiten «them» (plurales o colectivos). */
const EXTRA_PLURAL = /(?:s|cutlery|silverware)$/;
/**
 * Revisión 80 (R80-3): extras que el asistente OFRECE en su texto: los que van en una pregunta («¿Le mando cubiertos y
 * servilletas?»). Los de una afirmación («Le llevamos salsa verde, salsa roja…», la confirmación de siempre) no. Pura.
 */
export function extrasOfrecidos(texto: string): string[] {
  const preguntas = normAviso(texto).match(/¿[^?¿]*\?|[^.!?¿\n]*\?/g) ?? [];
  return preguntas.flatMap((q) => [...q.matchAll(new RegExp(EXTRA_NOMBRADO.source, "g"))].map((x) => x[0]));
}
/**
 * Revisión 78 (R78-8): «I want to cancel», «I need to cancel, sorry» sin decir qué (con «my order» ya cancela por
 * CANCELACION_R33): se pregunta si cancela. No «don't want to cancel» ni «need to cancel the card payment». Texto sin acentos
 * y en minúsculas, con signos.
 */
const QUIERO_CANCELAR_EN =
  /(?<!\b(?:don\W?t|do\s+not|dont|not|never)\s+)\b(?:want|need|wanna|like|have|got|gotta)\s+(?:to\s+)?cancel\b(?=\s*(?:$|[,.;!]|\s+(?:please|pls|now|sorry|thanks|thank\s+you|it|everything|asap)\b))/;
/**
 * Revisión 77 (R77-5/6): una posible cancelación que no es clara (QUITAR_PEDIDO_DUDOSO, DONT_SEND_SUELTO) y que el patrón de
 * cancelar no tomó: con un pedido vivo se trata como «ya no lo quiero» suelto (aviso de baja y «¿Quiere cancelar su
 * pedido?»). Pura.
 */
export function esCancelacionDudosa(texto: string, opciones: OpcionesCancelacion = {}): boolean {
  const conSignos = normAviso(texto);
  const plano = conSignos.replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  if (esPeticionDeCancelar(texto, opciones)) return false;
  // Revisión 78 (R78-3): «cancelen, mejor lo recojo mañana», «cancelen, mejor paso por el pedido luego»: no cancela (R77-8)
  // pero el «cancelen» es explícito: se pregunta, nunca silencio. Cancelar solo el envío / domicilio es cambio de entrega.
  if (/\b(?:cancel|anul)\w*/.test(plano) && OTRO_DIA_RECOGER.test(plano) && RECOJO_POR_PRONOMBRE.test(plano) &&
    !CANCELA_SOLO_LA_ENTREGA.test(plano) && esYaNoLoMandeConCambio(texto)) return true;
  if (esYaNoLoMandeConCambio(texto) || RECOJO_ESE_PEDIDO.test(plano)) return false;
  const dontSend = conSignos.match(DONT_SEND_SUELTO);
  // Revisión 78 (R78-9): «no straws please, don't send them», o «don't send it» tras «¿Le mando cubiertos?»: el pronombre es
  // el extra recién nombrado (en el mismo mensaje, antes, o en la oferta del asistente), no el pedido.
  // Revisión 80 (R80-3): «them» solo con un extra en plural (napkins, salsas); «it» con cualquiera.
  const concuerda = (extras: readonly string[]) =>
    dontSend !== null && (!/\bthem\b/.test(dontSend[0]) || extras.some((e) => EXTRA_PLURAL.test(e)));
  const nombrados = [...conSignos.slice(0, dontSend?.index ?? 0).matchAll(new RegExp(EXTRA_NOMBRADO.source, "g"))].map((x) => x[0]);
  const pronombreDeExtra = dontSend !== null && /\b(?:it|them)\b|send$/.test(dontSend[0]) &&
    ((nombrados.length > 0 && concuerda(nombrados)) ||
      ((opciones.extrasOfrecidos ?? []).length > 0 && concuerda(opciones.extrasOfrecidos ?? []) && !/\b(?:food|order)\b/.test(dontSend[0])));
  if (dontSend && !pronombreDeExtra) return true;
  if (QUIERO_CANCELAR_EN.test(conSignos)) return true;
  return QUITAR_PEDIDO_DUDOSO.test(plano) && !new RegExp(QUEDA_PRODUCTO).test(plano) && !REEMPLAZA_ALGO.test(plano);
}
// Revisión 67 (R67-3): en una pregunta el «no» no niega el querer («¿no me cancelan mi pedido?», «¿no me lo cancelan?»
// piden cancelar): ya no excluye, solo «que / porque» («¿por qué me cancelan…?»). Y el condicional «¿me cancelarían /
// cancelaría el pedido?». Revisión 67 (R67-6): con un objeto de PAGO («¿me cancelan el pago / el cargo de la tarjeta /
// la transferencia?») no es el pedido: no pregunta si cancela (lo atiende el modelo).
// Revisión 71 (R71-5d): tampoco con la promo, el descuento, el cupón o la oferta («¿cancelan la promo si pago con tarjeta?»).
/** Revisión 67 (R67-7): «…? no», «…? no, gracias», «…? no, mejor no» al final del mensaje (texto plano). */
const DECLINA_TRAS_PREGUNTA =
  /\?[\s.!¡]*(?:no|nel|nop|nah)\b(?:[\s,.!]+(?:(?:muchas\s+|mil\s+)?gracias|mejor\s+no|asi\s+esta\s+bien|todo\s+bien|por\s+ahora|ahorita\s+no)\b)*[\s.!]*$/; // CodeQL js/redos: separador sin cuantificadores anidados
const FORMA_CANCELAN_PREGUNTA =
  /(?<!\b(?:que|porque)\s(?:(?:me|nos|se)\s)?(?:(?:lo|la|los|las)\s)?)\b(?:(?:me|nos|se)\s+)?(?:(?:lo|la|los|las)\s+)?(?:cancelan|cancelarian|cancelaria|anularian|anularia|van\s+a\s+cancelar\w*)\b(?!\s+(?:(?:el|la|los|las|mi|mis|su|sus|este|ese|esta|esa)\s+)?(?:pagos?|cargos?|cobros?|tarjetas?|transferencias?|depositos?|promos?|promociones?|descuentos?|cupon(?:es)?|ofertas?)\b)/;
/** Revisión 66 (R66-1): relleno alrededor de la pregunta de cancelar (texto plano). */
const RELLENO_PREGUNTA_CANCELAR = new RegExp(
  String.raw`\b(?:(?:cancel|anul)\w*|me|nos|se|te|lo|la|los|las|le|les|el|mi|mis|su|sus|tu|pedido|pedidos|orden|ordenes|compra|y|e|o|oigan|oiga|oye|porfa|porfavor|plis|pls|por|favor|gracias|pueden|puede|podrian|podria|puedo|podemos|van|va|a|como|hago|hacemos|para|si|ya|primer|primero|primera|segundo|segunda|otro|otra|ultimo|ultima|dos|ambos|ambas|todo|hola|buenas|buenos|dias|tardes|noches|joven|amigo|amiga|senorita|senor|ok|bueno|pues|entonces|de|del|ese|este|esa|esta|ahora|ahorita|que|no|quiero|queremos)\b`,
  "g",
);
/**
 * Revisión 66 (R66-1): el texto es SOLO la pregunta de cancelar (con relleno o cortesía): con eso solo en la ráfaga, la
 * respuesta es la fija «Entendido. ¿Quiere cancelar su pedido?». Con algo más («…si no pago?», «…? ya van 50 min») va al
 * modelo con la pregunta al final. Pura.
 */
export function esPreguntaCancelarSola(texto: string, opciones: OpcionesCancelacion = {}): boolean {
  if (!esCancelacionEnPregunta(texto, opciones)) return false;
  return normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(RELLENO_PREGUNTA_CANCELAR, " ").trim() === "";
}
/** «gracias», «ok», «vale»… sin contenido de pedido. */
function esCortesiaSola(t: string): boolean {
  const plano = normAviso(t).replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();
  return plano === "" || /^(?:muchas |mil )?(?:gracias|ok|okey|vale|listo|perfecto|entendido|esta bien|por favor|si|no|buenas|hola)(?: (?:gracias|ok|vale|listo|perfecto))?$/.test(plano);
}
/** Revisión 70 (R70-3): «cancelen mi pedido» + «mejor no, ya llega» en la misma ráfaga (no se avisó la cancelación). */
export const CANCELACION_RETIRADA_EN_RAFAGA_REPLY = "Entendido, no cancelo su pedido: sigue en pie.";
export const RETRACTACION_CANCELACION_REPLY =
  "Entendido, ya avisé a la sucursal que usted prefiere esperar y que no se cancele su pedido. Gracias por su paciencia.";
/** Revisión 88 (R88-7): la retractación «sí lo quiero» tras el aviso de cancelación. */
export const RETRACTACION_SI_LO_QUIERE_REPLY = "Perfecto, su pedido sigue en pie; ya le avisé a la sucursal.";
/**
 * «Cancelar» que no es solo cancelar: una cancelación condicional («si tarda más de 40 minutos cancélenlo») o un
 * mensaje que trae además un pedido nuevo. Sin pedido abierto no se corta con «no hay nada que cancelar»:
 * eso se tragaría el pedido, así que el turno pasa al modelo.
 */
export function esCancelacionMixta(texto: string): boolean {
  const plano = normAviso(texto);
  if (/\bsi\b[^.!?\n]*\bcancel/.test(plano)) return true;
  // Sin la cláusula de cancelar (hasta la puntuación), ¿queda un verbo de pedir con un producto?
  const resto = plano.replace(/\bcancel\w*[^.,;!?\n]*/g, " ");
  return /\b(?:quiero|quisiera|quisieramos|queremos|necesito|ordenar|pedir|pido|mandame|deme|dame|me\s+(?:puede|puedes|podria|podrian|manda|envia|trae))\b/.test(resto) &&
    /\b(?:tacos?|platillos?|poc\s+chuc|cochinita|kilos?|ordenes?\s+de|pastor|bistec|refrescos?|nachos?|gringas?|tortas?|quesadillas?|frijoles|alambres?|suizos?|mestizas?|panuchos?|salbutes?|horchata)\b/.test(resto);
}
// Revisión 26: después de «cancelo/cancela…», «y/pero/mejor» + un verbo de pedir, dejar, agregar o cambiar.
const OTRA_PETICION_TRAS_CANCELAR =
  /\bcancel\w*\b[^.!?\n]*?\b(?:y|e|pero|mejor)\s+(?:mejor\s+)?(?:(?:me\s+)?(?:pido|pedir|pedimos|quiero|quisiera|queremos|dejo|dejen|deja|dejamos|agrego|agregar|agregamos|cambio|cambiar|ordeno|ordenar)|me\s+(?:das|dan|da|mandas|mandan|manda|manden|traes|traen|trae|pones|ponen|envias|envian))\b/;
/**
 * Revisión 26: «cancelo y pido otra cosa», «cancelo y dejo los tacos», «cancela mi pedido y mejor me mandas…»: además
 * de cancelar, el cliente pide algo más en el mismo mensaje. Con pedido abierto se registra el aviso de cancelación Y el
 * modelo atiende lo demás; sin pedido abierto el turno va al modelo (no se le contesta «no hay nada que cancelar»). Las
 * condicionales («si tarda, cancélenlo») no cuentan: siguen como siempre.
 */
export function cancelacionConOtraPeticion(texto: string): boolean {
  const plano = normAviso(texto);
  if (/\bsi\b[^.!?\n]*\bcancel/.test(plano)) return false;
  return OTRA_PETICION_TRAS_CANCELAR.test(plano) || esCancelacionMixta(texto);
}
/**
 * Revisión 26 — DECISIÓN conservadora para «no, cancelo» contestando a «¿Algo más?»: es ambiguo («no, nada más» o «no,
 * cancelo el pedido»). Con un pedido abierto NO se avisa la cancelación: se responde esta pregunta y solo un «sí» a ella
 * la registra. La regla aplica únicamente si la última respuesta del asistente pregunta «algo más» y el texto es «no» +
 * el verbo cancelar SIN objeto («no, cancelo», «no, mejor lo cancelo»); «no, cancelo mi pedido» o «no, cancelo» tras
 * otra pregunta siguen siendo cancelación, y sin pedido abierto se contesta como siempre (no hay nada que cancelar).
 */
export const PREGUNTA_CONFIRMAR_CANCELACION = "¿Quiere cancelar su pedido?";
/** Revisión 52: la respuesta fija al «ya no lo quiero / ya no lo mande» ambiguo con pedido vivo (su ÚNICA pregunta). */
export const YA_NO_LO_QUIERO_REPLY = `Entendido. ${PREGUNTA_CONFIRMAR_CANCELACION}`;
/**
 * Revisión 68 (R68-1): la pregunta de cancelar cuando se AGREGA a una respuesta que ya pregunta otra cosa («El envío es $20.
 * ¿Lo quiere a domicilio?»): pide una respuesta explícita, así el «sí» a la otra pregunta nunca cancela.
 */
export const PREGUNTA_CANCELAR_EXPLICITA = 'Si quiere cancelar su pedido, responda "cancelar"; si no, siga con normalidad.';
/**
 * Revisión 68 (R68-1): agrega la pregunta de cancelar al final de `texto` (si no la trae ya): «¿Quiere cancelar su pedido?»
 * si es la única pregunta; PREGUNTA_CANCELAR_EXPLICITA si el texto ya pregunta otra cosa. Pura.
 */
export function conPreguntaCancelar(texto: string, pregunta: string = PREGUNTA_CONFIRMAR_CANCELACION): string {
  if ([...PREGUNTAS_CANCELAR, ...PREGUNTAS_CANCELAR_EXPLICITAS].some((p) => texto.includes(p))) return texto;
  const explicita = pregunta === PREGUNTA_CANCELAR_REEMPLAZO ? PREGUNTA_CANCELAR_REEMPLAZO_EXPLICITA : PREGUNTA_CANCELAR_EXPLICITA;
  return `${texto}\n\n${/[¿?]/.test(texto) ? explicita : pregunta}`;
}
/**
 * Revisión 68 (R68-3): la pregunta cuando el cliente pide reemplazar su pedido en curso por uno nuevo («ya no lo quiero,
 * mejor 10 tacos a domicilio»). Un «sí» (como única pregunta) cancela el anterior y el modelo sigue con el nuevo.
 */
export const PREGUNTA_CANCELAR_REEMPLAZO = "¿Quiere cancelar su pedido anterior y hacer este nuevo?";
/** Revisión 68 (R68-3): la versión de respuesta explícita de PREGUNTA_CANCELAR_REEMPLAZO (junto a otra pregunta). */
export const PREGUNTA_CANCELAR_REEMPLAZO_EXPLICITA =
  'Si quiere cancelar su pedido anterior y hacer este nuevo, responda "cancelar"; si no, siga con normalidad.';
/** Las preguntas de cancelar cuyo «sí» (como única pregunta) confirma la cancelación. */
const PREGUNTAS_CANCELAR = [PREGUNTA_CONFIRMAR_CANCELACION, PREGUNTA_CANCELAR_REEMPLAZO];
/** Revisión 68: las versiones de respuesta explícita (solo un verbo de cancelar confirma). */
const PREGUNTAS_CANCELAR_EXPLICITAS = [PREGUNTA_CANCELAR_EXPLICITA, PREGUNTA_CANCELAR_REEMPLAZO_EXPLICITA];
/**
 * Revisión 68 (R68-3): el texto pide un pedido NUEVO: cantidad y producto con la entrega («10 tacos a domicilio», «2 gringas
 * para recoger») o «otro pedido / pedido nuevo». «mejor dame 2 gringas» (sin entrega) es cambiar un producto del pedido
 * (R36). Pura.
 */
export function esPedidoNuevo(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:otro|nuevo)\s+pedido\b|\bpedido\s+nuevo\b/.test(plano)) return true;
  const cantidadYProducto = new RegExp(
    String.raw`\b(?:\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|media\s+docena|docena)\s+(?:(?:de|orden(?:es)?\s+de)\s+)?(?:${PRODUCTO_CANCEL})`,
  ).test(plano);
  return cantidadYProducto && /\ba\s+domicilio\b|\bpara\s+(?:recoger|llevar)\b|\b(?:lo|la|los|las)\s+(?:recojo|paso\s+a\s+recoger)\b/.test(plano);
}
/**
 * Revisión 69 (R69-4): el texto AGREGA al pedido en curso («10 tacos más», «2 gringas extra», «también una coca»), no pide
 * otro en su lugar. «más tarde / más rápido» no cuenta. Pura.
 */
export function agregaAlPedido(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:extras?|adicional(?:es)?|tambien|ademas)\b/.test(plano)) return true;
  return MAS_AGREGA.test(plano);
}
/**
 * Revisión 70 (R70-1): «más» solo agrega pegado a un producto o una cantidad («10 tacos más», «más tacos», «otra más», «dos
 * más»); «lo más pronto posible», «lo más económico», «más tarde / rápido / barato» no. Texto plano.
 */
const MAS_NO_AGREGA = String.raw`(?!\s+(?:pronto|rapido|temprano|tarde|economic[oa]s?|barat[oa]s?|car[oa]s?|adelante|luego|facil|tiempo|o\s+menos)\b)`;
const MAS_AGREGA = new RegExp(
  String.raw`\b(?:\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|otr[oa]s?|${PRODUCTO_CANCEL})\s+mas\b${MAS_NO_AGREGA}|\bmas\s+(?:(?:${DETERMINANTE_CANCEL})\s+)?(?:(?:orden(?:es)?\s+)?de\s+)?(?:${PRODUCTO_CANCEL})\b`,
);
/** Revisión 68 (R68-3): el aviso de baja del pedido anterior cuando el cliente pide reemplazarlo. Pura. */
function avisoPosibleBajaReemplazo(yaNo: string[], nuevos: string[]): string {
  const corto = (xs: string[]) => citaDelCliente(xs.join(" / "), 400);
  const dijo = yaNo.length > 0 ? `el cliente escribió «${corto(yaNo)}» con un pedido en curso; ` : "";
  return `POSIBLE CANCELACIÓN, SIN CONFIRMAR: ${dijo}el cliente pide reemplazarlo por: «${corto(nuevos)}». Se le pregunta «${PREGUNTA_CANCELAR_REEMPLAZO}». Si contesta que sí, este aviso pasa a cancelación. El pedido nuevo puede quedar creado aparte: revise si el anterior sigue.`;
}
/**
 * Revisión 68 (R68-3): lo que el modelo sabe del reemplazo. Revisión 69 (R69-1): solo información; el modelo pregunta si
 * cancela el anterior pero puede tomar y crear el pedido nuevo como siempre (la sucursal ve el aviso de baja y decide).
 */
function bloqueReemplazoDePedido(textos: string[]): string {
  const dijo = citaDelCliente(textos.join(" / "), 300);
  return `REEMPLAZO DE UN PEDIDO EN CURSO: el cliente tiene un pedido en curso y escribió «${dijo}»: ya no quiere ese pedido y pide uno nuevo. Pregúntele si cancela el pedido anterior, exactamente «${PREGUNTA_CANCELAR_REEMPLAZO}» (sin otra pregunta en el mismo mensaje). Puede tomar y crear el pedido nuevo como siempre (no lo frene por esto). No avise una cancelación (no llame a registrar_contacto por esto) ni dé el pedido anterior por cancelado: el servidor ya le pasó a la sucursal la posible cancelación.`;
}
/** Revisión 68 (R68-3): lo que el modelo sabe cuando el cliente confirmó cancelar el anterior para hacer el nuevo. */
function bloqueReemplazoConfirmado(respuesta: string): string {
  return `CANCELACIÓN DEL PEDIDO ANTERIOR YA AVISADA: a «${PREGUNTA_CANCELAR_REEMPLAZO}» el cliente contestó que sí. El aviso de cancelación del pedido anterior ya quedó con la sucursal y el cliente ya recibe este texto antes de tu respuesta: «${respuesta}». No vuelvas a avisar la cancelación ni repitas ese texto. Sigue con el pedido NUEVO que pidió en los mensajes anteriores: si ya quedó creado en esta conversación, no lo vuelvas a crear (solo confírmale que sigue en pie); si no, cotízalo, dile el total y, con su confirmación y su forma de pago, créalo.`;
}
/** Revisión 52: la misma, cuando la queja de demora ya quedó avisada a la sucursal en ese turno. */
export const YA_NO_LO_QUIERO_DEMORA_REPLY = `Ya avisé a la sucursal de la demora. ${PREGUNTA_CONFIRMAR_CANCELACION}`;
/**
 * Contenido de la ÚLTIMA respuesta del asistente. Revisión 36: si el último mensaje del asistente está vacío (un turno
 * que terminó en una llamada a herramienta sin texto guardado, p. ej. el modelo falló y el cliente recibió otra cosa), es
 * "": ya no se salta hasta una pregunta vieja («¿Quiere cancelar su pedido?») que un «sí» confirmaría. Un turno normal
 * termina con su texto (las llamadas a herramientas quedan antes), así que no cambia nada más.
 */
function ultimaRespuestaDelAsistente(messages: readonly MensajeHilo[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (esMarcadorSesion(m)) return "";
    if (m?.role === "assistant") return typeof m.content === "string" && m.content.trim() ? m.content : "";
  }
  return "";
}
/**
 * Revisión 35: «ya no lo quiero», «ya no la quiero, gracias» SIN nada más: tras el resumen de un pedido es ambiguo (puede
 * ser lo que se le acaba de ofrecer). «ya no lo quiero, cancélenlo» o «…, ya tardaron mucho» no son sueltos. Pura.
 */
export function esYaNoLoQuieroSuelto(texto: string): boolean {
  return fraseSuelta(texto, String.raw`ya\s+no\s+(?:lo|la)\s+(?:quiero|queremos)`);
}
const YA_NO_LO_MANDE = String.raw`ya\s+no\s+(?:me\s+)?(?:lo|la)\s+(?:mande|manden|mandes|envie|envien|envies|traiga|traigan)`;
/**
 * Revisión 39: «ya no lo mande», «ya no me lo manden, por favor» SIN nada más. Ya no cancela (R39-1): con un pedido vivo el
 * modelo pregunta «¿Quiere cancelar su pedido?» y, contestando esa pregunta, confirma. Pura.
 */
export function esYaNoLoMandeSuelto(texto: string): boolean {
  return fraseSuelta(texto, YA_NO_LO_MANDE);
}
/** Revisión 49: otros «sí» al inicio de la respuesta a «¿Quiere cancelar su pedido?» (texto plano). */
const OTRO_SI = String.raw`(?:claro|exacto|asi\s+es|correcto|por\s+supuesto|adelante|simon|orale|sale|va|afirmativo)(?:\s+que\s+si)?`;
/** La frase sola, con a lo más muletillas antes y cortesías después (texto plano). */
function fraseSuelta(texto: string, frase: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  return new RegExp(
    String.raw`^(?:(?:no|si|pues|ah|oiga|bueno|mejor|ok|gracias|muchas)\s+)*${frase}(?:\s+(?:muchas\s+|mil\s+)?(?:gracias|por\s+favor|ok|joven|amigo|amiga|oiga|senorita|senor))*$`,
  ).test(plano);
}
/**
 * Revisión 39: contestando «¿Quiere cancelar su pedido?», un «sí» al inicio confirma aunque siga algo («sí, ya tardaron
 * mucho», «sí, cancélelo», «sí por favor»), salvo negación, espera, «pero», «solo» o pregunta («sí, pero mejor espero»,
 * «sí, solo la coca», «sí, ¿cuánto falta?»). «si» sin acento solo con signo o cortesía detrás: «si ya salió…» es condición.
 */
export function esSiQueConfirmaCancelar(
  texto: string,
  soloPreguntaCancelar = true,
  declaraAlergia: (texto: string) => boolean = mencionaAlergia,
): boolean {
  // Revisión 52: «pues sí», «pues sí, cancélelo»: el «pues» de arranque no cambia la respuesta.
  const sinPues = String(texto ?? "").replace(/^[\s¡!]*pues(?:\s*,\s*|\s+)(?=\S)/i, "");
  if (sinPues !== String(texto ?? "")) return esSiQueConfirmaCancelar(sinPues, soloPreguntaCancelar, declaraAlergia);
  // Revisión 57 (R57-1): «sí, quita la coca», «si, cambia la coca por agua», «sí, el de pastor no lo quiero»: modificación.
  if (esSiConCambioDeProducto(texto)) return false;
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  // Revisión 51: con otra pregunta al lado (la colonia, «¿Algo más?», una del modelo), cualquier «sí» puede contestar la
  // otra: solo confirma con un verbo de cancelar («sí, cancélelo»).
  const cancela = /\b(?:cancel|anul)\w*/.test(plano);
  if (!soloPreguntaCancelar && !cancela) return false;
  if (siNoDeUnaPalabra(texto) === "si") return true;
  // Revisión 57 (R57-7): «okey» (y «okeyy») como «ok», solo si «¿Quiere cancelar su pedido?» fue la única pregunta.
  if (soloPreguntaCancelar && /^okey+$/.test(plano)) return true;
  if (/[¿?]/.test(texto)) return false;
  const bajo = String(texto ?? "").toLowerCase().trim().replace(/^[¡!\s]+/, "");
  // Revisión 57 (R57-7): «si pues» como «sí pues».
  const siExplicito = /^sí(?![a-zñáéíóú])/.test(bajo) || /^si\s*[,.;:!]/.test(bajo) || /^si\s+(?:por\s+favor|gracias|pues|cancel|anul)/.test(plano);
  // Revisión 49: otros «sí» («claro», «así es», «órale», «va»…), solos o seguidos de cortesía o de cancelar.
  // Revisión 50: solo si «¿Quiere cancelar su pedido?» fue la ÚNICA pregunta del asistente (con «¿Con qué forma de pago?»
  // al lado, «claro» contesta la otra); si no, solo con un verbo de cancelar. Y no con reprogramar, recoger, la hora, el
  // pago o la dirección («claro gracias, lo recojo yo», «sale ok, a las 5»).
  const otroSi = !siExplicito &&
    new RegExp(String.raw`^${OTRO_SI}(?:\s+(?:por\s+favor|gracias|cancel\w*|anul\w*|muchas|mil|ok|si|pues)\b.*)?$`).test(plano) &&
    (soloPreguntaCancelar || cancela);
  if (!siExplicito && !otroSi) return false;
  // Revisión 52: «sí, no lo quiero», «sí, no lo mande»: ese «no» niega «quiero / mande», no el «sí» (pero no «sí, no lo
  // quiero cancelar»).
  const resto = plano.replace(/^si\b/, " ").replace(new RegExp(String.raw`^${OTRO_SI}\b`), " ").replace(
    new RegExp(String.raw`\b(?:ya\s+)?no\s+(?:me\s+)?(?:lo|la)\s+(?:quiero|queremos|mande|manden|mandes|envie|envien|envies|traiga|traigan)\b(?!\s+(?:que\s+)?(?:(?:lo|la|se)\s+)?(?:cancel|anul))`, "g"),
    " ",
  );
  // Revisión 51: tampoco el «sí» explícito con reprogramar, recoger, la hora, el pago, la dirección, una alergia o un
  // pedido («sí, lo recojo yo», «sí a las 5», «sí, efectivo», «sí, soy alérgico…», «sí, quiero 2 tacos»): va al modelo.
  if (esReprogramaORecoge(texto) || CAMBIO_NO_CANCELA_YA_NO_QUIERO.test(resto) || declaraAlergia(texto)) return false;
  if (!cancela && PIDE_ALGO_TRAS_SI.test(resto)) return false;
  // Revisión 58 (R58-1): «sí, sin cebolla porfa» es un cambio al pedido (va al modelo), no la confirmación.
  if (/\bsin\s+(?!problemas?\b|pena\b|duda\b)[a-z]/.test(resto)) return false;
  return !/\b(?:no|nunca|jamas|pero|mejor|espero|esperar|esperamos|esperare|solo|nada\s+mas|todavia|aun)\b/.test(resto);
}
/** Revisión 57 (R57-1): un producto con sus determinantes («la coca», «2 tacos», «coca»). Texto plano. */
const PRODUCTO_TRAS_SI = String.raw`(?:(?:${DETERMINANTE_CANCEL})\s+)*(?:${PRODUCTO_CANCEL})\b`;
/** Revisión 57 (R57-1): quitar o cambiar un producto, sobre lo que sigue al «sí» (texto plano). */
const CAMBIO_PRODUCTO_TRAS_SI = new RegExp([
  String.raw`\b(?:quit|cambi|sac|elimin|cancel|anul)\w*\s+(?:(?:le|les|me)\s+)?(?:lo\s+del?\s+)?${PRODUCTO_TRAS_SI}`,
  String.raw`\bsin\s+${PRODUCTO_TRAS_SI}`,
  String.raw`^(?:pero\s+)?${PRODUCTO_TRAS_SI}\s+(?:nomas|nada\s+mas|solamente|solo)\b`,
  String.raw`^(?:pero\s+)?(?:nomas|nada\s+mas|solamente|solo)\s+${PRODUCTO_TRAS_SI}`,
  String.raw`\b(?:el|la|los|las)\s+(?:de\s+[a-z]+|${PRODUCTO_CANCEL})\s+(?:ya\s+)?no\s+(?:lo|la|los|las)\s+(?:quiero|queremos)\b`,
].join("|"));
/**
 * Revisión 57 (R57-1): contestando «¿Quiere cancelar su pedido?», un «sí» seguido de quitar o cambiar un PRODUCTO («si, quita
 * la coca», «si, sin la coca», «si, cambia la coca por agua», «si, la coca nomás», «sí, el de pastor no lo quiero», «si,
 * cancela la coca») no cancela todo el pedido: es una modificación. Si nombra el pedido completo («sí, cancela el pedido de
 * la coca», «…todo»), no. Pura.
 */
export function esSiConCambioDeProducto(texto: string): boolean {
  const bajo = String(texto ?? "").toLowerCase().trim().replace(/^[¡!\s]+/, "").replace(/^pues\s*,?\s+/, "");
  if (!/^(?:sí(?![a-zñáéíóú])|si\s*[,.;:!]|si\s+(?:pero|nomas|nomás|nada\s+m[aá]s|solo|sólo)\b)/.test(bajo)) return false;
  const resto = normAviso(bajo).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim().replace(/^si\b\s*/, "");
  const sinDemas = resto.replace(/\b(?:(?:todo|toda)\s+)?lo\s+demas\b/g, " ");
  if (/\b(?:pedido|compra|completo|completa|todo|toda)\b|\b(?:la|mi|su|esta|esa)\s+orden\b/.test(sinDemas)) return false;
  return CAMBIO_PRODUCTO_TRAS_SI.test(resto);
}
/** Revisión 57 (R57-1): lo que el modelo sabe cuando el «sí, quita la coca» ya volvió el aviso de baja una modificación. */
function bloqueCambioTrasSiYaAvisado(textos: string[]): string {
  const dijo = citaDelCliente(textos.join(" / "), 300);
  return `CAMBIO DE PRODUCTO EN UN PEDIDO YA CREADO (YA AVISADO): a «${PREGUNTA_CONFIRMAR_CANCELACION}» el cliente contestó «${dijo}»: NO cancela todo su pedido, quiere quitar o cambiar un producto. El servidor YA le pasó ese cambio a la sucursal como modificación del pedido, con sus palabras: no registre otro aviso por esto, no lo dé por cancelado y no cancele ni cambie pedidos usted. Dígale en una frase que ya le pasó el cambio a la sucursal y que ahí le confirman el cambio y el nuevo total. Atienda cualquier otra cosa que pida.`;
}
/** Revisión 51: tras el «sí», pedir algo («quiero 2 tacos», «agrégueme una coca», «a domicilio», «deme…»). Texto plano. */
const PIDE_ALGO_TRAS_SI =
  /\b(?:quiero|queremos|dame|deme|denme|mandame|mandeme|mandenme|traigame|traiganme|ponme|pongame|agreg\w*)\b|\bme\s+(?:da|das|den|manda|mandas|manden|trae|traes|traen)\b|\ba\s+domicilio\b|\botro\s+pedido\b/;
/**
 * Revisión 38: lo que, junto a «ya no lo/la quiero», lo vuelve un CAMBIO y no una duda de cancelar (R37): la hora («para
 * las 3», «mejor para…», «más tarde»), la dirección, el pago, la sucursal, «para llevar». Sobre el texto plano sin el «ya
 * no lo quiero».
 */
const CAMBIO_NO_CANCELA_YA_NO_QUIERO = new RegExp([
  String.raw`\bcambi\w*\s+(?:(?:la|el|de|mi|su)\s+)?(?:hora|horario|direccion|domicilio|pago|forma\s+de\s+pago|sucursal|tarjeta|efectivo)\b`,
  String.raw`\bcambi\w*\s+(?:para|a)\s+las?\b`,
  String.raw`\b(?:para|a|hasta)\s+las?\s+(?:\d|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)`,
  String.raw`\bmejor\s+(?:para|a)\b|\bmas\s+tarde\b|\btodavia\b`,
  String.raw`\b(?:pago|pagar|pagare|pagamos|pagaria)\b|\befectivo\b|\btarjeta\b`,
  String.raw`\bdireccion\b|\bdomicilio\b|\bsucursal\b|\bpara\s+llevar\b|\brecoger\b`,
  // Revisión 41: SIN «mañana», días, «en la tarde/noche» ni «recojo» (R40 los agregó y callaba cancelaciones reales: «ya
  // no lo quiero, mañana lo pido otra vez», «…, el lunes vuelvo a pedir»). «ya no lo mande, es para mañana / lo recojo
  // yo» lleva la nota y el modelo pregunta «¿Quiere cancelar su pedido?»: preguntar de más no daña, callar sí.
].join("|"));
/**
 * Revisión 38: «ya no lo quiero, ya tardaron mucho», «ya no lo quiero, ya comí», «ya no lo quiero por la tardanza»: «ya no
 * lo/la quiero» con un MOTIVO (no suelto, no un cambio de hora/dirección/pago/sucursal ni de producto). Con pedido vivo el
 * modelo pregunta «¿Quiere cancelar su pedido?» (sin aviso de cancelación todavía). Pura.
 */
export function esYaNoLoQuieroConMotivo(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  // Revisión 40: igual «ya no (me) lo mande(s/n) / envíe / traiga» con un motivo («…, es muy tarde», «…, ya comimos», «…,
  // ya tardaron mucho»): desde R39 no cancela, y sin esto no avisaba ni preguntaba. Con un cambio («es para mañana», «lo
  // recojo yo») sigue sin nota; suelto va por esYaNoLoMandeSuelto.
  const frase = new RegExp(String.raw`\bya\s+no\s+(?:lo|la)\s+(?:quiero|queremos)\b|\b${YA_NO_LO_MANDE}\b`, "g");
  if (!frase.test(plano) || esYaNoLoQuieroSuelto(texto) || esYaNoLoMandeSuelto(texto)) return false;
  // Revisión 75 (R75-3): «ya no me lo manden, lo recojo yo» cambia la entrega, no es un motivo para dejar el pedido.
  if (esYaNoLoMandeConCambio(texto)) return false;
  // Revisión 62 (R62-1): «me equivoqué de dirección / de pedido / de sucursal» es el MOTIVO, no un cambio: sin esto la
  // palabra «dirección» o «sucursal» lo volvía cambio (CAMBIO_NO_CANCELA_YA_NO_QUIERO) y «ya no lo quiero, me equivoqué de
  // dirección» no avisaba ni preguntaba.
  const resto = plano.replace(frase, " ");
  const sinEquivoque = resto.replace(ME_EQUIVOQUE_DE, " ");
  // Revisión 41: con una queja de demora («…, ya tardaron mucho, mejor lo pido mañana / para las 3») siempre: el reclamo
  // se avisa y se pregunta si cancela, diga lo que diga además.
  if (esQuejaDeDemora(resto)) return true;
  return /[a-z0-9]/.test(resto) && !CAMBIO_NO_CANCELA_YA_NO_QUIERO.test(sinEquivoque) && !CAMBIO_DE_PRODUCTO.test(plano) &&
    !QUITA_PRODUCTO.test(plano);
}
/** Revisión 62 (R62-1): «me equivoqué de dirección / de pedido / de sucursal…» (texto plano): el motivo de «ya no lo quiero». */
const ME_EQUIVOQUE_DE = new RegExp(
  String.raw`\b(?:me|nos)\s+(?:equivoque|equivocamos)\s+(?:de|con|en)\s+(?:(?:la|el|mi|su)\s+)?(?:direccion|domicilio|pedido|orden|sucursal|ubicacion|producto|comida)\b`,
  "g",
);
/** Revisión 42: la marca que vuelve una respuesta a «¿Quiere cancelar su pedido?» en la cancelación confirmada. */
export const SUFIJO_CONFIRMA_CANCELACION = " (confirma: cancelo mi pedido)";
const DIA_REPROGRAMA = "manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo";
/** Revisión 44: el pedir negado explícito (esReprogramaORecoge). Sobre texto plano. */
const PEDIR_NEGADO_EXPLICITO = /\bno\s+pido\s+nada\b|\bya\s+no\s+(?:lo\s+)?pido\b|\bno\s+vuelvo\s+a\s+pedir\b|\bmanana\s+tampoco\b/;
/** Revisión 44: reprogramar en afirmativo (no «ya no lo pido, mañana…»); gana sobre PEDIR_NEGADO_EXPLICITO. Texto plano. */
const REPROGRAMA_AFIRMATIVO = new RegExp(
  String.raw`(?<!\bno\s)\b(?:lo|la|los|las)\s+pido\s+(?:el\s+|para\s+(?:el\s+)?)?(?:${DIA_REPROGRAMA})\b|\bmanana\s+si\b|\bes\s+para\s+(?:el\s+)?(?:${DIA_REPROGRAMA})\b|\bpara\s+el\s+(?:${DIA_REPROGRAMA})\b|\bno\s+(?:para\s+)?hoy\b`,
);
/**
 * Revisión 42: contestando «¿Quiere cancelar su pedido?», lo que acompaña al «ya no lo quiero / ya no lo mande» es
 * reprogramar o recogerlo («es para mañana», «el domingo», «mejor en la tarde», «lo recojo yo», «para las 3»), sin queja
 * de demora: NO confirma la cancelación (va al modelo). Solo en ese camino; CAMBIO_NO_CANCELA_YA_NO_QUIERO no los lleva
 * (R41-1). Pura.
 */
export function esReprogramaORecoge(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  const resto = plano.replace(
    new RegExp(String.raw`\bya\s+no\s+(?:lo|la)\s+(?:quiero|queremos)\b|\b${YA_NO_LO_MANDE}\b`, "g"),
    " ",
  );
  if (esQuejaDeDemora(resto)) return false;
  // Revisión 44: el pedir negado EXPLÍCITO («no pido nada», «ya no pido», «ya no lo pido», «no vuelvo a pedir», «mañana
  // tampoco») no reprograma (sí confirma), salvo que también reprograme en afirmativo («lo pido mañana», «mañana sí», «es
  // para mañana», «para el lunes», «no hoy», «no para hoy»). Sobre el texto completo, no sobre `resto` («no, ya no lo
  // quiero, lo pido mañana» no es «no lo pido»). El día + «no» suelto («mejor el sábado, no el domingo») no cuenta.
  if (PEDIR_NEGADO_EXPLICITO.test(plano)) return REPROGRAMA_AFIRMATIVO.test(plano);
  return REPROGRAMA_O_RECOGE.test(resto);
}
/** Revisión 56: el texto trae «ya no lo/la quiero» o «ya no (me) lo mande…» (con o sin algo más). Pura. */
function traeYaNoLoQuiero(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  return new RegExp(String.raw`\bya\s+no\s+(?:lo|la)\s+(?:quiero|queremos)\b|\b${YA_NO_LO_MANDE}\b`).test(plano);
}
/** Revisión 42: reprogramar o recoger («mañana», un día, «en la tarde», «lo recojo», «para las 3»). Texto plano. */
const REPROGRAMA_O_RECOGE =
  /\bmanana\b|\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\ben\s+la\s+(?:tarde|noche)\b|\brecoj\w*|\brecog\w*|\bpara\s+las?\s+(?:\d|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)/;
/**
 * Revisión 38: el texto se queja de la demora («ya tardaron», «la tardanza», «demora», «no llega», «ya pasó una hora»).
 * Revisión 39: no «buenas tardes» ni «a más tardar / se va a tardar» (el infinitivo). Pura.
 */
export function esQuejaDeDemora(texto: string): boolean {
  // Revisión 41: la pregunta «¿cuánto tarda(n)?», «¿a qué hora llega?» no es queja (sí lo que venga junto: «ya tardaron,
  // ¿cuánto falta?»).
  // Revisión 42: «¿cuánto MÁS tarda(n)?» sí es queja (ya esperó); se quita solo «¿cuánto tarda(n)?».
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ")
    .replace(/\bcuanto\s+(?:tarda|tardan|tardara|tardaran|tardaria|tardarian|demora|demoran|demorara|demoraran)\b/g, " ")
    .replace(/\ba\s+que\s+hora\s+(?:llega|llegan|llegara|llegaran|viene|vienen|tarda|tardan|me\s+lo\s+traen|lo\s+traen)\b/g, " ");
  // Revisión 68 (R68-4): «no me llegó», «no nos ha llegado» SIN objeto (al final o seguido de «y / ya / pues…»): es el pedido
  // que no llegó («no me llegó y ya no lo quiero»). «no me llegó la salsa» (faltante) no.
  if (/\bno\s+(?:me|nos)\s+(?:ha\s+|han\s+)?(?:llego|llegado)(?:\s+(?:nunca|todavia|aun))?(?=\s*$|\s+(?:y|e|ya|pues|asi\s+que|por\s+eso|entonces|mejor)\b)/.test(plano.trim())) {
    return true;
  }
  // Revisión 42: también «llevo una hora / mucho / rato esperando», «ya pasó mucho (tiempo)».
  return /\btard(?!es?\b|ar\b)[a-z]*|\bdemor[a-z]*|\bretras[a-z]*|\bno\s+(?:ha\s+)?(?:llega|llegado|llegan|viene|ha\s+venido)\b|\bya\s+pas(?:o|aron)\s+(?:mas\s+de\s+)?(?:una|dos|tres|cuatro|\d+|media)\s+(?:horas?|minutos?)\b|\bya\s+pas(?:o|aron)\s+(?:mucho|demasiado)\b|\bllev(?:o|amos)\s+(?:(?:mas\s+de\s+)?(?:una|dos|tres|\d+|media)\s+(?:horas?|minutos?)|mucho(?:\s+tiempo)?|(?:un\s+)?(?:buen\s+)?rato|horas)\s+esperando\b/
    .test(plano);
}
/** Revisión 37: la última respuesta del asistente ofrece agregar algo («¿Le agrego…?», «¿Desea…?», «¿Quiere agregar…?»). */
function ofrecioAgregarAlgo(messages: readonly MensajeHilo[]): boolean {
  const previa = normAviso(ultimaRespuestaDelAsistente(messages));
  return previa.includes("?") && /\b(?:le|les|te)\s+agrego\b|\bdesea\b|\bquiere\s+agregar\b/.test(previa);
}
/**
 * Revisión 52: el texto es SOLO el «ya no lo quiero / ya no lo mande» ambiguo (suelto, o con un motivo que no pide nada ni
 * pregunta: «…, ya comí», «…, ya tardaron mucho»). Con eso solo en la ráfaga, la respuesta es fija (sin modelo). Pura.
 */
function esYaNoLoQuieroAmbiguoSolo(texto: string): boolean {
  if (esYaNoLoQuieroSuelto(texto) || esYaNoLoMandeSuelto(texto)) return true;
  if (!esYaNoLoQuieroConMotivo(texto)) return false;
  // Reprogramar, recoger, una hora, el pago o pedir algo («…, ya tardaron mucho, lo recojo yo», «…, mañana lo pido») lo ve
  // el modelo; una pregunta también, salvo la de la demora («…, ¿cuánto más tarda?»: la demora ya quedó avisada).
  const resto = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(new RegExp(String.raw`\bya\s+no\s+(?:lo|la)\s+(?:quiero|queremos)\b|\b${YA_NO_LO_MANDE}\b`, "g"), " ");
  if (REPROGRAMA_O_RECOGE.test(resto) || CAMBIO_NO_CANCELA_YA_NO_QUIERO.test(resto) || PIDE_ALGO_TRAS_SI.test(resto)) return false;
  if (esQuejaDeDemora(texto)) return true;
  // Revisión 57 (R57-11): fuera de la demora, solo un motivo PURO que no pide nada («ya comí», «ya no tengo hambre», «cambié
  // de opinión», «ya es muy tarde») o cortesía. Una queja u otra cosa («…, la salsa no me llegó», «…, los tacos vinieron
  // fríos», «…, ya comí y me cayó mal») va al modelo (con la pregunta al final y el aviso de baja): la respuesta fija la
  // tiraba.
  return !/[¿?]/.test(texto) && resto.replace(MOTIVO_PURO_YA_NO_LO_QUIERO, " ").replace(RELLENO_MOTIVO, " ").trim() === "";
}
/** Revisión 57 (R57-11): motivos de «ya no lo quiero» que no piden nada a la sucursal (texto plano). */
const MOTIVO_PURO_YA_NO_LO_QUIERO = new RegExp(
  [
    String.raw`\b(?:ya\s+)?(?:comi|comimos|cene|cenamos|desayune|desayunamos|almorce|almorzamos)\b`,
    String.raw`\b(?:ya\s+)?no\s+(?:tengo|tenemos)\s+hambre\b|\bse\s+me\s+(?:quito|fue)\s+el\s+hambre\b`,
    String.raw`\b(?:me\s+|nos\s+)?cambi(?:e|amos)\s+de\s+(?:opinion|idea|plan(?:es)?)\b|\bme\s+arrepenti\b|\bnos\s+arrepentimos\b`,
    String.raw`\b(?:me|nos)\s+cambi(?:o|aron)\s+(?:el|los)\s+plan(?:es)?\b|\bcambiaron\s+(?:los\s+)?planes\b`,
    String.raw`\b(?:ya\s+)?es\s+(?:muy\s+|demasiado\s+)?tarde\b|\b(?:ya\s+)?se\s+(?:me|nos)\s+hizo\s+(?:muy\s+)?tarde\b`,
    String.raw`\b(?:lo|la)\s+(?:pedi|pedimos|compre|compramos)\s+en\s+otro\s+(?:lado|lugar)\b|\bpor\s+el\s+precio\b`,
    String.raw`\b(?:ya\s+)?no\s+(?:lo|la)\s+(?:necesito|necesitamos)\b`,
  ].join("|"),
  "g",
);
/** Revisión 57 (R57-11): cortesía y conectores alrededor del motivo (texto plano). */
const RELLENO_MOTIVO =
  /\b(?:y|e|pues|mejor|es\s+que|porque|la\s+verdad|ya|gracias|muchas|mil|por\s+favor|disculpe|disculpa|perdon|lo\s+siento|oiga|joven|amigo|amiga|senorita|senor|ok|bueno|no|si|hola|buenas|buenos|noches|dias|tardes)\b/g;
/**
 * Revisión 53: la queja de demora en su propio mensaje de la ráfaga («ya tardaron mucho», «llevo una hora esperando»), sin
 * reprogramar, recoger, una hora, el pago ni pedir algo: con «ya no lo quiero» al lado, la respuesta es la fija. Pura.
 */
function esDemoraSola(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  return esQuejaDeDemora(texto) && !REPROGRAMA_O_RECOGE.test(plano) && !CAMBIO_NO_CANCELA_YA_NO_QUIERO.test(plano) &&
    !PIDE_ALGO_TRAS_SI.test(plano);
}
/** Revisión 52: la nota cuando ya hay un aviso de cancelación abierto y el cliente repite «ya no lo quiero». */
const BLOQUE_CANCELACION_YA_PEDIDA =
  "CANCELACIÓN YA AVISADA: el cliente ya pidió cancelar su pedido y la sucursal ya tiene ese aviso (sigue abierto). NO le pregunte si quiere cancelar, no registre otro aviso por esto ni dé el pedido por cancelado: dígale en una frase que la sucursal ya tiene su solicitud de cancelación y que ahí se la confirman. Atienda cualquier otra cosa que pida.";
/** Revisión 66 (R66-1): lo que el modelo sabe de una pregunta sobre cancelar con pedido vivo (esCancelacionEnPregunta). */
function bloquePreguntaCancelar(texto: string): string {
  const dijo = citaDelCliente(texto, 200);
  return `PREGUNTA SOBRE CANCELAR: el cliente tiene un pedido en curso y escribió «${dijo}», que puede ser una petición de cancelar o solo una pregunta. NO avise todavía una cancelación a la sucursal (no llame a registrar_contacto por esto) ni dé el pedido por cancelado. Pregúntele exactamente: «${PREGUNTA_CONFIRMAR_CANCELACION}» (si contesta que sí, la sucursal recibe la cancelación). Atienda cualquier otra cosa que pida.`;
}
/** Revisión 35: lo que el modelo sabe de un «ya no lo quiero» suelto con pedido vivo (esYaNoLoQuieroSuelto). */
function bloqueYaNoLoQuieroAmbiguo(texto: string, demoraAvisada = false): string {
  const dijo = citaDelCliente(texto, 200);
  // Revisión 38: con una queja de demora, el servidor ya avisó el reclamo a la sucursal.
  const demora = demoraAvisada
    ? " La queja por la demora YA quedó avisada a la sucursal (no la vuelva a avisar): discúlpese y dígale que ya le avisó."
    : "";
  return `MENSAJE AMBIGUO: el cliente tiene un pedido en curso y escribió «${dijo}», sin decir qué ya no quiere. NO avise todavía una cancelación a la sucursal (no llame a registrar_contacto por esto) ni dé el pedido por cancelado. Pregúntele exactamente: «${PREGUNTA_CONFIRMAR_CANCELACION}». Atienda cualquier otra cosa que pida.${demora}`;
}
/** «no, cancelo» (sin objeto) contestando a «¿Algo más?»: ver PREGUNTA_CONFIRMAR_CANCELACION. Pura. */
export function esNoCanceloTrasAlgoMas(texto: string, messages: readonly MensajeHilo[]): boolean {
  const plano = normAviso(texto).replace(/[\s.!¡]+$/g, "");
  if (!/^no(?:\s*[,.;:!]+\s*|\s+)(?:mejor\s+)?(?:(?:lo|la)\s+)?cancel(?:o|a|e|en|amos|enlo|alo|elo)$/.test(plano)) return false;
  const previa = normAviso(ultimaRespuestaDelAsistente(messages));
  return /\balgo\s+mas\b/.test(previa) && previa.includes("?");
}
/**
 * Revisión 29: «cancelo el pedido de la coca», «cancelen el pedido de la coca, mejor 2 tacos», «quiero cancelar el pedido
 * de pollo» son AMBIGUOS: ¿todo el pedido (así nombra el cliente su pedido) o solo la coca? «quiero cancelar mi pedido»
 * (sin producto) o «cancelo todo el pedido de tacos» no lo son.
 * Revisión 32: con un pedido abierto el aviso de cancelación sale en ese mismo turno con las palabras del cliente (la
 * sucursal lee y decide si es todo o una parte) y el servidor agrega esta pregunta fija SOLO para el detalle: la
 * respuesta, sea cual sea, se anexa literal al aviso. Ningún análisis de «todo/solo» decide si se avisa.
 */
export const PREFIJO_PREGUNTA_ALCANCE_CANCELACION = "¿Quiere cancelar todo su pedido o solo ";
/** La pregunta fija del alcance de una cancelación ambigua. Pura. */
export function preguntaAlcanceCancelacion(producto: string): string {
  return `${PREFIJO_PREGUNTA_ALCANCE_CANCELACION}${producto}?`;
}
const PRODUCTO_ALCANCE = String.raw`(?:${PRODUCTO_CANCEL})\b(?:\s+de\s+(?:${PRODUCTO_CANCEL})\b)?`;
const CANCELACION_DE_PRODUCTO = new RegExp(
  String.raw`\bcancel\w*\s+(?:(?:el|mi|su|la|este|ese|esta|esa|nuestro|nuestra)\s+)?(?:pedido|orden)\s+de\s+((?:${DETERMINANTE_CANCEL}\s+)*${PRODUCTO_ALCANCE})`,
);
const TODO_EL_PEDIDO_FUENTE = String.raw`\b(?:todo|toda|todito|completo|completa|entero|entera)\b`;
const TODO_EL_PEDIDO = new RegExp(TODO_EL_PEDIDO_FUENTE);
/**
 * Revisión 29: el producto de «cancel… (el/mi) pedido/orden de <producto>» con las palabras del cliente («la coca», «las
 * 2 Cocas», «tacos de pastor»), o null si no es ambiguo (sin producto, «de hoy», «de Ana», o con «todo/completo»). Pura.
 */
export function productoDeCancelacionAmbigua(texto: string): string | null {
  const original = String(texto ?? "");
  const { plano, mapa } = planoConMapa(original);
  if (TODO_EL_PEDIDO.test(plano)) return null;
  const m = CANCELACION_DE_PRODUCTO.exec(plano);
  if (!m) return null;
  const fin = m.index + m[0].length;
  const inicio = fin - (m[1] ?? "").length;
  return original.slice(mapa[inicio] ?? original.length, mapa[fin] ?? original.length).replace(/\s+/g, " ").trim() || null;
}
/** Revisión 30: lo que antecede a la pregunta del alcance cuando se repite (la respuesta fue un «sí»/«ok» sin alcance). */
export const REPREGUNTA_ALCANCE_PREFIJO = "Para pasarle el detalle a la sucursal: ";
/** El producto de la pregunta del alcance («¿Quiere cancelar todo su pedido o solo la coca?» => «la coca»), o null. Pura. */
function productoDePreguntaAlcance(respuesta: string): string | null {
  const i = respuesta.lastIndexOf(PREFIJO_PREGUNTA_ALCANCE_CANCELACION);
  if (i < 0) return null;
  const resto = respuesta.slice(i + PREFIJO_PREGUNTA_ALCANCE_CANCELACION.length);
  const fin = resto.indexOf("?");
  const producto = (fin >= 0 ? resto.slice(0, fin) : resto).trim();
  return producto || null;
}
/** Revisión 31: la pregunta del alcance solo se contesta si tiene a lo más esto. */
export const PREGUNTA_ALCANCE_VIGENTE_MS = 30 * 60_000;
/**
 * Revisión 32: el producto de la pregunta del alcance que sigue PENDIENTE, o null. Pendiente: es la última respuesta del
 * asistente, o la penúltima si entre las dos el cliente solo dijo «sí»/«ok» (tras la repregunta, el modelo pide el
 * detalle con sus palabras y la respuesta real llega después). Y reciente: whatsapp_append_turn NO marca la hora («at»)
 * de los mensajes del asistente (solo los del cliente la traen, de whatsapp-entrada), así que la hora de la pregunta es
 * la suya si la trae y, si no, la del último mensaje del cliente ANTES de ella (el que la provocó). Sin ninguna hora
 * legible se toma por reciente (lo único que hace es anexar un detalle a un aviso ABIERTO). Pura.
 */
export function preguntaAlcancePendiente(messages: readonly MensajeHilo[], ahoraMs: number): string | null {
  const texto = (m: MensajeHilo | undefined): string => (typeof m?.content === "string" ? m.content : "");
  const esRespuesta = (m: MensajeHilo | undefined) => m?.role === "assistant" && texto(m).trim() !== "";
  const respuestas: number[] = [];
  let inicioSesion = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (esMarcadorSesion(messages[i])) {
      inicioSesion = i + 1;
      break;
    }
    if (esRespuesta(messages[i]) && respuestas.length < 2) respuestas.push(i);
  }
  if (respuestas.length === 0) return null;
  let iPregunta = -1;
  const r0 = respuestas[0] ?? -1;
  const r1 = respuestas[1] ?? -1;
  if (texto(messages[r0]).includes(PREFIJO_PREGUNTA_ALCANCE_CANCELACION)) iPregunta = r0;
  else if (respuestas.length === 2 && texto(messages[r1]).includes(PREFIJO_PREGUNTA_ALCANCE_CANCELACION)) {
    const entre = messages.slice(r1 + 1, r0).filter((m) => m?.role === "user" && typeof m.content === "string");
    if (entre.length > 0 && entre.every((m) => esSiCortoAlAlcance(texto(m)))) iPregunta = r1;
  }
  if (iPregunta < 0) return null;
  for (let i = iPregunta; i >= inicioSesion; i--) {
    const m = messages[i];
    if (i !== iPregunta && m?.role !== "user") continue;
    const at = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(at)) {
      if (ahoraMs - at > PREGUNTA_ALCANCE_VIGENTE_MS) return null;
      break;
    }
  }
  return productoDePreguntaAlcance(texto(messages[iPregunta]));
}
/** «sí», «ok», «va», «sí por favor», «claro», «de acuerdo» (no dice el alcance ni otra cosa). Pura. */
function esSiCortoAlAlcance(texto: string): boolean {
  if (siNoDeUnaPalabra(texto) === "si") return true;
  const plano = normAviso(texto).replace(/[.!¡,]+/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:si|sip|ok|okay|va|vale|sale|dale|claro|aja|de\s+acuerdo|esta\s+bien|si\s+claro)(?:\s+(?:por\s+favor|porfa|porfavor))?$/.test(plano);
}
/** Revisión 32: tope (puntos de código) de una respuesta al alcance que se anexa al aviso. */
export const MAX_RESPUESTA_ALCANCE = 120;
/**
 * Revisión 32: ¿el texto PARECE una respuesta a la pregunta del alcance? Corto (MAX_RESPUESTA_ALCANCE) y: un «sí/no/ok»
 * corto, o «todo/completo/entero/solo/nomás/nada más», un verbo de cancelar o anular, o el producto de la pregunta. Lo
 * demás («dos tacos más», «mi dirección es…», «¿a qué hora llega?») no se copia al aviso. Pura.
 */
export function pareceRespuestaDeAlcance(texto: string, producto: string): boolean {
  return parteDeRespuestaDeAlcance(texto, producto) !== null;
}
/**
 * Revisión 34: la parte del texto que contesta la pregunta del alcance, o null. Sin dirección ni teléfono es el texto
 * entero (si parece respuesta). Con una dirección o un teléfono (R33-6: no se copian al aviso) se parte por comas y se
 * quitan los pedazos de dirección: lo que queda solo cuenta si nombra el producto o cancelar/anular («solo la coca,
 * Calle 60 #500 x 41» => «solo la coca»); un «solo/todo» suelto junto a una dirección es de la dirección («Calle 60 #500,
 * casa solo timbre azul», «Av. Itzáes 123, todo derecho»). Pura.
 */
export function parteDeRespuestaDeAlcance(texto: string, producto: string): string | null {
  const original = String(texto ?? "");
  if (Array.from(original).length > MAX_RESPUESTA_ALCANCE) return null;
  if (!pareceDireccionOTelefono(original)) return pareceRespuestaSinDireccion(original, producto) ? original : null;
  const pedazos = original.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
  const resto = pedazos.filter((p) => !pareceDireccionOTelefono(p));
  if (resto.length === pedazos.length) return null;
  const quedan = resto.filter((p) => {
    const plano = normAviso(p).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    if (/\b(?:frente|enfrente|junto|esquina|cerca|lado|atras|entre|porton|puerta|casa|timbre|fachada|edificio)\b/.test(plano)) return false;
    return pareceRespuestaSinDireccion(p, producto) && (nombraProductoDeAlcance(plano, producto) || /\b(?:cancel|anul)\w*/.test(plano));
  });
  return quedan.length > 0 ? quedan.join(", ") : null;
}
function pareceRespuestaSinDireccion(texto: string, producto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!plano) return false;
  if (esSiCortoAlAlcance(texto) || /^(?:no|nop|nel|no gracias)$/.test(plano)) return true;
  if (/\b(?:todo|toda|todito|completo|completa|entero|entera|solo|solamente|nomas|unicamente|nada mas|cancel\w*|anul\w*)\b/.test(plano)) return true;
  return nombraProductoDeAlcance(plano, producto);
}
/**
 * Revisión 33: ¿el texto es una dirección o un teléfono? «mi dirección/domicilio…», una tira de 8+ dígitos (teléfono), o
 * dígitos con una palabra de calle (calle, av., col., cp, fracc., #, «60 x 41»…). «todo, eran 2 tacos y 1 coca» no. Pura.
 */
function pareceDireccionOTelefono(texto: string): boolean {
  const n = normAviso(texto);
  if (/\bmi\s+(?:direccion|domicilio|ubicacion)\b/.test(n)) return true;
  if (/(?:\d[\s.-]?){8,}/.test(n)) return true;
  if (!/\d/.test(n)) return false;
  return /#|\d\s*x\s*\d|\b(?:calle|av|avenida|col|colonia|cp|c\.p|fracc\w*|fraccionamiento|num|numero|mz|manzana|lote|depto|privada|priv|carretera|km|esquina|cruzamientos?)\b/.test(n);
}
/** ¿El texto (ya plano: sin acentos, minúsculas, sin signos) nombra el producto de la pregunta del alcance? Pura. */
function nombraProductoDeAlcance(plano: string, producto: string): boolean {
  const palabras = normAviso(producto).replace(/[^a-z0-9 ]+/g, " ").split(" ")
    .filter((w) => w.length >= 3 && !/^(?:las|los|del|una|unas|unos|mis|sus)$/.test(w))
    .map((w) => (w.length > 4 ? w.replace(/e?s$/, "") : w));
  return palabras.some((w) => new RegExp(String.raw`\b${w}`).test(plano));
}
/**
 * Revisión 33: la respuesta al alcance que pide quitar SOLO el producto («solo la coca», «quítele la coca», «cancelo mi
 * coca», «la coca nada más», «nomás la coca, todo lo demás se queda»): nombra el producto, no dice «todo/completo» (salvo
 * «todo lo demás») ni «pedido/orden», y no lo niega («no, la coca no»). «todo menos la coca» sigue siendo «todo». Pura.
 */
export function esRespuestaSoloProducto(texto: string, producto: string): boolean {
  if (Array.from(String(texto ?? "")).length > MAX_RESPUESTA_ALCANCE) return false;
  const plano = normAviso(texto).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!plano || !nombraProductoDeAlcance(plano, producto)) return false;
  const sinDemas = plano.replace(/\b(?:todo|toda)\s+lo\s+demas\b|\btodo\s+(?:bien|normal)\b/g, " ");
  if (TODO_EL_PEDIDO.test(sinDemas) || /\b(?:pedido|orden)\b/.test(sinDemas)) return false;
  return !/\bno\s+(?:(?:la|el|las|los|mi|mis)\s+)?\w+\s+no\b|\bno\s*$/.test(plano);
}
/** Revisión 67 (R67-8): el inicio de una respuesta que dice que NO cancela, sin empezar por «no» (texto normalizado). */
const NO_CANCELA_INICIAL =
  /^(?:(?:mejor|siempre|ahorita|ahora|por\s+ahora|creo\s+que|pues)\s+no\b|todo\s+bien\b|olvid\w*|(?:asi\s+)?dejel[oa]\b|(?:asi\s+)?dejal[oa]\b|asi\s+esta\s+bien\b|(?:mejor\s+)?(?:lo\s+)?espero\b)/;
/** Revisión 56 (R56-1): el mensaje del aviso de baja prioridad (posible_baja_pedido). Pura. */
export function avisoPosibleBaja(textos: string[]): string {
  const dijo = citaDelCliente(textos.join(" / "), 600);
  return `POSIBLE CANCELACIÓN, SIN CONFIRMAR: el cliente escribió «${dijo}» con un pedido en curso; se le preguntó «${PREGUNTA_CONFIRMAR_CANCELACION}». Si contesta que sí, este aviso pasa a cancelación.`;
}
/** Revisión 68 (R68-3): la marca del «no cancela» anexado al aviso de baja. */
const MARCA_NO_CANCELA = "El cliente dijo que NO cancela";
/** Revisión 56 (R56-1): lo que se anexa al aviso de baja cuando el cliente contesta que no. Pura. */
export function avisoNoCancela(textos: string[]): string {
  const dijo = citaDelCliente(textos.join(" / "), 600);
  return `${MARCA_NO_CANCELA}: «${dijo}»`;
}
/** Revisión 33: encabezado del aviso de quitar un producto cuando aún no se sabe si cancela todo (R33-4). */
// Revisión 62 (R62-3): también sin otra petición («cancelo el pedido de la coca» solo).
export function encabezadoQuitarProductoSinConfirmar(producto: string, pideMas = true): string {
  return pideMas
    ? `Modificación: quitar ${producto} (en el mismo mensaje pide algo más; se le preguntó si cancela todo o solo eso)`
    : `Modificación: quitar ${producto} (se le preguntó si cancela todo o solo eso)`;
}
/** Revisión 33: respuesta fija cuando se avisa que el cliente quita un producto (no es cancelación). Pura. */
export function quitarProductoReply(producto: string): string {
  return `Entendido, ya le pasé a la sucursal que quiere quitar ${producto} de su pedido; ahí le confirman el cambio y el nuevo total.`;
}
/** Revisión 33: encabezado del aviso cuando el cliente solo quita un producto (lo primero que lee la sucursal). */
export function encabezadoQuitarProducto(producto: string): string {
  return `Modificación: quitar ${producto} (el cliente NO cancela todo el pedido)`;
}
/**
 * Revisión 34: la respuesta al alcance dice cancelar TODO el pedido («todo», «el pedido completo», «cancelo todo», «sí,
 * todo»): sin «todo lo demás / todo bien / todo normal» ni una excepción («todo menos la coca»). Pura.
 */
// Revisión 35: SOLO lo explícito. «es todo, gracias», «no, gracias, eso es todo», «todo bien» (la despedida de siempre)
// volvían el aviso de quitar la coca una cancelación de TODO el pedido. Cuentan: «cancel…/anul…» con «todo/pedido/orden»,
// «el pedido completo/entero» y «todo» o «sí, todo» como respuesta entera.
export function esCancelarTodoAlAlcance(texto: string): boolean {
  const plano = normAviso(texto).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const sinDemas = plano.replace(/\b(?:todo|toda)\s+lo\s+demas\b|\btodo\s+(?:bien|normal)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:menos|excepto|salvo|sin)\b/.test(sinDemas)) return false;
  if (/\bno\s+(?:(?:lo|la)\s+)?(?:cancel\w*|anul\w*|todo)\b/.test(sinDemas)) return false;
  if (/^(?:si\s+)?(?:todo|toda|todito)$/.test(sinDemas)) return true;
  if (/\b(?:cancel|anul)\w*\b.*\b(?:todo|toda|todito|(?:pedido|orden)\b(?!\s+de\b))/.test(sinDemas)) return true;
  return /\b(?:pedido|orden)\s+(?:complet|enter)[oa]\b/.test(sinDemas);
}
/** Revisión 34: encabezado del aviso cuando el cliente, tras pedir quitar un producto, contesta que cancela TODO. */
export function encabezadoCancelacionTodo(producto: string): string {
  return `CANCELACIÓN DE TODO EL PEDIDO (primero pidió quitar ${producto}; al preguntarle, contestó que cancela todo)`;
}
/** Revisión 34: lo que el modelo sabe cuando la respuesta al alcance volvió el aviso de quitar el producto una cancelación. */
function bloqueCancelacionTodoAlcance(pregunta: string, respuestas: string[]): string {
  const dijo = citaDelCliente(respuestas.join(" / "), 300);
  return `RESPUESTA A «${pregunta}»: el cliente contestó «${dijo}»: cancela TODO su pedido. El servidor YA cambió el aviso a la sucursal a CANCELACIÓN de todo el pedido, con sus palabras: no registre otro aviso por esto ni cancele ni cambie pedidos usted. Dígale en una frase que ya avisó a la sucursal de su cancelación y que, si aún no empezaban a prepararlo, ahí se la confirman.`;
}
/** Revisión 33: lo que el modelo sabe cuando la respuesta al alcance volvió el aviso de cancelación una modificación. */
function bloqueModificacionAlcance(pregunta: string, respuestas: string[], producto: string): string {
  const dijo = citaDelCliente(respuestas.join(" / "), 300);
  return `RESPUESTA A «${pregunta}»: el cliente contestó «${dijo}»: NO cancela todo su pedido, solo quiere quitar ${producto}. El servidor YA le pasó esa respuesta, tal cual, a la sucursal como MODIFICACIÓN del pedido (quitar ${producto}), ya no como cancelación: no registre otro aviso por esto, no cancele ni cambie pedidos por esto. Dígale en una frase que ya le pasó a la sucursal que quite ${producto} y que ahí le confirman el cambio y el nuevo total. Atienda cualquier otra cosa que pida.`;
}
/** Lo que el modelo sabe tras anexar la respuesta a la pregunta del alcance al aviso de cancelación. Pura. */
function bloqueAlcanceCancelacion(pregunta: string, respuestas: string[]): string {
  const dijo = citaDelCliente(respuestas.join(" / "), 300);
  return `RESPUESTA A «${pregunta}»: el cliente contestó «${dijo}». El servidor YA le pasó esa respuesta, tal cual, a la sucursal junto con el aviso de cancelación (no registre otro aviso por esto, no cancele ni cambie pedidos por esto). Si la respuesta no dice si es todo el pedido o solo ese producto, pregúntele una vez con sus palabras; si lo dice, dígale en una frase que ya le pasó ese detalle a la sucursal y que ella le confirma. Atienda cualquier otra cosa que pida.`;
}
/** La última respuesta del asistente trae PREGUNTA_CONFIRMAR_CANCELACION (o, R68-1, PREGUNTA_CANCELAR_EXPLICITA). */
export function preguntoSiCancelar(messages: readonly MensajeHilo[]): boolean {
  const ultima = ultimaRespuestaDelAsistente(messages);
  return [...PREGUNTAS_CANCELAR, ...PREGUNTAS_CANCELAR_EXPLICITAS].some((p) => ultima.includes(p));
}
/** Revisión 68 (R68-3): la última respuesta del asistente preguntó si cancela el anterior para hacer el pedido nuevo. */
function preguntoReemplazo(messages: readonly MensajeHilo[]): boolean {
  const ultima = ultimaRespuestaDelAsistente(messages);
  return ultima.includes(PREGUNTA_CANCELAR_REEMPLAZO) || ultima.includes(PREGUNTA_CANCELAR_REEMPLAZO_EXPLICITA);
}
/**
 * Revisión 71 (R71-3): los mensajes del cliente del turno ANTERIOR (antes de la última respuesta del asistente, sin
 * cruzar la sesión) piden un pedido nuevo (esPedidoNuevo).
 */
function turnoAnteriorPidioPedidoNuevo(messages: readonly MensajeHilo[]): boolean {
  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const m = messages[i];
    if (esMarcadorSesion(m)) return false;
    if (m?.role === "assistant" && typeof m.content === "string" && m.content.trim()) break;
  }
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j];
    if (esMarcadorSesion(m)) return false;
    if (m?.role === "assistant" && typeof m.content === "string" && m.content.trim()) return false;
    if (m?.role === "user" && typeof m.content === "string" && esPedidoNuevo(m.content)) return true;
  }
  return false;
}
/** Revisión 71 (R71-3): cambia la pregunta de cancelar a secas por la del reemplazo (la explícita por la suya). Pura. */
function conPreguntaDeReemplazo(texto: string): string {
  if (texto.includes(PREGUNTA_CANCELAR_REEMPLAZO) || texto.includes(PREGUNTA_CANCELAR_REEMPLAZO_EXPLICITA)) return texto;
  return texto.replace(PREGUNTA_CANCELAR_EXPLICITA, PREGUNTA_CANCELAR_REEMPLAZO_EXPLICITA)
    .replace(PREGUNTA_CONFIRMAR_CANCELACION, PREGUNTA_CANCELAR_REEMPLAZO);
}
/** Revisión 68 (R68-1): la última respuesta del asistente trae la pregunta de cancelar de respuesta explícita. */
function preguntoCancelarExplicito(messages: readonly MensajeHilo[]): boolean {
  const ultima = ultimaRespuestaDelAsistente(messages);
  return PREGUNTAS_CANCELAR_EXPLICITAS.some((p) => ultima.includes(p));
}
/**
 * Revisión 57 (R57-2): la última respuesta del asistente (la pregunta de cancelar) tiene a lo más
 * VENTANA_CONFIRMA_CANCELACION_MIN: su hora o, si no la trae, la del último mensaje del cliente antes de ella. Sin hora
 * conocida: vigente (como antes).
 */
function preguntaCancelarVigente(messages: readonly MensajeHilo[], ahoraMs: number): boolean {
  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const m = messages[i];
    if (esMarcadorSesion(m)) return true;
    if (m?.role === "assistant" && typeof m.content === "string" && m.content.trim()) break;
  }
  for (let j = i; j >= 0; j--) {
    const m = messages[j];
    if (esMarcadorSesion(m)) break;
    if (j !== i && m?.role !== "user") continue;
    const at = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(at)) return ahoraMs - at <= VENTANA_CONFIRMA_CANCELACION_MIN * 60_000;
  }
  return true;
}
/**
 * Revisión 67 (R67-1): un «sí» explícito suelto, a lo más con cortesía: «sí», «si», «sí, gracias», «sí por favor», «sí,
 * porfa». No los suaves («claro», «va», «ok»), ni con pregunta o algo más. Pura.
 */
export function esSiExplicitoSolo(texto: string): boolean {
  if (/[¿?]/.test(String(texto ?? ""))) return false;
  const plano = normAviso(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:pues\s+)?si+(?:\s+(?:muchas\s+|mil\s+)?(?:gracias|por\s+favor|porfa|porfavor|xfa|pues))*$/.test(plano);
}
/** Revisión 67 (R67-1): lo que el modelo sabe cuando un «sí» suelto no confirmó la cancelación. */
const BLOQUE_SI_SIN_CONFIRMAR_CANCELACION =
  `POSIBLE CANCELACIÓN PENDIENTE: hay una posible cancelación pendiente de este cliente y su «sí» no quedó claro como respuesta a ella (puede contestar otra pregunta). NO dé el pedido por cancelado ni avise una cancelación (no llame a registrar_contacto por esto). Si el cliente quiere cancelar, pregúntele de nuevo exactamente: «${PREGUNTA_CONFIRMAR_CANCELACION}». Atienda cualquier otra cosa que pida.`;
/** Revisión 80 (R80-4): una pregunta de cancelar que ofrece quedarse con el pedido o la plantea en negativo. Texto sin acentos. */
const RETENCION_EN_PREGUNTA_CANCELAR =
  /^(?:(?:y|pero|entonces|bueno|ok)\s+)?no\b|\b(?:prefier\w*|en\s+vez|en\s+lugar|mas\s+tarde|luego|despues|mejor|cambi\w*|esper\w*|reprogram\w*|otr[oa]\s+(?:dia|hora|momento)|manana|mand\w*|envi\w*|llev\w*|guard\w*|aplaz\w*|pospon\w*)\b/;
/** Revisión 50: en la última respuesta del asistente no hay otra pregunta («?») fuera de PREGUNTA_CONFIRMAR_CANCELACION. */
function preguntaCancelarEsLaUnica(messages: readonly MensajeHilo[]): boolean {
  const ultima = ultimaRespuestaDelAsistente(messages);
  // Revisión 68 (R68-1): con la versión explícita nunca es la única (va junto a otra pregunta). Revisión 79 (R79-E): salvo
  // que esa otra pregunta del modelo TAMBIÉN sea si cancela («Sí, todavía puede. ¿Desea cancelarlo?»), sin alternativa
  // («¿… o prefiere cambiar la hora?»): entonces el «sí» solo puede contestar eso.
  if (PREGUNTAS_CANCELAR_EXPLICITAS.some((p) => ultima.includes(p))) {
    const resto = [...PREGUNTAS_CANCELAR, ...PREGUNTAS_CANCELAR_EXPLICITAS].reduce((x, p) => x.split(p).join(" "), ultima);
    const preguntas = resto.match(/¿[^?¿]*\?|[^.!?¿\n]*\?/g) ?? [];
    // Revisión 80 (R80-4): y sin retención ni alternativa negada («¿No prefiere…?», «¿en vez de cancelarlo?», «… más tarde»).
    return preguntas.length > 0 && preguntas.every((q) => {
      const n = normAviso(q).replace(/[¿?]/g, " ").replace(/\s+/g, " ").trim();
      return /\b(?:cancel|anul)\w*/.test(n) && !/(?:^|\s)[ou]\s/.test(n) && !RETENCION_EN_PREGUNTA_CANCELAR.test(n);
    });
  }
  return !PREGUNTAS_CANCELAR.reduce((x, p) => x.split(p).join(" "), ultima).includes("?");
}
/** Lo que el modelo sabe del aviso de cancelación ya registrado en este turno (cancelacionConOtraPeticion). */
function bloqueCancelacionYaAvisada(respuesta: string): string {
  return `AVISO YA REGISTRADO EN ESTE TURNO: el cliente pidió cancelar su pedido y en este mismo mensaje pide algo más. El aviso de cancelación ya quedó registrado y el cliente ya recibe este texto antes de tu respuesta: «${respuesta}». No vuelvas a avisar la cancelación (no llames a registrar_contacto por ella) ni repitas ese texto; atiende SOLO lo demás que pide el cliente.`;
}
/** Revisión 70 (R70-3): la cancelación se pidió y se retiró en la misma ráfaga, que además pide algo más. Pura. */
function bloqueCancelacionRetiradaEnRafaga(respuesta: string, dijo: string): string {
  const corto = citaDelCliente(dijo, 300);
  return `CANCELACIÓN RETIRADA EN ESTE TURNO: el cliente pidió cancelar y en la misma ráfaga se retractó («${corto}»): NO quiere cancelar, su pedido sigue. No se avisó ninguna cancelación y el cliente ya recibe este texto antes de tu respuesta: «${respuesta}». No registres ni menciones una cancelación (no llames a registrar_contacto por esto), no repitas ese texto; atiende SOLO lo demás que pide el cliente.`;
}
/** Revisión 33: lo que el modelo sabe cuando el cliente retiró la cancelación y en la misma ráfaga pide algo más. Pura. */
function bloqueRetractacionYaAvisada(respuesta: string, retiro: string): string {
  const dijo = citaDelCliente(retiro, 300);
  return `RETRACTACIÓN YA AVISADA EN ESTE TURNO: el cliente retiró la cancelación que había pedido («${dijo}»): NO quiere cancelar, prefiere esperar su pedido. El servidor ya le anotó a la sucursal que el cliente retiró la cancelación y el cliente ya recibe este texto antes de tu respuesta: «${respuesta}». No registres ni menciones otra cancelación, no repitas ese texto; atiende SOLO lo demás que pide el cliente.`;
}
export const CANCELACION_SIN_PEDIDO_REPLY =
  "Entendido, no tengo ningún pedido suyo en curso, así que no hay nada que cancelar. Si más adelante desea ordenar, con gusto le atiendo.";
/** Revisión 91 (R91-6): las respuestas fijas de la cancelación en inglés, para el cliente que escribe en inglés. */
export const CANCELACION_SIN_PEDIDO_REPLY_EN =
  "Understood, I don't have any current order of yours, so there's nothing to cancel. If you'd like to order later, I'm happy to help.";
export const CANCELACION_REPLY_EN =
  `Understood, I've let the branch know of your cancellation. If we haven't started preparing it yet (roughly the first ${CANCELACION_VENTANA_MIN} minutes) it's cancelled at no charge; if it's already being prepared or out for delivery, the branch will confirm what can be done.`;
export const RETRACTACION_CANCELACION_REPLY_EN =
  "Understood, I've let the branch know you'd rather wait and not cancel your order. Thanks for your patience.";
export const RETRACTACION_SI_LO_QUIERE_REPLY_EN = "Great, your order is still on; I've let the branch know.";
/** Revisión 87 (R87-V): el texto sin las oraciones que acusan la cancelación («ya avisé … cancelar/cancelación»). Pura. */
export function sinAcuseDeCancelacion(texto: string): string {
  return String(texto ?? "")
    .split(/(?<=[.!?])\s+/)
    .filter((o) => !/\bcancel/.test(normAviso(o)) || !/\b(?:avise|avisado|aviso|registr|pase|pasado|entendido|listo)/.test(normAviso(o)))
    .join(" ")
    .trim();
}

/**
 * La entrada «cancelacion» de HIGH_RISK_PATTERNS del núcleo (canal WhatsApp): el texto plano con las erratas corregidas
 * (corregirTyposCancelar), neutralizado (neutralizarCancelacion) y probado contra PATRON_CANCELACION_PEDIDO. Es lo que en
 * el núcleo hace `classifyHighRiskIntent(t)?.intent === "cancelacion"` cuando ninguna regla de mayor prioridad (pago ya
 * transferido) gana. Pura.
 */
export function esPeticionDeCancelar(texto: string, opciones: OpcionesCancelacion = {}): boolean {
  const plano = corregirTyposCancelar(String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase());
  return PATRON_CANCELACION_PEDIDO.test(neutralizarCancelacion(plano, opciones));
}

// ------------------------------------------------------------------ mensajes puros de los avisos (las escrituras del núcleo)

/** Respuesta del cliente a la pregunta del alcance, tal cual se anexa al aviso (anexarRespuestaAlcance). Pura. */
export function detalleRespuestaAlcance(pregunta: string, respuestas: readonly string[]): string {
  return sinControles(`Respuesta del cliente a «${pregunta}»: «${respuestas.map((r) => citaDelCliente(r, TOPE_MENSAJE_AVISO)).join(" / ")}»`)
    .replace(/\s+/g, " ").trim();
}

/**
 * Revisión 56 (R56-1) / R70-7: el mensaje con que el aviso de baja ABIERTO (posible_baja_pedido) pasa a
 * alto_riesgo:cancelacion (elevarPosibleBajaACancelacion): encabezado de la confirmación, el cuerpo previo sin «POSIBLE
 * CANCELACIÓN, SIN CONFIRMAR» ni su «Si contesta que sí…», y lo nuevo. null si no cabe (el núcleo registra la cancelación
 * como siempre). Pura.
 */
export function mensajeCancelacionConfirmada(mensajePrevio: string, nuevo: string): string | null {
  const encabezado = "CANCELACIÓN CONFIRMADA por el cliente (antes: posible cancelación sin confirmar)";
  const n = String(nuevo ?? "").trim();
  const previo = String(mensajePrevio ?? "")
    .replace(/POSIBLE CANCELACIÓN, SIN CONFIRMAR:\s*/g, "")
    .replace(/\s*Si contesta que sí, este aviso pasa a cancelación\./g, "")
    .trim();
  const sitio = TOPE_MENSAJE_AVISO - encabezado.length - n.length - 10;
  if (sitio < 0) return null;
  const cuerpo = previo.length <= sitio ? previo : previo.slice(previo.length - sitio);
  return hastaPuntosDeCodigo(`${encabezado}\n${cuerpo}\n---\n${n}`, TOPE_MENSAJE_AVISO);
}

/**
 * Revisión 57 (R57-1): el mensaje con que el aviso de baja ABIERTO pasa a modificacion_pedido tras «sí, quita la coca»
 * (convertirPosibleBajaEnModificacion). null si no cabe. Pura.
 */
export function mensajeModificacionDesdePosibleBaja(mensajePrevio: string, textos: readonly string[]): string | null {
  const encabezado = "Modificación: quitar o cambiar un producto (el cliente NO cancela todo el pedido; antes: posible cancelación sin confirmar)";
  const nuevo = `modificación: «${citaDelCliente(textos.join(" / "), 600)}»`;
  const previo = String(mensajePrevio ?? "").trim();
  const sitio = TOPE_MENSAJE_AVISO - encabezado.length - nuevo.length - 10;
  if (sitio < 0) return null;
  const cuerpo = previo.length <= sitio ? previo : previo.slice(previo.length - sitio);
  return hastaPuntosDeCodigo(`${encabezado}\n${cuerpo}\n---\n${nuevo}`, TOPE_MENSAJE_AVISO);
}

/**
 * Revisión 33: el aviso de cancelación ABIERTO pasa a modificación cuando la respuesta al alcance nombra solo el producto
 * (convertirCancelacionEnModificacion). Pura.
 */
export function mensajeModificacionDesdeCancelacion(mensajePrevio: string, producto: string, pregunta: string, respuestas: readonly string[]): string {
  const detalle = detalleRespuestaAlcance(pregunta, respuestas);
  const encabezado = encabezadoQuitarProducto(producto);
  const sitio = TOPE_MENSAJE_AVISO - encabezado.length - detalle.length - 10;
  const previo = String(mensajePrevio ?? "").trim();
  const cuerpo = previo.length <= sitio ? previo : previo.slice(previo.length - Math.max(0, sitio));
  return hastaPuntosDeCodigo(`${encabezado}\n${cuerpo}\n---\n${detalle}`, TOPE_MENSAJE_AVISO);
}

/**
 * Revisión 34: el aviso ABIERTO de quitar el producto pasa a cancelación cuando la respuesta al alcance dice «todo»
 * (convertirModificacionEnCancelacion). null si ese aviso no empieza con el encabezado de quitar sin confirmar. Pura.
 */
export function mensajeCancelacionTodoDesdeModificacion(
  mensajePrevio: string,
  producto: string,
  pregunta: string,
  respuestas: readonly string[],
): string | null {
  const previo = String(mensajePrevio ?? "").trim();
  if (![true, false].some((pideMas) => previo.startsWith(encabezadoQuitarProductoSinConfirmar(producto, pideMas)))) return null;
  const detalle = detalleRespuestaAlcance(pregunta, respuestas);
  const encabezado = encabezadoCancelacionTodo(producto);
  const sinEncabezado = previo.split("\n").slice(1).join("\n").trim();
  const sitio = TOPE_MENSAJE_AVISO - encabezado.length - detalle.length - 10;
  const cuerpo = sinEncabezado.length <= sitio ? sinEncabezado : sinEncabezado.slice(sinEncabezado.length - Math.max(0, sitio));
  return hastaPuntosDeCodigo(`${encabezado}\n${cuerpo}\n---\n${detalle}`, TOPE_MENSAJE_AVISO);
}

/** Revisión 93 (R93-2): la nota que se anexa al aviso de cancelación cuando el cliente duda («sí lo quiero, pero mañana»). Pura. */
export function mensajeClienteDuda(dudas: readonly string[], yaPreguntado: boolean): string {
  return `EL CLIENTE DUDA: ${dudas.join(" / ")}; ${yaPreguntado ? "ya se le había preguntado" : "se le preguntó"} si mantiene o cancela`;
}

/** Revisión 33: lo que se anexa al aviso de cancelación cuando el cliente la retira. Pura. */
export function mensajeRetractacion(retiros: readonly string[]): string {
  return `RETRACTACIÓN: el cliente retiró la cancelación (no cancelar, prefiere esperar): ${retiros.join(" / ")}`;
}


// ------------------------------------------------------------------ decisión del turno (resumen de runAgentTurn)

/** Lo que hace el servidor con los avisos de la sucursal (callback_requests). */
export interface OperacionAviso {
  /**
   * - crear: fila nueva (con su deduplicación de siempre).
   * - anexar: agrega `mensaje` a la fila ABIERTA de `motivo` (nunca crea una; sin fila, no pasa nada).
   * - cancelar: la cancelación confirmada o pedida. Si hay un posible_baja abierto, se ELEVA en la misma fila
   *   (mensajeCancelacionConfirmada + alerta inmediata); si no, se anexa a la cancelación abierta (contestando nuestro
   *   mensaje, ventana VENTANA_CONFIRMA_CANCELACION_MIN) o se crea.
   * - convertir: la fila abierta de `motivo` cambia a `motivoNuevo` con `mensaje` como lo nuevo (ver los mensaje* puros).
   */
  readonly operacion: "crear" | "anexar" | "cancelar" | "convertir";
  readonly motivo: string;
  readonly motivoNuevo?: string;
  readonly mensaje: string;
  /** Ventana (min) para buscar la fila abierta, si no es la de siempre (30). */
  readonly ventanaMin?: number;
  /** Encabezado que va antes del mensaje (convertir). */
  readonly encabezado?: string;
}

export type AccionCancelacion =
  | "nada"
  | "avisar_cancelacion"
  | "sin_pedido"
  | "avisar_posible_baja"
  | "cancelacion_ya_pedida"
  | "retirar_cancelacion"
  | "preguntar_mantener_o_cancelar"
  | "cancelacion_sigue"
  | "preguntar_alcance"
  | "respuesta_alcance"
  | "reemplazo"
  | "al_modelo_con_nota";

export interface DecisionCancelacion {
  readonly accion: AccionCancelacion;
  /** Respuesta fija (si `alModelo` es false) o el prefijo que va antes de la respuesta del modelo (si es true). */
  readonly respuesta: string | null;
  /** El turno sigue al modelo (con `nota`); `respuesta`, si la hay, va delante. */
  readonly alModelo: boolean;
  /** Bloque para el prompt del modelo (lo que el servidor ya hizo y lo que el modelo NO debe hacer). */
  readonly nota: string | null;
  /**
   * La pregunta que el servidor agrega al final de la respuesta del modelo si no la trae (conPreguntaCancelar con esta
   * pregunta): PREGUNTA_CONFIRMAR_CANCELACION o PREGUNTA_CANCELAR_REEMPLAZO. null: nada que agregar.
   */
  readonly preguntaAlFinal: string | null;
  /** Escrituras a la sucursal, en orden. */
  readonly avisos: readonly OperacionAviso[];
  /** Lo que pidió el brief: el motivo y el texto del primer aviso (o null). */
  readonly motivoAviso: string | null;
  readonly textoAviso: string | null;
}

export interface ContextoCancelacion {
  /** El hilo ANTES de la ráfaga (role/content; `at` ISO y el marcador de sesión si los hay). */
  readonly mensajes: readonly MensajeHilo[];
  /** ¿El cliente tiene un pedido vivo (estado abierto)? null = la consulta falló (el núcleo trata eso como vivo, salvo donde se indica). */
  readonly pedidoVivo: boolean | null;
  /** Hora del turno (ms). */
  readonly ahoraMs: number;
  /** ¿Hay un aviso alto_riesgo:cancelacion ABIERTO de este cliente (desde su pedido abierto)? */
  readonly cancelacionAbierta?: boolean;
  /** ¿Hay un aviso posible_baja_pedido ABIERTO (ventana VENTANA_CONFIRMA_CANCELACION_MIN)? */
  readonly posibleBajaAbierta?: boolean;
  /** ¿Hay un aviso modificacion_pedido ABIERTO (quitar el producto, tras la pregunta del alcance)? */
  readonly modificacionAbierta?: boolean;
  /** El carrito a medias (hayPedidoEnCurso del núcleo). */
  readonly carritoEnCurso?: boolean;
  readonly variosPedidosVivos?: boolean;
  /** El cliente escribe en inglés (esTextoEnIngles del núcleo, otro bloque). */
  readonly ingles?: boolean;
  /**
   * Otro intent de alto riesgo del texto que NO es la cancelación (reclamo_pedido, alergia, cobro…; el clasificador del
   * monorrepo), o null. Sin él se supone que no hay otro riesgo.
   */
  readonly otroRiesgo?: (texto: string) => string | null;
  /** El clasificador de alergias real (declaraAlergia); sin él, mencionaAlergia. */
  readonly declaraAlergia?: (texto: string) => boolean;
  /** Ventana de la política de cancelación (min) para la respuesta fija. */
  readonly ventanaMin?: number;
}

function decision(
  accion: AccionCancelacion,
  partes: Partial<Omit<DecisionCancelacion, "accion" | "motivoAviso" | "textoAviso">> = {},
): DecisionCancelacion {
  const avisos = partes.avisos ?? [];
  return {
    accion,
    respuesta: partes.respuesta ?? null,
    alModelo: partes.alModelo ?? false,
    nota: partes.nota ?? null,
    preguntaAlFinal: partes.preguntaAlFinal ?? null,
    avisos,
    motivoAviso: avisos[0]?.motivo ?? null,
    textoAviso: avisos[0]?.mensaje ?? null,
  };
}

const juntarNotas = (...notas: Array<string | null | undefined>): string | null => {
  const n = notas.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return n.length > 0 ? n.join("\n\n") : null;
};

/**
 * La decisión de cancelación del turno de WhatsApp, en el MISMO orden que runAgentTurn del núcleo (líneas ~6582–7545):
 *  1. «sí» a «¿Quiere cancelar su pedido?» (vigente 3 h; la ráfaga unida) → la cancelación confirmada (marca SUFIJO).
 *  2. La pregunta del alcance pendiente: repreguntar un «sí» suelto, o anexar / convertir la respuesta.
 *  3. «sí, quita la coca» a la pregunta → la posible baja pasa a modificación.
 *  4. Cada petición de cancelar: sin pedido vivo; «ya no lo quiero» suelto (posible baja); retirada en el mismo mensaje o
 *     en la ráfaga; «no, cancelo» tras «¿Algo más?» (pregunta fija); producto ambiguo (pregunta del alcance).
 *  5. «no…» a «¿Quiere cancelar…?» → se anexa a la posible baja.
 *  6. «ya no lo quiero» con motivo / demora / «ya no lo mande» suelto / reprogramar tras la pregunta → posible baja.
 *  7. Cancelar dentro de una pregunta o dudoso → posible baja.  8. «ya no lo quiero» + pedido nuevo → reemplazo.
 *  9. Retractación, «mantengo o cancelo», «la cancelación sigue».  10. Pregunta fija.  11. Sin pedido.
 * 12. Aviso de cancelación (respuesta fija o prefijo + modelo).  13. Posible baja: respuesta fija o pregunta al final.
 * No cubre lo que es de otros bloques: quitar un producto por nombre (esQuitarProductoExplicito, necesita el pedido), la
 * respuesta de varios avisos ni la de alergia/salud. Pura.
 */
export function decidirCancelacion(pendientes: readonly string[], ctx: ContextoCancelacion): DecisionCancelacion {
  const textos = pendientes.filter((t) => typeof t === "string" && t.trim() !== "");
  if (textos.length === 0) return decision("nada");
  const m = ctx.mensajes;
  const ahora = ctx.ahoraMs;
  const alergia = ctx.declaraAlergia ?? mencionaAlergia;
  const otroRiesgo = (t: string) => ctx.otroRiesgo?.(t) ?? null;
  const op: OpcionesCancelacion = {
    pedidoEnCurso: ctx.carritoEnCurso === true,
    extrasOfrecidos: extrasOfrecidos(ultimaRespuestaDelAsistente(m)),
    variosPedidosVivos: ctx.variosPedidosVivos === true,
  };
  const vivo = ctx.pedidoVivo !== false;
  const avisos: OperacionAviso[] = [];
  const pregunto = preguntoSiCancelar(m);

  // 1. Revisión 26/39/42/50/57/58/68: la respuesta a «¿Quiere cancelar su pedido?».
  const confirma = (t: string) =>
    esSiQueConfirmaCancelar(t, preguntaCancelarEsLaUnica(m), alergia) || (esYaNoLoQuieroConMotivo(t) && !esReprogramaORecoge(t)) ||
    esYaNoLoMandeSuelto(t);
  const contesta = pregunto && preguntaCancelarVigente(m, ahora);
  const unida = contesta && textos.length > 1 ? textos.join(", ") : null;
  const rafagaNoConfirma = unida !== null && !confirma(unida) && textos.some((t) => !confirma(t));
  const textosRiesgo = textos.map((t) => (contesta && !rafagaNoConfirma && confirma(t) ? `${t}${SUFIJO_CONFIRMA_CANCELACION}` : t));
  // Revisión 67 (R67-1): un «sí» suelto que NO confirma: el modelo vuelve a preguntar.
  let notaSiSinConfirmar: string | null = null;
  if (
    pregunto && textos.some((t) => esSiExplicitoSolo(t)) && textos.every((t) => esSiExplicitoSolo(t) || esCortesiaSola(t)) &&
    !textosRiesgo.some((t) => t.endsWith(SUFIJO_CONFIRMA_CANCELACION))
  ) notaSiSinConfirmar = BLOQUE_SI_SIN_CONFIRMAR_CANCELACION;

  // 2. Revisión 32/33/34: la respuesta a «¿Quiere cancelar todo su pedido o solo …?».
  const productoAlcance = preguntaAlcancePendiente(m, ahora);
  const contexto = productoAlcance !== null || contextoDeAvisoDeCancelacion(m);
  const esRetiro = (t: string) => esRetractacionEnContexto(t, contexto);
  let anexados: string[] = [];
  let notaAlcance: string | null = null;
  if (productoAlcance) {
    const pregunta = preguntaAlcanceCancelacion(productoAlcance);
    const ultima = ultimaRespuestaDelAsistente(m);
    if (ultima.includes(PREFIJO_PREGUNTA_ALCANCE_CANCELACION) && !ultima.startsWith(REPREGUNTA_ALCANCE_PREFIJO) && textos.every((t) => esSiCortoAlAlcance(t))) {
      return decision("preguntar_alcance", { respuesta: `${REPREGUNTA_ALCANCE_PREFIJO}${pregunta}` });
    }
    const pares = textos
      .map((t) => ({ t, parte: esRetiro(t) ? null : parteDeRespuestaDeAlcance(t, productoAlcance) }))
      .filter((x): x is { t: string; parte: string } => x.parte !== null);
    const respuestas = pares.map((x) => x.parte);
    const originales = pares.map((x) => x.t);
    const soloProducto = respuestas.length > 0 && respuestas.some((t) => esRespuestaSoloProducto(t, productoAlcance)) &&
      !respuestas.some((t) => TODO_EL_PEDIDO.test(normAviso(t).replace(/\b(?:todo|toda)\s+lo\s+demas\b|\btodo\s+(?:bien|normal)\b/g, " ")));
    const cancelaTodo = !soloProducto && respuestas.length > 0 && respuestas.some((t) => esCancelarTodoAlAlcance(t));
    const detalle = respuestas.length > 0 ? detalleRespuestaAlcance(pregunta, respuestas) : "";
    if (cancelaTodo && ctx.modificacionAbierta) {
      avisos.push({ operacion: "convertir", motivo: RAZON_MODIFICACION_PEDIDO, motivoNuevo: RAZON_CANCELACION, mensaje: detalle, encabezado: encabezadoCancelacionTodo(productoAlcance) });
      anexados = originales;
      notaAlcance = bloqueCancelacionTodoAlcance(pregunta, respuestas);
    } else if (soloProducto && (ctx.cancelacionAbierta || ctx.modificacionAbierta)) {
      avisos.push(ctx.cancelacionAbierta
        ? { operacion: "convertir", motivo: RAZON_CANCELACION, motivoNuevo: RAZON_MODIFICACION_PEDIDO, mensaje: detalle, encabezado: encabezadoQuitarProducto(productoAlcance) }
        : { operacion: "anexar", motivo: RAZON_MODIFICACION_PEDIDO, mensaje: detalle });
      anexados = originales;
      notaAlcance = bloqueModificacionAlcance(pregunta, respuestas, productoAlcance);
    } else if (respuestas.length > 0 && (ctx.cancelacionAbierta || ctx.modificacionAbierta)) {
      avisos.push({ operacion: "anexar", motivo: ctx.cancelacionAbierta ? RAZON_CANCELACION : RAZON_MODIFICACION_PEDIDO, mensaje: detalle });
      anexados = originales;
      notaAlcance = bloqueAlcanceCancelacion(pregunta, respuestas);
    }
  }

  // 3. Revisión 57/58 (R57-1, R58-1): «sí, quita la coca» a «¿Quiere cancelar su pedido?».
  let notaCambio: string | null = null;
  if (pregunto) {
    const cambiosTrasSi = textos.filter((t) => !anexados.includes(t) && esSiConCambioDeProducto(t));
    const cambioEnRafaga = cambiosTrasSi.length === 0 && rafagaNoConfirma && anexados.length === 0 && unida !== null &&
      esSiConCambioDeProducto(unida);
    if (cambioEnRafaga && unida !== null) cambiosTrasSi.push(unida);
    if (cambiosTrasSi.length > 0) {
      if (ctx.posibleBajaAbierta) {
        avisos.push({
          operacion: "convertir",
          motivo: RAZON_POSIBLE_BAJA,
          motivoNuevo: RAZON_MODIFICACION_PEDIDO,
          mensaje: `modificación: «${citaDelCliente(cambiosTrasSi.join(" / "), 600)}»`,
          encabezado: "Modificación: quitar o cambiar un producto (el cliente NO cancela todo el pedido; antes: posible cancelación sin confirmar)",
          ventanaMin: VENTANA_CONFIRMA_CANCELACION_MIN,
        });
        anexados = [...anexados, ...cambiosTrasSi, ...(cambioEnRafaga ? textos : [])];
        notaCambio = bloqueCambioTrasSiYaAvisado(cambiosTrasSi);
      } else {
        notaCambio = bloqueCambioDeProducto(cambiosTrasSi);
      }
    }
  }

  // 4. Las peticiones de cancelar de la ráfaga.
  let preguntarSiCancela = false;
  let cancelacionSinPedido = false;
  let alcanceAmbiguo: string | null = null;
  let notaYaNoLoQuiero: string | null = null;
  let posibleBaja: string[] = [];
  const canceladasRetiradas: string[] = [];
  const retirosEnRafaga: string[] = [];
  const cancelaciones: string[] = [];
  for (const [i, t] of textosRiesgo.entries()) {
    if (!esPeticionDeCancelar(t, op) || anexados.includes(t)) continue;
    if (ctx.pedidoVivo === false) {
      // Cancelación condicional o con un pedido nuevo en el mismo mensaje: va al modelo, no se corta.
      if (!esCancelacionMixta(t) && !cancelacionConOtraPeticion(t)) cancelacionSinPedido = true;
      continue;
    }
    // Revisión 35/37: «ya no lo quiero» suelto es ambiguo; contestando una oferta es un «no» a lo ofrecido.
    if (esYaNoLoQuieroSuelto(t) && !pregunto) {
      if (ofrecioAgregarAlgo(m)) continue;
      if (ctx.pedidoVivo !== null) {
        notaYaNoLoQuiero = bloqueYaNoLoQuieroAmbiguo(t);
        posibleBaja.push(t);
        continue;
      }
    }
    // Revisión 71 (R71-5e): «cancelen mi pedido, mejor no, ya llega» en UN mensaje.
    const original = textos[i] ?? t;
    if (retiraCancelacionEnElMismoMensaje(t)) {
      canceladasRetiradas.push(original);
      if (!retirosEnRafaga.includes(original)) retirosEnRafaga.push(original);
      continue;
    }
    // Revisión 70 (R70-3): «cancelen mi pedido» + «mejor no, ya llega» en la misma ráfaga.
    const retiroPosterior = textos.slice(i + 1).filter((x) => retiraCancelacionEnRafaga(x) && !esPeticionDeCancelar(x, op));
    if (retiroPosterior.length > 0) {
      canceladasRetiradas.push(original);
      for (const x of retiroPosterior) if (!retirosEnRafaga.includes(x)) retirosEnRafaga.push(x);
      continue;
    }
    // Revisión 26: «no, cancelo» tras «¿Algo más?» es ambiguo: se pregunta antes de avisar.
    if (esNoCanceloTrasAlgoMas(t, m)) {
      preguntarSiCancela = true;
      posibleBaja.push(t);
      continue;
    }
    // Revisión 32: «cancelo el pedido de la coca»: aviso YA y después la pregunta del alcance.
    alcanceAmbiguo ??= productoDeCancelacionAmbigua(t);
    cancelaciones.push(t);
  }
  const hayCancelacion = cancelaciones.length > 0;
  const highRisk = hayCancelacion || textos.some((t) => otroRiesgo(t) !== null);

  // 5. Revisión 56/67/68/69: un «no…» a «¿Quiere cancelar su pedido?» se anexa al aviso de baja abierto.
  let noCancelaEnTurno = false;
  if (pregunto && !hayCancelacion) {
    const explicita = preguntoCancelarExplicito(m);
    const noes = textos.filter((t) =>
      (/^(?:no|nel|nop|nope|nah)\b/.test(normAviso(t).replace(/^[^a-z0-9ñ]+/, "")) ||
        (!explicita && NO_CANCELA_INICIAL.test(normAviso(t).replace(/^[^a-z0-9ñ]+/, ""))) ||
        esRetractacionDeCancelacion(t)) && !traeYaNoLoQuiero(t)
    );
    if (noes.length > 0) {
      noCancelaEnTurno = true;
      avisos.push({ operacion: "anexar", motivo: RAZON_POSIBLE_BAJA, mensaje: avisoNoCancela(noes), ventanaMin: VENTANA_CONFIRMA_CANCELACION_MIN });
    }
  }

  // Revisión 36/56: «ya no lo quiero, cámbielo por agua», «ya no mande el pedido, mejor 2 tacos»: cambio, no cancelación.
  if (!hayCancelacion) {
    const cambios = textos.filter((t) => !anexados.includes(t) && esCambioDeProductoYaNoQuiero(t));
    const cambiosEntrega = textos.filter((t) => !anexados.includes(t) && !cambios.includes(t) && esYaNoLoMandeConCambio(t));
    if ((cambios.length > 0 || cambiosEntrega.length > 0) && vivo) {
      notaCambio = juntarNotas(
        notaCambio,
        cambios.length > 0 ? bloqueCambioDeProducto(cambios) : null,
        cambiosEntrega.length > 0 ? bloqueModificacionYaNoLoMande(cambiosEntrega) : null,
      );
    }
  }

  // 6. Revisión 38/39/40/41/53: «ya no lo quiero» con motivo, la demora en otra burbuja, «ya no lo mande» suelto.
  let demoraAvisada = false;
  let demorasDeLaRafaga: string[] = [];
  if (!pregunto) {
    const conMotivo = textos.filter((t) => !anexados.includes(t) && esYaNoLoQuieroConMotivo(t) && !cancelaciones.includes(t));
    const yaNoEnRafaga = !cancelaciones.some((t) => !esYaNoLoQuieroSuelto(t)) &&
      textos.some((t) => !anexados.includes(t) && (esYaNoLoQuieroSuelto(t) || esYaNoLoMandeSuelto(t) || esYaNoLoQuieroConMotivo(t)));
    const demorasSueltas = yaNoEnRafaga
      ? textos.filter((t) =>
        !anexados.includes(t) && !conMotivo.includes(t) && esQuejaDeDemora(t) && !esYaNoLoQuieroSuelto(t) &&
        !esYaNoLoMandeSuelto(t) && otroRiesgo(t) === null && !cancelaciones.includes(t)
      )
      : [];
    const ambiguos = demorasSueltas.length > 0
      ? textos.filter((t) =>
        conMotivo.includes(t) || demorasSueltas.includes(t) || (!anexados.includes(t) && (esYaNoLoQuieroSuelto(t) || esYaNoLoMandeSuelto(t)))
      )
      : conMotivo;
    if (ambiguos.length > 0) {
      // El reclamo de la demora, con cualquier pedido reciente (aquí: con pedido vivo conocido).
      const demoras = ctx.pedidoVivo === true
        ? textos.filter((t) => demorasSueltas.includes(t) || (conMotivo.includes(t) && esQuejaDeDemora(t) && otroRiesgo(t) === null))
        : [];
      if (demoras.length > 0) {
        avisos.push({ operacion: "crear", motivo: RAZON_RECLAMO_PEDIDO, mensaje: demoras.join("\n") });
        demoraAvisada = true;
      }
      const rechazaOferta = ofrecioAgregarAlgo(m) && conMotivo.every((t) => /^no\b/.test(normAviso(t)));
      if (vivo && (!rechazaOferta || demoraAvisada)) {
        notaYaNoLoQuiero = bloqueYaNoLoQuieroAmbiguo(ambiguos.join(" / "), demoraAvisada);
        posibleBaja = [...ambiguos];
        if (demoraAvisada) demorasDeLaRafaga = demorasSueltas;
      } else {
        demoraAvisada = false;
      }
    }
    if (!notaYaNoLoQuiero && !hayCancelacion && !ofrecioAgregarAlgo(m)) {
      const sueltos = textos.filter((t) => !anexados.includes(t) && esYaNoLoMandeSuelto(t));
      if (sueltos.length > 0 && vivo) {
        notaYaNoLoQuiero = bloqueYaNoLoQuieroAmbiguo(sueltos.join(" / "));
        posibleBaja = [...sueltos];
      }
    }
  }
  // Revisión 56 (R56-6): contestando la pregunta, «ya no lo quiero, lo pido mañana» no confirma: se vuelve a preguntar.
  if (pregunto && !notaYaNoLoQuiero && !hayCancelacion) {
    const difiere = textos.filter((t) =>
      !anexados.includes(t) && traeYaNoLoQuiero(t) && !esYaNoLoQuieroSuelto(t) && !esYaNoLoMandeSuelto(t) &&
      esReprogramaORecoge(t) && !esYaNoLoMandeConCambio(t) && !esCambioDeProductoYaNoQuiero(t)
    );
    if (difiere.length > 0 && vivo) {
      notaYaNoLoQuiero = bloqueYaNoLoQuieroAmbiguo(difiere.join(" / "));
      posibleBaja = [...difiere];
    }
  }
  // 7. Revisión 66/77 (R66-1, R77-5/6): cancelar en una pregunta o condición, o una cancelación dudosa.
  if (!highRisk) {
    const preguntas = textos.filter((t) =>
      !anexados.includes(t) && !posibleBaja.includes(t) && (esCancelacionEnPregunta(t, op) || esCancelacionDudosa(t, op))
    );
    if (preguntas.length > 0 && vivo) {
      posibleBaja = textos.filter((t) => posibleBaja.includes(t) || preguntas.includes(t));
      notaYaNoLoQuiero ??= bloquePreguntaCancelar(preguntas.join(" / "));
    }
  }
  // 8. Revisión 68/69 (R68-3, R69-4): «ya no lo quiero» + un pedido NUEVO es reemplazar el pedido vivo.
  let notaReemplazo: string | null = null;
  if (!highRisk && !demoraAvisada) {
    const yaNo = textos.filter((t) => !anexados.includes(t) && traeYaNoLoQuiero(t) && !/\b(?:cancel|anul)\w*/.test(normAviso(t)) && !esReprogramaORecoge(t));
    let nuevos = yaNo.length > 0 ? textos.filter((t) => !anexados.includes(t) && esPedidoNuevo(t)) : [];
    if (nuevos.length > 0 && textos.filter((t) => yaNo.includes(t) || nuevos.includes(t)).some((t) => agregaAlPedido(t))) nuevos = [];
    if (nuevos.length > 0 && vivo && !ctx.cancelacionAbierta) {
      const dijo = textos.filter((t) => yaNo.includes(t) || nuevos.includes(t));
      notaReemplazo = bloqueReemplazoDePedido(dijo);
      notaYaNoLoQuiero = null;
      posibleBaja = [];
      notaCambio = null;
      avisos.push({ operacion: "crear", motivo: RAZON_POSIBLE_BAJA, mensaje: avisoPosibleBajaReemplazo(yaNo.filter((t) => !nuevos.includes(t)), nuevos) });
    }
  }

  // 9. Revisión 33/70/87/88/89/92/93: retractación, «sí lo quiero», «¿mantengo o cancelo?».
  if (!highRisk) {
    const conMas = (t: string) => contexto && esSiLoQuieroConMas(t);
    const pendienteMantener = preguntaMantenerPendiente(m);
    const agregaTrasPregunta = (t: string) => pendienteMantener === "ultima" && diceAgregarTrasPregunta(t);
    const mantener = (t: string) =>
      (pendienteMantener === "ultima" && (diceMantener(t) || diceSiSolo(t) || diceAgregarTrasPregunta(t))) ||
      (pendienteMantener !== null && diceMantenerAmplio(t));
    const retiros = textos.filter((t) => (esRetiro(t) || retirosEnRafaga.includes(t) || conMas(t) || mantener(t)) && !anexados.includes(t));
    // Revisión 92/93 (R92-2, R93-2): «sí lo quiero, pero mañana»: la duda queda en el aviso y se pregunta una sola vez.
    if (retiros.length === 0 && contexto && textos.some((t) => esSiLoQuieroAmbiguo(t)) && ctx.cancelacionAbierta) {
      const yaPreguntado = yaSePreguntoMantener(m);
      avisos.push({ operacion: "anexar", motivo: RAZON_CANCELACION, mensaje: mensajeClienteDuda(textos.filter((t) => esSiLoQuieroAmbiguo(t)), yaPreguntado) });
      if (!yaPreguntado) {
        return decision("preguntar_mantener_o_cancelar", { respuesta: ctx.ingles ? PREGUNTA_MANTENER_O_CANCELAR_EN : PREGUNTA_MANTENER_O_CANCELAR, avisos });
      }
    }
    // Revisión 92 (R92-2): «no / mejor no» a la pregunta: la cancelación sigue (el aviso ya está abierto).
    if (
      retiros.length === 0 && preguntoMantenerOCancelar(m) && textos.every((t) => diceNoMantener(t) || esCortesiaSola(t)) &&
      textos.some((t) => diceNoMantener(t))
    ) {
      const en = ctx.ingles || ultimaRespuestaDelAsistente(m).includes(PREGUNTA_MANTENER_O_CANCELAR_EN);
      return decision("cancelacion_sigue", { respuesta: en ? CANCELACION_SIGUE_REPLY_EN : CANCELACION_SIGUE_REPLY, avisos });
    }
    if (retiros.length > 0) {
      const retiro = retiros.join(" / ");
      const anexado = ctx.cancelacionAbierta === true || (productoAlcance !== null && ctx.modificacionAbierta === true);
      if (anexado) {
        avisos.push({
          operacion: "anexar",
          motivo: ctx.cancelacionAbierta ? RAZON_CANCELACION : RAZON_MODIFICACION_PEDIDO,
          mensaje: mensajeRetractacion(retiros),
          ...(pendienteMantener !== null && ctx.cancelacionAbierta ? { ventanaMin: VENTANA_CONFIRMA_CANCELACION_MIN } : {}),
        });
        const siLoQuiere = retiros.every((t) => esSiLoQuieroTrasCancelar(t) || conMas(t) || mantener(t));
        const respuesta = ctx.ingles
          ? siLoQuiere ? RETRACTACION_SI_LO_QUIERE_REPLY_EN : RETRACTACION_CANCELACION_REPLY_EN
          : siLoQuiere ? RETRACTACION_SI_LO_QUIERE_REPLY : RETRACTACION_CANCELACION_REPLY;
        const demas = textos.filter((t) =>
          (!retiros.includes(t) || conMas(t) || agregaTrasPregunta(t)) && !canceladasRetiradas.includes(t) && !anexados.includes(t) && !esCortesiaSola(t)
        );
        if (demas.length === 0) return decision("retirar_cancelacion", { respuesta, avisos });
        return decision("retirar_cancelacion", { respuesta, alModelo: true, nota: bloqueRetractacionYaAvisada(respuesta, retiro), avisos });
      }
      if (canceladasRetiradas.length > 0) {
        // Revisión 70 (R70-3): la cancelación se retiró antes de avisarla: no hay nada que anotar.
        const respuesta = CANCELACION_RETIRADA_EN_RAFAGA_REPLY;
        const demas = textos.filter((t) => !retiros.includes(t) && !canceladasRetiradas.includes(t) && !anexados.includes(t) && !esCortesiaSola(t));
        if (demas.length === 0) return decision("retirar_cancelacion", { respuesta, avisos });
        return decision("retirar_cancelacion", {
          respuesta,
          alModelo: true,
          nota: bloqueCancelacionRetiradaEnRafaga(respuesta, [...canceladasRetiradas, ...retiros].join(" / ")),
          avisos,
        });
      }
    }
  }

  // 10. Revisión 26/27: «no, cancelo» tras «¿Algo más?»: primero se pregunta (lo demás espera al turno siguiente).
  if (!highRisk && preguntarSiCancela) {
    avisos.push({ operacion: "crear", motivo: RAZON_POSIBLE_BAJA, mensaje: avisoPosibleBaja(posibleBaja) });
    return decision("avisar_posible_baja", { respuesta: PREGUNTA_CONFIRMAR_CANCELACION, avisos });
  }
  // 11. Cancelar sin pedido vivo (y nada más que atender).
  const hayTextoSinClasificar = textos.some((t) => !esPeticionDeCancelar(t, op) && otroRiesgo(t) === null && !esCortesiaSola(t));
  if (!highRisk && cancelacionSinPedido && !hayTextoSinClasificar) {
    return decision("sin_pedido", { respuesta: ctx.ingles ? CANCELACION_SIN_PEDIDO_REPLY_EN : CANCELACION_SIN_PEDIDO_REPLY, avisos });
  }
  // 12. El aviso de cancelación (la confirmada eleva la posible baja abierta en la misma fila).
  if (hayCancelacion) {
    avisos.push({ operacion: "cancelar", motivo: RAZON_CANCELACION, mensaje: cancelaciones.join("\n"), ventanaMin: pregunto || contexto ? VENTANA_CONFIRMA_CANCELACION_MIN : undefined });
    const fija = ctx.ingles ? CANCELACION_REPLY_EN : cancelacionReply(ctx.ventanaMin);
    const alcance = alcanceAmbiguo ? `\n\n${preguntaAlcanceCancelacion(alcanceAmbiguo)}` : "";
    const residual = textos.filter((t) =>
      !cancelaciones.includes(t) && !cancelaciones.includes(`${t}${SUFIJO_CONFIRMA_CANCELACION}`) && !anexados.includes(t) &&
      !esCortesiaSola(t) && !esRetiro(t) && otroRiesgo(t) === null && !esPreguntaCancelarSola(t, op)
    );
    if (cancelaciones.some((t) => cancelacionConOtraPeticion(t)) || residual.length > 0) {
      const prefijo = `${fija}${alcance}`;
      return decision("avisar_cancelacion", { respuesta: prefijo, alModelo: true, nota: bloqueCancelacionYaAvisada(prefijo), avisos });
    }
    // Revisión 68/71 (R68-3, R71-3): «sí» a «¿Quiere cancelar su pedido anterior y hacer este nuevo?»: sigue el pedido nuevo.
    if (preguntoReemplazo(m) || (pregunto && turnoAnteriorPidioPedidoNuevo(m))) {
      return decision("avisar_cancelacion", { respuesta: fija, alModelo: true, nota: bloqueReemplazoConfirmado(fija), avisos });
    }
    return decision("avisar_cancelacion", { respuesta: `${fija}${alcance}`, avisos });
  }
  // Revisión 41/66/67/68 (R68-2, R68-5): con OTRO aviso del turno (reclamo, alergia, cobro…), la pregunta de cancelar va al
  // final de esa respuesta fija (preguntarCancelarTrasReclamo), o se repite si la posible baja sigue sin contestar.
  if (highRisk) {
    const conReclamo = textos.some((t) => otroRiesgo(t) === "reclamo_pedido");
    const yaNo = (t: string) =>
      esCancelacionEnPregunta(t, op) || esCancelacionDudosa(t, op) ||
      (conReclamo && (esYaNoLoQuieroConMotivo(t) || esYaNoLoMandeSuelto(t) || (esYaNoLoQuieroSuelto(t) && !ofrecioAgregarAlgo(m)))) ||
      (!conReclamo && traeYaNoLoQuiero(t) && !esReprogramaORecoge(t) && !esCambioDeProductoYaNoQuiero(t) && !esYaNoLoMandeConCambio(t) &&
        !((esYaNoLoQuieroSuelto(t) || esYaNoLoMandeSuelto(t)) && ofrecioAgregarAlgo(m)));
    if (!pregunto && textos.some(yaNo) && vivo && !ctx.cancelacionAbierta) {
      avisos.push({ operacion: "crear", motivo: RAZON_POSIBLE_BAJA, mensaje: avisoPosibleBaja(textos.filter(yaNo)) });
      return decision("avisar_posible_baja", { alModelo: true, preguntaAlFinal: PREGUNTA_CONFIRMAR_CANCELACION, avisos });
    }
    if (pregunto && !noCancelaEnTurno && ctx.posibleBajaAbierta) {
      return decision("al_modelo_con_nota", { alModelo: true, preguntaAlFinal: PREGUNTA_CONFIRMAR_CANCELACION, avisos });
    }
    return decision(avisos.length > 0 ? "al_modelo_con_nota" : "nada", { alModelo: true, nota: juntarNotas(notaAlcance, notaCambio), avisos });
  }
  // 13. Revisión 52/56: la posible baja. Con la cancelación ya abierta, solo la nota (ni aviso ni pregunta).
  if (notaYaNoLoQuiero && ctx.cancelacionAbierta) {
    const nota = demoraAvisada
      ? `${BLOQUE_CANCELACION_YA_PEDIDA} La queja por la demora de este mensaje YA quedó avisada a la sucursal (no la vuelva a avisar): dígale que ya avisó.`
      : BLOQUE_CANCELACION_YA_PEDIDA;
    return decision("cancelacion_ya_pedida", { alModelo: true, nota: juntarNotas(nota, notaAlcance, notaCambio), avisos });
  }
  if (notaYaNoLoQuiero) {
    avisos.push({ operacion: "crear", motivo: RAZON_POSIBLE_BAJA, mensaje: avisoPosibleBaja(posibleBaja) });
    const sola = !notaAlcance && !notaCambio && textos.every((t) =>
      esCortesiaSola(t) || esYaNoLoQuieroAmbiguoSolo(t) || (demorasDeLaRafaga.includes(t) && esDemoraSola(t)) ||
      (posibleBaja.includes(t) && esPreguntaCancelarSola(t, op))
    );
    if (sola) return decision("avisar_posible_baja", { respuesta: demoraAvisada ? YA_NO_LO_QUIERO_DEMORA_REPLY : YA_NO_LO_QUIERO_REPLY, avisos });
    return decision("avisar_posible_baja", {
      alModelo: true,
      nota: juntarNotas(notaYaNoLoQuiero, notaAlcance, notaCambio),
      preguntaAlFinal: PREGUNTA_CONFIRMAR_CANCELACION,
      avisos,
    });
  }
  if (notaReemplazo) {
    return decision("reemplazo", { alModelo: true, nota: notaReemplazo, preguntaAlFinal: PREGUNTA_CANCELAR_REEMPLAZO, avisos });
  }
  if (notaAlcance) return decision("respuesta_alcance", { alModelo: true, nota: juntarNotas(notaAlcance, notaCambio), avisos });
  const nota = juntarNotas(notaSiSinConfirmar, notaCambio);
  if (nota || avisos.length > 0) return decision("al_modelo_con_nota", { alModelo: true, nota, avisos });
  return decision("nada", { alModelo: true });
}

/**
 * Aplica `preguntaAlFinal` a la respuesta del modelo (conPreguntaCancelar; R71-3 cambia la pregunta a secas por la del
 * reemplazo). Pura.
 */
export function respuestaConPreguntaAlFinal(respuestaModelo: string, d: Pick<DecisionCancelacion, "preguntaAlFinal" | "respuesta" | "alModelo">): string {
  // Revisión 87 (R87-V): con el acuse de la cancelación ya en el prefijo, las oraciones del modelo que lo repiten se quitan.
  const propio = d.respuesta && /de su cancelaci[oó]n|of your cancellation/.test(d.respuesta) ? sinAcuseDeCancelacion(respuestaModelo) : respuestaModelo;
  const base = d.alModelo && d.respuesta ? (propio ? `${d.respuesta}\n\n${propio}` : d.respuesta) : respuestaModelo;
  if (!d.preguntaAlFinal) return base;
  if (d.preguntaAlFinal === PREGUNTA_CANCELAR_REEMPLAZO) return conPreguntaCancelar(conPreguntaDeReemplazo(base), PREGUNTA_CANCELAR_REEMPLAZO);
  return conPreguntaCancelar(base, d.preguntaAlFinal);
}
