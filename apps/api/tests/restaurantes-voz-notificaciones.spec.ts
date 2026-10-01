// Notificaciones in-app del ciclo de voz de restaurantes (productor compartido `emitirNotificacion`): una llamada que pasa a una persona
// y los errores del proveedor. Cada caso afirma que se EMITE (o no), con texto sin PII, y que un fallo de la base (sin migrar) nunca rompe
// el cierre de la llamada ni el registro del evento.
import { describe, expect, it } from "vitest";
import { InMemoryVozKpiRepository, InMemoryVozRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

async function construir(opts: { alEmitir?: () => number } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const voz = new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  const kpi = new InMemoryVozKpiRepository();
  const base: AppDeps = { ...ctx.deps, vozRepo: () => voz, vozKpiRepo: () => kpi };
  const { deps, emisiones } = conEmisiones(base, opts.alEmitir ? { alEmitir: opts.alEmitir } : {});
  const app = buildApp(deps);
  const post = (ruta: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return app.request(`/internal/restaurantes/voz${ruta}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
  };
  return { ctx, emisiones, post };
}

async function iniciar(t: Awaited<ReturnType<typeof construir>>, externalId: string): Promise<string> {
  const r = await t.post("/conversaciones", { organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, externalId, canal: "llamada", proveedor: "gemini-3.8-live" });
  return ((await r.json()) as { conversationId: string }).conversationId;
}

describe("llamada escalada", () => {
  it("al cerrar una llamada como escalada emite UNA notificacion de atencion, con enlace a Agente de voz y sin datos personales", async () => {
    const t = await construir();
    const id = await iniciar(t, "sala-1");
    const r = await t.post(`/conversaciones/${id}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "escalado" });
    expect(await r.json()).toEqual({ cerrada: true });
    expect(t.emisiones).toHaveLength(1);
    expect(t.emisiones[0]).toMatchObject({
      evento: "restaurantes.voz.llamada_escalada",
      organizationId: t.ctx.organizationId,
      severidad: "atencion",
      categoria: "agentes",
      enlace: "/restaurantes/{orgSlug}/agente-voz",
      dedupeKey: `restaurantes.voz.llamada_escalada:${id}`,
      roles: ["staff"],
    });
    expect(`${t.emisiones[0]!.titulo} ${t.emisiones[0]!.cuerpo}`).not.toMatch(/\d{7,}|@/);
  });

  it("cerrar otra vez la misma llamada (ya cerrada) no vuelve a emitir; pedido_creado y abandonado no emiten", async () => {
    const t = await construir();
    const id = await iniciar(t, "sala-2");
    await t.post(`/conversaciones/${id}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "escalado" });
    const otra = await t.post(`/conversaciones/${id}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "escalado" });
    expect(await otra.json()).toEqual({ cerrada: false });
    const b = await iniciar(t, "sala-3");
    await t.post(`/conversaciones/${b}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "abandonado" });
    const c = await iniciar(t, "sala-4");
    await t.post(`/conversaciones/${c}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "pedido_creado" });
    expect(t.emisiones).toHaveLength(1);
  });

  it("si la base no tiene el productor (la funcion falla) el cierre igual se confirma", async () => {
    const t = await construir({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const id = await iniciar(t, "sala-5");
    const r = await t.post(`/conversaciones/${id}/cerrar`, { organizationId: t.ctx.organizationId, resultado: "escalado" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cerrada: true });
  });
});

describe("errores del proveedor de voz", () => {
  it("un error_proveedor avisa una vez por sucursal por hora; una herramienta lenta o un error repetido en la misma hora no", async () => {
    const t = await construir();
    const org = { organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA };
    const a = await t.post("/eventos", { ...org, tipo: "error_proveedor", proveedor: "gemini", codigo: "ws_1006", ocurridoAt: "2026-10-01T15:10:00.000Z" });
    expect(a.status).toBe(201);
    await t.post("/eventos", { ...org, tipo: "tool_call", herramienta: "cotizar_pedido", latenciaMs: 900 });
    expect(t.emisiones).toHaveLength(1);
    expect(t.emisiones[0]).toMatchObject({
      evento: "restaurantes.voz.proveedor_con_fallas",
      organizationId: t.ctx.organizationId,
      propertyId: t.ctx.propertyIdA,
      severidad: "atencion",
      categoria: "salud",
      dedupeKey: `restaurantes.voz.proveedor_con_fallas:${t.ctx.propertyIdA}:2026100115`,
    });
    // El dedupe real lo hace la base por esta clave: dentro de la misma hora la clave es identica; otra hora es otra.
    await t.post("/eventos", { ...org, tipo: "error_proveedor", proveedor: "twilio", ocurridoAt: "2026-10-01T15:50:00.000Z" });
    await t.post("/eventos", { ...org, tipo: "error_proveedor", proveedor: "twilio", ocurridoAt: "2026-10-01T16:05:00.000Z" });
    expect(t.emisiones.map((e) => e.dedupeKey.split(":").at(-1))).toEqual(["2026100115", "2026100115", "2026100116"]);
  });

  it("si la notificacion falla, el evento igual queda registrado", async () => {
    const t = await construir({
      alEmitir: () => {
        throw Object.assign(new Error("relation core.notification does not exist"), { code: "42P01" });
      },
    });
    const r = await t.post("/eventos", { organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, tipo: "error_proveedor", proveedor: "gemini", codigo: "x" });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ registrado: true });
  });
});
