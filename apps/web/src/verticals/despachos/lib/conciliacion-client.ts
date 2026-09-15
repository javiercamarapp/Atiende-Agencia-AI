// Cliente de conciliación bancaria (hallazgo de auditoría severidad ALTA, "Siete
// módulos con ruta HTTP real y sin UI" -- porción "conciliación bancaria" tras
// vencimientos/declaraciones/nómina): conciliacion.ts expone POST /matching, POST
// /alertas, POST /clasificar-deposito y POST /verificar-spei sobre el motor
// determinista de niveles 1-3 (@atiende/domain-despachos/conciliacion/
// matching-engine.ts), el motor de alertas (aging/comisiones/duplicados/
// discrepancia de ingresos, .../conciliacion/alerts.ts), la clasificación de
// depósitos (CFF Art. 59 fr. III, .../conciliacion/classification.ts) y el
// matching SPEI/proveedor (.../conciliacion/spei-matching.ts) -- pero ningún
// cliente web ni página los usaba. Mismo criterio que el resto de lib/*.ts de este
// panel: separado de pages/Conciliacion.tsx para poder probarlo con vitest en
// entorno "node" sin DOM.
//
// Los tipos de abajo son un espejo deliberado de
// @atiende/domain-despachos/conciliacion/types.ts (mismo criterio que
// vencimientos-client.ts/declaraciones-client.ts: este paquete web no depende en
// tiempo de build del paquete de dominio, solo lo referencia en comentarios) -- la
// ruta HTTP serializa exactamente estas formas vía `c.json(resultado)`.
import { postJson } from "./admin-client.ts";

export type NivelCoincidencia = "exacto" | "fuzzy" | "multi_linea" | "llm" | "manual";
export type SeveridadAlerta = "info" | "warning" | "critical";

/** Movimiento bancario tal como lo devuelve el servidor (p.ej. dentro de
 * `unmatchedBank`) -- todos los campos opcionales del origen ya resueltos. */
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

/** Forma que este cliente MANDA al servidor -- espejo de `MovimientoBody` en
 * conciliacion.ts. Solo `fecha` es obligatorio; `monto` se deriva de
 * `abono - cargo` en el servidor si no viene explícito. */
export interface MovimientoBancarioInput {
  readonly fecha: string;
  readonly descripcion?: string;
  readonly referencia?: string | null;
  readonly cargo?: number | null;
  readonly abono?: number | null;
  readonly saldo?: number | null;
  readonly monto?: number;
  readonly banco?: string;
  readonly formato?: string;
}

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

export interface OpcionesMatching {
  readonly dateToleranceDays?: number; // default 3 (servidor)
  readonly montoTolerancePct?: number; // default 5.0 (servidor)
  readonly fuzzyThreshold?: number; // default 80 (servidor)
}

/** `AlertaAntiguedad` en el dominio -- también la forma que produce
 * `revisarDiscrepanciaIngresos` (una sola alerta suelta con `fecha: ""`). */
export interface AlertaConciliacion {
  readonly itemType: "bank" | "book";
  readonly fecha: string;
  readonly monto: number;
  readonly descripcion: string;
  readonly daysUnreconciled: number;
  readonly severity: SeveridadAlerta;
  readonly message: string;
  readonly rule: string;
}

export type ClasificacionDeposito = "ingreso" | "financiamiento" | "aportacion_socio" | "garantia" | "otro_no_gravable";

export interface ResultadoClasificacionDeposito {
  readonly clasificacion: ClasificacionDeposito;
  readonly confidence: number;
  readonly articuloCff: string | null;
  readonly requiresHumanReview: boolean;
}

export interface ResultadoVerificacionSpei {
  readonly verified: boolean;
  readonly bestScore: number;
  readonly movementIdx: number | null;
}

/** Corre el motor de matching (niveles 1-3, determinista) contra los CFDI ya
 * ingeridos de esta property -- el servidor resuelve `unmatchedBooks` a partir de
 * `repo.listInvoices`, el cliente solo manda los movimientos bancarios ya
 * parseados. */
export async function correrMatchingConciliacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  movimientos: readonly MovimientoBancarioInput[],
  opciones: OpcionesMatching = {},
): Promise<ResultadoConciliacion> {
  return postJson<ResultadoConciliacion>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/conciliacion/matching`, token, { movimientos, ...opciones });
}

/** Alertas de antigüedad/comisión/duplicados/discrepancia de ingresos sobre un
 * lote de movimientos ya parseados -- no requiere conciliarlos primero. */
export async function fetchAlertasConciliacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  movimientos: readonly MovimientoBancarioInput[],
  declaredIncome?: number,
): Promise<{ readonly alertas: readonly AlertaConciliacion[] }> {
  return postJson<{ readonly alertas: readonly AlertaConciliacion[] }>(
    fetchImpl,
    `${apiBaseUrl}/despachos/${propertyId}/conciliacion/alertas`,
    token,
    declaredIncome !== undefined ? { movimientos, declaredIncome } : { movimientos },
  );
}

/** Clasificación automática de un depósito (ingreso/financiamiento/aportación de
 * socio/garantía/otro) -- CFF Art. 59 fr. III. */
export async function clasificarDepositoConciliacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  descripcion: string,
  referencia?: string | null,
): Promise<ResultadoClasificacionDeposito> {
  return postJson<ResultadoClasificacionDeposito>(
    fetchImpl,
    `${apiBaseUrl}/despachos/${propertyId}/conciliacion/clasificar-deposito`,
    token,
    referencia ? { descripcion, referencia } : { descripcion },
  );
}

export interface VerificarSpeiInput {
  readonly movimientos: readonly MovimientoBancarioInput[];
  /** Exactamente uno de `claveRastreo`/`rfc` -- el servidor rechaza si faltan
   * ambos (prioriza `claveRastreo` si vinieran los dos). */
  readonly claveRastreo?: string;
  readonly rfc?: string;
  readonly monto: number;
  readonly fecha: string;
  readonly dateToleranceDays?: number; // default 3 (servidor)
}

/** Verificación de un pago SPEI (por clave de rastreo) o de proveedor (por RFC)
 * contra los movimientos ya parseados -- SOLO el matching local por score; la
 * consulta real a STP/Banxico CEP no está conectada en esta fase (ver
 * spei-matching.ts en el dominio). */
export async function verificarSpeiConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: VerificarSpeiInput): Promise<ResultadoVerificacionSpei> {
  return postJson<ResultadoVerificacionSpei>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/conciliacion/verificar-spei`, token, input);
}
