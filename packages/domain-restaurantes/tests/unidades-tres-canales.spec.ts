// UNA sola semantica de requested_quantity en voz, WhatsApp y herramientas (revision independiente, hallazgo MEDIO de unidades).
// La fija quoteOrder: con pack_size > 1 requested_quantity son PIEZAS (N ordenes = N x pack_size) y se cobran piezas / pack_size ordenes;
// con pack_size null el servidor cobra una orden por unidad (requested_quantity son ORDENES). Los nombres y descripciones son los del menu sembrado de produccion
// ("Orden de 2 tacos" / "Orden de 5 tacos" en la descripcion; papadzules lo trae en el nombre). Los precios son inventados.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { avisoUnidadPorTabla } from "../src/unidades-pm.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { PM_REGLA_UNIDADES_ORDEN } from "../src/whatsapp/perfil-pm.ts";
import { REGLAS_VIVAS_VOZ } from "../src/voz/perfil-voz-pm.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

// [nombre, descripcion del menu, pack_size esperado, precio de la orden]
const MENU = [
  ["Gringa de Pastor", "Orden de 2 tacos", 2, 194],
  ["Mestiza de Bistec", "Orden de 2 tacos", 2, 194],
  ["Alambre de Pastor", "Orden de 5 tacos", 5, 276],
  ["Suizo de Bistec", "Orden de 5 tacos", 5, 291],
  ["Papadzules (orden de 5)", null, 5, 194],
] as const;

function mundo() {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const categoryId = randomUUID();
  f.repo.seedCategory({ id: categoryId, organizationId: f.organizationId, name: "Tacos por orden" });
  const ids = new Map<string, string>();
  for (const [nombre, descripcion, , precio] of [...MENU, ["Gringa sin dato", "Sin dato de piezas", 0, 100] as const]) {
    const id = randomUUID();
    ids.set(nombre, id);
    f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId, name: nombre, description: descripcion, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price: precio, isAvailable: true });
  }
  return { f, ids };
}

const CANALES = ["whatsapp", "voz"] as const;

describe.each(CANALES)("%s: requested_quantity con pack_size > 1 va en PIEZAS (N ordenes = N x pack_size)", (channel) => {
  it.each(MENU)("%s: buscar_producto trae el pack_size y 3 ordenes = 3 x pack_size piezas se cobran como 3 ordenes", async (nombre, _d, pack, precio) => {
    const { f, ids } = mundo();
    const ctx = { organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}:${nombre}`, turn: "1", now: () => Date.now() } };
    const busqueda = await invokeAgentTool(f.repo, ctx, "buscar_producto", { query: nombre.replace(/ \(orden de 5\)/, ""), branch_slug: "fco-montejo" });
    const hallado = (busqueda.result as Array<{ name: string; pack_size: number | null }>).find((p) => p.name === nombre);
    expect(hallado?.pack_size).toBe(pack);

    const base = { branch_slug: "fco-montejo", canal: "recoger" };
    const item = (piezas: number) => ({ product_id: ids.get(nombre), product_name: nombre, requested_quantity: piezas, tortilla: "maiz" });
    const ok = await invokeAgentTool(f.repo, ctx, "cotizar_pedido", { ...base, items: [item(3 * pack)] });
    const linea = (ok.result as { quote: { lines: Array<{ requested_quantity: number; pack_size: number; quantity: number; line_total: number }> } }).quote.lines[0]!;
    expect(linea).toMatchObject({ requested_quantity: 3 * pack, pack_size: pack, quantity: 3, line_total: 3 * precio });
  });

  it.each(MENU)("%s: mandar 3 (las ordenes, no las piezas) se rechaza con el mensaje que corrige a PIEZAS", async (nombre, _d, pack) => {
    const { f, ids } = mundo();
    const ctx = { organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k2:${channel}:${nombre}`, turn: "1", now: () => Date.now() } };
    const intento = invokeAgentTool(f.repo, ctx, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: ids.get(nombre), product_name: nombre, requested_quantity: 3, tortilla: "maiz" }] });
    await expect(intento).rejects.toThrow(/requested_quantity va en PIEZAS/);
    await expect(intento).rejects.toThrow(new RegExp(`órdenes de ${pack} piezas`));
  });

  it("sin pack_size en el menu: el servidor cobra una orden por unidad y el aviso lo dice (requested_quantity son ORDENES), igual que la regla del prompt", async () => {
    const { f, ids } = mundo();
    const ctx = { organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k3:${channel}`, turn: "1", now: () => Date.now() } };
    const busqueda = await invokeAgentTool(f.repo, ctx, "buscar_producto", { query: "gringa sin dato", branch_slug: "fco-montejo" });
    const hallado = (busqueda.result as Array<{ name: string; pack_size: number | null; unidad_de_venta?: string }>).find((p) => p.name === "Gringa sin dato")!;
    expect(hallado.pack_size).toBeNull();
    const aviso = avisoUnidadPorTabla({ name: "Gringa sin dato", packSize: null })!;
    expect(hallado.unidad_de_venta).toBe(aviso);
    expect(aviso).toMatch(/cuenta ÓRDENES/);
    const ok = await invokeAgentTool(f.repo, ctx, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: ids.get("Gringa sin dato"), product_name: "Gringa sin dato", requested_quantity: 3 }] });
    expect((ok.result as { quote: { lines: Array<{ quantity: number; line_total: number }> } }).quote.lines[0]).toMatchObject({ quantity: 3, line_total: 300 });
  });
});

describe("las instrucciones de voz y de WhatsApp dicen lo mismo que el servidor", () => {
  it("la regla compartida esta en el prompt de voz y en el de WhatsApp", () => {
    expect(REGLAS_VIVAS_VOZ).toContain(PM_REGLA_UNIDADES_ORDEN);
    const wa = buildPmSystemPrompt({
      businessName: "Los Taquitos de PM", agentName: "Lupita", deliveryTimeText: "de 40 a 60 minutos", saludo: "Buenas tardes", branches: [],
      entryBranch: null, customer: { isNew: true } as never, fechaHoraLocal: "6 de octubre de 2026, 13:00", diaSemana: "martes",
    });
    expect(wa).toContain(PM_REGLA_UNIDADES_ORDEN);
  });
  it("la regla distingue pack_size > 1 (PIEZAS) de pack_size null (ORDENES) y ninguna instruccion dice lo contrario", () => {
    expect(PM_REGLA_UNIDADES_ORDEN).toMatch(/pack_size mayor a 1[^.]*PIEZAS/);
    expect(PM_REGLA_UNIDADES_ORDEN).toMatch(/pack_size es null[^.]*ÓRDENES/);
    expect(PM_REGLA_UNIDADES_ORDEN).toMatch(/3 órdenes de gringas = 6/);
    // Ninguna regla viva afirma que requested_quantity cuenta ordenes SIN condicionarlo a pack_size null.
    for (const texto of [REGLAS_VIVAS_VOZ, avisoUnidadPorTabla({ name: "Alambre de Pastor", packSize: null })!]) {
      for (const m of texto.matchAll(/requested_quantity[^.]{0,40}(?:cuenta|son) ÓRDENES/g)) {
        const contexto = texto.slice(Math.max(0, m.index! - 160), m.index! + m[0].length);
        expect(contexto, m[0]).toMatch(/pack_size|no trae/);
      }
    }
  });
});
