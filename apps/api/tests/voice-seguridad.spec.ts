// Aislamiento de voz entre numeros y sucursales (token por llamada, secreto por sucursal, maquina de
// estados, limites y bitacora). Cada caso afirma el EFECTO observable por HTTP real (`app.request`) sobre
// el repositorio en memoria.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { hashVoiceSecret } from "../src/routes/verticals/restaurantes/voice-auth.ts";
import { signVoiceCallToken, voiceCallTokenKey } from "../src/voice-call-token.ts";
import { authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { buildTestDeps, jsonRequestInit, TEST_ENV } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const LEGACY = { "x-atiende-tool-secret": "test-voice-tool-secret" };
const tokenHeader = (token: string) => ({ "x-atiende-call-token": token });

async function setup(envOverride: Partial<typeof TEST_ENV> = {}) {
  const ctx = await buildTestDeps();
  const deps = { ...ctx.deps, env: { ...ctx.deps.env, ...envOverride } };
  const app = buildApp(deps);
  const propertyB = randomUUID();
  ctx.restaurantesRepo.seedBranch({ propertyId: propertyB, organizationId: ctx.organizationId, name: "Otra Sucursal", slug: "otra", status: "active", phone: null, address: null, lat: null, lng: null });
  const mint = async (callId: string, phone: string, headers: Record<string, string> = LEGACY, extra: Record<string, unknown> = { branch_slug: "fco-montejo" }) => {
    const res = await app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: callId, caller_phone: phone, ...extra }, headers));
    return { res, body: (await res.json()) as { call_token?: string; branch_slug?: string; expires_at?: string } };
  };
  return { ...ctx, app, deps, propertyB, mint };
}

describe("emision del token por llamada", () => {
  it("con el secreto legado y branch_slug emite un token ligado a la sucursal; sin credencial es 401", async () => {
    const s = await setup();
    const ok = await s.mint("call-1", "+52 999 111 1111");
    expect(ok.res.status).toBe(200);
    expect(ok.body.call_token).toMatch(/^v1\./);
    expect(ok.body.branch_slug).toBe("fco-montejo");
    const sin = await s.mint("call-1", "9991111111", {});
    expect(sin.res.status).toBe(401);
  });

  it("400 con telefono invalido, call_id invalido o sucursal inexistente", async () => {
    const s = await setup();
    expect((await s.mint("call-1", "123")).res.status).toBe(400);
    expect((await s.mint("call con espacios", "9991111111")).res.status).toBe(400);
    expect((await s.mint("call-1", "9991111111", LEGACY, { branch_slug: "no-existe" })).res.status).toBe(400);
  });

  it("un token no puede emitir otro token (solo los secretos emiten)", async () => {
    const s = await setup();
    const { body } = await s.mint("call-1", "9991111111");
    const res = await s.app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: "c2", caller_phone: "9991111111", branch_slug: "fco-montejo" }, tokenHeader(body.call_token!)));
    expect(res.status).toBe(401);
  });
});

describe("historial por telefono: el telefono sale del token, no del body", () => {
  it("con token, pedir el historial de OTRO numero en el body devuelve el del llamante del token", async () => {
    const s = await setup();
    await s.restaurantesRepo.upsertCustomer(s.organizationId, "9991111111", "Ana");
    await s.restaurantesRepo.upsertCustomer(s.organizationId, "9992222222", "Beto");
    const { body } = await s.mint("call-1", "9991111111");
    const res = await s.app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({ phone: "9992222222" }, tokenHeader(body.call_token!)));
    expect(res.status).toBe(200);
    expect((await res.json()) as { name?: string }).toMatchObject({ name: "Ana" });
  });

  it("con token el body no necesita telefono", async () => {
    const s = await setup();
    await s.restaurantesRepo.upsertCustomer(s.organizationId, "9991111111", "Ana");
    const { body } = await s.mint("call-1", "9991111111");
    const res = await s.app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({}, tokenHeader(body.call_token!)));
    expect(res.status).toBe(200);
  });

  it("secreto de sucursal SIN token no puede consultar historial por telefono", async () => {
    const s = await setup();
    await s.restaurantesRepo.upsertCustomer(s.organizationId, "9992222222", "Beto");
    await s.restaurantesRepo.rotateVoiceBranchSecret(s.organizationId, s.propertyId, hashVoiceSecret("vbs_sucursal_a"), "_a", 3600);
    const res = await s.app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({ phone: "9992222222" }, { "x-atiende-tool-secret": "vbs_sucursal_a" }));
    expect(res.status).toBe(401);
  });

  it("camino legado (secreto global, sin token) sigue funcionando como antes", async () => {
    const s = await setup();
    await s.restaurantesRepo.upsertCustomer(s.organizationId, "9992222222", "Beto");
    const res = await s.app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({ phone: "9992222222" }, LEGACY));
    expect(res.status).toBe(200);
    expect((await res.json()) as { name?: string }).toMatchObject({ name: "Beto" });
  });
});

describe("tokens invalidos, vencidos o de otra organizacion/sucursal se rechazan", () => {
  it("token alterado o vencido => 401", async () => {
    const s = await setup();
    const { body } = await s.mint("call-1", "9991111111");
    // Alterar el primer carácter de la firma (última parte): usa sus 6 bits, así que SIEMPRE cambia el token.
    const partes = body.call_token!.split(".");
    const firma = partes.pop()!;
    const alterado = [...partes, `${firma[0] === "A" ? "B" : "A"}${firma.slice(1)}`].join(".");
    expect(alterado).not.toBe(body.call_token);
    expect((await s.app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({}, tokenHeader(alterado)))).status).toBe(401);
    const vencido = signVoiceCallToken(voiceCallTokenKey(s.deps.env.internalSecret), { org: s.organizationId, prop: s.propertyId, call: "c", ph: "9991111111", iat: 1, exp: 2 });
    expect((await s.app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({}, tokenHeader(vencido)))).status).toBe(401);
  });

  it("token firmado con OTRA llave (otro despliegue) => 401", async () => {
    const s = await setup();
    const now = Math.floor(Date.now() / 1000);
    const ajeno = signVoiceCallToken(voiceCallTokenKey("otro-secreto"), { org: s.organizationId, prop: s.propertyId, call: "c", ph: "9991111111", iat: now, exp: now + 600 });
    expect((await s.app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({}, tokenHeader(ajeno)))).status).toBe(401);
  });

  it("token de OTRA organizacion usado contra esta => 401", async () => {
    const s = await setup();
    const otraOrg = randomUUID();
    s.restaurantesRepo.seedOrganization({ id: otraOrg, slug: "otro-restaurante", name: "Otro" });
    const now = Math.floor(Date.now() / 1000);
    const token = signVoiceCallToken(voiceCallTokenKey(s.deps.env.internalSecret), { org: otraOrg, prop: randomUUID(), call: "c", ph: "9991111111", iat: now, exp: now + 600 });
    expect((await s.app.request(`/v1/restaurantes/${ORG}/customers/lookup`, jsonRequestInit({}, tokenHeader(token)))).status).toBe(401);
    expect(s.restaurantesRepo.voiceToolAudit.some((a) => a.outcome === "denied" && a.detail === "token_otra_organizacion")).toBe(true);
  });

  it("token de la sucursal A no puede buscar productos, cotizar ni consultar la sucursal B", async () => {
    const s = await setup();
    const { body } = await s.mint("call-1", "9991111111");
    const h = tokenHeader(body.call_token!);
    const buscar = await s.app.request(`/v1/restaurantes/${ORG}/products/search`, jsonRequestInit({ query: "coca", branch_slug: "otra" }, h));
    expect(buscar.status).toBe(400);
    expect(((await buscar.json()) as { message: string }).message).toMatch(/otra sucursal/);
    const cotizar = await s.app.request(`/v1/restaurantes/${ORG}/orders/quote`, jsonRequestInit({ branch_slug: "otra", items: [{ product_id: s.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }] }, h));
    expect(cotizar.status).toBe(400);
    expect(((await cotizar.json()) as { message: string }).message).toMatch(/otra sucursal/);
    const info = await s.app.request(`/v1/restaurantes/${ORG}/branches/info`, jsonRequestInit({ branch_slug: "otra" }, h));
    expect(info.status).toBe(400);
    expect(((await info.json()) as { message: string }).message).toMatch(/otra sucursal/);
    const propia = await s.app.request(`/v1/restaurantes/${ORG}/branches/info`, jsonRequestInit({ branch_slug: "fco-montejo" }, h));
    expect(propia.status).toBe(200);
  });
});

describe("secreto por sucursal", () => {
  it("un secreto de la sucursal A emite tokens para A, NO para B; el secreto global sigue valido", async () => {
    const s = await setup();
    await s.restaurantesRepo.rotateVoiceBranchSecret(s.organizationId, s.propertyId, hashVoiceSecret("vbs_a"), "s_a", 3600);
    const propio = await s.mint("c1", "9991111111", { "x-atiende-tool-secret": "vbs_a" }, {});
    expect(propio.res.status).toBe(200);
    expect(propio.body.branch_slug).toBe("fco-montejo");
    const ajeno = await s.mint("c2", "9991111111", { "x-atiende-tool-secret": "vbs_a" }, { branch_slug: "otra" });
    expect(ajeno.res.status).toBe(403);
    expect((await s.mint("c3", "9991111111", LEGACY)).res.status).toBe(200);
  });

  it("un secreto de sucursal de OTRA organizacion no se acepta", async () => {
    const s = await setup();
    const otraOrg = randomUUID();
    s.restaurantesRepo.seedOrganization({ id: otraOrg, slug: "otro-restaurante", name: "Otro" });
    await s.restaurantesRepo.rotateVoiceBranchSecret(otraOrg, randomUUID(), hashVoiceSecret("vbs_otra_org"), "_org", 3600);
    expect((await s.mint("c1", "9991111111", { "x-atiende-tool-secret": "vbs_otra_org" }, {})).res.status).toBe(401);
  });

  it("rotacion: el secreto anterior sigue valido solo en la ventana de gracia", async () => {
    const s = await setup();
    await s.restaurantesRepo.rotateVoiceBranchSecret(s.organizationId, s.propertyId, hashVoiceSecret("v1"), "v1", 3600);
    await s.restaurantesRepo.rotateVoiceBranchSecret(s.organizationId, s.propertyId, hashVoiceSecret("v2"), "v2", 3600);
    expect((await s.mint("c1", "9991111111", { "x-atiende-tool-secret": "v1" }, {})).res.status).toBe(200);
    expect((await s.mint("c2", "9991111111", { "x-atiende-tool-secret": "v2" }, {})).res.status).toBe(200);
    await s.restaurantesRepo.rotateVoiceBranchSecret(s.organizationId, s.propertyId, hashVoiceSecret("v3"), "v3", 0);
    expect((await s.mint("c3", "9991111111", { "x-atiende-tool-secret": "v2" }, {})).res.status).toBe(401);
  });

  it("base sin migrar (secretos por sucursal no disponibles): cae al secreto global legado sin romper", async () => {
    const s = await setup();
    s.restaurantesRepo.voiceSecretsUnavailable = true;
    expect((await s.mint("c1", "9991111111")).res.status).toBe(200);
    expect((await s.mint("c2", "9991111111", { "x-atiende-tool-secret": "vbs_cualquiera" }, {})).res.status).toBe(401);
  });
});

describe("VOICE_REQUIRE_CALL_TOKEN=true", () => {
  it("las herramientas exigen el token; los secretos solo sirven para emitirlo", async () => {
    const s = await setup({ voiceRequireCallToken: true });
    const legado = await s.app.request(`/v1/restaurantes/${ORG}/products/search`, jsonRequestInit({ query: "coca", branch_slug: "fco-montejo" }, LEGACY));
    expect(legado.status).toBe(401);
    const { res, body } = await s.mint("c1", "9991111111");
    expect(res.status).toBe(200);
    const conToken = await s.app.request(`/v1/restaurantes/${ORG}/products/search`, jsonRequestInit({ query: "coca", branch_slug: "fco-montejo" }, tokenHeader(body.call_token!)));
    expect(conToken.status).toBe(200);
  });
});

describe("maquina de estados por llamada (pedido sin cotizacion se rechaza)", () => {
  const items = (s: { products: Record<string, string> }) => [{ product_id: s.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];

  it("crear pedido sin cotizar => 400 y NO se crea; cotizar -> confirmar -> crear crea el pedido con el telefono DEL TOKEN", async () => {
    const s = await setup();
    const { body } = await s.mint("call-9", "+52 999 333 3333");
    const h = tokenHeader(body.call_token!);
    const pedido = { branch_slug: "fco-montejo", customer_name: "Carla", customer_address: "Calle 1", customer_phone: "9994444444", payment_method: "efectivo", items: items(s), source: "voice" };

    const sinCotizar = await s.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(pedido, h));
    expect(sinCotizar.status).toBe(400);
    expect(((await sinCotizar.json()) as { message: string }).message).toMatch(/cotizaci/i);
    expect(await s.restaurantesRepo.findCustomerByPhone(s.organizationId, "9993333333")).toBeNull();

    const quote = await s.app.request(`/v1/restaurantes/${ORG}/orders/quote`, jsonRequestInit({ branch_slug: "fco-montejo", items: items(s) }, h));
    expect(quote.status).toBe(200);
    const q = (await quote.json()) as { quote: { total: number }; quote_hash: string };
    expect(q.quote_hash).toMatch(/^[0-9a-f]{32}$/);

    const sinConfirmar = await s.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(pedido, h));
    expect(sinConfirmar.status).toBe(400);

    const confirmar = await s.app.request(`/v1/restaurantes/${ORG}/orders/confirm`, jsonRequestInit({ quote_hash: q.quote_hash }, h));
    expect(confirmar.status).toBe(200);

    const creado = await s.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(pedido, h));
    expect(creado.status).toBe(200);
    // El pedido quedo a nombre del telefono del TOKEN, nunca del body que escribio el modelo.
    expect(await s.restaurantesRepo.findCustomerByPhone(s.organizationId, "9993333333")).not.toBeNull();
    expect(await s.restaurantesRepo.findCustomerByPhone(s.organizationId, "9994444444")).toBeNull();

    // QA-caos-14: el reintento tras un pedido ya creado devuelve el pedido existente (mismo id, ya_registrado) en vez de un 400 sin id,
    // para que la llamada cuente el objetivo; no se crea un segundo pedido.
    const repetido = await s.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(pedido, h));
    expect(repetido.status).toBe(200);
    const repetidoBody = (await repetido.json()) as { order: { id: string }; ya_registrado?: boolean };
    const creadoBody = (await creado.clone().json()) as { order: { id: string } };
    expect(repetidoBody.ya_registrado).toBe(true);
    expect(repetidoBody.order.id).toBe(creadoBody.order.id);
  });

  it("el estado es POR LLAMADA: la cotizacion de una llamada no habilita crear en otra", async () => {
    const s = await setup();
    const a = (await s.mint("call-A", "9991111111")).body.call_token!;
    const b = (await s.mint("call-B", "9992222222")).body.call_token!;
    await s.app.request(`/v1/restaurantes/${ORG}/orders/quote`, jsonRequestInit({ branch_slug: "fco-montejo", items: items(s) }, tokenHeader(a)));
    await s.app.request(`/v1/restaurantes/${ORG}/orders/confirm`, jsonRequestInit({}, tokenHeader(a)));
    const pedido = { branch_slug: "fco-montejo", customer_name: "X", customer_address: "Calle 1", payment_method: "efectivo", items: items(s), source: "voice" };
    const enB = await s.app.request(`/v1/restaurantes/${ORG}/orders`, jsonRequestInit(pedido, tokenHeader(b)));
    expect(enB.status).toBe(400);
  });

  it("confirmar y escalar exigen token (el estado y el telefono viven en la llamada)", async () => {
    const s = await setup();
    expect((await s.app.request(`/v1/restaurantes/${ORG}/orders/confirm`, jsonRequestInit({}, LEGACY))).status).toBe(401);
    expect((await s.app.request(`/v1/restaurantes/${ORG}/callbacks`, jsonRequestInit({ customer_name: "A", motivo: "queja" }, LEGACY))).status).toBe(401);
    const token = (await s.mint("call-1", "9991111111")).body.call_token!;
    const ok = await s.app.request(`/v1/restaurantes/${ORG}/callbacks`, jsonRequestInit({ customer_name: "A", motivo: "queja", resumen: "frío" }, tokenHeader(token)));
    expect(ok.status).toBe(200);
  });
});

describe("limites por llamada/sucursal y bitacora", () => {
  it("la llamada 121 de un mismo token recibe 429 y queda en la bitacora", async () => {
    const s = await setup();
    const token = (await s.mint("call-limit", "9991111111")).body.call_token!;
    let last = 0;
    for (let i = 0; i < 121; i += 1) {
      last = (await s.app.request(`/v1/restaurantes/${ORG}/branches/info`, jsonRequestInit({ branch_slug: "fco-montejo" }, tokenHeader(token)))).status;
    }
    expect(last).toBe(429);
    expect(s.restaurantesRepo.voiceToolAudit.some((a) => a.outcome === "rate_limited" && a.callId === "call-limit")).toBe(true);
  });

  it("registra emision de token, uso ok y denegaciones, sin telefono en claro", async () => {
    const s = await setup();
    const token = (await s.mint("call-audit", "9991111111")).body.call_token!;
    await s.app.request(`/v1/restaurantes/${ORG}/branches/info`, jsonRequestInit({ branch_slug: "fco-montejo" }, tokenHeader(token)));
    await s.app.request(`/v1/restaurantes/${ORG}/products/search`, jsonRequestInit({ query: "x", branch_slug: "otra" }, tokenHeader(token)));
    const audit = s.restaurantesRepo.voiceToolAudit;
    expect(audit.map((a) => a.outcome)).toEqual(expect.arrayContaining(["token_issued", "ok", "denied"]));
    expect(JSON.stringify(audit)).not.toContain("9991111111");
    expect(audit.every((a) => a.phoneHash === null || /^[0-9a-f]{64}$/.test(a.phoneHash))).toBe(true);
  });
});

describe("rotacion del secreto de sucursal por staff (owner/admin)", () => {
  it("owner rota el secreto de su sucursal: lo recibe UNA vez en claro, el secreto emite tokens y la bitacora no lo guarda", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdB}/voz/secreto`;
    const res = await app.request(url, authedJson(ctx.staff.owner.token, {}, "POST"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { secret: string; hint: string };
    expect(body.secret).toMatch(/^vbs_/);
    expect((await ctx.restaurantesRepo.verifyVoiceBranchSecret(ctx.organizationId, hashVoiceSecret(body.secret))).status).toBe("match");
    const entrada = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.secreto_voz_rotado");
    expect(entrada).toBeDefined();
    expect(JSON.stringify(entrada)).not.toContain(body.secret);
  });

  it("staff sin rol owner/admin => 403; repartidor => 403; otra organizacion no puede rotar", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/voz/secreto`;
    expect((await app.request(url, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.repartidor.token, {}, "POST"))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.otroOrgOwner.token, {}, "POST"))).status).toBeGreaterThanOrEqual(400);
    const ajena = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.otherPropertyId}/voz/secreto`;
    expect((await app.request(ajena, authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBeGreaterThanOrEqual(400);
  });

  it("base sin migrar => 503 honesto (nunca 500)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.voiceSecretsUnavailable = true;
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${ctx.propertyIdA}/voz/secreto`, authedJson(ctx.staff.owner.token, {}, "POST"));
    expect(res.status).toBe(503);
  });
});

