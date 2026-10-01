// Rn-01 -- ejecutarLoteSync: claim/lease por feed (varias instancias no se pisan), backoff por
// feed fallido, bitácora/alertas, monitor de conflictos y compatibilidad con la base sin
// migrar. Contra el motor transaccional real en memoria (mismo EXCLUDE/conflicto que
// Postgres) + FakeIcalFeedPort, sin red.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import type { UnidadRecord } from "../src/types.ts";
import { FakeIcalFeedPort } from "../src/sync/calendar-sync-port.ts";
import { InMemoryRentasCalendarSyncRepository } from "../src/sync/in-memory-repository.ts";
import { ejecutarLoteSync, type DepsLoteSync } from "../src/sync/lote.ts";
import { calcularBackoffFeedSegundos } from "../src/sync/lease.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const URL_BOOKING = "https://admin.booking.com/hotel/ical/unidad-1.ics";
const URL_VRBO = "https://www.vrbo.com/icalendar/unidad-1.ics";
const T0 = Date.parse("2026-10-01T12:00:00Z");

function ics(uid: string, dtstart: string, dtend: string): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${dtstart.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${dtend.replaceAll("-", "")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

async function crearFixture(canales: readonly ("airbnb" | "booking" | "vrbo")[] = ["airbnb", "booking", "vrbo"]) {
  const store = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(store);
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1, name: "Casa del mar" };
  store.seedUnidad(unidad);
  const syncRepo = new InMemoryRentasCalendarSyncRepository(store);
  const port = new FakeIcalFeedPort();
  let ahora = T0;
  syncRepo.reloj = () => ahora;
  const urls = { airbnb: URL_AIRBNB, booking: URL_BOOKING, vrbo: URL_VRBO };
  const feedIds = new Map<string, string>();
  for (const codigo of canales) {
    const canal = store.findCanalPorCodigo(codigo)!;
    const { id } = await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canal.id, urlImportacion: urls[codigo] });
    feedIds.set(codigo, id);
  }
  const deps: DepsLoteSync = {
    conSesionSistema: (fn) => engine.withAppSession({ userId: null }, fn),
    crearSyncRepo: () => syncRepo,
    port,
    ahora: () => ahora,
  };
  return { store, syncRepo, port, deps, unidad, propertyId, feedIds, avanzar: (ms: number) => (ahora += ms), reloj: () => ahora };
}

const llamadasA = (port: FakeIcalFeedPort, url: string) => port.calls.filter((c) => c.url === url).length;

describe("ejecutarLoteSync -- claim/lease", () => {
  it("dos instancias del cron a la vez procesan cada feed exactamente una vez (nunca se pisan)", async () => {
    const { deps, port } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });
    port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("b1@booking", "2027-02-01", "2027-02-04") });
    port.definirEscenario(URL_VRBO, { tipo: "ics", contenidoIcs: ics("v1@vrbo", "2027-03-01", "2027-03-04") });

    const [r1, r2] = await Promise.all([ejecutarLoteSync(deps, { limite: 1 }), ejecutarLoteSync(deps, { limite: 1 })]);

    expect(llamadasA(port, URL_AIRBNB)).toBe(1);
    expect(llamadasA(port, URL_BOOKING)).toBe(1);
    expect(llamadasA(port, URL_VRBO)).toBe(1);
    expect(r1.modo).toBe("lease");
    expect(r1.feeds.length + r2.feeds.length).toBe(3);
  });

  it("libera el lease al terminar y respeta el piso de espaciamiento: una segunda corrida inmediata no re-descarga", async () => {
    const { deps, port, syncRepo, propertyId, avanzar } = await crearFixture(["airbnb"]);
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });

    await ejecutarLoteSync(deps);
    const [feed] = await syncRepo.listarFeedsMonitor(propertyId);
    expect(feed!.leaseHasta).toBeNull();
    expect(feed!.proximoIntentoEn).toBeNull();

    await ejecutarLoteSync(deps);
    expect(llamadasA(port, URL_AIRBNB)).toBe(1);

    avanzar(11 * 60_000);
    await ejecutarLoteSync(deps);
    expect(llamadasA(port, URL_AIRBNB)).toBe(2);
  });

  it("si una instancia muere sin liberar, el lease expira solo y el feed se reprocesa", async () => {
    const { deps, port, syncRepo, avanzar } = await crearFixture(["airbnb"]);
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });

    const reclamo = await syncRepo.reclamarFeeds({ limite: 5, leaseSegundos: 120, intervaloMinimoSegundos: 600 });
    expect(reclamo.disponible && reclamo.feeds).toHaveLength(1);

    // Mientras el lease está vigente ninguna otra instancia lo recibe.
    avanzar(60_000);
    await ejecutarLoteSync(deps);
    expect(llamadasA(port, URL_AIRBNB)).toBe(0);

    // Lease vencido (120 s) y piso de espaciamiento cumplido (600 s).
    avanzar(11 * 60_000);
    await ejecutarLoteSync(deps);
    expect(llamadasA(port, URL_AIRBNB)).toBe(1);
  });

  it("liberar con un token ajeno no pisa el lease vigente", async () => {
    const { syncRepo } = await crearFixture(["airbnb"]);
    const reclamo = await syncRepo.reclamarFeeds({ limite: 1, leaseSegundos: 120, intervaloMinimoSegundos: 600 });
    if (!reclamo.disponible) throw new Error("disponible esperado");
    const feedId = reclamo.feeds[0]!.feed.id;
    expect(await syncRepo.liberarFeed(feedId, randomUUID(), true)).toBe(false);
    expect(await syncRepo.liberarFeed(feedId, reclamo.feeds[0]!.leaseToken, true)).toBe(true);
  });

  it("al agotar el presupuesto de tiempo devuelve los feeds reclamados sin procesarlos (liberados para la siguiente corrida)", async () => {
    const { deps, port, syncRepo, propertyId, reloj } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });
    // Cada lectura del reloj avanza 15 s: el presupuesto de 20 s alcanza para el primer feed y no para el resto.
    let t = reloj();
    const lote = await ejecutarLoteSync({ ...deps, ahora: () => (t += 15_000) }, { presupuestoMs: 20_000, limite: 5 });
    expect(lote.feeds.length + lote.devueltosPorPresupuesto).toBeGreaterThan(0);
    expect(lote.devueltosPorPresupuesto).toBeGreaterThan(0);
    const monitor = await syncRepo.listarFeedsMonitor(propertyId);
    expect(monitor.every((f) => f.leaseHasta === null)).toBe(true);
  });
});

describe("ejecutarLoteSync -- backoff por feed fallido", () => {
  it("un feed fallido queda fuera de la cola con espera creciente; los demás siguen; un éxito limpia el backoff", async () => {
    const { deps, port, syncRepo, propertyId, feedIds, avanzar } = await crearFixture(["airbnb", "booking"]);
    port.definirEscenario(URL_AIRBNB, { tipo: "inaccesible" });
    port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("b1@booking", "2027-02-01", "2027-02-04") });

    const l1 = await ejecutarLoteSync(deps);
    expect(l1.feeds.find((f) => f.canal === "airbnb")?.resultado).toBe("fallo_red");
    expect(l1.feeds.find((f) => f.canal === "booking")?.resultado).toBe("exito_con_eventos");

    const monitor1 = await syncRepo.listarFeedsMonitor(propertyId);
    const airbnb1 = monitor1.find((f) => f.canalCodigo === "airbnb")!;
    expect(Date.parse(airbnb1.proximoIntentoEn!) - T0).toBe(calcularBackoffFeedSegundos(1) * 1000);
    expect(monitor1.find((f) => f.canalCodigo === "booking")!.proximoIntentoEn).toBeNull();

    // A los 29 min el feed fallido sigue en backoff (30 min); a los 31 min se reintenta y su espera crece (60 min).
    avanzar(29 * 60_000);
    await ejecutarLoteSync(deps);
    expect(llamadasA(port, URL_AIRBNB)).toBe(1);
    avanzar(2 * 60_000);
    await ejecutarLoteSync(deps);
    expect(llamadasA(port, URL_AIRBNB)).toBe(2);
    const airbnb2 = (await syncRepo.listarFeedsMonitor(propertyId)).find((f) => f.canalCodigo === "airbnb")!;
    expect(Date.parse(airbnb2.proximoIntentoEn!) - (T0 + 31 * 60_000)).toBe(calcularBackoffFeedSegundos(2) * 1000);

    // Reconectar con otra URL reinicia el backoff; un éxito posterior lo deja en null.
    await syncRepo.reiniciarBackoffFeed(feedIds.get("airbnb")!);
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });
    avanzar(11 * 60_000);
    const l3 = await ejecutarLoteSync(deps);
    expect(l3.feeds.find((f) => f.canal === "airbnb")?.resultado).toBe("exito_con_eventos");
    expect((await syncRepo.listarFeedsMonitor(propertyId)).find((f) => f.canalCodigo === "airbnb")!.proximoIntentoEn).toBeNull();
  });

  it("tres fallos consecutivos activan la cuarentena y dejan una alerta crítica abierta en la bitácora", async () => {
    const { deps, port, syncRepo, propertyId, avanzar } = await crearFixture(["airbnb"]);
    port.definirEscenario(URL_AIRBNB, { tipo: "inaccesible" });
    for (let i = 0; i < 3; i += 1) {
      await ejecutarLoteSync(deps);
      avanzar(7 * 3600_000); // supera cualquier backoff (tope 6 h)
    }
    const bitacora = await syncRepo.listarBitacora(propertyId, { soloAlertasAbiertas: true, limite: 50 });
    expect(bitacora.disponible).toBe(true);
    expect(bitacora.alertas.map((a) => [a.tipo, a.severidad])).toEqual([["cuarentena_activada", "critica"]]);
    const feed = (await syncRepo.listarFeedsMonitor(propertyId))[0]!;
    expect(feed.enCuarentenaDesde).not.toBeNull();
  });

  it("un error interno procesando un feed no detiene a los demás, deja alerta y fija backoff", async () => {
    const f = await crearFixture(["airbnb", "booking"]);
    f.port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });
    f.port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("b1@booking", "2027-02-01", "2027-02-04") });
    const original = f.syncRepo.persistFeedSyncState.bind(f.syncRepo);
    f.syncRepo.persistFeedSyncState = async (feedId, ...resto) => {
      if (feedId === f.feedIds.get("airbnb")) throw new Error("fallo simulado de base de datos");
      return original(feedId, ...resto);
    };

    const lote = await ejecutarLoteSync(f.deps);
    expect(lote.feeds.find((x) => x.canal === "airbnb")).toMatchObject({ resultado: "error_interno", error: "fallo simulado de base de datos" });
    expect(lote.feeds.find((x) => x.canal === "booking")?.resultado).toBe("exito_con_eventos");

    const bitacora = await f.syncRepo.listarBitacora(f.propertyId, { soloAlertasAbiertas: true, limite: 50 });
    expect(bitacora.alertas.map((a) => a.tipo)).toContain("error_interno");
    const airbnb = (await f.syncRepo.listarFeedsMonitor(f.propertyId)).find((x) => x.canalCodigo === "airbnb")!;
    expect(airbnb.leaseHasta).toBeNull();
    expect(airbnb.proximoIntentoEn).not.toBeNull();
  });
});

describe("ejecutarLoteSync -- conflictos entre canales (overbooking) y monitor", () => {
  it("dos canales que reservan las mismas noches generan un conflicto visible en el monitor y una alerta crítica; resolverlo lo cierra", async () => {
    const { deps, port, syncRepo, propertyId } = await crearFixture(["airbnb", "booking"]);
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-05-10", "2027-05-14") });
    port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("b1@booking", "2027-05-12", "2027-05-16") });

    const lote = await ejecutarLoteSync(deps);
    expect(lote.feeds.reduce((n, x) => n + x.conflictosDetectados, 0)).toBe(1);

    const listado = await syncRepo.listarConflictos(propertyId, { estado: "abiertos", limite: 100 });
    expect(listado.totalAbiertos).toBe(1);
    const conflicto = listado.conflictos[0]!;
    expect(conflicto.tipo).toBe("overbooking_confirmado");
    expect(conflicto.unidadNombre).toBe("Casa del mar");
    expect([conflicto.ocupacionA.canalCodigo, conflicto.ocupacionB?.canalCodigo].sort()).toEqual(["airbnb", "booking"]);

    const alertas = await syncRepo.listarBitacora(propertyId, { soloAlertasAbiertas: true, limite: 50 });
    expect(alertas.alertas.some((a) => a.tipo === "conflicto_detectado" && a.severidad === "critica" && a.conflictos === 1)).toBe(true);

    expect(conflicto.estado).toBe("abierto");
    // Las dos reservas siguen cruzadas: "resuelto" se rechaza; hay que ignorarlo con motivo.
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-1", { accion: "resuelto", motivo: null })).toBe("solape_vigente");
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-1", { accion: "ignorado", motivo: "mismo huesped en dos canales" })).toBe("ignorado");
    expect(await syncRepo.decidirConflicto(propertyId, conflicto.id, "staff-1", { accion: "ignorado", motivo: "otra vez" })).toBe("no_encontrado");
    expect((await syncRepo.listarConflictos(propertyId, { estado: "abiertos", limite: 100 })).totalAbiertos).toBe(0);
    const todos = (await syncRepo.listarConflictos(propertyId, { estado: "todos", limite: 100 })).conflictos;
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ estado: "ignorado", motivoResolucion: "mismo huesped en dos canales", resueltoPor: "staff-1" });

    // Atender la alerta tampoco se puede repetir, ni desde otra property.
    const alertaId = alertas.alertas.find((a) => a.tipo === "conflicto_detectado")!.id;
    expect(await syncRepo.atenderAlerta(randomUUID(), alertaId, "staff-1")).toBe("no_encontrado");
    expect(await syncRepo.atenderAlerta(propertyId, alertaId, "staff-1")).toBe("resuelto");
    expect(await syncRepo.atenderAlerta(propertyId, alertaId, "staff-1")).toBe("no_encontrado");
  });

  it("un conflicto de otra property nunca se lista ni se resuelve", async () => {
    const { deps, port, syncRepo, propertyId } = await crearFixture(["airbnb", "booking"]);
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-05-10", "2027-05-14") });
    port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("b1@booking", "2027-05-12", "2027-05-16") });
    await ejecutarLoteSync(deps);
    const propia = await syncRepo.listarConflictos(propertyId, { estado: "abiertos", limite: 100 });
    expect(propia.conflictos).toHaveLength(1);

    const ajena = randomUUID();
    expect(await syncRepo.listarConflictos(ajena, { estado: "todos", limite: 100 })).toEqual({ conflictos: [], totalAbiertos: 0 });
    expect(await syncRepo.decidirConflicto(ajena, propia.conflictos[0]!.id, "staff-ajeno", { accion: "ignorado", motivo: "intento ajeno" })).toBe("no_encontrado");
    expect((await syncRepo.listarConflictos(propertyId, { estado: "abiertos", limite: 100 })).totalAbiertos).toBe(1);
  });
});

describe("ejecutarLoteSync -- base sin la migración 024", () => {
  it("cae al barrido anterior: procesa todos los feeds activos sin lease, sin bitácora y sin lanzar", async () => {
    const { deps, port, syncRepo, propertyId } = await crearFixture(["airbnb", "booking"]);
    syncRepo.migracion024Disponible = false;
    port.definirEscenario(URL_AIRBNB, { tipo: "inaccesible" });
    port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: ics("b1@booking", "2027-02-01", "2027-02-04") });

    const lote = await ejecutarLoteSync(deps);
    expect(lote.modo).toBe("sin_lease");
    expect(lote.feeds.map((f) => [f.canal, f.resultado]).sort()).toEqual([["airbnb", "fallo_red"], ["booking", "exito_con_eventos"]]);

    // El monitor degrada con honestidad: bitácora no disponible, resolver no disponible.
    expect(await syncRepo.listarBitacora(propertyId, { soloAlertasAbiertas: true, limite: 10 })).toEqual({ disponible: false, alertas: [] });
    expect(await syncRepo.decidirConflicto(propertyId, randomUUID(), "staff-1", { accion: "resuelto", motivo: null })).toBe("no_disponible");
  });
});
