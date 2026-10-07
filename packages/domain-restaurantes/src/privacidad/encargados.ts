// Seccion "Encargados y transferencias" del aviso de privacidad (huecos-finales-restaurantes seccion 7, C-17). Lista los proveedores
// que de verdad procesan datos de la organizacion segun su configuracion REAL (no una lista fija): el agente de WhatsApp o de voz usa un
// modelo de lenguaje via OpenRouter; la voz usa Gemini (voz), Twilio y LiveKit; el canal de WhatsApp pasa por Meta.
//
// BORRADOR: el texto lo escribio un desarrollador, NO un abogado. Siempre se devuelve marcado como borrador con la revision legal
// pendiente; el pais es la sede del proveedor y el lugar exacto del tratamiento debe confirmarlo la revision legal.
export type EncargadoId = "openrouter" | "gemini" | "twilio" | "livekit" | "meta_whatsapp";

export interface EncargadoTransferencia {
  readonly id: EncargadoId;
  readonly proveedor: string;
  readonly finalidad: string;
  /** Pais donde tiene su sede el proveedor (referencia; el lugar del tratamiento lo confirma la revision legal). */
  readonly pais: string;
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
  openrouter: { id: "openrouter", proveedor: "OpenRouter (modelos de lenguaje)", finalidad: "Entender los mensajes y las llamadas del asistente virtual para tomar su pedido.", pais: "Estados Unidos" },
  gemini: { id: "gemini", proveedor: "Google Gemini (voz)", finalidad: "Convertir la voz de la llamada en texto y generar la voz del asistente.", pais: "Estados Unidos" },
  twilio: { id: "twilio", proveedor: "Twilio", finalidad: "Recibir y transportar las llamadas telefónicas.", pais: "Estados Unidos" },
  livekit: { id: "livekit", proveedor: "LiveKit", finalidad: "Transmitir el audio de la llamada en tiempo real.", pais: "Estados Unidos" },
  meta_whatsapp: { id: "meta_whatsapp", proveedor: "Meta (WhatsApp)", finalidad: "Enviar y recibir los mensajes de WhatsApp.", pais: "Estados Unidos" },
};

export const AVISO_BORRADOR_ENCARGADOS =
  "BORRADOR pendiente de revisión legal. Para atenderle, algunos proveedores tratan sus datos por cuenta del restaurante. " +
  "Estos proveedores solo los usan para prestar el servicio indicado y no para otros fines.";

/** Proveedores en uso segun la configuracion real; vacio = la organizacion no usa ninguno (solo pedidos en linea). */
export function encargadosEnUso(config: ConfiguracionEncargados): readonly EncargadoTransferencia[] {
  const ids: EncargadoId[] = [];
  if (config.whatsappConectado || config.vozHabilitada) ids.push("openrouter");
  if (config.vozHabilitada) ids.push("gemini", "twilio", "livekit");
  if (config.whatsappConectado) ids.push("meta_whatsapp");
  return ids.map((id) => CATALOGO[id]);
}

export function seccionEncargados(config: ConfiguracionEncargados): SeccionEncargados {
  return { borrador: true, revisionLegalPendiente: true, aviso: AVISO_BORRADOR_ENCARGADOS, encargados: encargadosEnUso(config) };
}
