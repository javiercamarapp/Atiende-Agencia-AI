// Regresiones del HISTORIAL DE GIT del original, lote 3: avisos de estado al cliente (9460a3e) y fallo parcial
// del despacho de WhatsApp (34c2696). it.fails = defecto vigente en main que corrige el lote nombrado.
import { describe, expect, it } from "vitest";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher, WhatsAppSendError } from "@atiende/whatsapp-gateway";
import type { MessagingOutboxItem, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import { createOrder } from "../../src/orders.ts";
import { notifyCustomerOnOrderStatusChangeCore } from "../../src/order-notifications.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

const TUTEO = /\b(?:tu|tus|tienes|puedes|quieres|cont[áa]ctanos|te|ti)\b/i;

async function pedidoEnEstado(estados: readonly ("preparando" | "en_camino" | "entregado")[]) {
  const f = buildRestaurantFixture();
  f.repo.seedWhatsAppChannel(f.organizationId, "PHONE_NUMBER_ID_123");
  const order = await createOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Marcela", customerPhone: "9990001111", customerAddress: "Calle 80 #30", items: [{ productId: f.products.cocaCola, requestedQuantity: 1 }], source: "web" });
  let previo: "pending" | "preparando" | "en_camino" = "pending";
  const actualizados = [];
  for (const estado of estados) {
    const updated = await f.repo.updateOrderStatus(f.organizationId, order.id, previo, estado);
    actualizados.push(updated!);
    previo = estado as "preparando" | "en_camino";
  }
  return { f, order, actualizados };
}

describe("9460a3e -- aviso al cliente por WhatsApp en cada cambio de estado", () => {
  it("cada estado se avisa UNA sola vez aunque el cambio se reintente (clave de dedupe por pedido y estado)", async () => {
    const { f, actualizados } = await pedidoEnEstado(["preparando", "en_camino", "entregado"]);
    for (const o of actualizados) {
      await notifyCustomerOnOrderStatusChangeCore(f.repo, o);
      await notifyCustomerOnOrderStatusChangeCore(f.repo, o);
    }
    const filas = f.repo.getOutbox();
    expect(filas).toHaveLength(3);
    expect(new Set(filas.map((r) => r.eventType))).toEqual(new Set(["order.status.preparando", "order.status.en_camino", "order.status.entregado"]));
  });

  it("cada aviso lleva su plantilla HSM es_MX con nombre, sucursal y total, para poder salir fuera de la ventana de 24 h", async () => {
    const { f, actualizados } = await pedidoEnEstado(["preparando"]);
    await notifyCustomerOnOrderStatusChangeCore(f.repo, actualizados[0]!);
    const payload = f.repo.getOutbox()[0]!.payload as { template?: { name: string; language: string; params: string[] } };
    expect(payload.template).toMatchObject({ name: "pedido_confirmado", language: "es_MX" });
    expect(payload.template!.params).toHaveLength(3);
    expect(payload.template!.params[0]).toBe("Marcela");
  });

  // QA viaje-10 (P26): los avisos de estado hablan de usted (corregido en main; antes tuteaban).
  it("P26 / 9460a3e [lote F, viaje-10]: el texto del aviso al cliente trata de usted", async () => {
    const { f, actualizados } = await pedidoEnEstado(["preparando", "en_camino", "entregado"]);
    for (const o of actualizados) await notifyCustomerOnOrderStatusChangeCore(f.repo, o);
    for (const fila of f.repo.getOutbox()) expect((fila.payload as { body: string }).body, fila.eventType).not.toMatch(TUTEO);
  });
});

// ---- 34c2696: fallo parcial del despacho. En produccion el cron corre TODO `dispatchPending` dentro de UNA sesion
// (`withAppSession`): si algo lanza a mitad del lote, la transaccion hace ROLLBACK y los `markSent` de los mensajes que
// YA salieron hacia Meta se pierden; al vencer el lease se reenvian (duplicado visible al cliente). El original cerraba
// cada mensaje en su propia llamada. Modelo: puerto con las mismas semanticas de commit/rollback por sesion.
class PuertoTransaccional implements MessagingOutboxPort {
  readonly label = "restaurantes";
  readonly filas = new Map<string, { estado: "pending" | "processing" | "sent"; attempts: number }>();
  private preparado = new Map<string, "sent" | "retry">();
  falloEnMarkRetry = false;

  constructor(ids: readonly string[]) {
    for (const id of ids) this.filas.set(id, { estado: "pending", attempts: 0 });
  }
  async claimBatch(limit: number): Promise<readonly MessagingOutboxItem[]> {
    const elegibles = [...this.filas.entries()].filter(([, r]) => r.estado === "pending" || r.estado === "processing").slice(0, limit);
    for (const [, r] of elegibles) r.estado = "processing";
    return elegibles.map(([id, r]) => ({ id, attempts: r.attempts, payload: { to: "+529990001111", phone_number_id: "pn1", body: `mensaje ${id}` } }));
  }
  async markSent(id: string) { this.preparado.set(id, "sent"); }
  async markRetry() { if (this.falloEnMarkRetry) throw new Error("57014 statement timeout"); }
  async markDead() {}
  /** COMMIT de la sesion: aplica lo preparado. */
  commit() {
    for (const [id, estado] of this.preparado) if (estado === "sent") this.filas.get(id)!.estado = "sent";
    this.preparado.clear();
  }
  /** ROLLBACK: lo preparado se pierde; lo reclamado (lease vencido) vuelve a ser elegible. */
  rollback() { this.preparado.clear(); }
}

describe("34c2696 -- fallo parcial en el despacho de WhatsApp", () => {
  it.fails("X34 / 34c2696 [lote D, automatizacion-01]: si el lote falla a medias, los mensajes ya enviados NO se reenvian en la siguiente corrida", async () => {
    const puerto = new PuertoTransaccional(["m1", "m2", "m3"]);
    puerto.falloEnMarkRetry = true;
    const graph = new FakeWhatsAppGraphClient({ onSend: (_m, i) => (i === 1 ? new WhatsAppSendError("503 temporal", true) : undefined) });
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: graph });

    // Corrida 1 (una sola sesion): m1 sale, m2 falla y marcarlo reintento revienta -> ROLLBACK de toda la sesion.
    await dispatcher.dispatchPending(puerto, { limit: 3 }).then(() => puerto.commit(), () => puerto.rollback());
    const enviadosTrasLaCorrida1 = graph.sent.length;

    // Corrida 2: el sistema se recupero.
    puerto.falloEnMarkRetry = false;
    await dispatcher.dispatchPending(puerto, { limit: 3 }).then(() => puerto.commit(), () => puerto.rollback());

    const porDestinatario = graph.sent.filter((m) => m.body === "mensaje m1");
    expect(enviadosTrasLaCorrida1).toBeGreaterThan(0);
    expect(porDestinatario).toHaveLength(1);
  });
});
