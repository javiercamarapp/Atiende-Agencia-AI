// Cliente HTTP de los reportes de cliente de despachos (D-01): balanza, DIOT, nómina e
// impuestos de un contribuyente y período, en JSON (pantalla) o PDF/Excel (descarga). Llama a
// `GET /despachos/:propertyId/reportes/:tipo?periodo=YYYY-MM&formato=json|pdf|xlsx`
// (apps/api/.../despachos/reportes.ts). Los tipos reflejan el `ReporteCliente` del dominio.
import { fetchBlob, fetchJson } from "./admin-client.ts";

export const TIPOS_REPORTE = ["balanza", "diot", "nomina", "impuestos"] as const;
export type TipoReporte = (typeof TIPOS_REPORTE)[number];
export type FormatoReporte = "pdf" | "xlsx";

export const ETIQUETAS_TIPO_REPORTE: Readonly<Record<TipoReporte, string>> = {
  balanza: "Balanza de comprobación",
  diot: "DIOT",
  nomina: "Nómina",
  impuestos: "Impuestos (IVA e ISR)",
};

export interface ColumnaReporte {
  readonly clave: string;
  readonly titulo: string;
  readonly tipo: "texto" | "moneda" | "entero" | "porcentaje";
}

export type CeldaReporte = string | number | null;

export interface SeccionReporte {
  readonly titulo: string;
  readonly columnas: readonly ColumnaReporte[];
  readonly filas: readonly Readonly<Record<string, CeldaReporte>>[];
  readonly totales: Readonly<Record<string, CeldaReporte>> | null;
  readonly sinDatosMotivo: string | null;
}

export interface ReporteCliente {
  readonly tipo: TipoReporte;
  readonly titulo: string;
  readonly periodo: string;
  readonly generadoEn: string;
  readonly contribuyente: { readonly nombre: string; readonly rfc: string | null };
  readonly secciones: readonly SeccionReporte[];
  readonly notas: readonly string[];
  readonly sinDatos: boolean;
}

export function urlReporte(apiBaseUrl: string, propertyId: string, tipo: TipoReporte, periodo: string, formato: "json" | FormatoReporte): string {
  return `${apiBaseUrl}/despachos/${propertyId}/reportes/${tipo}?periodo=${encodeURIComponent(periodo)}&formato=${formato}`;
}

export async function fetchReporte(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tipo: TipoReporte, periodo: string): Promise<ReporteCliente> {
  return fetchJson<ReporteCliente>(fetchImpl, urlReporte(apiBaseUrl, propertyId, tipo, periodo, "json"), token);
}

export async function descargarReporte(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tipo: TipoReporte,
  periodo: string,
  formato: FormatoReporte,
): Promise<{ readonly blob: Blob; readonly nombre: string }> {
  return fetchBlob(fetchImpl, urlReporte(apiBaseUrl, propertyId, tipo, periodo, formato), token, `reporte-${tipo}-${periodo}.${formato}`);
}

const MXN = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const ENTERO = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const PCT = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Texto de una celda según el tipo de su columna (misma regla que el PDF/Excel del servidor). */
export function formatearCeldaReporte(valor: CeldaReporte, columna: ColumnaReporte): string {
  if (valor === null) return "";
  if (typeof valor === "number") {
    if (columna.tipo === "moneda") return MXN.format(valor);
    if (columna.tipo === "porcentaje") return `${PCT.format(valor)} %`;
    return ENTERO.format(valor);
  }
  return valor;
}
