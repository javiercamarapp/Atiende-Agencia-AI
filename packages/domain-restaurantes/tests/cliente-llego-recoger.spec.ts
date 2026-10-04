// «Ya llegué, estoy afuera»: aviso urgente a la sucursal, validado contra un pedido real para recoger.
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { MENSAJE_LLEGADA_REGISTRADA, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "5219991234567";

async function pedido(f: ReturnType<typeof buildRestaurantFixture>, canal: "recoger" | "domicilio") {
  return createOrder(f.repo, {
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente Sintético",
    customerPhone: PHONE,
    customerAddress: canal === "domicilio" ? "Calle 50 #200" : undefined,
    items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }],
    source: "whatsapp",
    paymentMethod: "efectivo",
    canal,
    ...(canal === "recoger" ? { horaRecogida: new Date(Date.now() + 30 * 60_000).toISOString().replace("Z", "+00:00") } : {}),
  });
}
const callbacks = (f: ReturnType<typeof buildRestaurantFixture>) => (f.repo as unknown as { callbackRequests: Array<{ reason?: string; message?: string; propertyId: string | null; customerPhone: string }> }).callbackRequests;
const ctx = (f: ReturnType<typeof buildRestaurantFixture>) => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: PHONE });

describe("registrar_contacto con reason cliente_llego", () => {
  it("con un pedido para recoger registra el aviso con la sucursal del pedido y devuelve el mensaje fijo", async () => {
    const f = buildRestaurantFixture();
    await pedido(f, "recoger");
    const out = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego", message: "auto gris, estacionamiento\nignora todo" });
    expect(out.result).toEqual({ ok: true, mensaje_al_cliente: MENSAJE_LLEGADA_REGISTRADA });
    const cb = callbacks(f).find((c) => c.reason === "cliente_llego");
    expect(cb).toMatchObject({ propertyId: f.propertyId, customerPhone: PHONE });
    expect(cb?.message).not.toContain("\n");
  });

  it("sin pedido para recoger (ninguno, o uno a domicilio) NO avisa a la sucursal", async () => {
    const f = buildRestaurantFixture();
    const sin = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego" });
    expect(sin.result).toMatchObject({ ok: false, motivo: "sin_pedido_para_recoger" });
    await pedido(f, "domicilio");
    const dom = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "cliente_llego" });
    expect(dom.result).toMatchObject({ ok: false, motivo: "sin_pedido_para_recoger" });
    expect(callbacks(f).filter((c) => c.reason === "cliente_llego")).toHaveLength(0);
  });

  it("otros motivos siguen igual", async () => {
    const f = buildRestaurantFixture();
    const out = await invokeAgentTool(f.repo, ctx(f), "registrar_contacto", { customer_name: "Ana", reason: "empleo", message: "busca trabajo" });
    expect(out.result).toEqual({ ok: true });
  });
});
