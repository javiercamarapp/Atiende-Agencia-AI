// H-12 -- oferta automatica FIFO de la lista de espera sobre el espejo en memoria.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryHotelesRepository, InMemoryCambioFechasRepository, InMemoryListaEsperaRepository, ofrecerLugaresLiberados, type NuevaEntradaListaEspera } from "../src/index.ts";

const P = "00000000-0000-4000-8000-0000000000a1";
const T = "00000000-0000-4000-8000-0000000000b1";
const T2 = "00000000-0000-4000-8000-0000000000b2";
const AHORA = new Date("2031-07-01T18:00:00Z");

function setup(total = 1, booked = 1) {
  const hoteles = new InMemoryHotelesRepository();
  hoteles.seedRoomType(P, T, { name: "Doble", maxOccupancy: 2 });
  hoteles.seedRoomType(P, T2, { name: "Suite", maxOccupancy: 2 });
  for (const d of ["2031-07-03", "2031-07-04", "2031-07-05", "2031-07-06"]) {
    hoteles.seedAvailability(P, T, d, total, booked);
    hoteles.seedAvailability(P, T2, d, total, booked);
  }
  return { hoteles, lista: new InMemoryListaEsperaRepository(), fechas: new InMemoryCambioFechasRepository(hoteles) };
}
const nueva = (over: Partial<NuevaEntradaListaEspera> = {}): NuevaEntradaListaEspera => ({ propertyId: P, roomTypeId: T, checkInDate: "2031-07-03", checkOutDate: "2031-07-05", huespedes: 2, nombre: "Ana", telefono: "5511112222", email: null, notas: null, ...over });

describe("ofrecerLugaresLiberados", () => {
  // Solo se falsea Date (sin timers vivos): la validacion de vencimiento del espejo usa el reloj.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AHORA);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ofrece por orden de llegada (FIFO) y no ofrece el mismo lugar a dos entradas a la vez", async () => {
    const s = setup();
    s.hoteles.seedAvailability(P, T, "2031-07-03", 1, 0); // el lugar se libero (1 total, 0 reservadas)
    s.hoteles.seedAvailability(P, T, "2031-07-04", 1, 0);
    const primera = await s.lista.crear(nueva({ nombre: "Primera" }));
    const segunda = await s.lista.crear(nueva({ nombre: "Segunda" }));
    const ofrecidas = await ofrecerLugaresLiberados({ lista: s.lista, disponibilidad: s.fechas, propertyId: P, roomTypeId: T, desde: "2031-07-03", hasta: "2031-07-05", ahora: AHORA });
    expect(ofrecidas.map((e) => e.id)).toEqual([primera.id]);
    expect((await s.lista.buscar(P, primera.id))?.estado).toBe("ofrecida");
    expect((await s.lista.buscar(P, segunda.id))?.estado).toBe("activa");
    expect((await s.lista.buscar(P, primera.id))?.ofertaVenceEn).toBe(new Date(AHORA.getTime() + 24 * 3_600_000).toISOString());
  });

  it("con dos lugares liberados ofrece a las dos primeras; la tercera sigue esperando", async () => {
    const s = setup(2, 0);
    const ids: string[] = [];
    for (const n of ["A", "B", "C"]) {
      ids.push((await s.lista.crear(nueva({ nombre: n }))).id);
      }
    const ofrecidas = await ofrecerLugaresLiberados({ lista: s.lista, disponibilidad: s.fechas, propertyId: P, roomTypeId: T, desde: "2031-07-03", hasta: "2031-07-05", ahora: AHORA });
    expect(ofrecidas.map((e) => e.id)).toEqual([ids[0], ids[1]]);
  });

  it("solo ofrece entradas del mismo tipo de habitacion, con fechas traslapadas y con cupo en TODAS sus noches", async () => {
    const s = setup(1, 1);
    s.hoteles.seedAvailability(P, T, "2031-07-03", 1, 0); // libre solo la noche 3; la 4 sigue llena
    const otroTipo = await s.lista.crear(nueva({ roomTypeId: T2 }));
    const sinTraslape = await s.lista.crear(nueva({ checkInDate: "2031-07-05", checkOutDate: "2031-07-06" }));
    const dosNoches = await s.lista.crear(nueva({ nombre: "Dos noches" })); // 3 y 4: la 4 no tiene cupo
    const unaNoche = await s.lista.crear(nueva({ nombre: "Una noche", checkOutDate: "2031-07-04" }));
    const ofrecidas = await ofrecerLugaresLiberados({ lista: s.lista, disponibilidad: s.fechas, propertyId: P, roomTypeId: T, desde: "2031-07-03", hasta: "2031-07-04", ahora: AHORA });
    expect(ofrecidas.map((e) => e.id)).toEqual([unaNoche.id]);
    for (const e of [otroTipo, sinTraslape, dosNoches]) expect((await s.lista.buscar(P, e.id))?.estado).toBe("activa");
  });

  it("no hace nada si no hay entradas activas o la base no esta migrada", async () => {
    const s = setup(2, 0);
    expect(await ofrecerLugaresLiberados({ lista: s.lista, disponibilidad: s.fechas, propertyId: P, roomTypeId: T, desde: "2031-07-03", hasta: "2031-07-05", ahora: AHORA })).toEqual([]);
    await s.lista.crear(nueva());
    s.lista.migrated = false;
    expect(await ofrecerLugaresLiberados({ lista: s.lista, disponibilidad: s.fechas, propertyId: P, roomTypeId: T, desde: "2031-07-03", hasta: "2031-07-05", ahora: AHORA })).toEqual([]);
  });

  it("las horas de oferta se acotan a 1..168", async () => {
    const s = setup(2, 0);
    const e = await s.lista.crear(nueva());
    const [o] = await ofrecerLugaresLiberados({ lista: s.lista, disponibilidad: s.fechas, propertyId: P, roomTypeId: T, desde: "2031-07-03", hasta: "2031-07-05", ahora: AHORA, horasOferta: 99999 });
    expect(o?.id).toBe(e.id);
    expect(new Date(o?.ofertaVenceEn as string).getTime() - Date.now()).toBeLessThanOrEqual(168 * 3_600_000 + 5_000);
  });
});
