// R-11 -- HTTP end-to-end de pedidos programados: pestana "Programados", auto-promocion al consultar (sin cron),
// alta por el endpoint publico, endpoint interno de promocion y degradacion contra la base sin migrar.
import { describe, expect, it } from "vitest";
import type { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";
import { buildTestDeps, jsonRequestInit, TEST_ENV } from "./fixtures.ts";

const enMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

interface OrdersBody {
  readonly orders: ReadonlyArray<{ id: string; status: string; propertyId: string; programadoPara: string | null; promovidoAt: string | null }>;
}

async function contexto() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const programado = (propertyId: string, minutos: number, extra: Record<string, unknown> = {}) => {
    const o = makeOrder({ organizationId: ctx.organizationId, propertyId, status: "programado", total: 100, programadoPara: enMin(minutos), promovidoAt: null, ...extra });
    ctx.restaurantesRepo.seedOrder(o);
    return o;
  };
  return { ctx, programado, app: buildApp(ctx.deps) };
}

describe("GET .../admin/scheduled-orders", () => {
  it("lista los programados, el mas proximo primero, con su hora; el staff acotado a A NO ve los de B", async () => {
    const { ctx, programado, app } = await contexto();
    const lejano = programado(ctx.propertyIdA, 600);
    const cercano = programado(ctx.propertyIdA, 120);
    programado(ctx.propertyIdB, 200);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrdersBody & { disponible: boolean; serverNow: string };
    expect(body.disponible).toBe(true);
    expect(body.orders[0]?.id).toBe(cercano.id);
    expect(body.orders[2]?.id).toBe(lejano.id);
    expect(body.orders).toHaveLength(3);
    expect(body.orders[0]?.programadoPara).toBe(cercano.programadoPara);

    const asStaffA = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.staffSucursalA.token));
    const bodyA = (await asStaffA.json()) as OrdersBody;
    expect(bodyA.orders).toHaveLength(2);
    expect(bodyA.orders.every((o) => o.propertyId === ctx.propertyIdA)).toBe(true);
  });

  it("repartidor -> 403 y sin sesion -> 401", async () => {
    const { ctx, app } = await contexto();
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`)).status).toBe(401);
  });

  it("promueve al consultar: el pedido dentro de la anticipacion sale de la pestana y pasa a pendientes; el lejano y el cancelado no", async () => {
    const { ctx, programado, app } = await contexto();
    const proximo = programado(ctx.propertyIdA, 10);
    const lejano = programado(ctx.propertyIdA, 300);
    const cancelado = programado(ctx.propertyIdA, 5, { status: "cancelado" });
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as OrdersBody & { promovidos: string[] };
    expect(body.promovidos).toEqual([proximo.id]);
    expect(body.orders.map((o) => o.id)).toEqual([lejano.id]);

    const pend = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?status=pending`, authedGet(ctx.staff.owner.token));
    const pendBody = (await pend.json()) as OrdersBody;
    expect(pendBody.orders.map((o) => o.id)).toEqual([proximo.id]);
    expect(pendBody.orders[0]?.programadoPara).toBe(proximo.programadoPara);
    expect(pendBody.orders[0]?.promovidoAt).not.toBeNull();
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, cancelado.id))?.status).toBe("cancelado");
  });

  it("idempotente: consultar dos veces no promueve dos veces", async () => {
    const { ctx, programado, app } = await contexto();
    programado(ctx.propertyIdA, 10);
    const a = (await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token))).json()) as { promovidos: string[] };
    const b = (await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token))).json()) as { promovidos: string[] };
    expect(a.promovidos).toHaveLength(1);
    expect(b.promovidos).toHaveLength(0);
  });

  it("base SIN migrar: 200 con disponible=false y lista vacia (nunca un 500)", async () => {
    const { ctx, app } = await contexto();
    ctx.restaurantesRepo.setScheduledOrdersSupported(false);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, orders: [], promovidos: [] });
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?status=pending`, authedGet(ctx.staff.owner.token))).status).toBe(200);
  });
});

describe("GET .../admin/orders promueve programados al consultar", () => {
  it("sin filtro de estado y con status=pending si; con un historial (status=entregado) no", async () => {
    const { ctx, programado, app } = await contexto();
    const p = programado(ctx.propertyIdA, 10);
    const historial = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?status=entregado`, authedGet(ctx.staff.owner.token));
    expect(historial.status).toBe(200);
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, p.id))?.status).toBe("programado");

    const todos = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders`, authedGet(ctx.staff.owner.token));
    expect(((await todos.json()) as OrdersBody).orders.find((o) => o.id === p.id)?.status).toBe("pending");
  });

  it("un fallo al promover no rompe el listado de pedidos", async () => {
    const { ctx, app } = await contexto();
    ctx.restaurantesRepo.promoteDueScheduledOrders = async () => {
      throw new Error("falla simulada");
    };
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?status=pending`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
  });
});

describe("PATCH .../status de un pedido programado", () => {
  it("se puede cancelar (y ya no se promueve) o adelantar a pendiente; saltar a preparando -> 409", async () => {
    const { ctx, programado, app } = await contexto();
    const a = programado(ctx.propertyIdA, 10);
    const b = programado(ctx.propertyIdA, 600);
    const salto = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${b.id}/status`, authedJson(ctx.staff.owner.token, { status: "preparando" }, "PATCH"));
    expect(salto.status).toBe(409);
    const cancel = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${a.id}/status`, authedJson(ctx.staff.owner.token, { status: "cancelado", motivo: "otro" }, "PATCH"));
    expect(cancel.status).toBe(200);
    const adelanto = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${b.id}/status`, authedJson(ctx.staff.owner.token, { status: "pending" }, "PATCH"));
    expect(adelanto.status).toBe(200);
    const lista = (await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token))).json()) as OrdersBody & { promovidos: string[] };
    expect(lista.promovidos).toEqual([]);
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, a.id))?.status).toBe("cancelado");
  });
});

describe("POST /v1/restaurantes/:orgSlug/orders con programado_para", () => {
  async function crear(programado: unknown, preparar?: (r: Awaited<ReturnType<typeof buildTestDeps>>["restaurantesRepo"], propertyId: string) => void) {
    const { deps, restaurantesRepo, products, propertyId } = await buildTestDeps();
    preparar?.(restaurantesRepo, propertyId);
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        { branch_slug: "fco-montejo", customer_name: "Cliente Programado", customer_phone: "9991112222", items: [{ product_id: products.cocaCola, requested_quantity: 1 }], source: "voice", canal: "recoger", payment_method: "efectivo", programado_para: programado },
        { "x-atiende-tool-secret": "test-voice-tool-secret" },
      ),
    );
    return { res, restaurantesRepo };
  }

  it("crea el pedido en estado programado, sin encolar nada para cocina", async () => {
    const { res, restaurantesRepo } = await crear(enMin(180));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { status: string; programadoPara: string } };
    expect(body.order.status).toBe("programado");
    expect(body.order.programadoPara).toBeTruthy();
    expect(restaurantesRepo.getOutbox().filter((o) => o.eventType === "order.created.email")).toHaveLength(0);
  });

  it("hora invalida, sin zona o fuera de ventana -> 400", async () => {
    expect((await crear("manana")).res.status).toBe(400);
    expect((await crear("2030-01-01T10:00:00")).res.status).toBe(400);
    expect((await crear(enMin(5))).res.status).toBe(400);
    expect((await crear(enMin(60 * 24 * 30))).res.status).toBe(400);
  });

  it("fuera del horario de la sucursal (zona America/Mexico_City por omision) -> 400 con el motivo", async () => {
    const objetivo = new Date(Date.now() + 180 * 60_000);
    const horaLocal = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Mexico_City", hour: "2-digit", hourCycle: "h23" }).format(objetivo));
    // Turno diario de una hora, 12 horas despues de la hora elegida: la hora elegida nunca cae dentro.
    const abre = String((horaLocal + 12) % 24).padStart(2, "0");
    const cierra = String((horaLocal + 13) % 24).padStart(2, "0");
    const { res } = await crear(objetivo.toISOString(), (repo, propertyId) => repo.seedBranchPolicy(propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: `${abre}:00`, cierra: `${cierra}:00` }] }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("no atiende a la hora elegida");
  });

  it("base SIN migrar -> 400 (canal de voz) y no se crea ningun pedido", async () => {
    const { res, restaurantesRepo } = await crear(enMin(180), (repo) => repo.setScheduledOrdersSupported(false));
    expect(res.status).toBe(400);
    expect(restaurantesRepo.getOutbox()).toHaveLength(0);
  });
});

describe("/internal/restaurantes/promover-programados", () => {
  it("sin el secreto interno -> 401", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    expect((await app.request("/internal/restaurantes/promover-programados", { method: "POST" })).status).toBe(401);
  });

  it("promueve los vencidos de todas las organizaciones, acepta GET con Bearer (scheduler externo) y es idempotente", async () => {
    const { deps, restaurantesRepo, organizationId, propertyId } = await buildTestDeps();
    const o = makeOrder({ organizationId, propertyId, status: "programado", programadoPara: enMin(10), promovidoAt: null });
    restaurantesRepo.seedOrder(o);
    const app = buildApp(deps);
    const res = await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "ok", promoted: 1, orderIds: [o.id] });
    const again = await app.request("/internal/restaurantes/promover-programados", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(await again.json()).toMatchObject({ promoted: 0 });
    expect((await restaurantesRepo.findOrderById(organizationId, o.id))?.status).toBe("pending");
  });

  it("base SIN migrar -> 200 con status not_available", async () => {
    const { deps, restaurantesRepo } = await buildTestDeps();
    restaurantesRepo.setScheduledOrdersSupported(false);
    const app = buildApp(deps);
    const res = await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(await res.json()).toMatchObject({ ok: true, status: "not_available", promoted: 0 });
  });

  it("registra latido (cron de vercel.json) y el kill switch por cron detiene la promocion sin tocar pedidos", async () => {
    const { deps, restaurantesRepo, organizationId, propertyId } = await buildTestDeps();
    const saludRepo = deps.saludRepo as InMemorySaludRepository;
    saludRepo.addPlatformSuperadmin("admin-1");
    const o = makeOrder({ organizationId, propertyId, status: "programado", programadoPara: enMin(10), promovidoAt: null });
    restaurantesRepo.seedOrder(o);
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: "/internal/restaurantes/promover-programados" }]);
    const app = buildApp({ ...deps, platformSwitchGuard: guard });
    const headers = { authorization: `Bearer ${TEST_ENV.internalSecret}` };
    const pausado = await app.request("/internal/restaurantes/promover-programados", { method: "GET", headers });
    expect(await pausado.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    expect((await restaurantesRepo.findOrderById(organizationId, o.id))?.status).toBe("programado");
    const normal = buildApp(deps);
    expect(await (await normal.request("/internal/restaurantes/promover-programados", { method: "GET", headers })).json()).toMatchObject({ promoted: 1 });
    const latidos = await saludRepo.listCronHeartbeatsForSuperadmin("admin-1");
    expect(latidos.find((l) => l.cronName === "/internal/restaurantes/promover-programados")).toMatchObject({ lastStatus: "ok" });
  });
});
