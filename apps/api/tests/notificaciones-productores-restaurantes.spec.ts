// Productor `restaurantes.onboarding.listo`: se emite en la ESCRITURA que completa el ultimo punto obligatorio del checklist (agente,
// horario/politica de sucursal, disponibilidad de menu), una sola vez por transicion incompleto -> completo, a owner/admin, con enlace a
// Primeros pasos. Un GET del checklist NUNCA emite, aunque este completo. Una emision que falla (base sin 0039) no cambia la respuesta.
// `cargarOnboarding` se fuerza con una cola de estados (su calculo ya lo prueba restaurantes-admin-onboarding.spec.ts).
import { afterEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ listo: false, cola: [] as boolean[] }));
vi.mock("@atiende/domain-restaurantes", async (importOriginal) => {
  const real = await importOriginal<typeof import("@atiende/domain-restaurantes")>();
  return {
    ...real,
    cargarOnboarding: async () => {
      const listo = estado.cola.length > 0 ? (estado.cola.shift() as boolean) : estado.listo;
      return { items: [], resumen: { hechos: 0, total: 0, obligatoriosPendientes: listo ? 0 : 1 }, listoParaOperar: listo };
    },
  };
});

import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { InMemoryVozKpiRepository, diaVacio } from "@atiende/domain-restaurantes";
import { conEmisiones } from "./support/emisiones.ts";

const urlDe = (propertyId: string) => `/v1/restaurantes/${propertyId}/admin/onboarding`;
const PM = { alcance: "organizacion", perfil: "taqueria_pm", agentName: "Lupita", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" };

describe("restaurantes.onboarding.listo", () => {
  afterEach(() => {
    estado.listo = false;
    estado.cola = [];
  });

  async function guardarAgente(listoAntesYDespues: [boolean, boolean], opciones: { alEmitir?: () => number } = {}) {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps, opciones);
    estado.cola = [...listoAntesYDespues];
    const res = await buildApp(deps).request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/agente-whatsapp`, authedJson(ctx.staff.owner.token, PM, "PUT"));
    return { ctx, res, emisiones };
  }

  it("la escritura que completa el checklist (incompleto -> completo) emite UN aviso por organizacion, a owner/admin, con enlace a Primeros pasos y sin PII", async () => {
    const { ctx, res, emisiones } = await guardarAgente([false, true]);
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
    expect(JSON.stringify(emisiones)).not.toMatch(/Lupita/);
  });

  it("una escritura que deja el checklist incompleto, o que lo toca cuando ya estaba completo, no emite", async () => {
    expect((await guardarAgente([false, false])).emisiones).toHaveLength(0);
    // Ya completo antes de escribir: ni siquiera se vuelve a medir (no hay reemision al editar despues de los 30 dias de la dedupe).
    const { emisiones } = await guardarAgente([true, true]);
    expect(emisiones).toHaveLength(0);
  });

  it("completar el menu (disponibilidad de producto en la sucursal) o el horario (politica de sucursal) tambien emite", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const app = buildApp(deps);
    const creado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Taco", price: 30 }, "POST"));
    const productId = ((await creado.json()) as { product: { id: string } }).product.id;
    estado.cola = [false, true];
    const menu = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`, authedJson(ctx.staff.owner.token, { price: 30, isAvailable: true }, "PATCH"));
    expect(menu.status).toBe(200);
    expect(emisiones.map((e) => e.evento)).toEqual(["restaurantes.onboarding.listo"]);

    estado.cola = [false, true];
    const horario = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/politica`,
      authedJson(ctx.staff.owner.token, { horario: [{ dias: [1, 2, 3, 4, 5], abre: "09:00", cierra: "21:00" }], pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null }, "PUT"),
    );
    expect(horario.status).toBe(200);
    expect(emisiones.map((e) => e.evento)).toEqual(["restaurantes.onboarding.listo", "restaurantes.onboarding.listo"]);
  });

  it("una escritura rechazada (403) no emite, y leer el checklist (GET) nunca emite aunque este completo", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const app = buildApp(deps);
    estado.cola = [false, true];
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/agente-whatsapp`, authedJson(ctx.staff.repartidor.token, PM, "PUT"))).status).toBe(403);
    expect(emisiones).toHaveLength(0);
    estado.cola = [];
    estado.listo = true;
    const res = await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { listoParaOperar: boolean }).listoParaOperar).toBe(true);
    expect(emisiones).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) no cambia el 200 de la escritura", async () => {
    const { res } = await guardarAgente([false, true], {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    expect(res.status).toBe(200);
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
