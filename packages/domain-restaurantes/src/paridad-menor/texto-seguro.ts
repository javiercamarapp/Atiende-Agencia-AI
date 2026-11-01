// F4c -- normalizacion y deteccion de inyeccion para TEXTO NO CONFIABLE que acaba en el prompt: el mensaje del dueno y el texto extraido de archivos.
// Pasos: NFKC (pliega ancho completo y compatibilidad), quitar invisibles/controles/formato (guion blando, ancho cero, bidi), y para DETECTAR se arma un "esqueleto"
// (sin acentos, minusculas, homoglifos cirilicos/griegos a latino, variante leet, letras separadas unidas). La deteccion corre sobre todas las variantes.
// Esto es una barrera barata, NO una garantia: la contencion real son las reglas duras (despues del bloque) y las herramientas.

/** NFKC + sin caracteres de formato/control/bidi + espacios colapsados. Devuelve el texto "limpio" (conserva acentos y mayusculas). */
export function limpiarTexto(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => (c === "\n" || c === "\t" ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Como `limpiarTexto` pero conserva los saltos de linea (texto de documentos): NFKC y sin invisibles/controles/bidi. */
export function limpiarTextoMultilinea(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Lista de PERMITIDOS: letras latinas (con acentos), digitos y puntuacion basica. Se aplica al texto ya limpio. */
const PERMITIDOS = /^[\p{Script=Latin}0-9 .,;:!?¡¿()'"\-/]*$/u;
export function soloCaracteresPermitidos(limpio: string): boolean {
  return PERMITIDOS.test(limpio);
}

const HOMOGLIFOS: Readonly<Record<string, string>> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", к: "k", м: "m", т: "t", н: "h", в: "b", ӏ: "l",
  α: "a", ο: "o", ε: "e", ι: "i", ν: "v", ρ: "p", τ: "t", υ: "u", κ: "k", η: "n", β: "b",
};
const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };

function base(limpio: string): string {
  return limpio
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\P{ASCII}/gu, (c) => HOMOGLIFOS[c] ?? c);
}
const unirLetrasSeparadas = (s: string): string => s.replace(/(?<![a-z])(?:[a-z][\s._-]){2,}[a-z](?![a-z])/g, (m) => m.replace(/[\s._-]/g, ""));

/** Variantes sobre las que se prueba cada patron. */
export function esqueletos(limpio: string): readonly string[] {
  const b = base(limpio);
  const leet = b.replace(/[013457@$]/g, (c) => LEET[c] ?? c);
  return [...new Set([b, unirLetrasSeparadas(b), leet, unirLetrasSeparadas(leet)])];
}

type Patron = readonly [RegExp, string];

const VERBO_ANULAR = "(?:ignor\\w*|olvid\\w*|descart\\w*|anul\\w*|sustituy\\w*|reemplaz\\w*|desobedec\\w*|omit\\w*|salt\\w*|forget\\w*|disregard\\w*|overrid\\w*|bypass\\w*|oubli\\w*|esquec\\w*|ignore\\w*|dismiss\\w*|neglect\\w*)";
const OBJETO_ANULAR = "(?:regla\\w*|instruc\\w*|indicacion\\w*|lo anterior|lo de arriba|prompt|rule\\w*|instruction\\w*|previ?ous|above|before|told|anterior\\w*|precedent\\w*|prior|everything|todo|lo que|tout|tudo|arriba|antes)";

/** Patrones de INYECCION: aplican a cualquier texto no confiable (mensaje del dueno y texto de archivos). */
export const PATRONES_INYECCION: readonly Patron[] = [
  [new RegExp(`\\b${VERBO_ANULAR}\\b.{0,60}\\b${OBJETO_ANULAR}\\b`), "intenta anular las reglas del agente"],
  [/\b(a partir de ahora|de ahora en adelante|from now on|ahora eres|you are now|now you are|actua como|act as|pretend\w*|finge\w*|haste pasar|role ?play|jailbreak|modo desarrollador|developer mode|system prompt|prompt del sistema|dan mode)\b/, "intenta cambiar la identidad del agente"],
  [/\b(tu nuevo (?:objetivo|rol|papel|mision|tarea|proposito)|your new (?:goal|objective|role|task|purpose|mission)|new instructions|nuevas instrucciones|nueva regla|new rule|tu verdadero|your real)\b/, "intenta darle un nuevo objetivo al agente"],
  [/\b(prioriza\w*|por encima de|sobre todo lo demas|sobre las reglas|take precedence|prevalece\w*|tiene prioridad|above all|mas importante que|override)\b/, "intenta ponerse por encima de las reglas"],
  [/\b(system|assistant|developer|sistema|asistente|user|usuario|instruccion|instruction)\s*:/, "imita un mensaje del sistema"],
  [/\b(debes|tienes que|obedece\w*|you must|must obey|obey|siempre (?:confirma|acepta|di|responde|ofrece|regala|cobra)|nunca (?:cobres|pidas|preguntes|escales|verifiques|menciones|digas)|sin pedir|do not ask|never ask|always (?:confirm|accept|say|answer|offer))\b/, "da ordenes al agente"],
];

/** Patrones de TEMA: reglas duras que el mensaje del dueno no puede tocar (se aplican solo al mensaje del dueno; el conocimiento de un archivo SI puede hablar de pagos u horarios). */
export const PATRONES_TEMA: readonly Patron[] = [
  [/propin|\btips?\b|gratuity/, "la propina es una regla del sistema"],
  [/\b(transferenc\w*|spei|clabe|deposit\w*|cuenta bancaria|numero de cuenta|forma\w* de pago|metodo\w* de pago|tarjeta|cvv|efectivo|bizum|bitcoin|cripto\w*|crypto\w*|paypal|zelle|oxxo|mercado ?pago|payment\w*|pagos?|pagar|pay)\b/, "las formas de pago son una regla del sistema"],
  [/\b(escal\w*|gerente\w*|supervisor\w*|humano\w*|human\b|manager\w*|persona real|encargado|queja\w*|reclam\w*|complaint\w*)\b/, "la escalacion a una persona es una regla del sistema"],
  [/\b(seguridad|security|privacidad|privacy|datos personales|personal data|contrasena\w*|password\w*|token\w*|api ?key|llave\w*|secreto\w*|secret\w*|credencial\w*|arco)\b/, "la seguridad y la privacidad son reglas del sistema"],
  [/\b(precio\w*|price\w*|descuento\w*|discount\w*|gratis|free|regalo\w*|gift\w*|cortesia\w*|reembolso\w*|refund\w*|devoluc\w*|promocion\w*|promo\w*|2x1|cupon\w*|coupon\w*|cobr\w*|charg\w*|costo\w*|cost\w*|cuest\w+|pesos|mxn|usd|dolar\w*)\b/, "los precios, cobros y promociones salen siempre del menu y las herramientas"],
  [/\b(minimo\w*|horario\w*|schedule\w*|zona\w*|cobertura|abierto\w*|cerrado\w*|alcohol|cerveza\w*|beer|menor\w* de edad)\b/, "las reglas del pedido (minimos, horarios, zonas, alcohol) las aplica el sistema"],
  [/https?:|www\.|\b[\w-]+\.(?:com|mx|net|org|io|app|me|ly)\b|@[\w-]+\.|\b(?:\d[\s().-]*){10,}/, "no se permiten enlaces, correos ni telefonos"],
];

function primerMotivo(limpio: string, patrones: readonly Patron[]): string | null {
  const variantes = esqueletos(limpio);
  for (const [re, motivo] of patrones) if (variantes.some((v) => re.test(v))) return motivo;
  return null;
}

/** Motivo si el texto parece una instruccion al asistente (inyeccion); `null` si no. Pensado para texto de archivos y conocimiento. */
export function detectarInyeccion(texto: string): string | null {
  return primerMotivo(limpiarTexto(texto), PATRONES_INYECCION);
}

/** Motivo si el texto toca una regla dura o inyecta; `null` si no. Para el mensaje del dueno. */
export function detectarTemaProtegido(texto: string): string | null {
  const limpio = limpiarTexto(texto);
  return primerMotivo(limpio, PATRONES_INYECCION) ?? primerMotivo(limpio, PATRONES_TEMA);
}

/** Titulo seguro a partir de un nombre de archivo: sin extension, solo caracteres permitidos, sin ordenes; si no queda nada util, `fallback`. */
export function tituloSeguroDeNombre(nombre: string, fallback = "Documento"): string {
  const sinExt = limpiarTexto(nombre).replace(/\.[^.]{1,6}$/, "");
  const permitido = sinExt.replace(/[^\p{Script=Latin}0-9 .,;:!?¡¿()'"\-/]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (permitido === "" || detectarInyeccion(permitido) !== null || detectarInyeccion(sinExt) !== null) return fallback;
  return permitido;
}
