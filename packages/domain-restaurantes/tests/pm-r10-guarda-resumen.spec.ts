// QA-PM-R10 §6: crear_pedido rechaza si el cliente no ha visto el resumen (o si su ultimo mensaje es solo el pago o la propina), con salida en un turno si la heuristica de texto falla.
// Y los pasos 6 / 11 del prompt de WhatsApp. Deterministas, sin LLM: el efecto sobre el LLM real solo se mide en otra ronda.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentToolSafely, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { esRespuestaDePagoOPropina, resetOrderFlowWarningForTests, resumenVistoPorElCliente } from "../src/agent-tools/order-flow.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_AGENT_NAME_POR_OMISION, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Msg = { role: "user" | "assistant"; content: string };
const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

function setup(conHistorial = true, conSavepoint = false) {
  const f = buildRestaurantFixture();
  if (conSavepoint) {
    // Emula el SAVEPOINT de Postgres (`runWithSavepointFallback`): ante CUALQUIER excepcion restaura el estado del flujo, igual que ROLLBACK TO SAVEPOINT.
    const repo = f.repo as unknown as { orderFlows: Map<string, unknown>; runWithRowSavepoint: <T>(fn: () => Promise<T>) => Promise<T> };
    repo.runWithRowSavepoint = async <T>(fn: () => Promise<T>): Promise<T> => {
      const antes = new Map(repo.orderFlows);
      try {
        return await fn();
      } catch (err) {
        repo.orderFlows.clear();
        for (const [k, v] of antes) repo.orderFlows.set(k, v);
        throw err;
      }
    };
  }
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 0;
  const hist: Msg[] = [];
  const ctx = () => ({
    organizationId: f.organizationId,
    channel: conHistorial ? ("whatsapp" as const) : ("voz" as const),
    phone: "9991234567",
    flow: { key: "k:wa", turn: String(turn), now: () => Date.now() },
    ...(conHistorial ? { conversacionReciente: hist.slice(-30) } : {}),
  });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  const call = (tool: string, extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), tool, { ...base, ...extra });
  const snap = () => f.repo.readOrderFlow(f.organizationId, "k:wa");
  return {
    quote: () => call("cotizar_pedido", { payment_method: "efectivo", efectivo_con: 500 }),
    confirm: () => call("confirmar_resumen"),
    create: () => call("crear_pedido", { customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500 }),
    // Ruta real de produccion (llm-turn-handler): SAVEPOINT por tool call + errores de negocio convertidos en `{error}`.
    createSafe: () => executeAgentToolSafely(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500 }),
    total: async () => (await snap())?.context?.quotedTotal as number,
    // Nuevo turno: llega un mensaje del cliente.
    cliente: (t: string) => {
      turn += 1;
      hist.push({ role: "user", content: t });
    },
    asistente: (t: string) => void hist.push({ role: "assistant", content: t }),
    snap,
  };
}

describe("crear_pedido exige que el cliente haya visto el resumen", () => {
  it("pedido con pago pero sin resumen mostrado => rechazado con resumen_no_mostrado y NO crea", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote(); // cotizacion temprana
    s.asistente("¿Con cuánto paga?");
    s.cliente("con $500"); // respuesta de pago
    await s.confirm(); // el modelo confirma sin haber mostrado el resumen con el total
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" });
    expect((await s.snap())?.state).toBe("confirmado");
  });
  it("patron medido: el resumen estaba en el historial pero el ultimo mensaje es SOLO el pago => la respuesta de pago no es el sí", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Su pedido: 2 Coca-Cola. Total $${await s.total()}. ¿Con cuánto paga?`);
    s.cliente("con 500");
    await s.confirm();
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" });
  });
  it("tras rechazar por pago, el modelo muestra el resumen y el sí del turno siguiente crea", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Total $${await s.total()}. ¿Con cuánto paga?`);
    s.cliente("con 500");
    await s.confirm();
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" });
    s.asistente(`Resumen: 2 Coca-Cola, total $${await s.total()}, paga con 500. ¿Confirma?`);
    s.cliente("sí");
    expect((await s.create()).orderId).not.toBeNull();
  });
  it("resumen mostrado + sí => confirma y crea UN pedido", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora, pago con 500");
    await s.quote();
    s.asistente(`Su pedido: 2 Coca-Cola. Total $${await s.total()}. ¿Es correcto?`);
    s.cliente("sí");
    await s.confirm();
    expect((await s.create()).orderId).not.toBeNull();
  });
  it("heuristica con falso negativo (total en letras): se rechaza UNA vez y el turno siguiente sale", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente("Son dos Coca-Cola, el total es veinte pesos exactos. ¿Confirma?");
    s.cliente("sí");
    await s.confirm();
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" }); // 1er intento: se retrasa un turno
    s.asistente("Para confirmar: 2 Coca-Cola, total veinte pesos. ¿Es correcto?");
    s.cliente("sí, correcto");
    expect((await s.create()).orderId).not.toBeNull(); // 2o turno: sale
  });
  it("en el MISMO turno un reintento no esquiva la guarda (la salida exige un turno posterior)", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente("Listo, anotado.");
    s.cliente("sí");
    await s.confirm();
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" });
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" });
  });
  it("doble disparo tras resumen visto: un solo pedido", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Total $${await s.total()}. ¿Confirma?`);
    s.cliente("sí");
    await s.confirm();
    const rs = await Promise.allSettled([s.create(), s.create()]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(s.create()).rejects.toMatchObject({ code: "pedido_ya_creado" });
  });
  it("voz (sin historial): comportamiento previo intacto", async () => {
    const s = setup(false);
    s.cliente("x");
    await s.quote();
    s.cliente("sí");
    await s.confirm();
    expect((await s.create()).orderId).not.toBeNull();
  });
});

describe("ruta real de produccion (executeAgentToolSafely con SAVEPOINT que revierte ante excepciones)", () => {
  it("falso negativo del texto (total en letras): rechaza UNA vez y el turno siguiente crea, aun con el rollback del savepoint", async () => {
    const s = setup(true, true);
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente("Son dos Coca-Cola, el total es veinte pesos exactos. ¿Confirma?");
    s.cliente("sí");
    await s.confirm();
    const t1 = await s.createSafe();
    expect(t1.rechazoDelFlujo).toBe("resumen_no_mostrado");
    expect(t1.orderId).toBeNull();
    // mismo turno: no esquiva la guarda
    expect((await s.createSafe()).rechazoDelFlujo).toBe("resumen_no_mostrado");
    s.asistente("Para confirmar: 2 Coca-Cola, total veinte pesos. ¿Es correcto?");
    s.cliente("sí, correcto");
    const t2 = await s.createSafe();
    expect(t2.rechazoDelFlujo).toBeUndefined();
    expect(t2.orderId).not.toBeNull();
  });
  it("el marcador del rechazo SOBREVIVE al savepoint (queda en el flujo)", async () => {
    const s = setup(true, true);
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente("Listo.");
    s.cliente("sí");
    await s.confirm();
    await s.createSafe();
    expect((await s.snap())?.context?.resumenRechazadoTurn).toBe("2");
  });
  it("resumen fuera de la ventana de 30 mensajes: se retrasa un turno y sale", async () => {
    const s = setup(true, true);
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Resumen: total $${await s.total()}. ¿Confirma?`);
    // 30 mensajes de relleno empujan el resumen fuera de .slice(-30) (el mismo recorte de llm-turn-handler)
    for (let i = 0; i < 15; i++) {
      s.cliente(`mensaje ${i}`);
      s.asistente("ok");
    }
    s.cliente("sí");
    await s.confirm();
    expect((await s.createSafe()).rechazoDelFlujo).toBe("resumen_no_mostrado");
    s.cliente("sí, confirmo");
    expect((await s.createSafe()).orderId).not.toBeNull();
  });
  it("el pago/propina como ultimo mensaje se rechaza SIEMPRE, tambien despues de un rechazo previo (no es de un solo disparo)", async () => {
    const s = setup(true, true);
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Total $${await s.total()}. ¿Con cuánto paga?`);
    s.cliente("con 500");
    await s.confirm();
    expect((await s.createSafe()).rechazoDelFlujo).toBe("resumen_no_mostrado");
    s.asistente("¿Alguna propina?");
    s.cliente("no gracias");
    expect((await s.createSafe()).rechazoDelFlujo).toBe("resumen_no_mostrado");
    s.asistente(`Resumen: 2 Coca-Cola, total $${await s.total()}, paga con 500, sin propina. ¿Confirma?`);
    s.cliente("sí");
    expect((await s.createSafe()).orderId).not.toBeNull();
  });
  it("tras rechazo por total no visto (marcador puesto), un turno posterior con solo pago sigue rechazado", async () => {
    const s = setup(true, true);
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente("Listo, anotado.");
    s.cliente("sí");
    await s.confirm();
    expect((await s.createSafe()).rechazoDelFlujo).toBe("resumen_no_mostrado");
    s.asistente("¿Con cuánto paga?");
    s.cliente("con 500");
    expect((await s.createSafe()).rechazoDelFlujo).toBe("resumen_no_mostrado");
  });
  it("boton «Confirmar pedido» (entra como un si explicito) con el resumen visible => crea", async () => {
    const s = setup(true, true);
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Su pedido: 2 Coca-Cola. Total $${await s.total()}. ¿Confirma?`);
    s.cliente("Confirmar pedido");
    await s.confirm();
    expect((await s.createSafe()).orderId).not.toBeNull();
  });
  it("doble disparo concurrente por la ruta segura: un solo pedido", async () => {
    const s = setup(true, true);
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Total $${await s.total()}. ¿Confirma?`);
    s.cliente("sí");
    await s.confirm();
    const rs = await Promise.all([s.createSafe(), s.createSafe()]);
    expect(rs.filter((r) => r.orderId !== null)).toHaveLength(1);
  });
});

describe("heuristicas", () => {
  it("esRespuestaDePagoOPropina: pago y propina si; un si o una frase de pedido no", () => {
    for (const t of ["con $600", "Con 500", "600", "$250.50", "tarjeta", "en efectivo", "Sin propina", "no gracias", "propina de 20", "pago con tarjeta", "dejo 20 de propina"]) expect(esRespuestaDePagoOPropina(t), t).toBe(true);
    for (const t of ["sí", "sí, con 600", "dos tacos de pastor", "nada más", "confirmo", "", undefined]) expect(esRespuestaDePagoOPropina(t), String(t)).toBe(false);
  });
  it("resumenVistoPorElCliente: undefined sin historial; false si el ultimo mensaje es pago aunque el total este en el historial", () => {
    expect(resumenVistoPorElCliente(245, undefined)).toBeUndefined();
    const h: Msg[] = [{ role: "assistant", content: "Total $245" }];
    expect(resumenVistoPorElCliente(245, [...h, { role: "user", content: "sí" }])).toBe(true);
    expect(resumenVistoPorElCliente(245, [...h, { role: "user", content: "con 300" }])).toBe(false);
  });
});

describe("prompt de WhatsApp: pasos 6 y 11", () => {
  const sucursal = { propertyId: "p7", slug: "garcia-lavin", name: "García Lavín (Victory Platz)", address: null };
  const wa = buildPmSystemPrompt({
    businessName: "Los Taquitos de PM",
    agentName: PM_AGENT_NAME_POR_OMISION,
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas tardes",
    branches: [sucursal],
    entryBranch: { name: sucursal.name, slug: sucursal.slug },
    customer: { isNew: true },
    fechaHoraLocal: "6 de octubre de 2026, 13:00",
    diaSemana: "martes",
  });
  const paso = (n: string, sig: string) => {
    const i = wa.indexOf(`\n${n}. `);
    const j = wa.indexOf(`\n${sig}. `, i + 1);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    return wa.slice(i, j);
  };
  it("paso 6: la 2a y 3a cosa no manejada del mismo pedido tampoco se escala; solo insistir en la MISMA cosa", () => {
    const p6 = paso("6", "7");
    expect(p6).toMatch(/segunda o tercera cosa no manejada del MISMO pedido/);
    expect(p6).toMatch(/longaniza/);
    expect(p6).toMatch(/NO es insistir/);
    expect(p6).toMatch(/insistir es pedir la MISMA cosa otra vez/);
  });
  it("paso 11: pago/propina NO es el si, no crear en ese turno, y que hacer con resumen_no_mostrado", () => {
    const p11 = paso("11", "12");
    expect(p11).toMatch(/respuesta de pago o de propina/);
    expect(p11).toMatch(/NO es el sí/);
    expect(p11).toMatch(/nunca llame crear_pedido en el turno en que recibe el pago o la propina/);
    expect(p11).toMatch(/resumen_no_mostrado/);
  });
  it("coherente con H4 y 5b", () => {
    expect(wa).toMatch(/Varios productos no manejados en el mismo pedido se atienden igual/);
    expect(paso("5b", "6")).toMatch(/cuánto/i);
  });
});
