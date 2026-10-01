// H-03 -- guardrails y compuerta de agentes: funciones PURAS. Son el espejo, para la app y las pruebas, de lo
// que la base decide de forma autoritativa (migracion 035: hoteles.agent_guardrail_violation /
// within_send_window / agent_gate). Mismos casos de borde en ambos lados; los cubre scripts/
// verify-hoteles-agentes-aprobaciones contra Postgres real y guardrails.spec.ts aqui.
import type { ActionPolicyRecord, AgentGate, ApprovalActionType, GuardrailsInput, GuardrailsRecord } from "./tipos.ts";

export const DEFAULT_GUARDRAILS: GuardrailsInput = {
  maxDiscountPct: 30,
  maxRefundCents: 500_000,
  maxFolioChargeCents: 500_000,
  maxMassRecipients: 200,
  blockedWords: [],
  sendWindowStart: "08:00",
  sendWindowEnd: "21:00",
};

const ACCENT_FROM = "áàäâéèëêíìïîóòöôúùüûñÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑ";
const ACCENT_TO = "aaaaeeeeiiiioooouuuunAAAAEEEEIIIIOOOOUUUUN";

/** Mismo mapa explicito que hoteles.guardrail_normalize (no depende del locale): sin acentos, minusculas, espacios colapsados. */
export function normalizeGuardrailText(text: string | null | undefined): string {
  let out = "";
  for (const ch of text ?? "") {
    const i = ACCENT_FROM.indexOf(ch);
    out += i >= 0 ? ACCENT_TO[i]! : ch;
  }
  return out.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Normaliza la lista que guarda la base: sin vacias ni duplicadas, ordenada. Lanza si una supera 60 caracteres. */
export function normalizeBlockedWords(words: readonly string[]): readonly string[] {
  const set = new Set<string>();
  for (const w of words) {
    const n = normalizeGuardrailText(w);
    if (n === "") continue;
    if (n.length > 60) throw new RangeError("cada palabra bloqueada admite maximo 60 caracteres");
    set.add(n);
  }
  return [...set].sort();
}

function escapeRegex(value: string): string {
  return value.replace(/[.\\^$*+?()[\]{}|-]/g, "\\$&");
}

/** Primera palabra o frase bloqueada que aparece como palabra COMPLETA (no subcadena), o null. */
export function firstBlockedWord(text: string | null | undefined, blockedWords: readonly string[]): string | null {
  const haystack = normalizeGuardrailText(text);
  for (const w of blockedWords) {
    if (w === "") continue;
    if (new RegExp(`(^|[^a-z0-9])${escapeRegex(w)}([^a-z0-9]|$)`).test(haystack)) return w;
  }
  return null;
}

export type GuardrailViolation = "tope_descuento" | "tope_reembolso" | "tope_cargo_folio" | "tope_destinatarios" | "palabra_bloqueada";

export interface ProposalForGuardrails {
  readonly actionType: ApprovalActionType;
  readonly amountCents?: number | null;
  readonly percent?: number | null;
  readonly recipients?: number | null;
  /** Texto a revisar contra las palabras bloqueadas (contenido + resumen). */
  readonly text?: string | null;
}

/** Topes duros: lo que supera un tope NO llega a un humano (queda bloqueada). Los topes son inclusivos. */
export function evaluateGuardrails(p: ProposalForGuardrails, g: GuardrailsInput = DEFAULT_GUARDRAILS): GuardrailViolation | null {
  if (p.actionType === "descuento_tarifa" && p.percent != null && p.percent > g.maxDiscountPct) return "tope_descuento";
  if (p.actionType === "reembolso" && p.amountCents != null && p.amountCents > g.maxRefundCents) return "tope_reembolso";
  if (p.actionType === "cargo_folio" && p.amountCents != null && p.amountCents > g.maxFolioChargeCents) return "tope_cargo_folio";
  if (p.actionType === "mensaje_masivo" && p.recipients != null && p.recipients > g.maxMassRecipients) return "tope_destinatarios";
  if (firstBlockedWord(p.text, g.blockedWords) !== null) return "palabra_bloqueada";
  return null;
}

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Hora local 'minutos desde medianoche' de un instante en una zona IANA; zona invalida -> America/Mexico_City. */
export function localMinutesOfDay(now: Date, timeZone: string | null): number {
  const read = (tz: string): number => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const hour = Number(parts.find((x) => x.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((x) => x.type === "minute")?.value ?? "0");
    return hour * 60 + minute;
  };
  try {
    return read(timeZone ?? "America/Mexico_City");
  } catch {
    return read("America/Mexico_City");
  }
}

/** Ventana de envio de mensajes masivos: inicio inclusivo, fin exclusivo, en la hora local de la property. */
export function withinSendWindow(now: Date, timeZone: string | null, start: string, end: string): boolean {
  const minutes = localMinutesOfDay(now, timeZone);
  return minutes >= toMinutes(start) && minutes < toMinutes(end);
}

/** Resuelve la politica efectiva de una accion: sin configuracion = siempre humano. */
export function defaultPolicy(actionType: ApprovalActionType): ActionPolicyRecord {
  return { actionType, mode: "siempre_humano", autoMaxPercent: null, autoMaxAmountCents: null, expiresMinutes: 1440, approverRoles: ["owner", "gm"], configured: false, updatedAt: null };
}

/** true = la propuesta del AGENTE cumple el umbral de ejecucion automatica de la politica (borde inclusivo). */
export function qualifiesForAutoApproval(policy: ActionPolicyRecord, p: ProposalForGuardrails): boolean {
  if (policy.mode !== "auto_bajo_umbral") return false;
  if (p.actionType === "descuento_tarifa") return p.percent != null && policy.autoMaxPercent != null && p.percent <= policy.autoMaxPercent;
  if (p.actionType === "reembolso" || p.actionType === "cargo_folio") return p.amountCents != null && policy.autoMaxAmountCents != null && p.amountCents <= policy.autoMaxAmountCents;
  return false;
}

export function guardrailsFrom(record: GuardrailsRecord | GuardrailsInput): GuardrailsInput {
  return {
    maxDiscountPct: record.maxDiscountPct,
    maxRefundCents: record.maxRefundCents,
    maxFolioChargeCents: record.maxFolioChargeCents,
    maxMassRecipients: record.maxMassRecipients,
    blockedWords: record.blockedWords,
    sendWindowStart: record.sendWindowStart,
    sendWindowEnd: record.sendWindowEnd,
  };
}

// ---- compuerta del agente (kill switch + presupuesto propio) ----------------------------------------

export type AgentRunState = "activo" | "pausado" | "presupuesto_agotado";

/** Estado del agente: pausado (kill switch) gana; luego presupuesto agotado (gasto >= tope, borde inclusivo). */
export function agentRunState(gate: AgentGate | null): AgentRunState {
  if (!gate) return "activo";
  if (!gate.enabled) return "pausado";
  if (gate.budgetMicroUsd != null && gate.spentMicroUsd >= gate.budgetMicroUsd) return "presupuesto_agotado";
  return "activo";
}

export const MICRO_USD_PER_USD = 1_000_000;
export function usdToMicroUsd(usd: number): number {
  return Math.round(usd * MICRO_USD_PER_USD);
}
export function microUsdToUsd(micro: number): number {
  return micro / MICRO_USD_PER_USD;
}
export function currentUsageMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}
