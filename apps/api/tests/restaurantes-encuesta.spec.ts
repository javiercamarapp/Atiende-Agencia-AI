// R-41 (migracion 041): encuesta post-entrega por HTTP. Cada caso afirma el EFECTO (que se guardo, que se encolo, que NO se devuelve), no
// solo el status. El SQL real (RLS, alcance, zona horaria) lo prueba scripts/verify-restaurantes-encuesta-entrega/ contra Postgres real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryEncuestaRepository } from "@atiende/domain-restaurantes";
import type { EncuestaCandidata } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { encuestaTokenKey, issueEncuestaToken } from "../src/encuesta-token.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

afterEach(() => vi.useRealTimers());

const ORDER_1 = "00000000-0000-4000-8000-0000000000c1";
const ORDER_2 = "00000000-0000-4000-8000-0000000000c2";
const key = encuestaTokenKey(TEST_ENV.internalSecret);

async function construir(opts: { sinRepo?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const encuestas = new InMemoryEncuestaRepository();
  encuestas.nombresSucursal.set(ctx.propertyIdA, "Francisco de Montejo");
  const base: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { encuestaRepo: () => encuestas }) };
  const { deps, emisiones } = conEmisiones(base);
  const app = envolver(buildApp(deps));
  const tokenDe = (orderId: string, orgId = ctx.organizationId) => issueEncuestaToken(key, orgId, orderId);
  const urlPublica = (token: string, slug = "los-taquitos-de-pm") => `/v1/restaurantes/${slug}/encuesta/${token}`;
  const sembrar = (orderId = ORDER_1, extra: Partial<Parameters<typeof encuestas.sembrarEntrega>[0]> = {}) =>
    encuestas.sembrarEntrega({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, orderId, repartidorId: null, enviadaAt: new Date().toISOString(), ...extra });
  const post = (url: string, body: unknown, origin: string | null = "http://localhost:5173") => {
    const raw = JSON.stringify(body);
    return app.request(url, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), ...(origin ? { origin } : {}) } });
  };
  return { ctx, encuestas, app, emisiones, tokenDe, urlPublica, sembrar, post };
}

describe("encuesta publica del cliente", () => {
  it("GET con token valido: sucursal y estado, sin datos personales", async () => {
    const { app, urlPublica, tokenDe, sembrar } = await construir();
    sembrar();
    const res = await app.request(urlPublica(tokenDe(ORDER_1)));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ disponible: true, encuesta: { sucursal: "Francisco de Montejo", respondida: false, calificacion: null, resenasUrl: null } });
  });

  it("token malformado, firmado por otro, de otra organizacion o sin encuesta: la MISMA respuesta 404 (sin oraculo)", async () => {
    const { ctx, app, urlPublica, tokenDe, sembrar } = await construir();
    sembrar();
    const respuestas = await Promise.all([
      app.request(urlPublica("basura")),
      app.request(urlPublica(issueEncuestaToken(encuestaTokenKey("otro-secreto"), ctx.organizationId, ORDER_1))),
      app.request(urlPublica(tokenDe(ORDER_1, ctx.otherOrganizationId))),
      app.request(urlPublica(tokenDe(ORDER_2))),
      app.request(urlPublica(tokenDe(ORDER_1), "restaurante-que-no-existe")),
    ]);
    const cuerpos = await Promise.all(respuestas.map((r) => r.json()));
    for (const r of respuestas) expect(r.status).toBe(404);
    expect(new Set(cuerpos.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("un token de otra organizacion NO lee la encuesta aunque el slug sea el de ella", async () => {
    const { ctx, app, urlPublica, sembrar } = await construir();
    sembrar();
    const res = await app.request(urlPublica(issueEncuestaToken(key, ctx.otherOrganizationId, ORDER_1), "otro-restaurante"));
    expect(res.status).toBe(404);
  });

  it("POST registra la calificacion y el comentario; calificacion alta sin liga configurada no devuelve liga", async () => {
    const { app, urlPublica, tokenDe, sembrar, post, encuestas } = await construir();
    sembrar();
    const res = await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 5, comentario: "  Todo muy rico  " });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ disponible: true, estado: "registrada", calificacion: 5, resenasUrl: null });
    expect(encuestas.entregas[0]).toMatchObject({ calificacion: 5, comentario: "Todo muy rico" });
    const get = await (await app.request(urlPublica(tokenDe(ORDER_1)))).json();
    expect(get.encuesta).toMatchObject({ respondida: true, calificacion: 5 });
  });

  it("liga a resenas: solo con calificacion >= umbral y liga configurada en la sucursal", async () => {
    const { ctx, app, urlPublica, tokenDe, sembrar, post, encuestas } = await construir();
    await encuestas.guardarConfig(ctx.organizationId, ctx.propertyIdA, { activa: true, esperaMin: 30, resenasUrl: "https://g.page/r/ejemplo/review", umbralResena: 4 });
    sembrar(ORDER_1);
    sembrar(ORDER_2);
    const alta = await (await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 4 })).json();
    const baja = await (await post(urlPublica(tokenDe(ORDER_2)), { calificacion: 3 })).json();
    expect(alta.resenasUrl).toBe("https://g.page/r/ejemplo/review");
    expect(baja.resenasUrl).toBeNull();
    expect((await (await app.request(urlPublica(tokenDe(ORDER_1)))).json()).encuesta.resenasUrl).toBe("https://g.page/r/ejemplo/review");
  });

  it("la primera respuesta gana: el reintento recibe 200 ya_respondida con la calificacion original", async () => {
    const { urlPublica, tokenDe, sembrar, post, encuestas } = await construir();
    sembrar();
    expect((await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 5 })).status).toBe(201);
    const otra = await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 1, comentario: "cambio de opinion" });
    expect(otra.status).toBe(200);
    expect(await otra.json()).toMatchObject({ estado: "ya_respondida", calificacion: 5 });
    expect(encuestas.entregas[0]).toMatchObject({ calificacion: 5, comentario: null });
  });

  it.each([[0], [6], [3.5], ["5"], [null], [undefined]])("calificacion invalida %j -> 400 y nada se guarda", async (cal) => {
    const { urlPublica, tokenDe, sembrar, post, encuestas } = await construir();
    sembrar();
    const res = await post(urlPublica(tokenDe(ORDER_1)), { calificacion: cal });
    expect(res.status).toBe(400);
    expect(encuestas.entregas[0]?.calificacion).toBeNull();
  });

  it("comentario de mas de 1000 caracteres -> 400", async () => {
    const { urlPublica, tokenDe, sembrar, post } = await construir();
    sembrar();
    expect((await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 4, comentario: "x".repeat(1001) })).status).toBe(400);
  });

  it("POST con token invalido -> 404 y con origen no permitido -> 403", async () => {
    const { urlPublica, tokenDe, sembrar, post } = await construir();
    sembrar();
    expect((await post(urlPublica("basura"), { calificacion: 5 })).status).toBe(404);
    expect((await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 5 }, "https://sitio-malicioso.example")).status).toBe(403);
  });

  it("calificacion de 2 estrellas o menos emite UNA notificacion in-app (sin PII, enlace a Encuestas, dedupe por pedido); de 3 o mas, no", async () => {
    const { ctx, urlPublica, tokenDe, sembrar, post, emisiones } = await construir();
    sembrar(ORDER_1);
    sembrar(ORDER_2);
    await post(urlPublica(tokenDe(ORDER_2)), { calificacion: 3 });
    expect(emisiones).toHaveLength(0);
    const res = await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 2, comentario: "Llego frio, me llamo Juan Perez 5511223344" });
    expect(res.status).toBe(201);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "restaurantes.encuesta.calificacion_baja",
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyIdA,
      categoria: "operacion",
      severidad: "atencion",
      enlace: "/restaurantes/{orgSlug}/encuestas",
      dedupeKey: `restaurantes.encuesta.calificacion_baja:${ORDER_1}`,
    });
    expect(JSON.stringify(emisiones)).not.toMatch(/Juan|5511223344|frio/i);
    // El reintento no vuelve a emitir.
    await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 1 });
    expect(emisiones).toHaveLength(1);
  });

  it("una emision de notificacion que falla NO cambia la respuesta al cliente", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const encuestas = new InMemoryEncuestaRepository();
    encuestas.sembrarEntrega({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, orderId: ORDER_1, repartidorId: null, enviadaAt: new Date().toISOString() });
    const { deps } = conEmisiones({ ...ctx.deps, encuestaRepo: () => encuestas }, {
      alEmitir: () => {
        const err = new Error("la funcion no existe") as Error & { code: string };
        err.code = "42883";
        throw err;
      },
    });
    const raw = JSON.stringify({ calificacion: 1 });
    const res = await buildApp(deps).request(`/v1/restaurantes/los-taquitos-de-pm/encuesta/${issueEncuestaToken(key, ctx.organizationId, ORDER_1)}`, {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "content-length": String(raw.length), origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(201);
    expect(encuestas.entregas[0]?.calificacion).toBe(1);
  });

  it("base SIN migrar: GET responde disponible=false (200) y POST 503 honesto, nunca un 500", async () => {
    const { urlPublica, tokenDe, sembrar, post, app, encuestas } = await construir();
    sembrar();
    encuestas.disponible = false;
    const get = await app.request(urlPublica(tokenDe(ORDER_1)));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ disponible: false });
    const res = await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 5 });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ disponible: false });
  });

  it("despliegue sin encuestaRepo: 503 honesto", async () => {
    const { ctx, app, urlPublica } = await construir({ sinRepo: true });
    expect((await app.request(urlPublica(issueEncuestaToken(key, ctx.organizationId, ORDER_1)))).status).toBe(503);
  });

  it("limite de uso: la respuesta 11 en un minuto desde la misma IP recibe 429", async () => {
    const { urlPublica, tokenDe, sembrar, post } = await construir();
    sembrar();
    let ultimo = 0;
    for (let i = 0; i < 11; i++) ultimo = (await post(urlPublica(tokenDe(ORDER_1)), { calificacion: 5 })).status;
    expect(ultimo).toBe(429);
  });
});

describe("encuesta: configuracion del panel", () => {
  const url = (propertyId: string) => `/v1/restaurantes/${propertyId}/admin/encuestas/config`;
  const CONFIG = { activa: true, esperaMin: 45, resenasUrl: "https://g.page/r/ejemplo/review", umbralResena: 5 };

  it("GET: apagada por defecto; PUT guarda y GET devuelve lo guardado", async () => {
    const { ctx, app } = await construir();
    const antes = await (await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.owner.token))).json();
    expect(antes).toEqual({ disponible: true, config: { activa: false, esperaMin: 30, resenasUrl: null, umbralResena: 4 } });
    const put = await app.request(url(ctx.propertyIdA), authedJson(ctx.staff.owner.token, CONFIG, "PUT"));
    expect(put.status).toBe(200);
    expect((await (await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.admin.token))).json()).config).toEqual(CONFIG);
  });

  it.each([
    ["liga javascript", { ...CONFIG, resenasUrl: "javascript:alert(1)" }],
    ["liga http", { ...CONFIG, resenasUrl: "http://g.page/r/x" }],
    ["espera fuera de rango", { ...CONFIG, esperaMin: 2 }],
    ["umbral fuera de rango", { ...CONFIG, umbralResena: 6 }],
    ["activa no booleana", { ...CONFIG, activa: "si" }],
  ])("PUT con %s -> 400 y no guarda", async (_n, body) => {
    const { ctx, app, encuestas } = await construir();
    const res = await app.request(url(ctx.propertyIdA), authedJson(ctx.staff.owner.token, body, "PUT"));
    expect(res.status).toBe(400);
    expect(encuestas.configs.size).toBe(0);
  });

  it("staff de piso y repartidor -> 403, otra organizacion -> 403/404, sin sesion -> 401", async () => {
    const { ctx, app } = await construir();
    for (const t of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token]) {
      expect((await app.request(url(ctx.propertyIdA), authedGet(t))).status).toBe(403);
      expect((await app.request(url(ctx.propertyIdA), authedJson(t, CONFIG, "PUT"))).status).toBe(403);
    }
    expect([403, 404]).toContain((await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.otroOrgOwner.token))).status);
    expect((await app.request(url(ctx.propertyIdA))).status).toBe(401);
  });

  it("base sin migrar: GET disponible=false con la config por defecto y PUT 503 (no finge exito)", async () => {
    const { ctx, app, encuestas } = await construir();
    encuestas.disponible = false;
    expect(await (await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.owner.token))).json()).toMatchObject({ disponible: false, config: { activa: false } });
    expect((await app.request(url(ctx.propertyIdA), authedJson(ctx.staff.owner.token, CONFIG, "PUT"))).status).toBe(503);
  });
});

describe("encuesta: resumen de satisfaccion del panel", () => {
  const url = (propertyId: string, qs = "") => `/v1/restaurantes/${propertyId}/admin/encuestas/resumen${qs}`;

  function hoyFijo(iso = "2026-03-10T18:00:00Z") {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  }

  it("calcula promedio, tasa de respuesta, distribucion y por repartidor; sin PII", async () => {
    hoyFijo();
    const { ctx, app, encuestas } = await construir();
    encuestas.nombresRepartidor.set("rep-1", "Repartidor Uno");
    const ya = { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, enviadaAt: "2026-03-09T18:00:00.000Z" };
    encuestas.sembrarEntrega({ ...ya, orderId: "a", repartidorId: "rep-1", respondidaAt: "2026-03-09T19:00:00.000Z", calificacion: 5, comentario: "Excelente" });
    encuestas.sembrarEntrega({ ...ya, orderId: "b", repartidorId: "rep-1", respondidaAt: "2026-03-09T19:30:00.000Z", calificacion: 2, comentario: "Llego frio" });
    encuestas.sembrarEntrega({ ...ya, orderId: "c", repartidorId: null });
    const texto = await (await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.owner.token))).text();
    const r = JSON.parse(texto);
    expect(r).toMatchObject({ disponible: true, hoy: "2026-03-10", desde: "2026-02-09", hasta: "2026-03-10", alcance: "organizacion" });
    expect(r.resumen).toMatchObject({ enviadas: 3, respondidas: 2, promedio: 3.5, tasaRespuestaPct: 66.7, distribucion: [0, 1, 0, 0, 1] });
    expect(r.porRepartidor).toEqual([{ repartidorId: "rep-1", nombre: "Repartidor Uno", enviadas: 2, respondidas: 2, promedio: 3.5, tasaRespuestaPct: 100 }]);
    expect(r.recientes).toHaveLength(2);
    expect(texto).not.toMatch(/phone|telefono|customer/i);
  });

  it("sin encuestas: ceros honestos, promedio y tasa null (no 0)", async () => {
    hoyFijo();
    const { ctx, app } = await construir();
    const r = await (await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.owner.token))).json();
    expect(r.resumen).toMatchObject({ enviadas: 0, respondidas: 0, promedio: null, tasaRespuestaPct: null });
  });

  it("alcance=sucursal acota a la sucursal del panel; por defecto es de toda la organizacion", async () => {
    hoyFijo();
    const { ctx, app, encuestas } = await construir();
    const espiar: unknown[] = [];
    const original = encuestas.resumen.bind(encuestas);
    encuestas.resumen = async (org, desde, hasta, prop) => {
      espiar.push([desde, hasta, prop]);
      return original(org, desde, hasta, prop);
    };
    await app.request(url(ctx.propertyIdA, "?alcance=sucursal&dias=7"), authedGet(ctx.staff.owner.token));
    await app.request(url(ctx.propertyIdA, "?dias=7"), authedGet(ctx.staff.owner.token));
    expect(espiar).toEqual([
      ["2026-03-04", "2026-03-10", ctx.propertyIdA],
      ["2026-03-04", "2026-03-10", null],
    ]);
  });

  it.each([
    ["?dias=0"],
    ["?dias=93"],
    ["?dias=abc"],
    ["?desde=2026-03-01"],
    ["?desde=2026-03-01&hasta=2026-03-11"],
    ["?desde=2026-03-05&hasta=2026-03-01"],
    ["?desde=2025-01-01&hasta=2026-03-10"],
    ["?dias=7&desde=2026-03-01&hasta=2026-03-02"],
    ["?alcance=todo"],
  ])("parametros invalidos %s -> 400", async (qs) => {
    hoyFijo();
    const { ctx, app } = await construir();
    expect((await app.request(url(ctx.propertyIdA, qs), authedGet(ctx.staff.owner.token))).status).toBe(400);
  });

  it("staff de piso y repartidor -> 403; base sin migrar -> disponible=false con vacios", async () => {
    hoyFijo();
    const { ctx, app, encuestas } = await construir();
    expect((await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    encuestas.disponible = false;
    const r = await (await app.request(url(ctx.propertyIdA), authedGet(ctx.staff.owner.token))).json();
    expect(r).toMatchObject({ disponible: false, resumen: { enviadas: 0, promedio: null }, porSucursal: [], porRepartidor: [], recientes: [] });
  });
});

describe("encuesta: envio de pendientes", () => {
  const candidata = (ctx: { organizationId: string; propertyIdA: string }, orderId: string, extra: Partial<EncuestaCandidata> = {}): EncuestaCandidata => ({
    orderId,
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyIdA,
    orgSlug: "los-taquitos-de-pm",
    sucursal: "Francisco de Montejo",
    customerName: "Ana Lopez",
    customerPhone: "5511112222",
    ...extra,
  });

  it("boton del panel: encola el WhatsApp con la liga firmada, deja bitacora y es idempotente", async () => {
    const { ctx, app, encuestas } = await construir();
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "pnid-test");
    encuestas.pendientes.push(candidata(ctx, ORDER_1), candidata(ctx, ORDER_2));
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas/enviar-pendientes`, authedJson(ctx.staff.owner.token, {}, "POST"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: true, candidatas: 2, encoladas: 2, yaRegistradas: 0, errores: 0 });
    const outbox = ctx.restaurantesRepo.getOutbox().filter((o) => o.eventType === "encuesta.entrega");
    expect(outbox).toHaveLength(2);
    const payload = outbox[0]?.payload as { to: string; body: string; phone_number_id: string; transaccional?: boolean };
    expect(payload.to).toBe("+525511112222");
    expect(payload.phone_number_id).toBe("pnid-test");
    expect(payload.transaccional).toBeUndefined();
    const liga = /https:\/\/app\.test\.invalid\/encuesta\/los-taquitos-de-pm\/(e1\.[A-Za-z0-9_.-]+)/.exec(payload.body);
    expect(liga).not.toBeNull();
    expect(JSON.stringify(payload.body)).not.toContain("Lopez");
    expect(ctx.restaurantesRepo.auditLog.some((a) => a.action === "encuesta.envio_manual" && a.despues === "2")).toBe(true);
    const otra = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas/enviar-pendientes`, authedJson(ctx.staff.owner.token, {}, "POST"));
    expect(await otra.json()).toMatchObject({ candidatas: 0, encoladas: 0 });
    expect(ctx.restaurantesRepo.getOutbox().filter((o) => o.eventType === "encuesta.entrega")).toHaveLength(2);
  });

  it("la liga del WhatsApp funciona de punta a punta: abre la encuesta y se puede responder", async () => {
    const { ctx, app, encuestas, post } = await construir();
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "pnid-test");
    encuestas.pendientes.push(candidata(ctx, ORDER_1));
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas/enviar-pendientes`, authedJson(ctx.staff.owner.token, {}, "POST"));
    const body = (ctx.restaurantesRepo.getOutbox().find((o) => o.eventType === "encuesta.entrega")?.payload as { body: string }).body;
    const m = /\/encuesta\/([^/]+)\/(\S+)$/.exec(body);
    expect(m).not.toBeNull();
    const [, slug, token] = m as RegExpExecArray;
    const abrir = await app.request(`/v1/restaurantes/${slug}/encuesta/${token}`);
    expect(abrir.status).toBe(200);
    expect((await post(`/v1/restaurantes/${slug}/encuesta/${token}`, { calificacion: 5, comentario: "Rico" })).status).toBe(201);
    expect(encuestas.entregas[0]).toMatchObject({ orderId: ORDER_1, calificacion: 5 });
  });

  it("sin numero de WhatsApp: se omite, no se encola nada y se reporta", async () => {
    const { ctx, app, encuestas } = await construir();
    encuestas.pendientes.push(candidata(ctx, ORDER_1));
    const r = await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas/enviar-pendientes`, authedJson(ctx.staff.owner.token, {}, "POST"))).json();
    expect(r).toMatchObject({ encoladas: 0, omitidas: { sin_canal_whatsapp: 1 } });
    expect(ctx.restaurantesRepo.getOutbox()).toHaveLength(0);
  });

  it("staff de piso y repartidor -> 403; sin sesion -> 401", async () => {
    const { ctx, app } = await construir();
    const u = `/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas/enviar-pendientes`;
    expect((await app.request(u, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"))).status).toBe(403);
    expect((await app.request(u, authedJson(ctx.staff.repartidor.token, {}, "POST"))).status).toBe(403);
    expect((await app.request(u, { method: "POST" })).status).toBe(401);
  });

  it("tope de 6 por minuto por organizacion: la septima llamada recibe 429", async () => {
    const { ctx, app } = await construir();
    const u = `/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas/enviar-pendientes`;
    const estados: number[] = [];
    for (let i = 0; i < 7; i++) estados.push((await app.request(u, authedJson(ctx.staff.owner.token, {}, "POST"))).status);
    expect(estados).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it("base sin migrar: disponible=false y no encola nada", async () => {
    const { ctx, app, encuestas } = await construir();
    encuestas.disponible = false;
    const r = await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas/enviar-pendientes`, authedJson(ctx.staff.owner.token, {}, "POST"))).json();
    expect(r).toMatchObject({ disponible: false, encoladas: 0 });
  });
});

describe("/internal/restaurantes/enviar-encuestas", () => {
  it("sin el secreto interno -> 401; con el secreto barre TODAS las organizaciones y es idempotente (GET con Bearer tambien)", async () => {
    const { ctx, app, encuestas } = await construir();
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "pnid-a");
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.otherOrganizationId, "pnid-b");
    encuestas.pendientes.push(
      { orderId: ORDER_1, organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, orgSlug: "los-taquitos-de-pm", sucursal: "A", customerName: "Ana", customerPhone: "5511112222" },
      { orderId: ORDER_2, organizationId: ctx.otherOrganizationId, propertyId: ctx.otherPropertyId, orgSlug: "otro-restaurante", sucursal: "B", customerName: "Beto", customerPhone: "5533334444" },
    );
    expect((await app.request("/internal/restaurantes/enviar-encuestas", { method: "POST" })).status).toBe(401);
    const res = await app.request("/internal/restaurantes/enviar-encuestas", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "ok", candidates: 2, enqueued: 2, errors: 0 });
    const otra = await app.request("/internal/restaurantes/enviar-encuestas", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(await otra.json()).toMatchObject({ candidates: 0, enqueued: 0 });
    expect(ctx.restaurantesRepo.getOutbox().filter((o) => o.eventType === "encuesta.entrega")).toHaveLength(2);
  });

  it("organizationId limita el barrido a esa organizacion y se valida como uuid", async () => {
    const { ctx, app, encuestas } = await construir();
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "pnid-a");
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.otherOrganizationId, "pnid-b");
    encuestas.pendientes.push(
      { orderId: ORDER_1, organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, orgSlug: "los-taquitos-de-pm", sucursal: "A", customerName: "Ana", customerPhone: "5511112222" },
      { orderId: ORDER_2, organizationId: ctx.otherOrganizationId, propertyId: ctx.otherPropertyId, orgSlug: "otro-restaurante", sucursal: "B", customerName: "Beto", customerPhone: "5533334444" },
    );
    const headers = { "x-atiende-internal-secret": TEST_ENV.internalSecret };
    expect((await app.request("/internal/restaurantes/enviar-encuestas?organizationId=no-es-uuid", { method: "POST", headers })).status).toBe(400);
    const res = await app.request(`/internal/restaurantes/enviar-encuestas?organizationId=${ctx.otherOrganizationId}`, { method: "POST", headers });
    expect(await res.json()).toMatchObject({ enqueued: 1 });
    expect(encuestas.entregas.map((e) => e.orderId)).toEqual([ORDER_2]);
  });

  it("base SIN migrar -> 200 con status not_available", async () => {
    const { app, encuestas } = await construir();
    encuestas.disponible = false;
    const res = await app.request("/internal/restaurantes/enviar-encuestas", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(await res.json()).toMatchObject({ ok: true, status: "not_available", enqueued: 0 });
  });
});
