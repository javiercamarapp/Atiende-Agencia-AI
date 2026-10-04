// R-38 / R-43 -- marca publica en el storefront, sitemap, "Sitio publico" del panel y solicitud publica de evento, por HTTP real
// sobre el repositorio en memoria. Cubre origen no permitido, limite de tasa (IP y telefono), honeypot, validacion estricta,
// aislamiento cross-tenant, owner/admin vs staff y la marca sin migrar.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const ORG = "los-taquitos-de-pm";
const BASE = `/v1/restaurantes/${ORG}/storefront`;
const ORIGIN = { origin: "http://localhost:5173" };

// Un dia lejano pero valido (la validacion usa la fecha real del servidor): hoy + ~1 ano.
function fechaFutura(): string {
  const d = new Date(Date.now() + 365 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const EVENTO = () => ({ nombre: "Ana Pérez", telefono: "999 123 4567", fechaEvento: fechaFutura(), personas: 40, sucursal: "fco-montejo", comentario: "Boda, mesa de tacos", aceptaAviso: true });

async function setup() {
  const t = await buildTestDeps();
  const app = buildApp(t.deps);
  const post = (body: Record<string, unknown>, headers: Record<string, string> = ORIGIN, org = ORG) => app.request(`/v1/restaurantes/${org}/storefront/eventos`, jsonRequestInit(body, headers));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  return { ...t, app, post, json };
}

describe("GET storefront: marca, promociones y whatsapp por sucursal", () => {
  it("sin marca guardada devuelve la marca vacia (portada generica) y sin promociones", async () => {
    const s = await setup();
    const body = await s.json(await s.app.request(BASE));
    expect(body.marca).toMatchObject({ titular: null, portadaUrl: null, logoUrl: null, instagramUrl: null });
    expect(body.promociones).toEqual([]);
    expect(body.sucursales[0]).toHaveProperty("whatsappUrl");
  });

  it("con marca y una promocion automatica vigente las publica; una promocion por codigo no se publica", async () => {
    const s = await setup();
    await s.restaurantesRepo.upsertStorefrontMarca(s.organizationId, {
      titular: "Tacos con historia",
      eslogan: "Desde 1980",
      about: "Somos de Mérida",
      portadaUrl: "https://cdn.example.com/p.jpg",
      logoUrl: null,
      instagramUrl: "https://instagram.com/lostaquitos",
      facebookUrl: null,
      tiktokUrl: null,
    });
    await s.restaurantesRepo.createPromotion(s.organizationId, { code: "LUNES2X1", name: "Lunes 2x1", type: "bogo", value: 1, autoApply: true, channels: ["recoger"], daysOfWeek: [1] });
    await s.restaurantesRepo.createPromotion(s.organizationId, { code: "SECRETO10", name: "Codigo interno", type: "percentage", value: 10 });
    const body = await s.json(await s.app.request(BASE));
    expect(body.marca).toMatchObject({ titular: "Tacos con historia", eslogan: "Desde 1980", instagramUrl: "https://instagram.com/lostaquitos" });
    expect(body.promociones).toHaveLength(1);
    expect(body.promociones[0]).toMatchObject({ nombre: "Lunes 2x1", beneficio: "2x1", canal: "recoger", dias: [1] });
    expect(JSON.stringify(body)).not.toMatch(/LUNES2X1|SECRETO10/);
  });

  it("la marca de una organizacion no aparece en el storefront de otra", async () => {
    const s = await setup();
    await s.restaurantesRepo.upsertStorefrontMarca("00000000-0000-4000-8000-0000000000ff", { titular: "Ajena", eslogan: null, about: null, portadaUrl: null, logoUrl: null, instagramUrl: null, facebookUrl: null, tiktokUrl: null });
    expect((await s.json(await s.app.request(BASE))).marca.titular).toBeNull();
  });
});

describe("GET storefront/sitemap.xml", () => {
  it("lista inicio, eventos y cada sucursal activa; nunca rastreo ni checkout; XML valido y cacheable", async () => {
    const s = await setup();
    const res = await s.app.request(`${BASE}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    expect(res.headers.get("cache-control")).toContain("public");
    const xml = await res.text();
    expect(xml).toContain(`/pedir/${ORG}</loc>`);
    expect(xml).toContain(`/pedir/${ORG}/eventos</loc>`);
    expect(xml).toContain(`/pedir/${ORG}/fco-montejo</loc>`);
    expect(xml).not.toMatch(/pedido|rastreo|checkout/);
  });
  it("404 con restaurante inexistente", async () => {
    const s = await setup();
    expect((await s.app.request(`/v1/restaurantes/no-existe/storefront/sitemap.xml`)).status).toBe(404);
  });
});

describe("POST storefront/eventos (R-43)", () => {
  it("crea una solicitud con motivo 'evento', canal web y la sucursal elegida; responde recibido", async () => {
    const s = await setup();
    const res = await s.post(EVENTO());
    expect(res.status).toBe(200);
    const body = await s.json(res);
    expect(body.recibido).toBe(true);
    const [cb] = s.restaurantesRepo.peekCallbackRequests();
    expect(cb).toMatchObject({ organizationId: s.organizationId, propertyId: s.propertyId, reason: "evento", source: "web", customerName: "Ana Pérez", customerPhone: "9991234567" });
    expect(cb!.message).toContain("Personas: 40");
    expect(cb!.message).toContain("Aviso de privacidad aceptado.");
    expect(body.solicitud).toBe(cb!.id);
  });

  it("403 con Origin no permitido y no se crea nada", async () => {
    const s = await setup();
    expect((await s.post(EVENTO(), { origin: "https://evil.example.com" })).status).toBe(403);
    expect(s.restaurantesRepo.peekCallbackRequests()).toHaveLength(0);
  });

  it("honeypot: el campo oculto lleno responde el MISMO exito pero no crea ni cuenta una solicitud", async () => {
    const s = await setup();
    const res = await s.post({ ...EVENTO(), sitio_web: "http://spam.example.com" });
    expect(res.status).toBe(200);
    expect(await s.json(res)).toEqual({ recibido: true });
    expect(s.restaurantesRepo.peekCallbackRequests()).toHaveLength(0);
  });

  it.each([
    [{ nombre: "" }, /nombre/],
    [{ telefono: "123" }, /teléfono/],
    [{ fechaEvento: "2020-01-01" }, /ya pasó/],
    [{ personas: 0 }, /personas/],
    [{ aceptaAviso: false }, /aviso de privacidad/],
    [{ sucursal: "no-existe" }, /sucursal/],
    [{ sucursal: undefined }, /sucursal/],
  ])("validacion estricta: %j -> 400 y nada se guarda", async (cambio, mensaje) => {
    const s = await setup();
    const res = await s.post({ ...EVENTO(), ...cambio });
    expect(res.status).toBe(400);
    expect((await s.json(res)).message).toMatch(mensaje);
    expect(s.restaurantesRepo.peekCallbackRequests()).toHaveLength(0);
  });

  it("una sucursal inactiva no recibe solicitudes", async () => {
    const s = await setup();
    s.restaurantesRepo.seedBranch({ propertyId: "00000000-0000-4000-8000-00000000c1c1", organizationId: s.organizationId, name: "Cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: null, lng: null });
    expect((await s.post({ ...EVENTO(), sucursal: "cerrada" })).status).toBe(400);
  });

  it("404 con restaurante inexistente", async () => {
    const s = await setup();
    expect((await s.post(EVENTO(), ORIGIN, "no-existe")).status).toBe(404);
  });

  it("base sin migrar (el registro falla con 42501/42883): 503 honesto con el motivo, nunca 500, y no queda nada a medias", async () => {
    for (const code of ["42501", "42883"]) {
      const s = await setup();
      s.restaurantesRepo.createCallbackRequest = async () => {
        throw Object.assign(new Error("permission denied for table callback_requests"), { code });
      };
      const res = await s.post(EVENTO());
      expect(res.status).toBe(503);
      expect((await s.json(res)).message).toMatch(/todavía no están disponibles/);
      expect(s.restaurantesRepo.peekCallbackRequests()).toHaveLength(0);
    }
  });

  it("un error inesperado (no de compatibilidad) NO se disfraza de 503: se propaga como 500", async () => {
    const s = await setup();
    s.restaurantesRepo.createCallbackRequest = async () => {
      throw new Error("boom");
    };
    expect((await s.post(EVENTO())).status).toBe(500);
  });

  it("cuerpo gigante: se rechaza antes de procesar", async () => {
    const s = await setup();
    const res = await s.post({ ...EVENTO(), comentario: "x".repeat(10_000) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(s.restaurantesRepo.peekCallbackRequests()).toHaveLength(0);
  });

  it("limite de tasa por IP: la sexta solicitud en un minuto recibe 429", async () => {
    const s = await setup();
    const headers = { ...ORIGIN, "x-forwarded-for": "203.0.113.50" };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await s.post({ ...EVENTO(), telefono: `999 000 00${i}0` }, headers)).status);
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
  });

  it("limite por telefono: el mismo numero no abre mas de 3 solicitudes por hora aunque cambie de IP", async () => {
    const s = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await s.post(EVENTO(), { ...ORIGIN, "x-forwarded-for": `203.0.113.${60 + i}` })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(s.restaurantesRepo.peekCallbackRequests()).toHaveLength(3);
  });
});

describe("PUT/GET .../admin/config/sitio-publico (panel, owner/admin)", () => {
  const MARCA = { titular: "Mi marca", eslogan: "Sabor de casa", about: "Hola", portadaUrl: "https://cdn.example.com/p.jpg", logoUrl: "", instagramUrl: "https://instagram.com/mimarca", facebookUrl: "", tiktokUrl: "" };

  it("owner guarda, lo lee de vuelta, se publica en el storefront y queda en la bitacora (un renglon por campo cambiado)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sitio-publico`;
    const antes = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(antes.status).toBe(200);
    expect(await antes.json()).toMatchObject({ guardada: false, marca: { titular: null } });
    const put = await app.request(url, authedJson(ctx.staff.owner.token, MARCA, "PUT"));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ guardada: true, marca: { titular: "Mi marca", logoUrl: null, instagramUrl: "https://instagram.com/mimarca" } });
    const despues = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(await despues.json()).toMatchObject({ guardada: true, marca: { eslogan: "Sabor de casa" } });
    const campos = ctx.restaurantesRepo.auditLog.filter((r) => r.action === "configuracion.sitio_publico_actualizado").map((r) => r.campo);
    expect(campos.sort()).toEqual(["eslogan", "about", "instagramUrl", "portadaUrl", "titular"].sort());
    // Un segundo guardado identico no agrega renglones.
    await app.request(url, authedJson(ctx.staff.owner.token, MARCA, "PUT"));
    expect(ctx.restaurantesRepo.auditLog.filter((r) => r.action === "configuracion.sitio_publico_actualizado")).toHaveLength(5);
  });

  it("admin tambien puede; staff de sucursal y repartidor reciben 403 al leer y al escribir", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/config/sitio-publico`;
    expect((await app.request(url, authedJson(ctx.staff.admin.token, MARCA, "PUT"))).status).toBe(200);
    for (const rol of ["staffSucursalA", "repartidor"] as const) {
      expect((await app.request(url, authedGet(ctx.staff[rol].token))).status).toBe(403);
      expect((await app.request(url, authedJson(ctx.staff[rol].token, MARCA, "PUT"))).status).toBe(403);
    }
  });

  it("sin sesion 401; la marca de una organizacion no se puede escribir desde una sucursal de otra", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sitio-publico`)).status).toBe(401);
    const cruzado = await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/config/sitio-publico`, authedJson(ctx.staff.owner.token, MARCA, "PUT"));
    expect([403, 404]).toContain(cruzado.status);
    expect(await ctx.restaurantesRepo.findStorefrontMarca(ctx.otherOrganizationId)).toBeNull();
  });

  it.each([
    [{ portadaUrl: "http://inseguro.example.com/a.jpg" }],
    [{ logoUrl: "javascript:alert(1)" }],
    [{ instagramUrl: "https://evil.example.com/x" }],
    [{ titular: "x".repeat(200) }],
  ])("validacion: %j -> 400 y no guarda", async (cambio) => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/sitio-publico`, authedJson(ctx.staff.owner.token, { ...MARCA, ...cambio }, "PUT"));
    expect(res.status).toBe(400);
    expect(await ctx.restaurantesRepo.findStorefrontMarca(ctx.organizationId)).toBeNull();
  });
});
