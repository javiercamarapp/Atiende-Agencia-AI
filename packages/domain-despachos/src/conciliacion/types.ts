// Tipos de conciliación bancaria — puerto de
// `b2b_ai/features/reconciliation_agent/models.py`. Los nombres de campo en español
// (fecha, monto, descripcion...) replican exactamente los del origen porque son las
// llaves que el motor de matching compara; los nombres de tipo usan la convención ya
// establecida en `nomina/`/`declaraciones/` (Spanish-first para conceptos nuevos).

/** Nivel del algoritmo de matching que produjo una coincidencia — `MatchLevel` en el
 * origen. "llm" se mantiene en el vocabulario por paridad de tipos aunque esta fase
 * no lo implementa (ver `matching-engine.ts`, nivel 4 documentado como no portado). */
export type NivelCoincidencia = "exacto" | "fuzzy" | "multi_linea" | "llm" | "manual";

export type SeveridadAlerta = "info" | "warning" | "critical";

/** Un movimiento bancario ya parseado, sin importar el formato/banco de origen —
 * `BankMovement` en el origen. `monto` es el importe con signo (abono positivo, cargo
 * negativo), igual que la property `monto` de pydantic en el origen (no un campo
 * calculado en TS: el parser lo calcula igual que el origen, ver `parsers.ts`). */
export interface MovimientoBancario {
  readonly fecha: string; // YYYY-MM-DD
  readonly descripcion: string;
  readonly referencia: string | null;
  readonly cargo: number | null;
  readonly abono: number | null;
  readonly saldo: number | null;
  readonly monto: number;
  readonly banco: string;
  readonly formato: string;
}

/** Registro contable candidato a conciliar contra un movimiento bancario — origen
 * usa `Dict[str, Any]` con acceso flexible (`rec.get("monto", rec.get("total"))`,
 * `rec.get("descripcion", rec.get("concepto", rec.get("referencia", ""))`). Aquí se
 * tipa expresamente esa flexibilidad en vez de `any` para que el caller (rutas HTTP)
 * declare qué campos de un `InvoiceRecord`/póliza mapea a cada llave. */
export interface RegistroConciliable {
  readonly id: string;
  readonly fecha: string;
  readonly monto?: number | string | null;
  readonly total?: number | string | null;
  readonly descripcion?: string | null;
  readonly concepto?: string | null;
  readonly referencia?: string | null;
  readonly folioFiscal?: string | null;
}

export interface CoincidenciaConciliacion {
  readonly movementIdx: number;
  readonly registroIdx: number | null;
  readonly registroIndices: readonly number[] | null;
  readonly level: NivelCoincidencia;
  readonly score: number; // 0-100
  readonly detail: string;
  readonly montoBanco: number;
  readonly montoRegistro: number;
  readonly fechaBanco: string;
  readonly fechaRegistro: string;
}

export interface ResultadoConciliacion {
  readonly matched: readonly CoincidenciaConciliacion[];
  readonly unmatchedBank: readonly MovimientoBancario[];
  readonly unmatchedBooks: readonly RegistroConciliable[];
  readonly confidence: number;
  readonly totalMovements: number;
  readonly totalRecords: number;
  readonly totalMatched: number;
  readonly matchRate: number;
  readonly montoMatched: number;
  readonly montoUnmatchedBank: number;
  readonly montoUnmatchedBooks: number;
  readonly processingTimeMs: number;
}

/** Parámetros del motor — `MatchingEngine.__init__` / `UploadRequest` en el origen.
 * Los defaults son EXACTOS a los del origen (`date_tolerance_days=3`,
 * `monto_tolerance_pct=5.0`, `fuzzy_threshold=80`). El nivel 4 (LLM) del origen no se
 * porta en esta fase (ver `matching-engine.ts`, cabecera). */
export interface OpcionesMatchingEngine {
  readonly dateToleranceDays?: number; // default 3
  readonly montoTolerancePct?: number; // default 5.0
  readonly fuzzyThreshold?: number; // default 80
}

/** `AgingAlert` en el origen. */
export interface AlertaAntiguedad {
  readonly itemType: "bank" | "book";
  readonly fecha: string;
  readonly monto: number;
  readonly descripcion: string;
  readonly daysUnreconciled: number;
  readonly severity: SeveridadAlerta;
  readonly message: string;
  readonly rule: string;
}
