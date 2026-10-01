// Deja la maquina de estados del pedido en "confirmado" como si el cliente ya hubiera visto la
// cotizacion y dicho que si en un turno anterior (para pruebas que arrancan en el mensaje donde
// el modelo crea el pedido).
import { fingerprintOrder } from "../../src/agent-tools/order-flow.ts";
import type { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import type { RequestedOrderItemInput } from "../../src/types.ts";

export async function seedConfirmedOrderFlow(
  repo: InMemoryRestaurantesRepository,
  organizationId: string,
  flowKey: string,
  order: { readonly branchSlug: string; readonly canal?: "domicilio" | "recoger"; readonly adultConfirmed?: boolean; readonly items: readonly RequestedOrderItemInput[] },
  quotedTurn: string | null = "0",
): Promise<void> {
  const quoteHash = fingerprintOrder(order);
  const now = Date.now();
  const res = await repo.writeOrderFlow(organizationId, flowKey, 0, { state: "confirmado", context: { quoteHash, quotedAtMs: now, quotedTurn, confirmedAtMs: now } }, 3600);
  if (res !== "written") throw new Error("no se pudo sembrar el estado del pedido");
}
