// Tipos de conciliación bancaria — puerto de
// `b2b_ai/features/reconciliation_agent/models.py`. Los nombres de campo en español
// (fecha, monto, descripcion...) replican exactamente los del origen porque son las
// llaves que el motor de matching compara; los nombres de tipo usan la convención ya
// establecida en `nomina/`/`declaraciones/` (Spanish-first para conceptos nuevos).

/** Nivel del algoritmo de matching que produjo una coincidencia — `MatchLevel` en el
 * origen. "llm" es el nivel 4 (asistido por IA con aprobación humana obligatoria, ver
 * `llm-matching-agent.ts`) — a diferencia de niveles 1-3 (`matching-engine.ts`, 100%
 * deterministas), un `CoincidenciaConciliacion` con `level: "llm"` SOLO puede
 * construirse vía `aprobarSugerenciaLLM()`, nunca directamente desde la respuesta del
 * modelo. */
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
  /** D-P3-11: sentido del CFDI respecto del cliente. Un abono (cobro) solo concilia contra un CFDI `emitido` y un cargo (pago) contra uno
   * `recibido`; `indeterminado` se propone pero solo con revisión humana. Ausente/`null` = dato desconocido en un llamador heredado
   * (sin filtro por dirección, igual que antes). */
  readonly direccion?: "emitido" | "recibido" | "indeterminado" | null;
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
  /** D-P3-11: el CFDI tiene dirección `indeterminado`: la propuesta nunca se confirma ni autoconfirma sin revisión humana. */
  readonly requiereRevision?: boolean;
}

/** D-P3-10: 2 o más combinaciones de CFDI suman el movimiento. Nunca se confirma con un clic sin elegir una. */
export interface AmbiguoMultilinea {
  readonly movementIdx: number;
  /** Cada combinación = índices de `records`, ordenados. */
  readonly combinaciones: readonly (readonly number[])[];
  /** Había más combinaciones que `maxCombinaciones`: se listan las primeras. */
  readonly truncado: boolean;
  /** Las combinaciones son sumas exactas (dentro de la tolerancia en centavos) y no solo cercanas. */
  readonly exactas: boolean;
  readonly montoBanco: number;
}

export type MotivoSinConciliar = "sin_candidato" | "pocos_candidatos" | "sin_combinacion" | "demasiados_candidatos" | "presupuesto_agotado" | "ambiguo";

/** D-P3-10: movimiento que el motor no pudo conciliar, con el motivo y los registros individuales más cercanos (para la UI). */
export interface SinConciliarMovimiento {
  readonly movementIdx: number;
  readonly motivo: MotivoSinConciliar;
  readonly cercanos: readonly { readonly registroIdx: number; readonly diferenciaCentavos: number }[];
}

export interface ResultadoConciliacion {
  readonly matched: readonly CoincidenciaConciliacion[];
  readonly unmatchedBank: readonly MovimientoBancario[];
  readonly unmatchedBooks: readonly RegistroConciliable[];
  /** Movimientos con 2+ combinaciones N-a-1: no se concilian (siguen en `unmatchedBank`) hasta que una persona elija una. */
  readonly ambiguos: readonly AmbiguoMultilinea[];
  /** Motivo y registros más cercanos de cada movimiento que quedó sin conciliar (mismos movimientos que `unmatchedBank`). */
  readonly sinConciliar: readonly SinConciliarMovimiento[];
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
 * `monto_tolerance_pct=5.0`, `fuzzy_threshold=80`). Cubre SOLO niveles 1-3
 * (deterministas, `conciliarMovimientos`) — el nivel 4 (LLM, `sugerirMatchesLLM` en
 * `llm-matching-agent.ts`) es una capacidad aparte con su propio adaptador y opciones
 * (`SugerirMatchesLLMOptions`), invocada explícitamente sobre `unmatchedBank`/
 * `unmatchedBooks` del resultado de este motor — nunca mezclada en
 * `OpcionesMatchingEngine` ni en el motor determinístico mismo (ver cabecera de
 * `matching-engine.ts` y de `llm-matching-agent.ts`). */
export interface OpcionesMatchingEngine {
  readonly dateToleranceDays?: number; // default 3
  readonly montoTolerancePct?: number; // default 5.0
  readonly fuzzyThreshold?: number; // default 80
  /** Nivel 3 (N-a-1). */
  readonly subsetSum?: OpcionesSubsetSumMotor;
}

/** Parámetros del nivel 3 (D-P3-10). Todo es configurable; los defaults son los del origen (`bank_reconciliation.py`). */
export interface OpcionesSubsetSumMotor {
  /** Banda EXACTA en centavos (default 0). Las combinaciones dentro de ella tienen prioridad sobre las que solo caben en la tolerancia del 1 %. */
  readonly toleranciaCentavos?: number; // default 0
  /** Tolerancia porcentual de respaldo (default 1.0 = la del motor anterior). */
  readonly toleranciaPct?: number;
  /** Techo de candidatos por movimiento tras filtrar (default 60). Con más, el movimiento se abstiene con motivo `demasiados_candidatos`. */
  readonly maxCandidatos?: number;
  readonly minTamano?: number; // default 2
  readonly maxTamano?: number; // default 15
  /** Presupuesto de nodos por búsqueda (default 2 000 000). Agotado: `presupuesto_agotado`, nunca una combinación parcial. */
  readonly maxNodos?: number;
  /** Tope de combinaciones que se listan en una ambigüedad (default 200). */
  readonly maxCombinaciones?: number;
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
