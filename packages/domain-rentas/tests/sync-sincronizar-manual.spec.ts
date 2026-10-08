// Rn-P3-23 -- "Sincronizar ahora": ejecutarSincronizacionManualDeFeed corre UN feed con el lease existente.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import type { UnidadRecord } from "../src/types.ts";
import { FakeIcalFeedPort } from "../src/sync/calendar-sync-port.ts";
import { InMemoryRentasCalendarSyncRepository } from "../src/sync/in-memory-repository.ts";
import { ejecutarLoteSync, ejecutarSincronizacionManualDeFeed, type DepsLoteSync } from "../src/sync/lote.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const T0 = Date.parse("2026-10-01T12:00:00Z");

const ics = (uid: string, ini: string, fin: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", "BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${ini.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${fin.replaceAll("-", "")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

async function crear() {
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
  const canal = store.findCanalPorCodigo("airbnb")!;
  const { id } = await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canal.id, urlImportacion: URL_AIRBNB });
  const deps: DepsLoteSync = { conSesionSistema: (fn) => engine.withAppSession({ userId: null }, fn), crearSyncRepo: () => syncRepo, port, ahora: () => ahora };
  const feed = (await syncRepo.findFeedById(propertyId, id))!;
  return { deps, syncRepo, port, feed, propertyId, avanzar: (ms: number) => (ahora += ms) };
}

describe("ejecutarSincronizacionManualDeFeed", () => {
  it("sincroniza el feed, registra la bitácora y libera el lease", async () => {
    const { deps, port, feed, syncRepo, propertyId } = await crear();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });

    const r = await ejecutarSincronizacionManualDeFeed(deps, feed);

    expect(r.estado).toBe("sincronizado");
    if (r.estado !== "sincronizado") return;
    expect(r.fila).toMatchObject({ canal: "airbnb", resultado: "exito_con_eventos", eventosAplicados: 1, reservasNuevas: 1 });
    const [monitor] = await syncRepo.listarFeedsMonitor(propertyId);
    expect(monitor!.leaseHasta).toBeNull();
    const bitacora = await syncRepo.listarBitacora(propertyId, { soloAlertasAbiertas: false, limite: 10 });
    expect(bitacora.disponible && bitacora.alertas.map((a) => a.tipo)).toEqual(["sync_con_cambios"]);
  });

  it("si otro proceso tiene el lease responde `ocupado` y NO descarga el feed", async () => {
    const { deps, port, feed, syncRepo } = await crear();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });
    const ajeno = await syncRepo.reclamarFeedManual(feed.id, 120);
    expect(ajeno).toMatchObject({ disponible: true, leaseToken: expect.any(String) });

    expect(await ejecutarSincronizacionManualDeFeed(deps, feed)).toEqual({ estado: "ocupado" });
    expect(port.calls).toHaveLength(0);
  });

  it("el lease que toma la sincronización manual también frena al lote periódico", async () => {
    const { deps, port, feed, syncRepo, propertyId } = await crear();
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });
    // El lease queda vigente mientras "otro proceso" sincroniza manualmente.
    await syncRepo.reclamarFeedManual(feed.id, 120);
    const lote = await ejecutarLoteSync(deps);
    expect(lote.feeds).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
    expect((await syncRepo.listarFeedsMonitor(propertyId))[0]!.leaseHasta).not.toBeNull();
  });

  it("ignora el backoff de un feed fallido (el usuario pidió reintentar ya) y, si falla otra vez, vuelve a fijar el backoff", async () => {
    const { deps, port, feed, syncRepo, propertyId, avanzar } = await crear();
    port.definirEscenario(URL_AIRBNB, { tipo: "inaccesible" });
    const primero = await ejecutarSincronizacionManualDeFeed(deps, feed);
    expect(primero).toMatchObject({ estado: "sincronizado", fila: { resultado: "fallo_red" } });
    const [tras] = await syncRepo.listarFeedsMonitor(propertyId);
    expect(tras!.proximoIntentoEn).not.toBeNull(); // backoff fijado por el fallo

    // Con backoff vigente el lote periódico no lo toca, pero la sincronización manual sí.
    avanzar(60_000);
    const lote = await ejecutarLoteSync(deps);
    expect(lote.feeds).toHaveLength(0);
    port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics("a1@airbnb", "2027-01-01", "2027-01-04") });
    const manual = await ejecutarSincronizacionManualDeFeed(deps, (await syncRepo.findFeedById(propertyId, feed.id))!);
    expect(manual).toMatchObject({ estado: "sincronizado", fila: { resultado: "exito_con_eventos" } });
    expect((await syncRepo.listarFeedsMonitor(propertyId))[0]!.proximoIntentoEn).toBeNull(); // el éxito limpia el backoff
  });

  it("base sin la migración 037: `no_disponible`, sin tocar el feed", async () => {
    const { deps, port, feed, syncRepo } = await crear();
    syncRepo.migracion037Disponible = false;
    expect(await ejecutarSincronizacionManualDeFeed(deps, feed)).toEqual({ estado: "no_disponible" });
    expect(port.calls).toHaveLength(0);
  });

  it("un feed inactivo (desconectado) no se reclama: `ocupado`", async () => {
    const { deps, feed, syncRepo, propertyId } = await crear();
    await syncRepo.disconnectFeed(propertyId, feed.unidadId, feed.canalId);
    expect(await ejecutarSincronizacionManualDeFeed(deps, feed)).toEqual({ estado: "ocupado" });
  });
});
