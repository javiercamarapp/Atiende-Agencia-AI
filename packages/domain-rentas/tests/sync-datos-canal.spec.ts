// Rn-P3-05 -- el motor iCal guarda el codigo de confirmacion y los ultimos 4 del telefono en la ocupacion creada, rellena reservas
// importadas antes de la migracion y degrada sin romper el ciclo contra una base sin migrar (SAVEPOINT; AbortAwareFakeSession).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import type { EjecutorTransaccional } from "../src/ejecutor.ts";
import type { UnidadRecord } from "../src/types.ts";
import { FakeIcalFeedPort } from "../src/sync/calendar-sync-port.ts";
import { InMemoryRentasCalendarSyncRepository } from "../src/sync/in-memory-repository.ts";
import { PostgresRentasCalendarSyncRepository } from "../src/sync/postgres-repository.ts";
import { ejecutarCicloImportacion } from "../src/sync/motor.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const URL_AIRBNB = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";
const ICS = readFileSync(new URL("./fixtures/airbnb-reserva.ics", import.meta.url), "utf8");

async function fixture() {
  const store = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(store);
  let db!: EjecutorTransaccional;
  await engine.withAppSession({ userId: null }, async (s) => {
    db = s;
  });
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1 };
  store.seedUnidad(unidad);
  const canal = store.findCanalPorCodigo("airbnb")!;
  const syncRepo = new InMemoryRentasCalendarSyncRepository(store);
  const port = new FakeIcalFeedPort();
  await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canal.id, urlImportacion: URL_AIRBNB });
  port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ICS });
  const cambiarFeed = (ics: string) => port.definirEscenario(URL_AIRBNB, { tipo: "ics", contenidoIcs: ics });
  const ciclo = async () => ejecutarCicloImportacion({ db, syncRepo, port, feed: (await syncRepo.findFeed(propertyId, unidad.id, canal.id))!, zonaHorariaPropiedad: "America/Mexico_City" });
  const datos = () => [...store.ocupaciones.values()].filter((o) => o.codigoConfirmacion || o.telefonoUltimos4).map((o) => ({ codigoConfirmacion: o.codigoConfirmacion ?? null, telefonoUltimos4: o.telefonoUltimos4 ?? null }));
  return { store, syncRepo, ciclo, unidad, cambiarFeed, datos };
}

describe("motor iCal -- datos del canal en la ocupacion", () => {
  it("al crear la reserva guarda codigo HM... y ultimos 4; el bloqueo sin DESCRIPTION no guarda nada", async () => {
    const { store, ciclo, unidad, datos } = await fixture();
    await ciclo();
    const ocupaciones = [...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id);
    expect(ocupaciones).toHaveLength(2);
    const conCodigo = ocupaciones.filter((o) => o.codigoConfirmacion);
    expect(conCodigo).toHaveLength(1);
    expect(datos()).toEqual([{ codigoConfirmacion: "HMAB12CD34", telefonoUltimos4: "0123" }]);
    expect(conCodigo[0]!.externalId).toBe("1418fb94e984-ff1c0a7c0f3f@airbnb.com");
  });

  it("una segunda corrida sin cambios no duplica ni pierde el dato", async () => {
    const { ciclo, datos } = await fixture();
    await ciclo();
    await ciclo();
    expect(datos()).toHaveLength(1);
  });

  it("rellena una reserva importada ANTES de la migracion (el evento no cambio pero faltaba el dato)", async () => {
    const { store, ciclo, cambiarFeed, datos } = await fixture();
    await ciclo();
    for (const o of store.ocupaciones.values()) {
      o.codigoConfirmacion = null;
      o.telefonoUltimos4 = null;
    }
    // El feed cambia (un evento nuevo): el evento de la reserva viene igual (sin_cambio) pero faltaba el dato.
    cambiarFeed(ICS.replace("END:VCALENDAR", "BEGIN:VEVENT\r\nDTEND;VALUE=DATE:20261205\r\nDTSTART;VALUE=DATE:20261201\r\nUID:otro@airbnb.com\r\nDTSTAMP:20261001T120000Z\r\nSUMMARY:Airbnb (Not available)\r\nEND:VEVENT\r\nEND:VCALENDAR"));
    await ciclo();
    expect(datos()).toEqual([{ codigoConfirmacion: "HMAB12CD34", telefonoUltimos4: "0123" }]);
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("PostgresRentasCalendarSyncRepository.guardarDatosCanalOcupacion -- base sin la migracion 035", () => {
  const SIGUIENTE = { match: /select 1 as siguiente/i, respond: () => [{ ok: true }] };

  it("42703 -> false sin lanzar, transaccion utilizable y no vuelve a intentar en esta instancia", async () => {
    let intentos = 0;
    const session = new AbortAwareFakeSession([
      { match: /update rentas\.ocupacion/i, respond: () => { intentos++; return pgError("42703", 'column "codigo_confirmacion" of relation "ocupacion" does not exist'); } },
      SIGUIENTE,
    ]);
    const repo = new PostgresRentasCalendarSyncRepository(session);
    await expect(repo.guardarDatosCanalOcupacion("o1", { codigoConfirmacion: "HMAB12CD34", telefonoUltimos4: null })).resolves.toBe(false);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1 as siguiente")).resolves.toEqual({ rows: [{ ok: true }] });
    await expect(repo.guardarDatosCanalOcupacion("o2", { codigoConfirmacion: "HMAB12CD35", telefonoUltimos4: null })).resolves.toBe(false);
    expect(intentos).toBe(1);
  });

  it("sin datos no toca la base; un error que no es de migracion se propaga", async () => {
    const vacia = new AbortAwareFakeSession([]);
    await expect(new PostgresRentasCalendarSyncRepository(vacia).guardarDatosCanalOcupacion("o", { codigoConfirmacion: null, telefonoUltimos4: null })).resolves.toBe(false);
    expect(vacia.calls).toEqual([]);
    const mala = new AbortAwareFakeSession([{ match: /update rentas\.ocupacion/i, respond: () => pgError("40P01", "deadlock") }]);
    await expect(new PostgresRentasCalendarSyncRepository(mala).guardarDatosCanalOcupacion("o", { codigoConfirmacion: "HMAB12CD34", telefonoUltimos4: null })).rejects.toMatchObject({ code: "40P01" });
  });
});
