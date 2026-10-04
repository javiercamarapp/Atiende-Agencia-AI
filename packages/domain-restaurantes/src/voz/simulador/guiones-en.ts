// R-44 -- guiones de la prueba ciega de voz con un llamante que habla INGLES (turistas, expatriados). Mismos graders deterministas que los
// guiones es-MX mas `G_IDIOMA_EN` (el agente contesta en ingles). Los argumentos de las herramientas siguen en espanol y los importes son
// pesos mexicanos. Con el proveedor falso el agente es guionado; con Gemini real (manual) el modelo decide solo y los graders miden lo mismo.
// Menu, importes, nombres y direccion son los inventados del arnes (ningun dato real).
import { BRANCH_SLUG_PRINCIPAL } from "./mundo-voz.ts";
import type { GuionLlamada, MemoriaTools, PasoAgente } from "./tipos.ts";

const SUC = BRANCH_SLUG_PRINCIPAL;

const buscar = (query: string, slug = SUC): PasoAgente => ({ tool: "buscar_producto", args: { query, branch_slug: slug } });
const linea = (m: MemoriaTools, frag: string, piezas: number, tortilla?: "maiz" | "harina" | "mixta") => {
  const p = m.producto(frag);
  return { product_id: p.id, product_name: p.name, requested_quantity: piezas, ...(tortilla ? { tortilla } : {}) };
};
const dice = (texto: string): PasoAgente => ({ dice: texto });
const confirmar: PasoAgente = { tool: "confirmar_resumen", args: (m) => ({ quote_hash: m.quoteHash() }) };

const DIRECCION = "Calle 63 número 412 por 45 y 47, colonia Centro";
const DIRECCION_HABLADA = "The name is Ana Pech, sixty-third street, number four twelve, between forty-fifth and forty-seventh, Centro neighborhood";
const SENSIBLES = ["Ana Pech", "calle 63", "412", "four twelve", "sixty-third"] as const;
const bistec6 = (m: MemoriaTools) => [linea(m, "bistec", 6, "maiz")];

export const GUIONES_EN: readonly GuionLlamada[] = [
  {
    id: "VEN01-delivery-steak-tacos-address-spoken",
    titulo: "Delivery of steak tacos in English, address spoken in words; the agent explains the orders of 3",
    rasgos: ["ingles", "numeros hablados", "direccion hablada", "pago en efectivo", "ordenes de tres"],
    sensibles: SENSIBLES,
    turnos: [
      { kind: "voz", cliente: "Hello, good afternoon, I would like to order some steak tacos for delivery please", agente: [dice("Good afternoon, thank you for calling Los Taquitos de PM. Of course. Which neighborhood is the delivery for?")] },
      {
        kind: "voz",
        cliente: "I'm in the Centro neighborhood",
        agente: [{ tool: "buscar_sucursal_cercana", args: { colonia: "Centro" } }, dice("The Francisco de Montejo branch will take your order. Steak tacos are sold only in orders of 3. How many would you like, and which tortilla: corn, flour or mixed?")],
      },
      {
        kind: "voz",
        cliente: "Six steak tacos with corn tortillas",
        agente: [
          buscar("bistec"),
          { tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, items: bistec6(m), canal: "domicilio", colonia_entrega: "Centro" }) },
          dice("That is two orders of three steak tacos on corn tortillas, three hundred twenty-eight pesos in total. Is that correct?"),
        ],
      },
      { kind: "voz", cliente: "Yes, that's right", agente: [confirmar, dice("Perfect. Could I have your name and the full delivery address, please?")] },
      { kind: "voz", cliente: DIRECCION_HABLADA, agente: [dice("Thank you. Will you pay with cash or card when it arrives?")] },
      {
        kind: "voz",
        cliente: "Cash please",
        agente: [
          { tool: "crear_pedido", args: (m) => ({ branch_slug: SUC, customer_name: "Ana Pech", items: bistec6(m), payment_method: "efectivo", canal: "domicilio", customer_address: DIRECCION, colonia_entrega: "Centro" }) },
          dice("Your order has been registered and sent to the kitchen. It should arrive in about forty minutes. Thank you for calling."),
        ],
      },
    ],
    esperado: {
      resultado: "pedido_creado",
      pedido: { sucursal: "Francisco de Montejo", canal: "domicilio", pago: "efectivo", total: 328, items: [{ nombre: "Tacos de Bistec de Res (orden de 3)", cantidad: 2 }], direccionIncluye: ["63", "412", "Centro"] },
    },
  },
  {
    id: "VEN02-pickup-beer-adult-confirmed-card",
    titulo: "Pickup in English with a beer: the agent asks for the adult confirmation and pays by card",
    rasgos: ["ingles", "para llevar", "alcohol solo a recoger", "pago con tarjeta"],
    turnos: [
      { kind: "voz", cliente: "Hi, I'd like two orders of al pastor tacos and a beer for pickup", agente: [dice("Good afternoon, I'm happy to help. Which branch will you pick it up at?")] },
      {
        kind: "voz",
        cliente: "The Francisco de Montejo one, I'll be there in twenty minutes",
        agente: [buscar("pastor"), buscar("cerveza"), dice("Thank you. Is the person picking up an adult, and which tortilla would you like: corn, flour or mixed?")],
      },
      {
        kind: "voz",
        cliente: "Yes, I'm over twenty-one, flour tortillas",
        agente: [
          { tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, canal: "recoger", adult_confirmed: true, payment_method: "tarjeta", items: [linea(m, "pastor", 6, "harina"), linea(m, "cerveza", 1)] }) },
          dice("That is six al pastor tacos and one Sol beer, three hundred six pesos in total, paying by card. Is that correct?"),
        ],
      },
      { kind: "voz", cliente: "Yes, correct", agente: [confirmar, dice("What name should I put the order under?")] },
      {
        kind: "voz",
        cliente: "Ana Pech, I'll pay by card at the branch",
        agente: [
          { tool: "crear_pedido", args: (m) => ({ branch_slug: SUC, customer_name: "Ana Pech", canal: "recoger", adult_confirmed: true, payment_method: "tarjeta", items: [linea(m, "pastor", 6, "harina"), linea(m, "cerveza", 1)] }) },
          dice("Your order has been registered for pickup. Thank you."),
        ],
      },
    ],
    esperado: {
      resultado: "pedido_creado",
      pedido: { sucursal: "Francisco de Montejo", canal: "recoger", pago: "tarjeta", total: 306, items: [{ nombre: "Tacos al Pastor (orden de 3)", cantidad: 2 }, { nombre: "Cerveza Sol", cantidad: 1 }] },
    },
  },
  {
    id: "VEN03-complaint-handoff-in-english",
    titulo: "The caller complains in English: the agent escalates with a Spanish summary for the team and promises nothing",
    rasgos: ["ingles", "queja", "handoff", "resumen para el equipo en espanol"],
    sensibles: SENSIBLES,
    turnos: [
      {
        kind: "voz",
        cliente: "Hello, my order from yesterday arrived cold and I want to speak to a manager",
        agente: [
          { tool: "escalar_a_humano", args: { customer_name: "Ana Pech", motivo: "queja", resumen: "Cliente que habla inglés reporta que su pedido de ayer llegó frío y pide hablar con el gerente." } },
          dice("I'm very sorry about that. I will pass your call to a person at the restaurant; if no one is available, they will call you back."),
        ],
      },
    ],
    esperado: { resultado: "escalado", sinPedido: true, callbacks: ["escalada:queja"] },
  },
];
