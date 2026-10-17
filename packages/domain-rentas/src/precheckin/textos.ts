// Rn-P3-08 -- textos del pre-check-in: aviso de privacidad que ve el huesped y mensaje sugerido para los «mensajes programados» de la OTA.
// El texto legal definitivo del aviso lo decide Javier (por omision NO se pide identificacion oficial: minimizacion de datos).
import { AVISO_PRECHECKIN_VERSION } from "./tipos.ts";

export interface AvisoPrecheckin {
  readonly version: string;
  readonly titulo: string;
  readonly parrafos: readonly string[];
}

export function avisoPrivacidadPrecheckin(organizacionNombre: string): AvisoPrecheckin {
  return {
    version: AVISO_PRECHECKIN_VERSION,
    titulo: "Aviso de privacidad del pre-check-in",
    parrafos: [
      `${organizacionNombre} es responsable de los datos que captures aqui.`,
      "Pedimos tu correo (obligatorio) y tu WhatsApp (opcional) para enviarte las instrucciones de acceso a la propiedad y avisos sobre tu estancia. No pedimos identificacion oficial.",
      "Conservamos estos datos mientras dure tu estancia y el plazo de retencion de la organizacion; despues se eliminan o se anonimizan.",
      "Puedes ejercer tus derechos de acceso, rectificacion, cancelacion y oposicion escribiendo a la gestora de la propiedad.",
    ],
  };
}

/** Texto para pegar UNA vez en los mensajes programados de Airbnb o Booking (esa configuracion es nativa de la OTA y no requiere API). */
export function textoSugeridoPrecheckin(url: string): string {
  return [
    "Hola, para agilizar tu llegada completa tu pre-check-in en este enlace:",
    url,
    "Te pediremos el codigo de confirmacion de tu reserva y los ultimos 4 digitos de tu telefono. Con tu correo te enviaremos las instrucciones de acceso antes de tu llegada.",
  ].join("\n");
}
