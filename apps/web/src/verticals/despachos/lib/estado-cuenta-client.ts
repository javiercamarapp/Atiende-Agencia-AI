// Cliente de la importación de estados de cuenta bancarios (D-03):
// POST /despachos/:propertyId/conciliacion/importar-estado-de-cuenta (vista previa de
// solo lectura: parsea CSV/OFX, valida por renglón, calcula el hash de idempotencia y
// concilia contra los CFDI de la property). Los tipos son un espejo deliberado de
// @atiende/domain-despachos/conciliacion/estado-de-cuenta (mismo criterio que
// conciliacion-client.ts: este paquete web no depende en build del paquete de dominio).
import { postJson } from "./admin-client.ts";
import type { NivelCoincidencia, ResultadoConciliacion } from "./conciliacion-client.ts";

export const BANCOS_ESTADO_CUENTA = [
  { id: "bbva", nombre: "BBVA México" },
  { id: "banorte", nombre: "Banorte" },
  { id: "santander", nombre: "Santander" },
  { id: "hsbc", nombre: "HSBC México" },
  { id: "scotiabank", nombre: "Scotiabank" },
  { id: "banamex", nombre: "Citibanamex" },
  { id: "inbursa", nombre: "Inbursa" },
  { id: "generico", nombre: "Otro / genérico" },
] as const;
export type BancoEstadoCuenta = (typeof BANCOS_ESTADO_CUENTA)[number]["id"];

export interface MovimientoImportado {
  readonly fecha: string; // YYYY-MM-DD
  readonly descripcion: string;
  readonly referencia: string | null;
  readonly cargo: number | null;
  readonly abono: number | null;
  readonly saldo: number | null;
  readonly monto: number;
  readonly banco: string;
  readonly formato: string;
  readonly renglon: number;
  readonly hash: string;
  readonly ocurrencia: number;
}

export interface ErrorRenglonEstado {
  readonly renglon: number;
  readonly campo: string | null;
  readonly codigo: string;
  readonly mensaje: string;
}

export interface AdvertenciaEstado {
  readonly renglon: number | null;
  readonly codigo: string;
  readonly mensaje: string;
}

export interface ResultadoParseoEstado {
  readonly formato: "csv" | "ofx";
  readonly banco: BancoEstadoCuenta;
  readonly bancoDetectado: boolean;
  readonly cuenta: string | null;
  readonly moneda: string;
  readonly movimientos: readonly MovimientoImportado[];
  readonly errores: readonly ErrorRenglonEstado[];
  readonly advertencias: readonly AdvertenciaEstado[];
  readonly renglonesLeidos: number;
  readonly periodo: { readonly desde: string; readonly hasta: string } | null;
  readonly totalCargos: number;
  readonly totalAbonos: number;
  readonly saldoFinal: number | null;
}

export interface CoincidenciaImportacion {
  readonly hash: string;
  readonly renglon: number;
  readonly nivel: NivelCoincidencia;
  readonly score: number;
  readonly detalle: string;
  readonly registroIds: readonly string[];
  readonly folioFiscal: readonly string[];
  readonly cobranzaPendienteIds: readonly string[];
}

export interface VistaPreviaImportacion {
  readonly parseo: ResultadoParseoEstado;
  readonly yaImportados: readonly string[];
  readonly nuevos: number;
  readonly conciliacion: ResultadoConciliacion | null;
  readonly conciliacionOmitida: string | null;
  readonly coincidencias: readonly CoincidenciaImportacion[];
  readonly cobranzaDisponible: boolean;
  readonly libroDisponible: boolean;
}

export interface ResultadoGuardadoEstadoCuenta {
  readonly loteId: string;
  readonly insertados: number;
  readonly yaExistentes: number;
  readonly totalMovimientos: number;
}

export interface EntradaImportacion {
  readonly contenido: string;
  readonly formato?: "csv" | "ofx";
  readonly banco?: BancoEstadoCuenta;
  readonly cuenta?: string;
}

/**
 * Decodifica los bytes de un archivo bancario a texto. Los bancos mexicanos exportan en
 * UTF-8 o en Windows-1252 (Latin-1): se intenta UTF-8 ESTRICTO y, si hay bytes inválidos,
 * se reintenta como Windows-1252 para no convertir "Nómina" en "NÃ³mina" ni en "N?mina".
 */
export function decodificarArchivoEstadoCuenta(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Formato por extensión del archivo; `undefined` deja que el servidor lo detecte del contenido. */
export function formatoPorNombreArchivo(nombre: string): "csv" | "ofx" | undefined {
  const n = nombre.toLowerCase();
  if (n.endsWith(".ofx") || n.endsWith(".qfx")) return "ofx";
  if (n.endsWith(".csv") || n.endsWith(".txt")) return "csv";
  return undefined;
}

export async function previsualizarEstadoCuenta(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, entrada: EntradaImportacion): Promise<VistaPreviaImportacion> {
  return postJson<VistaPreviaImportacion>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/conciliacion/importar-estado-de-cuenta`, token, entrada);
}

/** Guarda en el libro los movimientos del archivo, idempotente por hash: el servidor vuelve a
 * parsear el contenido (nunca confía en movimientos que mande el cliente) y descarta lo ya importado. */
export async function guardarEstadoCuenta(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, entrada: EntradaImportacion): Promise<ResultadoGuardadoEstadoCuenta> {
  return postJson<ResultadoGuardadoEstadoCuenta>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/conciliacion/importar-estado-de-cuenta/guardar`, token, entrada);
}
