// Escenarios de punta a punta del repo original (atiende-restaurantes @ 13fb3bd) que no existian en las evals de PM (anexo NC-E2E de la importacion
// del original): llamadas reales de Javier, el E2E por SDK, los guiones de los *.test.ts y el red team. Tienen la MISMA forma que `casos.json`
// (`CasoEval`), asi que corren con `ejecutarCasoReferencia` (agente de referencia + mundo + graders deterministas) sin editar el registro comun.
// `estado: "pendiente_decision"` = depende de una decision abierta del dueno: se lista pero ni corre ni falla el CI.
import { readFileSync } from "node:fs";
import type { CasoEval } from "./tipos.ts";

export interface CasoE2eOriginal extends CasoEval {
  /** Fila del anexo NC-E2E y commit/archivo del original de donde sale (`E01 / cec17f1 ...`). */
  readonly origen_original: string;
  readonly estado: "activo" | "pendiente_decision";
  readonly dudas: readonly string[];
  /** Clave de la comprobacion contra el servidor real que ata el escenario (ver tests/evals-e2e-original.spec.ts). */
  readonly verificacion_servidor?: string;
}

export interface SuiteE2eOriginal {
  readonly suite: string;
  readonly version: string;
  readonly nota: string;
  readonly casos: readonly CasoE2eOriginal[];
}

let cache: SuiteE2eOriginal | null = null;
export function cargarEscenariosE2eOriginal(): SuiteE2eOriginal {
  cache ??= JSON.parse(readFileSync(new URL("escenarios-e2e-original.json", import.meta.url), "utf8")) as SuiteE2eOriginal;
  return cache;
}
