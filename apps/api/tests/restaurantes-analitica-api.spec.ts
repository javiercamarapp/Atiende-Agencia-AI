// Analítica del dueño (F7): `GET /v1/restaurantes/:propertyId/admin/analitica/{demanda,zonas,productos,ratios}` y `PUT .../productos/:id/costo`.
// Roles por acción (cfo.ver: owner/admin), alcance por sucursal (mismo 403 para ajena/inexistente), validación 422 sin tocar la base, secciones que
// degradan (base sin migrar => disponible:false, nunca 500), errores SQL tipados, ETag y ausencia de PII. Repositorio en memoria con datos sintéticos.
import { describe, expect, it } from "vitest";
import { AnaliticaNoDisponibleError, InMemoryAnaliticaRepository, type DemandaCruda, type RatiosCrudo, type ZonaCruda, type ProductosCrudo } from "@atiende/domain-restaurantes/analitica";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const Q = "desde=2026-09-01&hasta=2026-09-27";
const PRODUCTO = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2f01";

function datos(A: string) {
  const demanda: DemandaCruda = {
    matriz: [
      { propertyId: A, dow: 5, hora: 13, canal: "domicilio", source: "whatsapp", pedidos: 10, netaCentavos: 300_000 },
      { propertyId: A, dow: 6, hora: 19, canal: "recoger", source: "voice", pedidos: 6, netaCentavos: 120_000 },
    ],
    semanas: [{ propertyId: A, semana: "2026-09-21", dias: 7, pedidos: 16, netaCentavos: 420_000 }],
    ticket: [{ propertyId: A, canal: "domicilio", pedidos: 10, netaCentavos: 300_000, medianaCentavos: 30_000, p90Centavos: 45_000 }],
    pago: [{ propertyId: A, formaPago: "efectivo", pedidos: 16, netaCentavos: 420_000 }],
    promesa: [{ propertyId: A, domicilios: 10, entregados: 8, conPromesa: 8, aTiempo: 6, sinPromesa: 0, sinCierre: 2, realMedianaMin: 41, prometidoMedianaMin: 45, desvioMedianaMin: -3 }],
    totales: [{ propertyId: A, pedidos: 16, netaCentavos: 420_000 }],
    diasConVenta: 12,
  };
  const zonas: ZonaCruda[] = [
    { propertyId: A, colonia: "Centro", pedidos: 8, domicilios: 8, recogidas: 0, netaCentavos: 240_000, clientes: 6, entregados: 7, sinCierre: 1, medianaMin: 38, p90Min: 61, masDe60: 1 },
    { propertyId: A, colonia: "sin colonia / recoge", pedidos: 8, domicilios: 2, recogidas: 6, netaCentavos: 180_000, clientes: 7, entregados: 1, sinCierre: 1, medianaMin: 44, p90Min: 44, masDe60: 0 },
  ];
  const productos: ProductosCrudo = {
    productos: [{ propertyId: A, productoRef: PRODUCTO, nombre: "Bistec", categoria: "Tacos", unidades: 30, ingresoCentavos: 150_000, pedidos: 20, costoUnitarioCentavos: null, margenCentavos: null }],
    pares: [{ propertyId: A, productoA: PRODUCTO, productoB: "x", nombreA: "Bistec", nombreB: "Frijoles", juntos: 9, pedidosA: 20, pedidosB: 12, pedidosTotal: 40, enMenu: false, promocionCodigo: null }],
    costosCargados: 0,
  };
  const fila = (propertyId: string | null) => ({
    propertyId, pedidos: 16, netaCentavos: 420_000, ticketCentavos: 26_250, clientes: 10, pedidosConCliente: 14, clientesNuevos: 4,
    recompra: { d14: { elegibles: 2, recompraron: 1 }, d30: { elegibles: 0, recompraron: 0 }, d60: { elegibles: 0, recompraron: 0 } },
    cancelados: 4, grandes: 1, convChats: 20, convConPedido: 10, convEscaladas: 5, vozLlamadas: 0, vozConPedido: 0, vozEscaladas: 0,
    respN: 10, respMedianaSeg: 30, respP90Seg: 200, respHasta5min: 9, respAgenteN: 9, respHumanoN: 1, conversacionesAgente: 20, costoTotalCentavos: 4_000, costoPorConversacionCentavos: 200,
  });
  const ratios: RatiosCrudo = { grandeCentavos: 400_000, filas: [fila(A), fila(null)] };
  return { demanda, zonas, productos, ratios };
}

async function construir(op: { sinMigrar?: boolean; vacio?: boolean; clase?: new (d: ConstructorParameters<typeof InMemoryAnaliticaRepository>[0]) => InMemoryAnaliticaRepository } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const A = ctx.propertyIdA;
  const Repo = op.clase ?? InMemoryAnaliticaRepository;
  const repo = new Repo(op.vacio ? {} : { ...datos(A), ...(op.sinMigrar ? { sinMigrar: true } : {}) });
  const deps: AppDeps = { ...ctx.deps, analiticaRestaurantesRepo: () => repo };
  const app = envolver(buildApp(deps));
  const url = (ruta: string, qs: string, propertyId = A) => `/v1/restaurantes/${propertyId}/admin/analitica/${ruta}?${qs}`;
  return { ctx, repo, app, url, A, B: ctx.propertyIdB };
}

const RUTAS = ["demanda", "zonas", "productos", "ratios"] as const;

describe("roles por acción y alcance", () => {
  it.each(RUTAS)("%s: owner y admin (también el acotado) ven 200; staff, repartidor y otra organización 403; sin sesión 401", async (ruta) => {
    const { ctx, app, url } = await construir();
    for (const [rol, token] of [["owner", ctx.staff.owner.token], ["admin", ctx.staff.admin.token], ["admin acotado", ctx.staff.adminSucursalA.token]] as const) {
      expect((await app.request(url(ruta, Q), authedGet(token))).status, rol).toBe(200);
    }
    for (const [rol, token] of [["staff", ctx.staff.staffSucursalA.token], ["repartidor", ctx.staff.repartidor.token], ["otra org", ctx.staff.otroOrgOwner.token]] as const) {
      expect((await app.request(url(ruta, Q), authedGet(token))).status, rol).toBe(403);
    }
    expect((await app.request(url(ruta, Q))).status).toBe(401);
  });

  it("un 403 de rol no consulta la base", async () => {
    const { ctx, app, url, repo } = await construir();
    for (const ruta of RUTAS) await app.request(url(ruta, Q), authedGet(ctx.staff.repartidor.token));
    expect(repo.llamadas).toHaveLength(0);
  });

  it("sucursal ajena, inexistente o de otra organización: el MISMO 403; el admin acotado solo ve la suya", async () => {
    const { ctx, app, url, A, B } = await construir();
    const tok = ctx.staff.adminSucursalA.token;
    const mia = await (await app.request(url("demanda", Q), authedGet(tok))).json();
    expect(mia.sucursales.map((s: { propertyId: string }) => s.propertyId)).toEqual([A]);
    const mensajes = new Set<string>();
    for (const id of [B, "00000000-0000-4000-8000-00000000ffff", ctx.otherPropertyId]) {
      const r = await app.request(url("demanda", `${Q}&sucursales=${id}`), authedGet(tok));
      expect(r.status, id).toBe(403);
      mensajes.add((await r.json()).message);
    }
    expect([...mensajes]).toEqual(["No tienes acceso a esta sucursal."]);
  });
});

describe("validación de query (422) sin consultar la base", () => {
  it.each([
    ["sin fechas", "demanda", ""],
    ["fecha inválida", "zonas", "desde=2026-02-30&hasta=2026-03-05"],
    ["invertido", "ratios", "desde=2026-09-27&hasta=2026-08-31"],
    ["401 días", "demanda", "desde=2026-01-01&hasta=2027-02-05"],
    ["límite 0", "productos", `${Q}&limite=0`],
    ["límite 201", "productos", `${Q}&limite=201`],
    ["id de sucursal", "zonas", `${Q}&sucursales=hola`],
  ])("%s -> 422", async (_n, ruta, qs) => {
    const { ctx, app, url, repo } = await construir();
    const r = await app.request(url(ruta, qs), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("validation_error");
    expect(repo.llamadas).toHaveLength(0);
  });
});

describe("contenido", () => {
  it("demanda: matriz, picos calculados, vie–dom y promesa", async () => {
    const { ctx, app, url, A } = await construir();
    const j = await (await app.request(url("demanda", Q), authedGet(ctx.staff.owner.token))).json();
    expect(j.disponible).toBe(true);
    const s = j.demanda.sucursales.find((x: { propertyId: string | null }) => x.propertyId === A);
    expect(s.picos.map((p: { hora: number }) => p.hora)).toEqual([13, 19]);
    expect(s.vieDom.pctPedidos).toBe(100);
    expect(j.demanda.promesa[0]).toMatchObject({ aTiempoPct: 75, sinCierre: 2 });
    expect(j.demanda.pocoHistorial).toBe(true);
  });
  it("zonas: «sin colonia / recoge» presente y k = 5", async () => {
    const { ctx, app, url } = await construir();
    const j = await (await app.request(url("zonas", Q), authedGet(ctx.staff.owner.token))).json();
    expect(j.k).toBe(5);
    expect(j.zonas.map((z: { colonia: string }) => z.colonia)).toContain("sin colonia / recoge");
  });
  it("productos: sin costo no hay margen; el par sin promoción es oportunidad", async () => {
    const { ctx, app, url } = await construir();
    const j = await (await app.request(url("productos", Q), authedGet(ctx.staff.owner.token))).json();
    expect(j.productos.margenDisponible).toBe(false);
    expect(j.productos.productos[0]).toMatchObject({ sinCosto: true, margenPct: null });
    expect(j.productos.oportunidades).toHaveLength(1);
  });
  it("ratios: razones calculadas y definiciones incluidas", async () => {
    const { ctx, app, url } = await construir();
    const j = await (await app.request(url("ratios", Q), authedGet(ctx.staff.owner.token))).json();
    const total = j.filas.find((f: { propertyId: string | null }) => f.propertyId === null);
    expect(total).toMatchObject({ tasaCancelacionPct: 20, conversionChatPedidoPct: 50, resueltoPorAgentePct: 75, escaladoPct: 25, respondidoEn5minPct: 90 });
    expect(total.recompra14.pct).toBe(50);
    expect(total.recompra30.pct).toBeNull();
    expect(j.definiciones.length).toBeGreaterThanOrEqual(12);
  });
  it("sin PII en ninguna respuesta", async () => {
    const { ctx, app, url } = await construir();
    for (const ruta of RUTAS) {
      const t = JSON.stringify(await (await app.request(url(ruta, Q), authedGet(ctx.staff.owner.token))).json());
      expect(t, ruta).not.toMatch(/telefono|phone|customer_?id|direccion|address|\+52|@/i);
    }
  });
  it("ETag: la segunda lectura con If-None-Match es 304", async () => {
    const { ctx, app, url } = await construir();
    const r1 = await app.request(url("ratios", Q), authedGet(ctx.staff.owner.token));
    const etag = r1.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    const r2 = await app.request(url("ratios", Q), { method: "GET", headers: { authorization: `Bearer ${ctx.staff.owner.token}`, "if-none-match": etag } });
    expect(r2.status).toBe(304);
  });
});

describe("estados honestos", () => {
  it.each(RUTAS)("%s con la base sin migrar: 200 con disponible:false (nunca 500)", async (ruta) => {
    const { ctx, app, url } = await construir({ sinMigrar: true });
    const r = await app.request(url(ruta, Q), authedGet(ctx.staff.owner.token));
    expect(r.status).toBe(200);
    expect((await r.json()).disponible).toBe(false);
  });
  it("sin el repositorio cableado: 503", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = envolver(buildApp({ ...ctx.deps }));
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/analitica/demanda?${Q}`, authedGet(ctx.staff.owner.token))).status).toBe(503);
  });
  it("errores SQL tipados: 22023 -> 400, 42501 -> 403", async () => {
    const { AnaliticaParametroInvalidoError, AnaliticaSinAccesoError } = await import("@atiende/domain-restaurantes/analitica");
    class Falla extends InMemoryAnaliticaRepository {
      constructor(private readonly e: Error) { super({}); }
      override demanda(): never { throw this.e; }
    }
    for (const [err, status] of [[new AnaliticaParametroInvalidoError("x"), 400], [new AnaliticaSinAccesoError(), 403]] as const) {
      const ctx = await buildRestaurantesKpiTestContext(buildApp);
      const app = envolver(buildApp({ ...ctx.deps, analiticaRestaurantesRepo: () => new Falla(err) }));
      expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/analitica/demanda?${Q}`, authedGet(ctx.staff.owner.token))).status).toBe(status);
    }
  });
});

describe("costo por producto (PUT)", () => {
  const ruta = (A: string, id = PRODUCTO) => `/v1/restaurantes/${A}/admin/analitica/productos/${id}/costo`;
  it("owner guarda y borra; el repositorio recibe el costo redondeado a centavos", async () => {
    const { ctx, app, repo, A } = await construir();
    const r = await app.request(ruta(A), authedJson(ctx.staff.owner.token, { costo: 12.345 }, "PUT"));
    expect(r.status).toBe(200);
    expect([...repo.costos.values()]).toEqual([12.35]);
    expect((await app.request(ruta(A), authedJson(ctx.staff.owner.token, { costo: null }, "PUT"))).status).toBe(200);
    expect(repo.costos.size).toBe(0);
  });
  it("staff y repartidor 403; admin acotado a sucursales 403 (el costo es de la organización); sin tocar la base", async () => {
    const { ctx, app, repo, A } = await construir();
    for (const t of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.adminSucursalA.token]) {
      expect((await app.request(ruta(A), authedJson(t, { costo: 5 }, "PUT"))).status).toBe(403);
    }
    expect(repo.costos.size).toBe(0);
  });
  it.each([["negativo", { costo: -1 }], ["texto", { costo: "5" }], ["enorme", { costo: 100001 }], ["sin costo", {}]])("cuerpo inválido (%s) -> 422", async (_n, cuerpo) => {
    const { ctx, app, repo, A } = await construir();
    expect((await app.request(ruta(A), authedJson(ctx.staff.owner.token, cuerpo, "PUT"))).status).toBe(422);
    expect(repo.llamadas).not.toContain("guardarCostoProducto");
  });
  it("id de producto inválido -> 422; base sin migrar -> 503", async () => {
    const { ctx, app, A } = await construir();
    expect((await app.request(ruta(A, "no-es-uuid"), authedJson(ctx.staff.owner.token, { costo: 5 }, "PUT"))).status).toBe(422);
    const sm = await construir({ sinMigrar: true });
    expect((await sm.app.request(ruta(sm.A), authedJson(sm.ctx.staff.owner.token, { costo: 5 }, "PUT"))).status).toBe(503);
    expect(new AnaliticaNoDisponibleError().name).toBe("AnaliticaNoDisponibleError");
  });
});
