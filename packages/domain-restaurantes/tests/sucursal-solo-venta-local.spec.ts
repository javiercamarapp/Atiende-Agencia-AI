// Sucursal "solo venta local" (migracion 105; Galerias de PM, decision del dueno 6-nov-2026): ACTIVA para tableros, CFO y SoftRestaurant, pero los agentes
// de WhatsApp y voz y el pedido en linea nunca la ofrecen. Cada bloque compara contra el CONTROL (la misma Galerias activa sin la bandera) para que la
// prueba no pase en vacio: sin `solo_venta_local` el agente SI la ve.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest } from "@atiende/agent-core";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { cargarDatosConocimiento, generarConocimientoAuto } from "../src/ajustes-agente/conocimiento-auto.ts";
import { prepareCreateOrder, quoteOrder } from "../src/orders.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { armarInstruccionLlamada } from "../src/voz/llamada/instruccion.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { atiendeClientes, buscarSucursalParaClientes, sucursalesParaClientes } from "../src/solo-venta-local.ts";
import type { VozConfig } from "../src/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };
const MENCION = /galer/i;
const PHONE = "+5219990001111";

/** PM con Francisco de Montejo (fixture) y Galerias ACTIVA, con catalogo y coordenadas propias (lo peor posible: todo lo que la haria ofrecible). */
async function mundo(soloVentaLocal: boolean) {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const galerias = randomUUID();
  f.repo.seedBranch({ propertyId: galerias, organizationId: f.organizationId, name: "Galerías", slug: "galerias", status: "active", phone: "+529999419612", address: "Plaza Galerías, Mérida", lat: 21.0187, lng: -89.6709 });
  f.repo.seedBranchProduct({ propertyId: galerias, productId: f.products.cocaCola, price: 45, isAvailable: true });
  f.repo.seedBranchPolicy(galerias, { aceptaDomicilio: !soloVentaLocal, soloVentaLocal });
  return { ...f, galerias };
}

const ctx = (organizationId: string, channel: "whatsapp" | "voz" = "whatsapp") => ({ organizationId, channel, phone: "9991234567" });
const pedidoRecoger = (organizationId: string, productId: string) => ({
  organizationId,
  branchSlug: "galerias",
  canal: "recoger" as const,
  customerName: "Cliente Prueba",
  customerPhone: "9991234567",
  paymentMethod: "efectivo" as const,
  items: [{ productId, productName: "Coca-Cola", requestedQuantity: 1 }],
});

describe("staff y tableros: la sucursal solo venta local sigue contando", () => {
  it("aparece en la lista de staff (alcance de KPIs y filtro de sucursal) y en la de administracion (CFO, importacion de SoftRestaurant)", async () => {
    const m = await mundo(true);
    expect((await m.repo.listBranchesForOrganization(m.organizationId)).map((b) => b.slug)).toContain("galerias");
    expect((await m.repo.listBranchesForOrganizationAdmin(m.organizationId)).find((b) => b.slug === "galerias")?.status).toBe("active");
    expect(await m.repo.listarSucursalesSoloVentaLocal(m.organizationId)).toEqual([m.galerias]);
  });

  it("para clientes no existe: ni en la lista, ni por slug, ni como sucursal que atiende", async () => {
    const m = await mundo(true);
    expect((await sucursalesParaClientes(m.repo, m.organizationId)).map((b) => b.slug)).toEqual(["fco-montejo"]);
    expect(await buscarSucursalParaClientes(m.repo, m.organizationId, { slug: "galerias" })).toBeNull();
    expect(await buscarSucursalParaClientes(m.repo, m.organizationId, { name: "Galerías" })).toBeNull();
    const branch = (await m.repo.findBranch(m.organizationId, { slug: "galerias" }))!;
    expect(await atiendeClientes(m.repo, branch)).toBe(false);
    const control = await mundo(false);
    expect(await atiendeClientes(control.repo, (await control.repo.findBranch(control.organizationId, { slug: "galerias" }))!)).toBe(true);
  });
});

describe("agente de WhatsApp (turno completo): el prompt nunca la nombra", () => {
  async function promptDelTurno(soloVentaLocal: boolean, entrada: "org" | "galerias" = "org"): Promise<string> {
    const m = await mundo(soloVentaLocal);
    const sistemas: string[] = [];
    const provider = new FakeLlmProvider({ id: "guion", script: (r: LlmCompletionRequest) => (sistemas.push(r.system), { text: "¿En qué le ayudo?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }) });
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [provider]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
    const handler = createLlmWhatsAppTurnHandler(m.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    await handler.handleInboundMessage({ organizationId: m.organizationId, phone: PHONE, messages: [{ role: "user", content: "¿qué sucursales tienen para recoger?" }], customer: { isNew: true as const }, propertyId: entrada === "galerias" ? m.galerias : null });
    return sistemas[0]!;
  }

  it("con la bandera: ni en SUCURSALES REALES, ni en el mapa de telefonos, ni en las promociones", async () => {
    expect(await promptDelTurno(true)).not.toMatch(MENCION);
  });

  it("aunque el mensaje entrara por un numero ligado a Galerias, no se vuelve sucursal de entrada", async () => {
    expect(await promptDelTurno(true, "galerias")).not.toMatch(MENCION);
  });

  it("CONTROL: activa sin la bandera, el prompt SI la lista", async () => {
    expect(await promptDelTurno(false)).toMatch(/branch_slug: "galerias"/);
  });
});

describe("herramientas del agente (WhatsApp y voz): toda consulta u operacion en Galerias se rechaza sin datos", () => {
  for (const channel of ["whatsapp", "voz"] as const) {
    it(`${channel}: consultar_sucursal, buscar_producto, cotizar_pedido y crear_pedido para recoger, y enviar_menu`, async () => {
      const m = await mundo(true);
      const c = ctx(m.organizationId, channel);
      const items = [{ product_id: m.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
      const intentos: Array<[string, Record<string, unknown>]> = [
        ["consultar_sucursal", { branch_slug: "galerias" }],
        ["buscar_producto", { branch_slug: "galerias", query: "coca" }],
        ["cotizar_pedido", { branch_slug: "galerias", canal: "recoger", items }],
        ["crear_pedido", { branch_slug: "galerias", canal: "recoger", customer_name: "Cliente Prueba", customer_phone: "9991234567", payment_method: "efectivo", items }],
      ];
      if (channel === "whatsapp") intentos.push(["enviar_menu", { branch_slug: "galerias" }]);
      for (const [tool, args] of intentos) {
        await expect(invokeAgentTool(m.repo, c, tool, args), tool).rejects.toThrow(/no encontrada/);
      }
      expect((await m.repo.listOrders(m.organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(0);
    });
  }

  it("CONTROL: activa sin la bandera, consultar_sucursal SI responde con Galerias", async () => {
    const m = await mundo(false);
    const r = await invokeAgentTool(m.repo, ctx(m.organizationId), "consultar_sucursal", { branch_slug: "galerias" });
    expect(JSON.stringify(r.result)).toMatch(MENCION);
  });

  it("buscar_sucursal_cercana con un pin pegado a Galerias nunca la nombra ni la asigna", async () => {
    const m = await mundo(true);
    const r = await invokeAgentTool(m.repo, ctx(m.organizationId), "buscar_sucursal_cercana", { lat: 21.0187, lng: -89.6709 });
    expect(JSON.stringify(r.result)).not.toMatch(MENCION);
  });
});

describe("pedido en linea (orders.ts): ninguna via crea ni cotiza en Galerias", () => {
  it("prepareCreateOrder y quoteOrder la rechazan como inexistente", async () => {
    const m = await mundo(true);
    await expect(prepareCreateOrder(m.repo, { ...pedidoRecoger(m.organizationId, m.products.cocaCola), source: "whatsapp" })).rejects.toThrow(/no encontrada o inactiva/);
    await expect(quoteOrder(m.repo, { organizationId: m.organizationId, branchSlug: "galerias", canal: "recoger", items: [{ productId: m.products.cocaCola, requestedQuantity: 1 }] })).rejects.toThrow(/no encontrada o inactiva/);
  });
});

describe("agente de voz: la instruccion de la llamada no la nombra", () => {
  const CONFIG: VozConfig = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "", configurada: true };
  const AHORA = new Date("2026-11-06T18:00:00.000Z");

  it("con la bandera no aparece; CONTROL sin la bandera si", async () => {
    const m = await mundo(true);
    const r = await armarInstruccionLlamada(m.repo, { organizationId: m.organizationId, propertyId: m.propertyId, telefono: null, config: CONFIG, ahora: AHORA });
    expect(r.instruccion).not.toMatch(MENCION);
    const control = await mundo(false);
    const rc = await armarInstruccionLlamada(control.repo, { organizationId: control.organizationId, propertyId: control.propertyId, telefono: null, config: CONFIG, ahora: AHORA });
    expect(rc.instruccion).toMatch(/galerias/);
  });
});

describe("conocimiento generado del agente", () => {
  it("ni directorio, ni FAQ, ni menu la mencionan; CONTROL si", async () => {
    const m = await mundo(true);
    const docs = generarConocimientoAuto(await cargarDatosConocimiento(m.repo, m.organizationId)).documentos;
    expect(JSON.stringify(docs)).not.toMatch(MENCION);
    const control = await mundo(false);
    expect(JSON.stringify(generarConocimientoAuto(await cargarDatosConocimiento(control.repo, control.organizationId)).documentos)).toMatch(MENCION);
  });
});

describe("Postgres: base sin la migracion 105", () => {
  it("la columna inexistente (42703) cae a lista vacia dentro de SAVEPOINT y la sesion sigue usable", async () => {
    const sinColumna = Object.assign(new Error('column "solo_venta_local" does not exist'), { code: "42703" });
    const session = new AbortAwareFakeSession([
      { match: /solo_venta_local/, respond: () => sinColumna },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    await expect(repo.listarSucursalesSoloVentaLocal(randomUUID())).resolves.toEqual([]);
    await expect(session.query("select 1")).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});
