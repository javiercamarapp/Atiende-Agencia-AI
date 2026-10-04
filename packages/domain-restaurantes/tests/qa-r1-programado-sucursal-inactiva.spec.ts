// QA restaurantes, ronda 1 (lote storefront / dinero / idempotencia): regresion de QA-restaurantes-R1-caos-17. Un pedido PROGRAMADO
// de una sucursal que se desactiva antes de su hora no se promueve en silencio a cocina. Repositorio en memoria, reloj de `Date` congelado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { promoverProgramadosTodasLasOrganizaciones, promoverProgramadosVencidos } from "../src/pedidos-programados.ts";
import type { CreateOrderInput } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Viernes 2026-10-02 12:00 en Merida (UTC-6).
const AHORA = new Date("2026-10-02T12:00:00-06:00");
const PM = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AHORA);
});
afterEach(() => {
  vi.useRealTimers();
});

function pedido(f: ReturnType<typeof buildRestaurantFixture>, extra: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente Caos",
    customerPhone: "9997770000",
    customerAddress: "Calle 1",
    items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }],
    source: "web",
    ...extra,
  };
}

describe("caos de operacion: un pedido programado y la sucursal cambia antes de su hora", () => {
  it("QA-caos-17: un programado de una sucursal desactivada no se promueve en silencio a cocina (panel y barrido global); se queda programado", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: PM });
    const order = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T14:00:00-06:00" }));
    expect(order.status).toBe("programado");
    const branch = await f.repo.findBranchById(f.organizationId, f.propertyId);
    f.repo.seedBranch({ ...branch!, status: "inactive" });
    const ahora = new Date("2026-10-03T13:40:00-06:00");
    const r = await promoverProgramadosVencidos(f.repo, f.organizationId, { now: ahora });
    expect(r.promovidos.map((o) => o.id)).not.toContain(order.id);
    const global = await promoverProgramadosTodasLasOrganizaciones(f.repo, { now: ahora });
    expect(global.promovidos.map((o) => o.id)).not.toContain(order.id);
    expect((await f.repo.listScheduledOrders(f.organizationId, { propertyIds: null, limit: 10 })).orders.map((o) => o.id)).toContain(order.id);
  });

  it("al reactivar la sucursal el programado vencido SI se promueve (no queda atorado para siempre)", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: PM });
    const order = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-03T14:00:00-06:00" }));
    const branch = await f.repo.findBranchById(f.organizationId, f.propertyId);
    f.repo.seedBranch({ ...branch!, status: "inactive" });
    const ahora = new Date("2026-10-03T13:40:00-06:00");
    expect((await promoverProgramadosVencidos(f.repo, f.organizationId, { now: ahora })).promovidos).toHaveLength(0);
    f.repo.seedBranch({ ...branch!, status: "active" });
    expect((await promoverProgramadosVencidos(f.repo, f.organizationId, { now: ahora })).promovidos.map((o) => o.id)).toEqual([order.id]);
  });

  it("un programado cancelado nunca se promueve y uno lejano espera su ventana", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: PM });
    const lejano = await createOrder(f.repo, pedido(f, { programadoPara: "2026-10-04T14:00:00-06:00" }));
    const r = await promoverProgramadosVencidos(f.repo, f.organizationId, { now: new Date("2026-10-03T13:40:00-06:00") });
    expect(r.promovidos.map((o) => o.id)).not.toContain(lejano.id);
  });
});
