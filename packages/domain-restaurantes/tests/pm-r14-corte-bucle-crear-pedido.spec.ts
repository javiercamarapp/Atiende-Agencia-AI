// PM ronda 14 (hallazgo H2): confirmar_resumen ok -> crear_pedido error_regla -> buscar_producto x7 hasta agotar el reloj de 18 s. El servidor ya rechaza el pedido
// (es su trabajo); lo que sobraba era dejar que el modelo reintentara hasta vencer el turno. Tras un crear_pedido rechazado por regla el turno corta y responde con el
// resumen canonico (o un mensaje fijo) SOLO si: (i) se repite el MISMO rechazoDelFlujo, (ii) hay 3 llamadas repetidas con la misma firma (herramienta + argumentos) o
// (iii) respaldo: 6 llamadas siguientes sin una cotizacion exitosa. Las lecturas con argumentos nuevos son el modelo corrigiendo el pedido y NO cuentan para (ii).
// LLM falso guionado, sin red ni llaves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { CIERRE_MAQUINA_ENV } from "../src/agent-tools/cierre-maquina.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_COPY } from "../src/whatsapp/perfil-pm.ts";
import type { EventoObservabilidadWhatsApp, EventoTurnoWhatsApp } from "../src/whatsapp/observabilidad-turno.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
const PHONE = "+5219990001111";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
  vi.stubEnv(CIERRE_MAQUINA_ENV, "1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

async function mundo(guion: (paso: number, f: ReturnType<typeof buildRestaurantFixture>, req: LlmCompletionRequest) => LlmCompletionResult) {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let llamadas = 0;
  const provider = new FakeLlmProvider({ id: "guion", script: (request: LlmCompletionRequest) => guion((llamadas += 1), f, request) });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "escalado-sin-uso" })]);
  const eventos: EventoObservabilidadWhatsApp[] = [];
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", observabilidad: { emitir: (e) => void eventos.push(e) } });
  const turno = (messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" }]) => handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages, customer: { isNew: true as const }, propertyId: null });
  const evento = () => eventos.findLast((e): e is EventoTurnoWhatsApp => e.evento === "whatsapp_turno")!;
  return { f, turno, evento, llamadas: () => llamadas };
}

const cotiza = (f: { products: { cocaCola: string } }, id = "c1") =>
  llamada(id, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", payment_method: "efectivo", efectivo_con: 500, items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
// crear_pedido en el mismo turno que la cotizacion: el servidor lo rechaza por regla (el cliente aun no confirmo).
const crea = (f: { products: { cocaCola: string } }, id: string) =>
  llamada(id, "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500, items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
const busca = (id: string) => llamada(id, "buscar_producto", { query: "coca" });

describe("corte del bucle crear_pedido bloqueado -> buscar_producto", () => {
  it("con la maquina de cierre ON: al SEGUNDO error_regla de crear_pedido el turno termina con el resumen canonico, sin escalar ni crear pedido", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return busca("b1");
      if (paso === 4) return crea(f, "k2");
      return busca(`b${paso}`); // el modelo seguiria buscando hasta agotar el reloj
    });
    const t = await m.turno();
    expect(m.llamadas()).toBeLessThanOrEqual(4);
    expect(m.evento().vueltas).toBeLessThanOrEqual(4);
    expect(m.evento().tools.map((x) => x.tool)).toEqual(["cotizar_pedido", "crear_pedido", "buscar_producto", "crear_pedido"]);
    expect(m.evento().tools.filter((x) => x.tool === "crear_pedido").map((x) => x.resultado)).toEqual(["error_regla", "error_regla"]);
    expect(m.evento().resultado).toBe("ok");
    expect(t.reply).toContain("Total a pagar: $");
    expect(t.reply).toMatch(/¿Está correcto\? Responda \*sí\*/);
    expect(t.orderId ?? null).toBeNull();
    expect((t as { escalacion?: unknown }).escalacion).toBeUndefined();
  });

  it("con la maquina de cierre OFF (sin resumen canonico): el mismo corte con el mensaje fijo que pide confirmar o corregir", async () => {
    vi.stubEnv(CIERRE_MAQUINA_ENV, "");
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return busca("b1");
      if (paso === 4) return crea(f, "k2");
      return busca(`b${paso}`);
    });
    const t = await m.turno();
    expect(m.llamadas()).toBeLessThanOrEqual(4);
    expect(m.evento().resultado).toBe("ok");
    expect(t.reply).toBe(PM_COPY.cierreBloqueado);
    expect(t.orderId ?? null).toBeNull();
    expect((t as { escalacion?: unknown }).escalacion).toBeUndefined();
  });

  it("un solo rechazo de regla no corta: el modelo explica con su texto", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      return texto("Aun necesito su confirmacion para registrar el pedido.");
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(3);
    expect(t.reply).toContain("Aun necesito su confirmacion");
    expect(t.reply).not.toBe(PM_COPY.cierreBloqueado);
  });

  it("dos rechazos NO consecutivos (una cotizacion nueva exitosa en medio) no cortan", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f, "c1");
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return cotiza(f, "c2");
      if (paso === 4) return crea(f, "k2");
      return texto("Revisemos el pedido otra vez, por favor.");
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(5);
    expect(t.reply).toContain("Revisemos el pedido otra vez");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Revision independiente: el patron REAL de R13 (un solo crear_pedido rechazado y luego solo lectura), botones, telemetria y guardas.
// ---------------------------------------------------------------------------------------------------------------------
const crudo = (id: string, name: string, argumentsJson: string): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

describe("corte ampliado: tras un crear_pedido rechazado, 3 llamadas que no sean una cotizacion exitosa", () => {
  it("patron R13: cotizar -> crear (rechazo) -> buscar x N: corta en la 3a lectura (5 llamadas), con resumen canonico, botones y telemetria", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      return busca(`b${paso}`);
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(5);
    expect(m.evento().tools.map((x) => x.tool)).toEqual(["cotizar_pedido", "crear_pedido", "buscar_producto", "buscar_producto", "buscar_producto"]);
    expect(m.evento().resultado).toBe("ok");
    const ev = m.evento() as unknown as { causaError?: unknown; cierreCortado?: unknown };
    expect(ev.causaError).toBe("regla");
    expect(ev.cierreCortado).toBe(true);
    expect(t.reply).toContain("Total a pagar: $");
    expect((t as { pedirConfirmacion?: unknown }).pedirConfirmacion).toBeDefined();
    expect(t.orderId ?? null).toBeNull();
  });

  it("un turno normal no marca cierreCortado", async () => {
    const m = await mundo(() => texto("Hola, ¿qué desea pedir?"));
    await m.turno();
    const ev = m.evento() as unknown as { causaError?: unknown; cierreCortado?: unknown };
    expect(ev.cierreCortado).toBe(false);
    expect(ev.causaError).toBeNull();
  });

  it("con la maquina OFF el patron R13 corta con el texto fijo, sin botones", async () => {
    vi.stubEnv(CIERRE_MAQUINA_ENV, "");
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      return busca(`b${paso}`);
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(5);
    expect(t.reply).toBe(PM_COPY.cierreBloqueado);
    expect((t as { pedirConfirmacion?: unknown }).pedirConfirmacion).toBeUndefined();
  });

  it("dos lecturas tras el rechazo NO cortan (el modelo explica con su texto)", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso <= 4) return busca(`b${paso}`);
      return texto("Aun necesito su confirmacion para registrar el pedido.");
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(5);
    expect(t.reply).toContain("Aun necesito su confirmacion");
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(false);
  });

  it("una cotizacion exitosa reinicia la cuenta de lecturas", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f, "c1");
      if (paso === 2) return crea(f, "k1");
      if (paso === 3 || paso === 4) return busca(`b${paso}`);
      if (paso === 5) return cotiza(f, "c2");
      if (paso === 6 || paso === 7) return busca(`b${paso}`);
      return texto("Revisemos el pedido otra vez.");
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(8);
    expect(t.reply).toContain("Revisemos el pedido otra vez");
  });

  it("argumentos invalidos en crear_pedido reinician la cuenta (otra clase de fallo)", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return crudo("k2", "crear_pedido", "{no es json");
      if (paso === 4) return crea(f, "k3");
      return texto("Revisemos el pedido otra vez.");
    });
    // Los argumentos invalidos suben al rol escalado (B04): ese rol, no el guion, contesta la vuelta siguiente. Lo que importa aqui es que NO se corto por el bucle.
    await m.turno();
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(false);
    expect(m.evento().tools.map((x) => x.tool)).toEqual(["cotizar_pedido", "crear_pedido", "crear_pedido"]);
  });

  it("guarda escalarMotivo: si el modelo ya escalo a un humano en el turno, no se corta", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return llamada("e1", "escalar_a_humano", { customer_name: "Nora", motivo: "otro", resumen: "pidio hablar con alguien" });
      if (paso === 3) return crea(f, "k1");
      if (paso <= 7) return busca(`b${paso}`);
      return texto("Ya avise al equipo.");
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(8);
    expect(t.reply).toContain("Ya avise al equipo");
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(false);
  });

  it("guarda orderId: tras un pedido creado en el turno, rechazos posteriores no pisan la confirmacion", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return texto("Listo, ¿confirma su pedido?"); // turno 1 termina con el resumen canonico
      if (paso === 3) return llamada("c2", "confirmar_resumen", {}); // turno 2: el cliente dijo «sí»
      if (paso === 4) return crea(f, "k1");
      if (paso === 5) return crea(f, "k2"); // repite el crear: ya_registrado o rechazo, nunca debe pisar el pedido
      if (paso <= 9) return busca(`b${paso}`);
      return texto("Su pedido quedó registrado.");
    });
    const hist = [{ role: "user" as const, content: "dos cocas para recoger, soy Nora, pago con 500" }];
    const t1 = await m.turno(hist);
    const t2 = await m.turno([...hist, { role: "assistant", content: t1.reply }, { role: "user", content: "sí" }]);
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(false);
    expect(t2.orderId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Revision 2: sin falsos cortes. Las lecturas con argumentos NUEVOS son el modelo corrigiendo el pedido, no un bucle.
// ---------------------------------------------------------------------------------------------------------------------
const buscaQ = (id: string, query: string) => llamada(id, "buscar_producto", { query });
const creaTarjeta = (f: { products: { cocaCola: string } }, id: string) =>
  llamada(id, "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora", payment_method: "tarjeta", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });

describe("corte sin falsos positivos", () => {
  it("pedido grande legitimo: cotizar -> crear rechazado -> 3 busquedas DISTINTAS -> cotizar corregido: NO corta y la cotizacion corregida se ejecuta", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f, "c1");
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return buscaQ("b1", "pepsi");
      if (paso === 4) return buscaQ("b2", "sprite");
      if (paso === 5) return buscaQ("b3", "agua");
      if (paso === 6) return cotiza(f, "c2");
      return texto("Corregí su pedido; revíselo y avíseme.");
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(7);
    expect(m.evento().tools.map((x) => x.tool)).toEqual(["cotizar_pedido", "crear_pedido", "buscar_producto", "buscar_producto", "buscar_producto", "cotizar_pedido"]);
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(false);
    expect(t.reply).toContain("Corregí su pedido");
  });

  it("R13 con argumentos IGUALES (misma firma x3): corta en la tercera repeticion", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      return buscaQ(`b${paso}`, "coca");
    });
    await m.turno();
    expect(m.llamadas()).toBe(5);
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(true);
  });

  it("R13 con argumentos DISTINTOS cada vez: el respaldo corta tras 6 llamadas siguientes (el tope de 8 sigue acotando)", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      return buscaQ(`b${paso}`, `producto ${paso}`);
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(8);
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(true);
    expect(m.evento().resultado).toBe("ok");
    expect(t.reply).toContain("Total a pagar: $");
  });

  it("guion R13 completo: confirmar_resumen ok -> crear_pedido rechazado -> buscar_producto x7 distintos: corta (no llega a loop_agotado)", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return texto("Listo, ¿confirma su pedido?");
      if (paso === 3) return llamada("c2", "confirmar_resumen", {});
      if (paso === 4) return creaTarjeta(f, "k1"); // cambia el pago respecto al resumen confirmado: el servidor lo rechaza
      return buscaQ(`b${paso}`, `producto ${paso}`);
    });
    const hist = [{ role: "user" as const, content: "dos cocas para recoger, soy Nora, pago con 500" }];
    const t1 = await m.turno(hist);
    const t2 = await m.turno([...hist, { role: "assistant", content: t1.reply }, { role: "user", content: "sí" }]);
    const tools = m.evento().tools.map((x) => `${x.tool}:${x.resultado}`);
    expect(tools.slice(0, 2)).toEqual(["confirmar_resumen:ok", "crear_pedido:error_regla"]);
    expect(m.evento().resultado).toBe("ok");
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(true);
    expect(m.evento().vueltas).toBeLessThanOrEqual(8);
    expect(t2.orderId ?? null).toBeNull();
  });

  it("argumentos invalidos en LECTURAS no suman ni reinician: 4 lecturas distintas validas + 2 invalidas NO cortan", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return buscaQ("b1", "pepsi");
      if (paso === 4) return crudo("i1", "buscar_producto", "{no es json");
      if (paso === 5) return buscaQ("b2", "sprite");
      if (paso === 6) return crudo("i2", "buscar_producto", "{tampoco");
      if (paso === 7) return buscaQ("b3", "agua");
      if (paso === 8) return buscaQ("b4", "jarritos");
      return texto("fin");
    });
    await m.turno();
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(false);
  });

  it("un crear_pedido con argumentos invalidos reinicia el bloqueo (y no suma como la 6a llamada): NO corta", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso <= 7) return buscaQ(`b${paso}`, `producto ${paso}`); // 5 lecturas distintas tras el rechazo
      if (paso === 8) return crudo("i1", "crear_pedido", "{no es json"); // sumaria la 6a si no se tratara como otra clase de fallo
      return texto("fin");
    });
    // El crear invalido sube al rol escalado (B04) y ese rol contesta; lo que importa es que NO hubo corte.
    await m.turno();
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(false);
  });

  it("un cotizar_pedido fallido ni suma ni reinicia (es un intento de correccion)", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return llamada("c2", "cotizar_pedido", { branch_slug: "no-existe", canal: "recoger", items: [] }); // falla
      if (paso === 4) return buscaQ("b1", "pepsi");
      if (paso === 5) return buscaQ("b2", "sprite");
      if (paso === 6) return buscaQ("b3", "agua");
      if (paso === 7) return buscaQ("b4", "jarritos");
      if (paso === 8) return buscaQ("b5", "fanta");
      return texto("fin");
    });
    await m.turno();
    // 5 lecturas distintas tras el rechazo (el cotizar fallido no suma): no llega a 6.
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(false);
  });

  it("quoteHash: si el flujo ya no tiene la cotizacion de este turno, el corte responde con texto fijo y SIN botones", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 5) {
        // Justo antes del corte, otra escritura cambio la cotizacion vigente: el hash del flujo ya no es el del resumen de este turno.
        const lee = f.repo.readOrderFlow.bind(f.repo);
        (f.repo as unknown as { readOrderFlow: typeof lee }).readOrderFlow = async (...a) => {
          const r = await lee(...a);
          return r && r.context ? { ...r, context: { ...r.context, quoteHash: "otro-hash" } } : r;
        };
      }
      return buscaQ(`b${paso}`, "coca");
    });
    const t = await m.turno();
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(true);
    expect((t as { pedirConfirmacion?: unknown }).pedirConfirmacion).toBeUndefined();
    expect(t.reply).toBe(PM_COPY.cierreBloqueado);
  });

  it("quoteHash igual: el corte lleva los botones", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      return buscaQ(`b${paso}`, "coca");
    });
    const t = await m.turno();
    expect((t as { pedirConfirmacion?: unknown }).pedirConfirmacion).toBeDefined();
  });
});

describe("revision 3: cotizar fallido no reinicia, y los botones solo con una cotizacion verificable", () => {
  it("caso D: buscar «coca» x2, cotizar_pedido FALLIDO, buscar «coca»: un cotizar fallido NO reinicia, corta en la 6a llamada", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 3 || paso === 4) return buscaQ(`b${paso}`, "coca");
      if (paso === 5) return llamada("c2", "cotizar_pedido", { branch_slug: "no-existe", canal: "recoger", items: [] }); // falla
      return buscaQ(`b${paso}`, "coca");
    });
    await m.turno();
    expect(m.llamadas()).toBe(6);
    expect(m.evento().tools.map((x) => `${x.tool}:${x.resultado}`)[4]).toBe("cotizar_pedido:error_regla");
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(true);
  });

  it("sin cotizacion en este turno (resumen del rechazo del servidor) y otro quoteHash vigente: el texto sale SIN botones, nunca con el hash nuevo", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return texto("Listo, ¿confirma su pedido?"); // turno 1
      if (paso === 3) return llamada("c2", "confirmar_resumen", {}); // turno 2: el cliente dijo «sí»
      if (paso === 4) return creaTarjeta(f, "k1"); // el servidor lo rechaza con su resumen canonico
      if (paso === 5) {
        // Otro pedido sustituyo la cotizacion vigente: el hash del flujo ya no es el del resumen que viene del rechazo.
        const lee = f.repo.readOrderFlow.bind(f.repo);
        (f.repo as unknown as { readOrderFlow: typeof lee }).readOrderFlow = async (...a) => {
          const r = await lee(...a);
          return r && r.context ? { ...r, context: { ...r.context, quoteHash: "hash-de-otro-pedido" } } : r;
        };
      }
      return buscaQ(`b${paso}`, "coca");
    });
    const hist = [{ role: "user" as const, content: "dos cocas para recoger, soy Nora, pago con 500" }];
    const t1 = await m.turno(hist);
    const t2 = await m.turno([...hist, { role: "assistant", content: t1.reply }, { role: "user", content: "sí" }]);
    expect((m.evento() as unknown as { cierreCortado?: unknown }).cierreCortado).toBe(true);
    expect((t2 as { pedirConfirmacion?: unknown }).pedirConfirmacion).toBeUndefined();
  });
});
