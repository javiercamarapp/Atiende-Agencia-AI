// QA-PM R12 (A13 y A10 de Luna r1): dos defectos de pedido/dinero del agente real, reproducidos de forma determinista (sin LLM, con las frases EXACTAS de las transcripciones).
//  A13: tras el resumen el cliente contesto «No, quiero a $10, así dice la promo. Cobrámelos a ese precio porfa.» y el pedido se creo por $126: `rechazaElResumen` no cubria esa frase
//       (la coma rompia «no quiero») y `crear_pedido` no volvia a revisar el rechazo (con la maquina de cierre apagada solo `confirmar_resumen` lo hacia).
//  A10: el cliente contesto «sí, es correcto» a una pregunta de TORTILLA / PAGO (el mensaje del asistente traia el total pero no era un resumen para confirmar) y se creo el pedido con
//       una tortilla que el cliente nunca eligio: la guarda de `crear_pedido` daba por visto el resumen con solo ver el total en el historial.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentToolSafely, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { clasificarRespuestaCierre } from "../src/agent-tools/cierre-maquina.ts";
import { asistentePidioDatoPendiente, esAfirmacionSola, rechazaElResumen, resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Msg = { role: "user" | "assistant"; content: string };
const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

function setup(opciones: { sinMigrar?: boolean } = {}) {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  if (opciones.sinMigrar) {
    // Base sin migrar (SQLSTATE 42P01): el repositorio real devuelve null al leer y "unavailable" al escribir; el agente cae al camino anterior sin maquina de estados.
    const repo = f.repo as unknown as { readOrderFlow: () => Promise<null>; writeOrderFlow: () => Promise<string> };
    repo.readOrderFlow = async () => null;
    repo.writeOrderFlow = async () => "unavailable";
  }
  let turn = 0;
  const hist: Msg[] = [];
  const ctx = () => ({
    organizationId: f.organizationId,
    channel: "whatsapp" as const,
    phone: "9991234567",
    flow: { key: "k:wa", turn: String(turn), now: () => Date.now() },
    conversacionReciente: hist.slice(-30),
  });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  const call = (tool: string, extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), tool, { ...base, ...extra });
  const snap = () => f.repo.readOrderFlow(f.organizationId, "k:wa");
  return {
    quote: () => call("cotizar_pedido", { payment_method: "efectivo", efectivo_con: 500 }),
    confirm: () => call("confirmar_resumen"),
    create: () => call("crear_pedido", { customer_name: "Carlos", payment_method: "efectivo", efectivo_con: 500 }),
    createSafe: () => executeAgentToolSafely(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Carlos", payment_method: "efectivo", efectivo_con: 500 }),
    total: async () => (await snap())?.context?.quotedTotal as number,
    cliente: (t: string) => {
      turn += 1;
      hist.push({ role: "user", content: t });
    },
    asistente: (t: string) => void hist.push({ role: "assistant", content: t }),
    snap,
  };
}

// Frases EXACTAS de las transcripciones de la ronda 12 (A13 Luna r1).
const A13_RECHAZO_1 = "No, quiero a $10, así dice la promo. Cobrámelos a ese precio porfa.";
const A13_RECHAZO_0 = "No, quiero a $10, así dice la promo. De maíz, a nombre de Carlos; pago en efectivo.";

const RECHAZOS = [
  A13_RECHAZO_1,
  A13_RECHAZO_0,
  "No, quiero a $10",
  "no, quiero a $10 cada uno",
  "No, quiero a $10, así dice la promo.",
  "no, mejor por $100",
  "no ese no",
  "No, ese no",
  "cámbialo",
  "Cámbialo porfa",
  "quiero otro monto",
  "quiero cambiar el total",
  "no gracias, es mucho",
  "No gracias, está muy caro",
  "espera, no",
  "Espera, no así",
  "mejor no",
  "Mejor no, gracias",
  "no, prefiero 4 tacos",
  "No, yo quiero 4",
  "no, son 4 tacos",
  "no, a $10",
  "cóbramelos a $10",
  "Cóbrame $10 por los 3, porfa.",
  "cobrame a ese precio",
  "quiero a $10 cada taco",
  "no me convence el precio",
  "no es lo que pedí",
  "No, corrígelo",
  "no, quiero que sea con tarjeta",
  "No, quiero otro precio",
  "ese precio no",
  "eso no",
  "eso no, quiero a $10",
];

// Precision primero: NO son rechazo del resumen.
const NO_RECHAZOS = [
  "Sí",
  "Sí, quiero a $10 más",
  "sí, quiero a $10 de propina",
  "No, gracias",
  "no gracias",
  "No, gracias, es todo",
  "No hay problema",
  "sí, no hay problema",
  "no tengo cambio",
  "No quiero propina",
  "no quiero propina, gracias",
  "no, nada más",
  "no, eso es todo",
  "No, así está bien",
  "no, está bien así",
  "Sí, confirmo",
  "va, cámbialo todo a efectivo, sí",
  "ok, dale",
  "perfecto, quiero a $10 de cambio",
  "Efectivo",
  "con 500",
  "paso en 40 minutos",
  "no pasa nada",
  "el total es mucho pero está bien, sí",
];

describe("R12 A13: rechazaElResumen cubre los rechazos y cambios de monto mexicanos", () => {
  it.each(RECHAZOS)("rechaza: %s", (t) => expect(rechazaElResumen(t)).toBe(true));
  it.each(NO_RECHAZOS)("NO rechaza: %s", (t) => expect(rechazaElResumen(t)).toBe(false));
  it("hay al menos 25 variantes de rechazo y 15 de no rechazo", () => {
    expect(RECHAZOS.length).toBeGreaterThanOrEqual(25);
    expect(NO_RECHAZOS.length).toBeGreaterThanOrEqual(15);
  });
});

describe("R12 A13: clasificarRespuestaCierre no toma por «si» ni por dato el rechazo", () => {
  it.each([A13_RECHAZO_1, A13_RECHAZO_0, "No, quiero a $10", "mejor no"])("%s -> no", (t) => {
    expect(clasificarRespuestaCierre(t, { despuesDelResumen: true, total: 126 })).toBe("no");
  });
  it("«cámbialo» es un cambio (tampoco confirma)", () => {
    expect(clasificarRespuestaCierre("cámbialo", { despuesDelResumen: true, total: 126 })).toBe("cambio");
  });
});

describe("R12 A13: el pedido NO se crea tras «No, quiero a $10...» (maquina de cierre apagada, como en el arnes)", () => {
  it("confirmar_resumen rechaza la frase exacta", async () => {
    const s = setup();
    s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
    await s.quote();
    s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. Paga con 500. ¿Es correcto o desea agregar algo más?`);
    s.cliente(A13_RECHAZO_1);
    await expect(s.confirm()).rejects.toMatchObject({ code: "cliente_rechazo_resumen" });
  });
  it("crear_pedido tambien rechaza aunque el modelo ya hubiera confirmado antes del rechazo", async () => {
    const s = setup();
    s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
    await s.quote();
    s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. Paga con 500. ¿Es correcto?`);
    s.cliente("sí");
    await s.confirm();
    s.asistente("Perfecto, ¿algo más?");
    s.cliente(A13_RECHAZO_1);
    await expect(s.create()).rejects.toMatchObject({ code: "cliente_rechazo_resumen" });
    expect((await s.snap())?.state).toBe("confirmado");
  });
  it("por la ruta real de produccion el rechazo vuelve como resultado {error} y no hay pedido", async () => {
    const s = setup();
    s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
    await s.quote();
    s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. ¿Es correcto?`);
    s.cliente("sí");
    await s.confirm();
    s.asistente("Perfecto, ¿algo más?");
    s.cliente(A13_RECHAZO_1);
    const r = await s.createSafe();
    expect(r.orderId).toBeNull();
    expect(r.rechazoDelFlujo).toBe("cliente_rechazo_resumen");
  });
  it("contra una base SIN MIGRAR (sin maquina de estados) crear_pedido tambien rechaza el rechazo", async () => {
    const s = setup({ sinMigrar: true });
    s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
    s.asistente("Su pedido: 3 Coca-Cola. Total $126. ¿Es correcto?");
    s.cliente(A13_RECHAZO_1);
    await expect(s.create()).rejects.toMatchObject({ code: "cliente_rechazo_resumen" });
  });
  it("sin falso positivo: «Sí, quiero a $10 más de propina» tras el resumen SI crea", async () => {
    const s = setup();
    s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
    await s.quote();
    s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. ¿Es correcto?`);
    s.cliente("Sí, quiero a $10 más de propina");
    await s.confirm();
    expect((await s.create()).orderId).not.toBeNull();
  });
  it("tras el rechazo, el resumen corregido y un «sí» de un turno posterior crean el pedido", async () => {
    const s = setup();
    s.cliente("Pásame 3 tacos para recoger, a nombre de Carlos, efectivo");
    await s.quote();
    s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. ¿Es correcto?`);
    s.cliente(A13_RECHAZO_1);
    await expect(s.confirm()).rejects.toMatchObject({ code: "cliente_rechazo_resumen" });
    await s.quote();
    s.asistente(`El precio vigente es el del menú: 3 Coca-Cola, total $${await s.total()}. ¿Lo dejo así?`);
    s.cliente("Sí, está bien");
    await s.confirm();
    expect((await s.create()).orderId).not.toBeNull();
  });
});

describe("R12 A10: un «sí» a una pregunta de tortilla / pago NO es el sí al resumen", () => {
  // Transcripcion A10 Luna r1: el asistente dio el total ($126) pero cerro preguntando tortilla y pago; el cliente contesto «sí, es correcto»; se creo el pedido.
  const PREGUNTA_PENDIENTE = (total: number) =>
    `El precio vigente es de $42 por taco; tres suman $${total}. Para recoger hoy martes, también aplica la promoción de nachos de pastor. ¿Desea agregar una orden de nachos?\n\nPara continuar, ¿qué tortilla prefiere para los tacos: maíz, harina o mixta? ¿Con cuánto pagará en efectivo?`;

  it("sí, es correcto tras la pregunta de tortilla/pago => crear_pedido NO crea (resumen_no_mostrado)", async () => {
    const s = setup();
    s.cliente("Soy el dueño. Quiero 3 tacos de pastor para recoger");
    await s.quote();
    s.asistente(PREGUNTA_PENDIENTE(await s.total()));
    s.cliente("sí, es correcto");
    await s.confirm();
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" });
    expect((await s.snap())?.state).toBe("confirmado");
  });
  it("ruta real: se retrasa UN turno; con resumen real + sí del turno siguiente si crea", async () => {
    const s = setup();
    s.cliente("Soy el dueño. Quiero 3 tacos de pastor para recoger");
    await s.quote();
    s.asistente(PREGUNTA_PENDIENTE(await s.total()));
    s.cliente("sí, es correcto");
    await s.confirm();
    const r1 = await s.createSafe();
    expect(r1.rechazoDelFlujo).toBe("resumen_no_mostrado");
    expect(r1.orderId).toBeNull();
    s.asistente(`Resumen: 3 Coca-Cola, tortilla de maíz, paga con 500, total $${await s.total()}. ¿Es correcto?`);
    s.cliente("sí, es correcto");
    const r2 = await s.createSafe();
    expect(r2.orderId).not.toBeNull();
  });
  it.each([
    ["¿Qué tortilla prefiere: maíz, harina o mixta?"],
    ["¿Con cuánto pagará en efectivo?"],
    ["¿A nombre de quién registro el pedido?"],
    ["¿Cuánto tiempo tarda en pasar a recoger?"],
    ["¿Desea agregar propina?"],
  ])("pregunta pendiente %j => asistentePidioDatoPendiente", (q) => expect(asistentePidioDatoPendiente(`Tres suman $126. ${q}`)).toBe(true));
  it.each([["Resumen: 3 tacos, total $126. ¿Es correcto o desea agregar algo más?"], ["Total $126. ¿Confirma?"], ["Total $126. ¿Lo registro así?"], ["Listo, anotado."], [""]])(
    "NO es pregunta pendiente: %j",
    (txt) => expect(asistentePidioDatoPendiente(txt)).toBe(false),
  );
  it("resumen para confirmar (¿Es correcto?) + «sí» => crea sin retraso (sin falso positivo)", async () => {
    const s = setup();
    s.cliente("Quiero 3 cocas para recoger, a nombre de Carlos, pago con 500");
    await s.quote();
    s.asistente(`Su pedido: 3 Coca-Cola. Total $${await s.total()}. Paga con 500. ¿Es correcto?`);
    s.cliente("sí, es correcto");
    await s.confirm();
    expect((await s.createSafe()).orderId).not.toBeNull();
  });
});

describe("R12 A10: la guarda solo aplica a un «sí» a secas (regresion vista en CI: whatsapp-llm-agent)", () => {
  it.each(["sí", "Sí, es correcto", "sí, correcto", "ok", "dale", "Confirmo", "claro que sí", "va, perfecto", "👍", "sí por favor"])("afirmacion sola: %s", (t) => expect(esAfirmacionSola(t)).toBe(true));
  it.each(["efectivo, soy Fulano, paso por él", "sí, con tarjeta", "sí, de maíz", "sí, a nombre de Carlos", "con 500", "no", "sí, pero cámbialo", "", "quiero 3 tacos y que sean de bistec con harina por favor sí"])("NO es afirmacion sola: %j", (t) =>
    expect(esAfirmacionSola(t)).toBe(false),
  );
  it("el cliente CONTESTA la pregunta de pago con datos («efectivo, soy Carlos») => crea (no es un sí a secas)", async () => {
    const s = setup();
    s.cliente("Quiero 3 cocas para recoger");
    await s.quote();
    s.asistente(`Tu pedido es 3 Coca-Cola por $${await s.total()}. ¿Pagas con efectivo o tarjeta?`);
    s.cliente("efectivo, soy Carlos, paso en 30 minutos");
    await s.confirm();
    expect((await s.createSafe()).orderId).not.toBeNull();
  });
});
