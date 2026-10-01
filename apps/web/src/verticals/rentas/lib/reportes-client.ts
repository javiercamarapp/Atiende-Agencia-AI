// Rn-03 -- cliente del reporte de ocupación e ingresos
// (apps/api/src/routes/verticals/rentas/reportes.ts). Separado de pages/Reportes.tsx para
// probarlo en entorno "node".
//   - fetchReporte     -> GET /rentas/:propertyId/reportes/ocupacion-ingresos (json)
//   - descargarReporte -> mismo endpoint con formato=csv|pdf (Blob)
import { fetchBlob, fetchJson } from "./admin-client.ts";

export type AgrupacionReporte = "unidad" | "propietario" | "canal" | "mes";
export const ETIQUETA_AGRUPACION: Record<AgrupacionReporte, string> = { unidad: "Unidad", propietario: "Propietario", canal: "Canal", mes: "Mes" };

export interface MetricasReporte {
  readonly llegadas: number;
  readonly nochesOcupadas: number;
  readonly nochesDisponibles: number | null;
  readonly ocupacionBasisPoints: number | null;
  readonly ingresoBrutoCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
  readonly adrCentavos: number;
}

export interface GrupoReporte extends MetricasReporte {
  readonly clave: string;
  readonly etiqueta: string;
}

export interface ReporteOcupacionIngresos {
  readonly desde: string;
  readonly hasta: string;
  readonly moneda: string;
  readonly financieroDisponible: boolean;
  readonly totales: MetricasReporte;
  readonly grupos: Readonly<Record<AgrupacionReporte, readonly GrupoReporte[]>>;
  readonly advertencias: {
    readonly reservasSinMovimientoFinanciero: number;
    readonly reservasMonedaDistinta: number;
    readonly nochesSolapadasOmitidas: number;
    readonly reservasDuplicadasOmitidas: number;
  };
}

interface MetricasWire {
  readonly llegadas: number;
  readonly noches_ocupadas: number;
  readonly noches_disponibles: number | null;
  readonly ocupacion_basis_points: number | null;
  readonly ingreso_bruto_centavos: number;
  readonly comision_canal_centavos: number;
  readonly comision_gestor_centavos: number;
  readonly gastos_centavos: number;
  readonly impuestos_centavos: number;
  readonly neto_centavos: number;
  readonly adr_centavos: number;
}
type GrupoWire = MetricasWire & { readonly clave: string; readonly etiqueta: string };

interface ReporteWire {
  readonly periodo: { readonly desde: string; readonly hasta: string };
  readonly moneda: string;
  readonly financiero_disponible: boolean;
  readonly totales: MetricasWire;
  readonly por_unidad: readonly GrupoWire[];
  readonly por_propietario: readonly GrupoWire[];
  readonly por_canal: readonly GrupoWire[];
  readonly por_mes: readonly GrupoWire[];
  readonly advertencias: {
    readonly reservas_sin_movimiento_financiero: number;
    readonly reservas_moneda_distinta: number;
    readonly noches_solapadas_omitidas: number;
    readonly reservas_duplicadas_omitidas: number;
  };
}

const mapMetricas = (w: MetricasWire): MetricasReporte => ({
  llegadas: w.llegadas,
  nochesOcupadas: w.noches_ocupadas,
  nochesDisponibles: w.noches_disponibles,
  ocupacionBasisPoints: w.ocupacion_basis_points,
  ingresoBrutoCentavos: w.ingreso_bruto_centavos,
  comisionCanalCentavos: w.comision_canal_centavos,
  comisionGestorCentavos: w.comision_gestor_centavos,
  gastosCentavos: w.gastos_centavos,
  impuestosCentavos: w.impuestos_centavos,
  netoCentavos: w.neto_centavos,
  adrCentavos: w.adr_centavos,
});
const mapGrupo = (w: GrupoWire): GrupoReporte => ({ clave: w.clave, etiqueta: w.etiqueta, ...mapMetricas(w) });

export interface ParametrosReporte {
  readonly desde?: string;
  readonly hasta?: string;
  readonly agrupar?: AgrupacionReporte;
}

function urlReporte(apiBaseUrl: string, propertyId: string, p: ParametrosReporte, formato: "json" | "csv" | "pdf"): string {
  const q = new URLSearchParams();
  if (p.desde && p.hasta) {
    q.set("desde", p.desde);
    q.set("hasta", p.hasta);
  }
  if (p.agrupar) q.set("agrupar", p.agrupar);
  if (formato !== "json") q.set("formato", formato);
  const qs = q.toString();
  return `${apiBaseUrl}/rentas/${propertyId}/reportes/ocupacion-ingresos${qs ? `?${qs}` : ""}`;
}

export async function fetchReporte(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, p: ParametrosReporte = {}): Promise<ReporteOcupacionIngresos> {
  const w = await fetchJson<ReporteWire>(fetchImpl, urlReporte(apiBaseUrl, propertyId, p, "json"), token);
  return {
    desde: w.periodo.desde,
    hasta: w.periodo.hasta,
    moneda: w.moneda,
    financieroDisponible: w.financiero_disponible,
    totales: mapMetricas(w.totales),
    grupos: { unidad: w.por_unidad.map(mapGrupo), propietario: w.por_propietario.map(mapGrupo), canal: w.por_canal.map(mapGrupo), mes: w.por_mes.map(mapGrupo) },
    advertencias: {
      reservasSinMovimientoFinanciero: w.advertencias.reservas_sin_movimiento_financiero,
      reservasMonedaDistinta: w.advertencias.reservas_moneda_distinta,
      nochesSolapadasOmitidas: w.advertencias.noches_solapadas_omitidas,
      reservasDuplicadasOmitidas: w.advertencias.reservas_duplicadas_omitidas,
    },
  };
}

export async function descargarReporte(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, p: ParametrosReporte, formato: "csv" | "pdf"): Promise<Blob> {
  return fetchBlob(fetchImpl, urlReporte(apiBaseUrl, propertyId, p, formato), token);
}

/** Centavos -> texto de moneda es-MX, sin punto flotante en el cálculo del entero/fracción. */
export function formatearMoneda(centavos: number, moneda: string): string {
  const signo = centavos < 0 ? "-" : "";
  const abs = Math.abs(centavos);
  const enteros = new Intl.NumberFormat("es-MX").format(Math.floor(abs / 100));
  return `${signo}$${enteros}.${String(abs % 100).padStart(2, "0")} ${moneda}`;
}

export function formatearOcupacion(bp: number | null): string {
  return bp === null ? "—" : `${(bp / 100).toFixed(1)}%`;
}
