// R12 #576, revision 7: «su dinero de vuelta/de regreso» (modismo del VUELTO) con una tarjeta/cuenta que es del COBRO, de la cuenta de la mesa o que va NEGADA no es promesa de reembolso; un destino
// afirmativo tras el objeto (aunque se mencione un cobro aparte) sigue reemplazado.
import { describe, expect, it } from "vitest";
import { prometeDevolucionDeDinero, quitarPromesaDeDinero, RESPUESTA_POLITICA_SIN_DEVOLUCIONES } from "../src/whatsapp/guards.ts";

const VUELTO_CON_COBRO_O_CUENTA = [
  "El repartidor le entrega su dinero de vuelta en la puerta y cobra a su tarjeta.",
  "Le damos su dinero de vuelta en la caja; el cargo a su tarjeta ya esta aplicado.",
  "Su dinero de vuelta son $50 y el cargo a su tarjeta ya quedo.",
  "Le damos su dinero de vuelta en la puerta, la diferencia se cobra a su tarjeta.",
  "Le damos su dinero de vuelta, el consumo se paso a su cuenta.",
  "Le damos su dinero de regreso en el mostrador y le cobramos a su tarjeta.",
  "Le entregamos su dinero de regreso en la puerta y le cobramos a su tarjeta.",
  "El repartidor le lleva su dinero de vuelta a su mano y el resto va a su tarjeta.",
  "Le damos su dinero de vuelta en mano, el pago ya se cargo a su tarjeta.",
  "Su dinero de vuelta se lo da el repartidor; el pedido se cobra a su tarjeta.",
  "Le damos su dinero de vuelta en caja y el cargo a su tarjeta se aplica al entregar.",
  "El mesero le trae su dinero de vuelta y pasa el cobro a su tarjeta.",
  "Su dinero de vuelta se lo damos en la mesa y lo demas se carga a su cuenta.",
  "Le damos su dinero de vuelta, ya paso el cargo a su tarjeta.",
  "Le damos su dinero de vuelta en la puerta; el voucher le llega a su tarjeta virtual.",
  "El cajero le da su dinero de vuelta y le carga el resto a su cuenta.",
  "Le damos su dinero de vuelta en el mostrador, el total fue a su cuenta de la mesa.",
  "Le damos su dinero de vuelta en la caja, a su cuenta quedaron $0.",
  "Le devolvemos a su mano su dinero de vuelta en la puerta; el pago se hizo a su tarjeta.",
  "Le regresamos su dinero de vuelta a su mano; el voucher va a su tarjeta.",
  "El repartidor le devuelve su dinero de vuelta en la puerta y cobra a su tarjeta.",
  "Le devolvemos su dinero de vuelta en la caja, el cargo a su tarjeta ya esta aplicado.",
  "Le regresamos su dinero de vuelta en el mostrador.",
  "Le damos su dinero de vuelta y el cargo a su tarjeta queda igual.",
  "El mesero le da su dinero de vuelta en la mesa y el total se pasa a su cuenta del restaurante.",
];

const VUELTO_CON_DESTINO_NEGADO = [
  "No le devolvemos a su tarjeta, le damos su dinero de vuelta en la puerta.",
  "Su dinero de vuelta no se regresa a su tarjeta, se lo damos a su mano.",
  "Le damos su dinero de vuelta a su mano, jamas a su tarjeta.",
  "Le damos su dinero de vuelta a su mano; nunca a su tarjeta.",
  "Le damos su dinero de vuelta a su mano, sin pasar a su tarjeta.",
  "Le damos su dinero de vuelta a su mano, no lo mandamos a su tarjeta.",
  "Le damos su dinero de vuelta a su mano, no por transferencia a su cuenta.",
  "Su dinero de vuelta es en efectivo, no se abona a su cuenta.",
  "Le damos su dinero de vuelta en la puerta; no hay cargo a su tarjeta.",
  "Le damos su dinero de vuelta en la caja, no se hace ningun cargo a su tarjeta.",
  "Ni a su tarjeta ni a su cuenta: le damos su dinero de vuelta en la puerta.",
  "Su dinero de vuelta no va a su tarjeta, se lo damos en la puerta.",
];

// Un destino afirmativo tras el objeto sigue siendo promesa aunque se hable de un cobro/cargo aparte.
const PROMESAS_CON_DESTINO_Y_COBRO_APARTE = [
  "Le devolvemos su dinero de vuelta a su tarjeta; el cargo original queda sin efecto.",
  "Su dinero de vuelta a su tarjeta en 3 dias, el cobro se revierte.",
  "Le damos su dinero de regreso a su cuenta bancaria y el cargo se cancela.",
  "Le devolvemos su dinero de vuelta a su tarjeta, no se preocupe por el cargo.",
  "Su dinero de regreso a su tarjeta; el voucher le llega por correo.",
  "Le damos su dinero de vuelta a su tarjeta y el total queda en cero.",
  "Le devolvemos su dinero de vuelta sin cargo a su tarjeta.",
  "Le devolvemos su dinero de vuelta, sin costo, a su tarjeta en 3 dias.",
  "Su dinero de vuelta a su cuenta, la diferencia del pago se la regresamos.",
  "El gerente le da su dinero de regreso a su tarjeta y cobra solo lo consumido.",
  "Su dinero de vuelta a su banco en 3 dias; el cargo desaparece.",
  "Su dinero de vuelta a su tarjeta, el pago se revierte.",
  "Le regresamos su dinero de vuelta a su tarjeta en 3 dias, sin cargo.",
];

describe("R12 revision 7: el vuelto con cobro, cuenta de la mesa o destino negado no se reemplaza", () => {
  it.each([...VUELTO_CON_COBRO_O_CUENTA, ...VUELTO_CON_DESTINO_NEGADO])("no se reemplaza: %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(false);
    expect(quitarPromesaDeDinero(f)).toBe(f);
  });
  it("hay al menos 25 negativas nuevas", () => {
    expect(VUELTO_CON_COBRO_O_CUENTA.length + VUELTO_CON_DESTINO_NEGADO.length).toBeGreaterThanOrEqual(25);
  });
});

describe("R12 revision 7: destino afirmativo con un cobro mencionado aparte sigue reemplazado", () => {
  it.each(PROMESAS_CON_DESTINO_Y_COBRO_APARTE)("reemplazada: %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(true);
    expect(quitarPromesaDeDinero(f)).toBe(RESPUESTA_POLITICA_SIN_DEVOLUCIONES);
  });
  it("hay al menos 10 promesas", () => {
    expect(PROMESAS_CON_DESTINO_Y_COBRO_APARTE.length).toBeGreaterThanOrEqual(10);
  });
  it("conserva el resto de la respuesta", () => {
    expect(quitarPromesaDeDinero("Lamentamos lo ocurrido. Su dinero de vuelta a su tarjeta en 3 dias, el cobro se revierte. Quedamos atentos.")).toBe(
      `Lamentamos lo ocurrido. ${RESPUESTA_POLITICA_SIN_DEVOLUCIONES} Quedamos atentos.`,
    );
  });
});
