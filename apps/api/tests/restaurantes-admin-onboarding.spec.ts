// R-33 -- GET /v1/restaurantes/:propertyId/admin/onboarding por HTTP real sobre repos en memoria: checklist calculado con datos
// reales, solo owner/admin con acceso a TODA la organizacion, aislamiento entre organizaciones y sin 401/403 mal mapeados.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const urlDe = (propertyId: string) => `/v1/restaurantes/${propertyId}/admin/onboarding`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("checklist de onboarding", () => {
  it("owner: lo calcula con datos reales de la organizacion (nada guardado a mano) y no se cachea", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    const por = (id: string) => body.items.find((i: { id: string }) => i.id === id);
    expect(body.items.length).toBeGreaterThan(8);
    expect(por("sucursales").estado).toBe("hecho");
    // El fixture no configura agente, WhatsApp ni cobertura: se ve pendiente, nunca "hecho" por defecto.
    expect(por("agente_whatsapp").estado).toBe("pendiente");
    expect(por("whatsapp").estado).toBe("pendiente"); // el fixture no conecta ningun numero
    expect(por("catalogo_pos")).toMatchObject({ estado: "externo", responsable: "distribuidor_pos" });
    expect(body.listoParaOperar).toBe(false);
    expect(body.resumen.total).toBe(body.items.length);
  });

  it("refleja los cambios: al configurar el agente y poner nombre, los puntos pasan a hecho", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.restaurantesRepo.upsertWhatsAppAgentConfig(ctx.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Taqueria", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
    const body = await json(await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.admin.token)));
    expect(body.items.find((i: { id: string }) => i.id === "agente_whatsapp").estado).toBe("hecho");
    expect(body.items.find((i: { id: string }) => i.id === "nombre_del_asistente").estado).toBe("hecho");
  });

  it("admin tambien lo ve; staff acotado a una sucursal y repartidor NO (403); otra organizacion NO (403); sin sesion 401", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.admin.token))).status).toBe(200);
    expect((await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
    expect((await app.request(urlDe(ctx.propertyIdA))).status).toBe(401);
  });

  it("cross-tenant: el owner de otra organizacion no lo lee ni apuntando a su propia sucursal con datos ajenos", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const propio = await json(await app.request(urlDe(ctx.otherPropertyId), authedGet(ctx.staff.otroOrgOwner.token)));
    // Ve SU organizacion (sin sucursales activas con menu), nunca la de A.
    expect(JSON.stringify(propio)).not.toContain(ctx.organizationId);
    expect((await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
  });
});
