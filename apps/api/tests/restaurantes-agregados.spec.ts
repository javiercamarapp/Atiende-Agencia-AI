// «Agregados por validar» (migracion 099) -- contrato HTTP de punta a punta: listar / aceptar / rechazar con permiso `pedidos.agregados` (repartidor NO), alcance por sucursal,
// idempotencia (doble clic = un efecto), auditoria sin PII, aviso al cliente, tarea de devolver llamada, base sin migrar, y el SLA derivado al leer + barrido en el tick EXISTENTE de 5 min.
// La semantica real de SQL (RLS, grants, trigger, concurrencia) la prueba scripts/verify-restaurantes-agregados contra Postgres real.
import { describe, expect, it } from "vitest";
import { InMemoryAgregadosRepository } from "@atiende/domain-restaurantes";
import type { PedidoAgregableMemoria } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const COCA = { id: "p-coca", name: "Coca-Cola", price: 45, quantity: 2 };

async function construir(opts: { sinRepo?: boolean; disponible?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "PNID-AGREGADOS");
  const agregados = new InMemoryAgregadosRepository();
  agregados.disponible = opts.disponible ?? true;
  const deps: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { agregadosRepo: () => agregados }) };
  const app = envolver(buildApp(deps));
  const url = (propertyId = ctx.propertyIdA) => `/v1/restaurantes/${propertyId}/admin/agregados`;
  let n = 0;
  async function solicitud(propertyId = ctx.propertyIdA, extra: Partial<PedidoAgregableMemoria> = {}) {
    n += 1;
    const pedido: PedidoAgregableMemoria = {
      id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, organizationId: ctx.organizationId, propertyId, sucursal: "Centro", orderNumber: 100 + n, status: "preparando",
      items: [{ id: "p-taco", name: "Taco de pastor", price: 25, quantity: 4 }], total: 100, customerName: "Ana Pech", customerPhone: "9995550101", createdAt: new Date().toISOString(), ...extra,
    };
    agregados.sembrarPedido(pedido);
    const r = await agregados.crear({ organizationId: ctx.organizationId, propertyId, orderId: pedido.id, channel: "whatsapp", items: [COCA], customerNote: "bien fría" });
    if (r.estado !== "creado") throw new Error("esperaba creado");
    return { pedido, id: r.agregado.id };
  }
  return { ctx, agregados, deps, app, url, solicitud };
}

describe("GET .../admin/agregados", () => {
  it("lista las pendientes de la sucursal con el pedido original, lo agregado, el nuevo total y el cronometro", async () => {
    const t = await construir();
    const s = await t.solicitud();
    const res = await t.app.request(t.url(), authedGet(t.ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ disponible: true, pendientes: 1 });
    expect(body.agregados[0]).toMatchObject({
      id: s.id, estado: "pendiente", estadoEfectivo: "pendiente", canal: "whatsapp", sla: { nivel: "en_tiempo" },
      pedido: { numero: 101, estado: "preparando", yaEnCocina: true, total: 100, renglones: [{ nombre: "Taco de pastor", cantidad: 4 }] },
      agregado: { total: 90, nuevoTotal: 190, nota: "bien fría", renglones: [{ nombre: "Coca-Cola", cantidad: 2, precio: 45, subtotal: 90 }] },
      cliente: { nombre: "Ana Pech", telefono: "9995550101" },
    });
  });

  it("el repartidor NO la ve (403) y sin sesion es 401; owner, admin y staff si", async () => {
    const t = await construir();
    await t.solicitud();
    expect((await t.app.request(t.url(), authedGet(t.ctx.staff.repartidor.token))).status).toBe(403);
    expect((await t.app.request(t.url())).status).toBe(401);
    for (const who of [t.ctx.staff.owner, t.ctx.staff.admin, t.ctx.staff.staffSucursalA]) expect((await t.app.request(t.url(), authedGet(who.token))).status).toBe(200);
  });

  it("alcance: el staff y el admin ACOTADOS a A no ven los de B; el owner ve ambas; otra organizacion no ve nada", async () => {
    const t = await construir();
    await t.solicitud(t.ctx.propertyIdA);
    await t.solicitud(t.ctx.propertyIdB);
    const cuenta = async (token: string) => (await (await t.app.request(t.url(), authedGet(token))).json()).agregados.length;
    expect(await cuenta(t.ctx.staff.staffSucursalA.token)).toBe(1);
    expect(await cuenta(t.ctx.staff.adminSucursalA.token)).toBe(1);
    expect(await cuenta(t.ctx.staff.owner.token)).toBe(2);
    expect([403, 404]).toContain((await t.app.request(t.url(), authedGet(t.ctx.staff.otroOrgOwner.token))).status);
  });

  it("estado invalido es 400; «recientes» incluye lo resuelto de las ultimas 24 h con quien lo resolvio", async () => {
    const t = await construir();
    const s = await t.solicitud();
    expect((await t.app.request(`${t.url()}?estado=otro`, authedGet(t.ctx.staff.owner.token))).status).toBe(400);
    t.agregados.nombresPersonal.set(t.ctx.staff.owner.id, "Dueño");
    await t.app.request(`${t.url()}/${s.id}/aceptar`, authedJson(t.ctx.staff.owner.token, {}));
    const pend = await (await t.app.request(t.url(), authedGet(t.ctx.staff.owner.token))).json();
    expect(pend.agregados).toHaveLength(0);
    const rec = await (await t.app.request(`${t.url()}?estado=recientes`, authedGet(t.ctx.staff.owner.token))).json();
    expect(rec.agregados[0]).toMatchObject({ estado: "aceptado", resueltoPor: "Dueño", cliente: { telefono: null } });
  });

  it("SLA derivado AL LEER: a los 10 min aparece «sin_respuesta» y a los 20 «vencido» aunque el tick no haya corrido", async () => {
    const t = await construir();
    const s = await t.solicitud();
    t.agregados.envejecer(s.id, 11);
    let c = (await (await t.app.request(t.url(), authedGet(t.ctx.staff.owner.token))).json()).agregados[0];
    expect(c).toMatchObject({ estado: "pendiente", estadoEfectivo: "pendiente", sla: { nivel: "sin_respuesta" } });
    t.agregados.envejecer(s.id, 21);
    c = (await (await t.app.request(t.url(), authedGet(t.ctx.staff.owner.token))).json()).agregados[0];
    expect(c).toMatchObject({ estado: "pendiente", estadoEfectivo: "vencido", sla: { nivel: "vencido" } });
  });

  it("base sin migrar: disponible:false con lista vacia; sin repositorio cableado tambien, y las escrituras 503", async () => {
    const t = await construir({ disponible: false });
    expect(await (await t.app.request(t.url(), authedGet(t.ctx.staff.owner.token))).json()).toMatchObject({ disponible: false, agregados: [], pendientes: 0 });
    const id = "00000000-0000-4000-8000-000000000999";
    expect((await t.app.request(`${t.url()}/${id}/aceptar`, authedJson(t.ctx.staff.owner.token, {}))).status).toBe(503);
    const sin = await construir({ sinRepo: true });
    expect(await (await sin.app.request(sin.url(), authedGet(sin.ctx.staff.owner.token))).json()).toMatchObject({ disponible: false });
    expect((await sin.app.request(`${sin.url()}/${id}/aceptar`, authedJson(sin.ctx.staff.owner.token, {}))).status).toBe(503);
  });
});

describe("POST .../aceptar", () => {
  it("aplica los renglones y el total al pedido, avisa al cliente por WhatsApp y deja auditoria SIN telefono ni nombre", async () => {
    const t = await construir();
    const s = await t.solicitud();
    const res = await t.app.request(`${t.url()}/${s.id}/aceptar`, authedJson(t.ctx.staff.staffSucursalA.token, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resultado: "aplicado", agregado: { estado: "aceptado", cliente: { telefono: null } } });
    expect(t.agregados.pedidos.get(s.pedido.id)).toMatchObject({ total: 190 });
    expect(t.agregados.pedidos.get(s.pedido.id)!.items.map((i) => i.name)).toEqual(["Taco de pastor", "Coca-Cola"]);
    const msg = t.ctx.restaurantesRepo.getOutbox().filter((r) => r.eventType === "agregado.aceptado");
    expect(msg).toHaveLength(1);
    expect(JSON.stringify(msg[0])).toContain("ya agregamos 2 Coca-Cola a tu pedido #101");
    const aud = (await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 20 })).items.find((i) => i.action === "agregado.aceptado");
    expect(aud).toBeTruthy();
    expect(JSON.stringify(aud)).not.toMatch(/9995550101|Ana Pech/);
  });

  it("DOBLE CLIC (o dos cajeros a la vez): la segunda llamada es 200 ya_resuelto, no repite aviso, total ni auditoria", async () => {
    const t = await construir();
    const s = await t.solicitud();
    await t.app.request(`${t.url()}/${s.id}/aceptar`, authedJson(t.ctx.staff.staffSucursalA.token, {}));
    const otra = await t.app.request(`${t.url()}/${s.id}/aceptar`, authedJson(t.ctx.staff.owner.token, {}));
    expect(otra.status).toBe(200);
    expect((await otra.json()).resultado).toBe("ya_resuelto");
    expect(t.agregados.pedidos.get(s.pedido.id)?.total).toBe(190);
    expect(t.ctx.restaurantesRepo.getOutbox().filter((r) => r.eventType === "agregado.aceptado")).toHaveLength(1);
    expect((await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 20 })).items.filter((i) => i.action === "agregado.aceptado")).toHaveLength(1);
  });

  it("si el pedido salio antes de decidir: 200 no_aplicable, el pedido NO cambia y el cliente recibe la oferta de pedido aparte", async () => {
    const t = await construir();
    const s = await t.solicitud();
    t.agregados.pedidos.get(s.pedido.id)!.status = "en_camino";
    const res = await (await t.app.request(`${t.url()}/${s.id}/aceptar`, authedJson(t.ctx.staff.owner.token, {}))).json();
    expect(res.resultado).toBe("no_aplicable");
    expect(t.agregados.pedidos.get(s.pedido.id)?.total).toBe(100);
    expect(JSON.stringify(t.ctx.restaurantesRepo.getOutbox().filter((r) => r.eventType === "agregado.no_aplicable"))).toContain("ya salió");
  });

  it("permisos y alcance: el repartidor 403; el staff de A no decide uno de B (404); id invalido 400; inexistente 404", async () => {
    const t = await construir();
    const a = await t.solicitud(t.ctx.propertyIdA);
    const b = await t.solicitud(t.ctx.propertyIdB);
    expect((await t.app.request(`${t.url()}/${a.id}/aceptar`, authedJson(t.ctx.staff.repartidor.token, {}))).status).toBe(403);
    expect((await t.app.request(`${t.url()}/${b.id}/aceptar`, authedJson(t.ctx.staff.staffSucursalA.token, {}))).status).toBe(404);
    expect((await t.app.request(`${t.url()}/${b.id}/rechazar`, authedJson(t.ctx.staff.adminSucursalA.token, { motivo: "otro", nota: "x" }))).status).toBe(404);
    expect((await t.app.request(`${t.url()}/no-es-uuid/aceptar`, authedJson(t.ctx.staff.owner.token, {}))).status).toBe(400);
    expect((await t.app.request(`${t.url()}/00000000-0000-4000-8000-0000000000ff/aceptar`, authedJson(t.ctx.staff.owner.token, {}))).status).toBe(404);
    expect(t.agregados.pedidos.get(b.pedido.id)?.total).toBe(100);
    expect((await t.app.request(`${t.url()}/${a.id}/aceptar`, authedJson(t.ctx.staff.otroOrgOwner.token, {}))).status).toBeGreaterThanOrEqual(403);
  });
});

describe("POST .../rechazar", () => {
  it("con motivo: avisa al cliente con disculpa y oferta de pedido nuevo y crea la tarea de devolver llamada con guion", async () => {
    const t = await construir();
    const s = await t.solicitud();
    const res = await t.app.request(`${t.url()}/${s.id}/rechazar`, authedJson(t.ctx.staff.staffSucursalA.token, { motivo: "ya_salio_de_cocina" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resultado: "aplicado", agregado: { estado: "rechazado", motivoRechazo: "ya_salio_de_cocina" } });
    expect(t.agregados.pedidos.get(s.pedido.id)?.total).toBe(100);
    const msg = JSON.stringify(t.ctx.restaurantesRepo.getOutbox().filter((r) => r.eventType === "agregado.rechazado"));
    expect(msg).toContain("una disculpa");
    expect(msg).toContain("pedido nuevo");
    const cbs = t.ctx.restaurantesRepo.listCallbackRequests(t.ctx.organizationId);
    expect(cbs).toHaveLength(1);
    expect(cbs[0]).toMatchObject({ reason: "agregado_rechazado", propertyId: t.ctx.propertyIdA, customerPhone: "9995550101" });
    expect(cbs[0]!.message).toContain("el pedido ya salió de cocina");
    const aud = (await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 20 })).items.find((i) => i.action === "agregado.rechazado");
    expect(JSON.stringify(aud)).toContain("ya_salio_de_cocina");
  });

  it("validacion: sin motivo, motivo fuera de la lista, «otro» sin nota o nota de mas de 300: 400 y la solicitud sigue pendiente", async () => {
    const t = await construir();
    const s = await t.solicitud();
    const post = (cuerpo: unknown) => t.app.request(`${t.url()}/${s.id}/rechazar`, authedJson(t.ctx.staff.owner.token, cuerpo));
    for (const malo of [{}, { motivo: "porque_si" }, { motivo: "otro" }, { motivo: "otro", nota: "   " }, { motivo: "producto_agotado", nota: "x".repeat(301) }, { motivo: 5 }]) expect((await post(malo)).status).toBe(400);
    expect((await t.agregados.obtener(t.ctx.organizationId, s.id, null)).valor?.estado).toBe("pendiente");
    expect((await post({ motivo: "otro", nota: "Cocina saturada" })).status).toBe(200);
  });

  it("doble clic: la segunda llamada es ya_resuelto, una sola tarea y un solo WhatsApp", async () => {
    const t = await construir();
    const s = await t.solicitud();
    await t.app.request(`${t.url()}/${s.id}/rechazar`, authedJson(t.ctx.staff.owner.token, { motivo: "producto_agotado" }));
    const otra = await (await t.app.request(`${t.url()}/${s.id}/rechazar`, authedJson(t.ctx.staff.staffSucursalA.token, { motivo: "otro", nota: "x" }))).json();
    expect(otra.resultado).toBe("ya_resuelto");
    expect(otra.agregado.motivoRechazo).toBe("producto_agotado");
    expect(t.ctx.restaurantesRepo.listCallbackRequests(t.ctx.organizationId)).toHaveLength(1);
    expect(t.ctx.restaurantesRepo.getOutbox().filter((r) => r.eventType === "agregado.rechazado")).toHaveLength(1);
  });
});

describe("POST .../visto", () => {
  it("marca la primera vez que una persona la vio, una sola vez", async () => {
    const t = await construir();
    const s = await t.solicitud();
    expect((await t.app.request(`${t.url()}/${s.id}/visto`, authedJson(t.ctx.staff.staffSucursalA.token, {}))).status).toBe(200);
    const primera = (await t.agregados.obtener(t.ctx.organizationId, s.id, null)).valor!.firstSeenAt;
    expect(primera).not.toBeNull();
    await t.app.request(`${t.url()}/${s.id}/visto`, authedJson(t.ctx.staff.owner.token, {}));
    expect((await t.agregados.obtener(t.ctx.organizationId, s.id, null)).valor!.firstSeenAt).toBe(primera);
    expect((await t.app.request(`${t.url()}/${s.id}/visto`, authedJson(t.ctx.staff.repartidor.token, {}))).status).toBe(403);
  });
});

describe("tick /internal/restaurantes/promover-programados: SLA de agregados (sin cron nuevo)", () => {
  const llamar = (t: Awaited<ReturnType<typeof construir>>) => t.app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

  it("a los 10 min avisa UNA vez (dueno y cliente); a los 20 la cierra como vencida sin aceptar y deja la tarea de devolver llamada", async () => {
    const t = await construir();
    const s = await t.solicitud();
    expect((await (await llamar(t)).json()).autopiloto ?? {}).toMatchObject({ agregadosAvisados: 0, agregadosVencidos: 0 });
    t.agregados.envejecer(s.id, 11);
    const r1 = await (await llamar(t)).json();
    expect(r1.autopiloto).toMatchObject({ agregadosAvisados: 1, agregadosVencidos: 0, errores: 0 });
    await llamar(t);
    expect(t.ctx.restaurantesRepo.getOutbox().filter((r) => r.eventType === "agregado.seguimiento")).toHaveLength(1);
    expect((await t.agregados.obtener(t.ctx.organizationId, s.id, null)).valor?.estado).toBe("pendiente");
    t.agregados.envejecer(s.id, 21);
    const r2 = await (await llamar(t)).json();
    expect(r2.autopiloto).toMatchObject({ agregadosVencidos: 1 });
    expect((await t.agregados.obtener(t.ctx.organizationId, s.id, null)).valor).toMatchObject({ estado: "vencido", decidedBy: null });
    expect(t.agregados.pedidos.get(s.pedido.id)?.total).toBe(100);
    expect(t.ctx.restaurantesRepo.listCallbackRequests(t.ctx.organizationId).map((c) => c.reason)).toEqual(["agregado_vencido"]);
    expect(t.ctx.restaurantesRepo.getOutbox().filter((r) => r.eventType === "agregado.vencido")).toHaveLength(1);
  });

  it("sin el secreto interno el tick es 401; una solicitud resuelta a tiempo no se escala", async () => {
    const t = await construir();
    const s = await t.solicitud();
    expect((await t.app.request("/internal/restaurantes/promover-programados", { method: "POST" })).status).toBe(401);
    await t.app.request(`${t.url()}/${s.id}/aceptar`, authedJson(t.ctx.staff.owner.token, {}));
    t.agregados.envejecer(s.id, 30);
    expect((await (await llamar(t)).json()).autopiloto).toMatchObject({ agregadosAvisados: 0, agregadosVencidos: 0 });
  });
});
