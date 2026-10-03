// R-31 (migración 040): GET .../admin/whatsapp/kpi. Cada caso afirma el EFECTO (qué se calculó, qué rango se pidió a la base, qué
// NO se devuelve), no solo el status.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWhatsappKpiRepository, whatsappDiaVacio } from "@atiende/domain-restaurantes";
import type { WhatsappKpiDia } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

afterEach(() => vi.useRealTimers());

function hoyFijo(iso = "2026-03-10T18:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

async function construir(opts: { sinRepo?: boolean; zona?: string | null } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const kpi = new InMemoryWhatsappKpiRepository();
  if (opts.zona !== undefined) await ctx.restaurantesRepo.upsertBranchZonaHoraria(ctx.propertyIdA, opts.zona);
  const deps: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { whatsappKpiRepo: () => kpi }) };
  return { ctx, kpi, app: envolver(buildApp(deps)), url: `/v1/restaurantes/${ctx.propertyIdA}/admin/whatsapp/kpi` };
}

const dia = (fecha: string, parcial: Partial<WhatsappKpiDia> = {}): WhatsappKpiDia => ({ ...whatsappDiaVacio(fecha), ...parcial });

describe("GET .../admin/whatsapp/kpi", () => {
  it("sin datos: ceros honestos, porcentajes y costo por pedido null (no 0%), serie de 14 días terminando hoy", async () => {
    hoyFijo();
    const { ctx, app, url } = await construir();
    const res = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ disponible: true, hoy: "2026-03-10", desde: "2026-02-25", hasta: "2026-03-10", zonaHoraria: "America/Mexico_City" });
    expect(r.resumen).toMatchObject({ dias: 14, conversaciones: 0, conversionPct: null, handoffPct: null, pedidos: 0, costoLlmPorPedidoCentavosMxn: null });
    expect(r.serie).toHaveLength(14);
    expect(r.serie[0]).toMatchObject({ fecha: "2026-02-25", conversionPct: null, costoLlmPorPedidoCentavosMxn: null });
  });

  it("calcula conversión, handoff y costo LLM promedio por pedido con los agregados del repositorio", async () => {
    hoyFijo();
    const { ctx, kpi, app, url } = await construir();
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [
      dia("2026-03-09", { conversaciones: 4, conversacionesConPedido: 1, conversacionesConHandoff: 1, pedidos: 1, handoffs: 1, pedidosOrg: 2, costoLlmOrgCentavosMxn: 600, costoLlmOrgMicroUsd: 300_000 }),
      dia("2026-03-10", { conversaciones: 6, conversacionesConPedido: 3, conversacionesConHandoff: 0, pedidos: 3, handoffs: 0, pedidosOrg: 4, costoLlmOrgCentavosMxn: 1000, costoLlmOrgMicroUsd: 500_000 }),
    ]);
    const texto = await (await app.request(`${url}?dias=2`, authedGet(ctx.staff.owner.token))).text();
    const r = JSON.parse(texto);
    expect(r.serie).toHaveLength(2);
    expect(r.serie[1]).toMatchObject({ conversionPct: 50, handoffPct: 0, costoLlmPorPedidoCentavosMxn: 250 });
    expect(r.resumen).toMatchObject({ conversaciones: 10, conversionPct: 40, handoffPct: 10, pedidos: 4, handoffs: 1, pedidosOrg: 6, costoLlmOrgCentavosMxn: 1600, costoLlmPorPedidoCentavosMxn: 267 });
    expect(texto).not.toMatch(/phone|telefono|caller|hash/i);
  });

  it("sin alcance de toda la organización (costo y pedidos de la organización null): el costo por pedido es null, no 0", async () => {
    hoyFijo();
    const { ctx, kpi, app, url } = await construir();
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [dia("2026-03-10", { conversaciones: 2, pedidos: 1, pedidosOrg: null, costoLlmOrgCentavosMxn: null, costoLlmOrgMicroUsd: null })]);
    const r = await (await app.request(`${url}?dias=1`, authedGet(ctx.staff.owner.token))).json();
    expect(r.resumen).toMatchObject({ costoLlmOrgCentavosMxn: null, costoLlmPorPedidoCentavosMxn: null, pedidosOrg: null });
  });

  it("organización demo: se avisa y el costo no se muestra", async () => {
    hoyFijo();
    const { ctx, kpi, app, url } = await construir();
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [dia("2026-03-10", { orgEsDemo: true, costoLlmOrgCentavosMxn: null, costoLlmOrgMicroUsd: null })]);
    const r = await (await app.request(`${url}?dias=1`, authedGet(ctx.staff.owner.token))).json();
    expect(r.resumen).toMatchObject({ orgEsDemo: true, costoLlmOrgCentavosMxn: null });
  });

  it("el día de hoy usa la zona de la sucursal (05:30Z del día 11: sigue siendo el 10 en México y ya es el 11 en Auckland)", async () => {
    hoyFijo("2026-03-11T05:30:00Z");
    const mx = await construir();
    expect((await (await mx.app.request(mx.url, authedGet(mx.ctx.staff.owner.token))).json()).hoy).toBe("2026-03-10");
    const nz = await construir({ zona: "Pacific/Auckland" });
    expect(await (await nz.app.request(nz.url, authedGet(nz.ctx.staff.owner.token))).json()).toMatchObject({ hoy: "2026-03-11", zonaHoraria: "Pacific/Auckland" });
  });

  it("rango explícito: pide exactamente ese rango a la base", async () => {
    hoyFijo();
    const { ctx, kpi, app, url } = await construir();
    const res = await app.request(`${url}?desde=2026-03-01&hasta=2026-03-05`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(kpi.consultas.at(-1)).toEqual({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, desde: "2026-03-01", hasta: "2026-03-05" });
    expect((await res.json()).serie).toHaveLength(5);
  });

  it.each([
    ["dias=0"], ["dias=64"], ["dias=abc"], ["dias=-3"],
    ["desde=2026-03-01"], ["desde=2026-03-05&hasta=2026-03-01"], ["desde=2026-02-30&hasta=2026-03-05"],
    ["desde=2026-03-01&hasta=2026-03-11"], ["desde=2025-12-01&hasta=2026-03-10"], ["dias=3&desde=2026-03-01&hasta=2026-03-02"],
  ])("parámetros inválidos (%s) -> 400 y no se consulta la base", async (qs) => {
    hoyFijo();
    const { ctx, kpi, app, url } = await construir();
    const res = await app.request(`${url}?${qs}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
    expect(kpi.consultas).toHaveLength(0);
  });

  it("otro tenant: lo registrado para otra organización o sucursal nunca aparece", async () => {
    hoyFijo();
    const { ctx, kpi, app, url } = await construir();
    kpi.dias.set(`${ctx.otherOrganizationId}:${ctx.otherPropertyId}`, [dia("2026-03-10", { conversaciones: 50 })]);
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdB}`, [dia("2026-03-10", { conversaciones: 40 })]);
    const r = await (await app.request(url, authedGet(ctx.staff.owner.token))).json();
    expect(r.resumen.conversaciones).toBe(0);
  });

  it("roles: staff, repartidor y owner de otra organización -> 403; sin sesión -> 401; sucursal ajena -> 403/404 sin consultar la base", async () => {
    const { ctx, kpi, app, url } = await construir();
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(url, authedGet(token))).status).toBe(403);
    }
    expect((await app.request(url)).status).toBe(401);
    const ajena = await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/whatsapp/kpi`, authedGet(ctx.staff.owner.token));
    expect([403, 404]).toContain(ajena.status);
    expect(kpi.consultas).toHaveLength(0);
  });

  it("base SIN migrar: 200 con disponible=false y serie vacía, nunca 500", async () => {
    hoyFijo();
    const { ctx, kpi, app, url } = await construir();
    kpi.disponible = false;
    const res = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, serie: [], resumen: { dias: 0, conversaciones: 0, conversionPct: null, costoLlmPorPedidoCentavosMxn: null } });
  });

  it("despliegue sin whatsappKpiRepo: 503 honesto", async () => {
    const { ctx, app, url } = await construir({ sinRepo: true });
    expect((await app.request(url, authedGet(ctx.staff.owner.token))).status).toBe(503);
  });
});
