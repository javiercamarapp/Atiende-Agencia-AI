// Interruptor por organizacion del aviso «va en camino» (migracion 107): GET/PUT /v1/restaurantes/:propertyId/admin/whatsapp/aviso-en-camino.
// Encendido por omision; solo owner/admin de toda la organizacion lo cambian; bitacora con antes/despues; base sin migrar honesta (disponible:false / 503).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

async function montar() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/whatsapp/aviso-en-camino`;
  return { ctx, app, url };
}

type Respuesta = { disponible: boolean; activo: boolean; plantilla: { evento: string; nombre: string; idioma: string; categoria: string; variables: string[] } };

describe("admin/whatsapp/aviso-en-camino", () => {
  it("encendido por omision; el owner lo apaga, el GET lo refleja y la bitacora guarda antes y despues", async () => {
    const { ctx, app, url } = await montar();
    const inicial = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as Respuesta;
    expect(inicial.disponible).toBe(true);
    expect(inicial.activo).toBe(true);
    expect(inicial.plantilla).toEqual({ evento: "order.en_camino", nombre: "pedido_en_camino", idioma: "es_MX", categoria: "utility", variables: ["sucursal", "folio", "tiempo"] });

    const put = await app.request(url, authedJson(ctx.staff.owner.token, { activo: false }, "PUT"));
    expect(put.status).toBe(200);
    expect(((await put.json()) as Respuesta).activo).toBe(false);
    expect(((await (await app.request(url, authedGet(ctx.staff.staffSucursalA.token))).json()) as Respuesta).activo).toBe(false);

    const aud = await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 50 });
    const fila = aud.items.find((i) => i.action === "configuracion.aviso_en_camino_actualizado");
    expect(fila).toBeTruthy();
    expect(JSON.stringify(fila)).toContain("encendido");
    expect(JSON.stringify(fila)).toContain("apagado");
  });

  it("cuerpo invalido es 400", async () => {
    const { ctx, app, url } = await montar();
    for (const malo of [{}, { activo: "no" }, { activo: null }, { activo: true, extra: 1 }]) {
      expect((await app.request(url, authedJson(ctx.staff.owner.token, malo, "PUT"))).status).toBe(400);
    }
  });

  it("solo owner/admin de toda la organizacion escriben; staff lee; repartidor y anonimo no", async () => {
    const { ctx, app, url } = await montar();
    expect((await app.request(url, authedJson(ctx.staff.admin.token, { activo: false }, "PUT"))).status).toBe(200);
    expect((await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { activo: true }, "PUT"))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.adminSucursalA.token, { activo: true }, "PUT"))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.repartidor.token, { activo: true }, "PUT"))).status).toBe(403);
    expect((await app.request(url, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
  });

  it("aislamiento: otra organizacion no lo ve ni lo cambia", async () => {
    const { ctx, app, url } = await montar();
    expect([403, 404]).toContain((await app.request(url, authedGet(ctx.staff.otroOrgOwner.token))).status);
    expect([403, 404]).toContain((await app.request(url, authedJson(ctx.staff.otroOrgOwner.token, { activo: false }, "PUT"))).status);
  });

  it("base sin migrar: GET disponible:false (encendido por omision) y PUT 503, nunca un falso exito", async () => {
    const { ctx, app, url } = await montar();
    ctx.restaurantesRepo.avisoEnCaminoConfigDisponible = false;
    const g = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as Respuesta;
    expect(g.disponible).toBe(false);
    expect(g.activo).toBe(true);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { activo: false }, "PUT"))).status).toBe(503);
  });
});
