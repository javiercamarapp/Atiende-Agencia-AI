// Tipos del auto-clasificador de pólizas — puerto de
// `b2b_ai/features/bookkeeping/models.py` (Fase 6).
export type TipoCfdiBookkeeping = "I" | "E" | "T" | "P" | "N";

export type PolizaType = "ingreso" | "egreso" | "diario";

export type LineaTipo = "cargo" | "abono";

export interface CfdiClassification {
  readonly cfdiUuid: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly descripcion: string;
  readonly subtotal: number;
  readonly iva: number;
  readonly total: number;
  readonly tasaIva: number;
  readonly tipoCfdi: TipoCfdiBookkeeping;
  readonly categoria: string;
  readonly confidence: number;
  readonly needsHumanReview: boolean;
}

export interface LineaPoliza {
  readonly cuenta: string;
  readonly concepto: string;
  readonly debe: number;
  readonly haber: number;
  readonly tipo: LineaTipo;
}

export interface PolizaContable {
  readonly tipo: PolizaType;
  readonly fecha: string;
  readonly concepto: string;
  readonly referencia: string;
  readonly lineas: readonly LineaPoliza[];
  readonly totalDebe: number;
  readonly totalHaber: number;
  readonly cuadrada: boolean;
  readonly tenantId: string;
}

export interface AccountMapping {
  readonly cargo: string;
  readonly abono: string;
  readonly ivaCargo: string | null;
  readonly ivaAbono: string | null;
  readonly polizaType: PolizaType;
}

export interface OverrideRecord {
  readonly cfdiUuid: string;
  readonly rfcEmisor: string;
  readonly newCategoria: string;
  readonly tenantId: string;
}

export interface SuggestionRetraining {
  readonly rfc: string;
  readonly suggestedCategoria: string;
  readonly overrideCount: number;
  readonly totalCorrections: number;
  readonly confidence: number;
}
