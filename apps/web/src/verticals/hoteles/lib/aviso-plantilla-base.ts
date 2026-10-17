// H-P3-03 -- plantilla BASE del aviso de privacidad de un hotel: declara los encargados y las transferencias que la plataforma realmente hace
// (proveedor de LLM via OpenRouter, Meta/WhatsApp, Google y LiveKit para voz, PAC, Stripe y Resend). Es un PUNTO DE PARTIDA: lleva la etiqueta
// visible «requiere revisión legal» y NUNCA se publica sola; solo llena el formulario de "Publicar versión nueva", que el hotel revisa y publica.
export const ETIQUETA_REVISION_LEGAL = "Requiere revisión legal";

export interface EncargadoTransferencia {
  readonly proveedor: string;
  readonly finalidad: string;
}

/** Terceros a los que el tratamiento recurre (encargados) o a quienes se transfieren datos. Mantener sincronizado con las integraciones reales. */
export const ENCARGADOS_Y_TRANSFERENCIAS: readonly EncargadoTransferencia[] = [
  { proveedor: "Proveedor de modelos de lenguaje vía OpenRouter", finalidad: "asistente de inteligencia artificial que atiende mensajes" },
  { proveedor: "Meta / WhatsApp", finalidad: "mensajería con el huésped" },
  { proveedor: "Google y LiveKit", finalidad: "llamadas de voz atendidas por el asistente" },
  { proveedor: "Proveedor autorizado de certificación (PAC)", finalidad: "timbrado de comprobantes fiscales (CFDI)" },
  { proveedor: "Stripe", finalidad: "procesamiento de pagos" },
  { proveedor: "Resend", finalidad: "envío de correo electrónico" },
];

export interface PlantillaBaseAviso {
  readonly textoSimplificado: string;
  readonly finalidadesObligatorias: readonly string[];
  readonly finalidadesOpcionales: readonly string[];
}

export function plantillaBaseAviso(): PlantillaBaseAviso {
  const encargados = ENCARGADOS_Y_TRANSFERENCIAS.map((e) => `${e.proveedor} (${e.finalidad})`).join("; ");
  return {
    textoSimplificado:
      "El hotel, como responsable, trata tus datos personales (nombre, contacto, fechas de estancia, datos de tu reserva y de facturación y, cuando los proporcionas, tu identificación) " +
      "para gestionar tu reserva y tu estancia. Para ello recurre a terceros que tratan datos por cuenta del hotel o a quienes se transfieren datos cuando es necesario: " +
      `${encargados}. ` +
      "Puedes ejercer tus derechos de acceso, rectificación, cancelación y oposición (ARCO) y revocar tu consentimiento por los medios indicados en el aviso integral.",
    finalidadesObligatorias: ["Gestionar tu reserva, tu estancia y tu facturación", "Atenderte por WhatsApp, llamada o correo, incluido el asistente de inteligencia artificial"],
    finalidadesOpcionales: ["Enviarte avisos antes de tu llegada y después de tu estancia, con invitación a dejar una reseña"],
  };
}
