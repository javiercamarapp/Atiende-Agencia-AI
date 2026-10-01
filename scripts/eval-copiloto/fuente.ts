// Formato de AUTORIA de los casos (scripts/eval-copiloto/casos/<vertical>.ts) y resolucion de las cifras esperadas.
// El autor escribe la pregunta, la(s) herramienta(s) y argumentos esperados y QUE cifras importan (columna/fila);
// los VALORES no se escriben: salen de ejecutar la herramienta de referencia contra la base sembrada (congelar.ts).
import type { DataChatHistoryTurn, DataChatStatus, DataChatToolResult } from "@atiende/agent-core/data-chat";
import { extractNumbers } from "@atiende/agent-core/data-chat";
import type { CategoriaCaso, CifraEsperada, LlamadaEsperada, RiesgoCaso } from "@atiende/agent-core/data-chat/evals";

export type FilaSpec = "primera" | "ultima" | "suma" | "max" | "min" | "conteo" | number | { readonly donde: Readonly<Record<string, string | number>> };

export type CifraSpec =
  | { readonly l?: number; readonly col: string; readonly fila?: FilaSpec; readonly etiqueta?: string }
  /** Cifras del resumen determinista de la llamada SIN los parentesis (etiqueta de periodo y alcance); `tomar` elige por posicion. */
  | { readonly l?: number; readonly resumen: true; readonly tomar?: readonly number[]; readonly etiqueta?: string };

export interface CasoFuente {
  readonly id: string;
  readonly cat: CategoriaCaso;
  readonly q: string;
  /** Historial previo como pares [usuario, asistente]. */
  readonly h?: readonly (readonly [string, string])[];
  readonly llama?: readonly LlamadaEsperada[];
  readonly cifras?: readonly CifraSpec[];
  /** Estado esperado del turno. Por omision: ok si hay llamadas, clarify si ambigua, out_of_catalog en otro caso. */
  readonly status?: DataChatStatus;
  readonly grafica?: boolean;
  readonly prohibidas?: readonly string[];
  readonly riesgo?: RiesgoCaso;
}

export const llamada = (tool: string, args: Readonly<Record<string, string | number>> = {}): LlamadaEsperada => ({ tool, args });

export function historialDe(h: CasoFuente["h"]): DataChatHistoryTurn[] {
  return (h ?? []).flatMap(([u, a]) => [
    { role: "user" as const, text: u },
    { role: "assistant" as const, text: a },
  ]);
}

export function riesgoPorOmision(c: CategoriaCaso): RiesgoCaso {
  if (c === "fuera_catalogo" || c === "trampa") return "alto";
  if (c === "ambigua") return "bajo";
  return "medio";
}

export function estadoPorOmision(c: CasoFuente): DataChatStatus {
  if (c.status) return c.status;
  if ((c.llama?.length ?? 0) > 0) return "ok";
  return c.cat === "ambigua" ? "clarify" : "out_of_catalog";
}

function numero(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Resuelve UNA especificacion de cifra contra los resultados de referencia. Lanza si no existe (caso mal escrito). */
export function resolverCifra(spec: CifraSpec, resultados: readonly DataChatToolResult[], idCaso: string): CifraEsperada[] {
  const r = resultados[spec.l ?? 0];
  if (!r) throw new Error(`${idCaso}: la cifra apunta a la llamada ${spec.l ?? 0} y no existe`);
  if ("resumen" in spec) {
    const sinParentesis = (r.summary ?? "").replace(/\([^)]*\)/g, " ");
    const todas = extractNumbers(sinParentesis);
    const nums = spec.tomar ? spec.tomar.map((i) => todas[i]).filter((n): n is number => n !== undefined) : todas;
    if (nums.length === 0) throw new Error(`${idCaso}: el resumen de la llamada ${spec.l ?? 0} no tiene cifras (${r.summary ?? ""})`);
    return nums.map((valor, i) => ({ etiqueta: `${spec.etiqueta ?? "resumen"}#${i + 1}`, valor }));
  }
  const fila = spec.fila ?? "primera";
  const valores = r.rows.map((row) => row[spec.col]);
  if (!r.columns.some((c) => c.key === spec.col)) throw new Error(`${idCaso}: la columna '${spec.col}' no existe (hay: ${r.columns.map((c) => c.key).join(", ")})`);
  let v: number | null = null;
  if (fila === "primera") v = numero(valores[0]);
  else if (fila === "ultima") v = numero(valores[valores.length - 1]);
  else if (fila === "suma") v = valores.reduce<number>((a, x) => a + (numero(x) ?? 0), 0);
  else if (fila === "max") v = Math.max(...valores.map((x) => numero(x) ?? -Infinity));
  else if (fila === "min") v = Math.min(...valores.map((x) => numero(x) ?? Infinity));
  else if (fila === "conteo") v = r.rows.length;
  else if (typeof fila === "number") v = numero(valores[fila]);
  else {
    const hit = r.rows.find((row) => Object.entries(fila.donde).every(([k, x]) => row[k] === x));
    if (!hit) throw new Error(`${idCaso}: no hay fila con ${JSON.stringify(fila.donde)} (filas: ${r.rows.length})`);
    v = numero(hit[spec.col]);
  }
  if (v === null || !Number.isFinite(v)) throw new Error(`${idCaso}: la columna '${spec.col}' no es numerica en la fila pedida`);
  return [{ etiqueta: spec.etiqueta ?? `${spec.col}(${typeof fila === "object" ? "donde" : fila})`, valor: Math.round(v * 100) / 100 }];
}
