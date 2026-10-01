// Tareas del BAKE-OFF (40) construidas desde los resultados REALES congelados de las herramientas de referencia, y el modelo
// guionado "oro" del modo CI (genera un reporte valido a partir de las tablas, sin red ni costo).
import type { DataChatToolResult } from "@atiende/agent-core/data-chat";
import { candidatoPorId } from "@atiende/agent-core/data-chat/evals";
import type { ArchivoCongelado, CategoriaCaso, DataChatCompletionAlias, TareaBakeoff } from "./tipos-bakeoff.ts";
import { VERTICALES_EVAL, type VerticalEval } from "./mundos.ts";

/** Cuantas tareas por vertical (6 verticales = 40) y de que categorias de caso salen, en orden de preferencia. */
export const TAREAS_POR_VERTICAL: Readonly<Record<VerticalEval, number>> = { restaurantes: 7, hoteles: 7, rentas: 7, despachos: 7, licitaciones: 6, citas: 6 };
const PREFERENCIA: readonly CategoriaCaso[] = ["multi", "multi", "multi", "directa", "directa", "periodo", "redaccion", "directa"];

export function seleccionarTareas(congelados: ReadonlyMap<VerticalEval, ArchivoCongelado>): TareaBakeoff[] {
  const tareas: TareaBakeoff[] = [];
  for (const v of VERTICALES_EVAL) {
    const c = congelados.get(v);
    if (!c) continue;
    const usados = new Set<string>();
    const elegibles = c.casos.filter((x) => x.esperado.status === "ok" && x.esperado.llamadas.length > 0 && (c.referencias[x.id] ?? []).some((r) => r.result.rows.length >= 2) && x.historial.length === 0);
    for (const cat of PREFERENCIA) {
      if (usados.size >= TAREAS_POR_VERTICAL[v]) break;
      const caso = elegibles.find((x) => x.categoria === cat && !usados.has(x.id));
      if (!caso) continue;
      usados.add(caso.id);
      tareas.push({
        id: `BO-${caso.id}`,
        vertical: v,
        peticion: `Prepara un reporte ejecutivo para la direccion sobre lo siguiente: ${caso.pregunta}`,
        tablas: (c.referencias[caso.id] ?? []).map((r) => r.result as DataChatToolResult),
        cifrasClave: caso.esperado.cifras,
      });
    }
    // completa con cualquier otro caso elegible si las categorias preferidas no alcanzaron
    for (const caso of elegibles) {
      if (usados.size >= TAREAS_POR_VERTICAL[v]) break;
      if (usados.has(caso.id)) continue;
      usados.add(caso.id);
      tareas.push({ id: `BO-${caso.id}`, vertical: v, peticion: `Prepara un reporte ejecutivo para la direccion sobre lo siguiente: ${caso.pregunta}`, tablas: (c.referencias[caso.id] ?? []).map((r) => r.result as DataChatToolResult), cifrasClave: caso.esperado.cifras });
    }
  }
  return tareas;
}

// ---------------------------------------------------------------------------------------------
// Modelo "oro" del bake-off (CI): reporte valido derivado de las tablas
// ---------------------------------------------------------------------------------------------

interface TablaPrompt {
  tabla: number;
  fuente: string;
  periodo: string | null;
  columnas: { clave: string; tipo: string }[];
  filas: Record<string, string | number | null>[];
  resumen: string | null;
}

function tablasDelPrompt(user: string): TablaPrompt[] {
  const i = user.indexOf("Tablas: ");
  const j = user.indexOf("\nAnalisis: ");
  return JSON.parse(user.slice(i + "Tablas: ".length, j < 0 ? undefined : j)) as TablaPrompt[];
}

export function reporteOro(user: string): unknown {
  const tablas = tablasDelPrompt(user);
  const t0 = tablas[0]!;
  const numerica = t0.columnas.find((c) => c.tipo !== "text" && t0.filas.some((f) => typeof f[c.clave] === "number"))?.clave ?? t0.columnas[0]!.clave;
  const etiqueta = t0.columnas.find((c) => c.tipo === "text")?.clave ?? t0.columnas[0]!.clave;
  const filas = t0.filas.slice(0, 8);
  const valor = (f: Record<string, string | number | null>): number => (typeof f[numerica] === "number" && Number.isFinite(f[numerica] as number) ? Math.abs(f[numerica] as number) : 0);
  const max = Math.max(1, ...filas.map(valor));
  const barras = filas
    .slice(0, 5)
    .map((f, i) => {
      const alto = Math.round((valor(f) / max) * 200);
      return `<rect x="${60 + i * 100}" y="${280 - alto}" width="70" height="${alto}" fill="#1d4ed8"/><text x="${60 + i * 100}" y="300" font-size="12">${String(f[etiqueta] ?? "").replace(/[<>&"]/g, "").replace(/\b(?:NaN|undefined|null)\b/g, "").slice(0, 12)}</text>`;
    })
    .join("");
  const resumen = tablas.map((t) => t.resumen ?? "").filter(Boolean).join(" ").slice(0, 600) || `Resumen de ${t0.fuente}.`;
  // Cada hallazgo cita los valores numericos de una fila de alguna tabla (todos salen de las tablas).
  const textoFila = (t: TablaPrompt, f: Record<string, string | number | null>): string =>
    t.columnas
      .filter((c) => typeof f[c.clave] === "number")
      .map((c) => `${c.clave} ${String(f[c.clave])}`)
      .join(", ");
  const hallazgos = tablas.flatMap((t, ti) => t.filas.slice(0, 8).map((f, i) => ({ texto: `Tabla ${ti + 1}, fila ${i + 1}: ${textoFila(t, f) || "sin valores numericos"}.`, fuente: [{ tabla: ti, fila: i }] })));
  return {
    titulo: "Reporte ejecutivo",
    resumen,
    secciones: [
      { encabezado: "Lo mas importante", texto: resumen },
      { encabezado: "Detalle", texto: `La tabla principal tiene ${t0.filas.length} filas.` },
    ],
    hallazgos,
    grafica: { kind: "bar", x: etiqueta, y: numerica, tabla: 0 },
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><title>Resumen</title><rect x="0" y="0" width="640" height="360" fill="#f8fafc"/>${barras}<line x1="50" y1="280" x2="600" y2="280" stroke="#334155"/></svg>`,
  };
}

/** Fabrica guionada: el analista devuelve un analisis minimo y el redactor/solo el reporte oro. */
export function fabricaOroBakeoff(): (m: { id: string }) => DataChatCompletionAlias {
  return (m) => async (req) => {
    const user = req.messages.find((x) => x.role === "user")?.content ?? "";
    const esAnalista = req.system.startsWith("Eres un analista de datos");
    const text = esAnalista ? JSON.stringify({ kpis: [], tendencias: [], anomalias: [], riesgos: [], recomendaciones: [] }) : JSON.stringify(reporteOro(user));
    return { text, model: m.id, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  };
}

/** Tokens por reporte supuestos para proyectar (entrada/salida): analista 3k/1.2k, redactor 6k/2k, solo 4k/3k. */
export function proyectarBakeoffUsd(tareas: number, brazos: readonly { analista?: string; redactor: string }[]): number {
  const costo = (id: string, tIn: number, tOut: number): number => {
    const m = candidatoPorId(id)!;
    return (tIn * m.precio.entrada + tOut * m.precio.salida) / 1_000_000;
  };
  let total = 0;
  for (const b of brazos) total += b.analista ? costo(b.analista, 3_000, 1_200) + costo(b.redactor, 6_000, 2_000) : costo(b.redactor, 4_000, 3_000);
  return Math.round(total * tareas * 1000) / 1000;
}

