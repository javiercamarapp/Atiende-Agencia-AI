// WhatsApp Embedded Signup por sucursal (detras de configuracion), contra el doble en memoria y un Graph API falso (fetch global
// sustituido solo para graph.facebook.com): «no disponible aún» con la lista de lo que falta, conexion feliz que guarda el ruteo y
// devuelve el PIN una vez, fallo de Meta traducido sin secretos, permisos y alcance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDefaultRateLimiterForTests } from "@atiende/core-ratelimit";
import { buildApp } from "../src/app.ts";
import { faltantesEmbeddedSignup } from "../src/routes/verticals/restaurantes/whatsapp-embedded-signup.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const TOKEN = "EAAB" + "z".repeat(40);
const ENV_ES = { whatsappEmbeddedSignup: true, metaAppId: "1234567890", whatsappEsConfigId: "555666777", whatsappSystemUserId: "998877", whatsappAccessToken: "token-plataforma-de-prueba" };
const originalFetch = globalThis.fetch;

function stubGraph(opciones: { fallaEn?: string } = {}) {
  const llamadas: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (new URL(u).hostname !== "graph.facebook.com") return originalFetch(url as never, init);
      llamadas.push(`${init?.method ?? "GET"} ${new URL(u).pathname}`);
      const ruta = new URL(u).pathname;
      if (opciones.fallaEn && ruta.endsWith(opciones.fallaEn)) return new Response(JSON.stringify({ error: { message: `fallo con ${TOKEN}`, code: 100 } }), { status: 400 });
      if (ruta.endsWith("/oauth/access_token")) return new Response(JSON.stringify({ access_token: TOKEN }), { status: 200 });
      if (ruta.endsWith("/phone_numbers")) return new Response(JSON.stringify({ data: [{ id: "555000111", display_phone_number: "+52 999 123 4567", verified_name: "Los Taquitos" }] }), { status: 200 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }),
  );
  return llamadas;
}

async function setup(env: Record<string, unknown> = ENV_ES) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp({ ...ctx.deps, env: { ...ctx.deps.env, ...env } });
  const url = (branch = ctx.propertyIdA) => `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sucursales/${branch}/whatsapp/embedded-signup`;
  return { ctx, app, url };
}

const CUERPO = { code: "AQBcodigo-de-meta-123", wabaId: "1234567", phoneNumberId: "555000111" };

beforeEach(() => resetDefaultRateLimiterForTests());
afterEach(() => vi.unstubAllGlobals());

describe("Embedded Signup de WhatsApp por sucursal", () => {
  it("apagado por omision: GET dice no disponible con los NOMBRES de lo que falta; POST 503 sin tocar Meta", async () => {
    const llamadas = stubGraph();
    const t = await setup({});
    const res = await t.app.request(t.url(), authedGet(t.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; faltantes: string[]; appId: string | null };
    expect(body.disponible).toBe(false);
    expect(body.faltantes).toEqual(expect.arrayContaining(["WHATSAPP_EMBEDDED_SIGNUP", "META_APP_ID", "WHATSAPP_ES_CONFIG_ID", "WHATSAPP_SYSTEM_USER_ID"]));
    expect(body.appId).toBeNull();
    expect((await t.app.request(t.url(), authedJson(t.ctx.staff.owner.token, CUERPO))).status).toBe(503);
    expect(llamadas).toHaveLength(0);
  });

  it("configurado: conecta, guarda el ruteo de la sucursal, devuelve el PIN una vez y nunca el token", async () => {
    const llamadas = stubGraph();
    const t = await setup();
    const cfg = (await (await t.app.request(t.url(), authedGet(t.ctx.staff.owner.token))).json()) as { disponible: boolean; appId: string; configId: string };
    expect(cfg).toMatchObject({ disponible: true, appId: "1234567890", configId: "555666777" });

    const res = await t.app.request(t.url(), authedJson(t.ctx.staff.owner.token, CUERPO));
    expect(res.status).toBe(201);
    const texto = await res.text();
    expect(texto).not.toContain(TOKEN);
    const body = JSON.parse(texto) as { phoneNumberId: string; numero: string; pin: string };
    expect(body.phoneNumberId).toBe("555000111");
    expect(body.numero).toBe("+52 999 123 4567");
    expect(body.pin).toMatch(/^\d{6}$/);
    expect(llamadas).toHaveLength(5);
    const canales = await t.ctx.restaurantesRepo.listWhatsappBranchChannels(t.ctx.organizationId);
    expect(canales.find((n) => n.propertyId === t.ctx.propertyIdA)?.phoneNumberId).toBe("555000111");
  });

  it("Meta falla en un paso: 409 con mensaje legible sin secretos y sin guardar ruteo", async () => {
    stubGraph({ fallaEn: "/register" });
    const t = await setup();
    const res = await t.app.request(t.url(), authedJson(t.ctx.staff.owner.token, CUERPO));
    expect(res.status).toBe(409);
    const texto = await res.text();
    expect(texto).not.toContain(TOKEN);
    expect(texto).toContain("registrar el número");
    expect((await t.ctx.restaurantesRepo.listWhatsappBranchChannels(t.ctx.organizationId)).some((n) => n.propertyId === t.ctx.propertyIdA)).toBe(false);
  });

  it("validacion 400, staff 403, sucursal de otra organizacion 404, tope 429", async () => {
    stubGraph();
    const t = await setup();
    expect((await t.app.request(t.url(), authedJson(t.ctx.staff.owner.token, { ...CUERPO, wabaId: "../x" }))).status).toBe(400);
    expect((await t.app.request(t.url(), authedJson(t.ctx.staff.staffSucursalA.token, CUERPO))).status).toBe(403);
    expect((await t.app.request(t.url(t.ctx.otherPropertyId), authedJson(t.ctx.staff.owner.token, CUERPO))).status).toBe(404);
    for (let i = 0; i < 10; i++) await t.app.request(t.url(), authedJson(t.ctx.staff.owner.token, CUERPO));
    expect((await t.app.request(t.url(), authedJson(t.ctx.staff.owner.token, CUERPO))).status).toBe(429);
  });

  it("faltantesEmbeddedSignup solo lista nombres de variables", () => {
    expect(faltantesEmbeddedSignup({ ...TEST_ENV, ...ENV_ES })).toEqual([]);
    expect(faltantesEmbeddedSignup(TEST_ENV)).toEqual(["WHATSAPP_EMBEDDED_SIGNUP", "META_APP_ID", "WHATSAPP_ES_CONFIG_ID", "WHATSAPP_SYSTEM_USER_ID", "WHATSAPP_ACCESS_TOKEN"]);
  });
});
