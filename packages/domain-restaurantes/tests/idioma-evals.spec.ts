// R-44 -- eval del detector de idioma sobre mensajes realistas de clientes de una taqueria (mensajes inventados para el arnes: ningun
// chat real). Umbral: 100 % en el set dorado. Un mensaje mal clasificado hace que el agente conteste en el idioma equivocado.
import { describe, expect, it } from "vitest";
import { detectarIdioma, type Idioma } from "../src/idioma.ts";

const DORADO: ReadonlyArray<readonly [Idioma, readonly string[]]> = [
  ["en", ["Hi, can I order for pickup?"]],
  ["en", ["Hello! I would like two orders of al pastor tacos please"]],
  ["en", ["What time do you close tonight?"]],
  ["en", ["Do you deliver to Altabrisa?"]],
  ["en", ["How much is the delivery and how long does it take?"]],
  ["en", ["I'm allergic to peanuts, can you tell me if the sauces have any?"]],
  ["en", ["Can I get a corn tortilla for all of them, no onions please"]],
  ["en", ["I'll pay with cash when it arrives"]],
  ["en", ["Is the beer available for delivery?"]],
  ["en", ["Good evening, I want to place an order for delivery"]],
  ["en", ["We are a group of six, what do you recommend from the menu?"]],
  ["en", ["Thanks, that's all for now"]],
  ["en", ["Can you send it to my hotel? It's on Paseo de Montejo"]],
  ["en", ["Hello, I'd like to cancel my order please"]],
  ["en", ["[Nota de voz transcrita] I want four tacos al pastor and one horchata please"]],
  ["en", ["Hello, I want to order tacos please", "yes", "tacos al pastor", "4"]],
  ["es", ["Hola, quiero hacer un pedido para recoger"]],
  ["es", ["Buenas tardes, ¿a qué hora cierran hoy?"]],
  ["es", ["Quiero dos órdenes de tacos al pastor por favor"]],
  ["es", ["¿Cuánto cuesta el envío y cuánto tardan?"]],
  ["es", ["Soy alérgico al cacahuate, ¿las salsas llevan?"]],
  ["es", ["Me pone una orden de frijoles con queso y una coca"]],
  ["es", ["Pago en efectivo cuando llegue"]],
  ["es", ["¿Todavía están tomando pedidos a domicilio?"]],
  ["es", ["Buenas noches, lo de siempre a domicilio"]],
  ["es", ["sin cebolla y con mucha piña"]],
  ["es", ["Mi dirección es calle 63 número 412 por 45 y 47, colonia Centro"]],
  ["es", ["Quiero cancelar mi pedido, ya pasó media hora"]],
  ["es", ["[Nota de voz transcrita] quiero cuatro tacos de pastor y una horchata por favor"]],
  ["es", ["Hola, quiero hacer un pedido", "sí", "tacos al pastor", "4"]],
  ["es", []],
  ["es", ["2"]],
  ["es", ["ok"]],
  ["es", ["tacos al pastor"]],
  ["en", ["Hello, I'd like to order please", "Buenas tardes, ahora en español por favor, quiero un pedido a domicilio", "Sorry, I prefer English. Can you continue in English please?"]],
  ["es", ["Hello, I'd like to order please", "mejor en español, quiero pedir a domicilio por favor"]],
];

describe("eval del detector de idioma (set dorado)", () => {
  it("clasifica correctamente el 100 % de los casos", () => {
    const fallos = DORADO.flatMap(([esperado, mensajes]) => {
      const real = detectarIdioma(mensajes);
      return real === esperado ? [] : [`${esperado} != ${real}: ${JSON.stringify(mensajes)}`];
    });
    expect(fallos).toEqual([]);
  });
});
