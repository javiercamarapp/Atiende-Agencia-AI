// TTS de la cascada v2: ElevenLabs `eleven_v4_turbo` por HTTP en streaming (`POST /v1/text-to-speech/{voz}/stream?output_format=pcm_24000`).
//
// Una peticion por frase sobre la MISMA conexion keep-alive (undici reutiliza el socket TLS): la medicion del 6-nov-2026 dio 0.28 s al primer byte con la conexion
// abierta. `abrir` valida la llave y la voz con `GET /v1/voices/{voz}` (no gasta creditos) y de paso deja la conexion caliente antes de que el cliente hable.
// Salida: PCM16 mono little-endian a 24 kHz (la tasa de la sala), sin contenedor; un byte suelto entre trozos se guarda para no desalinear las muestras.
// Barge-in: la `senal` aborta el `fetch` (ElevenLabs deja de generar y no se descarga mas audio).
import type { ConfigElevenLabs } from "../../config-plataforma.ts";
import { VozProveedorError } from "../../provider.ts";
import type { OpcionesTts, ProveedorTts, PuertoTtsVoz, SesionTts } from "./puertos.ts";

export const ELEVENLABS_API_URL = "https://api.elevenlabs.io";

/** Ids de voz de ElevenLabs: 20 caracteres alfanumericos (p. ej. Regina - Contact Center `9Godp7dNohUvXk6qp0gS`). */
const VOZ_ELEVENLABS_RE = /^[A-Za-z0-9]{20}$/;

export function esVozElevenLabs(voz: unknown): voz is string {
  return typeof voz === "string" && VOZ_ELEVENLABS_RE.test(voz);
}

/** Voz telefonica de la sucursal -> voz de ElevenLabs; cualquier otro valor (una voz de Gemini o de Aura-2, vacio) cae a la voz por omision (Regina). */
export function resolverVozElevenLabs(voz: unknown, porDefecto: string): string {
  return esVozElevenLabs(voz) ? voz : porDefecto;
}

export interface ElevenLabsTtsOpciones {
  readonly apiKey: string;
  readonly config: ConfigElevenLabs["tts"];
  readonly fetchFn?: typeof fetch;
  readonly baseUrl?: string;
  readonly aperturaTimeoutMs?: number;
}

const codigoHttp = (status: number): string => `tts_el_${status}`;

/** Lee el cuerpo con tope de espera por trozo; aborta la peticion si se pasa. */
async function* trozos(cuerpo: ReadableStream<Uint8Array>, timeoutMs: number, abortar: () => void): AsyncGenerator<Uint8Array> {
  const lector = cuerpo.getReader();
  try {
    for (;;) {
      let t: ReturnType<typeof setTimeout> | undefined;
      const vencido = new Promise<never>((_, rej) => {
        t = setTimeout(() => {
          abortar();
          rej(new Error("tts_timeout"));
        }, timeoutMs);
      });
      let r: { done: boolean; value?: Uint8Array };
      try {
        r = await Promise.race([lector.read(), vencido]);
      } finally {
        clearTimeout(t);
      }
      if (r.done) return;
      if (r.value && r.value.byteLength > 0) yield r.value;
    }
  } finally {
    lector.releaseLock();
  }
}

class SesionElevenLabsTts implements SesionTts {
  private cerrada = false;
  private turnoAnterior: Promise<void> = Promise.resolve();

  constructor(
    private readonly voz: string,
    private readonly o: ElevenLabsTtsOpciones,
  ) {}

  proveedor(): ProveedorTts {
    return "elevenlabs-tts";
  }

  private get fetchFn(): typeof fetch {
    return this.o.fetchFn ?? fetch;
  }

  private get base(): string {
    return this.o.baseUrl ?? ELEVENLABS_API_URL;
  }

  /** Valida llave y voz sin gastar creditos (y calienta la conexion). */
  async validar(): Promise<void> {
    const control = new AbortController();
    const t = setTimeout(() => control.abort(), this.o.aperturaTimeoutMs ?? 6_000);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/v1/voices/${encodeURIComponent(this.voz)}`, { method: "GET", headers: { "xi-api-key": this.o.apiKey }, signal: control.signal });
    } catch {
      throw new VozProveedorError("ElevenLabs (TTS) no respondio al validar la voz.");
    } finally {
      clearTimeout(t);
    }
    try {
      await res.body?.cancel();
    } catch {
      /* sin cuerpo */
    }
    if (!res.ok) throw new VozProveedorError(`ElevenLabs (TTS) rechazo la voz o la llave (HTTP ${res.status}).`, res.status);
  }

  async *sintetizar(texto: string, senal: AbortSignal): AsyncIterable<Uint8Array> {
    if (this.cerrada) throw new Error("tts_cerrado");
    // Las frases se atienden de una en una (contrato del puerto).
    let liberar: () => void = () => undefined;
    const anterior = this.turnoAnterior;
    this.turnoAnterior = new Promise<void>((r) => {
      liberar = r;
    });
    await anterior;
    try {
      if (senal.aborted) return;
      const control = new AbortController();
      const alAbortar = (): void => control.abort();
      senal.addEventListener("abort", alAbortar, { once: true });
      // Tope al PRIMER trozo (conexion + cabeceras + primer audio): sin el, un servidor que acepta y no responde deja la llamada en silencio sin caer al respaldo.
      let vencioPrimerByte = false;
      let primerByte: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        vencioPrimerByte = true;
        control.abort();
      }, this.o.config.primerByteTimeoutMs);
      const quitarPrimerByte = (): void => {
        if (primerByte !== null) clearTimeout(primerByte);
        primerByte = null;
      };
      try {
        const c = this.o.config;
        const url = `${this.base}/v1/text-to-speech/${encodeURIComponent(this.voz)}/stream?output_format=pcm_${c.hzSalida}`;
        let res: Response;
        try {
          res = await this.fetchFn(url, {
            method: "POST",
            headers: { "xi-api-key": this.o.apiKey, "Content-Type": "application/json", Accept: "audio/pcm" },
            body: JSON.stringify({ text: texto, model_id: c.modelo, language_code: c.idioma }),
            signal: control.signal,
          });
        } catch {
          if (vencioPrimerByte) throw new Error("tts_el_timeout");
          if (senal.aborted) return;
          throw new Error("tts_el_red");
        }
        if (!res.ok || !res.body) {
          try {
            await res.body?.cancel();
          } catch {
            /* sin cuerpo */
          }
          throw new Error(codigoHttp(res.status));
        }
        let suelto: number | null = null;
        for await (const trozo of trozos(res.body, c.fraseTimeoutMs, () => control.abort())) {
          quitarPrimerByte();
          if (senal.aborted) return;
          let datos = trozo;
          if (suelto !== null) {
            const unido = new Uint8Array(trozo.byteLength + 1);
            unido[0] = suelto;
            unido.set(trozo, 1);
            datos = unido;
            suelto = null;
          }
          if (datos.byteLength % 2 === 1) {
            suelto = datos[datos.byteLength - 1]!;
            datos = datos.subarray(0, datos.byteLength - 1);
          }
          if (datos.byteLength > 0) yield datos;
        }
      } catch (err) {
        if (vencioPrimerByte) throw new Error("tts_el_timeout");
        if (senal.aborted) return;
        throw err;
      } finally {
        quitarPrimerByte();
        senal.removeEventListener("abort", alAbortar);
        control.abort();
      }
    } finally {
      liberar();
    }
  }

  async cerrar(): Promise<void> {
    this.cerrada = true;
  }
}

/** Puerto de TTS sobre ElevenLabs. La llave va SOLO en la cabecera `xi-api-key`. `OpcionesTts.voz` debe ser un id de voz de ElevenLabs (ver `resolverVozElevenLabs`). */
export function crearTtsElevenLabs(opts: ElevenLabsTtsOpciones): PuertoTtsVoz {
  return {
    async abrir(opciones: OpcionesTts) {
      if (opciones.hzSalida !== opts.config.hzSalida) throw new VozProveedorError(`ElevenLabs (TTS) configurado a ${opts.config.hzSalida} Hz y la sala pide ${opciones.hzSalida} Hz.`);
      const sesion = new SesionElevenLabsTts(resolverVozElevenLabs(opciones.voz, opts.config.voz), opts);
      await sesion.validar();
      return sesion;
    },
  };
}
