// QA-restaurantes-R1-viaje-10: los avisos de estado y las respuestas ARCO tratan de USTED (P26), como el agente y la voz.
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { notifyCustomerOnOrderStatusChangeCore } from "../src/order-notifications.ts";
import { arcoAlreadyOpenReply, arcoConfirmedReply, arcoPendingConfirmationReply, arcoWithdrawnReply, ARCO_MENU_REPLY, ARCO_THIRD_PARTY_REPLY } from "../src/privacidad/data-rights.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Formas de tuteo que no deben aparecer en texto al cliente de PM.
const TUTEO = /\b(tu|tus|tuyo|tuyos|tú|te|puedes|necesitas|tienes|quieres|haces|responde|dime|contáctanos|hiciste)\b/i;

describe("trato de usted en WhatsApp al cliente", () => {
  it("los avisos de estado del pedido no tutean", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: "9990001111",
      customerAddress: "Calle 80 #30", items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }], source: "web",
    });
    for (const [from, to] of [["pending", "preparando"], ["preparando", "en_camino"], ["en_camino", "entregado"]] as const) {
      const updated = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, from, to);
      await notifyCustomerOnOrderStatusChangeCore(fixture.repo, updated!);
    }
    const bodies = fixture.repo.getOutbox().map((r) => (r.payload as { body: string }).body);
    expect(bodies).toHaveLength(3);
    for (const b of bodies) {
      expect(b).toContain("su pedido");
      expect(b).not.toMatch(TUTEO);
    }
  });

  it("las respuestas ARCO no tutean", () => {
    const textos = [
      ARCO_MENU_REPLY,
      ARCO_THIRD_PARTY_REPLY,
      arcoPendingConfirmationReply("acceso", "11111111-1111-4111-8111-111111111111"),
      arcoConfirmedReply("cancelacion", "11111111-1111-4111-8111-111111111111", null, null, "America/Merida"),
      arcoWithdrawnReply("acceso", "11111111-1111-4111-8111-111111111111"),
      arcoAlreadyOpenReply("acceso", "11111111-1111-4111-8111-111111111111", "recibida", null, "America/Merida"),
    ];
    for (const t of textos) expect(t).not.toMatch(TUTEO);
  });
});
