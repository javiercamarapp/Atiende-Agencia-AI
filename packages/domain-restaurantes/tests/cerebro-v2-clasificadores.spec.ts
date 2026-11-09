// Cerebro v2 (SUELTO-VS-718-V2.md «Alergia antes del modelo: clasificador semántico ABIERTO» y «B4: salvo clasificador ¿aparte?»): los dos clasificadores LLM
// del suelto conectados por el gateway del monorrepo con su rol (`clasificadorRole`, en producción `restaurantes:whatsapp_clasificador`, actividad
// `clasificacion_whatsapp` de la tabla central de modelos: Gemini 3.5 Flash-Lite -> Luna, ambos ZDR), siempre con retención cero (zdrEstricto),
// temperatura 0 y salida estructurada:
//  - alergia semántica (suelto ~6479, alergiasSemanticasDelTurno): regex O clasificador => alergia; lo que la regex no ve y el clasificador marca escala igual.
//  - «¿aparte?» (suelto ~8022-8045): si la guarda del pedido en la sesión rechaza (no por cotizar) y hay respuesta a «¿Quiere hacer un pedido aparte?», el
//    clasificador lee lo que dijo el cliente y la guarda se recalcula con esa intención; sin clasificador o si falla, null (modo R24, como antes).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";
import { executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { hiloDelSuelto } from "../src/whatsapp/cerebro-v2/hilo-herramientas.ts";
import { MARCA_PROMPT_CLASIFICADOR_ALERGIA, NOMBRE_ESQUEMA_ALERGIA } from "../src/whatsapp/cerebro-v2/clasificador-alergia.ts";
import { clasificadorAlergiaPorGateway, clasificadorApartePorGateway } from "../src/whatsapp/cerebro-v2/clasificadores-gateway.ts";
import { entradaClasificadorPedidoAparte, motivoOtroPedidoEnSesion, PREGUNTA_PEDIDO_APARTE, type IntencionPedidoAparte } from "../src/whatsapp/cerebro-v2/pedido-aparte.ts";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest } from "@atiende/agent-core";

const T0 = new Date("2026-10-13T19:00:00-06:00");
const NO_LO_VE_LA_REGEX = "el cacahuate y yo no nos llevamos";

function gatewayCon(respuesta: (req: LlmCompletionRequest) => string) {
  const g = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  const vistos: LlmCompletionRequest[] = [];
  g.registerZdrLadder("clasificador", [new FakeLlmProvider({ id: "c", script: (req) => (vistos.push(req), { text: respuesta(req), model: "c", tokensIn: 1, tokensOut: 1, costUsd: 0 }) })]);
  return { g, vistos };
}

describe("clasificadores por el gateway (puros con gateway falso)", () => {
  it("alergia: rol propio con ZDR, temperatura 0, salida estructurada y el JSON parseado; una falla => null", async () => {
    const { g, vistos } = gatewayCon(() => JSON.stringify({ declara_restriccion_alimentaria: true, texto: "cacahuate" }));
    const c = clasificadorAlergiaPorGateway(g, { organizationId: "org", role: "clasificador" });
    expect(await c(NO_LO_VE_LA_REGEX, { llave: "gateway", plazoMs: 1500 })).toEqual({ declara: true, texto: "cacahuate" });
    expect(vistos[0]!.system).toContain(MARCA_PROMPT_CLASIFICADOR_ALERGIA);
    expect(vistos[0]!.temperature).toBe(0);
    expect(vistos[0]!.responseFormat?.name).toBe(NOMBRE_ESQUEMA_ALERGIA);
    const roto = clasificadorAlergiaPorGateway(gatewayCon(() => "no es json").g, { organizationId: "org", role: "clasificador" });
    expect(await roto("x", { llave: "gateway", plazoMs: 1500 })).toBeNull();
    const sinEscalera = clasificadorAlergiaPorGateway(gatewayCon(() => "{}").g, { organizationId: "org", role: "otro-rol" });
    expect(await sinEscalera("x", { llave: "gateway", plazoMs: 1500 })).toBeNull();
  });

  it("«¿aparte?»: devuelve la intención del JSON; indefinido/basura => null", async () => {
    const entrada = { pregunta: PREGUNTA_PEDIDO_APARTE, conversacion: [{ rol: "cliente" as const, texto: "sí, pero súmalo a lo de antes" }] };
    const ok = clasificadorApartePorGateway(gatewayCon(() => JSON.stringify({ intencion: "sumar_al_mismo" })).g, { organizationId: "org", role: "clasificador" });
    expect(await ok(entrada, { llave: "gateway", plazoMs: 2000 })).toBe("sumar_al_mismo");
    const basura = clasificadorApartePorGateway(gatewayCon(() => "{\"intencion\":\"quien sabe\"}").g, { organizationId: "org", role: "clasificador" });
    expect(await basura(entrada, { llave: "gateway", plazoMs: 2000 })).toBeNull();
  });
});

describe("cerebro v2: clasificador semántico de alergia en el turno", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("lo que la regex no ve y el clasificador marca escala como alergia (aviso escalada:alergia_salud); sin clasificador, no", async () => {
    const con = await nuevoViaje({ cerebroV2: true, clasificador: (req) => (String(req.system).includes(MARCA_PROMPT_CLASIFICADOR_ALERGIA) ? JSON.stringify({ declara_restriccion_alimentaria: true, texto: "cacahuate" }) : "{}") });
    await con.escribe(NO_LO_VE_LA_REGEX);
    expect(con.callbacks.some((c) => c.reason === "escalada:alergia_salud")).toBe(true);
    const sin = await nuevoViaje({ cerebroV2: true });
    await sin.escribe(NO_LO_VE_LA_REGEX);
    expect(sin.callbacks.some((c) => c.reason === "escalada:alergia_salud")).toBe(false);
  });

  it("el clasificador dice que no: no hay aviso (solo cuenta la regex)", async () => {
    const v = await nuevoViaje({ cerebroV2: true, clasificador: () => JSON.stringify({ declara_restriccion_alimentaria: false, texto: null }) });
    await v.escribe(NO_LO_VE_LA_REGEX);
    expect(v.callbacks.some((c) => c.reason === "escalada:alergia_salud")).toBe(false);
  });
});

describe("cerebro v2: clasificador «¿aparte?» en la guarda del pedido en la sesión", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  async function primerPedido(v: Viaje) {
    const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items } }] },
      { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" },
    ]);
    await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Gabriela Poot, pago con tarjeta");
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
  }

  it("paridad con el suelto: con respuesta a la pregunta, la guarda se recalcula con la intención del clasificador", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await primerPedido(v);
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000));
    const guardado = await v.world.repo.whatsappAppendTurn(v.world.organizationId, TEL_CLIENTE, [], null, null, null);
    const ahora = new Date().toISOString();
    const hilo = [...hiloDelSuelto(guardado), { role: "assistant" as const, content: PREGUNTA_PEDIDO_APARTE, at: ahora }, { role: "user" as const, content: "sí, pero súmalo a lo de antes por favor", at: ahora }];
    const entrada = entradaClasificadorPedidoAparte(hilo);
    expect(entrada).not.toBeNull();
    const input = { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items: [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 6 }] };
    const llamadas: unknown[] = [];
    const clasificarAparte = async (e: unknown): Promise<IntencionPedidoAparte | null> => (llamadas.push(e), "sumar_al_mismo");
    const ctx = { organizationId: v.world.organizationId, channel: "whatsapp" as const, phone: TEL_CLIENTE, entryPropertyId: v.t7, cerebroV2: true, hiloV2: hilo, conversacionReciente: hilo.map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content ?? "") })), clasificarAparte };
    const r = await executeAgentToolSafely(v.world.repo, ctx, "crear_pedido", input);
    expect(llamadas).toEqual([entrada]);
    const esperado = motivoOtroPedidoEnSesion(hilo, input, { ahoraMs: Date.now(), intencionAparte: "sumar_al_mismo" });
    expect((r.result as { error?: string }).error).toBe(esperado);
  });
});
