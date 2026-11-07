// Cerebro v2 (decision B): menos vueltas del modelo por turno. Luna por Azure ZDR cuesta p50 3.0 s / p90 5.4-6.3 s por llamada; el turno vale lo que sus llamadas.
// Modelo SIMULADO (sin LLM real, sin red) contra el handler real sobre el catalogo y las zonas reales de PM (mundo en memoria del seed). «Llamadas» = peticiones que llegan al
// proveedor simulado. El modelo simulado se porta como Luna en C3: UNA herramienta por respuesta (sucursal -> producto -> producto -> cotizar -> texto) y usa lo que ya
// tiene en el historial del turno. Lo que el modelo real hara con el bloque nuevo solo lo mide el arnes C3.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { buildInMemoryPmWorld } from "../../src/seed/pm-world.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { MARCA_CONTEXTO_PRECARGADO, coloniaDelMensaje, mensajeParaPrecargaV2, mensajeSinColonia, precargarBusquedas } from "../../src/whatsapp/contexto-precargado.ts";
import { loteAdmiteResumenSinVuelta } from "../../src/whatsapp/cerebro-v2/resumen-sin-vuelta.ts";
import type { ObservabilidadTurno } from "../../src/whatsapp/observabilidad-turno.ts";
import { MARTES_14H, planPm } from "../qa-viaje/arnes-viaje.ts";
import type { CustomerLookupResult, KnownZone } from "../../src/types.ts";

const PHONE = "+5219995550177";
const NUEVO: CustomerLookupResult = { isNew: true };
const base = { model: "sim", tokensIn: 1, tokensOut: 1, costUsd: 0 };
const texto = (text: string): LlmCompletionResult => ({ text, ...base });
const herramientas = (n: number, ...calls: Array<readonly [string, object]>): LlmCompletionResult => ({ text: "", toolCalls: calls.map(([name, args], i) => ({ id: `c${n}-${i}`, name, argumentsJson: JSON.stringify(args) })), ...base });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Modelo = (req: LlmCompletionRequest, n: number) => LlmCompletionResult;

async function armar(v2: boolean, opts: { entrada?: boolean; observabilidad?: ObservabilidadTurno } = {}) {
  const world = await buildInMemoryPmWorld(planPm());
  const t7 = world.propertyBySlug.get("garcia-lavin")!;
  const peticiones: LlmCompletionRequest[] = [];
  let modelo: Modelo = () => texto("Con gusto.");
  const provider = new FakeLlmProvider({ id: "sim", model: "sim", script: (req) => { peticiones.push({ ...req, messages: [...req.messages] }); return modelo(req, peticiones.length); } });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [provider]);
  gateway.registerZdrLadder("default", [provider]);
  const handler = createLlmWhatsAppTurnHandler(world.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerCerebroV2: async () => v2, ...(opts.observabilidad ? { observabilidad: opts.observabilidad } : {}) });
  const turno = async (mensaje: string, m: Modelo, historial: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = []) => {
    modelo = m;
    const antes = peticiones.length;
    const r = await handler.handleInboundMessage({ organizationId: world.organizationId, phone: PHONE, messages: [...historial, { role: "user", content: mensaje }], customer: NUEVO, propertyId: opts.entrada === false ? null : t7 });
    return { ...r, llamadas: peticiones.length - antes, primera: peticiones[antes]!, ultima: peticiones.at(-1)! };
  };
  return { world, turno, peticiones, producto: (n: string) => world.productIds.get(n)! };
}

/** Lo que ya trae el historial del turno (lo que va despues del ultimo mensaje del cliente). */
function delTurno(req: LlmCompletionRequest) {
  const ultimo = req.messages.findLastIndex((m) => m.role === "user");
  const resto = req.messages.slice(ultimo + 1);
  return {
    llamadas: resto.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.name) : [])),
    resultados: resto.filter((m) => m.role === "tool").map((m) => String(m.content)),
  };
}

interface Pedido {
  readonly colonia?: string;
  readonly productos: readonly { readonly query: string; readonly nombre: string; readonly qty: number }[];
  readonly cotizar: Record<string, unknown>;
}

/** Modelo a la Luna de C3: una herramienta por respuesta, sin repetir lo que ya esta en el historial del turno. */
function modeloUnoPorRespuesta(p: Pedido, producto: (n: string) => string): Modelo {
  return (req, n) => {
    const { llamadas, resultados } = delTurno(req);
    let slug = "garcia-lavin";
    if (p.colonia) {
      const suc = resultados.map((r) => JSON.parse(r) as { estado?: string; branch_slug?: string }).find((r) => r.estado === "asignada");
      if (!suc) return herramientas(n, ["buscar_sucursal_cercana", { colonia: p.colonia }]);
      slug = suc.branch_slug!;
    }
    const falta = p.productos.find((x) => !resultados.some((r) => r.includes(`"name":"${x.nombre}"`)));
    if (falta) return herramientas(n, ["buscar_producto", { query: falta.query, branch_slug: slug }]);
    if (!llamadas.includes("cotizar_pedido")) {
      return herramientas(n, ["cotizar_pedido", { branch_slug: slug, items: p.productos.map((x) => ({ product_id: producto(x.nombre), product_name: x.nombre, requested_quantity: x.qty })), ...p.cotizar }]);
    }
    return texto("Permítame repetirle su pedido. ¿Es correcto o desea agregar algo más?");
  };
}

const DOMICILIO_TEMOZON: Pedido = {
  colonia: "Temozón Norte",
  productos: [{ query: "coca", nombre: "Coca-Cola", qty: 2 }, { query: "kilo de pastor", nombre: "Pastor — 1 kg", qty: 1 }],
  cotizar: { canal: "domicilio", colonia_entrega: "Temozón Norte" },
};
const MENSAJE_TEMOZON = "Hola, quiero 2 cocas y un kilo de pastor a domicilio en Temozón Norte";

// ─── puras ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("coloniaDelMensaje / mensajeSinColonia", () => {
  const z = (name: string): KnownZone => ({ id: name, organizationId: "o", name, lat: 21, lng: -89, createdAt: "" });
  const zonas = [z("Temozón Norte"), z("Pensiones"), z("Centro"), z("Itzimná"), z("García Lavín (Victory Platz)")];
  const sucursales = ["Pensiones", "García Lavín (Victory Platz)", "Altabrisa"];
  it("colonia con preposicion o señal de domicilio: la encuentra (palabras completas, sin acentos)", () => {
    expect(coloniaDelMensaje(MENSAJE_TEMOZON, zonas, sucursales)?.name).toBe("Temozón Norte");
    expect(coloniaDelMensaje("dos tacos a itzimna por favor", zonas, sucursales)?.name).toBe("Itzimná");
  });
  it("conservadora: recoger, una sucursal sin señal de domicilio, un pedazo de palabra, saludos y toques no precargan nada", () => {
    expect(coloniaDelMensaje("paso a recoger en Pensiones", zonas, sucursales)).toBeNull();
    expect(coloniaDelMensaje("quiero 2 tacos en Pensiones", zonas, sucursales)).toBeNull();
    expect(coloniaDelMensaje("quiero 2 tacos a domicilio en Pensiones", zonas, sucursales)?.name).toBe("Pensiones");
    expect(coloniaDelMensaje("tacos concentrados", zonas, sucursales)).toBeNull();
    expect(coloniaDelMensaje("hola", zonas, sucursales)).toBeNull();
    expect(coloniaDelMensaje("[Ubicación compartida por WhatsApp] lat=21 lng=-89", zonas, sucursales)).toBeNull();
  });
  it("le quita la colonia (y su «a domicilio en») al texto que se usa para buscar productos", () => {
    expect(mensajeSinColonia(MENSAJE_TEMOZON, zonas[0]!)).toBe("hola, quiero 2 cocas y un kilo de pastor");
  });
});

describe("precarga v2 de productos", () => {
  it("quita pago, plazo y nombre pegados al producto", () => {
    expect(mensajeParaPrecargaV2("Soy Ana Prueba, quiero 2 cocas para recoger en 30 minutos, pago en efectivo").split(",").map((p) => p.trim()).filter(Boolean)).toEqual(["quiero 2 cocas para recoger"]);
  });
  it("partes primero: cada producto por separado aunque la busqueda del mensaje entero devuelva algo; y el tope de tiempo corta la cadena", async () => {
    const pedidas: string[] = [];
    const buscar = async (q: string) => { pedidas.push(q); return { result: [{ name: q }], latenciaMs: 1, error: false }; };
    expect((await precargarBusquedas("coca y kilo de pastor", buscar, Number.POSITIVE_INFINITY, true)).map((c) => c.query)).toEqual(["coca", "kilo de pastor"]);
    expect(pedidas).toEqual(["coca", "kilo de pastor"]);
    expect(await precargarBusquedas("coca y kilo de pastor", buscar, Date.now() - 1, true)).toEqual([]);
  });
});

describe("loteAdmiteResumenSinVuelta", () => {
  const cot = (result: Record<string, unknown>, input: Record<string, unknown> = { canal: "domicilio" }) => ({ name: "cotizar_pedido", input, result, error: false });
  const ok = { quote: { total: 100 }, resumen_canonico: "Permítame repetirle su pedido... ¿Es correcto?", instruccion_resumen: "x", quote_hash: "h" };
  it("lecturas + cotizar con resumen y nada que explicar: si", () => {
    expect(loteAdmiteResumenSinVuelta([{ name: "buscar_producto", input: {}, result: [], error: false }, cot(ok)], ["soy Ana, 2 cocas, pago en efectivo"])).toBe(true);
  });
  it("no: promociones sugeridas, avisos, pregunta del cliente, recoger sin hora, mutante en el lote o error", () => {
    expect(loteAdmiteResumenSinVuelta([cot({ ...ok, quote: { total: 1, promociones_sugeridas: [{}] } })], ["x"])).toBe(false);
    expect(loteAdmiteResumenSinVuelta([cot({ ...ok, aviso_hora: "otra hora" })], ["x"])).toBe(false);
    expect(loteAdmiteResumenSinVuelta([cot(ok)], ["¿cuánto tarda?"])).toBe(false);
    expect(loteAdmiteResumenSinVuelta([cot(ok, { canal: "recoger" })], ["2 cocas"])).toBe(false);
    expect(loteAdmiteResumenSinVuelta([cot(ok, { canal: "recoger" })], ["2 cocas, paso en cuanto esté"])).toBe(true);
    expect(loteAdmiteResumenSinVuelta([cot(ok, { canal: "recoger", minutos_para_recoger: 30 })], ["2 cocas"])).toBe(true);
    expect(loteAdmiteResumenSinVuelta([{ name: "escalar_a_humano", input: {}, result: {}, error: false }, cot(ok)], ["x"])).toBe(false);
    expect(loteAdmiteResumenSinVuelta([{ ...cot(ok), error: true }], ["x"])).toBe(false);
  });
});

// ─── handler real ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("(a) precarga v2: «quiero X y Y a domicilio en [colonia]» llega a la respuesta en menos llamadas", () => {
  it("sin bandera 5 llamadas (sucursal, producto, producto, cotizar, texto); con cerebro_v2 2 (cotizar, texto)", async () => {
    const sin = await armar(false);
    const rSin = await sin.turno(MENSAJE_TEMOZON, modeloUnoPorRespuesta(DOMICILIO_TEMOZON, sin.producto));
    const con = await armar(true);
    const rCon = await con.turno(MENSAJE_TEMOZON, modeloUnoPorRespuesta(DOMICILIO_TEMOZON, con.producto));
    expect(rSin.llamadas).toBe(5);
    expect(rCon.llamadas).toBe(2);
    // El modelo arranca con sucursal y productos ya en el historial (resultados reales de las herramientas reales) y el bloque que dice que son vigentes.
    expect(rCon.primera.system).toContain(MARCA_CONTEXTO_PRECARGADO);
    expect(rCon.primera.system).toMatch(/NO las vuelva a llamar con los mismos datos/);
    const pre = rCon.primera.messages.find((m) => m.role === "assistant");
    expect(pre && pre.role === "assistant" ? pre.toolCalls?.map((c) => c.name) : null).toEqual(["buscar_sucursal_cercana", "buscar_producto", "buscar_producto"]);
    // Misma cotizacion que sin bandera: el total que lee el cliente no cambia.
    const total = (r: { ultima: LlmCompletionRequest }) => (JSON.parse(String(r.ultima.messages.filter((m) => m.role === "tool").at(-1)!.content)) as { quote?: { total?: number } }).quote?.total;
    expect(total(rCon)).toBe(total(rSin));
    expect(total(rCon)).toBeGreaterThan(0);
  });

  it("chat sin sucursal de entrada (numero central): la sucursal asignada a la colonia manda en la busqueda de productos", async () => {
    const con = await armar(true, { entrada: false });
    const r = await con.turno("quiero 2 cocas a domicilio en Itzimná", modeloUnoPorRespuesta({ colonia: "Itzimná", productos: [{ query: "coca", nombre: "Coca-Cola", qty: 2 }], cotizar: { canal: "domicilio", colonia_entrega: "Itzimná" } }, con.producto));
    const pre = r.primera.messages.find((m) => m.role === "assistant");
    const args = pre && pre.role === "assistant" ? pre.toolCalls!.map((c) => JSON.parse(c.argumentsJson) as { branch_slug?: string }) : [];
    expect(args[1]?.branch_slug).toBe("prol-montejo");
    expect(r.llamadas).toBe(2);
  });

  it("memo: si el modelo vuelve a pedir una lectura precargada con los mismos datos, recibe el mismo resultado sin ir a la base", async () => {
    const con = await armar(true);
    let savepoints = 0;
    const original = con.world.repo.runWithRowSavepoint.bind(con.world.repo);
    con.world.repo.runWithRowSavepoint = (fn) => { savepoints += 1; return original(fn); };
    const marcas: number[] = [];
    const r = await con.turno(MENSAJE_TEMOZON, (req, n) => {
      marcas.push(savepoints);
      // Desobediente: repite la colonia (escrita distinto) y la busqueda de la coca tal cual las precargo el servidor.
      if (delTurno(req).llamadas.filter((c) => c === "buscar_producto").length < 3) {
        const pre = req.messages.find((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.name === "buscar_producto"));
        const q = pre && pre.role === "assistant" ? (JSON.parse(pre.toolCalls!.find((c) => c.name === "buscar_producto")!.argumentsJson) as { query: string; branch_slug: string }) : null;
        return herramientas(n, ["buscar_sucursal_cercana", { colonia: "temozon norte" }], ["buscar_producto", { query: q!.query.toUpperCase(), branch_slug: q!.branch_slug }]);
      }
      return texto("Con gusto.");
    });
    expect(r.llamadas).toBe(2);
    expect(marcas[1]).toBe(marcas[0]); // ninguna herramienta fue a la base entre la 1a y la 2a llamada
    const tools = r.ultima.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(tools.at(-2)).toBe(tools[0]); // sucursal repetida = la precargada
    expect(tools.at(-1)).toBe(tools[1]); // producto repetido = el precargado
  });

  it("observabilidad: el turno dice que se precargo la sucursal y cuantos productos", async () => {
    const eventos: Array<Record<string, unknown>> = [];
    const con = await armar(true, { observabilidad: { emitir: (e) => eventos.push(e as unknown as Record<string, unknown>) } });
    await con.turno(MENSAJE_TEMOZON, modeloUnoPorRespuesta(DOMICILIO_TEMOZON, con.producto));
    expect(eventos.find((e) => e.evento === "whatsapp_turno")!.precargado).toEqual({ cliente: false, productos: 2, sucursal: true });
  });
});

describe("(b) lecturas en lote: todas se ejecutan y regresan en orden", () => {
  it("tres lecturas en UNA respuesta = una vuelta; cada tool_call recibe su resultado en el orden pedido", async () => {
    for (const v2 of [false, true]) {
      const t = await armar(v2);
      const r = await t.turno("hola", (req, n) =>
        delTurno(req).llamadas.includes("consultar_sucursal")
          ? texto("Con gusto.")
          : herramientas(n, ["buscar_producto", { query: "horchata", branch_slug: "garcia-lavin" }], ["consultar_sucursal", { branch_slug: "garcia-lavin" }], ["buscar_producto", { query: "coca", branch_slug: "garcia-lavin" }]),
      );
      expect(r.llamadas).toBe(2);
      const ult = r.ultima.messages;
      const pedido = ult.findLast((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) === 3);
      const ids = pedido && pedido.role === "assistant" ? pedido.toolCalls!.map((c) => c.id) : [];
      const resultados = ult.slice(ult.indexOf(pedido!) + 1).filter((m) => m.role === "tool");
      expect(resultados.map((m) => (m.role === "tool" ? m.toolCallId : ""))).toEqual(ids);
      expect(String(resultados[0]!.content)).toContain("Horchata");
      expect(String(resultados[2]!.content)).toContain("Coca-Cola");
    }
  });
});

describe("(c) sin bandera: llamadas y prompt de siempre", () => {
  it("sin cerebro_v2 no hay bloque, ni intercambio precargado, ni memo, ni resumen del servidor", async () => {
    vi.stubEnv("RESTAURANTES_CIERRE_MAQUINA_ESTADOS", "1");
    const eventos: Array<Record<string, unknown>> = [];
    const sin = await armar(false, { observabilidad: { emitir: (e) => eventos.push(e as unknown as Record<string, unknown>) } });
    const r = await sin.turno(MENSAJE_TEMOZON, modeloUnoPorRespuesta(DOMICILIO_TEMOZON, sin.producto));
    expect(r.primera.system).not.toContain(MARCA_CONTEXTO_PRECARGADO);
    expect(r.primera.messages.filter((m) => m.role !== "user")).toHaveLength(0);
    expect(r.llamadas).toBe(5);
    const turno = eventos.find((e) => e.evento === "whatsapp_turno")!;
    expect(turno.precargado).toBeUndefined();
    expect(turno.resumenDelServidor).toBeUndefined();
    const s = await armar(false);
    const conDatos = await s.turno("Soy Ana Prueba, quiero 2 cocas para recoger en 30 minutos, pago en efectivo", modeloUnoPorRespuesta({ productos: [{ query: "coca", nombre: "Coca-Cola", qty: 2 }], cotizar: { canal: "recoger", customer_name: "Ana Prueba", payment_method: "efectivo", minutos_para_recoger: 30 } }, s.producto));
    expect(conDatos.llamadas).toBe(3);
  });
});

describe("(3) cotizar con todos los datos: el resumen sale del servidor en la misma vuelta", () => {
  const RECOGER: Pedido = { productos: [{ query: "coca", nombre: "Coca-Cola", qty: 2 }], cotizar: { canal: "recoger", customer_name: "Ana Prueba", payment_method: "efectivo", minutos_para_recoger: 30 } };
  const MENSAJE = "Soy Ana Prueba, quiero 2 cocas para recoger en 30 minutos, pago en efectivo";

  it("con cerebro_v2: 1 llamada (cotizar) y el cliente recibe el resumen canonico con los botones; sin bandera 3", async () => {
    vi.stubEnv("RESTAURANTES_CIERRE_MAQUINA_ESTADOS", "1");
    const sin = await armar(false);
    const rSin = await sin.turno(MENSAJE, modeloUnoPorRespuesta(RECOGER, sin.producto));
    const con = await armar(true);
    const rCon = await con.turno(MENSAJE, modeloUnoPorRespuesta(RECOGER, con.producto));
    expect(rSin.llamadas).toBe(3);
    expect(rCon.llamadas).toBe(1);
    const flow = await con.world.repo.readOrderFlow(con.world.organizationId, `wa:${PHONE}`);
    expect(rCon.reply).toContain("$106");
    expect(flow?.context?.resumenCanonico).toBeTruthy();
    expect((rCon as { pedirConfirmacion?: { quoteHash: string } }).pedirConfirmacion?.quoteHash).toBe(flow!.context!.quoteHash);
  });

  it("si falta un dato del cierre (sin nombre) o el cliente pregunta algo, el modelo redacta como siempre", async () => {
    vi.stubEnv("RESTAURANTES_CIERRE_MAQUINA_ESTADOS", "1");
    const a = await armar(true);
    const sinNombre = await a.turno("quiero 2 cocas para recoger en 30 minutos, pago en efectivo", modeloUnoPorRespuesta({ ...RECOGER, cotizar: { canal: "recoger", payment_method: "efectivo", minutos_para_recoger: 30 } }, a.producto));
    expect(sinNombre.llamadas).toBe(2);
    const b = await armar(true);
    const pregunta = await b.turno(`${MENSAJE}. ¿Tienen estacionamiento?`, modeloUnoPorRespuesta(RECOGER, b.producto));
    expect(pregunta.llamadas).toBe(2);
  });
});

describe("(3) cierre en una vuelta con cerebro_v2", () => {
  it("el «si» al resumen vigente: el servidor confirma y crea con lo cotizado y el modelo solo redacta (1 llamada)", async () => {
    vi.stubEnv("RESTAURANTES_CIERRE_MAQUINA_ESTADOS", "1");
    const con = await armar(true);
    const RECOGER: Pedido = { productos: [{ query: "coca", nombre: "Coca-Cola", qty: 2 }], cotizar: { canal: "recoger", customer_name: "Ana Prueba", payment_method: "efectivo", minutos_para_recoger: 30 } };
    const primero = "Soy Ana Prueba, quiero 2 cocas para recoger en 30 minutos, pago en efectivo";
    const r1 = await con.turno(primero, modeloUnoPorRespuesta(RECOGER, con.producto));
    const r2 = await con.turno("Sí, es correcto", () => texto("Listo, su pedido quedó registrado."), [{ role: "user", content: primero }, { role: "assistant", content: r1.reply }]);
    expect(r2.llamadas).toBe(1);
    expect(r2.orderId).not.toBeNull();
    const hechas = r2.ultima.messages.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.name) : []));
    expect(hechas).toEqual(["confirmar_resumen", "crear_pedido"]);
  });
});
