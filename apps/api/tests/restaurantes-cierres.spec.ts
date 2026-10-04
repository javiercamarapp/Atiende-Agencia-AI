// R-42 (migración 041): cierre del día y resumen semanal. Cada caso afirma el EFECTO (qué quedó generado, qué NO se creó dos veces, qué
// se rechazó), no solo el status. Los agregados los calcula SQL (scripts/verify-restaurantes-cierre-dia); aquí se prueba el contrato HTTP,
// la idempotencia, las validaciones de periodo, los roles, la base sin migrar y el barrido interno con su aislamiento por sucursal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATOS_VACIOS, InMemoryCierreRepository } from "@atiende/domain-restaurantes";
import type { CierreDatos, CierreRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { periodosPendientes } from "../src/routes/verticals/restaurantes/cierres.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

afterEach(() => vi.useRealTimers());
// Hoy local (Mexico, UTC-6) = 2026-03-10; ayer = 2026-03-09 (lunes). La semana 2026-03-02..08 ya termino.
function hoyFijo(iso = "2026-03-10T18:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

const CON_VENTAS: CierreDatos = {
  ...DATOS_VACIOS,
  pedidos: 5,
  ventasCentavos: 38575,
  ticketPromedioCentavos: 7715,
  cancelados: 1,
  canceladosCentavos: 8000,
  cancelacionPct: 16.7,
  comparativo: { fechaInicio: "2026-03-02", fechaFin: "2026-03-02", pedidos: 2, ventasCentavos: 20000 },
};

async function construir(opts: { sinRepo?: boolean; repo?: CierreRepository; zona?: string | null } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  if (opts.zona !== undefined) await ctx.restaurantesRepo.upsertBranchZonaHoraria(ctx.propertyIdA, opts.zona);
  const repo =
    opts.repo ??
    new InMemoryCierreRepository({
      calcular: () => CON_VENTAS,
      sucursales: [{ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, zonaHoraria: "America/Mexico_City" }],
    });
  const deps: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { cierreRepo: () => repo }) };
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/cierres`;
  return { ctx, repo: repo as InMemoryCierreRepository, deps, app: envolver(buildApp(deps)), base };
}

describe("periodosPendientes (puro)", () => {
  it("dias: ayer hacia atras sin los ya generados; hoy nunca", () => {
    expect(periodosPendientes("dia", "2026-03-10", new Set(["2026-03-08"]), 3)).toEqual(["2026-03-09", "2026-03-07"]);
  });
  it("semanas: la semana en curso no se ofrece; la ultima terminada es la del lunes anterior", () => {
    expect(periodosPendientes("semana", "2026-03-10", new Set(), 2)).toEqual(["2026-03-02", "2026-02-23"]);
    expect(periodosPendientes("semana", "2026-03-15", new Set(), 1)).toEqual(["2026-03-02"]); // domingo: la semana 9..15 aun no termina
    expect(periodosPendientes("semana", "2026-03-16", new Set(["2026-03-09"]), 2)).toEqual(["2026-03-02"]);
  });
});

describe("GET .../admin/cierres", () => {
  it("sin cierres: lista vacia y los 7 dias terminados ofrecidos como pendientes (hoy no)", async () => {
    hoyFijo();
    const { ctx, app, base } = await construir();
    const res = await app.request(base, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ disponible: true, tipo: "dia", hoy: "2026-03-10", zonaHoraria: "America/Mexico_City", cierres: [] });
    expect(r.pendientes).toEqual(["2026-03-09", "2026-03-08", "2026-03-07", "2026-03-06", "2026-03-05", "2026-03-04", "2026-03-03"]);
  });

  it("tipo=semana ofrece la semana terminada y valida el tipo", async () => {
    hoyFijo();
    const { ctx, app, base } = await construir();
    const r = await (await app.request(`${base}?tipo=semana`, authedGet(ctx.staff.owner.token))).json();
    expect(r.pendientes[0]).toBe("2026-03-02");
    expect((await app.request(`${base}?tipo=mes`, authedGet(ctx.staff.owner.token))).status).toBe(400);
  });

  it.each([["limite=0"], ["limite=61"], ["limite=abc"], ["limite=-1"]])("limite invalido (%s) -> 400", async (qs) => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base}?${qs}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
  });

  it("el dia de hoy usa la zona de la sucursal (05:30Z del 11: sigue siendo el 10 en Mexico y ya es el 11 en Auckland)", async () => {
    hoyFijo("2026-03-11T05:30:00Z");
    const mx = await construir();
    expect((await (await mx.app.request(mx.base, authedGet(mx.ctx.staff.owner.token))).json()).hoy).toBe("2026-03-10");
    const nz = await construir({ zona: "Pacific/Auckland" });
    expect(await (await nz.app.request(nz.base, authedGet(nz.ctx.staff.owner.token))).json()).toMatchObject({ hoy: "2026-03-11", zonaHoraria: "Pacific/Auckland" });
  });

  it("roles: staff, repartidor y owner de otra organizacion -> 403; sin sesion -> 401; sucursal ajena no consulta nada", async () => {
    const { ctx, app, base } = await construir();
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(base, authedGet(token))).status).toBe(403);
    }
    expect((await app.request(base)).status).toBe(401);
    const ajena = await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/cierres`, authedGet(ctx.staff.owner.token));
    expect([403, 404]).toContain(ajena.status);
  });

  it("base SIN migrar: 200 con disponible=false, listas vacias y SIN ofrecer generar; nunca 500", async () => {
    const { ctx, app, base } = await construir({ repo: new InMemoryCierreRepository({ disponible: false }) });
    const res = await app.request(base, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, cierres: [], pendientes: [] });
  });

  it("despliegue sin cierreRepo: 503 honesto", async () => {
    const { ctx, app, base } = await construir({ sinRepo: true });
    expect((await app.request(base, authedGet(ctx.staff.owner.token))).status).toBe(503);
  });
});

describe("POST .../admin/cierres/generar", () => {
  const post = (token: string, body: unknown) => authedJson(token, body, "POST");

  it("genera el cierre de ayer: 201, sin PII, con variacion contra el comparativo; despues aparece en la lista y deja de ser pendiente", async () => {
    hoyFijo();
    const { ctx, app, base } = await construir();
    const res = await app.request(`${base}/generar`, post(ctx.staff.owner.token, { tipo: "dia", fecha: "2026-03-09" }));
    expect(res.status).toBe(201);
    const texto = await res.text();
    const r = JSON.parse(texto);
    expect(r.estado).toBe("creado");
    expect(r.cierre).toMatchObject({ tipo: "dia", fechaInicio: "2026-03-09", fechaFin: "2026-03-09", pedidos: 5, ventasCentavos: 38575, ticketPromedioCentavos: 7715, cancelados: 1 });
    expect(r.cierre.comparativo).toMatchObject({ pedidos: 2, variacionPedidosPct: 150, variacionVentasPct: 92.9 });
    expect(texto).not.toMatch(/phone|telefono|customer|nombre/i);
    const lista = await (await app.request(base, authedGet(ctx.staff.owner.token))).json();
    expect(lista.cierres.map((c: { fechaInicio: string }) => c.fechaInicio)).toEqual(["2026-03-09"]);
    expect(lista.pendientes).not.toContain("2026-03-09");
  });

  it("idempotente por fecha de negocio: repetir devuelve el MISMO cierre (200, existente) y no crea otro", async () => {
    hoyFijo();
    const { ctx, repo, app, base } = await construir();
    const a = await (await app.request(`${base}/generar`, post(ctx.staff.owner.token, { tipo: "dia", fecha: "2026-03-09" }))).json();
    const res2 = await app.request(`${base}/generar`, post(ctx.staff.owner.token, { tipo: "dia", fecha: "2026-03-09" }));
    expect(res2.status).toBe(200);
    const b = await res2.json();
    expect(b.estado).toBe("existente");
    expect(b.cierre.id).toBe(a.cierre.id);
    expect((await repo.listar(ctx.organizationId, ctx.propertyIdA, "dia", 10)).valor).toHaveLength(1);
  });

  it("resumen semanal: genera de lunes a domingo", async () => {
    hoyFijo();
    const { ctx, app, base } = await construir();
    const res = await app.request(`${base}/generar`, post(ctx.staff.owner.token, { tipo: "semana", fecha: "2026-03-02" }));
    expect(res.status).toBe(201);
    expect((await res.json()).cierre).toMatchObject({ tipo: "semana", fechaInicio: "2026-03-02", fechaFin: "2026-03-08" });
  });

  it.each([
    ["hoy (el dia sigue abierto)", { tipo: "dia", fecha: "2026-03-10" }],
    ["fecha futura", { tipo: "dia", fecha: "2026-03-20" }],
    ["fecha inexistente", { tipo: "dia", fecha: "2026-02-30" }],
    ["formato invalido", { tipo: "dia", fecha: "10/03/2026" }],
    ["sin fecha", { tipo: "dia" }],
    ["tipo invalido", { tipo: "mes", fecha: "2026-03-09" }],
    ["semana que no empieza en lunes", { tipo: "semana", fecha: "2026-03-03" }],
    ["semana en curso (termina el 15)", { tipo: "semana", fecha: "2026-03-09" }],
  ])("rechaza %s con 400 y no crea nada", async (_n, body) => {
    hoyFijo();
    const { ctx, repo, app, base } = await construir();
    const res = await app.request(`${base}/generar`, post(ctx.staff.owner.token, body));
    expect(res.status).toBe(400);
    expect(repo.generaciones).toBe(0);
  });

  it("roles: staff, repartidor y owner ajeno -> 403 y no se genera nada; sin sesion -> 401", async () => {
    hoyFijo();
    const { ctx, repo, app, base } = await construir();
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(`${base}/generar`, post(token, { tipo: "dia", fecha: "2026-03-09" }))).status).toBe(403);
    }
    expect((await app.request(`${base}/generar`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(repo.generaciones).toBe(0);
  });

  it("base SIN migrar: 503 honesto, no 500", async () => {
    hoyFijo();
    const { ctx, app, base } = await construir({ repo: new InMemoryCierreRepository({ disponible: false }) });
    expect((await app.request(`${base}/generar`, post(ctx.staff.owner.token, { tipo: "dia", fecha: "2026-03-09" }))).status).toBe(503);
  });

  it("deja rastro en la bitacora de auditoria (accion, sucursal y fecha, sin cifras)", async () => {
    hoyFijo();
    const { ctx, app, base } = await construir();
    await app.request(`${base}/generar`, post(ctx.staff.owner.token, { tipo: "dia", fecha: "2026-03-09" }));
    const pagina = await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 10 } as never);
    const fila = pagina.items.find((i) => i.action === "cierre.dia_generado");
    expect(fila).toBeDefined();
    expect(fila).toMatchObject({ entityId: ctx.propertyIdA, despues: "2026-03-09" });
  });
});

describe("/internal/restaurantes/cierres-dia", () => {
  const SECRETO = (deps: AppDeps) => deps.env.internalSecret;
  const llamar = (app: { request(i: string, init?: RequestInit): Promise<Resp> }, deps: AppDeps, qs = "") =>
    app.request(`/internal/restaurantes/cierres-dia${qs}`, { method: "POST", headers: { "x-atiende-internal-secret": SECRETO(deps) } });

  it("sin el secreto interno -> 401 y no genera nada", async () => {
    const { repo, app } = await construir();
    expect((await app.request("/internal/restaurantes/cierres-dia", { method: "POST" })).status).toBe(401);
    expect(repo.generaciones).toBe(0);
  });

  it("asegura el cierre de los ultimos dias, acepta GET con Bearer y es idempotente (la 2a corrida no crea ni avisa)", async () => {
    hoyFijo();
    const { ctx, repo, deps, app } = await construir();
    const r1 = await (await llamar(app, deps, "?dias=2")).json();
    expect(r1).toMatchObject({ ok: true, status: "ok", sucursales: 1, creados: 3, existentes: 0 }); // 2 dias (8 y 9) + la semana 2..8 que cerro el domingo 8
    const r2 = await (await app.request("/internal/restaurantes/cierres-dia?dias=2", { method: "GET", headers: { authorization: `Bearer ${SECRETO(deps)}` } })).json();
    expect(r2).toMatchObject({ ok: true, creados: 0, existentes: 3, avisos: 0 });
    const guardados = (await repo.listar(ctx.organizationId, ctx.propertyIdA, "dia", 10)).valor.map((c) => c.fechaInicio);
    expect(guardados).toEqual(["2026-03-09", "2026-03-08"]);
  });

  it("no cierra el dia de hoy aunque se pidan muchos dias", async () => {
    hoyFijo();
    const { ctx, repo, deps, app } = await construir();
    await llamar(app, deps, "?dias=14");
    const fechas = (await repo.listar(ctx.organizationId, ctx.propertyIdA, "dia", 60)).valor.map((c) => c.fechaInicio);
    expect(fechas).not.toContain("2026-03-10");
    expect(fechas).toHaveLength(14);
  });

  it("el barrido omite los dias sin pedidos (no guarda cierres vacios)", async () => {
    hoyFijo();
    const { ctx, deps } = await construir();
    const repo = new InMemoryCierreRepository({ calcular: () => null, sucursales: [{ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, zonaHoraria: "America/Mexico_City" }] });
    const app = envolver(buildApp({ ...deps, cierreRepo: () => repo }));
    expect(await (await llamar(app, deps, "?dias=3")).json()).toMatchObject({ creados: 0, sinActividad: 4 }); // 3 dias + la semana 2..8
    expect((await repo.listar(ctx.organizationId, ctx.propertyIdA, "dia", 10)).valor).toEqual([]);
  });

  it.each([["dias=0"], ["dias=15"], ["dias=abc"], ["dias=-1"]])("parametros invalidos (%s) -> 400 sin generar", async (qs) => {
    const { repo, deps, app } = await construir();
    expect((await llamar(app, deps, `?${qs}`)).status).toBe(400);
    expect(repo.generaciones).toBe(0);
  });

  it("una sucursal que falla no frena a las demas: se reporta y el resto queda generado", async () => {
    hoyFijo();
    const { ctx, deps } = await construir();
    const sana = new InMemoryCierreRepository({ calcular: () => CON_VENTAS });
    const rota = "00000000-0000-4000-8000-00000000dead";
    const repo: CierreRepository = {
      listar: (...a) => sana.listar(...a),
      sucursalesParaBarrido: async () => ({
        disponible: true,
        valor: [
          { organizationId: ctx.organizationId, propertyId: rota, zonaHoraria: "America/Mexico_City" },
          { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, zonaHoraria: "America/Mexico_City" },
        ],
      }),
      generar: (org, prop, ...resto) => (prop === rota ? Promise.reject(new Error("falla simulada de una sucursal")) : sana.generar(org, prop, ...resto)),
    };
    const app = envolver(buildApp({ ...deps, cierreRepo: () => repo }));
    const r = await (await llamar(app, deps, "?dias=1")).json();
    expect(r).toMatchObject({ ok: false, sucursales: 2, creados: 1 });
    expect(r.fallos).toEqual([{ propertyId: rota, error: "falla simulada de una sucursal" }]);
    expect((await sana.listar(ctx.organizationId, ctx.propertyIdA, "dia", 5)).valor).toHaveLength(1);
  });

  it("base SIN migrar: 200 con status not_available, nunca 500", async () => {
    const { deps } = await construir();
    const app = envolver(buildApp({ ...deps, cierreRepo: () => new InMemoryCierreRepository({ disponible: false }) }));
    expect(await (await llamar(app, deps)).json()).toMatchObject({ ok: true, status: "not_available", sucursales: 0, creados: 0 });
  });

  it("despliegue sin cierreRepo: 503 honesto", async () => {
    const { deps, app } = await construir({ sinRepo: true });
    expect((await llamar(app, deps)).status).toBe(503);
  });
});
