// Rn-01/Rn-02 -- HTTP real (app.request) del cron por lote con lease y del monitor de
// conflictos/alertas de sync: overbooking entre dos canales detectado por el cron, visible
// en el monitor, resoluble por el staff con auditoría, con roles finos y degradación
// honesta contra la base sin la migración 024.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const URL_BOOKING = "https://admin.booking.com/hotel/ical/unidad-1.ics";

function ics(uid: string, dtstart: string, dtend: string): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${dtstart.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${dtend.replaceAll("-", "")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

async function prepararOverbooking() {
  const ctx = await buildRentasTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const admin = ctx.staff.adminGestora.token;
  for (const [canal, url] of [["airbnb", URL_AIRBNB], ["booking", URL_BOOKING]] as const) {
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/${canal}/ical-sync`, authedJson(admin, { url }));
    expect(res.status).toBe(201);
  }
  ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-05-10", "2027-05-14") });
  ctx.rentasIcalFeedPort.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("b1@booking", "2027-05-12", "2027-05-16") });
  const cron = await app.request("/internal/rentas/ical-sync", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
  return { ctx, app, admin, cron };
}

const get = (token: string) => authedJson(token, undefined, {}, "GET");

describe("cron /internal/rentas/ical-sync por lote", () => {
  it("responde con el modo lease y el total de conflictos detectados entre canales", async () => {
    const { cron } = await prepararOverbooking();
    expect(cron.status).toBe(200);
    const body = (await cron.json()) as { ok: boolean; modo: string; procesados: number; conflictosDetectados: number };
    expect(body).toMatchObject({ ok: true, modo: "lease", procesados: 2, conflictosDetectados: 1 });
  });

  it("dos disparos seguidos del cron no re-descargan los feeds (lease liberado + piso de espaciamiento)", async () => {
    const { ctx, app } = await prepararOverbooking();
    const antes = ctx.rentasIcalFeedPort.calls.length;
    const segundo = await app.request("/internal/rentas/ical-sync", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(((await segundo.json()) as { procesados: number }).procesados).toBe(0);
    expect(ctx.rentasIcalFeedPort.calls.length).toBe(antes);
  });

  it("contra una base sin la migración 024 cae al barrido anterior (modo sin_lease) y responde ok", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    ctx.rentasCalendarSyncRepo.migracion024Disponible = false;
    await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/canales/airbnb/ical-sync`, authedJson(ctx.staff.adminGestora.token, { url: URL_AIRBNB }));
    ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-05-10", "2027-05-14") });
    const res = await app.request("/internal/rentas/ical-sync", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, modo: "sin_lease", procesados: 1 });
  });
});

describe("GET /rentas/:propertyId/sync-monitor y /conflictos", () => {
  it("lista el estado por feed, la alerta crítica de overbooking y el contador de conflictos abiertos", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const res = await app.request(`/rentas/${ctx.propertyId}/sync-monitor`, get(admin));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      feeds: { canal: string; salud: string; proximo_intento_en: string | null }[];
      alertas: { disponible: boolean; abiertas: { tipo: string; severidad: string; conflictos: number; detalle: string }[] };
      conflictos_abiertos: number;
    };
    expect(body.feeds.map((f) => f.canal).sort()).toEqual(["airbnb", "booking"]);
    expect(body.feeds.every((f) => f.salud === "ok")).toBe(true);
    expect(body.alertas.disponible).toBe(true);
    expect(body.alertas.abiertas).toEqual([expect.objectContaining({ tipo: "conflicto_detectado", severidad: "critica", conflictos: 1 })]);
    expect(JSON.stringify(body)).not.toContain("feeds.airbnb.com");
    expect(body.conflictos_abiertos).toBe(1);
  });

  it("GET /conflictos devuelve las dos reservas en pugna con su canal; ?estado inválido es 400", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const res = await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin));
    const body = (await res.json()) as { total_abiertos: number; conflictos: { tipo: string; ocupacion_a: { canal: string }; ocupacion_b: { canal: string } }[] };
    expect(body.total_abiertos).toBe(1);
    expect(body.conflictos[0]!.tipo).toBe("overbooking_confirmado");
    expect([body.conflictos[0]!.ocupacion_a.canal, body.conflictos[0]!.ocupacion_b.canal].sort()).toEqual(["airbnb", "booking"]);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos?estado=raro`, get(admin))).status).toBe(400);
  });

  it("operador:solo_calendario puede VER el monitor; contador no (fuera de SYNC_CALENDARIO_LECTURA_ROLES)", async () => {
    const { ctx, app } = await prepararOverbooking();
    expect((await app.request(`/rentas/${ctx.propertyId}/sync-monitor`, get(ctx.staff.operadorSoloCalendario.token))).status).toBe(200);
    expect((await app.request(`/rentas/${ctx.propertyId}/sync-monitor`, get(ctx.staff.contador.token))).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(ctx.staff.contador.token))).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/sync-monitor`)).status).toBe(401);
  });

  it("contra una base sin la migración 024: alertas no disponibles (lista vacía honesta), conflictos sí, nunca 500", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    ctx.rentasCalendarSyncRepo.migracion024Disponible = false;
    const res = await app.request(`/rentas/${ctx.propertyId}/sync-monitor`, get(admin));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alertas: { disponible: boolean; abiertas: unknown[] }; conflictos_abiertos: number };
    expect(body.alertas).toEqual({ disponible: false, abiertas: [] });
    expect(body.conflictos_abiertos).toBe(1);
  });
});

describe("POST resolver conflicto / atender alerta", () => {
  it("el staff de escritura resuelve el conflicto, queda en la bitácora de auditoría y no se puede resolver dos veces (404)", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { conflictos: { id: string }[] };
    const id = lista.conflictos[0]!.id;
    const url = `/rentas/${ctx.propertyId}/conflictos/${id}/resolver`;

    const res = await app.request(url, authedJson(admin, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, resuelto: true });
    expect((await app.request(url, authedJson(admin, {}))).status).toBe(404);

    const abiertos = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { total_abiertos: number; conflictos: unknown[] };
    expect(abiertos.total_abiertos).toBe(0);
    expect(abiertos.conflictos).toHaveLength(0);
    const todos = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos?estado=todos`, get(admin))).json()) as { conflictos: { resuelto_en: string | null }[] };
    expect(todos.conflictos[0]!.resuelto_en).not.toBeNull();

    const auditoria = (await (await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", get(admin))).json()) as { items: { action: string; entity_type?: string; entityType?: string }[] };
    expect(auditoria.items.map((i) => i.action)).toContain("conflicto_calendario.resuelto");
  });

  it("operador:solo_calendario no puede resolver (403); un id no UUID es 400; un UUID desconocido es 404", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { conflictos: { id: string }[] };
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/${lista.conflictos[0]!.id}/resolver`, authedJson(ctx.staff.operadorSoloCalendario.token, {}))).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/no-es-uuid/resolver`, authedJson(admin, {}))).status).toBe(400);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/00000000-0000-4000-8000-000000000000/resolver`, authedJson(admin, {}))).status).toBe(404);
  });

  it("atender una alerta la saca de las abiertas; repetirlo es 404", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const monitor = (await (await app.request(`/rentas/${ctx.propertyId}/sync-monitor`, get(admin))).json()) as { alertas: { abiertas: { id: string }[] } };
    const alertaId = monitor.alertas.abiertas[0]!.id;
    const url = `/rentas/${ctx.propertyId}/sync-alertas/${alertaId}/atender`;
    expect((await app.request(url, authedJson(admin, {}))).status).toBe(200);
    expect((await app.request(url, authedJson(admin, {}))).status).toBe(404);
    const despues = (await (await app.request(`/rentas/${ctx.propertyId}/sync-monitor`, get(admin))).json()) as { alertas: { abiertas: unknown[] } };
    expect(despues.alertas.abiertas).toHaveLength(0);
  });

  it("contra una base sin la migración 024 resolver/atender responden 409 (aún no disponible), nunca 500", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { conflictos: { id: string }[] };
    ctx.rentasCalendarSyncRepo.migracion024Disponible = false;
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/${lista.conflictos[0]!.id}/resolver`, authedJson(admin, {}))).status).toBe(409);
    expect((await app.request(`/rentas/${ctx.propertyId}/sync-alertas/00000000-0000-4000-8000-000000000000/atender`, authedJson(admin, {}))).status).toBe(409);
  });
});
