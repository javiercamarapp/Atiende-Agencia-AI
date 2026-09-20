// Tests de integración reales (no mocks de red) del motor de sincronización iCal —
// contra InMemoryRentasCalendarStore/InMemoryRentasTenancyEngine (mismo motor
// transaccional real de aplicacion/reservas.ts que usan apps/api/tests/
// rentas-reservas.spec.ts) + InMemoryRentasCalendarSyncRepository +
// FakeIcalFeedPort (sin red, mismo patrón que FakeGoogleCalendarPort de
// domain-citas). El camino de red REAL se prueba aparte en tests/sync-net-real.spec.ts
// con IcalFeedHttpSimulator + RealIcalFeedPort.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { crearBloqueo, crearReservaConfirmada } from "../src/aplicacion/reservas.ts";
import type { EjecutorTransaccional } from "../src/ejecutor.ts";
import type { UnidadRecord } from "../src/types.ts";
import { FakeIcalFeedPort } from "../src/sync/calendar-sync-port.ts";
import { InMemoryRentasCalendarSyncRepository } from "../src/sync/in-memory-repository.ts";
import { ejecutarCicloImportacion, exportarFeedParaUnidad, type ContextoSincronizacion } from "../src/sync/motor.ts";

const ZONA = "America/Mexico_City";
const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const URL_BOOKING = "https://admin.booking.com/hotel/ical/unidad-1.ics";

function icsConEvento(opts: { uid: string; dtstart: string; dtend: string; sequence?: number; dtstamp?: string; status?: string }): string {
  const lineas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", "BEGIN:VEVENT", `UID:${opts.uid}`, `DTSTAMP:${opts.dtstamp ?? "2026-01-01T00:00:00Z".replace(/[-:]/g, "")}`, `DTSTART;VALUE=DATE:${opts.dtstart.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${opts.dtend.replaceAll("-", "")}`];
  if (opts.sequence !== undefined) lineas.push(`SEQUENCE:${opts.sequence}`);
  if (opts.status) lineas.push(`STATUS:${opts.status}`);
  lineas.push("END:VEVENT", "END:VCALENDAR");
  return lineas.join("\r\n");
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

  const { id: feedId } = await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canalAirbnb.id, urlImportacion: URL_AIRBNB });

  async function ctxParaCanal(canalId: string): Promise<ContextoSincronizacion> {
    const feed = await syncRepo.findFeed(propertyId, unidad.id, canalId);
    return { db, syncRepo, port, feed: feed!, zonaHorariaPropiedad: ZONA };
  }

  async function ejecutarCiclo() {
    return ejecutarCicloImportacion(await ctxParaCanal(canalAirbnb.id));
  }

  return { store, db, organizationId, propertyId, unidad, canalAirbnb, canalBooking, syncRepo, port, feedId, ctxParaCanal, ejecutarCiclo };
}

describe("ejecutarCicloImportacion", () => {
  it("primera corrida: crea una ocupación capa='reserva' RESERVA_CANAL bloqueante a partir del feed externo", async () => {
    const { store, unidad, canalAirbnb, port, ejecutarCiclo } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-1@airbnb.com", dtstart: "2026-06-01", dtend: "2026-06-05" }) });

    const resumen = await ejecutarCiclo();
    expect(resumen.resultado).toBe("exito_con_eventos");
    expect(resumen.eventosAplicados).toBe(1);
    expect(resumen.eventosDescartadosPorError).toHaveLength(0);

    const ocupaciones = [...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id);
    expect(ocupaciones).toHaveLength(1);
    expect(ocupaciones[0]).toMatchObject({ capa: "reserva", razon: "RESERVA_CANAL", estado: "confirmado", bloqueante: true, canalOrigenId: canalAirbnb.id, externalId: "airbnb-evt-1@airbnb.com", inicio: "2026-06-01", fin: "2026-06-05" });
  });

  it("una reimportación exacta (mismo contenido) es sin_cambio: no crea una segunda ocupación", async () => {
    const { store, unidad, port, ejecutarCiclo } = await crearFixture();
    const ics = icsConEvento({ uid: "airbnb-evt-2@airbnb.com", dtstart: "2026-07-01", dtend: "2026-07-03" });
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics });

    await ejecutarCiclo();
    const r2 = await ejecutarCiclo();
    expect(r2.eventosAplicados).toBe(0);

    const ocupaciones = [...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id);
    expect(ocupaciones).toHaveLength(1);
  });

  it("una corrida con SEQUENCE mayor y fechas nuevas modifica la ocupación existente en vez de crear una nueva", async () => {
    const { store, unidad, port, ejecutarCiclo } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-3@airbnb.com", dtstart: "2026-08-01", dtend: "2026-08-04", sequence: 0 }) });
    await ejecutarCiclo();

    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-3@airbnb.com", dtstart: "2026-08-01", dtend: "2026-08-07", sequence: 1, dtstamp: "20260102T000000Z" }) });
    const r2 = await ejecutarCiclo();
    expect(r2.eventosAplicados).toBe(1);

    const ocupaciones = [...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id);
    expect(ocupaciones).toHaveLength(1);
    expect(ocupaciones[0]!.fin).toBe("2026-08-07");
  });

  it("STATUS:CANCELLED cancela la ocupación existente sin reabrir noches de otra causa", async () => {
    const { store, unidad, port, ejecutarCiclo } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-4@airbnb.com", dtstart: "2026-09-01", dtend: "2026-09-05", sequence: 0 }) });
    await ejecutarCiclo();

    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-4@airbnb.com", dtstart: "2026-09-01", dtend: "2026-09-05", sequence: 1, dtstamp: "20260102T000000Z", status: "CANCELLED" }) });
    const r2 = await ejecutarCiclo();
    expect(r2.eventosAplicados).toBe(1);

    const ocupacion = [...store.ocupaciones.values()].find((o) => o.unidadId === unidad.id)!;
    expect(ocupacion.estado).toBe("cancelado");
  });

  it("un feed 304 (no_modificado) no reprocesa eventos ni toca ocupaciones", async () => {
    const { store, unidad, port, ejecutarCiclo } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-5@airbnb.com", dtstart: "2026-10-01", dtend: "2026-10-03" }) });
    await ejecutarCiclo();

    port.definirEscenario(URL_AIRBNB, { tipo: "no_modificado" });
    const r2 = await ejecutarCiclo();
    expect(r2.resultado).toBe("no_modificado");
    expect(r2.eventosAplicados).toBe(0);
    expect([...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id)).toHaveLength(1);
  });

  it("un evento individual con rango inválido (DURATION:PT0S) se descarta sin abortar el resto del ciclo", async () => {
    const { unidad, port, ejecutarCiclo } = await crearFixture();
    const icsInvalido = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:malo@airbnb.com", "DTSTAMP:20260101T000000Z", "DTSTART;VALUE=DATE:20261101", "DURATION:PT0S", "END:VEVENT", "BEGIN:VEVENT", "UID:bueno@airbnb.com", "DTSTAMP:20260101T000000Z", "DTSTART;VALUE=DATE:20261110", "DTEND;VALUE=DATE:20261112", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsInvalido });

    const resumen = await ejecutarCiclo();
    expect(resumen.eventosDescartadosPorError).toHaveLength(1);
    expect(resumen.eventosDescartadosPorError[0]!.uid).toBe("malo@airbnb.com");
    expect(resumen.eventosAplicados).toBe(1); // el evento válido sí se aplicó
    void unidad;
  });

  // Hallazgo de auditoría (a3, MEDIA, corregido tras revisión de PR #175) — a
  // diferencia de la primera versión de este fix (que lanzaba desde el PARSER y
  // tumbaba el FEED entero, ver el comentario de cabecera de
  // `validarComponentesFecha` en ../src/ical/parser.ts), un DTSTART/DTEND con año
  // "0000" ahora se descarta SOLO ese evento -- mismo criterio y mismo mecanismo que
  // el rango inválido del test de arriba (validado en JS ANTES de cualquier SQL, ver
  // `motor.ts::anioFechaLocalValido`, junto a `esRangoValido`).
  it("un evento individual con año de calendario inválido (DTSTART año '0000') se descarta sin abortar el resto del ciclo", async () => {
    const { port, ejecutarCiclo } = await crearFixture();
    const icsConAnioInvalido = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:anio-invalido@airbnb.com",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;VALUE=DATE:00000101",
      "DTEND;VALUE=DATE:00000105",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:bueno-anio@airbnb.com",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;VALUE=DATE:20261201",
      "DTEND;VALUE=DATE:20261203",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConAnioInvalido });

    const resumen = await ejecutarCiclo();
    expect(resumen.resultado).toBe("exito_con_eventos"); // el feed se parseó completo, no "fallo_parseo"
    expect(resumen.eventosDescartadosPorError).toHaveLength(1);
    expect(resumen.eventosDescartadosPorError[0]!.uid).toBe("anio-invalido@airbnb.com");
    expect(resumen.eventosAplicados).toBe(1); // el evento con año válido sí se aplicó
  });

  // Hallazgo de auditoría (a3, ALTA) — a diferencia del test de arriba (rango
  // inválido, descartado en JS ANTES de cualquier SQL), este reproduce un error que
  // ocurre DENTRO de una llamada real al repositorio de sync (el camino que, contra
  // Postgres real, dejaba la transacción del feed ABORTADA -- ver el comentario de
  // cabecera de `procesarEventoDelCicloAislado`, motor.ts). El repositorio en memoria
  // nunca aborta una transacción por sí solo, así que este test verifica el mecanismo
  // DIRECTAMENTE: que `ctx.db.exec` recibe la secuencia SAVEPOINT/ROLLBACK TO
  // SAVEPOINT/RELEASE SAVEPOINT alrededor del evento venenoso, y que el evento sano
  // que sigue en el MISMO feed sí se aplica -- sin este fix, el error simplemente
  // escapaba del try/catch sin ningún exec() de por medio.
  it("SAVEPOINT por evento: un error real del repositorio de sync en un evento no impide que el siguiente evento del mismo feed se aplique", async () => {
    const { db, port, syncRepo, propertyId, unidad, canalAirbnb } = await crearFixture();
    const feed = await syncRepo.findFeed(propertyId, unidad.id, canalAirbnb.id);

    const execCalls: string[] = [];
    const dbEspiado = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "exec") {
          return async (sql: string) => {
            execCalls.push(sql);
            return target.exec(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const UID_VENENOSO = "evt-venenoso@airbnb.com";
    let vecesLlamado = 0;
    const syncRepoEnvenenado = new Proxy(syncRepo, {
      get(target, prop, receiver) {
        if (prop === "upsertEventoImportado") {
          return async (unidadId: string, canalId: string, entrada: Parameters<typeof syncRepo.upsertEventoImportado>[2]) => {
            if (entrada.uid === UID_VENENOSO) {
              vecesLlamado += 1;
              throw new Error("error real simulado del repositorio (ej. 23502/22003 contra Postgres real)");
            }
            return target.upsertEventoImportado(unidadId, canalId, entrada);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const icsDosEventos = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${UID_VENENOSO}`,
      "DTSTAMP:20260101T000000Z",
      "DTSTART;VALUE=DATE:20260701",
      "DTEND;VALUE=DATE:20260703",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:evt-sano@airbnb.com",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;VALUE=DATE:20260801",
      "DTEND;VALUE=DATE:20260803",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsDosEventos });

    const resumen = await ejecutarCicloImportacion({
      db: dbEspiado,
      syncRepo: syncRepoEnvenenado,
      port,
      feed: feed!,
      zonaHorariaPropiedad: ZONA,
    });

    expect(vecesLlamado).toBe(1); // el repositorio SÍ se llamó para el uid venenoso
    expect(resumen.eventosDescartadosPorError).toHaveLength(1);
    expect(resumen.eventosDescartadosPorError[0]!.uid).toBe(UID_VENENOSO);
    expect(resumen.eventosAplicados).toBe(1); // el evento sano SÍ se aplicó pese al error del anterior

    // La secuencia real que Postgres exige para recuperar una transacción abortada:
    // SAVEPOINT antes del intento, y ante el error, ROLLBACK TO SAVEPOINT + RELEASE
    // SAVEPOINT (en ese orden) ANTES de seguir con el siguiente evento. Se filtra por
    // el nombre propio del SAVEPOINT de `procesarEventoDelCicloAislado`
    // (`sp_evento_ciclo_`) -- `crearReservaConfirmada` (llamado dentro del evento SANO
    // también) usa sus PROPIOS SAVEPOINT internos (`sp_crear_reserva`/
    // `intento_insercion`) con su propio RELEASE, que no deben confundirse con los de
    // este aislamiento.
    const propios = execCalls.filter((c) => c.includes("sp_evento_ciclo_"));
    const savepointIdx = propios.findIndex((c) => c.startsWith("SAVEPOINT "));
    const rollbackIdx = propios.findIndex((c) => c.startsWith("ROLLBACK TO SAVEPOINT "));
    const releaseIdx = propios.findIndex((c) => c.startsWith("RELEASE SAVEPOINT "));
    expect(savepointIdx).toBeGreaterThanOrEqual(0);
    expect(rollbackIdx).toBeGreaterThan(savepointIdx);
    expect(releaseIdx).toBeGreaterThan(rollbackIdx);
  });

  it("cuarentena: tras 3 fallos de fetch consecutivos, el feed queda marcado en cuarentena", async () => {
    const { port, ejecutarCiclo, syncRepo, propertyId, unidad, canalAirbnb } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "inaccesible", statusHttp: 503 });

    for (let i = 0; i < 3; i++) await ejecutarCiclo();

    const feed = await syncRepo.findFeed(propertyId, unidad.id, canalAirbnb.id);
    expect(feed!.estadoSync.enCuarentenaDesde).not.toBeNull();
    expect(feed!.estadoSync.intentosFallidosConsecutivos).toBeGreaterThanOrEqual(3);
  });

  it("cuarentena: nunca libera/crea disponibilidad mientras el feed está en cuarentena — un éxito posterior sí sale de cuarentena", async () => {
    const { store, unidad, port, ejecutarCiclo, syncRepo, propertyId, canalAirbnb } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-6@airbnb.com", dtstart: "2026-11-01", dtend: "2026-11-03" }) });
    await ejecutarCiclo();

    port.definirEscenario(URL_AIRBNB, { tipo: "inaccesible" });
    for (let i = 0; i < 3; i++) await ejecutarCiclo();
    const enCuarentena = [...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id);
    expect(enCuarentena).toHaveLength(1); // sigue existiendo, nunca se liberó

    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-6@airbnb.com", dtstart: "2026-11-01", dtend: "2026-11-03" }) });
    await ejecutarCiclo();
    const feed = await syncRepo.findFeed(propertyId, unidad.id, canalAirbnb.id);
    expect(feed!.estadoSync.enCuarentenaDesde).toBeNull();
  });

  it("reconciliación completa: detecta drift cuando un UID activo desaparece del feed sin CANCEL explícito, sin cancelar automáticamente", async () => {
    const { store, port, ejecutarCiclo } = await crearFixture();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "airbnb-evt-7@airbnb.com", dtstart: "2026-12-01", dtend: "2026-12-03" }) });
    await ejecutarCiclo();

    // El canal deja de listar el evento por completo (sin STATUS:CANCELLED).
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "otro-evento-no-relacionado@airbnb.com", dtstart: "2027-01-01", dtend: "2027-01-02" }) });
    const resumen = await ejecutarCiclo();

    expect(resumen.driftReconciliacionCompleta).toBe(1);
    expect(resumen.candidatosACancelarPorAusencia).toHaveLength(1);
    // Nunca se cancela automáticamente: la ocupación original sigue activa.
    const original = [...store.ocupaciones.values()].find((o) => o.externalId === "airbnb-evt-7@airbnb.com")!;
    expect(original.estado).not.toBe("cancelado");
  });
});

describe("anti-eco", () => {
  it("capa 1 (namespace de UID propio): un import que refleja nuestro propio export nunca crea una reserva nueva", async () => {
    const { store, organizationId, propertyId, unidad, canalBooking, syncRepo, port, ctxParaCanal } = await crearFixture();

    // Reserva directa existente, exportada al canal Booking.
    const directa = await crearReservaConfirmada((await ctxParaCanal(canalBooking.id)).db, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2027-02-01", fin: "2027-02-05" }, estado: "confirmado", bloqueante: true });
    const feedExportado = await exportarFeedParaUnidad({ syncRepo, organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id }, "Unidad 1");
    const uidExportado = [...feedExportado.hashesPorOcupacion.keys()][0]!;
    expect(uidExportado).toBe(directa.ocupacionId);

    // Conectamos un feed de importación para Booking que "rebota" ese mismo UID
    // exportado (namespace propio) -- capa 1 del anti-eco.
    const { id: feedBookingId } = await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id, urlImportacion: URL_BOOKING });
    void feedBookingId;
    const uidNamespacePropio = feedExportado.contenidoIcs.match(/UID:([^\r\n]+)/)![1]!;
    port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: icsConEvento({ uid: uidNamespacePropio, dtstart: "2027-02-01", dtend: "2027-02-05" }) });

    const resumen = await ejecutarCicloImportacion(await ctxParaCanal(canalBooking.id));
    expect(resumen.ecosDescartados).toBe(1);
    expect(resumen.eventosAplicados).toBe(0);
    expect([...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id)).toHaveLength(1); // solo la directa original
  });

  it("capa 2 (hash de contenido): un import con UID nuevo pero mismo rango/razón que un export ya hecho se descarta como eco", async () => {
    const { store, organizationId, propertyId, unidad, canalBooking, syncRepo, port, ctxParaCanal } = await crearFixture();

    await crearReservaConfirmada((await ctxParaCanal(canalBooking.id)).db, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2027-03-10", fin: "2027-03-14" }, estado: "confirmado", bloqueante: true });
    await exportarFeedParaUnidad({ syncRepo, organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id }, "Unidad 1");

    await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id, urlImportacion: URL_BOOKING });
    // Booking nos refleja la misma reserva con SU PROPIO UID (no el namespace
    // propio) -- solo el hash de contenido (unidad, rango, RESERVA_CANAL) coincide.
    port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "booking-reserva-ajena-555@booking.com", dtstart: "2027-03-10", dtend: "2027-03-14" }) });

    const resumen = await ejecutarCicloImportacion(await ctxParaCanal(canalBooking.id));
    expect(resumen.ecosDescartados).toBe(1);
    expect([...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id)).toHaveLength(1);
  });

  it("capa 3 (rango ya exportado): un bloqueo de mantenimiento exportado y reflejado por otro canal con UID/razón distintos también se descarta como eco", async () => {
    const { store, organizationId, propertyId, unidad, canalBooking, syncRepo, port, ctxParaCanal, db } = await crearFixture();

    const bloqueo = await crearBloqueo(db, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2027-04-01", fin: "2027-04-03" }, razon: "MANTENIMIENTO" });
    void bloqueo;
    await exportarFeedParaUnidad({ syncRepo, organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id }, "Unidad 1");

    await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id, urlImportacion: URL_BOOKING });
    // El hash NO coincide (la razón entrante siempre se asume RESERVA_CANAL, el
    // bloqueo real es MANTENIMIENTO) -- solo la capa 3 (rango exacto ya exportado a
    // algún canal) puede detectar este eco.
    port.definirEscenario(URL_BOOKING, { tipo: "ics", contenidoIcs: icsConEvento({ uid: "reflejo-mantenimiento@booking.com", dtstart: "2027-04-01", dtend: "2027-04-03" }) });

    const resumen = await ejecutarCicloImportacion(await ctxParaCanal(canalBooking.id));
    expect(resumen.ecosDescartados).toBe(1);
    expect([...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id)).toHaveLength(1); // solo el bloqueo original, nunca una reserva nueva
  });
});

describe("exportarFeedParaUnidad", () => {
  it("nunca incrementa SEQUENCE si el contenido exportado no cambió entre corridas", async () => {
    const { organizationId, propertyId, unidad, canalBooking, syncRepo, db } = await crearFixture();
    await crearReservaConfirmada(db, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2027-05-01", fin: "2027-05-04" }, estado: "confirmado", bloqueante: true });

    const feed1 = await exportarFeedParaUnidad({ syncRepo, organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id }, "Unidad 1");
    const feed2 = await exportarFeedParaUnidad({ syncRepo, organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id }, "Unidad 1");

    const seq = (ics: string) => Number(ics.match(/SEQUENCE:(\d+)/)![1]);
    expect(seq(feed1.contenidoIcs)).toBe(seq(feed2.contenidoIcs));
  });

  // Hallazgo de auditoría (rubro 10, "performance y escalabilidad", severidad MEDIA):
  // "feed iCal público de rentas... ejecuta 3+2N queries por request" -- antes, este
  // motor llamaba a `findBloqueoExportadoPrevio`/`upsertBloqueoExportado` UNA VEZ POR
  // OCUPACIÓN ACTIVA (2N llamadas). Verifica que, con N ocupaciones activas, el
  // repositorio recibe exactamente UNA llamada de lectura y UNA de escritura por
  // corrida -- nunca una por ocupación -- y que el contenido exportado sigue siendo
  // correcto para las N.
  it("con N ocupaciones activas, ejecuta un número de llamadas al repositorio FIJO (1 lectura + 1 escritura), nunca 2N", async () => {
    const { organizationId, propertyId, unidad, canalBooking, syncRepo, db } = await crearFixture();

    const N = 6;
    for (let i = 0; i < N; i++) {
      const inicio = `2027-08-${String(1 + i * 3).padStart(2, "0")}`;
      const fin = `2027-08-${String(2 + i * 3).padStart(2, "0")}`;
      await crearReservaConfirmada(db, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio, fin }, estado: "confirmado", bloqueante: true });
    }

    const feed1 = await exportarFeedParaUnidad({ syncRepo, organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id }, "Unidad 1");
    expect(feed1.hashesPorOcupacion.size).toBe(N);
    expect((feed1.contenidoIcs.match(/BEGIN:VEVENT/g) ?? []).length).toBe(N);

    // El punto del hallazgo: sin importar N, exactamente UNA llamada de lectura y UNA
    // de escritura -- antes eran N+N (una por ocupación en cada fase del bucle).
    expect(syncRepo.llamadasFindBloqueosExportadosPrevios).toBe(1);
    expect(syncRepo.llamadasUpsertBloqueosExportadosBatch).toBe(1);

    // Segunda corrida sin cambios: sigue siendo 1+1 llamadas totales (nunca 2N más),
    // y el SEQUENCE de cada ocupación se mantiene estable (mismo criterio que el test
    // de arriba, ahora con N ocupaciones en vez de 1).
    const feed2 = await exportarFeedParaUnidad({ syncRepo, organizationId, propertyId, unidadId: unidad.id, canalId: canalBooking.id }, "Unidad 1");
    expect(syncRepo.llamadasFindBloqueosExportadosPrevios).toBe(2);
    expect(syncRepo.llamadasUpsertBloqueosExportadosBatch).toBe(2);
    const secuencias = (ics: string) => [...ics.matchAll(/SEQUENCE:(\d+)/g)].map((m) => Number(m[1])).sort();
    expect(secuencias(feed2.contenidoIcs)).toEqual(secuencias(feed1.contenidoIcs));
  });
});
