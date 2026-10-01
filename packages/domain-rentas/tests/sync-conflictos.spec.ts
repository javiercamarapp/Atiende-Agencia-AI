// Rn-02 -- decisión sobre conflictos de calendario (resuelto / ignorado con motivo), solape,
// vigencia por zona horaria de la property y resumen de sync por canal. Funciones puras +
// adaptador en memoria (mismas reglas que rentas.resolver_conflicto_calendario, migración 026).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { FakeIcalFeedPort } from "../src/sync/calendar-sync-port.ts";
import {
  calcularSolape,
  clasificarVigenciaSolape,
  fechaLocalEnZona,
  formatearInstanteEnZona,
  MOTIVO_CONFLICTO_MAX,
  normalizarDecisionConflicto,
  resolverZonaHoraria,
  resumirSyncPorCanal,
} from "../src/sync/conflictos.ts";
import { InMemoryRentasCalendarSyncRepository } from "../src/sync/in-memory-repository.ts";
import { ejecutarLoteSync } from "../src/sync/lote.ts";
import type { FeedMonitorRecord } from "../src/sync/monitor.ts";
import type { UnidadRecord } from "../src/types.ts";

describe("normalizarDecisionConflicto", () => {
  it("resuelto: el motivo es opcional y se recorta; vacío o solo espacios queda en null", () => {
    expect(normalizarDecisionConflicto("resuelto", undefined)).toEqual({ ok: true, accion: "resuelto", motivo: null });
    expect(normalizarDecisionConflicto("resuelto", "   ")).toEqual({ ok: true, accion: "resuelto", motivo: null });
    expect(normalizarDecisionConflicto("resuelto", "  se canceló en Booking  ")).toEqual({ ok: true, accion: "resuelto", motivo: "se canceló en Booking" });
  });

  it("ignorado: exige motivo de 3 a 500 caracteres (sin contar espacios de los extremos)", () => {
    expect(normalizarDecisionConflicto("ignorado", undefined)).toMatchObject({ ok: false });
    expect(normalizarDecisionConflicto("ignorado", null)).toMatchObject({ ok: false });
    expect(normalizarDecisionConflicto("ignorado", "  ab  ")).toMatchObject({ ok: false });
    expect(normalizarDecisionConflicto("ignorado", "abc")).toEqual({ ok: true, accion: "ignorado", motivo: "abc" });
    expect(normalizarDecisionConflicto("ignorado", "x".repeat(MOTIVO_CONFLICTO_MAX))).toMatchObject({ ok: true });
    expect(normalizarDecisionConflicto("ignorado", "x".repeat(MOTIVO_CONFLICTO_MAX + 1))).toMatchObject({ ok: false });
  });

  it("rechaza una acción fuera del catálogo y un motivo que no es texto", () => {
    for (const accion of ["cancelar_reserva", "abierto", "", null, undefined, 1]) expect(normalizarDecisionConflicto(accion, "motivo válido")).toMatchObject({ ok: false });
    expect(normalizarDecisionConflicto("resuelto", 42)).toMatchObject({ ok: false });
    expect(normalizarDecisionConflicto("ignorado", { texto: "x" })).toMatchObject({ ok: false });
  });
});

describe("calcularSolape", () => {
  it("devuelve la intersección semiabierta de dos estancias", () => {
    expect(calcularSolape({ inicio: "2027-05-10", fin: "2027-05-14" }, { inicio: "2027-05-12", fin: "2027-05-16" })).toEqual({ inicio: "2027-05-12", fin: "2027-05-14" });
    expect(calcularSolape({ inicio: "2027-05-10", fin: "2027-05-20" }, { inicio: "2027-05-12", fin: "2027-05-14" })).toEqual({ inicio: "2027-05-12", fin: "2027-05-14" });
  });

  it("estancias contiguas (check-out = check-in) NO se cruzan, ni con el cambio de mes o de año", () => {
    expect(calcularSolape({ inicio: "2027-05-10", fin: "2027-05-14" }, { inicio: "2027-05-14", fin: "2027-05-16" })).toBeNull();
    expect(calcularSolape({ inicio: "2026-12-30", fin: "2027-01-01" }, { inicio: "2027-01-01", fin: "2027-01-03" })).toBeNull();
    expect(calcularSolape({ inicio: "2026-12-30", fin: "2027-01-02" }, { inicio: "2027-01-01", fin: "2027-01-03" })).toEqual({ inicio: "2027-01-01", fin: "2027-01-02" });
  });

  it("un rango con fechas inválidas es 'sin cruce' (nunca lanza)", () => {
    expect(calcularSolape({ inicio: "2027-02-30", fin: "2027-03-02" }, { inicio: "2027-03-01", fin: "2027-03-05" })).toBeNull();
    expect(calcularSolape({ inicio: "no-fecha", fin: "2027-03-02" }, { inicio: "2027-03-01", fin: "2027-03-05" })).toBeNull();
  });
});

describe("zona horaria de la property: America/Cancun (UTC-5) vs America/Mexico_City (UTC-6)", () => {
  // 2027-01-01T05:30:00Z = 00:30 del 1-ene en Cancún, 23:30 del 31-dic en CDMX.
  const CRUCE = Date.parse("2027-01-01T05:30:00Z");

  it("el mismo instante cae en días distintos según la zona (y distinto del día UTC del servidor)", () => {
    expect(fechaLocalEnZona(CRUCE, "America/Cancun")).toBe("2027-01-01");
    expect(fechaLocalEnZona(CRUCE, "America/Mexico_City")).toBe("2026-12-31");
    expect(fechaLocalEnZona(Date.parse("2027-01-01T04:59:59Z"), "America/Cancun")).toBe("2026-12-31");
    expect(fechaLocalEnZona(Date.parse("2027-01-01T05:00:00Z"), "America/Cancun")).toBe("2027-01-01");
    expect(fechaLocalEnZona(Date.parse("2027-01-01T05:59:59Z"), "America/Mexico_City")).toBe("2026-12-31");
    expect(fechaLocalEnZona(Date.parse("2027-01-01T06:00:00Z"), "America/Mexico_City")).toBe("2027-01-01");
  });

  it("formatearInstanteEnZona muestra la hora de pared de la property (medianoche es 00:00, nunca 24:00) y tolera nulos o basura", () => {
    expect(formatearInstanteEnZona("2027-01-01T05:30:00Z", "America/Cancun")).toBe("2027-01-01 00:30");
    expect(formatearInstanteEnZona("2027-01-01T05:30:00Z", "America/Mexico_City")).toBe("2026-12-31 23:30");
    expect(formatearInstanteEnZona("2027-01-01T06:00:00Z", "America/Mexico_City")).toBe("2027-01-01 00:00");
    expect(formatearInstanteEnZona(null, "America/Cancun")).toBeNull();
    expect(formatearInstanteEnZona("no-es-fecha", "America/Cancun")).toBeNull();
  });

  it("una zona desconocida cae a la de la plataforma (CDMX) en vez de lanzar", () => {
    expect(resolverZonaHoraria("America/Cancun")).toBe("America/Cancun");
    expect(resolverZonaHoraria("Mars/Olympus")).toBe("America/Mexico_City");
    expect(resolverZonaHoraria(null)).toBe("America/Mexico_City");
    expect(resolverZonaHoraria("")).toBe("America/Mexico_City");
    expect(fechaLocalEnZona(CRUCE, "Mars/Olympus")).toBe("2026-12-31");
  });

  it("la vigencia del solape cambia de 'en curso' (CDMX) a 'pasado' (Cancún) justo en el cruce de medianoche", () => {
    // Noches en conflicto: 29-dic y 30-dic y 31-dic (fin exclusivo 1-ene; el 1-ene es día de check-out).
    const solape = { inicio: "2026-12-29", fin: "2027-01-01" };
    expect(clasificarVigenciaSolape(solape, CRUCE, "America/Mexico_City")).toBe("en_curso");
    expect(clasificarVigenciaSolape(solape, CRUCE, "America/Cancun")).toBe("pasado");
    // Un segundo después de que CDMX también cruza la medianoche, ambas coinciden.
    expect(clasificarVigenciaSolape(solape, Date.parse("2027-01-01T06:00:00Z"), "America/Mexico_City")).toBe("pasado");
  });

  it("solape futuro / en curso / pasado alrededor de los bordes inclusivo (inicio) y exclusivo (fin)", () => {
    const solape = { inicio: "2027-03-10", fin: "2027-03-12" };
    const al = (iso: string, zona: string) => clasificarVigenciaSolape(solape, Date.parse(iso), zona);
    expect(al("2027-03-10T05:59:59Z", "America/Mexico_City")).toBe("futuro"); // 9-mar 23:59 en CDMX
    expect(al("2027-03-10T06:00:00Z", "America/Mexico_City")).toBe("en_curso"); // 10-mar 00:00
    expect(al("2027-03-10T05:00:00Z", "America/Cancun")).toBe("en_curso"); // 10-mar 00:00 en Cancún, una hora antes que en CDMX
    expect(al("2027-03-12T05:59:59Z", "America/Mexico_City")).toBe("en_curso"); // 11-mar 23:59: queda la noche del 11
    expect(al("2027-03-12T06:00:00Z", "America/Mexico_City")).toBe("pasado"); // 12-mar 00:00 = check-out: ya no hay noches
    expect(al("2027-03-12T05:00:00Z", "America/Cancun")).toBe("pasado");
  });

  it("el cruce de año no confunde al comparador de fechas (31-dic vs 1-ene)", () => {
    const solape = { inicio: "2026-12-31", fin: "2027-01-02" };
    expect(clasificarVigenciaSolape(solape, Date.parse("2026-12-31T04:00:00Z"), "America/Cancun")).toBe("futuro"); // 30-dic 23:00 Cancún
    expect(clasificarVigenciaSolape(solape, Date.parse("2026-12-31T05:00:00Z"), "America/Cancun")).toBe("en_curso");
  });
});

function feed(parcial: Partial<FeedMonitorRecord> & Pick<FeedMonitorRecord, "id" | "canalCodigo" | "unidadId">): FeedMonitorRecord {
  return {
    unidadNombre: null,
    activo: true,
    ultimaSincronizacionExitosaEn: "2026-10-01T11:50:00Z",
    enCuarentenaDesde: null,
    intentosFallidosConsecutivos: 0,
    motivoCuarentena: null,
    ultimoIntentoEn: null,
    proximoIntentoEn: null,
    leaseHasta: null,
    ...parcial,
  };
}

describe("resumirSyncPorCanal", () => {
  const AHORA = Date.parse("2026-10-01T12:00:00Z");

  it("agrupa por canal, cuenta la salud, marca el peor estado y las unidades con problema; ordena por gravedad", () => {
    const resumen = resumirSyncPorCanal(
      [
        feed({ id: "1", canalCodigo: "airbnb", unidadId: "u1" }),
        feed({ id: "2", canalCodigo: "airbnb", unidadId: "u2", ultimaSincronizacionExitosaEn: "2026-10-01T08:00:00Z" }),
        feed({ id: "3", canalCodigo: "booking", unidadId: "u1", enCuarentenaDesde: "2026-10-01T09:00:00Z", intentosFallidosConsecutivos: 5 }),
        feed({ id: "4", canalCodigo: "booking", unidadId: "u2", enCuarentenaDesde: "2026-10-01T09:00:00Z" }),
        feed({ id: "5", canalCodigo: "vrbo", unidadId: "u1", activo: false }),
      ],
      AHORA,
    );
    expect(resumen.map((r) => [r.canal, r.peor])).toEqual([
      ["booking", "en_cuarentena"],
      ["airbnb", "desactualizado"],
      ["vrbo", "inactivo"],
    ]);
    const airbnb = resumen.find((r) => r.canal === "airbnb")!;
    expect(airbnb).toMatchObject({ totalFeeds: 2, unidadesConProblema: 1, sincronizacionMasAntiguaEn: "2026-10-01T08:00:00Z" });
    expect(airbnb.porSalud).toMatchObject({ ok: 1, desactualizado: 1, en_cuarentena: 0 });
    expect(resumen.find((r) => r.canal === "booking")).toMatchObject({ unidadesConProblema: 2, totalFeeds: 2 });
    expect(resumen.find((r) => r.canal === "vrbo")).toMatchObject({ unidadesConProblema: 0, sincronizacionMasAntiguaEn: null });
  });

  it("un feed en backoff cuenta como problema aunque su última sincronización sea reciente; un canal solo con feeds al día es ok", () => {
    const resumen = resumirSyncPorCanal(
      [feed({ id: "1", canalCodigo: "airbnb", unidadId: "u1", proximoIntentoEn: "2026-10-01T13:00:00Z" }), feed({ id: "2", canalCodigo: "vrbo", unidadId: "u1" })],
      AHORA,
    );
    expect(resumen.map((r) => [r.canal, r.peor])).toEqual([
      ["airbnb", "en_backoff"],
      ["vrbo", "ok"],
    ]);
  });

  it("sin feeds, sin resumen", () => {
    expect(resumirSyncPorCanal([], AHORA)).toEqual([]);
  });
});

describe("InMemoryRentasCalendarSyncRepository.decidirConflicto (mismas reglas que la migración 026)", () => {
  async function conOverbooking() {
    const store = new InMemoryRentasCalendarStore();
    const engine = new InMemoryRentasTenancyEngine(store);
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1, name: "Casa del mar" };
    store.seedUnidad(unidad);
    const syncRepo = new InMemoryRentasCalendarSyncRepository(store);
    const port = new FakeIcalFeedPort();
    const t0 = Date.parse("2026-10-01T12:00:00Z");
    syncRepo.reloj = () => t0;
    const urls = { airbnb: "https://feeds.airbnb.com/calendar/ical/u1.ics", booking: "https://admin.booking.com/hotel/ical/u1.ics" } as const;
    for (const codigo of ["airbnb", "booking"] as const) {
      await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: store.findCanalPorCodigo(codigo)!.id, urlImportacion: urls[codigo] });
    }
    const ics = (uid: string, d1: string, d2: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${d1}`, `DTEND;VALUE=DATE:${d2}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    port.definirEscenario(urls.airbnb, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "20270510", "20270514") });
    port.definirEscenario(urls.booking, { tipo: "ics", contenidoIcs: ics("b1@booking", "20270512", "20270516") });
    await ejecutarLoteSync({ conSesionSistema: (fn) => engine.withAppSession({ userId: null }, fn), crearSyncRepo: () => syncRepo, port, ahora: () => t0 });
    const conflicto = (await syncRepo.listarConflictos(propertyId, { estado: "abiertos", limite: 10 })).conflictos[0]!;
    return { store, syncRepo, propertyId, conflicto };
  }

  it("'resuelto' se rechaza mientras las dos reservas sigan cruzadas y se acepta cuando una se cancela; el solape se corrige sin tocar nada más", async () => {
    const { store, syncRepo, propertyId, conflicto } = await conOverbooking();
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-1", { accion: "resuelto", motivo: null })).toBe("solape_vigente");
    expect((await syncRepo.listarConflictos(propertyId, { estado: "abiertos", limite: 10 })).totalAbiertos).toBe(1);

    store.marcarCancelada(conflicto.ocupacionB!.id);
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-1", { accion: "resuelto", motivo: "se canceló en Booking" })).toBe("resuelto");
    const [cerrado] = (await syncRepo.listarConflictos(propertyId, { estado: "resueltos", limite: 10 })).conflictos;
    expect(cerrado).toMatchObject({ id: conflicto.id, estado: "resuelto", motivoResolucion: "se canceló en Booking", resueltoPor: "staff-1" });
    expect(store.getOcupacion(conflicto.ocupacionA.id)!.estado).toBe("confirmado");
  });

  it("'ignorado' acepta el solape vigente, queda en su filtro y en la bitácora; no se decide dos veces", async () => {
    const { syncRepo, propertyId, conflicto } = await conOverbooking();
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-1", { accion: "ignorado", motivo: "mismo huésped" })).toBe("ignorado");
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-2", { accion: "ignorado", motivo: "otra vez" })).toBe("no_encontrado");
    expect((await syncRepo.listarConflictos(propertyId, { estado: "ignorados", limite: 10 })).conflictos).toHaveLength(1);
    expect((await syncRepo.listarConflictos(propertyId, { estado: "resueltos", limite: 10 })).conflictos).toHaveLength(0);
    expect((await syncRepo.listarConflictos(propertyId, { estado: "abiertos", limite: 10 })).conflictos).toHaveLength(0);
    const historial = await syncRepo.listarHistorialConflicto(propertyId, conflicto.id);
    expect(historial).toMatchObject({ disponible: true });
    expect(historial.entradas).toEqual([expect.objectContaining({ accion: "ignorado", motivo: "mismo huésped", actorUserId: "staff-1" })]);
    // Otra property no ve el historial.
    expect((await syncRepo.listarHistorialConflicto(randomUUID(), conflicto.id)).entradas).toEqual([]);
  });

  it("sin la migración 026: 'ignorado' no está disponible, 'resuelto' cae al camino anterior, no hay motivo ni bitácora", async () => {
    const { syncRepo, propertyId, conflicto } = await conOverbooking();
    syncRepo.migracion026Disponible = false;
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-1", { accion: "ignorado", motivo: "mismo huésped" })).toBe("no_disponible");
    expect(await syncRepo.listarHistorialConflicto(propertyId, conflicto.id)).toEqual({ disponible: false, entradas: [] });
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-1", { accion: "resuelto", motivo: "x" })).toBe("resuelto");
    const [k] = (await syncRepo.listarConflictos(propertyId, { estado: "resueltos", limite: 10 })).conflictos;
    expect(k).toMatchObject({ estado: "resuelto", motivoResolucion: null });
    expect((await syncRepo.listarConflictos(propertyId, { estado: "ignorados", limite: 10 })).conflictos).toHaveLength(0);
  });
});
