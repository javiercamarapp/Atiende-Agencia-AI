// R23 (migracion 120): al cerrar una llamada como `escalado` se abre el handoff de voz (resumen + telefono para devolver la llamada).
// Solo `escalado` lo pide, con la conversacion y la organizacion de la llamada; y una base sin migrar (42883) nunca rompe el cierre.
import { describe, expect, it } from "vitest";
import { InMemoryVozKpiRepository, InMemoryVozRepository } from "@atiende/domain-restaurantes";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

async function construir(opts: { falla?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const voz = new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  const llamadas: unknown[][] = [];
  const envolver = (s: TenantDbSession): TenantDbSession => ({
    exec: (sql) => s.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/handoff_solicitar_voz/.test(sql)) {
        llamadas.push(params ?? []);
        if (opts.falla) throw Object.assign(new Error("function restaurantes.handoff_solicitar_voz does not exist"), { code: "42883" });
        return { rows: [{ handoff_solicitar_voz: null }] as unknown as T[] };
      }
      return s.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => ctx.deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
  const deps: AppDeps = { ...ctx.deps, engine, vozRepo: () => voz, vozKpiRepo: () => new InMemoryVozKpiRepository() };
  const app = buildApp(deps);
  const post = (ruta: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return app.request(`/internal/restaurantes/voz${ruta}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
  };
  const iniciar = async (externalId: string): Promise<string> => {
    const r = await post("/conversaciones", { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, externalId, canal: "llamada", proveedor: "gemini-3.8-live" });
    return ((await r.json()) as { conversationId: string }).conversationId;
  };
  return { ctx, llamadas, post, iniciar };
}

describe("llamada escalada abre el handoff de voz", () => {
  it("escalado -> una sola peticion de handoff con la organizacion y la conversacion de ESA llamada", async () => {
    const t = await construir();
    const id = await t.iniciar("sala-h1");
    const r = await t.post(`/conversaciones/${id}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "escalado" });
    expect(await r.json()).toEqual({ cerrada: true });
    expect(t.llamadas).toEqual([[t.ctx.organizationId, id, "llamada_escalada"]]);
  });

  it("pedido_creado, abandonado y el segundo cierre de la misma llamada no piden handoff", async () => {
    const t = await construir();
    const a = await t.iniciar("sala-h2");
    await t.post(`/conversaciones/${a}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "pedido_creado" });
    const b = await t.iniciar("sala-h3");
    await t.post(`/conversaciones/${b}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "abandonado" });
    const c = await t.iniciar("sala-h4");
    await t.post(`/conversaciones/${c}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "escalado" });
    await t.post(`/conversaciones/${c}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "escalado" });
    expect(t.llamadas).toHaveLength(1);
  });

  it("base sin la migracion 120 (42883): el cierre igual se confirma", async () => {
    const t = await construir({ falla: true });
    const id = await t.iniciar("sala-h5");
    const r = await t.post(`/conversaciones/${id}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "escalado" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cerrada: true });
  });
});
