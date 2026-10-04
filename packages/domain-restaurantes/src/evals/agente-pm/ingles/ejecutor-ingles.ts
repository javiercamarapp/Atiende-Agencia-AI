// Ejecutor del set en INGLES: agente de referencia en ingles + mundo simulado + graders de `graders-ingles.ts`. Corre en CI sin LLM real.
import { readFileSync } from "node:fs";
import { CONTRATO_OBJETIVO, Mundo, cargarMenu, cargarSuite } from "../mundo.ts";
import type { CapacidadesMundo } from "../mundo.ts";
import type { CasoEval, ResultadoCaso, SuiteEval } from "../tipos.ts";
import { evaluarCasoIngles } from "./graders-ingles.ts";
import { correrReferenciaIngles } from "./referencia-ingles.ts";

/** Casos en ingles con el mundo (sucursales, zonas) del set base: los fixtures no se duplican. */
export function cargarSuiteIngles(): SuiteEval {
  const base = cargarSuite();
  const propios = JSON.parse(readFileSync(new URL("casos-ingles.json", import.meta.url), "utf8")) as { suite: string; version: string; casos: CasoEval[] };
  return { suite: propios.suite, version: propios.version, fixtures: base.fixtures, casos: propios.casos };
}

export interface EjecucionCasoIngles {
  readonly mundo: Mundo;
  readonly resultado: ResultadoCaso;
}

export async function ejecutarCasoReferenciaIngles(caso: CasoEval, capacidades: CapacidadesMundo = CONTRATO_OBJETIVO, suite: SuiteEval = cargarSuiteIngles()): Promise<EjecucionCasoIngles> {
  const mundo = new Mundo(caso, suite, cargarMenu(), capacidades);
  let excepcion: string | null = null;
  try {
    await correrReferenciaIngles(mundo);
  } catch (err) {
    excepcion = err instanceof Error ? err.message : String(err);
  }
  const base = evaluarCasoIngles(caso, mundo);
  if (excepcion === null) return { mundo, resultado: base };
  return { mundo, resultado: { casoId: caso.id, ok: false, graders: [...base.graders, { grader: "EJECUCION", ok: false, detalle: excepcion }] } };
}

export async function ejecutarSuiteReferenciaIngles(capacidades: CapacidadesMundo = CONTRATO_OBJETIVO): Promise<readonly EjecucionCasoIngles[]> {
  const suite = cargarSuiteIngles();
  const out: EjecucionCasoIngles[] = [];
  for (const caso of suite.casos) out.push(await ejecutarCasoReferenciaIngles(caso, capacidades, suite));
  return out;
}
