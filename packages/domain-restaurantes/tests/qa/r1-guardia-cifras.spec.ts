// QA R1 -- guardia de cifras del agente de WhatsApp (enforceQuotedTotal): regresion de agentes-05 (el "Subtotal" no es el total),
// viaje-04 (precio alucinado sin la palabra "total") y agentes-06 (la cotizacion vigente sobrevive entre turnos). Mas las pruebas
// base del repo original (whatsapp-agent-core.test.ts: total alucinado, en pesos, correcto intacto, precios unitarios, sin total).
import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceQuotedTotal, knownAmountsOfQuote } from "../../src/whatsapp/guards.ts";
import { LUNES_14, banco, base, call, item, lastTool, say } from "./r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("enforceQuotedTotal (pura): pruebas base del original", () => {
  it("corrige un total alucinado", () => {
    expect(enforceQuotedTotal("Su total es $100.00, ¿confirma?", 179)).toBe("Su total es $179.00, ¿confirma?");
  });
  it("corrige un total escrito 'en pesos'", () => {
    expect(enforceQuotedTotal("El total son 100 pesos", 179)).toBe("El total son $179.00");
  });
  it("deja intacto un total correcto", () => {
    const texto = "Su total es $179.00, ¿confirma?";
    expect(enforceQuotedTotal(texto, 179)).toBe(texto);
  });
  it("nunca toca un precio unitario sin la palabra total", () => {
    const texto = "El taco cuesta $42.00 cada uno y la Coca $25.00";
    expect(enforceQuotedTotal(texto, 179, [42, 25, 179])).toBe(texto);
  });
  it("sin total conocido no hace nada", () => {
    const texto = "Su total es $100.00";
    expect(enforceQuotedTotal(texto, null)).toBe(texto);
  });
});

describe("agentes-05: 'Subtotal' no es 'total'", () => {
  it("con la promo 2x1 'Subtotal $144 / Descuento $72 / Total $72' queda intacto", () => {
    const texto = "Subtotal: $144.00\nDescuento 2x1: $72.00\nTotal: $72.00";
    expect(enforceQuotedTotal(texto, 72)).toBe(texto);
  });
  it("sigue corrigiendo el Total aunque haya un Subtotal correcto antes", () => {
    expect(enforceQuotedTotal("Subtotal: $144.00. Total: $99.00", 72)).toBe("Subtotal: $144.00. Total: $72.00");
  });
  it("punta a punta (lunes, T3 recoger, 4 pastor): el cliente lee el Subtotal real y el Total", async () => {
    const b = await banco({ now: LUNES_14 });
    const pastor = b.pid("Taco Al Pastor (individual)");
    b.setGuion([
      call("cotizar_pedido", { branch_slug: "pensiones", canal: "recoger", items: [item(pastor, "Taco Al Pastor (individual)", 4, "maiz")] }),
      (req) => {
        const q = lastTool(req) as { quote: { subtotal: number; descuento: number; total: number } };
        return { text: `Subtotal: $${q.quote.subtotal.toFixed(2)}. Descuento 2x1: $${q.quote.descuento.toFixed(2)}. Total: $${q.quote.total.toFixed(2)}. ¿Confirma?`, ...base };
      },
    ]);
    const turn = await b.handler.handleInboundMessage({ organizationId: b.w.organizationId, phone: "+5219990000008", messages: [{ role: "user", content: "4 de pastor pa recoger" }], customer: { isNew: true }, propertyId: b.t3 });
    expect(turn.reply).toContain("Subtotal: $168.00");
    expect(turn.reply).toContain("Total: $84.00");
  });
});

describe("viaje-04: precio alucinado sin la palabra 'total'", () => {
  const amounts = [450, 106, 556, 53];
  it("'le queda en $300 pesos todo' se corrige al total de la cotizacion", () => {
    expect(enforceQuotedTotal("Perfecto, le queda en $300 pesos todo. ¿Se lo confirmo?", 556, amounts)).toBe("Perfecto, le queda en $556.00 pesos todo. ¿Se lo confirmo?");
  });
  it("'$300 en total' se corrige", () => {
    expect(enforceQuotedTotal("Serían $300 en total, ¿confirma?", 556, amounts)).toBe("Serían $556.00 en total, ¿confirma?");
  });
  it("una cifra legitima de la cotizacion (precio de renglon) NO se toca", () => {
    const texto = "Le queda en $556.00 en total; el medio kilo de pastor va en $450.00.";
    expect(enforceQuotedTotal(texto, 556, amounts)).toBe(texto);
    expect(enforceQuotedTotal("El pastor queda en $450.00 el medio kilo", 556, amounts)).toBe("El pastor queda en $450.00 el medio kilo");
  });
  it("sin cifras conocidas (solo el total) la guardia por redaccion no actua: nunca adivina precios de renglon", () => {
    expect(enforceQuotedTotal("El pastor queda en $450.00 el medio kilo", 556)).toBe("El pastor queda en $450.00 el medio kilo");
  });
  it("knownAmountsOfQuote reune precio, importe de renglon, subtotal, descuento y total", () => {
    expect(knownAmountsOfQuote({ total: 72, subtotal: 144, descuento: 72, lines: [{ price: 36, line_total: 144 }] }).sort((a, b) => a - b)).toEqual([36, 72, 144]);
  });
  it("punta a punta: cotizacion real de $179 y el modelo dice 'le queda en $300': el cliente lee $179.00", async () => {
    const b = await banco();
    const pastor = b.pid("Taco Al Pastor (individual)");
    const coca = b.pid("Coca-Cola");
    b.setGuion([
      call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items: [item(pastor, "Taco Al Pastor (individual)", 3, "maiz"), item(coca, "Coca-Cola", 1)] }),
      say("Perfecto, le queda en $300 pesos todo. ¿Se lo confirmo?"),
    ]);
    const r = await b.enviar("+5219990000022", "3 pastor maiz y una coca pa recoger");
    expect(r.reply).not.toMatch(/\$300/);
    expect(r.reply).toContain("$179.00");
  });
});

describe("agentes-06: la cotizacion vigente sobrevive entre turnos", () => {
  it("cotiza $179; en el turno siguiente, sin herramientas, 'su total queda en $150' se corrige a $179", async () => {
    const b = await banco();
    const pastor = b.pid("Taco Al Pastor (individual)");
    const coca = b.pid("Coca-Cola");
    b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items: [item(pastor, "Taco Al Pastor (individual)", 3, "maiz"), item(coca, "Coca-Cola", 1)] }), say("Total: $179.00. ¿Confirma?")]);
    const tel = "+5219990000009";
    await b.enviar(tel, "3 pastor maiz y una coca pa recoger");
    b.setGuion([say("Claro, su total queda en $150.00. ¿Efectivo o tarjeta?")]);
    const r = await b.enviar(tel, "cuanto era?");
    expect(r.reply).toContain("$179.00");
    expect(r.reply).not.toContain("$150.00");
  });

  it("sin cotizacion previa en la conversacion la guardia no inventa nada", async () => {
    const b = await banco();
    b.setGuion([say("El taco de pastor cuesta $42.00. ¿Cuántos le anoto?")]);
    const r = await b.enviar("+5219990000023", "cuanto cuesta el taco de pastor?");
    expect(r.reply).toContain("$42.00");
  });

  it("base sin migrar (sin maquina de estados): el turno sigue funcionando, solo sin la guardia entre turnos", async () => {
    const b = await banco();
    (b.w.repo as unknown as { orderFlowUnavailable: boolean }).orderFlowUnavailable = true;
    b.setGuion([say("Su total queda en $150.00. ¿Confirma?")]);
    const r = await b.enviar("+5219990000024", "hola");
    expect(r.reply).toContain("$150.00");
  });
});
