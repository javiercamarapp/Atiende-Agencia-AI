// CR12: PM sin zonas de reparto cargadas no acepta "cualquier colonia" a domicilio: exige el pin (asigna por distancia) o una persona.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OrderValidationError } from "../src/errors.ts";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { PM_SIN_ZONAS_PEDIR_PIN_MENSAJE } from "../src/pin-reparto.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };
// fixture: Francisco de Montejo en (21.0186, -89.6708). Segunda sucursal cerca de Altabrisa.
const CERCA_DE_FCO = { lat: 21.0187, lng: -89.6709 };
const CERCA_DE_ALTABRISA = { lat: 21.0156, lng: -89.5982 };

async function mundo(opts: { pm: boolean }) {
  const f = buildRestaurantFixture();
  if (opts.pm) await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const altabrisaId = randomUUID();
  f.repo.seedBranch({ propertyId: altabrisaId, organizationId: f.organizationId, name: "Victory Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: 21.0156, lng: -89.5982 });
  return { ...f, altabrisaId };
}

const quote = (f: Awaited<ReturnType<typeof mundo>>, extra: Record<string, unknown> = {}) =>
  quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], canal: "domicilio", colonia: "Altabrisa", source: "whatsapp", ...extra } as never);

describe("PM sin zonas cargadas, domicilio por el agente", () => {
  it("colonia en texto sin pin: no cotiza ni crea; manda a pedir el pin o escalar zona_no_reconocida", async () => {
    const f = await mundo({ pm: true });
    const q = await quote(f).catch((e: unknown) => e);
    expect(q).toBeInstanceOf(OrderValidationError);
    expect((q as Error).message).toBe(PM_SIN_ZONAS_PEDIR_PIN_MENSAJE);
    expect((q as Error).message).toContain("zona_no_reconocida");
    const c = await createOrder(f.repo, {
      organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Marcela Pech", customerPhone: "9991234567", customerAddress: "Calle 7 #210",
      items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", canal: "domicilio", colonia: "Altabrisa", paymentMethod: "efectivo",
    }).catch((e: unknown) => e);
    expect(c).toBeInstanceOf(OrderValidationError);
    expect((c as Error).message).toBe(PM_SIN_ZONAS_PEDIR_PIN_MENSAJE);
  });

  it("la voz tampoco acepta domicilio sin zonas ni pin (no hay forma de pedirlo en llamada)", async () => {
    const f = await mundo({ pm: true });
    await expect(quote(f, { source: "voice" })).rejects.toThrow(/zona_no_reconocida/);
  });

  it("con pin: se asigna por distancia; el pin cerca de la sucursal del pedido pasa", async () => {
    const f = await mundo({ pm: true });
    const q = await quote(f, { ubicacion: CERCA_DE_FCO });
    expect(q.total).toBe(90);
  });

  it("con pin que queda mas cerca de OTRA sucursal: se rechaza y se nombra a la que le toca", async () => {
    const f = await mundo({ pm: true });
    const q = await quote(f, { ubicacion: CERCA_DE_ALTABRISA }).catch((e: unknown) => e);
    expect(q).toBeInstanceOf(OrderValidationError);
    expect((q as Error).message).toContain("Victory Altabrisa");
  });

  it("recoger no cambia", async () => {
    const f = await mundo({ pm: true });
    const q = await quote(f, { canal: "recoger", colonia: undefined });
    expect(q.total).toBe(90);
  });

  it("captura admin y checkout web (sin agente) no cambian", async () => {
    const f = await mundo({ pm: true });
    expect((await quote(f, { source: "admin" })).total).toBe(90);
    expect((await quote(f, { source: "web" })).total).toBe(90);
    expect((await quote(f, { source: undefined })).total).toBe(90);
  });

  it("organizacion generica (sin perfil taqueria_pm): sin cambio, la zona sigue siendo opt-in", async () => {
    const f = await mundo({ pm: false });
    expect((await quote(f)).total).toBe(90);
    const g = await mundo({ pm: false });
    await g.repo.upsertWhatsAppAgentConfig(g.organizationId, null, { ...PM, perfil: "generico" });
    expect((await quote(g)).total).toBe(90);
  });

  it("PM CON zonas cargadas: se aplica la cobertura de siempre (sin exigir pin)", async () => {
    const f = await mundo({ pm: true });
    const zoneId = randomUUID();
    f.repo.seedKnownZone({ id: zoneId, organizationId: f.organizationId, name: "Altabrisa", lat: 21.0156, lng: -89.5982 });
    f.repo.seedBranchDeliveryZones(f.propertyId, [zoneId]);
    expect((await quote(f)).total).toBe(90);
    await expect(quote(f, { colonia: "Zona inexistente xyz" })).rejects.toThrow(/No reconozco esa colonia/);
  });
});

describe("herramientas del agente: el pin sale del contexto del turno, nunca del modelo", () => {
  const items = (f: Awaited<ReturnType<typeof mundo>>) => [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];

  it("sin pin compartido: cotizar_pedido a domicilio de PM sin zonas devuelve el error con el motivo de escalacion", async () => {
    const f = await mundo({ pm: true });
    const out = await executeAgentToolSafely(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "9991234567" }, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Altabrisa", items: items(f) });
    expect(JSON.stringify(out)).toContain("zona_no_reconocida");
  });

  it("con el pin del turno (ctx.sharedLocation) cerca de la sucursal cotiza; el modelo no puede mandarlo por su cuenta", async () => {
    const f = await mundo({ pm: true });
    const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", sharedLocation: CERCA_DE_FCO };
    const ok = await executeAgentToolSafely(f.repo, ctx, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Altabrisa", items: items(f) });
    expect(JSON.stringify(ok)).toContain("90");
    expect(JSON.stringify(ok)).not.toContain("zona_no_reconocida");
    const sinCtx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" };
    const forzado = await executeAgentToolSafely(f.repo, sinCtx, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Altabrisa", items: items(f), ubicacion: CERCA_DE_FCO, lat: 21.0187, lng: -89.6709 });
    expect(JSON.stringify(forzado)).toContain("zona_no_reconocida");
  });
});
