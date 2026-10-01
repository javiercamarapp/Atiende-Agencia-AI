// R-11 + SoftRestaurant: la comanda de un pedido PROGRAMADO al pasar a cocina.
//
// Un pedido programado no manda su comanda al POS al crearse (llegaria horas antes de la hora elegida:
// ver public.ts). Al PROMOVERSE a `pending` (cron interno o el panel al consultar) entra a cocina, y por eso
// tambien debe llegar al POS. Antes de este helper la promocion solo cambiaba el estado: la cocina lo veia
// en el panel pero el POS nunca recibia la comanda salvo captura manual (hallazgo del e2e R-23).
//
// Una transaccion de SISTEMA por pedido (un POS lento o un pedido venenoso no revierte a los demas) y
// best-effort: nunca lanza ni cambia el estado ya promovido. Idempotente por pedido (`idempotency_key` del
// outbox de comandas): promover por el cron y por el panel a la vez no duplica la comanda. Con la bandera
// de SoftRestaurant apagada o sin la migracion 024, `encolarComandaParaPedido` no hace nada.
import { encolarComandaParaPedido } from "@atiende/domain-restaurantes/softrestaurant";
import type { Order } from "@atiende/domain-restaurantes";
import { softRestaurantComandaDeps } from "./softrestaurant-wiring.ts";
import type { AppDeps } from "../../../deps.ts";

export async function enqueueComandasForPromotedOrders(deps: AppDeps, orders: readonly Order[]): Promise<void> {
  for (const order of orders) {
    try {
      await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo = deps.restaurantesRepo(db);
        // `canal`/`propina` no viajan en el listado de promovidos (la base puede no tener la migracion 031).
        const [info] = await repo.listOrderPickupInfo(order.organizationId, [order.id]);
        await encolarComandaParaPedido(softRestaurantComandaDeps(deps, db, repo), {
          order,
          ...(info?.canal ? { tipo: info.canal } : {}),
          ...(info?.propina ? { propina: info.propina } : {}),
        });
      });
    } catch (err) {
      console.error("restaurantes programados: no se pudo encolar la comanda del pedido promovido (se puede capturar a mano):", err instanceof Error ? err.message : err);
    }
  }
}
