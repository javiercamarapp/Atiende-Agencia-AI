// PM R18 + R19: el cierre determinista (#631) tras el respaldo de proveedor (#630). Primer intento por tope -> respaldo -> el respaldo tambien falla (o el turno muere): con un «si» claro a un
// resumen vigente se crea UN pedido y la telemetria conserva el reintento real. Si el respaldo SI responde, el servidor no inyecta nada. Modelos simulados, reloj simulado, sin llaves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { CIERRE_MAQUINA_ENV } from "../../src/agent-tools/cierre-maquina.ts";
import { resetOrderFlowWarningForTests } from "../../src/agent-tools/order-flow.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { MODELO_ALTERNO_TOPE_ID, MODELO_PREDETERMINADO_ID } from "../../src/ajustes-agente/modelos.ts";
import { hashTelefonoParaLogs } from "../../src/whatsapp/observabilidad-turno.ts";
import type { EventoObservabilidadWhatsApp, EventoToolWhatsApp, EventoTurnoWhatsApp, ObservabilidadTurno } from "../../src/whatsapp/observabilidad-turno.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { itemsCoca, llamada, ordenes, texto } from "../pm-r11-romper/arnes.ts";

const PHONE = "+5219991234567";
const LUNA = MODELO_PREDETERMINADO_ID;
const DEEPSEEK = MODELO_ALTERNO_TOPE_ID;
const COLGADA = (): Promise<LlmCompletionResult> => new Promise(() => undefined);

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Guion = (modelo: string, request: LlmCompletionRequest) => LlmCompletionResult | Promise<LlmCompletionResult>;

async function armar(hacerGuion: (f: ReturnType<typeof buildRestaurantFixture>) => Guion) {
  const f = buildRestaurantFixture();
  const guion = hacerGuion(f);
  // Perfil PM (el cierre determinista es solo de PM) con horario abierto 24/7 en el reloj simulado.
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "00:00", cierra: "23:59" }], propinaPolitica: "solo_tarjeta" });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const intentos: string[] = [];
  const proveedor = (modelo: string) => new FakeLlmProvider({ id: modelo, model: modelo, script: (request) => (intentos.push(modelo), guion(modelo, request)) });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [proveedor(LUNA), proveedor(DEEPSEEK)]);
  gateway.registerLadder("escalated", [proveedor("escalado/modelo")]);
  const eventos: EventoObservabilidadWhatsApp[] = [];
  const obs: ObservabilidadTurno = { emitir: (e) => void eventos.push(e), hashTelefono: (t) => hashTelefonoParaLogs(t, "llave-de-prueba") };
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", observabilidad: obs, turnBudgetMs: 30_000 });
  const correr = async (messages: Array<{ role: "user" | "assistant"; content: string }>) => {
    const p = handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages, customer: { isNew: true }, propertyId: null });
    await vi.advanceTimersByTimeAsync(40_000);
    return p;
  };
  return { f, intentos, eventos, correr };
}

const turnos = (eventos: EventoObservabilidadWhatsApp[]) => eventos.filter((e): e is EventoTurnoWhatsApp => e.evento === "whatsapp_turno");
const tools = (eventos: EventoObservabilidadWhatsApp[]) => eventos.filter((e): e is EventoToolWhatsApp => e.evento === "whatsapp_tool");

/** Turno 1 (cotizar y mostrar el resumen, normal) + turno 2 con `turno2` para el «si». */
function guionDe(f: ReturnType<typeof buildRestaurantFixture>, turno2: Guion): Guion {
  return (modelo, req) => {
    const usuarios = req.messages.filter((m) => m.role === "user").length;
    if (usuarios === 1) {
      const herramientas = req.messages.filter((m) => m.role === "tool");
      if (herramientas.length === 0) return llamada("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", items: itemsCoca(f, 2) });
      const total = (JSON.parse(String(herramientas.at(-1)!.content)) as { quote: { total: number } }).quote.total;
      return texto(`Permítame repetirle su pedido: 2 Coca-Cola. Total $${total}.00. ¿Es correcto?`);
    }
    return turno2(modelo, req);
  };
}

describe.each([
  ["maquina de cierre apagada", ""],
  ["maquina de cierre encendida", "1"],
] as const)("cierre determinista tras el respaldo de proveedor (%s)", (_n, flag) => {
  beforeEach(() => vi.stubEnv(CIERRE_MAQUINA_ENV, flag));

  async function resumen(m: Awaited<ReturnType<typeof armar>>) {
    const r1 = await m.correr([{ role: "user", content: "dos coca para recoger, soy Ana" }]);
    return [{ role: "user" as const, content: "dos coca para recoger, soy Ana" }, { role: "assistant" as const, content: r1.reply }];
  }

  it("primer intento por tope -> respaldo tambien falla: UN pedido por el cierre determinista, telemetria del reintento intacta, e idempotente", async () => {
    const m2 = await armar((f) => guionDe(f, () => COLGADA()));
    const previo = await resumen(m2);
    const antes = m2.intentos.length;
    const r = await m2.correr([...previo, { role: "user", content: "Sí, es correcto" }]);
    expect(m2.intentos.slice(antes)).toEqual([LUNA, DEEPSEEK]); // 1er intento (tope) + UN respaldo; ninguna llamada mas
    const creadas = await ordenes(m2.f);
    expect(creadas).toHaveLength(1);
    expect(r.orderId).toBe(creadas[0]!.id);
    expect(r.reply).not.toMatch(/problema t[eé]cnico|no alcanc[eé]/i);
    const t = turnos(m2.eventos).at(-1)!;
    expect(t.reintentosLlm).toBe(1);
    expect(t.modeloRespaldoLlm).toBe(DEEPSEEK);
    expect(t.causaError).toBe("tope_llamada");
    expect(t.modeloRespondioLlm).toBeNull(); // ningun modelo contesto: no se inventa uno
    expect(tools(m2.eventos).filter((e) => e.tool === "crear_pedido")).toHaveLength(1);
    // Otro «si» despues (el modelo ya responde): no crea un segundo pedido.
    const r3 = await m2.correr([...previo, { role: "user", content: "Sí, es correcto" }, { role: "assistant", content: r.reply }, { role: "user", content: "sí" }]);
    expect(r3.orderId ?? null).toBeNull();
    expect(await ordenes(m2.f)).toHaveLength(1);
  });

  it("el respaldo SI responde: el servidor no inyecta el cierre (el modelo decide)", async () => {
    const m2 = await armar((f) => guionDe(f, (modelo) => (modelo === LUNA ? COLGADA() : texto("Con gusto, ¿algo más?"))));
    const previo = await resumen(m2);
    const r = await m2.correr([...previo, { role: "user", content: "Sí, es correcto" }]);
    expect(r.reply).toContain("Con gusto");
    expect(await ordenes(m2.f)).toHaveLength(0);
    const t = turnos(m2.eventos).at(-1)!;
    expect(t.reintentosLlm).toBe(1);
    expect(t.modeloRespondioLlm).toBe(DEEPSEEK);
    expect(tools(m2.eventos).filter((e) => e.tool === "crear_pedido" || e.tool === "confirmar_resumen")).toHaveLength(0);
  });
});
