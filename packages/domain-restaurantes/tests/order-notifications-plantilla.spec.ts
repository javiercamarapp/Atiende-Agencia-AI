// R-27 -- el aviso de estado del pedido al cliente declara la plantilla HSM del estado (ademas del texto libre de
// respaldo) y su payload lo acepta el dispatcher REAL del gateway; con un cliente de Graph API de prueba el envio
// sale como `type: "template"` solo si la plantilla se declaro aprobada. Sin red ni credenciales.
import { describe, expect, it, vi } from "vitest";
import { MetaGraphWhatsAppClient, WhatsAppOutboundDispatcher, type MessagingOutboxItem, type MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import { createOrder } from "../src/orders.ts";
import { notifyCustomerOnOrderStatusChangeCore, PLANTILLAS_ESTADO_PEDIDO, plantillaParaEstado } from "../src/order-notifications.ts";
import type { OrderStatus } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

async function pedido(overrides: { customerName?: string; branchSlug?: string } = {}) {
  const fx = buildRestaurantFixture();
  fx.repo.seedWhatsAppChannel(fx.organizationId, "PHONE_NUMBER_ID_123");
  const order = await createOrder(fx.repo, {
    organizationId: fx.organizationId,
    branchSlug: overrides.branchSlug ?? "fco-montejo",
    customerName: overrides.customerName ?? "Ana",
    customerPhone: "9990001111",
    customerAddress: "Calle 80 #30",
    items: [{ productId: fx.products.cocaCola, requestedQuantity: 1 }],
    source: "web",
  });
  return { fx, order };
}

describe("plantillaParaEstado", () => {
  it("cada estado notificado tiene su plantilla es_MX; los demas no", async () => {
    const { order } = await pedido();
    for (const status of ["preparando", "en_camino", "listo_para_recoger", "entregado", "cancelado"] as const satisfies readonly OrderStatus[]) {
      const p = plantillaParaEstado({ ...order, status });
      expect(p?.name).toBe(PLANTILLAS_ESTADO_PEDIDO[status]?.name);
      expect(p?.language).toBe("es_MX");
      expect(p?.params).toHaveLength(3);
    }
    for (const status of ["pending", "completado", "problema", "programado"] as const satisfies readonly OrderStatus[]) {
      expect(plantillaParaEstado({ ...order, status })).toBeUndefined();
    }
  });

  it("variables: nombre, sucursal y total; sin saltos de linea ni vacias (nombre/sucursal vacios usan respaldo)", async () => {
    const { order } = await pedido();
    const p = plantillaParaEstado({ ...order, status: "en_camino", customerName: "  Ana \n  Maria\t", branch: null, total: 250 });
    expect(p?.params).toEqual(["Ana Maria", "la sucursal", "$250.00 MXN"]);
    expect(plantillaParaEstado({ ...order, status: "en_camino", customerName: "   " })?.params[0]).toBe("cliente");
    expect(plantillaParaEstado({ ...order, status: "en_camino", customerName: "x".repeat(3000) })?.params[0]).toHaveLength(1024);
  });
});

describe("notifyCustomerOnOrderStatusChangeCore: payload con plantilla", () => {
  it("encola body (respaldo) + template del estado, y no cambia to/phone_number_id", async () => {
    const { fx, order } = await pedido();
    const enCamino = { ...order, status: "en_camino" as const };
    expect(await notifyCustomerOnOrderStatusChangeCore(fx.repo, enCamino)).toEqual({ enqueued: true });
    const payload = fx.repo.getOutbox()[0]?.payload as { to: string; phone_number_id: string; body: string; template: { name: string; language: string; params: string[] } };
    expect(payload.to).toBe("+529990001111");
    expect(payload.phone_number_id).toBe("PHONE_NUMBER_ID_123");
    expect(payload.body).toMatch(/va en camino/);
    expect(payload.template).toMatchObject({ name: "pedido_en_camino", language: "es_MX" });
    expect(payload.template.params[0]).toBe("Ana");
  });

  it("idempotencia intacta: reintentar el mismo pedido+estado no duplica el aviso", async () => {
    const { fx, order } = await pedido();
    const enCamino = { ...order, status: "en_camino" as const };
    await notifyCustomerOnOrderStatusChangeCore(fx.repo, enCamino);
    await notifyCustomerOnOrderStatusChangeCore(fx.repo, enCamino);
    expect(fx.repo.getOutbox()).toHaveLength(1);
  });

  it("de punta a punta contra el dispatcher real: sin plantilla aprobada sale texto libre; con ella, type=template", async () => {
    for (const aprobadas of [[], ["pedido_en_camino"]]) {
      const { fx, order } = await pedido();
      await notifyCustomerOnOrderStatusChangeCore(fx.repo, { ...order, status: "en_camino" });
      const fila = fx.repo.getOutbox()[0]!;
      const puerto: MessagingOutboxPort = {
        label: "restaurantes-test",
        claimBatch: async (): Promise<readonly MessagingOutboxItem[]> => [{ id: fila.id, attempts: 0, payload: fila.payload }],
        markSent: vi.fn(async () => undefined),
        markRetry: vi.fn(async () => undefined),
        markDead: vi.fn(async () => undefined),
      };
      const enviados: Record<string, unknown>[] = [];
      const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
        enviados.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
      });
      const graphClient = new MetaGraphWhatsAppClient({ accessToken: "test-fake-token-never-real", fetchImpl: fetchImpl as unknown as typeof fetch, approvedTemplates: aprobadas });
      const resumen = await new WhatsAppOutboundDispatcher({ graphClient }).dispatchPending(puerto);
      expect(resumen.sent).toBe(1);
      expect(puerto.markDead).not.toHaveBeenCalled();
      expect(enviados[0]?.type).toBe(aprobadas.length > 0 ? "template" : "text");
    }
  });
});
