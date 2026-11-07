// C3 S-NEW-016/017 y POL-03/04 (cerebro v2, decisión del dueño: conducta del suelto). Kanasín, Umán, Progreso y Chicxulub Puerto no son colonias de Mérida (no están en
// known_zone): el monorrepo contestaba `no_reconocida`, el agente pedía otra referencia y a la segunda escalaba `zona_no_reconocida`. El suelto los reconoce por nombre con su
// coordenada (merida_colonias / COLONIAS_APROX del banco: Kanasín 20.934,-89.558; Umán 20.885,-89.748) y, a más de 8 km de toda sucursal que reparte, contesta
// «fuera de zona» (fuera_de_zona: true) para ofrecer recoger. Con la bandera: mismo resultado `fuera_de_zona` de siempre (reparto fuera_de_zona_habitual). Sin ella: igual que antes.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";

const PM = { perfil: "taqueria_pm" as const, agentName: null, businessName: null, toneStyle: null, deliveryTimeText: "de 40 a 50 minutos", escalationReasonsOff: [] };
const TEL = "9991234567";

/** Distancia en km (haversine), la misma geometría del suelto (sucursal_mas_cercana). */
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (g: number) => (g * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const SUCURSALES = [
  { slug: "pensiones", name: "Victory Pensiones", lat: 20.9952, lng: -89.6477 },
  { slug: "garcia-lavin", name: "T7 García Lavín", lat: 21.0302, lng: -89.6201 },
];

async function mundo() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  let entrada = "";
  for (const s of SUCURSALES) {
    const propertyId = randomUUID();
    if (!entrada) entrada = propertyId;
    repo.seedBranch({ propertyId, organizationId, name: s.name, slug: s.slug, status: "active", phone: "999 555 0101", address: null, lat: s.lat, lng: s.lng });
  }
  await repo.upsertWhatsAppAgentConfig(organizationId, null, PM);
  const ctx = (cerebroV2: boolean) => ({ organizationId, channel: "whatsapp" as const, phone: TEL, entryPropertyId: entrada, ...(cerebroV2 ? { cerebroV2: true } : {}) });
  return { repo, ctx };
}

describe("cerebro v2: municipios conocidos fuera de cobertura (Kanasín, Umán…) = fuera de zona, no colonia no reconocida", () => {
  for (const [colonia, punto] of [["Kanasín", { lat: 20.934, lng: -89.558 }], ["Uman", { lat: 20.885, lng: -89.748 }]] as const) {
    it(`${colonia}: fuera_de_zona con la sucursal más cercana (paridad: > 8 km de toda sucursal, como el suelto)`, async () => {
      const m = await mundo();
      const r = (await invokeAgentTool(m.repo, m.ctx(true), "buscar_sucursal_cercana", { colonia })).result as Record<string, unknown>;
      // Suelto: fuera_de_zona = la sucursal más cercana está a más de 8 km.
      expect(Math.min(...SUCURSALES.map((s) => km(punto, s)))).toBeGreaterThan(8);
      expect(r.estado).toBe("fuera_de_zona");
      expect(r.reparto).toBe("fuera_de_zona_habitual");
      expect(r.encontrada).toBe(false);
    });
  }

  it("sin cerebro v2 sigue como antes (no_reconocida)", async () => {
    const m = await mundo();
    const r = (await invokeAgentTool(m.repo, m.ctx(false), "buscar_sucursal_cercana", { colonia: "Kanasín" })).result as Record<string, unknown>;
    expect(r.estado).toBe("no_reconocida");
  });

  it("una colonia de verdad desconocida sigue siendo no_reconocida con la bandera", async () => {
    const m = await mundo();
    const r = (await invokeAgentTool(m.repo, m.ctx(true), "buscar_sucursal_cercana", { colonia: "Colonia Inventada Xyz" })).result as Record<string, unknown>;
    expect(r.estado).toBe("no_reconocida");
  });
});
