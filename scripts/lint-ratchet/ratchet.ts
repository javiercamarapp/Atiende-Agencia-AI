// Trinquete de lint (PL-12). `npm run lint` solo falla con ERRORES; las advertencias (warn) pueden crecer sin
// que nadie lo note. Este guard cuenta las advertencias reales de ESLint y exige que el numero NUNCA suba por
// encima del baseline versionado en `baseline.json`. Si baja, pide bajar el baseline (el piso solo desciende).
//
// Uso:   node --experimental-strip-types scripts/lint-ratchet/ratchet.ts            -> comprueba (CI)
//        node --experimental-strip-types scripts/lint-ratchet/ratchet.ts --update   -> baja el baseline si hay menos
//        (nunca lo sube: subirlo es una decision humana que se hace editando baseline.json en un PR a la vista)
// Pruebas: packages/db/tests/ci-pl12-guards.spec.ts ejercita `evaluarRatchet` y `contarResultadosEslint`.
// Sin secretos, sin red, sin escribir fuera de baseline.json.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface ResultadoEslint {
  readonly filePath?: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly messages?: ReadonlyArray<{ readonly ruleId?: string | null }>;
}

export interface ConteoLint {
  readonly errores: number;
  readonly advertencias: number;
  readonly porRegla: Readonly<Record<string, number>>;
}

export interface Veredicto {
  readonly ok: boolean;
  /** Verdadero si hay MENOS advertencias que el baseline: conviene bajarlo con --update. */
  readonly puedeBajarBaseline: boolean;
  readonly mensaje: string;
}

export function contarResultadosEslint(resultados: readonly ResultadoEslint[]): ConteoLint {
  let errores = 0;
  let advertencias = 0;
  const porRegla: Record<string, number> = {};
  for (const r of resultados) {
    errores += r.errorCount;
    advertencias += r.warningCount;
    for (const m of r.messages ?? []) {
      const regla = m.ruleId ?? "(sin regla)";
      porRegla[regla] = (porRegla[regla] ?? 0) + 1;
    }
  }
  return { errores, advertencias, porRegla };
}

export function evaluarRatchet(conteo: Pick<ConteoLint, "errores" | "advertencias">, baseline: number): Veredicto {
  if (!Number.isInteger(baseline) || baseline < 0) {
    return { ok: false, puedeBajarBaseline: false, mensaje: `baseline invalido (${String(baseline)}): debe ser un entero >= 0` };
  }
  if (conteo.errores > 0) {
    return { ok: false, puedeBajarBaseline: false, mensaje: `ESLint reporta ${conteo.errores} error(es); corrigelos antes de mirar las advertencias` };
  }
  if (conteo.advertencias > baseline) {
    return {
      ok: false,
      puedeBajarBaseline: false,
      mensaje: `las advertencias de ESLint subieron: ${conteo.advertencias} > baseline ${baseline} (+${conteo.advertencias - baseline}). Corrige las nuevas; el baseline solo puede bajar`,
    };
  }
  if (conteo.advertencias < baseline) {
    return {
      ok: true,
      puedeBajarBaseline: true,
      mensaje: `advertencias ${conteo.advertencias} < baseline ${baseline}: baja el baseline con \`node --experimental-strip-types scripts/lint-ratchet/ratchet.ts --update\` y commitealo`,
    };
  }
  return { ok: true, puedeBajarBaseline: false, mensaje: `advertencias ${conteo.advertencias} == baseline ${baseline}` };
}

export function leerBaseline(ruta: URL): number {
  const crudo = JSON.parse(readFileSync(ruta, "utf8")) as { warnings?: unknown };
  if (typeof crudo.warnings !== "number") throw new Error("baseline.json no trae `warnings` numerico");
  return crudo.warnings;
}

function ejecutarEslint(): ConteoLint {
  const r = spawnSync("npx", ["eslint", ".", "-f", "json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  // ESLint sale con 1 si hay errores y con 2 si falla su propia configuracion; con 0/1 el stdout es el JSON.
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    throw new Error(`eslint no se pudo ejecutar (status ${String(r.status)}): ${(r.error?.message ?? r.stderr ?? "").slice(0, 2000)}`);
  }
  return contarResultadosEslint(JSON.parse(r.stdout) as ResultadoEslint[]);
}

function main(): number {
  const rutaBaseline = new URL("./baseline.json", import.meta.url);
  const baseline = leerBaseline(rutaBaseline);
  const conteo = ejecutarEslint();
  const veredicto = evaluarRatchet(conteo, baseline);
  const top = Object.entries(conteo.porRegla)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([regla, n]) => `  ${n}\t${regla}`)
    .join("\n");
  console.log(`lint-ratchet: errores=${conteo.errores} advertencias=${conteo.advertencias} baseline=${baseline}`);
  if (top) console.log(`reglas con mas hallazgos:\n${top}`);
  console.log(`lint-ratchet: ${veredicto.mensaje}`);
  if (process.argv.includes("--update") && veredicto.ok && conteo.advertencias < baseline) {
    writeFileSync(rutaBaseline, `${JSON.stringify({ warnings: conteo.advertencias }, null, 2)}\n`);
    console.log(`lint-ratchet: baseline bajado a ${conteo.advertencias}`);
  }
  return veredicto.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
