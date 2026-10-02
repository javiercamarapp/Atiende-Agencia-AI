import { describe, expect, it } from "vitest";
import { VARIABLES_PLANTILLA, construirVariables, extraerVariables, renderizarPlantilla, variablesNoSoportadas } from "../src/index.ts";

const BASE = { huespedNombre: "Ana", propiedadNombre: "Casa Mar", unidadNombre: "Depto 1", checkIn: "2030-06-10", checkOut: "2030-06-12" };

describe("construirVariables", () => {
  it("llena TODAS las variables publicadas y las fechas salen en el dia de calendario correcto (sin corrimiento por zona)", () => {
    const vars = construirVariables(BASE);
    expect(Object.keys(vars).sort()).toEqual(VARIABLES_PLANTILLA.map((v) => v.nombre).sort());
    expect(vars.fecha_check_in).toMatch(/^lunes,? 10 de junio de 2030$/);
    expect(vars.fecha_check_out).toMatch(/^miércoles,? 12 de junio de 2030$/);
    expect(vars.noches).toBe("2");
  });

  it("sin nombre de huesped usa un saludo neutro, nunca inventa un nombre", () => {
    expect(construirVariables({ ...BASE, huespedNombre: null }).huesped).toBe("huésped");
    expect(construirVariables({ ...BASE, huespedNombre: "   " }).huesped).toBe("huésped");
  });

  it("una plantilla con variables conocidas se renderiza completa", () => {
    const texto = renderizarPlantilla({ evento: "pre_llegada", idioma: "es", canal: null, cuerpo: "Hola {{huesped}}, {{propiedad}} te espera {{noches}} noches.", aprobadaPorTenant: true, activa: true }, construirVariables(BASE));
    expect(texto).toBe("Hola Ana, Casa Mar te espera 2 noches.");
  });
});

describe("variablesNoSoportadas", () => {
  it("detecta las variables que el sistema no sabe llenar", () => {
    expect(variablesNoSoportadas("Hola {{huesped}} {{codigo_wifi}} {{precio}}")).toEqual(["codigo_wifi", "precio"]);
    expect(variablesNoSoportadas("Sin variables")).toEqual([]);
    expect(extraerVariables("{{huesped}} {{huesped}}")).toEqual(["huesped"]);
  });
});
