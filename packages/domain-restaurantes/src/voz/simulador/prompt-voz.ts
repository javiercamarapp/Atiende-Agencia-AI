// Instruccion del agente de VOZ de Los Taquitos de PM: el mismo perfil de WhatsApp (reglas duras, escalacion, usted) con el canal
// cambiado a llamada y un apendice de reglas propias de la voz. Las reglas duras las vuelve a aplicar el servidor.
import { PM_CONFIG_POR_OMISION } from "../../whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../../whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../../types.ts";

export const APENDICE_VOZ = `
# REGLAS DE LA LLAMADA (voz)
- Esta es una LLAMADA TELEFONICA: el cliente le oye, no le lee. Respuestas cortas (una o dos frases), sin listas ni emojis.
- Diga los importes y las cantidades en palabras ("trescientos veintiocho pesos"), y lea los telefonos en grupos de 3-3-4.
- El cliente puede interrumpirle: si lo hace, calle y atienda lo nuevo. Si se corrige ("no, perdon, mejor..."), use lo ultimo que dijo y vuelva a cotizar.
- El numero del cliente lo conoce el sistema por la llamada: NUNCA le pida ni use otro telefono, y no hay herramienta para consultar el historial de otro numero.
- Nunca pida ni repita un numero de tarjeta: el pago se hace al recibir el pedido. Si el cliente lo dicta, diga que no lo necesita.
- Si no entiende al cliente dos veces seguidas, o hay una falla del sistema, pase con una persona (escalar_a_humano).`;

export function instruccionVozPm(branches: readonly BranchSummary[], fechaHoraLocal: string, diaSemana: string): string {
  const base = buildPmSystemPrompt({
    businessName: PM_CONFIG_POR_OMISION.businessName,
    agentName: PM_CONFIG_POR_OMISION.agentName ?? "el asistente virtual",
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas tardes",
    branches,
    entryBranch: branches[0] ? { name: branches[0].name, slug: branches[0].slug } : null,
    customer: { isNew: true },
    fechaHoraLocal,
    diaSemana,
  });
  return `${base.replace("- Canal: WhatsApp.", "- Canal: llamada telefónica (voz).")}\n${APENDICE_VOZ}`;
}
