import { describe, expect, it } from "vitest";
import { exigirPlantillaAprobadaParaProgramar, extraerVariables, PlantillaNoAprobadaError, renderizarPlantilla, VariablePlantillaFaltanteError } from "../../src/mensajeria/plantillas.ts";
import type { PlantillaMensaje } from "../../src/mensajeria/plantillas.ts";

function plantilla(overrides: Partial<PlantillaMensaje> = {}): PlantillaMensaje {
  return {
    evento: "confirmacion",
    idioma: "es",
    canal: null,
    cuerpo: "¡Hola {{nombre}}! Tu reserva en {{propiedad}} está confirmada.",
    aprobadaPorTenant: false,
    activa: true,
    ...overrides,
  };
}

describe("extraerVariables", () => {
  it("extrae variables únicas en orden de primera aparición", () => {
    expect(extraerVariables("{{a}} y {{b}} y otra vez {{a}}")).toEqual(["a", "b"]);
  });

  it("un cuerpo sin variables devuelve lista vacía", () => {
    expect(extraerVariables("Texto fijo sin variables")).toEqual([]);
  });
});

describe("renderizarPlantilla", () => {
  it("sustituye todas las variables provistas", () => {
    const resultado = renderizarPlantilla(plantilla(), { nombre: "Ana", propiedad: "Casa Sol" });
    expect(resultado).toBe("¡Hola Ana! Tu reserva en Casa Sol está confirmada.");
  });

  it("lanza VariablePlantillaFaltanteError si falta una variable — nunca deja el hueco vacío ni inventa un valor", () => {
    expect(() => renderizarPlantilla(plantilla(), { nombre: "Ana" })).toThrow(VariablePlantillaFaltanteError);
  });
});

describe("exigirPlantillaAprobadaParaProgramar", () => {
  it("permite una plantilla activa y aprobada por el tenant", () => {
    expect(() => exigirPlantillaAprobadaParaProgramar(plantilla({ aprobadaPorTenant: true, activa: true }))).not.toThrow();
  });

  it("rechaza una plantilla sin aprobar, aunque esté activa", () => {
    expect(() => exigirPlantillaAprobadaParaProgramar(plantilla({ aprobadaPorTenant: false, activa: true }))).toThrow(PlantillaNoAprobadaError);
  });

  it("rechaza una plantilla aprobada pero inactiva", () => {
    expect(() => exigirPlantillaAprobadaParaProgramar(plantilla({ aprobadaPorTenant: true, activa: false }))).toThrow(PlantillaNoAprobadaError);
  });
});
