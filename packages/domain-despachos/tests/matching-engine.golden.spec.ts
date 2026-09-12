// Golden-set numérico (Fase 5 despachos, OBLIGATORIO) — compara el output del motor
// Python REAL (`MatchingEngine.match()` de
// b2b_ai/features/reconciliation_agent/matching_engine.py, capturado en
// tests/fixtures/golden-conciliacion-output.json vía
// tests/fixtures/golden_gen_conciliacion.py) contra `conciliarMovimientos` (TS).
//
// Niveles 1 (exacto) y 3 (multi-línea) NO dependen de `rapidfuzz.fuzz.partial_ratio`
// — son byte-exactos aquí (score, nivel, índices, montos, fechas, agregados, todo).
// El nivel 2 (fuzzy) SÍ depende de `partialRatio`, una aproximación documentada (ver
// text-similarity.ts) — para ese caso se compara con una tolerancia explícita en vez
// de igualdad estricta, y se verifica que la DECISIÓN (qué matcheó con qué, en qué
// nivel) sea idéntica, que es lo que realmente le importa al negocio.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-conciliacion-output.json" with { type: "json" };
import { conciliarMovimientos } from "../src/conciliacion/matching-engine.ts";
import type { MovimientoBancario, RegistroConciliable } from "../src/conciliacion/types.ts";

interface GoldenMovimiento {
  readonly fecha: string;
  readonly descripcion: string;
  readonly referencia: string | null;
  readonly cargo: number | null;
  readonly abono: number | null;
  readonly saldo: number | null;
  readonly monto: number;
  readonly banco: string;
  readonly formato: string;
}

interface GoldenRegistro {
  readonly id: string;
  readonly fecha: string;
  readonly monto?: number;
  readonly total?: number;
  readonly descripcion?: string;
  readonly referencia?: string;
}

function aMovimiento(m: GoldenMovimiento): MovimientoBancario {
  return { fecha: m.fecha, descripcion: m.descripcion, referencia: m.referencia, cargo: m.cargo, abono: m.abono, saldo: m.saldo, monto: m.monto, banco: m.banco, formato: m.formato };
}

function aRegistro(r: GoldenRegistro): RegistroConciliable {
  return { id: r.id, fecha: r.fecha, monto: r.monto, descripcion: r.descripcion, referencia: r.referencia };
}

interface GoldenMatch {
  readonly movementIdx: number;
  readonly registroIdx: number | null;
  readonly registroIndices: readonly number[] | null;
  readonly level: string;
  readonly score: number;
  readonly montoBanco: number;
  readonly montoRegistro: number;
  readonly fechaBanco: string;
  readonly fechaRegistro: string;
}

interface GoldenCaso {
  readonly entrada: { readonly movimientos: readonly GoldenMovimiento[]; readonly registros: readonly GoldenRegistro[] };
  readonly resultado: {
    readonly matched: readonly GoldenMatch[];
    readonly confidence: number;
    readonly totalMovements: number;
    readonly totalRecords: number;
    readonly totalMatched: number;
    readonly matchRate: number;
    readonly montoMatched: number;
    readonly montoUnmatchedBank: number;
    readonly montoUnmatchedBooks: number;
    readonly unmatchedBankCount: number;
    readonly unmatchedBooksCount: number;
  };
}

const entries = Object.entries(golden) as Array<[string, GoldenCaso]>;
const casosByteExactos = entries.filter(([nombre]) => !nombre.startsWith("nivel2_"));
const casosFuzzy = entries.filter(([nombre]) => nombre.startsWith("nivel2_"));

describe("golden: conciliarMovimientos niveles 1 y 3 (byte-exacto vs Python real)", () => {
  it.each(casosByteExactos)("%s", (_nombre, caso) => {
    const movimientos = (caso.entrada.movimientos as GoldenMovimiento[]).map(aMovimiento);
    const registros = (caso.entrada.registros as GoldenRegistro[]).map(aRegistro);
    const resultado = conciliarMovimientos(movimientos, registros);

    expect(resultado.matched).toHaveLength(caso.resultado.matched.length);
    caso.resultado.matched.forEach((esperado: GoldenMatch, i: number) => {
      const real = resultado.matched[i]!;
      expect(real.movementIdx).toBe(esperado.movementIdx);
      expect(real.registroIdx).toBe(esperado.registroIdx);
      expect(real.registroIndices).toEqual(esperado.registroIndices);
      const nivelEsperado = esperado.level === "exact" ? "exacto" : esperado.level === "multi_line" ? "multi_linea" : esperado.level;
      expect(real.level).toBe(nivelEsperado);
      expect(real.score).toBe(esperado.score);
      expect(real.montoBanco).toBe(esperado.montoBanco);
      expect(real.montoRegistro).toBe(esperado.montoRegistro);
      expect(real.fechaBanco).toBe(esperado.fechaBanco);
      expect(real.fechaRegistro).toBe(esperado.fechaRegistro);
    });

    expect(resultado.confidence).toBe(caso.resultado.confidence);
    expect(resultado.totalMovements).toBe(caso.resultado.totalMovements);
    expect(resultado.totalRecords).toBe(caso.resultado.totalRecords);
    expect(resultado.totalMatched).toBe(caso.resultado.totalMatched);
    expect(resultado.matchRate).toBe(caso.resultado.matchRate);
    expect(resultado.montoMatched).toBe(caso.resultado.montoMatched);
    expect(resultado.montoUnmatchedBank).toBe(caso.resultado.montoUnmatchedBank);
    expect(resultado.montoUnmatchedBooks).toBe(caso.resultado.montoUnmatchedBooks);
    expect(resultado.unmatchedBank).toHaveLength(caso.resultado.unmatchedBankCount);
    expect(resultado.unmatchedBooks).toHaveLength(caso.resultado.unmatchedBooksCount);
  });
});

describe("golden: conciliarMovimientos nivel 2 fuzzy (tolerancia documentada vs Python real)", () => {
  it.each(casosFuzzy)("%s — misma decisión de match, score dentro de tolerancia", (_nombre, caso) => {
    const movimientos = (caso.entrada.movimientos as GoldenMovimiento[]).map(aMovimiento);
    const registros = (caso.entrada.registros as GoldenRegistro[]).map(aRegistro);
    const resultado = conciliarMovimientos(movimientos, registros);

    expect(resultado.matched).toHaveLength(caso.resultado.matched.length);
    const esperado = caso.resultado.matched[0]!;
    const real = resultado.matched[0]!;
    expect(real.movementIdx).toBe(esperado.movementIdx);
    expect(real.registroIdx).toBe(esperado.registroIdx);
    expect(real.level).toBe("fuzzy");
    // Tolerancia de score documentada en text-similarity.ts: diferencia máxima
    // observada de 8.3 pts en 2,000 casos de descripciones realistas.
    expect(Math.abs(real.score - esperado.score)).toBeLessThanOrEqual(10);
  });
});
