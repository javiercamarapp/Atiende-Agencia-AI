import { describe, expect, it } from "vitest";
import {
  calcularPrioridad,
  calcularVencimientosDelPeriodo,
  decidirEscalamiento,
  decidirEscalamientoHabil,
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

describe("calcularVencimientosDelPeriodo (D-26: día hábil y plazos por obligación)", () => {
  it("régimen por defecto (601): ISR/IVA/Nómina el 17 hábil, DIOT el último día del mes siguiente y balanza el día 3 del segundo mes", () => {
    const v = calcularVencimientosDelPeriodo(2026, 6, "2026-06-01");
    expect(v.map((x) => [x.tipo, x.fechaLimite])).toEqual([
      ["ISR", "2026-07-17"],
      ["IVA", "2026-07-17"],
      ["DIOT", "2026-07-31"],
      ["Nómina", "2026-07-17"],
      ["Retenciones", "2026-07-17"],
      ["IMSS", "2026-07-17"],
      ["IMSS-bimestral", "2026-07-17"],
      ["ISN", "2026-07-17"],
      ["Balanza", "2026-08-03"],
    ]);
    expect(v.every((x) => x.periodo === "2026-06")).toBe(true);
  });

  it("el 17 que cae en domingo se corre al lunes (art. 12 CFF) y lo declara", () => {
    const v = calcularVencimientosDelPeriodo(2026, 4, "2026-04-01");
    const isr = v.find((x) => x.tipo === "ISR")!;
    expect(isr.fechaNominal).toBe("2026-05-17");
    expect(isr.fechaLimite).toBe("2026-05-18");
    expect(isr.ajustadaPorDiaInhabil).toBe(true);
  });

  it("la prioridad se calcula sobre la fecha límite AJUSTADA", () => {
    const v = calcularVencimientosDelPeriodo(2026, 4, "2026-05-18");
    expect(v.find((x) => x.tipo === "ISR")!.prioridad).toBe("critica");
  });

  it("un régimen sin calendario modelado lanza en vez de adivinar", () => {
    expect(() => calcularVencimientosDelPeriodo(2026, 6, "2026-06-01", { regimenFiscal: "999" })).toThrow(/999/);
  });
});

describe("decidirEscalamientoHabil (D-P3-33: 7/3/1 dias habiles)", () => {
  it("mas de 7 dias habiles: no toca avisar", () => {
    expect(decidirEscalamientoHabil("IVA", "2026-06-22", 8)).toBeNull();
    expect(decidirEscalamientoHabil("IVA", "2026-06-22", 30)).toBeNull();
  });
  it.each([
    [7, "nivel_1"],
    [4, "nivel_1"],
    [3, "nivel_2"],
    [2, "nivel_2"],
    [1, "nivel_3"],
    [0, "nivel_3"],
    [-1, "nivel_4"],
  ])("%s dia(s) habil(es) -> %s, siempre con revision humana (CFF art. 89)", (dias, nivel) => {
    const d = decidirEscalamientoHabil("ISR", "2026-06-19", dias)!;
    expect(d.level).toBe(nivel);
    expect(d.requiresHumanReview).toBe(true);
    expect(d.notes).toContain("2026-06-19");
  });
  it("el texto habla de dias habiles, no naturales", () => {
    expect(decidirEscalamientoHabil("ISR", "2026-06-19", 3)!.notes).toContain("faltan 3 día(s) hábil(es)");
    expect(decidirEscalamientoHabil("ISR", "2026-06-19", -1)!.notes).toContain("ya venció");
  });
});
