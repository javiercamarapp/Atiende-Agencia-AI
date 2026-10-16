// R10 P1 (latencia): vueltas del modelo por tipo de turno, medidas con un MODELO SIMULADO determinista (sin LLM real, sin red) contra el handler real de WhatsApp.
//
// Por que vueltas: en la ronda 10 el turno de WhatsApp tardo mediana 12.8 s / p95 23.6 s con ~3.3 s por vuelta del modelo, mientras que cada herramienta tarda 2-42 ms (mediana
// por herramienta en la bitacora `whatsapp_tool` de la ronda: buscar_cliente 2, buscar_producto 9, buscar_sucursal_cercana 17, cotizar_pedido 27, crear_pedido 42 ms). El tiempo
// de un turno son sus vueltas. Bitacora real (223 turnos con telemetria, `whatsapp_turno` + `whatsapp_tool`):
//
//   vueltas  turnos   mediana del turno
//        1      44        3.0 s     (saludo / respuesta directa, sin herramientas)
//        2      79        6.2 s     (una ronda de herramientas + texto)
//        3      72        9.0 s     (dos rondas + texto)   <- 20 de estos son el «si»: confirmar_resumen (v1), crear_pedido (v2), texto (v3)
//      4-6      28       12.7-16.5 s
//
// Lo que se prueba aqui es lo que el SERVIDOR permite y garantiza; lo que el modelo real decide hacer (si junta llamadas o no) NO se puede verificar sin otra ronda con LLM real.
//
// Lo que se analizo y NO se hizo (con la razon verificable en el codigo):
//  (a) Ejecutar en paralelo las herramientas de un mismo turno: las herramientas ya se aceptan en lote (varios tool_calls en UNA respuesta = UNA vuelta, ver abajo) y su
//      ejecucion suma ms, no segundos. Ademas es INSEGURO: cada llamada abre su SAVEPOINT (`executeAgentToolSafely` -> `repo.runWithRowSavepoint`) sobre la transaccion unica del
//      request (ver packages/db/src/savepoint-fallback.ts); SAVEPOINT / ROLLBACK TO / RELEASE intercalados en una sola conexion se pisan entre si.
//  (b) Precargar `buscar_sucursal_cercana` con el pin compartido: el pin llega normalmente DESPUES de la colonia (el servidor mismo manda el boton de ubicacion tras la primera
//      asignacion por colonia) y la herramienta cruza colonia contra pin (#556); precargarla solo con el pin se saltaria ese cruce. Precargar `buscar_cliente` de un cliente CONOCIDO
//      meteria la direccion completa en cada prompt (hoy es deliberado que solo la vea quien llama la herramienta).
//  (c) Cerrar «confirmar_resumen + crear_pedido» sin modelo, o saltar el texto final tras crear_pedido: construir los argumentos de crear_pedido en el servidor es el cierre
//      determinista de #562 (aun sin fusionar), y el texto del modelo lleva el tiempo estimado que la confirmacion del servidor (`confirmacionDePedido`) no trae.
//
// Lo que si se hizo: el servidor le dice al modelo el resultado de `buscar_cliente` cuando el cliente es NUEVO (identico al de la herramienta) para ahorrar esa vuelta.
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { MARCA_DATOS_YA_CONSULTADOS } from "../../src/whatsapp/datos-ya-consultados.ts";
import { normalizePhone } from "../../src/phone.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamadas = (...calls: Array<readonly [string, string, object]>): LlmCompletionResult => ({
  text: "",
  toolCalls: calls.map(([id, name, args]) => ({ id, name, argumentsJson: JSON.stringify(args) })),
  model: "fake",
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
});
const PM = { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null } as const;
const PHONE = "+5219990004444";

type Guion = (req: LlmCompletionRequest) => LlmCompletionResult;

function armar() {
  const f = buildRestaurantFixture();
  let guion: Guion = () => texto("Con gusto.");
  const peticiones: LlmCompletionRequest[] = [];
  const provider = new FakeLlmProvider({ id: "sim", script: (req) => { peticiones.push(req); return guion(req); } });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  let n = 0;
  /** Un turno completo por el webhook; `cola` son las respuestas sucesivas del modelo simulado. Devuelve cuantas vueltas gasto. */
  const turno = async (body: string, cola: LlmCompletionResult[]) => {
    const restantes = [...cola];
    guion = () => restantes.shift() ?? texto("Con gusto.");
    const antes = peticiones.length;
    n += 1;
    const outcome = await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: `wamid.V${n}`, phone: PHONE, body, phoneNumberId: "pn-vueltas" });
    return { outcome, vueltas: peticiones.length - antes, sobrantes: restantes.length, ultima: peticiones[peticiones.length - 1]! };
  };
  const pedidos = async () => {
    const c = await f.repo.findCustomerByPhone(f.organizationId, normalizePhone(PHONE));
    return c ? await f.repo.listEligibleOrderHistory(c.id) : [];
  };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
  const cotizar = llamadas(["q", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items }]);
  const confirmar = (id = "k") => [id, "confirmar_resumen", {}] as const;
  const crear = (id = "c") => [id, "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "efectivo", items }] as const;
  const resumen = texto("Su pedido: 1 Coca-Cola, total $45.00 para recoger. ¿Lo confirma?");
  const preparar = async () => { await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM as never); };
  /** Deja el pedido cotizado con el resumen mostrado: el siguiente turno es el «si». */
  const hastaElResumen = async () => { await preparar(); return turno("quiero una coca para recoger", [cotizar, resumen]); };
  const herramientasDe = (req: LlmCompletionRequest) => req.messages.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.name) : []));
  return { f, handler, turno, pedidos, cotizar, confirmar, crear, resumen, hastaElResumen, preparar, herramientasDe, peticiones };
}

describe("vueltas del modelo por tipo de turno (modelo simulado, handler real)", () => {
  it("saludo / respuesta directa: 1 vuelta", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.turno("hola", [texto("Buenas tardes, ¿es para recoger o a domicilio?")]);
    expect(r.vueltas).toBe(1);
  });

  it("cotizar con el carrito ya buscado: herramienta + texto = 2 vueltas", async () => {
    const t = armar();
    const r = await t.hastaElResumen();
    expect(r.vueltas).toBe(2);
  });

  it("buscar_producto de 3 productos en UNA respuesta = 2 vueltas; uno por respuesta = 4 (el servidor acepta el lote: lo que decide es el modelo)", async () => {
    const t = armar();
    await t.preparar();
    const buscar = (id: string, q: string) => [id, "buscar_producto", { query: q, branch_slug: "fco-montejo" }] as const;
    const lote = await t.turno("quiero coca, sol y tacos", [llamadas(buscar("b1", "coca"), buscar("b2", "sol"), buscar("b3", "tacos")), texto("Tengo los tres.")]);
    expect(lote.vueltas).toBe(2);
    expect(lote.ultima.messages.filter((m) => m.role === "tool")).toHaveLength(3);
    const uno = await t.turno("y una coca mas, un sol y tacos", [llamadas(buscar("b4", "coca")), llamadas(buscar("b5", "sol")), llamadas(buscar("b6", "tacos")), texto("Listo.")]);
    expect(uno.vueltas).toBe(4);
  });

  it("buscar_producto -> cotizar_pedido -> texto: 3 vueltas (cotizar depende de lo que devuelve la busqueda)", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.turno("una coca para recoger", [llamadas(["b", "buscar_producto", { query: "coca", branch_slug: "fco-montejo" }]), t.cotizar, t.resumen]);
    expect(r.vueltas).toBe(3);
  });

  it("el «si» SECUENCIAL (lo que hace el modelo real, 20 de 20 en la bitacora): confirmar_resumen, crear_pedido, texto = 3 vueltas y 1 pedido", async () => {
    const t = armar();
    await t.hastaElResumen();
    const r = await t.turno("si", [llamadas(t.confirmar()), llamadas(t.crear()), texto("Su pedido ya quedó registrado.")]);
    expect(r.vueltas).toBe(3);
    expect(r.outcome.orderId).not.toBeNull();
    expect(await t.pedidos()).toHaveLength(1);
  });

  it("el «si» en LOTE: confirmar_resumen + crear_pedido en UNA respuesta = 2 vueltas, mismo pedido, y el orden de dependencia se respeta", async () => {
    const t = armar();
    await t.hastaElResumen();
    const r = await t.turno("si", [llamadas(t.confirmar(), t.crear()), texto("Su pedido ya quedó registrado.")]);
    expect(r.vueltas).toBe(2);
    expect(await t.pedidos()).toHaveLength(1);
    expect(t.herramientasDe(r.ultima)).toEqual(["confirmar_resumen", "crear_pedido"]);
    const resultados = r.ultima.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(resultados[0]).not.toContain('"error"');
    expect(resultados[1]).not.toContain('"error"');
  });

  it("idempotencia: el lote [confirmar, crear] y un crear_pedido repetido en la vuelta siguiente dejan UN solo pedido", async () => {
    const t = armar();
    await t.hastaElResumen();
    const r = await t.turno("si", [llamadas(t.confirmar(), t.crear("c1")), llamadas(t.crear("c2")), texto("Su pedido ya quedó registrado.")]);
    expect(r.vueltas).toBe(3);
    expect(await t.pedidos()).toHaveLength(1);
  });

  it("dependencia: crear_pedido ANTES de confirmar_resumen en el mismo lote lo rechaza el servidor (no nace un pedido sin «si»); cuesta una vuelta extra", async () => {
    const t = armar();
    await t.hastaElResumen();
    const r = await t.turno("si", [llamadas(t.crear("c1"), t.confirmar()), llamadas(t.crear("c2")), texto("Su pedido ya quedó registrado.")]);
    const resultados = r.ultima.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(resultados[0]).toContain('"error"');
    expect(r.vueltas).toBe(3);
    expect(await t.pedidos()).toHaveLength(1);
  });

  it("dependencia: [confirmar_resumen, crear_pedido] SIN cotizacion previa no crea ningun pedido", async () => {
    const t = armar();
    await t.preparar();
    const r = await t.turno("si", [llamadas(t.confirmar(), t.crear()), texto("Disculpe, ¿me repite su pedido?")]);
    expect(r.vueltas).toBe(2);
    expect(await t.pedidos()).toHaveLength(0);
    const resultados = r.ultima.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(resultados.every((x) => x.includes('"error"'))).toBe(true);
  });
});

describe("datos que el servidor ya consulto: buscar_cliente de un cliente nuevo no cuesta una vuelta", () => {
  // Modelo simulado OBEDIENTE: si el prompt ya trae el resultado de buscar_cliente no la llama; si no, la llama (como manda el paso 3) y luego escribe. Que el modelo real obedezca
  // el bloque no se puede probar sin LLM real; esto prueba que el servidor se lo dice solo cuando el resultado es identico al de la herramienta.
  const obediente: Guion = (req) => {
    const ultimo = req.messages.at(-1);
    if (ultimo?.role === "tool") return texto("Bienvenido, ¿es para recoger o a domicilio?");
    if (req.system.includes(MARCA_DATOS_YA_CONSULTADOS)) return texto("Bienvenido, ¿es para recoger o a domicilio?");
    return llamadas(["bc", "buscar_cliente", {}]);
  };

  async function correr(opciones: { perfilPm: boolean; clienteNuevo: boolean; preview?: boolean }) {
    const f = buildRestaurantFixture();
    if (opciones.perfilPm) await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM as never);
    let vueltas = 0;
    let sistema = "";
    const provider = new FakeLlmProvider({ id: "sim", script: (req) => { vueltas += 1; sistema = req.system; return obediente(req); } });
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [provider]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const conocido = { isNew: false as const, name: "Luis", orderCount: 3, addresses: [], lastOrderItems: null, frequentItems: [], tier: null, agentNotes: [] };
    await handler.handleInboundMessage({
      organizationId: f.organizationId,
      phone: PHONE,
      messages: [{ role: "user", content: "hola" }],
      customer: opciones.clienteNuevo ? { isNew: true } : conocido,
      ...(opciones.preview ? { modo: "preview" as const } : {}),
    });
    return { vueltas, sistema };
  }

  it("PM + cliente nuevo: el prompt trae el resultado y el turno cuesta 1 vuelta (antes 2)", async () => {
    const r = await correr({ perfilPm: true, clienteNuevo: true });
    expect(r.sistema).toContain(MARCA_DATOS_YA_CONSULTADOS);
    expect(r.vueltas).toBe(1);
  });

  it("PM + cliente conocido: el prompt NO cambia (la direccion guardada solo la ve quien llama la herramienta) y sigue costando 2 vueltas", async () => {
    const r = await correr({ perfilPm: true, clienteNuevo: false });
    expect(r.sistema).not.toContain(MARCA_DATOS_YA_CONSULTADOS);
    expect(r.vueltas).toBe(2);
  });

  it("perfil generico o vista previa del panel: el prompt NO cambia", async () => {
    expect((await correr({ perfilPm: false, clienteNuevo: true })).sistema).not.toContain(MARCA_DATOS_YA_CONSULTADOS);
    expect((await correr({ perfilPm: true, clienteNuevo: true, preview: true })).sistema).not.toContain(MARCA_DATOS_YA_CONSULTADOS);
  });
});
