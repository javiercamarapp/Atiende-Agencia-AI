// PM ronda 21 (arreglos 1 y 2 del informe R20). Proveedor simulado, reloj simulado y repositorio en memoria: sin llaves ni gasto.
//
// H1: «el reintento de la llamada al modelo no actua en la 2.a y 3.a vuelta por falta de presupuesto». Se comprueba por vuelta, con el presupuesto por omision (18 s).
// H2: «tras `falla_sistema` el mensaje del cliente se pierde y el agente vuelve a preguntar ¿Que desea pedir?».
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { CIERRE_MAQUINA_ENV } from "../../src/agent-tools/cierre-maquina.ts";
import { resetOrderFlowWarningForTests } from "../../src/agent-tools/order-flow.ts";
import { TURN_BUDGET_POR_OMISION_MS, createLlmWhatsAppTurnHandler, planTopeLlamadaLlm } from "../../src/whatsapp/llm-turn-handler.ts";
import { FUNCION_MAX_MS, MARGEN_CIERRE_TURNO_MS } from "../../src/whatsapp/inbound.ts";
import { bloquePedidoPendienteTrasFalla, esAvisoDeFallaDelSistema, mensajesPerdidosPorFalla } from "../../src/whatsapp/falla-pendiente.ts";
import { PM_COPY } from "../../src/whatsapp/perfil-pm.ts";
import { MODELO_ALTERNO_TOPE_ID, MODELO_PREDETERMINADO_ID } from "../../src/ajustes-agente/modelos.ts";
import { hashTelefonoParaLogs } from "../../src/whatsapp/observabilidad-turno.ts";
import type { EventoObservabilidadWhatsApp, EventoTurnoWhatsApp } from "../../src/whatsapp/observabilidad-turno.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { seedConfirmedOrderFlow } from "../support/order-flow-seed.ts";
import { itemsCoca, llamada, ordenes, pasoDelTurno, texto } from "../pm-r11-romper/arnes.ts";

const PHONE = "+5219991234567";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };
const COLGADA = (): Promise<LlmCompletionResult> => new Promise(() => undefined);
const LUNA = MODELO_PREDETERMINADO_ID;
const esperar = (ms: number) => new Promise((res) => setTimeout(res, ms));

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.stubEnv(CIERRE_MAQUINA_ENV, "");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Msg = { role: "user" | "assistant"; content: string };
type Guion = (n: number, modelo: string, request: LlmCompletionRequest) => LlmCompletionResult | Promise<LlmCompletionResult>;

async function armar(script: Guion, f = buildRestaurantFixture(), turnBudgetMs = TURN_BUDGET_POR_OMISION_MS) {
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const intentos: Array<{ en: number; modelo: string; request: LlmCompletionRequest }> = [];
  const t0 = Date.now();
  const proveedor = (modelo: string) => new FakeLlmProvider({ id: modelo, model: modelo, script: (request) => { const n = intentos.length; intentos.push({ en: Date.now() - t0, modelo, request }); return script(n, modelo, request); } });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [proveedor(LUNA), proveedor(MODELO_ALTERNO_TOPE_ID)]);
  gateway.registerLadder("escalated", [proveedor("escalado/modelo")]);
  const eventos: EventoObservabilidadWhatsApp[] = [];
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", turnBudgetMs, observabilidad: { emitir: (e) => void eventos.push(e), hashTelefono: (t) => hashTelefonoParaLogs(t, "llave") } });
  const correr = async (messages: Msg[]) => {
    const p = handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages, customer: { isNew: true }, propertyId: null });
    await vi.advanceTimersByTimeAsync(turnBudgetMs + 5_000);
    return p;
  };
  return { f, intentos, eventos, correr };
}
const turno = (e: EventoObservabilidadWhatsApp[]) => e.filter((x): x is EventoTurnoWhatsApp => x.evento === "whatsapp_turno").at(-1)!;

describe("H1: presupuesto del reintento por vuelta (18 s)", () => {
  it("el presupuesto por omision sale de la funcion: 30 - 6 - 6 = 18 s, con 12 s de holgura bajo el tope de la funcion (el p95 del turno es el reloj de 18 s)", () => {
    expect(TURN_BUDGET_POR_OMISION_MS).toBe(18_000);
    expect(FUNCION_MAX_MS - TURN_BUDGET_POR_OMISION_MS).toBe(12_000);
    expect(MARGEN_CIERRE_TURNO_MS).toBe(6_000);
  });

  // Tabla de la verificacion: vuelta k arranca cuando ya se gastaron `gastado` s del reloj (llamadas de ~3.5 s, mediana medida, mas herramientas).
  it.each([
    { vuelta: 1, gastado: 0, respalda: true },
    { vuelta: 2, gastado: 3_500, respalda: true },
    { vuelta: 3, gastado: 7_000, respalda: true },
    { vuelta: 4, gastado: 10_500, respalda: false },
  ])("vuelta $vuelta (gastado $gastado ms): respalda=$respalda", ({ gastado, respalda }) => {
    expect(planTopeLlamadaLlm(TURN_BUDGET_POR_OMISION_MS - gastado).respalda).toBe(respalda);
  });

  it("atasco en la 3.a vuelta (2 llamadas de 3.5 s antes): hay respaldo y el cliente recibe respuesta, no «problema tecnico»", async () => {
    const m = await armar(async (_n, modelo, req) => {
      const paso = pasoDelTurno(req);
      if (paso <= 1) { await esperar(3_500); return llamada("consultar_sucursal", { branch_slug: "fco-montejo" }, `c${paso}`); }
      return modelo === LUNA ? COLGADA() : texto("Abrimos a las 9.");
    });
    const r = await m.correr([{ role: "user", content: "a que hora abren" }]);
    expect(r.reply).toContain("Abrimos");
    const t = turno(m.eventos);
    expect(t.resultado).toBe("ok");
    expect(t.reintentoLlmRecuperado).toBe(true);
    expect(t.latenciaTotalMs).toBeLessThanOrEqual(TURN_BUDGET_POR_OMISION_MS);
  });

  it("peor caso: ambos modelos atascados en la 1.a vuelta; el turno cierra en el reloj (18 s), sin pasar el tope de la funcion", async () => {
    const m = await armar(() => COLGADA());
    await m.correr([{ role: "user", content: "hola" }]);
    expect(turno(m.eventos).causaError).toBe("tope_llamada");
    expect(turno(m.eventos).latenciaTotalMs).toBeLessThanOrEqual(TURN_BUDGET_POR_OMISION_MS + 500);
    expect(turno(m.eventos).latenciaTotalMs + MARGEN_CIERRE_TURNO_MS).toBeLessThan(FUNCION_MAX_MS);
  });
});

describe("H2: el mensaje del cliente que cayo en falla_sistema", () => {
  const PEDIDO = "Quiero 2 cocas para recoger, a nombre de Ana";
  const historia: Msg[] = [{ role: "user", content: PEDIDO }, { role: "assistant", content: PM_COPY.sinAsistenteAvisoEquipo }, { role: "user", content: "hola? sigue ahi" }];

  it("el historial SI conserva el mensaje fallido (no se pierde), pero nada le dice al modelo que quedo sin atender: el bloque del servidor lo marca", async () => {
    const m = await armar(() => texto("Con gusto, 2 cocas para recoger a nombre de Ana. ¿Confirma?"));
    await m.correr(historia);
    const req = m.intentos[0]!.request;
    expect(req.messages.map((x) => x.content)).toContain(PEDIDO); // el contexto lo trae
    expect(req.system).toContain("falla previa del sistema"); // y ahora el servidor dice que NO fue atendido
    expect(req.system).toMatch(/no le vuelva a preguntar/i);
  });

  it("sin falla previa (la ultima respuesta fue del modelo) el prompt NO cambia", async () => {
    const m = await armar(() => texto("ok"));
    await m.correr([{ role: "user", content: PEDIDO }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }]);
    expect(m.intentos[0]!.request.system).not.toContain("falla previa del sistema");
  });

  it("detecta el aviso solo si es la ULTIMA respuesta del agente, y toma los mensajes entre la respuesta previa y el aviso", () => {
    const h: Msg[] = [{ role: "user", content: "hola" }, { role: "assistant", content: "Bienvenido" }, { role: "user", content: "2 gringas" }, { role: "user", content: "de bistec" }, { role: "assistant", content: PM_COPY.problemaTecnico }, { role: "user", content: "?" }];
    expect(mensajesPerdidosPorFalla(h).map((x) => x.content)).toEqual(["2 gringas", "de bistec"]);
    expect(mensajesPerdidosPorFalla([...h.slice(0, 5), { role: "assistant", content: "Listo" }, { role: "user", content: "gracias" }])).toEqual([]);
    expect(esAvisoDeFallaDelSistema("Total $90")).toBe(false);
    expect(bloquePedidoPendienteTrasFalla([{ role: "user", content: "hola" }])).toBe("");
  });

  it("el bloque no cita ni copia texto del cliente (no abre una via de inyeccion al prompt de sistema)", () => {
    expect(bloquePedidoPendienteTrasFalla(historia)).not.toContain("Ana");
  });
});

describe("H2: reanudar tras la falla NO duplica pedidos (rafagas)", () => {
  const sembrar = async () => {
    const f = buildRestaurantFixture();
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }] });
    return f;
  };
  const crear = (f: ReturnType<typeof buildRestaurantFixture>, id: string) => llamada("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: itemsCoca(f, 2) }, id);
  const falla: Msg = { role: "assistant", content: PM_COPY.sinAsistenteAvisoEquipo };

  it("rafaga «si», «si», «si» tras la falla con un modelo que insiste en crear_pedido en cada vuelta: un solo pedido", async () => {
    const f = await sembrar();
    const m = await armar((_n, _modelo, req) => (pasoDelTurno(req) < 3 ? crear(f, `c${pasoDelTurno(req)}`) : texto("Listo.")), f);
    const r = await m.correr([{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }, falla, { role: "user", content: "si" }, { role: "user", content: "si" }, { role: "user", content: "si" }]);
    const creadas = await ordenes(f);
    expect(creadas.length).toBeLessThanOrEqual(1);
    expect(r.orderId === null || r.orderId === creadas[0]!.id).toBe(true);
  });

  it("dos turnos seguidos (la misma rafaga reentregada): en total un pedido", async () => {
    const f = await sembrar();
    const m = await armar((_n, _modelo, req) => (pasoDelTurno(req) === 0 ? crear(f, "c0") : texto("Listo.")), f);
    const h: Msg[] = [{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }, falla, { role: "user", content: "si" }];
    await m.correr(h);
    await m.correr([...h, { role: "assistant", content: "Listo." }, { role: "user", content: "si" }, { role: "user", content: "si" }]);
    expect((await ordenes(f)).length).toBe(1);
  });

  it("falla del proveedor en el turno del «si» con resumen vigente: el servidor cierra UNA vez y el reintento del cliente no crea otro", async () => {
    const f = await sembrar();
    const m = await armar(() => COLGADA(), f);
    const h: Msg[] = [{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }];
    await m.correr(h);
    const tras = (await ordenes(f)).length;
    await m.correr([...h, { role: "assistant", content: PM_COPY.sinAsistenteAvisoEquipo }, { role: "user", content: "si" }, { role: "user", content: "si" }]);
    expect((await ordenes(f)).length).toBe(tras);
    expect(tras).toBeLessThanOrEqual(1);
  });
});
