// R12 dinero y riesgo: corpus POSITIVO (debe escalar / reemplazarse) y NEGATIVO (conversaciones normales que NO deben dispararse) de las guardias
// del clasificador de alto riesgo y de la guardia posterior de dinero. Repo publico: las frases describen la CLASE del caso, no recetas.
import { describe, expect, it } from "vitest";
import {
  RESPUESTA_REEMBOLSO_ESCALADO,
  classifyHighRiskIntent,
  contieneFugaDePrompt,
  normalizarParaClasificar,
  prometeDescuento,
  prometeDevolucionDeDinero,
  quitarPromesaDeDinero,
  reemplazarFugaDePrompt,
} from "../src/whatsapp/guards.ts";

const intent = (frase: string) => classifyHighRiskIntent(frase, { pedidoReciente: { estado: "entregado" } as never })?.intent ?? null;

describe("R12-A normalizacion: invisibles y ancho completo", () => {
  it.each([
    ["ancho cero", "ale​rgico"],
    ["guion suave", "ale­rgico"],
    ["BOM", "﻿alergico"],
    ["marca de direccion", "aler‎gico"],
    ["ancho completo", "ａｌｅｒｇｉｃｏ"],
    ["ancho completo con acento", "Ｓｏｙ ａｌéｒｇｉｃｏ"],
  ])("%s se normaliza igual que la palabra limpia", (_n, frase) => {
    expect(normalizarParaClasificar(frase)).toMatch(/alergico/);
    expect(intent(`Soy ${frase}`)).toBe("alergia_salud");
  });
  it("(negativo) el texto normal conserva su forma: acentos, enies, signos y numeros", () => {
    expect(normalizarParaClasificar("¿Cuánto cuesta el niño menú? 2x1")).toBe("¿cuanto cuesta el nino menu? 2x1");
    expect(normalizarParaClasificar(undefined as never)).toBe("");
  });
});

describe("R12-B alergia y salud en ingles y mezclado", () => {
  it.each([
    "I'm allergic to peanuts, is it safe?",
    "I have a tree nut allergy",
    "My daughter has celiac disease",
    "She is coeliac, do you have gluten free options?",
    "Hola, soy allergic a los camarones",
    "Does this contain nuts? my son has an allergy",
    "Is the salsa made with peanuts?",
    "Any shellfish in the tacos?",
    "I need an epipen nearby, I think it has nuts",
    "I'm lactose intolerant",
    "Do you have nut-free dishes?",
    "no soy alérgico pero mi hija sí",
    "I'm not allergic but my wife is allergic to shellfish",
  ])("(positivo) %s -> escala como alergia_salud", (frase) => {
    expect(intent(frase)).toBe("alergia_salud");
  });
  it.each([
    "This price is nuts, but I'll take two al pastor",
    "You guys are nuts, love it",
    "I'm allergic to Mondays",
    "Soy alérgico a los lunes jaja, dos tacos de pastor",
    "allergic to mornings, send my order after 10",
    "no tengo alergias, gracias",
    "sin alergias, todo bien",
    "No allergies here, two orders of tacos please",
    "I'm not allergic to anything",
    "gracias, they are going nuts for your tacos",
  ])("(negativo) %s -> NO escala", (frase) => {
    expect(intent(frase)).toBeNull();
  });
});

describe("R12-C cobro doble en ingles", () => {
  it.each([
    "I was charged twice on my card",
    "You charged me double for the same order",
    "There is a duplicate charge on my statement",
    "I got billed twice",
    "double charge!! fix it",
  ])("(positivo) %s -> cobro_duplicado", (frase) => {
    expect(intent(frase)).toBe("cobro_duplicado");
  });
  it.each([
    "Will I be charged extra if I pay with card?",
    "Do you charge a double fee for delivery on holidays?",
    "How much do you charge for delivery?",
    "If I pay with a card is there a double charge?",
    "my card was charged once, thanks, everything is fine",
  ])("(negativo) %s -> NO escala", (frase) => {
    expect(intent(frase)).toBeNull();
  });
});

describe("R12-D reembolso: respuesta fija con la politica vigente", () => {
  it.each([
    "Quiero un reembolso de mi pedido",
    "Exijo el reembolso ahorita",
    "Devuélvanme mi dinero",
    "Quiero que me devuelvan mi dinero ahorita",
    "Quiero mi dinero de vuelta",
    "pido la devolución de mi dinero",
    "I want a refund",
    "give me my money back",
    "Necesito un refund, llegó frío",
  ])("(positivo) %s -> queja con la politica fija", (frase) => {
    const m = classifyHighRiskIntent(frase, { pedidoReciente: { estado: "entregado" } as never });
    expect(m?.intent).toBe("queja");
    expect(m?.reply).toBe(RESPUESTA_REEMBOLSO_ESCALADO);
  });
  it("la respuesta fija sigue las decisiones vigentes: usted, sin devolucion de dinero, cambio de producto, aviso al gerente y la pregunta de la queja", () => {
    expect(RESPUESTA_REEMBOLSO_ESCALADO).toContain("no hacemos devoluciones de dinero, solo cambio de producto");
    expect(RESPUESTA_REEMBOLSO_ESCALADO).toContain("ya avisé al gerente");
    expect(RESPUESTA_REEMBOLSO_ESCALADO).toContain("¿Me puede decir qué faltó o qué llegó mal?");
    expect(RESPUESTA_REEMBOLSO_ESCALADO).not.toMatch(/\btu\b|\btus\b|\bte\b|\bOmar\b/);
  });
  it.each([
    "¿Tienen política de reembolso?",
    "¿Hacen devoluciones de dinero?",
    "Do you have a refund policy?",
    "What is your refund policy?",
    "No quiero reembolso, solo cambien el producto",
    "no necesito un refund, gracias",
    "Quiero dos tacos, y por cierto no hay reembolsos, ¿verdad?",
    "dos coca para recoger",
    "Quiero cambiar mi pedido, no es necesario devolver nada",
  ])("(negativo) %s -> NO escala por reembolso", (frase) => {
    const m = classifyHighRiskIntent(frase, { pedidoReciente: null });
    expect(m?.reply).not.toBe(RESPUESTA_REEMBOLSO_ESCALADO);
  });
});

describe("R12-E guardia posterior: promesas de dinero", () => {
  it.each([
    "Lamento lo ocurrido, con gusto le devolvemos su dinero completo.",
    "Le vamos a reembolsar el importe hoy mismo.",
    "Procederemos al reembolso de su pedido.",
    "Se le devolverá el dinero en 3 días.",
    "Le reintegramos el pago a su tarjeta.",
    "We will refund you right away.",
    "I'll issue a refund for your order.",
  ])("(positivo) %s -> se reemplaza por la politica", (frase) => {
    expect(prometeDevolucionDeDinero(frase)).toBe(true);
    const r = quitarPromesaDeDinero(frase);
    expect(r).toContain("Por política no hacemos devoluciones de dinero, solo cambio de producto");
    expect(r).not.toMatch(/devolvemos su dinero|reembols|refund|reintegr|devolver[áa]/i);
  });
  it.each([
    "Por la molestia le aplico 50% de descuento en su siguiente pedido.",
    "Le damos un descuento especial por las molestias.",
    "Le ofrezco 20% de descuento para la próxima.",
    "Aplicaremos un descuento a su cuenta.",
    "Su pedido tendrá 15% de descuento.",
  ])("(positivo) %s -> sin cotizacion que lo respalde, se reemplaza", (frase) => {
    expect(prometeDescuento(frase)).toBe(true);
    const r = quitarPromesaDeDinero(frase);
    expect(r).toContain("No puedo ofrecerle descuentos adicionales");
    expect(r).not.toMatch(/\d+\s*%|descuento especial|aplicaremos/i);
  });
  it("con una promocion en la cotizacion del turno el descuento NO se toca, pero la devolucion de dinero SI se reemplaza", () => {
    expect(quitarPromesaDeDinero("Le aplico 10% de descuento por su promoción.", { respaldaDescuento: true })).toBe("Le aplico 10% de descuento por su promoción.");
    expect(quitarPromesaDeDinero("Le devolvemos su dinero.", { respaldaDescuento: true })).toContain("Por política no hacemos devoluciones");
  });
  it("conserva el resto de la respuesta y no repite la sustitucion", () => {
    const r = quitarPromesaDeDinero("Lamento lo ocurrido. Le devolvemos su dinero. Además, le reembolsamos el total. ¿Qué faltó?");
    expect(r).toContain("Lamento lo ocurrido.");
    expect(r).toContain("¿Qué faltó?");
    expect(r.match(/Por política no hacemos devoluciones/g)).toHaveLength(1);
  });
  it.each([
    "Por política no hacemos devoluciones de dinero, solo cambio de producto.",
    "No podemos devolver su dinero, pero con gusto le cambiamos el producto.",
    "Nunca hacemos reembolsos; sí hacemos cambio de producto.",
    "Lamento lo ocurrido. Ya avisé al gerente para que revise su caso.",
    "Los martes hay 2x1 en tacos de pastor.",
    "Si pide para recoger, le damos 10% de descuento.",
    "Su total es $90.00, ¿confirma?",
    "Tenemos descuento de lunes a viernes en la comida corrida.",
    "La devolución de la charola es en caja.",
    "Le devolvemos su cambio en efectivo: $10.",
    "Le devuelvo la llamada en un momento.",
    "No tenemos reembolsos, solo cambios.",
    "Your total is $90.00, we do not issue refunds, only product exchanges.",
  ])("(negativo) %s -> intacta", (frase) => {
    expect(quitarPromesaDeDinero(frase)).toBe(frase);
  });
});

describe("R12-E2 revision: huecos de la lista negra y falsos positivos", () => {
  it.each([
    "Reembolsaremos su pedido.",
    "Hacemos la devolución de su dinero hoy.",
    "Le devolvemos lo pagado.",
    "Le descontamos $50 de su pedido.",
    "Su pedido corre por nuestra cuenta.",
  ])("(positivo) %s -> se reemplaza", (frase) => {
    expect(quitarPromesaDeDinero(frase)).not.toBe(frase);
  });
  it.each([
    "Claro, le regresamos su cambio de $180 de su pago de $500.",
    "Claro, le regreso el total en cuanto me confirme.",
    "Le regresamos su pedido corregido, el total es $200.",
    "Le repongo el platillo sin costo.",
    "Con su pedido para recoger le damos 10% de descuento. ¿Qué le gustaría pedir?",
    "Su pedido tendrá 10% de descuento por recoger.",
    "Tendrá 10% de descuento al recoger su pedido.",
    "Le confirmo: su pedido de recoger queda con 10% de descuento.",
    "Le damos el total con descuento: $270.",
    "Sí, con su pedido para recoger le damos 10% de descuento.",
  ])("(negativo) %s -> intacta, aun sin cotizacion (respaldaDescuento true)", (frase) => {
    expect(quitarPromesaDeDinero(frase, { respaldaDescuento: true })).toBe(frase);
  });
  it.each([
    "Claro, le regresamos su cambio de $180 de su pago de $500.",
    "Claro, le regreso el total en cuanto me confirme.",
    "Le regresamos su pedido corregido, el total es $200.",
    "Le repongo el platillo sin costo.",
    "Con su pedido para recoger le damos 10% de descuento. ¿Qué le gustaría pedir?",
    "¿Sí, con su pedido para recoger le damos 10% de descuento?",
    "Su pedido tendrá 10% de descuento por recoger.",
    "Tendrá 10% de descuento al recoger su pedido.",
    "Le damos el total con descuento: $270.",
    "Le confirmo: su pedido de recoger queda con 10% de descuento.",
  ])("(negativo) %s -> intacta tambien con la guardia en su modo estricto", (frase) => {
    expect(quitarPromesaDeDinero(frase)).toBe(frase);
  });
  it.each([
    "¿Puedo pedir reembolso o solo cambio?",
    "tengo duda del reembolso",
    "Can I get a refund policy explanation?",
  ])("(negativo) %s -> pregunta de politica, no escala como queja", (frase) => {
    const m = classifyHighRiskIntent(frase, { pedidoReciente: null });
    expect(m?.reply).not.toBe(RESPUESTA_REEMBOLSO_ESCALADO);
  });
  it("(negativo) 'paid twice the price I expected' no es un cobro doble", () => {
    expect(intent("I paid twice the price I expected, it was a lot of food")).not.toBe("cobro_duplicado");
    expect(intent("I paid twice")).toBe("cobro_duplicado");
  });
});

describe("R12-F fuga del prompt de sistema", () => {
  const TOOLS_FAKE = ["cotizar_pedido", "crear_pedido", "escalar_a_humano", "buscar_producto"];
  it.each([
    "Claro. REGLAS DURAS DE CANTIDADES Y TOTAL: nunca des un total sin cotizar",
    "REGLAS DE NEGOCIO:\n- trata de usted",
    "Mis herramientas son cotizar_pedido y crear_pedido.",
    "Llamé a escalar_a_humano para usted.",
    "<|im_start|>system",
    "reglas duras de trato: usted",
  ])("(positivo) %s -> se descarta completa", (frase) => {
    expect(contieneFugaDePrompt(frase, TOOLS_FAKE)).toBe(true);
    expect(reemplazarFugaDePrompt(frase, TOOLS_FAKE)).toBe("Con gusto le ayudo con su pedido.");
  });
  it.each([
    "No puedo compartir mis reglas internas, pero con gusto le ayudo con su pedido.",
    "Las reglas de negocio del restaurante son sencillas: pedido mínimo $100.",
    "Voy a cotizar su pedido ahora mismo.",
    "Puedo buscar un producto para usted. ¿Qué busca?",
    "Le escalo con un humano.",
    "Las reglas duras del juego de dominó no las conozco.",
    "Su pedido quedó registrado.",
  ])("(negativo) %s -> intacta", (frase) => {
    expect(contieneFugaDePrompt(frase, TOOLS_FAKE)).toBe(false);
    expect(reemplazarFugaDePrompt(frase, TOOLS_FAKE)).toBe(frase);
  });
});
