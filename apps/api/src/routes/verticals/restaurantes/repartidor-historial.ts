// R-15 -- GET /v1/restaurantes/:propertyId/repartidor/historial-dia: lo que ESTE repartidor entrego hoy (dia calendario en la zona horaria
// de la sucursal, por `delivered_at`) y cuanto efectivo debe rendir. Solo rol `repartidor` y solo sus pedidos (misma restriccion que
// repartidor-orders.ts). Totales en centavos enteros.
//
// "Efectivo a rendir" = suma de los pedidos entregados hoy cuyo metodo de pago registrado es `efectivo`. El metodo de pago es un dato
// opcional del pedido: los pedidos SIN metodo registrado se cuentan aparte (`sinMetodoPedidos`) y NO se suman al efectivo, para no
// inventar una cifra; la pantalla lo avisa. No incluye propinas (la propina vive en una columna de la migracion 031 que no se lee aqui).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { REPARTIDOR_ROLES, diaLocalSucursal } from "@atiende/domain-restaurantes";
import type { Order } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../../../deps.ts";

const centavos = (pesos: number): number => Math.round(pesos * 100);

export function totalizarEntregas(orders: readonly Pick<Order, "total" | "paymentMethod">[]) {
  let totalCentavos = 0;
  let efectivoCentavos = 0;
  let efectivoPedidos = 0;
  let tarjetaCentavos = 0;
  let sinMetodoPedidos = 0;
  for (const o of orders) {
    const c = centavos(o.total);
    totalCentavos += c;
    if (o.paymentMethod === "efectivo") {
      efectivoCentavos += c;
      efectivoPedidos++;
    } else if (o.paymentMethod === "tarjeta") tarjetaCentavos += c;
    else sinMetodoPedidos++;
  }
  return { pedidos: orders.length, totalCentavos, efectivoCentavos, efectivoPedidos, tarjetaCentavos, sinMetodoPedidos };
}

export function restaurantesRepartidorHistorialRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/repartidor/historial-dia";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, REPARTIDOR_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const { zonaHoraria } = await repo.findBranchZonaHoraria(c.req.param("propertyId") ?? "");
    const { fecha, zonaHoraria: zona } = diaLocalSucursal(new Date(), zonaHoraria);
    const orders = await repo.listDeliveredOrdersForRepartidor(c.get("organizationId"), c.get("userId"), fecha, zona);
    return c.json({
      fecha,
      zonaHoraria: zona,
      entregas: orders.map((o) => ({ id: o.id, customerName: o.customerName, total: o.total, paymentMethod: o.paymentMethod, status: o.status, deliveredAt: o.deliveredAt ?? null })),
      totales: totalizarEntregas(orders),
    });
  });

  return app;
}
