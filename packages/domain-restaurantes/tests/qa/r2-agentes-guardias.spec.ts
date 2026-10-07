// QA adversarial R2 (lente AGENTES, restaurantes) -- guardias DETERMINISTAS del agente de WhatsApp (guards.ts) con espanol de Mexico real.
// Re-verifica los cierres de R1 (agentes-01 clasificador, agentes-05 guardia de total, agentes-14 "quiero una persona") con variantes nuevas.
// Convencion: `it.fails` = comportamiento ESPERADO que hoy falla (defecto QA-restaurantes-R2-agentes-NN); `it` = correcto confirmado.
import { describe, expect, it } from "vitest";
import { classifyHighRiskIntent, enforceQuotedTotal, pideUnaPersona } from "../../src/whatsapp/guards.ts";

describe("R2 guardia de total (enforceQuotedTotal): no puede inventar cifras", () => {
  // Cotizacion PM real: 3 tacos de pastor a $42 ($126) + 1 Coca-Cola 2 L $53 = $179.
  const COTIZ = [42, 126, 53, 179];

  // QA-restaurantes-R2-agentes-03 (P1, variante reabierta de R1-05): la guardia reescribe CUALQUIER cifra junto a la palabra "total" con el total
  // a pagar, aunque sea un importe legitimo de la cotizacion (total de un renglon, total antes del descuento, total sin envio).
  it("R2-03a el 'total' de un renglon ($126 de 3 tacos) NO se cambia por el total del pedido", () => {
    const out = enforceQuotedTotal("3 Tacos al pastor (total: $126.00)\n1 Coca-Cola $53.00\nTotal a pagar: $179.00", 179, COTIZ);
    expect(out).toContain("(total: $126.00)");
  });

  it("R2-03b 2x1 del lunes: 'Total antes del descuento: $144.00' no se convierte en $72.00", () => {
    const out = enforceQuotedTotal("Total antes del descuento: $144.00. Descuento 2x1: $72.00. Total a pagar: $72.00", 72, [36, 144, 72]);
    expect(out).toContain("Total antes del descuento: $144.00");
  });

  it("R2-03c domicilio: 'Total sin envío: $150.00, con envío: $179.00' conserva el $150.00 legitimo", () => {
    const out = enforceQuotedTotal("Total sin envío: $150.00, con envío: $179.00", 179, [150, 29, 179]);
    expect(out).toContain("$150.00");
  });

  // QA-restaurantes-R2-agentes-04 (P2): formatos de cifra que la guardia no entiende; en dos de ellos la propia guardia FABRICA una cifra nueva.
  it("R2-04a '$1 500' (espacio de miles) no termina como '$179.00 500'", () => {
    expect(enforceQuotedTotal("Su total: $1 500", 179, [179])).not.toContain("$179.00 500");
  });

  it("R2-04b '$1.500,00' (formato europeo) no termina como '$179.000,00'", () => {
    expect(enforceQuotedTotal("Total: $1.500,00", 179, [179])).not.toContain("179.000");
  });

  it("R2-04c 'Su total es de 150 MXN' (sin $ ni 'pesos') se corrige al total real", () => {
    expect(enforceQuotedTotal("Su total es de 150 MXN", 179, [179])).toContain("179");
  });

  it("control: 'Subtotal' ya no se reescribe (cierre de R1-05) y un total alucinado si se corrige", () => {
    expect(enforceQuotedTotal("Subtotal: $144.00. Descuento 2x1: $72.00. Total: $72.00", 72, [36, 144, 72])).toContain("Subtotal: $144.00");
    expect(enforceQuotedTotal("Su total queda en $150.00", 179, COTIZ)).toContain("$179.00");
    expect(enforceQuotedTotal("Son $150 pesos en total", 179, COTIZ)).toContain("$179.00");
  });
});

describe("R2 clasificador de alto riesgo (antes del LLM)", () => {
  // QA-restaurantes-R2-agentes-05 (P2, R1-01 reabierto en parte): sin ningun pedido creado, frases de un pedido NUEVO escalan a una persona y el agente
  // calla (handoff). `pedidoReciente: null` = el servidor ya sabe que este telefono no tiene pedido en las ultimas 12 h.
  it("R2-05a 'Urgente! mi pedido: 5 tacos de pastor para recoger' (sin pedido previo) NO escala: es un pedido nuevo", () => {
    expect(classifyHighRiskIntent("Urgente! mi pedido: 5 tacos de pastor para recoger", { pedidoReciente: null })).toBeNull();
  });

  it("R2-05b 'quiero hacer mi pedido urgente' (sin pedido previo) NO escala", () => {
    expect(classifyHighRiskIntent("quiero hacer mi pedido urgente", { pedidoReciente: null })).toBeNull();
  });

  it("R2-05c 'olvídelo, cancele el pedido' SIN pedido creado no escala una cancelacion (no hay nada que cancelar; es abandonar el carrito)", () => {
    expect(classifyHighRiskIntent("olvídelo, cancele el pedido", { pedidoReciente: null })).toBeNull();
  });

  // QA-restaurantes-R2-agentes-06 (P2): quejas reales muy comunes NO se detectan antes del LLM (quedan al criterio del modelo; con el autopiloto
  // tampoco se crea la solicitud de compensacion ligada al pedido).
  it("R2-06 'me faltaron dos tacos', 'no me llegó la coca', 'vino frío todo' son quejas", () => {
    const entregado = { pedidoReciente: { estado: "entregado" } } as never;
    for (const t of ["me faltaron dos tacos de mi pedido", "no me llegó la coca", "vino frío todo"]) {
      expect(classifyHighRiskIntent(t, entregado)?.intent, t).toBe("queja");
    }
  });

  it("control (cierre de R1-01): ajustes del carrito y 'me falto pedir' no escalan; 'me faltó la bebida de mi pedido' si", () => {
    expect(classifyHighRiskIntent("ah me falto pedirle dos cocas")).toBeNull();
    expect(classifyHighRiskIntent("ah me faltó pedirle dos cocas")).toBeNull();
    expect(classifyHighRiskIntent("no, cancela la orden de bistec y mejor ponme 6 de pastor", { pedidoReciente: null })).toBeNull();
    expect(classifyHighRiskIntent("me faltó la bebida de mi pedido")?.intent).toBe("queja");
    expect(classifyHighRiskIntent("me cobraron dos veces")?.intent).toBe("cobro_duplicado");
    expect(classifyHighRiskIntent("quiero que borren mis datos")?.intent).toBe("privacidad_arco");
  });
});

describe("R2 'quiero una persona' (WhatsApp y voz comparten PIDE_UNA_PERSONA_RE)", () => {
  // QA-restaurantes-R2-agentes-07 (P2, R1-14 reabierto en parte): formas habituales de pedir una persona no se reconocen; en voz solo esta regex
  // (y el DTMF 0) escalan sin depender del modelo.
  it("R2-07 '¿me puede atender una persona?', 'un humano por favor', 'con su supervisor', 'con el dueño', 'con un operador'", () => {
    for (const t of ["¿me puede atender una persona?", "un humano por favor", "comuníqueme con su supervisor", "quiero hablar con el dueño", "páseme con un operador"]) {
      expect(pideUnaPersona(t), t).toBe(true);
    }
  });

  it("control: las formas ya cubiertas siguen detectandose y un pedido normal no", () => {
    for (const t of ["quiero hablar con una persona", "páseme con el gerente", "quiero un humano", "me pasa con alguien"]) expect(pideUnaPersona(t), t).toBe(true);
    for (const t of ["quiero seis tacos de bistec", "a nombre de Juan Pérez", "Un paquete para una persona por favor", "quiero nachos para una persona, por favor"]) expect(pideUnaPersona(t), t).toBe(false);
    for (const t of ["un humano por favor", "una persona, por favor"]) expect(pideUnaPersona(t), t).toBe(true);
  });
});
