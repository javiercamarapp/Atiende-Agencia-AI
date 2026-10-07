// Comandas al POS (captura asistida): alerta de captura manual vencida (tick del dispatch, sin adaptador real), umbral por sucursal
// y estado de la comanda por pedido (insignia de Pedidos). HTTP real sobre repos en memoria; el SQL lo cubre
// scripts/verify-restaurantes-clientes-import contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, type ComandaInput } from "@atiende/domain-restaurantes/softrestaurant";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const PAYLOAD: ComandaInput = {
  idempotencyKey: "k",
  sucursal: "T1",
  tipo: "recoger",
  cliente: { nombre: "Ana", telefono: "9991112222" },
  formaPago: "efectivo",
  items: [{ codigo: "FAKE-003", cantidad: 1, modificadores: [], nombre: "Refresco" }],
};

async function construir(opciones: { alEmitir?: () => number } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  // Reloj del store: las comandas se siembran "hace 10 minutos"; el tick usa el reloj real.
  const hace10min = new Date(Date.now() - 10 * 60_000);
  const store = new InMemoryComandaOutboxStore({ ahora: () => hace10min });
  store.registrarSucursal(ctx.propertyIdA, ctx.organizationId);
  store.registrarSucursal(ctx.propertyIdB, ctx.organizationId);
  const base: AppDeps = { ...ctx.deps, softRestaurantStore: () => store, softRestaurantPort: new FakeSoftRestaurantAdapter() };
  const { deps, emisiones } = conEmisiones(base, opciones);
  const app = buildApp(deps);
  const headers = { "x-atiende-internal-secret": deps.env.internalSecret };
  const tick = () => app.request("/internal/restaurantes/softrestaurant-dispatch", { method: "POST", headers });

  async function sembrarCapturaManual(propertyId = ctx.propertyIdA) {
    const orderId = randomUUID();
    const r = await store.encolar({ organizationId: ctx.organizationId, propertyId, orderId, idempotencyKey: `k-${orderId}`, modo: "activo", payload: PAYLOAD, maxIntentos: 5 });
    if (!r.disponible) throw new Error("store no disponible");
    store.ponerModo(ctx.organizationId, "activo");
    await store.reclamarPorId(r.fila.id, hace10min, 1000);
    await store.completar(r.fila.id, { estado: "captura_manual", folio: null, ultimoError: "rechazada:producto_sin_codigo_pos", proximoIntentoEn: null, alertarCapturaManual: true });
    return { comandaId: r.fila.id, orderId };
  }
  return { ctx, store, app, emisiones, tick, sembrarCapturaManual, base: `/v1/restaurantes/${ctx.propertyIdA}/admin/softrestaurant` };
}

describe("alerta de comanda esperando captura manual (tick de softrestaurant-dispatch)", () => {
  it("SIN adaptador real igual avisa: 503 por el adaptador, pero emite UNA alerta por comanda vencida, sin PII y con enlace a Comandas al POS", async () => {
    const t = await construir();
    const { comandaId } = await t.sembrarCapturaManual();
    const res = await t.tick();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { alertas: { disponible: boolean; candidatas: number; emitidas: number } };
    expect(body.alertas).toMatchObject({ disponible: true, candidatas: 1, emitidas: 1 });
    expect(t.emisiones).toHaveLength(1);
    expect(t.emisiones[0]).toMatchObject({
      evento: "restaurantes.comanda.captura_manual_vencida",
      organizationId: t.ctx.organizationId,
      propertyId: t.ctx.propertyIdA,
      severidad: "atencion",
      categoria: "operacion",
      enlace: "/restaurantes/{orgSlug}/comandas-pos",
      dedupeKey: `restaurantes.comanda.captura_manual_vencida:${comandaId}`,
      roles: ["staff"],
    });
    expect(`${t.emisiones[0]!.titulo} ${t.emisiones[0]!.cuerpo}`).not.toMatch(/Ana|9991112222|\d{7,}|@/);
    expect(t.emisiones[0]!.cuerpo).toMatch(/Lleva 10 minutos/);
  });

  it("dos ticks reutilizan la MISMA clave de dedupe (la base deja una sola alerta por comanda)", async () => {
    const t = await construir();
    await t.sembrarCapturaManual();
    await t.tick();
    await t.tick();
    expect(t.emisiones).toHaveLength(2);
    expect(new Set(t.emisiones.map((e) => e.dedupeKey)).size).toBe(1);
  });

  it("no avisa antes del umbral, ni de una comanda confirmada o ya capturada a mano", async () => {
    const t = await construir();
    // Umbral de la sucursal A a 30 minutos: la comanda (10 min) aun no vence.
    await t.sembrarCapturaManual();
    const fija = await t.app.request(`${t.base}/umbral-captura-manual`, authedJson(t.ctx.staff.owner.token, { branchId: t.ctx.propertyIdA, minutos: 30 }, "PUT"));
    expect(fija.status).toBe(200);
    await t.tick();
    expect(t.emisiones).toHaveLength(0);
    // Con 5 minutos vuelve a vencer; si se captura a mano deja de avisar.
    await t.app.request(`${t.base}/umbral-captura-manual`, authedJson(t.ctx.staff.owner.token, { branchId: t.ctx.propertyIdA, minutos: 5 }, "PUT"));
    const otra = await t.sembrarCapturaManual(t.ctx.propertyIdB);
    await t.store.marcarCapturada(t.ctx.organizationId, otra.comandaId, "u-staff", null);
    await t.tick();
    expect(t.emisiones).toHaveLength(1);
    expect(t.emisiones[0]!.propertyId).toBe(t.ctx.propertyIdA);
  });

  it("si el productor de notificaciones falla (base sin migrar) el tick no revienta y cuenta el error", async () => {
    const t = await construir({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    await t.sembrarCapturaManual();
    const res = await t.tick();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { alertas: { errores: number; emitidas: number } }).alertas).toMatchObject({ emitidas: 0, errores: 1 });
  });

  it("sin la migracion 054 (store no disponible) el tick responde sin alertas y sin error", async () => {
    const t = await construir();
    t.store.disponible = false;
    const res = await t.tick();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { alertas: { disponible: boolean } }).alertas.disponible).toBe(false);
    expect(t.emisiones).toHaveLength(0);
  });
});

describe("PUT admin/softrestaurant/umbral-captura-manual", () => {
  it("owner y admin lo fijan, queda en la bitacora y GET config lo devuelve", async () => {
    const t = await construir();
    const res = await t.app.request(`${t.base}/umbral-captura-manual`, authedJson(t.ctx.staff.owner.token, { branchId: t.ctx.propertyIdA, minutos: 12 }, "PUT"));
    expect(res.status).toBe(200);
    const cfg = (await (await t.app.request(`${t.base}/config`, authedGet(t.ctx.staff.owner.token))).json()) as { umbralCapturaManual: { porOmisionMin: number; disponible: boolean; porSucursal: Record<string, number> } };
    expect(cfg.umbralCapturaManual).toMatchObject({ porOmisionMin: 5, disponible: true });
    expect(cfg.umbralCapturaManual.porSucursal[t.ctx.propertyIdA]).toBe(12);
    const auditoria = await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 50 });
    const fila = auditoria.items.find((a) => a.action === "softrestaurant.umbral_captura_manual");
    expect(fila).toMatchObject({ antes: "5", despues: "12" });
  });

  it("staff y repartidor 403; otra organizacion 403; minutos o sucursal invalidos 400; sin la migracion 503", async () => {
    const t = await construir();
    const put = (token: string, body: unknown) => t.app.request(`${t.base}/umbral-captura-manual`, authedJson(token, body, "PUT"));
    expect((await put(t.ctx.staff.staffSucursalA.token, { branchId: t.ctx.propertyIdA, minutos: 10 })).status).toBe(403);
    expect((await put(t.ctx.staff.repartidor.token, { branchId: t.ctx.propertyIdA, minutos: 10 })).status).toBe(403);
    expect((await put(t.ctx.staff.otroOrgOwner.token, { branchId: t.ctx.propertyIdA, minutos: 10 })).status).toBe(403);
    for (const body of [{ branchId: t.ctx.propertyIdA, minutos: 0 }, { branchId: t.ctx.propertyIdA, minutos: 241 }, { branchId: t.ctx.propertyIdA, minutos: 2.5 }, { branchId: "x", minutos: 10 }, { branchId: randomUUID(), minutos: 10 }]) {
      expect((await put(t.ctx.staff.owner.token, body)).status, JSON.stringify(body)).toBe(400);
    }
    t.store.disponible = false;
    expect((await put(t.ctx.staff.owner.token, { branchId: t.ctx.propertyIdA, minutos: 10 })).status).toBe(503);
  });
});

describe("GET admin/softrestaurant/estados (insignia de Pedidos)", () => {
  it("devuelve el estado de la comanda de cada pedido que tiene comanda y nada de otra organizacion", async () => {
    const t = await construir();
    const a = await t.sembrarCapturaManual();
    const sinComanda = randomUUID();
    const res = await t.app.request(`${t.base}/estados?orderIds=${a.orderId},${sinComanda}`, authedGet(t.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disponible: true, estados: { [a.orderId]: "captura_manual" } });
    const ajeno = await t.app.request(`${t.base}/estados?orderIds=${a.orderId}`, authedGet(t.ctx.staff.otroOrgOwner.token));
    expect([403, 404]).toContain(ajeno.status);
  });

  it("ids invalidos o mas de 100 -> 400; repartidor 403; sin ids -> vacio; sin la migracion disponible:false", async () => {
    const t = await construir();
    expect((await t.app.request(`${t.base}/estados?orderIds=no-es-uuid`, authedGet(t.ctx.staff.owner.token))).status).toBe(400);
    const muchos = Array.from({ length: 101 }, () => randomUUID()).join(",");
    expect((await t.app.request(`${t.base}/estados?orderIds=${muchos}`, authedGet(t.ctx.staff.owner.token))).status).toBe(400);
    expect((await t.app.request(`${t.base}/estados?orderIds=${randomUUID()}`, authedGet(t.ctx.staff.repartidor.token))).status).toBe(403);
    expect(await (await t.app.request(`${t.base}/estados`, authedGet(t.ctx.staff.owner.token))).json()).toEqual({ disponible: true, estados: {} });
    t.store.disponible = false;
    expect(await (await t.app.request(`${t.base}/estados?orderIds=${randomUUID()}`, authedGet(t.ctx.staff.owner.token))).json()).toEqual({ disponible: false, estados: {} });
  });
});

describe("GET admin/softrestaurant/comandas -- total del pedido", () => {
  it("cada comanda trae el total del pedido de Atiende (la comanda nunca cobra: solo informa a quien captura); sin pedido, null", async () => {
    const t = await construir();
    const con = await t.sembrarCapturaManual();
    const sin = await t.sembrarCapturaManual();
    t.ctx.restaurantesRepo.seedOrder({
      id: con.orderId, customerId: null, customerName: "Ana", customerPhone: "9991112222", customerAddress: null, customerEmail: null, branch: null, total: 345.5, status: "pending", items: [],
      source: "voice", notes: null, paymentMethod: null, callTranscript: null, callRecordingUrl: null, dedupeFingerprint: null, idempotencyKey: null, createdAt: new Date().toISOString(),
      assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null, organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA,
    } as never);
    const res = await t.app.request(`${t.base}/comandas`, authedGet(t.ctx.staff.owner.token));
    const cuerpo = (await res.json()) as { comandas: Array<{ orderId: string; totalPedido: number | null }> };
    expect(cuerpo.comandas.find((c) => c.orderId === con.orderId)!.totalPedido).toBe(345.5);
    expect(cuerpo.comandas.find((c) => c.orderId === sin.orderId)!.totalPedido).toBeNull();
  });
});
