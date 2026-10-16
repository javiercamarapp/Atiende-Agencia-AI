// D-24 -- cliente del libro contable persistido de un cliente del despacho. Llama a las rutas de
// apps/api/.../despachos/libro.ts (catalogo, polizas, reversa, balanza, CFDI del periodo, contabilidad electronica).
// Todo en CENTAVOS ENTEROS: las funciones puras de aqui convierten el texto en pesos que escribe el contador a centavos exactos
// (sin flotantes) y dan retroalimentacion inmediata; el servidor y la base validan de verdad.
import { despachosAuthContext, fetchJson, postJson, putJson } from "./admin-client.ts";
import { conStepUp } from "./step-up.ts";

export type TipoPoliza = "ingreso" | "egreso" | "diario";
export const TIPOS_POLIZA: readonly TipoPoliza[] = ["ingreso", "egreso", "diario"];
export const ETIQUETA_TIPO_POLIZA: Readonly<Record<TipoPoliza, string>> = { ingreso: "Ingreso", egreso: "Egreso", diario: "Diario" };
export const ETIQUETA_ORIGEN_POLIZA: Readonly<Record<string, string>> = { manual: "Manual", cfdi: "Desde CFDI", reversa: "Reversa" };

export type EstadoLibro = "disponible" | "no_disponible";

export interface CuentaLibro {
  readonly codigo: string;
  readonly descripcion: string;
  readonly naturaleza: "D" | "A";
  /** 1 = cuenta de mayor; n > 1 = subcuenta (migración 028). Ausente si el servidor aún no la tiene. */
  readonly nivel?: number;
  readonly cuentaPadre?: string | null;
  /** Código agrupador del SAT (Anexo 24); null = sin asignar. */
  readonly codigoAgrupador?: string | null;
  /** Código que propone el catálogo base (supuesto por validar con el fiscalista); solo se aplica con una acción explícita. */
  readonly propuestaCodigo?: string | null;
}

export interface PolizaResumen {
  readonly id: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly tipo: TipoPoliza;
  readonly folio: number;
  readonly fecha: string;
  readonly concepto: string;
  readonly origen: "manual" | "cfdi" | "reversa";
  readonly invoiceId: string | null;
  readonly reversaDe: string | null;
  readonly reversada: boolean;
  readonly totalCentavos: number;
}

export interface MovimientoPoliza {
  readonly linea: number;
  readonly cuenta: string;
  readonly concepto: string;
  readonly debeCentavos: number;
  readonly haberCentavos: number;
}

export interface PolizaDetalle extends PolizaResumen {
  readonly movimientos: readonly MovimientoPoliza[];
}

export interface LineaBalanza {
  readonly cuenta: string;
  readonly descripcion: string;
  readonly naturaleza: "D" | "A";
  readonly saldoInicialCentavos: number;
  readonly debeCentavos: number;
  readonly haberCentavos: number;
  readonly saldoFinalCentavos: number;
}

export interface BalanzaRespuesta {
  readonly estado: EstadoLibro;
  readonly periodo: string;
  readonly lineas: readonly LineaBalanza[];
  readonly totales: { readonly debeCentavos: number; readonly haberCentavos: number; readonly cuadrada: boolean };
}

export interface CfdiLibro {
  readonly id: string;
  readonly folioFiscal: string;
  readonly tipo: string;
  readonly direccion: "emitido" | "recibido" | "indeterminado" | null;
  readonly fecha: string;
  readonly totalCentavos: number;
  readonly estadoSat: string;
  readonly poliza: { readonly id: string; readonly folio: number; readonly tipo: TipoPoliza } | null;
  readonly armable: boolean;
  readonly motivo: string | null;
}

export interface PagoRepLibro {
  readonly pagoId: string;
  readonly folioFiscalRep: string;
  readonly folioFiscalCfdi: string;
  readonly fechaPago: string;
  readonly flujo: "trasladado" | "acreditable";
  readonly numParcialidad: number | null;
  readonly importePagadoCentavos: number;
  readonly ivaCentavos: number;
  readonly poliza: { readonly id: string; readonly folio: number; readonly tipo: TipoPoliza } | null;
  readonly armable: boolean;
  readonly motivo: string | null;
}

export interface ResultadoDesdeRep {
  readonly folioFiscalRep: string;
  readonly registradas: number;
  readonly resultados: readonly { readonly pagoId: string; readonly estado: "registrada" | "ya_existia" | "omitida" | "error"; readonly folio?: number; readonly motivo?: string; readonly advertencias?: readonly string[] }[];
}

export interface VistaPreviaCatalogo {
  readonly confirmado: boolean;
  readonly periodo: string;
  readonly aceptadas: number;
  readonly nuevas: number;
  readonly actualizadas: number;
  readonly sinCodigoAgrupador: number;
  readonly rechazadasTotal: number;
  readonly rechazadas: readonly { readonly numCta: string; readonly motivo: string }[];
  readonly advertencias: readonly string[];
  readonly agregadas?: number;
}

export interface VistaPreviaApertura {
  readonly confirmado: boolean;
  readonly periodo: string;
  readonly tipoEnvio: "N" | "C";
  readonly fecha: string;
  readonly partidas: number;
  readonly totalCentavos: number;
  readonly concepto: string;
  readonly folio?: number;
}

export interface PolizasPeriodoXml {
  readonly periodo: string;
  readonly tipoSolicitud: string;
  readonly polizas: number;
  readonly xml: string;
  readonly sha1: string;
  readonly nota: string;
}

export type TipoSolicitudPolizas = "AF" | "FC" | "DE" | "CO";
export const ETIQUETA_TIPO_SOLICITUD: Readonly<Record<TipoSolicitudPolizas, string>> = {
  AF: "AF · Auditoría",
  FC: "FC · Fiscalización compulsa",
  DE: "DE · Devolución",
  CO: "CO · Compensación",
};

export interface PaqueteContabilidad {
  readonly periodo: string;
  readonly estado: string;
  readonly nota: string;
  readonly catalogo: { readonly xml: string; readonly sha1: string; readonly cuentas: number };
  readonly balanza: { readonly xml: string; readonly sha1: string; readonly cuadrada: boolean; readonly cuentas: number };
  readonly resumen: { readonly cuentas: number; readonly totalDebe: string; readonly totalHaber: string; readonly cuadrada: boolean; readonly saldosAnomalos: readonly string[] };
}

// ---------------------------------------------------------------------------
// Pesos <-> centavos exactos.
// ---------------------------------------------------------------------------

/** "1,234.50" / "1234.5" / "0.05" -> centavos enteros; `null` si no es un monto en pesos con hasta 2 decimales. Nunca redondea en silencio. */
export function pesosACentavos(texto: string): number | null {
  const t = texto.trim();
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return null;
  const [enteros, decimales = ""] = t.replace(/,/g, "").split(".");
  const centavos = Number(enteros) * 100 + Number(decimales.padEnd(2, "0"));
  return Number.isSafeInteger(centavos) && centavos <= 1_000_000_000_000 ? centavos : null;
}

/** Centavos -> "1,234.50" exacto (para mostrar y para volver a editar). */
export function centavosAPesos(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const enteros = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negativo ? "-" : ""}${enteros}.${String(abs % 100).padStart(2, "0")}`;
}

export function dinero(centavos: number | null): string {
  return centavos === null ? "—" : `$${centavosAPesos(centavos)}`;
}

// ---------------------------------------------------------------------------
// Formulario de poliza.
// ---------------------------------------------------------------------------

export interface PartidaFormulario {
  readonly cuenta: string;
  readonly concepto: string;
  readonly debe: string;
  readonly haber: string;
}
export interface PolizaFormulario {
  readonly tipo: TipoPoliza;
  readonly fecha: string;
  readonly concepto: string;
  readonly partidas: readonly PartidaFormulario[];
}

export const PARTIDA_VACIA: PartidaFormulario = { cuenta: "", concepto: "", debe: "", haber: "" };
export const polizaVacia = (fecha: string): PolizaFormulario => ({ tipo: "diario", fecha, concepto: "", partidas: [PARTIDA_VACIA, PARTIDA_VACIA] });

export interface ResumenCuadre {
  readonly debeCentavos: number;
  readonly haberCentavos: number;
  readonly diferenciaCentavos: number;
  readonly cuadra: boolean;
}

export function resumenCuadre(partidas: readonly PartidaFormulario[]): ResumenCuadre {
  let debe = 0;
  let haber = 0;
  for (const p of partidas) {
    debe += pesosACentavos(p.debe) ?? 0;
    haber += pesosACentavos(p.haber) ?? 0;
  }
  return { debeCentavos: debe, haberCentavos: haber, diferenciaCentavos: debe - haber, cuadra: debe === haber && debe > 0 };
}

/** Errores por campo (vacio = se puede enviar). El servidor y la base repiten TODO. */
export function erroresPoliza(f: PolizaFormulario, cuentasValidas: ReadonlySet<string>): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)) e.fecha = "Elige la fecha de la póliza.";
  if (f.concepto.trim() === "") e.concepto = "El concepto es obligatorio.";
  f.partidas.forEach((p, i) => {
    const debe = p.debe.trim() === "" ? 0 : pesosACentavos(p.debe);
    const haber = p.haber.trim() === "" ? 0 : pesosACentavos(p.haber);
    if (p.cuenta === "") e[`partida${i}`] = "Elige la cuenta.";
    else if (!cuentasValidas.has(p.cuenta)) e[`partida${i}`] = "La cuenta no está en el catálogo del cliente.";
    else if (debe === null || haber === null) e[`partida${i}`] = "Importe en pesos con hasta 2 decimales.";
    else if ((debe > 0) === (haber > 0)) e[`partida${i}`] = "Captura debe o haber (uno solo, mayor que cero).";
  });
  if (f.partidas.length < 2) e.partidas = "Una póliza lleva al menos 2 partidas.";
  const r = resumenCuadre(f.partidas);
  if (!e.partidas && !r.cuadra && Object.keys(e).filter((k) => k.startsWith("partida")).length === 0) e.cuadre = `La póliza no cuadra: diferencia de ${dinero(Math.abs(r.diferenciaCentavos))}.`;
  return e;
}

export function cuerpoPoliza(f: PolizaFormulario): Record<string, unknown> {
  return {
    tipo: f.tipo,
    fecha: f.fecha,
    concepto: f.concepto.trim(),
    movimientos: f.partidas.map((p) => ({ cuenta: p.cuenta, concepto: p.concepto.trim(), debe: pesosACentavos(p.debe) ?? 0, haber: pesosACentavos(p.haber) ?? 0 })),
  };
}

export function periodoActual(hoy: string): string {
  return hoy.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Llamadas HTTP.
// ---------------------------------------------------------------------------
const base = (apiBaseUrl: string, propertyId: string): string => `${apiBaseUrl}/despachos/${propertyId}/libro`;

export async function fetchCuentas(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ estado: EstadoLibro; cuentas: readonly CuentaLibro[]; sinCodigoAgrupador?: number }> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/cuentas`, token);
}
export async function sembrarCatalogo(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ agregadas: number }> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/catalogo/sembrar`, token, {});
}
export async function guardarCuenta(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, cuenta: CuentaLibro): Promise<CuentaLibro> {
  // Solo lo editable viaja (nunca `propuestaCodigo`); sin jerarquía ni código el servidor conserva lo que la cuenta ya tenga.
  const cuerpo: Record<string, unknown> = { codigo: cuenta.codigo, descripcion: cuenta.descripcion, naturaleza: cuenta.naturaleza };
  if (cuenta.nivel !== undefined) cuerpo.nivel = cuenta.nivel;
  if (cuenta.cuentaPadre) cuerpo.cuentaPadre = cuenta.cuentaPadre;
  if (cuenta.codigoAgrupador) cuerpo.codigoAgrupador = cuenta.codigoAgrupador;
  return putJson(f, `${base(apiBaseUrl, propertyId)}/cuentas`, token, cuerpo);
}
export async function fetchPolizas(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string): Promise<{ estado: EstadoLibro; polizas: readonly PolizaResumen[] }> {
  const [ejercicio, mes] = periodo.split("-");
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/polizas?ejercicio=${ejercicio}&mes=${Number(mes)}&limit=200`, token);
}
export async function fetchPoliza(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, polizaId: string): Promise<PolizaDetalle> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/polizas/${polizaId}`, token);
}
export async function registrarPoliza(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, form: PolizaFormulario): Promise<{ polizaId: string; folio: number }> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/polizas`, token, cuerpoPoliza(form));
}
export interface OpcionesPolizaCfdi {
  /** Cuenta de gasto elegida por el staff (p. ej. rentas para un arrendamiento); solo CFDI recibidos. */
  readonly cuentaGasto?: string;
  readonly tratamientoIeps?: "costo" | "acreditable";
}
export async function polizaDesdeCfdi(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, invoiceId: string, opciones: OpcionesPolizaCfdi = {}): Promise<{ polizaId: string; folio: number }> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/polizas/desde-cfdi`, token, { invoiceId, ...opciones });
}
export async function reversarPoliza(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, polizaId: string, fecha: string, concepto: string): Promise<{ polizaId: string; folio: number }> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/polizas/${polizaId}/reversar`, token, { fecha, concepto });
}
export async function fetchBalanza(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string): Promise<BalanzaRespuesta> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/balanza?periodo=${encodeURIComponent(periodo)}`, token);
}
export async function fetchCfdiLibro(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string): Promise<{ periodo: string; truncado: boolean; cfdi: readonly CfdiLibro[] }> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/cfdi?periodo=${encodeURIComponent(periodo)}`, token);
}
export interface OpcionesPaquete {
  readonly tipoEnvio?: "N" | "C";
  /** AAAA-MM-DD; solo con tipoEnvio C. */
  readonly fechaModBal?: string;
}
export async function fetchPaquete(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string, opciones: OpcionesPaquete = {}): Promise<PaqueteContabilidad> {
  // D-30: misma exportacion fiscal que el paquete de contabilidad electronica -> segundo factor reciente (lib/step-up.ts).
  const q = new URLSearchParams({ periodo });
  if (opciones.tipoEnvio) q.set("tipoEnvio", opciones.tipoEnvio);
  if (opciones.fechaModBal) q.set("fechaModBal", opciones.fechaModBal);
  return conStepUp({ fetchImpl: f, apiBaseUrl, token }, (h) => fetchJson<PaqueteContabilidad>(f, `${base(apiBaseUrl, propertyId)}/contabilidad-electronica?${q.toString()}`, token, despachosAuthContext(), h));
}
export interface SolicitudPolizasXml {
  readonly tipoSolicitud: TipoSolicitudPolizas;
  readonly numOrden?: string;
  readonly numTramite?: string;
}
export async function fetchPolizasXml(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string, s: SolicitudPolizasXml): Promise<PolizasPeriodoXml> {
  const q = new URLSearchParams({ periodo, tipoSolicitud: s.tipoSolicitud });
  if (s.numOrden) q.set("numOrden", s.numOrden);
  if (s.numTramite) q.set("numTramite", s.numTramite);
  return conStepUp({ fetchImpl: f, apiBaseUrl, token }, (h) => fetchJson<PolizasPeriodoXml>(f, `${base(apiBaseUrl, propertyId)}/contabilidad-electronica/polizas?${q.toString()}`, token, despachosAuthContext(), h));
}

// ---- Código agrupador, importación del proveedor anterior y REP (D-P3-16/17/44) ----------------------------------------------------------------------
export async function asignarAgrupadores(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, asignaciones: readonly { codigo: string; codigoAgrupador: string }[]): Promise<{ actualizadas: number }> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/catalogo/agrupadores`, token, { asignaciones });
}
export async function proponerAgrupadores(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ aplicadas: number; sinPropuesta: number; nota: string }> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/catalogo/agrupadores/proponer`, token, {});
}
/** Vista previa (sin confirmar) o importación (confirmar: true, con segundo factor) del catálogo XML del proveedor anterior. */
export async function importarCatalogoXml(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, xml: string, confirmar: boolean): Promise<VistaPreviaCatalogo> {
  const url = `${base(apiBaseUrl, propertyId)}/catalogo/importar`;
  if (!confirmar) return postJson(f, url, token, { xml });
  return conStepUp({ fetchImpl: f, apiBaseUrl, token }, (h) => postJson<VistaPreviaCatalogo>(f, url, token, { xml, confirmar: true }, h));
}
/** Vista previa o registro (confirmar: true, con segundo factor) de la póliza de apertura desde la balanza XML del proveedor anterior. */
export async function importarAperturaXml(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, xml: string, confirmar: boolean): Promise<VistaPreviaApertura> {
  const url = `${base(apiBaseUrl, propertyId)}/apertura/importar`;
  if (!confirmar) return postJson(f, url, token, { xml });
  return conStepUp({ fetchImpl: f, apiBaseUrl, token }, (h) => postJson<VistaPreviaApertura>(f, url, token, { xml, confirmar: true }, h));
}
export async function fetchPagosRep(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string): Promise<{ estado: EstadoLibro; pagos: readonly PagoRepLibro[] }> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/pagos-rep?periodo=${encodeURIComponent(periodo)}`, token);
}
export async function polizasDesdeRep(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioFiscalRep: string, pagoId?: string): Promise<ResultadoDesdeRep> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/polizas/desde-rep`, token, pagoId ? { folioFiscalRep, pagoId } : { folioFiscalRep });
}
