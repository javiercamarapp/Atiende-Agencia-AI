// Golden-set numérico (Fase 3 despachos, OBLIGATORIO — ver diseño §4) —
// compara, campo por campo, el output del motor Python REAL
// (`compliance.calculate_isr`, capturado en
// tests/fixtures/golden-nomina-output.json vía
// tests/fixtures/golden_gen_nomina.py, corrido contra el intérprete real del
// repo `despachos`) contra el motor TS nuevo (`calcularIsrNomina`).
//
// 45 casos: 20 (ISR nómina mensual, límites lower/upper de los 10 tramos) +
// 19 (ISR nómina anual, 9 tramos con upper finito × lower+upper + el último
// tramo con "valor_alto") + 2 (cero/negativo) + 3 (grupo B, huecos de
// precisión de punto flotante confirmados empíricamente: mensual tramo 0,
// anual tramos 3 y 8) + 1 (anual cero/negativo ya contados arriba). Ver
// isr-nomina-engine.ts para la nota de fidelidad completa sobre el algoritmo
// de clasificación (`lower<=x<=upper`, DISTINTO del de declaraciones/
// isr-engine.ts) y el hueco de punto flotante.
//
// Si algún caso no coincidiera, el criterio (diseño §4, tarea) es corregir el
// TS, nunca ajustar el golden para que pase — EXCEPTO el grupo B (huecos),
// donde la discrepancia es un bug real del Python de referencia que este
// puerto replica a propósito (fidelidad estricta, ver isr-nomina-engine.ts).
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-nomina-output.json" with { type: "json" };
import { calcularIsrNomina } from "../src/nomina/isr-nomina-engine.ts";

type GoldenIsrNomina = {
  entrada: { gravable: number; annual: boolean };
  resultado: { isr: number };
  nota?: string;
};

const entries = Object.entries(golden) as [string, unknown][];

function casesFor(prefix: string, excludeHole = true) {
  return entries.filter(([name]) => name.startsWith(prefix) && (!excludeHole || !name.includes("_hole_")));
}

describe("golden-set numérico: ISR nómina mensual (TS) vs compliance.calculate_isr (Python real)", () => {
  for (const [name, raw] of casesFor("isr_nomina_mensual_tramo")) {
    const { entrada, resultado } = raw as GoldenIsrNomina;
    it(`${name}: gravable=${entrada.gravable} -> isr=${resultado.isr}`, () => {
      const ts = calcularIsrNomina(entrada.gravable, false);
      expect(ts).toBe(resultado.isr);
    });
  }

  it("isr_nomina_mensual_cero: gravable=0 -> isr=0", () => {
    const { resultado } = golden.isr_nomina_mensual_cero as unknown as GoldenIsrNomina;
    expect(calcularIsrNomina(0)).toBe(resultado.isr);
  });

  it("isr_nomina_mensual_negativo: gravable negativo -> isr=0 sin tocar la tabla", () => {
    const { entrada, resultado } = golden.isr_nomina_mensual_negativo as unknown as GoldenIsrNomina;
    expect(calcularIsrNomina(entrada.gravable, false)).toBe(resultado.isr);
  });
});

describe("golden-set numérico: ISR nómina anual (TS) vs compliance.calculate_isr(annual=True) (Python real)", () => {
  for (const [name, raw] of casesFor("isr_nomina_anual_tramo")) {
    const { entrada, resultado } = raw as GoldenIsrNomina;
    it(`${name}: gravable=${entrada.gravable} -> isr=${resultado.isr}`, () => {
      const ts = calcularIsrNomina(entrada.gravable, true);
      expect(ts).toBe(resultado.isr);
    });
  }
});

describe("golden-set numérico GRUPO B: hueco de punto flotante en clasificación de tramo (CRÍTICO, diseño §5.1) — replicado a propósito, fidelidad estricta", () => {
  const holeCases = entries.filter(([name]) => name.includes("_hole_"));

  it("hay al menos un caso de hueco confirmado empíricamente contra el intérprete real", () => {
    expect(holeCases.length).toBeGreaterThan(0);
  });

  for (const [name, raw] of holeCases) {
    const { entrada, resultado, nota } = raw as GoldenIsrNomina;
    it(`${name}: gravable=${entrada.gravable} (reconstruido) -> isr=${resultado.isr} (retención perdida en silencio) — ${nota}`, () => {
      const ts = calcularIsrNomina(entrada.gravable, entrada.annual);
      // El TS reproduce EXACTAMENTE el mismo hueco que el Python: 0, no el
      // ISR "correcto" que un literal decimal limpio produciría en ese mismo
      // tramo. Esto es el comportamiento observado a propósito, no un bug
      // del puerto — ver isr-nomina-engine.ts.
      expect(ts).toBe(resultado.isr);
      expect(ts).toBe(0);
    });
  }
});
