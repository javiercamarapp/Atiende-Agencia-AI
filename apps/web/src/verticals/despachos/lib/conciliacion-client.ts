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
import { fetchJson, postJson, putJson } from "./admin-client.ts";

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

// ---------------------------------------------------------------------------------------------------------------------------------
// D-35 + D-02 -- conciliacion PERSISTIDA (sesiones, matches confirmados, deshacer) y nivel 4 (IA) con aprobacion humana. Espejo de los tipos que
// serializa apps/api/.../despachos/conciliacion-persistida.ts (migracion 021). El servidor recalcula el motor al confirmar: este cliente solo manda ids.
// ---------------------------------------------------------------------------------------------------------------------------------
export type EstadoSesionConciliacion = "abierta" | "cerrada";
export type EstadoMovimientoSesion = "conciliado" | "sugerido" | "ambiguo" | "sin_conciliar";
export type OrigenMatchConciliacion = "motor" | "llm_aprobado" | "manual" | "autopiloto";
export type MotivoSinConciliar = "sin_candidato" | "pocos_candidatos" | "sin_combinacion" | "demasiados_candidatos" | "presupuesto_agotado" | "ambiguo";

export interface SesionConciliacionResumen {
  readonly id: string;
  readonly periodo: string;
  readonly cuenta: string | null;
  readonly estado: EstadoSesionConciliacion;
  readonly creadaEn: string;
  readonly cerradaEn: string | null;
  readonly totalMovimientos: number;
  readonly matchesVigentes: number;
  readonly sugerenciasPendientes: number;
}

export interface MovimientoSesion {
  readonly id: string;
  readonly fecha: string;
  readonly descripcion: string;
  readonly referencia: string | null;
  readonly cuenta: string | null;
  readonly monto: number;
  readonly estado: EstadoMovimientoSesion;
  readonly matchId: string | null;
}

export interface CfdiSesion {
  readonly id: string;
  readonly folioFiscal: string;
  readonly emisorNombre: string | null;
  readonly total: number;
  readonly fecha: string;
  readonly conciliado: boolean;
  /** D-P3-11 (opcionales: el servidor sin la migración 018/025 no las manda). */
  readonly cancelado?: boolean;
  readonly direccion?: "emitido" | "recibido" | "indeterminado" | null;
}

export interface PropuestaMotorSesion {
  readonly movimientoId: string;
  readonly invoiceId: string;
  /** 1 exacto, 2 fuzzy. */
  readonly nivel: 1 | 2;
  readonly confianza: number;
  readonly detalle: string;
  /** D-P3-11: el CFDI tiene dirección indeterminada: solo se confirma tras revisarlo. */
  readonly requiereRevision?: boolean;
}

/** D-P3-10: 2 o más combinaciones de CFDI suman el movimiento. */
export interface AmbiguaSesion {
  readonly movimientoId: string;
  readonly combinaciones: readonly (readonly string[])[];
  readonly truncado: boolean;
  readonly exactas: boolean;
}

export interface SinConciliarSesion {
  readonly movimientoId: string;
  readonly motivo: MotivoSinConciliar;
  readonly cercanos: readonly { readonly invoiceId: string; readonly diferenciaCentavos: number }[];
}

export interface MatchSesion {
  readonly id: string;
  readonly movimientoId: string;
  readonly invoiceId: string;
  readonly nivel: number | null;
  readonly confianza: number | null;
  readonly origen: OrigenMatchConciliacion;
  readonly confirmadoEn: string;
  readonly deshechoEn: string | null;
  readonly motivoDeshacer: string | null;
}

export interface SugerenciaSesion {
  readonly id: string;
  readonly movimientoId: string;
  readonly invoiceId: string;
  readonly confianza: number;
  readonly razon: string;
  readonly estado: "pendiente" | "aprobada" | "rechazada";
}

export interface DetalleSesionConciliacion {
  readonly sesion: { readonly id: string; readonly periodo: string; readonly cuenta: string | null; readonly estado: EstadoSesionConciliacion };
  readonly movimientos: readonly MovimientoSesion[];
  readonly cfdis: readonly CfdiSesion[];
  readonly propuestas: readonly PropuestaMotorSesion[];
  readonly multiLinea: readonly { readonly movimientoId: string; readonly invoiceIds: readonly string[]; readonly confianza: number; readonly detalle: string }[];
  /** D-P3-10 (opcionales: un servidor anterior no los manda). */
  readonly ambiguas?: readonly AmbiguaSesion[];
  readonly sinConciliar?: readonly SinConciliarSesion[];
  /** Cuándo se calcularon las propuestas guardadas; `null` = se calcularon al vuelo (sesión anterior a la migración 025). */
  readonly propuestasEn?: string | null;
  readonly propuestasFuente?: "guardadas" | "calculadas" | "ninguna";
  readonly ventana?: { readonly desde: string; readonly hasta: string; readonly dias: number };
  readonly matches: readonly MatchSesion[];
  readonly sugerencias: readonly SugerenciaSesion[];
}

export interface SugerirConIaRespuesta {
  readonly sugerencias: readonly SugerenciaSesion[];
  readonly sinSugerencia: readonly { readonly movimientoId: string; readonly razon: string; readonly mejorScoreEvaluado: number | null }[];
  readonly notificacion: string;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/despachos/${propertyId}/conciliacion`;

export function listarSesionesConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ readonly disponible: boolean; readonly sesiones: readonly SesionConciliacionResumen[] }> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sesiones`, token);
}

export function crearSesionConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string, cuenta?: string): Promise<{ readonly sesion: { readonly id: string }; readonly movimientos: number }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sesiones`, token, cuenta ? { periodo, cuenta } : { periodo });
}

export function obtenerSesionConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, sesionId: string): Promise<DetalleSesionConciliacion> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sesiones/${sesionId}`, token);
}

/** Confirma pares: solo ids. El servidor vuelve a correr el motor y toma de ahi nivel, confianza y origen. */
export function confirmarParesConciliacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  sesionId: string,
  pares: readonly { readonly movimientoId: string; readonly invoiceId: string; readonly revisado?: boolean }[],
): Promise<{ readonly matches: readonly MatchSesion[] }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sesiones/${sesionId}/confirmar`, token, { pares });
}

export function deshacerMatchConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, matchId: string, motivo: string): Promise<{ readonly yaDeshecho: boolean }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/matches/${matchId}/deshacer`, token, { motivo });
}

export function cerrarSesionConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, sesionId: string): Promise<{ readonly yaCerrada: boolean }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sesiones/${sesionId}/cerrar`, token, {});
}

/** Nivel 4: el modelo SUGIERE (quedan pendientes). 503 "IA no configurada" llega como Error con el mensaje del servidor. */
export function sugerirConIaConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, sesionId: string): Promise<SugerirConIaRespuesta> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sesiones/${sesionId}/sugerencias-llm`, token, {});
}

export function resolverSugerenciaConciliacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  sugerenciaId: string,
  aprobar: boolean,
): Promise<{ readonly estado: "aprobada" | "rechazada"; readonly matchId: string | null }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sugerencias/${sugerenciaId}/${aprobar ? "aprobar" : "rechazar"}`, token, {});
}

/** D-P3-10: recalcula el motor sobre lo libre de la sesión y guarda las propuestas (el GET ya no las recalcula). */
export function recalcularSesionConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, sesionId: string): Promise<DetalleSesionConciliacion & { readonly guardado: boolean }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/sesiones/${sesionId}/recalcular`, token, {});
}

/** D-P3-12: bandera del piloto automático de nivel 1 (apagada por omisión). */
export function leerConfiguracionConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ readonly autoconfirmarNivel1: boolean }> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion`, token);
}

export function guardarConfiguracionConciliacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, autoconfirmarNivel1: boolean): Promise<{ readonly autoconfirmarNivel1: boolean }> {
  return putJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion`, token, { autoconfirmarNivel1 });
}
