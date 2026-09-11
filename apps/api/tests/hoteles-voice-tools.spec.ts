// Fase 2 hoteles §1 — Server Tools HTTP reales para el agente de voz de ElevenLabs.
// Mismo patrón de test que voice-tools.spec.ts (restaurantes): HTTP real vía
// `app.request`, sobre fixtures in-memory, sin mocks de la lógica de negocio.
//
// Cubre la divergencia deliberada del diseño §1/§5.1: el secreto es POR PROPERTY
// (hoteles.voice_agent_config), no compartido de plataforma — así que estos tests
// verifican explícitamente que dos properties nunca comparten secreto, y que el
// endpoint de rotación (staff ADMIN_ROLES) es el único que puede crearlo/rotarlo.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

describe("POST /v1/hoteles/:propertyId/voz/tickets-fnb — crear_ticket_huesped_fnb", () => {
  it("503 si la property nunca configuró su agente de voz", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`, jsonRequestInit({ mensaje: "Quiero dos cafés" }, { "x-atiende-tool-secret": "lo-que-sea" }));
    expect(res.status).toBe(503);
  });

  it("401 con el secreto equivocado, incluso una vez configurado el agente", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "el-secreto-correcto-de-esta-property", true);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`, jsonRequestInit({ mensaje: "Quiero dos cafés" }, { "x-atiende-tool-secret": "un-secreto-equivocado" }));
    expect(res.status).toBe(401);
  });

  it("AISLAMIENTO POR TENANT (diseño §1/§5.1): el secreto de OTRA property nunca sirve para esta", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "secreto-de-esta-property", true);
    // Otra property con su propio secreto, distinto.
    const otraPropertyId = "00000000-0000-4000-8000-000000000099";
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(otraPropertyId, ctx.organizationId, "secreto-de-la-otra-property", true);

    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`, jsonRequestInit({ mensaje: "Quiero dos cafés" }, { "x-atiende-tool-secret": "secreto-de-la-otra-property" }));
    expect(res.status).toBe(401);
  });

  it("503 si el agente está deshabilitado (enabled:false), aunque el secreto sea correcto", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "secreto-de-esta-property", false);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`, jsonRequestInit({ mensaje: "Quiero dos cafés" }, { "x-atiende-tool-secret": "secreto-de-esta-property" }));
    expect(res.status).toBe(503);
  });

  it("400 si falta mensaje", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "secreto-de-esta-property", true);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`, jsonRequestInit({}, { "x-atiende-tool-secret": "secreto-de-esta-property" }));
    expect(res.status).toBe(400);
  });

  it("crea el ticket real (actor system:voz, sin staff logueado) y NUNCA afirma que el platillo es seguro incluso con alergia declarada", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "secreto-de-esta-property", true);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`,
      jsonRequestInit({ mensaje: "Un club sandwich, soy alérgico a las nueces", habitacion: "812", alergia_declarada: true }, { "x-atiende-tool-secret": "secreto-de-esta-property" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; alergiaDeclarada: boolean; mensaje: string };
    expect(body.alergiaDeclarada).toBe(true);
    expect(body.mensaje).not.toMatch(/es seguro/i);
    expect(body.mensaje).toMatch(/cocina/i);

    const order = await ctx.deps.hotelesRepo.findFnbOrder(ctx.propertyId, body.id);
    expect(order).not.toBeNull();
    expect(order!.createdBy).toBeNull(); // actor system:voz.
    expect(order!.kitchenConfirmedBy).toBeNull();
    expect(order!.safetyAssuranceSentAt).toBeNull();
  });

  it("una alergia detectada solo en texto libre (sin el flag estructurado) también queda marcada — fail-closed real, no solo en el canal de staff", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "secreto-de-esta-property", true);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`,
      jsonRequestInit({ mensaje: "Una pasta, soy intolerante al gluten" }, { "x-atiende-tool-secret": "secreto-de-esta-property" }),
    );
    const body = (await res.json()) as { id: string; alergiaDeclarada: boolean };
    expect(body.alergiaDeclarada).toBe(true);
    const order = await ctx.deps.hotelesRepo.findFnbOrder(ctx.propertyId, body.id);
    expect(order!.allergyDeclaredVia).toBe("texto_libre");
  });
});

describe("POST /v1/hoteles/:propertyId/voz/contacto-no-operativo — registrar_contacto_no_operativo", () => {
  it("401 sin secreto y 400 sin motivo, con el secreto correcto", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "secreto-de-esta-property", true);
    const app = buildApp(ctx.deps);
    const noAuth = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/contacto-no-operativo`, jsonRequestInit({ motivo: "queja" }));
    expect(noAuth.status).toBe(401);
    const noMotivo = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/contacto-no-operativo`, jsonRequestInit({}, { "x-atiende-tool-secret": "secreto-de-esta-property" }));
    expect(noMotivo.status).toBe(400);
  });

  it("registra el contacto real, nunca crea un pedido de F&B", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    await ctx.deps.hotelesRepo.upsertVoiceAgentConfig(ctx.propertyId, ctx.organizationId, "secreto-de-esta-property", true);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/hoteles/${ctx.propertyId}/voz/contacto-no-operativo`,
      jsonRequestInit({ motivo: "factura", resumen: "Pide factura del hospedaje" }, { "x-atiende-tool-secret": "secreto-de-esta-property" }),
    );
    expect(res.status).toBe(200);
    const orders = await ctx.deps.hotelesRepo.listFnbOrders(ctx.propertyId);
    expect(orders).toHaveLength(0);
  });
});

describe("POST /hoteles/:propertyId/voz/config — rotación del secreto de voz (staff ADMIN_ROLES)", () => {
  it("401 sin sesión de staff", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/voz/config`, jsonRequestInit({}));
    expect(res.status).toBe(401);
  });

  it("403 con staff que no es ADMIN_ROLES (frontdesk no puede rotar el secreto de voz)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/voz/config`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(res.status).toBe(403);
  });

  it("owner puede rotar/crear el secreto — el valor nuevo funciona de inmediato contra el tool endpoint", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const rotate = await app.request(`/hoteles/${ctx.propertyId}/voz/config`, authedJson(ctx.staff.owner.token, { enabled: true }));
    expect(rotate.status).toBe(200);
    const { toolWebhookSecret } = (await rotate.json()) as { toolWebhookSecret: string; enabled: boolean };
    expect(toolWebhookSecret.length).toBeGreaterThanOrEqual(16);

    const toolRes = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`, jsonRequestInit({ mensaje: "Dos aguas" }, { "x-atiende-tool-secret": toolWebhookSecret }));
    expect(toolRes.status).toBe(200);
  });

  it("rotar dos veces invalida el secreto anterior", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const first = await app.request(`/hoteles/${ctx.propertyId}/voz/config`, authedJson(ctx.staff.owner.token, {}));
    const { toolWebhookSecret: firstSecret } = (await first.json()) as { toolWebhookSecret: string };
    await app.request(`/hoteles/${ctx.propertyId}/voz/config`, authedJson(ctx.staff.owner.token, {}));

    const res = await app.request(`/v1/hoteles/${ctx.propertyId}/voz/tickets-fnb`, jsonRequestInit({ mensaje: "Dos aguas" }, { "x-atiende-tool-secret": firstSecret }));
    expect(res.status).toBe(401);
  });
});
