// Trinquete de `npm audit` (Ola 2, seguridad, arreglo F.4). Dos reglas:
//
//   1. Dependencias de PRODUCCION (`npm audit --omit=dev`): cero avisos high/critical. Sin baseline: hoy es 0.
//   2. Arbol completo (`npm audit`, incluye dev): ningun aviso high/critical NUEVO respecto de `baseline.json`. Los que
//      ya estaban (todos de la cadena de herramientas de desarrollo: vitest/tinypool, vite, jsdom/undici, eslint/
//      brace-expansion) quedan listados con su GHSA para retirarlos al actualizar; uno que desaparece pide limpiar el
//      baseline (el baseline solo se achica).
//
// `npm audit` necesita el registro de npm. Si no responde (sin red, 5xx), el paso NO bloquea: emite un aviso
// (`::warning::`) para no tumbar el CI por una caida externa; un resultado valido siempre se evalua.
//
// Uso:   node --experimental-strip-types scripts/npm-audit-baseline/check.ts
// Pruebas: packages/db/tests/npm-audit-baseline.spec.ts (evaluarAudit con reportes sinteticos).
// Sin secretos; solo lee package-lock.json via npm y baseline.json.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface AvisoAudit {
  readonly ghsa: string;
  readonly paquete: string;
  readonly severidad: "high" | "critical";
  readonly titulo: string;
}

export interface Baseline {
  readonly avisos: ReadonlyArray<{ readonly ghsa: string; readonly paquete: string; readonly severidad: string; readonly motivo: string }>;
}

export interface VeredictoAudit {
  readonly ok: boolean;
  readonly produccion: readonly AvisoAudit[];
  readonly nuevos: readonly AvisoAudit[];
  readonly retirables: readonly string[];
}

interface ReporteNpmAudit {
  readonly vulnerabilities?: Record<string, { readonly via?: ReadonlyArray<string | { readonly url?: string; readonly name?: string; readonly severity?: string; readonly title?: string }> }>;
}

/** Avisos high/critical de un reporte `npm audit --json` (v2), por GHSA, sin duplicados. */
export function avisosAltos(reporte: ReporteNpmAudit): AvisoAudit[] {
  const porGhsa = new Map<string, AvisoAudit>();
  for (const vuln of Object.values(reporte.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === "string") continue;
      if (via.severity !== "high" && via.severity !== "critical") continue;
      const ghsa = /GHSA-[\w-]+/.exec(via.url ?? "")?.[0];
      if (!ghsa) continue;
      porGhsa.set(ghsa, { ghsa, paquete: via.name ?? "?", severidad: via.severity, titulo: via.title ?? "" });
    }
  }
  return [...porGhsa.values()].sort((a, b) => a.ghsa.localeCompare(b.ghsa));
}

export function evaluarAudit(produccion: ReporteNpmAudit, completo: ReporteNpmAudit, baseline: Baseline): VeredictoAudit {
  const prod = avisosAltos(produccion);
  const todos = avisosAltos(completo);
  const conocidos = new Set(baseline.avisos.map((a) => a.ghsa));
  const vigentes = new Set(todos.map((a) => a.ghsa));
  const nuevos = todos.filter((a) => !conocidos.has(a.ghsa));
  const retirables = [...conocidos].filter((g) => !vigentes.has(g)).sort();
  return { ok: prod.length === 0 && nuevos.length === 0, produccion: prod, nuevos, retirables };
}

function correrAudit(args: string[]): ReporteNpmAudit | null {
  const r = spawnSync("npm", ["audit", "--json", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    const json = JSON.parse(r.stdout) as ReporteNpmAudit & { error?: unknown };
    if (json.error || !json.vulnerabilities) return null;
    return json;
  } catch {
    return null;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const baseline = JSON.parse(readFileSync(path.join(HERE, "baseline.json"), "utf8")) as Baseline;
  const produccion = correrAudit(["--omit=dev"]);
  const completo = correrAudit([]);
  if (!produccion || !completo) {
    console.log("::warning::npm audit no respondió (registro de npm inaccesible); el trinquete de auditoría no se evaluó en esta corrida.");
    process.exit(0);
  }
  const v = evaluarAudit(produccion, completo, baseline);
  const linea = (a: AvisoAudit) => `  - ${a.ghsa} ${a.paquete} (${a.severidad}): ${a.titulo}`;
  if (v.produccion.length > 0) console.error(`npm audit (producción): ${v.produccion.length} aviso(s) high/critical en dependencias de producción:\n${v.produccion.map(linea).join("\n")}`);
  if (v.nuevos.length > 0) console.error(`npm audit (árbol completo): ${v.nuevos.length} aviso(s) high/critical NUEVO(S), fuera de baseline.json:\n${v.nuevos.map(linea).join("\n")}`);
  if (v.retirables.length > 0) console.log(`npm audit: ya no aparecen ${v.retirables.join(", ")}; quítalos de scripts/npm-audit-baseline/baseline.json.`);
  if (!v.ok) process.exit(1);
  console.log(`npm audit: OK -- 0 high/critical en producción; árbol completo sin avisos nuevos (${baseline.avisos.length} conocidos en baseline.json, todos de desarrollo).`);
}
