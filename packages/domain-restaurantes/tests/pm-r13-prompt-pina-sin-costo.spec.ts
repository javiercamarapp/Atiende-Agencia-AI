// PM R13 Q5 (T7-012 Luna r2): el bot dijo «piña picada sin costo» y luego cotizó y creó «Extra Piña» ($19): total $407 en vez de $388. La lista de salsas del
// prompt mezclaba «piña picada (gratis si la piden; la doble es el extra piña)» y el modelo agregó el producto. Decisión de Javier (R13, «hazlo según tu
// recomendación»): todas las salsas, incluida la piña, son SIEMPRE sin costo; lo ÚNICO cobrado es la doble porción de piña (Extra Piña, $19) y solo si el cliente
// dice explícitamente doble o extra. El servidor ya cobra bien (el precio sale del catálogo); esta prueba ata que el PROMPT lo diga. Determinista, sin LLM.
import { describe, expect, it } from "vitest";
import { buildComplementNotes, buildOrderQuoteFromProducts, PM_BASIC_COMPLEMENTS } from "../src/order-quote.ts";
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

describe("PM R13 Q5: la piña es siempre sin costo; solo la doble porción (Extra Piña) se cobra", () => {
  it("dice que todas las salsas, incluida la piña, son SIEMPRE sin costo", () => {
    expect(prompt).toContain("Todas las salsas, incluida la piña, son SIEMPRE sin costo");
  });

  it("dice que lo ÚNICO cobrado es la doble porción de piña (Extra Piña, $19) y solo si dicen explícitamente doble o extra", () => {
    expect(prompt).toMatch(/la ÚNICA cobrada es la doble porción de piña \(Extra Piña, \$19\)/);
    expect(prompt).toMatch(/dice explícitamente doble o extra/);
  });

  it("prohíbe cobrar la piña pedida como complemento y cuando dicen «sin costo»", () => {
    expect(prompt).toMatch(/[Nn]unca cobre la piña pedida como complemento ni cuando el cliente diga «sin costo»/);
  });
});

describe("PM R13 Q5: el servidor no contradice la regla (el precio sale del catálogo)", () => {
  const tacos: ProductoEncontrado = { id: "t1", name: "Tacos de Pastor", price: 194, packSize: 3, requiresAdultConfirmation: false, requiresTortilla: true };
  const extraPina: ProductoEncontrado = { id: "ep", name: "Extra Piña", price: 19, packSize: 1, requiresAdultConfirmation: false };

  it("la piña pedida como complemento va a la comanda «sin costo» y no agrega renglón ni importe", () => {
    const notas = buildComplementNotes(undefined, ["pina"], [], PM_BASIC_COMPLEMENTS);
    expect(notas).toContain("Pedidas (sin costo): piña picada.");
    const sinPina = buildOrderQuoteFromProducts([{ productId: "t1", requestedQuantity: 3, tortilla: "maiz" }], [tacos, extraPina]);
    expect(sinPina.total).toBe(194);
    expect(sinPina.lines).toHaveLength(1);
  });

  it("la doble porción es el producto Extra Piña a $19 del catálogo", () => {
    const q = buildOrderQuoteFromProducts(
      [{ productId: "t1", requestedQuantity: 3, tortilla: "maiz" }, { productId: "ep", requestedQuantity: 1 }],
      [tacos, extraPina],
    );
    expect(q.total).toBe(213);
    expect(q.lines.map((l) => l.name)).toContain("Extra Piña");
  });
});
