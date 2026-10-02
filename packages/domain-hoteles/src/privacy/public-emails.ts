// Correos de la privacidad publica del huesped (H-30): codigo de verificacion de la solicitud ARCO y enlace "mis datos".
// Se encolan en `hoteles.messaging_outbox` (canal email); el envio real lo hace el drenado de Resend. Sin la llave de
// Resend el correo queda `pending` y la UI lo dice honestamente. Todo dato dinamico se escapa.
import { escapeHtml, renderCorreo } from "../emails/layout.ts";
import type { VerificationEmail } from "./public.ts";

const DERECHO_TEXTO: Record<string, string> = { acceso: "acceso", rectificacion: "rectificacion", cancelacion: "cancelacion", oposicion: "oposicion" };

export function correoCodigoArco(input: { readonly to: string; readonly hotelNombre: string; readonly nombre: string; readonly derecho: string; readonly codigo: string; readonly minutos: number }): VerificationEmail {
  const derecho = DERECHO_TEXTO[input.derecho] ?? input.derecho;
  const html = renderCorreo({
    titulo: "Confirma tu solicitud de privacidad",
    preheader: `Tu codigo de verificacion para ${input.hotelNombre}`,
    etiqueta: { texto: "Solicitud de privacidad", color: "#1D4ED8" },
    parrafosHtml: [
      `Hola ${escapeHtml(input.nombre)}, recibimos una solicitud de <strong>${escapeHtml(derecho)}</strong> sobre tus datos personales en <strong>${escapeHtml(input.hotelNombre)}</strong>.`,
      "Para confirmar que eres tu, captura este codigo en la pagina donde hiciste la solicitud:",
    ],
    tabla: { filas: [{ etiqueta: "Codigo", valor: input.codigo }] },
    nota: `El codigo vence en ${input.minutos} minutos y solo se puede usar una vez. Si no hiciste esta solicitud, ignora este correo: no se tramita nada hasta confirmar el codigo.`,
    piePorQueLlego: `Recibes este correo porque alguien indico tu correo en una solicitud de privacidad de ${input.hotelNombre}.`,
  });
  return {
    to: input.to,
    subject: `Tu codigo de verificacion · ${input.hotelNombre}`,
    html,
    text: `Hola ${input.nombre}, recibimos una solicitud de ${derecho} sobre tus datos personales en ${input.hotelNombre}.\nTu codigo de verificacion: ${input.codigo}\nVence en ${input.minutos} minutos y solo se puede usar una vez. Si no hiciste esta solicitud, ignora este correo.`,
  };
}

export function correoMisDatos(input: { readonly to: string; readonly hotelNombre: string; readonly folio: string; readonly url: string; readonly horas: number }): VerificationEmail {
  const html = renderCorreo({
    titulo: "Tus datos personales estan listos",
    preheader: `Respuesta a tu solicitud ${input.folio}`,
    etiqueta: { texto: "Respuesta a tu solicitud", color: "#047857" },
    parrafosHtml: [
      `Tu solicitud de acceso <strong>${escapeHtml(input.folio)}</strong> en <strong>${escapeHtml(input.hotelNombre)}</strong> fue atendida.`,
      `Puedes consultar tus datos en este enlace: <a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a>`,
    ],
    nota: `El enlace es personal y vence en ${input.horas} horas. No lo compartas.`,
    piePorQueLlego: `Recibes este correo porque solicitaste el acceso a tus datos personales en ${input.hotelNombre}.`,
  });
  return {
    to: input.to,
    subject: `Respuesta a tu solicitud ${input.folio} · ${input.hotelNombre}`,
    html,
    text: `Tu solicitud de acceso ${input.folio} en ${input.hotelNombre} fue atendida.\nConsulta tus datos en: ${input.url}\nEl enlace es personal y vence en ${input.horas} horas. No lo compartas.`,
  };
}
