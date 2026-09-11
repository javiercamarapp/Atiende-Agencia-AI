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
]);

/**
 * Tokenizador compartido de búsqueda de productos — port literal, incluyendo los dos
 * gaps reales encontrados en producción el 3-sep-2026 (plural "tacos" -> "taco" y
 * pesos pegados "500g"/"1kg" sin espacio) y la normalización de frases de kilos
 * ("medio kilo" -> "500g") encontrada el mismo día.
 */
export function tokenizeForProductSearch(query: string): string[] {
  const normalizada = query
    .toLowerCase()
    .replace(/\bcero\s+punto\s+cero\b/g, "0.0")
    .replace(/tres\s+cuartos?\s+de\s+kilo/g, "750g")
    .replace(/cuarto\s+de\s+kilo/g, "250g")
    .replace(/medio\s+kilo/g, "500g")
    .replace(/\bkilos?\b/g, "kg");

  const raw = normalizada.split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS_BUSQUEDA.has(t));

  const tokens: string[] = [];
  for (const t of raw) {
    const pesoMatch = t.match(/^(\d+)(kg|gr|g)$/);
    if (pesoMatch) {
      tokens.push(pesoMatch[1] as string, pesoMatch[2] === "gr" ? "g" : (pesoMatch[2] as string));
      continue;
    }
    tokens.push(t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t);
  }
  return tokens.length > 0 ? tokens : [query.toLowerCase()];
}

/** Determina si un texto de búsqueda hace match contra un producto — un token hace
 * match si aparece en name, description, categoría, o cualquier search_keywords
 * (todos los tokens son obligatorios, AND, igual que el origen). */
export function matchesProductSearch(
  tokens: readonly string[],
  fields: { readonly name: string; readonly description: string | null; readonly categoryName: string | null; readonly searchKeywords: readonly string[] },
): boolean {
  const textoPlano = [fields.name, fields.description, fields.categoryName].filter(Boolean).join(" ").toLowerCase();
  return tokens.every((t) => textoPlano.includes(t) || fields.searchKeywords.some((a) => a.toLowerCase().includes(t)));
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
