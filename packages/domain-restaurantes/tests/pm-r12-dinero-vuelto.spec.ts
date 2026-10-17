// R12 #576, revision 5: «su dinero de vuelta/de regreso» es el modismo mexicano del VUELTO (cambio en efectivo), no una promesa de reembolso. Precision primero.
import { describe, expect, it } from "vitest";
import { prometeDescuento, prometeDevolucionDeDinero, quitarPromesaDeDinero } from "../src/whatsapp/guards.ts";

const VUELTO_LEGITIMO = [
  // las 5 del revisor
  "Le damos su dinero de vuelta: $120 de su billete.",
  "Su dinero de vuelta son $120, de su billete de $500.",
  "Le damos su dinero de vuelta en la puerta, son $85.",
  "Su dinero de regreso, o sea el cambio, se lo lleva el repartidor.",
  "Le devolvemos $15 a su mano, no a su tarjeta.",
  // variantes mexicanas del vuelto
  "Su vuelto son $80, se lo lleva el repartidor.",
  "Le damos su vuelto en la puerta.",
  "Le damos de vuelta $50 de su billete de $200.",
  "Su dinero de regreso son $35, el repartidor lleva feria.",
  "Le regresamos de su billete $150 al entregar.",
  "Su cambio de $65 se lo lleva el repartidor.",
  "Su cambio de $120 se lo entrega el mesero en la mesa.",
  "Le regresamos su cambio en efectivo al recibir el pedido.",
  "Su dinero de vuelta, $45, se lo da el repartidor al llegar.",
  "Su dinero de regreso en monedas, son $18.",
  "Le damos su dinero de vuelta en billetes chicos.",
  "Su dinero de vuelta lo recibe en mano, son $90.",
  "Su dinero de regreso en efectivo son $70.",
  "Le damos su dinero de vuelta en el mostrador, son $40.",
  "Su dinero de vuelta se lo damos en caja, son $110.",
  "De su billete de $500 le regresamos $230 de cambio.",
  "Le regresamos $20 de feria cuando llegue el repartidor.",
  "Su dinero de regreso son $55 de su billete de $200.",
  "Le damos de vuelta su cambio, $75, en la puerta.",
  "Su dinero de vuelta, o sea la feria, la lleva el repartidor.",
  "Le devolvemos $30 a su mano, sin tarjeta de por medio.",
  "Le devolvemos $25 en efectivo, no a su tarjeta.",
  "Le devolvemos $40 a su mano, no a su cuenta.",
  "Su dinero de vuelta es el cambio de su billete; lo lleva el repartidor.",
  "Le damos su vuelto de $60 al entregar el pedido.",
  "Su dinero de regreso de $100 se lo damos en la puerta, no es reembolso.",
  "Su cambio, o sea su dinero de vuelta, son $95 de su billete de $300.",
  "Le damos su dinero de vuelta en la caja, de su pago de $400 son $60.",
];

const PROMESAS_CLARAS = [
  "Le devolvemos su dinero a su tarjeta.",
  "Le reembolsamos su dinero.",
  "Su dinero de regreso a su tarjeta en 3 días.",
  "Se le hará el reembolso.",
  "We will refund you.",
  "You get your money back.",
  "Le damos la devolución de su dinero en 3 días.",
  "Su dinero de vuelta a su tarjeta en 5 días hábiles.",
  "Le damos su dinero de regreso en 3 días.",
];

describe("R12 revision 5: vuelto en efectivo no se reemplaza", () => {
  it.each(VUELTO_LEGITIMO)("intacta: %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(false);
    expect(prometeDescuento(f)).toBe(false);
    expect(quitarPromesaDeDinero(f)).toBe(f);
  });
  it.each(PROMESAS_CLARAS)("sigue reemplazada: %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(true);
    expect(quitarPromesaDeDinero(f)).not.toBe(f);
  });
});
