// PM R12 (T7-031 Luna r1): el prompt no decía cuántas flautas trae una orden. El modelo preguntó «¿cuántas flautas serían?», el cliente dijo «4» y se cobraron
// 4 x $283 = $2,682 en lugar de $1,833 (+$849). Decisión de Javier (16-oct-2026): «una orden de flautas es UNA flauta grande» y el precio de menú es por orden.
// El seed y las herramientas ya lo cargan (pm-flautas-una-orden.spec.ts); esta prueba ata que el PROMPT también lo diga. Determinista, sin LLM.
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

describe("PM R12 T7-031: el prompt define que una orden de flautas es UNA flauta grande", () => {
  it("dice que una orden de flautas es una flauta grande y que el precio es por orden", () => {
    expect(prompt).toMatch(/orden de flautas es UNA flauta grande/i);
    expect(prompt).toMatch(/precio de menú es por orden/i);
  });

  it("dice que N flautas son N órdenes, que no se multiplica ni se inventan piezas", () => {
    expect(prompt).toMatch(/N flautas son N órdenes/);
    expect(prompt).toMatch(/nunca multiplique/i);
    expect(prompt).toMatch(/ni invente piezas/i);
  });

  it("no manda preguntar cuántas flautas trae la orden", () => {
    expect(prompt).toMatch(/no pregunte cuántas (flautas|piezas) trae/i);
  });
});

describe("PM R12 T7-031: cotización con el catálogo (el servidor ya cotiza bien; el defecto era del modelo)", () => {
  const pechuga: ProductoEncontrado = { id: "f1", name: "Flauta de Pechuga", price: 283, packSize: 1, requiresAdultConfirmation: false };
  it("1 orden de flautas cotiza el precio de menú x1 y 4 flautas son 4 órdenes", () => {
    expect(buildOrderQuoteFromProducts([{ productId: "f1", requestedQuantity: 1 }], [pechuga]).total).toBe(283);
    expect(buildOrderQuoteFromProducts([{ productId: "f1", requestedQuantity: 4 }], [pechuga]).total).toBe(1132);
  });
});
