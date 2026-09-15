// ISR de nómina — tramos verificados directamente contra la tarifa Art. 96 LISR
// vigente (ISR_NOMINA_MENSUAL_2026/ISR_NOMINA_ANUAL_2026, re-exportadas de
// declaraciones/isr-tablas.ts — ver ese archivo para la fuente/verificación
// completa contra el Anexo 8 RMF 2026, DOF 28-dic-2025).
//
// CORRECCIÓN FISCAL (auditoría, hallazgo CRÍTICO #1): este archivo comparaba antes
// contra `tests/fixtures/golden-nomina-output.json` — una captura de un motor
// Python de referencia cuya tabla ISR de nómina resultó NO coincidir con el Anexo 8
// SAT/DOF real (ver isr-tablas.ts). Esa fixture ya no es una fuente de verdad
// fiscal válida: se retiró la dependencia de ella. Los 21 casos de límite de tramo
// de abajo (10 mensuales + 11 anuales) se generaron PROGRAMÁTICAMENTE desde la
// tabla real ya corregida (mismo criterio que antes, solo que ahora la tabla de
// origen es correcta) — no transcritos a mano.
//
// El GRUPO B del archivo anterior ("hueco de punto flotante") probaba una
// reconstrucción de float que caía exactamente en un hueco de clasificación de LA
// TABLA ANTERIOR (valores específicos como "194610.60000000003", elegidos porque
// coincidían con un límite exacto de esa tabla vieja) — no aplica a los límites de
// la tabla corregida y se retiró junto con la fixture. El comportamiento
// algorítmico que ese grupo probaba (clasificación `lower<=x<=upper` con el
// `upper` PROPIO de cada fila, no el de la fila siguiente) sigue intacto y sin
// cambios en isr-nomina-engine.ts — no fue tocado por esta corrección, que es
// puramente de datos (la tabla), nunca del algoritmo de clasificación.
import { describe, expect, it } from "vitest";
import { calcularIsrNomina } from "../src/nomina/isr-nomina-engine.ts";
import { ISR_NOMINA_MENSUAL_2026, ISR_NOMINA_ANUAL_2026 } from "../src/nomina/isr-nomina-tablas.ts";

const CASOS_MENSUAL: ReadonlyArray<readonly [gravable: number, isr: number]> = [
  [0.01, 0],
  [844.59, 16.22],
  [844.6, 16.22],
  [7168.51, 420.95],
  [7168.52, 420.95],
  [12598.02, 1011.68],
  [12598.03, 1011.68],
  [14644.64, 1339.14],
  [14644.65, 1339.14],
  [17533.64, 1856.85],
  [17533.65, 1856.84],
  [35362.83, 5665.15],
  [35362.84, 5665.16],
  [55736.68, 10457.09],
  [55736.69, 10457.09],
  [106410.5, 25659.23],
  [106410.51, 25659.23],
  [141880.66, 37009.68],
  [141880.67, 37009.69],
  [425641.99, 133488.54],
  [425642.0, 133488.54],
];

const CASOS_ANUAL: ReadonlyArray<readonly [gravable: number, isr: number]> = [
  [0.12, 0],
  [10135.08, 194.59],
  [10135.2, 194.64],
  [86022.12, 5051.4],
  [86022.24, 5051.4],
  [151176.24, 12140.16],
  [151176.36, 12140.16],
  [175735.68, 16069.65],
  [175735.8, 16069.68],
  [210403.68, 22282.16],
  [210403.8, 22282.08],
  [424353.96, 67981.83],
  [424354.08, 67981.92],
  [668840.16, 125485.05],
  [668840.28, 125485.08],
  [1276926.0, 307910.8],
  [1276926.12, 307910.76],
  [1702567.92, 444116.14],
  [1702568.04, 444116.28],
  [5107703.88, 1601862.47],
  [5107704.0, 1601862.48],
];

describe("calcularIsrNomina — mensual (ISR_NOMINA_MENSUAL_2026, 11 tramos)", () => {
  for (const [gravable, isr] of CASOS_MENSUAL) {
    it(`gravable=${gravable} -> isr=${isr}`, () => {
      expect(calcularIsrNomina(gravable, false)).toBe(isr);
    });
  }

  it("gravable=0 -> isr=0", () => {
    expect(calcularIsrNomina(0)).toBe(0);
  });

  it("gravable negativo -> isr=0 sin tocar la tabla", () => {
    expect(calcularIsrNomina(-100, false)).toBe(0);
  });

  it("la tabla mensual tiene exactamente 11 tramos", () => {
    expect(ISR_NOMINA_MENSUAL_2026.length).toBe(11);
  });
});

describe("calcularIsrNomina — anual (ISR_NOMINA_ANUAL_2026, 11 tramos)", () => {
  for (const [gravable, isr] of CASOS_ANUAL) {
    it(`gravable=${gravable} -> isr=${isr}`, () => {
      expect(calcularIsrNomina(gravable, true)).toBe(isr);
    });
  }

  it("la tabla anual tiene exactamente 11 tramos", () => {
    expect(ISR_NOMINA_ANUAL_2026.length).toBe(11);
  });
});

describe("calcularIsrNomina — clasificación con el `upper` PROPIO de cada fila (no el `lower` de la fila siguiente)", () => {
  // ver isr-nomina-engine.ts: a diferencia de declaraciones/isr-engine.ts, este
  // motor clasifica con `lower<=x<=upper` leído directamente de la tabla.
  it("un valor justo en el límite superior de un tramo clasifica EN ese tramo, no en el siguiente", () => {
    // Tramo 1 mensual: [844.6, 7168.51, 16.22, 0.064] -> en el upper exacto,
    // excedente = 7168.51 - 844.6 = 6323.91, isr = 16.22 + 6323.91*0.064 = 420.95
    // (mismo valor que el lower del tramo 2, por continuidad de la tabla oficial).
    expect(calcularIsrNomina(7168.51, false)).toBe(420.95);
  });
});
