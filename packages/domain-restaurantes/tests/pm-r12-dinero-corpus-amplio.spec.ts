// R12 revision #576: corpus amplio e independiente, espanol e ingles, de la guardia posterior de dinero y del clasificador de reembolso.
// Repo publico: frases de la CLASE del caso (operacion normal vs. promesa fuera de politica), sin recetas.
import { describe, expect, it } from "vitest";
import { RESPUESTA_REEMBOLSO_ESCALADO, classifyHighRiskIntent, quitarPromesaDeDinero } from "../src/whatsapp/guards.ts";

const POLITICA = "Por política no hacemos devoluciones de dinero, solo cambio de producto";
const SIN_DESC = "No puedo ofrecerle descuentos adicionales";
const clasif = (f: string, pedidoReciente: unknown = null) => classifyHighRiskIntent(f, { pedidoReciente: pedidoReciente as never });

describe("corpus negativo: la guardia de dinero NO toca operacion legitima (cambio, vuelto, reposicion, totales)", () => {
  it.each([
    "Le devolvemos su cambio de $180 de su pago de $500.",
    "Le devolvemos el cambio, son $180 de su pago de $500.",
    "Le devolvemos el cambio de su pago.",
    "Le regresamos su cambio de $50.",
    "Le regresamos el cambio en cuanto llegue el repartidor.",
    "Le devuelvo el cambio de su billete de $200.",
    "Le devolvemos el vuelto de $30.",
    "Le regresamos su vuelto.",
    "Su cambio de $20 se lo devolvemos en la entrega.",
    "Le regreso el total en cuanto me confirme.",
    "Le regreso el total actualizado en un momento.",
    "Le regresamos su pedido corregido, el total es $200.",
    "Le devolvemos su pedido corregido con el total de $230.",
    "Le repongo el platillo sin costo.",
    "Le reponemos el taco que faltó sin costo.",
    "Le reponemos su orden sin costo adicional.",
    "Le devuelvo la llamada en un momento.",
    "Le devuelvo el mensaje en cuanto confirme.",
    "La devolución de la charola se hace en caja.",
    "Le regresamos con gusto la cotización completa: $320.",
    "Pagando en efectivo con $500, le devolvemos $180 de cambio.",
    "Para su pago en efectivo, el repartidor lleva cambio de hasta $500.",
    "Su pago en efectivo quedó registrado; el repartidor le regresa el cambio.",
    "We will bring your change of $180 from your $500 payment.",
    "Your change is $180 from your $500 payment.",
    "We'll return your corrected order shortly, the total is $200.",
    "We will replace the dish at no extra cost.",
    "Hola, ¿qué le gustaría pedir hoy?",
    "Su total es $90.00, ¿confirma?",
    "Su pedido está en camino.",
    "Con gusto le cambiamos el producto sin costo.",
    "Le cambiamos su pedido por el correcto, sin costo.",
    "Por política no hacemos devoluciones de dinero, solo cambio de producto.",
    "Lo siento, no podemos reembolsar; sí podemos cambiar su producto.",
    "No hacemos reembolsos, pero le reponemos el platillo.",
    "Tenemos 2x1 los martes en tacos.",
    "Si pide para recoger, le damos 10% de descuento.",
    "La promoción de hoy es 15% de descuento en comida corrida.",
    "El descuento de la carta aplica de lunes a viernes.",
    "We do not issue refunds, only product exchanges.",
    // R12 revision #576 (segunda ronda): falsos positivos medidos por el revisor
    "Le repongo el platillo sin cobro adicional.",
    "Le reponemos el taco que faltó, sin ningún cobro.",
    "Le regresamos su pedido corregido, sin cobro extra.",
    "Le devuelvo la llamada para confirmar su pago.",
    "Le devolvemos el link para que complete su pago.",
    "Le devolvemos $180 de su pago de $500.",
    "Le regreso $20 de cambio.",
    "Su cambio de $20 se le devolverá en la entrega.",
    "Le devolvemos el vuelto: $30.",
    "Los martes damos 10% de descuento en tacos.",
    "Ofrecemos descuento de 10% si pide para recoger.",
    "No hacemos descuentos adicionales.",
    "No podemos hacer un descuento, lo siento.",
    "Lo siento, no damos descuentos fuera de la cotización.",
    "Te mandamos el link de pago en un momento.",
    "Le mandamos su pedido en 30 minutos.",
    "Le enviamos la cotización completa: $320.",
    "Procedemos con su pedido, ¿confirma?",
    "Hacemos la entrega en 30 minutos.",
    "Tenemos promoción de 15% de descuento en comida corrida.",
    "Pasamos por la devolución de la charola mañana.",
    "You will get your order in 30 minutes.",
    "We can't refund the money, but we can exchange the product.",
    "You won't get your money back, only an exchange.",
    "We will send you the payment link.",
  ])("intacta: %s", (f) => {
    expect(quitarPromesaDeDinero(f)).toBe(f);
  });
});

describe("corpus positivo: promesas de dinero SI se reemplazan por la politica", () => {
  it.each([
    "Reembolsaremos su pedido.",
    "Le reembolsamos su pedido.",
    "Le reembolsamos todo.",
    "Hacemos la devolución de su dinero hoy.",
    "Hacemos la devolución de su dinero.",
    "Le devolvemos lo pagado.",
    "Le devolvemos lo que pagó.",
    "Le devolvemos su dinero.",
    "Le devolvemos el dinero de su pedido.",
    "Le devolvemos todo su dinero.",
    "Le devolvemos el pago completo.",
    "Le devolveremos su pago.",
    "Le regresamos su dinero.",
    "Le regresamos lo pagado.",
    "Le regresamos el pago.",
    "Le regreso su dinero hoy mismo.",
    "Se le devolverá su dinero.",
    "Su dinero será devuelto.",
    "Será reembolsado en 3 días.",
    "Le hacemos un reembolso.",
    "Procedemos con el reembolso.",
    "Le acreditamos el monto a su tarjeta.",
    "Le bonificamos el total.",
    "We will refund you.",
    "We'll refund your order.",
    "Your money will be refunded.",
    "I will issue a refund.",
    "You'll get a full refund.",
    // devolucion con hacer/proceder y cifra en pesos (R12 revision, bloqueante 2)
    "Se le hará la devolución de su dinero.",
    "Se le hará la devolución.",
    "Le haremos la devolución completa.",
    "Procederemos con la devolución.",
    "Procedemos con la devolución de su pedido.",
    "Realizamos la devolución hoy mismo.",
    "Le devolvemos $500 a su tarjeta.",
    "Le devolvemos los $500 que pagó.",
    "Le devolveremos el importe de su pedido.",
    "Le reembolsamos $200.",
    "Su dinero se devolverá a su tarjeta.",
    "Su pago se regresará en 3 días hábiles.",
    "Le mandamos su dinero de regreso.",
    "Le retornamos su dinero.",
    "Le compensamos con $100 de crédito.",
    "Le damos su dinero de vuelta.",
    "You will get your money back.",
    "We will credit your card.",
    "We'll reimburse you.",
    "We will send you your money back.",
  ])("reemplaza dinero: %s", (f) => {
    const r = quitarPromesaDeDinero(f);
    expect(r).not.toBe(f);
    expect(r).toContain(POLITICA);
  });
  it.each([
    "Le hacemos un descuento.",
    "Le hacemos un descuento del 30%.",
    "Le hacemos un descuento de 30%.",
    "Le damos un descuento.",
    "Le aplicamos un descuento.",
    "Le aplico 50% de descuento.",
    "Le damos 20% de descuento por las molestias.",
    "Le descontamos $50 de su pedido.",
    "Le descuento $30 de su cuenta.",
    "Le descontamos el 10%.",
    "Su pedido corre por nuestra cuenta.",
    "Su orden va por cuenta de la casa.",
    "Su pedido sale gratis.",
    "Se lo regalamos.",
    "We'll give you a discount.",
    "I'll give you 50% off.",
    // forma sin pronombre (R12 revision, bloqueante 1)
    "Hacemos un descuento.",
    "Sí, hacemos un descuento.",
    "Hacemos un descuento del 10% por la molestia.",
    "Podemos hacer un descuento.",
    "Damos un descuento de 20%.",
    "Se aplicará un descuento.",
    "Se le otorgará un descuento del 15%.",
    "Haremos un descuento en su próxima orden.",
    "Podemos darle un descuento por las molestias.",
    "Hago un descuento del 30%.",
  ])("reemplaza descuento: %s", (f) => {
    const r = quitarPromesaDeDinero(f);
    expect(r).not.toBe(f);
    expect(r).toContain(SIN_DESC);
  });
  it("conserva el resto de la respuesta", () => {
    const r = quitarPromesaDeDinero("Lamento lo ocurrido. Le devolvemos lo pagado. ¿Qué faltó o qué llegó mal?");
    expect(r).toContain("Lamento lo ocurrido.");
    expect(r).toContain("¿Qué faltó o qué llegó mal?");
    expect(r).toContain(POLITICA);
  });
});

describe("preguntas de politica y mensajes del cliente: sin escalar de mas ni clasificar mal", () => {
  it.each([
    "¿Puedo pedir reembolso o solo cambio?",
    "tengo duda del reembolso",
    "¿Hacen reembolsos?",
    "¿Tienen política de devoluciones?",
    "¿Cuál es su política de reembolso?",
    "¿Si no me gusta me devuelven el dinero?",
    "do you have a refund policy?",
    "Can I get a refund if I change my mind?",
    "paid twice the price I expected",
    "I paid twice the price I expected, it was a lot of food",
    "Quiero cambiar mi pedido, no es necesario devolver nada",
    "dos tacos de pastor para recoger",
    "Me gustaría saber si puedo pedir reembolso",
    "tengo una pregunta sobre reembolsos",
    "Dime si hay reembolso",
    "¿Qué pasa si quiero un reembolso?",
    "What happens if I want a refund?",
    "I was wondering about your refund policy",
  ])("no escala (sin intent ni respuesta fija): %s", (f) => {
    expect(clasif(f)).toBeNull();
  });
  it.each(["do you have peanuts?", "Do you have peanut-free dishes?"])("la pregunta de alergia en ingles SI escala por seguridad: %s", (f) => {
    expect(clasif(f)?.intent).toBe("alergia_salud");
  });
  it.each([
    "Quiero un reembolso",
    "Quiero mi dinero de vuelta",
    "I want a refund",
    "give me my money back",
    "Devuélvanme mi dinero",
    "Me cobraron mal, ¿me devuelven mi dinero?",
    "Llegó frío, ¿me devuelven el dinero?",
  ])("queja real de reembolso escala con la politica: %s", (f) => {
    expect(clasif(f, { estado: "entregado" })?.reply).toBe(RESPUESTA_REEMBOLSO_ESCALADO);
  });
});
