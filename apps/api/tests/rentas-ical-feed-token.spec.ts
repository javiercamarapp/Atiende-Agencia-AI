// Paridad3 (Rn-13, Rn-P3-15/16/17/23) -- feed iCal por TOKEN rotable, catálogo de canales, matriz de conectividad,
// "Probar URL" y "Sincronizar ahora". HTTP real vía app.request contra los adaptadores en memoria (mismos puertos
// que Postgres); el SQL (RLS, definer, lease) lo cubre scripts/verify-rentas-feed-token contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RealIcalFeedPort, generarTokenFeed } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import type { RentasTestContext } from "./rentas-fixtures.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";

const ics = (uid: string, ini: string, fin: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${ini.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${fin.replaceAll("-", "")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

async function rotar(app: ReturnType<typeof buildApp>, ctx: RentasTestContext, canal = "airbnb", token = ctx.staff.adminGestora.token) {
  return app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/${canal}/feed-token/rotar`, authedJson(token, undefined, {}, "POST"));
}
const feedPorToken = (app: ReturnType<typeof buildApp>, token: string, headers: Record<string, string> = {}) => app.request(`/rentas/feed/${token}.ics`, { headers });

describe("POST .../canales/:canalCodigo/feed-token/rotar", () => {
  it("crea un token, lo muestra una vez y el feed por token responde sin sesión, con ETag y 304", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const reserva = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-09-01", fin: "2026-09-05" } }));
    expect(reserva.status).toBe(201);

    const res = await rotar(app, ctx);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { canal: string; token: string; ruta: string; url_uuid_activa: boolean };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.ruta).toBe(`/rentas/feed/${body.token}.ics`);
    expect(body.url_uuid_activa).toBe(true);

    const feed = await feedPorToken(app, body.token);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toMatch(/text\/calendar/);
    expect(feed.headers.get("cache-control")).toBe("max-age=300");
    expect(feed.headers.get("deprecation")).toBeNull();
    const etag = feed.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const contenido = await feed.text();
    expect(contenido).toContain("DTSTART;VALUE=DATE:20260901");
    expect(contenido).not.toContain(body.token);

    // La OTA vuelve a preguntar con el ETag: 304 sin cuerpo (el DTSTAMP cambia en cada petición, el ETag no).
    const condicional = await feedPorToken(app, body.token, { "if-none-match": etag! });
    expect(condicional.status).toBe(304);
    expect(await condicional.text()).toBe("");
    expect(condicional.headers.get("etag")).toBe(etag);
  });

  it("rotar invalida el token anterior (404) y el nuevo funciona; la bitácora no guarda el token", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const primero = (await (await rotar(app, ctx)).json()) as { token: string };
    const antes = ctx.rentasRepo.auditLog.length;
    const segundo = (await (await rotar(app, ctx)).json()) as { token: string };

    expect((await feedPorToken(app, primero.token)).status).toBe(404);
    expect((await feedPorToken(app, segundo.token)).status).toBe(200);

    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ entityType: "canal", action: "canal.ical_token_rotado" });
    expect(JSON.stringify(nuevas)).not.toContain(segundo.token);
    expect(JSON.stringify(nuevas)).not.toContain(primero.token);
  });

  it("cada canal tiene su propio token", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const a = (await (await rotar(app, ctx, "airbnb")).json()) as { token: string };
    const v = (await (await rotar(app, ctx, "vrbo")).json()) as { token: string };
    expect(a.token).not.toBe(v.token);
    expect((await feedPorToken(app, a.token)).status).toBe(200);
    expect((await feedPorToken(app, v.token)).status).toBe(200);
  });

  it("exige rol de escritura de calendario: solo_calendario, contador y limpieza reciben 403 y no se crea nada", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const rol of ["operadorSoloCalendario", "contador", "limpieza"] as const) {
      expect((await rotar(app, ctx, "airbnb", ctx.staff[rol].token)).status, rol).toBe(403);
    }
    const lista = await ctx.rentasCalendarSyncRepo.listarFeedTokens(ctx.propertyId);
    expect(lista.disponible && lista.tokens).toHaveLength(0);
    expect((await rotar(app, ctx, "airbnb", ctx.staff.operadorAccesoTotal.token)).status).toBe(201);
  });

  it("sin sesión 401; unidad de otra propiedad 404 (no se puede rotar la URL de una unidad ajena); canal desconocido 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/feed-token/rotar`, { method: "POST" })).status).toBe(401);

    const otraPropiedad = randomUUID();
    const unidadAjena = randomUUID();
    ctx.rentasRepo.seedUnidad({ id: unidadAjena, organizationId: ctx.organizationId, propertyId: otraPropiedad, duracionMinimaNoches: 1, name: "Ajena" });
    const ajena = await app.request(`/rentas/${ctx.propertyId}/unidades/${unidadAjena}/canales/airbnb/feed-token/rotar`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "POST"));
    expect(ajena.status).toBe(404);
    expect((await rotar(app, ctx, "no-existe")).status).toBe(404);
  });

  it("base sin la migración 037: 409 honesto (no 500), la URL por UUID sigue funcionando", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.rentasCalendarSyncRepo.migracion037Disponible = false;

    const res = await rotar(app, ctx);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("aún no está disponible");

    const legacy = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/feed.ics`);
    expect(legacy.status).toBe(200);

    const estado = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/feed-tokens`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(estado.status).toBe(200);
    expect(await estado.json()).toMatchObject({ disponible: false, url_uuid_activa: true, tokens: [] });
  });
});

describe("GET /rentas/feed/:token.ics -- seguridad y límites", () => {
  it("un token inexistente, mal formado o sin .ics responde 404 sin consultar la base", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await feedPorToken(app, generarTokenFeed().token)).status).toBe(404);
    expect((await feedPorToken(app, "corto")).status).toBe(404);
    expect((await app.request(`/rentas/feed/${generarTokenFeed().token}`)).status).toBe(404);
  });

  it("120 consultas desde la MISMA IP a 40 tokens distintos no dan 429 (las OTA comparten rangos de IP)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const airbnb = ctx.calendarStore.findCanalPorCodigo("airbnb")!;
    const tokens: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const unidadId = randomUUID();
      ctx.rentasRepo.seedUnidad({ id: unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, duracionMinimaNoches: 1, name: `Unidad ${i}` });
      const t = generarTokenFeed();
      await ctx.rentasCalendarSyncRepo.rotarFeedToken({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId, canalId: airbnb.id, tokenHash: t.hash });
      tokens.push(t.token);
    }
    const estados: number[] = [];
    for (let vuelta = 0; vuelta < 3; vuelta += 1) {
      for (const token of tokens) estados.push((await feedPorToken(app, token, { "x-forwarded-for": "203.0.113.7" })).status);
    }
    expect(estados).toHaveLength(120);
    expect(estados.every((s) => s === 200)).toBe(true);
  });

  it("13 consultas en un minuto al MISMO token dan 429 (y otro token de la misma IP sigue respondiendo)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const a = (await (await rotar(app, ctx, "airbnb")).json()) as { token: string };
    const v = (await (await rotar(app, ctx, "vrbo")).json()) as { token: string };

    const estados: number[] = [];
    for (let i = 0; i < 13; i += 1) estados.push((await feedPorToken(app, a.token)).status);
    expect(estados.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(estados[12]).toBe(429);
    expect((await feedPorToken(app, v.token)).status).toBe(200);
  });

  it("registra el último acceso del token (lo que la matriz y el asistente muestran como 'la OTA ya lo consultó')", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const t = (await (await rotar(app, ctx)).json()) as { token: string };
    const antes = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/feed-tokens`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(((await antes.json()) as { tokens: { ultimo_acceso_en: string | null }[] }).tokens[0]!.ultimo_acceso_en).toBeNull();

    await feedPorToken(app, t.token);
    const despues = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/feed-tokens`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    const filas = ((await despues.json()) as { tokens: { canal: string; creado_en: string; ultimo_acceso_en: string | null }[] }).tokens;
    expect(filas).toHaveLength(1);
    expect(filas[0]!.canal).toBe("airbnb");
    expect(filas[0]!.ultimo_acceso_en).not.toBeNull();
    // Nunca expone el token ni su hash.
    expect(JSON.stringify(filas)).not.toContain(t.token);
  });
});

describe("GET .../feed.ics por UUID (deprecado)", () => {
  it("sigue respondiendo con Deprecation y ETag/304, y ya no corta a la OTA a las 30 consultas", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/booking/feed.ics`;
    const primera = await app.request(url);
    expect(primera.status).toBe(200);
    expect(primera.headers.get("deprecation")).toBe("true");
    expect((await app.request(url, { headers: { "if-none-match": primera.headers.get("etag")! } })).status).toBe(304);

    let ultimo = 0;
    for (let i = 0; i < 100; i += 1) ultimo = (await app.request(url)).status;
    expect(ultimo).toBe(200);
  });

  it("el tope por IP sigue existiendo contra scrapers (600 cada 5 min)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/booking/feed.ics`;
    let ultimo = 0;
    for (let i = 0; i < 601; i += 1) ultimo = (await app.request(url)).status;
    expect(ultimo).toBe(429);
  });

  it("con RENTAS_ICAL_FEED_UUID_LEGACY=off responde 410 (switch de apagado); por omisión está encendida", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/booking/feed.ics`;
    const previo = process.env.RENTAS_ICAL_FEED_UUID_LEGACY;
    try {
      delete process.env.RENTAS_ICAL_FEED_UUID_LEGACY;
      expect((await app.request(url)).status).toBe(200);
      process.env.RENTAS_ICAL_FEED_UUID_LEGACY = "off";
      const apagada = await app.request(url);
      expect(apagada.status).toBe(410);
      // El feed por token no depende del switch.
      const t = (await (await rotar(app, ctx)).json()) as { token: string; url_uuid_activa: boolean };
      expect(t.url_uuid_activa).toBe(false);
      expect((await feedPorToken(app, t.token)).status).toBe(200);
    } finally {
      if (previo === undefined) delete process.env.RENTAS_ICAL_FEED_UUID_LEGACY;
      else process.env.RENTAS_ICAL_FEED_UUID_LEGACY = previo;
    }
  });
});

describe("GET /rentas/:propertyId/canales/catalogo", () => {
  it("devuelve los 8 canales con latencia, fuente y motivo de bloqueo; Booking sin evidencia", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/canales/catalogo`, authedJson(ctx.staff.operadorSoloCalendario.token, undefined, {}, "GET"));
    expect(res.status).toBe(200);
    const { canales } = (await res.json()) as { canales: { codigo: string; via_ical: string; latencia: { confianza: string; fuente: string | null }; bloqueo: { motivo: string } | null }[] };
    expect(canales.map((c) => c.codigo).sort()).toEqual(["agoda", "airbnb", "booking", "despegar", "directo", "expedia", "google_vr", "vrbo"]);
    const booking = canales.find((c) => c.codigo === "booking")!;
    expect(booking.via_ical).toBe("sin_evidencia");
    expect(booking.latencia).toMatchObject({ confianza: "sin_evidencia", fuente: null });
    expect(booking.bloqueo?.motivo).toContain("pausing integrations");
    expect(canales.find((c) => c.codigo === "airbnb")!.latencia.confianza).toBe("baja");
  });

  it("contador no ve el catálogo (fuera de SYNC_CALENDARIO_LECTURA_ROLES); sin sesión 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(`/rentas/${ctx.propertyId}/canales/catalogo`, authedJson(ctx.staff.contador.token, undefined, {}, "GET"))).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/canales/catalogo`)).status).toBe(401);
  });
});

describe("POST .../ical-feeds/probar", () => {
  const probar = (app: ReturnType<typeof buildApp>, ctx: RentasTestContext, url: unknown, token = ctx.staff.adminGestora.token) =>
    app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ical-feeds/probar`, authedJson(token, { url }));

  it("descarga la URL, cuenta eventos y rango, y NO guarda nada", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-10", "2027-01-14") + "" });
    const res = await probar(app, ctx, URL_AIRBNB);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, eventos: 1, desde: "2027-01-10", hasta: "2027-01-14", errores: [] });

    // Sin persistencia: ningún feed conectado, ninguna ocupación creada, ninguna bitácora.
    const feeds = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ical-sync`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(((await feeds.json()) as { feeds: unknown[] }).feeds).toEqual([]);
    const bitacora = await ctx.rentasCalendarSyncRepo.listarBitacora(ctx.propertyId, { soloAlertasAbiertas: false, limite: 10 });
    expect(bitacora.disponible && bitacora.alertas).toHaveLength(0);
    const auditoria = ctx.rentasRepo.auditLog.filter((e) => String((e as { action?: string }).action).startsWith("canal."));
    expect(auditoria).toHaveLength(0);
  });

  it("un contenido que no es .ics responde ok:false con el error de parseo; una URL caída, ok:false de red/HTTP", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "malformado" });
    const parseo = (await (await probar(app, ctx, URL_AIRBNB)).json()) as { ok: boolean; tipo: string; errores: { codigo: string }[] };
    expect(parseo).toMatchObject({ ok: false, tipo: "parseo" });
    expect(parseo.errores[0]!.codigo).toBeTruthy();

    const otraUrl = "https://feeds.airbnb.com/calendar/ical/otra.ics";
    expect(await (await probar(app, ctx, otraUrl)).json()).toMatchObject({ ok: false, tipo: "http", status_http: 404 });
    ctx.rentasIcalFeedPort.failNextCall = new Error("ENOTFOUND");
    expect(await (await probar(app, ctx, URL_AIRBNB)).json()).toMatchObject({ ok: false, tipo: "red" });
  });

  it("rechaza http://, IPs privadas, loopback y el endpoint de metadatos de la nube (SSRF) sin abrir ninguna conexión", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp({ ...ctx.deps, rentasIcalFeedPort: new RealIcalFeedPort() });
    for (const url of ["http://feeds.airbnb.com/x.ics", "https://10.0.0.5/feed.ics", "https://192.168.1.10/feed.ics", "https://127.0.0.1/feed.ics", "https://169.254.169.254/latest/meta-data/"]) {
      const res = await probar(app, ctx, url);
      expect(res.status, url).toBe(400);
    }
    expect((await probar(app, ctx, "")).status).toBe(400);
    expect((await probar(app, ctx, 42)).status).toBe(400);
    // Un literal IPv6 entre corchetes no pasa por el validador de IPs, pero tampoco resuelve por DNS: nunca devuelve un feed.
    const ipv6 = await probar(app, ctx, "https://[::1]/feed.ics");
    expect(ipv6.status === 400 || ((await ipv6.json()) as { ok: boolean }).ok === false).toBe(true);
  });

  it("exige rol de escritura (solo_calendario y contador 403), sin sesión 401, y limita a 10 pruebas por minuto por usuario", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await probar(app, ctx, URL_AIRBNB, ctx.staff.operadorSoloCalendario.token)).status).toBe(403);
    expect((await probar(app, ctx, URL_AIRBNB, ctx.staff.contador.token)).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ical-feeds/probar`, { method: "POST" })).status).toBe(401);
    let ultimo = 0;
    for (let i = 0; i < 11; i += 1) ultimo = (await probar(app, ctx, URL_AIRBNB)).status;
    expect(ultimo).toBe(429);
  });
});

describe("POST .../ical-feeds/:canalCodigo/sincronizar", () => {
  const sincronizar = (app: ReturnType<typeof buildApp>, ctx: RentasTestContext, canal = "airbnb", token = ctx.staff.adminGestora.token) =>
    app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ical-feeds/${canal}/sincronizar`, authedJson(token, undefined, {}, "POST"));
  const conectar = (app: ReturnType<typeof buildApp>, ctx: RentasTestContext) =>
    app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));

  it("sincroniza el feed al momento, aplica la reserva y devuelve el resultado del ciclo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await conectar(app, ctx);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-10", "2027-01-14") });

    const res = await sincronizar(app, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ canal: "airbnb", ok: true, resultado: "exito_con_eventos", eventos_aplicados: 1, reservas_nuevas: 1 });

    const estado = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(((await estado.json()) as { feed: { ultima_sincronizacion_exitosa_en: string | null } }).feed.ultima_sincronizacion_exitosa_en).not.toBeNull();
    expect(ctx.rentasRepo.auditLog.at(-1)).toMatchObject({ entityType: "canal", action: "canal.ical_sincronizado_manual" });
  });

  it("máximo una vez por minuto por feed: la segunda llamada inmediata da 429", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await conectar(app, ctx);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-10", "2027-01-14") });
    expect((await sincronizar(app, ctx)).status).toBe(200);
    expect((await sincronizar(app, ctx)).status).toBe(429);
  });

  it("si otro proceso tiene el lease del feed responde 409 'ya se está sincronizando' y no descarga nada", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const c = (await (await conectar(app, ctx)).json()) as { id: string };
    await ctx.rentasCalendarSyncRepo.reclamarFeedManual(c.id, 120);
    const res = await sincronizar(app, ctx);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("ya se está sincronizando");
    expect(ctx.rentasIcalFeedPort.calls).toHaveLength(0);
  });

  it("un feed caído responde 200 con ok:false (no un 500) y deja el backoff", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await conectar(app, ctx);
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "inaccesible" });
    const res = await sincronizar(app, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, resultado: "fallo_red" });
  });

  it("sin feed conectado 404; solo_calendario y contador 403; sin la migración 037, 409 honesto", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await sincronizar(app, ctx)).status).toBe(404);
    await conectar(app, ctx);
    expect((await sincronizar(app, ctx, "airbnb", ctx.staff.operadorSoloCalendario.token)).status).toBe(403);
    expect((await sincronizar(app, ctx, "airbnb", ctx.staff.contador.token)).status).toBe(403);
    ctx.rentasCalendarSyncRepo.migracion037Disponible = false;
    const sin037 = await sincronizar(app, ctx);
    expect(sin037.status).toBe(409);
    expect(await sin037.text()).toContain("aún no está disponible");
  });
});

describe("GET /rentas/:propertyId/conectividad (matriz)", () => {
  const matriz = async (app: ReturnType<typeof buildApp>, ctx: RentasTestContext, token = ctx.staff.adminGestora.token) => {
    const res = await app.request(`/rentas/${ctx.propertyId}/conectividad`, authedJson(token, undefined, {}, "GET"));
    return { res, body: res.status === 200 ? ((await res.json()) as { tokens_disponibles: boolean; canales: { canal_atiende: string }[]; unidades: { id: string; celdas: { canal: string; estado: string; import: { estado: string }; export: { estado: string } }[] }[] }) : null };
  };

  it("sin nada conectado todas las celdas son sin_conectar (estado vacío honesto) y las columnas son los 3 canales con iCal", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { body } = await matriz(app, ctx);
    expect(body!.canales.map((c) => c.canal_atiende).sort()).toEqual(["airbnb", "booking", "vrbo"]);
    const u = body!.unidades.find((x) => x.id === ctx.unidadId)!;
    expect(u.celdas).toHaveLength(3);
    expect(u.celdas.every((c) => c.estado === "sin_conectar" && c.export.estado === "sin_token")).toBe(true);
  });

  it("refleja el estado real: sincroniza el import y la OTA consulta el token -> conectado; con el import caído -> fallando", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-10", "2027-01-14") });
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ical-feeds/airbnb/sincronizar`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "POST"));

    let { body } = await matriz(app, ctx);
    expect(body!.unidades[0]!.celdas.find((c) => c.canal === "airbnb")).toMatchObject({ estado: "solo_import", import: { estado: "ok" }, export: { estado: "sin_token" } });

    const t = (await (await rotar(app, ctx, "airbnb")).json()) as { token: string };
    await feedPorToken(app, t.token);
    ({ body } = await matriz(app, ctx));
    expect(body!.unidades[0]!.celdas.find((c) => c.canal === "airbnb")).toMatchObject({ estado: "conectado", export: { estado: "consultado" } });
    expect(body!.unidades[0]!.celdas.find((c) => c.canal === "vrbo")!.estado).toBe("sin_conectar");
  });

  it("base sin la migración 037: la matriz sigue respondiendo y declara la exportación 'no_disponible_aun'", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.rentasCalendarSyncRepo.migracion037Disponible = false;
    const { res, body } = await matriz(app, ctx);
    expect(res.status).toBe(200);
    expect(body!.tokens_disponibles).toBe(false);
    expect(body!.unidades[0]!.celdas.every((c) => c.export.estado === "no_disponible_aun")).toBe(true);
  });

  it("roles: solo_calendario puede verla; contador 403; sin sesión 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await matriz(app, ctx, ctx.staff.operadorSoloCalendario.token)).res.status).toBe(200);
    expect((await matriz(app, ctx, ctx.staff.contador.token)).res.status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/conectividad`)).status).toBe(401);
  });
});
