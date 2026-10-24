// Configuracion del Resumen (migracion 096): GET/PUT /v1/restaurantes/:propertyId/admin/resumen/config.
// Rangos validados, solo owner/admin escriben, aislamiento por organizacion, bitacora con antes/despues y base sin migrar honesta.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const VALIDO = { minutosPorConversacion: 6, metaPedidosIaPct: 50, metaIngresosIaPct: 40 };

async function montar() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/resumen/config`;
  return { ctx, app, url };
}

describe("admin/resumen/config", () => {
  it("sin configurar: GET devuelve todo null con rangos y la formula; owner guarda y el GET lo refleja; la bitacora guarda antes y despues", async () => {
    const { ctx, app, url } = await montar();
    const vacio = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as { disponible: boolean; config: Record<string, unknown>; formula: string; rangos: unknown };
    expect(vacio.disponible).toBe(true);
    expect(vacio.config).toEqual({ minutosPorConversacion: null, metaPedidosIaPct: null, metaIngresosIaPct: null });
    expect(vacio.formula).toContain("minutos por conversacion");

    const put = await app.request(url, authedJson(ctx.staff.owner.token, VALIDO, "PUT"));
    expect(put.status).toBe(200);
    const leido = (await (await app.request(url, authedGet(ctx.staff.admin.token))).json()) as { config: unknown };
    expect(leido.config).toEqual(VALIDO);

    const aud = await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 50 });
    const fila = aud.items.find((i) => i.action === "configuracion.resumen_actualizada");
    expect(fila).toBeTruthy();
    expect(JSON.stringify(fila)).toContain("minutosPorConversacion");
  });

  it("quitar un valor con null; rangos y campos invalidos son 400", async () => {
    const { ctx, app, url } = await montar();
    await app.request(url, authedJson(ctx.staff.owner.token, VALIDO, "PUT"));
    const quitar = await app.request(url, authedJson(ctx.staff.owner.token, { ...VALIDO, metaPedidosIaPct: null }, "PUT"));
    expect(((await quitar.json()) as { config: { metaPedidosIaPct: number | null } }).config.metaPedidosIaPct).toBeNull();
    for (const malo of [
      { ...VALIDO, minutosPorConversacion: 0 },
      { ...VALIDO, minutosPorConversacion: 121 },
      { ...VALIDO, metaPedidosIaPct: 101 },
      { ...VALIDO, metaIngresosIaPct: 0 },
      { ...VALIDO, metaIngresosIaPct: 2.5 },
      { ...VALIDO, minutosPorConversacion: "5" },
      { minutosPorConversacion: 5 },
      { ...VALIDO, extra: 1 },
    ]) {
      expect((await app.request(url, authedJson(ctx.staff.owner.token, malo, "PUT"))).status).toBe(400);
    }
  });

  it("solo owner/admin escriben (staff y repartidor 403); staff lee; repartidor no", async () => {
    const { ctx, app, url } = await montar();
    expect((await app.request(url, authedJson(ctx.staff.staffSucursalA.token, VALIDO, "PUT"))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.repartidor.token, VALIDO, "PUT"))).status).toBe(403);
    expect((await app.request(url, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(200);
    expect((await app.request(url, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
  });

  it("aislamiento: la configuracion de una organizacion no se ve en otra", async () => {
    const { ctx, app, url } = await montar();
    await app.request(url, authedJson(ctx.staff.owner.token, VALIDO, "PUT"));
    const otra = await app.request(url, authedGet(ctx.staff.otroOrgOwner.token));
    expect([403, 404]).toContain(otra.status);
  });

  it("base sin migrar: GET disponible:false y PUT 503, nunca un falso exito", async () => {
    const { ctx, app, url } = await montar();
    ctx.restaurantesRepo.resumenConfigDisponible = false;
    const g = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as { disponible: boolean; config: Record<string, unknown> };
    expect(g.disponible).toBe(false);
    expect(g.config.minutosPorConversacion).toBeNull();
    expect((await app.request(url, authedJson(ctx.staff.owner.token, VALIDO, "PUT"))).status).toBe(503);
  });
});
