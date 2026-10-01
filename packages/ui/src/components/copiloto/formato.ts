import type { CopilotoBloque, CopilotoCelda, CopilotoColumnaTipo, ConversacionResumen } from "./tipos";

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const entero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** Texto de una celda con el formato de su columna. Los textos no se interpretan como HTML (React los escapa). */
export function formatoCelda(kind: CopilotoColumnaTipo, valor: CopilotoCelda): string {
  if (valor === null) return "—";
  if (typeof valor === "string") return valor;
  switch (kind) {
    case "mxn":
      return mxn.format(valor);
    case "integer":
      return entero.format(valor);
    case "percent":
      return `${decimal.format(valor)} %`;
    case "decimal":
      return decimal.format(valor);
    default:
      return String(valor);
  }
}

/** Tabla del bloque como TSV (se pega en Excel). */
export function bloqueATsv(b: CopilotoBloque): string {
  const limpiar = (t: string) => t.replace(/[\t\r\n]+/g, " ");
  const cab = b.columns.map((c) => limpiar(c.label)).join("\t");
  const filas = b.rows.map((r) => b.columns.map((c) => limpiar(formatoCelda(c.kind, r[c.key] ?? null))).join("\t"));
  return [limpiar(b.title), cab, ...filas].join("\n");
}

export type GrupoHistorial = "fijadas" | "hoy" | "ayer" | "semana" | "anteriores";
export const ETIQUETA_GRUPO: Readonly<Record<GrupoHistorial, string>> = {
  fijadas: "Fijadas",
  hoy: "Hoy",
  ayer: "Ayer",
  semana: "Últimos 7 días",
  anteriores: "Anteriores",
};
export const ORDEN_GRUPOS: readonly GrupoHistorial[] = ["fijadas", "hoy", "ayer", "semana", "anteriores"];

/** Dia calendario (yyyy-mm-dd) de un instante en una zona horaria IANA. */
function diaEnZona(fecha: Date, zona: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(fecha);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(fecha);
  }
}

/** Dias enteros entre dos yyyy-mm-dd (a - b). */
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function grupoDeConversacion(c: ConversacionResumen, ahora: Date, zona: string | undefined): GrupoHistorial {
  if (c.fijada) return "fijadas";
  const t = new Date(c.actualizadaEn);
  if (Number.isNaN(t.getTime())) return "anteriores";
  const dif = diasEntre(diaEnZona(ahora, zona), diaEnZona(t, zona));
  if (dif <= 0) return "hoy";
  if (dif === 1) return "ayer";
  if (dif <= 7) return "semana";
  return "anteriores";
}

export function agruparConversaciones(
  lista: readonly ConversacionResumen[],
  ahora: Date,
  zona: string | undefined,
): Array<{ grupo: GrupoHistorial; items: ConversacionResumen[] }> {
  const por = new Map<GrupoHistorial, ConversacionResumen[]>();
  for (const c of lista) {
    const g = grupoDeConversacion(c, ahora, zona);
    por.set(g, [...(por.get(g) ?? []), c]);
  }
  return ORDEN_GRUPOS.filter((g) => por.has(g)).map((g) => ({ grupo: g, items: por.get(g) ?? [] }));
}

/** Rutas de fuente: solo internas (lista blanca), nunca URLs externas ni protocolos. */
export function rutaInternaSegura(ruta: string | undefined): string | undefined {
  if (!ruta) return undefined;
  return ruta.startsWith("/") && !ruta.startsWith("//") && !ruta.includes("\\") ? ruta : undefined;
}
