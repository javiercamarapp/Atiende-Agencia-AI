// C3 PED-15 (cerebro v2, decision del dueño): cada sucursal de PM tiene su WhatsApp, pero si el cliente escribe al de la sucursal A y su domicilio lo cubre la B, el pedido
// SE TOMA y se asigna a B (con su tiempo de entrega), en vez de mandarlo a llamar al telefono de B. Recoger en otra sucursal tambien se toma para la que el cliente elija.
// Sin la bandera todo queda igual (aviso H17 de siempre, rechazo de recoger en otra, prompt identico).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PM_PAQUETE_B_REGLAS } from "../src/whatsapp/prompt-pm-paquete-b.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PM = { perfil: "taqueria_pm" as const, agentName: null, businessName: null, toneStyle: null, deliveryTimeText: "de 40 a 50 minutos", escalationReasonsOff: [] };

function mundoDosSucursales() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  const garcia = randomUUID();
  const montejo = randomUUID();
  repo.seedBranch({ propertyId: garcia, organizationId, name: "García Lavín (Victory Platz)", slug: "garcia-lavin", status: "active", phone: "999 518 2637", address: null, lat: 21.0211, lng: -89.6141 });
  repo.seedBranch({ propertyId: montejo, organizationId, name: "Prolongación Montejo", slug: "prol-montejo", status: "active", phone: "999 944 0342", address: null, lat: 21.0282, lng: -89.6098 });
  repo.seedBranchPolicy(garcia, { aceptaDomicilio: true });
  repo.seedBranchPolicy(montejo, { aceptaDomicilio: true });
  return { repo, organizationId, garcia, montejo };
}
const ctxWa = (organizationId: string, extra: Record<string, unknown> = {}) => ({ organizationId, channel: "whatsapp" as const, phone: "9991234567", ...extra });
type ResultadoSucursal = { estado: string; branch_slug: string; atiende_otra_sucursal?: { aviso: string; telefono?: string; tiempo_entrega?: string; tomar_pedido?: boolean } };

describe("PED-15 buscar_sucursal_cercana desde el chat de otra sucursal", () => {
  it("con cerebro v2: el aviso manda TOMAR el pedido con el branch_slug de la que entrega y decir su tiempo", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, PM);
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, m.montejo, { ...PM, deliveryTimeText: "de 30 a 40 minutos" });
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId, { entryPropertyId: m.garcia, cerebroV2: true }), "buscar_sucursal_cercana", { lat: 21.0283, lng: -89.6097 })).result as unknown as ResultadoSucursal;
    expect(r.branch_slug).toBe("prol-montejo");
    const aviso = r.atiende_otra_sucursal!.aviso;
    expect(aviso).toMatch(/tome el pedido con branch_slug prol-montejo/i);
    expect(aviso).toMatch(/de 30 a 40 minutos/);
    expect(aviso).not.toMatch(/NO tome el pedido/);
    expect(aviso).not.toMatch(/999 944 0342/);
    expect(r.atiende_otra_sucursal!.tiempo_entrega).toBe("de 30 a 40 minutos");
  });

  it("sin la bandera: el aviso de siempre (no tomar, telefono, ofrecer recoger)", async () => {
    const m = mundoDosSucursales();
    await m.repo.upsertWhatsAppAgentConfig(m.organizationId, null, PM);
    const r = (await invokeAgentTool(m.repo, ctxWa(m.organizationId, { entryPropertyId: m.garcia }), "buscar_sucursal_cercana", { lat: 21.0283, lng: -89.6097 })).result as unknown as ResultadoSucursal;
    expect(r.atiende_otra_sucursal!.aviso).toMatch(/NO tome el pedido a domicilio desde este chat/);
    expect(r.atiende_otra_sucursal!.aviso).toMatch(/999 944 0342/);
  });
});

async function mundoFixture() {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { ...PM, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const });
  const pensionesId = randomUUID();
  f.repo.seedBranch({ propertyId: pensionesId, organizationId: f.organizationId, name: "Victory Pensiones", slug: "pensiones", status: "active", phone: "999 555 0101", address: null, lat: 21.02, lng: -89.62 });
  f.repo.seedBranchPolicy(pensionesId, { aceptaDomicilio: true });
  f.repo.seedBranchProduct({ propertyId: pensionesId, productId: f.products.cocaCola, price: 45, isAvailable: true });
  const base = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", entryPropertyId: f.propertyId };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 5 }];
  return { f, pensionesId, base, items };
}

describe("PED-15 crear el pedido en la sucursal que entrega desde el chat de otra", () => {
  it("con cerebro v2: domicilio en B desde el chat de A se crea en B", async () => {
    const m = await mundoFixture();
    // Pin del cliente junto a Pensiones (la cobertura de la prueba es por distancia: el mundo no trae zonas cargadas).
    const r = await invokeAgentTool(m.f.repo, { ...m.base, cerebroV2: true, sharedLocation: { lat: 21.0201, lng: -89.6201 } }, "crear_pedido", {
      branch_slug: "pensiones", canal: "domicilio", items: m.items, customer_name: "Dulce Pech", customer_address: "Calle 12 #91 x 5 y 7, Chuburná", colonia_entrega: "Chuburná", payment_method: "tarjeta",
    });
    expect(r.propertyId).toBe(m.pensionesId);
  });

  it("con cerebro v2: recoger en otra sucursal se toma para la que el cliente eligió", async () => {
    const m = await mundoFixture();
    const q = await invokeAgentTool(m.f.repo, { ...m.base, cerebroV2: true }, "cotizar_pedido", { branch_slug: "pensiones", items: m.items, canal: "recoger" });
    expect(q.result).toHaveProperty("quote");
  });

  it("sin la bandera: recoger en otra sigue rechazado (H17)", async () => {
    const m = await mundoFixture();
    await expect(invokeAgentTool(m.f.repo, m.base, "cotizar_pedido", { branch_slug: "pensiones", items: m.items, canal: "recoger" })).rejects.toThrow(/H17/);
  });
});

describe("PED-15 prompt v2 sin la regla de no tomar el pedido de otra sucursal", () => {
  const ctx = {
    businessName: "Los Taquitos de PM",
    agentName: "Lupita",
    deliveryTimeText: "de 40 a 50 minutos",
    saludo: "buenas tardes",
    branches: [],
    entryBranch: { name: "Francisco de Montejo", slug: "fco-montejo" },
    customer: { isNew: true } as const,
  };
  it("el prompt v2 cambia H17, el paso 4 y B4 por la regla de tomar el pedido en la sucursal que entrega", () => {
    const base = buildPmSystemPrompt(ctx);
    expect(base).toMatch(/NO tome el pedido para esa sucursal/);
    const v2 = adaptarPromptPmV2(base);
    expect(v2).not.toMatch(/NO tome el pedido/);
    expect(v2).not.toMatch(/si es otra, H17\)/);
    expect(v2).toMatch(/H17\. Pedido de otra sucursal: TÓMELO/);
    const b = adaptarPromptPmV2(PM_PAQUETE_B_REGLAS);
    expect(b).not.toMatch(/no tome el domicilio ahí/);
    expect(b).toMatch(/B4\. OTRA SUCURSAL\. Si la zona del cliente le toca a otra sucursal, tome el pedido/);
  });
  it("sin bandera el prompt no cambia (nadie llama adaptarPromptPmV2) y la funcion es idempotente", () => {
    const base = buildPmSystemPrompt(ctx);
    expect(buildPmSystemPrompt(ctx)).toBe(base);
    const v2 = adaptarPromptPmV2(base);
    expect(adaptarPromptPmV2(v2)).toBe(v2);
  });
});
