import type { ItemInventarioUnidad } from "./tipos.ts";

/**
 * Inventario mínimo de ropa blanca/consumibles por unidad (H-052, REQ-115) — port de
 * rentas/packages/domain/src/limpieza/inventario.ts. `aplicarConsumo` es pura:
 * calcula el nuevo nivel y si cruza el umbral mínimo (alerta de stock bajo); la
 * capa de aplicación es quien persiste el nuevo nivel y decide a quién notificar la
 * alerta.
 */
export interface ResultadoConsumoInventario {
  readonly cantidadNueva: number;
  readonly cruzaUmbralMinimo: boolean;
}

export function aplicarConsumo(item: Pick<ItemInventarioUnidad, "cantidadActual" | "umbralMinimo">, cantidadConsumida: number): ResultadoConsumoInventario {
  if (cantidadConsumida < 0) {
    throw new Error("cantidadConsumida no puede ser negativa");
  }
  const cantidadNueva = Math.max(0, item.cantidadActual - cantidadConsumida);
  const estabaPorEncimaDelUmbral = item.cantidadActual >= item.umbralMinimo;
  const quedaPorDebajoDelUmbral = cantidadNueva < item.umbralMinimo;
  return {
    cantidadNueva,
    cruzaUmbralMinimo: estabaPorEncimaDelUmbral && quedaPorDebajoDelUmbral,
  };
}

export function stockBajo(item: Pick<ItemInventarioUnidad, "cantidadActual" | "umbralMinimo">): boolean {
  return item.cantidadActual < item.umbralMinimo;
}
