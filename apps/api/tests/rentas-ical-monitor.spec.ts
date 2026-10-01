// Rn-01/Rn-02 -- HTTP real (app.request) del cron por lote con lease y del monitor de
// conflictos/alertas de sync: overbooking entre dos canales detectado por el cron, visible
// en el monitor, decidible por el staff (resuelto / ignorado con motivo) con auditoría y
// bitácora, con roles finos y degradación honesta contra la base sin las migraciones 024/026.
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

  it("el monitor trae el resumen de salud por canal y la zona horaria de la property", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const body = (await (await app.request(`/rentas/${ctx.propertyId}/sync-monitor`, get(admin))).json()) as {
      zona_horaria: string;
      resumen_por_canal: { canal: string; total_feeds: number; peor: string; unidades_con_problema: number; por_salud: Record<string, number> }[];
    };
    expect(body.zona_horaria).toBe("America/Cancun");
    expect(body.resumen_por_canal.map((r) => [r.canal, r.total_feeds, r.peor, r.unidades_con_problema]).sort()).toEqual([
      ["airbnb", 1, "ok", 0],
      ["booking", 1, "ok", 0],
    ]);
    expect(body.resumen_por_canal[0]!.por_salud).toMatchObject({ ok: 1, en_cuarentena: 0 });
  });

  it("GET /conflictos devuelve las dos reservas en pugna con su canal; ?estado inválido es 400", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const res = await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin));
    const body = (await res.json()) as { total_abiertos: number; conflictos: { tipo: string; ocupacion_a: { canal: string }; ocupacion_b: { canal: string } }[] };
    expect(body.total_abiertos).toBe(1);
    expect(body.conflictos[0]!.tipo).toBe("overbooking_confirmado");
    expect([body.conflictos[0]!.ocupacion_a.canal, body.conflictos[0]!.ocupacion_b.canal].sort()).toEqual(["airbnb", "booking"]);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos?estado=raro`, get(admin))).status).toBe(400);
    for (const estado of ["abiertos", "resueltos", "ignorados", "todos"]) expect((await app.request(`/rentas/${ctx.propertyId}/conflictos?estado=${estado}`, get(admin))).status).toBe(200);
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
  it("'resuelto' se rechaza (409) mientras las dos reservas sigan cruzadas; con una cancelada se acepta, queda en la auditoría y no se repite (404)", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { conflictos: { id: string; ocupacion_b: { id: string } }[] };
    const { id, ocupacion_b } = lista.conflictos[0]!;
    const url = `/rentas/${ctx.propertyId}/conflictos/${id}/resolver`;

    // Cuerpo vacío ({} de los clientes anteriores) = "resuelto": el solape sigue vigente.
    const rechazo = await app.request(url, authedJson(admin, {}));
    expect(rechazo.status).toBe(409);
    expect(((await rechazo.json()) as { message: string }).message).toMatch(/siguen cruzadas/);
    expect(((await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { total_abiertos: number }).total_abiertos).toBe(1);

    ctx.calendarStore.marcarCancelada(ocupacion_b.id);
    const res = await app.request(url, authedJson(admin, { accion: "resuelto", motivo: "se canceló en Booking" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, resuelto: true, estado: "resuelto" });
    expect((await app.request(url, authedJson(admin, {}))).status).toBe(404);

    const abiertos = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { total_abiertos: number; conflictos: unknown[] };
    expect(abiertos.total_abiertos).toBe(0);
    expect(abiertos.conflictos).toHaveLength(0);
    const resueltos = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos?estado=resueltos`, get(admin))).json()) as { conflictos: { estado: string; resuelto_en: string | null; resuelto_por_mi: boolean; motivo_resolucion: string | null }[] };
    expect(resueltos.conflictos).toEqual([expect.objectContaining({ estado: "resuelto", motivo_resolucion: "se canceló en Booking", resuelto_por_mi: true })]);
    expect(resueltos.conflictos[0]!.resuelto_en).not.toBeNull();

    const auditoria = (await (await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", get(admin))).json()) as { items: { action: string }[] };
    expect(auditoria.items.map((i) => i.action)).toContain("conflicto_calendario.resuelto");
  });

  it("'ignorado' exige motivo (400), acepta el solape vigente, deja historial atribuido y aparece en su filtro", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { conflictos: { id: string }[] };
    const id = lista.conflictos[0]!.id;
    const url = `/rentas/${ctx.propertyId}/conflictos/${id}/resolver`;

    expect((await app.request(url, authedJson(admin, { accion: "ignorado" }))).status).toBe(400);
    expect((await app.request(url, authedJson(admin, { accion: "ignorado", motivo: "  ab " }))).status).toBe(400);
    expect((await app.request(url, authedJson(admin, { accion: "cancelar_reserva", motivo: "no existe" }))).status).toBe(400);
    expect((await app.request(url, authedJson(admin, { accion: "ignorado", motivo: "x".repeat(501) }))).status).toBe(400);
    expect(((await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { total_abiertos: number }).total_abiertos).toBe(1);

    const ok = await app.request(url, authedJson(admin, { accion: "ignorado", motivo: "  mismo huésped en dos plataformas  " }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id, resuelto: true, estado: "ignorado" });
    expect((await app.request(url, authedJson(admin, { accion: "ignorado", motivo: "otra vez" }))).status).toBe(404);

    const ignorados = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos?estado=ignorados`, get(admin))).json()) as { conflictos: { estado: string; motivo_resolucion: string }[] };
    expect(ignorados.conflictos).toEqual([expect.objectContaining({ estado: "ignorado", motivo_resolucion: "mismo huésped en dos plataformas" })]);
    expect(((await (await app.request(`/rentas/${ctx.propertyId}/conflictos?estado=resueltos`, get(admin))).json()) as { conflictos: unknown[] }).conflictos).toHaveLength(0);

    const historial = (await (await app.request(`${url.replace("/resolver", "/historial")}`, get(admin))).json()) as { disponible: boolean; entradas: { accion: string; motivo: string; por_mi: boolean }[] };
    expect(historial.disponible).toBe(true);
    expect(historial.entradas).toEqual([expect.objectContaining({ accion: "ignorado", motivo: "mismo huésped en dos plataformas", por_mi: true })]);

    const auditoria = (await (await app.request("/v1/rentas/rentas-de-prueba/admin/auditoria", get(admin))).json()) as { items: { action: string; despues?: string | null }[] };
    const entrada = auditoria.items.find((i) => i.action === "conflicto_calendario.ignorado");
    expect(entrada).toBeDefined();
    expect(JSON.stringify(auditoria)).not.toContain("mismo huésped"); // el motivo vive solo en la bitácora del conflicto
  });

  it("un cuerpo que no es un objeto JSON es 400; el historial exige UUID y rol de lectura", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { conflictos: { id: string }[] };
    const id = lista.conflictos[0]!.id;
    const url = `/rentas/${ctx.propertyId}/conflictos/${id}/resolver`;
    expect((await app.request(url, { ...authedJson(admin, {}), body: "[1,2]" })).status).toBe(400);
    expect((await app.request(url, { ...authedJson(admin, {}), body: "{no-json" })).status).toBe(400);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/no-es-uuid/historial`, get(admin))).status).toBe(400);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/${id}/historial`, get(ctx.staff.contador.token))).status).toBe(403);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/${id}/historial`, get(ctx.staff.operadorSoloCalendario.token))).status).toBe(200);
  });

  it("cada conflicto trae el solape real y su vigencia en la zona de la property (America/Cancun), con la hora local de detección", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const res = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as {
      zona_horaria: string;
      conflictos: { solape: { inicio: string; fin: string; vigencia: string } | null; detectado_en: string; detectado_en_local: string }[];
    };
    expect(res.zona_horaria).toBe("America/Cancun");
    // Reservas 10-14 y 12-16 de mayo de 2027: se cruzan las noches del 12 y el 13.
    expect(res.conflictos[0]!.solape).toEqual({ inicio: "2027-05-12", fin: "2027-05-14", vigencia: "futuro" });
    expect(res.conflictos[0]!.detectado_en_local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // Cancún es UTC-5 todo el año: la hora local es la UTC menos 5 h.
    const utc = Date.parse(res.conflictos[0]!.detectado_en);
    expect(res.conflictos[0]!.detectado_en_local).toBe(new Date(utc - 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " "));
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

  it("contra una base con la 024 pero sin la 026: 'resuelto' sigue funcionando (camino anterior), 'ignorado' e historial responden honesto, nunca 500", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { conflictos: { id: string }[] };
    const id = lista.conflictos[0]!.id;
    ctx.rentasCalendarSyncRepo.migracion026Disponible = false;
    const ignorar = await app.request(`/rentas/${ctx.propertyId}/conflictos/${id}/resolver`, authedJson(admin, { accion: "ignorado", motivo: "mismo huésped" }));
    expect(ignorar.status).toBe(409);
    expect(((await ignorar.json()) as { message: string }).message).toMatch(/Ignorar conflictos aún no está disponible/);
    const historial = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos/${id}/historial`, get(admin))).json()) as { disponible: boolean; entradas: unknown[] };
    expect(historial).toMatchObject({ disponible: false, entradas: [] });
    const listado = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos?estado=ignorados`, get(admin))).json()) as { conflictos: unknown[] };
    expect(listado.conflictos).toEqual([]);
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/${id}/resolver`, authedJson(admin, {}))).status).toBe(200);
  });

  it("contra una base sin la migración 024 resolver/atender responden 409 (aún no disponible), nunca 500", async () => {
    const { ctx, app, admin } = await prepararOverbooking();
    const lista = (await (await app.request(`/rentas/${ctx.propertyId}/conflictos`, get(admin))).json()) as { conflictos: { id: string }[] };
    ctx.rentasCalendarSyncRepo.migracion024Disponible = false;
    expect((await app.request(`/rentas/${ctx.propertyId}/conflictos/${lista.conflictos[0]!.id}/resolver`, authedJson(admin, {}))).status).toBe(409);
    expect((await app.request(`/rentas/${ctx.propertyId}/sync-alertas/00000000-0000-4000-8000-000000000000/atender`, authedJson(admin, {}))).status).toBe(409);
  });
});
