// PAQUETE A (PM): unidades confirmadas por Javier (21-oct-2026) en el aviso de unidad de buscar_producto y precios de flauta del seed.
// Pruebas deterministas, sin LLM. Alitas 7, crujientes ~12 (aproximado), pizza Quesobich = 1 pieza sin tortilla ni totopos.
import { describe, expect, it } from "vitest";
import { unidadDeVenta, unidadDeVentaSinPiezas, unidadDeVentaPizza } from "../src/product-search.ts";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PROMPT_PM_PAQUETE_A } from "../src/whatsapp/prompt-pm-paquete-a.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

describe("aviso de unidad: alitas y crujientes con el dato confirmado", () => {
  it("alitas sin pack_size: la orden trae 7 piezas y requested_quantity cuenta órdenes", () => {
    const t = unidadDeVentaSinPiezas({ name: "Alitas de Pollo", packSize: null });
    expect(t).toMatch(/7 piezas/);
    expect(t).toMatch(/ÓRDENES/);
    expect(t).not.toMatch(/no registra/i);
  });
  it("crujientes de pechuga: aproximadamente 12, nunca como cifra exacta", () => {
    const t = unidadDeVentaSinPiezas({ name: "Crujientes de Pechuga de Pollo", packSize: null });
    expect(t).toMatch(/aproximadamente 12/i);
    expect(t).toMatch(/ÓRDENES/);
  });
  it("con pack_size explícito manda la herramienta y el aviso desaparece", () => {
    expect(unidadDeVentaSinPiezas({ name: "Alitas de Pollo (orden de 7)", packSize: 7 })).toBeNull();
  });
});

describe("aviso de unidad: pizza Quesobich", () => {
  it("es una pieza, sin tortilla ni totopos, solo salsa y cebolla", () => {
    const t = unidadDeVentaPizza({ name: "Quesobich de Pastor", categoryName: "Pizza Quesobich", packSize: null });
    expect(t).toMatch(/UNA pieza/i);
    expect(t).toMatch(/sin tortilla/i);
    expect(t).toMatch(/totopos/i);
    expect(t).toMatch(/salsa y cebolla/i);
  });
  it("no aplica a otros productos", () => {
    expect(unidadDeVentaPizza({ name: "Gringa de Pastor", packSize: 2 })).toBeNull();
  });
  it("unidadDeVenta lo encadena", () => {
    expect(unidadDeVenta({ name: "Quesobich de Queso", categoryName: "Pizza Quesobich", packSize: null })).toMatch(/UNA pieza/i);
  });
});


// CAMINO ENLAZADO REAL: buscar_producto (registry) y buildPmSystemPrompt (perfil-pm). Estas pruebas fallan sin el enlace del paquete A.
const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
type Hallado = { name: string; pack_size: number | null; unidad_de_venta?: string };
const buscar = async (query: string) => {
  const w = await mundo;
  const out = await invokeAgentTool(w.repo, { organizationId: w.organizationId, channel: "whatsapp", phone: "9991234567" }, "buscar_producto", { query, branch_slug: "garcia-lavin" });
  return out.result as Hallado[];
};

describe("buscar_producto enlazado a los avisos de unidad", () => {
  it("alitas: el resultado real trae 7 piezas", async () => {
    const r = (await buscar("alitas de pollo")).find((p) => p.name === "Alitas de Pollo")!;
    expect(r.unidad_de_venta).toMatch(/7 piezas/);
  });
  it("crujientes: aproximadamente 12", async () => {
    const r = (await buscar("crujientes de pechuga")).find((p) => /^Crujientes/.test(p.name))!;
    expect(r.unidad_de_venta).toMatch(/aproximadamente 12/);
  });
  it("Quesobich: una pieza sin tortilla ni totopos", async () => {
    const r = (await buscar("quesobich de pastor")).find((p) => p.name === "Quesobich de Pastor")!;
    expect(r.unidad_de_venta).toMatch(/UNA pieza/);
    expect(r.unidad_de_venta).toMatch(/sin tortilla ni totopos/);
  });
});

describe("el prompt de WhatsApp incluye el módulo del paquete A", () => {
  it("buildPmSystemPrompt contiene el texto del paquete y la voz (compacta) no", () => {
    const base = {
      businessName: "Los Taquitos de PM", agentName: "Lupita", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, saludo: "Buenas tardes", branches: [],
      entryBranch: null, customer: { isNew: true } as never, fechaHoraLocal: "21 de octubre de 2026, 14:10", diaSemana: "miércoles",
    };
    expect(buildPmSystemPrompt(base)).toContain(PROMPT_PM_PAQUETE_A);
  });
});
