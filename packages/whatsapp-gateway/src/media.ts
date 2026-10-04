// Descarga de MEDIA entrante de la Cloud API de WhatsApp (R-32: notas de voz). Dos llamadas, ambas con Bearer:
//   1) GET {base}/{version}/{media-id}            -> { url, mime_type, file_size, id }
//   2) GET {url}  (URL firmada de corta vida)      -> bytes
// Reglas de este archivo:
//   * Nunca se registra ni se incluye en un mensaje de error la URL firmada, el id de media ni los bytes: los errores
//     llevan solo un `code` tipado y un texto fijo (la URL firmada y el audio son datos del cliente).
//   * El token solo viaja a hosts de Meta (o al propio `baseUrl` configurado, p. ej. el simulador local): una URL de
//     descarga fuera de esa lista se rechaza sin enviarla (defensa en profundidad contra filtrar el token).
//   * Tope de tamano ANTES (file_size declarado) y DURANTE la descarga (lectura por flujo con corte), timeout total y
//     lista cerrada de tipos mime de audio. La duracion se estima solo para Ogg/Opus (formato de las notas de voz).
import { WhatsAppConfigError } from "./errors.ts";

export type WhatsAppMediaErrorCode =
  | "unauthorized"
  | "not_found"
  | "unsupported_type"
  | "too_large"
  | "too_long"
  | "timeout"
  | "network"
  | "invalid_response"
  | "blocked_host";

/** Error tipado de la descarga de media. `message` es un texto FIJO en espanol: jamas incluye la URL firmada ni el id. */
export class WhatsAppMediaError extends Error {
  constructor(
    readonly code: WhatsAppMediaErrorCode,
    readonly retryable: boolean,
  ) {
    super(MEDIA_ERROR_TEXT[code]);
    this.name = "WhatsAppMediaError";
  }
}

const MEDIA_ERROR_TEXT: Readonly<Record<WhatsAppMediaErrorCode, string>> = {
  unauthorized: "Meta rechazo el token al pedir el archivo multimedia",
  not_found: "el archivo multimedia ya no existe o expiro en Meta",
  unsupported_type: "tipo de archivo multimedia no permitido",
  too_large: "el archivo multimedia supera el tamano maximo",
  too_long: "la nota de voz supera la duracion maxima",
  timeout: "se agoto el tiempo al descargar el archivo multimedia",
  network: "fallo de red al descargar el archivo multimedia",
  invalid_response: "respuesta inesperada de Meta al descargar el archivo multimedia",
  blocked_host: "la URL de descarga de Meta no es un host permitido",
};

export const DEFAULT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MEDIA_TIMEOUT_MS = 10_000;
/** Notas de voz de WhatsApp: ogg/opus (nativas), mp4/m4a (iOS), mpeg (mp3) y amr (equipos antiguos). */
export const DEFAULT_ALLOWED_AUDIO_MIMES: readonly string[] = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/amr", "audio/aac"];
/** Hosts de Meta que sirven media (sufijos). El token nunca se manda a otro host. */
const META_MEDIA_HOST_SUFFIXES: readonly string[] = [".fbsbx.com", ".whatsapp.net", ".facebook.com", ".fbcdn.net"];
const MEDIA_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;

export interface DownloadedMedia {
  readonly bytes: Uint8Array;
  /** Tipo mime normalizado (sin parametros, minusculas): "audio/ogg". */
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Segundos, solo cuando se pudo leer del contenedor (Ogg/Opus); `null` si se desconoce. */
  readonly durationSeconds: number | null;
}

export interface MediaDownloadLimits {
  readonly maxBytes?: number;
  readonly maxDurationSeconds?: number;
  readonly allowedMimeTypes?: readonly string[];
}

export interface MetaMediaDownloaderOptions {
  readonly accessToken: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  /** Solo pruebas: el simulador local. Su origen tambien se acepta para la URL de descarga. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly defaultLimits?: MediaDownloadLimits;
}

export interface MediaDownloader {
  download(mediaId: string, limits?: MediaDownloadLimits): Promise<DownloadedMedia>;
}

export function normalizeMimeType(raw: string): string {
  return raw.split(";")[0]!.trim().toLowerCase();
}

/** Duracion de un archivo Ogg/Opus: posicion de granulo de la ultima pagina / 48 kHz (Opus siempre cuenta a 48 kHz), menos el pre-skip
 *  no se descuenta (error < 0.1 s). `null` si no es Ogg o no se puede leer. */
export function oggOpusDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 27) return null;
  const isOgg = (i: number) => bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53;
  if (!isOgg(0)) return null;
  for (let i = bytes.length - 27; i >= 0; i--) {
    if (!isOgg(i)) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset + i, 27);
    const granule = view.getBigUint64(6, true);
    if (granule === 0xffffffffffffffffn) return null;
    return Number(granule) / 48_000;
  }
  return null;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new WhatsAppMediaError("invalid_response", false);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WhatsAppMediaError("too_large", false);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class MetaGraphMediaDownloader implements MediaDownloader {
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaults: MediaDownloadLimits;

  constructor(opts: MetaMediaDownloaderOptions) {
    if (!opts.accessToken || opts.accessToken.trim().length === 0) {
      throw new WhatsAppConfigError("MetaGraphMediaDownloader requiere WHATSAPP_ACCESS_TOKEN: sin el no se puede descargar media, nunca se finge.");
    }
    this.accessToken = opts.accessToken;
    this.apiVersion = opts.apiVersion ?? "v21.0";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://graph.facebook.com";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
    this.defaults = opts.defaultLimits ?? {};
  }

  private hostAllowed(url: URL): boolean {
    if (url.origin === new URL(this.baseUrl).origin) return true;
    if (url.protocol !== "https:") return false;
    return META_MEDIA_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
  }

  private async get(url: string, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${this.accessToken}` }, signal });
    } catch (err) {
      if (signal.aborted) throw new WhatsAppMediaError("timeout", true);
      void err; // el texto del error de red puede traer la URL: no se propaga.
      throw new WhatsAppMediaError("network", true);
    }
  }

  private statusToError(status: number): WhatsAppMediaError {
    if (status === 401 || status === 403) return new WhatsAppMediaError("unauthorized", false);
    if (status === 404 || status === 410) return new WhatsAppMediaError("not_found", false);
    if (status === 429 || status >= 500) return new WhatsAppMediaError("network", true);
    return new WhatsAppMediaError("invalid_response", false);
  }

  async download(mediaId: string, limits: MediaDownloadLimits = {}): Promise<DownloadedMedia> {
    if (!MEDIA_ID_RE.test(mediaId)) throw new WhatsAppMediaError("invalid_response", false);
    const maxBytes = limits.maxBytes ?? this.defaults.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
    const maxDuration = limits.maxDurationSeconds ?? this.defaults.maxDurationSeconds;
    const allowed = (limits.allowedMimeTypes ?? this.defaults.allowedMimeTypes ?? DEFAULT_ALLOWED_AUDIO_MIMES).map(normalizeMimeType);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const metaResponse = await this.get(`${this.baseUrl}/${this.apiVersion}/${mediaId}`, controller.signal);
      if (!metaResponse.ok) throw this.statusToError(metaResponse.status);
      let meta: { url?: unknown; mime_type?: unknown; file_size?: unknown };
      try {
        meta = (await metaResponse.json()) as typeof meta;
      } catch {
        throw new WhatsAppMediaError("invalid_response", false);
      }
      if (typeof meta.url !== "string" || typeof meta.mime_type !== "string") throw new WhatsAppMediaError("invalid_response", false);
      const mimeType = normalizeMimeType(meta.mime_type);
      if (!allowed.includes(mimeType)) throw new WhatsAppMediaError("unsupported_type", false);
      if (typeof meta.file_size === "number" && meta.file_size > maxBytes) throw new WhatsAppMediaError("too_large", false);

      let downloadUrl: URL;
      try {
        downloadUrl = new URL(meta.url);
      } catch {
        throw new WhatsAppMediaError("invalid_response", false);
      }
      if (!this.hostAllowed(downloadUrl)) throw new WhatsAppMediaError("blocked_host", false);

      const fileResponse = await this.get(downloadUrl.toString(), controller.signal);
      if (!fileResponse.ok) throw this.statusToError(fileResponse.status);
      const declared = Number(fileResponse.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) throw new WhatsAppMediaError("too_large", false);
      let bytes: Uint8Array;
      try {
        bytes = await readLimited(fileResponse, maxBytes);
      } catch (err) {
        if (err instanceof WhatsAppMediaError) throw err;
        if (controller.signal.aborted) throw new WhatsAppMediaError("timeout", true);
        throw new WhatsAppMediaError("network", true);
      }
      if (bytes.byteLength === 0) throw new WhatsAppMediaError("invalid_response", false);
      const durationSeconds = mimeType === "audio/ogg" ? oggOpusDurationSeconds(bytes) : null;
      if (maxDuration !== undefined && durationSeconds !== null && durationSeconds > maxDuration) throw new WhatsAppMediaError("too_long", false);
      return { bytes, mimeType, sizeBytes: bytes.byteLength, durationSeconds };
    } finally {
      clearTimeout(timer);
    }
  }
}
