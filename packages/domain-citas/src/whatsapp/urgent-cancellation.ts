// C-03 -- cancelación con urgencia explícita. Port de `isUrgentCancellationMessage`
// (citas-reservaciones/supabase/functions/_shared/intent-fastpath-core.ts).
//
// NO es un guardrail que responde fijo (a diferencia de crisis/ARCO): solo marca que el
// primer turno del agente debe FORZAR `tool_choice = buscar_mis_citas`, para que un
// cliente que avisa con prisa ("urgente, ya no voy a poder llegar, cancela mi cita")
// nunca dependa de que el modelo decida empezar por la herramienta correcta. Requiere
// AMBAS señales (intención real de cancelar + urgencia explícita): "quiero cancelar mi
// cita" a secas es una cancelación normal y se queda a discreción del flujo habitual.
import { normalizeForCrisisCheck } from "../vertical-config.ts";

const CANCELLATION_PHRASES: readonly string[] = [
  "cancelar mi cita",
  "cancela mi cita",
  "cancelen mi cita",
  "anular mi cita",
  "anula mi cita",
  "ya no puedo ir",
  "ya no voy a poder ir",
  "ya no voy a poder llegar",
  "no voy a poder llegar",
  "no voy a poder ir",
];

const URGENCY_PHRASES: readonly string[] = [
  "urgente",
  "urgencia",
  "es una emergencia",
  "ahora mismo",
  "ahorita mismo",
  "lo antes posible",
  "ya no voy a llegar",
  "se me hizo tardisimo",
  "se me hizo muy tarde",
];

/** true solo si el mensaje trae, a la vez, una frase real de cancelación Y una de
 * urgencia -- nunca por una sola señal aislada (un "cancela mi cita para el jueves"
 * tranquilo, o un "urgente que me confirmen" que no habla de cancelar, no la activan). */
export function isUrgentCancellationMessage(message: string): boolean {
  const normalized = normalizeForCrisisCheck(message ?? "");
  if (!CANCELLATION_PHRASES.some((phrase) => normalized.includes(phrase))) return false;
  return URGENCY_PHRASES.some((phrase) => normalized.includes(phrase));
}
