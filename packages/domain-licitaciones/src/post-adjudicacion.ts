// L-27 -- post-adjudicacion estructurada del contrato: garantias (cumplimiento, anticipo, vicios ocultos),
// hitos con responsable, convenios modificatorios y plazos de firma/entrega de garantia.
//
// Modulo de DOMINIO puro (sin base ni reloj): todo recibe `hoy` ("YYYY-MM-DD") y el calendario efectivo de
// L-22. Los montos viajan como cadena decimal en la API y como centavos (`bigint`) en el calculo; nunca como
// punto flotante (`money.ts`).
//
// HONESTIDAD LEGAL (ficha `laassp-2025-plazos-firma-garantia` del registro `normas.ts`): este modulo NO fija
// cuantos dias tiene la convocante para firmar ni cuantos tiene el proveedor para entregar la garantia. Esos
// dias los DECLARA la organizacion a partir de las bases o del fallo; aqui solo se cuentan como dias HABILES
// contra el calendario efectivo. Si la norma o las bases los cuentan como naturales, el vencimiento calculado
// puede diferir: validar con abogado. Ningun articulo se cita sin ficha verificada.
import { addBusinessDays, daysBetween } from "./business-days.ts";
import { isValidDateOnly } from "./dias-inhabiles.ts";
import type { CalendarioPlazos } from "./dias-inhabiles.ts";
import { assertValidDecimalString, fromCents, toCents } from "./money.ts";

export class PostAdjudicacionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostAdjudicacionValidationError";
  }
}

/** La base no tiene aun la migracion 035: lecturas -> "no disponible aun", escrituras -> 503. Nunca un 500. */
export class PostAdjudicacionNotAvailableError extends Error {
  constructor(message = "El seguimiento de garantías, hitos y convenios aún no está disponible en este ambiente (falta la migración 035 de licitaciones).") {
    super(message);
    this.name = "PostAdjudicacionNotAvailableError";
  }
}

/** Transicion o edicion que la maquina de estados rechaza (garantia/hito ya final, transicion invalida). */
export class PostAdjudicacionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostAdjudicacionStateError";
  }
}

/** Escritura que el rol del usuario no puede hacer (p. ej. liberar una garantia sin rol de decision). */
export class PostAdjudicacionForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostAdjudicacionForbiddenError";
  }
}

/** El recurso no existe en esta organizacion (o es de otra: nunca se distingue). */
export class PostAdjudicacionNotFoundError extends Error {
  constructor(message = "No encontrado.") {
    super(message);
    this.name = "PostAdjudicacionNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Garantias
// ---------------------------------------------------------------------------

export const GARANTIA_TIPOS = ["cumplimiento", "anticipo", "vicios_ocultos"] as const;
export type GarantiaTipo = (typeof GARANTIA_TIPOS)[number];

export const GARANTIA_ESTADOS = ["pendiente_entrega", "entregada", "liberada", "ejecutada", "vencida"] as const;
export type GarantiaEstado = (typeof GARANTIA_ESTADOS)[number];

export function isGarantiaTipo(v: unknown): v is GarantiaTipo {
  return typeof v === "string" && (GARANTIA_TIPOS as readonly string[]).includes(v);
}
export function isGarantiaEstado(v: unknown): v is GarantiaEstado {
  return typeof v === "string" && (GARANTIA_ESTADOS as readonly string[]).includes(v);
}

/** Espejo de `licitaciones.contract_guarantee_guard` (migracion 035): la base lo vuelve a exigir. */
export const GARANTIA_TRANSICIONES: Readonly<Record<GarantiaEstado, readonly GarantiaEstado[]>> = {
  pendiente_entrega: ["entregada"],
  entregada: ["liberada", "ejecutada", "vencida"],
  vencida: ["liberada", "ejecutada"],
  liberada: [],
  ejecutada: [],
};

/** Estados finales de una garantia: ya no se editan. */
export function isGarantiaFinal(estado: GarantiaEstado): boolean {
  return estado === "liberada" || estado === "ejecutada";
}

/** Liberar o ejecutar una garantia es una decision (DECISION_ROLES), no una edicion (WRITE_ROLES). */
export const GARANTIA_ESTADOS_DE_DECISION: readonly GarantiaEstado[] = ["liberada", "ejecutada"];

export function assertGarantiaTransicion(desde: GarantiaEstado, hacia: GarantiaEstado): void {
  if (!GARANTIA_TRANSICIONES[desde].includes(hacia)) {
    const permitidas = GARANTIA_TRANSICIONES[desde];
    throw new PostAdjudicacionStateError(
      permitidas.length === 0 ? `La garantía ya está ${desde} y no admite más cambios.` : `Transición de garantía inválida: ${desde} -> ${hacia}. Desde ${desde} solo se puede pasar a: ${permitidas.join(", ")}.`,
    );
  }
}

export interface Garantia {
  readonly id: string;
  readonly contractId: string;
  readonly tipo: GarantiaTipo;
  /** Monto como cadena decimal con 2 decimales ("125000.00"); internamente centavos. */
  readonly monto: string;
  /** Porcentaje del monto del contrato (0.01..100) o null si no se declaro. */
  readonly porcentaje: number | null;
  readonly afianzadora: string | null;
  readonly numeroPoliza: string | null;
  readonly vigenciaDesde: string;
  readonly vigenciaHasta: string;
  readonly fechaLimiteEntrega: string | null;
  readonly entregadaEn: string | null;
  readonly estado: GarantiaEstado;
  readonly notas: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GarantiaInput {
  readonly tipo: GarantiaTipo;
  readonly montoCents: bigint;
  readonly porcentajeBp: number | null;
  readonly afianzadora: string | null;
  readonly numeroPoliza: string | null;
  readonly vigenciaDesde: string;
  readonly vigenciaHasta: string;
  /** `undefined` = que el servidor la calcule de los plazos del contrato (solo cumplimiento). */
  readonly fechaLimiteEntrega: string | null | undefined;
  readonly entregadaEn: string | null;
  readonly notas: string | null;
}

export interface GarantiaPatch {
  readonly montoCents?: bigint;
  readonly porcentajeBp?: number | null;
  readonly afianzadora?: string | null;
  readonly numeroPoliza?: string | null;
  readonly vigenciaDesde?: string;
  readonly vigenciaHasta?: string;
  readonly fechaLimiteEntrega?: string | null;
  readonly entregadaEn?: string | null;
  readonly estado?: GarantiaEstado;
  readonly notas?: string | null;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function requireDate(raw: unknown, campo: string): string {
  if (!isValidDateOnly(raw)) throw new PostAdjudicacionValidationError(`${campo}: se esperaba una fecha real "YYYY-MM-DD".`);
  const anio = Number(raw.slice(0, 4));
  if (anio < 2000 || anio > 2100) throw new PostAdjudicacionValidationError(`${campo}: el año debe estar entre 2000 y 2100.`);
  return raw;
}

function optionalDate(raw: unknown, campo: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  return requireDate(raw, campo);
}

function optionalText(raw: unknown, campo: string, min: number, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new PostAdjudicacionValidationError(`${campo}: se esperaba texto.`);
  const t = raw.trim();
  if (t.length === 0) return null;
  if (t.length < min || t.length > max) throw new PostAdjudicacionValidationError(`${campo}: debe tener entre ${min} y ${max} caracteres.`);
  return t;
}

function requireText(raw: unknown, campo: string, min: number, max: number): string {
  const t = optionalText(raw, campo, min, max);
  if (t === null) throw new PostAdjudicacionValidationError(`${campo}: requerido (entre ${min} y ${max} caracteres).`);
  return t;
}

const MONTO_MAX_CENTS = 100_000_000_000_000n;

/** Monto como cadena decimal positiva ("1234.56"); nunca un `number` de punto flotante. */
export function parseMontoCents(raw: unknown, campo: string): bigint {
  if (typeof raw !== "string") throw new PostAdjudicacionValidationError(`${campo}: se esperaba una cadena decimal (p. ej. "125000.50").`);
  try {
    assertValidDecimalString(raw);
  } catch (err) {
    throw new PostAdjudicacionValidationError(`${campo}: ${err instanceof Error ? err.message : "monto inválido."}`);
  }
  const cents = toCents(raw);
  if (cents <= 0n) throw new PostAdjudicacionValidationError(`${campo}: debe ser mayor que cero.`);
  if (cents > MONTO_MAX_CENTS) throw new PostAdjudicacionValidationError(`${campo}: excede el máximo permitido.`);
  return cents;
}

/** Ajuste de monto de un convenio: positivo (incremento) o negativo (reduccion), nunca cero. */
export function parseDeltaCents(raw: unknown, campo: string): bigint {
  if (typeof raw !== "string") throw new PostAdjudicacionValidationError(`${campo}: se esperaba una cadena decimal (p. ej. "-5000.00" o "12000").`);
  try {
    assertValidDecimalString(raw);
  } catch (err) {
    throw new PostAdjudicacionValidationError(`${campo}: ${err instanceof Error ? err.message : "monto inválido."}`);
  }
  const cents = toCents(raw);
  if (cents === 0n) throw new PostAdjudicacionValidationError(`${campo}: no puede ser cero.`);
  if (cents > MONTO_MAX_CENTS || cents < -MONTO_MAX_CENTS) throw new PostAdjudicacionValidationError(`${campo}: excede el máximo permitido.`);
  return cents;
}

/** Porcentaje 0.01..100 con a lo mas 2 decimales -> puntos base (1 = 0.01 %). */
export function parsePorcentajeBp(raw: unknown, campo: string): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new PostAdjudicacionValidationError(`${campo}: se esperaba un número entre 0.01 y 100.`);
  const bp = Math.round(raw * 100);
  if (Math.abs(bp / 100 - raw) > 1e-9 || bp < 1 || bp > 10_000) throw new PostAdjudicacionValidationError(`${campo}: se esperaba un número entre 0.01 y 100 con máximo 2 decimales.`);
  return bp;
}

export function parseGarantiaInput(raw: unknown): GarantiaInput {
  if (!isRecord(raw)) throw new PostAdjudicacionValidationError("Se esperaba un objeto JSON.");
  if (!isGarantiaTipo(raw.tipo)) throw new PostAdjudicacionValidationError(`tipo: se esperaba uno de ${GARANTIA_TIPOS.join(", ")}.`);
  const vigenciaDesde = requireDate(raw.vigenciaDesde, "vigenciaDesde");
  const vigenciaHasta = requireDate(raw.vigenciaHasta, "vigenciaHasta");
  if (vigenciaHasta < vigenciaDesde) throw new PostAdjudicacionValidationError("vigenciaHasta no puede ser anterior a vigenciaDesde.");
  const entregadaEn = optionalDate(raw.entregadaEn, "entregadaEn");
  return {
    tipo: raw.tipo,
    montoCents: parseMontoCents(raw.monto, "monto"),
    porcentajeBp: parsePorcentajeBp(raw.porcentaje, "porcentaje"),
    afianzadora: optionalText(raw.afianzadora, "afianzadora", 2, 200),
    numeroPoliza: optionalText(raw.numeroPoliza, "numeroPoliza", 1, 100),
    vigenciaDesde,
    vigenciaHasta,
    fechaLimiteEntrega: "fechaLimiteEntrega" in raw ? optionalDate(raw.fechaLimiteEntrega, "fechaLimiteEntrega") : undefined,
    entregadaEn,
    notas: optionalText(raw.notas, "notas", 1, 1000),
  };
}

export function parseGarantiaPatch(raw: unknown): GarantiaPatch {
  if (!isRecord(raw)) throw new PostAdjudicacionValidationError("Se esperaba un objeto JSON.");
  const patch: { -readonly [K in keyof GarantiaPatch]: GarantiaPatch[K] } = {};
  if ("monto" in raw) patch.montoCents = parseMontoCents(raw.monto, "monto");
  if ("porcentaje" in raw) patch.porcentajeBp = parsePorcentajeBp(raw.porcentaje, "porcentaje");
  if ("afianzadora" in raw) patch.afianzadora = optionalText(raw.afianzadora, "afianzadora", 2, 200);
  if ("numeroPoliza" in raw) patch.numeroPoliza = optionalText(raw.numeroPoliza, "numeroPoliza", 1, 100);
  if ("vigenciaDesde" in raw) patch.vigenciaDesde = requireDate(raw.vigenciaDesde, "vigenciaDesde");
  if ("vigenciaHasta" in raw) patch.vigenciaHasta = requireDate(raw.vigenciaHasta, "vigenciaHasta");
  if ("fechaLimiteEntrega" in raw) patch.fechaLimiteEntrega = optionalDate(raw.fechaLimiteEntrega, "fechaLimiteEntrega");
  if ("entregadaEn" in raw) patch.entregadaEn = optionalDate(raw.entregadaEn, "entregadaEn");
  if ("notas" in raw) patch.notas = optionalText(raw.notas, "notas", 1, 1000);
  if ("estado" in raw) {
    if (!isGarantiaEstado(raw.estado)) throw new PostAdjudicacionValidationError(`estado: se esperaba uno de ${GARANTIA_ESTADOS.join(", ")}.`);
    patch.estado = raw.estado;
  }
  if (Object.keys(patch).length === 0) throw new PostAdjudicacionValidationError("No hay ningún campo que actualizar.");
  if (patch.vigenciaDesde && patch.vigenciaHasta && patch.vigenciaHasta < patch.vigenciaDesde) throw new PostAdjudicacionValidationError("vigenciaHasta no puede ser anterior a vigenciaDesde.");
  return patch;
}

/** Vista derivada de una garantia a una fecha: la vigencia manda sobre el estado guardado. */
export interface GarantiaVigencia {
  /** `entregada` con la vigencia ya terminada se muestra `vencida` aunque nadie la haya marcado. */
  readonly estadoEfectivo: GarantiaEstado;
  readonly vencidaPorFecha: boolean;
  /** Entregada y con vigencia que termina dentro de la ventana (inclusive). */
  readonly porVencer: boolean;
  /** Dias de calendario hasta `vigenciaHasta` (negativo = ya paso); solo informativo. */
  readonly diasParaVencer: number;
  /** `pendiente_entrega` con la fecha limite de entrega ya vencida. */
  readonly entregaVencida: boolean;
}

/** Ventana de "por vencer" de una garantia entregada (dias de calendario). */
export const GARANTIA_POR_VENCER_DIAS = 30;

export function evaluarGarantia(g: Pick<Garantia, "estado" | "vigenciaHasta" | "fechaLimiteEntrega">, hoy: string, ventanaDias: number = GARANTIA_POR_VENCER_DIAS): GarantiaVigencia {
  const diasParaVencer = daysBetween(hoy, g.vigenciaHasta);
  const vencidaPorFecha = g.estado === "entregada" && diasParaVencer < 0;
  return {
    estadoEfectivo: vencidaPorFecha ? "vencida" : g.estado,
    vencidaPorFecha,
    porVencer: g.estado === "entregada" && diasParaVencer >= 0 && diasParaVencer <= ventanaDias,
    diasParaVencer,
    entregaVencida: g.estado === "pendiente_entrega" && g.fechaLimiteEntrega !== null && g.fechaLimiteEntrega < hoy,
  };
}

// ---------------------------------------------------------------------------
// Plazos de firma y de entrega de garantia
// ---------------------------------------------------------------------------

/** Id de la ficha del registro normativo (`normas.ts`) que respalda (y limita) estos calculos. */
export const PLAZOS_POST_ADJUDICACION_NORMA_ID = "laassp-2025-plazos-firma-garantia";

export const PLAZOS_POST_ADJUDICACION_NOTA =
  "Los días del plazo de firma y de entrega de garantía los declara la organización según las bases o el fallo; aquí solo se cuentan como días hábiles con el calendario efectivo. Plazo legal no verificado contra la fuente primaria: validar con abogado, sobre todo si las bases cuentan días naturales.";

export interface ContractPlazos {
  readonly contractId: string;
  readonly falloNotificadoEn: string | null;
  readonly plazoFirmaDias: number | null;
  readonly firmadoEn: string | null;
  readonly plazoGarantiaDias: number | null;
  readonly updatedAt: string;
}

export interface PlazosInput {
  readonly falloNotificadoEn?: string | null;
  readonly plazoFirmaDias?: number | null;
  readonly firmadoEn?: string | null;
  readonly plazoGarantiaDias?: number | null;
}

function optionalDias(raw: unknown, campo: string): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 90) throw new PostAdjudicacionValidationError(`${campo}: se esperaba un entero entre 1 y 90 (días hábiles).`);
  return raw;
}

export function parsePlazosInput(raw: unknown): PlazosInput {
  if (!isRecord(raw)) throw new PostAdjudicacionValidationError("Se esperaba un objeto JSON.");
  const out: { -readonly [K in keyof PlazosInput]: PlazosInput[K] } = {};
  if ("falloNotificadoEn" in raw) out.falloNotificadoEn = optionalDate(raw.falloNotificadoEn, "falloNotificadoEn");
  if ("plazoFirmaDias" in raw) out.plazoFirmaDias = optionalDias(raw.plazoFirmaDias, "plazoFirmaDias");
  if ("firmadoEn" in raw) out.firmadoEn = optionalDate(raw.firmadoEn, "firmadoEn");
  if ("plazoGarantiaDias" in raw) out.plazoGarantiaDias = optionalDias(raw.plazoGarantiaDias, "plazoGarantiaDias");
  if (Object.keys(out).length === 0) throw new PostAdjudicacionValidationError("No hay ningún plazo que actualizar.");
  return out;
}

export interface PlazosCalculados {
  /** Limite de firma: fallo + dias habiles. `null` si falta la fecha del fallo o los dias. */
  readonly fechaLimiteFirma: string | null;
  /** Limite de entrega de la garantia de cumplimiento: firma + dias habiles. `null` si falta la firma o los dias. */
  readonly fechaLimiteEntregaGarantia: string | null;
  readonly firmaVencida: boolean;
  readonly nota: string;
  readonly normaId: string;
  readonly calendarioNota: string;
}

/** Calcula las fechas limite en dias HABILES con el calendario efectivo (L-22). Nunca inventa un dato que falta. */
export function calcularPlazos(plazos: Pick<ContractPlazos, "falloNotificadoEn" | "plazoFirmaDias" | "firmadoEn" | "plazoGarantiaDias"> | null, calendario: CalendarioPlazos, hoy: string): PlazosCalculados {
  const fechaLimiteFirma = plazos?.falloNotificadoEn && plazos.plazoFirmaDias ? addBusinessDays(plazos.falloNotificadoEn, plazos.plazoFirmaDias, calendario) : null;
  const fechaLimiteEntregaGarantia = plazos?.firmadoEn && plazos.plazoGarantiaDias ? addBusinessDays(plazos.firmadoEn, plazos.plazoGarantiaDias, calendario) : null;
  return {
    fechaLimiteFirma,
    fechaLimiteEntregaGarantia,
    firmaVencida: fechaLimiteFirma !== null && !plazos?.firmadoEn && fechaLimiteFirma < hoy,
    nota: PLAZOS_POST_ADJUDICACION_NOTA,
    normaId: PLAZOS_POST_ADJUDICACION_NORMA_ID,
    calendarioNota: calendario.note,
  };
}

// ---------------------------------------------------------------------------
// Hitos
// ---------------------------------------------------------------------------

export const HITO_ESTADOS = ["pendiente", "cumplido", "cancelado"] as const;
export type HitoEstado = (typeof HITO_ESTADOS)[number];

export function isHitoEstado(v: unknown): v is HitoEstado {
  return typeof v === "string" && (HITO_ESTADOS as readonly string[]).includes(v);
}

export interface Hito {
  readonly id: string;
  readonly contractId: string;
  readonly titulo: string;
  readonly descripcion: string | null;
  /** Staff de la organizacion responsable; `null` si fue dado de baja. */
  readonly responsableId: string | null;
  readonly fechaCompromiso: string;
  readonly estado: HitoEstado;
  readonly cumplidoEn: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HitoInput {
  readonly titulo: string;
  readonly descripcion: string | null;
  readonly responsableId: string;
  readonly fechaCompromiso: string;
}

export interface HitoPatch {
  readonly titulo?: string;
  readonly descripcion?: string | null;
  readonly responsableId?: string;
  readonly fechaCompromiso?: string;
  readonly estado?: Exclude<HitoEstado, "pendiente">;
  readonly cumplidoEn?: string | null;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function parseHitoInput(raw: unknown): HitoInput {
  if (!isRecord(raw)) throw new PostAdjudicacionValidationError("Se esperaba un objeto JSON.");
  if (!isUuid(raw.responsableId)) throw new PostAdjudicacionValidationError("responsableId: se esperaba el UUID de un miembro del equipo.");
  return {
    titulo: requireText(raw.titulo, "titulo", 3, 200),
    descripcion: optionalText(raw.descripcion, "descripcion", 1, 1000),
    responsableId: raw.responsableId,
    fechaCompromiso: requireDate(raw.fechaCompromiso, "fechaCompromiso"),
  };
}

/** `hoy` solo se usa para fijar `cumplidoEn` cuando se marca cumplido sin fecha explicita. */
export function parseHitoPatch(raw: unknown, hoy: string): HitoPatch {
  if (!isRecord(raw)) throw new PostAdjudicacionValidationError("Se esperaba un objeto JSON.");
  const patch: { -readonly [K in keyof HitoPatch]: HitoPatch[K] } = {};
  if ("titulo" in raw) patch.titulo = requireText(raw.titulo, "titulo", 3, 200);
  if ("descripcion" in raw) patch.descripcion = optionalText(raw.descripcion, "descripcion", 1, 1000);
  if ("responsableId" in raw) {
    if (!isUuid(raw.responsableId)) throw new PostAdjudicacionValidationError("responsableId: se esperaba el UUID de un miembro del equipo.");
    patch.responsableId = raw.responsableId;
  }
  if ("fechaCompromiso" in raw) patch.fechaCompromiso = requireDate(raw.fechaCompromiso, "fechaCompromiso");
  if ("estado" in raw) {
    if (raw.estado !== "cumplido" && raw.estado !== "cancelado") throw new PostAdjudicacionValidationError('estado: solo se puede pasar a "cumplido" o "cancelado".');
    patch.estado = raw.estado;
    patch.cumplidoEn = raw.estado === "cumplido" ? (optionalDate(raw.cumplidoEn, "cumplidoEn") ?? hoy) : null;
  }
  if (Object.keys(patch).length === 0) throw new PostAdjudicacionValidationError("No hay ningún campo que actualizar.");
  return patch;
}

export interface HitoVigencia {
  /** `pendiente` con la fecha comprometida ya pasada se muestra `vencido`. */
  readonly estadoEfectivo: HitoEstado | "vencido";
  readonly vencido: boolean;
  readonly diasDeRetraso: number;
}

export function evaluarHito(h: Pick<Hito, "estado" | "fechaCompromiso">, hoy: string): HitoVigencia {
  const retraso = daysBetween(h.fechaCompromiso, hoy);
  const vencido = h.estado === "pendiente" && retraso > 0;
  return { estadoEfectivo: vencido ? "vencido" : h.estado, vencido, diasDeRetraso: vencido ? retraso : 0 };
}

// ---------------------------------------------------------------------------
// Convenios modificatorios
// ---------------------------------------------------------------------------

export const CONVENIO_TIPOS = ["monto", "plazo", "monto_plazo"] as const;
export type ConvenioTipo = (typeof CONVENIO_TIPOS)[number];

export interface Convenio {
  readonly id: string;
  readonly contractId: string;
  /** Consecutivo por contrato, asignado por la base. */
  readonly numero: number;
  readonly tipo: ConvenioTipo;
  /** Ajuste del monto como cadena decimal con signo ("12000.00" / "-5000.00") o null si solo cambia el plazo. */
  readonly montoDelta: string | null;
  readonly nuevaFechaFin: string | null;
  readonly fechaFinAnterior: string | null;
  readonly fechaFirma: string;
  readonly motivo: string;
  readonly createdAt: string;
}

export interface ConvenioInput {
  readonly tipo: ConvenioTipo;
  readonly montoDeltaCents: bigint | null;
  readonly nuevaFechaFin: string | null;
  readonly fechaFirma: string;
  readonly motivo: string;
}

export function parseConvenioInput(raw: unknown): ConvenioInput {
  if (!isRecord(raw)) throw new PostAdjudicacionValidationError("Se esperaba un objeto JSON.");
  if (typeof raw.tipo !== "string" || !(CONVENIO_TIPOS as readonly string[]).includes(raw.tipo)) throw new PostAdjudicacionValidationError(`tipo: se esperaba uno de ${CONVENIO_TIPOS.join(", ")}.`);
  const tipo = raw.tipo as ConvenioTipo;
  const tieneMonto = raw.montoDelta !== undefined && raw.montoDelta !== null;
  const tieneFin = raw.nuevaFechaFin !== undefined && raw.nuevaFechaFin !== null && raw.nuevaFechaFin !== "";
  if (tipo !== "plazo" && !tieneMonto) throw new PostAdjudicacionValidationError("montoDelta: requerido para un convenio de monto.");
  if (tipo !== "monto" && !tieneFin) throw new PostAdjudicacionValidationError("nuevaFechaFin: requerida para un convenio de plazo.");
  if (tipo === "plazo" && tieneMonto) throw new PostAdjudicacionValidationError("Un convenio de plazo no lleva montoDelta: use el tipo monto_plazo.");
  if (tipo === "monto" && tieneFin) throw new PostAdjudicacionValidationError("Un convenio de monto no lleva nuevaFechaFin: use el tipo monto_plazo.");
  return {
    tipo,
    montoDeltaCents: tieneMonto ? parseDeltaCents(raw.montoDelta, "montoDelta") : null,
    nuevaFechaFin: tieneFin ? requireDate(raw.nuevaFechaFin, "nuevaFechaFin") : null,
    fechaFirma: requireDate(raw.fechaFirma, "fechaFirma"),
    motivo: requireText(raw.motivo, "motivo", 3, 1000),
  };
}

/** Suma de los ajustes de monto de los convenios (centavos -> cadena decimal con signo). */
export function sumarAjustesDeMonto(convenios: readonly Pick<Convenio, "montoDelta">[]): string {
  let total = 0n;
  for (const c of convenios) if (c.montoDelta !== null) total += toCents(c.montoDelta);
  return fromCents(total);
}

// ---------------------------------------------------------------------------
// Bitacora
// ---------------------------------------------------------------------------

export interface BitacoraEntrada {
  readonly id: string;
  readonly entidad: "plazos" | "garantia" | "hito" | "convenio";
  readonly entidadId: string;
  readonly accion: "crear" | "editar" | "cambio_estado";
  readonly detalle: Readonly<Record<string, unknown>>;
  readonly actorId: string | null;
  readonly createdAt: string;
}

export interface Responsable {
  readonly userId: string;
  readonly nombre: string;
  readonly rol: string;
}

// ---------------------------------------------------------------------------
// Resumen (alimenta la pantalla y el tablero)
// ---------------------------------------------------------------------------

export interface ResumenPostAdjudicacion {
  readonly garantiasEntregadas: number;
  readonly garantiasPendientes: number;
  readonly garantiasPorVencer: number;
  readonly garantiasVencidas: number;
  readonly garantiasEntregaVencida: number;
  readonly hitosPendientes: number;
  readonly hitosVencidos: number;
  readonly ajusteDeMontoAcumulado: string;
}

export function resumirPostAdjudicacion(input: { garantias: readonly Garantia[]; hitos: readonly Hito[]; convenios: readonly Convenio[] }, hoy: string): ResumenPostAdjudicacion {
  let entregadas = 0;
  let pendientes = 0;
  let porVencer = 0;
  let vencidas = 0;
  let entregaVencida = 0;
  for (const g of input.garantias) {
    const v = evaluarGarantia(g, hoy);
    if (g.estado === "entregada" && !v.vencidaPorFecha) entregadas += 1;
    if (g.estado === "pendiente_entrega") pendientes += 1;
    if (v.porVencer) porVencer += 1;
    if (v.estadoEfectivo === "vencida") vencidas += 1;
    if (v.entregaVencida) entregaVencida += 1;
  }
  let hitosPendientes = 0;
  let hitosVencidos = 0;
  for (const h of input.hitos) {
    if (h.estado === "pendiente") hitosPendientes += 1;
    if (evaluarHito(h, hoy).vencido) hitosVencidos += 1;
  }
  return {
    garantiasEntregadas: entregadas,
    garantiasPendientes: pendientes,
    garantiasPorVencer: porVencer,
    garantiasVencidas: vencidas,
    garantiasEntregaVencida: entregaVencida,
    hitosPendientes,
    hitosVencidos,
    ajusteDeMontoAcumulado: sumarAjustesDeMonto(input.convenios),
  };
}

// ---------------------------------------------------------------------------
// Candidatos de alerta (barrido del cron existente)
// ---------------------------------------------------------------------------

export type PostAdjudicacionAlertaTipo = "garantia_por_vencer" | "garantia_no_entregada" | "hito_vencido";

export interface PostAdjudicacionAlertaCandidata {
  readonly tipo: PostAdjudicacionAlertaTipo;
  readonly entidadId: string;
  readonly contractId: string;
  /** Convocatoria del contrato: arma el enlace a su pantalla de post-adjudicacion. */
  readonly tenderId: string;
  /** Fecha que motiva la alerta: fin de vigencia, limite de entrega o fecha comprometida. */
  readonly fecha: string;
}

export function isAlertaTipo(v: unknown): v is PostAdjudicacionAlertaTipo {
  return v === "garantia_por_vencer" || v === "garantia_no_entregada" || v === "hito_vencido";
}
