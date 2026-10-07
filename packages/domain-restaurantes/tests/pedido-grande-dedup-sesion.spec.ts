// Regresion PR #470 (revision Opus): "otro igual" (< 5 min, deduplicado por create_order_idempotent) de un pedido YA aceptado no debe retenerse como pedido grande.
// La memoria del cliente (049) excluye `programado`, asi que el id del ultimo pedido de la sesion se marca como ya aceptado (`sesionPrevia.ultimoPedidoId`).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import type { PedidoGrandeHook } from "../src/autopiloto/tipos.ts";
import type { Order } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Martes 2026-10-06 13:00 en Merida (UTC-6).
const AHORA = new Date("2026-10-06T13:00:00-06:00");
const MANANA_14 = "2026-10-07T14:00:00-06:00";
const TEL = "9991234567";

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AHORA);
});
afterEach(() => vi.useRealTimers());

interface Opts {
  readonly memoria?: boolean;
  readonly autopiloto?: boolean;
  readonly cliente?: "nuevo" | "con_historial" | "sin_pedidos";
}

async function mundo(opts: Opts = {}) {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
  if (opts.memoria === false) f.repo.setCliente360Supported(false);
  const kilos = randomUUID();
  f.repo.seedCategory({ id: kilos, organizationId: f.organizationId, name: "Kilos a Domicilio" });
  const p: Record<string, string> = {};
  for (const [name, price] of [["Arrachera — 2 kg", 2800], ["Bistec de Res — 2 kg", 2200], ["Pastor — 1 kg", 900], ["Pastor — 500 g", 450]] as const) {
    const id = randomUUID();
    p[name] = id;
    f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: kilos, name, description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price, isAvailable: true });
  }
  const cliente = opts.cliente ?? "sin_pedidos";
  if (cliente === "sin_pedidos") await f.repo.upsertCustomer(f.organizationId, TEL, "Nora");
  if (cliente === "con_historial") {
    const c = await f.repo.upsertCustomer(f.organizationId, TEL, "Nora");
    // Un pedido entregado hace 3 dias (fuera de la ventana de 6 h): historial real.
    f.repo.seedOrder({
      id: randomUUID(), organizationId: f.organizationId, propertyId: f.propertyId, customerId: c.id, customerName: "Nora", customerPhone: TEL, branch: "Fco Montejo",
      total: 300, status: "entregado", items: [], source: "whatsapp", createdAt: new Date(AHORA.getTime() - 3 * 86_400_000).toISOString(),
    } as unknown as Order);
  }
  const retenidos: { orderId: string; statusAntes: string; detalle: Record<string, unknown> }[] = [];
  const orders = (f.repo as unknown as { orders: Order[] }).orders;
  // Espejo de restaurantes.solicitud_pedido_grande_retener (050): pending/programado -> por_aprobar; por_aprobar -> existente; otro -> error.
  const hook: PedidoGrandeHook = {
    disponible: async () => true,
    retener: async (i) => {
      const idx = orders.findIndex((o) => o.id === i.orderId);
      const o = orders[idx]!;
      retenidos.push({ orderId: i.orderId, statusAntes: o.status, detalle: { ...i.detalle } });
      if (o.status === "por_aprobar") return { estado: "por_aprobar", solicitudId: "existente" };
      if (o.status !== "pending" && o.status !== "programado") throw new Error(`solicitud_pedido_grande_retener: el pedido ya avanzo (${o.status})`);
      orders[idx] = { ...o, status: "por_aprobar" } as Order;
      return { estado: "por_aprobar", solicitudId: randomUUID() };
    },
  };
  let turn = 1;
  let conv = "c1";
  const ctx = () => ({
    organizationId: f.organizationId, channel: "whatsapp" as const, phone: TEL, flow: { key: `k:${conv}`, turn: String(turn), now: () => Date.now() },
    ...(opts.autopiloto === false ? {} : { pedidoGrande: hook }),
  });
  const base = { branch_slug: "fco-montejo", canal: "recoger" };
  const pedir = async (nombres: readonly string[], pago: "efectivo" | "tarjeta" = "tarjeta", extra: Record<string, unknown> = {}) => {
    const items = nombres.map((n) => ({ product_id: p[n]!, product_name: n, requested_quantity: 1 }));
    turn += 1;
    await invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, items, ...extra });
    turn += 1;
    await invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
    return invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, items, customer_name: "Nora", payment_method: pago, ...extra });
  };
  const nuevaConversacion = (horas: number) => {
    vi.setSystemTime(new Date(Date.now() + horas * 3_600_000));
    conv = randomUUID();
  };
  const avisos = () => f.repo.listCallbackRequests(f.organizationId).filter((a) => a.reason === "escalada:pedido_grande");
  const estado = (id: string | null) => orders.find((o) => o.id === id)?.status;
  return { f, pedir, nuevaConversacion, retenidos, avisos, estado, orders };
}

describe("'otro igual' dentro de 5 min en la misma sesion (deduplicado)", () => {
  it("pedido pending (esta en la memoria): no se retiene", async () => {
    const m = await mundo();
    const a = await m.pedir(["Bistec de Res — 2 kg"]);
    const b = await m.pedir(["Bistec de Res — 2 kg"]);
    expect(b.orderId).toBe(a.orderId);
    expect(m.retenidos).toHaveLength(0);
    expect(m.estado(a.orderId)).toBe("pending");
  });
  it("pedido PROGRAMADO (la memoria no lo incluye): no se retiene y sigue programado", async () => {
    const m = await mundo();
    const a = await m.pedir(["Bistec de Res — 2 kg"], "tarjeta", { programado_para: MANANA_14 });
    expect(m.estado(a.orderId)).toBe("programado");
    const b = await m.pedir(["Bistec de Res — 2 kg"], "tarjeta", { programado_para: MANANA_14 });
    expect(b.orderId).toBe(a.orderId);
    expect(m.retenidos).toHaveLength(0);
    expect(m.estado(a.orderId)).toBe("programado");
  });
  it("pending SIN memoria (049 ausente, 050 presente): no se retiene el ya aceptado", async () => {
    const m = await mundo({ memoria: false });
    const a = await m.pedir(["Bistec de Res — 2 kg"]);
    const b = await m.pedir(["Bistec de Res — 2 kg"]);
    expect(b.orderId).toBe(a.orderId);
    expect(m.retenidos).toHaveLength(0);
    expect(m.estado(a.orderId)).toBe("pending");
  });
});
