// Latencia R5: llamadas SECUENCIALES al modelo por turno (cada vuelta del bucle de tool-use espera a la anterior).
// Arnes determinista: el modelo es un guion con una latencia virtual fija por llamada (3 s, sin dormir de verdad) y se cuenta cuantas
// llamadas seguidas hace el turno por tipo. No mide latencia real del proveedor: fija el numero de vueltas que el SERVIDOR deja al modelo.
// El modelo simulado es OBEDIENTE y sin agrupar herramientas (una por vuelta, el peor caso razonable): sigue lo que le dicen las notas del servidor.
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { NOTA_TOQUE_CONFIRMAR, parsearIdDeBoton } from "../../src/whatsapp/botones-confirmacion.ts";
import { normalizePhone } from "../../src/phone.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

/** Latencia virtual de CADA llamada al modelo. */
export const MS_POR_LLAMADA = 3_000;

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;
const PHONE = "+5219990004444";
const SLUG = "fco-montejo";

type Politica = (req: LlmCompletionRequest, vuelta: number) => LlmCompletionResult;

function armar() {
  const f = buildRestaurantFixture();
  let politica: Politica = () => texto("Con gusto.");
  let virtualMs = 0;
  const peticiones: LlmCompletionRequest[] = [];
  const provider = new FakeLlmProvider({
    id: "latencia",
    script: (req) => {
      virtualMs += MS_POR_LLAMADA;
      peticiones.push(req);
      return politica(req, peticiones.length);
    },
  });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  const turnHandler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  let n = 0;
  /** Un turno completo por el webhook: devuelve cuantas llamadas SECUENCIALES al modelo hizo y la latencia virtual que sumaron. */
  const turno = async (body: string, p: Politica, extra: { botonId?: string } = {}) => {
    politica = p;
    n += 1;
    const antes = peticiones.length;
    const t0 = virtualMs;
    const outcome = await handleInboundWhatsAppMessage(f.repo, turnHandler, { organizationId: f.organizationId, messageId: `wamid.L${n}`, phone: PHONE, body, phoneNumberId: "pn-lat", ...extra });
    return { outcome, llamadas: peticiones.length - antes, latenciaVirtualMs: virtualMs - t0, peticiones: peticiones.slice(antes) };
  };
  const salida = () => f.repo.getOutbox().map((o) => ({ key: o.dedupeKey, ...(o.payload as { body: string; buttons?: { id: string; title: string }[] }) }));
  const botones = () => [...salida()].reverse().find((s) => s.buttons)?.buttons ?? [];
  const pedidos = async () => {
    const c = await f.repo.findCustomerByPhone(f.organizationId, normalizePhone(PHONE));
    return c ? await f.repo.listEligibleOrderHistory(c.id) : [];
  };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
  return { f, turno, salida, botones, pedidos, items, preparar: () => f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM as never) };
}

const ultimoUsuario = (req: LlmCompletionRequest): string => {
  const m = [...req.messages].reverse().find((x) => x.role === "user");
  return m && m.role === "user" ? m.content : "";
};
/** Cuantos resultados de herramienta lleva ya ESTE turno (los mensajes `tool` del arreglo efimero). */
const rondasDeHerramienta = (req: LlmCompletionRequest): number => req.messages.filter((m) => m.role === "tool").length;
/** Nombres de las herramientas que ya respondieron en este turno. */
const herramientasHechas = (req: LlmCompletionRequest): string[] => req.messages.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.name) : []));

/** Un guion lineal: la vuelta k (0 = primera) devuelve `pasos[k]`. */
const lineal = (...pasos: LlmCompletionResult[]): Politica => (req) => pasos[Math.min(rondasDeHerramienta(req), pasos.length - 1)]!;

describe("R5 latencia: llamadas secuenciales al modelo por tipo de turno (modelo simulado, 3 s por llamada)", () => {
  it("saludo con buscar_cliente: 2 llamadas (la lectura del cliente es del modelo; no se prefetch para no meter la direccion completa al prompt)", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.turno("hola", lineal(llamada("a", "buscar_cliente", {}), texto("Buenas tardes, con gusto le ayudo. ¿Va a recoger o es a domicilio?")));
    expect(r.llamadas).toBe(2);
    expect(r.latenciaVirtualMs).toBe(2 * MS_POR_LLAMADA);
  });

  it("saludo sin herramienta: 1 llamada", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.turno("hola", lineal(texto("Buenas tardes, con gusto le ayudo. ¿Va a recoger o es a domicilio?")));
    expect(r.llamadas).toBe(1);
  });

  it("cotizar (buscar_producto -> cotizar_pedido -> resumen): 3 llamadas", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.turno(
      "quiero una coca para recoger",
      lineal(llamada("b", "buscar_producto", { query: "coca", branch_slug: SLUG }), llamada("q", "cotizar_pedido", { branch_slug: SLUG, canal: "recoger", items: t.items }), texto("Su pedido: 1 Coca-Cola, total $45.00 para recoger. ¿Es correcto?")),
    );
    expect(r.llamadas).toBe(3);
    expect(r.latenciaVirtualMs).toBe(3 * MS_POR_LLAMADA);
  });

  /** Deja una cotizacion vigente y devuelve los botones del resumen. */
  async function conCotizacion() {
    const t = armar();
    await t.preparar();
    await t.turno("quiero una coca para recoger", lineal(llamada("q", "cotizar_pedido", { branch_slug: SLUG, canal: "recoger", items: t.items }), texto("Su pedido: 1 Coca-Cola, total $45.00 para recoger. ¿Es correcto?")));
    return t;
  }
  const crearArgs = (t: ReturnType<typeof armar>) => ({ branch_slug: SLUG, canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items: t.items });

  it("«si» escrito (confirmar_resumen y crear_pedido en vueltas separadas -> texto): 3 llamadas", async () => {
    const t = await conCotizacion();
    const r = await t.turno(
      "si",
      lineal(llamada("k", "confirmar_resumen", {}), llamada("c", "crear_pedido", crearArgs(t)), texto("Listo, su pedido ya quedó registrado. Lo esperamos en 25 a 35 minutos.")),
    );
    expect(r.llamadas).toBe(3);
    expect(r.outcome.orderId).not.toBeNull();
  });

  it("toque «Confirmar pedido» vigente: el modelo obediente sigue la nota del servidor y el servidor ya registro la confirmacion", async () => {
    const t = await conCotizacion();
    const b = t.botones().find((x) => parsearIdDeBoton(x.id)?.accion === "confirmar")!;
    // Obediente: si la nota dice «llame confirmar_resumen y enseguida crear_pedido» y no habla de una confirmacion ya registrada, hace las dos en vueltas separadas.
    const obediente: Politica = (req) => {
      const hechas = herramientasHechas(req);
      const nota = ultimoUsuario(req);
      const yaConfirmada = hechas.includes("confirmar_resumen") || /YA registr[óo] la confirmaci[óo]n/i.test(nota);
      if (!yaConfirmada && nota.includes(NOTA_TOQUE_CONFIRMAR.slice(0, 40))) return llamada("k", "confirmar_resumen", {});
      if (!hechas.includes("crear_pedido")) return llamada("c", "crear_pedido", crearArgs(t));
      return texto("Listo, su pedido ya quedó registrado. Lo esperamos en 25 a 35 minutos.");
    };
    const r = await t.turno(b.title, obediente, { botonId: b.id });
    expect(r.outcome.orderId).not.toBeNull();
    expect(await t.pedidos()).toHaveLength(1);
    // BASE (antes de la optimizacion): confirmar_resumen + crear_pedido + texto = 3 llamadas.
    expect(r.llamadas).toBe(3);
  });

  it("estado de un pedido ya creado: 1 llamada (el estado viaja en el prompt)", async () => {
    const t = await conCotizacion();
    await t.turno("si", lineal(llamada("k", "confirmar_resumen", {}), llamada("c", "crear_pedido", crearArgs(t)), texto("Listo, su pedido ya quedó registrado.")));
    const r = await t.turno("¿cómo va mi pedido?", lineal(texto("Su pedido ya quedó registrado y la sucursal lo está preparando.")));
    expect(r.llamadas).toBe(1);
  });

  it("escalar a humano por el modelo (aviso + texto): 2 llamadas", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.turno("quiero que me cambien la receta del pastor", lineal(llamada("e", "escalar_a_humano", { customer_name: "Luis", motivo: "modificacion_platillo", resumen: "pide cambiar la receta" }), texto("Permítame avisar al gerente de la sucursal; le responden en cuanto puedan.")));
    expect(r.llamadas).toBe(2);
    expect(r.outcome.ok).toBe(true);
  });

  it("alto riesgo detectado por el servidor (cobro duplicado): 0 llamadas al modelo", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.turno("me cobraron dos veces mi pedido", () => texto("NO DEBE LLAMARSE"));
    expect(r.llamadas).toBe(0);
  });
});
