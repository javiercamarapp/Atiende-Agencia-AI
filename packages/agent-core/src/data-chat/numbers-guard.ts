// "Nunca inventa cifras": todo número que aparezca en el texto narrado por el modelo
// debe existir en los resultados de las herramientas (o en la pregunta/periodo). Si no,
// el motor DESCARTA la narrativa y muestra el resumen determinista + las tablas.
import { formatCell } from "./format.js";
import type { DataChatToolResult } from "./types.js";

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.match(NUMBER_RE) ?? []) {
    const n = Number(m.replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function variants(n: number): number[] {
  return [n, Math.round(n * 100) / 100, Math.round(n * 10) / 10, Math.round(n), Math.abs(n)];
}

export function allowedNumbers(question: string, results: readonly DataChatToolResult[]): Set<number> {
  const allowed = new Set<number>();
  const add = (n: number) => variants(n).forEach((v) => allowed.add(v));
  extractNumbers(question).forEach(add);
  for (const r of results) {
    [r.source, r.periodLabel ?? "", r.scopeLabel, r.summary ?? ""].forEach((t) => extractNumbers(t).forEach(add));
    // posiciones/conteos ("top 3", "2 de 5"): 1..#filas
    for (let i = 0; i <= r.rows.length; i += 1) allowed.add(i);
    for (const row of r.rows) {
      for (const col of r.columns) {
        const v = row[col.key];
        if (v === null || v === undefined) continue;
        if (typeof v === "number") {
          add(v);
          extractNumbers(formatCell(col.kind, v)).forEach(add);
          if (col.kind === "percent") add(Math.round(v));
        } else {
          extractNumbers(v).forEach(add);
        }
      }
    }
  }
  return allowed;
}

/** Números del texto que NO están respaldados por los resultados. Vacío = texto limpio. */
export function unsupportedNumbers(text: string, allowed: ReadonlySet<number>): number[] {
  return extractNumbers(text).filter((n) => !variants(n).some((v) => allowed.has(v)));
}
