// Seccion "Encargados y transferencias" del aviso de privacidad (huecos-finales-restaurantes seccion 7, C-17). Lista los proveedores
// que de verdad procesan datos de la organizacion segun su configuracion REAL (no una lista fija): el agente de WhatsApp o de voz usa un
// modelo de lenguaje via OpenRouter (con retencion cero cuando el modelo lo ofrece) y corre sobre Vercel y Supabase; la voz usa ElevenLabs
// (Scribe v2 Realtime + v4 Turbo; decision del dueno 6-nov-2026, retiene audio y texto por omision) con Deepgram de respaldo, Gemini en
// algunas configuraciones, Twilio, LiveKit y el worker en Fly.io; el canal de WhatsApp pasa por Meta. Krisp NO se lista: el filtro de
// ruido corre dentro del worker y no manda audio a un tercero.
//
// BORRADOR: el texto lo escribio un desarrollador, NO un abogado. Siempre se devuelve marcado como borrador con la revision legal
// pendiente; el pais es la sede del proveedor y el lugar exacto del tratamiento debe confirmarlo la revision legal.
export type EncargadoId = "openrouter" | "elevenlabs" | "deepgram" | "gemini" | "twilio" | "livekit" | "fly_io" | "meta_whatsapp" | "supabase" | "vercel";

export interface EncargadoTransferencia {
  readonly id: EncargadoId;
  readonly proveedor: string;
  readonly finalidad: string;
  /** Pais donde tiene su sede el proveedor (referencia; el lugar del tratamiento lo confirma la revision legal). */
  readonly pais: string;
  /** Politica de privacidad del proveedor cuando conserva datos por su cuenta (no se inventan plazos: se enlaza su politica). */
  readonly politicaPropia?: string;
}

export interface ConfiguracionEncargados {
  /** El canal de WhatsApp de la organizacion tiene un numero conectado. */
  readonly whatsappConectado: boolean;
  /** Alguna sucursal tiene el agente de voz habilitado. */
  readonly vozHabilitada: boolean;
}

export interface SeccionEncargados {
  readonly borrador: true;
  readonly revisionLegalPendiente: true;
  readonly aviso: string;
  readonly encargados: readonly EncargadoTransferencia[];
}

const CATALOGO: Readonly<Record<EncargadoId, EncargadoTransferencia>> = {
  openrouter: { id: "openrouter", proveedor: "OpenRouter y los modelos de lenguaje que enruta", finalidad: "Entender los mensajes, las notas de voz y las llamadas para tomar su pedido, con retención cero de datos cuando el modelo lo ofrece.", pais: "Estados Unidos" },
  elevenlabs: {
    id: "elevenlabs",
    proveedor: "ElevenLabs (Eleven Labs Inc.)",
    finalidad: "Convertir en texto el audio de la llamada (con lo que usted diga: nombre, dirección, teléfono, pedido) y generar la voz del asistente. Puede conservarlos según su propia política de privacidad.",
    pais: "Estados Unidos",
    politicaPropia: "https://elevenlabs.io/privacy-policy",
  },
  deepgram: { id: "deepgram", proveedor: "Deepgram", finalidad: "Respaldo de ElevenLabs: convertir voz en texto y texto en voz si ElevenLabs falla.", pais: "Estados Unidos" },
  gemini: { id: "gemini", proveedor: "Google (Gemini)", finalidad: "Modelo de lenguaje y, en algunas configuraciones, voz del asistente.", pais: "Estados Unidos" },
  twilio: { id: "twilio", proveedor: "Twilio", finalidad: "Recibir y transportar las llamadas telefónicas.", pais: "Estados Unidos" },
  livekit: { id: "livekit", proveedor: "LiveKit", finalidad: "Transmitir el audio de la llamada en tiempo real.", pais: "Estados Unidos" },
  fly_io: { id: "fly_io", proveedor: "Fly.io", finalidad: "Servidores donde corre el asistente de voz.", pais: "Estados Unidos" },
  meta_whatsapp: { id: "meta_whatsapp", proveedor: "Meta (WhatsApp)", finalidad: "Enviar y recibir los mensajes de WhatsApp.", pais: "Estados Unidos" },
  supabase: { id: "supabase", proveedor: "Supabase", finalidad: "Base de datos donde se guardan sus pedidos y conversaciones.", pais: "Estados Unidos" },
  vercel: { id: "vercel", proveedor: "Vercel", finalidad: "Alojamiento de la aplicación y del asistente de WhatsApp.", pais: "Estados Unidos" },
};

export const AVISO_BORRADOR_ENCARGADOS =
  "BORRADOR pendiente de revisión legal. Para atenderle, algunos proveedores tratan sus datos por cuenta del restaurante. " +
  "Estos proveedores solo los usan para prestar el servicio indicado y no para otros fines.";

/** Proveedores en uso segun la configuracion real; vacio = la organizacion no usa ninguno (solo pedidos en linea). */
export function encargadosEnUso(config: ConfiguracionEncargados): readonly EncargadoTransferencia[] {
  const ids: EncargadoId[] = [];
  if (config.whatsappConectado || config.vozHabilitada) ids.push("openrouter");
  if (config.vozHabilitada) ids.push("elevenlabs", "deepgram", "gemini", "twilio", "livekit", "fly_io");
  if (config.whatsappConectado) ids.push("meta_whatsapp");
  if (config.whatsappConectado || config.vozHabilitada) ids.push("supabase", "vercel");
  return ids.map((id) => CATALOGO[id]);
}

export function seccionEncargados(config: ConfiguracionEncargados): SeccionEncargados {
  return { borrador: true, revisionLegalPendiente: true, aviso: AVISO_BORRADOR_ENCARGADOS, encargados: encargadosEnUso(config) };
}
