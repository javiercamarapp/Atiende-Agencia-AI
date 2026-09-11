import { describe, expect, it } from "vitest";
import {
  calcularPrioridad,
  calcularVencimientosDelPeriodo,
  decidirEscalamiento,
  diasHasta,
  fechaLimiteDia17MesSiguiente,
} from "../src/vencimientos/engine.ts";

describe("fechaLimiteDia17MesSiguiente", () => {
  it("día 17 del mes siguiente dentro del mismo año", () => {
    expect(fechaLimiteDia17MesSiguiente(2026, 6)).toBe("2026-07-17");
  });

  it("diciembre rueda al 17 de enero del año siguiente", () => {
    expect(fechaLimiteDia17MesSiguiente(2026, 12)).toBe("2027-01-17");
  });
});

describe("diasHasta", () => {
  it("positivo cuando la fecha límite está en el futuro", () => {
    expect(diasHasta("2026-07-20", "2026-07-17")).toBe(3);
  });

  it("negativo cuando la fecha límite ya pasó", () => {
    expect(diasHasta("2026-07-10", "2026-07-17")).toBe(-7);
  });

  it("cero el mismo día", () => {
    expect(diasHasta("2026-07-17", "2026-07-17")).toBe(0);
  });
});

describe("calcularPrioridad (port literal de _calculate_priority)", () => {
  it("vencido -> critica", () => expect(calcularPrioridad(-1)).toBe("critica"));
  it("vence hoy -> critica", () => expect(calcularPrioridad(0)).toBe("critica"));
  it("1-3 días -> alta", () => {
    expect(calcularPrioridad(1)).toBe("alta");
    expect(calcularPrioridad(3)).toBe("alta");
  });
  it("4-7 días -> media", () => {
    expect(calcularPrioridad(4)).toBe("media");
    expect(calcularPrioridad(7)).toBe("media");
  });
  it("8+ días -> baja", () => expect(calcularPrioridad(8)).toBe("baja"));
});

describe("decidirEscalamiento (port literal de escalate)", () => {
  it("vencido -> nivel_4, siempre requiere revisión humana (CFF art. 89)", () => {
    const d = decidirEscalamiento("ISR", "2026-07-17", -2);
    expect(d.level).toBe("nivel_4");
    expect(d.requiresHumanReview).toBe(true);
  });
  it("vence hoy -> nivel_3", () => expect(decidirEscalamiento("IVA", "2026-07-17", 0).level).toBe("nivel_3"));
  it("vence en 1 día -> nivel_2", () => expect(decidirEscalamiento("DIOT", "2026-07-17", 1).level).toBe("nivel_2"));
  it("vence en 2+ días -> nivel_1", () => expect(decidirEscalamiento("Nómina", "2026-07-17", 5).level).toBe("nivel_1"));
});

describe("calcularVencimientosDelPeriodo", () => {
  it("genera los 4 vencimientos estándar (ISR/IVA/DIOT/Nómina) con la misma fecha límite", () => {
    const vencimientos = calcularVencimientosDelPeriodo(2026, 6, "2026-06-01");
    expect(vencimientos.map((v) => v.tipo)).toEqual(["ISR", "IVA", "DIOT", "Nómina"]);
    expect(vencimientos.every((v) => v.fechaLimite === "2026-07-17")).toBe(true);
    expect(vencimientos.every((v) => v.periodo === "2026-06")).toBe(true);
  });
});
