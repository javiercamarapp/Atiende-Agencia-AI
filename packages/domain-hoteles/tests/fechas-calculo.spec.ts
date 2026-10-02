// H-28 -- reglas puras del cambio de fechas: recotizacion, cupo (solo noches agregadas), penalidad por acortar y bloqueos.
import { describe, expect, it } from "vitest";
import { previsualizarCambioFechas, calcularPenalidadAcortamiento, type PrevisualizarCambioFechasInput, type NightlyRateRecord } from "../src/index.ts";

const rate = (date: string, price = 1000, over: Partial<NightlyRateRecord> = {}): NightlyRateRecord => ({ date, price, minStay: 1, closedToArrival: false, closedToDeparture: false, ...over });
const fechas = (desde: number, hasta: number) => Array.from({ length: hasta - desde + 1 }, (_, i) => `2031-07-${String(desde + i).padStart(2, "0")}`);
const TARIFAS = fechas(1, 12).map((d) => rate(d));
const DISP = {
  noches: fechas(1, 12).map((date) => ({ date, totalRooms: 2, bookedRooms: 1 })),
  overbooking: { maxOverbookRooms: 0, occupancyThresholdPct: 95 },
};

function base(over: Partial<PrevisualizarCambioFechasInput> = {}): PrevisualizarCambioFechasInput {
  return {
    estado: "confirmada",
    entrada: "2031-07-03",
    salida: "2031-07-05",
    totalNeto: 2000,
    nuevaEntrada: "2031-07-03",
    nuevaSalida: "2031-07-06",
    hoy: "2031-07-01",
    ahora: new Date("2031-07-01T18:00:00Z"),
    tarifas: TARIFAS,
    impuestos: { ivaRate: 0.16, ishRate: 0.03 },
    politica: { freeUntilHours: 48, penaltyPct: 0.5 },
    disponibilidad: DISP,
    ...over,
  };
}

describe("previsualizarCambioFechas", () => {
  it("extender una noche recotiza con el motor (neto + IVA + ISH) y compara contra el total actual", () => {
    const p = previsualizarCambioFechas(base());
    expect(p.puedeCambiar).toBe(true);
    expect(p.actual).toMatchObject({ noches: 2, neto: 2000, iva: 320, ish: 60, total: 2380 });
    expect(p.nueva).toMatchObject({ noches: 3, neto: 3000, iva: 480, ish: 90, total: 3570 });
    expect(p.diferenciaTotal).toBe(1190);
    expect(p.nochesAgregadas).toEqual(["2031-07-05"]);
    expect(p.nochesQuitadas).toEqual([]);
    expect(p.penalidad).toEqual({ monto: 0, porcentaje: 0, horasParaLaNoche: null });
  });

  it("usa las tarifas por noche (una noche mas cara cambia el total) y no el promedio", () => {
    const p = previsualizarCambioFechas(base({ tarifas: TARIFAS.map((r) => (r.date === "2031-07-05" ? { ...r, price: 2500 } : r)) }));
    expect(p.nueva?.neto).toBe(4500);
  });

  it("solo las noches AGREGADAS piden cupo: las que ya eran de la reserva no cuentan contra el inventario", () => {
    const lleno = { ...DISP, noches: DISP.noches.map((n) => (n.date === "2031-07-03" || n.date === "2031-07-04" ? { ...n, bookedRooms: 2 } : n)) };
    expect(previsualizarCambioFechas(base({ disponibilidad: lleno })).puedeCambiar).toBe(true);
    const sinCupoNueva = { ...DISP, noches: DISP.noches.map((n) => (n.date === "2031-07-05" ? { ...n, bookedRooms: 2 } : n)) };
    const p = previsualizarCambioFechas(base({ disponibilidad: sinCupoNueva }));
    expect(p.puedeCambiar).toBe(false);
    expect(p.nochesSinCupo).toEqual(["2031-07-05"]);
    expect(p.bloqueos[0]?.codigo).toBe("sin_disponibilidad");
  });

  it("respeta la sobreventa controlada del tipo y trata una noche sin inventario como sin cupo", () => {
    const conSobreventa = { noches: DISP.noches.map((n) => (n.date === "2031-07-05" ? { ...n, bookedRooms: 2 } : n)), overbooking: { maxOverbookRooms: 1, occupancyThresholdPct: 95 } };
    expect(previsualizarCambioFechas(base({ disponibilidad: conSobreventa })).puedeCambiar).toBe(true);
    const sinFila = { ...DISP, noches: DISP.noches.filter((n) => n.date !== "2031-07-05") };
    expect(previsualizarCambioFechas(base({ disponibilidad: sinFila })).nochesSinCupo).toEqual(["2031-07-05"]);
  });

  it("acortar libera noches y calcula la penalidad por la politica de cancelacion (dentro de la ventana gratis no hay cargo)", () => {
    const dentro = previsualizarCambioFechas(base({ salida: "2031-07-07", totalNeto: 4000, nuevaSalida: "2031-07-05", ahora: new Date("2031-07-04T12:00:00Z") }));
    expect(dentro.nochesQuitadas).toEqual(["2031-07-05", "2031-07-06"]);
    // la primera noche quitada (5 jul 00:00Z) esta a 12 h: dentro de las 48 h -> 50% de 2 noches de 1000
    expect(dentro.penalidad).toEqual({ monto: 1000, porcentaje: 0.5, horasParaLaNoche: 12 });
    const libre = previsualizarCambioFechas(base({ salida: "2031-07-07", totalNeto: 4000, nuevaSalida: "2031-07-05", ahora: new Date("2031-07-01T00:00:00Z") }));
    expect(libre.penalidad.monto).toBe(0);
    expect(libre.diferenciaTotal).toBe(-2380);
  });

  it("sin politica configurada no hay penalidad", () => {
    expect(calcularPenalidadAcortamiento({ nochesQuitadas: ["2031-07-05"], tarifas: TARIFAS, totalNetoActual: 2000, nochesActuales: 2, ahora: new Date("2031-07-05T00:00:00Z"), politica: null }).monto).toBe(0);
  });

  it("con el huesped en casa: la llegada no cambia, se puede extender/acortar la salida y se ignoran restricciones de llegada de la fecha original", () => {
    const enCasa = base({ estado: "en_estancia", entrada: "2031-07-01", salida: "2031-07-04", totalNeto: 3000, hoy: "2031-07-02", nuevaEntrada: "2031-07-01", nuevaSalida: "2031-07-06", tarifas: TARIFAS.map((r) => (r.date === "2031-07-01" ? { ...r, closedToArrival: true, minStay: 9 } : r)) });
    const p = previsualizarCambioFechas(enCasa);
    expect(p.puedeCambiar).toBe(true);
    expect(p.nochesAgregadas).toEqual(["2031-07-04", "2031-07-05"]);
    const moverLlegada = previsualizarCambioFechas({ ...enCasa, nuevaEntrada: "2031-07-02" });
    expect(moverLlegada.bloqueos.map((b) => b.codigo)).toContain("llegada_no_modificable");
    const salidaPasada = previsualizarCambioFechas({ ...enCasa, nuevaSalida: "2031-07-01", hoy: "2031-07-02" });
    expect(salidaPasada.puedeCambiar).toBe(false);
  });

  it("una reserva confirmada respeta CTA y estancia minima de las fechas nuevas (motor de cotizacion)", () => {
    const cta = previsualizarCambioFechas(base({ nuevaEntrada: "2031-07-06", nuevaSalida: "2031-07-08", tarifas: TARIFAS.map((r) => (r.date === "2031-07-06" ? { ...r, closedToArrival: true } : r)) }));
    expect(cta.puedeCambiar).toBe(false);
    expect(cta.bloqueos.map((b) => b.codigo)).toContain("cerrado_a_llegada");
    const minStay = previsualizarCambioFechas(base({ tarifas: TARIFAS.map((r) => (r.date === "2031-07-03" ? { ...r, minStay: 5 } : r)) }));
    expect(minStay.bloqueos.map((b) => b.codigo)).toContain("estadia_minima_no_alcanzada");
    const sinTarifa = previsualizarCambioFechas(base({ tarifas: TARIFAS.filter((r) => r.date !== "2031-07-05") }));
    expect(sinTarifa.bloqueos.map((b) => b.codigo)).toContain("sin_tarifa");
  });

  it("bloquea estados no modificables, fechas invalidas, sin cambio, llegada en el pasado y estancias demasiado largas", () => {
    expect(previsualizarCambioFechas(base({ estado: "cancelada" })).bloqueos[0]?.codigo).toBe("reserva_no_modificable");
    expect(previsualizarCambioFechas(base({ estado: "check_out" })).puedeCambiar).toBe(false);
    expect(previsualizarCambioFechas(base({ nuevaSalida: "2031-07-03" })).bloqueos[0]?.codigo).toBe("fechas_invalidas");
    expect(previsualizarCambioFechas(base({ nuevaSalida: "2031-02-30" })).bloqueos[0]?.codigo).toBe("fechas_invalidas");
    expect(previsualizarCambioFechas(base({ nuevaEntrada: "2031-07-03", nuevaSalida: "2031-07-05" })).bloqueos[0]?.codigo).toBe("sin_cambio");
    expect(previsualizarCambioFechas(base({ nuevaEntrada: "2031-06-28", nuevaSalida: "2031-07-05" })).bloqueos.map((b) => b.codigo)).toContain("llegada_pasada");
    expect(previsualizarCambioFechas(base({ nuevaSalida: "2033-07-05" })).bloqueos[0]?.codigo).toBe("fechas_invalidas");
  });

  it("mover ambas fechas libera y reserva noches distintas", () => {
    const p = previsualizarCambioFechas(base({ nuevaEntrada: "2031-07-04", nuevaSalida: "2031-07-07" }));
    expect(p.nochesQuitadas).toEqual(["2031-07-03"]);
    expect(p.nochesAgregadas).toEqual(["2031-07-05", "2031-07-06"]);
    expect(p.nueva?.noches).toBe(3);
  });
});
