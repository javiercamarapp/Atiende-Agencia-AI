// Ejecuta el set dorado de PM: un agente (el de referencia guionado en CI; un LLM real a mano) contra el mundo
// simulado y los graders deterministas de cada caso.
import { evaluarCaso } from "./graders.ts";
import { CONTRATO_OBJETIVO, Mundo, cargarMenu, cargarSuite, type CapacidadesMundo } from "./mundo.ts";
import { correrReferencia } from "./referencia.ts";
import type { CasoEval, ResultadoCaso, SuiteEval } from "./tipos.ts";

export interface EjecucionCaso {
  readonly mundo: Mundo;
  readonly resultado: ResultadoCaso;
}

/** Corre UN caso con el agente de referencia. Una excepcion del agente (p. ej. el mundo rechaza algo que el
 * contrato objetivo pide) se reporta como fallo del caso, nunca como pase. */
export async function ejecutarCasoReferencia(caso: CasoEval, capacidades: CapacidadesMundo = CONTRATO_OBJETIVO, suite: SuiteEval = cargarSuite()): Promise<EjecucionCaso> {
  const mundo = new Mundo(caso, suite, cargarMenu(), capacidades);
  let excepcion: string | null = null;
  try {
    await correrReferencia(mundo);
  } catch (err) {
    excepcion = err instanceof Error ? err.message : String(err);
  }
  const base = evaluarCaso(caso, mundo);
  if (excepcion === null) return { mundo, resultado: base };
  return { mundo, resultado: { casoId: caso.id, ok: false, graders: [...base.graders, { grader: "EJECUCION", ok: false, detalle: excepcion }] } };
}

export async function ejecutarSuiteReferencia(capacidades: CapacidadesMundo = CONTRATO_OBJETIVO): Promise<readonly EjecucionCaso[]> {
  const suite = cargarSuite();
  const out: EjecucionCaso[] = [];
  for (const caso of suite.casos) out.push(await ejecutarCasoReferencia(caso, capacidades, suite));
  return out;
}

/** Umbrales de aprobacion del set (seccion 8.4 del experto) aplicados a una lista de resultados. */
export function resumenUmbrales(resultados: readonly ResultadoCaso[], casos: readonly CasoEval[]): { readonly total: number; readonly aprobados: number; readonly seguridadFallos: number; readonly reglasDurasFallos: number } {
  const porId = new Map(casos.map((c) => [c.id, c]));
  const SEGURIDAD = new Set(["G_REGLA_R7", "G_REGLA_R9", "G_REGLA_R11", "G_SEGURIDAD"]);
  let seguridadFallos = 0;
  let reglasDurasFallos = 0;
  for (const r of resultados) {
    const caso = porId.get(r.casoId);
    for (const g of r.graders) {
      if (g.ok) continue;
      if (SEGURIDAD.has(g.grader)) seguridadFallos += 1;
      if (/^G_REGLA_R\d+$/.test(g.grader) && caso) reglasDurasFallos += 1;
    }
  }
  return { total: resultados.length, aprobados: resultados.filter((r) => r.ok).length, seguridadFallos, reglasDurasFallos };
}
