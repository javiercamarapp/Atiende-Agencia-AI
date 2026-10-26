// PM ronda 19: `tope_llamada` fue el 100 % de los errores de proveedor de las rondas 15-18 (6.1 % de los turnos en la 18; con error el acierto es ~15 %, sin
// error ~71 %). Repetir la MISMA llamada al MISMO modelo (#610) se revirtio: un modelo atascado sigue atascado. Cambio: con presupuesto de sobra, el PRIMER
// intento tiene un tope menor y, si lo agota, se repite UNA vez la misma peticion contra el modelo ALTERNO de la escalera ya aprobada (Luna -> DeepSeek V4.1
// Flash; si el elegido ya es DeepSeek -> Gemini 2.5 Flash-Lite). Repetir la llamada al modelo no tiene efectos laterales; las herramientas NUNCA se repiten.
// Todo con modelos simulados, reloj simulado y repositorio en memoria: sin llaves ni gasto de LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, OpenRouterError } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { CIERRE_MAQUINA_ENV } from "../../src/agent-tools/cierre-maquina.ts";
import { resetOrderFlowWarningForTests } from "../../src/agent-tools/order-flow.ts";
import {
  createLlmWhatsAppTurnHandler,
  planTopeLlamadaLlm,
  RESPALDO_LLM_PRIMER_TOPE_MIN_MS,
  RESPALDO_LLM_RESERVA_MS,
  RESPALDO_LLM_RESTANTE_MIN_MS,
  RESPALDO_LLM_RESTANTE_MIN_TARDIO_MS,
  RESPALDO_LLM_RESERVA_TARDIA_MS,
  RESPALDO_LLM_PRIMER_TOPE_MIN_TARDIO_MS,
} from "../../src/whatsapp/llm-turn-handler.ts";
import { MODELOS_AGENTE, MODELO_ALTERNO_SEGUNDO_TOPE_ID, MODELO_ALTERNO_TOPE_ID, MODELO_PREDETERMINADO_ID, idModeloDeListaCerrada, modeloAdmiteRespaldoPorTope, modeloAlternoParaTope } from "../../src/ajustes-agente/modelos.ts";
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
  // PM-R21: estas pruebas fijan el respaldo SECUENCIAL de R19 (la ruta con el hedging apagado); el hedging tiene su propio archivo (pm-r21-hedging-llm.spec.ts).
  vi.stubEnv("WHATSAPP_LLM_HEDGE_MS", "0");
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

describe("PM-R19 modelo alterno: solo modelos ya aprobados y distinto del que se atasco", () => {
  it("Luna (o cualquier otro) -> DeepSeek V4.1 Flash; DeepSeek -> Gemini 2.5 Flash-Lite; sin eleccion -> DeepSeek", () => {
    expect(modeloAlternoParaTope(LUNA)).toBe(DEEPSEEK);
    expect(modeloAlternoParaTope(FLASH_LITE)).toBe(DEEPSEEK);
    expect(modeloAlternoParaTope("anthropic/claude-sonnet-5.5")).toBe(DEEPSEEK);
    expect(modeloAlternoParaTope(DEEPSEEK)).toBe(FLASH_LITE);
    expect(modeloAlternoParaTope(null)).toBe(DEEPSEEK);
    expect(modeloAlternoParaTope(undefined)).toBe(DEEPSEEK);
  });

  it("los alternos estan en la lista permitida (MODELOS_AGENTE) y nunca coinciden con el modelo de origen", () => {
    const permitidos = MODELOS_AGENTE.map((m) => m.id);
    expect(permitidos).toContain(DEEPSEEK);
    expect(permitidos).toContain(FLASH_LITE);
    for (const origen of [...permitidos, null, undefined, "id/desconocido"]) {
      const alterno = modeloAlternoParaTope(origen);
      expect(permitidos).toContain(alterno);
      expect(alterno).not.toBe(origen);
    }
  });
});

describe("PM-R19 solo los modelos economicos se respaldan", () => {
  it("economicos y el predeterminado si; modelos lentos con razonamiento y desconocidos no", () => {
    for (const ok of [null, undefined, LUNA, DEEPSEEK, FLASH_LITE]) expect(modeloAdmiteRespaldoPorTope(ok), String(ok)).toBe(true);
    for (const no of ["anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash", "meta/muse-spark-1.3", "id/desconocido"]) expect(modeloAdmiteRespaldoPorTope(no), no).toBe(false);
  });

  it("el id que reporta el gateway se reduce a la lista cerrada", () => {
    expect(idModeloDeListaCerrada("fake", `openrouter:${LUNA}`)).toBe(LUNA);
    expect(idModeloDeListaCerrada(DEEPSEEK)).toBe(DEEPSEEK);
    expect(idModeloDeListaCerrada("raro/modelo-con-datos", undefined)).toBe("otro");
    expect(idModeloDeListaCerrada(null, "")).toBe("otro");
  });

  it.each(["anthropic/claude-sonnet-5.5", "google/gemini-3.8-flash"])("con %s elegido y atascado NO se activa el respaldo: un solo intento hasta el reloj del turno", async (modeloElegido) => {
    const m = armar(() => COLGADA(), { turnBudgetMs: 18_000, modeloElegido });
    const r = await m.correr();
    expect(m.intentos).toHaveLength(1);
    expect(r.reply).toContain("problema técnico");
    const t = turno(m.eventos);
    expect(t.causaError).toBe("tope_llamada");
    expect(t.reintentosLlm).toBe(0);
    expect(t.modeloRespaldoLlm).toBeNull();
  });

  it("con un modelo lento elegido una llamada de 15 s (que hoy termina bien) NO se corta a los 11 s", async () => {
    const m = armar(async () => {
      await new Promise((res) => setTimeout(res, 15_000));
      return texto("lento pero bueno");
    }, { turnBudgetMs: 18_000, modeloElegido: "anthropic/claude-sonnet-5.5" });
    const r = await m.correr();
    expect(r.reply).toContain("lento pero bueno");
    expect(m.intentos).toHaveLength(1);
  });
});

describe("PM-R19 telemetria del modelo que realmente contesto", () => {
  it("turno normal: contesta el primario", async () => {
    const m = armar(() => texto("hola"), { turnBudgetMs: 18_000 });
    await m.correr();
    expect(turno(m.eventos).modeloRespondioLlm).toBe(LUNA);
  });

  it("respaldo real: contesta el alterno y hay constancia del reintento", async () => {
    const m = armar(lunaAtascada(() => texto("hola")), { turnBudgetMs: 18_000 });
    await m.correr();
    const t = turno(m.eventos);
    expect(t.modeloRespondioLlm).toBe(DEEPSEEK);
    expect(t.reintentosLlm).toBe(1);
  });

  it("caida de escalera (5xx rapido): contesta el siguiente escalon pero NO cuenta como respaldo", async () => {
    const m = armar((_n, modelo) => {
      if (modelo === LUNA) throw new OpenRouterError("OpenRouter 503 (m): upstream", 503, { transient: true, ladderRetryable: true });
      return texto("hola");
    }, { turnBudgetMs: 18_000 });
    await m.correr();
    const t = turno(m.eventos);
    expect(t.modeloRespondioLlm).toBe(DEEPSEEK);
    expect(t.reintentosLlm).toBe(0);
    expect(t.modeloRespaldoLlm).toBeNull();
  });

  it("si ninguna llamada contesta, no hay modelo que contesto", async () => {
    const m = armar(() => COLGADA(), { turnBudgetMs: 18_000 });
    await m.correr();
    expect(turno(m.eventos).modeloRespondioLlm).toBeNull();
  });
});

describe("PM-R19 proveedor cooperativo: respeta la senal de aborto", () => {
  it("el intento atascado rechaza al recibir el aborto, no queda trabajando y el respaldo contesta", async () => {
    let abortadoPorSenal = false;
    const m = armar((_n, modelo, request) => {
      if (modelo !== LUNA) return texto("respaldo ok");
      return new Promise<LlmCompletionResult>((_res, rej) => {
        request.signal?.addEventListener("abort", () => {
          abortadoPorSenal = true;
          rej(new Error("The operation was aborted"));
        });
      });
    }, { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(abortadoPorSenal).toBe(true);
    expect(r.reply).toContain("respaldo ok");
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, DEEPSEEK]);
    const t = turno(m.eventos);
    expect(t.resultado).toBe("ok");
    expect(t.reintentoLlmRecuperado).toBe(true);
  });
});

describe("PM-R19 plan del tope por llamada al modelo", () => {
  it("por debajo del minimo (tardio) de presupuesto restante no hay respaldo: el tope sigue siendo todo lo que queda", () => {
    expect(planTopeLlamadaLlm(RESPALDO_LLM_RESTANTE_MIN_TARDIO_MS - 1)).toEqual({ primerTopeMs: RESPALDO_LLM_RESTANTE_MIN_TARDIO_MS - 1, respalda: false });
    expect(planTopeLlamadaLlm(5_000)).toEqual({ primerTopeMs: 5_000, respalda: false });
    expect(planTopeLlamadaLlm(0)).toEqual({ primerTopeMs: 0, respalda: false });
    expect(planTopeLlamadaLlm(-3)).toEqual({ primerTopeMs: 0, respalda: false });
  });

  it("en el minimo exacto: primer intento con su piso y al respaldo le quedan al menos 6 s", () => {
    const p = planTopeLlamadaLlm(RESPALDO_LLM_RESTANTE_MIN_MS);
    expect(p.respalda).toBe(true);
    expect(p.primerTopeMs).toBe(RESPALDO_LLM_PRIMER_TOPE_MIN_MS);
    expect(RESPALDO_LLM_RESTANTE_MIN_MS - p.primerTopeMs).toBeGreaterThanOrEqual(6_000);
  });

  it("con el presupuesto por omision (18 s) el primer intento deja la reserva completa al respaldo", () => {
    expect(planTopeLlamadaLlm(18_000)).toEqual({ primerTopeMs: 18_000 - RESPALDO_LLM_RESERVA_MS, respalda: true });
  });

  it("el primer intento nunca baja de su piso (una llamada legitima de ~8 s no se corta antes de tiempo) y siempre queda tiempo para el respaldo", () => {
    for (let restante = RESPALDO_LLM_RESTANTE_MIN_MS; restante <= 40_000; restante += 500) {
      const p = planTopeLlamadaLlm(restante);
      expect(p.primerTopeMs).toBeGreaterThanOrEqual(RESPALDO_LLM_PRIMER_TOPE_MIN_MS);
      expect(restante - p.primerTopeMs).toBeGreaterThanOrEqual(6_000);
    }
  });
});

describe("PM-R19 respaldo al modelo alterno cuando se agota el tope", () => {
  it("Luna se atasca y DeepSeek responde: el cliente recibe la respuesta, no 'problema tecnico'", async () => {
    const m = armar(lunaAtascada(() => texto("Claro, ¿que desea pedir?")), { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("¿que desea pedir?");
    expect(r.reply).not.toContain("problema técnico");
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, DEEPSEEK]);
    // Primer intento cortado a los 11 s (18 s - reserva de 7 s) y el respaldo arranca ahi mismo.
    expect(m.intentos[0]!.en).toBe(0);
    expect(m.intentos[1]!.en).toBe(18_000 - RESPALDO_LLM_RESERVA_MS);
    const t = turno(m.eventos);
    expect(t.resultado).toBe("ok");
    expect(t.causaError).toBeNull();
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(true);
    expect(t.modeloRespaldoLlm).toBe(DEEPSEEK);
    expect(t.vueltas).toBe(1);
  });

  it("es la MISMA peticion: mismo sistema, mismos mensajes, mismas herramientas; solo cambia el modelo y la senal de aborto", async () => {
    const m = armar(lunaAtascada(() => texto("listo")), { turnBudgetMs: 18_000 });
    await m.correr();
    const [a, b] = m.intentos.map((i) => i.request);
    expect(a!.signal).toBeDefined();
    expect(b!.signal).toBeDefined();
    expect(a!.signal).not.toBe(b!.signal);
    expect(a!.signal!.aborted).toBe(true); // el intento atascado se aborta: no queda trabajando en segundo plano
    expect(b!.signal!.aborted).toBe(false);
    expect(sinSenal(b!)).toEqual(sinSenal(a!));
  });

  it("si la organizacion eligio DeepSeek y se atasca, el respaldo es Gemini 2.5 Flash-Lite (nunca el mismo modelo)", async () => {
    const m = armar((_n, modelo) => (modelo === DEEPSEEK ? COLGADA() : texto("desde flash-lite")), { turnBudgetMs: 18_000, modeloElegido: DEEPSEEK });
    const r = await m.correr();
    expect(r.reply).toContain("desde flash-lite");
    expect(m.intentos.map((i) => i.modelo)).toEqual([DEEPSEEK, FLASH_LITE]);
    expect(turno(m.eventos).modeloRespaldoLlm).toBe(FLASH_LITE);
  });

  it("ambos modelos se atascan: error_proveedor con tope_llamada, SOLO un respaldo y el turno no pasa del reloj del turno", async () => {
    const m = armar(() => COLGADA(), { turnBudgetMs: 18_000 });
    const t0 = Date.now();
    const r = await m.correr();
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, DEEPSEEK]);
    expect(r.reply).toContain("problema técnico");
    const t = turno(m.eventos);
    expect(t.resultado).toBe("error_proveedor");
    expect(t.causaError).toBe("tope_llamada");
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(false);
    // El turno termina en el reloj del turno (18 s): el respaldo no estira la latencia maxima (p95 <= 18 s).
    expect(t.latenciaTotalMs).toBeLessThanOrEqual(18_000 + 500);
    expect(Date.now() - t0).toBeLessThanOrEqual(18_000 + 5_000);
  });

  it("presupuesto restante insuficiente (< 10 s): NO hay respaldo; comportamiento de siempre", async () => {
    const m = armar(() => COLGADA(), { turnBudgetMs: RESPALDO_LLM_RESTANTE_MIN_TARDIO_MS - 1 });
    const r = await m.correr();
    expect(m.intentos).toHaveLength(1);
    expect(r.reply).toContain("problema técnico");
    const t = turno(m.eventos);
    expect(t.causaError).toBe("tope_llamada");
    expect(t.reintentosLlm).toBe(0);
    expect(t.reintentoLlmRecuperado).toBe(false);
    expect(t.modeloRespaldoLlm).toBeNull();
  });

  it("una llamada lenta pero dentro del primer tope se acepta tal cual: sin respaldo ni segunda llamada", async () => {
    const m = armar(async () => {
      await new Promise((res) => setTimeout(res, 10_000));
      return texto("tarde pero buena");
    }, { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("tarde pero buena");
    expect(m.intentos).toHaveLength(1);
    expect(turno(m.eventos).reintentosLlm).toBe(0);
  });

  it("un error rapido del proveedor (5xx) NO usa este respaldo: la escalera de proveedores del gateway es quien lo maneja", async () => {
    const m = armar((_n, modelo) => {
      if (modelo === LUNA) throw new OpenRouterError("OpenRouter 503 (m): upstream", 503, { transient: true, ladderRetryable: true });
      return texto("lo atendio el siguiente escalon");
    }, { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("lo atendio el siguiente escalon");
    const t = turno(m.eventos);
    expect(t.reintentosLlm).toBe(0);
    expect(t.reintentoLlmRecuperado).toBe(false);
    expect(t.modeloRespaldoLlm).toBeNull();
  });

  it("si el respaldo falla por otra causa, la causa registrada es la del ULTIMO fallo y queda constancia del respaldo", async () => {
    // Luna solo se atasca en la 1.a llamada; despues (la escalera del gateway la vuelve a probar tras el respaldo) y los demas escalones responden 503.
    const m = armar((n) => {
      if (n === 0) return COLGADA();
      throw new OpenRouterError("OpenRouter 503 (m): upstream", 503, { transient: true, ladderRetryable: true });
    }, { turnBudgetMs: 18_000 });
    await m.correr();
    const t = turno(m.eventos);
    expect(t.resultado).toBe("error_proveedor");
    expect(t.causaError).not.toBe("tope_llamada");
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(false);
  });

  it("un turno sin atascos no cambia: sin respaldo y con los campos nuevos en cero", async () => {
    const m = armar(() => texto("hola, ¿que se le ofrece?"), { turnBudgetMs: 18_000 });
    await m.correr();
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA]);
    const t = turno(m.eventos);
    expect(t.resultado).toBe("ok");
    expect(t.reintentosLlm).toBe(0);
    expect(t.reintentoLlmRecuperado).toBe(false);
    expect(t.modeloRespaldoLlm).toBeNull();
  });
});

describe("PM-R19 el respaldo repite SOLO la llamada al modelo, nunca las herramientas", () => {
  it("atasco en la 2.a vuelta (tras una herramienta): la herramienta corrio UNA vez y el respaldo ve su resultado", async () => {
    const m = armar(
      (_n, modelo, req) => {
        if (pasoDelTurno(req) === 0) return llamada("consultar_sucursal", { branch_slug: "fco-montejo" });
        return modelo === LUNA ? COLGADA() : texto("La sucursal abre a las 9.");
      },
      { turnBudgetMs: 30_000 },
    );
    const r = await m.correr();
    expect(r.reply).toContain("La sucursal abre");
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, LUNA, DEEPSEEK]); // vuelta 1 + atasco y respaldo de la vuelta 2
    expect(tools(m.eventos).filter((e) => e.tool === "consultar_sucursal")).toHaveLength(1);
    const [, atascado, respaldo] = m.intentos.map((i) => i.request);
    expect(respaldo!.messages.filter((x) => x.role === "tool")).toHaveLength(1); // el resultado de la herramienta no se duplica
    expect(sinSenal(respaldo!)).toEqual(sinSenal(atascado!));
    const t = turno(m.eventos);
    expect(t.vueltas).toBe(2);
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(true);
  });

  it("tras un respaldo, las vueltas siguientes del mismo turno usan directamente el modelo alterno (sin esperar de nuevo al atascado)", async () => {
    const m = armar(
      (_n, modelo, req) => {
        if (modelo === LUNA) return COLGADA();
        return pasoDelTurno(req) === 0 ? llamada("consultar_sucursal", { branch_slug: "fco-montejo" }) : texto("La sucursal abre a las 9.");
      },
      { turnBudgetMs: 30_000 },
    );
    const r = await m.correr();
    expect(r.reply).toContain("La sucursal abre");
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, DEEPSEEK, DEEPSEEK]);
    expect(tools(m.eventos).filter((e) => e.tool === "consultar_sucursal")).toHaveLength(1);
    expect(turno(m.eventos).reintentosLlm).toBe(1); // un solo respaldo por turno
  });

  it("herramienta CON efectos (crear_pedido) y luego atasco al redactar: un solo pedido y el respaldo redacta la confirmacion", async () => {
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
    expect(creadas).toHaveLength(1); // el respaldo NO volvio a crear el pedido
    expect(r.orderId).toBe(creadas[0]!.id);
    expect(tools(m.eventos).filter((e) => e.tool === "crear_pedido")).toHaveLength(1);
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, LUNA, DEEPSEEK]);
    const t = turno(m.eventos);
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(true);
  });

  it("herramienta con efectos y AMBOS modelos atascados: el cliente sigue sabiendo que su pedido existe (nada a medias)", async () => {
    const f = buildRestaurantFixture();
    const { seedConfirmedOrderFlow } = await import("../support/order-flow-seed.ts");
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }] });
    const m = armar(
      (_n, _modelo, req) => (pasoDelTurno(req) === 0 ? llamada("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: itemsCoca(f, 2) }) : COLGADA()),
      { turnBudgetMs: 30_000 },
      f,
    );
    const r = await m.correr([{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }]);
    const creadas = await ordenes(f);
    expect(creadas).toHaveLength(1);
    expect(r.orderId).toBe(creadas[0]!.id);
    expect(m.intentos).toHaveLength(3); // 1 + intento atascado + un solo respaldo
    expect(turno(m.eventos).causaError).toBe("tope_llamada");
    expect(tools(m.eventos).filter((e) => e.tool === "crear_pedido")).toHaveLength(1);
  });

  it("la telemetria nueva no filtra contenido: un entero, un booleano y el id de un modelo de la lista cerrada", async () => {
    const m = armar(lunaAtascada(() => texto("Hola Nora Privada, 999 123 4567")), { turnBudgetMs: 18_000 });
    await m.correr([{ role: "user", content: "soy Nora Privada, mi cel 999 123 4567" }]);
    const t = turno(m.eventos);
    expect(typeof t.reintentosLlm).toBe("number");
    expect(typeof t.reintentoLlmRecuperado).toBe("boolean");
    expect(MODELOS_AGENTE.map((x) => x.id)).toContain(t.modeloRespaldoLlm);
    const crudo = JSON.stringify(m.eventos);
    expect(crudo).not.toContain("Nora");
    expect(crudo).not.toContain("999 123 4567");
  });
});

describe("PM-R19b respaldo en vueltas posteriores (plan tardio)", () => {
  it("plan tardio: con 10 a 16 s restantes el primer intento queda en max(6 s, restante - 6 s) y siempre sobran >= 4 s al respaldo", () => {
    for (let restante = RESPALDO_LLM_RESTANTE_MIN_TARDIO_MS; restante < RESPALDO_LLM_RESTANTE_MIN_MS; restante += 250) {
      const p = planTopeLlamadaLlm(restante);
      expect(p.respalda).toBe(true);
      expect(p.primerTopeMs).toBe(Math.max(RESPALDO_LLM_PRIMER_TOPE_MIN_TARDIO_MS, restante - RESPALDO_LLM_RESERVA_TARDIA_MS));
      expect(restante - p.primerTopeMs).toBeGreaterThanOrEqual(4_000);
    }
    expect(planTopeLlamadaLlm(RESPALDO_LLM_RESTANTE_MIN_TARDIO_MS - 1).respalda).toBe(false);
  });

  it("atasco en la 2.a vuelta con ~14 s restantes (presupuesto 18 s, la 1.a vuelta tardo 4 s): ahora SI hay respaldo y no hay 'problema tecnico'", async () => {
    const m = armar(
      async (_n, modelo, req) => {
        if (pasoDelTurno(req) === 0) {
          await new Promise((res) => setTimeout(res, 4_000));
          return llamada("consultar_sucursal", { branch_slug: "fco-montejo" });
        }
        return modelo === LUNA ? COLGADA() : texto("La sucursal abre a las 9.");
      },
      { turnBudgetMs: 18_000 },
    );
    const r = await m.correr();
    expect(r.reply).toContain("La sucursal abre");
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, LUNA, DEEPSEEK]);
    expect(m.intentos[2]!.en).toBe(4_000 + 8_000); // restante 14 s -> primer tope 8 s
    expect(tools(m.eventos).filter((e) => e.tool === "consultar_sucursal")).toHaveLength(1);
    const t = turno(m.eventos);
    expect(t.resultado).toBe("ok");
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(true);
    expect(t.latenciaTotalMs).toBeLessThanOrEqual(18_000);
  });

  it("con < 10 s restantes en la vuelta (2 herramientas de 4 s antes) NO hay respaldo: comportamiento de siempre y el turno termina en el reloj", async () => {
    const m = armar(
      async (_n, _modelo, req) => {
        const paso = pasoDelTurno(req);
        if (paso <= 1) {
          await new Promise((res) => setTimeout(res, 4_500));
          return llamada("consultar_sucursal", { branch_slug: "fco-montejo" });
        }
        return COLGADA();
      },
      { turnBudgetMs: 18_000 },
    );
    const r = await m.correr();
    expect(m.intentos).toHaveLength(3);
    expect(r.reply).toContain("problema técnico");
    const t = turno(m.eventos);
    expect(t.causaError).toBe("tope_llamada");
    expect(t.reintentosLlm).toBe(0);
    expect(t.latenciaTotalMs).toBeLessThanOrEqual(18_000 + 500);
  });

  it("un solo respaldo por turno: con los dos modelos atascados nunca hay una tercera llamada al modelo en la vuelta y el turno no pasa del reloj", async () => {
    const m = armar(() => COLGADA(), { turnBudgetMs: 40_000 });
    await m.correr();
    expect(m.intentos.map((i) => i.modelo)).toEqual([LUNA, DEEPSEEK]);
    const t = turno(m.eventos);
    expect(t.causaError).toBe("tope_llamada");
    expect(t.reintentosLlm).toBe(1);
    expect(t.latenciaTotalMs).toBeLessThanOrEqual(40_000 + 500);
  });

  it("un modelo lento elegido (Sonnet) sigue sin respaldo tambien en vueltas posteriores", async () => {
    const m = armar(
      (_n, _modelo, req) => (pasoDelTurno(req) === 0 ? llamada("consultar_sucursal", { branch_slug: "fco-montejo" }) : COLGADA()),
      { turnBudgetMs: 18_000, modeloElegido: "anthropic/claude-sonnet-5.5" },
    );
    await m.correr();
    expect(m.intentos).toHaveLength(2);
    expect(turno(m.eventos).reintentosLlm).toBe(0);
  });
});
