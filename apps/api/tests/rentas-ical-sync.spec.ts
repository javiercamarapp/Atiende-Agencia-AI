// Fase 5 -- test de integración end-to-end (HTTP real vía app.request) de
// sincronización de calendario por canal: conectar/desconectar un feed, ver estado de
// sync, el cron interno ejecutando un ciclo real contra un FakeIcalFeedPort
// compartido, y el endpoint público de exportación del feed .ics (sin auth).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";

describe("POST/DELETE/GET /rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/ical-sync", () => {
  it("conecta un feed real, lo lista en el estado de sync, y lo desconecta", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`;

    const conectar = await app.request(base, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
    expect(conectar.status).toBe(201);
    const conectarBody = (await conectar.json()) as { id: string; canal: string; conectado: boolean };
    expect(conectarBody.canal).toBe("airbnb");
    expect(conectarBody.conectado).toBe(true);

    const estado = await app.request(base, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(estado.status).toBe(200);
    const estadoBody = (await estado.json()) as { feed: { url_importacion: string; activo: boolean; en_cuarentena_desde: string | null } };
    expect(estadoBody.feed.url_importacion).toBe(URL_AIRBNB);
    expect(estadoBody.feed.activo).toBe(true);
    expect(estadoBody.feed.en_cuarentena_desde).toBeNull();

    const listado = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/ical-sync`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(listado.status).toBe(200);
    const listadoBody = (await listado.json()) as { feeds: { canal: string }[] };
    expect(listadoBody.feeds.map((f) => f.canal)).toContain("airbnb");

    const desconectar = await app.request(base, { method: "DELETE", headers: { authorization: `Bearer ${ctx.staff.adminGestora.token}` } });
    expect(desconectar.status).toBe(200);

    // Desconectar es un soft-delete (activo=false, mismo criterio que "estado" en
    // bloqueos/reservas -- nunca se borra la fila ni su bookkeeping de versión):
    // GET .../ical-sync sigue devolviendo 200 con `activo:false`, nunca 404.
    const estadoTrasDesconectar = await app.request(base, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(estadoTrasDesconectar.status).toBe(200);
    const estadoTrasDesconectarBody = (await estadoTrasDesconectar.json()) as { feed: { activo: boolean } };
    expect(estadoTrasDesconectarBody.feed.activo).toBe(false);

    // Un segundo intento de desconectar un feed ya inactivo -> 404 (nada que
    // desconectar).
    const segundaDesconexion = await app.request(base, { method: "DELETE", headers: { authorization: `Bearer ${ctx.staff.adminGestora.token}` } });
    expect(segundaDesconexion.status).toBe(404);
  });

  it("rechaza una URL que no es https:// (nunca acepta credenciales embebidas ni esquemas inseguros)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`;
    const res = await app.request(base, authedJson(ctx.staff.adminGestora.token, { url: "http://canal-inseguro.example.com/feed.ics" }));
    expect(res.status).toBe(400);
  });

  it("operador:solo_calendario puede VER el estado pero no puede conectar un feed (403)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`;

    const intentoConectar = await app.request(base, authedJson(ctx.staff.operadorSoloCalendario.token, { url: URL_AIRBNB }));
    expect(intentoConectar.status).toBe(403);

    await app.request(base, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
    const verEstado = await app.request(base, authedJson(ctx.staff.operadorSoloCalendario.token, undefined, {}, "GET"));
    expect(verEstado.status).toBe(200);
  });

  it("contador no puede ver el estado de sync (fuera de SYNC_CALENDARIO_LECTURA_ROLES)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`;
    await app.request(base, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
    const res = await app.request(base, authedJson(ctx.staff.contador.token, undefined, {}, "GET"));
    expect(res.status).toBe(403);
  });
});

describe("GET /rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed.ics (público, sin auth)", () => {
  it("exporta un feed .ics real con la reserva directa activa de la unidad, sin requerir sesión", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const reserva = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-09-01", fin: "2026-09-05" } }));
    expect(reserva.status).toBe(201);

    const feed = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/booking/feed.ics`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toMatch(/text\/calendar/);
    const contenido = await feed.text();
    expect(contenido).toContain("BEGIN:VCALENDAR");
    expect(contenido).toContain("DTSTART;VALUE=DATE:20260901");
    expect(contenido).toContain("DTEND;VALUE=DATE:20260905");
    expect(contenido).not.toMatch(/[A-Za-z]+@(?!atiende)[A-Za-z-]+\.[a-z]{2,}/); // sin datos de contacto/huésped
  });

  it("una unidad inexistente da 404, no un feed vacío silencioso", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/00000000-0000-0000-0000-000000000000/canales/airbnb/feed.ics`);
    expect(res.status).toBe(404);
  });
});

describe("POST /internal/rentas/ical-sync (cron real)", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/ical-sync", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, procesa todos los feeds activos contra el CalendarSyncPort inyectado y aplica una reserva real de canal", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, {
      tipo: "ics",
      contenidoIcs: ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:cron-evt-1@airbnb.com", "DTSTAMP:20260101T000000Z", "DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261004", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
    });

    const res = await app.request("/internal/rentas/ical-sync", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; procesados: number; resultados: { canal: string; resultado: string; eventosAplicados: number }[] };
    expect(body.ok).toBe(true);
    expect(body.procesados).toBe(1);
    expect(body.resultados[0]).toMatchObject({ canal: "airbnb", resultado: "exito_con_eventos", eventosAplicados: 1 });

    const estado = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    const estadoBody = (await estado.json()) as { feed: { ultima_sincronizacion_exitosa_en: string | null } };
    expect(estadoBody.feed.ultima_sincronizacion_exitosa_en).not.toBeNull();
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` -- nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/ical-sync", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/ical-sync", { method: "GET" });
    expect(res.status).toBe(401);
  });
});
