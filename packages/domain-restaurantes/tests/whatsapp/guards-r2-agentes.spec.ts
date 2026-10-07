// Regresion R2-agentes: parseo de importes en todos los formatos, preguntas vs pedidos de cancelacion y negacion con coma.
import { describe, expect, it } from "vitest";
import { classifyHighRiskIntent, enforceQuotedTotal, esConsultaDeCancelacion, parseMoneyToken } from "../../src/whatsapp/guards.ts";
import { negacionDeCancelacion } from "../../src/whatsapp/autopiloto-turno.ts";

describe("parseMoneyToken", () => {
  it.each([
    ["$179", 179],
    ["$179.00", 179],
    ["$1,500.00", 1500],
    ["$1.500,00", 1500],
    ["$1 500", 1500],
    ["$1.500", 1500],
    ["150 MXN", 150],
    ["150 pesos", 150],
    ["$150,5", 150.5],
    ["$1,234,567.89", 1234567.89],
  ])("%s -> %d", (token, esperado) => {
    expect(parseMoneyToken(token)).toBeCloseTo(esperado);
  });
});

describe("enforceQuotedTotal con formatos de miles", () => {
  it("un total correcto escrito con espacio o coma de miles no se toca", () => {
    expect(enforceQuotedTotal("Su total: $1 500", 1500, [1500])).toBe("Su total: $1 500");
    expect(enforceQuotedTotal("Su total: $1,500.00", 1500, [1500])).toBe("Su total: $1,500.00");
  });
  it("un total europeo equivocado se corrige completo, sin restos del numero original", () => {
    expect(enforceQuotedTotal("Total: $1.500,00 en total", 179, [179])).toBe("Total: $179.00 en total");
  });
  it("un total sin cifras legitimas conocidas se sigue corrigiendo aunque diga 'sin envio'", () => {
    expect(enforceQuotedTotal("Total sin envío: $150.00", 179)).toContain("$179.00");
  });
});

describe("cancelacion: preguntas vs pedidos", () => {
  it.each(["¿Mi pedido se canceló?", "¿Si cancelo el pedido me cobran algo?", "¿Hasta qué hora se puede cancelar un pedido?", "¿Puedo cancelar mi pedido?", "me cobran por cancelar el pedido?"])(
    "pregunta: %s",
    (t) => {
      expect(esConsultaDeCancelacion(t)).toBe(true);
      expect(classifyHighRiskIntent(t)).toBeNull();
    },
  );
  it.each(["Quiero cancelar mi pedido", "Cancelen mi pedido por favor", "Ya no lo quiero, cancelen el pedido", "cancela el pedido"])("pedido: %s", (t) => {
    expect(esConsultaDeCancelacion(t)).toBe(false);
    expect(classifyHighRiskIntent(t, { pedidoReciente: { estado: "pendiente" } as never })?.intent).toBe("cancelacion_modificacion");
  });
  it("sin pedido reciente conocido no hay nada que cancelar", () => {
    expect(classifyHighRiskIntent("quiero cancelar mi pedido", { pedidoReciente: null })).toBeNull();
  });
  it("negacion: 'no, cancelen el pedido' y 'ya no lo quiero, cancelen' NO son negaciones; 'no cancelen' si", () => {
    expect(negacionDeCancelacion("No, cancelen el pedido")).toBe(false);
    expect(negacionDeCancelacion("Ya no lo quiero, cancelen el pedido")).toBe(false);
    expect(negacionDeCancelacion("Ya no lo quiero cancelen el pedido")).toBe(false);
    expect(negacionDeCancelacion("No cancelen mi pedido")).toBe(true);
    expect(negacionDeCancelacion("ya llegó, no hace falta cancelar")).toBe(true);
  });
  it.each([
    "Si no llega a las 3:30, cancelo el pedido",
    "Si no está aquí a las 9:15, cancelo el pedido",
    "Como no llegue en 10 minutos, cancelo el pedido",
    "De no llegar en 10 min, cancelo el pedido",
    "De no llegar a las 3:30, cancelo el pedido",
    "Si no llega en 10 min; cancelo el pedido",
    "Si no llega en 10 min, cancelo el pedido",
    "Si en 10 minutos no llega, cancelen mi pedido",
    "Ya no lo quiero cancelar",
  ])("negacion (amenaza condicional): %s", (t) => {
    expect(negacionDeCancelacion(t)).toBe(true);
  });
  it.each(["Quiero cancelar mi pedido", "Cancela por favor, ya no lo quiero", "Si no es molestia, cancela mi pedido", "Cancelen mi pedido, es para las 3:30", "Como ya no lo quiero, cancelen el pedido"])(
    "no es negacion: %s",
    (t) => {
      expect(negacionDeCancelacion(t)).toBe(false);
    },
  );
});
