// QA-PM-R4-voz-02 (VS13): el pedido grande retenido decia "ha quedado registrado" porque la herramienta le devolvia al modelo un texto con la palabra REGISTRADO. Ahora trae
// un `mensaje_al_cliente` fijo que no afirma registro.
import { describe, expect, it } from "vitest";
import { invokeAgentTool, MENSAJE_PEDIDO_GRANDE_PENDIENTE } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe.each(["voz", "whatsapp"] as const)("%s: pedido grande retenido", (channel) => {
  it("devuelve mensaje_al_cliente sin afirmar registro, confirmacion ni cocina, y deja el aviso pedido_grande", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
    const ctx = { organizationId: f.organizationId, channel, phone: "9991234567" };
    const r = await invokeAgentTool(f.repo, ctx, "crear_pedido", {
      branch_slug: "fco-montejo",
      items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 120 }],
      canal: "recoger",
      customer_name: "Ana Prueba",
      payment_method: "efectivo",
    });
    const res = r.result as { pedido_grande?: boolean; mensaje_al_cliente?: string; mensaje?: string };
    expect(res.pedido_grande).toBe(true);
    expect(res.mensaje_al_cliente).toBe(MENSAJE_PEDIDO_GRANDE_PENDIENTE);
    expect(res.mensaje_al_cliente).not.toMatch(/registrad|confirmad|preparaci|cocina ya/i);
    expect(res.mensaje).not.toMatch(/REGISTRADO/);
    expect((await f.repo.listCallbackRequests(f.organizationId)).some((a) => (a.reason ?? "").startsWith("escalada:pedido_grande"))).toBe(true);
  });
});
