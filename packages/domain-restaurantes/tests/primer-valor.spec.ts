import { describe, expect, it } from "vitest";
import { calcularPrimerValor, type LecturasPrimerValor } from "../src/primer-valor.ts";

const NUEVA: LecturasPrimerValor = {
  sucursal: { propertyId: "p1", nombre: "Centro", status: "inactive" },
  productosDisponibles: 0,
  tieneHorario: false,
  aceptaDomicilio: true,
  coloniasConCobertura: 0,
  metodosPagoConfirmados: false,
  agenteProbado: false,
};

describe("calcularPrimerValor", () => {
  it("sucursal recien creada: 6 pasos pendientes, 25 minutos, no se puede activar", () => {
    const pv = calcularPrimerValor(NUEVA);
    expect(pv.pasos.map((p) => [p.id, p.estado])).toEqual([
      ["menu", "pendiente"],
      ["horario", "pendiente"],
      ["zonas", "pendiente"],
      ["metodos_pago", "pendiente"],
      ["probar_agente", "pendiente"],
      ["activar", "pendiente"],
    ]);
    expect(pv.minutosRestantes).toBe(25);
    expect(pv.minutosRestantes).toBeLessThan(30);
    expect(pv.puedeActivar).toBe(false);
    expect(pv.listo).toBe(false);
  });

  it("solo recoger no necesita zonas; con menu y horario ya puede activar", () => {
    const pv = calcularPrimerValor({ ...NUEVA, productosDisponibles: 12, tieneHorario: true, aceptaDomicilio: false });
    expect(pv.pasos.find((p) => p.id === "zonas")!.estado).toBe("hecho");
    expect(pv.puedeActivar).toBe(true);
    expect(pv.minutosRestantes).toBe(7);
  });

  it("todo hecho y activa: listo; sin las migraciones de hitos, esos pasos dicen no_disponible (nunca hecho)", () => {
    const listo = calcularPrimerValor({ ...NUEVA, sucursal: { ...NUEVA.sucursal, status: "active" }, productosDisponibles: 3, tieneHorario: true, coloniasConCobertura: 4, metodosPagoConfirmados: true, agenteProbado: true });
    expect(listo.listo).toBe(true);
    expect(listo.minutosRestantes).toBe(0);
    const sinMigrar = calcularPrimerValor({ ...NUEVA, metodosPagoConfirmados: null, agenteProbado: null });
    expect(sinMigrar.pasos.filter((p) => p.estado === "no_disponible").map((p) => p.id)).toEqual(["metodos_pago", "probar_agente"]);
  });
});
