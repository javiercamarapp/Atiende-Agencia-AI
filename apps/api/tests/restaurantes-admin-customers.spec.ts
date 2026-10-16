// Fase 5 restaurantes — HTTP end-to-end de admin-customers.ts (listado + ficha).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

describe("GET /v1/restaurantes/:propertyId/admin/customers", () => {
  it("lista clientes reales de la organización, nunca los de otra", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    await ctx.restaurantesRepo.upsertCustomer(ctx.otherOrganizationId, "9993334444", "Cliente ajeno");
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<{ name: string | null }> };
    expect(body.customers.some((c) => c.name === "Ana Torres")).toBe(true);
    expect(body.customers.some((c) => c.name === "Cliente ajeno")).toBe(false);
  });

  it("search filtra por nombre/teléfono", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9995556666", "Beto López");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers?search=ana`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { customers: Array<{ name: string | null }> };
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0]?.name).toBe("Ana Torres");
  });

  it("repartidor -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });

  it("staff de OTRA organización -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/restaurantes/:propertyId/admin/customers/:customerId", () => {
  it("devuelve la ficha real (tier/direcciones/lo de siempre) — misma forma que lookupCustomer", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const customer = await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/${customer.id}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customer: { isNew: boolean; name: string | null } };
    expect(body.customer.isNew).toBe(false);
    expect(body.customer.name).toBe("Ana Torres");
  });

  it("cliente inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/00000000-0000-0000-0000-000000000000`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(404);
  });

  it("un cliente de OTRA organización -> 404 (nunca se filtra por id ajeno)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const otherCustomer = await ctx.restaurantesRepo.upsertCustomer(ctx.otherOrganizationId, "9993334444", "Cliente ajeno");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/${otherCustomer.id}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(404);
  });
});

// ---- Cartera por nivel (R: pos-y-clientes) -------------------------------------------------------------------------------------------
type ListaBody = { customers: Array<{ name: string | null; tier: string | null; orderCount: number }>; filtrosDisponibles: boolean };

async function sembrarCartera(ctx: Awaited<ReturnType<typeof buildRestaurantesKpiTestContext>>) {
  // Tres clientes con 1, 1 y 3 pedidos (el nivel sale del gasto real).
  const mk = async (tel: string, nombre: string, pedidos: number, total: number, haceDias: number) => {
    const c = await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, tel, nombre);
    for (let i = 0; i < pedidos; i += 1) {
      ctx.restaurantesRepo.seedOrder({
        id: randomUUID(), customerId: c.id, customerName: nombre, customerPhone: tel, customerAddress: null, customerEmail: null, branch: null, total, status: "entregado", items: [],
        source: "voice", notes: null, paymentMethod: null, callTranscript: null, callRecordingUrl: null, dedupeFingerprint: null, idempotencyKey: null,
        createdAt: new Date(Date.now() - haceDias * 86_400_000).toISOString(), assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null,
        organizationId: ctx.organizationId, propertyId: ctx.propertyIdA,
      } as never);
    }
    return c;
  };
  await mk("9990000001", "Ana", 1, 100, 100);
  await mk("9990000002", "Beto", 1, 200, 2);
  await mk("9990000003", "Carla", 3, 500, 1);
}

describe("GET admin/customers con filtros de cartera", () => {
  it("filtra por nivel, frecuencia y dias sin pedir y devuelve el nivel de cada cliente", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await sembrarCartera(ctx);
    const app = buildApp(ctx.deps);
    const get = async (qs: string) => {
      const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers${qs}`, authedGet(ctx.staff.owner.token));
      expect(res.status).toBe(200);
      return (await res.json()) as ListaBody;
    };
    expect((await get("?nivel=BLACK")).customers.map((c) => c.name)).toEqual(["Carla"]);
    expect((await get("?frecuencia=recurrentes")).customers.map((c) => c.name)).toEqual(["Carla"]);
    expect((await get("?frecuencia=una_vez")).customers).toHaveLength(2);
    expect((await get("?inactivoDias=30")).customers.map((c) => c.name)).toEqual(["Ana"]);
    const todos = await get("");
    expect(todos.filtrosDisponibles).toBe(true);
    expect(todos.customers.find((c) => c.name === "Carla")!.tier).toBe("BLACK");
  });

  it("filtros invalidos -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const qs of ["?nivel=ORO", "?frecuencia=a_veces", "?inactivoDias=0", "?inactivoDias=abc", "?branchId=no-existe"]) {
      const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers${qs}`, authedGet(ctx.staff.owner.token));
      expect(res.status, qs).toBe(400);
    }
  });

  it("la sucursal pedida debe ser de la organizacion del staff", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers?branchId=${ctx.propertyIdB}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
  });

  it("repartidor -> 403 y staff de otra organizacion -> 403 en los KPIs", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/kpis`, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/kpis`, authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
  });

  it("KPIs de cartera: total, recurrentes, ticket y cliente mas frecuente con telefono enmascarado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await sembrarCartera(ctx);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/kpis`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const k = (await res.json()) as { disponible: boolean; total: number; recurrentes: number; ticketPromedio: number; masFrecuente: { nombre: string; telefonoEnmascarado: string; pedidos: number; diasDesdeUltimoPedido: number } };
    expect(k).toMatchObject({ disponible: true, total: 3, recurrentes: 1 });
    expect(k.ticketPromedio).toBe(Math.round(((100 + 200 + 3 * 500) / 5) * 100) / 100);
    expect(k.masFrecuente).toMatchObject({ nombre: "Carla", telefonoEnmascarado: "******0003", pedidos: 3, diasDesdeUltimoPedido: 1 });
    expect(JSON.stringify(k)).not.toContain("9990000003");
  });
});

describe("importar cartera (POST admin/customers/import)", () => {
  const HUELLA = "c".repeat(64);
  const filas = [
    { telefono: "9991230001", nombre: "Ana", direccion: "Calle 1 #2", colonia: "Centro", notas: "sin picante" },
    { telefono: "+52 999 123 0002", nombre: "Bruno" },
    { telefono: "99912300033", nombre: "Once digitos" },
  ];

  it("vista previa: no escribe nada, reporta el error por renglon y enmascara los telefonos", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/import/preview`, authedJson(ctx.staff.owner.token, { huella: HUELLA, filas }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; validos: number; totalErrores: number; errores: Array<{ renglon: number }>; muestra: Array<{ telefonoEnmascarado: string }> };
    expect(body).toMatchObject({ total: 3, validos: 2, totalErrores: 1 });
    expect(body.errores[0]!.renglon).toBe(3);
    expect(body.muestra[0]!.telefonoEnmascarado).toBe("******0001");
    expect((await ctx.restaurantesRepo.listCustomers(ctx.organizationId, { limit: 50 })).customers).toHaveLength(0);
  });

  it("importa, deja bitacora sin telefonos, y el mismo archivo dos veces no duplica", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/customers/import`;
    const r1 = await app.request(url, authedJson(ctx.staff.owner.token, { huella: HUELLA, filas }));
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { resultado: { yaImportado: boolean; creados: number; rechazados: number } };
    expect(b1.resultado).toMatchObject({ yaImportado: false, creados: 2, rechazados: 1 });
    const r2 = await app.request(url, authedJson(ctx.staff.owner.token, { huella: HUELLA, filas }));
    expect(((await r2.json()) as { resultado: { yaImportado: boolean } }).resultado.yaImportado).toBe(true);

    const todos = (await ctx.restaurantesRepo.listCustomers(ctx.organizationId, { limit: 50 })).customers;
    expect(todos).toHaveLength(2);
    expect(todos.every((c) => c.orderCount === 0)).toBe(true);
    const auditoria = await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 50 });
    const importaciones = auditoria.items.filter((a) => a.action === "clientes.importados");
    expect(importaciones).toHaveLength(1);
    expect(importaciones[0]!.despues).toContain("creados=2");
    expect(JSON.stringify(importaciones)).not.toContain("9991230001");
  });

  it("no pisa el nombre conocido de un cliente existente", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991230001", "Nombre Conocido");
    const app = buildApp(ctx.deps);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/import`, authedJson(ctx.staff.owner.token, { huella: HUELLA, filas: [{ telefono: "9991230001", nombre: "Otro" }] }));
    expect((await ctx.restaurantesRepo.findCustomerByPhone(ctx.organizationId, "9991230001"))!.name).toBe("Nombre Conocido");
  });

  it("la ficha muestra la nota importada", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/import`, authedJson(ctx.staff.owner.token, { huella: HUELLA, filas: [{ telefono: "9991230001", nombre: "Ana", notas: "alergia al cacahuate" }] }));
    const c = (await ctx.restaurantesRepo.findCustomerByPhone(ctx.organizationId, "9991230001"))!;
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/${c.id}`, authedGet(ctx.staff.owner.token));
    expect(((await res.json()) as { customer: { notes: string | null } }).customer.notes).toBe("alergia al cacahuate");
  });

  it("entradas invalidas -> 400: huella, arreglo vacio, mas de 5,000 renglones, ningun renglon valido", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/customers/import`;
    const casos: unknown[] = [
      { huella: "no-es-hash", filas },
      { huella: HUELLA, filas: [] },
      { huella: HUELLA, filas: Array.from({ length: 5001 }, () => ({ telefono: "9991230001" })) },
      { huella: HUELLA, filas: [{ telefono: "123" }] },
    ];
    for (const body of casos) expect((await app.request(url, authedJson(ctx.staff.owner.token, body))).status).toBe(400);
  });

  it("repartidor y staff de otra organizacion -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/customers/import`;
    expect((await app.request(url, authedJson(ctx.staff.repartidor.token, { huella: HUELLA, filas }))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.otroOrgOwner.token, { huella: HUELLA, filas }))).status).toBe(403);
    expect((await app.request(`${url}/preview`, authedJson(ctx.staff.repartidor.token, { huella: HUELLA, filas }))).status).toBe(403);
  });

  it("base sin la migracion 054 -> 503 honesto (no un 500) y los KPIs dicen disponible:false", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const sinMigrar = Object.create(ctx.restaurantesRepo) as typeof ctx.restaurantesRepo;
    sinMigrar.importarClientes = async () => ({ disponible: false });
    sinMigrar.getCarteraKpis = async () => ({ disponible: false });
    const app = buildApp({ ...ctx.deps, restaurantesRepo: () => sinMigrar });
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/import`, authedJson(ctx.staff.owner.token, { huella: HUELLA, filas }));
    expect(res.status).toBe(503);
    const kpis = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/kpis`, authedGet(ctx.staff.owner.token));
    expect(await kpis.json()).toEqual({ disponible: false });
  });
});
