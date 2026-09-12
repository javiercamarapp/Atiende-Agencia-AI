// Tests reales de las validaciones de escritura de pricing (Fase 2, Flujo 4) — cierran
// una brecha real del repo origen (nunca comprobaba solapamiento de
// temporadas/min-stay), ver diseño Fase 2 rentas §3.2/§3.4 y pricing/validacion.ts.
import { describe, expect, it } from "vitest";
import { encontrarMinStaySolapada, encontrarTemporadaSolapada } from "../src/pricing/validacion.ts";
import type { ReglaMinStayExistente, TemporadaExistente } from "../src/pricing/validacion.ts";

describe("encontrarTemporadaSolapada", () => {
  const existentes: TemporadaExistente[] = [
    { id: "t1", nombre: "Verano", rango: { inicio: "2026-06-01", fin: "2026-08-01" } },
    { id: "t2", nombre: "Navidad", rango: { inicio: "2026-12-15", fin: "2027-01-05" } },
  ];

  it("null cuando el nuevo rango no toca ninguna temporada existente", () => {
    expect(encontrarTemporadaSolapada(existentes, { inicio: "2026-09-01", fin: "2026-09-10" })).toBeNull();
  });

  it("detecta un traslape total", () => {
    const conflicto = encontrarTemporadaSolapada(existentes, { inicio: "2026-06-15", fin: "2026-06-20" });
    expect(conflicto?.id).toBe("t1");
  });

  it("detecta un traslape parcial en el borde", () => {
    const conflicto = encontrarTemporadaSolapada(existentes, { inicio: "2026-07-31", fin: "2026-08-10" });
    expect(conflicto?.id).toBe("t1");
  });

  it("estancias contiguas (fin de una = inicio de otra) NO son traslape -- semiabierto [inicio,fin)", () => {
    expect(encontrarTemporadaSolapada(existentes, { inicio: "2026-08-01", fin: "2026-08-15" })).toBeNull();
  });

  it("excluirId permite que una temporada no conflicte consigo misma (caso de actualización futura)", () => {
    expect(encontrarTemporadaSolapada(existentes, { inicio: "2026-06-10", fin: "2026-06-20" }, "t1")).toBeNull();
  });
});

describe("encontrarMinStaySolapada", () => {
  it("dos reglas traslapadas en rango y AMBAS 'todos los días' (null) -- SÍ es conflicto", () => {
    const existentes: ReglaMinStayExistente[] = [{ id: "r1", rango: { inicio: "2026-12-01", fin: "2026-12-31" }, diaSemanaCheckIn: null }];
    const conflicto = encontrarMinStaySolapada(existentes, { rango: { inicio: "2026-12-10", fin: "2026-12-20" }, diaSemanaCheckIn: null });
    expect(conflicto?.id).toBe("r1");
  });

  it("dos reglas traslapadas en rango pero CON DISTINTO día de check-in -- NO es conflicto (evaluarViolacionesMinStay las evalúa por separado)", () => {
    const existentes: ReglaMinStayExistente[] = [{ id: "r1", rango: { inicio: "2026-12-01", fin: "2026-12-31" }, diaSemanaCheckIn: null }];
    const conflicto = encontrarMinStaySolapada(existentes, { rango: { inicio: "2026-12-10", fin: "2026-12-20" }, diaSemanaCheckIn: 6 });
    expect(conflicto).toBeNull();
  });

  it("dos reglas traslapadas en rango y con el MISMO día de check-in específico (no null) -- SÍ es conflicto", () => {
    const existentes: ReglaMinStayExistente[] = [{ id: "r1", rango: { inicio: "2026-12-01", fin: "2026-12-31" }, diaSemanaCheckIn: 6 }];
    const conflicto = encontrarMinStaySolapada(existentes, { rango: { inicio: "2026-12-10", fin: "2026-12-20" }, diaSemanaCheckIn: 6 });
    expect(conflicto?.id).toBe("r1");
  });

  it("rangos que no se traslapan -- nunca conflicto, sin importar el día de check-in", () => {
    const existentes: ReglaMinStayExistente[] = [{ id: "r1", rango: { inicio: "2026-12-01", fin: "2026-12-10" }, diaSemanaCheckIn: null }];
    expect(encontrarMinStaySolapada(existentes, { rango: { inicio: "2026-12-10", fin: "2026-12-20" }, diaSemanaCheckIn: null })).toBeNull();
  });
});
