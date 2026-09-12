// Golden-set numérico: Subsidio al empleo (Fase 3 despachos) — compara contra
// `_calcular_subsidio` (nomina_completa/service.py), capturado en
// tests/fixtures/golden-nomina-output.json. 47 casos: 22 (mensual, lower+upper
// de los 11 tramos) + 22 (quincenal, ídem) + arriba-del-último-tramo + cero +
// negativo.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-nomina-output.json" with { type: "json" };
import { calcularSubsidio, SUBSIDIO_EMPLEO_MENSUAL_2026, SUBSIDIO_EMPLEO_QUINCENAL_2026 } from "../src/nomina/subsidio-empleo.ts";

type GoldenSubsidio = {
  entrada: { ingresoGravado: number; periodicidad: "mensual" | "quincenal" };
  resultado: { subsidio: number; subsidio_efectivo: number; isr_neto: number };
};

const entries = Object.entries(golden).filter(([name]) => name.startsWith("subsidio_")) as [string, unknown][];

describe("golden-set numérico: subsidio al empleo (TS) vs _calcular_subsidio (Python real)", () => {
  for (const [name, raw] of entries) {
    const { entrada, resultado } = raw as GoldenSubsidio;
    it(`${name}: ingresoGravado=${entrada.ingresoGravado} periodicidad=${entrada.periodicidad} -> subsidio=${resultado.subsidio}`, () => {
      const ts = calcularSubsidio(entrada.ingresoGravado, entrada.periodicidad);
      expect(ts).toBe(resultado.subsidio);
    });
  }

  it("las tablas mensual y quincenal tienen 11 tramos cada una", () => {
    expect(SUBSIDIO_EMPLEO_MENSUAL_2026.length).toBe(11);
    expect(SUBSIDIO_EMPLEO_QUINCENAL_2026.length).toBe(11);
  });

  it("último tramo mensual (11492.67-13493.97) da subsidio 0", () => {
    expect(calcularSubsidio(13000, "mensual")).toBe(0);
  });

  it("por encima del último tramo mensual también da 0 (no hay excepción, cae fuera de la tabla)", () => {
    const { resultado } = golden.subsidio_mensual_arriba_del_ultimo_tramo as unknown as GoldenSubsidio;
    expect(resultado.subsidio).toBe(0);
  });

  it("cero e ingresos negativos dan subsidio 0 sin tocar la tabla", () => {
    expect(calcularSubsidio(0, "mensual")).toBe(0);
    expect(calcularSubsidio(-500, "mensual")).toBe(0);
  });
});
