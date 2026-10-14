// STT de la cascada v2: Deepgram Nova-3 en streaming por WebSocket (`wss://api.deepgram.com/v1/listen`).
//
// ESTADO DE VERIFICACION (honesto): URL, parametros y mensajes se escribieron contra la documentacion vigente de Deepgram leida el 2026-10-13
// (https://developers.deepgram.com/reference/speech-to-text/listen-streaming, /docs/models-languages-overview, /docs/understand-endpointing-interim-results,
// /docs/utterance-end, /docs/speech-started, /docs/keyterm, /docs/audio-keep-alive) y se prueban contra un WebSocket FALSO. NO se probaron contra la API real
// (no hay llave en este entorno): la primera corrida real es `scripts/voz-cascada-v2-smoke/`.
//
// Fin de turno: lo decide el endpointing de Deepgram (`endpointing=<ms>` -> `speech_final: true`), con `UtteranceEnd` como respaldo; ya no hay corte por energia RMS.
// Nova-3 no tiene `es-MX`: se usa `es-419` (espanol latinoamericano). `keyterm` (solo Nova-3) lleva los terminos del menu; `keywords` NO se usa (no lo admite Nova-3).
import type { ConfigCascadaV2 } from "../../config-plataforma.ts";
import { VozProveedorError } from "../../provider.ts";
import type { EventosStt, OpcionesStt, PuertoSttVoz, SesionStt } from "./puertos.ts";
import { crearLectorMensajes, crearSocketDeepgramGlobal } from "./socket.ts";
import type { CrearSocketDeepgram, SocketDeepgram } from "./socket.ts";

export const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

const KEYTERM_LARGO_MAX = 60;
const KEYTERMS_CARACTERES_MAX = 1000;

/** Terminos clave para `keyterm`: unicos, sin vacios ni caracteres de control, hasta `max` terminos y un tope de caracteres (Deepgram limita a 500 tokens por conexion). */
export function keytermsDe(vocabulario: readonly string[] | undefined, max: number): string[] {
  const terminos = new Map<string, string>();
  let caracteres = 0;
  for (const t of Array.isArray(vocabulario) ? vocabulario : []) {
    if (terminos.size >= max) break;
    if (typeof t !== "string") continue;
    // eslint-disable-next-line no-control-regex
    const limpio = t.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, KEYTERM_LARGO_MAX).trim();
    if (limpio === "" || terminos.has(limpio.toLowerCase())) continue;
    if (caracteres + limpio.length > KEYTERMS_CARACTERES_MAX) break;
    caracteres += limpio.length;
    terminos.set(limpio.toLowerCase(), limpio);
  }
  return [...terminos.values()];
}

export function urlListenDeepgram(c: ConfigCascadaV2["deepgram"], opciones: OpcionesStt): string {
  const q = new URLSearchParams({
    model: c.modelo,
    language: c.idioma,
    encoding: "linear16",
    sample_rate: String(opciones.hzEntrada),
    channels: "1",
    interim_results: "true",
    endpointing: String(c.endpointingMs),
    utterance_end_ms: String(c.utteranceEndMs),
    vad_events: "true",
    smart_format: "true",
  });
  // Cada termino es su propio parametro `keyterm` (no se separan con comas); URLSearchParams codifica los espacios como `+`, que Deepgram acepta.
  for (const t of keytermsDe(opciones.vocabulario, c.keytermsMax)) q.append("keyterm", t);
  return `${DEEPGRAM_LISTEN_URL}?${q.toString()}`;
}

export interface DeepgramSttOpciones {
  readonly apiKey: string;
  readonly config: ConfigCascadaV2["deepgram"];
  readonly crearSocket?: CrearSocketDeepgram;
  /** Tope de espera de la apertura del socket. */
  readonly aperturaTimeoutMs?: number;
  /** Cada cuanto se manda `KeepAlive` si no hubo audio (Deepgram cierra tras ~10 s sin audio ni KeepAlive). */
  readonly keepAliveMs?: number;
  readonly ahora?: () => number;
  /** Programa una tarea periodica y devuelve como cancelarla. Por omision `setInterval` (sin retener el proceso). */
  readonly programar?: (tarea: () => void, ms: number) => () => void;
}

interface ResultadoDeepgram {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  last_word_end?: number;
  channel?: { alternatives?: { transcript?: string }[] };
}

const programarPorDefecto = (tarea: () => void, ms: number): (() => void) => {
  const id = setInterval(tarea, ms);
  (id as { unref?: () => void }).unref?.();
  return () => clearInterval(id);
};

class SesionDeepgramStt implements SesionStt {
  private cerradaPorNosotros = false;
  private caidaAvisada = false;
  private abierto = false;
  private acumulado = "";
  private ultimoAudioMs: number;
  private cancelarKeepAlive: (() => void) | null = null;

  constructor(
    private readonly socket: SocketDeepgram,
    private readonly eventos: EventosStt,
    private readonly o: DeepgramSttOpciones,
  ) {
    this.ultimoAudioMs = (o.ahora ?? Date.now)();
  }

  conectar(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        if (!this.abierto) {
          this.cerradaPorNosotros = true;
          try {
            this.socket.close(1000, "apertura_timeout");
          } catch {
            /* ya cerrado */
          }
          reject(new VozProveedorError("Deepgram (STT) no respondio al abrir (tiempo agotado)."));
        }
      }, this.o.aperturaTimeoutMs ?? 10_000);
      try {
        this.socket.binaryType = "arraybuffer";
      } catch {
        /* un doble o socket sin binaryType: se ignora */
      }
      this.socket.onopen = () => {
        this.abierto = true;
        clearTimeout(t);
        this.iniciarKeepAlive();
        resolve();
      };
      this.socket.onerror = () => {
        if (!this.abierto) {
          clearTimeout(t);
          reject(new VozProveedorError("No se pudo abrir la conexion con Deepgram (STT)."));
          return;
        }
        this.avisarCaida("stt_ws_error");
      };
      this.socket.onclose = (ev) => {
        this.cancelarKeepAlive?.();
        if (!this.abierto) {
          clearTimeout(t);
          reject(new VozProveedorError(`Deepgram (STT) cerro la conexion al abrir (codigo ${ev.code ?? "?"}).`, ev.code));
          return;
        }
        if (this.cerradaPorNosotros) return;
        this.avisarCaida(`stt_ws_${ev.code ?? "cerrado"}`);
      };
      this.socket.onmessage = crearLectorMensajes((m) => {
        if (m.tipo === "texto") this.recibir(m.texto);
      });
    });
  }

  private iniciarKeepAlive(): void {
    const cada = this.o.keepAliveMs ?? 4_000;
    const ahora = this.o.ahora ?? Date.now;
    this.cancelarKeepAlive = (this.o.programar ?? programarPorDefecto)(() => {
      if (this.cerradaPorNosotros || ahora() - this.ultimoAudioMs < cada) return;
      try {
        this.socket.send(JSON.stringify({ type: "KeepAlive" }));
      } catch {
        /* el cierre del socket avisa la caida */
      }
    }, cada);
  }

  private avisarCaida(codigo: string): void {
    if (this.caidaAvisada || this.cerradaPorNosotros) return;
    this.caidaAvisada = true;
    this.cancelarKeepAlive?.();
    this.eventos.caido(codigo);
  }

  private recibir(texto: string): void {
    let msg: ResultadoDeepgram;
    try {
      msg = JSON.parse(texto) as ResultadoDeepgram;
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object") return;
    switch (msg.type) {
      case "SpeechStarted":
        this.eventos.hablaIniciada();
        return;
      case "UtteranceEnd":
        // `last_word_end: -1` = el resultado ya se finalizo antes del hueco: se ignora para no duplicar el turno (docs/utterance-end).
        if (msg.last_word_end !== -1) this.cerrarTurno();
        return;
      case "Results": {
        const transcripcion = (msg.channel?.alternatives?.[0]?.transcript ?? "").trim();
        if (msg.is_final === true) {
          if (transcripcion !== "") {
            this.acumulado = this.acumulado === "" ? transcripcion : `${this.acumulado} ${transcripcion}`;
            this.eventos.parcial(this.acumulado);
          }
          if (msg.speech_final === true) this.cerrarTurno();
        } else if (transcripcion !== "") {
          this.eventos.parcial(this.acumulado === "" ? transcripcion : `${this.acumulado} ${transcripcion}`);
        }
        return;
      }
      default:
        // `Metadata` y los `Error` no fatales (los fatales cierran el socket) no cambian el turno.
        return;
    }
  }

  private cerrarTurno(): void {
    const texto = this.acumulado.trim();
    this.acumulado = "";
    if (texto !== "") this.eventos.turnoFinal(texto);
  }

  enviarAudio(pcm16: Uint8Array): void {
    if (this.cerradaPorNosotros || this.caidaAvisada || pcm16.byteLength === 0) return;
    this.ultimoAudioMs = (this.o.ahora ?? Date.now)();
    try {
      this.socket.send(pcm16);
    } catch {
      this.avisarCaida("stt_send");
    }
  }

  async cerrar(): Promise<void> {
    if (this.cerradaPorNosotros) return;
    this.cerradaPorNosotros = true;
    this.cancelarKeepAlive?.();
    try {
      if (this.abierto) this.socket.send(JSON.stringify({ type: "CloseStream" }));
      this.socket.close(1000, "fin_de_llamada");
    } catch {
      /* ya cerrado */
    }
  }
}

/** Puerto de STT sobre Deepgram. La llave va en la cabecera `Authorization: Token`. */
export function crearSttDeepgram(opts: DeepgramSttOpciones): PuertoSttVoz {
  return {
    async abrir(opciones, eventos) {
      const crear = opts.crearSocket ?? crearSocketDeepgramGlobal;
      const socket = crear(urlListenDeepgram(opts.config, opciones), { headers: { Authorization: `Token ${opts.apiKey}` } });
      const sesion = new SesionDeepgramStt(socket, eventos, opts);
      await sesion.conectar();
      return sesion;
    },
  };
}
