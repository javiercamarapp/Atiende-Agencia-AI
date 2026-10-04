// Notas de voz de WhatsApp (R-32). Hasta ahora un audio entrante se convertia en una nota que le pedia al cliente escribir
// (channel-config.ts::unsupportedBody). Con credencial de Meta, modelo con entrada de audio, presupuesto y topes, el audio se
// DESCARGA, se TRANSCRIBE y el agente recibe el texto marcado "[Nota de voz transcrita] ...".
//
// Reglas de este modulo:
//   * Un audio NUNCA salta cotizar/confirmar: la transcripcion entra como un mensaje de texto mas del cliente y el agente aplica las
//     mismas reglas (el prompt agrega que puede traer errores de cantidades/nombres/direcciones y que se confirman).
//   * Sin credencial, sin modelo, tope alcanzado o cualquier error: `transcribirNotaDeVoz` devuelve un MOTIVO y el llamador conserva
//     EXACTAMENTE el comportamiento anterior (pedir texto). Nunca lanza.
//   * Idempotencia: se invoca DESPUES de reclamar el mensaje en el ledger de entrada (`claimWhatsAppMessage`), asi que un replay de Meta
//     con el mismo message.id no llega aqui ni gasta una segunda transcripcion.
//   * Privacidad: ni los bytes, ni el id de media, ni la URL firmada, ni el telefono se registran; el log lleva solo el motivo.
//   * Topes con el limitador existente (`consumeRateLimit`): N notas por conversacion y hora, y un tope diario por organizacion.
import type { RestaurantesRepository } from "../repository.ts";
import { actorHash, consumeRateLimit } from "../rate-limit.ts";

/** Prefijo que ve el agente (y el staff en el historial) para distinguir una transcripcion de texto tecleado. */
export const PREFIJO_NOTA_DE_VOZ = "[Nota de voz transcrita]";

export const LIMITE_NOTAS_POR_CONVERSACION_HORA = 5;
export const LIMITE_NOTAS_POR_ORGANIZACION_DIA = 300;
export const NOTA_DE_VOZ_MAX_BYTES = 3 * 1024 * 1024;
export const NOTA_DE_VOZ_MAX_SEGUNDOS = 90;
/** Largo maximo de la transcripcion que se acepta (una nota de 90 s son ~250 palabras). */
export const TRANSCRIPCION_MAX_CARACTERES = 2000;

/** Audio entrante tal como lo reporta el webhook de Meta (`messages[].audio`). */
export interface NotaDeVozEntrante {
  readonly mediaId: string;
  readonly mimeType: string;
}

export type MotivoSinTranscripcion =
  | "no_configurado" // sin token de Meta o sin gateway/modelo de transcripcion
  | "apagado" // interruptor de plataforma o presupuesto agotado
  | "tope_conversacion"
  | "tope_organizacion"
  | "tope_no_disponible" // el limitador fallo: por prudencia de gasto no se transcribe
  | "tipo_no_soportado"
  | "demasiado_grande"
  | "demasiado_larga"
  | "descarga_fallo"
  | "transcripcion_fallo"
  | "transcripcion_vacia";

/** Error tipado que lanzan los adaptadores del puerto (apps/api): el dominio solo conoce el motivo. */
export class NotaDeVozError extends Error {
  constructor(readonly motivo: MotivoSinTranscripcion) {
    super(`nota de voz sin transcribir: ${motivo}`);
    this.name = "NotaDeVozError";
  }
}

export interface AudioDescargado {
  readonly bytes: Uint8Array;
  /** Mime normalizado ("audio/ogg"). */
  readonly mimeType: string;
  readonly durationSeconds: number | null;
}

/** Puerto hacia el mundo real. Los adaptadores lanzan `NotaDeVozError`; cualquier otro error se trata como fallo de esa etapa. */
export interface PuertoNotasDeVoz {
  descargar(mediaId: string, limites: { readonly maxBytes: number; readonly maxDurationSeconds: number }): Promise<AudioDescargado>;
  transcribir(audio: AudioDescargado, contexto: { readonly organizationId: string }): Promise<{ readonly texto: string }>;
}

export type ResultadoNotaDeVoz = { readonly ok: true; readonly texto: string } | { readonly ok: false; readonly motivo: MotivoSinTranscripcion };

/** Lo que `handleInboundWhatsAppMessage` / `recibirMensajeConEspera` necesitan para transcribir (ambos opcionales: ausente = comportamiento anterior). */
export interface TranscripcionDeEntrada {
  readonly audio: NotaDeVozEntrante;
  readonly puerto: PuertoNotasDeVoz;
}

function registrarMotivo(motivo: MotivoSinTranscripcion, organizationId: string): void {
  // Sin PII: ni telefono, ni id de media, ni URL, ni audio.
  console.warn(JSON.stringify({ level: "warn", event: "nota_de_voz_sin_transcribir", motivo, organizationId }));
}

async function tomarCupo(repo: RestaurantesRepository, scope: string, actor: string, max: number, windowSeconds: number): Promise<boolean | "error"> {
  try {
    // En savepoint: un error de Postgres (p. ej. la funcion no existe) no aborta la transaccion compartida del webhook.
    return (await repo.runWithRowSavepoint(() => consumeRateLimit(repo, scope, actor, max, windowSeconds))).allowed;
  } catch {
    return "error";
  }
}

/** Texto final que recibe el agente. La transcripcion se acota y se le quitan saltos de linea para que no imite otro mensaje del sistema. */
export function formatearNotaDeVoz(texto: string): string {
  const limpio = texto.replace(/\s+/g, " ").trim().slice(0, TRANSCRIPCION_MAX_CARACTERES);
  return `${PREFIJO_NOTA_DE_VOZ} ${limpio}`;
}

/** Transcribe una nota de voz respetando topes. Nunca lanza: ante cualquier problema devuelve el motivo y el llamador cae al camino anterior. */
export async function transcribirNotaDeVoz(
  repo: RestaurantesRepository,
  puerto: PuertoNotasDeVoz,
  args: { readonly organizationId: string; readonly phone: string; readonly audio: NotaDeVozEntrante },
): Promise<ResultadoNotaDeVoz> {
  const { organizationId, phone, audio } = args;
  const sinTranscribir = (motivo: MotivoSinTranscripcion): ResultadoNotaDeVoz => {
    registrarMotivo(motivo, organizationId);
    return { ok: false, motivo };
  };

  const porConversacion = await tomarCupo(repo, "whatsapp-voz-conversacion", `${organizationId}:${actorHash(phone)}`, LIMITE_NOTAS_POR_CONVERSACION_HORA, 3600);
  if (porConversacion === "error") return sinTranscribir("tope_no_disponible");
  if (!porConversacion) return sinTranscribir("tope_conversacion");
  const porOrganizacion = await tomarCupo(repo, "whatsapp-voz-organizacion", organizationId, LIMITE_NOTAS_POR_ORGANIZACION_DIA, 86_400);
  if (porOrganizacion === "error") return sinTranscribir("tope_no_disponible");
  if (!porOrganizacion) return sinTranscribir("tope_organizacion");

  let descargado: AudioDescargado;
  try {
    descargado = await puerto.descargar(audio.mediaId, { maxBytes: NOTA_DE_VOZ_MAX_BYTES, maxDurationSeconds: NOTA_DE_VOZ_MAX_SEGUNDOS });
  } catch (err) {
    return sinTranscribir(err instanceof NotaDeVozError ? err.motivo : "descarga_fallo");
  }
  if (descargado.durationSeconds !== null && descargado.durationSeconds > NOTA_DE_VOZ_MAX_SEGUNDOS) return sinTranscribir("demasiado_larga");
  if (descargado.bytes.byteLength > NOTA_DE_VOZ_MAX_BYTES) return sinTranscribir("demasiado_grande");

  try {
    const { texto } = await puerto.transcribir(descargado, { organizationId });
    if (texto.replace(/\s+/g, "").length < 2) return sinTranscribir("transcripcion_vacia");
    return { ok: true, texto: formatearNotaDeVoz(texto) };
  } catch (err) {
    return sinTranscribir(err instanceof NotaDeVozError ? err.motivo : "transcripcion_fallo");
  }
}

/** Cuerpo del mensaje: la transcripcion si hubo, o el texto anterior (pedir que escriba) si no. */
export async function resolverCuerpoConNotaDeVoz(
  repo: RestaurantesRepository,
  args: { readonly organizationId: string; readonly phone: string; readonly body: string; readonly transcripcion?: TranscripcionDeEntrada },
): Promise<string> {
  if (!args.transcripcion) return args.body;
  const resultado = await transcribirNotaDeVoz(repo, args.transcripcion.puerto, { organizationId: args.organizationId, phone: args.phone, audio: args.transcripcion.audio });
  return resultado.ok ? resultado.texto : args.body;
}
