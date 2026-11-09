// D12 (criterio de «listo» de PM: totales = renglones con cortesías) sobre el catálogo REAL de PM (seed), no sobre una taquería de prueba:
// la cortesía del martes, el 2x1 del lunes y el extra COBRADO de doble salsa conviven en el mismo pedido y la suma de renglones sigue siendo
// exactamente el total que cotizó el agente y el que se guarda. pm-r5-d12-renglones-con-promocion.spec.ts cubre cada promoción por separado
// sobre productos inventados; aquí se fija la combinación con los precios y nombres que ve el cliente.
// Reloj fijo (solo Date, instantes absolutos). Pensiones abre a las 18:00 (America/Merida, UTC-6): 20:00 local = 02:00Z del día siguiente.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import type { DoubleSalsa } from "../src/types.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);
// 2026-10-13 es martes y 2026-10-12 lunes (20:00 en Merida).
const MARTES_20H = new Date("2026-10-14T02:00:00Z");
const LUNES_20H = new Date("2026-10-13T02:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const suma = (items: readonly { price: number; quantity: number }[]) => Math.round(items.reduce((a, i) => a + i.price * i.quantity, 0) * 100) / 100;

type Renglon = readonly [producto: string, piezas: number];
async function cotizarYCrear(fecha: Date, renglones: readonly Renglon[], doubleSalsas: readonly DoubleSalsa[], paymentMethod: "efectivo" | "tarjeta") {
  vi.setSystemTime(fecha);
  const w = await buildInMemoryPmWorld(plan);
  const items = renglones.map(([p, requestedQuantity]) => {
    const productId = w.productIds.get(p);
    if (!productId) throw new Error(`el catálogo de PM ya no tiene "${p}"`);
    return { productId, requestedQuantity, ...(p.startsWith("Taco") ? { tortilla: "maiz" as const } : {}) };
  });
  const base = { organizationId: w.organizationId, branchSlug: "pensiones", canal: "recoger" as const, items, doubleSalsas };
  const cotizacion = await quoteOrder(w.repo, base);
  const pedido = await createOrder(w.repo, { ...base, customerName: "Ana", customerPhone: "9991234567", source: "whatsapp", paymentMethod });
  return { cotizacion, pedido, renglones: pedido.items.map((i) => [i.name, i.price, i.quantity]) };
}

describe("D12 con el catálogo real de PM: cortesías, 2x1 y extra cobrado en un mismo pedido suman el total", () => {
  it("martes: nachos + 2 jamaicas (cortesía) + horchata cobrada + doble crema de ajo -> $407 cotizado = guardado = suma de renglones", async () => {
    const { cotizacion, pedido, renglones } = await cotizarYCrear(MARTES_20H, [["Nachos de Pastor", 1], ["Agua de Jamaica", 2], ["Horchata", 1]], ["crema_ajo"], "efectivo");
    expect(cotizacion.total).toBe(407);
    expect(pedido.total).toBe(407);
    expect(suma(pedido.items)).toBe(pedido.total);
    expect(renglones).toEqual([
      ["Nachos de Pastor", 328, 1],
      ["Agua de Jamaica", 0, 2],
      ["Horchata", 60, 1],
      ["Extra Salsa (doble porción: crema de ajo)", 19, 1],
    ]);
  });

  it("martes con tarjeta: 2 nachos (4 cortesías) + 5 aguas de tres sabores + doble salsa verde -> la quinta agua y el extra se cobran y la suma cuadra ($735)", async () => {
    const { cotizacion, pedido } = await cotizarYCrear(MARTES_20H, [["Nachos de Pastor", 2], ["Agua de Jamaica", 3], ["Horchata", 1], ["Té", 1]], ["salsa_verde"], "tarjeta");
    expect(cotizacion.total).toBe(735);
    expect(pedido.total).toBe(735);
    expect(suma(pedido.items)).toBe(pedido.total);
    // 4 aguas a $0 (las cortesías) y una cobrada a precio de lista: el renglón regalado nunca esconde un cobro.
    const aguas = pedido.items.filter((i) => ["Agua de Jamaica", "Horchata", "Té"].includes(i.name));
    expect(aguas.filter((i) => i.price === 0).reduce((a, i) => a + i.quantity, 0)).toBe(4);
    expect(aguas.filter((i) => i.price > 0).reduce((a, i) => a + i.quantity, 0)).toBe(1);
  });

  it("lunes: 5 tacos al pastor en 2x1 + doble piña -> 3 cobrados + 2 a $0 + el extra, $145 = suma de renglones", async () => {
    const { cotizacion, pedido, renglones } = await cotizarYCrear(LUNES_20H, [["Taco Al Pastor (individual)", 5]], ["salsa_pina"], "efectivo");
    expect(cotizacion.total).toBe(145);
    expect(pedido.total).toBe(145);
    expect(suma(pedido.items)).toBe(pedido.total);
    expect(renglones).toEqual([
      ["Taco Al Pastor (individual)", 42, 3],
      ["Taco Al Pastor (individual)", 0, 2],
      ["Extra Salsa (doble porción: salsa de piña)", 19, 1],
    ]);
  });
});
