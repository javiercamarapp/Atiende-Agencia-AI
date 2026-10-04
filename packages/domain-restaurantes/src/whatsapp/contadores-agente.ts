// Contadores DETERMINISTAS del agente de WhatsApp (rescate-orig-restaurantes-1 §3, P11 y P32). En voz la maquina de la llamada ya cuenta los
// malentendidos (`malentendidosMax: 2`); en WhatsApp dependia de que el modelo siguiera el prompt ("colonia no reconocida dos veces -> escalar").
// Aqui el SERVIDOR cuenta, entre turnos (migracion 043, `whatsapp_conversations.agent_counters`), y al llegar a 2 escala por su cuenta.
import type { RestaurantesRepository } from "../repository.ts";

export type ClaveContadorAgente = "colonia_no_reconocida" | "no_entiende";

/** Con este numero de intentos seguidos el servidor escala (el mismo "dos veces" del prompt y de la maquina de voz). */
export const CONTADOR_AGENTE_UMBRAL = 2;

/** Textos fijos (siempre de usted, nunca prometen resultado) con que el servidor responde cuando escala por contador. */
export const COPY_ESCALACION_CONTADOR = {
  zona_no_reconocida: "No logro ubicar su colonia con lo que me indica. Permítame avisar al gerente de la sucursal para que le ayude; en un momento le responden.",
  no_entiende: "Disculpe, no logro entender bien su mensaje. Permítame avisar al gerente de la sucursal para que le ayude; en un momento le responden.",
} as const;

/** La respuesta del modelo pide repetir o dice que no entendio ("¿me puede repetir...?", "no le entendí"). Conservador: solo frases claras. */
export function pideRepetir(texto: string): boolean {
  return /\b(no (le )?entend[ií]|no (logro|alcanc[eé])( a)? (entender|escuchar)|me (puede|podr[ií]a) repetir|puede repetir(me)?|podr[ií]a repetir(me)?|repita(me)? (por favor|su)|¿me repite)/i.test(texto);
}

/** Cuenta (o reinicia) y devuelve el valor; `null` = no hay donde contar (base sin migrar): el llamador usa su cuenta local del turno. */
export async function contarAgente(repo: RestaurantesRepository, organizationId: string, phone: string, clave: ClaveContadorAgente, accion: "incrementar" | "reiniciar"): Promise<number | null> {
  return repo.contadorAgenteWhatsApp(organizationId, phone, clave, accion);
}
