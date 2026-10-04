// Comportamiento del agente de VOZ de Los Taquitos de PM: el MISMO perfil que WhatsApp (`whatsapp/perfil-pm.ts`, reglas H1-H18,
// flujo, escalacion y datos) con el canal `voz` y un apendice propio de la llamada. Una sola fuente: ya no hay un prompt de voz
// sembrado aparte (el `system-prompt.txt` nombraba herramientas que no existen y prometia el combo del martes).
//
// La columna `restaurantes.branch_voice_config.comportamiento` tiene tope de 8000 caracteres (migracion 025), por eso el perfil
// de voz es la version COMPACTA del mismo contenido y este modulo falla en voz alta si se pasa del tope.
import type { BranchSummary } from "../types.ts";
import { buildPmSystemPrompt } from "../whatsapp/perfil-pm.ts";

export const COMPORTAMIENTO_VOZ_MAX = 8000;

export const APENDICE_VOZ = `
# LLAMADA (voz)
- Una o dos frases por turno, sin listas ni emojis. Importes en palabras; teléfonos en grupos de 3-3-4.
- Si lo interrumpen, calle y atienda; si el cliente se corrige, use lo último y vuelva a cotizar.
- Si no entiende dos veces seguidas o falla el sistema: escalar_a_humano.`;

export interface EntradaComportamientoVoz {
  readonly businessName: string;
  readonly agentName: string;
  readonly deliveryTimeText: string;
  readonly branches: readonly BranchSummary[];
  readonly salsasTexto?: string | null;
  readonly promosTexto?: string | null;
  readonly motivosDesactivados?: readonly string[];
}

/** Texto FIJO que se siembra en `branch_voice_config.comportamiento`. No sabe la hora ni la sucursal de entrada (es el mismo
 * para todas): el modelo consulta `consultar_sucursal` y el saludo por hora lo da el sistema. */
export function comportamientoVozPm(e: EntradaComportamientoVoz): string {
  const texto =
    buildPmSystemPrompt({
      canal: "voz",
      businessName: e.businessName,
      agentName: e.agentName,
      deliveryTimeText: e.deliveryTimeText,
      saludo: "",
      branches: e.branches,
      entryBranch: null,
      customer: { isNew: true },
      saludoPersonalizado: null,
      salsasTexto: e.salsasTexto ?? null,
      promosTexto: e.promosTexto ?? null,
      motivosDesactivados: e.motivosDesactivados ?? [],
    }) + APENDICE_VOZ;
  if (texto.length > COMPORTAMIENTO_VOZ_MAX) {
    throw new RangeError(`El comportamiento de voz mide ${texto.length} caracteres; el maximo de branch_voice_config.comportamiento es ${COMPORTAMIENTO_VOZ_MAX} (migracion 025).`);
  }
  return texto;
}
