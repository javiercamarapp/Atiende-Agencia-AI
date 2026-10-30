// R22 #3 (conductual, sin regex de prompt): un pedido de MAS de $4,000 se cotiza y se crea UNA sola vez en estado por_aprobar con su aviso `escalada:pedido_grande`,
// SIN escalada previa del agente (el aviso lo deja el servidor al crear), y reintentar no crea un segundo pedido. El umbral del servidor es > 4000 (pedido-grande.ts).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import type { PedidoGrandeHook } from "../src/autopiloto/tipos.ts";
import type { Order } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const AHORA = new Date("2026-10-06T13:00:00-06:00"); // martes 13:00 en Merida
const TEL = "9991234567";
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AHORA);
});
afterEach(() => vi.useRealTimers());

async function mundo() {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
  const cat = randomUUID();
  f.repo.seedCategory({ id: cat, organizationId: f.organizationId, name: "Kilos a Domicilio" });
  const productId = randomUUID();
  f.repo.seedProduct({ id: productId, organizationId: f.organizationId, categoryId: cat, name: "Arrachera — 2 kg", description: null, searchKeywords: [] });
  f.repo.seedBranchProduct({ propertyId: f.propertyId, productId, price: 2800, isAvailable: true });
  await f.repo.upsertCustomer(f.organizationId, TEL, "Nora");
  const orders = (f.repo as unknown as { orders: Order[] }).orders;
  const retenidos: string[] = [];
  const hook: PedidoGrandeHook = {
    disponible: async () => true,
    retener: async (i) => {
      const idx = orders.findIndex((o) => o.id === i.orderId);
      retenidos.push(i.orderId);
      if (orders[idx]!.status === "por_aprobar") return { estado: "por_aprobar", solicitudId: "existente" };
      orders[idx] = { ...orders[idx]!, status: "por_aprobar" } as Order;
      return { estado: "por_aprobar", solicitudId: randomUUID() };
    },
  };
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: TEL, flow: { key: "k:c1", turn: String(turn), now: () => Date.now() }, pedidoGrande: hook });
  const base = { branch_slug: "fco-montejo", canal: "recoger" };
  const items = [{ product_id: productId, product_name: "Arrachera — 2 kg", requested_quantity: 2 }]; // 2 x $2,800 = $5,600
  const avisos = () => f.repo.listCallbackRequests(f.organizationId).filter((a) => a.reason === "escalada:pedido_grande");
  return { f, orders, retenidos, avisos, ctx, base, items, siguiente: () => void (turn += 1) };
}

describe("R22-3b pedido de mas de $4,000: se toma normal, queda por_aprobar con aviso, una sola vez", () => {
  it("cotizar y confirmar NO escalan; crear_pedido deja UN pedido por_aprobar y UN aviso; el reintento no crea otro", async () => {
    const m = await mundo();
    m.siguiente();
    const cot = (await invokeAgentTool(m.f.repo, m.ctx(), "cotizar_pedido", { ...m.base, items: m.items })) as { result: { quote?: { total: number } } };
    expect(cot.result.quote!.total).toBe(5600);
    expect(m.avisos()).toHaveLength(0); // sin escalada previa
    expect(m.orders).toHaveLength(0);
    m.siguiente();
    await invokeAgentTool(m.f.repo, m.ctx(), "confirmar_resumen", {});
    expect(m.avisos()).toHaveLength(0);

    const r = (await invokeAgentTool(m.f.repo, m.ctx(), "crear_pedido", { ...m.base, items: m.items, customer_name: "Nora", payment_method: "tarjeta" })) as { orderId?: string; result?: unknown };
    expect(m.orders).toHaveLength(1);
    expect(m.orders[0]!.status).toBe("por_aprobar");
    expect(r.orderId).toBe(m.orders[0]!.id);
    expect(m.avisos()).toHaveLength(1);
    expect(m.retenidos).toHaveLength(1);

    // reintento (el modelo repite crear_pedido): no se duplica ni el pedido ni el aviso
    await invokeAgentTool(m.f.repo, m.ctx(), "crear_pedido", { ...m.base, items: m.items, customer_name: "Nora", payment_method: "tarjeta" }).catch(() => undefined);
    expect(m.orders).toHaveLength(1);
    expect(m.orders[0]!.status).toBe("por_aprobar");
    expect(m.avisos()).toHaveLength(1);
  });
});
