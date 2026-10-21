// PM ronda 15: en la ronda limpia (host sano) los 77 turnos con error de proveedor (5.9 % OFF, 4.1 % ON de 1,556) fueron TODOS `tope_llamada`: la llamada al
// modelo no contesto antes del reloj del turno (~18 s) y el cliente recibio "problema tecnico". La llamada tipica tarda ~3.4 s (p95 ~5.8 s), asi que una que
// sigue sin contestar a los 9-10 s es casi siempre una llamada atascada, no una lenta. El tope por llamada era TODO el presupuesto restante del turno: al
// vencer ya no quedaba tiempo para intentarlo otra vez.
//
// Cambio: con >= 14 s de presupuesto restante, el PRIMER intento tiene un tope menor y, si lo agota, se repite UNA vez la MISMA llamada al modelo (misma
// peticion) con lo que reste del turno. Repetir la llamada al modelo no tiene efectos laterales; las herramientas NUNCA se repiten (corren entre llamadas, no
// dentro de ellas). La telemetria del turno (#605) registra `reintentosLlm` y `reintentoLlmRecuperado`.
// Todo con modelo simulado, reloj simulado y repositorio en memoria: sin llaves ni gasto de LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLlmProvider, OpenRouterError } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { CIERRE_MAQUINA_ENV } from "../../src/agent-tools/cierre-maquina.ts";
import { resetOrderFlowWarningForTests } from "../../src/agent-tools/order-flow.ts";
import {
  createLlmWhatsAppTurnHandler,
  planTopeLlamadaLlm,
  REINTENTO_LLM_PRIMER_TOPE_MIN_MS,
  REINTENTO_LLM_RESERVA_MS,
  REINTENTO_LLM_RESTANTE_MIN_MS,
} from "../../src/whatsapp/llm-turn-handler.ts";
import { hashTelefonoParaLogs } from "../../src/whatsapp/observabilidad-turno.ts";
import type { EventoObservabilidadWhatsApp, EventoTurnoWhatsApp, EventoToolWhatsApp, ObservabilidadTurno } from "../../src/whatsapp/observabilidad-turno.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { gatewayDe, itemsCoca, llamada, ordenes, pasoDelTurno, texto } from "../pm-r11-romper/arnes.ts";

const PHONE = "+5219991234567";
const NEW_CUSTOMER = { isNew: true } as const;
const COLGADA = (): Promise<LlmCompletionResult> => new Promise(() => undefined); // nunca responde (ignora la senal: el tope la corta igual)

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.stubEnv(CIERRE_MAQUINA_ENV, "");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

interface Intento {
  readonly en: number;
  readonly request: LlmCompletionRequest;
}

/** Handler con modelo guionado POR INTENTO (el guion ve el numero de intento global, 0-based, y el request). Devuelve los intentos con su instante simulado. */
function armar(script: (n: number, request: LlmCompletionRequest) => LlmCompletionResult | Promise<LlmCompletionResult>, opts: { turnBudgetMs: number }, f = buildRestaurantFixture()) {
  const intentos: Intento[] = [];
  const t0 = Date.now();
  const provider = new FakeLlmProvider({
    id: "guion",
    script: (request) => {
      const n = intentos.length;
      intentos.push({ en: Date.now() - t0, request });
      return script(n, request);
    },
  });
  const eventos: EventoObservabilidadWhatsApp[] = [];
  const obs: ObservabilidadTurno = { emitir: (e) => void eventos.push(e), hashTelefono: (t) => hashTelefonoParaLogs(t, "llave-de-prueba") };
  const handler = createLlmWhatsAppTurnHandler(f.repo, gatewayDe([provider]), { defaultRole: "default", escalatedRole: "escalated", observabilidad: obs, ...opts });
  const correr = async (messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: "hola" }]) => {
    const p = handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages, customer: NEW_CUSTOMER, propertyId: null });
    await vi.advanceTimersByTimeAsync(opts.turnBudgetMs + 5_000);
    return p;
  };
  return { f, intentos, eventos, correr };
}

const turno = (eventos: EventoObservabilidadWhatsApp[]) => eventos.find((e): e is EventoTurnoWhatsApp => e.evento === "whatsapp_turno")!;
const tools = (eventos: EventoObservabilidadWhatsApp[]) => eventos.filter((e): e is EventoToolWhatsApp => e.evento === "whatsapp_tool");
const sinSenal = (r: LlmCompletionRequest) => ({ ...r, signal: undefined });

describe("PM-R15 plan del tope por llamada al modelo", () => {
  it("por debajo del minimo de presupuesto restante no hay reintento: el tope sigue siendo todo lo que queda", () => {
    expect(planTopeLlamadaLlm(REINTENTO_LLM_RESTANTE_MIN_MS - 1)).toEqual({ primerTopeMs: REINTENTO_LLM_RESTANTE_MIN_MS - 1, reintenta: false });
    expect(planTopeLlamadaLlm(5_000)).toEqual({ primerTopeMs: 5_000, reintenta: false });
    expect(planTopeLlamadaLlm(0)).toEqual({ primerTopeMs: 0, reintenta: false });
    expect(planTopeLlamadaLlm(-3)).toEqual({ primerTopeMs: 0, reintenta: false });
  });

  it("en el minimo exacto: primer intento con su piso y al reintento le quedan al menos 6 s", () => {
    const p = planTopeLlamadaLlm(REINTENTO_LLM_RESTANTE_MIN_MS);
    expect(p.reintenta).toBe(true);
    expect(p.primerTopeMs).toBe(REINTENTO_LLM_PRIMER_TOPE_MIN_MS);
    expect(REINTENTO_LLM_RESTANTE_MIN_MS - p.primerTopeMs).toBeGreaterThanOrEqual(6_000);
  });

  it("con el presupuesto por omision (18 s) el primer intento deja la reserva completa al reintento", () => {
    expect(planTopeLlamadaLlm(18_000)).toEqual({ primerTopeMs: 18_000 - REINTENTO_LLM_RESERVA_MS, reintenta: true });
  });

  it("el primer intento nunca baja de su piso (una llamada legitima de ~8 s no se corta antes de tiempo)", () => {
    for (let restante = REINTENTO_LLM_RESTANTE_MIN_MS; restante <= 40_000; restante += 500) {
      const p = planTopeLlamadaLlm(restante);
      expect(p.primerTopeMs).toBeGreaterThanOrEqual(REINTENTO_LLM_PRIMER_TOPE_MIN_MS);
      expect(restante - p.primerTopeMs).toBeGreaterThan(0);
    }
  });
});

describe("PM-R15 reintento unico de la llamada al modelo cuando se agota el tope", () => {
  it("la 1.a llamada se atasca y la 2.a responde: el cliente recibe la respuesta, no 'problema tecnico'", async () => {
    const m = armar((n) => (n === 0 ? COLGADA() : texto("Claro, ¿que desea pedir?")), { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("¿que desea pedir?");
    expect(r.reply).not.toContain("problema técnico");
    expect(m.intentos).toHaveLength(2);
    // Primer intento cortado a los 10 s (18 s - reserva de 8 s) y el segundo arranca ahi mismo con 8 s de margen.
    expect(m.intentos[0]!.en).toBe(0);
    expect(m.intentos[1]!.en).toBe(18_000 - REINTENTO_LLM_RESERVA_MS);
    const t = turno(m.eventos);
    expect(t.resultado).toBe("ok");
    expect(t.causaError).toBeNull();
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(true);
    expect(t.vueltas).toBe(1);
  });

  it("es la MISMA peticion: mismo sistema, mismos mensajes, mismas herramientas; solo cambia la senal de aborto", async () => {
    const m = armar((n) => (n === 0 ? COLGADA() : texto("listo")), { turnBudgetMs: 18_000 });
    await m.correr();
    const [a, b] = m.intentos.map((i) => i.request);
    expect(a!.signal).toBeDefined();
    expect(b!.signal).toBeDefined();
    expect(a!.signal).not.toBe(b!.signal);
    expect(a!.signal!.aborted).toBe(true); // el intento atascado se aborta: no queda trabajando en segundo plano
    expect(b!.signal!.aborted).toBe(false);
    expect(sinSenal(b!)).toEqual(sinSenal(a!));
  });

  it("ambas llamadas se atascan: error_proveedor con tope_llamada, SOLO un reintento y el turno no pasa del reloj del turno", async () => {
    const m = armar(() => COLGADA(), { turnBudgetMs: 18_000 });
    const t0 = Date.now();
    const r = await m.correr();
    expect(m.intentos).toHaveLength(2);
    expect(r.reply).toContain("problema técnico");
    const t = turno(m.eventos);
    expect(t.resultado).toBe("error_proveedor");
    expect(t.causaError).toBe("tope_llamada");
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(false);
    // El turno termina en el reloj del turno (18 s), no antes ni despues: el reintento no estira la latencia maxima.
    expect(t.latenciaTotalMs).toBeLessThanOrEqual(18_000 + 500);
    expect(Date.now() - t0).toBeLessThanOrEqual(18_000 + 5_000);
  });

  it("presupuesto restante insuficiente (< 14 s): NO reintenta; comportamiento de siempre", async () => {
    const m = armar(() => COLGADA(), { turnBudgetMs: REINTENTO_LLM_RESTANTE_MIN_MS - 1 });
    const r = await m.correr();
    expect(m.intentos).toHaveLength(1);
    expect(r.reply).toContain("problema técnico");
    const t = turno(m.eventos);
    expect(t.causaError).toBe("tope_llamada");
    expect(t.reintentosLlm).toBe(0);
    expect(t.reintentoLlmRecuperado).toBe(false);
  });

  it("una llamada lenta pero dentro del primer tope se acepta tal cual: sin reintento ni segunda llamada", async () => {
    const m = armar(async () => {
      await new Promise((res) => setTimeout(res, 9_000));
      return texto("tarde pero buena");
    }, { turnBudgetMs: 18_000 });
    const r = await m.correr();
    expect(r.reply).toContain("tarde pero buena");
    expect(m.intentos).toHaveLength(1);
    expect(turno(m.eventos).reintentosLlm).toBe(0);
  });

  it("un error rapido del proveedor (5xx) NO usa este reintento: la escalera de proveedores es quien lo maneja", async () => {
    const m = armar(() => { throw new OpenRouterError("OpenRouter 503 (m): upstream", 503, { transient: true, ladderRetryable: true }); }, { turnBudgetMs: 18_000 });
    await m.correr();
    expect(m.intentos).toHaveLength(1);
    const t = turno(m.eventos);
    expect(t.causaError).toBe("proveedor_5xx");
    expect(t.reintentosLlm).toBe(0);
  });

  it("si el reintento falla por otra causa, la causa registrada es la del ULTIMO fallo y queda constancia del reintento", async () => {
    const m = armar((n) => { if (n === 0) return COLGADA(); throw new OpenRouterError("OpenRouter 503 (m): upstream", 503, { transient: true, ladderRetryable: true }); }, { turnBudgetMs: 18_000 });
    await m.correr();
    expect(m.intentos).toHaveLength(2);
    const t = turno(m.eventos);
    expect(t.resultado).toBe("error_proveedor");
    expect(t.causaError).toBe("proveedor_5xx");
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(false);
  });

  it("un turno sin atascos no cambia: sin reintento y con los campos nuevos en cero", async () => {
    const m = armar(() => texto("hola, ¿que se le ofrece?"), { turnBudgetMs: 18_000 });
    await m.correr();
    expect(m.intentos).toHaveLength(1);
    const t = turno(m.eventos);
    expect(t.resultado).toBe("ok");
    expect(t.reintentosLlm).toBe(0);
    expect(t.reintentoLlmRecuperado).toBe(false);
  });
});

describe("PM-R15 el reintento repite SOLO la llamada al modelo, nunca las herramientas", () => {
  it("atasco en la 2.a vuelta (tras una herramienta): la herramienta corrio UNA vez y el reintento ve su resultado", async () => {
    const m = armar(
      (n, req) => {
        if (pasoDelTurno(req) === 0) return llamada("consultar_sucursal", { branch_slug: "fco-montejo" });
        // Ya hay un resultado de herramienta: el primer intento de esta vuelta se atasca y el segundo responde.
        return n === 1 ? COLGADA() : texto("La sucursal abre a las 9.");
      },
      { turnBudgetMs: 30_000 },
    );
    const r = await m.correr();
    expect(r.reply).toContain("La sucursal abre");
    expect(m.intentos).toHaveLength(3); // vuelta 1 + 2 intentos de la vuelta 2
    expect(tools(m.eventos).filter((e) => e.tool === "consultar_sucursal")).toHaveLength(1);
    const [, atascado, reintento] = m.intentos.map((i) => i.request);
    expect(pasoDelTurno(atascado!)).toBe(1);
    expect(pasoDelTurno(reintento!)).toBe(1);
    expect(reintento!.messages.filter((x) => x.role === "tool")).toHaveLength(1); // el resultado de la herramienta no se duplica
    expect(sinSenal(reintento!)).toEqual(sinSenal(atascado!));
    const t = turno(m.eventos);
    expect(t.vueltas).toBe(2);
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(true);
  });

  it("herramienta CON efectos (crear_pedido) y luego atasco al redactar: un solo pedido y el reintento redacta la confirmacion", async () => {
    const f = buildRestaurantFixture();
    const { seedConfirmedOrderFlow } = await import("../support/order-flow-seed.ts");
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }] });
    const m = armar(
      (n, req) => {
        if (pasoDelTurno(req) === 0) return llamada("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: itemsCoca(f, 2) });
        return n === 1 ? COLGADA() : texto("Listo, su pedido quedo registrado.");
      },
      { turnBudgetMs: 30_000 },
      f,
    );
    const r = await m.correr([{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }]);
    const creadas = await ordenes(f);
    expect(creadas).toHaveLength(1); // el reintento NO volvio a crear el pedido
    expect(r.orderId).toBe(creadas[0]!.id);
    expect(tools(m.eventos).filter((e) => e.tool === "crear_pedido")).toHaveLength(1);
    expect(m.intentos).toHaveLength(3);
    const t = turno(m.eventos);
    expect(t.reintentosLlm).toBe(1);
    expect(t.reintentoLlmRecuperado).toBe(true);
  });

  it("herramienta con efectos y los DOS intentos atascados: el cliente sigue sabiendo que su pedido existe (nada a medias)", async () => {
    const f = buildRestaurantFixture();
    const { seedConfirmedOrderFlow } = await import("../support/order-flow-seed.ts");
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }] });
    const m = armar(
      (_n, req) => (pasoDelTurno(req) === 0 ? llamada("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: itemsCoca(f, 2) }) : COLGADA()),
      { turnBudgetMs: 30_000 },
      f,
    );
    const r = await m.correr([{ role: "user", content: "dos coca para recoger" }, { role: "assistant", content: "Total $90. ¿Confirma?" }, { role: "user", content: "si" }]);
    const creadas = await ordenes(f);
    expect(creadas).toHaveLength(1);
    expect(r.orderId).toBe(creadas[0]!.id);
    expect(m.intentos).toHaveLength(3); // 1 + 2: nunca mas de un reintento
    expect(turno(m.eventos).causaError).toBe("tope_llamada");
    expect(tools(m.eventos).filter((e) => e.tool === "crear_pedido")).toHaveLength(1);
  });

  it("la telemetria nueva no filtra contenido: los campos son un entero y un booleano", async () => {
    const m = armar((n) => (n === 0 ? COLGADA() : texto("Hola Nora Privada, 999 123 4567")), { turnBudgetMs: 18_000 });
    await m.correr([{ role: "user", content: "soy Nora Privada, mi cel 999 123 4567" }]);
    const t = turno(m.eventos);
    expect(typeof t.reintentosLlm).toBe("number");
    expect(typeof t.reintentoLlmRecuperado).toBe("boolean");
    const crudo = JSON.stringify(m.eventos);
    expect(crudo).not.toContain("Nora");
    expect(crudo).not.toContain("999 123 4567");
  });
});
