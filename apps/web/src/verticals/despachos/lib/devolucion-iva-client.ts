// Cliente de devolución de IVA (hallazgo de auditoría severidad ALTA, "Siete
// módulos con ruta HTTP real y sin UI" -- penúltima porción, tras
// vencimientos/declaraciones/nómina/conciliación/migración de catálogo):
// devolucion-iva.ts expone GET /facturas/:periodo y 7 POST (diot, conciliacion,
// saldo-favor, congruencia, solicitud, plazo-resolucion, papel-trabajo) sobre el
// motor completo de @atiende/domain-despachos/devolucion-iva/ -- ningún cliente
// web ni página los usaba. Mismo criterio que el resto de lib/*.ts de este panel:
// separado de pages/DevolucionIva.tsx para poder probarlo con vitest en entorno
// "node" sin DOM.
//
// Los tipos de abajo son un espejo deliberado de
// @atiende/domain-despachos/devolucion-iva/{types.ts,calculo.ts,workpaper.ts}
// (mismo criterio que conciliacion-client.ts/vencimientos-client.ts: este paquete
// web no depende en tiempo de build del paquete de dominio, solo lo referencia en
// comentarios) -- la ruta HTTP serializa exactamente estas formas vía
// `c.json(resultado)`. NO se persiste ninguna "solicitud de devolución" en esta
// fase (ver cabecera de devolucion-iva.ts en apps/api): el resultado de
// `postSolicitudDevolucionIva` es responsabilidad de este cliente/página
// mostrarlo, no hay un GET para recuperarlo después.
import { fetchJson, postJson } from "./admin-client.ts";

export type TipoFacturaIva = "Ingreso" | "Egreso" | "Traslado" | "Nómina" | "Pago";
export type ClasificacionIva = "acreditable_100" | "acreditable_proporcional" | "no_acreditable";
export type EstatusConciliacionIva = "match" | "mismatch" | "missing";
export type EstatusDevolucion = "pendiente" | "en_revision" | "aprobada" | "rechazada" | "pagada";
export type EstadoEnvioSolicitud = "lista_para_envio" | "requiere_aclaracion";

/** Espejo de `FacturaCfdiIva` (domain-despachos/devolucion-iva/types.ts).
 * Usada tanto para lo que devuelve GET /facturas/:periodo como para lo que este
 * cliente reenvía en los POST siguientes (facturas ya vistas se reciclan tal
 * cual entre pasos, mismo patrón que diotEntries/declaraciones de abajo). Solo
 * `uuid`/`rfcEmisor`/`rfcReceptor`/`fecha` son obligatorios en el servidor
 * (ver `parseFactura` en devolucion-iva.ts) -- el resto cae a defaults ahí. */
export interface FacturaCfdiIva {
  readonly uuid: string;
  readonly rfcEmisor: string;
  readonly nombreEmisor?: string;
  readonly rfcReceptor: string;
  /** YYYY-MM-DD. */
  readonly fecha: string;
  readonly subtotal?: number;
  readonly iva?: number;
  readonly total?: number;
  readonly tipo?: TipoFacturaIva;
  readonly categoria?: ClasificacionIva;
  readonly bancoPago?: string | null;
  readonly fechaPago?: string | null;
  /** 0.0-1.0 -- proporción de acreditamiento para gastos de uso mixto. */
  readonly proporcionalidad?: number;
  readonly folioFactura?: string | null;
  readonly formaPago?: string | null;
  readonly metodoPago?: string | null;
  /** LIVA Art. 5 fracc. III: sin este UUID de REP, el IVA "efectivamente
   * pagado" de la factura es 0 sin importar `proporcionalidad`. */
  readonly referenciaComplementoPago?: string | null;
  readonly concepto?: string | null;
}

export interface ClasificacionIvaResultado {
  readonly acreditable_100: readonly FacturaCfdiIva[];
  readonly acreditable_proporcional: readonly FacturaCfdiIva[];
  readonly no_acreditable: readonly FacturaCfdiIva[];
}

export interface DiotFacturaDetalleIva {
  readonly folioFiscal: string;
  readonly folioFactura: string | null;
  readonly concepto: string | null;
  readonly fechaPago: string | null;
  readonly bancoPago: string | null;
}

export interface DiotEntryIva {
  readonly rfcTercero: string;
  readonly nombre: string;
  readonly tipoOperacion: string;
  readonly montoNeto: number;
  readonly ivaTrasladado: number;
  readonly ivaAcreditable: number;
  readonly foliosFiscales: readonly string[];
  readonly facturasDetalle: readonly DiotFacturaDetalleIva[];
}

export interface DeclaracionMensualIva {
  readonly mes: number;
  readonly año: number;
  readonly ivaCobrado: number;
  readonly ivaPagado: number;
  readonly saldoFavor: number;
  readonly saldoContra: number;
}

export interface ConciliacionFacturaDiot {
  readonly facturaUuid: string;
  readonly diotMatch: boolean;
  readonly status: EstatusConciliacionIva;
  readonly detalles: string;
}

export interface ConciliacionDiotDeclaracion {
  readonly diotIvaTotal: number;
  readonly declaracionIvaAcreditable: number;
  readonly diferencia: number;
  readonly status: EstatusConciliacionIva;
}

export interface ConciliacionDeclaracionSaldo {
  readonly totalSaldoFavorDeclared: number;
  readonly totalSaldoContraDeclared: number;
  readonly saldoNetoDeclaraciones: number;
  readonly saldoAFavorSolicitado: number;
  readonly diferencia: number;
  readonly consistente: boolean;
}

export interface MontoDevolucion {
  readonly saldoFavorOriginal: number;
  readonly totalSaldoFavorDeclaraciones: number;
  readonly factorActualizacion: number;
  readonly montoActualizado: number;
  readonly montoDevolucionSugerido: number;
  readonly periodoMasAntiguo: string | null;
  readonly prescripcionVerificada: boolean;
}

export interface CongruenciaDiotCfdiDeclaracion {
  readonly periodo: string;
  readonly diotExiste: boolean;
  readonly declaracionExiste: boolean;
  readonly totalCfdiIvaAcreditable: number;
  readonly totalDiotIvaAcreditable: number;
  readonly totalDeclaracionIvaPagado: number;
  readonly diferenciaCfdiDiot: number;
  readonly diferenciaDiotDeclaracion: number;
  readonly diferenciaMaxima: number;
  readonly tolerancia: number;
  readonly congruente: boolean;
}

export interface SolicitudDevolucion {
  readonly solicitudId: string;
  readonly periodo: string;
  readonly montoSolicitado: number;
  readonly tenantId: string | null;
  readonly cuentaBanco: string | null;
  readonly clabe: string | null;
  readonly documentos: readonly string[];
  readonly status: EstatusDevolucion;
  readonly estado: EstadoEnvioSolicitud;
  readonly motivoAclaracion: string | null;
  readonly createdAt: string;
}

// --- Papel de trabajo (espejo de devolucion-iva/workpaper.ts) --------------

export interface ResumenFacturasPeriodo {
  readonly totalFacturas: number;
  readonly acreditable100Count: number;
  readonly acreditableProporcionalCount: number;
  readonly noAcreditableCount: number;
  readonly totalSubtotal: number;
  readonly totalIvaTrasladado: number;
  readonly totalGravado: number;
}

export interface ResumenDiotPeriodo {
  readonly totalEntradas: number;
  readonly totalIvaTrasladado: number;
  readonly totalIvaAcreditable: number;
}

export interface ResumenDeclaracionesPeriodo {
  readonly totalDeclaraciones: number;
  readonly totalIvaCobrado: number;
  readonly totalIvaPagado: number;
  readonly totalSaldoFavor: number;
  readonly totalSaldoContra: number;
}

export interface Seccion1ResumenPeriodo {
  readonly periodo: string;
  readonly resumenFacturas: ResumenFacturasPeriodo;
  readonly resumenDiot: ResumenDiotPeriodo;
  readonly resumenDeclaraciones: ResumenDeclaracionesPeriodo;
}

export interface ProveedorDiotSeccion {
  readonly rfc: string;
  readonly nombre: string;
  readonly tipoOperacion: string;
  readonly montoNeto: number;
  readonly ivaTrasladado: number;
  readonly ivaAcreditable: number;
  readonly numFacturas: number;
  readonly foliosFiscales: readonly string[];
  readonly facturasDetalle: readonly DiotFacturaDetalleIva[];
}

export interface Seccion2DiotPorProveedor {
  readonly proveedores: readonly ProveedorDiotSeccion[];
  readonly totalProveedores: number;
  readonly totalMontoNeto: number;
  readonly totalIvaTrasladado: number;
  readonly totalIvaAcreditable: number;
}

export interface DetalleConciliacionCfdiDiot {
  readonly facturaUuid: string;
  readonly detalles: string;
}

export interface Seccion3ConciliacionCfdiDiot {
  readonly totalFacturas: number;
  readonly matches: number;
  readonly mismatches: number;
  readonly missing: number;
  readonly tasaConciliacion: number;
  readonly detalleMismatches: readonly DetalleConciliacionCfdiDiot[];
  readonly detalleMissing: readonly DetalleConciliacionCfdiDiot[];
}

export interface Seccion4ConciliacionDiotDeclaracion {
  readonly totalDeclaraciones: number;
  readonly matches: number;
  readonly mismatches: number;
  readonly tasaConciliacion: number;
  readonly detalle: readonly ConciliacionDiotDeclaracion[];
}

export interface Seccion5CalculoSaldo {
  readonly saldoAFavor: number;
  readonly montoDevolucion: MontoDevolucion;
  readonly verificacion: ConciliacionDeclaracionSaldo;
}

export interface Seccion6DocumentosSoporte {
  readonly documentos: readonly string[];
  readonly totalDocumentos: number;
  readonly checklist: {
    readonly cfdiCompra: boolean;
    readonly diot: boolean;
    readonly declaraciones: boolean;
    readonly estadosCuenta: boolean;
    readonly balanza: boolean;
  };
}

export interface Seccion7NoDiscrepanciaDepositos {
  readonly disponible: boolean;
  readonly mensaje: string | null;
  readonly totalDepositosClasificados: number;
  readonly clasificacionesDepositos: readonly unknown[];
  readonly resumenPorClasificacion: Record<string, number>;
  readonly requiereRevisionHumana: boolean;
  readonly advertenciaFiscal: string;
}

export interface PapelTrabajoDevolucionIva {
  readonly periodo: string;
  readonly tenantId: string | null;
  readonly secciones: {
    readonly "1_resumen_periodo": Seccion1ResumenPeriodo;
    readonly "2_diot_por_proveedor": Seccion2DiotPorProveedor;
    readonly "3_conciliacion_cfdi_diot": Seccion3ConciliacionCfdiDiot;
    readonly "4_conciliacion_diot_declaracion": Seccion4ConciliacionDiotDeclaracion;
    readonly "5_calculo_saldo": Seccion5CalculoSaldo;
    readonly "6_documentos_soporte": Seccion6DocumentosSoporte;
    readonly "7_no_discrepancia_fiscal_depositos": Seccion7NoDiscrepanciaDepositos;
  };
  readonly metadata: {
    readonly generadoPor: string;
    readonly version: string;
    readonly totalFacturas: number;
    readonly totalDiotEntries: number;
    readonly totalDeclaraciones: number;
  };
}

// ---------------------------------------------------------------------------
// Llamadas HTTP -- una por endpoint, mismo orden que declara devolucion-iva.ts.
// ---------------------------------------------------------------------------

/** GET .../devolucion-iva/facturas/:periodo -- facturas ya ingeridas (CFDI de
 * esta property) para el periodo YYYY-MM, ya clasificadas. */
export async function fetchFacturasPeriodoDevolucionIva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  periodo: string,
): Promise<{ readonly facturas: readonly FacturaCfdiIva[]; readonly clasificacion: ClasificacionIvaResultado }> {
  return fetchJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/devolucion-iva/facturas/${periodo}`, token);
}

/** POST .../devolucion-iva/diot -- agrupa las facturas por RFC emisor
 * (tipo de operación "03") y valida el resultado. */
export async function postDiotDevolucionIva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  facturas: readonly FacturaCfdiIva[],
  periodo?: string,
): Promise<{ readonly diotEntries: readonly DiotEntryIva[]; readonly errores: readonly string[] }> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/devolucion-iva/diot`, token, periodo ? { facturas, periodo } : { facturas });
}

/** POST .../devolucion-iva/conciliacion -- facturas vs DIOT y DIOT vs
 * declaración, sobre el mismo lote ya visto en los pasos anteriores. */
export async function postConciliacionDevolucionIva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  facturas: readonly FacturaCfdiIva[],
  diotEntries: readonly DiotEntryIva[],
  declaraciones: readonly DeclaracionMensualIva[],
): Promise<{ readonly facturasVsDiot: readonly ConciliacionFacturaDiot[]; readonly diotVsDeclaracion: readonly ConciliacionDiotDeclaracion[] }> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/devolucion-iva/conciliacion`, token, { facturas, diotEntries, declaraciones });
}

/** POST .../devolucion-iva/saldo-favor -- saldo a favor + monto de
 * devolución sugerido a partir de las declaraciones ya presentadas. */
export async function postSaldoFavorDevolucionIva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  declaraciones: readonly DeclaracionMensualIva[],
): Promise<{ readonly saldoFavor: number; readonly montoDevolucion: MontoDevolucion; readonly verificacion: ConciliacionDeclaracionSaldo }> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/devolucion-iva/saldo-favor`, token, { declaraciones });
}

/** POST .../devolucion-iva/congruencia -- REQ-IVA-010: congruencia
 * DIOT<->CFDI<->declaración, exigida antes de dejar una solicitud > $10,001
 * MXN lista para envío. */
export async function postCongruenciaDevolucionIva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  periodo: string,
  facturas: readonly FacturaCfdiIva[],
  diotEntries: readonly DiotEntryIva[],
  declaraciones: readonly DeclaracionMensualIva[],
  tolerancia?: number,
): Promise<CongruenciaDiotCfdiDeclaracion> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/devolucion-iva/congruencia`, token, {
    periodo,
    facturas,
    diotEntries,
    declaraciones,
    ...(tolerancia !== undefined ? { tolerancia } : {}),
  });
}

export interface SaldoDevolucionInput {
  readonly montoDevolucionSugerido?: number;
  readonly saldoFavorOriginal?: number;
}

export interface SolicitudDevolucionOpciones {
  readonly cuentaBanco?: string | null;
  readonly clabe?: string | null;
  readonly documentos?: readonly string[];
  readonly tenantId?: string | null;
  readonly facturas?: readonly FacturaCfdiIva[];
  readonly diotEntries?: readonly DiotEntryIva[];
  readonly declaraciones?: readonly DeclaracionMensualIva[];
}

/** POST .../devolucion-iva/solicitud -- arma la solicitud de devolución
 * (nunca se persiste server-side en esta fase: el resultado es
 * responsabilidad del cliente mostrarlo/guardarlo). El servidor rechaza con
 * 400 si el monto es <= 0 o la CLABE es inválida (`DespachosAdminError`,
 * mismo criterio que el resto de este panel). */
export async function postSolicitudDevolucionIva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  periodo: string,
  saldo: SaldoDevolucionInput,
  opciones: SolicitudDevolucionOpciones = {},
): Promise<SolicitudDevolucion> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/devolucion-iva/solicitud`, token, { periodo, saldo, ...opciones });
}

/** POST .../devolucion-iva/plazo-resolucion -- Art. 22 CFF: 40 días hábiles
 * (20 si hay dictamen de contador público registrado o garantía). */
export async function postPlazoResolucionDevolucionIva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  fechaPresentacion: string,
  hayDictamenOGarantia?: boolean,
): Promise<{ readonly fechaPresentacion: string; readonly fechaLimite: string }> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/devolucion-iva/plazo-resolucion`, token, {
    fechaPresentacion,
    ...(hayDictamenOGarantia !== undefined ? { hayDictamenOGarantia } : {}),
  });
}

export interface PapelTrabajoOpciones {
  readonly tenantId?: string | null;
  readonly documentosSoporte?: readonly string[];
}

/** POST .../devolucion-iva/papel-trabajo -- ensambla las 7 secciones del
 * papel de trabajo final. Si no se manda `diotEntries`, el servidor las
 * regenera desde `facturas`+`periodo` (mismo `generarDiotDevolucionIva` del
 * paso 2) -- este cliente siempre las manda explícitas cuando ya se
 * calcularon en un paso previo, para no recalcular dos veces con datos que
 * pudieron divergir. */
export async function postPapelTrabajoDevolucionIva(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  periodo: string,
  facturas: readonly FacturaCfdiIva[],
  diotEntries: readonly DiotEntryIva[] | undefined,
  declaraciones: readonly DeclaracionMensualIva[],
  opciones: PapelTrabajoOpciones = {},
): Promise<PapelTrabajoDevolucionIva> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/devolucion-iva/papel-trabajo`, token, {
    periodo,
    facturas,
    ...(diotEntries !== undefined ? { diotEntries } : {}),
    declaraciones,
    ...opciones,
  });
}
