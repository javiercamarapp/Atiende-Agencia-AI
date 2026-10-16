// Guardia DETERMINISTA de la voz de restaurantes: si el cliente PIDE hablar con una persona ("comuníqueme con una persona", "quiero hablar con un
// humano"), la llamada pasa a una persona sin depender de que el modelo lo haga (en WhatsApp la guardia equivalente corre antes del modelo; en voz
// solo el DTMF 0 era determinista). El controlador de voice-core la corre en cada habla inteligible ANTES de que el modelo la reciba: interrumpe al
// agente, dice el texto TAL CUAL, escala con `escalar_a_humano` (motivo `cliente_lo_pide`) y cierra la llamada como `escalado`.
import type { DecisionGuardiaCliente, GuardiaCliente } from "@atiende/voice-core";
import { classifyHighRiskIntent, pideUnaPersona } from "../whatsapp/guards.ts";

export const MOTIVO_PERSONA_VOZ = "cliente_lo_pide";
export const TEXTO_PERSONA_VOZ = "Con gusto. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.";

/** La parte pura de la guardia (sin `decir`): sin datos del cliente en el motivo ni en el resumen. Si el mismo texto trae un motivo mas
 * especifico (queja, alergia, cobro...), se escala con ese motivo y su respuesta, igual que en WhatsApp; si no, `cliente_lo_pide`. */
export function evaluarPersonaVoz(texto: string): DecisionGuardiaCliente | null {
  if (!pideUnaPersona(texto)) return null;
  const riesgo = classifyHighRiskIntent(texto);
  if (riesgo) return { texto: riesgo.reply, motivo: riesgo.motivo, resumen: `El cliente pidió hablar con una persona (${riesgo.motivo}).` };
  return { texto: TEXTO_PERSONA_VOZ, motivo: MOTIVO_PERSONA_VOZ, resumen: "El cliente pidió hablar con una persona." };
}

/** La guardia completa para una llamada real; `decir` reproduce el texto con la sintesis local. */
export function crearGuardiaPersonaVoz(decir: GuardiaCliente["decir"]): GuardiaCliente {
  return { evaluar: evaluarPersonaVoz, decir };
}
