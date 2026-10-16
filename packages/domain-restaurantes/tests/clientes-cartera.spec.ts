// Cartera de clientes: filtros por nivel / frecuencia / dias sin pedir / sucursal, KPIs e importacion (repositorio en memoria)
// + compatibilidad con la base SIN migrar (SAVEPOINT, AbortAwareFakeSession).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import type { Customer, Order } from "../src/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = randomUUID();
const OTRA_ORG = randomUUID();
const SUC_A = randomUUID();
const SUC_B = randomUUID();
const DIA = 86_400_000;

function cliente(i: number, orderCount: number, org = ORG): Customer {
  return { id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, organizationId: org, phone: `99900000${String(i).padStart(2, "0")}`, name: `Cliente ${i}`, orderCount };
}

function pedido(c: Customer, total: number, hace: number, propertyId = SUC_A): Order {
  return {
    id: randomUUID(), customerId: c.id, customerName: c.name ?? "x", customerPhone: c.phone, customerAddress: null, customerEmail: null, branch: null, total,
    status: "entregado", items: [], source: "voice", notes: null, paymentMethod: null, callTranscript: null, callRecordingUrl: null, dedupeFingerprint: null, idempotencyKey: null,
    createdAt: new Date(Date.now() - hace * DIA).toISOString(), assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null,
    organizationId: c.organizationId, propertyId,
  } as Order;
}

/** Misma cartera que scripts/verify-restaurantes-clientes-import: gasto c1..c9 = 100*i, c10 = 3 x 500, c11 sin pedidos. */
function carteraDePrueba() {
  const repo = new InMemoryRestaurantesRepository();
  // `seedOrder` suma 1 a order_count por cada pedido sembrado: los clientes empiezan en 0.
  const cs = Array.from({ length: 11 }, (_, k) => cliente(k + 1, 0));
  for (const c of cs) repo.seedCustomer(c);
  const hace: Record<number, number> = { 1: 100, 2: 70, 3: 40 };
  cs.slice(0, 9).forEach((c, k) => repo.seedOrder(pedido(c, 100 * (k + 1), hace[k + 1] ?? 1, k + 1 === 2 ? SUC_B : SUC_A)));
  for (let k = 0; k < 3; k += 1) repo.seedOrder(pedido(cs[9]!, 500, 1));
  return { repo, cs };
}

describe("listCustomers con filtros de cartera (en memoria)", () => {
  it("nivel: BLACK / PLATINUM / GOLD / BLUE como calc_customer_tier", async () => {
    const { repo } = carteraDePrueba();
    const por = async (nivel: "BLACK" | "PLATINUM" | "GOLD" | "BLUE") => (await repo.listCustomers(ORG, { limit: 50, nivel })).customers.map((c) => c.name);
    expect(await por("BLACK")).toEqual(["Cliente 10"]);
    expect(await por("PLATINUM")).toEqual(["Cliente 9"]);
    expect((await por("GOLD")).sort()).toEqual(["Cliente 7", "Cliente 8"]);
    expect(await por("BLUE")).toHaveLength(7);
  });

  it("cada cliente trae su nivel y ultimo pedido", async () => {
    const { repo } = carteraDePrueba();
    const todos = (await repo.listCustomers(ORG, { limit: 50 })).customers;
    expect(todos).toHaveLength(11);
    expect(todos.find((c) => c.name === "Cliente 10")!.tier).toBe("BLACK");
    expect(todos.find((c) => c.name === "Cliente 11")!.lastOrderAt).toBeNull();
  });

  it("frecuencia: con 1 pedido vs recurrentes", async () => {
    const { repo } = carteraDePrueba();
    expect((await repo.listCustomers(ORG, { limit: 50, frecuencia: "una_vez" })).customers).toHaveLength(9);
    expect((await repo.listCustomers(ORG, { limit: 50, frecuencia: "recurrentes" })).customers.map((c) => c.name)).toEqual(["Cliente 10"]);
  });

  it("sin pedir en 30 / 60 / 90 dias (quien nunca pidio cuenta)", async () => {
    const { repo } = carteraDePrueba();
    const n = async (inactivoDias: number) => (await repo.listCustomers(ORG, { limit: 50, inactivoDias })).customers.length;
    expect(await n(30)).toBe(4);
    expect(await n(60)).toBe(3);
    expect(await n(90)).toBe(2);
  });

  it("sucursal y combinacion de filtros", async () => {
    const { repo } = carteraDePrueba();
    expect((await repo.listCustomers(ORG, { limit: 50, propertyId: SUC_B })).customers.map((c) => c.name)).toEqual(["Cliente 2"]);
    expect((await repo.listCustomers(ORG, { limit: 50, nivel: "BLUE", inactivoDias: 30 })).customers).toHaveLength(4);
  });

  it("nunca mezcla organizaciones", async () => {
    const { repo } = carteraDePrueba();
    repo.seedCustomer(cliente(50, 1, OTRA_ORG));
    expect((await repo.listCustomers(ORG, { limit: 50 })).customers).toHaveLength(11);
    expect((await repo.listCustomers(OTRA_ORG, { limit: 50 })).customers).toHaveLength(1);
  });
});

describe("getCarteraKpis (en memoria)", () => {
  it("total, recurrentes, ticket promedio y cliente mas frecuente", async () => {
    const { repo, cs } = carteraDePrueba();
    const k = await repo.getCarteraKpis(ORG);
    expect(k).toMatchObject({ disponible: true, total: 11, recurrentes: 1, ticketPromedio: 500 });
    if (k.disponible) expect(k.masFrecuente).toMatchObject({ customerId: cs[9]!.id, orderCount: 3 });
  });

  it("organizacion sin clientes: ceros y sin cliente mas frecuente", async () => {
    const k = await new InMemoryRestaurantesRepository().getCarteraKpis(ORG);
    expect(k).toEqual({ disponible: true, total: 0, recurrentes: 0, ticketPromedio: null, masFrecuente: null });
  });
});

describe("importarClientes (en memoria)", () => {
  const H1 = "a".repeat(64);

  it("crea, no pisa el nombre conocido, no crea pedidos y guarda direccion y nota", async () => {
    const { repo, cs } = carteraDePrueba();
    const pedidosAntes = (await repo.listEligibleOrderHistory(cs[0]!.id)).length;
    const r = await repo.importarClientes(ORG, H1, [
      { phone: "9991230001", name: "Ana", address: "Calle 1", notes: "sin picante" },
      { phone: cs[0]!.phone, name: "Nombre Distinto", address: null, notes: null },
    ]);
    expect(r).toEqual({ disponible: true, yaImportado: false, total: 2, creados: 1, actualizados: 0, sinCambios: 1, rechazados: 0 });
    expect((await repo.findCustomerByPhone(ORG, cs[0]!.phone))!.name).toBe("Cliente 1");
    const nuevo = (await repo.findCustomerByPhone(ORG, "9991230001"))!;
    expect(nuevo.orderCount).toBe(0);
    expect(await repo.getCustomerNotes(ORG, nuevo.id)).toBe("sin picante");
    expect((await repo.listCustomerAddresses(nuevo.id))[0]).toMatchObject({ address: "Calle 1", isDefault: true });
    expect((await repo.listEligibleOrderHistory(cs[0]!.id)).length).toBe(pedidosAntes);
  });

  it("completa solo el nombre vacio", async () => {
    const { repo } = carteraDePrueba();
    await repo.upsertCustomer(ORG, "9991230055", "");
    const sinNombre = (await repo.findCustomerByPhone(ORG, "9991230055"))!;
    expect(sinNombre.name).toBe("");
    // un cliente con name null (alta por telefono) recibe el del archivo
    repo.seedCustomer({ id: randomUUID(), organizationId: ORG, phone: "9991230056", name: null, orderCount: 0 });
    const r = await repo.importarClientes(ORG, "b".repeat(64), [{ phone: "9991230056", name: "Rellenado", address: null, notes: null }]);
    expect(r).toMatchObject({ actualizados: 1, creados: 0 });
    expect((await repo.findCustomerByPhone(ORG, "9991230056"))!.name).toBe("Rellenado");
  });

  it("el mismo archivo dos veces (misma huella) no duplica y avisa ya_importado", async () => {
    const { repo } = carteraDePrueba();
    const filas = [{ phone: "9991230001", name: "Ana", address: null, notes: null }];
    const primera = await repo.importarClientes(ORG, H1, filas);
    const segunda = await repo.importarClientes(ORG, H1, filas);
    expect(primera).toMatchObject({ yaImportado: false, creados: 1 });
    expect(segunda).toMatchObject({ yaImportado: true, creados: 1 });
    expect((await repo.listCustomers(ORG, { limit: 50 })).customers).toHaveLength(12);
  });

  it("rechaza en el repositorio un telefono que no son 10 digitos", async () => {
    const { repo } = carteraDePrueba();
    const r = await repo.importarClientes(ORG, H1, [{ phone: "99912300011", name: "Once", address: null, notes: null }]);
    expect(r).toMatchObject({ creados: 0, rechazados: 1 });
  });
});

// ---- Compatibilidad con la base SIN migrar (regla dura): una sola transaccion por request ----
function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function sesionSinMigrar054() {
  return new AbortAwareFakeSession([
    { match: /restaurantes\.clientes_cartera|restaurantes\.cartera_kpis|restaurantes\.importar_clientes/i, respond: () => pgError("42883", "function restaurantes.* does not exist") },
    { match: /select notes from restaurantes\.customers/i, respond: () => pgError("42703", 'column "notes" does not exist') },
    { match: /from restaurantes\.customers\s+where organization_id = \$1/i, respond: () => [{ id: "00000000-0000-4000-8000-000000000001", organization_id: ORG, phone: "9990000001", name: "Ana", order_count: 2, last_order_at: new Date("2026-09-01T00:00:00Z") }] },
    { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
  ]);
}

async function sigueUsable(s: AbortAwareFakeSession) {
  const r = await s.query<{ ok: boolean }>("select 1 as siguiente_query_del_request");
  expect(r.rows).toEqual([{ ok: true }]);
}

describe("cartera contra la base SIN migrar (SAVEPOINT, nunca 25P02 ni 500)", () => {
  it("el listado sin filtros nuevos cae al listado de siempre y la transaccion sigue usable", async () => {
    const s = sesionSinMigrar054();
    const page = await new PostgresRestaurantesRepository(s).listCustomers(ORG, { limit: 10 });
    expect(page.filtrosDisponibles).toBe(true);
    expect(page.customers).toHaveLength(1);
    expect(page.customers[0]).toMatchObject({ name: "Ana", tier: null, lastOrderAt: "2026-09-01T00:00:00.000Z" });
    await sigueUsable(s);
  });

  it("pedir un filtro nuevo => lista vacia honesta con filtrosDisponibles:false", async () => {
    const s = sesionSinMigrar054();
    const page = await new PostgresRestaurantesRepository(s).listCustomers(ORG, { limit: 10, nivel: "BLACK" });
    expect(page).toEqual({ customers: [], nextCursor: null, filtrosDisponibles: false });
    await sigueUsable(s);
  });

  it("KPIs => disponible:false; importar => disponible:false; notas => null; la sesion sigue usable tras cada uno", async () => {
    const s = sesionSinMigrar054();
    const repo = new PostgresRestaurantesRepository(s);
    expect(await repo.getCarteraKpis(ORG)).toEqual({ disponible: false });
    await sigueUsable(s);
    expect(await repo.importarClientes(ORG, "a".repeat(64), [{ phone: "9990000001", name: "Ana", address: null, notes: null }])).toEqual({ disponible: false });
    await sigueUsable(s);
    expect(await repo.getCustomerNotes(ORG, "00000000-0000-4000-8000-000000000001")).toBeNull();
    await sigueUsable(s);
  });

  it("un error que NO es de base sin migrar se repropaga (no se enmascara)", async () => {
    const s = new AbortAwareFakeSession([{ match: /restaurantes\.cartera_kpis/i, respond: () => pgError("57014", "canceling statement due to statement timeout") }]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(new PostgresRestaurantesRepository(s).getCarteraKpis(ORG)).rejects.toMatchObject({ code: "57014" });
  });
});
