// Reglas de la encuesta post-entrega (huecos-finales-restaurantes, seccion 6), como constantes y funciones PURAS para
// que `r41-encuesta-post-entrega` las use sin reinventarlas. Aqui NO se envia nada ni se toca la base.
//
//  * Se manda de 2 a 3 h despues de `delivered_at`, nunca entre 23:00 y 9:00 (hora de la organizacion), una vez por
//    pedido y como maximo una cada 14 dias por cliente.
//  * Pregunta de 1 a 5.
//  * Con >= 4 se invita a resenar en Google (link de la sucursal, si existe). Con <= 3 se abre una recuperacion
//    privada: callback con motivo `encuesta_baja` y aviso al gerente; NUNCA se envia a Google.
//  * PROHIBIDO condicionar o incentivar la resena ("le damos X si deja 5 estrellas"): `contieneIncentivoDeResena`
//    lo detecta y es lo que verifica la bateria de textos del test.
import { componentesLocales } from "./horarios.ts";

export const ENCUESTA_ESPERA_MIN_HORAS = 2;
export const ENCUESTA_ESPERA_MAX_HORAS = 3;
/** Horas locales vedadas: de las 23:00 (inclusive) a las 9:00 (exclusive). */
export const ENCUESTA_SILENCIO_DESDE_HORA = 23;
export const ENCUESTA_SILENCIO_HASTA_HORA = 9;
export const ENCUESTA_DIAS_MIN_ENTRE_ENCUESTAS_POR_CLIENTE = 14;
export const ENCUESTA_ESCALA_MIN = 1;
export const ENCUESTA_ESCALA_MAX = 5;
/** Calificacion a partir de la cual se invita a resenar en Google. */
export const ENCUESTA_UMBRAL_INVITAR_RESENA = 4;
export const ENCUESTA_CALLBACK_MOTIVO_BAJA = "encuesta_baja";

const HORA_MS = 60 * 60 * 1000;
const PASO_MS = 15 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

/** true si `instante` cae en las horas de silencio (23:00-8:59) en la zona horaria de la organizacion. */
export function enHorasDeSilencio(instante: Date, zonaHoraria: string | null | undefined): boolean {
  const { minutos } = componentesLocales(instante, zonaHoraria ?? "America/Mexico_City");
  const hora = Math.floor(minutos / 60);
  return hora >= ENCUESTA_SILENCIO_DESDE_HORA || hora < ENCUESTA_SILENCIO_HASTA_HORA;
}

export type DecisionEnvioEncuesta =
  | { readonly enviar: true; readonly enviarDespuesDe: Date; readonly fueraDeVentana: boolean }
  | { readonly enviar: false; readonly motivo: "pedido_ya_encuestado" | "cliente_encuestado_recientemente" };

/**
 * Cuando mandar la encuesta de un pedido entregado en `deliveredAt`. Regla base: `delivered_at + 2 h`. Si ese
 * instante cae entre 23:00 y 9:00 locales, se pospone a las 9:00 locales (primer paso de 15 min ya fuera del silencio);
 * `fueraDeVentana` avisa que el envio quedo despues de las 3 h a proposito. Una vez por pedido y una cada 14 dias por
 * cliente: sin esas dos condiciones no se envia.
 */
export function decidirEnvioEncuesta(args: {
  readonly deliveredAt: Date;
  readonly zonaHoraria: string | null | undefined;
  readonly pedidoYaEncuestado: boolean;
  readonly ultimaEncuestaCliente: Date | null;
}): DecisionEnvioEncuesta {
  if (args.pedidoYaEncuestado) return { enviar: false, motivo: "pedido_ya_encuestado" };
  const base = new Date(args.deliveredAt.getTime() + ENCUESTA_ESPERA_MIN_HORAS * HORA_MS);
  if (args.ultimaEncuestaCliente && base.getTime() - args.ultimaEncuestaCliente.getTime() < ENCUESTA_DIAS_MIN_ENTRE_ENCUESTAS_POR_CLIENTE * DIA_MS) {
    return { enviar: false, motivo: "cliente_encuestado_recientemente" };
  }
  let candidato = base;
  // Maximo 24 h de busqueda (96 pasos de 15 min): el silencio dura 10 h, siempre hay salida.
  for (let i = 0; i < 96 && enHorasDeSilencio(candidato, args.zonaHoraria); i += 1) candidato = new Date(candidato.getTime() + PASO_MS);
  const limite = args.deliveredAt.getTime() + ENCUESTA_ESPERA_MAX_HORAS * HORA_MS;
  return { enviar: true, enviarDespuesDe: candidato, fueraDeVentana: candidato.getTime() > limite };
}

export type AccionEncuesta =
  | { readonly tipo: "invitar_resena_google"; readonly enviarAGoogle: true }
  | { readonly tipo: "recuperacion_privada"; readonly enviarAGoogle: false; readonly callbackMotivo: typeof ENCUESTA_CALLBACK_MOTIVO_BAJA; readonly avisarGerente: true };

/** Califica 1 a 5 (entero). >= 4 invita a resenar; <= 3 abre recuperacion privada y NO va a Google. Fuera de rango lanza. */
export function accionSegunCalificacion(calificacion: number): AccionEncuesta {
  if (!Number.isInteger(calificacion) || calificacion < ENCUESTA_ESCALA_MIN || calificacion > ENCUESTA_ESCALA_MAX) {
    throw new RangeError(`La calificacion debe ser un entero de ${ENCUESTA_ESCALA_MIN} a ${ENCUESTA_ESCALA_MAX}.`);
  }
  if (calificacion >= ENCUESTA_UMBRAL_INVITAR_RESENA) return { tipo: "invitar_resena_google", enviarAGoogle: true };
  return { tipo: "recuperacion_privada", enviarAGoogle: false, callbackMotivo: ENCUESTA_CALLBACK_MOTIVO_BAJA, avisarGerente: true };
}

const SIN_ACENTOS = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Patrones de incentivo o condicion sobre una resena (texto ya sin acentos y en minusculas). */
const PATRONES_INCENTIVO: readonly RegExp[] = [
  /\b(descuento|regalo|regalamos|obsequio|cortesia|premio|sorteo|rifa|cupon|promocion|gratis|bono|vale)\b/,
  /\b(a cambio|en agradecimiento por (la|su) resena|le damos|te damos|le daremos|te daremos|le obsequiamos|le ofrecemos)\b/,
  /\b(si|solo si|siempre que|cuando)\b[^.!?]{0,60}\b(5|cinco)\s*estrellas\b/,
  /\b(5|cinco)\s*estrellas\b[^.!?]{0,40}\b(y|para|por)\b[^.!?]{0,40}\b(recib|gana|obten|llev)/,
  /\b(deje|dejar|ponga|poner|califique con|dar|de)\b[^.!?]{0,30}\b(5|cinco)\s*estrellas\b/,
  /\b(resena|opinion|calificacion)\b[^.!?]{0,40}\b(positiva|favorable|buena|perfecta)\b/,
];

/** true si el texto condiciona o incentiva la resena. La invitacion y la encuesta NUNCA deben contenerlo. */
export function contieneIncentivoDeResena(texto: string): boolean {
  const limpio = SIN_ACENTOS(texto);
  return PATRONES_INCENTIVO.some((p) => p.test(limpio));
}

/** Texto de invitacion a resenar (trato de usted, sin incentivo ni condicion). Sin link de Google no se envia nada. */
export function textoInvitacionResenaGoogle(args: { readonly nombreSucursal: string; readonly urlResenaGoogle: string | null }): string | null {
  if (!args.urlResenaGoogle || !/^https:\/\//.test(args.urlResenaGoogle)) return null;
  return `Gracias por su calificación. Si lo desea, puede compartir su opinión sobre ${args.nombreSucursal} en Google: ${args.urlResenaGoogle}`;
}

/** Texto de la recuperacion privada (<= 3): nunca menciona Google ni resenas. */
export function textoRecuperacionPrivada(nombreSucursal: string): string {
  return `Lamentamos que su pedido en ${nombreSucursal} no haya sido como esperaba. Una persona de la sucursal le llamará para atenderle. Si prefiere, cuéntenos qué pasó respondiendo a este mensaje.`;
}
