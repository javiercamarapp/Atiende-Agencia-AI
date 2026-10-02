// H-28 -- reglas de `aplicarCambio` (espejo en memoria de hoteles.change_reservation_dates): noches posteadas intactas, inventario por
// noche, traslape de habitacion, fechas esperadas y la carrera de dos cambios por el ultimo cupo (sin sobreventa).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCambioFechasRepository, InMemoryHotelesRepository, CambioFechasConflictError, CambioFechasInvalidInputError, CambioFechasUnavailableError, type AplicarCambioFechasInput } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-0000000000f1";
const P = "00000000-0000-4000-8000-0000000000a1";
const T = "00000000-0000-4000-8000-0000000000b1";

function setup() {
  const hoteles = new InMemoryHotelesRepository();
  hoteles.seedRoomType(P, T, { name: "Doble", maxOccupancy: 2 });
  for (let d = 1; d <= 9; d++) hoteles.seedAvailability(P, T, `2031-07-0${d}`, 3, 0);
  const repo = new InMemoryCambioFechasRepository(hoteles);
  const reserva = (over: { status?: "confirmada" | "en_estancia" | "cancelada"; in: string; out: string; roomId?: string | null }) => {
    const id = randomUUID();
    hoteles.seedReservation({ id, organizationId: ORG, propertyId: P, roomTypeId: T, guestId: null, checkInDate: over.in, checkOutDate: over.out, status: over.status ?? "confirmada", totalAmount: 1000, cancellationPenaltyAmount: null, canceledAt: null, createdAt: "2031-06-01T00:00:00Z", roomId: over.roomId ?? null });
    return id;
  };
  const cambio = (id: string, esperada: [string, string], nueva: [string, string], over: Partial<AplicarCambioFechasInput> = {}): AplicarCambioFechasInput => ({
    propertyId: P, reservationId: id, esperadaEntrada: esperada[0], esperadaSalida: esperada[1], nuevaEntrada: nueva[0], nuevaSalida: nueva[1], nuevoTotalNeto: 5000, penalidad: 0, motivo: null, ...over,
  });
  const booked = async (d: string) => (await repo.cargarDisponibilidad(P, T, d, d)).noches[0]?.bookedRooms;
  return { hoteles, repo, reserva, cambio, booked };
}

describe("InMemoryCambioFechasRepository.aplicarCambio", () => {
  it("reserva solo las noches agregadas, libera solo las quitadas y actualiza fechas y total", async () => {
    const s = setup();
    const id = s.reserva({ in: "2031-07-03", out: "2031-07-05" });
    await s.hoteles.bookAvailability(P, T, "2031-07-03", 1);
    await s.hoteles.bookAvailability(P, T, "2031-07-04", 1);
    const r = await s.repo.aplicarCambio(s.cambio(id, ["2031-07-03", "2031-07-05"], ["2031-07-04", "2031-07-07"]));
    expect(r).toMatchObject({ nochesLiberadas: 1, nochesReservadas: 2, totalNeto: 5000 });
    expect([await s.booked("2031-07-03"), await s.booked("2031-07-04"), await s.booked("2031-07-05"), await s.booked("2031-07-06")]).toEqual([0, 1, 1, 1]);
    expect(await s.hoteles.findReservation(P, id)).toMatchObject({ checkInDate: "2031-07-04", checkOutDate: "2031-07-07", totalAmount: 5000 });
    expect(s.repo.bitacora).toHaveLength(1);
  });

  it("noches ya posteadas por el night-audit no se tocan: acortar por debajo de una noche posteada falla y no cambia nada", async () => {
    const s = setup();
    const id = s.reserva({ status: "en_estancia", in: "2031-07-01", out: "2031-07-04" });
    for (const d of ["2031-07-01", "2031-07-02", "2031-07-03"]) await s.hoteles.bookAvailability(P, T, d, 1);
    const folio = await s.hoteles.ensurePrimaryFolio(P, ORG, id);
    for (const d of ["2031-07-01", "2031-07-02"]) {
      await s.hoteles.insertCharge({ organizationId: ORG, propertyId: P, folioId: folio.id, description: `Hospedaje ${d}`, amount: 1000, taxAmount: 160, concept: "hospedaje", stayDate: d });
    }
    const err = await s.repo.aplicarCambio(s.cambio(id, ["2031-07-01", "2031-07-04"], ["2031-07-01", "2031-07-02"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CambioFechasConflictError);
    expect((err as CambioFechasConflictError).code).toBe("noches_posteadas");
    expect(await s.booked("2031-07-03")).toBe(1);
    expect(await s.hoteles.findReservation(P, id)).toMatchObject({ checkOutDate: "2031-07-04" });
    // acortar hasta la noche 3 (las posteadas siguen dentro) si es valido
    await expect(s.repo.aplicarCambio(s.cambio(id, ["2031-07-01", "2031-07-04"], ["2031-07-01", "2031-07-03"]))).resolves.toMatchObject({ nochesLiberadas: 1 });
    // y la llegada con el huesped en casa no se mueve
    await expect(s.repo.aplicarCambio(s.cambio(id, ["2031-07-01", "2031-07-03"], ["2031-07-02", "2031-07-03"]))).rejects.toBeInstanceOf(CambioFechasInvalidInputError);
  });

  it("sin cupo en una noche agregada: 409 sin_disponibilidad y el inventario de las otras noches queda como estaba", async () => {
    const s = setup();
    const id = s.reserva({ in: "2031-07-03", out: "2031-07-04" });
    await s.hoteles.bookAvailability(P, T, "2031-07-03", 1);
    s.hoteles.seedAvailability(P, T, "2031-07-05", 1, 1); // 07-04 libre, 07-05 llena
    const err = await s.repo.aplicarCambio(s.cambio(id, ["2031-07-03", "2031-07-04"], ["2031-07-03", "2031-07-06"])).catch((e: unknown) => e);
    expect((err as CambioFechasConflictError).code).toBe("sin_disponibilidad");
    expect(await s.booked("2031-07-04")).toBe(0);
    expect(await s.hoteles.findReservation(P, id)).toMatchObject({ checkOutDate: "2031-07-04" });
  });

  it("DOS cambios simultaneos por el ultimo cupo de una noche: uno entra y el otro no sobrevende", async () => {
    const s = setup();
    s.hoteles.seedAvailability(P, T, "2031-07-05", 1, 0);
    const a = s.reserva({ in: "2031-07-03", out: "2031-07-05" });
    const b = s.reserva({ in: "2031-07-03", out: "2031-07-05" });
    const resultados = await Promise.allSettled([
      s.repo.aplicarCambio(s.cambio(a, ["2031-07-03", "2031-07-05"], ["2031-07-03", "2031-07-06"])),
      s.repo.aplicarCambio(s.cambio(b, ["2031-07-03", "2031-07-05"], ["2031-07-03", "2031-07-06"])),
    ]);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rechazo = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rechazo.reason as CambioFechasConflictError).code).toBe("sin_disponibilidad");
    expect(await s.booked("2031-07-05")).toBe(1);
  });

  it("fechas esperadas desactualizadas, estados no modificables, habitacion con otra reserva y base sin migrar", async () => {
    const s = setup();
    const id = s.reserva({ in: "2031-07-03", out: "2031-07-05", roomId: "00000000-0000-4000-8000-0000000000c1" });
    s.reserva({ in: "2031-07-05", out: "2031-07-08", roomId: "00000000-0000-4000-8000-0000000000c1" });
    const code = async (i: AplicarCambioFechasInput) => ((await s.repo.aplicarCambio(i).catch((e: unknown) => e)) as { code?: string }).code;
    expect(await code(s.cambio(id, ["2031-07-03", "2031-07-04"], ["2031-07-03", "2031-07-06"]))).toBe("reserva_modificada");
    expect(await code(s.cambio(id, ["2031-07-03", "2031-07-05"], ["2031-07-03", "2031-07-06"]))).toBe("habitacion_ocupada");
    const cancelada = s.reserva({ status: "cancelada", in: "2031-07-03", out: "2031-07-05" });
    expect(await code(s.cambio(cancelada, ["2031-07-03", "2031-07-05"], ["2031-07-03", "2031-07-06"]))).toBe("reserva_no_modificable");
    s.repo.migrated = false;
    await expect(s.repo.aplicarCambio(s.cambio(id, ["2031-07-03", "2031-07-05"], ["2031-07-03", "2031-07-04"]))).rejects.toBeInstanceOf(CambioFechasUnavailableError);
  });
});
