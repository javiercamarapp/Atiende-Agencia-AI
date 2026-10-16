// Guardia DETERMINISTA de la voz de restaurantes: si el cliente PIDE hablar con una persona ("comuníqueme con una persona", "quiero hablar con un
// humano") O dice una senal de riesgo (alergia, cobro doble, queja, urgencia, ARCO), la llamada pasa a una persona sin depender de que el modelo lo haga (en WhatsApp la guardia equivalente corre antes del modelo; en voz
// solo el DTMF 0 era determinista). El controlador de voice-core la corre en cada habla inteligible ANTES de que el modelo la reciba: interrumpe al
// agente, dice el texto TAL CUAL, escala con `escalar_a_humano` (motivo `cliente_lo_pide`) y cierra la llamada como `escalado`.
import type { DecisionGuardiaCliente, GuardiaCliente } from "@atiende/voice-core";
import { classifyHighRiskIntent, pideUnaPersona } from "../whatsapp/guards.ts";

export const MOTIVO_PERSONA_VOZ = "cliente_lo_pide";
export const TEXTO_PERSONA_VOZ = "Con gusto. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.";

/** Motivos de alto riesgo que la voz escala SIN que el cliente pida una persona. `cancelacion_modificacion` queda fuera a proposito: necesita contexto de pedido
 * (el telefono de la llamada, un pedido vigente) que esta guardia pura no tiene, y por voz la cancelacion la maneja el agente con sus herramientas. */
const MOTIVOS_VOZ_SIN_PEDIR_PERSONA: ReadonlySet<string> = new Set(["alergia_salud", "cobro_duplicado", "privacidad_arco", "queja", "urgencia"]);

/** Motivo de riesgo (de los permitidos) que trae el texto, o null. La primera pasada usa el contexto vacio; si lo que gana es un motivo NO permitido (cancelacion
 * sin contexto de pedido), se reintenta con "sin pedido reciente" para no taparle una queja o alergia que viene despues en la misma frase. */
function riesgoDeVoz(texto: string) {
  const primero = classifyHighRiskIntent(texto);
  if (primero && MOTIVOS_VOZ_SIN_PEDIR_PERSONA.has(primero.motivo)) return primero;
  if (!primero) return null;
  const segundo = classifyHighRiskIntent(texto, { pedidoReciente: null });
  return segundo && MOTIVOS_VOZ_SIN_PEDIR_PERSONA.has(segundo.motivo) ? segundo : null;
}

/** La parte pura de la guardia (sin `decir`): sin datos del cliente en el motivo ni en el resumen. En CUALQUIER habla inteligible consulta el clasificador de alto
 * riesgo (alergia, cobro doble, ARCO, queja, urgencia) y escala con su respuesta fija, igual que WhatsApp antes del modelo (R11-17: con Gemini Live un aviso de
 * alergia improvisado colgo sin avisar al equipo). Si ademas pide una persona, el resumen lo dice; si solo pide una persona, `cliente_lo_pide`. */
export function evaluarPersonaVoz(texto: string): DecisionGuardiaCliente | null {
  if (typeof texto !== "string" || texto.trim() === "") return null;
  const pide = pideUnaPersona(texto);
  const riesgo = riesgoDeVoz(texto);
  if (riesgo) return { texto: riesgo.reply, motivo: riesgo.motivo, resumen: pide ? `El cliente pidió hablar con una persona (${riesgo.motivo}).` : `Señal de riesgo en la llamada (${riesgo.motivo}).` };
  if (!pide) return null;
  return { texto: TEXTO_PERSONA_VOZ, motivo: MOTIVO_PERSONA_VOZ, resumen: "El cliente pidió hablar con una persona." };
}

/** La guardia completa para una llamada real; `decir` reproduce el texto con la sintesis local. */
export function crearGuardiaPersonaVoz(decir: GuardiaCliente["decir"]): GuardiaCliente {
  return { evaluar: evaluarPersonaVoz, decir };
}
