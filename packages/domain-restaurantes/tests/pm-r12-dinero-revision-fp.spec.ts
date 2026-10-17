// R12 #576, revision 4 (falsos positivos reportados por el revisor): la guardia de dinero NO debe tocar envio de pedido, instruccion de pago, resumenes ni menciones de la politica.
import { describe, expect, it } from "vitest";
import { prometeDescuento, prometeDevolucionDeDinero, quitarPromesaDeDinero } from "../src/whatsapp/guards.ts";

const INTACTAS = [
  // mandar/enviar + importe de su pedido / regresando
  "Le envío el importe de su pedido: $320.",
  "Le mando el importe de su pedido, son $350.",
  "Regresando a su pedido, el importe de su pedido es de $280.",
  "Su total es $320. Le envío el importe de su pedido: $320. ¿Lo confirma?",
  // pago completo
  "Le mandamos su pedido en cuanto reciba el pago completo.",
  "Le enviamos su pedido apenas se refleje el pago completo.",
  "Mándenos el pago completo y le confirmamos.",
  "Puede transferir el pago completo a la cuenta indicada.",
  "Puede depositar el pago completo a la cuenta.",
  // lo pagado: resumenes
  "Le envío el desglose de lo pagado.",
  "Le mandamos un resumen de lo pagado.",
  "Le mandamos el resumen de lo que pagó hoy.",
  // el dinero
  "Si puede, mande el dinero exacto para agilizar la entrega.",
  "Le mandamos el dinero de la caja al repartidor.",
  // a su cuenta / tarjeta
  "Le depositamos sus puntos a su cuenta de cliente frecuente.",
  "Le transferimos los puntos a su cuenta de lealtad.",
  "Le regresamos a su cuenta del menú anterior.",
  "Le transferimos con el gerente a su cuenta.",
  // menciones de reembolso sin prometer
  "Comprendo su petición de reembolso; avisé al gerente para que revise su caso.",
  "Sobre su solicitud de reembolso, el gerente la revisará y lo contactará.",
  "El reembolso no depende de mí, lo decide el gerente.",
  "Si desea un reembolso, el gerente debe autorizarlo; yo no puedo prometerlo.",
  "Los reembolsos no están disponibles, pero le cambiamos el producto.",
  "Lamentamos informarle que los reembolsos no son posibles.",
  "La devolución de su dinero no es posible, solo cambio de producto.",
  // descuento: desglose
  "Le damos el desglose: descuento -$30, total $270.",
];
const REEMPLAZADAS = [
  "Le devolvemos su dinero.",
  "Le devolvemos $500 a su tarjeta.",
  "Le devolvemos lo pagado.",
  "Le regresaremos el importe de su pedido.",
  "Le devolvemos el pago completo.",
  "Se le hará la devolución de su dinero.",
  "Su dinero se devolverá a su tarjeta.",
  "Le mandamos su dinero de regreso.",
  "Reembolsaremos su pedido.",
  "Haremos el reembolso de su pedido.",
  "Se le reembolsará hoy mismo.",
  "Será reembolsado en 3 días.",
  "We will refund you today.",
  "You'll get a full refund.",
  "Hacemos un descuento.",
  "Podemos hacer un descuento.",
  "Damos un descuento de 20%.",
  "Se aplicará un descuento.",
];

describe("R12 revision 4: falsos positivos del revisor no se tocan", () => {
  it.each(INTACTAS)("intacta: %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(false);
    expect(prometeDescuento(f)).toBe(false);
    expect(quitarPromesaDeDinero(f)).toBe(f);
  });
  it.each(REEMPLAZADAS)("sigue reemplazada: %s", (f) => {
    expect(quitarPromesaDeDinero(f)).not.toBe(f);
  });
});
