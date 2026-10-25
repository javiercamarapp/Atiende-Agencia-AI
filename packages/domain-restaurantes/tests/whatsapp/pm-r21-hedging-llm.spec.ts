// PM-R21 (por que se cae el modelo): hedging de la llamada al LLM en el turno de WhatsApp. En R20, 113 de 1437 turnos terminaron en `error_proveedor`
// (todos `tope_llamada`); en 71 el respaldo SECUENCIAL de R19 (cortar a los 9-11 s y llamar al alterno con <= 7 s) tambien se quedo sin contestar. Con el
// hedging el alterno se lanza EN PARALELO a los 5.5 s y gana el primero que conteste. Modelos simulados y reloj simulado: sin llaves ni gasto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, OpenRouterError } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { CIERRE_MAQUINA_ENV } from "../../src/agent-tools/cierre-maquina.ts";
import { resetOrderFlowWarningForTests } from "../../src/agent-tools/order-flow.ts";
import {
  createLlmWhatsAppTurnHandler,
} from "../../src/whatsapp/llm-turn-handler.ts";
import { HEDGES_MAX_POR_TURNO } from "../../src/whatsapp/llm-turn-handler.ts";
import { MODELO_ALTERNO_SEGUNDO_TOPE_ID, MODELO_ALTERNO_TOPE_ID, MODELO_PREDETERMINADO_ID } from "../../src/ajustes-agente/modelos.ts";
import { hashTelefonoParaLogs } from "../../src/whatsapp/observabilidad-turno.ts";
import type { EventoObservabilidadWhatsApp, EventoTurnoWhatsApp, EventoToolWhatsApp, ObservabilidadTurno } from "../../src/whatsapp/observabilidad-turno.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { itemsCoca, llamada, ordenes, pasoDelTurno, texto } from "../pm-r11-romper/arnes.ts";

const PHONE = "+5219991234567";
const NEW_CUSTOMER = { isNew: true } as const;
const COLGADA = (): Promise<LlmCompletionResult> => new Promise(() => undefined); // nunca responde (ignora la senal: el tope la corta igual)
const LUNA = MODELO_PREDETERMINADO_ID;
const DEEPSEEK = MODELO_ALTERNO_TOPE_ID;
const FLASH_LITE = MODELO_ALTERNO_SEGUNDO_TOPE_ID;

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.stubEnv(CIERRE_MAQUINA_ENV, "");
  vi.stubEnv("WHATSAPP_LLM_HEDGE_MS", "5500");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

interface Intento {
  readonly en: number;
  readonly modelo: string;
  readonly request: LlmCompletionRequest;
}
type Guion = (n: number, modelo: string, request: LlmCompletionRequest) => LlmCompletionResult | Promise<LlmCompletionResult>;

/** Handler con la escalera aprobada simulada (Luna -> DeepSeek -> Flash-Lite) y un guion que ve el numero de intento global, el modelo que contesta y el request. */
function armar(script: Guion, opts: { turnBudgetMs: number; modeloElegido?: string }, f = buildRestaurantFixture()) {
  const intentos: Intento[] = [];
  const t0 = Date.now();
  const proveedor = (modelo: string) => new FakeLlmProvider({
    id: modelo,
    model: modelo,
    script: (request) => {
      const n = intentos.length;
      intentos.push({ en: Date.now() - t0, modelo, request });
      return script(n, modelo, request);
    },
  });
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("default", [proveedor(LUNA), proveedor(DEEPSEEK), proveedor(FLASH_LITE)]);
  gateway.registerLadder("escalated", [proveedor("escalado/modelo")]);
  const eventos: EventoObservabilidadWhatsApp[] = [];
  const obs: ObservabilidadTurno = { emitir: (e) => void eventos.push(e), hashTelefono: (t) => hashTelefonoParaLogs(t, "llave-de-prueba") };
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, {
    defaultRole: "default",
    escalatedRole: "escalated",
    observabilidad: obs,
    turnBudgetMs: opts.turnBudgetMs,
    ...(opts.modeloElegido ? { leerAjustes: async () => ({ modelo: opts.modeloElegido!, temperatura: 0 }) } : {}),
  });
  const correr = async (messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: "hola" }]) => {
    const p = handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages, customer: NEW_CUSTOMER, propertyId: null });
    await vi.advanceTimersByTimeAsync(opts.turnBudgetMs + 5_000);
    return p;
  };
  return { f, intentos, eventos, correr };
}

/** Luna se atasca siempre; los demas contestan con `respuesta`. */
const lunaAtascada = (respuesta: () => LlmCompletionResult | Promise<LlmCompletionResult>): Guion => (_n, modelo) => (modelo === LUNA ? COLGADA() : respuesta());

const turno = (eventos: EventoObservabilidadWhatsApp[]) => eventos.find((e): e is EventoTurnoWhatsApp => e.evento === "whatsapp_turno")!;
const tools = (eventos: EventoObservabilidadWhatsApp[]) => eventos.filter((e): e is EventoToolWhatsApp => e.evento === "whatsapp_tool");
const sinSenal = (r: LlmCompletionRequest) => ({ ...r, signal: undefined });


const lenta = (ms: number, respuesta: () => LlmCompletionResult): ((s?: AbortSignal) => Promise<LlmCompletionResult>) => (signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(respuesta()), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("abortada"));
    });
  });

describe("PM-R21 hedging: el alterno entra en paralelo, no despues de cortar al primario", () => {
  it("Luna se atasca: DeepSeek se lanza a los 5.5 s (no a los 11 s de R19), contesta y el cliente recibe la respuesta en ~6 s", async () => {
    const m = armar(lunaAtascada(() => texto("Claro, ¿que desea pedir?")), { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("¿que desea pedir?");
    expect(m.intentos.map((i) => [i.modelo, i.en])).toEqual([[LUNA, 0], [DEEPSEEK, 5_500]]);
    const t = turno(m.eventos);
    expect(t.resultado).toBe("ok");
    expect(t.latenciaTotalMs).toBeLessThan(6_500); // R19 secuencial: 11 s + lo que tarde el alterno
    expect(t.hedgeLlmLanzado).toBe(true);
    expect(t.hedgeLlmGanador).toBe("alterno");
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(true);
    expect(t.modeloRespaldoLlm).toBe(DEEPSEEK);
    expect(t.modeloRespondioLlm).toBe(DEEPSEEK);
    // El primario atascado se abortó: no queda trabajando.
    expect(m.intentos[0]!.request.signal!.aborted).toBe(true);
    expect(m.intentos[1]!.request.signal!.aborted).toBe(false);
  });

  it("telemetria por pata: el primario cancelado (con cuanto llevaba) y el alterno que contesto", async () => {
    const m = armar(lunaAtascada(() => texto("listo")), { turnBudgetMs: 18_000 });
    await m.correr();
    const t = turno(m.eventos);
    expect(t.llamadasLlm).toEqual([
      { pata: "alterno", resultado: "ok", ms: expect.any(Number), modelo: DEEPSEEK },
      { pata: "primario", resultado: "cancelada", ms: expect.any(Number), modelo: LUNA },
    ]);
    expect(t.llamadasLlm!.find((x) => x.pata === "primario")!.ms).toBeGreaterThanOrEqual(5_500);
    expect(JSON.stringify(t)).not.toMatch(/hola|Claro|desea/); // solo clases y duraciones
  });

  it("turno normal (Luna contesta en 3.5 s): una sola llamada, sin hedging y con su duracion en la telemetria", async () => {
    const m = armar((_n, modelo) => (modelo === LUNA ? lenta(3_500, () => texto("Con gusto."))() : texto("no deberia")), { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("Con gusto");
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA]);
    const t = turno(m.eventos);
    expect(t.hedgeLlmLanzado).toBe(false);
    expect(t.hedgeLlmGanador).toBeNull();
    expect(t.reintentosLlm).toBe(0);
    expect(t.llamadasLlm).toHaveLength(1);
    expect(t.llamadasLlm![0]).toMatchObject({ pata: "primario", resultado: "ok", modelo: LUNA });
    expect(t.llamadasLlm![0]!.ms).toBeGreaterThanOrEqual(3_500);
  });

  it("Luna lenta (7 s) pero contesta antes que el alterno: gana Luna, el alterno se aborta y el turno sigue con Luna (no queda 'pegado' al alterno)", async () => {
    const m = armar(
      (_n, modelo, req) => {
        if (modelo === LUNA) return pasoDelTurno(req) === 0 ? lenta(7_000, () => llamada("consultar_sucursal", { branch_slug: "fco-montejo" }))() : texto("La sucursal abre a las 9.");
        return lenta(9_000, () => texto("desde deepseek"))();
      },
      { turnBudgetMs: 30_000 },
    );
    const r = await m.correr();
    expect(r.reply).toContain("La sucursal abre");
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, DEEPSEEK, LUNA]);
    const t = turno(m.eventos);
    expect(t.hedgeLlmLanzado).toBe(true);
    expect(t.reintentoLlmRecuperado).toBe(false); // el alterno no contesto
    expect(t.modeloRespondioLlm).toBe(LUNA);
  });

  it("ambos atascados: error_proveedor/tope_llamada, DOS llamadas en paralelo, cada una con su tope registrado, y el turno no pasa del reloj", async () => {
    const m = armar(() => COLGADA(), { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(m.intentos.map((i) => [i.modelo, i.en])).toEqual([[LUNA, 0], [DEEPSEEK, 5_500]]);
    expect(r.reply).toContain("problema técnico");
    const t = turno(m.eventos);
    expect(t.resultado).toBe("error_proveedor");
    expect(t.causaError).toBe("tope_llamada");
    expect(t.hedgeLlmLanzado).toBe(true);
    expect(t.hedgeLlmGanador).toBeNull();
    expect(t.llamadasLlm!.map((x) => [x.pata, x.resultado])).toEqual([["primario", "tope"], ["alterno", "tope"]]);
    expect(t.latenciaTotalMs).toBeLessThanOrEqual(18_000 + 500);
  });

  it("error rapido de Luna (429/5xx que la escalera del gateway ya agoto): no se lanza hedging, se comporta como siempre", async () => {
    const m = armar(() => Promise.reject(new OpenRouterError("OpenRouter 429 (x): limite", 429, { transient: true, ladderRetryable: true })), { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("problema técnico");
    expect(turno(m.eventos).hedgeLlmLanzado).toBe(false);
    expect(turno(m.eventos).causaError).toBe("proveedor_5xx");
  });

  it("la herramienta corre UNA vez y el alterno ve el mismo resultado: el hedging solo duplica la llamada al modelo", async () => {
    const m = armar(
      (_n, modelo, req) => {
        if (pasoDelTurno(req) === 0) return llamada("consultar_sucursal", { branch_slug: "fco-montejo" });
        return modelo === LUNA ? COLGADA() : texto("La sucursal abre a las 9.");
      },
      { turnBudgetMs: 30_000 },
    );
    const r = await m.correr();
    expect(r.reply).toContain("La sucursal abre");
    expect(tools(m.eventos).filter((e) => e.tool === "consultar_sucursal")).toHaveLength(1);
    const [, atascado, alterno] = m.intentos.map((i) => i.request);
    expect(alterno!.messages.filter((x) => x.role === "tool")).toHaveLength(1);
    expect(sinSenal(alterno!)).toEqual(sinSenal(atascado!));
  });

  it("crear_pedido con efectos y luego atasco al redactar: un solo pedido; el alterno redacta la confirmacion", async () => {
    const f = buildRestaurantFixture();
    const { seedConfirmedOrderFlow } = await import("../support/order-flow-seed.ts");
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }] });
    const m = armar(
      (_n, modelo, req) => {
        if (pasoDelTurno(req) === 0) return llamada("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: itemsCoca(f, 2) });
        return modelo === LUNA ? COLGADA() : texto("Listo, su pedido quedo registrado.");
      },
      { turnBudgetMs: 30_000 },
      f,
    );
    const r = await m.correr([{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }]);
    const creadas = await ordenes(f);
    expect(creadas).toHaveLength(1);
    expect(r.orderId).toBe(creadas[0]!.id);
    expect(tools(m.eventos).filter((e) => e.tool === "crear_pedido")).toHaveLength(1);
  });

  it.each(["anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash"])("con %s elegido (no economico) no hay hedging: un solo intento hasta el reloj del turno", async (modeloElegido) => {
    const m = armar(() => COLGADA(), { turnBudgetMs: 18_000, modeloElegido });
    await m.correr();
    expect(m.intentos).toHaveLength(1);
    expect(turno(m.eventos).hedgeLlmLanzado).toBe(false);
  });

  it("si la organizacion eligio DeepSeek y se atasca, el alterno en paralelo es Gemini 2.5 Flash-Lite (nunca el mismo modelo)", async () => {
    const m = armar((_n, modelo) => (modelo === DEEPSEEK ? COLGADA() : texto("desde flash-lite")), { turnBudgetMs: 18_000, modeloElegido: DEEPSEEK });
    const r = await m.correr();
    expect(r.reply).toContain("desde flash-lite");
    expect(m.intentos.map((i) => i.modelo)).toEqual([DEEPSEEK, FLASH_LITE]);
  });

  it("presupuesto justo (9 s): el hedging entra tras 5.5 s con 3.5 s para el alterno (R19 no daba respaldo con < 10 s)", async () => {
    const m = armar(lunaAtascada(() => texto("a tiempo")), { turnBudgetMs: 9_000 });
    const r = await m.correr();
    expect(r.reply).toContain("a tiempo");
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, DEEPSEEK]);
  });

  it("presupuesto 8 s: el hedging se adelanta a los 4.5 s para dejarle 3.5 s al alterno", async () => {
    const m = armar(lunaAtascada(() => texto("justo")), { turnBudgetMs: 8_000 });
    const r = await m.correr();
    expect(r.reply).toContain("justo");
    expect(m.intentos.map((i) => [i.modelo, i.en])).toEqual([[LUNA, 0], [DEEPSEEK, 4_500]]);
  });

  it("presupuesto menor al minimo para hedging (< 7 s): un solo intento", async () => {
    const m = armar(() => COLGADA(), { turnBudgetMs: 6_000 });
    await m.correr();
    expect(m.intentos).toHaveLength(1);
  });

  it("bandera apagada (WHATSAPP_LLM_HEDGE_MS=0): vuelve el respaldo secuencial de R19 (alterno a los 11 s)", async () => {
    vi.stubEnv("WHATSAPP_LLM_HEDGE_MS", "0");
    const m = armar(lunaAtascada(() => texto("secuencial")), { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("secuencial");
    expect(m.intentos.map((i) => [i.modelo, i.en])).toEqual([[LUNA, 0], [DEEPSEEK, 11_000]]);
    expect(turno(m.eventos).hedgeLlmLanzado).toBe(false);
    expect(turno(m.eventos).llamadasLlm!.map((x) => [x.pata, x.resultado])).toEqual([["primario", "tope"], ["respaldo_secuencial", "ok"]]);
  });

  it("retraso configurable: WHATSAPP_LLM_HEDGE_MS=4000 lanza el alterno a los 4 s", async () => {
    vi.stubEnv("WHATSAPP_LLM_HEDGE_MS", "4000");
    const m = armar(lunaAtascada(() => texto("rapido")), { turnBudgetMs: 18_000 });
    await m.correr();
    expect(m.intentos.map((i) => i.en)).toEqual([0, 4_000]);
  });

  it("sin la variable (omision) el hedging esta APAGADO: respaldo secuencial de R19", async () => {
    vi.stubEnv("WHATSAPP_LLM_HEDGE_MS", "");
    const m = armar(lunaAtascada(() => texto("secuencial")), { turnBudgetMs: 18_000 });
    await m.correr();
    expect(m.intentos.map((i) => i.en)).toEqual([0, 11_000]);
    expect(turno(m.eventos).hedgesLlm).toBe(0);
  });

  it("tope duro: como maximo HEDGES_MAX_POR_TURNO (2) vueltas con hedging; la tercera vuelta atascada va sola hasta el reloj", async () => {
    expect(HEDGES_MAX_POR_TURNO).toBe(2);
    // Luna lenta (7 s) en cada vuelta: gana Luna tras lanzar el alterno (hedge), 3 vueltas con herramienta.
    const m = armar(
      (_n, modelo, req) => {
        if (modelo !== LUNA) return lenta(20_000, () => texto("tarde"))();
        const paso = pasoDelTurno(req);
        return lenta(7_000, () => (paso < 3 ? llamada("consultar_sucursal", { branch_slug: "fco-montejo" }, `c_${paso}`) : texto("fin")))();
      },
      { turnBudgetMs: 60_000 },
    );
    await m.correr();
    const t = turno(m.eventos);
    expect(t.hedgesLlm).toBe(2);
    expect(m.intentos.filter((i) => i.modelo === DEEPSEEK)).toHaveLength(2);
  });
});
