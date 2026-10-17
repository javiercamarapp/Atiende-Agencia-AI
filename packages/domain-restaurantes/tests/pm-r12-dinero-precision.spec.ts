// R12 revision #576 (ronda 3, «precision primero»): la guardia posterior de dinero solo dispara con senales de alta precision y NO toca la operacion normal de un restaurante
// (cambio en efectivo, confirmacion de pagos, propinas, reposiciones, correcciones, promociones respaldadas). Repo publico: frases de la CLASE, sin recetas de explotacion.
import { describe, expect, it } from "vitest";
import { prometeDescuento, prometeDevolucionDeDinero, quitarPromesaDeDinero } from "../src/whatsapp/guards.ts";

const POLITICA = "Por política no hacemos devoluciones de dinero, solo cambio de producto";
const SIN_DESC = "No puedo ofrecerle descuentos adicionales";

describe("corpus negativo amplio: NUNCA se toca (con y sin promocion respaldada)", () => {
  const NEGATIVOS = [
    // cambio en efectivo, distintas cifras y redacciones
    "Paga con $500, le devolvemos $180 de cambio.",
    "Paga con $500, le devolvemos $1 de cambio.",
    "Si paga con $1000, le devolvemos $730 de cambio.",
    "Pagando con $200, le regresamos $45.",
    "Le devolvemos su cambio de $180.",
    "Le regresamos el cambio, son $55.",
    "Su cambio es de $320, se lo entrega el repartidor.",
    "El repartidor lleva cambio de hasta $500.",
    "Le devuelvo el vuelto: $70.",
    "Le regresamos la feria en la entrega.",
    "Con su billete de $500 le devolvemos $230.",
    "Le devolvemos $230 de su billete de $500.",
    "Pago en efectivo: le devolvemos $150 de cambio en la puerta.",
    "Si paga en efectivo, ¿con cuánto paga para llevarle cambio?",
    "Le devolvemos el cambio exacto, no se preocupe.",
    "Dame un momento y te regreso el cambio de los $100.",
    "Su cambio de $12.50 se lo regresamos en monedas.",
    "We'll bring your change of $180 from your $500 bill.",
    "Your change is $230, the driver will hand it to you.",
    "Pay with cash and we return the change at the door.",
    // pago con tarjeta, terminal, acreditacion
    "Su pago se acreditará en breve.",
    "Su pago con tarjeta se acreditará de inmediato.",
    "Su pago se abonará a su pedido en un momento.",
    "Pago recibido, gracias.",
    "Su pago fue confirmado, ya preparamos su pedido.",
    "Recibimos su pago, su pedido sale en 20 minutos.",
    "El repartidor lleva la terminal para pagar con tarjeta.",
    "Puede pagar con tarjeta en la terminal al recibir su pedido.",
    "Su pago con tarjeta fue aprobado.",
    "Se abona a su cuenta de cliente frecuente un punto por cada $10.",
    "Payment received, thank you!",
    "Your card payment was approved and will be credited shortly.",
    // propinas
    "La propina es voluntaria; puede dejarla en efectivo o en la terminal.",
    "Le agradecemos la propina, se la entregamos al repartidor.",
    "¿Quiere agregar propina a su pago con tarjeta?",
    "You can add a tip on the terminal.",
    // confirmaciones de pedido y de pago
    "Su pedido quedó registrado, ¿confirma?",
    "Su total es $270.00, ¿lo confirma?",
    "Le regreso el importe total para que lo confirme: $200.",
    "Le mando la cotización completa: $320.",
    "Le devolvemos el link de pago para que complete su compra.",
    "Le mandamos el link de pago en un momento.",
    "Le envío el comprobante a su correo.",
    "Le enviamos el recibo a su cuenta de correo.",
    "Le regresamos con gusto la cotización actualizada.",
    "Su pedido está en camino y llega en 25 minutos.",
    "Ya mandamos su pedido, llega en 30 minutos.",
    "Procedemos con su pedido, ¿confirma?",
    "Hacemos la entrega en 30 minutos.",
    "Your order is confirmed and will arrive in 30 minutes.",
    "We will send you the payment link.",
    // reposiciones y correcciones
    "Le repongo el platillo sin cobro adicional.",
    "Le reponemos el taco que faltó, sin ningún cobro.",
    "Le regresamos su pedido corregido, sin cobro extra.",
    "Le repongo el platillo sin costo.",
    "Le reponemos su orden sin costo adicional.",
    "Le regresamos su pedido corregido, el total es $200.",
    "Le devolvemos su pedido corregido con el total de $230.",
    "Lamento el error, le enviamos de nuevo el platillo correcto sin cargo.",
    "Le mandamos otra salsa sin costo.",
    "Con gusto le cambiamos el producto sin costo.",
    "Le cambiamos su pedido por el correcto.",
    "We will replace the dish at no extra cost.",
    "We'll send the corrected order right away, no extra charge.",
    // promociones legitimas (respaldadas por la carta o la cotizacion)
    "Los martes damos 10% de descuento en tacos.",
    "Si pide para recoger, le damos 10% de descuento.",
    "Ofrecemos descuento de 10% si pide para recoger.",
    "Tenemos promoción de 15% de descuento en comida corrida.",
    "La promoción de hoy es 2x1 en tacos de pastor.",
    "Le damos el total con descuento: $270.",
    "El descuento de la carta aplica de lunes a viernes.",
    "Su pedido tendrá 10% de descuento por recoger.",
    // cortesias
    "De cortesía le mandamos una salsa extra.",
    "Va un postre de cortesía por su paciencia.",
    "Le agradecemos su espera.",
    // tiempos de entrega
    "Tu pedido llega en 35 minutos aproximadamente.",
    "Salimos a entregar en 10 minutos.",
    "El tiempo de entrega es de 30 a 40 minutos.",
    // politica y negaciones
    "Por política no hacemos devoluciones de dinero, solo cambio de producto.",
    "No hacemos reembolsos, pero le reponemos el platillo.",
    "No podemos devolver su dinero, pero con gusto le cambiamos el producto.",
    "Lo siento, no podemos reembolsar; sí podemos cambiar su producto.",
    "Nunca hacemos reembolsos; sí hacemos cambio de producto.",
    "Sin reembolso, solo cambio de producto.",
    "No hacemos descuentos adicionales.",
    "No podemos hacer un descuento, lo siento.",
    "Lo siento, no damos descuentos fuera de la cotización.",
    "Por ahora solo hacemos cambio de producto.",
    "We do not issue refunds, only product exchanges.",
    "We can't refund the money, but we can exchange the product.",
    "You won't get your money back, only an exchange.",
    // otros usos de devolver / regresar
    "Le devuelvo la llamada en un momento.",
    "La devolución de la charola se hace en caja.",
    "Pasamos por la devolución del garrafón mañana.",
    "Le regreso el mensaje en cuanto confirme.",
    "Regresamos en 5 minutos con su respuesta.",
    "¿Qué le gustaría pedir hoy?",
  ];
  it("el corpus negativo tiene al menos 80 frases", () => {
    expect(new Set(NEGATIVOS).size).toBeGreaterThanOrEqual(80);
  });
  it.each(NEGATIVOS)("intacta: %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(false);
    expect(quitarPromesaDeDinero(f)).toBe(f);
    expect(quitarPromesaDeDinero(f, { respaldaDescuento: true })).toBe(f);
  });
});

describe("corpus positivo: promesas claras de reembolso, devolucion de dinero o descuento sin respaldo SI se reemplazan", () => {
  const DINERO = [
    "Reembolsaremos su pedido.",
    "Le reembolsamos su pedido.",
    "Le reembolsamos todo.",
    "Le reembolsamos $200.",
    "Le vamos a reembolsar el importe hoy mismo.",
    "Será reembolsado en 3 días.",
    "Le hacemos un reembolso completo.",
    "Procedemos con el reembolso.",
    "Hacemos la devolución de su dinero hoy.",
    "Se le hará la devolución de su dinero.",
    "Se le devolverá el dinero en 3 días.",
    "Le devolvemos su dinero.",
    "Le devolvemos su dinero completo.",
    "Le devolvemos todo su dinero.",
    "Le devolvemos el dinero de su pedido.",
    "Le devolvemos lo pagado.",
    "Le devolvemos lo que pagó.",
    "Le regresamos su dinero.",
    "Le regresamos lo pagado.",
    "Le devolvemos el pago completo.",
    "Le devolveremos el importe de su pedido.",
    "Le devolvemos $500 a su tarjeta.",
    "Le devolvemos los $500 que pagó.",
    "Su dinero será devuelto a su tarjeta.",
    "Su dinero se devolverá a su tarjeta.",
    "Le mandamos su dinero de regreso.",
    "Le retornamos su dinero.",
    "Le damos su dinero de vuelta.",
    "We will refund you.",
    "I'll issue a refund for your order.",
    "Your money will be refunded.",
    "Your money will be returned.",
    "You will get your money back.",
    "We will send you your money back.",
    "We'll reimburse you.",
  ];
  const DESCUENTO = [
    "Hacemos un descuento.",
    "Sí, hacemos un descuento.",
    "Podemos hacer un descuento.",
    "Podemos darle un descuento por las molestias.",
    "Damos un descuento de 20%.",
    "Se aplicará un descuento.",
    "Se le otorgará un descuento del 15%.",
    "Haremos un descuento en su próxima orden.",
    "Hago un descuento del 30%.",
    "Le hacemos un descuento.",
    "Le hacemos un descuento del 30%.",
    "Le damos un descuento.",
    "Le aplicamos un descuento.",
    "Le aplico 50% de descuento.",
    "Le damos 20% de descuento por las molestias.",
    "Por la molestia le aplico 50% de descuento en su siguiente pedido.",
    "Su pedido tendrá 15% de descuento.",
    "Aplicaremos un descuento a su cuenta.",
    "We'll give you a discount.",
    "I'll give you 50% off.",
  ];
  it("el corpus positivo tiene al menos 30 frases", () => {
    expect(new Set([...DINERO, ...DESCUENTO]).size).toBeGreaterThanOrEqual(30);
  });
  it.each(DINERO)("reemplaza dinero (aun con promocion respaldada): %s", (f) => {
    expect(prometeDevolucionDeDinero(f)).toBe(true);
    expect(quitarPromesaDeDinero(f)).toContain(POLITICA);
    expect(quitarPromesaDeDinero(f, { respaldaDescuento: true })).toContain(POLITICA);
  });
  it.each(DESCUENTO)("reemplaza descuento sin respaldo: %s", (f) => {
    expect(prometeDescuento(f)).toBe(true);
    expect(quitarPromesaDeDinero(f)).toContain(SIN_DESC);
  });
  it("conserva el resto de la respuesta y no repite la sustitucion", () => {
    const r = quitarPromesaDeDinero("Lamento lo ocurrido. Le devolvemos su dinero. Además, le reembolsamos todo. ¿Qué faltó o qué llegó mal?");
    expect(r).toContain("Lamento lo ocurrido.");
    expect(r).toContain("¿Qué faltó o qué llegó mal?");
    expect(r.match(/Por política no hacemos devoluciones/g)).toHaveLength(1);
  });
  it("una respuesta mixta solo pierde la oracion que promete", () => {
    const r = quitarPromesaDeDinero("Paga con $500, le devolvemos $180 de cambio. Le reembolsamos su pedido. Su pago se acreditará en breve.");
    expect(r).toContain("le devolvemos $180 de cambio.");
    expect(r).toContain("Su pago se acreditará en breve.");
    expect(r).toContain(POLITICA);
  });
});

describe("falsos negativos aceptados por diseno: NO se reemplazan (la defensa es el prompt y escalar a humano)", () => {
  it.each([
    "Se le hará la devolución.",
    "Procederemos con la devolución de su pedido.",
    "Le bonificamos el total.",
    "Le compensamos con $100 de crédito.",
    "Le descontamos $50 de su pedido.",
    "Su pedido corre por nuestra cuenta.",
    "Su pedido sale gratis.",
    "Se lo regalamos.",
    "Le acreditamos el monto a su tarjeta.",
    "Le devolvemos su dinero en efectivo.",
    "Su pago se regresará en 3 días hábiles.",
    "We will pay you back.",
  ])("pasa intacta (precision sobre cobertura): %s", (f) => {
    expect(quitarPromesaDeDinero(f)).toBe(f);
  });
});
