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
  [/\btres\s+cuartos?\s+de\s+kilo\b|\b3\s*\/\s*4\b(?:\s*(?:de\s+)?(?:kg|kilos?))?|(?<![\d.])0?\.75\s*(?:kg|kilos?)\b|(?<![\d.])0?\.750\b/g, 750],
  [/\bcuarto\s+de\s+kilo\b|\bun\s+cuarto\b|\b1\s*\/\s*4\b(?:\s*(?:de\s+)?(?:kg|kilos?))?|(?<![\d.])0?\.25\s*(?:kg|kilos?)\b|(?<![\d.])0?\.250\b/g, 250],
  [/\bkilo\s+y\s+medio\b|(?<![\d.])1[.,]5\s*(?:kg|kilos?)\b|\b1\s+1\s*\/\s*2\s*(?:kg|kilos?)\b/g, 1500],
  [/\bmedio\s+kilo\b|\b1\s*\/\s*2\s*(?:de\s+)?(?:kg|kilos?)\b|(?<![\d.])0?\.5\s*(?:kg|kilos?)\b|(?<![\d.])0?\.500\b/g, 500],
  [/\bdos\s+kilos?\b|\b2\s*(?:kg|kilos?)\b/g, 2000],
  [/(?<![\d./])(\d{2,4})\s*(?:gr|g|gramos)\b/g, -1],
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
  let texto = textoSinAcentos;
  for (const [patron, gramos] of FRASES_DE_PESO) {
    texto = texto.replace(patron, (...args: unknown[]) => ` peso:${gramos === -1 ? String(args[1]) : gramos} `);
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
export function tokenizeForProductSearch(query: string): string[] {
  const normalizada = normalizarPesosEnConsulta(
    normalizarUnidadesDeKilo(sinAcentos(query)).replace(/\bcero\s+punto\s+cero\b/g, "0.0"),
  )
    .replace(/\bmedia\s+orden\b/g, "1/2")
    // Jerga de T7 (chats reales): "medios charros" = media orden de frijoles charros; "nachos grandes" = la orden completa (el catalogo
    // solo distingue "(1/2 orden)"), asi que "grande(s)" junto a estos platillos no es parte del nombre.
    .replace(/\b(?:medios?|medias?)\s+(?=(?:frijoles?\s+)?charros?\b|frijoles?\b|nachos?\b)/g, "1/2 ")
    .replace(/\b(nachos?|charros?|frijoles?)\s+grandes?\b/g, "$1")
    .replace(/\bgrandes?\s+(?=nachos?\b|charros?\b|frijoles?\b)/g, "");

  const raw = normalizada.split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS_BUSQUEDA.has(t));

  const tokens: string[] = [];
  for (const t of raw) {
    if (t.startsWith("peso:")) {
      tokens.push(t);
      continue;
    }
    const singular = t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t;
    tokens.push(ALIAS_DE_ESCRITURA[singular] ?? singular);
  }
  return tokens.length > 0 ? tokens : [sinAcentos(query)];
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
    if (t.startsWith("peso:")) return pesoProducto !== null && pesoProducto === Number(t.slice(5));
    return textoPlano.includes(t) || alias.some((a) => a.includes(t)) || (t.length >= 6 && textoCompacto.includes(t));
  });
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
