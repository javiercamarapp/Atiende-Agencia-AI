// SoftRestaurant (POS de PM): enganche del pedido, rutas de staff y dispatcher del outbox.
// HTTP real (app.request) sobre repos en memoria. Las propiedades de SQL (RLS/GRANT) las
// cubre scripts/verify-restaurantes-softrestaurant-outbox/ contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import {
  FakeSoftRestaurantAdapter,
  InMemoryComandaOutboxStore,
  MapaProductoCodigo,
  crearResolverSucursalPos,
  type SoftRestaurantPort,
} from "@atiende/domain-restaurantes/softrestaurant";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

/** El falso se declara "real" SOLO en pruebas, para poder prender la bandera. */
function falsoComoReal(fake: FakeSoftRestaurantAdapter): SoftRestaurantPort {
  return new Proxy(fake, { get: (t, p, r) => (p === "esReal" ? true : Reflect.get(t, p, r)) }) as unknown as SoftRestaurantPort;
}

const PAYLOAD = {
  idempotencyKey: "k",
  sucursal: "T1",
  tipo: "recoger",
  cliente: { nombre: "Ana", telefono: "9991112222" },
  formaPago: "efectivo",
  items: [{ codigo: "FAKE-003", cantidad: 1, modificadores: [], nombre: "Refresco" }],
} as const;

describe("POST /v1/restaurantes/:orgSlug/orders con SoftRestaurant", () => {
  async function setup(modo: "apagado" | "sombra" | "activo") {
    const base = await buildTestDeps();
    const store = new InMemoryComandaOutboxStore();
    store.ponerModo(base.organizationId, modo);
    const fake = new FakeSoftRestaurantAdapter();
    const deps: AppDeps = {
      ...base.deps,
      softRestaurantStore: () => store,
      softRestaurantPort: falsoComoReal(fake),
      softRestaurantMapeo: {
        resolverCodigos: new MapaProductoCodigo([{ productId: base.products.cocaCola!, codigo: "FAKE-003" }]),
        resolverSucursal: crearResolverSucursalPos({ [base.propertyId]: "T2" }),
      },
    };
    const app = buildApp(deps);
    const crear = () =>
      app.request(
        "/v1/restaurantes/los-taquitos-de-pm/orders",
        jsonRequestInit({
          branch_slug: "fco-montejo",
          customer_name: "Cliente Web",
          customer_phone: "9991234567",
          customer_address: "Calle 10 x 5 y 7",
          items: [{ product_id: base.products.cocaCola, requested_quantity: 2 }],
          source: "voice",
          payment_method: "efectivo",
        }, { "x-atiende-tool-secret": "test-voice-tool-secret" }),
      );
    return { base, store, fake, crear };
  }

  it("bandera APAGADA (default): la respuesta es EXACTAMENTE la de antes y no hay filas ni llamadas al POS", async () => {
    const t = await setup("apagado");
    const res = await t.crear();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["order"]);
    expect(t.store.todas()).toHaveLength(0);
    expect(t.fake.llamadasCrear).toHaveLength(0);
  });

  it("sin store inyectado (produccion sin migrar) el pedido se crea igual, sin comanda", async () => {
    const base = await buildTestDeps();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await buildApp(base.deps).request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "C", customer_phone: "9991234567", canal: "recoger", payment_method: "efectivo", items: [{ product_id: base.products.cocaCola, requested_quantity: 1 }], source: "voice" }, { "x-atiende-tool-secret": "test-voice-tool-secret" }),
    );
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).toEqual(["order"]);
  });

  it("modo ACTIVO con el POS arriba: el pedido trae la comanda confirmada con el folio del POS", async () => {
    const t = await setup("activo");
    const res = await t.crear();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { id: string }; comanda: { estado: string; folio: string } };
    expect(body.comanda.estado).toBe("confirmada");
    expect(body.comanda.folio).toBe(t.fake.comandas[0]!.folio);
    expect(t.fake.llamadasCrear[0]).toMatchObject({ sucursal: "T2", tipo: "domicilio" });
  });

  it("modo ACTIVO con el POS caido: el pedido se crea (200) y el agente recibe 'pendiente de confirmar' SIN folio", async () => {
    const t = await setup("activo");
    t.fake.inyectarFalla("crearComanda", { tipo: "timeout" });
    const res = await t.crear();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { id: string }; comanda: { estado: string; folio: string | null; mensaje: string } };
    expect(body.order.id).toBeTruthy();
    expect(body.comanda).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
    expect(body.comanda.mensaje).not.toMatch(/folio/i);
    expect(t.store.todas()[0]).toMatchObject({ estado: "fallida", folio: null });
  });

  it("modo SOMBRA: encola en paralelo sin tocar la respuesta ni llamar al POS en linea", async () => {
    const t = await setup("sombra");
    const res = await t.crear();
    expect(Object.keys((await res.json()) as object)).toEqual(["order"]);
    expect(t.store.todas()).toHaveLength(1);
    expect(t.store.todas()[0]!.estado).toBe("pendiente");
    expect(t.fake.llamadasCrear).toHaveLength(0);
  });
});

describe("rutas de staff de SoftRestaurant", () => {
  async function setup(opciones: { real?: boolean } = {}) {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const store = new InMemoryComandaOutboxStore();
    const fake = new FakeSoftRestaurantAdapter();
    const deps: AppDeps = { ...ctx.deps, softRestaurantStore: () => store, softRestaurantPort: opciones.real ? falsoComoReal(fake) : fake };
    const app = buildApp(deps);
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/softrestaurant`;
    async function sembrar(propertyId: string, organizationId = ctx.organizationId, estado: "captura_manual" | "fallida" | "pendiente" | "confirmada" = "captura_manual") {
      const orderId = randomUUID();
      const r = await store.encolar({ organizationId, propertyId, orderId, idempotencyKey: `k-${orderId}`, modo: "activo", payload: { ...PAYLOAD }, maxIntentos: 5 });
      if (!r.disponible) throw new Error("store no disponible");
      store.ponerModo(organizationId, "activo");
      if (estado !== "pendiente") {
        await store.reclamarPorId(r.fila.id, new Date(), 1000);
        await store.completar(
          r.fila.id,
          estado === "confirmada"
            ? { estado: "confirmada", folio: "T1-000001", ultimoError: null, proximoIntentoEn: null, alertarCapturaManual: false }
            : estado === "fallida"
              ? { estado: "fallida", folio: null, ultimoError: "no_disponible:timeout", proximoIntentoEn: new Date(Date.now() + 60_000), alertarCapturaManual: false }
              : { estado: "captura_manual", folio: null, ultimoError: "no_disponible:timeout:intentos_agotados", proximoIntentoEn: null, alertarCapturaManual: true },
        );
      }
      return store.fila(r.fila.id)!;
    }
    return { ctx, store, fake, app, base, sembrar };
  }

  it("GET config: cualquier MANAGER_ROLES ve el modo (default apagado) y el adaptador; repartidor 403; sin token 401", async () => {
    const t = await setup();
    const res = await t.app.request(`${t.base}/config`, authedGet(t.ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      modo: "apagado",
      disponible: true,
      adaptador: { nombre: "fake", esReal: false },
      umbralCapturaManual: { porOmisionMin: 5, minimo: 1, maximo: 240, disponible: true, porSucursal: {} },
    });
    expect((await t.app.request(`${t.base}/config`, authedGet(t.ctx.staff.repartidor.token))).status).toBe(403);
    expect((await t.app.request(`${t.base}/config`)).status).toBe(401);
  });

  it("PUT config: con el adaptador NO real, prender la bandera es 409 y no se mueve; apagar si se puede", async () => {
    const t = await setup({ real: false });
    const res = await t.app.request(`${t.base}/config`, authedJson(t.ctx.staff.owner.token, { modo: "activo" }, "PUT"));
    expect(res.status).toBe(409);
    expect(await t.store.leerModo(t.ctx.organizationId)).toBe("apagado");
    const off = await t.app.request(`${t.base}/config`, authedJson(t.ctx.staff.owner.token, { modo: "apagado" }, "PUT"));
    expect(off.status).toBe(200);
  });

  it("PUT config con adaptador real: owner/admin cambian el modo y queda en la bitacora; staff/repartidor 403; modo invalido 400", async () => {
    const t = await setup({ real: true });
    const antes = t.ctx.restaurantesRepo.auditLog.length;
    const res = await t.app.request(`${t.base}/config`, authedJson(t.ctx.staff.admin.token, { modo: "sombra" }, "PUT"));
    expect(res.status).toBe(200);
    expect(await t.store.leerModo(t.ctx.organizationId)).toBe("sombra");
    expect(t.ctx.restaurantesRepo.auditLog.slice(antes)).toEqual([
      expect.objectContaining({ entityType: "configuracion", action: "softrestaurant.modo_cambiado", actorUserId: t.ctx.staff.admin.id, antes: "apagado", despues: "sombra" }),
    ]);
    expect((await t.app.request(`${t.base}/config`, authedJson(t.ctx.staff.staffSucursalA.token, { modo: "activo" }, "PUT"))).status).toBe(403);
    expect((await t.app.request(`${t.base}/config`, authedJson(t.ctx.staff.repartidor.token, { modo: "activo" }, "PUT"))).status).toBe(403);
    expect((await t.app.request(`${t.base}/config`, authedJson(t.ctx.staff.owner.token, { modo: "loco" }, "PUT"))).status).toBe(400);
  });

  it("PUT config sin la migracion 024 => 503 claro (no 500)", async () => {
    const t = await setup({ real: true });
    t.store.disponible = false;
    const res = await t.app.request(`${t.base}/config`, authedJson(t.ctx.staff.owner.token, { modo: "sombra" }, "PUT"));
    expect(res.status).toBe(503);
  });

  it("GET comandas: por defecto lista las que requieren atencion o estan en camino, con la comanda para captura manual", async () => {
    const t = await setup();
    await t.sembrar(t.ctx.propertyIdA, t.ctx.organizationId, "captura_manual");
    await t.sembrar(t.ctx.propertyIdA, t.ctx.organizationId, "fallida");
    await t.sembrar(t.ctx.propertyIdA, t.ctx.organizationId, "confirmada");
    const res = await t.app.request(`${t.base}/comandas`, authedGet(t.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; comandas: Array<{ estado: string; comanda: { items: unknown[] } }>; requierenAtencion: number; resumen: Record<string, number> };
    expect(body.disponible).toBe(true);
    expect(body.comandas.map((c) => c.estado).sort()).toEqual(["captura_manual", "fallida"]);
    expect(body.comandas[0]!.comanda.items).toHaveLength(1);
    expect(body.requierenAtencion).toBe(2);
    expect(body.resumen.confirmada).toBe(1);
    const soloConfirmadas = await t.app.request(`${t.base}/comandas?estado=confirmada`, authedGet(t.ctx.staff.owner.token));
    expect(((await soloConfirmadas.json()) as { comandas: unknown[] }).comandas).toHaveLength(1);
  });

  it("GET comandas: alcance por sucursal (staff de A no ve B), cross-tenant vacio, repartidor 403, filtros invalidos 400", async () => {
    const t = await setup();
    await t.sembrar(t.ctx.propertyIdA);
    await t.sembrar(t.ctx.propertyIdB);
    const deA = await t.app.request(`${t.base}/comandas`, authedGet(t.ctx.staff.staffSucursalA.token));
    const comandasA = ((await deA.json()) as { comandas: Array<{ propertyId: string }> }).comandas;
    expect(comandasA).toHaveLength(1);
    expect(comandasA[0]!.propertyId).toBe(t.ctx.propertyIdA);
    const todas = await t.app.request(`${t.base}/comandas`, authedGet(t.ctx.staff.owner.token));
    expect(((await todas.json()) as { comandas: unknown[] }).comandas).toHaveLength(2);
    const otro = await t.app.request(`${t.base}/comandas`, authedGet(t.ctx.staff.otroOrgOwner.token));
    expect(otro.status).toBe(403);
    expect((await t.app.request(`${t.base}/comandas`, authedGet(t.ctx.staff.repartidor.token))).status).toBe(403);
    expect((await t.app.request(`${t.base}/comandas?estado=inventado`, authedGet(t.ctx.staff.owner.token))).status).toBe(400);
    expect((await t.app.request(`${t.base}/comandas?limit=0`, authedGet(t.ctx.staff.owner.token))).status).toBe(400);
  });

  it("GET comandas sin la migracion 024: disponible:false y lista vacia (nunca 500)", async () => {
    const t = await setup();
    t.store.disponible = false;
    const res = await t.app.request(`${t.base}/comandas`, authedGet(t.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; comandas: unknown[] };
    expect(body).toMatchObject({ disponible: false, comandas: [] });
  });

  it("POST capturada: marca la comanda capturada a mano, registra la bitacora y corta los reintentos", async () => {
    const t = await setup();
    const fila = await t.sembrar(t.ctx.propertyIdA, t.ctx.organizationId, "fallida");
    const antes = t.ctx.restaurantesRepo.auditLog.length;
    const res = await t.app.request(`${t.base}/comandas/${fila.id}/capturada`, authedJson(t.ctx.staff.staffSucursalA.token, { nota: "capturada en caja 2" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comanda: { estado: string; capturadoPor: string; notaCaptura: string } };
    expect(body.comanda).toMatchObject({ estado: "capturada_manual", capturadoPor: t.ctx.staff.staffSucursalA.id, notaCaptura: "capturada en caja 2" });
    expect(t.ctx.restaurantesRepo.auditLog.slice(antes)).toEqual([
      expect.objectContaining({ entityType: "pedido", action: "comanda.captura_manual", entityId: fila.orderId, antes: "fallida", despues: "capturada_manual: capturada en caja 2" }),
    ]);
    // ya no es reclamable: cero duplicados automaticos
    expect(await t.store.reclamarLote(10, new Date(Date.now() + 3_600_000), 1000)).toEqual([]);
    // segunda vez: estado terminal => 409
    const otra = await t.app.request(`${t.base}/comandas/${fila.id}/capturada`, authedJson(t.ctx.staff.owner.token, {}));
    expect(otra.status).toBe(409);
  });

  it("POST capturada: no se puede sobre una comanda confirmada (409), ni inexistente (404), ni con id invalido (400)", async () => {
    const t = await setup();
    const confirmada = await t.sembrar(t.ctx.propertyIdA, t.ctx.organizationId, "confirmada");
    expect((await t.app.request(`${t.base}/comandas/${confirmada.id}/capturada`, authedJson(t.ctx.staff.owner.token, {}))).status).toBe(409);
    expect((await t.app.request(`${t.base}/comandas/${randomUUID()}/capturada`, authedJson(t.ctx.staff.owner.token, {}))).status).toBe(404);
    expect((await t.app.request(`${t.base}/comandas/no-es-uuid/capturada`, authedJson(t.ctx.staff.owner.token, {}))).status).toBe(400);
    expect((await t.app.request(`${t.base}/comandas/${confirmada.id}/capturada`, authedJson(t.ctx.staff.owner.token, { nota: "x".repeat(301) }))).status).toBe(400);
  });

  it("POST capturada: roles y alcance -- repartidor 403, staff de A sobre comanda de B 403, otra organizacion 403/404", async () => {
    const t = await setup();
    const deB = await t.sembrar(t.ctx.propertyIdB);
    const deA = await t.sembrar(t.ctx.propertyIdA);
    expect((await t.app.request(`${t.base}/comandas/${deA.id}/capturada`, authedJson(t.ctx.staff.repartidor.token, {}))).status).toBe(403);
    expect((await t.app.request(`${t.base}/comandas/${deB.id}/capturada`, authedJson(t.ctx.staff.staffSucursalA.token, {}))).status).toBe(403);
    expect(t.store.fila(deB.id)!.estado).toBe("captura_manual");
    const ajena = await t.app.request(`${t.base}/comandas/${deA.id}/capturada`, authedJson(t.ctx.staff.otroOrgOwner.token, {}));
    expect([403, 404]).toContain(ajena.status);
    expect(t.store.fila(deA.id)!.estado).toBe("captura_manual");
  });
});

describe("GET/POST /internal/restaurantes/softrestaurant-dispatch", () => {
  async function setup(real: boolean) {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const store = new InMemoryComandaOutboxStore();
    const fake = new FakeSoftRestaurantAdapter();
    const deps: AppDeps = {
      ...ctx.deps,
      softRestaurantStore: () => store,
      softRestaurantPort: real ? falsoComoReal(fake) : fake,
      softRestaurantMapeo: { resolverCodigos: new MapaProductoCodigo(), resolverSucursal: crearResolverSucursalPos() },
    };
    return { ctx, store, fake, app: buildApp(deps), headers: { "x-atiende-internal-secret": deps.env.internalSecret } };
  }

  it("401 sin secreto", async () => {
    const t = await setup(true);
    expect((await t.app.request("/internal/restaurantes/softrestaurant-dispatch", { method: "POST" })).status).toBe(401);
  });

  it("fail-closed: sin adaptador real responde 503 y NO reclama nada", async () => {
    const t = await setup(false);
    store_sembrar(t);
    const res = await t.app.request("/internal/restaurantes/softrestaurant-dispatch", { method: "POST", headers: t.headers });
    expect(res.status).toBe(503);
    expect(t.store.todas()[0]!.estado).toBe("pendiente");
    expect(t.store.todas()[0]!.intentos).toBe(0);
  });

  it("con adaptador real drena el lote: la comanda sin codigo POS va a captura manual y se alerta al staff", async () => {
    const t = await setup(true);
    store_sembrar(t);
    const res = await t.app.request("/internal/restaurantes/softrestaurant-dispatch", { method: "POST", headers: t.headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; resumen: { reclamadas: number; capturaManual: number } };
    expect(body.resumen).toMatchObject({ reclamadas: 1, capturaManual: 1 });
    expect(t.store.todas()[0]).toMatchObject({ estado: "captura_manual", ultimoError: "rechazada:producto_sin_codigo_pos" });
    const avisos = await t.ctx.restaurantesRepo.listStaffOrderNotifications(t.ctx.organizationId, null, {});
    expect(avisos.filter((n) => n.eventType === "order.problema" && n.message.includes("captura manual requerida"))).toHaveLength(1);
  });
});

function store_sembrar(t: { ctx: { organizationId: string; propertyIdA: string }; store: InMemoryComandaOutboxStore }): void {
  t.store.ponerModo(t.ctx.organizationId, "activo");
  void t.store.encolar({
    organizationId: t.ctx.organizationId,
    propertyId: t.ctx.propertyIdA,
    orderId: randomUUID(),
    idempotencyKey: "k",
    modo: "activo",
    payload: { ...PAYLOAD, items: [{ codigo: "", cantidad: 1, modificadores: [], nombre: "Refresco" }] },
    maxIntentos: 5,
  });
}
