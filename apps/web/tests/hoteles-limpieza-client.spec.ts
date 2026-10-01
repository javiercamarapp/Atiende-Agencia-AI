// H-04 -- cliente del tablero de Housekeeping: URLs/metodos/cuerpos reales contra
// apps/api/.../hoteles/housekeeping.ts y la tabla de acciones por estado de la tarea.
import { describe, expect, it, vi } from "vitest";
import { accionTarea, accionesDisponibles, fetchCamaristas, fetchReporte, fetchTablero, generarDia, inhabilitar, marcarSucia, rehabilitar } from "../src/verticals/hoteles/lib/limpieza-client.ts";

function recorder(body: unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const B = "http://api.local";
const H = `${B}/hoteles/prop-1/housekeeping`;

describe("lecturas", () => {
  it("tablero y reporte aceptan fecha opcional", async () => {
    const r = recorder({ fecha: "2026-03-10", tareasDisponibles: true, habitaciones: [] });
    await fetchTablero(r.impl, B, "tok", "prop-1");
    await fetchTablero(r.impl, B, "tok", "prop-1", "2026-03-10");
    await fetchReporte(r.impl, B, "tok", "prop-1", "2026-03-10");
    expect(r.calls.map((c) => c.url)).toEqual([`${H}/tablero`, `${H}/tablero?fecha=2026-03-10`, `${H}/reporte?fecha=2026-03-10`]);
  });

  it("camaristas desempaqueta la lista", async () => {
    const r = recorder({ camaristas: [{ id: "u1", nombre: "Ana" }] });
    expect(await fetchCamaristas(r.impl, B, "tok", "prop-1")).toEqual([{ id: "u1", nombre: "Ana" }]);
    expect(r.calls[0]!.url).toBe(`${H}/camaristas`);
  });

  it("un error del servidor se propaga con su mensaje", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Sin permiso" } }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchTablero(impl, B, "tok", "prop-1")).rejects.toThrow();
  });
});

describe("escrituras", () => {
  it("generar dia, acciones de tarea, marcar sucia y fuera de servicio llaman a la ruta correcta", async () => {
    const r = recorder({ ok: true });
    await generarDia(r.impl, B, "tok", "prop-1", "2026-03-10");
    await accionTarea(r.impl, B, "tok", "prop-1", "t1", "iniciar");
    await accionTarea(r.impl, B, "tok", "prop-1", "t1", "inspeccionar", { aprobada: false, nota: "Falta polvo" });
    await accionTarea(r.impl, B, "tok", "prop-1", "t1", "asignar", { asignadoA: "u1" });
    await marcarSucia(r.impl, B, "tok", "prop-1", "r1");
    await inhabilitar(r.impl, B, "tok", "prop-1", { roomId: "r1", tipo: "fuera_de_orden", motivo: "Fuga" });
    await rehabilitar(r.impl, B, "tok", "prop-1", "o1");
    expect(r.calls.map((c) => [c.method, c.url.replace(H, "")])).toEqual([
      ["POST", "/tareas/generar"],
      ["POST", "/tareas/t1/iniciar"],
      ["POST", "/tareas/t1/inspeccionar"],
      ["POST", "/tareas/t1/asignar"],
      ["POST", "/habitaciones/r1/sucia"],
      ["POST", "/fuera-de-servicio"],
      ["POST", "/fuera-de-servicio/o1/rehabilitar"],
    ]);
    expect(r.calls[2]!.body).toEqual({ aprobada: false, nota: "Falta polvo" });
    expect(r.calls[5]!.body).toEqual({ roomId: "r1", tipo: "fuera_de_orden", motivo: "Fuga" });
  });
});

describe("accionesDisponibles", () => {
  it("espeja el ciclo del servidor", () => {
    expect(accionesDisponibles("pendiente")).toEqual(["iniciar", "asignar", "cancelar"]);
    expect(accionesDisponibles("en_progreso")).toEqual(["terminar", "asignar", "cancelar"]);
    expect(accionesDisponibles("terminada")).toEqual(["inspeccionar", "cancelar"]);
    expect(accionesDisponibles("inspeccionada")).toEqual([]);
    expect(accionesDisponibles("cancelada")).toEqual([]);
  });
});
