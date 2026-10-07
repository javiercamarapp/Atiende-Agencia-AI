// Rn-P3-13 -- catalogo de 20 casos adversariales de sincronizacion iCal (ACEPTACION.md §Calendario-2 del original), NOMBRADOS uno por
// uno: `caso-01-doble-evento` ... `caso-20-ssrf`. Corre contra el motor real (ejecutarCicloImportacion) sobre el calendario en memoria
// transaccional y FakeIcalFeedPort (sin red). Los casos que dependen de capas que no viven en este paquete (18, 19) se marcan
// `test.skip` con el motivo y la ruta del spec que SI los cubre -- nunca se silencian. Tabla de estado en docs/PRUEBAS-RENTAS.md.
// Ademas: regresiones D-DSD-04 (rebote anti-eco entre dos canales), D-DSD-10 (vacio sin historial), D-DSD-12 (bookkeeping perdido),
// feed HTML disfrazado/truncado y DST de Madrid y Nueva York 2027.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../../src/in-memory-tenancy-engine.ts";
import { crearBloqueo, crearReservaConfirmada } from "../../src/aplicacion/reservas.ts";
import type { EjecutorTransaccional } from "../../src/ejecutor.ts";
import type { UnidadRecord } from "../../src/types.ts";
import { FakeIcalFeedPort, type CalendarSyncPort, type FetchFeedInput, type FetchFeedResult } from "../../src/sync/calendar-sync-port.ts";
import { InMemoryRentasCalendarSyncRepository } from "../../src/sync/in-memory-repository.ts";
import { ejecutarCicloImportacion, exportarFeedParaUnidad, type ContextoSincronizacion } from "../../src/sync/motor.ts";
import { calcularBackoffMs } from "../../src/sync/reconciliacion.ts";
import { fetchIcsSeguro } from "../../src/sync/net/fetch-ics-seguro.ts";

const ZONA = "America/Mexico_City";
const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const URL_BOOKING = "https://admin.booking.com/hotel/ical/unidad-1.ics";

interface EventoIcs {
  uid: string;
  dtstart: string;
  dtend: string;
  sequence?: number;
  dtstamp?: string;
  status?: string;
}

/** Fecha pura `AAAA-MM-DD` o valor completo (`TZID=...:20270313T150000`, `20270314T020000Z`) tal cual. */
function linea(nombre: "DTSTART" | "DTEND", valor: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return `${nombre};VALUE=DATE:${valor.replaceAll("-", "")}`;
  if (valor.startsWith("TZID=")) return `${nombre};${valor}`;
  return `${nombre}:${valor}`;
}

function ics(eventos: readonly EventoIcs[]): string {
  const cuerpo = eventos.flatMap((e) => {
    const l = ["BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${e.dtstamp ?? "20270101T000000Z"}`, linea("DTSTART", e.dtstart), linea("DTEND", e.dtend)];
    if (e.sequence !== undefined) l.push(`SEQUENCE:${e.sequence}`);
    if (e.status) l.push(`STATUS:${e.status}`);
    l.push("END:VEVENT");
    return l;
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ADVERSARIAL//EN", ...cuerpo, "END:VCALENDAR"].join("\r\n");
}

async function crearFixture() {
  const store = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(store);
  let db!: EjecutorTransaccional;
  await engine.withAppSession({ userId: null }, async (session) => {
    db = session;
  });
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1 };
  store.seedUnidad(unidad);
  const canalAirbnb = store.findCanalPorCodigo("airbnb")!;
  const canalBooking = store.findCanalPorCodigo("booking")!;
  const syncRepo = new InMemoryRentasCalendarSyncRepository(store);
  const port = new FakeIcalFeedPort();
  await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canalAirbnb.id, urlImportacion: URL_AIRBNB });
  await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id, urlImportacion: URL_BOOKING });

  async function ctx(canalId: string, zona = ZONA, portUsado: CalendarSyncPort = port): Promise<ContextoSincronizacion> {
    const feed = (await syncRepo.findFeed(propertyId, unidad.id, canalId))!;
    return { db, syncRepo, port: portUsado, feed, zonaHorariaPropiedad: zona };
  }
  const ciclo = async (canalId = canalAirbnb.id, zona = ZONA) => ejecutarCicloImportacion(await ctx(canalId, zona));
  const importar = async (feedIcs: string, canalId = canalAirbnb.id, zona = ZONA) => {
    port.definirEscenario(canalId === canalAirbnb.id ? URL_AIRBNB : URL_BOOKING, { tipo: "ics", contenidoIcs: feedIcs });
    return ciclo(canalId, zona);
  };
  const ocupaciones = () => [...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id);
  const activas = () => ocupaciones().filter((o) => o.estado !== "cancelado");
  const snapshot = () => JSON.stringify(ocupaciones().map((o) => ({ id: o.id, estado: o.estado, inicio: o.inicio, fin: o.fin, canal: o.canalOrigenId, ext: o.externalId })).sort((a, b) => a.id.localeCompare(b.id)));
  const nochesLibres = async (inicio: string, fin: string): Promise<boolean> => {
    const r = await crearReservaConfirmada(db, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio, fin }, estado: "confirmado", bloqueante: true });
    return r.conflicto === null;
  };
  return { store, db, organizationId, propertyId, unidad, canalAirbnb, canalBooking, syncRepo, port, ctx, ciclo, importar, ocupaciones, activas, snapshot, nochesLibres };
}

describe("caso-01-doble-evento", () => {
  it("mismo UID+SEQUENCE con contenido distinto: DTSTAMP decide y queda exactamente un evento", async () => {
    const f = await crearFixture();
    const uid = "caso1@airbnb.com";
    await f.importar(ics([{ uid, sequence: 1, dtstamp: "20270101T000000Z", dtstart: "2027-06-01", dtend: "2027-06-05" }]));
    const r2 = await f.importar(ics([{ uid, sequence: 1, dtstamp: "20270102T000000Z", dtstart: "2027-06-10", dtend: "2027-06-15" }]));
    expect(r2.eventosAplicados).toBe(1);
    expect(f.activas()).toHaveLength(1);
    expect(f.activas()[0]).toMatchObject({ inicio: "2027-06-10", fin: "2027-06-15" });
  });

  it("con DTSTAMP anterior el entrante se descarta y el estado final sigue siendo el primero", async () => {
    const f = await crearFixture();
    const uid = "caso1b@airbnb.com";
    await f.importar(ics([{ uid, sequence: 1, dtstamp: "20270105T000000Z", dtstart: "2027-06-01", dtend: "2027-06-05" }]));
    const r2 = await f.importar(ics([{ uid, sequence: 1, dtstamp: "20270102T000000Z", dtstart: "2027-06-10", dtend: "2027-06-15" }]));
    expect(r2.eventosAplicados).toBe(0);
    expect(f.activas()[0]).toMatchObject({ inicio: "2027-06-01", fin: "2027-06-05" });
  });
});

describe("caso-02-reserva-simultanea-dos-canales", () => {
  it("las mismas noches en Airbnb y Booking generan conflicto para revision humana y NO se cancela ninguna reserva", async () => {
    const f = await crearFixture();
    const rA = await f.importar(ics([{ uid: "a-1@airbnb.com", dtstart: "2027-07-01", dtend: "2027-07-05" }]), f.canalAirbnb.id);
    expect(rA.conflictosDetectados).toBe(0);
    const rB = await f.importar(ics([{ uid: "b-1@booking.com", dtstart: "2027-07-03", dtend: "2027-07-08" }]), f.canalBooking.id);
    expect(rB.conflictosDetectados).toBe(1);
    expect(f.ocupaciones()).toHaveLength(2);
    expect(f.ocupaciones().some((o) => o.estado === "cancelado")).toBe(false);
    expect(f.ocupaciones().find((o) => o.canalOrigenId === f.canalAirbnb.id)!.estado).toBe("confirmado");
  });
});

describe("caso-03-eventos-desordenados", () => {
  it("un CANCEL con SEQUENCE menor llegado despues del CREATE no se aplica como estado final", async () => {
    const f = await crearFixture();
    const uid = "caso3@airbnb.com";
    await f.importar(ics([{ uid, sequence: 2, dtstamp: "20270201T000000Z", dtstart: "2027-07-01", dtend: "2027-07-05", status: "CONFIRMED" }]));
    const r = await f.importar(ics([{ uid, sequence: 1, dtstamp: "20270101T000000Z", dtstart: "2027-07-01", dtend: "2027-07-05", status: "CANCELLED" }]));
    expect(r.eventosAplicados).toBe(0);
    expect(f.activas()).toHaveLength(1);
  });

  it("y un CANCEL con SEQUENCE mayor SI se aplica (control: el orden lo decide la version, no la llegada)", async () => {
    const f = await crearFixture();
    const uid = "caso3b@airbnb.com";
    await f.importar(ics([{ uid, sequence: 1, dtstamp: "20270101T000000Z", dtstart: "2027-07-01", dtend: "2027-07-05" }]));
    const r = await f.importar(ics([{ uid, sequence: 2, dtstamp: "20270201T000000Z", dtstart: "2027-07-01", dtend: "2027-07-05", status: "CANCELLED" }]));
    expect(r.eventosAplicados).toBe(1);
    expect(f.activas()).toHaveLength(0);
  });
});

describe("caso-04-modificacion-de-fechas", () => {
  it("el bloqueo se mueve completo: las noches viejas quedan libres y las nuevas ocupadas", async () => {
    const f = await crearFixture();
    const uid = "caso4@airbnb.com";
    await f.importar(ics([{ uid, sequence: 0, dtstamp: "20270101T000000Z", dtstart: "2027-08-01", dtend: "2027-08-05" }]));
    await f.importar(ics([{ uid, sequence: 1, dtstamp: "20270102T000000Z", dtstart: "2027-08-10", dtend: "2027-08-14" }]));
    expect(f.activas()).toHaveLength(1);
    expect(f.activas()[0]).toMatchObject({ inicio: "2027-08-10", fin: "2027-08-14" });
    expect(await f.nochesLibres("2027-08-01", "2027-08-05")).toBe(true);
    expect(await f.nochesLibres("2027-08-10", "2027-08-14")).toBe(false);
  });
});

describe("caso-05-cancelacion-no-reabre-noches-ocupadas-por-otra-causa", () => {
  it("cancelar la reserva de canal NO libera las noches que un bloqueo de mantenimiento sigue ocupando", async () => {
    const f = await crearFixture();
    await crearBloqueo(f.db, { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, rango: { inicio: "2027-09-02", fin: "2027-09-04" }, razon: "MANTENIMIENTO" });
    const uid = "caso5@airbnb.com";
    await f.importar(ics([{ uid, sequence: 0, dtstart: "2027-09-01", dtend: "2027-09-06" }]));
    await f.importar(ics([{ uid, sequence: 1, dtstamp: "20270102T000000Z", dtstart: "2027-09-01", dtend: "2027-09-06", status: "CANCELLED" }]));
    const bloqueo = f.ocupaciones().find((o) => o.capa === "bloqueo")!;
    expect(bloqueo.estado).toBe("confirmado");
    expect(bloqueo).toMatchObject({ bloqueante: true, inicio: "2027-09-02", fin: "2027-09-04" }); // sigue ocupando esas noches
    expect(f.activas()).toEqual([bloqueo]); // y es lo unico que queda activo: la cancelacion no toco nada mas
  });
});

describe("caso-06-timeout-tras-exito-remoto", () => {
  it("el timeout del fetch no toca los datos y el reintento no duplica el efecto", async () => {
    const f = await crearFixture();
    const feed = ics([{ uid: "caso6@airbnb.com", sequence: 1, dtstart: "2027-10-01", dtend: "2027-10-04" }]);
    await f.importar(feed);
    const antes = f.snapshot();
    f.port.failNextCall = new Error("timeout simulado tras exito remoto");
    const r = await f.ciclo();
    expect(r.resultado).toBe("fallo_red");
    expect(f.snapshot()).toBe(antes);
    const reintento = await f.importar(feed);
    expect(reintento.eventosAplicados).toBe(0);
    expect(f.snapshot()).toBe(antes);
  });
});

describe("caso-07-reintento-de-import-ya-procesado", () => {
  it("reprocesar el mismo evento (aunque el cuerpo cambie byte a byte) deja un diff de estado vacio", async () => {
    const f = await crearFixture();
    const evento = { uid: "caso7@airbnb.com", sequence: 1, dtstart: "2027-10-10", dtend: "2027-10-13" };
    await f.importar(ics([evento]));
    const antes = f.snapshot();
    // Mismo evento, cuerpo distinto (cabecera extra): evita el 304 por ETag y fuerza un reproceso real.
    const r = await f.importar(ics([evento]).replace("VERSION:2.0", "VERSION:2.0\r\nX-REINTENTO:1"));
    expect(r.resultado).toBe("exito_con_eventos");
    expect(r.eventosAplicados).toBe(0);
    expect(f.snapshot()).toBe(antes);
  });
});

describe("caso-08-ack-perdido", () => {
  it("el canal reenvia el mismo evento con DTSTAMP nuevo (no recibio el ack): sin cambio de contenido, el estado no se corrompe", async () => {
    const f = await crearFixture();
    const base = { uid: "caso8@airbnb.com", sequence: 1, dtstart: "2027-11-01", dtend: "2027-11-04" };
    await f.importar(ics([{ ...base, dtstamp: "20270301T000000Z" }]));
    const antes = f.snapshot();
    const r = await f.importar(ics([{ ...base, dtstamp: "20270302T000000Z" }]));
    expect(r.eventosAplicados).toBe(0);
    expect(f.snapshot()).toBe(antes);
    expect(f.activas()).toHaveLength(1);
  });
});

describe("caso-09-feed-malformado", () => {
  it("se rechaza (fallo_parseo) sin estado parcial: las reservas existentes no se tocan", async () => {
    const f = await crearFixture();
    await f.importar(ics([{ uid: "caso9@airbnb.com", dtstart: "2027-12-01", dtend: "2027-12-04" }]));
    const antes = f.snapshot();
    f.port.definirEscenario(URL_AIRBNB, { tipo: "malformado" });
    const r = await f.ciclo();
    expect(r.resultado).toBe("fallo_parseo");
    expect(r.eventosAplicados).toBe(0);
    expect(f.snapshot()).toBe(antes);
    const feed = (await f.syncRepo.findFeed(f.propertyId, f.unidad.id, f.canalAirbnb.id))!;
    expect(feed.estadoSync.intentosFallidosConsecutivos).toBe(1);
  });
});

describe("caso-10-feed-vacio", () => {
  it("un feed vacio valido NO cancela las reservas existentes y levanta la alerta de vacio inesperado", async () => {
    const f = await crearFixture();
    await f.importar(ics([{ uid: "caso10@airbnb.com", dtstart: "2028-01-01", dtend: "2028-01-04" }]));
    const antes = f.snapshot();
    f.port.definirEscenario(URL_AIRBNB, { tipo: "vacio" });
    const r = await f.ciclo();
    expect(r.resultado).toBe("exito_vacio");
    expect(r.alertaCuarentena?.tipo).toBe("vacio_inesperado");
    expect(f.snapshot()).toBe(antes);
    expect(f.activas()).toHaveLength(1);
  });
});

describe("caso-11-feed-inaccesible", () => {
  it("tras 3 fallos entra en cuarentena, preserva el ultimo estado conocido y el backoff crece con tope", async () => {
    const f = await crearFixture();
    await f.importar(ics([{ uid: "caso11@airbnb.com", dtstart: "2028-02-01", dtend: "2028-02-04" }]));
    const antes = f.snapshot();
    f.port.definirEscenario(URL_AIRBNB, { tipo: "inaccesible", statusHttp: 503 });
    let ultimo;
    for (let i = 0; i < 3; i++) ultimo = await f.ciclo();
    expect(ultimo!.alertaCuarentena?.tipo).toBe("cuarentena_activada");
    const feed = (await f.syncRepo.findFeed(f.propertyId, f.unidad.id, f.canalAirbnb.id))!;
    expect(feed.estadoSync.enCuarentenaDesde).not.toBeNull();
    expect(f.snapshot()).toBe(antes);
    const b = [1, 2, 3, 4, 10, 50].map((n) => calcularBackoffMs(n));
    for (let i = 1; i < b.length; i++) expect(b[i]!).toBeGreaterThanOrEqual(b[i - 1]!);
    expect(b[0]!).toBeLessThan(b[3]!);
    expect(b[5]!).toBe(b[4]!); // tope alcanzado
  });
});

describe("caso-12-bloqueo-manual-superpuesto-con-import", () => {
  it("el bloqueo manual se preserva (nunca se sobrescribe) y el solape queda como conflicto visible", async () => {
    const f = await crearFixture();
    const b = await crearBloqueo(f.db, { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, rango: { inicio: "2028-03-05", fin: "2028-03-08" }, razon: "BLOQUEO_PROPIETARIO" });
    const r = await f.importar(ics([{ uid: "caso12@airbnb.com", dtstart: "2028-03-04", dtend: "2028-03-10" }]));
    const bloqueo = f.ocupaciones().find((o) => o.id === b.ocupacionId)!;
    expect(bloqueo).toMatchObject({ estado: "confirmado", inicio: "2028-03-05", fin: "2028-03-08", capa: "bloqueo" });
    // La reserva de canal se acepta (el canal ya la confirmo) y el solape queda registrado como conflicto capa_cruzada visible.
    expect(r.reservasNuevas).toBe(1);
    const conflictos = [...f.store.conflictos.values()].filter((c) => c.unidadId === f.unidad.id);
    expect(conflictos).toHaveLength(1);
    expect(conflictos[0]).toMatchObject({ tipo: "capa_cruzada", resueltoEn: null });
    expect([conflictos[0]!.ocupacionAId, conflictos[0]!.ocupacionBId]).toContain(b.ocupacionId);
  });
});

describe("caso-13-uid-reciclado", () => {
  it("SEQUENCE mayor con DTSTAMP anterior y contenido distinto va a revision humana; la reserva original no se toca", async () => {
    const f = await crearFixture();
    const uid = "caso13@airbnb.com";
    await f.importar(ics([{ uid, sequence: 5, dtstamp: "20270601T000000Z", dtstart: "2028-04-01", dtend: "2028-04-05" }]));
    const r = await f.importar(ics([{ uid, sequence: 6, dtstamp: "20270101T000000Z", dtstart: "2029-01-01", dtend: "2029-01-10" }]));
    expect(r.revisionesUidReciclado).toHaveLength(1);
    expect(r.eventosAplicados).toBe(0);
    expect(f.activas()).toHaveLength(1);
    expect(f.activas()[0]).toMatchObject({ inicio: "2028-04-01", fin: "2028-04-05" });
  });

  it("sin SEQUENCE, DTSTAMP mas reciente y rango disjunto tambien va a revision (D-DSD-03); un solape real se aplica sin falso positivo", async () => {
    const f = await crearFixture();
    const uid = "caso13b@airbnb.com";
    await f.importar(ics([{ uid, dtstamp: "20261201T000000Z", dtstart: "2028-05-10", dtend: "2028-05-15" }]));
    const reciclado = await f.importar(ics([{ uid, dtstamp: "20270601T000000Z", dtstart: "2028-11-20", dtend: "2028-11-22" }]));
    expect(reciclado.revisionesUidReciclado).toHaveLength(1);
    const legitimo = await f.importar(ics([{ uid, dtstamp: "20270602T000000Z", dtstart: "2028-05-10", dtend: "2028-05-16" }]));
    expect(legitimo.revisionesUidReciclado).toHaveLength(0);
    expect(legitimo.eventosAplicados).toBe(1);
    expect(f.activas()[0]).toMatchObject({ inicio: "2028-05-10", fin: "2028-05-16" });
  });
});

describe("caso-14-dst-madrid-y-nueva-york-2027", () => {
  // Las noches se calculan en la zona de la propiedad (RFC 5545 §3.3.5: hora local, no sumar 24 h). Los cambios de hora 2027: Madrid
  // 28-mar y 31-oct; Nueva York 14-mar y 7-nov. Con el dia UTC se obtendria una noche de mas o de menos.
  const casos: ReadonlyArray<{ nombre: string; zona: string; dtstart: string; dtend: string; inicio: string; fin: string }> = [
    { nombre: "Madrid, salto de primavera (UTC)", zona: "Europe/Madrid", dtstart: "20270327T230000Z", dtend: "20270329T220000Z", inicio: "2027-03-28", fin: "2027-03-30" },
    { nombre: "Madrid, retroceso de otono (UTC)", zona: "Europe/Madrid", dtstart: "20271029T220000Z", dtend: "20271031T230000Z", inicio: "2027-10-30", fin: "2027-11-01" },
    { nombre: "Nueva York, salto de primavera (UTC)", zona: "America/New_York", dtstart: "20270314T020000Z", dtend: "20270316T020000Z", inicio: "2027-03-13", fin: "2027-03-15" },
    { nombre: "Nueva York, retroceso de otono (UTC)", zona: "America/New_York", dtstart: "20271107T040000Z", dtend: "20271109T050000Z", inicio: "2027-11-07", fin: "2027-11-09" },
    { nombre: "Nueva York, hora local con TZID a traves del salto", zona: "America/New_York", dtstart: "TZID=America/New_York:20270313T150000", dtend: "TZID=America/New_York:20270315T110000", inicio: "2027-03-13", fin: "2027-03-15" },
    { nombre: "Madrid, hora local con TZID a traves del retroceso", zona: "Europe/Madrid", dtstart: "TZID=Europe/Madrid:20271030T150000", dtend: "TZID=Europe/Madrid:20271101T110000", inicio: "2027-10-30", fin: "2027-11-01" },
  ];
  it.each(casos)("$nombre", async ({ zona, dtstart, dtend, inicio, fin }) => {
    const f = await crearFixture();
    const r = await f.importar(ics([{ uid: `dst-${dtstart}@airbnb.com`, dtstart, dtend }]), f.canalAirbnb.id, zona);
    expect(r.eventosAplicados).toBe(1);
    expect(f.activas()[0]).toMatchObject({ inicio, fin });
  });
});

describe("caso-15-estancias-contiguas", () => {
  it("check-out de una = check-in de la otra no es solape: ambas se aceptan sin conflicto", async () => {
    const f = await crearFixture();
    const r = await f.importar(
      ics([
        { uid: "c15-a@airbnb.com", dtstart: "2028-06-01", dtend: "2028-06-05" },
        { uid: "c15-b@airbnb.com", dtstart: "2028-06-05", dtend: "2028-06-08" },
      ]),
    );
    expect(r.eventosAplicados).toBe(2);
    expect(r.conflictosDetectados).toBe(0);
    expect(f.activas().every((o) => o.estado === "confirmado")).toBe(true);
  });

  it("tambien entre canales y cruzando fin de mes y de ano", async () => {
    const f = await crearFixture();
    await f.importar(ics([{ uid: "c15-c@airbnb.com", dtstart: "2028-12-28", dtend: "2029-01-01" }]), f.canalAirbnb.id);
    const r = await f.importar(ics([{ uid: "c15-d@booking.com", dtstart: "2029-01-01", dtend: "2029-01-04" }]), f.canalBooking.id);
    expect(r.conflictosDetectados).toBe(0);
  });
});

describe("caso-16-crash-y-replay-a-mitad-de-batch", () => {
  const A = { uid: "c16-a@airbnb.com", sequence: 1, dtstart: "2028-07-01", dtend: "2028-07-03" };
  const B = { uid: "c16-b@airbnb.com", sequence: 1, dtstart: "2028-08-01", dtend: "2028-08-03" };

  it("un crash tras el primer evento y el replay del batch completo equivale a procesarlo una sola vez", async () => {
    const limpio = await crearFixture();
    await limpio.importar(ics([A, B]));

    const conCrash = await crearFixture();
    await conCrash.importar(ics([A])); // el proceso murio despues de A
    const replay = await conCrash.importar(ics([A, B]));
    expect(replay.eventosAplicados).toBe(1); // solo B: A ya estaba
    const forma = (f: typeof limpio) => f.activas().map((o) => `${o.externalId}:${o.inicio}:${o.fin}`).sort();
    expect(forma(conCrash)).toEqual(forma(limpio));
  });

  it("repetir el batch completo no duplica ninguno de los dos eventos", async () => {
    const f = await crearFixture();
    await f.importar(ics([A, B]));
    const r = await f.importar(ics([A, B]).replace("VERSION:2.0", "VERSION:2.0\r\nX-REPLAY:1"));
    expect(r.eventosAplicados).toBe(0);
    expect(f.activas()).toHaveLength(2);
  });
});

describe("caso-17-limites-de-api-http-429", () => {
  it("un 429 es fallo de red (nunca exito), no cambia datos y el backoff respeta Retry-After sin reintento agresivo", async () => {
    const f = await crearFixture();
    f.port.definirEscenario(URL_AIRBNB, { tipo: "inaccesible", statusHttp: 429 });
    const r = await f.ciclo();
    expect(r.resultado).toBe("fallo_red");
    expect(f.ocupaciones()).toHaveLength(0);
    expect(calcularBackoffMs(1, undefined, 120)).toBe(120_000);
    expect(calcularBackoffMs(1, undefined, 10_000_000)).toBeLessThanOrEqual(calcularBackoffMs(99));
  });
});

describe("caso-18-aislamiento-multitenant", () => {
  it("a nivel dominio: un feed solo se resuelve con la property correcta", async () => {
    const f = await crearFixture();
    expect(await f.syncRepo.findFeed(randomUUID(), f.unidad.id, f.canalAirbnb.id)).toBeNull();
    expect(await f.syncRepo.findFeed(f.propertyId, f.unidad.id, f.canalAirbnb.id)).not.toBeNull();
  });
  it.skip("cruce cross-tenant por HTTP/RLS: se verifica en apps/api/tests/rentas-*.spec.ts (requirePropertyMembership) y scripts/verify-rentas-cron-rls, no en el dominio puro", () => {});
});

describe("caso-19-escalada-de-privilegios", () => {
  it.skip("enforcement de roles en capa de servicio: apps/api/tests/rentas-reservas.spec.ts (403 operador:solo_calendario), rentas-bloqueos.spec.ts y packages/domain-rentas/tests/roles.spec.ts; no aplica al motor de sync", () => {});
});

describe("caso-20-ssrf", () => {
  /** Puerto real con el guard SSRF y un resolvedor controlado (el RealIcalFeedPort de produccion usa DNS real). */
  const puertoSsrf = (ips: string[]): CalendarSyncPort => ({
    async fetchFeed(input: FetchFeedInput): Promise<FetchFeedResult> {
      const r = await fetchIcsSeguro({ url: input.url, etag: input.etag, ultimaModificacionHttp: input.ultimaModificacionHttp, resolverPersonalizado: () => ips });
      return { status: r.status, cuerpo: r.cuerpo, etag: r.etag, ultimaModificacionHttp: r.ultimaModificacionHttp, noModificado: r.noModificado };
    },
  });

  it.each([["169.254.169.254"], ["10.0.0.5"], ["172.16.0.1"], ["192.168.1.1"], ["127.0.0.1"], ["::ffff:127.0.0.1"]])("un feed que resuelve a %s se rechaza antes de conectar y no crea ocupaciones", async (ip) => {
    const f = await crearFixture();
    const feed = (await f.syncRepo.findFeed(f.propertyId, f.unidad.id, f.canalAirbnb.id))!;
    const r = await ejecutarCicloImportacion({ db: f.db, syncRepo: f.syncRepo, port: puertoSsrf([ip]), feed, zonaHorariaPropiedad: ZONA });
    expect(r.resultado).toBe("fallo_red");
    expect(f.ocupaciones()).toHaveLength(0);
  });
});

describe("D-DSD-04 -- anti-eco con rebote entre dos canales distintos", () => {
  it("lo exportado a Booking y reflejado por el feed de Airbnb (UID ajeno) se descarta como eco, y viceversa", async () => {
    const f = await crearFixture();
    await crearReservaConfirmada(f.db, { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, rango: { inicio: "2028-09-01", fin: "2028-09-05" }, estado: "confirmado", bloqueante: true });
    await exportarFeedParaUnidad({ syncRepo: f.syncRepo, organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, canalId: f.canalBooking.id }, "Unidad 1");
    const rAirbnb = await f.importar(ics([{ uid: "rebote-airbnb@airbnb.com", dtstart: "2028-09-01", dtend: "2028-09-05" }]), f.canalAirbnb.id);
    expect(rAirbnb.ecosDescartados).toBe(1);
    expect(f.activas()).toHaveLength(1); // solo la directa original

    await exportarFeedParaUnidad({ syncRepo: f.syncRepo, organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, canalId: f.canalAirbnb.id }, "Unidad 1");
    const rBooking = await f.importar(ics([{ uid: "rebote-booking@booking.com", dtstart: "2028-09-01", dtend: "2028-09-05" }]), f.canalBooking.id);
    expect(rBooking.ecosDescartados).toBe(1);
    expect(f.activas()).toHaveLength(1);
  });
});

describe("D-DSD-10 -- vacio inesperado solo cuando habia historial", () => {
  const vacio = (n: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\nX-N:${n}\r\nEND:VCALENDAR\r\n`;
  it("dos ciclos vacios consecutivos sin historial de eventos no alertan", async () => {
    const f = await crearFixture();
    const r1 = await f.importar(vacio("1"));
    const r2 = await f.importar(vacio("2"));
    expect(r1.resultado).toBe("exito_vacio");
    expect(r1.alertaCuarentena).toBeNull();
    expect(r2.alertaCuarentena).toBeNull();
  });
  it("un canal poblado que pasa a vacio SI alerta", async () => {
    const f = await crearFixture();
    await f.importar(ics([{ uid: "d10@airbnb.com", dtstart: "2028-10-01", dtend: "2028-10-03" }]));
    const r = await f.importar(vacio("poblado"));
    expect(r.alertaCuarentena?.tipo).toBe("vacio_inesperado");
    expect(f.activas()).toHaveLength(1);
  });
});

describe("D-DSD-12 -- crash entre el efecto de dominio y el bookkeeping", () => {
  it("reprocesar el UID tras perder el bookkeeping recupera la ocupacion existente: ni duplicado ni overbooking falso contra si misma", async () => {
    const f = await crearFixture();
    const uid = "d12@airbnb.com";
    const creada = await crearReservaConfirmada(f.db, { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, rango: { inicio: "2028-03-01", fin: "2028-03-05" }, estado: "confirmado", bloqueante: true, canalOrigenId: f.canalAirbnb.id, externalId: uid });
    expect(creada.conflicto).toBeNull();
    const r = await f.importar(ics([{ uid, sequence: 1, dtstart: "2028-03-01", dtend: "2028-03-05", status: "CONFIRMED" }]));
    expect(r.conflictosDetectados).toBe(0);
    expect(r.reservasNuevas).toBe(0);
    expect(f.ocupaciones()).toHaveLength(1);
    expect((await f.syncRepo.findVersionPrevia(f.unidad.id, f.canalAirbnb.id, uid))?.ocupacionId).toBe(creada.ocupacionId);
  });
});

describe("feed HTML disfrazado o truncado", () => {
  it("una pagina HTML con 200 OK no crea ocupaciones ni libera las existentes", async () => {
    const f = await crearFixture();
    await f.importar(ics([{ uid: "html@airbnb.com", dtstart: "2028-11-01", dtend: "2028-11-03" }]));
    const antes = f.snapshot();
    const r = await f.importar("<!doctype html><html><body><h1>Verify you are human</h1></body></html>");
    expect(["fallo_parseo", "exito_vacio"]).toContain(r.resultado);
    expect(f.snapshot()).toBe(antes);
  });

  it("un feed truncado a mitad de un VEVENT es fallo_parseo y no aplica el evento a medias", async () => {
    const f = await crearFixture();
    const completo = ics([{ uid: "trunc@airbnb.com", dtstart: "2028-11-10", dtend: "2028-11-12" }]);
    const r = await f.importar(completo.slice(0, completo.indexOf("DTEND")));
    expect(r.resultado).toBe("fallo_parseo");
    expect(f.ocupaciones()).toHaveLength(0);
  });
});
