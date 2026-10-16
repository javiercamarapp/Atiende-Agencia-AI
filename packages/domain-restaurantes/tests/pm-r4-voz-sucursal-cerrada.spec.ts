// QA-PM-R4-voz-01 (VR31): una llamada a una sucursal que abre a las 18:00 el martes, a las 13:00, no puede crear pedido. La guarda de horario vive en el SERVIDOR
// (aplicarReglasDeSucursal) y aplica igual a `source: voice`; la copia real de PM tiene todas las sucursales de 12:00 a 01:00, por eso en esa copia el martes 13:00 si esta abierto.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

afterEach(() => vi.useRealTimers());

describe("voz: crear_pedido respeta el horario de la sucursal", () => {
  it("martes 13:00 en una sucursal que abre a las 18:00: crear_pedido y cotizar_pedido se rechazan con la hora de apertura", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [2], abre: "18:00", cierra: "01:00" }] });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T19:00:00Z")); // martes 13:00 en Merida
    const ctx = { organizationId: f.organizationId, channel: "voz" as const, phone: "9991234567" };
    const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }];
    await expect(invokeAgentTool(f.repo, ctx, "cotizar_pedido", { branch_slug: "fco-montejo", items, canal: "recoger" })).rejects.toThrow(/cerrada en este momento; abre hoy a las 18:00/);
    await expect(
      invokeAgentTool(f.repo, ctx, "crear_pedido", { branch_slug: "fco-montejo", items, canal: "recoger", customer_name: "Ana Prueba", payment_method: "efectivo" }),
    ).rejects.toThrow(/cerrada en este momento/);
  });
});
