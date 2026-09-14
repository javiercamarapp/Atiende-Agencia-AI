import type { CanalMensajeriaCodigo } from "./tipos.ts";

/**
 * Políticas de canal — port de rentas/packages/domain/src/mensajeria/politica.ts
 * (H-057, H-058). Procedencia preservada tal cual del repo origen
 * (docs/investigacion/RV10-mensajes-huesped.md, no copiado a este monorepo):
 *
 * - Airbnb: límite de 4,000 caracteres [DATO] (Airbnb Help Center, artículo 2898) y
 *   prohibición explícita de contacto/pago fuera de plataforma antes de la reserva
 *   [DATO] (artículos 209/3059/4155).
 * - Booking.com y Vrbo: SIN fuente primaria verificada (el origen documentó que
 *   todas las URLs oficiales devolvieron 403/429 en su investigación). El límite de
 *   4,000 caracteres para estos dos canales es un límite interno declarado por
 *   Atiende [E], no un hecho de esas plataformas, aplicado por prudencia (mismo techo
 *   que el único dato verificado, Airbnb) hasta contar con fuente primaria. La
 *   postura conservadora de NO automatizar mensajes pre-reserva (Booking) y de
 *   redactar contacto directo antes de confirmar (Vrbo) proviene de fuente
 *   secundaria de confianza media-baja (Hospitable, [R]).
 */
export interface PoliticaCanalMensajeria {
  readonly canal: CanalMensajeriaCodigo;
  readonly maxCaracteres: number;
  readonly fuenteMaxCaracteres: string;
  /** `false`: el canal prohíbe compartir contacto directo antes de que la reserva
   * esté confirmada (email/teléfono/enlaces de pago). */
  readonly permiteContactoDirectoPreReserva: boolean;
  /** `false`: no se debe programar automatización de mensajes ANTES de que exista
   * una reserva confirmada en ese canal (Booking). */
  readonly permiteAutomatizacionPreReserva: boolean;
  /** Comportamiento por defecto del filtro de contenido ante contacto/pago detectado
   * antes de la reserva: `bloquear` (Airbnb — el mensaje nunca llega al huésped) o
   * `redactar` (Booking/Vrbo — se enmascara el dato y el resto del mensaje sí se
   * conserva, replicando el comportamiento nativo de esos canales). */
  readonly accionAntePreReservaProhibida: "bloquear" | "redactar";
  readonly fuentePolitica: string;
}

export const POLITICAS_POR_CANAL: Readonly<Record<CanalMensajeriaCodigo, PoliticaCanalMensajeria>> = {
  airbnb: {
    canal: "airbnb",
    maxCaracteres: 4000,
    fuenteMaxCaracteres: "[DATO] Airbnb Help Center art. 2898",
    permiteContactoDirectoPreReserva: false,
    permiteAutomatizacionPreReserva: true,
    accionAntePreReservaProhibida: "bloquear",
    fuentePolitica: "[DATO] Airbnb Help Center art. 209, 3059/3049, 4155",
  },
  booking: {
    canal: "booking",
    maxCaracteres: 4000,
    fuenteMaxCaracteres: "[E] supuesto interno de Atiende — sin fuente primaria de Booking.com",
    permiteContactoDirectoPreReserva: false,
    permiteAutomatizacionPreReserva: false,
    accionAntePreReservaProhibida: "redactar",
    fuentePolitica: "[R] Hospitable, confianza media-baja",
  },
  vrbo: {
    canal: "vrbo",
    maxCaracteres: 4000,
    fuenteMaxCaracteres: "[E] supuesto interno de Atiende — sin fuente primaria de Vrbo",
    permiteContactoDirectoPreReserva: false,
    permiteAutomatizacionPreReserva: false,
    accionAntePreReservaProhibida: "redactar",
    fuentePolitica: "[R] Hospitable, confianza media-baja",
  },
};

export function politicaDeCanal(canal: CanalMensajeriaCodigo): PoliticaCanalMensajeria {
  return POLITICAS_POR_CANAL[canal];
}

// ---------------------------------------------------------------------------
// Errores tipados (H-057, H-058) — el dominio nunca lanza `Error` genérico para un
// rechazo de política, así apps/api puede traducirlos 1:1 a un status HTTP estable
// (ver apps/api/src/routes/verticals/rentas/mensajeria-borradores.ts).
// ---------------------------------------------------------------------------

export class MensajeExcedeLongitudError extends Error {
  constructor(
    readonly canal: CanalMensajeriaCodigo,
    readonly longitud: number,
    readonly maximo: number,
  ) {
    super(`Mensaje de ${longitud} caracteres excede el máximo de ${maximo} para ${canal} (${POLITICAS_POR_CANAL[canal].fuenteMaxCaracteres}) — rechazado antes de envío`);
    this.name = "MensajeExcedeLongitudError";
  }
}

export class ContenidoProhibidoError extends Error {
  constructor(
    readonly canal: CanalMensajeriaCodigo,
    readonly hallazgos: readonly string[],
  ) {
    super(`Mensaje bloqueado: contiene ${hallazgos.join(", ")} — prohibido antes de confirmar la reserva en ${canal}`);
    this.name = "ContenidoProhibidoError";
  }
}

// ---------------------------------------------------------------------------
// Detección de contacto directo / pagos fuera de plataforma (H-058)
// ---------------------------------------------------------------------------

const PATRON_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Al menos 7 dígitos con separadores opcionales de espacio/guion/punto — suficiente
// para números de teléfono reales sin marcar cualquier número corto (ej. "habitación
// 2") como contacto.
const PATRON_TELEFONO = /(?:\+?\d[\d\-.\s]{6,}\d)/g;
const PATRON_URL = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
const PALABRAS_PAGO_EXTERNO = /\b(paypal|venmo|zelle|wise|mercado\s?pago|transferencia\s+bancaria|deposit[ao]\s+directo|c(?:ó|o)digo\s+qr\s+de\s+pago)\b/gi;

export interface HallazgosContactoPago {
  readonly emails: readonly string[];
  readonly telefonos: readonly string[];
  readonly urls: readonly string[];
  readonly palabrasPago: readonly string[];
}

export function detectarContactoOPago(texto: string): HallazgosContactoPago {
  return {
    emails: [...texto.matchAll(PATRON_EMAIL)].map((m) => m[0]),
    telefonos: [...texto.matchAll(PATRON_TELEFONO)].map((m) => m[0]),
    urls: [...texto.matchAll(PATRON_URL)].map((m) => m[0]),
    palabrasPago: [...texto.matchAll(PALABRAS_PAGO_EXTERNO)].map((m) => m[0]),
  };
}

function hayHallazgos(h: HallazgosContactoPago): boolean {
  return h.emails.length + h.telefonos.length + h.urls.length + h.palabrasPago.length > 0;
}

function listaHallazgos(h: HallazgosContactoPago): string[] {
  const lista: string[] = [];
  if (h.emails.length > 0) lista.push("correo electrónico");
  if (h.telefonos.length > 0) lista.push("teléfono");
  if (h.urls.length > 0) lista.push("enlace externo");
  if (h.palabrasPago.length > 0) lista.push("referencia a pago fuera de plataforma");
  return lista;
}

function redactarContactoOPago(texto: string): string {
  return texto
    .replace(PATRON_EMAIL, "[correo oculto]")
    .replace(PATRON_URL, "[enlace oculto]")
    .replace(PALABRAS_PAGO_EXTERNO, "[pago externo oculto]")
    .replace(PATRON_TELEFONO, "[teléfono oculto]");
}

// ---------------------------------------------------------------------------
// Lenguaje discriminatorio (H-058) — heurística MVP: combina un verbo de exclusión
// con un término de característica protegida. No pretende ser exhaustiva (no es un
// modelo de moderación); es defensa en profundidad explícita, documentada como tal.
// ---------------------------------------------------------------------------

const VERBOS_EXCLUSION = /\b(no\s+(?:aceptamos|rentamos|recibimos|admitimos)|prohibido\s+para)\b/i;
const CARACTERISTICAS_PROTEGIDAS = /\b(raza|religi[oó]n|nacionalidad|orientaci[oó]n\s+sexual|discapacidad|g[eé]nero|origen\s+[eé]tnico|edad\s+avanzada)\b/i;

export function contieneLenguajeExcluyente(texto: string): boolean {
  return VERBOS_EXCLUSION.test(texto) && CARACTERISTICAS_PROTEGIDAS.test(texto);
}

// ---------------------------------------------------------------------------
// Validación combinada de un mensaje saliente (H-057, H-058)
// ---------------------------------------------------------------------------

export interface EntradaValidarMensajeSaliente {
  readonly canal: CanalMensajeriaCodigo;
  readonly texto: string;
  readonly reservaConfirmada: boolean;
}

export interface ResultadoValidarMensajeSaliente {
  /** Texto final a enviar — igual al original salvo que el canal redacte
   * contacto/pago (Booking/Vrbo). */
  readonly texto: string;
  readonly redactado: boolean;
}

/**
 * Aplica longitud + contacto/pago + lenguaje excluyente. Lanza un error tipado
 * (nunca silencioso) ante cualquier rechazo — la única mutación posible del texto es
 * la redacción explícita de Booking/Vrbo, nunca un truncado silencioso que cambie el
 * significado del mensaje.
 */
export function validarMensajeSaliente(entrada: EntradaValidarMensajeSaliente): ResultadoValidarMensajeSaliente {
  const politica = politicaDeCanal(entrada.canal);

  if (entrada.texto.length > politica.maxCaracteres) {
    throw new MensajeExcedeLongitudError(entrada.canal, entrada.texto.length, politica.maxCaracteres);
  }

  if (contieneLenguajeExcluyente(entrada.texto)) {
    throw new ContenidoProhibidoError(entrada.canal, ["lenguaje excluyente por característica protegida"]);
  }

  if (entrada.reservaConfirmada || politica.permiteContactoDirectoPreReserva) {
    return { texto: entrada.texto, redactado: false };
  }

  const hallazgos = detectarContactoOPago(entrada.texto);
  if (!hayHallazgos(hallazgos)) {
    return { texto: entrada.texto, redactado: false };
  }

  if (politica.accionAntePreReservaProhibida === "bloquear") {
    throw new ContenidoProhibidoError(entrada.canal, listaHallazgos(hallazgos));
  }
  return { texto: redactarContactoOPago(entrada.texto), redactado: true };
}
