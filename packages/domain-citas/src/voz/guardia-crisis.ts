// Guardia de CRISIS de la voz de citas: la misma regla determinista que en WhatsApp (`crisis-guardrail.ts`: mismas palabras clave, mismo mensaje,
// solo rubros de salud) aplicada a lo que DICE el cliente, ANTES de que el modelo lo reciba o conteste (el controlador de voice-core la corre en cada
// habla inteligible). Nunca la decide el modelo. Al activarse, el core interrumpe al agente, dice `CRISIS_ESCALATION_MESSAGE` TAL CUAL, escala con
// `derivar_a_humano` (motivo `crisis`) y cierra la llamada como `escalado`; el servidor registra la escalacion (`citas.emergency_escalations`, canal
// 'voice') con `derivarAHumanoVoz`.
import type { GuardiaCliente, DecisionGuardiaCliente } from "@atiende/voice-core";
import { CRISIS_ESCALATION_MESSAGE, detectCrisisKeyword, requiresCrisisGuardrail } from "../vertical-config.ts";

/** Motivo con el que la guardia escala; el servidor lo reconoce y registra la escalacion de crisis. */
export const MOTIVO_CRISIS_VOZ = "crisis";
/** El resumen de la escalacion lleva la palabra clave tras este prefijo (solo una palabra de CRISIS_KEYWORDS se acepta; cualquier otro texto se descarta). */
export const PREFIJO_PALABRA_CLAVE = "palabra_clave:";

/** Una guardia de crisis para esta llamada, o null si el rubro del negocio no la requiere (misma regla que WhatsApp). */
export function crearGuardiaCrisisVoz(rubro: string | null | undefined, decir: GuardiaCliente["decir"]): GuardiaCliente | null {
  if (!rubro || !requiresCrisisGuardrail(rubro)) return null;
  return { evaluar: evaluarCrisisVoz, decir };
}

/** La parte pura de la guardia (sin `decir`), para el simulador. */
export function evaluarCrisisVoz(texto: string): DecisionGuardiaCliente | null {
  const palabra = detectCrisisKeyword(texto);
  if (!palabra) return null;
  return { texto: CRISIS_ESCALATION_MESSAGE, motivo: MOTIVO_CRISIS_VOZ, resumen: `${PREFIJO_PALABRA_CLAVE}${palabra}` };
}
