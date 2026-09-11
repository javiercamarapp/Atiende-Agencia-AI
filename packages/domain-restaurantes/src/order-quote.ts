// Port literal de la cotización de pedido de
// restaurantes/supabase/functions/_shared/create-order-core.ts
// (buildOrderQuoteFromProducts/buildComplementNotes). Traduce lo que pidió el
// cliente (piezas/unidades habladas) a unidades cobrables del catálogo — el cálculo
// vive fuera del LLM para que "8 individuales" nunca se convierta en "máximo 1", y
// para que una orden de 3 se cobre una sola vez, no tres. El precio SIEMPRE sale de
// `product.price` (que ya viene de branch_products, resuelto server-side) — nunca de
// lo que mande el cliente.
import { OrderValidationError } from "./errors.ts";
import type { DefaultComplement, OrderQuote, ProductoEncontrado, QuotedOrderLine, RequestedComplement, RequestedOrderItemInput } from "./types.ts";

export const DEFAULT_COMPLEMENTS: readonly DefaultComplement[] = ["salsa_verde", "salsa_roja", "limones", "cebolla"];

const COMPLEMENT_LABELS: Record<DefaultComplement | RequestedComplement, string> = {
  salsa_verde: "salsa verde",
  salsa_roja: "salsa roja",
  limones: "limones",
  cebolla: "cebolla",
  salsa_habanero: "salsa habanero",
  crema_ajo: "crema de ajo",
};

export function buildComplementNotes(
  notes?: string,
  requested: readonly RequestedComplement[] = [],
  omitted: readonly DefaultComplement[] = [],
): string {
  const omittedSet = new Set(omitted);
  const included = DEFAULT_COMPLEMENTS.filter((item) => !omittedSet.has(item));
  const uniqueRequested = [...new Set(requested)];
  const lines = [notes?.trim()].filter(Boolean) as string[];
  lines.push(
    included.length > 0
      ? `Complementos incluidos: ${included.map((item) => COMPLEMENT_LABELS[item]).join(", ")}.`
      : "No enviar complementos de cortesía.",
  );
  if (uniqueRequested.length > 0) {
    lines.push(`Complementos solicitados: ${uniqueRequested.map((item) => COMPLEMENT_LABELS[item]).join(", ")}.`);
  }
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
  options: { readonly adultConfirmed?: boolean } = {},
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

    if (product.requiresAdultConfirmation && options.adultConfirmed !== true) {
      throw new OrderValidationError(
        `Antes de cotizar ${product.name}, confirma de forma explícita que quien recibe el pedido es mayor de edad.`,
      );
    }
    if (product.requiresAdultConfirmation) containsAlcohol = true;

    if (item.tortilla !== undefined && item.tortilla !== "maiz" && item.tortilla !== "harina") {
      throw new OrderValidationError(`Tortilla inválida para ${product.name}: elige maíz o harina.`);
    }
    const requiresTortilla = /\btacos?\b/i.test(product.name);
    if (requiresTortilla && !item.tortilla) {
      throw new OrderValidationError(`Antes de continuar, confirma si ${product.name} va con tortilla de maíz o harina.`);
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
