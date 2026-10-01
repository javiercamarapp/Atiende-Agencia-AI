// H-28 -- cliente de Recepcion: URLs/metodos/cuerpos reales contra apps/api/.../hoteles/recepcion.ts y la seleccion de
// habitaciones candidatas del rack.
import { describe, expect, it, vi } from "vitest";
import { cambiarHabitacion, checkIn, checkOut, fetchRecepcion, habitacionesCandidatas } from "../src/verticals/hoteles/lib/recepcion-client.ts";
import type { RackHabitacion } from "../src/verticals/hoteles/lib/recepcion-client.ts";

function recorder(body: unknown, status = 200) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const B = "http://api.local";
const R = `${B}/hoteles/prop-1/recepcion`;

describe("lecturas y acciones", () => {
  it("fetchRecepcion acepta fecha opcional y la codifica", async () => {
    const r = recorder({ fecha: "2026-12-02" });
    await fetchRecepcion(r.impl, B, "tok", "prop-1");
    await fetchRecepcion(r.impl, B, "tok", "prop-1", "2026-12-02");
    expect(r.calls.map((c) => c.url)).toEqual([R, `${R}?fecha=2026-12-02`]);
  });

  it("check-in manda la habitacion solo si se eligio una; check-out y cambio llaman a su ruta", async () => {
    const r = recorder({ ok: true });
    await checkIn(r.impl, B, "tok", "prop-1", "res-1");
    await checkIn(r.impl, B, "tok", "prop-1", "res-1", "room-9");
    await checkOut(r.impl, B, "tok", "prop-1", "res-1");
    await cambiarHabitacion(r.impl, B, "tok", "prop-1", "res-1", "room-3");
    await cambiarHabitacion(r.impl, B, "tok", "prop-1", "res-1", "room-3", "Ruido");
    expect(r.calls).toEqual([
      { url: `${R}/reservas/res-1/check-in`, method: "POST", body: {} },
      { url: `${R}/reservas/res-1/check-in`, method: "POST", body: { roomId: "room-9" } },
      { url: `${R}/reservas/res-1/check-out`, method: "POST", body: {} },
      { url: `${R}/reservas/res-1/cambiar-habitacion`, method: "POST", body: { roomId: "room-3" } },
      { url: `${R}/reservas/res-1/cambiar-habitacion`, method: "POST", body: { roomId: "room-3", motivo: "Ruido" } },
    ]);
  });

  it("un error del servidor se propaga (no se inventa un mensaje)", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ code: "habitacion_ocupada", message: "La habitacion 102 tiene otra reserva en esas fechas." }), { status: 409 })) as unknown as typeof fetch;
    await expect(checkIn(impl, B, "tok", "prop-1", "res-1", "room-9")).rejects.toThrow(/102/);
  });
});

describe("habitacionesCandidatas", () => {
  const h = (roomId: string, over: Partial<RackHabitacion>): RackHabitacion => ({
    roomId,
    codigo: roomId,
    tipoHabitacionId: "doble",
    tipoHabitacion: "Doble",
    estado: "disponible",
    limpieza: null,
    fueraDeServicio: null,
    ocupacion: "libre",
    reserva: null,
    ...over,
  });
  const rack = [h("101", {}), h("102", { estado: "sucia" }), h("103", { ocupacion: "ocupada" }), h("104", { ocupacion: "llegada" }), h("105", { estado: "fuera_de_servicio" }), h("201", { tipoHabitacionId: "suite" }), h("106", {})];

  it("ofrece solo habitaciones libres, limpias y del mismo tipo", () => {
    expect(habitacionesCandidatas(rack, "doble").map((x) => x.roomId)).toEqual(["101", "106"]);
    expect(habitacionesCandidatas(rack, "suite").map((x) => x.roomId)).toEqual(["201"]);
  });

  it("excluye la habitacion actual y, sin tipo conocido, no filtra por tipo", () => {
    expect(habitacionesCandidatas(rack, "doble", "101").map((x) => x.roomId)).toEqual(["106"]);
    expect(habitacionesCandidatas(rack, null).map((x) => x.roomId)).toEqual(["101", "201", "106"]);
  });
});
