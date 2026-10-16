// Autopiloto -- confirmacion inmediata "Recibimos su pedido #folio, tiempo estimado X" para VOZ (nunca WhatsApp):
//   * solo con la plantilla `pedido_recibido` aprobada (WHATSAPP_APPROVED_TEMPLATES); sin ella NO se envia (estado honesto);
//   * una vez por pedido (dedupe) aunque el checkout se reintente;
//   * el aviso lleva el tiempo del dueno (o el aprendido) y jamas rompe la creacion del pedido.
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { createOrder } from "@atiende/domain-restaurantes";
import type { Order } from "@atiende/domain-restaurantes";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { avisarPedidoRecibido } from "../src/routes/verticals/restaurantes/autopiloto-recibido.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

/** Sesion sin consultas: el aviso solo usa el repositorio de restaurantes y, sin repositorio de autopiloto, el texto fijo del dueno. */
class SesionNula implements TenantDbSession {
  async query<T>(): Promise<{ rows: T[] }> {
    return { rows: [] };
  }
  async exec(): Promise<void> {}
}

async function construir(plantillas: readonly string[]) {
  const t = await buildTestDeps();
  const deps: AppDeps = { ...t.deps, env: { ...t.deps.env, whatsappApprovedTemplates: plantillas } };
  await t.restaurantesRepo.upsertWhatsAppAgentConfig(t.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: "Domicilio 30-45 minutos. Recoger 15-25 minutos." } as never);
  // CR12: con perfil PM, el domicilio por voz exige zonas de reparto cargadas (o pin); la sucursal del fixture recibe una zona para ese caso.
  const zona = await t.restaurantesRepo.createKnownZone(t.organizationId, { name: "Centro", lat: 20.97, lng: -89.62 });
  await t.restaurantesRepo.replaceBranchDeliveryZones(t.organizationId, t.propertyId, [zona.id]);
  const app = buildApp(deps);
  const recibidos = () => t.restaurantesRepo.getOutbox().filter((o) => o.eventType === "order.recibido");
  return { ...t, deps, app, recibidos };
}

const VOZ = (productId: string, telefono = "9991234567", extra: Record<string, unknown> = {}) => ({
  branch_slug: "fco-montejo", customer_name: "Cliente Voz", customer_phone: telefono, items: [{ product_id: productId, requested_quantity: 2 }], source: "voice", canal: "recoger", payment_method: "efectivo", ...extra,
});

describe("POST /v1/restaurantes/:orgSlug/orders -> Recibimos su pedido", () => {
  it("voz (secreto de herramienta) con plantilla aprobada: sale UN aviso con el tiempo del dueno, a E.164, con su plantilla", async () => {
    const t = await construir(["pedido_recibido"]);
    const res = await t.app.request("/v1/restaurantes/los-taquitos-de-pm/orders", jsonRequestInit(VOZ(t.products.cocaCola!), { "x-atiende-tool-secret": "test-voice-tool-secret" }));
    expect(res.status).toBe(200);
    const filas = t.recibidos();
    expect(filas).toHaveLength(1);
    const p = filas[0]!.payload as { body: string; to: string; template: { name: string; params: string[] } };
    expect(p.to).toBe("+529991234567");
    expect(p.body).toMatch(/recibimos su pedido/i);
    expect(p.body).toContain("Tiempo estimado:");
    expect(p.body).toContain("15-25"); // recoger: el texto fijo del dueno (menos de 20 muestras)
    expect(p.template.name).toBe("pedido_recibido");
    expect(p.template.params).toHaveLength(3);
  });

  it("SIN la plantilla aprobada no se envia nada: el pedido se crea igual", async () => {
    const t = await construir([]);
    const res = await t.app.request("/v1/restaurantes/los-taquitos-de-pm/orders", jsonRequestInit(VOZ(t.products.cocaCola!), { "x-atiende-tool-secret": "test-voice-tool-secret" }));
    expect(res.status).toBe(200);
    expect(t.recibidos()).toHaveLength(0);
  });

  it("voz con plantilla aprobada: sale UN aviso (y el reintento del mismo pedido no duplica)", async () => {
    const t = await construir(["pedido_recibido"]);
    const cuerpo = { ...VOZ(t.products.cocaCola!), source: "voice", customer_address: "Calle 1 #200", colonia_entrega: "Centro", canal: "domicilio" };
    const init = jsonRequestInit(cuerpo, { "x-atiende-tool-secret": "test-voice-tool-secret" });
    expect((await t.app.request("/v1/restaurantes/los-taquitos-de-pm/orders", init)).status).toBe(200);
    expect(t.recibidos()).toHaveLength(1);
    expect((t.recibidos()[0]!.payload as { body: string }).body).toContain("30-45");
    // Reintento con el mismo contenido: el pedido es el mismo (dedupe) y el aviso tambien.
    await t.app.request("/v1/restaurantes/los-taquitos-de-pm/orders", init);
    expect(t.recibidos()).toHaveLength(1);
  });

  it("un pedido de WhatsApp NUNCA recibe este aviso (el chat ya confirma), aunque la plantilla este aprobada", async () => {
    const t = await construir(["pedido_recibido"]);
    const order = await createOrder(t.restaurantesRepo, { organizationId: t.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: "9991234567", customerAddress: "Calle 1", colonia: "Centro", items: [{ productId: t.products.cocaCola!, requestedQuantity: 1 }], source: "whatsapp", paymentMethod: "efectivo" });
    const r = await avisarPedidoRecibido(t.deps, new SesionNula(), t.restaurantesRepo, order);
    expect(r).toEqual({ enviado: false, motivo: "canal_no_aplica" });
    expect(t.recibidos()).toHaveLength(0);
  });

  it("sin canal de WhatsApp de la organizacion declara el estado honesto en vez de fingir el envio", async () => {
    const t = await construir(["pedido_recibido"]);
    vi.spyOn(t.restaurantesRepo, "resolveActiveWhatsAppPhoneNumberId").mockResolvedValue(null);
    const order = { id: "o1", organizationId: t.organizationId, propertyId: t.propertyId, customerName: "Ana", customerPhone: "9991234567", branch: "X", total: 10, status: "pending", source: "voice" } as unknown as Order;
    const r = await avisarPedidoRecibido(t.deps, new SesionNula(), t.restaurantesRepo, order);
    expect(r).toEqual({ enviado: false, motivo: "sin_canal_whatsapp" });
    expect(t.recibidos()).toHaveLength(0);
  });
});
