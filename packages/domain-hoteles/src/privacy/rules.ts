// Reglas puras de privacidad (H-02): plazos ARCO, recordatorio de vulneraciones, revision de
// retenciones legales y el aviso de "no es asesoria legal". Sin I/O.
//
// IMPORTANTE: son DECISIONES DE PRODUCTO tomadas de un informe de investigacion documental
// (atiende-loop/expertos/retencion-identidad-hoteles-mx.md, 30-sep-2026, borrador sin valor de
// asesoria legal). Un abogado debe confirmarlas (ver PRIVACY_LAWYER_CHECKLIST).
import { addDaysYmd } from "../identity/service.ts";
import type { ArcoRequestRecord, ArcoStatus, LegalHoldRecord, PrivacyIncidentRecord } from "./types.ts";

/** Ventana de bloqueo previa a la purga (dias). Default 7; editable 3-30 por property. */
export const BLOCK_WINDOW_DAYS_DEFAULT = 7;
export const BLOCK_WINDOW_DAYS_MIN = 3;
export const BLOCK_WINDOW_DAYS_MAX = 30;

/** ARCO (LFPDPPP 2025, art. 31 segun el informe): respuesta en 20 dias; ejecucion en 15 mas; prorroga una vez por igual plazo. */
export const ARCO_RESPONSE_DAYS = 20;
export const ARCO_EXECUTION_DAYS = 15;
/** Avisar "por vencer" cuando faltan este numero de dias o menos. */
export const ARCO_DUE_SOON_DAYS = 5;
/** Revision anual obligatoria de una retencion legal. */
export const LEGAL_HOLD_REVIEW_DAYS = 365;

export const PRIVACY_LEGAL_DISCLAIMER =
  "Esta pantalla es una herramienta de registro y control. NO es asesoria legal ni garantiza el cumplimiento de la LFPDPPP ni de ninguna otra norma. Los plazos, formatos y criterios fueron tomados de un informe documental no vinculante: un abogado debe confirmarlos antes de usarlos como cumplimiento.";

/** Lo que un abogado debe confirmar (informe, seccion 6, mas lo especifico de H-02). */
export const PRIVACY_LAWYER_CHECKLIST: readonly string[] = [
  "Si los plazos ARCO (20 dias de respuesta, 15 de ejecucion) se cuentan en dias naturales o habiles; este sistema usa naturales (el computo mas conservador).",
  "Como se aplica la prorroga unica 'por igual plazo' (aqui: +20 dias en la fase de respuesta o +15 en la de ejecucion, una sola vez) y que motivo debe documentarse.",
  "Plazo, forma y destinatarios de la notificacion de vulneraciones (art. 19 LFPDPPP): el informe no encontro un plazo en horas ni aviso obligatorio a la Secretaria; el Reglamento puede precisarlo.",
  "Cuando una vulneracion 'afecta de forma significativa derechos patrimoniales o morales' (la bandera de riesgo significativo la decide el hotel con su abogado).",
  "Si la imagen del documento, el rostro o la huella son datos sensibles bajo la nueva ley y, por tanto, exigen consentimiento expreso y por escrito.",
  "Vigencia del Reglamento de la LFPDPPP de 2011 y de los Lineamientos del aviso de privacidad bajo la ley de 2025.",
  "Contenido minimo del aviso integral y simplificado (arts. 15 y 16) y la redaccion de las finalidades obligatorias frente a las opcionales.",
  "Decreto de la CDMX del 19-dic-2025 (plazo de 1 ano del registro de huespedes, alcance de 'identificacion') y normas estatales o municipales analogas.",
  "Plazo de bloqueo (aqui 7 dias por defecto, 3 a 30): el informe lo propone como practica de seguridad; el bloqueo legal equivale al plazo de prescripcion de las acciones de la relacion juridica (art. 2 fr. III y art. 24).",
  "Cuando una retencion legal (legal hold) es obligatoria o procedente (arts. 24-25 LFPDPPP, CPF 105, CCF 1161) y cada cuanto debe revisarse (aqui, anual).",
  "Consentimiento de menores de edad y de sus tutores en el registro de huespedes.",
];

function isRealDate(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/** Dias de calendario entre dos fechas YYYY-MM-DD (`to - from`). */
export function daysBetweenYmd(from: string, to: string): number {
  if (!isRealDate(from) || !isRealDate(to)) throw new Error(`daysBetweenYmd: fecha invalida (${from}, ${to})`);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Fecha limite de respuesta: recepcion + 20 dias naturales. */
export function computeArcoResponseDue(receivedOn: string): string {
  return addDaysYmd(receivedOn, ARCO_RESPONSE_DAYS);
}
/** Fecha limite de ejecucion: decision de procedencia + 15 dias naturales. */
export function computeArcoExecutionDue(decidedOn: string): string {
  return addDaysYmd(decidedOn, ARCO_EXECUTION_DAYS);
}

export type ArcoDeadlineState = "en_plazo" | "por_vencer" | "vencida" | "cerrada";
export interface ArcoDeadline {
  /** Fase abierta: respuesta (recibida/en_revision) o ejecucion (procedente); `null` si ya esta cerrada. */
  readonly phase: "respuesta" | "ejecucion" | null;
  readonly dueOn: string | null;
  /** Dias hasta el vencimiento (negativo = vencida hace N dias); `null` si esta cerrada. */
  readonly daysRemaining: number | null;
  readonly state: ArcoDeadlineState;
}

const OPEN_RESPONSE: readonly ArcoStatus[] = ["recibida", "en_revision"];

/** Estado del plazo de una solicitud ARCO a la fecha de negocio `today`. */
export function arcoDeadline(req: Pick<ArcoRequestRecord, "status" | "responseDueOn" | "executionDueOn">, today: string): ArcoDeadline {
  let phase: ArcoDeadline["phase"] = null;
  let dueOn: string | null = null;
  if (OPEN_RESPONSE.includes(req.status)) {
    phase = "respuesta";
    dueOn = req.responseDueOn;
  } else if (req.status === "procedente") {
    phase = "ejecucion";
    dueOn = req.executionDueOn;
  }
  if (phase === null || dueOn === null) return { phase: null, dueOn: null, daysRemaining: null, state: "cerrada" };
  const daysRemaining = daysBetweenYmd(today, dueOn);
  const state: ArcoDeadlineState = daysRemaining < 0 ? "vencida" : daysRemaining <= ARCO_DUE_SOON_DAYS ? "por_vencer" : "en_plazo";
  return { phase, dueOn, daysRemaining, state };
}

/** Si la prorroga unica aun esta disponible y por cuantos dias extenderia la fase abierta. */
export function arcoExtensionAvailable(req: Pick<ArcoRequestRecord, "status" | "extendedAt">): { available: boolean; days: number } {
  if (req.extendedAt !== null || req.status === "improcedente" || req.status === "ejecutada") return { available: false, days: 0 };
  return { available: true, days: req.status === "procedente" ? ARCO_EXECUTION_DAYS : ARCO_RESPONSE_DAYS };
}

export interface IncidentNotificationReminder {
  /** Hay que notificar al titular (riesgo significativo, sin notificacion registrada, incidente abierto). */
  readonly required: boolean;
  /** Art. 19: la notificacion es "de forma inmediata", asi que mientras falte esta vencida. */
  readonly overdue: boolean;
  readonly hoursSinceDetection: number;
  readonly message: string | null;
}

/** Recordatorio de notificar al titular (art. 19). SOLO es un aviso en pantalla: el sistema no envia nada. */
export function incidentNotificationReminder(
  incident: Pick<PrivacyIncidentRecord, "significantRisk" | "notifiedAt" | "status" | "detectedAt">,
  now: Date,
): IncidentNotificationReminder {
  const hours = Math.max(0, Math.floor((now.getTime() - Date.parse(incident.detectedAt)) / 3_600_000));
  const required = incident.significantRisk && incident.notifiedAt === null && incident.status !== "cerrada";
  return {
    required,
    overdue: required,
    hoursSinceDetection: hours,
    message: required
      ? `Notifica al titular DE INMEDIATO (art. 19 LFPDPPP): van ${hours} h desde la deteccion. Este sistema NO envia la notificacion; registrala aqui cuando la hagas.`
      : null,
  };
}

export type LegalHoldReviewState = "vigente" | "revision_proxima" | "revision_vencida" | "liberada";
/** Estado de la revision anual de una retencion legal (30 dias de antelacion para "proxima"). */
export function legalHoldReviewState(hold: Pick<LegalHoldRecord, "status" | "reviewDueOn">, today: string): LegalHoldReviewState {
  if (hold.status === "liberada") return "liberada";
  const remaining = daysBetweenYmd(today, hold.reviewDueOn);
  return remaining < 0 ? "revision_vencida" : remaining <= 30 ? "revision_proxima" : "vigente";
}
