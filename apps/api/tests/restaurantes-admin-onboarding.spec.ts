// R-33 -- GET /v1/restaurantes/:propertyId/admin/onboarding por HTTP real sobre repos en memoria: checklist calculado con datos
// reales, solo owner/admin con acceso a TODA la organizacion, aislamiento entre organizaciones y sin 401/403 mal mapeados.
import { describe, expect, it } from "vitest";
import { FakeVoiceProvider, InMemoryPrivacidadRepository, InMemoryVozRepository, PostgresPrivacidadRepository, PostgresVozRepository } from "@atiende/domain-restaurantes";
import { PRIVACY_CONFIG_POR_DEFECTO } from "../../../packages/domain-restaurantes/src/privacidad/aviso.ts";
import { AbortAwareFakeSession } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";
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

describe("checklist de onboarding: voz, aviso de privacidad y gate", () => {
  const porId = (body: { items: { id: string }[] }, id: string) => body.items.find((i) => i.id === id);
  const gateUrl = (propertyId: string) => `${urlDe(propertyId)}/gate`;

  it("sin repositorios de voz ni privacidad en el despliegue: voz queda pendiente y el aviso externo (no bloquea); nunca 500", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const body = await json(await buildApp(ctx.deps).request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token)));
    expect(porId(body, "voz")).toMatchObject({ estado: "pendiente", pantalla: "agente-voz", obligatorio: false });
    expect(porId(body, "aviso_privacidad")).toMatchObject({ estado: "externo", obligatorio: false, pantalla: "privacidad" });
  });

  it("con voz y privacidad migradas: voz deshabilitada a proposito = hecho; sin aviso = pendiente obligatorio que activa el gate", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const voz = new InMemoryVozRepository();
    // El dueño decide la voz en CADA sucursal de la organizacion.
    for (const b of await ctx.restaurantesRepo.listBranchesForOrganizationAdmin(ctx.organizationId)) {
      voz.seedProperty(b.propertyId, ctx.organizationId);
      await voz.upsertConfig(ctx.organizationId, b.propertyId, { habilitado: false, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "" });
    }
    const privacidad = new InMemoryPrivacidadRepository();
    const app = buildApp({ ...ctx.deps, vozRepo: () => voz, privacidadRepo: () => privacidad, voiceProvider: new FakeVoiceProvider() });
    const body = await json(await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token)));
    expect(porId(body, "voz").estado).toBe("hecho");
    expect(porId(body, "aviso_privacidad")).toMatchObject({ estado: "pendiente", obligatorio: true });
    expect(body.listoParaOperar).toBe(false);
    expect(body.gate).toMatchObject({ bloquea: true, operaConPedidos: false });

    const gate = await app.request(gateUrl(ctx.propertyIdA), authedGet(ctx.staff.admin.token));
    expect(gate.status).toBe(200);
    expect(gate.headers.get("cache-control")).toBe("no-store");
    expect(await gate.json()).toMatchObject({ bloquea: true, listoParaOperar: false, operaConPedidos: false });

    // Publicado el aviso, el punto pasa a hecho (solo cuenta una URL real, no la fila por defecto).
    privacidad.configs.set(ctx.organizationId, { ...PRIVACY_CONFIG_POR_DEFECTO, configurada: true, noticeUrl: "https://ejemplo.mx/aviso" });
    const despues = await json(await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token)));
    expect(porId(despues, "aviso_privacidad").estado).toBe("hecho");
  });

  it("gate: staff acotado, repartidor y otra organizacion reciben 403; sin sesion 401", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(gateUrl(ctx.propertyIdA), authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(gateUrl(ctx.propertyIdA), authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(gateUrl(ctx.propertyIdA), authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
    expect((await app.request(gateUrl(ctx.propertyIdA))).status).toBe(401);
  });

  it("base sin migrar (025 y 030) con la transaccion en estado abortado: 200, voz sin configurar, aviso pendiente y la sesion sigue viva", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const sinTabla = (code: "42P01" | "42883") => Object.assign(new Error("objeto inexistente"), { code });
    const session = new AbortAwareFakeSession([
      { match: /branch_voice_config/i, respond: () => { throw sinTabla("42P01"); } },
      { match: /privacy_config/i, respond: () => { throw sinTabla("42P01"); } },
      { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const app = buildApp({ ...ctx.deps, vozRepo: () => new PostgresVozRepository(session), privacidadRepo: () => new PostgresPrivacidadRepository(session), voiceProvider: new FakeVoiceProvider() });
    const res = await app.request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(porId(body, "voz").estado).toBe("pendiente");
    expect(porId(body, "aviso_privacidad")).toMatchObject({ estado: "pendiente", obligatorio: true });
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
});
