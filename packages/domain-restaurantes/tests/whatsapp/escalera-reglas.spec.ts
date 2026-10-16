// B04 (import-orig-04): la escalera barato -> caro sube de modelo solo ante un FALLO (error de sistema al crear el pedido, o argumentos que el modelo barato no
// supo armar), nunca ante un RECHAZO DE REGLA (`OrderValidationError`: minimo a domicilio, zona/politica de la sucursal, dia de reparto, cantidad, alcohol...):
// ahi la respuesta correcta es explicarlo y subir de modelo solo suma latencia y costo. Cada caso cuenta cuantas llamadas recibio cada escalon.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { seedConfirmedOrderFlow } from "../support/order-flow-seed.ts";
import { makeGateway, NEW_CUSTOMER } from "../pm/harness.ts";
import { pmFixture } from "../regresiones-original/fixture.ts";
import type { F } from "../regresiones-original/fixture.ts";

afterEach(() => {
  vi.useRealTimers();
});

const PHONE = "+5219990000077";
const comp = (partial: Partial<LlmCompletionResult>): LlmCompletionResult => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0, ...partial });
const llamada = (id: string, name: string, args: object) => comp({ toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }] });
const crearArgs = (f: F, extra: object = {}) => ({
  branch_slug: "t1-montejo",
  customer_name: "Marcela",
  canal: "domicilio",
  customer_address: "Calle 7 #210, Vista Alegre",
  items: [{ product_id: f.p.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }],
  payment_method: "efectivo",
  ...extra,
});

/** Dos escaleras (default/escalated) con un guion por indice de llamada; cuenta las llamadas de cada una. */
function turnoConGuion(f: F, guion: (n: number) => LlmCompletionResult) {
  const gateway = makeGateway();
  let n = 0;
  const llamadas = { default: 0, escalated: 0 };
  for (const rol of ["default", "escalated"] as const) {
    gateway.registerLadder(rol, [new FakeLlmProvider({ id: rol, script: () => { llamadas[rol] += 1; return guion(n++); } })]);
  }
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const turno = (contenido: string) => handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: contenido }], customer: NEW_CUSTOMER, propertyId: null });
  return { turno, llamadas };
}

async function sembrarFlujo(f: F, canal: "domicilio" | "recoger", productId = f.p.cocaCola, productName = "Coca-Cola", qty = 1) {
  await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "t1-montejo", canal, items: [{ productId, productName, requestedQuantity: qty }] });
}

describe("B04: un rechazo de regla NO sube al modelo caro", () => {
  it("pedido minimo a domicilio: el modelo barato explica el faltante y no hay llamadas al escalon caro", async () => {
    const f = pmFixture();
    f.repo.seedBranchPolicy(f.t1, { pedidoMinimoDomicilio: 200 });
    await sembrarFlujo(f, "domicilio");
    const { turno, llamadas } = turnoConGuion(f, (n) => (n === 0 ? llamada("c", "crear_pedido", crearArgs(f)) : comp({ text: "Le faltan $155 para el mínimo a domicilio, ¿desea agregar algo?" })));
    const r = await turno("confirmo");
    expect(r.orderId).toBeNull();
    expect(r.reply).toMatch(/mínimo/);
    expect(llamadas).toEqual({ default: 2, escalated: 0 });
  });

  it("sucursal solo recoger (politica de zona/servicio): se explica y no se escala", async () => {
    const f = pmFixture();
    f.repo.seedBranchPolicy(f.t1, { aceptaDomicilio: false });
    await sembrarFlujo(f, "domicilio");
    const { turno, llamadas } = turnoConGuion(f, (n) => (n === 0 ? llamada("c", "crear_pedido", crearArgs(f)) : comp({ text: "Esta sucursal solo atiende para recoger, ¿le parece?" })));
    const r = await turno("confirmo");
    expect(r.orderId).toBeNull();
    expect(llamadas).toEqual({ default: 2, escalated: 0 });
  });

  it("dia de reparto fuera de horario (solo entrega vie-dom y es martes): se explica y no se escala", async () => {
    const f = pmFixture();
    f.repo.seedBranchPolicy(f.t1, { diasDomicilio: [5, 6, 0] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T18:00:00Z")); // martes 12:00 en Merida
    await sembrarFlujo(f, "domicilio");
    const { turno, llamadas } = turnoConGuion(f, (n) => (n === 0 ? llamada("c", "crear_pedido", crearArgs(f)) : comp({ text: "A domicilio solo entregamos de viernes a domingo, ¿lo recoge?" })));
    const r = await turno("confirmo");
    expect(r.orderId).toBeNull();
    expect(llamadas).toEqual({ default: 2, escalated: 0 });
  });

  it("alcohol a domicilio (regla del negocio): se explica y no se escala", async () => {
    const f = pmFixture();
    f.repo.seedNoDomicilio({ categoryIds: [f.categorias.cervezas] });
    await sembrarFlujo(f, "domicilio", f.p.sol, "Sol", 6);
    const { turno, llamadas } = turnoConGuion(f, (n) =>
      n === 0 ? llamada("c", "crear_pedido", crearArgs(f, { adult_confirmed: true, items: [{ product_id: f.p.sol, product_name: "Sol", requested_quantity: 6 }] })) : comp({ text: "La cerveza no se vende a domicilio, ¿la recoge?" }),
    );
    const r = await turno("confirmo");
    expect(r.orderId).toBeNull();
    expect(llamadas).toEqual({ default: 2, escalated: 0 });
  });

  it("rechazos de la maquina de estados (crear sin confirmar) tampoco escalan: el modelo barato lee el error y corrige", async () => {
    const f = pmFixture(); // sin flujo sembrado: crear_pedido sin cotizar ni confirmar
    const { turno, llamadas } = turnoConGuion(f, (n) => (n === 0 ? llamada("c", "crear_pedido", crearArgs(f, { canal: "recoger" })) : comp({ text: "Permítame confirmar su pedido primero, ¿es correcto?" })));
    const r = await turno("confirmo");
    expect(r.orderId).toBeNull();
    expect(llamadas).toEqual({ default: 2, escalated: 0 });
  });
});

describe("B04: un FALLO sigue subiendo al modelo caro (T-FP06)", () => {
  it("error de sistema al crear el pedido (la base cae): el siguiente paso del turno usa el escalon caro", async () => {
    const f = pmFixture();
    await sembrarFlujo(f, "recoger");
    vi.spyOn(f.repo, "upsertCustomer").mockRejectedValue(new Error("base caida"));
    const { turno, llamadas } = turnoConGuion(f, (n) => (n === 0 ? llamada("c", "crear_pedido", crearArgs(f, { canal: "recoger" })) : comp({ text: "Un momento, ¿me confirma su pedido?" })));
    await turno("confirmo");
    expect(llamadas).toEqual({ default: 1, escalated: 1 });
  });

  it("argumentos que el modelo barato no supo armar (JSON roto) tambien suben al escalon caro", async () => {
    const f = pmFixture();
    await sembrarFlujo(f, "recoger");
    const { turno, llamadas } = turnoConGuion(f, (n) => (n === 0 ? comp({ toolCalls: [{ id: "c", name: "crear_pedido", argumentsJson: "{no es json" }] }) : comp({ text: "¿Me puede repetir su pedido?" })));
    await turno("confirmo");
    expect(llamadas).toEqual({ default: 1, escalated: 1 });
  });

  it("un rechazo de regla seguido de un fallo de sistema SI escala (el fallo cuenta aunque antes hubiera una regla)", async () => {
    const f = pmFixture();
    f.repo.seedBranchPolicy(f.t1, { pedidoMinimoDomicilio: 200 });
    await sembrarFlujo(f, "domicilio");
    vi.spyOn(f.repo, "upsertCustomer").mockRejectedValue(new Error("base caida"));
    const { turno, llamadas } = turnoConGuion(f, (n) => {
      if (n === 0) return llamada("a", "crear_pedido", crearArgs(f)); // regla: minimo
      if (n === 1) {
        f.repo.seedBranchPolicy(f.t1, {}); // el cliente agrego lo que faltaba: ya no hay regla que rechace, pero la base cae
        return llamada("b", "crear_pedido", crearArgs(f));
      }
      return comp({ text: "Un momento por favor." });
    });
    await turno("confirmo");
    expect(llamadas.escalated).toBe(1);
  });
});
