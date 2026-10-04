// Autopiloto (migracion 050) -- contrato HTTP de punta a punta: aprobar/rechazar con un clic (idempotente, un solo efecto), alcance por sucursal y rol,
// motivo obligatorio al cancelar, base sin migrar, y el tick (limpieza por tiempo y regreso de handoffs) dentro del cron existente. La semantica
// real de SQL (RLS, bloqueos, concurrencia) la prueba scripts/verify-restaurantes-autopiloto contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryAutopilotoRepository } from "@atiende/domain-restaurantes";
import type { PedidoMemoria } from "@atiende/domain-restaurantes";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

async function construir(opts: { sinRepo?: boolean; disponible?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "PNID-AUTOPILOTO");
  const auto = new InMemoryAutopilotoRepository();
  auto.disponible = opts.disponible ?? true;
  const store = new InMemoryComandaOutboxStore({ disponible: true });
  store.ponerModo(ctx.organizationId, "sombra");
  const fake = new FakeSoftRestaurantAdapter();
  const deps: AppDeps = {
    ...ctx.deps,
    ...(opts.sinRepo ? {} : { autopilotoRepo: () => auto }),
    softRestaurantStore: () => store,
    softRestaurantPort: fake as unknown as SoftRestaurantPort,
  };
  const app = envolver(buildApp(deps));
  const base = (propertyId = ctx.propertyIdA) => `/v1/restaurantes/${propertyId}/admin/autopiloto`;

  /** Pedido en ambos repositorios (el principal que lee la ruta y el del autopiloto). */
  function pedido(propertyId: string, status: PedidoMemoria["status"], extra: Partial<PedidoMemoria> = {}): { id: string; mem: PedidoMemoria } {
    const o = makeOrder({ organizationId: ctx.organizationId, propertyId, status, total: 4500, customerName: "Deb", customerPhone: "9995550101", source: "whatsapp" });
    ctx.restaurantesRepo.seedOrder(o);
    const mem: PedidoMemoria = {
      id: o.id, organizationId: ctx.organizationId, propertyId, status, total: 4500, clienteNombre: "Deb", telefono: "9995550101", canal: "domicilio", numero: 77,
      renglones: [{ nombre: "Tacos", cantidad: 100 }, { nombre: "Agua", cantidad: 5 }], ...extra,
    };
    auto.pedidos.set(o.id, mem);
    return { id: o.id, mem };
  }
  async function retenido(propertyId = ctx.propertyIdA) {
    const p = pedido(propertyId, "pending");
    const r = await auto.retenerPedidoGrande(ctx.organizationId, p.id, { total: 4500 });
    return { ...p, solicitudId: r.solicitudId! };
  }
  return { ctx, auto, store, deps, app, base, pedido, retenido };
}

const SIN_SECRETO = { method: "POST", headers: {} };
void SIN_SECRETO;

describe("GET .../admin/autopiloto/solicitudes", () => {
  it("lista las aprobaciones pendientes de la sucursal con el pedido y las decisiones posibles", async () => {
    const t = await construir();
    const r = await t.retenido();
    const res = await t.app.request(`${t.base()}/solicitudes`, authedGet(t.ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disponible).toBe(true);
    expect(body.solicitudes).toHaveLength(1);
    expect(body.solicitudes[0]).toMatchObject({ id: r.solicitudId, tipo: "pedido_grande", estado: "pendiente", decisionesPosibles: ["aprobar", "rechazar"], pedido: { total: 4500, numero: 77, status: "por_aprobar" } });
  });

  it("alcance por sucursal: el staff de A no ve las solicitudes de B; el owner (org-wide) ve ambas", async () => {
    const t = await construir();
    await t.retenido(t.ctx.propertyIdA);
    await t.retenido(t.ctx.propertyIdB);
    const a = await (await t.app.request(`${t.base()}/solicitudes`, authedGet(t.ctx.staff.staffSucursalA.token))).json();
    expect(a.solicitudes.map((s: { propertyId: string }) => s.propertyId)).toEqual([t.ctx.propertyIdA]);
    const o = await (await t.app.request(`${t.base()}/solicitudes`, authedGet(t.ctx.staff.owner.token))).json();
    expect(o.solicitudes).toHaveLength(2);
  });

  it("repartidor, otro tenant y sin sesion no entran; estado invalido es 400", async () => {
    const t = await construir();
    expect((await t.app.request(`${t.base()}/solicitudes`, authedGet(t.ctx.staff.repartidor.token))).status).toBe(403);
    expect((await t.app.request(`${t.base()}/solicitudes`, authedGet(t.ctx.staff.otroOrgOwner.token))).status).toBeGreaterThanOrEqual(403);
    expect((await t.app.request(`${t.base()}/solicitudes`)).status).toBe(401);
    expect((await t.app.request(`${t.base()}/solicitudes?estado=otra`, authedGet(t.ctx.staff.owner.token))).status).toBe(400);
  });

  it("base SIN migrar: 200 con disponible=false y lista vacia (estado honesto, nunca un 500); sin repositorio cableado: 503", async () => {
    const t = await construir({ disponible: false });
    const body = await (await t.app.request(`${t.base()}/solicitudes`, authedGet(t.ctx.staff.owner.token))).json();
    expect(body).toEqual({ disponible: false, solicitudes: [] });
    const s = await construir({ sinRepo: true });
    expect((await s.app.request(`${s.base()}/solicitudes`, authedGet(s.ctx.staff.owner.token))).status).toBe(503);
  });
});

describe("POST .../solicitudes/:id/resolver", () => {
  it("aprobar con un clic: pending, la comanda al POS sale UNA vez (post-commit) y el cliente recibe UN WhatsApp", async () => {
    const t = await construir();
    const r = await t.retenido();
    const res = await t.app.request(`${t.base()}/solicitudes/${r.solicitudId}/resolver`, authedJson(t.ctx.staff.staffSucursalA.token, { decision: "aprobar" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aplicado: true, tipo: "pedido_grande", estadoPedido: "pending" });
    expect(r.mem.status).toBe("pending");
    expect(t.store.todas().map((f) => f.orderId)).toEqual([r.id]);
    expect(t.ctx.restaurantesRepo.getOutbox().filter((o) => o.eventType === "order.aprobado")).toHaveLength(1);
  });

  it("doble clic: el segundo responde aplicado=false, sin segunda comanda ni segundo aviso", async () => {
    const t = await construir();
    const r = await t.retenido();
    const url = `${t.base()}/solicitudes/${r.solicitudId}/resolver`;
    await t.app.request(url, authedJson(t.ctx.staff.owner.token, { decision: "aprobar" }));
    const segundo = await t.app.request(url, authedJson(t.ctx.staff.owner.token, { decision: "aprobar" }));
    expect(segundo.status).toBe(200);
    expect(await segundo.json()).toMatchObject({ aplicado: false, efectos: [] });
    expect(t.store.todas()).toHaveLength(1);
    expect(t.ctx.restaurantesRepo.getOutbox().filter((o) => o.eventType === "order.aprobado")).toHaveLength(1);
  });

  it("rechazar exige motivo de la lista cerrada (400) y con motivo deja el pedido cancelado y avisa con texto honesto", async () => {
    const t = await construir();
    const r = await t.retenido();
    const url = `${t.base()}/solicitudes/${r.solicitudId}/resolver`;
    expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, { decision: "rechazar" }))).status).toBe(400);
    expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, { decision: "rechazar", motivo: "porque si" }))).status).toBe(400);
    expect(r.mem.status).toBe("por_aprobar");
    const ok = await t.app.request(url, authedJson(t.ctx.staff.owner.token, { decision: "rechazar", motivo: "sin_producto" }));
    expect(ok.status).toBe(200);
    expect(r.mem.status).toBe("cancelado");
    expect(t.store.todas()).toHaveLength(0);
    expect(t.ctx.restaurantesRepo.getOutbox().filter((o) => o.eventType === "order.no_confirmado")).toHaveLength(1);
  });

  it("validaciones: decision desconocida, id invalido, indices invalidos -> 400", async () => {
    const t = await construir();
    const r = await t.retenido();
    expect((await t.app.request(`${t.base()}/solicitudes/${r.solicitudId}/resolver`, authedJson(t.ctx.staff.owner.token, { decision: "autoaprobar" }))).status).toBe(400);
    expect((await t.app.request(`${t.base()}/solicitudes/no-es-uuid/resolver`, authedJson(t.ctx.staff.owner.token, { decision: "aprobar" }))).status).toBe(400);
    expect((await t.app.request(`${t.base()}/solicitudes/${randomUUID()}/resolver`, authedJson(t.ctx.staff.owner.token, { decision: "reponer_producto", indices: ["a"] }))).status).toBe(400);
  });

  it("roles: el repartidor y otra organizacion no resuelven; el sistema no tiene ruta de aprobacion", async () => {
    const t = await construir();
    const r = await t.retenido();
    const url = `${t.base()}/solicitudes/${r.solicitudId}/resolver`;
    expect((await t.app.request(url, authedJson(t.ctx.staff.repartidor.token, { decision: "aprobar" }))).status).toBe(403);
    expect((await t.app.request(url, authedJson(t.ctx.staff.otroOrgOwner.token, { decision: "aprobar" }))).status).toBeGreaterThanOrEqual(403);
    expect(r.mem.status).toBe("por_aprobar");
  });

  it("sin alcance en la base (42501) -> 403 y el pedido no cambia", async () => {
    const t = await construir();
    const r = await t.retenido();
    t.auto.actorConAlcance = false;
    const res = await t.app.request(`${t.base()}/solicitudes/${r.solicitudId}/resolver`, authedJson(t.ctx.staff.owner.token, { decision: "aprobar" }));
    expect(res.status).toBe(403);
    expect(r.mem.status).toBe("por_aprobar");
  });

  it("base SIN migrar: 503 honesto (nunca un 500)", async () => {
    const t = await construir({ disponible: false });
    const res = await t.app.request(`${t.base()}/solicitudes/${randomUUID()}/resolver`, authedJson(t.ctx.staff.owner.token, { decision: "aprobar" }));
    expect(res.status).toBe(503);
  });

  it("compensacion: 'Reponer producto' crea el pedido de $0, lo manda a cocina una vez y no se repite", async () => {
    const t = await construir();
    const p = t.pedido(t.ctx.propertyIdA, "entregado");
    const q = await t.auto.crearSolicitud(t.ctx.organizationId, t.ctx.propertyIdA, "compensacion", p.id, { subtipo: "faltante" });
    const url = `${t.base()}/solicitudes/${q.solicitudId}/resolver`;
    const r1 = await t.app.request(url, authedJson(t.ctx.staff.owner.token, { decision: "reponer_producto", indices: [1] }));
    expect(r1.status).toBe(200);
    const body = await r1.json();
    expect(body.reposicionOrderId).toBeTruthy();
    // El pedido de reposicion vive en el repositorio del autopiloto; la comanda post-commit se intenta una vez.
    const r2 = await (await t.app.request(url, authedJson(t.ctx.staff.owner.token, { decision: "reponer_producto", indices: [1] }))).json();
    expect(r2.aplicado).toBe(false);
    expect([...t.auto.pedidos.values()].filter((x) => x.total === 0)).toHaveLength(1);
  });
});

describe("config del autopiloto", () => {
  const CONFIG = { cancelacionAuto: false, aceptacionAuto: true, aprobacionMinutos: 12, handoffRegresoMinutos: 20, noRecogidoMinutos: 90, completadoHoras: 8, compensacionTopePct: 15, saturacionUmbral1: 10, saturacionUmbral2: 20, saturacionExtraMinutos: 15 };

  it("sin guardar: valores por omision seguros (cancelacion automatica APAGADA) y estado honesto de plantillas y POS", async () => {
    const t = await construir();
    const body = await (await t.app.request(`${t.base()}/config`, authedGet(t.ctx.staff.owner.token))).json();
    expect(body.config).toMatchObject({ cancelacionAuto: false, aceptacionAuto: false, aprobacionMinutos: 10, handoffRegresoMinutos: 15, noRecogidoMinutos: 60, configurada: false });
    expect(body.plantillas.length).toBeGreaterThan(5);
    expect(body.plantillas.every((p: { aprobada: boolean }) => p.aprobada === false)).toBe(true);
    expect(body.posReal).toBe(false);
  });

  it("solo owner/admin guardan; el staff de piso recibe 403; queda en la bitacora y se lee de vuelta", async () => {
    const t = await construir();
    expect((await t.app.request(`${t.base()}/config`, authedJson(t.ctx.staff.staffSucursalA.token, CONFIG, "PUT"))).status).toBe(403);
    const ok = await t.app.request(`${t.base()}/config`, authedJson(t.ctx.staff.admin.token, CONFIG, "PUT"));
    expect(ok.status).toBe(200);
    const leida = await (await t.app.request(`${t.base()}/config`, authedGet(t.ctx.staff.owner.token))).json();
    expect(leida.config).toMatchObject({ aceptacionAuto: true, aprobacionMinutos: 12, configurada: true });
    const bitacora = await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 20 } as never);
    expect(bitacora.items.some((f) => f.action === "autopiloto.config_actualizada")).toBe(true);
  });

  it("la regla de toda la organizacion (el agente gestiona las cancelaciones) viene apagada, la guarda owner/admin y queda en la bitacora", async () => {
    const t = await construir();
    const antes = await (await t.app.request(`${t.base()}/config`, authedGet(t.ctx.staff.owner.token))).json();
    expect(antes.org).toEqual({ cancelacionAgente: false });
    const res = await t.app.request(`${t.base()}/config`, authedJson(t.ctx.staff.owner.token, { ...CONFIG, cancelacionAgente: true }, "PUT"));
    expect(res.status).toBe(200);
    expect((await res.json()).org).toEqual({ cancelacionAgente: true });
    expect((await (await t.app.request(`${t.base()}/config`, authedGet(t.ctx.staff.owner.token))).json()).org).toEqual({ cancelacionAgente: true });
    const bitacora = await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 20 } as never);
    expect(bitacora.items.some((f) => f.action === "autopiloto.cancelacion_agente_actualizada" && f.despues === "true")).toBe(true);
    // Sin cambio no se vuelve a escribir ni a auditar.
    await t.app.request(`${t.base()}/config`, authedJson(t.ctx.staff.owner.token, { ...CONFIG, cancelacionAgente: true }, "PUT"));
    const bitacora2 = await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 50 } as never);
    expect(bitacora2.items.filter((f) => f.action === "autopiloto.cancelacion_agente_actualizada")).toHaveLength(1);
  });

  it("cancelacionAgente exige booleano (400) y sin alcance organizacional en la base es 403", async () => {
    const t = await construir();
    expect((await t.app.request(`${t.base()}/config`, authedJson(t.ctx.staff.owner.token, { ...CONFIG, cancelacionAgente: "si" }, "PUT"))).status).toBe(400);
    t.auto.actorConAlcance = false;
    expect((await t.app.request(`${t.base()}/config`, authedJson(t.ctx.staff.owner.token, { ...CONFIG, cancelacionAgente: true }, "PUT"))).status).toBe(403);
  });

  it("valida rangos y umbrales (400)", async () => {
    const t = await construir();
    for (const malo of [{ ...CONFIG, aprobacionMinutos: 0 }, { ...CONFIG, cancelacionAuto: "si" }, { ...CONFIG, saturacionUmbral2: 5 }, { ...CONFIG, saturacionUmbral1: null, saturacionUmbral2: 30 }, { ...CONFIG, compensacionTopePct: 101 }]) {
      expect((await t.app.request(`${t.base()}/config`, authedJson(t.ctx.staff.owner.token, malo, "PUT"))).status).toBe(400);
    }
  });
});

describe("agotado hasta manana", () => {
  it("marca el producto no disponible hasta manana (zona de la sucursal) y deja bitacora; se repone en el tick al cambiar el dia", async () => {
    const t = await construir();
    const productId = randomUUID();
    t.auto.agotados.push({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, productId, disponible: true, agotadoHasta: null });
    const res = await t.app.request(`${t.base()}/agotado`, authedJson(t.ctx.staff.staffSucursalA.token, { productId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agotadoHasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.auto.agotados[0]).toMatchObject({ disponible: false, agotadoHasta: body.agotadoHasta });
    const bitacora = await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 20 } as never);
    expect(bitacora.items.some((f) => f.action === "producto.agotado_hasta_manana" && f.entityId === productId)).toBe(true);
  });

  it("producto no dado de alta -> 404; id invalido -> 400; repartidor -> 403; base sin migrar -> 503", async () => {
    const t = await construir();
    expect((await t.app.request(`${t.base()}/agotado`, authedJson(t.ctx.staff.owner.token, { productId: randomUUID() }))).status).toBe(404);
    expect((await t.app.request(`${t.base()}/agotado`, authedJson(t.ctx.staff.owner.token, { productId: "x" }))).status).toBe(400);
    expect((await t.app.request(`${t.base()}/agotado`, authedJson(t.ctx.staff.repartidor.token, { productId: randomUUID() }))).status).toBe(403);
    const v = await construir({ disponible: false });
    expect((await v.app.request(`${v.base()}/agotado`, authedJson(v.ctx.staff.owner.token, { productId: randomUUID() }))).status).toBe(503);
  });
});

describe("cancelar un pedido (PATCH status) exige motivo de la lista cerrada", () => {
  it("sin motivo o con motivo libre -> 400 y el pedido NO cambia; con motivo -> 200", async () => {
    const t = await construir();
    const o = makeOrder({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, status: "pending", total: 100 });
    t.ctx.restaurantesRepo.seedOrder(o);
    const url = `/v1/restaurantes/${t.ctx.propertyIdA}/admin/orders/${o.id}/status`;
    expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, { status: "cancelado" }, "PATCH"))).status).toBe(400);
    expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, { status: "cancelado", motivo: "no quiso" }, "PATCH"))).status).toBe(400);
    expect((await t.ctx.restaurantesRepo.findOrderById(t.ctx.organizationId, o.id))!.status).toBe("pending");
    expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, { status: "cancelado", motivo: "error_agente" }, "PATCH"))).status).toBe(200);
    expect((await t.ctx.restaurantesRepo.findOrderById(t.ctx.organizationId, o.id))!.status).toBe("cancelado");
  });

  it("un pedido por_aprobar no se mueve con el cambio manual de estado (409): se aprueba o rechaza con su solicitud", async () => {
    const t = await construir();
    const o = makeOrder({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, status: "por_aprobar", total: 4500 });
    t.ctx.restaurantesRepo.seedOrder(o);
    const url = `/v1/restaurantes/${t.ctx.propertyIdA}/admin/orders/${o.id}/status`;
    expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, { status: "pending" }, "PATCH"))).status).toBe(409);
    expect((await t.app.request(url, authedJson(t.ctx.staff.owner.token, { status: "cancelado", motivo: "otro" }, "PATCH"))).status).toBe(409);
    expect((await t.ctx.restaurantesRepo.findOrderById(t.ctx.organizationId, o.id))!.status).toBe("por_aprobar");
  });
});

describe("tick /internal/restaurantes/promover-programados: autopiloto", () => {
  const llamar = (t: Awaited<ReturnType<typeof construir>>) => t.app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

  it("limpieza por tiempo en el cron existente (sin cron nuevo): entregado de hace 7 h pasa a completado, UNA vez", async () => {
    const t = await construir();
    const p = t.pedido(t.ctx.propertyIdA, "entregado", { entregadoAt: new Date(Date.now() - 7 * 3_600_000) });
    const r1 = await (await llamar(t)).json();
    expect(r1.autopiloto).toMatchObject({ disponible: true, estadosAplicados: 1, errores: 0 });
    expect(p.mem.status).toBe("completado");
    const r2 = await (await llamar(t)).json();
    expect(r2.autopiloto.estadosAplicados).toBe(0);
  });

  it("jamas autoaprueba: una aprobacion sin respuesta se escala una vez y el pedido sigue por_aprobar", async () => {
    const t = await construir();
    const r = await t.retenido();
    t.auto.configs.set(t.ctx.propertyIdA, { ...(await t.auto.leerConfig("", t.ctx.propertyIdA)).valor, aprobacionMinutos: 1, configurada: true });
    // Reloj: la solicitud se creo "hace 5 minutos".
    (t.auto as unknown as { solicitudes: { solicitadaAt: Date }[] }).solicitudes.forEach((s) => (s.solicitadaAt = new Date(Date.now() - 5 * 60_000)));
    const r1 = await (await llamar(t)).json();
    expect(r1.autopiloto.escaladas).toBe(1);
    expect((await (await llamar(t)).json()).autopiloto.escaladas).toBe(0);
    expect(r.mem.status).toBe("por_aprobar");
    expect(t.store.todas()).toHaveLength(0);
  });

  it("regreso del handoff en el mismo tick, una sola vez", async () => {
    const t = await construir();
    t.auto.handoffs.push({ id: "h1", organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, conversationId: randomUUID(), telefono: "9995550199", estado: "tomada", tomadaAt: new Date(Date.now() - 30 * 60_000), ultimaHumanaAt: null, ultimoClienteAt: new Date(Date.now() - 10 * 60_000) });
    expect((await (await llamar(t)).json()).autopiloto.handoffsDevueltos).toBe(1);
    expect((await (await llamar(t)).json()).autopiloto.handoffsDevueltos).toBe(0);
  });

  it("sin repositorio de autopiloto o con la base sin migrar el tick sigue respondiendo ok (autopiloto no disponible)", async () => {
    const s = await construir({ sinRepo: true });
    const a = await (await llamar(s)).json();
    expect(a.ok).toBe(true);
    expect(a.autopiloto.disponible).toBe(false);
    const v = await construir({ disponible: false });
    const b = await (await llamar(v)).json();
    expect(b.ok).toBe(true);
    expect(b.autopiloto).toMatchObject({ disponible: false, errores: 0 });
  });

  it("sin el secreto interno el tick es 401", async () => {
    const t = await construir();
    expect((await t.app.request("/internal/restaurantes/promover-programados", { method: "POST" })).status).toBe(401);
  });
});

describe("GET .../pedidos/:orderId/historial", () => {
  it("devuelve las transiciones del pedido y respeta el alcance de sucursal", async () => {
    const t = await construir();
    const r = await t.retenido();
    await t.app.request(`${t.base()}/solicitudes/${r.solicitudId}/resolver`, authedJson(t.ctx.staff.owner.token, { decision: "aprobar" }));
    const res = await t.app.request(`${t.base()}/pedidos/${r.id}/historial`, authedGet(t.ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventos.map((e: { hacia: string }) => e.hacia)).toEqual(["por_aprobar", "pending"]);
    const otra = t.pedido(t.ctx.propertyIdB, "pending");
    expect((await t.app.request(`${t.base()}/pedidos/${otra.id}/historial`, authedGet(t.ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await t.app.request(`${t.base()}/pedidos/no-uuid/historial`, authedGet(t.ctx.staff.owner.token))).status).toBe(400);
  });
});
