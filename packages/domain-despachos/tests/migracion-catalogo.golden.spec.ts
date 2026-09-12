// Golden-set numérico (Fase 5 despachos, OBLIGATORIO) — compara byte a byte el
// output del motor Python REAL (`calcular_score_compuesto`/`clasificar_cuenta_origen`
// de b2b_ai/features/migracion_catalogo/matching.py, capturado en
// tests/fixtures/golden-migracion-catalogo-output.json vía
// tests/fixtures/golden_gen_migracion_catalogo.py, corrido contra el intérprete real
// del repo `despachos`) contra el motor TS nuevo. A diferencia del golden-set de
// conciliación bancaria (fuzzy con tolerancia, ver matching-engine.golden.spec.ts),
// este SÍ es byte-exacto en el 100% de los campos: `calcularScoreCompuesto` solo
// depende de `tokenSortRatio`, que se verificó byte-exacto contra
// `rapidfuzz.fuzz.token_sort_ratio` (0 discrepancias en 2,000 casos aleatorios — ver
// comentario de cabecera de text-similarity.ts), a diferencia de `partialRatio`
// (usado en conciliación bancaria), que es una aproximación documentada.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-migracion-catalogo-output.json" with { type: "json" };
import { calcularScoreCompuesto, clasificarCuentaOrigen } from "../src/migracion-catalogo/matching.ts";
import type { CuentaCatalogo } from "../src/migracion-catalogo/types.ts";

interface CuentaGolden {
  readonly id?: string;
  readonly codigo: string;
  readonly nombre: string;
  readonly nivel: number;
  readonly naturaleza: string;
  readonly tipoAgregado: string;
  readonly cuentaPadreCodigo: string | null;
}

function aCuenta(c: CuentaGolden, id: string): CuentaCatalogo {
  return { id: c.id ?? id, codigo: c.codigo, nombre: c.nombre, nivel: c.nivel, naturaleza: c.naturaleza, tipoAgregado: c.tipoAgregado, cuentaPadreCodigo: c.cuentaPadreCodigo };
}

interface GoldenCaso {
  readonly entrada: { readonly origen: CuentaGolden; readonly destino?: CuentaGolden; readonly candidatos?: readonly CuentaGolden[] };
  readonly resultado: { readonly score: number; readonly destino_cuenta_id?: string | null; readonly tipo_match?: string; readonly estado?: string };
}

const entries = Object.entries(golden) as Array<[string, GoldenCaso]>;

describe("golden: calcularScoreCompuesto (byte-exacto vs Python real)", () => {
  const casos = entries.filter(([nombre]) => nombre.startsWith("score_"));
  it.each(casos)("%s", (_nombre, caso) => {
    const origen = aCuenta(caso.entrada.origen, "o");
    const destino = aCuenta(caso.entrada.destino!, "d");
    expect(calcularScoreCompuesto(origen, destino)).toBe(caso.resultado.score);
  });
});

describe("golden: clasificarCuentaOrigen (byte-exacto vs Python real)", () => {
  const casos = entries.filter(([nombre]) => nombre.startsWith("clasificar_"));
  it.each(casos)("%s", (_nombre, caso) => {
    const origen = aCuenta(caso.entrada.origen, "o");
    const candidatos = (caso.entrada.candidatos as CuentaGolden[]).map((c, i) => aCuenta(c, `c${i}`));
    const resultado = clasificarCuentaOrigen(origen, candidatos);
    expect(resultado.destinoCuentaId).toBe(caso.resultado.destino_cuenta_id);
    expect(resultado.tipoMatch).toBe(caso.resultado.tipo_match);
    expect(resultado.score).toBe(caso.resultado.score);
    expect(resultado.estado).toBe(caso.resultado.estado);
  });
});
