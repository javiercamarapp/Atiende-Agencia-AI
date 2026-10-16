// Reporte de una corrida de evals de voz de HOTELES: JSON (maquina) y markdown (persona) en `docs/evals/hoteles/`. Forma comun para que el runner de
// WhatsApp (cuando exista) escriba en la misma carpeta. Sin datos de huespedes: solo ids de guion, nombres de grader y el detalle corto que ya dan los graders.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultadoGrader } from "./tipos.ts";

export interface ResultadoGuionEval {
  readonly id: string;
  readonly ok: boolean;
  readonly graders: readonly ResultadoGrader[];
  readonly error?: string;
  /** Tiempo de pared de la corrida del guion, en milisegundos. */
  readonly latenciaMs: number;
}

export interface OmitidoEval {
  readonly id: string;
  readonly motivo: "solo_falso" | "tope_de_gasto" | "no_seleccionado";
}

export interface EntradaReporteEvals {
  readonly canal: "voz";
  readonly modo: "real" | "falso";
  readonly modelo: string;
  readonly fecha: Date;
  readonly resultados: readonly ResultadoGuionEval[];
  readonly omitidos: readonly OmitidoEval[];
  readonly gastoUsdEstimado: number;
  readonly topeUsd: number | null;
}

export interface TasaAprobacion {
  readonly aprobados: number;
  readonly total: number;
  readonly tasa: number;
}

export interface ReporteEvals {
  readonly version: 1;
  readonly canal: "voz";
  readonly modo: "real" | "falso";
  readonly modelo: string;
  readonly fecha: string;
  readonly guionesCorridos: readonly string[];
  readonly guionesOmitidos: readonly OmitidoEval[];
  readonly aprobacion: { readonly global: TasaAprobacion; readonly porGrader: Readonly<Record<string, TasaAprobacion>> };
  readonly costo: { readonly usdEstimado: number; readonly topeUsd: number | null };
  readonly latenciaMs: { readonly p50: number | null; readonly p95: number | null };
  readonly resultados: readonly ResultadoGuionEval[];
}

const tasa = (aprobados: number, total: number): TasaAprobacion => ({ aprobados, total, tasa: total === 0 ? 0 : aprobados / total });

/** Percentil por rango mas cercano (p en 0..100); `null` sin datos. */
export function percentil(valores: readonly number[], p: number): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const i = Math.min(orden.length - 1, Math.max(0, Math.ceil((p / 100) * orden.length) - 1));
  return orden[i]!;
}

export function construirReporte(e: EntradaReporteEvals): ReporteEvals {
  const porGrader = new Map<string, { ok: number; total: number }>();
  for (const r of e.resultados) {
    for (const g of r.graders) {
      const a = porGrader.get(g.grader) ?? { ok: 0, total: 0 };
      a.total += 1;
      if (g.ok) a.ok += 1;
      porGrader.set(g.grader, a);
    }
  }
  const lat = e.resultados.map((r) => r.latenciaMs);
  return {
    version: 1,
    canal: e.canal,
    modo: e.modo,
    modelo: e.modelo,
    fecha: e.fecha.toISOString(),
    guionesCorridos: e.resultados.map((r) => r.id),
    guionesOmitidos: e.omitidos,
    aprobacion: {
      global: tasa(e.resultados.filter((r) => r.ok).length, e.resultados.length),
      porGrader: Object.fromEntries([...porGrader].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, tasa(v.ok, v.total)])),
    },
    costo: { usdEstimado: Math.round(e.gastoUsdEstimado * 1e6) / 1e6, topeUsd: e.topeUsd },
    latenciaMs: { p50: percentil(lat, 50), p95: percentil(lat, 95) },
    resultados: e.resultados,
  };
}

const pct = (t: TasaAprobacion): string => `${(t.tasa * 100).toFixed(1)} % (${t.aprobados}/${t.total})`;
const celda = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function reporteMarkdown(r: ReporteEvals): string {
  const l: string[] = [];
  l.push(`# Evals de ${r.canal} de hoteles (${r.modo})`, "");
  l.push(`- Fecha: ${r.fecha}`, `- Modelo: ${r.modelo}`, `- Aprobacion global: ${pct(r.aprobacion.global)}`);
  l.push(`- Costo estimado: US$ ${r.costo.usdEstimado.toFixed(4)}${r.costo.topeUsd === null ? "" : ` (tope US$ ${r.costo.topeUsd})`}`);
  l.push(`- Latencia por guion: p50 ${r.latenciaMs.p50 ?? "n/d"} ms, p95 ${r.latenciaMs.p95 ?? "n/d"} ms`, "");
  l.push("## Aprobacion por grader", "", "| Grader | Aprobacion |", "|---|---|");
  for (const [g, t] of Object.entries(r.aprobacion.porGrader)) l.push(`| ${g} | ${pct(t)} |`);
  l.push("", "## Guiones corridos", "", "| Guion | Resultado | Latencia (ms) | Fallos |", "|---|---|---|---|");
  for (const x of r.resultados) {
    const fallos = x.error ?? x.graders.filter((g) => !g.ok).map((g) => `${g.grader}: ${g.detalle ?? ""}`).join(" ; ");
    l.push(`| ${x.id} | ${x.ok ? "OK" : "FALLA"} | ${x.latenciaMs} | ${celda(fallos)} |`);
  }
  l.push("", "## Guiones omitidos", "");
  if (r.guionesOmitidos.length === 0) l.push("Ninguno.");
  for (const o of r.guionesOmitidos) l.push(`- ${o.id}: ${o.motivo}`);
  return `${l.join("\n")}\n`;
}

/** Escribe `<canal>-<fecha>.json` y `.md` en `dir` (se crea si falta) y devuelve las dos rutas. */
export function escribirReporte(r: ReporteEvals, dir: string): { readonly json: string; readonly md: string } {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${r.canal}-${r.modo}-${r.fecha.replace(/[:.]/g, "-")}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync(`${base}.md`, reporteMarkdown(r));
  return { json: `${base}.json`, md: `${base}.md` };
}
