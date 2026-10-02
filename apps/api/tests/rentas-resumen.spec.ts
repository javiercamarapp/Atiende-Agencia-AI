// Rn-26 -- HTTP real (app.request) del Resumen operativo: los KPI salen de las mismas tablas que las pantallas de origen
// (reservas/tareas/conflictos/feeds creados por la API real), "hoy" se calcula en la zona horaria de la PROPERTY con reloj
// fijo (23:30 CDMX), la ocupación no cuenta dos veces una reserva que cruza de mes, cada bloque respeta el rol y degrada solo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRentasReportesRepository, InMemoryRentasResumenRepository } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

// 2026-10-02 23:30 en CDMX (UTC-6, sin horario de verano) = 2026-10-03 05:30Z = 2026-10-03 00:30 en Cancún (UTC-5).
const AHORA_FIJO = "2026-10-03T05:30:00Z";
const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const URL_BOOKING = "https://admin.booking.com/hotel/ical/unidad-1.ics";

interface Bloque {
  estado: "ok" | "no_disponible" | "sin_permiso";
  [k: string]: unknown;
}
interface ResumenBody {
  hoy: string;
  zona_horaria: string;
  llegadas_salidas: Bloque & { llegadas?: number; salidas?: number };
  ocupacion_mes: Bloque & { noches_ocupadas?: number; noches_disponibles?: number; ocupacion_basis_points?: number };
  conflictos: Bloque & { abiertos?: number };
  limpieza: Bloque & { pendientes?: number; vencidas?: number };
  aprobaciones: Bloque & { pendientes?: number };
  feeds: Bloque & { activos?: number; con_problema?: number };
  agentes: { clave: string; ultima_corrida_en: string; estado: string }[];
}

function ics(uid: string, dtstart: string, dtend: string): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${dtstart.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${dtend.replaceAll("-", "")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

async function preparar(zona: string = "America/Mexico_City") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AHORA_FIJO));
  const ctx = await buildRentasTestContext(buildApp);
  ctx.rentasCalendarSyncRepo.seedZonaHoraria(ctx.propertyId, zona);
  const resumen = new InMemoryRentasResumenRepository(ctx.calendarStore);
  const reportes = new InMemoryRentasReportesRepository();
  reportes.unidades.push({ id: ctx.unidadId, nombre: "Depa de Prueba", ownerId: null, ownerNombre: null });
  const app = buildApp({ ...ctx.deps, rentasResumenRepo: () => resumen, rentasReportesRepo: () => reportes });
  const admin = ctx.staff.adminGestora.token;
  const base = `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}`;
  const reservar = async (inicio: string, fin: string, huespedNombre?: string) => {
    const res = await app.request(`${base}/reservas`, authedJson(admin, { rango: { inicio, fin }, huespedNombre, huespedContacto: huespedNombre ? "+52 55 1234 5678" : undefined }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const get = (token: string) => app.request(`/rentas/${ctx.propertyId}/resumen`, authedJson(token, undefined, {}, "GET"));
  return { ctx, app, resumen, reportes, admin, reservar, get };
}

describe("GET /rentas/:propertyId/resumen", () => {
  it("llegadas y salidas de HOY según la zona de la property: a las 23:30 CDMX es 2-oct allí y 3-oct en Cancún", async () => {
    const cdmx = await preparar("America/Mexico_City");
    await cdmx.reservar("2026-10-02", "2026-10-05", "Ana Pérez"); // llega hoy (CDMX)
    await cdmx.reservar("2026-09-28", "2026-10-02"); // sale hoy (CDMX)
    await cdmx.reservar("2026-10-05", "2026-10-06"); // llega en 3 días: no cuenta
    const a = (await (await cdmx.get(cdmx.admin)).json()) as ResumenBody;
    expect(a.hoy).toBe("2026-10-02");
    expect(a.zona_horaria).toBe("America/Mexico_City");
    expect(a.llegadas_salidas).toMatchObject({ estado: "ok", llegadas: 1, salidas: 1 });

    const cancun = await preparar("America/Cancun");
    await cancun.reservar("2026-09-30", "2026-10-03"); // sale hoy (Cancún)
    await cancun.reservar("2026-10-03", "2026-10-04", "Luis Gómez"); // llega hoy (Cancún)
    const b = (await (await cancun.get(cancun.admin)).json()) as ResumenBody;
    expect(b.hoy).toBe("2026-10-03");
    expect(b.llegadas_salidas).toMatchObject({ estado: "ok", llegadas: 1, salidas: 1 });
  });

  it("no incluye reservas canceladas ni bloqueos en llegadas/salidas y no filtra PII de huéspedes", async () => {
    const t = await preparar();
    const id = await t.reservar("2026-10-02", "2026-10-04", "Ana Pérez");
    expect(((await t.app.request(`/rentas/${t.ctx.propertyId}/unidades/${t.ctx.unidadId}/reservas/${id}/cancelar`, authedJson(t.admin, {}))).status)).toBe(200);
    const bloqueo = await t.app.request(`/rentas/${t.ctx.propertyId}/unidades/${t.ctx.unidadId}/bloqueos`, authedJson(t.admin, { rango: { inicio: "2026-10-02", fin: "2026-10-03" }, razon: "MANTENIMIENTO" }));
    expect(bloqueo.status).toBe(201);
    const res = await t.get(t.admin);
    const texto = await res.text();
    expect((JSON.parse(texto) as ResumenBody).llegadas_salidas).toMatchObject({ llegadas: 0, salidas: 0 });
    expect(texto).not.toContain("Ana");
    expect(texto).not.toContain("1234");
  });

  it("la ocupación del mes reutiliza el reporte de Rn-03: una reserva que cruza de mes cuenta una sola vez", async () => {
    const t = await preparar();
    // Octubre 2026 tiene 31 noches; la reserva (28-sep a 04-oct) aporta 3 noches a octubre (1, 2 y 3); la segunda, 2.
    t.reportes.reservas.push(
      { ocupacionId: "r1", unidadId: t.ctx.unidadId, canal: "airbnb", inicio: "2026-09-28", fin: "2026-10-04", creadaEn: "2026-09-01", financiero: null },
      { ocupacionId: "r2", unidadId: t.ctx.unidadId, canal: "manual", inicio: "2026-10-10", fin: "2026-10-12", creadaEn: "2026-09-02", financiero: null },
    );
    const body = (await (await t.get(t.admin)).json()) as ResumenBody;
    expect(body.ocupacion_mes).toMatchObject({ estado: "ok", noches_ocupadas: 5, noches_disponibles: 31, ocupacion_basis_points: Math.round((5 / 31) * 10000) });
  });

  it("conflictos abiertos y feeds salen del monitor de sync real (overbooking entre dos canales) y el agente de sync aparece con su última corrida", async () => {
    const t = await preparar();
    for (const [canal, url] of [["airbnb", URL_AIRBNB], ["booking", URL_BOOKING]] as const) {
      expect((await t.app.request(`/rentas/${t.ctx.propertyId}/unidades/${t.ctx.unidadId}/canales/${canal}/ical-sync`, authedJson(t.admin, { url }))).status).toBe(201);
    }
    t.ctx.rentasIcalFeedPort.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-05-10", "2027-05-14") });
    t.ctx.rentasIcalFeedPort.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("b1@booking", "2027-05-12", "2027-05-16") });
    const cron = await t.app.request("/internal/rentas/ical-sync", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(cron.status).toBe(200);
    const body = (await (await t.get(t.admin)).json()) as ResumenBody;
    expect(body.conflictos).toMatchObject({ estado: "ok", abiertos: 1 });
    expect(body.feeds).toMatchObject({ estado: "ok", activos: 2 });
    const sync = body.agentes.find((a) => a.clave === "sync_ical");
    expect(sync).toBeDefined();
    expect(Number.isNaN(Date.parse(sync!.ultima_corrida_en))).toBe(false);
  });

  it("cuenta tareas pendientes y vencidas (SLA) de la property, sin las completadas ni las de otra property", async () => {
    const t = await preparar();
    const base = { organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyId, unidadId: t.ctx.unidadId, programadaPara: "2026-10-02" };
    t.ctx.rentasRepo.seedTareaOperativa({ ...base, estado: "pendiente", slaVenceEn: "2026-10-02T12:00:00Z" }); // vencida
    t.ctx.rentasRepo.seedTareaOperativa({ ...base, estado: "en_progreso", slaVenceEn: "2026-10-05T12:00:00Z" }); // en tiempo
    t.ctx.rentasRepo.seedTareaOperativa({ ...base, estado: "completada", slaVenceEn: "2026-10-01T12:00:00Z" }); // cerrada: no cuenta
    t.ctx.rentasRepo.seedTareaOperativa({ ...base, propertyId: "99999999-9999-4999-8999-999999999999", estado: "pendiente", slaVenceEn: "2026-10-01T00:00:00Z" }); // otro tenant
    const body = (await (await t.get(t.admin)).json()) as ResumenBody;
    expect(body.limpieza).toMatchObject({ estado: "ok", pendientes: 2, vencidas: 1 });
  });

  it("aprobaciones pendientes y el agente de borradores IA solo aparecen con datos reales; sin borrador IA no se muestra el agente", async () => {
    const t = await preparar();
    const vacio = (await (await t.get(t.admin)).json()) as ResumenBody;
    expect(vacio.aprobaciones).toMatchObject({ estado: "ok", pendientes: 0 });
    expect(vacio.agentes.map((a) => a.clave)).not.toContain("borradores_ia");
    expect(vacio.agentes.map((a) => a.clave)).not.toContain("liberacion_acceso");
    t.resumen.borradoresPorProperty.set(t.ctx.propertyId, { pendientes: 3, ultimoBorradorIaEn: "2026-10-02T20:00:00.000Z" });
    t.resumen.accesoPorProperty.set(t.ctx.propertyId, { politicaActiva: true, ultimaLiberacionEn: "2026-10-02T18:00:00.000Z" });
    const body = (await (await t.get(t.admin)).json()) as ResumenBody;
    expect(body.aprobaciones).toMatchObject({ estado: "ok", pendientes: 3 });
    expect(body.agentes).toEqual(expect.arrayContaining([expect.objectContaining({ clave: "borradores_ia", ultima_corrida_en: "2026-10-02T20:00:00.000Z" }), expect.objectContaining({ clave: "liberacion_acceso", ultima_corrida_en: "2026-10-02T18:00:00.000Z" })]));
  });

  it("un bloque que falla por base sin migrar dice 'no_disponible' y el resto carga", async () => {
    const t = await preparar();
    t.resumen.noDisponibles.add("tareas");
    t.resumen.noDisponibles.add("borradores");
    await t.reservar("2026-10-02", "2026-10-03");
    const res = await t.get(t.admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResumenBody;
    expect(body.limpieza.estado).toBe("no_disponible");
    expect(body.aprobaciones.estado).toBe("no_disponible");
    expect(body.llegadas_salidas).toMatchObject({ estado: "ok", llegadas: 1 });
    expect(body.ocupacion_mes.estado).toBe("ok");
  });

  it("cada rol ve solo los bloques de las pantallas que puede abrir; limpieza recibe 403; sin sesión 401", async () => {
    const t = await preparar();
    const contador = (await (await t.get(t.ctx.staff.contador.token)).json()) as ResumenBody;
    expect(contador.llegadas_salidas.estado).toBe("ok");
    expect(contador.conflictos.estado).toBe("sin_permiso");
    expect(contador.limpieza.estado).toBe("sin_permiso");
    expect(contador.aprobaciones.estado).toBe("sin_permiso");

    const solo = (await (await t.get(t.ctx.staff.operadorSoloCalendario.token)).json()) as ResumenBody;
    expect(solo.conflictos.estado).toBe("ok");
    expect(solo.feeds.estado).toBe("ok");
    expect(solo.aprobaciones.estado).toBe("sin_permiso");
    expect(solo.limpieza.estado).toBe("sin_permiso");

    const acceso = (await (await t.get(t.ctx.staff.operadorAccesoTotal.token)).json()) as ResumenBody;
    expect(acceso.aprobaciones.estado).toBe("ok");
    expect(acceso.limpieza.estado).toBe("ok");

    expect((await t.get(t.ctx.staff.limpieza.token)).status).toBe(403);
    expect((await t.app.request(`/rentas/${t.ctx.propertyId}/resumen`, { method: "GET" })).status).toBe(401);
  });

  it("una property ajena (otro tenant) no se puede leer", async () => {
    const t = await preparar();
    const res = await t.app.request("/rentas/99999999-9999-4999-8999-999999999999/resumen", authedJson(t.admin, undefined, {}, "GET"));
    expect([403, 404]).toContain(res.status);
  });
});
