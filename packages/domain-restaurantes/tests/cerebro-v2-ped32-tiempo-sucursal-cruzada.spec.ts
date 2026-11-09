// C3 PED-32 (cerebro v2, Luna): el cliente escribe al WhatsApp de García Lavín y su domicilio lo entrega Francisco de Montejo. El agente dijo «40 a 50 minutos» (el
// tiempo de la que entrega, del aviso de buscar_sucursal_cercana) y en el resumen «75 a 90 minutos» (los TIEMPOS DE ESTA SUCURSAL del prompt: los de García Lavín en hora
// pico). El cliente reclamó la diferencia y acabó escalado. Con la bandera: cotizar_pedido de otra sucursal trae su tiempo_entrega y el prompt v2 dice que el tiempo que
// se le da al cliente (también en el resumen) es SIEMPRE el de la sucursal que entrega. Sin la bandera todo queda igual.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "a domicilio de 60 a 75 min (pico: 75 a 90)", escalationReasonsOff: [] };

async function mundo() {
  // La fixture trae Francisco de Montejo (la que entrega); el chat es el de García Lavín.
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, f.propertyId, { ...PM, deliveryTimeText: "de 40 a 50 minutos" });
  const garciaId = randomUUID();
  f.repo.seedBranch({ propertyId: garciaId, organizationId: f.organizationId, name: "García Lavín (Victory Platz)", slug: "garcia-lavin", status: "active", phone: "999 518 2637", address: null, lat: 21.0211, lng: -89.6141 });
  f.repo.seedBranchPolicy(garciaId, { aceptaDomicilio: true });
  f.repo.seedBranchProduct({ propertyId: garciaId, productId: f.products.cocaCola, price: 45, isAvailable: true });
  const base = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", entryPropertyId: garciaId };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 5 }];
  return { f, garciaId, base, items };
}
type ResultadoCotizacion = { quote: unknown; tiempo_entrega?: string; aviso_tiempo?: string };

describe("PED-32 cotizar_pedido de otra sucursal trae el tiempo de la que entrega", () => {
  it("con cerebro v2: tiempo_entrega es el de la sucursal cotizada y el aviso dice que no use el de este chat", async () => {
    const m = await mundo();
    const r = (await invokeAgentTool(m.f.repo, { ...m.base, cerebroV2: true }, "cotizar_pedido", { branch_slug: "fco-montejo", items: m.items, canal: "recoger" })).result as unknown as ResultadoCotizacion;
    expect(r.tiempo_entrega).toBe("de 40 a 50 minutos");
    expect(r.aviso_tiempo).toMatch(/Francisco de Montejo/);
    expect(r.aviso_tiempo).toMatch(/de 40 a 50 minutos/);
    expect(r.aviso_tiempo).toMatch(/resumen/);
  });

  it("con cerebro v2 y la sucursal del chat: sin tiempo_entrega (rige el del prompt)", async () => {
    const m = await mundo();
    const slugDelChat = "garcia-lavin";
    const r = (await invokeAgentTool(m.f.repo, { ...m.base, cerebroV2: true }, "cotizar_pedido", { branch_slug: slugDelChat, items: m.items, canal: "recoger" })).result as unknown as ResultadoCotizacion;
    expect(r).not.toHaveProperty("tiempo_entrega");
    expect(r).not.toHaveProperty("aviso_tiempo");
  });

  it("sin la bandera: la cotización de la sucursal del chat no cambia", async () => {
    const m = await mundo();
    const slugDelChat = "garcia-lavin";
    const r = (await invokeAgentTool(m.f.repo, m.base, "cotizar_pedido", { branch_slug: slugDelChat, items: m.items, canal: "recoger" })).result as unknown as ResultadoCotizacion;
    expect(r).not.toHaveProperty("tiempo_entrega");
    expect(r).not.toHaveProperty("aviso_tiempo");
  });
});

describe("PED-32 prompt v2: el tiempo del resumen es el de la sucursal que entrega", () => {
  const ctx = {
    businessName: "Los Taquitos de PM",
    agentName: "Lupita",
    deliveryTimeText: "a domicilio de 60 a 75 min (pico: 75 a 90)",
    saludo: "buenas noches",
    branches: [],
    entryBranch: { name: "García Lavín (Victory Platz)", slug: "garcia-lavin" },
    customer: { isNew: true } as const,
  };
  it("el bloque de tiempos dice que son de la sucursal de este chat y que con otra sucursal manda su tiempo_entrega", () => {
    const base = buildPmSystemPrompt(ctx);
    const v2 = adaptarPromptPmV2(base);
    expect(base).not.toMatch(/tiempo_entrega/);
    expect(v2).toMatch(/TIEMPOS DE ESTA SUCURSAL \(la de este chat[^)]*\)/);
    expect(v2).toMatch(/OTRA sucursal[^.]*resumen[^.]*tiempo_entrega/);
    expect(v2).toMatch(/Tiempo a domicilio de la sucursal de este chat \(con otra sucursal, el tiempo_entrega de esa\): a domicilio de 60 a 75 min/);
    expect(adaptarPromptPmV2(v2)).toBe(v2);
  });
});
