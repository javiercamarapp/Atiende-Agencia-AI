// Cerebro v2 · SALUD Y ALERGIA (port fiel del núcleo «suelto», wt-suelto-voz e69279e, whatsapp-agent-core.ts versión
// WhatsApp, revisiones 25-93). Todo puro: sin red, sin base, sin reloj implícito (la hora llega por parámetro).
//  - Detección: declaraAlergia (regex medida en 93 rondas, con negaciones puras), esReaccionDeSalud (reacción en curso),
//    emergenciaDeSaludFuerte (R93-1), saludConOtraPeticion (R92-1), malestar tras comer (SALUD_MALESTAR, intent «salud»).
//  - Clasificador semántico: candidatos, reparto y combinación (el clasificador es inyectable, ver clasificador-alergia.ts).
//  - Sesión: evidenciaAlergiaEnSesion, decidirBloqueoAlergia (guarda de crear_pedido), notas de cocina y de preferencia.
//  - Avisos: esAvisoDeAltaPrioridad, mensajeAvisoDeRiesgo (marca URGENTE al inicio), respuestas fijas ES/EN.
//  - Decisión del turno: decidirSalud (resumen puro de cómo runAgentTurn combina todo lo anterior).
import { citaDelCliente, esMarcadorSesion, normAviso, type MensajeHilo } from "./texto-plano.ts";
import {
  type ClasificadorAlergia,
  debeClasificarAlergia,
  MAX_CANDIDATOS_ALERGIA_POR_TURNO,
  MAX_CARACTERES_ALERGIA,
  plazoClasificadorAlergia,
  sinDelimitadores,
} from "./clasificador-alergia.ts";

/**
 * Un mensaje del hilo con lo que el cerebro de salud lee además de { role, content }: la marca del clasificador semántico en
 * el mensaje del cliente del turno (`alergia_semantica`) y, en la respuesta fija del asistente, los textos que el
 * clasificador leyó como alergia (`alergia_declarada`, revisión 28: así los turnos siguientes los ven).
 */
export interface MensajeSalud extends MensajeHilo {
  readonly alergia_semantica?: boolean;
  readonly alergia_declarada?: readonly unknown[];
}

/** La fila de un aviso (callback_request) de alergia, como la lee la guarda: lo mínimo que usa la decisión. */
export interface FilaAvisoAlergia {
  readonly id?: string;
  readonly reason?: string | null;
  readonly message?: string | null;
  readonly created_at?: string | null;
  readonly resolved?: boolean | null;
  readonly [k: string]: unknown;
}

// ------------------------------------------------------------------ frases de seguridad (pm-policies.ts, CR-WA-048)
// Frases obligatorias de las respuestas fijas de alergia y salud. La de un aviso y la de varios se arman con estas mismas
// constantes: no pueden divergir.
export const ALERGIA_SIN_GARANTIA =
  "Por su seguridad no puedo garantizarle ingredientes ni que un platillo esté libre de algún alérgeno.";
export const ALERGIA_ANTES_DEL_PEDIDO = "una persona le confirme directamente antes de tomar su pedido";
// Revisión 56 (R56-10): las mismas frases para el cliente que escribe en inglés.
export const ALERGIA_SIN_GARANTIA_EN =
  "For your safety, I can't guarantee ingredients or that any dish is free of a given allergen.";
export const ALERGIA_ANTES_DEL_PEDIDO_EN = "a person confirms with you directly before taking your order";
export const SALUD_SIN_DIAGNOSTICO =
  "Por su seguridad no puedo diagnosticar ni garantizar nada sobre ingredientes; si se siente mal, busque atención médica.";

/** Respuesta fija de alergia sin pedido en curso (HIGH_RISK_PATTERNS «alergia»): la sucursal confirma antes de tomar el pedido. */
export const ALERGIA_REPLY = `Gracias por avisarnos, es importante. ${ALERGIA_SIN_GARANTIA} Ya avisé a la sucursal para que ${ALERGIA_ANTES_DEL_PEDIDO}.`;
/** Respuesta fija del malestar tras comer (HIGH_RISK_PATTERNS «salud»). */
export const SALUD_MALESTAR_REPLY =
  `Lamento mucho lo que me cuenta. Ya avisé a la sucursal para que una persona lo contacte de inmediato. ${SALUD_SIN_DIAGNOSTICO}`;
/** Cuando no se pudo registrar el aviso: no se promete que la sucursal ya sabe. */
export const AVISO_NO_REGISTRADO_REPLY =
  "Lamento lo que pasó. En este momento no pude dejar el aviso en el sistema, así que no puedo asegurarle que la sucursal ya lo sepa. Le pido que llame directamente a la sucursal; también paso su mensaje a una persona en cuanto pueda.";

/**
 * Malestar tras comer (intoxicación, vómito, diarrea, «me cayó mal»): intent «salud» de HIGH_RISK_PATTERNS, sobre texto sin
 * acentos y en minúsculas. «Me enfermé de antojo/hambre» es una expresión, no salud.
 */
export const SALUD_MALESTAR =
  /\bintoxi|\benvenen|\bvomit|\bdiarrea|\b(?:comida|tacos?|cena|lo\s+que\s+pedi|despues\s+de\s+comer|estomago)\b[^.!?\n]{0,60}(?<!\b(?:no|nunca|jamas)\s)\bme\s+(?:cayo|puse|senti)\s+mal\b(?!\s+(?:atendid|tratad|servid))|(?<!\b(?:no|nunca|jamas)\s)\bme\s+(?:cayo|puse|senti)\s+mal\b(?!\s+(?:atendid|tratad|servid))[^.!?\n]{0,60}\b(?:comida|tacos?|cena|lo\s+que\s+pedi|despues\s+de\s+comer|estomago)\b|(?<!\b(?:no|nunca|jamas)\s)\b(?:me|nos)\s+enferm(?:e|amos|o)\b(?!\s+de\s+(?:antojo|hambre|ganas|risa))/;

// ------------------------------------------------------------------ ayudantes de texto
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
/** «gracias», «ok», «vale»… sin contenido de pedido. */
export function esCortesiaSola(t: string): boolean {
  const plano = normAviso(t).replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();
  return plano === "" || /^(?:muchas |mil )?(?:gracias|ok|okey|vale|listo|perfecto|entendido|esta bien|por favor|si|no|buenas|hola)(?: (?:gracias|ok|vale|listo|perfecto))?$/.test(plano);
}
/** Ventana en que un aviso abierto del mismo motivo cubre al nuevo (min). */
const VENTANA_AVISO_DUPLICADO_MIN = 30;

// ------------------------------------------------------------------ avisos a la sucursal
/** Inicio del mensaje de un aviso que el cliente pidió con urgencia (callback_requests no tiene campo de prioridad). */
export const MARCA_AVISO_URGENTE = "URGENTE: el cliente pide atención inmediata.";
/** Tope del mensaje de un aviso (caracteres). */
export const TOPE_MENSAJE_AVISO = 2000;

/** Categoría de alto riesgo de una razón: la del prefijo «alto_riesgo:x» o la inferida de un texto libre. Pura. */
export function categoriaDeRazon(razonNorm: string): string | null {
  if (razonNorm.startsWith("alto_riesgo:")) return razonNorm.slice("alto_riesgo:".length).trim() || null;
  if (/alerg/.test(razonNorm)) return "alergia";
  if (/intoxi|envenen|enferm|vomit|diarrea/.test(razonNorm)) return "salud";
  if (/cobro|cargo/.test(razonNorm) && /duplic|doble|dos veces/.test(razonNorm)) return "cobro_duplicado";
  if (/cancel/.test(razonNorm)) return "cancelacion";
  if (/urgen/.test(razonNorm)) return "urgencia";
  if (/\barco\b|privacidad|datos personales/.test(razonNorm)) return "privacidad_arco";
  // Revisión 87 (R87-R): «pago», «pago_realizado», «confirmar pago», «pago hecho» del modelo son el mismo aviso que el
  // alto_riesgo:transferencia_realizada del servidor (se deduplican con él).
  if (/transferen|deposit|comprobante|\bpag(?:o|os|ado|ada|ue|aron|o_realizado)\b|\bpago_/.test(razonNorm)) return "transferencia_realizada";
  return null;
}

/**
 * Avisos que no pueden esperar al cron de 10 min (alerta inmediata a la sucursal): alto riesgo (alergia y salud siempre),
 * cancelación o modificación de un pedido, y confirmar el peso. Pura.
 */
export function esAvisoDeAltaPrioridad(razon: string | null | undefined): boolean {
  const norm = normAviso(razon);
  return !!norm && (categoriaDeRazon(norm) !== null || /modificacion|cancel|confirmar[_ ]peso/.test(norm));
}

/**
 * ¿El aviso lo creó un turno urgente? Su PRIMER mensaje (lo anterior al primer «\n---\n» anexado) empieza con la marca
 * URGENTE. El recorte por el tope conserva esa primera línea, así que la marca sobrevive; sin ella se toma como no urgente
 * (en el peor caso sale un correo urgente de más, nunca se pierde uno). Pura.
 */
export function avisoCreadoUrgente(message: unknown): boolean {
  const primero = (String(message ?? "").split("\n---\n")[0] ?? "").trimStart();
  return primero.startsWith(MARCA_AVISO_URGENTE) || /^URGENTE(?::|\n)/.test(primero);
}

/**
 * El mensaje del aviso de alto riesgo que el servidor registra en el turno (runAgentTurn): la marca URGENTE al INICIO (lo
 * primero que ve la sucursal en el panel), un encabezado opcional, las palabras del cliente y, con alergia o salud que
 * nombra un alérgeno y pedidos abiertos, qué pedido ya lleva la alergia en sus notas. Pura.
 */
export function mensajeAvisoDeRiesgo(
  textos: readonly string[],
  opciones: { urgente?: boolean; encabezado?: string; pedidosConAlergia?: readonly string[] } = {},
): string {
  const delPedido = opciones.pedidosConAlergia && opciones.pedidosConAlergia.length > 0
    ? `\n(Pedido ya registrado: ${opciones.pedidosConAlergia.join(", ")}; se agregó la alergia a sus notas.)`
    : "";
  return `${opciones.urgente ? `${MARCA_AVISO_URGENTE}\n` : ""}${opciones.encabezado ? `${opciones.encabezado}\n` : ""}${textos.join("\n")}${delPedido}`;
}

/** Respuesta fija de un aviso marcado urgente: «Entendido, es urgente.» sin repetir el «Entendido» de la fija. Pura. */
export function respuestaUrgente(reply: string): string {
  const resto = reply.replace(/^Entendido[,.;:]?\s*/, "");
  return `Entendido, es urgente. ${resto.charAt(0).toUpperCase()}${resto.slice(1)}`;
}

// Revisión 79 (R79-C): también lo que se vende por kilo («el kilo de pastor», «el medio kilo», «la carne»).
const COMIDA_RECLAMO =
  "kilo|kilos|carne|carnes|coca|cocas|refresco|refrescos|bebida|bebidas|agua|cerveza|taco|tacos|orden|ordenes|salsa|salsas|guacamole|queso|quesadilla|quesadillas|gringa|gringas|alambre|alambres|suizo|suizos|mestiza|mestizas|papa|papas|frijoles|tortilla|tortillas|limon|limones|cebolla|nachos|torta|tortas|postre|complemento|complementos|pastor|bistec|pollo|pechuga|chorizo|cochinita|res|" +
  // Revisión 40 (P2): lo que faltaba del menú de PM (sopa de lima, arrachera, chuleta, flautas, postres, bebidas…).
  "sopa|sopas|arrachera|chuleta|costilla|champinon|champinones|rajas|flauta|flautas|fajita|fajitas|alitas|papadzules|codzitos|hamburguesa|hamburguesas|chetaco|chetacos|quesobich|parrillada|ensalada|flan|jericalla|jericallas|horchata|limonada|limonadas|naranjada|naranjadas|sprite|fanta|michelada|chelada|cafe";

// Alergia o restricción de salud (sobre texto sin acentos y en minúsculas).
// Revisión 28: también las erratas y abreviaturas («alergic», «alerjico», «alergiko», «alergiaa», «alerg.») y la
// anafilaxia («anafilaxia», «anafiláctico»).
// Revisión 29: también en inglés («allergic», «allergy», «allergies», «celiac», «lactose intolerant/intolerance»,
// «anaphylaxis»).
// Revisión 57 (R57-3): también «alegico», «alegica», «alegia» (sin la r; no «alegría»).
const PATRON_ALERGIA =
  /\baler[gj]i[a-z]*\b|\baleg(?:i[ck][a-z]*|ias?)\b|\balerg\.|\balergenos?\b|\banafila[a-z]*|\bintoleran(?:te|cia|tes|t|ts|ce)\b|\bceliac(?:[oa]s?)?\b|\bceliaquia\b|\ballerg[a-z]*|\banaphyla[a-z]*|\bcoeliac\b/;
const PALABRA_ALERGIA = String.raw`(?:aler[gj]i\w*|aleg(?:i[ck]\w*|ias?\b)|alerg\.|alergen\w*|anafila\w*|intoleran\w*|celiac\w*|celiaquia|allerg\w*|anaphyla\w*)`;
// Revisión 26: negaciones de una alergia («no tengo alergias», «sin alergias», «ninguna alergia», «no soy alérgico»,
// «nadie es alérgico», «alergias: ninguna»). Se quitan del texto antes de buscar la alergia.
const ALERGIA_NEGADA = new RegExp(
  [
    String.raw`\b(?:no|nunca)\s+(?:tengo|tenemos|tiene|tienen|padezco|padecemos|padece|hay)\s+(?:ningun[ao]?\s+|nada\s+de\s+|tipo\s+de\s+)?${PALABRA_ALERGIA}`,
    String.raw`\bsin\s+(?:ningun[ao]?\s+)?${PALABRA_ALERGIA}`,
    String.raw`\b(?:ningun[ao]?|cero|nada\s+de)\s+${PALABRA_ALERGIA}`,
    // Revisión 29: también «nadie en mi mesa/familia», «nadie de mi familia», «ninguno de nosotros».
    String.raw`\b(?:no|nadie|ninguno|ninguna)\s+(?:(?:de\s+nosotros|aqui|aca|en\s+casa|(?:en|de)\s+(?:mi|la|nuestra|esta|su)\s+(?:mesa|familia|casa|oficina|grupo))\s+)?(?:soy|somos|es|son|esta|estamos|estan)\s+${PALABRA_ALERGIA}`,
    String.raw`\b${PALABRA_ALERGIA}\s*:?\s*(?:ningun[ao]?|nada|cero)\b`,
    String.raw`\b${PALABRA_ALERGIA}\s*:?\s*no\s*$`,
    // Revisión 29: en inglés («no allergies», «no food allergies», «I'm not allergic», «I don't have any allergies»,
    // «nobody is allergic»).
    String.raw`\bno\s+(?:known\s+|food\s+)?${PALABRA_ALERGIA}`,
    String.raw`\b(?:not|nobody\s+is|no\s+one\s+is|none\s+of\s+us\s+(?:is|are))\s+${PALABRA_ALERGIA}`,
    String.raw`\b(?:don['’]?t|do\s+not|doesn['’]?t|does\s+not)\s+have\s+(?:any\s+)?(?:food\s+)?${PALABRA_ALERGIA}`,
  ].join("|"),
  "g",
);
const ALERGIA_NEGADA_UNA = new RegExp(ALERGIA_NEGADA.source);
// Revisión 29: alérgenos frecuentes en inglés (para «I can't eat peanuts» y para no descartar una negación con alimento).
// Sin «soy»: en español es «soy Luis» (la soya ya está como «soya»/«soybeans»).
const ALERGENO_INGLES =
  String.raw`peanuts?|tree\s+nuts?|nuts?|shellfish|shrimps?|prawns?|fish|eggs?|milk|dairy|wheat|soybeans?|sesame|strawberr(?:y|ies)|lactose|crab|lobster|almonds?|walnuts?|cashews?|pecans?`;
// Revisión 27: alimentos y alérgenos frecuentes (sin acentos). Sirven para las formas indirectas («no puede comer
// cacahuate») y para NO descartar una negación que nombra un alimento («no tengo alergia… bueno sí, al cacahuate»).
const ALIMENTO_ALERGENO = String.raw`(?:cacahuates?|mani|nuez|nueces|almendras?|avellanas?|pistaches?|semillas?|mariscos?|camaron(?:es)?|pescados?|atun|ostion(?:es)?|pulpo|calamar(?:es)?|crustaceos?|gluten|trigo|harinas?|lactosa|leche|lacteos?|quesos?|crema|huevos?|soya|ajonjoli|sesamo|cilantro|cebolla|ajo|chiles?|picante|habanero|tomate|jitomate|cerdo|puerco|res|pollo|mostaza|apio|fresas?|pina|kiwi|azucar|sulfitos?|maiz|frijol(?:es)?|aguacate|guacamole|penicilina|medicamentos?|${ALERGENO_INGLES})`;
// «mi esposa no puede comer cacahuate», «no me puedo comer el cilantro», «mis hijos no pueden comer mariscos».
const NO_PUEDE_COMER = String.raw`\bno\s+(?:me\s+|le\s+|les\s+|nos\s+|se\s+lo\s+|se\s+)?(?:puedo|puede|pueden|podemos|debo|debe|deben|debemos)\s+(?:comer|tomar|consumir|ingerir|probar)\b[^.!?\n]{0,40}?\b${ALIMENTO_ALERGENO}\b`;
// «me hace daño el chile», «a mi esposo le hace daño el camarón» (no «me hizo daño»: eso es malestar, intent salud).
const HACE_DANO = String.raw`\b(?:me|le|les|nos)\s+(?:hace|hacen)\s+(?:mucho\s+)?dano\b`;
// Revisión 28: formas indirectas con un alimento en la misma oración. «no puedo con el cacahuate», «mi mamá no puede con
// los mariscos»; «me cae mal el gluten», «el gluten me cae mal», «me hace mal la leche», «me cae pesado la lactosa»;
// «me dan ronchas con los camarones», «me da comezón la nuez», «me inflamo con los mariscos», «me enferma la lactosa»;
// «soy sensible al gluten»; «no tolero la lactosa». Lo que la regex no alcanza lo lee el clasificador semántico.
// Revisión 29: los modismos («no puedo con», «me cae mal», «me enferma», «ronchas») solo cuentan con un ALÉRGENO
// (ALERGENO_MODISMO: sin picante, chile, cebolla, res, pollo, queso… que son gusto o hartazgo: «no puedo con el picante»,
// «ya no puedo con tanto pollo») y en la MISMA cláusula (la ventana se corta en comas, punto y coma y puntos: «me cae mal
// el de la moto, dame 2 tacos de res»). Lo demás lo lee el clasificador semántico.
const ALERGENO_MODISMO =
  String.raw`(?:cacahuates?|mani|nuez|nueces|almendras?|avellanas?|pistaches?|mariscos?|camaron(?:es)?|pescados?|atun|ostion(?:es)?|pulpo|calamar(?:es)?|crustaceos?|gluten|trigo|lactosa|leche|lacteos?|huevos?|soya|ajonjoli|sesamo|fresas?|kiwi|mostaza|sulfitos?|penicilina|medicamentos?|${ALERGENO_INGLES})`;
const NO_PUEDE_CON = String.raw`\bno\s+(?:me\s+|le\s+|les\s+|nos\s+)?(?:puedo|puede|pueden|podemos)\s+con\b[^.!?\n,;]{0,30}?\b${ALERGENO_MODISMO}\b`;
// Revisión 56 (R56-4): también «me / le pone(n) mal(o/a)» («el cacahuate me pone malo», «sí me pone mala la leche»).
// Revisión 75 (R75-1, decisión de producto): «me cae(n) mal / pesado», «me hace(n) mal», «me sienta mal» SIN una palabra de
// salud o reacción (PALABRA_SALUD_CAE_MAL) es preferencia o intolerancia, no alergia: el pedido sigue y lleva la nota «no le
// cae bien…» (notaPreferenciaDelPedido). «me pone(n) malo» sí es malestar del cuerpo y sigue contando como alergia.
const CAE_MAL_PREFERENCIA = String.raw`\b(?:me|le|les|nos)\s+(?:cae|caen|hace|hacen|sienta|sientan)\s+(?:muy\s+)?(?:mal|pesad[oa]s?)\b`;
const PONE_MAL = String.raw`\b(?:me|le|les|nos)\s+(?:pone|ponen)\s+(?:muy\s+)?mal[oa]?s?\b`;
const CAE_MAL = String.raw`(?:${CAE_MAL_PREFERENCIA}|${PONE_MAL})`;
const REACCION = String.raw`(?:\bronchas?\b|\bcomezon\b|\burticaria\b|\b(?:me|se|le|nos)\s+(?:inflam[oa]|hinch[oa]|ahog[oa]|enferm(?:a|an|o))\b)`;
// Revisión 31: una reacción del cuerpo en sentido amplio (para ordenar los candidatos del clasificador, no para declarar).
const REACCION_CUERPO =
  /\b(?:ronchas?|comezon|urticaria|hinch\w*|inflam\w*|ahog\w*|pica(?:n)?|picazon|ard(?:e|en|or)|garganta|labios?|salpullido|sarpullido|granit\w*|vomit\w*|nause\w*|enferm\w*|respirar)\b/;
const CERCA_DE_ALIMENTO = (x: string, alimento = ALERGENO_MODISMO) =>
  String.raw`${x}[^.!?\n,;]{0,40}?\b${alimento}\b|\b${alimento}\b[^.!?\n,;]{0,40}?${x}`;
// Revisión 75 (R75-6): reacciones que por sí solas son de salud («me hace ronchas la cebolla», «me sale roncha con el
// jitomate», «le da reacción», «es mortal para mí», «se me cierra la garganta», «urticaria», «epipen»). Cuentan con
// CUALQUIER alimento (no solo los alérgenos típicos) en la misma oración, aunque haya comas en medio («a mi esposa le hace
// mal el ajo, le da reacción»). «mortal» solo como «es mortal» / «mortal para» («está mortal el tráfico» no).
// Revisión 76 (R76-8): la reacción negada («sin reacción», «no le da reacción», «ninguna reacción», «no tiene reacción») no.
// Revisión 77 (R77-4): solo la negación PEGADA a la reacción; «sin nuez que me da reacción», «no sé si me da reacción» sí.
const REACCION_FUERTE = String.raw`(?:\bronchas?\b|\burticaria\b|\banafila\w*|\bepi\s*pen\b|\b(?:se\s+)?(?:me|le|les|nos)\s+cierra\w*\s+la\s+garganta\b|\b(?:es|son|seria|puede\s+ser)\s+mortal\b|\bmortal\s+para\b|(?<!\b(?:no|nunca)\s)\b(?:me|le|les|nos|te)\s+(?:da|dan|hace|hacen|causa|causan|provoca|provocan|sale|salen)\s+(?:una\s+|mucha\s+)?reaccion\w*|(?<!\b(?:no|nunca)\s)\b(?:tengo|tiene|tienen|tenemos|hago|hace)\s+(?:una\s+)?reaccion\w*|(?<!\b(?:sin|ningun|ninguna|nada\s+de|(?:no|nunca)\s+(?:(?:me|le|les|nos|te)\s+)?(?:da|dan|hace|hacen|causa|causan|provoca|provocan|sale|salen|tengo|tiene|tienen|tenemos|hago)(?:\s+(?:una|ninguna|ningun))?)\s+)\breaccion\w*\s+(?:a|al|con|por)\b)`;
const REACCION_FUERTE_CON_ALIMENTO = String.raw`${REACCION_FUERTE}[^.!?\n]{0,80}?\b${ALIMENTO_ALERGENO}\b|\b${ALIMENTO_ALERGENO}\b[^.!?\n]{0,80}?${REACCION_FUERTE}`;
// Revisión 75 (R75-1): las palabras de salud que vuelven alergia un «me cae mal» con un alimento (en cualquier parte del
// mensaje: «me cae mal el camarón, me hincho»).
// Revisión 76 (R76-5): también el malestar del cuerpo («no puede respirar», «se pone rojito», «diarrea», «vómito»,
// «gastritis», «reflujo», «colitis»).
const PALABRA_SALUD_CAE_MAL = String.raw`(?:\b${PALABRA_ALERGIA}|\breaccion\w*|\bronchas?\b|\bhinch\w*|\bgarganta\b|\bmortal\b|\bepi\s*pen\b|\burticaria\b|\bcomezon\b|\binflam\w*|\bahog\w*|\benferm\w*|\brespir\w*|\b(?:pone|ponen|puso|pusieron)\s+(?:muy\s+|todo\s+|toda\s+)?roj\w*|\bdiarrea\b|\bvomit\w*|\bgastritis\b|\breflujo\b|\bcolitis\b)`;
const CAE_MAL_CON_SALUD = String.raw`^(?=[\s\S]*${PALABRA_SALUD_CAE_MAL})[\s\S]*?(?:${CERCA_DE_ALIMENTO(CAE_MAL_PREFERENCIA, ALIMENTO_ALERGENO)})`;
// Revisión 30: la coma no corta la reacción cuando va justo después del alérgeno nombrado («con la nuez, me ahogo»,
// «los camarones, me dan ronchas»). Sigue cortándola en el otro sentido («me inflamo, dame 2 tacos de pescado»).
const ALERGENO_COMA_REACCION = String.raw`\b${ALERGENO_MODISMO}\b[^.!?\n,;]{0,25}?,\s*(?:y\s+|pero\s+)?(?:me\s+dan\s+|me\s+da\s+|me\s+salen\s+)?${REACCION}`;
const SENSIBLE_A = String.raw`\bsensibles?\s+(?:a|al|a\s+la|a\s+los|a\s+las)\s+${ALIMENTO_ALERGENO}\b`;
// Revisión 30: en inglés («I'm sensitive to gluten», «gluten sensitivity», «sensitivity to dairy»).
const SENSITIVE_TO =
  String.raw`\bsensitiv(?:e|ity)\s+to\s+(?:the\s+)?${ALIMENTO_ALERGENO}\b|\b${ALIMENTO_ALERGENO}\s+sensitiv(?:e|ity)\b`;
// Revisión 29: «I can't eat peanuts», «she cannot eat shellfish», «can't have dairy».
const CANT_EAT = String.raw`\b(?:can['’]?t|cannot|can\s+not|shouldn['’]?t|must\s+not|mustn['’]?t)\s+(?:eat|have)\b[^.!?\n,;]{0,30}?\b(?:${ALERGENO_INGLES})\b`;
const NO_TOLERA = String.raw`\bno\s+(?:tolero|tolera|toleran|toleramos)\b[^.!?\n]{0,20}?\b${ALIMENTO_ALERGENO}\b`;
/** Revisión 27/28: una declaración de alergia o restricción, directa o indirecta (sobre texto sin acentos y en minúsculas). */
const PATRON_DECLARACION_ALERGIA = new RegExp(
  [PATRON_ALERGIA.source, NO_PUEDE_COMER, HACE_DANO, NO_PUEDE_CON, CERCA_DE_ALIMENTO(PONE_MAL), CAE_MAL_CON_SALUD, CERCA_DE_ALIMENTO(REACCION), REACCION_FUERTE_CON_ALIMENTO, ALERGENO_COMA_REACCION, SENSIBLE_A, SENSITIVE_TO, NO_TOLERA, CANT_EAT]
    .join("|"),
);
// Después de una negación: «pero/aunque/bueno/excepto … sí», «excepto/salvo/menos <alimento o alergia>» o «sí/solo al
// <alimento>» la contradicen. Revisión 28: «pero/solo … <alimento>» ya no («no tengo alergias, pero quiero tacos de
// pollo», «sin alergias, solo 2 tacos de pollo» son la negación y un pedido).
// Revisión 33: «solo/nomás/únicamente/only/just» PEGADO a un alérgeno («no tengo alergias, solo cacahuate», «no allergies,
// only peanuts») y «<alérgeno> sí» («…a la nuez sí») también la contradicen: sin clasificador la alergia se perdía. Solo
// con un ALÉRGENO (ALERGENO_MODISMO), no con cualquier alimento: «solo 2 tacos de pollo», «nomás con queso» son el pedido.
const ARTICULO_AFIRMACION = String.raw`(?:(?:a|al|a\s+la|a\s+los|a\s+las|el|la|los|las|the|to)\s+)?`;
// Revisión 47 (seguridad primero): tras negar la alergia propia, «, mi hijo sí» / «; mi esposa sí» / «a mi hija sí» (sin
// «pero») y en inglés «but my son is / does», «, my wife does» la afirman de otra persona. Solo con el «sí» / el auxiliar al
// final de la cláusula: «no tengo alergias, mi hijo sí quiere tacos» es el pedido.
// Revisión 53 (seguridad primero): la lista cerrada de personas de R52 se perdía «mi señora sí», «mi hijita sí», «mi
// compadre sí», «mi vecino sí», «mi doctora sí», «mi hijo de cinco años sí». Se invierte: tras el posesivo va CUALQUIER
// frase de hasta 4 palabras, salvo que alguna sea comida, bebida, el pedido o un producto («mis refrescos sí», «mis dos
// tacos sí», «mi orden sí», «my order is» son el pedido). «papa(s)» no se excluye: «mis papás sí» son los padres.
// Revisión 54: «mi chela sí», «mi cena sí», «mi limonada sí» son el pedido. «mis papás sí» (con acento) llega como
// «papis» (ver planoAlergia).
// Revisión 56 (R56-9, seguridad primero): «mis papas sí» SIN acento vuelve a ser persona (los padres escritos sin acento):
// se avisa. Con comida detrás («mis papas sí con queso») la cláusula sigue y no cuenta.
const NO_PERSONA_ES = String.raw`(?:${
  COMIDA_RECLAMO.split("|").filter((w) => w !== "papa" && w !== "papas").join("|")
}|chelas?|cervezas?|cenas?|almuerzos?|desayunos?|limonadas?|micheladas?|frescas?|pedidos?|ordenes|comidas?|platos?|platillos?|productos?|bebidas?|antojitos?|combos?|paquetes?|kilos?|carnes?|panuchos?|salbutes?|empanadas?|tamales?|tostadas?|sopas?|postres?|cafes?|jugos?|aguas?|horchata|jamaica|pago|tarjeta|efectivo|cuenta|direccion|domicilio|envio|${ALIMENTO_ALERGENO})`;
const NO_PERSONA_EN = String.raw`(?:orders?|food|foods|drinks?|beverages?|sodas?|cokes?|water|tacos?|meals?|plates?|dish(?:es)?|salsas?|items?|products?|sides?|combo|delivery|payment|card|address|total|${ALERGENO_INGLES})`;
const FRASE_PERSONA_ES = String.raw`(?!${NO_PERSONA_ES}\b)[a-z0-9]+(?:\s+(?!${NO_PERSONA_ES}\b)[a-z0-9]+){0,3}`;
const FRASE_PERSONA_EN = String.raw`(?!${NO_PERSONA_EN}\b)[a-z0-9]+(?:\s+(?!${NO_PERSONA_EN}\b)[a-z0-9]+){0,3}`;
// Revisión 54 (seguridad primero): tras «<persona> sí», una reacción («se pone malo con los cacahuates», «le hace daño
// la leche», «le salen ronchas») también la afirma aunque la cláusula siga.
// Revisión 56 (R56-4): y «(sí) me / le / lo pone(n) mal(o)» («no tengo alergias, pero sí me pone malo el cacahuate»).
const REACCION_TRAS_SI = String.raw`\s+(?:(?:se|me|le|les|lo|la|los|las|nos)\s+(?:pone|ponen)\s+(?:muy\s+)?mal[oa]?s?|(?:le|les)\s+(?:hace|hacen)\s+(?:mucho\s+)?dano|(?:le|les)\s+(?:da|dan)\s+alergia|se\s+(?:hincha|hinchan|inflama|inflaman|ahoga|ahogan|enferma|enferman)|(?:le|les)\s+(?:sale|salen)\s+ronchas?)\b`;
const OTRA_PERSONA_SI = String.raw`(?:[,;.!?\n]|\b(?:pero|aunque|y)\b)\s*(?:a\s+)?(?:mi|mis|su|sus|nuestr[oa]s?)\s+${FRASE_PERSONA_ES}\s+si\b(?:(?:\s+(?:lo\s+es|lo\s+son|es|son|tiene|tienen))?(?=\s*(?:[.,;!?\n]|$))|${REACCION_TRAS_SI})|(?:[,;.!?\n]|\b(?:but|and)\b)\s*(?:but\s+)?(?:my|his|her|our|their)\s+${FRASE_PERSONA_EN}\s+(?:is|are|does|do|has|have)\b(?=\s*(?:[.,;!?\n]|$))`;
// Revisión 54: «pero/aunque … sí» solo afirma si tras el «sí» termina la cláusula («bueno sí», «pero mi hijo sí»), viene
// un alérgeno («pero sí al cacahuate»), «tengo/tiene…» o una reacción. «pero sí quiero / me da / voy a pedir / pido…» es
// el pedido (bloqueaba crear_pedido hasta 120 min). Lo demás («pero sí soy alérgico», «sí me salen ronchas») lo leen
// PATRON_DECLARACION_ALERGIA y REACCION_CUERPO sobre el resto.
const SIGUE_AFIRMACION = String.raw`(?:(?=\s*(?:[.,;!?\n]|$))|\s+${ARTICULO_AFIRMACION}${ALERGENO_MODISMO}\b|\s+(?:a|al|a\s+la|a\s+los|a\s+las)\s+${ALIMENTO_ALERGENO}\b|\s+(?:tengo|tiene|tienen|tenemos)\b|${REACCION_TRAS_SI})`;
// Revisión 56 (R56-7): «pero sí» seguido, en la misma cláusula, de «sin <alérgeno>» («no tengo alergias, pero sí mi hijo
// quiere sin cacahuate») también la afirma. Solo con un ALÉRGENO: «pero sí quiero 2 tacos sin cebolla» es el pedido.
const SIN_ALERGENO_TRAS_SI = String.raw`\b(?:pero|aunque|bueno)\b[^\n]*\bsi\b[^.!?\n,;]{0,40}?\bsin\s+${ARTICULO_AFIRMACION}${ALERGENO_MODISMO}\b`;
const AFIRMACION_TRAS_NEGACION = new RegExp(
  String.raw`${SIN_ALERGENO_TRAS_SI}|\b(?:pero|aunque|bueno|excepto|salvo|menos)\b[^\n]*\bsi\b${SIGUE_AFIRMACION}|\b(?:excepto|salvo|menos)\b[^\n]{0,40}?(?:\b${ALIMENTO_ALERGENO}\b|${PALABRA_ALERGIA})|\b(?:si|solo|nomas)\s*,?\s+(?:a|al|a\s+la|a\s+los|a\s+las)\s+${ALIMENTO_ALERGENO}\b|\b(?:solo|solamente|nomas|unicamente|only|just)\s*,?\s+${ARTICULO_AFIRMACION}${ALERGENO_MODISMO}\b|\b${ALERGENO_MODISMO}\s*,?\s*si\b|${OTRA_PERSONA_SI}`,
);
// Revisión 28: el alimento solo hace dudosa una negación si va PEGADO a la alergia («no tengo alergia al cacahuate»:
// conservador, se registra). Suelto («no tengo alergias, dos tacos de pollo», «sin alergias, con queso») es el pedido.
const ALERGIA_A_ALIMENTO = new RegExp(
  String.raw`${PALABRA_ALERGIA}\s+(?:a|al|de|del|a\s+la|a\s+los|a\s+las)\s+(?:(?:el|la|los|las|un|una|mi|su)\s+)?${ALIMENTO_ALERGENO}\b`,
);
/** Partición en oraciones (la misma en el texto original y en el plano: los signos no cambian al normalizar). */
const PARTIR_ORACIONES = /(?<=[.!?;\n])/;

// Revisión 32: en vez de más patrones de cercanía (cada ronda cambiaba un fallo por otro), reglas sobre el RESTO del
// mensaje (todas las oraciones, sin las frases de negación). Una palabra de excepción, con errores comunes.
const EXCEPCION_PALABRA =
  /\b(?:excepto|exepto|exeto|ecepto|exceto|exceptuando|excepcion|excluyendo|salvo|aparte|fuera\s+del?|except|excepting|apart\s+from|aside\s+from|other\s+than|besides)\b/;
const ALIMENTO_PALABRA = new RegExp(String.raw`\b${ALIMENTO_ALERGENO}\b`);
// «me cae mal / pesado», «me sienta mal», «me hace mal» con un alimento en el resto del mensaje (malestar por un alimento).
const CAE_MAL_UNA = new RegExp(CAE_MAL);
/**
 * Revisión 28: de cada oración (ya sin acentos y en minúsculas), ¿es una negación PURA de alergia? (ver
 * sinNegacionesPurasDeAlergia). Pura.
 * Revisión 32 (más simple): se mira el RESTO del mensaje (todas las oraciones, sin las frases de negación). La negación
 * NO se descarta (cuenta como declaración: aviso) si ese resto trae una reacción del cuerpo (REACCION_CUERPO: ronchas,
 * pica, garganta, arde, ahogo, hinchazón…), una excepción o un «me cae/sienta mal» con un alimento («aparte de la
 * cebolla», «fuera del cilantro», «excepto el ajo», «el queso me sienta mal»), otra declaración, una afirmación («pero mi hijo sí», «solo al cacahuate») o un alimento
 * pegado a la alergia («no tengo alergia al cacahuate»). Un alimento SOLO («no tengo alergias, 2 tacos de pollo», «sin
 * alergias, con queso») o una excepción sin alimento («Comemos fuera de casa») no la anulan: es el pedido, y el
 * clasificador semántico lo lee de todos modos (la palabra «alergia» pasa su prefiltro).
 */
function negacionesPuras(oraciones: string[]): boolean[] {
  const resto = oraciones.join("").replace(ALERGIA_NEGADA, " ");
  const contradicha = REACCION_CUERPO.test(resto) ||
    ((EXCEPCION_PALABRA.test(resto) || CAE_MAL_UNA.test(resto)) && ALIMENTO_PALABRA.test(resto)) ||
    PATRON_DECLARACION_ALERGIA.test(resto) ||
    AFIRMACION_TRAS_NEGACION.test(resto);
  return oraciones.map((o) => !contradicha && ALERGIA_NEGADA_UNA.test(o) && !ALERGIA_A_ALIMENTO.test(o));
}

/**
 * Revisión 27 (seguridad primero: un aviso de más es aceptable, una alergia perdida no): el texto (ya sin acentos y en
 * minúsculas) sin las negaciones PURAS de alergia. Una oración con una negación («no tengo alergias», «sin alergias»,
 * «nadie es alérgico») solo se descarta si, quitada la negación, no queda otra declaración ni un alimento PEGADO a la
 * alergia (revisión 28), y si después (en esa oración o en las siguientes) no viene una afirmación («bueno sí, al
 * cacahuate», «pero mi hijo sí»). «Ya lo saben / ya les dije» NO descarta nada: una alergia dicha siempre se registra.
 */
function sinNegacionesPurasDeAlergia(plano: string): string {
  const oraciones = plano.split(PARTIR_ORACIONES);
  const puras = negacionesPuras(oraciones);
  return oraciones.map((o, i) => (puras[i] ? o.replace(ALERGIA_NEGADA, " ") : o)).join("");
}

/** Texto sin acentos y en minúsculas, con el índice en el original de cada carácter (y uno más al final). Pura. */
function planoConMapa(original: string, padres = false): { plano: string; mapa: number[] } {
  let plano = "";
  const mapa: number[] = [];
  let i = 0;
  for (const ch of original) {
    let p = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
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
 * Revisión 28: lo que la nota de cocina cita de un mensaje del cliente: sin las oraciones que son negaciones puras y
 * sin las frases de negación de las demás («no tengo alergia al cacahuate» => «al cacahuate»: conservador). La nota
 * nunca cita una negación. Conserva acentos y mayúsculas del original. Pura.
 */
export function textoDeclaradoSinNegaciones(original: string): string {
  const oraciones = String(original ?? "").split(PARTIR_ORACIONES);
  const conMapa = oraciones.map((o) => planoConMapa(o, true));
  const puras = negacionesPuras(conMapa.map((x) => x.plano));
  const partes: string[] = [];
  oraciones.forEach((o, i) => {
    if (puras[i]) return;
    const x = conMapa[i];
    if (!x) return;
    const { plano, mapa } = x;
    let salida = "";
    let desde = 0;
    for (const m of plano.matchAll(ALERGIA_NEGADA)) {
      salida += o.slice(mapa[desde], mapa[m.index!]) + " ";
      desde = m.index! + m[0].length;
    }
    salida += o.slice(mapa[desde]);
    // Revisión 56 (R56-8): sin la negación quedaba la puntuación suelta («PAPÁS: , pero sí al camarón»): se quita el espacio
    // antes de un signo y la coma o el punto y coma que sigue a otro signo.
    // Tras colapsar los espacios, «\s+» antes de un signo es un solo espacio (sin cuantificador: CodeQL js/polynomial-redos).
    const limpia = salida.replace(/\s+/g, " ").replace(/ ([.,;:!?…])/g, "$1").replace(/([.,;:!?…])(?: ?[,;])+/g, "$1")
      .replace(/^[\s.,;:!?…-]+/, "").trim();
    if (limpia && /[\p{L}\p{N}]/u.test(limpia)) partes.push(limpia);
  });
  return partes.join(" ");
}

/**
 * Revisión 54: el plano de las alergias. Sin acentos «papás» (los padres) y «papas» (la comida) se confundían: «papá(s)»
 * con acento pasa a «papi(s)», que no es comida («no tengo alergias, mis papás sí» sigue avisando). Pura.
 */
function planoAlergia(texto: string): string {
  return String(texto ?? "").normalize("NFD").replace(/\b(pap)a\u0301(s?)(?![a-z])/gi, "$1i$2")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Revisión 26/27: ¿el cliente DECLARA una alergia o restricción (no es una negación pura)? Pura. */
export function declaraAlergia(texto: string): boolean {
  const plano = planoAlergia(texto);
  return PATRON_DECLARACION_ALERGIA.test(sinNegacionesPurasDeAlergia(plano));
}

const PREFERENCIA_CAE_MAL = new RegExp(CERCA_DE_ALIMENTO(CAE_MAL_PREFERENCIA, ALIMENTO_ALERGENO));
/**
 * Revisión 75 (R75-1): las cláusulas (texto original) de un «me cae(n) mal / pesado», «me hace mal» con un alimento que NO
 * es alergia (sin palabra de salud: declaraAlergia lo descarta). [] si no hay o si el mensaje sí declara una alergia. Pura.
 */
export function preferenciasCaeMal(texto: string): string[] {
  if (declaraAlergia(texto)) return [];
  return String(texto ?? "").split(/[,;.!?\n]+/).map((c) => c.trim())
    .filter((c) => c && PREFERENCIA_CAE_MAL.test(planoAlergia(c)));
}
/**
 * Revisión 76 (R76-5): el texto sin las cláusulas de preferencia «me cae(n) mal X» (lo demás, para el clasificador de
 * alergia). Revisión 77 (R77-9): además del corte de preferenciasCaeMal, corta en « y » / « pero » («me cae mal el cerdo y a
 * mi hijo la nuez lo pone malito» manda «a mi hijo la nuez lo pone malito»): ante la duda, al clasificador. Pura.
 */
export function sinClausulasCaeMal(texto: string): string {
  return partirClausulas(String(texto ?? "")).map((c) => c.trim())
    .filter((c) => c && !PREFERENCIA_CAE_MAL.test(planoAlergia(c))).join(", ");
}

/**
 * Las cláusulas de un texto: cortes en [,;.!?\n]+ y en « y » / « e » / « pero » (con espacios de cualquier largo a los dos lados), lo mismo que el split
 * `/[,;.!?\n]+|\s+(?:y|e|pero)\s+/i` pero en tiempo lineal (CodeQL js/polynomial-redos: ese regex era cuadrático con muchos espacios). Pura.
 */
function partirClausulas(texto: string): string[] {
  const salida: string[] = [];
  for (const pieza of texto.split(/[,;.!?\n]+/)) {
    const fichas = pieza.match(/\s+|\S+/g) ?? [];
    let actual = "";
    for (let i = 0; i < fichas.length; i++) {
      const f = fichas[i]!;
      const sig = fichas[i + 1];
      if (/^\s/.test(f) && sig !== undefined && /^(?:y|e|pero)$/i.test(sig) && fichas[i + 2] !== undefined && /^\s/.test(fichas[i + 2]!)) {
        salida.push(actual);
        actual = "";
        i += 2;
        continue;
      }
      actual += f;
    }
    salida.push(actual);
  }
  return salida;
}
const TOPE_NOTA_PREFERENCIA = 300;
/**
 * Revisión 75 (R75-1): la nota del pedido con lo que al cliente «no le cae bien» en la sesión (no es alergia: el pedido se
 * toma normal y cocina lo evita). null si no dijo nada así. Pura.
 */
export function notaPreferenciaDelPedido(messages: readonly MensajeSalud[]): string | null {
  let inicio = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (esMarcadorSesion(messages[i])) {
      inicio = i + 1;
      break;
    }
  }
  const textos: string[] = [];
  for (const m of messages.slice(inicio)) {
    if (m?.role === "user" && typeof m.content === "string") textos.push(...preferenciasCaeMal(m.content));
  }
  const unicos = [...new Set(textos)];
  if (unicos.length === 0) return null;
  return hastaPuntosDeCodigo(
    sinControles(`PREFERENCIA (no es alergia): no le cae bien «${unicos.map((u) => citaDelCliente(u, TOPE_NOTA_PREFERENCIA)).join(" / ")}»; evitarlo.`).replace(/\s+/g, " "),
    TOPE_NOTA_PREFERENCIA,
  );
}
/** Revisión 75 (R75-1): las notas del modelo con la de preferencia al final (sin duplicarla). Pura. */
export function notasConPreferencia(notaPreferencia: string | null, notas: unknown): string | undefined {
  const propias = typeof notas === "string" && notas.trim() ? notas.trim() : "";
  if (!notaPreferencia || propias.includes(notaPreferencia)) return propias || undefined;
  return propias ? `${propias}\n${notaPreferencia}` : notaPreferencia;
}

/** Revisión 56 (R56-10): la respuesta fija de alergia para el cliente que escribe en inglés (mismas frases obligatorias). */
export const ALERGIA_REPLY_EN =
  `Thank you for letting us know, it's important. ${ALERGIA_SIN_GARANTIA_EN} I've notified the branch so that ${ALERGIA_ANTES_DEL_PEDIDO_EN}.`;
/**
 * Revisión 87 (R87-O): la alergia dicha con un pedido en curso (ya se anotó en sus notas): la sucursal la confirma para ese
 * pedido (no «antes de tomar su pedido»).
 */
const ALERGIA_EN_CURSO_AVISADA = "Ya avisé a la sucursal de su alergia para su pedido en curso; una persona le confirma.";
const ALERGIA_EN_CURSO_AVISADA_EN = "I've notified the branch about your allergy for your current order; a person will confirm it with you.";
export const ALERGIA_PEDIDO_EN_CURSO_REPLY = `Gracias por avisarnos, es importante. ${ALERGIA_SIN_GARANTIA} ${ALERGIA_EN_CURSO_AVISADA}`;
export const ALERGIA_PEDIDO_EN_CURSO_REPLY_EN =
  `Thank you for letting us know, it's important. ${ALERGIA_SIN_GARANTIA_EN} ${ALERGIA_EN_CURSO_AVISADA_EN}`;
/**
 * Revisión 87 (R87-O): una reacción («me dio alergia», «me estoy hinchando», «no puedo respirar»): es salud, no una alergia
 * que declarar antes de pedir; la respuesta pide atención médica de inmediato y siempre deja aviso.
 */
export const SALUD_REACCION_REPLY =
  `Lamento mucho lo que me cuenta: busque atención médica de inmediato. Ya avisé a la sucursal para que una persona lo contacte de inmediato. ${SALUD_SIN_DIAGNOSTICO}`;
/** Revisión 87 (R87-O): palabras de una reacción alérgica o de salud en curso (texto plano: minúsculas y sin acentos). */
// Revisión 88 (R88-2): «se me cerró» solo con la garganta («se me cerró la app» no es salud).
// Revisión 89 (R89-3): también «se me cerró la boca y la garganta» y «siento la garganta cerrada».
const REACCION_DE_SALUD =
  /\b(?:me\s+(?:dio|dieron|causo|provoco)\s+(?:una\s+)?(?:alergia|reaccion)|(?:me\s+)?estoy\s+hinchand\w*|se\s+me\s+(?:hincho|hincharon|inflamo|inflamaron)\b|se\s+me\s+(?:cierra|cierran|cerro|cerraron|esta\s+cerrando|estan\s+cerrando)\s+(?:(?:la|el|los|las|mi|mis)\s+[a-z]+\s+(?:y|e)\s+)?(?:la\s+|mi\s+)?garganta\b|(?:siento|tengo|se\s+me\s+siente)\s+(?:la\s+|mi\s+)?garganta\s+(?:cerrada|hinchada|inflamada|apretada)|me\s+hinche\b)/;
/**
 * Revisión 91 (R91-1): la falta de aire es salud POR DEFECTO: «no puedo respirar», «me falta el aire», «me ahogo», «me estoy
 * ahogando», «siento que me ahogo», en tercera persona («mi hijo se está ahogando») y en inglés («I can't breathe», «my throat
 * is closing», «choking»). Ya no exige otra palabra de salud (R90-2).
 */
// «me ahogo» con «con <algo>» antes («con la nuez me ahogo») es la alergia que declara (R30-3), no una reacción en curso; el
// progresivo («con el taco me estoy ahogando») sí es salud.
const AHOGO_FUENTE = String.raw`(?:siento\s+que\s+)?(?:(?<!\bcon\b[^.!?\n]{0,40})me\s+ahogo|(?:me|se)\s+(?:estoy|esta|estan)\s+ahogando)`;
const FALTA_DE_AIRE_FUENTE = String.raw`(?:no\s+puedo\s+respirar|me\s+cuesta\s+(?:trabajo\s+)?respirar|me\s+falta\s+el\s+aire|${AHOGO_FUENTE}|(?:i|he|she|they|we|(?:my|our)\s+[a-z]+)\s+(?:can\W?t|cannot|can\s+not)\s+breathe|(?:my|his|her|their)\s+throat\s+is\s+(?:closing|swelling)|chok(?:ing|ed)\b)`;
const FALTA_DE_AIRE = new RegExp(String.raw`\b${FALTA_DE_AIRE_FUENTE}`);
/**
 * Revisión 91 (R91-1): la única excepción: el objeto figurado PEGADO a la frase («me ahogo de calor», «me estoy ahogando en
 * trabajo / en deudas / en el tráfico», «me ahogo de lo rico / de lo picoso», y la risa pegada a cualquier falta de aire: «no
 * puedo respirar de risa»). Se borra; si no queda otra falta de aire y no hay otro síntoma, no es salud.
 */
const RISA_PEGADA = String.raw`de\s+(?:la\s+)?risa|de\s+tanto\s+(?:que\s+)?(?:me\s+)?(?:rei|reir|reirme|reimos)`;
const OBJETO_FIGURADO = String.raw`de(?:l)?\s+(?:calor|bochorno|lo\s+(?:rico|picoso|picante|sabroso|bueno))|en\s+(?:(?:el|la|los|las|mi|mis|puro|pura|puros|puras)\s+)?(?:trabajo|chamba|deudas?|trafico|tareas?|pendientes)`;
const FALTA_DE_AIRE_FIGURADA = new RegExp(
  String.raw`\b${AHOGO_FUENTE}\s+(?:${OBJETO_FIGURADO})\b|\b${FALTA_DE_AIRE_FUENTE}(?:\s+(?:bien|nada))?\s+(?:${RISA_PEGADA})\b|\b(?:${RISA_PEGADA})[\s,]+(?:ya\s+)?${FALTA_DE_AIRE_FUENTE}`,
  "g",
);
/**
 * Revisión 89 (R89-3) / 91 (R91-1): otro síntoma en el mensaje (ronchas, hinchado, «me pica la garganta», «tenía cacahuate» o
 * un alérgeno que traía la comida): con él, ni el objeto figurado cancela la falta de aire.
 */
const OTRA_PALABRA_DE_SALUD = new RegExp(
  String.raw`\b(?:roncha\w*|me\s+siento\s+mal|me\s+senti\s+mal|hinch\w*|me\s+pica\w*|pica\s+todo|comezon|garganta|mare\w*|vomit\w*|nause\w*|alergi\w*|reaccion|me\s+duele|dolor|inflam\w*|sarpullido|desmay\w*|en\s+serio|(?:tenia|tenian|traia|traian|tiene|tienen|trae|traen|llevaba|llevaban|lleva|llevan)\s+(?:(?:el|la|los|las)\s+)?(?:${ALERGENO_MODISMO}))\b`,
);
/** Revisión 87 (R87-O) / 88 (R88-2) / 89 (R89-3) / 91 (R91-1): ¿el texto plano (minúsculas y sin acentos) cuenta una reacción de salud en curso? */
function reaccionDeSaludEnPlano(plano: string): boolean {
  if (REACCION_DE_SALUD.test(plano)) return true;
  // Revisión 93 (R93-1): otra persona que se ahoga o no respira («mi mamá no puede respirar») también es salud.
  if (OTRO_SE_AHOGA.test(plano)) return true;
  if (!FALTA_DE_AIRE.test(plano)) return false;
  // Revisión 91 (R91-1): salud salvo que TODA falta de aire lleve su objeto figurado pegado y no haya otro síntoma.
  return FALTA_DE_AIRE.test(plano.replace(FALTA_DE_AIRE_FIGURADA, " ")) || OTRA_PALABRA_DE_SALUD.test(plano);
}
/** Revisión 91 (R91-1): ¿el texto nombra un alérgeno típico (ALERGENO_MODISMO)? Pura. */
export function nombraAlergeno(texto: string): boolean {
  return new RegExp(String.raw`\b(?:${ALERGENO_MODISMO})\b`).test(normAviso(texto));
}
/** Revisión 87 (R87-O): ¿el texto cuenta una reacción de salud en curso? Pura. */
export function esReaccionDeSalud(texto: string): boolean {
  return reaccionDeSaludEnPlano(normAviso(texto));
}
/**
 * Revisión 92 (R92-1): la línea corta que el servidor antepone cuando el aviso de salud ya quedó y la ráfaga pide algo más
 * (un pedido, agregar, una pregunta): el turno NO se reemplaza por la respuesta fija de salud.
 */
export const SALUD_LINEA_CORTA = "Si se siente mal, busque atención médica; ya avisé a la sucursal.";
export const SALUD_LINEA_CORTA_EN = "If you feel unwell, please seek medical attention; I've already notified the branch.";
/** Revisión 92 (R92-1): pedir algo fuera de la frase de salud (cantidad, verbo de pedir, dirección, pago; en inglés también). */
const PIDE_ALGO_FUERA_DE_SALUD = new RegExp(
  String.raw`\d|\b(?:quiero|queremos|quisiera|dame|deme|denme|mandame|mandeme|mandenme|manden|mandalo|mandalos|pasame|paseme|pasenme|traeme|traigame|traiganme|ponme|pongame|ponganme|ponle|agreg\w*|pideme|pidame|me\s+(?:da|das|den|manda|mandas|manden|pasa|pasan|trae|traen)|calle|domicilio|direccion|colonia|recoger|recojo|tarjeta|efectivo|transferencia|can\s+you|could\s+you|i\s+want|i\s?d\s+like|add|send|order|deliver)\b`,
);
/** Revisión 92 (R92-1): una pregunta que es del pedido o del negocio («¿ya viene?», «¿cuánto tarda?»), no de la salud. */
const PREGUNTA_DEL_PEDIDO =
  /\b(?:viene|vienen|llega|llegan|sale|salio|pedido|orden|cuanto|cuesta|tarda|tardan|hora|menu|precio|abren|cierran|where|when|how\s+much|how\s+long)\b/;
/** Revisión 92 (R92-1): pedir ayuda de emergencia: con esto el mensaje es de salud aunque traiga una dirección o un número. */
const PIDE_AYUDA_DE_EMERGENCIA = /\b(?:ambulancia|hospital|urgencias|emergencia|auxilio|ayuda|ayudenme|ayudeme|help|911)\b/;
/** El patrón del malestar (SALUD_MALESTAR, intent salud) en versión global. */
const saludPatronGlobal = () => new RegExp(SALUD_MALESTAR.source, "g");
/**
 * Revisión 92 (R92-1): ¿la ráfaga con el aviso de salud pide ALGO MÁS (un pedido, agregar, una pregunta del pedido)? Se quita
 * de cada burbuja la frase de salud (falta de aire, reacción, malestar) y se mira lo que queda, cláusula por cláusula. El
 * detector de salud no cambia: solo decide si el turno sigue al modelo (con la línea corta delante) o es la respuesta fija
 * de salud (mensaje de salud puro o que pide ayuda de emergencia). Pura.
 */
export function saludConOtraPeticion(textos: readonly string[]): boolean {
  const planos = textos.map((t) => normAviso(t));
  if (planos.some((p) => PIDE_AYUDA_DE_EMERGENCIA.test(p))) return false;
  return planos.some((plano) => {
    const sinSalud = plano
      .replace(new RegExp(REACCION_DE_SALUD.source, "g"), " , ")
      .replace(new RegExp(String.raw`\b${FALTA_DE_AIRE_FUENTE}`, "g"), " , ")
      .replace(saludPatronGlobal(), " , ");
    return sinSalud.split(/[,.;:!\n]+|\s+(?:y|e|pero)\s+|(?<=\?)/).some((c) => {
      const clausula = c.trim();
      if (clausula === "" || esCortesiaSola(clausula)) return false;
      return PIDE_ALGO_FUERA_DE_SALUD.test(clausula) || (/\?/.test(clausula) && PREGUNTA_DEL_PEDIDO.test(clausula));
    });
  });
}
/** Revisión 92 (R92-1): el aviso de salud ya quedó y la ráfaga pide algo más: el modelo atiende lo demás. Pura. */
export function bloqueSaludYaRegistrada(respuesta: string): string {
  return `AVISO DE SALUD YA REGISTRADO EN ESTE TURNO: el cliente mencionó algo que puede ser un malestar; ya quedó avisado a la sucursal y el cliente ya recibe este texto antes de tu respuesta: «${respuesta}». No lo vuelvas a registrar (no llames a registrar_contacto por eso), no repitas ese texto, no diagnostiques ni garantices ingredientes. Atiende SOLO lo demás que pide el cliente (un pedido, agregar algo a su pedido, una pregunta) con el flujo normal.`;
}
/** Revisión 93 (R93-1): la garganta que se cierra («se me cerró / cierra la garganta», «my throat is closing»). */
const GARGANTA_CERRANDO =
  /\bse\s+me\s+(?:cierra|cierran|cerro|cerraron|esta\s+cerrando|estan\s+cerrando)\s+(?:(?:la|el|los|las|mi|mis)\s+[a-z]+\s+(?:y|e)\s+)?(?:la\s+|mi\s+)?garganta\b|\b(?:siento|tengo)\s+(?:la\s+|mi\s+)?garganta\s+cerrada\b|\bthroat\s+(?:is\s+)?(?:closing|closed|swelling)\b/;
/**
 * Revisión 93 (R93-1): otra persona (un niño, un familiar) que se ahoga o no respira, en español y en inglés. Seguido de «con /
 * cuando / si» («mi niño no puede respirar con la leche») es la alergia que se declara, no una emergencia en curso.
 */
const OTRO_SE_AHOGA = new RegExp(
  String.raw`\b(?:mi|mis|su|el|la)\s+(?:${"mama|mamas|papa|papas|madre|padre|hermano|hermana|esposa|esposo|hijo|hija|hijos|hijas|tia|tio|abuela|abuelo|suegra|suegro|novia|novio|amigo|amiga|prima|primo|vecino|vecina|bebe|nino|nina|nene|nena|nieto|nieta|senor|senora"})\b[^.!?\n]{0,30}\b(?:se\s+(?:esta|estan)\s+ahogando|se\s+ahoga|se\s+atraganto|esta\s+atragantad[oa]|no\s+puede\s+respirar|no\s+respira)\b(?!\s+(?:con|cuando|si)\b)` +
    String.raw`|\b(?:(?:my|our|his|her)\s+(?:son|daughter|kid|child|baby|boy|girl|mom|mother|dad|father|wife|husband|friend|brother|sister|grandma|grandpa)|he|she)\s+(?:is\s+|s\s+)?(?:choking|can\W?t\s+breathe|cannot\s+breathe|isn\W?t\s+breathing|is\s+not\s+breathing|not\s+breathing)\b`,
);
/** Revisión 93 (R93-1): pedir que alguien venga, llame o lo atienda («manden a alguien», «vengan», «me pasan con alguien», «llamen»). */
const PIDE_A_ALGUIEN =
  /\b(?:alguien|vengan|venga|llamen|llamenle|llame|marquen|ambulancia|hospital|urgencias|emergencia|auxilio|ayuda|ayudenme|ayudeme|me\s+(?:pasan|pasas|comunican)\s+con|send\s+(?:someone|somebody|help)|come|call|help|911)\b/;
/** Revisión 93 (R93-1): una dirección dicha junto a la falta de aire, sin pedir comida. */
const DIRECCION_SIN_COMIDA = (p: string) =>
  /\b(?:calle|domicilio|direccion|estoy\s+en)\b/.test(p) && !/\b(?:tacos?|cocas?|ordenes?|pedido|quiero|mandenme|mandame|tortas?|refrescos?)\b/.test(p);
/** Revisión 93 (R93-1): la reacción a un alérgeno («me dio alergia», «tenía cacahuate», un alérgeno nombrado). */
const REACCION_A_ALERGENO = new RegExp(
  String.raw`\b(?:me\s+(?:dio|dieron|causo|provoco)\s+(?:una\s+)?(?:alergia|reaccion)|allergic\s+reaction|(?:${ALERGENO_MODISMO}))\b`,
);
/**
 * Revisión 93 (R93-1): ¿la ráfaga trae una señal FUERTE de emergencia de salud? La garganta que se cierra; otra persona (un
 * niño, un familiar) que se ahoga o no respira; la falta de aire junto con pedir a alguien (que vengan, que llamen, que lo
 * pasen con alguien) o una dirección sin comida; la falta de aire o la garganta junto con un alérgeno o «me dio alergia».
 * Con ella el turno es la respuesta fija de salud y el aviso va URGENTE (nunca la línea corta ni contenido de venta). La
 * falta de aire sola o posiblemente figurada (R92-1) sigue con la línea corta. Pura.
 */
export function emergenciaDeSaludFuerte(textos: readonly string[]): boolean {
  const planos = textos.map((t) => normAviso(t));
  const todo = planos.join(" . ");
  if (planos.some((p) => GARGANTA_CERRANDO.test(p) || OTRO_SE_AHOGA.test(p))) return true;
  const sinFiguradas = todo.replace(FALTA_DE_AIRE_FIGURADA, " ");
  if (!FALTA_DE_AIRE.test(sinFiguradas)) return false;
  return PIDE_A_ALGUIEN.test(todo) || planos.some(DIRECCION_SIN_COMIDA) || REACCION_A_ALERGENO.test(todo);
}
const PALABRAS_EN = new Set([
  "i", "im", "i'm", "me", "my", "mine", "the", "a", "an", "to", "and", "or", "is", "am", "are", "was", "be", "have", "has", "had",
  "do", "does", "don't", "dont", "can't", "cant", "cannot", "not", "with", "of", "for", "in", "on", "please", "thanks", "thank",
  "you", "your", "he", "she", "his", "her", "we", "our", "they", "their", "son", "daughter", "wife", "husband", "kid", "kids",
  "allergic", "allergy", "allergies", "intolerant", "intolerance", "severe", "any", "food", "eat", "order", "want", "would", "like",
  "peanut", "peanuts", "nut", "nuts", "shrimp", "shellfish", "milk", "dairy", "egg", "eggs", "wheat", "sesame", "fish",
  // Revisión 83 (R83-3): las de un pedido corto («yes», «cash, exact change», «delivered to…»).
  "yes", "yeah", "yep", "sure", "cash", "card", "exact", "change", "delivered", "delivery", "pickup", "pay", "will", "it",
  "that", "this", "what", "how", "much", "just", "need", "more", "place",
]);
const PALABRAS_ES = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "que", "y", "o", "es", "soy", "son", "tengo", "tiene",
  "mi", "mis", "su", "sus", "por", "favor", "con", "sin", "para", "al", "alergia", "alergias", "alergico", "alergica", "alergicos",
  "quiero", "no", "si", "pero", "hijo", "hija", "esposa", "esposo", "gracias", "tacos", "taco", "pedido", "me", "le", "puede",
]);
/**
 * Revisión 56 (R56-10): ¿los textos están en inglés? Heurística simple (no hay detección de idioma en el agente): más
 * palabras frecuentes del inglés que del español, y al menos dos. «soy celiac, 2 tacos de pollo» sigue en español. Pura.
 */
export function esTextoEnIngles(textos: string[]): boolean {
  const { en, es } = puntajeIdioma(textos);
  return en >= 2 && en > es;
}

/** Revisión 83 (R83-3): palabras frecuentes del inglés y del español en los textos. Pura. */
function puntajeIdioma(textos: string[]): { en: number; es: number } {
  const palabras = textos.join(" ").toLowerCase().replace(/[’`]/g, "'").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z']+/).filter(Boolean);
  let en = 0;
  let es = 0;
  for (const w of palabras) {
    // «me» es de los dos idiomas: no cuenta.
    if (w === "me") continue;
    if (PALABRAS_EN.has(w)) en++;
    if (PALABRAS_ES.has(w)) es++;
  }
  return { en, es };
}


/**
 * Revisión 25 (seguridad): la respuesta de alergia promete que «una persona le confirme directamente antes de tomar su
 * pedido» (pm-policies: «no tomes el pedido hasta que una persona de la sucursal lo confirme»; desde la revisión 27 el
 * prompt también dice qué hacer si pasada la ventana el sistema lo permite). Mientras el aviso siga abierto, crear_pedido
 * se rechaza con este texto: no se crea nada y el modelo no promete el pedido.
 */
export const RECHAZO_ALERGIA_SIN_CONFIRMAR =
  "El cliente avisó de una alergia o restricción de salud y la sucursal todavía no le confirma: NO se creó el pedido. Por su seguridad, el pedido espera a que una persona de la sucursal le confirme lo de la alergia. No vuelva a llamar a crear_pedido en este turno, no le diga que su pedido quedó registrado ni le prometa que sale, y no le garantice ingredientes. Dígale con amabilidad que la sucursal ya tiene su aviso, que una persona de la sucursal se va a comunicar con él para confirmarlo y que, en cuanto le confirme, se toma su pedido.";

/** El rechazo con el teléfono de la sucursal, si se conoce: el cliente puede llamar en vez de esperar. */
export function rechazoAlergiaSinConfirmar(sucursal: { name?: string | null; phone?: string | null } | null): string {
  const tel = String(sucursal?.phone ?? "").trim();
  if (!tel) return RECHAZO_ALERGIA_SIN_CONFIRMAR;
  const nombre = String(sucursal?.name ?? "").trim();
  return `${RECHAZO_ALERGIA_SIN_CONFIRMAR} Ofrézcale también llamar directamente a la sucursal${nombre ? ` ${nombre}` : ""} al ${tel} si prefiere no esperar.`;
}

/**
 * Revisión 26 — DECISIÓN (pendiente de confirmar con el dueño): el pedido de un cliente con una alergia avisada espera
 * hasta que la sucursal resuelve ese aviso (callback_requests.resolved) O hasta VENTANA_BLOQUEO_ALERGIA_MIN minutos
 * después del aviso, lo que pase primero. Pasada la ventana sin respuesta de la sucursal el pedido se puede tomar (la
 * respuesta fija ya le dijo al cliente que no se garantizan ingredientes, y el personal ya recibió la alerta).
 */
export const VENTANA_BLOQUEO_ALERGIA_MIN = 120;
export const RAZON_ALERGIA = "alto_riesgo:alergia";
/** Marca (dentro de RECHAZO_ALERGIA_SIN_CONFIRMAR) de que ya hubo un rechazo por alergia en la sesión. */
export const MARCA_RECHAZO_ALERGIA = "Por su seguridad, el pedido espera a que una persona de la sucursal le confirme lo de la alergia.";
/** Evento de la alerta urgente del primer bloqueo (llave `cb:<aviso>:urgente:bloqueo-alergia`: una por aviso). */
export const EVENTO_BLOQUEO_ALERGIA = "bloqueo-alergia";

/**
 * Revisión 25: ¿en la sesión (desde el último marcador sesion_nueva) se le avisó al cliente de una alergia? Lo sabe por
 * la respuesta fija (la de un aviso o la de varios: ambas traen ALERGIA_ANTES_DEL_PEDIDO) o por un registrar_contacto
 * exitoso del modelo con un motivo de alergia. Pura.
 */
export function alergiaAvisadaEnSesion(messages: readonly MensajeSalud[]): boolean {
  return evidenciaAlergiaEnSesion(messages).avisada;
}

/** Revisión 26: lo que la sesión dice de una alergia, con la hora de la evidencia más reciente. */
export interface EvidenciaAlergia {
  /** Hay alergia en la sesión (aviso registrado o declaración del cliente). */
  avisada: boolean;
  /** Hora (ms) de la evidencia más reciente; null si ningún mensaje trae `at`. */
  atMs: number | null;
  /**
   * Revisión 26: declaraciones del cliente SIN un aviso registrado después (el agente estaba apagado o el registro
   * falló): hay que registrar el aviso. null si no hay ninguna pendiente. Revisión 27: `atMs` es la hora de la ÚLTIMA
   * declaración pendiente: una fila que solo cubre la primera (p. ej. resuelta entre las dos) no cubre la nueva.
   */
  pendiente: { atMs: number | null; textos: string[] } | null;
}

/** Revisión 28: textos que el clasificador semántico leyó como alergia, guardados en la respuesta del asistente. */
function textosAlergiaDeclarada(m: MensajeSalud | undefined): string[] {
  if (m?.role !== "assistant" || !Array.isArray(m.alergia_declarada)) return [];
  return m.alergia_declarada.filter((t: unknown): t is string => typeof t === "string" && t.trim() !== "");
}

/** Hora del mensaje i o, si no la trae, la del mensaje anterior más cercano que la tenga. */
function horaDeMensaje(messages: readonly MensajeSalud[], i: number): number | null {
  for (let j = i; j >= 0; j--) {
    const t = Date.parse(String(messages[j]?.at ?? ""));
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Revisión 25/26: evidencia de alergia en la sesión (desde el último marcador sesion_nueva): la respuesta fija (la de un
 * aviso o la de varios: ambas traen ALERGIA_ANTES_DEL_PEDIDO), un registrar_contacto exitoso del modelo con un motivo
 * de alergia o, desde la revisión 26, un mensaje del propio cliente que declara una alergia (declaraAlergia: no las
 * negaciones puras; desde la revisión 27, «ya lo saben» sí cuenta), incluso uno que llegó con el agente apagado. Pura.
 */
export function evidenciaAlergiaEnSesion(messages: readonly MensajeSalud[]): EvidenciaAlergia {
  let inicio = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (esMarcadorSesion(messages[i])) {
      inicio = i + 1;
      break;
    }
  }
  const llamadasAlergia = new Set<string>();
  let avisada = false;
  let atMs: number | null = null;
  // Declaraciones del cliente todavía sin un aviso registrado después.
  let pendientes: Array<{ i: number; texto: string }> = [];
  const marcar = (i: number) => {
    avisada = true;
    const t = horaDeMensaje(messages, i);
    if (t !== null && (atMs === null || t > atMs)) atMs = t;
  };
  const registrado = (i: number) => {
    marcar(i);
    pendientes = [];
  };
  for (let i = inicio; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string" && (declaraAlergia(m.content) || m.alergia_semantica === true)) {
      marcar(i);
      pendientes.push({ i, texto: m.content });
    }
    // Revisión 28: lo que el clasificador semántico leyó en un turno anterior viaja en la respuesta de ese turno
    // (el mensaje del cliente ya estaba guardado): cuenta como declaración, pendiente hasta que se registre su aviso.
    for (const texto of textosAlergiaDeclarada(m)) {
      marcar(i);
      pendientes.push({ i, texto });
    }
    // Revisión 56: también la respuesta fija en inglés (ALERGIA_REPLY_EN).
    if (
      m?.role === "assistant" && typeof m.content === "string" &&
      (m.content.includes(ALERGIA_ANTES_DEL_PEDIDO) || m.content.includes(ALERGIA_ANTES_DEL_PEDIDO_EN) ||
        // Revisión 87 (R87-O): la respuesta fija con un pedido en curso.
        m.content.includes(ALERGIA_EN_CURSO_AVISADA) || m.content.includes(ALERGIA_EN_CURSO_AVISADA_EN))
    ) registrado(i);
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        if (c?.function?.name !== "registrar_contacto") continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.function.arguments || "{}") ?? {};
        } catch { /* argumentos ilegibles */ }
        if (categoriaDeRazon(normAviso(args.reason)) === "alergia") llamadasAlergia.add(String(c.id));
      }
    }
    if (m?.role === "tool" && llamadasAlergia.has(String(m.tool_call_id))) {
      try {
        const r = JSON.parse(String(m.content));
        if (r && typeof r === "object" && !("error" in r)) registrado(i);
      } catch { /* resultado ilegible: no cuenta */ }
    }
  }
  const pendiente = pendientes.length > 0
    ? { atMs: horaDeMensaje(messages, pendientes[pendientes.length - 1]?.i ?? messages.length - 1), textos: [...new Set(pendientes.map((p) => p.texto))] }
    : null;
  return { avisada, atMs, pendiente };
}

/**
 * Revisión 27: ¿la fila de alergia `fila` es el aviso de una declaración hecha en `declaracionMs`? Una fila ABIERTA la
 * cubre si se creó después o a lo más VENTANA_AVISO_DUPLICADO_MIN antes (la sucursal ya está revisando ese caso; la
 * revisión 28 le anexa el texto nuevo); una RESUELTA solo si se creó después de la declaración (es su propio aviso) o,
 * desde la revisión 28, si su mensaje ya trae TODOS los textos de la declaración (se le anexaron y la sucursal la
 * resolvió con ellos). Una resuelta anterior sin esos textos era OTRA alergia y nunca absorbe una declaración nueva.
 */
export function filaCubreDeclaracion(fila: FilaAvisoAlergia | null, declaracionMs: number, textos: string[] = []): boolean {
  if (!fila) return false;
  const creada = Date.parse(String(fila.created_at ?? ""));
  if (!Number.isFinite(creada)) return false;
  if (fila.resolved === true) return creada >= declaracionMs || filaTraeTextos(fila, textos);
  return creada >= declaracionMs - VENTANA_AVISO_DUPLICADO_MIN * 60_000;
}

/** ¿El mensaje de la fila ya trae todos estos textos? (sin acentos ni mayúsculas; sin textos: false). */
function filaTraeTextos(fila: FilaAvisoAlergia | null, textos: string[]): boolean {
  const mensaje = normAviso(fila?.message);
  return textos.length > 0 && textos.every((t) => mensaje.includes(normAviso(t)));
}

/** Revisión 57 (R57-10): palabras que no dicen QUÉ alergia es (muletillas, recordatorio, la palabra alergia). */
const RELLENO_ALERGIA = new Set([
  "a", "al", "el", "la", "los", "las", "lo", "de", "del", "y", "e", "o", "que", "soy", "es", "somos", "son", "esta", "estoy",
  "sigo", "siendo", "mi", "mis", "su", "sus", "yo", "le", "les", "me", "nos", "ya", "se", "recuerden", "recuerde", "recuerda",
  "acuerdense", "acuerdese", "recordarles", "recordarle", "recuerdo", "repito", "reitero", "dije", "comente", "mencione",
  "como", "otra", "vez", "nuevamente", "nuevo", "por", "favor", "porfa", "gracias", "ok", "oigan", "oiga", "importante", "muy",
  "mucho", "eh", "pues", "tengo", "tiene", "tenemos", "hola", "buenas", "buenos", "dias", "tardes", "noches", "igual",
  "tambien", "recordar", "i", "m", "am", "im", "to", "the", "remember", "again", "please", "still", "is", "my",
]);
/**
 * Revisión 57 (R57-10): el texto solo REPITE una alergia ya escrita en el aviso (`previo`): toda palabra que no es relleno
 * ni la palabra alergia ya está en el aviso («recuerden que soy alergico al cacahuate» tras «soy alergico al cacahuate»).
 * Con algo nuevo (otro alérgeno, otra persona) no es repetición. Sin aviso previo: false. Pura.
 */
export function alergiaYaAvisada(previo: string, texto: string): boolean {
  const palabras = (s: string) => normAviso(s).replace(/[^a-z0-9ñ ]+/g, " ").split(/\s+/).filter(Boolean);
  const antes = new Set(palabras(previo).flatMap(formasSinPlural));
  if (antes.size === 0) return false;
  const clave = palabras(texto).filter((w) => !RELLENO_ALERGIA.has(w) && !/^(?:aler[gj]|aleg(?:i[ck]|ia)|allerg|intoleran|celiac)/.test(w));
  return clave.length > 0 && clave.every((w) => formasSinPlural(w).some((f) => antes.has(f)));
}

/** Resultado de leer el aviso de alergia más reciente del cliente. ok=false: la consulta falló. */
export interface ConsultaAvisoAlergia {
  ok: boolean;
    fila: FilaAvisoAlergia | null;
}

/** Revisión 26: decisión de la guarda de alergia y la fila abierta que la sostiene (para alertar al personal). */
export interface EstadoAlergia {
  bloquear: boolean;
    filaAbierta: FilaAvisoAlergia | null;
  /** Revisión 27: el cliente declaró una alergia y ninguna fila la cubre (el registro falló o la base no responde). */
  sinAviso?: { declaracionMs: number };
}

/**
 * Revisión 26 (pura): ¿el pedido espera la confirmación de una alergia? VENTANA_BLOQUEO_ALERGIA_MIN = V.
 *  - Revisión 27: una declaración del cliente sin aviso en el hilo (evidencia.pendiente) que ninguna fila cubre
 *    (filaCubreDeclaracion; o la consulta falló) bloquea SIN ventana: la sucursal nunca se enteró, así que no se libera
 *    a los V minutos. Solo libera cuando existe la fila y se resuelve o pasa su ventana.
 *  - Con alergia en la sesión: no espera si la fila más reciente está RESUELTA y es de este aviso (creada después de la
 *    evidencia, o a lo más VENTANA_AVISO_DUPLICADO_MIN antes: el aviso pudo anexarse a una abierta); una resuelta más
 *    vieja era OTRA alergia. Si no, espera hasta V minutos desde lo más reciente entre la evidencia y la fila abierta.
 *    Sin fila o con la base caída se mide desde la evidencia; sin hora en el hilo, se toma «ahora» (espera).
 *  - Sin alergia en la sesión: espera solo con una fila SIN resolver de menos de V minutos.
 */
export function decidirBloqueoAlergia(
  evidencia: EvidenciaAlergia,
  consulta: ConsultaAvisoAlergia,
  ahoraMs: number,
): EstadoAlergia {
  const ventanaMs = VENTANA_BLOQUEO_ALERGIA_MIN * 60_000;
  const fila = consulta.ok ? consulta.fila : null;
  const creada = fila ? Date.parse(String(fila.created_at ?? "")) : NaN;
  const abierta = fila && fila.resolved !== true ? fila : null;
  if (evidencia.avisada) {
    if (evidencia.pendiente) {
      const declaracionMs = evidencia.pendiente.atMs ?? ahoraMs;
      if (!filaCubreDeclaracion(fila, declaracionMs, evidencia.pendiente.textos)) {
        return { bloquear: true, filaAbierta: null, sinAviso: { declaracionMs } };
      }
    }
    const deEsteAviso = evidencia.atMs === null ||
      (Number.isFinite(creada) && creada >= evidencia.atMs - VENTANA_AVISO_DUPLICADO_MIN * 60_000);
    if (fila && fila.resolved === true && deEsteAviso) return { bloquear: false, filaAbierta: null };
    let desde = evidencia.atMs ?? ahoraMs;
    if (abierta && Number.isFinite(creada) && creada > desde) desde = creada;
    return ahoraMs - desde <= ventanaMs ? { bloquear: true, filaAbierta: abierta } : { bloquear: false, filaAbierta: null };
  }
  if (!abierta || !Number.isFinite(creada)) return { bloquear: false, filaAbierta: null };
  return ahoraMs - creada <= ventanaMs ? { bloquear: true, filaAbierta: abierta } : { bloquear: false, filaAbierta: null };
}

const TOPE_NOTA_ALERGIA = 400;
const TOPE_NOTAS_PEDIDO = 2000;

/**
 * Revisión 27: la nota «ALERGIA declarada: <texto>» de un pedido que se toma con una alergia en la sesión (pasada la
 * ventana o resuelto el aviso), para que cocina la vea. El texto es lo que dijo el cliente (declaraAlergia) o, si la
 * alergia vino de un registrar_contacto del modelo, su mensaje. null sin alergia en la sesión. Pura.
 */
export function notaAlergiaDelPedido(messages: readonly MensajeSalud[]): string | null {
  if (!evidenciaAlergiaEnSesion(messages).avisada) return null;
  let inicio = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (esMarcadorSesion(messages[i])) {
      inicio = i + 1;
      break;
    }
  }
  const textos: string[] = [];
  for (const m of messages.slice(inicio)) {
    if (m?.role === "user" && typeof m.content === "string" && (declaraAlergia(m.content) || m.alergia_semantica === true)) {
      // Revisión 28: la nota nunca cita una negación («no tengo alergias, dos tacos de pollo»).
      const declarado = textoDeclaradoSinNegaciones(m.content);
      if (declarado) textos.push(declarado);
    }
    for (const t of textosAlergiaDeclarada(m)) {
      const declarado = textoDeclaradoSinNegaciones(t);
      if (declarado) textos.push(declarado);
    }
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        if (c?.function?.name !== "registrar_contacto") continue;
        try {
          const args = JSON.parse(c.function.arguments || "{}") ?? {};
          if (categoriaDeRazon(normAviso(args.reason)) === "alergia" && typeof args.message === "string" && args.message.trim()) {
            textos.push(args.message.trim());
          }
        } catch { /* argumentos ilegibles */ }
      }
    }
  }
  const unicos = [...new Set(textos)];
  const detalle = unicos.length ? unicos.join(" / ") : "ver el aviso de alergia del cliente";
  return hastaPuntosDeCodigo(sinControles(`ALERGIA declarada: ${detalle}`).replace(/\s+/g, " "), TOPE_NOTA_ALERGIA);
}

/**
 * Las notas del pedido con la de alergia primero (las notas se acotan al consumirlas: la alergia no se corta). Revisión
 * 28: sin caracteres de control (salvo el salto de línea) y cortadas por punto de código.
 */
export function notasConAlergia(notaAlergia: string | null, notas: unknown): string | undefined {
  const propias = typeof notas === "string" && notas.trim() ? sinControles(notas).trim() : "";
  if (!notaAlergia) return propias || undefined;
  return hastaPuntosDeCodigo(propias ? `${notaAlergia}\n${propias}` : notaAlergia, TOPE_NOTAS_PEDIDO);
}

/** Las notas de un pedido YA creado con la línea de alergia al inicio (reemplaza una anterior: idempotente). Pura. */
export function notasDePedidoConAlergia(notaAlergia: string, notas: unknown): string {
  const sinAlergia = String(typeof notas === "string" ? notas : "")
    .split("\n")
    .filter((l) => !l.startsWith("ALERGIA declarada:"))
    .join("\n");
  return notasConAlergia(notaAlergia, sinAlergia) ?? notaAlergia;
}

/**
 * Revisión 28: textos del turno que el clasificador semántico lee como alergia o restricción y que la expresión regular
 * NO detecta. Solo los que traen una pista (debeClasificarAlergia); en paralelo, con plazo acotado por lo que le queda al
 * turno. Cualquier falla (sin llave, plazo, JSON inválido, excepción) => ese texto queda solo con la regex. Nunca lanza.
 * Cerebro v2: sin red propia; el clasificador, la llave y el tiempo que le queda al turno llegan inyectados. Se engancha
 * ANTES del modelo, con los textos del cliente del turno; su salida es `alergiaSemantica` de riesgosDeSalud / decidirSalud.
 */
export async function alergiasSemanticasDelTurno(
  textos: readonly string[],
  clasificador: ClasificadorAlergia | null,
  llave: () => Promise<string | null>,
  restanteMs: () => number,
): Promise<Set<string>> {
  const salida = new Set<string>();
  // Revisión 75 (R75-1): un «me caen mal los camarones» sin palabra de salud es preferencia (decisión de producto): esa
  // cláusula no se manda al clasificador, que la leería como alergia y frenaría el pedido.
  // Revisión 76 (R76-5, seguridad): solo se quita esa cláusula; el resto del mensaje («y a mi niño la leche lo pone
  // malito») sí se clasifica. Lo que el clasificador marca se avisa con el texto ORIGINAL.
  const originales = new Map<string, string>();
  for (const t of new Set(textos)) {
    if (!debeClasificarAlergia(t) || declaraAlergia(t)) continue;
    const resto = preferenciasCaeMal(t).length > 0 ? sinClausulasCaeMal(t) : t;
    if (resto && debeClasificarAlergia(resto) && !originales.has(resto)) originales.set(resto, t);
  }
  const candidatos = [...originales.keys()];
  if (candidatos.length === 0) return salida;
  const { grupos, sinLugar } = repartoClasificadorAlergia(candidatos);
  // Revisión 31/32 (seguridad primero): lo que no cupo en las llamadas del turno no se lee con el clasificador. Se decide
  // AQUÍ, antes de cualquier salida temprana (sin clasificador, sin llave, sin tiempo): solo si parece alergia (un
  // alérgeno o «alergia», o un alimento Y una reacción del cuerpo; ver pareceAlergiaSinClasificar) se avisa; el relleno
  // largo con un alimento común («pescado») no bloquea el pedido.
  const sobrante = sinLugar.filter((t) => pareceAlergiaSinClasificar(t));
  if (sinLugar.length > 0) {
    console.warn(`[alergia] ${sinLugar.length} texto(s) de la ráfaga no cupieron en el clasificador; ${sobrante.length} parecen alergia y se avisan`);
  }
  for (const t of sobrante) salida.add(originales.get(t) ?? t);
  if (!clasificador || grupos.length === 0) return salida;
  if (plazoClasificadorAlergia(restanteMs()) <= 0) return salida;
  let llaveLeida: string | null = null;
  try {
    llaveLeida = await llave();
  } catch {
    return salida;
  }
  if (!llaveLeida) return salida;
  // Revisión 29: el plazo se calcula con lo que le QUEDA al turno justo antes de llamar (descuenta leer la llave).
  const plazoMs = plazoClasificadorAlergia(restanteMs());
  if (plazoMs <= 0) return salida;
  const resultados = await Promise.all(
    grupos.map((g) =>
      Promise.resolve().then(() => clasificador(g.map((p) => p.texto).join("\n"), { llave: llaveLeida, plazoMs })).catch(() => null)
    ),
  );
  resultados.forEach((r, i) => {
    if (r?.declara === true) for (const p of grupos[i] ?? []) salida.add(originales.get(p.origen) ?? p.origen);
  });
  return salida;
}

/**
 * Revisión 33: alérgenos típicos (sin los alimentos comunes de la carta: pescado, atún, leche, huevo, trigo, queso…) y la
 * palabra alergia. Un texto que no cupo en el clasificador y los nombra se avisa aunque no traiga palabra de reacción.
 */
const ALERGENO_SIN_LUGAR = new RegExp(
  String.raw`\b(?:cacahuates?|mani|nuez|nueces|almendras?|avellanas?|pistaches?|mariscos?|camaron(?:es)?|ostion(?:es)?|pulpo|calamar(?:es)?|crustaceos?|gluten|lactosa|ajonjoli|sesamo|kiwi|mostaza|sulfitos?|penicilina|peanuts?|tree\s+nuts?|nuts?|shellfish|shrimps?|prawns?|sesame|lactose|crab|lobster|almonds?|walnuts?|cashews?|pecans?)\b|\baler[gj]|\baleg(?:i[ck]|ias?\b)|\ballerg|\banafila|\banaphyla|\bintoleran|\bceliac`,
);
/**
 * Revisión 34: alérgenos comunes que también están en la carta (huevo, leche, pescado, trigo, soya): solos no bastan (el
 * relleno «tacos de pescado» no bloquea), pero con una reacción («me pongo morado con el huevo») sí. REACCION_SIN_LUGAR
 * suma a REACCION_CUERPO las que se escriben sin ella («morado», «me desmayo», «se me cierra la garganta»).
 */
const ALERGENO_COMUN_SIN_LUGAR = /\b(?:huevos?|leche|lacteos?|pescados?|trigo|soya)\b/;
const REACCION_SIN_LUGAR =
  /\b(?:morad[oa]s?|desmay\w*|mare[oa]\w*|me\s+(?:pongo|pone|ponen|puse)\s+(?:mal|malo|mala|rojo|roja|azul)|se\s+me\s+cierra\w*|reaccion\w*)\b/;
/**
 * Revisión 32: un texto que el clasificador no leyó parece alergia si nombra un alimento Y una reacción del cuerpo.
 * Revisión 33: o si nombra un alérgeno típico o la alergia (ALERGENO_SIN_LUGAR): «con la nuez me pongo morado» no trae
 * palabra de reacción y se perdía. Un alimento común solo («pescado») no basta. Pura.
 */
export function pareceAlergiaSinClasificar(texto: string): boolean {
  const plano = String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return ALERGENO_SIN_LUGAR.test(plano) || (ALIMENTO_PALABRA.test(plano) && REACCION_CUERPO.test(plano)) ||
    (ALERGENO_COMUN_SIN_LUGAR.test(plano) && (REACCION_CUERPO.test(plano) || REACCION_SIN_LUGAR.test(plano)));
}

/** Revisión 32: lo que se repite entre dos pedazos de una oración larga (una frase así nunca queda partida en ambos). */
const TRASLAPE_ALERGIA = 80;

/**
 * Revisión 30 (seguridad primero): R29 clasificaba solo los 3 candidatos MÁS RECIENTES de la ráfaga y una alergia dicha
 * antes («con la nuez me pongo morado» + tres mensajes de «me pica…») nunca se leía. Ahora se clasifican TODOS dentro
 * del mismo tope de llamadas (MAX_CANDIDATOS_ALERGIA_POR_TURNO): primero los que nombran un alérgeno o la alergia,
 * luego los que nombran un alimento con una reacción del cuerpo, luego los más recientes.
 * Revisión 31: la última llamada juntaba TODO lo que sobraba y el clasificador corta su entrada en
 * MAX_CARACTERES_ALERGIA: lo más viejo (una alergia) se perdía. Ahora ninguna llamada pasa del tope: si los que sobran no
 * caben juntos se reparten por largo entre las llamadas (en orden de prioridad) y lo que ya no cabe en ninguna llamada
 * sale en `sinLugar` (alergiasSemanticasDelTurno lo avisa solo si parece alergia).
 * Revisión 32: un texto más largo que el tope se parte SOLO entre oraciones; una oración sola más larga que el tope se
 * parte en ventanas que se traslapan TRASLAPE_ALERGIA caracteres (cortadas en un espacio si se puede): una frase de
 * hasta ese largo aparece completa en algún pedazo. Pura.
 */
export function repartoClasificadorAlergia(
  candidatos: string[],
): { grupos: Array<Array<{ texto: string; origen: string }>>; sinLugar: string[] } {
  // Un alérgeno o la palabra alergia en el texto (las constantes viven más abajo en el módulo: se arma al llamar).
  const pistaFuerte = new RegExp(String.raw`\b${ALERGENO_MODISMO}\b|${PALABRA_ALERGIA}`);
  const alimentoYReaccion = new RegExp(String.raw`\b${ALIMENTO_ALERGENO}\b`);
  const plano = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const prioridad = (t: string) =>
    pistaFuerte.test(plano(t)) ? 2 : alimentoYReaccion.test(plano(t)) && REACCION_CUERPO.test(plano(t)) ? 1 : 0;
  const ordenados = candidatos
    .map((t, i) => ({ t, i, p: prioridad(t) }))
    .sort((a, b) => b.p - a.p || b.i - a.i)
    .map((x) => x.t);
  const tope = Math.max(1, MAX_CANDIDATOS_ALERGIA_POR_TURNO);
  const maximo = Math.max(1, MAX_CARACTERES_ALERGIA);
  // Pedazos de a lo más `maximo` caracteres (medidos como los manda el clasificador): oraciones enteras juntas y, solo
  // si una oración sola no cabe, ventanas traslapadas de esa oración.
  const pedazos: Array<{ texto: string; origen: string; largo: number }> = [];
  const agregar = (texto: string, origen: string) => {
    const limpio = texto.trim();
    if (limpio) pedazos.push({ texto: limpio, origen, largo: Array.from(limpio).length });
  };
  const traslape = Math.min(TRASLAPE_ALERGIA, Math.floor(maximo / 4));
  for (const origen of ordenados) {
    const todo = Array.from(sinDelimitadores(origen));
    if (todo.length <= maximo) {
      pedazos.push({ texto: origen, origen, largo: todo.length });
      continue;
    }
    let actual = "";
    for (const oracion of todo.join("").split(PARTIR_ORACIONES)) {
      const cp = Array.from(oracion);
      if (Array.from(actual).length + cp.length <= maximo) {
        actual += oracion;
        continue;
      }
      agregar(actual, origen);
      actual = "";
      if (cp.length <= maximo) {
        actual = oracion;
        continue;
      }
      let inicio = 0;
      while (inicio < cp.length) {
        let fin = Math.min(cp.length, inicio + maximo);
        if (fin < cp.length) {
          const espacio = cp.lastIndexOf(" ", fin);
          if (espacio > inicio + maximo / 2) fin = espacio;
        }
        agregar(cp.slice(inicio, fin).join(""), origen);
        if (fin >= cp.length) break;
        let siguiente = fin - traslape;
        const espacio = cp.lastIndexOf(" ", siguiente);
        if (espacio > inicio && espacio >= siguiente - 40) siguiente = espacio + 1;
        inicio = Math.max(inicio + 1, siguiente);
      }
    }
    agregar(actual, origen);
  }
  const sinLargo = (g: typeof pedazos) => g.map(({ texto, origen }) => ({ texto, origen }));
  const largoDe = (g: typeof pedazos) => g.reduce((n, p) => n + p.largo, 0) + Math.max(0, g.length - 1);
  if (pedazos.length <= tope) return { grupos: pedazos.map((p) => sinLargo([p])), sinLugar: [] };
  // La forma de la revisión 30 (los primeros solos, los que sobran juntos en la última) si la última cabe.
  const juntos = pedazos.slice(tope - 1);
  if (largoDe(juntos) <= maximo) {
    return { grupos: [...pedazos.slice(0, tope - 1).map((p) => sinLargo([p])), sinLargo(juntos)], sinLugar: [] };
  }
  // Si no: cada pedazo, en orden de prioridad, a la primera llamada donde quepa; lo que no cabe en ninguna, sin lugar.
  const llamadas: Array<typeof pedazos> = [];
  const sinLugar = new Set<string>();
  for (const p of pedazos) {
    const destino = llamadas.find((g) => largoDe([...g, p]) <= maximo);
    if (destino) destino.push(p);
    else if (llamadas.length < tope) llamadas.push([p]);
    else sinLugar.add(p.origen);
  }
  return { grupos: llamadas.map(sinLargo), sinLugar: [...sinLugar] };
}
/** Los textos de cada llamada al clasificador (ver repartoClasificadorAlergia). Pura. */
export function gruposClasificadorAlergia(candidatos: string[]): string[][] {
  return repartoClasificadorAlergia(candidatos).grupos.map((g) => g.map((p) => p.texto));
}

/** Formas de una palabra sin el plural («tacos» → «taco», «limones» → «limon»). */
function formasSinPlural(w: string): string[] {
  const formas = [w];
  if (w.length > 4 && w.endsWith("es")) formas.push(w.slice(0, -2));
  if (w.length > 3 && w.endsWith("s")) formas.push(w.slice(0, -1));
  return formas;
}

// ================================================================== decisión del turno (resumen de runAgentTurn)
/** Los dos riesgos de este módulo (HighRiskIntent del núcleo). */
export type IntentSalud = "alergia" | "salud";
/** Motivo del aviso (callback_requests.reason) de cada riesgo. */
export const RAZON_SALUD = "alto_riesgo:salud";

/** Lo que riesgosDeSalud detecta en un texto (orden de prioridad de HIGH_RISK_PATTERNS: alergia antes que salud). */
export interface RiesgoDeSalud {
  intent: IntentSalud;
  reply: string;
}

/**
 * La parte de salud de riesgosDeTexto (versión WhatsApp): para un texto del cliente, alergia y/o salud.
 *  - Revisión 87 (R87-O): una reacción en curso (esReaccionDeSalud) es SALUD con SALUD_REACCION_REPLY y nunca alergia.
 *  - Alergia: declaraAlergia (regex sin negaciones puras) O el clasificador semántico la leyó (`alergiaSemantica`).
 *  - Salud: el malestar tras comer (SALUD_MALESTAR) con SALUD_MALESTAR_REPLY.
 * Nota: el núcleo corrige antes las erratas de «cancelar» (corregirTyposCancelar); no cambia estos dos patrones. Pura.
 */
export function riesgosDeSalud(texto: string, opciones: { alergiaSemantica?: ReadonlySet<string> } = {}): RiesgoDeSalud[] {
  const plano = String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (reaccionDeSaludEnPlano(plano)) return [{ intent: "salud", reply: SALUD_REACCION_REPLY }];
  const salida: RiesgoDeSalud[] = [];
  if (opciones.alergiaSemantica?.has(texto) === true || declaraAlergia(texto)) salida.push({ intent: "alergia", reply: ALERGIA_REPLY });
  if (SALUD_MALESTAR.test(plano)) salida.push({ intent: "salud", reply: SALUD_MALESTAR_REPLY });
  return salida;
}

/** Revisión 87 (R87-N): la alergia ya quedó con la sucursal en el turno y la ráfaga pide algo más. Pura. */
export function bloqueAlergiaYaRegistrada(respuesta: string): string {
  return `AVISO DE ALERGIA YA REGISTRADO EN ESTE TURNO: la alergia (u otro aviso) que dio el cliente ya quedó con la sucursal, una persona le confirma, y el cliente ya recibe este texto antes de tu respuesta: «${respuesta}». No la vuelvas a registrar (no llames a registrar_contacto por ella), no repitas ese texto ni le garantices ingredientes. Atiende SOLO lo demás que pide: un cambio a su pedido ya registrado (dirección, recoger, forma de pago, quitar o agregar algo, una indicación) regístralo con registrar_contacto reason «modificacion_pedido» y sus palabras; un pedido nuevo no se puede crear hasta que la sucursal le confirme lo de la alergia.`;
}

/** Frases que la respuesta de varios avisos no puede perder (FRASES_OBLIGATORIAS_DE_AVISO + frasesDeVariosAvisos). */
const FRASES_DE_VARIOS: Record<IntentSalud, string[]> = {
  alergia: [ALERGIA_SIN_GARANTIA, `Le pedí a la sucursal que ${ALERGIA_ANTES_DEL_PEDIDO}.`],
  salud: [SALUD_SIN_DIAGNOSTICO],
};
const DE_QUE_SE_AVISO: Record<IntentSalud, string> = { alergia: "de su alergia", salud: "de su malestar" };

/**
 * Respuesta fija cuando el turno registra 2+ avisos (aquí: alergia y salud): corta, nombra cada uno y lleva las frases
 * obligatorias de cada riesgo completas. (El núcleo la arma igual para cobro, cancelación, reclamo…) Pura.
 */
export function respuestaDeVariosAvisosDeSalud(riesgos: ReadonlyArray<{ intent: IntentSalud; urgente?: boolean }>): string {
  const partes = riesgos.map((r) => DE_QUE_SE_AVISO[r.intent]);
  const lista = partes.length === 1 ? (partes[0] ?? "") : `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1] ?? ""}`;
  const intents = [...new Set(riesgos.map((r) => r.intent))];
  return [
    `${riesgos.some((r) => r.urgente) ? "Entendido, es urgente. " : "Lamento lo que pasó. "}Ya avisé a la sucursal ${lista}; una persona revisará cada caso y lo contactará.`,
    ...intents.flatMap((i) => FRASES_DE_VARIOS[i]),
  ].join(" ");
}

/** Idioma de una respuesta fija de este módulo. */
function idiomaDe(respuesta: string): "es" | "en" {
  return respuesta === ALERGIA_REPLY_EN || respuesta === ALERGIA_PEDIDO_EN_CURSO_REPLY_EN || respuesta === SALUD_LINEA_CORTA_EN ? "en" : "es";
}

export type TipoSalud = "emergencia" | "reaccion" | "malestar" | "alergia" | "alergia_en_curso" | "alergia_y_salud" | "salud_con_otra_peticion";

export interface ContextoDecisionSalud {
  /**
   * Hay un pedido YA creado y abierto (de la sesión o del número en 24 h) al que se le anotó la alergia (R87-O / R72-6): la
   * respuesta fija habla de ESE pedido (ALERGIA_PEDIDO_EN_CURSO_REPLY). Un pedido a medias (sin crear) no cuenta.
   */
  pedidoEnCurso: boolean;
  /**
   * Lo que leyó el clasificador semántico (alergiasSemanticasDelTurno): el conjunto de textos, o `true` para «todos los
   * textos con pista (debeClasificarAlergia) que la regex no vio». Regex O clasificador => alergia.
   */
  clasificadorDijoAlergia?: boolean | ReadonlySet<string>;
  /**
   * Mensaje del aviso de alergia ABIERTO del cliente, si existe (la base lo sabe; el núcleo anexa ahí el texto nuevo). Con
   * él, una alergia que solo REPITE lo ya avisado no alerta otra vez (R57-10: alergiaYaAvisada). Sin él: alerta.
   */
  avisoAlergiaAbierto?: string | null;
  /**
   * Revisión 87 (R87-N): la ráfaga trae algo más que atender (residual con contenido: un cambio, un pedido, una pregunta).
   * En el núcleo lo calcula hayResidualConContenido (fuera de este bloque); con alergia sola el aviso queda, su texto va
   * primero y el modelo atiende lo demás con bloqueAlergiaYaRegistrada.
   */
  residualConContenido?: boolean;
  /** El cliente escribe en inglés (el núcleo usa clienteEscribeEnIngles del hilo). Sin dato: esTextoEnIngles de los textos. */
  clienteEnIngles?: boolean;
  /** La ráfaga trae «urgente» (intent urgencia): se funde en los otros avisos como marca URGENTE (no es un aviso aparte). */
  urgentePorCliente?: boolean;
}

export interface AvisoDeSalud {
  motivo: typeof RAZON_ALERGIA | typeof RAZON_SALUD;
  intent: IntentSalud;
  textos: string[];
  urgente: boolean;
  /** Mensaje para callback_requests (marca URGENTE al inicio). El núcleo le agrega «(Pedido ya registrado: …)» con los folios. */
  mensaje: string;
}

export interface DecisionSalud {
  tipo: TipoSalud | null;
  /** Respuesta fija (seguirAlModelo=false) o el texto que va ANTES de la respuesta del modelo (seguirAlModelo=true). */
  respuesta: string | null;
  /** Algún aviso va URGENTE (marca al inicio del mensaje y alerta inmediata). */
  urgente: boolean;
  /** true: el modelo atiende lo demás (con `bloquePrompt` en el sistema); false: el turno es la respuesta fija, sin modelo. */
  seguirAlModelo: boolean;
  /** Bloque para el prompt de sistema cuando el aviso ya quedó y el modelo atiende lo demás. */
  bloquePrompt?: string;
  /** Idioma de `respuesta` (las respuestas de salud solo existen en español; la de alergia y la línea corta también en inglés). */
  idioma: "es" | "en";
  /** Avisos que el servidor registra YA (antes del modelo), uno por motivo. Si el registro falla: AVISO_NO_REGISTRADO_REPLY. */
  avisos: AvisoDeSalud[];
  /** Escribir «ALERGIA declarada: …» en las notas de los pedidos abiertos (alergia, o salud que nombra un alérgeno: R91-1). */
  anotarAlergiaEnPedido: boolean;
  /** Revisión 91 (R91-1): textos de salud que nombran la alergia (nota de cocina si la sesión no trae otra alergia). */
  textosDeSalud: string[];
  /** Con un aviso de alergia abierto: ¿hay una alergia NUEVA que alertar (alertaAlergiaNueva)? Sin aviso abierto: el alta normal. */
  alertarAlergiaNueva: boolean;
}

/**
 * Cerebro v2: cómo runAgentTurn (WhatsApp) combina regex + clasificador + emergencia para los textos del cliente del turno,
 * como UNA función pura. Se engancha ANTES del modelo (fast-path de alto riesgo), después de alergiasSemanticasDelTurno.
 *  1. Por texto: riesgosDeSalud (reacción en curso => salud; alergia por regex O clasificador; malestar tras comer).
 *  2. Revisión 93 (R93-1): con salud y emergenciaDeSaludFuerte(ráfaga) el aviso de salud va URGENTE y, si todo es salud, la
 *     respuesta es SALUD_REACCION_REPLY (nunca la línea corta ni venta).
 *  3. Respuesta: varios avisos => respuestaDeVariosAvisosDeSalud; uno urgente => respuestaUrgente; alergia en inglés =>
 *     ALERGIA_REPLY_EN; alergia con pedido abierto (no urgente) => ALERGIA_PEDIDO_EN_CURSO_REPLY(_EN) (R87-O / R56-10).
 *  4. Revisión 92 (R92-1): solo salud (no urgente) y la ráfaga pide algo más (saludConOtraPeticion) => el aviso queda, va
 *     SALUD_LINEA_CORTA(_EN) delante y el modelo atiende lo demás con bloqueSaludYaRegistrada.
 *  5. Revisión 87 (R87-N): solo alergia y residual con contenido => su respuesta delante y bloqueAlergiaYaRegistrada.
 *  6. Lo demás: respuesta fija, sin modelo.
 * Pura.
 */
export function decidirSalud(pendientes: readonly string[], ctx: ContextoDecisionSalud): DecisionSalud {
  const semantica: ReadonlySet<string> = ctx.clasificadorDijoAlergia instanceof Set
    ? ctx.clasificadorDijoAlergia
    : new Set(ctx.clasificadorDijoAlergia === true ? pendientes.filter((t) => debeClasificarAlergia(t)) : []);
  const grupos: Array<{ intent: IntentSalud; reply: string; textos: string[]; urgente: boolean }> = [];
  for (const intent of ["alergia", "salud"] as const) {
    for (const texto of pendientes) {
      const r = riesgosDeSalud(texto, { alergiaSemantica: semantica }).find((x) => x.intent === intent);
      if (!r) continue;
      const g = grupos.find((x) => x.intent === intent);
      if (g) g.textos.push(texto);
      else grupos.push({ intent, reply: r.reply, textos: [texto], urgente: ctx.urgentePorCliente === true });
    }
  }
  const sinRiesgo: DecisionSalud = {
    tipo: null, respuesta: null, urgente: false, seguirAlModelo: true, idioma: (ctx.clienteEnIngles ?? esTextoEnIngles([...pendientes])) ? "en" : "es",
    avisos: [], anotarAlergiaEnPedido: false, textosDeSalud: [], alertarAlergiaNueva: false,
  };
  const primero = grupos[0];
  if (!primero) return sinRiesgo;
  const conSalud = grupos.some((g) => g.intent === "salud");
  const conAlergia = grupos.some((g) => g.intent === "alergia");
  const emergencia = conSalud && emergenciaDeSaludFuerte(pendientes);
  if (emergencia) for (const g of grupos) if (g.intent === "salud") g.urgente = true;
  const enIngles = ctx.clienteEnIngles ?? esTextoEnIngles(primero.textos);
  const soloSalud = grupos.every((g) => g.intent === "salud");
  const soloAlergia = grupos.every((g) => g.intent === "alergia");
  let respuesta = emergencia && soloSalud
    ? SALUD_REACCION_REPLY
    : grupos.length > 1
    ? respuestaDeVariosAvisosDeSalud(grupos)
    : primero.urgente
    ? respuestaUrgente(primero.reply)
    : primero.intent === "alergia" && enIngles
    ? ALERGIA_REPLY_EN
    : primero.reply;
  if (grupos.length === 1 && primero.intent === "alergia" && ctx.pedidoEnCurso && !primero.urgente) {
    respuesta = enIngles ? ALERGIA_PEDIDO_EN_CURSO_REPLY_EN : ALERGIA_PEDIDO_EN_CURSO_REPLY;
  }
  const saludConAlergia = (g: { intent: IntentSalud; textos: string[] }) =>
    g.intent === "salud" && g.textos.some((t) => declaraAlergia(t) || semantica.has(t) || nombraAlergeno(t));
  const textosDeSalud = grupos.filter(saludConAlergia).flatMap((g) => g.textos);
  const previo = ctx.avisoAlergiaAbierto ?? null;
  const textosAlergia = grupos.find((g) => g.intent === "alergia")?.textos ?? [];
  const alertarAlergiaNueva = conAlergia && (previo === null
    ? true
    : textosAlergia.filter((t) => !normAviso(previo).includes(normAviso(t))).some((t) => !alergiaYaAvisada(previo, t)));
  const base = {
    urgente: grupos.some((g) => g.urgente),
    avisos: grupos.map((g): AvisoDeSalud => ({
      motivo: g.intent === "alergia" ? RAZON_ALERGIA : RAZON_SALUD,
      intent: g.intent,
      textos: [...g.textos],
      urgente: g.urgente,
      mensaje: mensajeAvisoDeRiesgo(g.textos, { urgente: g.urgente }),
    })),
    anotarAlergiaEnPedido: conAlergia || textosDeSalud.length > 0,
    textosDeSalud,
    alertarAlergiaNueva,
  };
  const tipoFijo: TipoSalud = emergencia
    ? "emergencia"
    : conAlergia && conSalud
    ? "alergia_y_salud"
    : conAlergia
    ? (ctx.pedidoEnCurso && !primero.urgente ? "alergia_en_curso" : "alergia")
    : grupos.some((g) => g.reply === SALUD_REACCION_REPLY)
    ? "reaccion"
    : "malestar";
  // Revisión 92 (R92-1): la salud nunca bloquea el turno si la ráfaga pide algo más.
  if (soloSalud && !grupos.some((g) => g.urgente) && saludConOtraPeticion(pendientes)) {
    const lineaEnIngles = ctx.clienteEnIngles ?? esTextoEnIngles([...pendientes]);
    const linea = lineaEnIngles ? SALUD_LINEA_CORTA_EN : SALUD_LINEA_CORTA;
    return {
      ...base, tipo: "salud_con_otra_peticion", respuesta: linea, seguirAlModelo: true,
      bloquePrompt: bloqueSaludYaRegistrada(linea), idioma: lineaEnIngles ? "en" : "es",
    };
  }
  // Revisión 87 (R87-N): la alergia (sola) con algo más en la ráfaga: el aviso queda y el modelo atiende lo demás.
  if (soloAlergia && ctx.residualConContenido === true) {
    return { ...base, tipo: tipoFijo, respuesta, seguirAlModelo: true, bloquePrompt: bloqueAlergiaYaRegistrada(respuesta), idioma: idiomaDe(respuesta) };
  }
  return { ...base, tipo: tipoFijo, respuesta, seguirAlModelo: false, idioma: idiomaDe(respuesta) };
}
