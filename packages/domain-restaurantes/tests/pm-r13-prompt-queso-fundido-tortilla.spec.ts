// PM R13 Q3 (T7-008): el juez exige que el bot pregunte la tortilla del queso fundido (maíz o harina) antes de cotizar, como en las demás órdenes con tortilla,
// y en las 8 corridas de R13 nadie la preguntó. Decisión de Javier (R13, «hazlo según tu recomendación»): SÍ se pregunta. ASUNCIÓN a confirmar con PM: que el queso
// fundido se sirva con tortilla de maíz o harina a elección del cliente (el menú del seed no trae descripción de ese platillo). Esta prueba ata que el PROMPT lo diga.
// Determinista, sin LLM.
import { describe, expect, it } from "vitest";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary, ProductoEncontrado } from "../src/types.ts";

const SUCURSALES: BranchSummary[] = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const prompt = buildPmSystemPrompt({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: SUCURSALES,
  entryBranch: null,
  customer: { isNew: true },
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
});

describe("PM R13 Q3: el queso fundido sí pregunta la tortilla (maíz o harina) antes de cotizar", () => {
  it("manda preguntar la tortilla del queso fundido, igual que en los tacos", () => {
    expect(prompt).toMatch(/Queso fundido: pregunte la tortilla ANTES de cotizar/);
  });

  it("dice dónde anotarla: la herramienta no trae campo de tortilla en ese renglón, va en notes", () => {
    expect(prompt).toMatch(/queso fundido[^.]*notes/i);
  });

  it("sigue sin negar el queso fundido como producto inexistente (#589)", () => {
    expect(prompt).not.toMatch(/"queso fundido"/);
  });
});

describe("PM R13 Q3: el servidor no exige ni conserva la tortilla del queso fundido (por eso la regla vive en el prompt)", () => {
  const quesoFundido: ProductoEncontrado = { id: "qf", name: "Queso Fundido Rajas", price: 175, packSize: 1, requiresAdultConfirmation: false };

  it("cotiza el queso fundido sin tortilla (no se rechaza) y descarta la tortilla si el modelo la manda", () => {
    const sin = buildOrderQuoteFromProducts([{ productId: "qf", requestedQuantity: 1 }], [quesoFundido]);
    expect(sin.total).toBe(175);
    const con = buildOrderQuoteFromProducts([{ productId: "qf", requestedQuantity: 1, tortilla: "harina" }], [quesoFundido]);
    expect(con.lines[0]?.tortilla).toBeNull();
  });
});
