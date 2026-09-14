// Tipos del papel de trabajo de devolución de IVA — puerto de
// `b2b_ai/features/devolucion_iva/models.py` (pydantic v2). Fase 6.
//
// Alcance deliberado (ver informe de auditoría de esta fase): se porta el
// FLUJO NUMÉRICO completo (recopilar → clasificar → DIOT → conciliar →
// saldo a favor → congruencia → solicitud → plazo de resolución), que es lo
// que sustenta el papel de trabajo real. NO se portan las validaciones de
// catálogo SAT de `forma_pago`/`metodo_pago` (c_FormaPago/c_MetodoPago,
// Anexo 20) del modelo `FacturaCFDI` original — son validaciones de forma
// sobre el anexo 7/7-A de exportación FED, no números del papel de trabajo,
// y requerirían portar un catálogo SAT completo fuera del alcance de esta
// fase; se documentan como campos opcionales sin validar aquí.
export type TipoFacturaIva = "Ingreso" | "Egreso" | "Traslado" | "Nómina" | "Pago";

export type ClasificacionIva = "acreditable_100" | "acreditable_proporcional" | "no_acreditable";

export type EstatusConciliacionIva = "match" | "mismatch" | "missing";

export type EstatusDevolucion = "pendiente" | "en_revision" | "aprobada" | "rechazada" | "pagada";

export type EstadoEnvioSolicitud = "lista_para_envio" | "requiere_aclaracion";

export interface FacturaCfdiIva {
  readonly uuid: string;
  readonly rfcEmisor: string;
  readonly nombreEmisor: string;
  readonly rfcReceptor: string;
  /** YYYY-MM-DD. */
  readonly fecha: string;
  readonly subtotal: number;
  readonly iva: number;
  readonly total: number;
  readonly tipo: TipoFacturaIva;
  readonly categoria: ClasificacionIva;
  readonly bancoPago?: string | null;
  readonly fechaPago?: string | null;
  /** 0.0–1.0. Proporción de acreditamiento para gastos de uso mixto
   * (actividades gravadas/exentas) — el Python original NO calcula esta
   * proporción con una fórmula automática de prorrateo (ratio de
   * actividades gravadas/totales de 12 meses); asume que el llamador ya la
   * asignó por factura. Documentado como hallazgo de la auditoría: si se
   * requiere el cálculo automático del prorrateo real, es una fase futura. */
  readonly proporcionalidad: number;
  readonly folioFactura?: string | null;
  readonly formaPago?: string | null;
  readonly metodoPago?: string | null;
  readonly referenciaComplementoPago?: string | null;
  readonly concepto?: string | null;
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
