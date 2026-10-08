// QA-PM-R5-reglas-01 (P0): el piso unitario no vio que el modelo real rellena TODO campo opcional de crear_pedido con 0 / "" / false / [] / null cuando no tiene el dato
// (propina_porcentaje: 0 rechazaba casi todo pedido de WhatsApp). Contrato generado desde las DEFINICIONES de las herramientas: cada campo opcional, relleno de forma
// "vacia" (solo o todos juntos), nunca debe impedir un pedido que de otro modo es valido. Si alguien agrega un campo opcional que rechaza su relleno, esta prueba falla.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOOL_DEFINITIONS, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00-06:00")); // miercoles 12:00
});
afterEach(() => vi.useRealTimers());

type Esquema = { type?: string; enum?: unknown[]; properties?: Record<string, Esquema> };
const definicion = (nombre: string) => (AGENT_TOOL_DEFINITIONS.find((d) => d.name === nombre)!.parameters as unknown as Esquema).properties!;

/** Campos que definen QUE se pide (no son "opcionales de relleno"): sin ellos el pedido no existe. */
const ESTRUCTURALES = new Set(["branch_slug", "customer_name", "items", "canal", "payment_method", "quote_hash"]);

/** Los rellenos que un modelo manda cuando NO tiene el dato, segun el tipo del campo. */
function rellenos(esquema: Esquema): unknown[] {
  if (esquema.enum) return []; // un enum no se rellena con vacio: el modelo elige un valor de la lista
  switch (esquema.type) {
    case "number":
    case "integer":
      return [0, null];
    case "string":
      return ["", null];
    case "array":
      return [[], null];
    case "boolean":
      return [false, null];
    default:
      return [];
  }
}

function setup(channel: "whatsapp" | "voz") {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "08:00", cierra: "23:00" }], propinaPolitica: "solo_tarjeta" });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const ctx = { organizationId: f.organizationId, channel, phone: "9991234567" };
  const base = { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora", payment_method: "efectivo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] };
  return { f, ctx, base };
}

const opcionales = Object.entries(definicion("crear_pedido")).filter(([k]) => !ESTRUCTURALES.has(k));

describe.each(["whatsapp", "voz"] as const)("%s: el relleno vacio de los opcionales de crear_pedido no impide el pedido", (channel) => {
  it("hay campos opcionales que cubrir", () => {
    expect(opcionales.length).toBeGreaterThan(15);
  });

  it.each(opcionales.flatMap(([campo, esquema]) => rellenos(esquema).map((valor) => [campo, valor] as const)))("%s = %j", async (campo, valor) => {
    const s = setup(channel);
    const r = await invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, [campo]: valor });
    expect(r.orderId).not.toBeNull();
  });

  it("todos los opcionales rellenos a la vez (0 / '' / [] / false)", async () => {
    const s = setup(channel);
    const todos = Object.fromEntries(opcionales.map(([campo, esquema]) => [campo, rellenos(esquema)[0]]).filter(([, v]) => v !== undefined));
    const r = await invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, ...todos });
    expect(r.orderId).not.toBeNull();
  });

  it("todos los opcionales con null a la vez", async () => {
    const s = setup(channel);
    const todos = Object.fromEntries(opcionales.filter(([, esquema]) => rellenos(esquema).length > 0).map(([campo]) => [campo, null]));
    const r = await invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, ...todos });
    expect(r.orderId).not.toBeNull();
  });

  it("con tarjeta y el relleno de propina (propina_porcentaje 0 + propina 0), como lo manda el modelo", async () => {
    const s = setup(channel);
    const r = await invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, payment_method: "tarjeta", propina_porcentaje: 0, propina: 0, efectivo_con: 0 });
    expect(r.orderId).not.toBeNull();
  });
});

// Barrido EXHAUSTIVO de los dos campos de propina: TODOS los rellenos que un modelo manda cuando no hay propina, en ambos campos y su producto cartesiano.
const RELLENOS_PROPINA: ReadonlyArray<unknown> = [0, "0", "0%", "", null, undefined, false, [], {}, "0.0", " 0 ", "0 %"];
describe.each(["whatsapp", "voz"] as const)("%s: barrido de rellenos de propina (producto cartesiano de propina y propina_porcentaje)", (channel) => {
  const combos = RELLENOS_PROPINA.flatMap((porcentaje) => RELLENOS_PROPINA.map((monto) => [porcentaje, monto] as const));
  it("hay 144 combinaciones", () => expect(combos.length).toBe(144));
  it.each(combos)("propina_porcentaje %j + propina %j crea el pedido sin propina", async (porcentaje, monto) => {
    const s = setup(channel);
    const extra: Record<string, unknown> = {};
    if (porcentaje !== undefined) extra.propina_porcentaje = porcentaje;
    if (monto !== undefined) extra.propina = monto;
    for (const pago of ["efectivo", "tarjeta"]) {
      const r = await invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, payment_method: pago, ...extra });
      expect(r.orderId, pago).not.toBeNull();
    }
  });
});

describe("negativo: el mismo contrato sigue rechazando valores invalidos de verdad", () => {
  it.each([
    ["propina_porcentaje", -5],
    ["propina_porcentaje", 31],
    ["propina", "veinte"],
    ["minutos_para_recoger", -1],
  ])("%s = %j se rechaza", async (campo, valor) => {
    const s = setup("whatsapp");
    await expect(invokeAgentTool(s.f.repo, s.ctx, "crear_pedido", { ...s.base, payment_method: "tarjeta", [campo]: valor })).rejects.toThrow();
  });
});
