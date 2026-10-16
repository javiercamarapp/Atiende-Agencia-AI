// R12 #576, revision 6: la negacion del destino («no a su tarjeta», «sin tarjeta») no puede confundirse con «sin costo / sin cargo / no se preocupe ... a su tarjeta», que son promesas reales.
import { describe, expect, it } from "vitest";
import { prometeDescuento, prometeDevolucionDeDinero, quitarPromesaDeDinero, RESPUESTA_POLITICA_SIN_DEVOLUCIONES } from "../src/whatsapp/guards.ts";

const PROMESAS_CON_DESTINO = [
  "Le devolveremos su dinero sin costo a su tarjeta.",
  "Le devolvemos su dinero sin cargo a su tarjeta.",
  "Le devolvemos su dinero no tarda a su tarjeta.",
  "Le regresamos el importe de su pedido sin costo a su tarjeta.",
  "Le devolvemos su dinero ya mismo y sin pena a su cuenta.",
  "Su dinero de vuelta, son $120, a su tarjeta en 3 días.",
  "Le damos su dinero de vuelta a su tarjeta, el repartidor no interviene.",
  "Le damos su dinero de vuelta, lo autoriza el gerente en caja, en 3 días.",
  "Le devolvemos su dinero sin tarjeta de por medio, a su cuenta de banco.",
  "Le devolvemos su dinero sin demora a su tarjeta.",
  "Le devolvemos su dinero sin problema a su tarjeta.",
  "Le devolvemos su dinero, no se preocupe a su tarjeta.",
  "Le devolvemos su dinero no se preocupe a su tarjeta.",
  "Le regresamos lo pagado sin costo a su cuenta.",
  "Se le devolverá su dinero sin costo a su tarjeta.",
  "Su dinero será devuelto sin costo a su tarjeta.",
  "Le devolvemos el total que pagó sin descuento a su tarjeta.",
  "Su dinero de vuelta a su tarjeta, el cajero lo autoriza.",
  "Su dinero de vuelta a su tarjeta; la caja ya lo registró.",
  "Le reintegramos su dinero sin costo a su tarjeta.",
  "Le regresamos su dinero sin pena a su tarjeta, no hay problema.",
  "Le devolvemos su dinero sin descuento alguno a su tarjeta.",
  "Le devolvemos lo que pagó sin costo a su tarjeta.",
  "Con gusto le devolvemos su dinero, sin cargo, a su tarjeta.",
  "Le devolveremos el importe de su pedido a su tarjeta sin ningún costo.",
];

const VUELTO_Y_PROPINA_CON_NEGACION = [
  "Su dinero de vuelta son $120, a su mano, no a su tarjeta.",
  "Le damos su dinero de vuelta a su mano, sin tarjeta.",
  "Su dinero de vuelta se lo da el repartidor, no es a su cuenta.",
  "Le devolvemos $50 de su billete en la puerta, no a su tarjeta.",
  "Le damos su dinero de vuelta en efectivo, no a su cuenta.",
  "Su dinero de regreso en efectivo, no a su cuenta.",
  "Su dinero de vuelta son $80 en la caja, sin tarjeta.",
  "Le regresamos $100 de su billete, no a su tarjeta.",
  "La propina se cobra en la terminal, no a su cuenta.",
  "Su cambio va a su mano, no a su tarjeta.",
  "Le devolvemos la feria en monedas, sin tarjeta de por medio.",
  "Le damos su dinero de vuelta en la mesa, son $70, no por tarjeta.",
  "Su dinero de regreso son $45, no en tarjeta, lo lleva el repartidor.",
  "Le devolvemos $30 en efectivo, ni a su tarjeta ni a su cuenta.",
  "Su dinero de vuelta es el cambio, no es a su cuenta ni reembolso.",
  "Le regresamos $60 de cambio al mesero, no a su tarjeta.",
  "La propina va en la terminal; el cambio, a su mano, no a su tarjeta.",
  "Su dinero de vuelta son $25 de su billete de $100, sin tarjeta.",
];

describe("R12 revision 6: promesas con «sin costo / sin cargo / no se preocupe ... a su tarjeta» siguen reemplazadas", () => {
  it.each(PROMESAS_CON_DESTINO)("reemplazada: %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(true);
    expect(quitarPromesaDeDinero(f)).toBe(RESPUESTA_POLITICA_SIN_DEVOLUCIONES);
  });
  it("conserva el resto de la respuesta", () => {
    expect(quitarPromesaDeDinero("Lamentamos lo ocurrido. Le devolvemos su dinero sin costo a su tarjeta. Quedamos atentos.")).toBe(
      `Lamentamos lo ocurrido. ${RESPUESTA_POLITICA_SIN_DEVOLUCIONES} Quedamos atentos.`,
    );
  });
});

describe("R12 revision 6: vuelto en efectivo / propina / terminal con negacion real del destino NO se reemplaza", () => {
  it.each(VUELTO_Y_PROPINA_CON_NEGACION)("intacta: %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(false);
    expect(prometeDescuento(f)).toBe(false);
    expect(quitarPromesaDeDinero(f)).toBe(f);
  });
});
