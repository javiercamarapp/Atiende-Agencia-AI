// Port literal de la cotización de pedido de
// restaurantes/supabase/functions/_shared/create-order-core.ts
// (buildOrderQuoteFromProducts/buildComplementNotes). Traduce lo que pidió el
// cliente (piezas/unidades habladas) a unidades cobrables del catálogo — el cálculo
// vive fuera del LLM para que "8 individuales" nunca se convierta en "máximo 1", y
// para que una orden de 3 se cobre una sola vez, no tres. El precio SIEMPRE sale de
// `product.price` (que ya viene de branch_products, resuelto server-side) — nunca de
// lo que mande el cliente.
import { OrderValidationError } from "./errors.ts";
import type { CanalPedido, DefaultComplement, DoubleSalsa, OrderQuote, ProductoEncontrado, QuotedOrderLine, RequestedComplement, RequestedOrderItemInput, TortillaChoice } from "./types.ts";

/** Las 9 salsas/guarniciones que PM incluye sin costo en cada pedido de tacos. */
export const DEFAULT_COMPLEMENTS: readonly DefaultComplement[] = [
  "salsa_roja",
  "salsa_verde",
  "salsa_mexicana",
  "salsa_guacamolera",
  "limones",
  "crema_ajo",
  "cebolla_cilantro",
  "salsa_pina",
  "salsa_habanero",
];

/** Básicas por omisión de Los Taquitos de PM (chats reales de T7): van en TODO pedido de tacos; las demás salsas van sin costo solo si el
 * cliente las pide. Es dato del PERFIL (lo pasa el agente en `basicComplements`), no una regla global del dominio. */
export const PM_BASIC_COMPLEMENTS: readonly DefaultComplement[] = ["salsa_roja", "salsa_verde", "cebolla_cilantro", "limones"];

const COMPLEMENT_LABELS: Record<DefaultComplement | RequestedComplement, string> = {
  salsa_roja: "salsa roja",
  salsa_verde: "salsa verde",
  salsa_mexicana: "salsa mexicana",
  salsa_guacamolera: "salsa guacamolera",
  limones: "limones",
  crema_ajo: "crema de ajo",
  cebolla_cilantro: "cebolla con cilantro",
  salsa_pina: "salsa de piña",
  salsa_habanero: "salsa habanero (soasada o picada con limón)",
  cebolla: "cebolla con cilantro",
  pina: "piña picada",
  salsa_habanero_soasado: "salsa habanero soasada",
};

/** Tortillas validas de un renglon de tacos (`mixta` = mitad maiz, mitad harina). */
export const TORTILLA_CHOICES: readonly TortillaChoice[] = ["maiz", "harina", "mixta"];

export function isTortillaChoice(value: unknown): value is TortillaChoice {
  return typeof value === "string" && (TORTILLA_CHOICES as readonly string[]).includes(value);
}

/** Lista cerrada de lo que el cliente puede pedir (sin costo). */
export const COMPLEMENTOS_PEDIBLES: readonly RequestedComplement[] = ["salsa_guacamolera", "salsa_mexicana", "salsa_pina", "pina", "salsa_habanero", "salsa_habanero_soasado", "crema_ajo"];

/** Jerga y escrituras de las salsas que el cliente pide (chats reales de T7) -> complemento canonico. Vive en el mapa de complementos, no
 * en el catalogo: ninguna de estas salsas es un producto. Se compara sin acentos y en minusculas. */
const ALIAS_DE_COMPLEMENTO: ReadonlyArray<readonly [RegExp, RequestedComplement]> = [
  [/\b(?:sauceada|suasada|soasada|soasado|sauceado|suasado)\b/, "salsa_habanero_soasado"],
  [/\bxnipec\b|\bxni\s?pec\b|\bpico\s+de\s+gallo\b|\bcebolla\s+con\s+tomate\b|\bsalsa\s+mexicana\b|\bmexicana\b/, "salsa_mexicana"],
  [/\bguacamolera\b|\bguacamole\b/, "salsa_guacamolera"],
  [/\bcrema\s+de\s+ajo\b|\bcrema_ajo\b/, "crema_ajo"],
  [/\bsalsa\s+de\s+pi[ñn]a\b|\bsalsa_pina\b/, "salsa_pina"],
  [/\bpi[ñn]a\b|\bpina\b/, "pina"],
  [/\bhabanero\b|\bsalsa_habanero\b/, "salsa_habanero"],
];

/** Convierte lo que mando el modelo en un complemento canonico de la lista cerrada, o null si no se reconoce (se descarta, nunca se imprime). */
export function canonicalRequestedComplement(valor: unknown): RequestedComplement | null {
  if (typeof valor !== "string") return null;
  const t = valor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if ((COMPLEMENTOS_PEDIBLES as readonly string[]).includes(t)) return t as RequestedComplement;
  for (const [patron, canonico] of ALIAS_DE_COMPLEMENTO) if (patron.test(t)) return canonico;
  return null;
}

/** `cebolla` es el nombre historico de `cebolla_cilantro`: ambos omiten la misma salsa. */
function canonicalComplement(item: DefaultComplement): DefaultComplement {
  return item === "cebolla" ? "cebolla_cilantro" : item;
}

/** Producto del catalogo que cobra la doble porcion de una salsa ("Extra salsa ..."). El precio SIEMPRE
 * sale del catalogo de la sucursal, nunca de lo que mande el cliente o el modelo. */
const EXTRA_SALSA_PRODUCT_RE = /^extra\s+salsa\b/i;

export function findExtraSalsaProduct(products: readonly ProductoEncontrado[]): ProductoEncontrado | null {
  return products.find((p) => EXTRA_SALSA_PRODUCT_RE.test(p.name.trim())) ?? null;
}

/**
 * Renglon cobrado de la doble porcion de salsas: una pieza del producto "Extra salsa" del catalogo
 * por cada salsa pedida en doble. Sin ese producto en el catalogo de la sucursal NO se inventa un
 * precio: se rechaza con un mensaje accionable (el extra aun no tiene precio cargado).
 */
export function buildDoubleSalsaLine(products: readonly ProductoEncontrado[], doubleSalsas: readonly DoubleSalsa[]): QuotedOrderLine | null {
  const unique = [...new Set(doubleSalsas)];
  if (unique.length === 0) return null;
  const extra = findExtraSalsaProduct(products);
  if (!extra) {
    throw new OrderValidationError(
      "El extra por doble porción de salsa todavía no tiene precio en el catálogo de esta sucursal: no lo ofrezca ni lo cobre por su cuenta. Pase la solicitud a una persona (escalar_a_humano) o continúe el pedido sin doble porción.",
    );
  }
  const price = Number(extra.price);
  const quantity = unique.length;
  return {
    productId: extra.id,
    name: `${extra.name} (doble porción: ${unique.map((s) => COMPLEMENT_LABELS[s]).join(", ")})`,
    price,
    requestedQuantity: quantity,
    packSize: null,
    quantity,
    tortilla: null,
    requiresAdultConfirmation: false,
    lineTotal: Math.round(price * quantity * 100) / 100,
  };
}

export function buildComplementNotes(
  notes?: string,
  requested: readonly RequestedComplement[] = [],
  omitted: readonly DefaultComplement[] = [],
  basics?: readonly DefaultComplement[],
): string {
  // Las 9 salsas (incluidas habanero y crema de ajo) ya van incluidas sin costo por omision, asi que pedir
  // habanero/crema de ajo NO agrega una linea "solicitados" aparte (apareceria a la vez como incluido y
  // solicitado). Si el cliente la pide expresamente, esa peticion gana sobre una omision contradictoria.
  const omittedSet = new Set(omitted.map(canonicalComplement));
  if (basics) return buildComplementNotesConBasicas(notes, requested, omittedSet, basics);
  const requestedSet = new Set<DefaultComplement>(requested.filter((r) => (DEFAULT_COMPLEMENTS as readonly string[]).includes(r)) as unknown as DefaultComplement[]);
  const included = DEFAULT_COMPLEMENTS.filter((item) => requestedSet.has(item) || !omittedSet.has(item));
  const lines = [notes?.trim()].filter(Boolean) as string[];
  lines.push(
    included.length > 0
      ? `Complementos incluidos: ${included.map((item) => COMPLEMENT_LABELS[item]).join(", ")}.`
      : "No enviar complementos de cortesía.",
  );
  return lines.join("\n");
}

/** Comanda con perfil de básicas: «Básicas» (las del perfil menos las omitidas) y «Pedidas» (lo que el cliente pidió además; sin costo).
 * Lo pedido gana sobre una omisión contradictoria; una básica pedida no se repite en «Pedidas». */
function buildComplementNotesConBasicas(
  notes: string | undefined,
  requested: readonly RequestedComplement[],
  omittedSet: ReadonlySet<DefaultComplement>,
  basics: readonly DefaultComplement[],
): string {
  const basicas = [...new Set(basics.map(canonicalComplement))];
  // Lista cerrada: un valor desconocido del modelo se descarta (nunca se imprime tal cual en la comanda).
  const requestedUnique = [...new Set(requested.filter((r) => Object.hasOwn(COMPLEMENT_LABELS, r)).map((r) => canonicalComplement(r as DefaultComplement)))] as (DefaultComplement | RequestedComplement)[];
  const basicasQueVan = basicas.filter((item) => requestedUnique.includes(item) || !omittedSet.has(item));
  const pedidas = requestedUnique.filter((item) => !basicas.includes(item as DefaultComplement));
  const lines = [notes?.trim()].filter(Boolean) as string[];
  if (basicasQueVan.length === 0 && pedidas.length === 0) {
    lines.push("No enviar complementos de cortesía.");
    return lines.join("\n");
  }
  if (basicasQueVan.length > 0) lines.push(`Básicas: ${basicasQueVan.map((item) => COMPLEMENT_LABELS[item]).join(", ")}.`);
  if (pedidas.length > 0) lines.push(`Pedidas (sin costo): ${pedidas.map((item) => COMPLEMENT_LABELS[item]).join(", ")}.`);
  return lines.join("\n");
}

/** Piezas maximas por renglon. Antes 100 (120 tacos para una fiesta no se podian ni cotizar): un pedido grande se cotiza y, en los canales de
 * agente, el servidor lo retiene para que la sucursal lo confirme (ver pedido-grande.ts). El checkout WEB conserva su tope de 100 (`MAX_PIEZAS_POR_RENGLON_WEB`). */
export const MAX_PIEZAS_POR_RENGLON = 500;
export const MAX_PIEZAS_POR_RENGLON_WEB = 100;
/** Un producto vendido por peso ("— 1 kg") no admite mas de estas piezas por renglon: 100 o mas piezas de un producto por peso son gramos como cantidad (250, 750, 1000); 30 kg es un pedido grande legitimo que se retiene aparte. */
export const MAX_PIEZAS_PRODUCTO_POR_PESO = 99;

/** Mensaje accionable para una cantidad fuera de rango: dice el maximo en vez de un error generico. */
export function mensajeCantidadInvalida(value: unknown, max: number = MAX_PIEZAS_POR_RENGLON): string {
  return typeof value === "number" && Number.isInteger(value) && value > max
    ? `Productos o cantidades inválidos: el máximo es de ${max} piezas por renglón; un pedido más grande lo confirma directamente la sucursal. Si ${value} son GRAMOS, requested_quantity no es el peso: busque el producto de esa presentación con buscar_producto usando la fracción ("cuarto de bistec", "tres cuartos de chuleta") y mande requested_quantity 1.`
    : "Productos o cantidades inválidos";
}

/**
 * Cotiza N renglones YA resueltos contra el catálogo real de la sucursal (ver
 * product-search.ts::resolveOrderItemsAgainstProducts para la guardia anti-precio).
 * Valida: confirmación de mayoría de edad para alcohol, tortilla obligatoria para
 * tacos, múltiplos exactos de pack_size, y calcula el total server-side redondeado a
 * centavos — ninguna de estas reglas vive en el LLM.
 */
export function buildOrderQuoteFromProducts(
  requestedItems: readonly RequestedOrderItemInput[],
  products: readonly ProductoEncontrado[],
  options: { readonly adultConfirmed?: boolean; readonly canal?: CanalPedido } = {},
): OrderQuote {
  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    throw new OrderValidationError("El pedido no tiene productos");
  }
  if (requestedItems.length > 100) {
    throw new OrderValidationError("Productos o cantidades inválidos");
  }

  const lines: QuotedOrderLine[] = [];
  let total = 0;
  let containsAlcohol = false;
  for (const item of requestedItems) {
    if (
      !item ||
      typeof item.productId !== "string" ||
      item.productId.length > 64 ||
      !Number.isInteger(item.requestedQuantity) ||
      item.requestedQuantity < 1 ||
      item.requestedQuantity > MAX_PIEZAS_POR_RENGLON
    ) {
      throw new OrderValidationError(mensajeCantidadInvalida(item?.requestedQuantity));
    }
    const product = products.find((candidate) => candidate.id === item.productId);
    if (!product) {
      throw new OrderValidationError(`Producto no disponible: ${item.productId}`);
    }
    // QA-PM-R4-reglas-03: "un cuarto de bistec" llegaba como requested_quantity 250 sobre el producto de 1 kg (250 kg, o el error de 500 piezas con 750). Un producto que se vende por
    // peso ("Bistec de Res — 1 kg") no se pide por gramos: se rechaza con la instruccion de usar la presentacion exacta y cantidad 1.
    if (item.requestedQuantity > MAX_PIEZAS_PRODUCTO_POR_PESO && /[—-]\s*\d+(?:[.,]\d+)?\s*(?:kg|g|gr)\b/i.test(product.name)) {
      throw new OrderValidationError(
        `${product.name} se vende por peso: requested_quantity es el número de piezas de ese producto (1 para un kilo), no gramos. Para ${item.requestedQuantity} g busque el producto de esa presentación con buscar_producto usando la fracción en la consulta (por ejemplo "cuarto de bistec") y mande requested_quantity 1.`,
      );
    }

    // Regla dura: producto/categoria marcados "no se vende a domicilio" (PM: alcohol). Se
    // evalua ANTES de la confirmacion de mayoria de edad: no tiene caso preguntarla por algo
    // que de todos modos no se puede enviar. `canal` ausente = domicilio (historico).
    if (product.noDomicilio === true && (options.canal ?? "domicilio") === "domicilio") {
      throw new OrderValidationError(
        `${product.name} no se vende a domicilio. Quítelo del pedido o cambie el pedido a recoger en sucursal.`,
      );
    }

    if (product.requiresAdultConfirmation && options.adultConfirmed !== true) {
      throw new OrderValidationError(
        `Antes de cotizar ${product.name}, confirma de forma explícita que quien recibe el pedido es mayor de edad.`,
      );
    }
    if (product.requiresAdultConfirmation) containsAlcohol = true;

    if (item.tortilla !== undefined && !isTortillaChoice(item.tortilla)) {
      throw new OrderValidationError(`Tortilla inválida para ${product.name}: elige maíz, harina o mixta.`);
    }
    const requiresTortilla = product.requiresTortilla ?? /\btacos?\b/i.test(product.name);
    if (requiresTortilla && !item.tortilla) {
      throw new OrderValidationError(`Antes de continuar, confirma si ${product.name} va con tortilla de maíz, harina o mixta.`);
    }
    // Un renglón que no requiere tortilla nunca la carga, aunque el caller la mande
    // (los modelos a veces copian el último enum de tortilla a todos los renglones).
    const tortilla = requiresTortilla ? (item.tortilla ?? null) : null;

    const packSize = product.packSize;
    if (packSize !== null && (!Number.isInteger(packSize) || packSize < 1)) {
      throw new OrderValidationError(`Presentación inválida para ${product.name}`);
    }
    if (packSize && packSize > 1 && item.requestedQuantity % packSize !== 0) {
      const lower = Math.floor(item.requestedQuantity / packSize) * packSize;
      const upper = Math.ceil(item.requestedQuantity / packSize) * packSize;
      const opciones = lower >= packSize ? `${lower} o ${upper}` : String(upper);
      throw new OrderValidationError(
        `${product.name} solo se vende en órdenes de ${packSize} piezas. Pediste ${item.requestedQuantity}; puedes pedir ${opciones}. ` +
          `requested_quantity va en PIEZAS, no en órdenes: ${item.requestedQuantity < packSize ? `si el cliente pidió ${item.requestedQuantity === 1 ? "UNA orden" : `${item.requestedQuantity} órdenes`}, mande requested_quantity ${item.requestedQuantity * packSize}` : `una orden son ${packSize} piezas y dos son ${packSize * 2}`}; no reintente con el mismo número.`,
      );
    }

    const quantity = packSize && packSize > 1 ? item.requestedQuantity / packSize : item.requestedQuantity;
    const price = Number(product.price);
    const lineTotal = Math.round(price * quantity * 100) / 100;
    total = Math.round((total + lineTotal) * 100) / 100;
    lines.push({
      productId: product.id,
      name: product.name,
      price,
      requestedQuantity: item.requestedQuantity,
      packSize,
      quantity,
      tortilla,
      requiresAdultConfirmation: product.requiresAdultConfirmation,
      lineTotal,
    });
  }

  return { lines, total, containsAlcohol };
}
