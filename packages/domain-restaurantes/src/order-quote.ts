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
};

/** Tortillas validas de un renglon de tacos (`mixta` = mitad maiz, mitad harina). */
export const TORTILLA_CHOICES: readonly TortillaChoice[] = ["maiz", "harina", "mixta"];

export function isTortillaChoice(value: unknown): value is TortillaChoice {
  return typeof value === "string" && (TORTILLA_CHOICES as readonly string[]).includes(value);
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
): string {
  // Las 9 salsas (incluidas habanero y crema de ajo) ya van incluidas sin costo por omision, asi que pedir
  // habanero/crema de ajo NO agrega una linea "solicitados" aparte (apareceria a la vez como incluido y
  // solicitado). Si el cliente la pide expresamente, esa peticion gana sobre una omision contradictoria.
  const requestedSet = new Set<DefaultComplement>(requested);
  const omittedSet = new Set(omitted.map(canonicalComplement));
  const included = DEFAULT_COMPLEMENTS.filter((item) => requestedSet.has(item) || !omittedSet.has(item));
  const lines = [notes?.trim()].filter(Boolean) as string[];
  lines.push(
    included.length > 0
      ? `Complementos incluidos: ${included.map((item) => COMPLEMENT_LABELS[item]).join(", ")}.`
      : "No enviar complementos de cortesía.",
  );
  return lines.join("\n");
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
      item.requestedQuantity > 100
    ) {
      throw new OrderValidationError("Productos o cantidades inválidos");
    }
    const product = products.find((candidate) => candidate.id === item.productId);
    if (!product) {
      throw new OrderValidationError(`Producto no disponible: ${item.productId}`);
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
        `${product.name} solo se vende en órdenes de ${packSize} piezas. Pediste ${item.requestedQuantity}; puedes pedir ${opciones}.`,
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
