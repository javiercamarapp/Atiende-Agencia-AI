// C3 PED-11 / PED-35 / PED-36 (cerebro v2, decision del dueño): cada sucursal tiene su número y las zonas de reparto son fijas. Si el domicilio lo cubre otra sucursal, el pedido se
// TOMA para la que cubre; si el cliente insiste en que lo atienda otra que no cubre su zona, se le explica con amabilidad y se le ofrece recoger en la que prefiera, SIN escalar
// (el banco espera 0 escalaciones). En la medición el agente escalaba zona_ambigua al insistir el cliente (PED-36), cliente_lo_pide cuando pedía «un supervisor» para lo mismo (PED-35)
// y dejaba un aviso «otro» para «confirmar la atención de su zona» con la sucursal ya asignada y cotizada (PED-11). Sin la bandera todo queda igual.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { PM_POLICY_RULES_V2, adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";

const PM = { perfil: "taqueria_pm" as const, agentName: null, businessName: null, toneStyle: null, deliveryTimeText: "de 40 a 50 minutos", escalationReasonsOff: [] };
const TEL = "9991234567";

async function mundo(conCotizacionDomicilio = true) {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  const pensiones = randomUUID();
  repo.seedBranch({ propertyId: pensiones, organizationId, name: "Victory Pensiones", slug: "pensiones", status: "active", phone: "999 555 0101", address: null, lat: 20.9952, lng: -89.6477 });
  await repo.upsertWhatsAppAgentConfig(organizationId, null, PM);
  // La cotización a domicilio vigente (sucursal que cubre el domicilio, ya cotizada) es la evidencia de que la zona está asignada.
  if (conCotizacionDomicilio) {
    await repo.writeOrderFlow(organizationId, `wa:${TEL}`, 0, { state: "cotizado", context: { quoteHash: "h", quotedAtMs: Date.now(), quotedTurn: "t1", quotedTotal: 411, quotedBranchSlug: "fco-montejo", quotedCanal: "domicilio" } }, 3600);
  }
  const ctx = (cerebroV2: boolean) => ({ organizationId, channel: "whatsapp" as const, phone: TEL, entryPropertyId: pensiones, flow: { key: `wa:${TEL}`, turn: "t2" }, ...(cerebroV2 ? { cerebroV2: true } : {}) });
  return { repo, organizationId, ctx };
}

const ESCALA_PED36 = { customer_name: "Leticia Naal", motivo: "zona_ambigua", resumen: "Insiste en que la atienda Pensiones aunque la zona fue asignada a Francisco de Montejo." };
const ESCALA_PED35 = { customer_name: "Ramiro Che", motivo: "cliente_lo_pide", resumen: "Solicita que un supervisor o encargado revise si García Lavín puede entregar a domicilio en Itzimná, aunque la zona está fuera de cobertura habitual." };
const ESCALA_PED11 = { customer_name: "Ximena Ku", motivo: "otro", resumen: "Desea un pedido a domicilio en Cholul. La zona fue indicada como atendida por Victory Altabrisa, pero necesito confirmar con la sucursal que entrega y el tiempo estimado para esta zona antes de cerrar." };

describe("PED-35/36/11 escalar_a_humano por la zona con cerebro v2", () => {
  it("zona_ambigua (cliente insiste en otra sucursal) se rechaza: zonas fijas, ofrecer domicilio desde la que cubre o recoger; sin aviso", async () => {
    const m = await mundo(false);
    await expect(invokeAgentTool(m.repo, m.ctx(true), "escalar_a_humano", ESCALA_PED36)).rejects.toThrow(/zonas de reparto son fijas.*recoger/s);
    expect(m.repo.listCallbackRequests(m.organizationId)).toHaveLength(0);
  });

  it("cliente_lo_pide «que un supervisor revise la sucursal» con la zona ya cotizada se rechaza igual", async () => {
    const m = await mundo();
    await expect(invokeAgentTool(m.repo, m.ctx(true), "escalar_a_humano", ESCALA_PED35)).rejects.toThrow(/zonas de reparto son fijas/);
    expect(m.repo.listCallbackRequests(m.organizationId)).toHaveLength(0);
  });

  it("PED-11: un aviso «otro» para confirmar la zona ya asignada y cotizada se rechaza", async () => {
    const m = await mundo();
    await expect(invokeAgentTool(m.repo, m.ctx(true), "escalar_a_humano", ESCALA_PED11)).rejects.toThrow(/ya tiene la sucursal que lo entrega/);
    expect(m.repo.listCallbackRequests(m.organizationId)).toHaveLength(0);
  });

  it("pedir una persona por OTRO motivo (queja) sigue escalando", async () => {
    const m = await mundo();
    const r = await invokeAgentTool(m.repo, m.ctx(true), "escalar_a_humano", { customer_name: "Ramiro Che", motivo: "cliente_lo_pide", resumen: "Quiere hablar con una persona por una queja del pedido anterior en su zona." });
    expect(r.result).toMatchObject({ ok: true });
    expect(m.repo.listCallbackRequests(m.organizationId)).toHaveLength(1);
  });

  it("sin cotización a domicilio, «otro»/cliente_lo_pide por la zona no se bloquea (puede no haber sucursal que cubra)", async () => {
    const m = await mundo(false);
    const r = await invokeAgentTool(m.repo, m.ctx(true), "escalar_a_humano", ESCALA_PED35);
    expect(r.result).toMatchObject({ ok: true });
  });

  it("sin la bandera: zona_ambigua, cliente_lo_pide y otro escalan como siempre", async () => {
    const m = await mundo();
    for (const e of [ESCALA_PED36, ESCALA_PED35, ESCALA_PED11]) expect((await invokeAgentTool(m.repo, m.ctx(false), "escalar_a_humano", e)).result).toMatchObject({ ok: true });
    expect(m.repo.listCallbackRequests(m.organizationId).length).toBeGreaterThan(0);
  });
});

describe("PED-35/36 referencia NO confirmada de otra sucursal", () => {
  it("con cerebro v2 el aviso ya no manda escalar zona_ambigua", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
    const garcia = randomUUID();
    const montejo = randomUUID();
    repo.seedBranch({ propertyId: garcia, organizationId, name: "García Lavín (Victory Platz)", slug: "garcia-lavin", status: "active", phone: "999 518 2637", address: null, lat: 21.0211, lng: -89.6141 });
    repo.seedBranch({ propertyId: montejo, organizationId, name: "Prolongación Montejo", slug: "prol-montejo", status: "active", phone: "999 944 0342", address: null, lat: 21.0282, lng: -89.6098 });
    repo.seedBranchPolicy(garcia, { aceptaDomicilio: true });
    repo.seedBranchPolicy(montejo, { aceptaDomicilio: true });
    await repo.upsertWhatsAppAgentConfig(organizationId, null, PM);
    // Colonia reconocida sin reparto confirmado cuya referencia es otra sucursal (estado «sugerida»), como en pm-r8-guardas-l3.
    const zona = randomUUID();
    const otra = randomUUID();
    repo.seedKnownZone({ id: zona, organizationId, name: "Zona Nueva", lat: 21.0283, lng: -89.6097 });
    repo.seedKnownZone({ id: otra, organizationId, name: "Otra Zona", lat: 21.5, lng: -89.6 });
    repo.seedBranchDeliveryZones(garcia, [otra]);
    repo.seedBranchDeliveryZones(montejo, [otra]);
    const buscar = async (cerebroV2: boolean) =>
      ((await invokeAgentTool(repo, { organizationId, channel: "whatsapp", phone: TEL, entryPropertyId: garcia, ...(cerebroV2 ? { cerebroV2: true } : {}) }, "buscar_sucursal_cercana", { colonia: "Zona Nueva" })).result as { estado: string; referencia_otra_sucursal?: { aviso: string } });
    const v2 = await buscar(true);
    expect(v2.estado).toBe("sugerida");
    expect(v2.referencia_otra_sucursal!.aviso).toMatch(/NO confirmada/);
    expect(v2.referencia_otra_sucursal!.aviso).not.toMatch(/zona_ambigua/);
    expect(v2.referencia_otra_sucursal!.aviso).toMatch(/no escale/i);
    // Sin la bandera, el aviso de siempre.
    expect((await buscar(false)).referencia_otra_sucursal!.aviso).toMatch(/escale UNA vez \(zona_ambigua\)/);
  });
});

describe("PED-35/36 prompt v2", () => {
  const ctx = { businessName: "Los Taquitos de PM", agentName: "Lupita", deliveryTimeText: "de 40 a 50 minutos", saludo: "buenas tardes", branches: [], entryBranch: { name: "Pensiones", slug: "pensiones" }, customer: { isNew: true } as const };
  it("el prompt v2 ya no ofrece zona_ambigua como motivo de escalación y la política dice no escalar por la zona", () => {
    const base = buildPmSystemPrompt(ctx);
    expect(base).toMatch(/zona_ambigua \(el cliente insiste en otra sucursal para domicilio\)/);
    const v2 = adaptarPromptPmV2(base);
    expect(v2).not.toMatch(/zona_ambigua/);
    expect(adaptarPromptPmV2(v2)).toBe(v2);
    expect(PM_POLICY_RULES_V2).toMatch(/zonas de reparto son fijas/);
    expect(PM_POLICY_RULES_V2).toMatch(/no escale/i);
  });
});
