// R-44 -- idioma del cliente (espanol / ingles) para el agente de WhatsApp y de voz de restaurantes.
//
// Decision de diseno: el idioma NO se guarda (sin migracion). Se deduce en cada turno, de forma DETERMINISTA, de los
// mensajes que el cliente ya escribio en la conversacion (el historial persistido es solo texto). Por omision es espanol:
// solo se pasa a ingles cuando el cliente escribe claramente en ingles, y se vuelve a espanol en cuanto escribe claramente en
// espanol. Un mensaje ambiguo ("ok", "2", un nombre de producto como "tacos al pastor") conserva el idioma que ya traia la
// conversacion. El modelo NO decide el idioma de las reglas duras: los guardias (alto riesgo, total cotizado, avisos fijos)
// usan este mismo resultado.

export type Idioma = "es" | "en";

export const IDIOMA_POR_OMISION: Idioma = "es";

// Marcadores que el sistema antepone a mensajes del cliente: no son palabras suyas y no cuentan para detectar el idioma.
const MARCADORES_SISTEMA_RE = /\[Nota de voz transcrita\]|\[Ubicaci[oó]n compartida por WhatsApp\][^\n]*/gi;

// Palabras funcionales frecuentes de cada idioma. Se evitan las que existen en los dos ("no", "a", "me", "es", "ok", "menu", "total",
// "taco(s)", "tortilla", "salsa") ni los nombres de platillos del menu ("pastor", "bistec", "maiz", "agua"...): un "ok" suelto es habitual en el espanol de Mexico y no debe cambiar la conversacion a ingles.
const EN_PALABRAS = new Set([
  "the", "and", "you", "your", "yours", "please", "thanks", "thank", "hello", "hi", "hey", "yes", "yeah", "yep", "nope",
  "want", "wanna", "would", "like", "need", "order", "pickup", "pick", "delivery", "deliver", "address", "pay", "cash", "card",
  "with", "without", "for", "from", "have", "can", "could", "do", "does", "what", "which", "where", "when", "how", "much", "many",
  "is", "are", "was", "this", "that", "these", "those", "my", "our", "its", "it", "i", "i'd", "i'm", "i'll", "ill", "id", "im", "we", "they", "of", "on", "in", "at",
  "to", "be", "get", "give", "send", "bring", "take", "add", "remove", "change", "cancel", "wait", "morning", "afternoon", "evening", "night",
  "good", "great", "sure", "some", "any", "more", "extra", "another", "also", "just", "only", "now", "today", "tonight", "tomorrow", "later",
  "name", "phone", "number", "price", "cost", "open", "close", "closed", "hours", "time", "long", "will", "take", "ready", "there",
  "orders", "pieces", "piece", "corn", "flour", "mixed", "spicy", "hot", "sauce", "drink", "drinks", "beer", "water",
  "speak", "talk", "person", "human", "manager", "someone", "allergic", "allergy", "refund", "charged", "twice", "complaint", "cold", "missing", "wrong",
  "street", "avenue", "near", "close", "neighborhood", "location", "branch", "store", "restaurant",
]);

const ES_PALABRAS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "y", "o", "que", "por", "para", "con", "sin", "en", "se", "su", "sus", "mi", "mis",
  "hola", "buenas", "buenos", "dias", "tardes", "noches", "gracias", "favor", "quiero", "quisiera", "necesito", "pedido", "pedir", "orden", "ordenes",
  "domicilio", "recoger", "direccion", "pagar", "efectivo", "tarjeta", "si", "claro", "vale", "bueno", "sale", "dale", "ahorita", "cuanto", "cuantos", "cuanta",
  "cuesta", "cuestan", "tiene", "tienen", "hay", "es", "son", "esta", "estan", "como", "donde", "cuando", "cual", "cuales", "porque", "pero", "tambien", "mas", "menos",
  "mucho", "poco", "todo", "todos", "toda", "ese", "esa", "eso", "este", "esto", "esos", "esas", "nombre", "telefono", "colonia", "calle", "numero", "hoy", "manana",
  "ahora", "luego", "despues", "antes", "puede", "pueden", "podria", "me", "te", "lo", "le", "les", "nos", "yo", "tu", "usted", "ustedes", "estoy", "estamos",
  "bebida", "refresco", "cancelar", "cancela", "quitar", "agregar", "agrega", "ponle",
  "persona", "humano", "gerente", "alergico", "alergica", "queja", "cobraron", "cobro", "llego", "frio", "falto", "equivocado", "equivocada",
]);

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[¿¡]/g, " ")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PuntajeIdioma {
  readonly en: number;
  readonly es: number;
}

/** Cuenta palabras funcionales de cada idioma en un texto del cliente (sin los marcadores del sistema). */
export function puntajeIdioma(texto: string): PuntajeIdioma {
  const limpio = normalizar(texto.replace(MARCADORES_SISTEMA_RE, " "));
  let en = 0;
  let es = 0;
  for (const palabra of limpio.split(" ")) {
    if (!palabra) continue;
    const enPalabra = EN_PALABRAS.has(palabra);
    const esPalabra = ES_PALABRAS.has(palabra);
    // Una palabra que existe en los dos conjuntos ("close", "persona" no; "salsa", "tortilla"...) no desempata.
    if (enPalabra && esPalabra) continue;
    if (enPalabra) en += 1;
    else if (esPalabra) es += 1;
  }
  return { en, es };
}

/** Ventaja minima para decidir con UN solo mensaje; con menos se conserva el idioma que traia la conversacion. */
const VENTAJA_DECISIVA = 2;

/** Idioma de UN mensaje: `null` si es ambiguo (corto, un numero, un nombre de producto, un empate). */
export function idiomaDeMensaje(texto: string): Idioma | null {
  const { en, es } = puntajeIdioma(texto);
  if (en - es >= VENTAJA_DECISIVA) return "en";
  if (es - en >= VENTAJA_DECISIVA) return "es";
  return null;
}

/**
 * Idioma de la conversacion a partir de los mensajes del cliente en orden cronologico. El mensaje decisivo MAS RECIENTE manda
 * (el cliente puede cambiar de idioma a mitad de la charla). Sin ninguno decisivo: la ventaja de 1 palabra del mensaje mas
 * reciente que la tenga; sin eso, espanol.
 */
export function detectarIdioma(mensajesCliente: readonly string[]): Idioma {
  for (let i = mensajesCliente.length - 1; i >= 0; i--) {
    const decidido = idiomaDeMensaje(mensajesCliente[i]!);
    if (decidido) return decidido;
  }
  for (let i = mensajesCliente.length - 1; i >= 0; i--) {
    const { en, es } = puntajeIdioma(mensajesCliente[i]!);
    if (en > es) return "en";
    if (es > en) return "es";
  }
  return IDIOMA_POR_OMISION;
}

/** Idioma de la conversacion a partir del historial persistido (solo mira los mensajes del cliente). */
export function idiomaDeConversacion(mensajes: readonly { readonly role: string; readonly content: string }[]): Idioma {
  return detectarIdioma(mensajes.filter((m) => m.role === "user").map((m) => m.content));
}

/** Saludo segun la franja horaria en ingles (la franja la calcula el servidor, nunca el modelo). */
export function saludoPorHoraEn(hora: number): string {
  if (hora >= 5 && hora < 12) return "good morning";
  if (hora >= 12 && hora < 19) return "good afternoon";
  return "good evening";
}
