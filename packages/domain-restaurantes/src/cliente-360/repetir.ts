// "Lo mismo de la vez pasada": toma un pedido anterior del MISMO cliente y lo vuelve a cotizar contra el catalogo y los
// precios de HOY. Nunca reutiliza el precio viejo y avisa de lo que ya no existe o cambio de precio.
import { OrderValidationError } from "../errors.ts";
import { extraerPackSize } from "../product-search.ts";
import { fusionarRenglonesPorProducto } from "../promotions.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { PersistedOrderItem } from "../types.ts";
import type { PastOrder } from "./types.ts";

export interface CambioDeRepeticion {
  readonly producto: string;
  readonly motivo: "ya_no_disponible" | "precio_cambio";
  readonly precioAnterior: number;
  /** null cuando el producto ya no esta disponible. */
  readonly precioActual: number | null;
}

export interface RenglonRepetido {
  readonly productId: string;
  readonly productName: string;
  readonly requestedQuantity: number;
  readonly tortilla?: "maiz" | "harina" | "mixta";
}

export interface PedidoRepetido {
  readonly pedido: { readonly numero: number | null; readonly fecha: string; readonly total: number; readonly sucursal: string | null };
  readonly renglones: readonly RenglonRepetido[];
  readonly cambios: readonly CambioDeRepeticion[];
  readonly totalAnterior: number;
}

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Elige el pedido a repetir: el numero citado por el cliente o, sin numero, el mas reciente. */
export function elegirPedido(orders: readonly PastOrder[], numero: number | undefined): PastOrder {
  if (orders.length === 0) throw new OrderValidationError("Este cliente todavía no tiene pedidos anteriores que repetir.");
  if (numero === undefined) return orders[0]!;
  const found = orders.find((o) => o.orderNumber === numero);
  if (!found) throw new OrderValidationError(`No encontré el pedido ${numero} entre los pedidos anteriores de este cliente.`);
  return found;
}

/**
 * Resuelve los renglones del pedido anterior contra el catalogo disponible HOY de la sucursal. El resultado alimenta la
 * cotizacion normal (`cotizar_pedido`), que es quien fija precios y reglas: aqui solo se decide que renglones siguen
 * existiendo y se detectan los cambios para avisarlos al cliente.
 */
export async function repetirPedido(repo: RestaurantesRepository, args: { readonly organizationId: string; readonly branchSlug: string; readonly order: PastOrder }): Promise<PedidoRepetido> {
  const branch = await repo.findBranch(args.organizationId, { slug: args.branchSlug });
  if (!branch || branch.status !== "active") throw new OrderValidationError(`Sucursal '${args.branchSlug}' no encontrada o inactiva`);
  const catalog = await repo.listAvailableProductsForBranch(branch.propertyId);

  const renglones: RenglonRepetido[] = [];
  const cambios: CambioDeRepeticion[] = [];
  // D12: un renglon regalado por la promocion (a $0) y su renglon pagado son el mismo producto: se repite UNA vez, al precio de lista.
  for (const item of fusionarRenglonesPorProducto(args.order.items as readonly PersistedOrderItem[])) {
    const product = catalog.find((p) => p.id === item.id) ?? catalog.find((p) => normalizar(p.name) === normalizar(item.name));
    if (!product) {
      cambios.push({ producto: item.name, motivo: "ya_no_disponible", precioAnterior: item.price, precioActual: null });
      continue;
    }
    const packSize = extraerPackSize(product.name, product.description);
    const requestedQuantity = Math.round(item.quantity * (packSize && packSize > 1 ? packSize : 1));
    renglones.push({ productId: product.id, productName: product.name, requestedQuantity, ...(item.tortilla ? { tortilla: item.tortilla } : {}) });
    if (Math.round(Number(product.price) * 100) !== Math.round(item.price * 100)) {
      cambios.push({ producto: product.name, motivo: "precio_cambio", precioAnterior: item.price, precioActual: Number(product.price) });
    }
  }
  if (renglones.length === 0) {
    throw new OrderValidationError("Ninguno de los productos de ese pedido está disponible hoy en esa sucursal. Ofrezca ver el menú y armar un pedido nuevo.");
  }
  return {
    pedido: { numero: args.order.orderNumber, fecha: args.order.createdAt, total: args.order.total, sucursal: args.order.branch },
    renglones,
    cambios,
    totalAnterior: args.order.total,
  };
}
