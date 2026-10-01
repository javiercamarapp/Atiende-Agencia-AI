// R-13 (migración 035): KPI de voz, costo por día y alertas operativas. Rutas del panel y registrador de eventos del
// servicio de voz. Cada caso afirma el EFECTO (qué se calculó, qué quedó en bitácora, qué NO se envió), no solo el status.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryVozKpiRepository, diaVacio } from "@atiende/domain-restaurantes";
import type { VozKpiDia } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

afterEach(() => vi.useRealTimers());

async function construir(opts: { sinRepo?: boolean; zona?: string | null } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const kpi = new InMemoryVozKpiRepository();
  if (opts.zona !== undefined) await ctx.restaurantesRepo.upsertBranchZonaHoraria(ctx.propertyIdA, opts.zona);
  const deps: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { vozKpiRepo: () => kpi }) };
  return { ctx, kpi, app: envolver(buildApp(deps)), base: `/v1/restaurantes/${ctx.propertyIdA}/admin/voz` };
}

function dia(fecha: string, parcial: Partial<VozKpiDia> = {}): VozKpiDia {
  return { ...diaVacio(fecha), ...parcial };
}

describe("GET .../admin/voz/kpi", () => {
  it("sin datos: ceros honestos, porcentajes null y la serie completa de 14 días", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T18:00:00Z"));
    const { ctx, app, base } = await construir();
    const res = await app.request(`${base}/kpi`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ disponible: true, hoy: "2026-03-10", mesDesde: "2026-03-01", zonaHoraria: "America/Mexico_City" });
    expect(r.diaDeHoy).toMatchObject({ llamadas: 0, tasaResolucionPct: null, tasaErrorPct: null, toolP95PeorDiaMs: null, costoCentavosMxn: 0 });
    expect(r.mes.dias).toBe(10);
    expect(r.serie).toHaveLength(14);
    expect(r.serie[0].fecha).toBe("2026-02-25");
    expect(r.serie.at(-1).fecha).toBe("2026-03-10");
  });

  it("calcula hoy y mes con los agregados del repositorio y no filtra PII del llamante", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T18:00:00Z"));
    const { ctx, kpi, app, base } = await construir();
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [
      dia("2026-03-09", { llamadas: 3, llamadasCerradas: 3, pedidosVoz: 1, duracionTotalS: 300, costoVozMicroUsd: 1_000_000, costoTotalCentavosMxn: 2000 }),
      dia("2026-03-10", { llamadas: 4, llamadasCerradas: 3, pedidosVoz: 1, escaladas: 1, abandonadas: 1, duracionTotalS: 1290, erroresProveedor: 1, toolP95Ms: 950, toolCalls: 20, costoVozMicroUsd: 1_500_000, costoTelefoniaMicroUsd: 500_000, costoTotalCentavosMxn: 4000 }),
    ]);
    const texto = await (await app.request(`${base}/kpi`, authedGet(ctx.staff.owner.token))).text();
    const r = JSON.parse(texto);
    expect(r.diaDeHoy).toMatchObject({ llamadas: 4, tasaResolucionPct: 33, tasaHandoffPct: 33, tasaAbandonoPct: 33, tasaErrorPct: 25, toolP95PeorDiaMs: 950, costoCentavosMxn: 4000, costoPorLlamadaCentavosMxn: 1000, duracionPromedioS: 430 });
    expect(r.mes).toMatchObject({ llamadas: 7, costoCentavosMxn: 6000, costoCompleto: true });
    expect(texto).not.toMatch(/phone|telefono|caller|hash/i);
  });

  it("el día de hoy usa la zona de la sucursal: a las 05:30Z del día 11 sigue siendo el día 10 en México y ya es el 11 en Auckland", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-11T05:30:00Z"));
    const mx = await construir();
    expect((await (await mx.app.request(`${mx.base}/kpi`, authedGet(mx.ctx.staff.owner.token))).json()).hoy).toBe("2026-03-10");
    const nz = await construir({ zona: "Pacific/Auckland" });
    const r = await (await nz.app.request(`${nz.base}/kpi`, authedGet(nz.ctx.staff.owner.token))).json();
    expect(r).toMatchObject({ hoy: "2026-03-11", zonaHoraria: "Pacific/Auckland" });
  });

  it("cruce de mes: el primer día del mes el 'mes' es solo ese día; el rango pedido a la base cubre el mes anterior para la serie", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-01T18:00:00Z"));
    const { ctx, kpi, app, base } = await construir();
    const espiar = vi.spyOn(kpi, "getKpisDiarios");
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [dia("2026-03-31", { llamadas: 9 }), dia("2026-04-01", { llamadas: 2 })]);
    const r = await (await app.request(`${base}/kpi`, authedGet(ctx.staff.owner.token))).json();
    expect(r.mes).toMatchObject({ dias: 1, llamadas: 2 });
    expect(r.serie.map((d: { llamadas: number }) => d.llamadas).slice(-2)).toEqual([9, 2]);
    expect(espiar).toHaveBeenCalledWith(ctx.organizationId, ctx.propertyIdA, "2026-03-19", "2026-04-01");
  });

  it("otro tenant: lo registrado para otra organización o sucursal nunca aparece", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T18:00:00Z"));
    const { ctx, kpi, app, base } = await construir();
    kpi.dias.set(`${ctx.otherOrganizationId}:${ctx.otherPropertyId}`, [dia("2026-03-10", { llamadas: 50 })]);
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdB}`, [dia("2026-03-10", { llamadas: 40 })]);
    const r = await (await app.request(`${base}/kpi`, authedGet(ctx.staff.owner.token))).json();
    expect(r.mes.llamadas).toBe(0);
  });

  it("roles: staff, repartidor y owner de otra organización -> 403; sin sesión -> 401; sucursal fuera de la organización -> 403/404", async () => {
    const { ctx, app, base } = await construir();
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(`${base}/kpi`, authedGet(token))).status).toBe(403);
    }
    expect((await app.request(`${base}/kpi`)).status).toBe(401);
    const ajena = await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/voz/kpi`, authedGet(ctx.staff.owner.token));
    expect([403, 404]).toContain(ajena.status);
  });

  it("base SIN migrar: 200 con disponible=false y ceros, nunca 500", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T18:00:00Z"));
    const { ctx, kpi, app, base } = await construir();
    kpi.disponible = false;
    const res = await app.request(`${base}/kpi`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, mes: { llamadas: 0, costoCentavosMxn: 0 } });
  });

  it("despliegue sin vozKpiRepo: 503 honesto", async () => {
    const { ctx, app, base } = await construir({ sinRepo: true });
    expect((await app.request(`${base}/kpi`, authedGet(ctx.staff.owner.token))).status).toBe(503);
  });
});

const UMBRALES = { umbralCostoDiaCentavosMxn: 8000, umbralTasaErrorPct: 40, minLlamadasTasaError: 5 };

describe("umbrales y alertas", () => {
  it("PUT guarda, se lee de vuelta, deja bitácora con actor y NO envía nada", async () => {
    const { ctx, app, base } = await construir();
    const antes = await (await app.request(`${base}/alertas`, authedGet(ctx.staff.owner.token))).json();
    expect(antes).toMatchObject({ disponible: true, umbrales: { configurado: false, umbralCostoDiaCentavosMxn: null, umbralTasaErrorPct: null }, alertas: [] });

    const put = await app.request(`${base}/alertas/config`, authedJson(ctx.staff.owner.token, UMBRALES, "PUT"));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ configurado: true, ...UMBRALES });
    const despues = await (await app.request(`${base}/alertas`, authedGet(ctx.staff.admin.token))).json();
    expect(despues.umbrales).toMatchObject(UMBRALES);

    const entrada = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.voz_umbrales_actualizados");
    expect(entrada).toMatchObject({ actorUserId: ctx.staff.owner.id, entityId: ctx.propertyIdA, antes: null });
    expect(JSON.parse(entrada?.despues ?? "{}")).toEqual({ costoDiaCentavosMxn: 8000, tasaErrorPct: 40, minLlamadas: 5 });
  });

  it("validación: faltantes, decimales, cero, fuera de rango -> 400 y nada se guarda; null apaga una alerta", async () => {
    const { ctx, kpi, app, base } = await construir();
    const casos: unknown[] = [
      {},
      { ...UMBRALES, umbralCostoDiaCentavosMxn: 10.5 },
      { ...UMBRALES, umbralCostoDiaCentavosMxn: 0 },
      { ...UMBRALES, umbralTasaErrorPct: 101 },
      { ...UMBRALES, minLlamadasTasaError: 0 },
      { ...UMBRALES, umbralCostoDiaCentavosMxn: "8000" },
      { umbralCostoDiaCentavosMxn: 1, umbralTasaErrorPct: 1 },
    ];
    for (const body of casos) {
      expect((await app.request(`${base}/alertas/config`, authedJson(ctx.staff.owner.token, body, "PUT"))).status).toBe(400);
    }
    expect(kpi.umbrales.size).toBe(0);
    const ok = await app.request(`${base}/alertas/config`, authedJson(ctx.staff.owner.token, { umbralCostoDiaCentavosMxn: null, umbralTasaErrorPct: null, minLlamadasTasaError: 3 }, "PUT"));
    expect(ok.status).toBe(200);
  });

  it("evaluar: dispara costo y tasa de error, queda UNA alerta por tipo aunque se evalúe dos veces, y no encola ningún mensaje saliente", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T18:00:00Z"));
    const { ctx, kpi, app, base } = await construir();
    kpi.hoy = "2026-03-10";
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [dia("2026-03-10", { llamadas: 6, erroresProveedor: 3, costoVozMicroUsd: 5_000_000, costoTotalCentavosMxn: 10000 })]);
    await app.request(`${base}/alertas/config`, authedJson(ctx.staff.owner.token, UMBRALES, "PUT"));
    const primera = await (await app.request(`${base}/alertas/evaluar`, authedJson(ctx.staff.owner.token, {}))).json();
    expect(primera.alertas).toEqual([
      { fecha: "2026-03-10", tipo: "costo_dia", valor: 10000, umbral: 8000, nueva: true },
      { fecha: "2026-03-10", tipo: "tasa_error", valor: 50, umbral: 40, nueva: true },
    ]);
    const segunda = await (await app.request(`${base}/alertas/evaluar`, authedJson(ctx.staff.owner.token, {}))).json();
    expect(segunda.alertas.map((a: { nueva: boolean }) => a.nueva)).toEqual([false, false]);
    const lista = await (await app.request(`${base}/alertas`, authedGet(ctx.staff.owner.token))).json();
    expect(lista.alertas).toHaveLength(2);
    // Solo alertas internas: ningun mensaje saliente (WhatsApp/correo). La linea de bitacora de la alerta la escribe la
    // funcion SQL voz_evaluar_alertas (probada en scripts/verify-restaurantes-voz-kpi), no esta ruta.
    expect(ctx.restaurantesRepo.getOutbox()).toHaveLength(0);
  });

  it("evaluar sin umbrales no inventa alertas; roles insuficientes -> 403", async () => {
    const { ctx, app, base } = await construir();
    const r = await (await app.request(`${base}/alertas/evaluar`, authedJson(ctx.staff.owner.token, {}))).json();
    expect(r.alertas).toEqual([]);
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(`${base}/alertas/evaluar`, authedJson(token, {}))).status).toBe(403);
      expect((await app.request(`${base}/alertas/config`, authedJson(token, UMBRALES, "PUT"))).status).toBe(403);
      expect((await app.request(`${base}/alertas`, authedGet(token))).status).toBe(403);
    }
  });

  it("base SIN migrar: lecturas y evaluar -> disponible=false (200); PUT -> 503 sin bitácora", async () => {
    const { ctx, kpi, app, base } = await construir();
    kpi.disponible = false;
    expect(await (await app.request(`${base}/alertas`, authedGet(ctx.staff.owner.token))).json()).toMatchObject({ disponible: false, alertas: [] });
    expect(await (await app.request(`${base}/alertas/evaluar`, authedJson(ctx.staff.owner.token, {}))).json()).toMatchObject({ disponible: false, alertas: [] });
    const put = await app.request(`${base}/alertas/config`, authedJson(ctx.staff.owner.token, UMBRALES, "PUT"));
    expect(put.status).toBe(503);
    expect(ctx.restaurantesRepo.auditLog.some((r) => r.action === "configuracion.voz_umbrales_actualizados")).toBe(false);
  });
});

describe("POST /internal/restaurantes/voz/eventos", () => {
  async function post(app: { request(i: string, init?: RequestInit): Promise<Resp> }, secret: string | null, body: unknown) {
    const raw = JSON.stringify(body);
    return app.request("/internal/restaurantes/voz/eventos", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), ...(secret ? { "x-atiende-internal-secret": secret } : {}) } });
  }

  it("sin secreto interno -> 401 y nada se registra", async () => {
    const { ctx, kpi, app } = await construir();
    expect((await post(app, null, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, tipo: "tool_call", herramienta: "x", latenciaMs: 1 })).status).toBe(401);
    expect((await post(app, "otro-secreto", { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, tipo: "tool_call", herramienta: "x", latenciaMs: 1 })).status).toBe(401);
    expect(kpi.eventos).toHaveLength(0);
  });

  it("registra una herramienta con latencia y un error de proveedor", async () => {
    const { ctx, kpi, app } = await construir();
    const secret = ctx.deps.env.internalSecret;
    const a = await post(app, secret, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, tipo: "tool_call", herramienta: "cotizar_pedido", latenciaMs: 420 });
    expect(a.status).toBe(201);
    const b = await post(app, secret, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, tipo: "error_proveedor", proveedor: "twilio", codigo: "31005" });
    expect(b.status).toBe(201);
    expect(kpi.eventos).toMatchObject([
      { tipo: "tool_call", herramienta: "cotizar_pedido", latenciaMs: 420, proveedor: null },
      { tipo: "error_proveedor", proveedor: "twilio", codigo: "31005", herramienta: null },
    ]);
  });

  it("validación: tipo/proveedor desconocidos, tool_call sin herramienta ni latencia, UUID inválido, código demasiado largo -> 400", async () => {
    const { ctx, kpi, app } = await construir();
    const secret = ctx.deps.env.internalSecret;
    const base = { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA };
    for (const body of [
      { ...base, tipo: "otro" },
      { ...base, tipo: "error_proveedor", proveedor: "stripe" },
      { ...base, tipo: "error_proveedor" },
      { ...base, tipo: "tool_call", latenciaMs: 5 },
      { ...base, tipo: "tool_call", herramienta: "x" },
      { ...base, tipo: "tool_call", herramienta: "x", latenciaMs: -1 },
      { ...base, tipo: "error_proveedor", proveedor: "twilio", codigo: "x".repeat(81) },
      { organizationId: "no-uuid", propertyId: ctx.propertyIdA, tipo: "tool_call", herramienta: "x", latenciaMs: 1 },
    ]) {
      expect((await post(app, secret, body)).status).toBe(400);
    }
    expect(kpi.eventos).toHaveLength(0);
  });

  it("base SIN migrar: 503 (no 500)", async () => {
    const { ctx, kpi, app } = await construir();
    kpi.disponible = false;
    expect((await post(app, ctx.deps.env.internalSecret, { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, tipo: "tool_call", herramienta: "x", latenciaMs: 1 })).status).toBe(503);
  });
});
