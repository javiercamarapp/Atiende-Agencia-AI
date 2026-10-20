// PM ronda 14: la telemetria `whatsapp_turno` no permitia separar un fallo del proveedor de uno de infraestructura local porque el
// `catch {` del turno no guardaba nada. Ahora el evento trae `causaError` (lista cerrada, derivada de la clase/codigo/mensaje de la excepcion
// SIN guardar el mensaje), `cierreMaquina` (la bandera RESTAURANTES_CIERRE_MAQUINA_ESTADOS en ese turno) y, por herramienta, solo el nombre,
// el resultado, la duracion y el codigo de regla (lista cerrada del flujo del pedido). Gateway falso: sin LLM real, sin llaves, sin gasto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AllProvidersFailedError,
  CircuitOpenError,
  FakeLlmProvider,
  GatewayBudgetExceededError,
  MonthlyBudgetExceededError,
  OpenRouterError,
  ResidencyGateBlockedError,
  RoleDailyTurnLimitExceededError,
} from "@atiende/agent-core";
import type { LlmGateway } from "@atiende/agent-core";
import { CIERRE_MAQUINA_ENV } from "../../src/agent-tools/cierre-maquina.ts";
import { resetOrderFlowWarningForTests } from "../../src/agent-tools/order-flow.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { hashTelefonoParaLogs } from "../../src/whatsapp/observabilidad-turno.ts";
import type { EventoObservabilidadWhatsApp, EventoTurnoWhatsApp, ObservabilidadTurno } from "../../src/whatsapp/observabilidad-turno.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { makeGateway, NEW_CUSTOMER, result } from "../pm/harness.ts";
import type { ScriptStep } from "../pm/harness.ts";

const PHONE = "+5219991234567";
const MENSAJE_CLIENTE = "Hola soy Nora Privada, mi cel 999 123 4567, mi direccion es Calle Secreta 123, quiero dos cocas";
const LLAVE_FALSA = "sk-or-v1-LLAVE-FALSA-NO-DEBE-SALIR";

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.stubEnv(CIERRE_MAQUINA_ENV, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Mundo = ReturnType<typeof armar>;

function armarCon(gateway: LlmGateway, opts: { maxToolUseTurns?: number; turnBudgetMs?: number } = {}) {
  const f = buildRestaurantFixture();
  const eventos: EventoObservabilidadWhatsApp[] = [];
  const obs: ObservabilidadTurno = { emitir: (e) => void eventos.push(e), hashTelefono: (t) => hashTelefonoParaLogs(t, "llave-de-prueba") };
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", observabilidad: obs, ...opts });
  const correr = (contenido = MENSAJE_CLIENTE) => handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: contenido }], customer: NEW_CUSTOMER, propertyId: null });
  return { f, eventos, correr };
}

/** Gateway falso cuya llamada al modelo siempre rechaza con `err`. */
function gatewayQueFalla(err: unknown): LlmGateway {
  return { complete: async () => { throw err; } } as unknown as LlmGateway;
}

/** Gateway real con un proveedor guionado (puede lanzar). */
function armar(steps: readonly ScriptStep[], opts: { maxToolUseTurns?: number; turnBudgetMs?: number } = {}) {
  const gateway = makeGateway();
  let n = 0;
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => { const s = steps[Math.min(n, steps.length - 1)]!; return result(s, n++); } })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  return armarCon(gateway, opts);
}

const turno = (m: Pick<Mundo, "eventos">) => m.eventos.find((e): e is EventoTurnoWhatsApp => e.evento === "whatsapp_turno")!;
const causa = (m: Pick<Mundo, "eventos">) => (turno(m) as unknown as { causaError?: unknown }).causaError;

describe("PM-R14 causaError: cada causa produce su valor de la lista cerrada", () => {
  const casos: Array<[string, unknown, string]> = [
    ["presupuesto mensual de la organizacion agotado", new MonthlyBudgetExceededError("organization", "org-1", 10, 5), "presupuesto_agotado"],
    ["presupuesto diario del tenant agotado", new GatewayBudgetExceededError("tenant", 1, 0.5), "presupuesto_agotado"],
    ["tope diario de turnos por rol", new RoleDailyTurnLimitExceededError("default", "org-1", 100, 100), "presupuesto_agotado"],
    ["presupuesto agotado envuelto en otro error (cadena de cause)", new Error("envoltura", { cause: new MonthlyBudgetExceededError("platform", "org-1", 10, 5) }), "presupuesto_agotado"],
    ["HTTP 402 del proveedor (sin credito)", new OpenRouterError("OpenRouter 402 (m): sin credito", 402, { transient: false, ladderRetryable: true }), "presupuesto_agotado"],
    ["HTTP 503 del proveedor", new OpenRouterError("OpenRouter 503 (m): upstream", 503, { transient: true, ladderRetryable: true }), "proveedor_5xx"],
    ["HTTP 429 del proveedor", new OpenRouterError("OpenRouter 429 (m): rate", 429, { transient: true, ladderRetryable: true }), "proveedor_5xx"],
    ["escalera agotada cuyo ultimo intento fue 502", new AllProvidersFailedError([{ providerId: "a", error: "OpenRouter 502 (m): bad gateway" }]), "proveedor_5xx"],
    ["circuito abierto del proveedor", new CircuitOpenError("p", 30), "proveedor_5xx"],
    ["timeout del proveedor (OpenRouter)", new OpenRouterError("OpenRouter timeout (m): aborted", undefined, { transient: true, ladderRetryable: true }), "proveedor_timeout"],
    ["escalera agotada por timeout", new AllProvidersFailedError([{ providerId: "a", error: "OpenRouter timeout (m): The operation was aborted" }]), "proveedor_timeout"],
    ["HTTP 408", new OpenRouterError("OpenRouter 408 (m): timeout", 408, { transient: true, ladderRetryable: true }), "proveedor_timeout"],
    ["error de red del proveedor", new OpenRouterError("OpenRouter network error (m): fetch failed", undefined, { transient: true, ladderRetryable: true }), "red"],
    ["conexion a la base terminada", new Error("Connection terminated due to connection timeout"), "red"],
    ["ECONNRESET", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "red"],
    ["gate de residencia bloqueado", new ResidencyGateBlockedError("MX", ["a"]), "regla"],
    ["excepcion no clasificable", new Error("algo raro"), "otro"],
    ["valor lanzado que ni es un Error", "texto suelto", "otro"],
  ];
  for (const [nombre, err, esperado] of casos) {
    it(`${nombre} => ${esperado}`, async () => {
      const m = armarCon(gatewayQueFalla(err));
      await m.correr();
      expect(turno(m).resultado).toBe("error_proveedor");
      expect(causa(m)).toBe(esperado);
    });
  }

  it("llamada al modelo colgada: vence el tope por llamada => tope_llamada", async () => {
    const m = armarCon({ complete: () => new Promise(() => undefined) } as unknown as LlmGateway, { turnBudgetMs: 100 });
    await m.correr();
    expect(turno(m).resultado).toBe("error_proveedor");
    expect(causa(m)).toBe("tope_llamada");
  });

  it("el reloj del turno ya vencio antes de llamar al modelo => presupuesto_agotado con causa tope_turno", async () => {
    const m = armar([{ text: "no se llega a llamar" }], { turnBudgetMs: -1 });
    await m.correr();
    expect(turno(m).resultado).toBe("presupuesto_agotado");
    expect(causa(m)).toBe("tope_turno");
  });

  it("gateway real: proveedor que lanza 503 en toda la escalera => proveedor_5xx", async () => {
    const gateway = makeGateway();
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => { throw new OpenRouterError("OpenRouter 503 (m): upstream", 503, { transient: true, ladderRetryable: true }); } })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const m = armarCon(gateway);
    await m.correr();
    expect(turno(m).resultado).toBe("error_proveedor");
    expect(causa(m)).toBe("proveedor_5xx");
  });

  it("loop agotado por herramientas que fallan con error del sistema => herramienta", async () => {
    const m = armar([{ calls: [{ name: "consultar_sucursal", args: { branch_slug: "fco-montejo" } }] }], { maxToolUseTurns: 2 });
    (m.f.repo as unknown as { runWithRowSavepoint: () => Promise<never> }).runWithRowSavepoint = async () => { throw new Error("base caida"); };
    await m.correr();
    expect(turno(m).resultado).toBe("loop_agotado");
    expect(turno(m).tools.every((t) => t.resultado === "error_sistema")).toBe(true);
    expect(causa(m)).toBe("herramienta");
  });

  it("loop agotado por rechazos de regla del servidor => regla", async () => {
    const m = armar([{ calls: [{ name: "cotizar_pedido", args: { branch_slug: "no-existe", canal: "recoger", items: [] } }] }], { maxToolUseTurns: 2 });
    await m.correr();
    expect(turno(m).resultado).toBe("loop_agotado");
    expect(turno(m).tools.every((t) => t.resultado === "error_regla")).toBe(true);
    expect(causa(m)).toBe("regla");
  });

  it("un turno que termina bien trae causaError null", async () => {
    const m = armar([{ text: "Hola, ¿qué desea pedir?" }]);
    await m.correr();
    expect(turno(m).resultado).toBe("ok");
    expect(causa(m)).toBeNull();
  });
});

describe("PM-R14 cierreMaquina: la bandera de la maquina de cierre en ese turno", () => {
  for (const [valor, esperado] of [["1", true], ["on", true], ["", false], ["0", false]] as const) {
    it(`${CIERRE_MAQUINA_ENV}="${valor}" => cierreMaquina=${esperado} (turno ok)`, async () => {
      vi.stubEnv(CIERRE_MAQUINA_ENV, valor);
      const m = armar([{ text: "Hola" }]);
      await m.correr();
      expect((turno(m) as unknown as { cierreMaquina?: unknown }).cierreMaquina).toBe(esperado);
    });
  }
  it("tambien se registra en un turno que termina en error del proveedor", async () => {
    vi.stubEnv(CIERRE_MAQUINA_ENV, "1");
    const on = armarCon(gatewayQueFalla(new Error("x")));
    await on.correr();
    vi.stubEnv(CIERRE_MAQUINA_ENV, "");
    const off = armarCon(gatewayQueFalla(new Error("x")));
    await off.correr();
    expect((turno(on) as unknown as { cierreMaquina?: unknown }).cierreMaquina).toBe(true);
    expect((turno(off) as unknown as { cierreMaquina?: unknown }).cierreMaquina).toBe(false);
  });
});

describe("PM-R14 herramientas del turno: nombre, resultado, duracion y codigo de regla", () => {
  it("cada herramienta trae tool/resultado/latenciaMs numerico y codigoRegla null o de la lista del flujo; un rechazo del flujo lo trae", async () => {
    vi.stubEnv(CIERRE_MAQUINA_ENV, "1");
    const m = armar([
      { calls: [{ name: "consultar_sucursal", args: { branch_slug: "fco-montejo" } }] },
      { calls: [{ name: "crear_pedido", args: { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora Privada", payment_method: "efectivo", items: [] } }] },
      { text: "Necesito confirmar su pedido primero." },
    ]);
    await m.correr();
    const t = turno(m);
    expect(t.tools.map((x) => x.tool)).toEqual(["consultar_sucursal", "crear_pedido"]);
    for (const x of t.tools as ReadonlyArray<{ tool: string; resultado: string; latenciaMs: number; codigoRegla?: unknown }>) {
      expect(typeof x.latenciaMs).toBe("number");
      expect(["ok", "error_regla", "error_sistema"]).toContain(x.resultado);
      expect("codigoRegla" in x).toBe(true);
      expect(x.codigoRegla === null || (typeof x.codigoRegla === "string" && /^[a-z_]+$/.test(x.codigoRegla))).toBe(true);
    }
    const [ok, rechazo] = t.tools as ReadonlyArray<{ tool: string; resultado: string; codigoRegla?: unknown }>;
    expect(ok!.codigoRegla).toBeNull();
    // crear_pedido sin cotizar lo rechaza el flujo del servidor: viaja el CODIGO, no el texto del error.
    expect(rechazo).toMatchObject({ resultado: "error_regla", codigoRegla: "sin_cotizacion" });
  });
});

describe("PM-R14 privacidad: el evento no lleva texto del cliente, telefonos, argumentos, mensajes de error ni llaves", () => {
  it("turno con error del proveedor cuyo mensaje trae llave y datos: solo la clase llega al evento", async () => {
    const m = armarCon(gatewayQueFalla(new OpenRouterError(`OpenRouter 503 (m): Authorization Bearer ${LLAVE_FALSA} para ${MENSAJE_CLIENTE}`, 503, { transient: true, ladderRetryable: true })));
    await m.correr();
    const serial = JSON.stringify(m.eventos);
    expect(causa(m)).toBe("proveedor_5xx");
    for (const prohibido of [LLAVE_FALSA, "LLAVE-FALSA", "Bearer", "Nora Privada", "Calle Secreta", "999 123 4567", "9991234567", "5219991234567", "quiero dos cocas", "upstream"]) {
      expect(serial, prohibido).not.toContain(prohibido);
    }
  });

  it("turno con herramientas: ni los argumentos (nombre del cliente) ni el texto del cliente aparecen en ningun evento", async () => {
    vi.stubEnv(CIERRE_MAQUINA_ENV, "1");
    const m = armar([
      { calls: [{ name: "crear_pedido", args: { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora Privada", delivery_address: "Calle Secreta 123", payment_method: "efectivo", items: [] } }] },
      { text: "Gracias, ¿qué le gustaría pedir exactamente?" },
    ]);
    await m.correr();
    const serial = JSON.stringify(m.eventos);
    expect(m.eventos.length).toBeGreaterThan(0);
    for (const prohibido of ["Nora Privada", "Calle Secreta", "999 123 4567", "9991234567", "5219991234567", "quiero dos cocas", "qué le gustaría"]) {
      expect(serial, prohibido).not.toContain(prohibido);
    }
    expect(turno(m).telefonoHash).toMatch(/^tel_[0-9a-f]{16}$/);
    // Los campos nuevos existen (el evento no se limita a callar).
    expect("causaError" in turno(m)).toBe(true);
    expect("cierreMaquina" in turno(m)).toBe(true);
  });

  it("el mensaje crudo de una excepcion desconocida no se guarda: causaError es una de las nueve causas", async () => {
    const m = armarCon(gatewayQueFalla(new Error(`secreto ${LLAVE_FALSA} ${PHONE}`)));
    await m.correr();
    expect(JSON.stringify(m.eventos)).not.toContain("secreto");
    expect(["tope_llamada", "tope_turno", "presupuesto_agotado", "proveedor_5xx", "proveedor_timeout", "red", "regla", "herramienta", "otro"]).toContain(causa(m));
  });
});
