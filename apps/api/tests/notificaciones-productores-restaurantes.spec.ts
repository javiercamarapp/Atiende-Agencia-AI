// Productor `restaurantes.onboarding.listo`: el checklist de Primeros pasos completo avisa UNA vez por organizacion (clave = organizacion)
// a owner/admin con enlace a la pantalla origen; un checklist incompleto no emite, y una emision que falla (base sin 0039) no cambia la
// respuesta. El estado `listoParaOperar` se fuerza sobre `cargarOnboarding` (su calculo ya lo prueba restaurantes-admin-onboarding.spec.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ listo: false }));
vi.mock("@atiende/domain-restaurantes", async (importOriginal) => {
  const real = await importOriginal<typeof import("@atiende/domain-restaurantes")>();
  return {
    ...real,
    cargarOnboarding: async () => ({ items: [], resumen: { hechos: 0, total: 0, obligatoriosPendientes: estado.listo ? 0 : 1 }, listoParaOperar: estado.listo }),
  };
});

import { buildApp } from "../src/app.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { InMemoryVozKpiRepository, diaVacio } from "@atiende/domain-restaurantes";
import { conEmisiones } from "./support/emisiones.ts";

const urlDe = (propertyId: string) => `/v1/restaurantes/${propertyId}/admin/onboarding`;

describe("restaurantes.onboarding.listo", () => {
  it("checklist completo: emite UN aviso por organizacion, a owner/admin, con enlace a Primeros pasos y sin PII", async () => {
    estado.listo = true;
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const res = await buildApp(deps).request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "restaurantes.onboarding.listo",
      organizationId: ctx.organizationId,
      propertyId: null,
      categoria: "onboarding",
      severidad: "info",
      enlace: "/restaurantes/{orgSlug}/primeros-pasos",
      dedupeKey: `restaurantes.onboarding.listo:${ctx.organizationId}`,
      roles: null,
    });
  });

  it("checklist incompleto: no emite", async () => {
    estado.listo = false;
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    expect((await buildApp(deps).request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token))).status).toBe(200);
    expect(emisiones).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) no cambia el 200 del checklist", async () => {
    estado.listo = true;
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps } = conEmisiones(ctx.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await buildApp(deps).request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { listoParaOperar: boolean }).listoParaOperar).toBe(true);
  });
});

describe("alertas de voz (costo del dia y tasa de error)", () => {
  afterEach(() => vi.useRealTimers());

  async function setup(opciones: { alEmitir?: () => number } = {}) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T18:00:00Z"));
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const kpi = new InMemoryVozKpiRepository();
    kpi.hoy = "2026-03-10";
    kpi.dias.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [{ ...diaVacio("2026-03-10"), llamadas: 6, erroresProveedor: 3, costoVozMicroUsd: 5_000_000, costoTotalCentavosMxn: 10000 }]);
    const { deps, emisiones } = conEmisiones({ ...ctx.deps, vozKpiRepo: () => kpi }, opciones);
    const app = buildApp(deps);
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/voz`;
    await app.request(`${base}/alertas/config`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` }, body: JSON.stringify({ umbralCostoDiaCentavosMxn: 8000, umbralTasaErrorPct: 40, minLlamadasTasaError: 3 }) });
    const evaluar = () => app.request(`${base}/alertas/evaluar`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ctx.staff.owner.token}` }, body: "{}" });
    return { ctx, emisiones, evaluar };
  }

  it("la evaluacion que dispara costo y tasa de error por primera vez emite UNA por tipo con clave sucursal + dia, a owner/admin y sin cifras; la segunda evaluacion no emite", async () => {
    const { ctx, emisiones, evaluar } = await setup();
    expect((await evaluar()).status).toBe(200);
    expect(emisiones.map((e) => e.evento)).toEqual(["restaurantes.costo.umbral_voz", "restaurantes.voz.tasa_error_alta"]);
    expect(emisiones[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, categoria: "cierres", enlace: "/restaurantes/{orgSlug}/agente-voz", dedupeKey: `restaurantes.costo.umbral_voz:${ctx.propertyIdA}:2026-03-10`, roles: null });
    expect(emisiones[1]).toMatchObject({ categoria: "salud", dedupeKey: `restaurantes.voz.tasa_error_alta:${ctx.propertyIdA}:2026-03-10` });
    expect(JSON.stringify(emisiones)).not.toMatch(/10000|8000/);
    expect((await evaluar()).status).toBe(200);
    expect(emisiones).toHaveLength(2);
  });

  it("una emision que falla (base sin migrar) no cambia la respuesta de la evaluacion", async () => {
    const { evaluar } = await setup({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await evaluar();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { alertas: unknown[] }).alertas).toHaveLength(2);
  });
});
