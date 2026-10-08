// Port literal de la búsqueda/resolución de productos de
// restaurantes/supabase/functions/_shared/create-order-core.ts. Contiene la guardia
// anti-alucinación de precio: `resolveOrderItemsAgainstProducts` SIEMPRE rechaza un
// renglón cuyo producto no está en el catálogo resuelto server-side — nunca inventa
// ni asume un precio, mismo patrón que agent-core ya aplica (rechazar en vez de
// alucinar). El precio final SIEMPRE sale de `branch_products` (fuente real de
// precio/disponibilidad por sucursal), nunca de lo que mande el cliente/LLM.
import type { ProductoEncontrado } from "./types.ts";
import { OrderValidationError } from "./errors.ts";

// Bug real confirmado el 3-sep-2026 (auditoría de voz, 9 agentes): "cerveza Sol" y
// "coctel Margarita" devolvían CERO resultados pese a que "Sol" y "Margarita" sí
// están disponibles — el match es AND de todos los tokens contra products.name, y
// "cerveza"/"coctel" nunca aparecen literalmente en el nombre real. Se suman estas
// palabras de categoría a las stopwords para que solo el nombre real de la bebida
// entre al match.
const STOPWORDS_BUSQUEDA = new Set([
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "y",
  "con",
  "para",
  "al",
  "quiero",
  "quisiera",
  "dame",
  "deme",
  "ponme",
  "agrega",
  "añade",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "dieciseis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
  "veinte",
  "cerveza",
  "cervezas",
  "coctel",
  "cocteles",
  "cóctel",
  "cócteles",
  // "una orden de frijoles": la unidad de venta no es parte del nombre del platillo (el match
  // es AND de todos los tokens, y "orden" solo vive en algunos nombres). "media orden" no se
  // descarta: se normaliza a "1/2" para encontrar el producto "(1/2 orden)" que si existe.
  "orden",
  "ordenes",
  "órdenes",
]);

/** Minusculas y sin diacriticos (NFD): "Champiñón" y "champinon" comparan igual. Los clientes escriben sin acentos y el
 * catalogo los trae; la comparacion se hace SIEMPRE sobre este texto, en la consulta y en los campos. */
export function sinAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Pesos que se venden por fraccion de kilo (chats reales de T7, 2-oct-2026): gramos canonicos de cada frase. El orden importa:
 * lo mas especifico primero ("kilo y medio" antes que "medio"; "1/4 de bistec" sin unidad es un cuarto de kilo, pero "1/2" sin
 * unidad NO es peso porque tambien es la "media orden"). */
const FRASES_DE_PESO: ReadonlyArray<readonly [RegExp, number]> = [
  // "kilo y cuarto" (1250 g) no es una presentacion del menu: se buscan todos los pesos y el agente arma el total (igual que "3 kilos").
  [/\bkilo\s+y\s+cuarto\b/g, 0],
  [/\bdos\s+cuartos(?:\s+de\s+(?:kilo|kg))?\b/g, 500],
  [/\btres\s+cuartos?(?:\s+de\s+(?:kilo|kg))?\b|\b3\s*\/\s*4\b(?:\s*(?:de\s+)?(?:kg|kilos?))?|(?<![\d.])0?\.75\s*(?:kg|kilos?)\b|(?<![\d.])0?\.750\b/g, 750],
  [/\b(?:un\s+)?cuarto\s+(?:de\s+)?(?:kilo|kg)s?\b|\bun\s+cuarto\b|\bcuarto\b(?=\s+de\s)|\b1\s*\/\s*4\b(?:\s*(?:de\s+)?(?:kg|kilos?))?|(?<![\d.])0?\.25\s*(?:kg|kilos?)\b|(?<![\d.])0?\.250\b/g, 250],
  [/(?:\b1\s*|\bun\s+)?\b(?:kilo|kg)\s+y\s+medio\b|(?<![\d.])1[.,]5\s*(?:kg|kilos?)\b|\b1\s+1\s*\/\s*2\s*(?:kg|kilos?)\b/g, 1500],
  [/\bmedio\s+(?:kilo|kg)\b|\bmedio\b(?=\s+de\s)|\b1\s*\/\s*2\s*(?:de\s+)?(?:kg|kilos?)\b|(?<![\d.])0?\.5\s*(?:kg|kilos?)\b|(?<![\d.])0?\.500\b/g, 500],
  [/\bdos\s+kilos?\b|\b2\s*(?:kg|kilos?)\b/g, 2000],
  // "3 kilos", "5 kg": no hay producto de ese peso (se venden 1/4 a 2 kg): el numero no es un peso exacto; se buscan todos los pesos del producto (`peso:cualquiera`) y el agente
  // arma el total con renglones de 2 kg y de 1 kg (nunca 3 piezas del de 1 kg). Va ANTES del patron generico de "kilo".
  [/(?<![\d./])(?:[3-9]|[1-9]\d)\s*(?:kg|kilos?)\b/g, 0],
  [/(?<![\d./])(\d{2,4})\s*(?:grs?|g|gramos)\b/g, -1],
  [/\b1\s*(?:kg|kilo)\b|\bun\s+kilo\b|\bkilos?\b|\bkg\b/g, 1000],
];

/** Escrituras comunes de una misma palabra ("bisteck", "bistek", "biftec") que el catalogo escribe "bistec". Se aplica al token ya singular. */
// "bisctec" (chats reales de T7) y "pok" ("pok chuc", del piloto original) son faltas de escritura de "bistec" y "poc".
const ALIAS_DE_ESCRITURA: Readonly<Record<string, string>> = { bisteck: "bistec", bistek: "bistec", bisteak: "bistec", biftec: "bistec", biftek: "bistec", bisctec: "bistec", pok: "poc" };

/** "kgs", "kgr", "kgrs" y "kilogramos" son "kg": sin esto "2 kgs de pastor" no se reconoce como peso y la busqueda devuelve vacio. */
function normalizarUnidadesDeKilo(texto: string): string {
  return texto.replace(/\b(?:kgrs?|kgs|kilogramos?)\b/g, "kg");
}

/** Convierte las frases de peso de una consulta en tokens `peso:<gramos>` (uno por frase). Lo que no es peso queda igual. */
export function normalizarPesosEnConsulta(textoSinAcentos: string): string {
  // Fracciones Unicode (el teclado del celular las escribe): "½ kilo" = 1/2 kilo; "1½ kg" = 1.5 kg.
  let texto = textoSinAcentos.replace(/1\s*½/g, "1.5").replace(/½/g, "1/2").replace(/¼/g, "1/4").replace(/¾/g, "3/4");
  for (const [patron, gramos] of FRASES_DE_PESO) {
    texto = texto.replace(patron, (...args: unknown[]) => ` peso:${gramos === 0 ? "cualquiera" : gramos === -1 ? String(args[1]) : gramos} `);
  }
  return texto;
}

/** Peso en gramos que declara el NOMBRE de un producto ("Pastor — 500 g" -> 500; "Pastor — 1.5 kg" -> 1500); null si no trae. */
export function pesoDeProductoEnGramos(nombre: string): number | null {
  const m = sinAcentos(nombre).match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr)\b/);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return Math.round(m[2] === "kg" ? n * 1000 : n);
}

/**
 * Tokenizador compartido de búsqueda de productos — port literal, incluyendo los dos
 * gaps reales encontrados en producción el 3-sep-2026 (plural "tacos" -> "taco" y
 * pesos pegados "500g"/"1kg" sin espacio) y la normalización de frases de kilos
 * encontrada el mismo día. Desde el 2-oct-2026 los pesos (fracciones de kilo: 1/4, 1/2, 3/4, 1, 1.5 y 2 kg, y gramos
 * explicitos) se vuelven UN token `peso:<gramos>` que `matchesProductSearch` compara EXACTO contra el peso del nombre del
 * producto: "1 kg" ya no encuentra tambien "1.5 kg".
 */
/** Marcador de la consulta "nachos grandes / completos": el producto NO puede ser una media orden ("(1/2 orden)"). */
export const ORDEN_COMPLETA = "orden:completa";

/** Marcador de la consulta "sin alcohol" / "0%": solo hace match con productos que el MENU escribe "sin alcohol" o "0.0" (nunca alcohol). */
export const SIN_ALCOHOL = "sinalcohol";
const FRASE_SIN_ALCOHOL = /\b(?:sin\s+alcohol(?:es)?|sin\s+alcol|cero\s+alcohol|libre\s+de\s+alcohol|no\s+alcoholic[oa]s?|sin\s+alcoholic[oa]s?)\b|(?<![\d.])0\s*%(?:\s+alcohol)?/g;
const MENU_SIN_ALCOHOL = /\bsin\s+alcohol\b|\b0[.,]0\b|\b0\s*%/;

/** Plural espanol -> singular de una palabra de la consulta. La "s" final basta casi siempre ("tacos", "chelas", "frijoles"); las terminaciones
 * -ones/-ores/-ales/-anes/-eles piden quitar "es" ("champinones" -> "champinon", "pastores" -> "pastor", "normales" -> "normal", "flanes" -> "flan").
 * Se limita a esas terminaciones para no romper "chiles" ni "tomates", que quedan por la regla de la "s". */
export function singularizar(palabra: string): string {
  if (palabra.length <= 4 || !palabra.endsWith("s")) return palabra;
  if (palabra.length > 5 && /(?:on|or|al|an|el)es$/.test(palabra)) return palabra.slice(0, -2);
  return palabra.slice(0, -1);
}

export function tokenizeForProductSearch(query: string): string[] {
  const normalizada = normalizarPesosEnConsulta(
    normalizarUnidadesDeKilo(sinAcentos(query)).replace(/\bcero\s+punto\s+cero\b/g, "0.0"),
  )
    .replace(FRASE_SIN_ALCOHOL, " sinalcohol ")
    // "cerveza con alcohol": "alcohol" no es parte del nombre de ningun producto pedido y casaria con los "sin Alcohol" (el contrario de lo pedido).
    .replace(/\bcon\s+alcohol\b/g, " ")
    .replace(/\bmedia\s+orden\b/g, "1/2")
    // Jerga de T7 (chats reales): "medios charros" = media orden de frijoles charros; "nachos grandes" = la orden COMPLETA (el catalogo solo distingue
    // "(1/2 orden)"). "grande(s)", "completa(s)" y "entera(s)" junto a estos platillos no son parte del nombre: piden la orden completa, asi que se vuelven
    // el marcador `orden:completa` (matchesProductSearch descarta las medias ordenes) en vez de simplemente borrarse (QA-R2-AGREGADO-01).
    .replace(/\b(?:medios?|medias?)\s+(?=(?:frijoles?\s+)?charros?\b|frijoles?\b|nachos?\b)/g, "1/2 ")
    .replace(/\b(nachos?|charros?|frijoles?)\s+(?:grandes?|completos?|completas?|enteros?|enteras?)\b/g, "$1 ordencompleta")
    .replace(/\b(?:grandes?|completos?|completas?|enteros?|enteras?)\s+(?:de\s+)?(?=nachos?\b|charros?\b|frijoles?\b)/g, " ordencompleta ");

  // "cerveza sin alcohol" / "coctel sin alcohol": con el marcador la categoria SI es parte de la consulta (sin ella el marcador mezclaria cervezas 0.0 y cocteles).
  const conSinAlcohol = /\bsinalcohol\b/.test(normalizada);
  const raw = normalizada
    .split(/\s+/)
    .map((t) => (conSinAlcohol && /^cervezas?$/.test(t) ? "cerveza" : conSinAlcohol && /^coctel(?:es)?$/.test(t) ? "cocktail" : t))
    .filter((t) => t.length > 1 && (t === "cerveza" ? conSinAlcohol : t === "cocktail" || !STOPWORDS_BUSQUEDA.has(t)));
  // "una cerveza", "dos cervezas": todas las palabras eran articulo/cantidad/categoria y la busqueda quedaba con la frase entera (vacia). La categoria
  // "cerveza" SI identifica lo pedido (casa con la categoria Cervezas), asi que se conserva cuando es lo unico que dice el cliente.
  if (raw.length === 0 && /\bcervezas?\b/.test(normalizada)) raw.push("cerveza");

  const tokens: string[] = [];
  for (const t of raw) {
    if (t.startsWith("peso:")) {
      tokens.push(t);
      continue;
    }
    if (t === SIN_ALCOHOL) {
      tokens.push(t);
      continue;
    }
    if (t === "ordencompleta") {
      tokens.push(ORDEN_COMPLETA);
      continue;
    }
    const singular = singularizar(t);
    tokens.push(ALIAS_DE_ESCRITURA[singular] ?? singular);
  }
  return tokens.length > 0 ? tokens : [sinAcentos(query)];
}

/** Palabras que identifican un platillo (sin "de/la", sin "(orden de 3)", sin el peso "— 500 g"): sirve para saber si un producto es una
 * VARIANTE de otro ("Margarita sin Alcohol" de "Margarita", "Bistec de Res Encebollado" de "Bistec de Res"). */
function palabrasNucleo(nombre: string): Set<string> {
  const base = sinAcentos(nombre).replace(/\([^)]*\)/g, " ").replace(/\s[—-]\s.*$/, " ");
  return new Set(base.split(/[^a-z0-9.]+/).filter((w) => w && !STOPWORDS_BUSQUEDA.has(w)));
}

const CALIFICADORES_DE_VARIANTE = new Set(["encebollado", "especial", "especiales", "sin", "light"]);
/** Palabras que marcan la version NORMAL de un platillo con variantes ("Frijoles Charros Normal" vs "con Queso"): ganan al empatar si el cliente no pidio otra. */
const PALABRAS_DE_VERSION_NORMAL = new Set(["normal", "regular"]);

/** Puntaje de relevancia de UN producto que ya hizo match: palabra completa o alias exacto (4) > inicio de palabra, p. ej. el plural (3) >
 * subcadena del nombre (1.5) > descripcion/categoria (0.5); "orden de ..." prefiere los renglones "(orden de N)". */
export function puntajeDeBusqueda(
  tokens: readonly string[],
  fields: { readonly name: string; readonly searchKeywords?: readonly string[] },
  consultaCruda = "",
): number {
  const nombre = sinAcentos(fields.name);
  const palabras = nombre.split(/[^a-z0-9.]+/).filter(Boolean);
  const alias = (fields.searchKeywords ?? []).map(sinAcentos);
  let puntaje = 0;
  for (const t of tokens) {
    if (t.startsWith("peso:")) continue;
    if (t === SIN_ALCOHOL) {
      puntaje += MENU_SIN_ALCOHOL.test(nombre) ? 4 : 0.5;
      continue;
    }
    if (palabras.includes(t) || palabras.some((w) => singularizar(w) === t) || alias.some((a) => a === t || a.split(/[^a-z0-9.]+/).includes(t))) puntaje += 4;
    else if (palabras.some((w) => w.startsWith(t))) puntaje += 3;
    else if (nombre.includes(t)) puntaje += 1.5;
    else puntaje += 0.5;
  }
  if (/\b(?:una?|la|las)\s+orden(?:es)?\b|^orden(?:es)?\b/.test(sinAcentos(consultaCruda)) && /\(orden de \d+/.test(nombre)) puntaje += 2;
  // El producto "base" gana al calificado cuando el cliente no pidio el calificativo ("bistec" no es "bistec encebollado").
  if (palabras.some((w) => PALABRAS_DE_VERSION_NORMAL.has(w)) && !tokens.some((t) => PALABRAS_DE_VERSION_NORMAL.has(t))) puntaje += 0.5;
  if (palabras.some((w) => CALIFICADORES_DE_VARIANTE.has(w) && !tokens.some((t) => w.startsWith(t) || t.startsWith(w)) && !(w === "sin" && tokens.includes(SIN_ALCOHOL)))) puntaje -= 0.5;
  return puntaje;
}

/** Ordena los productos que hicieron match de mayor a menor relevancia. Estable (a igualdad queda el orden del catalogo). Una VARIANTE
 * (su nucleo contiene al de otro resultado) baja un punto frente al producto base. */
export function ordenarPorRelevancia<T extends { readonly name: string; readonly searchKeywords?: readonly string[] }>(
  tokens: readonly string[],
  encontrados: readonly T[],
  consultaCruda: string,
): T[] {
  const nucleos = encontrados.map((p) => palabrasNucleo(p.name));
  // Solo se comparan renglones de la MISMA presentacion: "Bistec de Res — 500 g" vs "Bistec de Res Encebollado — 500 g", no vs unos tacos.
  const forma = (n: string) => sinAcentos(n).replace(/^[^(—]*?(?=\(|\s—|$)/, "").trim();
  const formas = encontrados.map((p) => forma(p.name));
  const esVariante = (i: number) =>
    nucleos.some((otro, j) => j !== i && formas[j] === formas[i] && otro.size > 0 && otro.size < nucleos[i]!.size && [...otro].every((w) => nucleos[i]!.has(w)));
  return encontrados
    .map((p, i) => ({ p, i, s: puntajeDeBusqueda(tokens, p, consultaCruda) - (esVariante(i) ? 1 : 0) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map((x) => x.p);
}

/** Determina si un texto de búsqueda hace match contra un producto — un token hace
 * match si aparece en name, description, categoría, o cualquier search_keywords
 * (todos los tokens son obligatorios, AND, igual que el origen). */
export function matchesProductSearch(
  tokens: readonly string[],
  fields: { readonly name: string; readonly description: string | null; readonly categoryName: string | null; readonly searchKeywords: readonly string[] },
): boolean {
  const textoPlano = sinAcentos([fields.name, fields.description, fields.categoryName].filter(Boolean).join(" "));
  const alias = fields.searchKeywords.map(sinAcentos);
  // "cocacola" (junto) debe encontrar "Coca-Cola": una palabra larga tambien se compara contra el texto sin guiones ni espacios.
  const textoCompacto = textoPlano.replace(/[\s-]/g, "");
  const pesoProducto = pesoDeProductoEnGramos(fields.name);
  return tokens.every((t) => {
    if (t === "peso:cualquiera") return pesoProducto !== null;
    if (t.startsWith("peso:")) return pesoProducto !== null && pesoProducto === Number(t.slice(5));
    if (t === SIN_ALCOHOL) return MENU_SIN_ALCOHOL.test(sinAcentos(fields.name)) || alias.some((a) => MENU_SIN_ALCOHOL.test(a));
    if (t === ORDEN_COMPLETA) return !/\b1\s*\/\s*2\b|\bmedia\s+orden\b/.test(textoPlano);
    return textoPlano.includes(t) || alias.some((a) => a.includes(t)) || (t.length >= 6 && textoCompacto.includes(t));
  });
}

/** Una "media orden" (producto "(1/2 orden)") solo es lo pedido si el cliente nombro el PLATILLO (lo que va antes del "de": "Nachos", "Frijoles Charros"),
 * no un ingrediente: "media orden de bistec" no es "Nachos de Bistec (1/2 orden)". `tokens` son los de la consulta ya sin el "1/2". */
export function nombraElPlatilloDeMediaOrden(tokens: readonly string[], fields: { readonly name: string; readonly searchKeywords: readonly string[] }): boolean {
  const cabeza = sinAcentos(fields.name).replace(/\(.*$/, " ").split(/\s+de\s+|\s[—-]\s/)[0] ?? "";
  const alias = fields.searchKeywords.map(sinAcentos);
  return tokens.some((t) => t !== "1/2" && !t.startsWith("peso:") && t !== ORDEN_COMPLETA && t !== SIN_ALCOHOL && (cabeza.includes(t) || alias.some((a) => a === t)));
}

/** Tortilla obligatoria al cotizar: los productos "tacos" y los que el MENU dice que van "de maiz o harina" (quesadillas).
 * Si el menu no lo dice, NO se exige (mejor una pregunta de menos que inventar una opcion que el platillo no tiene). */
export function requiresTortillaChoice(productName: string, description: string | null | undefined): boolean {
  if (/\btacos?\b/i.test(productName)) return true;
  return /\bde\s+ma[ií]z\s+o\s+harina\b/i.test(description ?? "");
}

export function extraerPackSize(name: string, description: string | null): number | null {
  const texto = `${name} ${description ?? ""}`;
  const orden = texto.match(/orden de (\d+)/i);
  if (orden) return parseInt(orden[1] as string, 10);
  if (/individual/i.test(texto)) return 1;
  return null;
}

/** El agente debe obtener un sí claro de mayoría de edad antes de cotizar alcohol. */
export function requiresAdultConfirmation(productName: string, categoryName: string | null | undefined): boolean {
  if (!/^(cervezas|licores y cocktails)$/i.test(categoryName ?? "")) return false;
  return !/(?:\bsin\s+alcohol\b|\b0[.,]0\b)/i.test(productName);
}

function comparableProductName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es-MX");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export { UUID_PATTERN };

/**
 * GUARDIA ANTI-ALUCINACIÓN DE PRECIO: resuelve cada renglón al producto canónico del
 * catálogo real (resuelto server-side). Un id inválido o inexistente puede
 * recuperarse ÚNICAMENTE con el nombre exacto que devolvió la búsqueda — si ninguno
 * de los dos identifica un producto real, se RECHAZA con OrderValidationError, nunca
 * se inventa ni se asume un precio para un producto que no está en el catálogo. Si un
 * id válido apunta a un nombre distinto del que mandó el caller, también se rechaza:
 * jamás se cambia silenciosamente lo que se va a cobrar/preparar. Mismo principio que
 * agent-core aplica en sus propias tools: rechazar en vez de alucinar.
 */
export function resolveOrderItemsAgainstProducts<T extends { productId?: string; productName?: string }>(
  items: readonly T[],
  products: readonly ProductoEncontrado[],
): Array<T & { productId: string; productName: string }> {
  return items.map((item) => {
    const requestedId = typeof item.productId === "string" ? item.productId.trim() : "";
    const requestedName = typeof item.productName === "string" ? item.productName.trim() : "";
    const byId = requestedId ? products.find((product) => product.id === requestedId) : undefined;
    const byName = requestedName
      ? products.find((product) => comparableProductName(product.name) === comparableProductName(requestedName))
      : undefined;

    if (byId && requestedName && comparableProductName(byId.name) !== comparableProductName(requestedName)) {
      throw new OrderValidationError(
        `El identificador y el nombre del producto no coinciden: ${requestedName}. Vuelve a usar exactamente el resultado de buscar_producto.`,
      );
    }
    const product = byId ?? byName;
    if (!product) {
      const reference = requestedName || requestedId || "sin identificador";
      throw new OrderValidationError(`Producto no disponible: ${reference}. Vuelve a llamar buscar_producto y copia también el nombre.`);
    }
    return { ...item, productId: product.id, productName: product.name };
  });
}
