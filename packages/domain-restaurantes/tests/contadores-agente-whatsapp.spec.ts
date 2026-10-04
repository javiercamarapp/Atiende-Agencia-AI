// rescate-orig-restaurantes-1 §3 (P11, P32; T-HO07): contadores DETERMINISTAS de "no entiendo" y "colonia no reconocida" en WhatsApp. Cuenta el
// servidor entre turnos; al llegar a 2 escala por su cuenta con un texto fijo. LLM simulado por guion (el modelo no decide nada de esto).
import { describe, expect, it, vi } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { CONTADOR_AGENTE_UMBRAL, COPY_ESCALACION_CONTADOR, pideRepetir } from "../src/whatsapp/contadores-agente.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;
const PHONE = "+5219990002222";

function armar(guion: (n: number) => LlmCompletionResult, config: Record<string, unknown> = {}) {
  const f = buildRestaurantFixture();
  let n = 0;
  const provider = new FakeLlmProvider({ id: "guion", script: () => guion((n += 1)) });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  const preparar = () => f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { ...PM, ...config } as never);
  const turno = (contenido: string, propertyId: string | null = null) =>
    handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: contenido }], customer: { isNew: true }, propertyId, messageId: `wamid.${n}.${contenido.length}` });
  return { f, handler, provider, preparar, turno };
}

describe("colonia no reconocida dos veces -> escala zona_no_reconocida (una sola vez)", () => {
  // Cada turno: el modelo llama buscar_sucursal_cercana con una colonia y despues contesta con texto.
  const guionColonia = (colonia: string) => (n: number) => (n % 2 === 1 ? llamada(`c${n}`, "buscar_sucursal_cercana", { colonia }) : texto("No la ubiqué, ¿me da otra referencia?"));

  it("dos colonias inventadas en turnos distintos: el 2.o turno escala con el texto fijo y crea UN aviso", async () => {
    const colonias = ["Narnia", "Mordor"];
    let turnoActual = 0;
    const { f, preparar, turno } = armar((n) => guionColonia(colonias[turnoActual]!)(n));
    await preparar();
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    const t1 = await turno("vivo en Narnia");
    expect(t1.reply).toContain("¿me da otra referencia?");
    expect((t1 as { escalacion?: unknown }).escalacion).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();

    turnoActual = 1;
    const t2 = await turno("Mordor");
    expect(t2.reply).toBe(COPY_ESCALACION_CONTADOR.zona_no_reconocida);
    expect((t2 as { escalacion?: { motivo: string } }).escalacion).toEqual({ motivo: "zona_no_reconocida" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ customerPhone: PHONE, reason: "escalada:zona_no_reconocida", source: "whatsapp" });
  });

  it("una colonia invalida y luego una valida: NO escala y el contador se reinicia (otra invalida despues vuelve a contar desde 1)", async () => {
    let colonia = "Narnia";
    const { f, preparar, turno } = armar((n) => guionColonia(colonia)(n));
    f.repo.seedKnownZone({ organizationId: f.organizationId, name: "Vista Alegre", lat: 21.0152, lng: -89.5995 });
    await preparar();
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    await turno("Narnia");
    colonia = "Vista Alegre";
    const valida = await turno("Vista Alegre");
    expect((valida as { escalacion?: unknown }).escalacion).toBeUndefined();
    colonia = "Mordor";
    const otra = await turno("Mordor");
    expect(otra.reply).not.toBe(COPY_ESCALACION_CONTADOR.zona_no_reconocida);
    expect(spy).not.toHaveBeenCalled();
  });

  it("tras escalar el contador vuelve a 0: la siguiente colonia invalida no escala sola", async () => {
    const { f, preparar, turno } = armar(guionColonia("Narnia"));
    await preparar();
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    await turno("a");
    const escalo = await turno("b");
    expect(escalo.reply).toBe(COPY_ESCALACION_CONTADOR.zona_no_reconocida);
    const siguiente = await turno("c");
    expect(siguiente.reply).not.toBe(COPY_ESCALACION_CONTADOR.zona_no_reconocida);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("dos intentos fallidos en el MISMO turno tambien escalan (el modelo reintenta la colonia)", async () => {
    const { f, preparar, turno } = armar((n) => (n <= 2 ? llamada(`c${n}`, "buscar_sucursal_cercana", { colonia: `Inventada ${n}` }) : texto("x")));
    await preparar();
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    const t = await turno("vivo por ahi");
    expect(t.reply).toBe(COPY_ESCALACION_CONTADOR.zona_no_reconocida);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("una zona conocida pero fuera de cobertura NO es 'colonia no reconocida' (no cuenta)", async () => {
    const { f, preparar, turno } = armar(guionColonia("Lejos"));
    f.repo.seedKnownZone({ organizationId: f.organizationId, name: "Lejos", lat: 25.0, lng: -100.0 });
    await preparar();
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    await turno("a");
    await turno("b");
    expect(spy).not.toHaveBeenCalled();
  });

  it("el perfil generico (sin PM) no se toca", async () => {
    const { f, turno } = armar(guionColonia("Narnia"));
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    await turno("a");
    const t = await turno("b");
    expect(t.reply).not.toBe(COPY_ESCALACION_CONTADOR.zona_no_reconocida);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("'no entiendo' dos veces seguidas -> escala no_entiende", () => {
  const pideRepetirTexto = "Disculpe, no le entendí bien. ¿Me puede repetir su pedido, por favor?";

  it("dos respuestas seguidas que piden repetir: la 2.a la sustituye el servidor por el texto fijo y escala (T-HO07)", async () => {
    const { f, preparar, turno } = armar(() => texto(pideRepetirTexto));
    await preparar();
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    const t1 = await turno("asdf qwer");
    expect(t1.reply).toContain("repetir");
    const t2 = await turno("zxcv");
    expect(t2.reply).toBe(COPY_ESCALACION_CONTADOR.no_entiende);
    expect((t2 as { escalacion?: { motivo: string } }).escalacion).toEqual({ motivo: "no_entiende" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ reason: "escalada:no_entiende", source: "whatsapp" });
  });

  it("pedir repetir una vez y luego una respuesta normal: NO escala y el contador se reinicia", async () => {
    const respuestas = [pideRepetirTexto, "Con gusto, ¿para recoger o a domicilio?", pideRepetirTexto];
    const { f, preparar, turno } = armar((n) => texto(respuestas[n - 1]!));
    await preparar();
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    for (const m of ["??", "quiero tacos", "ñññ"]) {
      const t = await turno(m);
      expect(t.reply).not.toBe(COPY_ESCALACION_CONTADOR.no_entiende);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("motivo desactivado por el negocio (escalationReasonsOff): no cuenta ni escala", async () => {
    const { f, preparar, turno } = armar(() => texto(pideRepetirTexto));
    await preparar();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { ...PM, escalationReasonsOff: ["no_entiende"] } as never);
    const spy = vi.spyOn(f.repo, "createCallbackRequest");
    await turno("a");
    const t = await turno("b");
    expect(t.reply).toContain("repetir");
    expect(spy).not.toHaveBeenCalled();
  });

  it("pideRepetir: solo frases claras de 'no entendi'/'repita', no cualquier pregunta", () => {
    for (const si of ["No le entendí, ¿me puede repetir?", "¿Podría repetirme el pedido?", "No logro entender su mensaje", "¿Me puede repetir su pedido, por favor?"]) expect(pideRepetir(si), si).toBe(true);
    for (const no of ["¿Para recoger o a domicilio?", "Su total es $90.00, ¿es correcto?", "Repito su pedido: dos tacos."]) expect(pideRepetir(no), no).toBe(false);
    expect(CONTADOR_AGENTE_UMBRAL).toBe(2);
  });
});

describe("base SIN migrar: sin donde contar el agente sigue funcionando (SAVEPOINT, sesion viva)", () => {
  it("la funcion del contador no existe (42883): devuelve null y la MISMA sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /whatsapp_contador_agente/i, respond: () => Object.assign(new Error("function restaurantes.whatsapp_contador_agente does not exist"), { code: "42883" }) },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.contadorAgenteWhatsApp("o", "+521", "no_entiende", "incrementar")).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("con la funcion disponible manda organizacion, telefono, clave y accion", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([{ match: /whatsapp_contador_agente/i, respond: () => [{ n: 2 }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      if (/whatsapp_contador_agente/i.test(sql)) params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;
    expect(await new PostgresRestaurantesRepository(session).contadorAgenteWhatsApp("o", "+521", "colonia_no_reconocida", "incrementar")).toBe(2);
    expect(params).toEqual(["o", "+521", "colonia_no_reconocida", "incrementar"]);
  });

  it("el repositorio en memoria cuenta, reinicia y deja vencer el contador a las 2 h", async () => {
    vi.useFakeTimers();
    try {
      const repo = new InMemoryRestaurantesRepository();
      expect(await repo.contadorAgenteWhatsApp("o", "p", "no_entiende", "incrementar")).toBe(1);
      expect(await repo.contadorAgenteWhatsApp("o", "p", "no_entiende", "incrementar")).toBe(2);
      expect(await repo.contadorAgenteWhatsApp("o", "p", "colonia_no_reconocida", "incrementar")).toBe(1);
      vi.advanceTimersByTime(121 * 60_000);
      expect(await repo.contadorAgenteWhatsApp("o", "p", "no_entiende", "incrementar")).toBe(1);
      await repo.contadorAgenteWhatsApp("o", "p", "no_entiende", "reiniciar");
      expect(await repo.contadorAgenteWhatsApp("o", "p", "no_entiende", "incrementar")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
