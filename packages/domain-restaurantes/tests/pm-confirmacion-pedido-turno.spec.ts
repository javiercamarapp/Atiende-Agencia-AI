// Defecto B (13-oct, prod, chat de prueba): el servidor CREO el pedido (simulado PRUEBA-0ADC, 3 x $42 = $126) pero el cliente leyo
// «Se me complicó procesar su solicitud por este medio. Ya avisé al equipo para que lo contacte directamente.» y el equipo recibia un aviso falso.
// Causa: el turno agota sus vueltas de herramientas (o el proveedor falla / contesta vacio) DESPUES de un crear_pedido exitoso; la rama de respaldo
// solo reconocia `orderId` (que en preview es null: el pedido simulado viaja aparte) y escalaba. Estas pruebas recorren el turno COMPLETO con un modelo
// guionado (cotiza -> el cliente confirma -> confirmar_resumen -> crear_pedido -> el modelo sigue llamando herramientas) y afirman el EFECTO:
// el texto de confirmacion con folio y total del servidor, y la AUSENCIA del texto de fallo y de cualquier aviso al equipo. Reloj fijo, sin tocar la zona del proceso.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { telefonoFicticioPreview } from "../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Martes 2026-10-06 13:00 en Merida (UTC-6).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

const FALLO = /Se me complic[óo]|Ya avis[ée] al equipo|problema t[ée]cnico|¿Me puede repetir/i;

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id: `c_${name}_${Math.random()}`, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

/** Cuantas respuestas de herramienta lleva el turno actual (todo lo posterior al ultimo mensaje del cliente). */
function pasoDelTurno(request: LlmCompletionRequest): number {
  const msgs = request.messages;
  const ultimoUser = msgs.map((m) => m.role).lastIndexOf("user");
  return msgs.slice(ultimoUser + 1).filter((m) => m.role === "tool").length;
}

type Modo = "real" | "preview";
interface Opciones {
  readonly perfilPm?: boolean;
  /** Que hace el modelo DESPUES de crear_pedido: seguir llamando herramientas (agota las vueltas), responder vacio, o hacer fallar al proveedor. */
  readonly trasCrear: "sigue_con_herramientas" | "texto_vacio" | "proveedor_falla" | "escalar_y_agotar" | "crear_otra_vez";
  readonly textoCotizacion?: string;
  readonly cantidad?: number;
  readonly extraBase?: Record<string, unknown>;
  readonly bistec?: boolean;
  readonly zonaSucursal?: string;
  /** Numera el pedido real como lo hace Postgres (`orders.order_number`); el repositorio en memoria no lo hace. */
  readonly orderNumber?: number;
}

async function escenario(modo: Modo, op: Opciones) {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "23:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, op.zonaSucursal ?? "America/Merida");
  if (op.orderNumber !== undefined) {
    const original = f.repo.createOrderIdempotent.bind(f.repo);
    vi.spyOn(f.repo, "createOrderIdempotent").mockImplementation(async (...a) => ({ ...(await original(...a)), orderNumber: op.orderNumber }));
  }
  if (op.perfilPm) await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
  const items = op.bistec
    ? [{ product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: op.cantidad ?? 3, tortilla: "maiz" }]
    : [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: op.cantidad ?? 3 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger", ...(op.extraBase ?? {}) };
  let proveedorCaido = false;
  const script = (request: LlmCompletionRequest): LlmCompletionResult => {
    if (proveedorCaido) throw new Error("proveedor caido");
    const paso = pasoDelTurno(request);
    const ultimo = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (/quiero|bistec/i.test(ultimo) && !/confirmo/i.test(ultimo)) {
      return paso === 0 ? llamada("cotizar_pedido", base) : texto(op.textoCotizacion ?? "Son 3 Coca-Cola, el total es **$135**. ¿Confirma y cómo paga?");
    }
    if (paso === 0) return llamada("confirmar_resumen", {});
    if (paso === 1) return llamada("crear_pedido", { ...base, customer_name: "Javier", payment_method: "efectivo" });
    if (op.trasCrear === "crear_otra_vez" && paso === 2) return llamada("crear_pedido", { ...base, customer_name: "Javier", payment_method: "efectivo" });
    if (op.trasCrear === "crear_otra_vez") return texto("");
    if (op.trasCrear === "texto_vacio") return texto("");
    if (op.trasCrear === "proveedor_falla") {
      proveedorCaido = true;
      throw new Error("proveedor caido");
    }
    if (op.trasCrear === "escalar_y_agotar" && paso === 2) return llamada("escalar_a_humano", { customer_name: "Javier", motivo: "otro", resumen: "aviso a sucursal" });
    return llamada("buscar_cliente", { phone: "9990000000" });
  };
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "guion", script })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "esc", script })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", now: () => new Date() });
  const phone = modo === "preview" ? telefonoFicticioPreview("sesion-qa") : "+5219990001111";
  const comun = { organizationId: f.organizationId, phone, customer: { isNew: true as const }, propertyId: null, ...(modo === "preview" ? { modo: "preview" as const } : {}) };

  const pedido1 = op.bistec ? "Quiero 3 tacos de bistec para recoger" : "Hola, quiero 3 coca cola para recoger";
  const t1 = await handler.handleInboundMessage({ ...comun, messages: [{ role: "user", content: pedido1 }] });
  const t2 = await handler.handleInboundMessage({
    ...comun,
    messages: [
      { role: "user", content: pedido1 },
      { role: "assistant", content: t1.reply },
      { role: "user", content: op.bistec ? "Sí confirmo los tacos de bistec, pago en efectivo" : "Sí confirmo, pago en efectivo" },
    ],
  });
  return { f, t1, t2 };
}

async function pedidosReales(repo: InMemoryRestaurantesRepository, organizationId: string) {
  return (await repo.listOrders(organizationId, { propertyIds: null, limit: 100 })).orders;
}

const ESCENARIOS: ReadonlyArray<{ nombre: string; op: Opciones }> = [
  { nombre: "generico, el modelo sigue llamando herramientas hasta agotar las 4 vueltas", op: { trasCrear: "sigue_con_herramientas" } },
  { nombre: "taqueria_pm, agota las 8 vueltas", op: { perfilPm: true, trasCrear: "sigue_con_herramientas" } },
  { nombre: "generico, el proveedor cae justo despues de crear el pedido", op: { trasCrear: "proveedor_falla" } },
  { nombre: "taqueria_pm, el proveedor cae justo despues de crear el pedido", op: { perfilPm: true, trasCrear: "proveedor_falla" } },
  { nombre: "generico, el modelo responde vacio despues de crear", op: { trasCrear: "texto_vacio" } },
  { nombre: "taqueria_pm, el modelo responde vacio despues de crear", op: { perfilPm: true, trasCrear: "texto_vacio" } },
];

describe.each(["preview", "real"] as const)("crear_pedido exitoso -> el cliente ve la confirmacion (%s)", (modo) => {
  it.each(ESCENARIOS)("$nombre", async ({ op }) => {
    const { f, t2 } = await escenario(modo, { ...op, orderNumber: 4521 });
    // Confirmacion generada con datos del servidor: total de la cotizacion ($45 x 3) y folio.
    expect(t2.reply).toContain("$135");
    // Preview: folio PRUEBA. Real: el folio numerico que devuelve la base (aqui 4521, como `orders.order_number`).
    if (modo === "preview") expect(t2.reply).toMatch(/\*Folio:\* PRUEBA-[0-9A-F]{4}/);
    else expect(t2.reply).toContain("*Folio:* #4521");
    expect(t2.reply).toMatch(/Coca-Cola/);
    expect(t2.reply).toMatch(/Francisco de Montejo/);
    expect(t2.reply).toMatch(/efectivo/i);
    // Ausencia del texto de fallo y de avisos al equipo (ni respuesta, ni escalacion, ni callback en la base).
    expect(t2.reply).not.toMatch(FALLO);
    expect(t2.escalacion).toBeUndefined();
    expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(0);
    // Y el efecto en la base coincide con lo que se le dijo.
    const pedidos = await pedidosReales(f.repo, f.organizationId);
    if (modo === "preview") {
      expect(pedidos).toHaveLength(0);
      expect(t2.pedidoSimulado).toMatchObject({ total: 135 });
      expect(t2.orderId).toBeNull();
    } else {
      expect(pedidos).toHaveLength(1);
      expect(pedidos[0]!.total).toBe(135);
      expect(t2.orderId).toBe(pedidos[0]!.id);
      expect(t2.reply).toContain(String(pedidos[0]!.orderNumber ?? ""));
    }
  });

  it("si un segundo paso falla (aviso a sucursal), el cliente aun ve la confirmacion y no se promete ni se inventa un aviso", async () => {
    // El repositorio rechaza CUALQUIER aviso/callback: el segundo paso falla.
    const original = InMemoryRestaurantesRepository.prototype as unknown as Record<string, unknown>;
    const nombres = Object.getOwnPropertyNames(InMemoryRestaurantesRepository.prototype).filter((n) => /^(create|insert|add)Callback/.test(n) || n === "createCallbackRequest");
    const espias = nombres.map((n) => vi.spyOn(original as never, n as never).mockRejectedValue(new Error("aviso fallo") as never));
    try {
      const { f, t2 } = await escenario(modo, { trasCrear: "escalar_y_agotar" });
      expect(t2.reply).toContain("$135");
      expect(t2.reply).not.toMatch(FALLO);
      expect(f.repo.listCallbackRequests(f.organizationId)).toHaveLength(0);
      // En real el aviso FALLO de verdad: ni escalacion ni promesa de aviso. En preview el aviso es simulado y exitoso (el modelo lo pidio): solo se exige la confirmacion.
      if (modo === "real") expect(t2.escalacion).toBeUndefined();
    } finally {
      for (const e of espias) e.mockRestore();
    }
  });
});

describe.each(["preview", "real"] as const)("pedido grande retenido SIN autopiloto: el cliente lee el mensaje del servidor y hay UN solo aviso (%s)", (modo) => {
  const MENSAJE = /la sucursal lo tiene que confirmar primero/i;
  it.each(["sigue_con_herramientas", "proveedor_falla", "texto_vacio"] as const)("tras retenerlo el modelo: %s", async (trasCrear) => {
    const { f, t2 } = await escenario(modo, { perfilPm: true, trasCrear, cantidad: 100 });
    expect(t2.reply).toMatch(MENSAJE);
    expect(t2.reply).not.toMatch(FALLO);
    expect(t2.reply).not.toMatch(/ya qued[óo] registrado|se mand[óo] a cocina/i);
    expect(t2.escalacion?.motivo).toBe("pedido_grande");
    // Real: exactamente el aviso escalada:pedido_grande (nunca un segundo no_puedo_resolver / falla_sistema). Preview: ningun aviso.
    const avisos = f.repo.listCallbackRequests(f.organizationId).map((a) => a.reason);
    expect(avisos).toEqual(modo === "real" ? ["escalada:pedido_grande"] : []);
    expect((await pedidosReales(f.repo, f.organizationId)).length).toBe(0);
  });
});

describe("casos limite de la confirmacion (real)", () => {
  it("dos crear_pedido iguales en el mismo turno: un pedido, una confirmacion", async () => {
    const { f, t2 } = await escenario("real", { trasCrear: "crear_otra_vez", orderNumber: 77 });
    expect((await pedidosReales(f.repo, f.organizationId)).length).toBe(1);
    expect(t2.reply.match(/\*Folio:\*/g)).toHaveLength(1);
    expect(t2.reply).not.toMatch(FALLO);
  });

  it("el aviso de bistec (orden de 3) aparece una sola vez aunque el modelo conteste vacio", async () => {
    const { t2 } = await escenario("real", { trasCrear: "texto_vacio", bistec: true });
    expect(t2.reply.match(/se venden únicamente en órdenes de 3/g) ?? []).toHaveLength(1);
    expect(t2.reply).toContain("*Total:*");
  });

  it("la hora de recogida se muestra en la zona de la SUCURSAL (Cancun, UTC-5), no en la del agente (Merida, UTC-6)", async () => {
    // 2026-10-07T01:30Z = 20:30 en Cancun = 19:30 en Merida.
    const { t2 } = await escenario("real", { trasCrear: "texto_vacio", zonaSucursal: "America/Cancun", extraBase: { hora_recogida: "2026-10-07T01:30:00Z" } });
    expect(t2.reply).toMatch(/\*Recoger a las:\*.*20:30/);
    expect(t2.reply).not.toMatch(/19:30/);
  });
});

describe.each(["preview", "real"] as const)("defecto A: el texto final sale en formato WhatsApp (%s)", (modo) => {
  it("la cotizacion del modelo con **$135** llega como *$135* y sin dobles asteriscos", async () => {
    const { t1 } = await escenario(modo, { trasCrear: "texto_vacio" });
    expect(t1.reply).toContain("*$135*");
    expect(t1.reply).not.toContain("**");
  });
});

describe("el texto del turno anterior no se reutiliza: el fallo real SIN pedido sigue siendo fallo", () => {
  it("si el turno agota vueltas ANTES de crear el pedido, se avisa al equipo como siempre (no se finge confirmacion)", async () => {
    const f = buildRestaurantFixture();
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    const script = () => llamada("buscar_cliente", { phone: "9990000000" });
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "g", script })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e", script })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const out = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: telefonoFicticioPreview("s2"), customer: { isNew: true }, propertyId: null, modo: "preview", messages: [{ role: "user", content: "quiero algo" }] });
    expect(out.reply).toMatch(/Se me complic/);
    expect(out.escalacion?.motivo).toBe("no_puedo_resolver");
    expect(out.pedidoSimulado).toBeUndefined();
  });
});
