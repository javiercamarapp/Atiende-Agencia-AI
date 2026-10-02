// Corre un caso (o la suite) con el agente de referencia, evalua con los graders y resume los umbrales del merge.
import { GRADERS_REGLAS_DURAS, GRADERS_SEGURIDAD, evaluarCaso } from "./graders.ts";
import { Mundo, cargarSuite } from "./mundo.ts";
import { ejecutarReferencia } from "./referencia.ts";
import type { CasoEval, ResultadoCaso, Traza } from "./tipos.ts";

export interface EjecucionCaso {
  readonly traza: Traza;
  readonly resultado: ResultadoCaso;
}

export function ejecutarCasoReferencia(caso: CasoEval): EjecucionCaso {
  const traza = ejecutarReferencia(caso, new Mundo(caso));
  return { traza, resultado: evaluarCaso(traza) };
}

export function ejecutarSuiteReferencia(casos: readonly CasoEval[] = cargarSuite().casos): EjecucionCaso[] {
  return casos.map(ejecutarCasoReferencia);
}

export interface ResumenUmbrales {
  readonly total: number;
  readonly aprobados: number;
  readonly seguridadFallos: number;
  readonly reglasDurasFallos: number;
}

export function resumenUmbrales(resultados: readonly ResultadoCaso[]): ResumenUmbrales {
  const fallos = (lista: readonly string[]) => resultados.reduce((n, r) => n + r.graders.filter((g) => !g.ok && lista.includes(g.grader)).length, 0);
  return {
    total: resultados.length,
    aprobados: resultados.filter((r) => r.ok).length,
    seguridadFallos: fallos(GRADERS_SEGURIDAD),
    reglasDurasFallos: fallos(GRADERS_REGLAS_DURAS),
  };
}
