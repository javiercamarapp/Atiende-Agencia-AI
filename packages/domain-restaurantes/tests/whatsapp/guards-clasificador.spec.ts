// QA R1 agentes-01 / viaje-01,02,03,07: el clasificador de alto riesgo corre ANTES del modelo, asi que un falso positivo deja al cliente sin
// agente (abre handoff y el agente calla) y un falso negativo deja pasar una queja real. Estas pruebas fijan la matriz con y sin acento.
import { describe, expect, it } from "vitest";
import { classifyHighRiskIntent, contextoDeCliente, matchesHighRiskOtherThan, normalizarParaClasificar } from "../../src/whatsapp/guards.ts";
import type { PedidoReciente } from "../../src/pedido-reciente.ts";
import type { CustomerLookupResult } from "../../src/types.ts";

const pedido = (estado: PedidoReciente["estado"]): PedidoReciente => ({ estado, canal: "recoger", sucursal: "T7", confirmadoHoraLocal: "14:00", minutosDesdeConfirmacion: 30 });
const conocido = (pedidoReciente: PedidoReciente | null): CustomerLookupResult => ({ isNew: false, name: "Cliente", orderCount: 3, addresses: [], lastOrderItems: null, frequentItems: [], tier: null, agentNotes: [], pedidoReciente });

describe("clasificador de alto riesgo: ajustes del carrito NO escalan", () => {
  const alCarrito = [
    "ah me falto pedir otra coca",
    "ah me faltó pedir otra coca",
    "AH ME FALTÓ PEDIRLE DOS COCAS",
    "me falto agregar una orden de frijoles",
    "cancela la orden de gringas y mejor ponme unos nachos",
    "no, cancela la orden de bistec y mejor ponme 6 de pastor",
    "cancela la comanda de nachos",
    "Hola, quiero medio kilo de pastor, lo necesito urgente porfa",
    "es urgente porfa tengo una fiesta, mejor que sean 20 de pastor",
    "lo quiero urgente: 3 de pastor para recoger",
  ];
  for (const frase of alCarrito) it(`'${frase}' va al agente`, () => expect(classifyHighRiskIntent(frase), frase).toBeNull());

  it("quiero cambiar el pedido que armo ('cancela el pedido de gringas, mejor nachos') solo escala si ya hay un pedido creado", () => {
    const frase = "cancela el pedido de gringas, mejor nachos";
    expect(classifyHighRiskIntent(frase, contextoDeCliente(conocido(null)))).toBeNull();
    expect(classifyHighRiskIntent(frase, contextoDeCliente(conocido(pedido("preparando"))))?.motivo).toBe("cancelacion_modificacion");
  });
});

describe("clasificador de alto riesgo: lo real SI escala, con o sin acento", () => {
  const casos: Array<[string, string]> = [
    ["Oiga me faltó la bebida de mi pedido de hace rato", "queja"],
    ["Oiga me falto la bebida de mi pedido de hace rato", "queja"],
    ["me llegó frío todo", "queja"],
    ["me llego frio todo", "queja"],
    ["quiero cancelar mi pedido", "cancelacion_modificacion"],
    ["QUIERO CANCELAR MI PEDIDO", "cancelacion_modificacion"],
    ["cancela el pedido de hace rato", "cancelacion_modificacion"],
    ["Es urgente, necesito mi pedido", "urgencia"],
    ["es urgente ya viene mi pedido?", "urgencia"],
    ["soy alérgico al cacahuate", "alergia_salud"],
    ["soy alergico al cacahuate", "alergia_salud"],
    ["me cobraron dos veces", "cobro_duplicado"],
    ["pagaré por depósito", "transferencia"],
    ["quiero hablar con una persona", "cliente_lo_pide"],
  ];
  for (const [frase, motivo] of casos) it(`'${frase}' -> ${motivo}`, () => expect(classifyHighRiskIntent(frase)?.motivo, frase).toBe(motivo));

  it("'me faltó la bebida' sin decir de que pedido solo es queja si el ultimo pedido ya salio o se entrego", () => {
    const frase = "me faltó la bebida";
    expect(classifyHighRiskIntent(frase)).toBeNull();
    expect(classifyHighRiskIntent(frase, contextoDeCliente(conocido(pedido("preparando"))))).toBeNull();
    expect(classifyHighRiskIntent(frase, contextoDeCliente(conocido(pedido("entregado"))))?.motivo).toBe("queja");
    expect(classifyHighRiskIntent(frase, contextoDeCliente(conocido(pedido("salio"))))?.motivo).toBe("queja");
  });

  it("'me faltó pedir' NUNCA es queja, aunque el pedido ya se haya entregado", () => {
    expect(classifyHighRiskIntent("me faltó pedir otra coca", contextoDeCliente(conocido(pedido("entregado"))))).toBeNull();
  });

  it("el motivo de mayor riesgo gana cuando el mensaje mezcla varios (alergia sobre queja)", () => {
    expect(classifyHighRiskIntent("me faltó la bebida de mi pedido y soy alérgico al gluten")?.motivo).toBe("alergia_salud");
  });
});

describe("normalizacion y compatibilidad", () => {
  it("normalizarParaClasificar quita acentos y mayusculas", () => expect(normalizarParaClasificar("ME FALTÓ Alérgico")).toBe("me falto alergico"));
  it("matchesHighRiskOtherThan sigue distinguiendo ARCO de otros motivos (con acento tambien)", () => {
    expect(matchesHighRiskOtherThan("quiero que borren mis datos", "privacidad_arco")).toBe(false);
    expect(matchesHighRiskOtherThan("borren mis datos, soy alérgico", "privacidad_arco")).toBe(true);
  });
  it("contextoDeCliente: cliente nuevo = desconocido; conocido sin pedido = null", () => {
    expect(contextoDeCliente({ isNew: true })).toEqual({});
    expect(contextoDeCliente(conocido(null)).pedidoReciente).toBeNull();
  });
});
