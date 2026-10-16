// TTS de la cascada v2: Deepgram Aura-2 en streaming por WebSocket (`wss://api.deepgram.com/v1/speak`).
//
// ESTADO DE VERIFICACION (honesto): URL, parametros, mensajes y limites salen de la documentacion vigente de Deepgram leida el 2026-10-13
// (https://developers.deepgram.com/reference/text-to-speech/speak-streaming, /docs/streaming-text-to-speech, /docs/tts-models, /docs/tts-media-output-settings)
// y se prueban contra un WebSocket FALSO. NO se probaron contra la API real (no hay llave en este entorno): la primera corrida real es `scripts/voz-cascada-v2-smoke/`.
//
// Protocolo: el cliente manda `{"type":"Speak","text":...}` y `{"type":"Flush"}`; el servidor responde con tramas binarias de audio y, al terminar, `{"type":"Flushed"}`.
// `{"type":"Clear"}` descarta el texto/audio pendiente. Formato pedido: `encoding=linear16` a `sample_rate` (24 000 Hz, la tasa de salida de la sala): PCM lineal
// SIN contenedor (en streaming no hay contenedor), asi que no hace falta remuestrear.
//
// Limites documentados (/docs/streaming-text-to-speech, "Limits"): 2 000 caracteres por mensaje `Speak`, 2 400 caracteres por minuto por conexion, 20 `Flush` por cada
// 60 s y 60 min de vida por conexion. Este adaptador parte los textos largos, reconecta de forma perezosa si la conexion se cerro en reposo y expone
// `flushesDisponibles()` para que el nucleo junte frases (un solo Flush) cuando se acerque al limite; si aun asi se agotaran, falla con `tts_flush_limite` y la escalera decide.
// Barge-in: se manda `Clear` y se espera `Cleared` en la MISMA conexion (la doc pide una conexion por conversacion); si `Cleared` no llega se reconecta.
// Sin verificar contra la API real: que un `Flushed` rezagado de una frase cancelada no se confunda con el de la siguiente, la contrapresion (`bufferedAmount`) del socket
// y el limite de 2 400 caracteres por minuto (una llamada muy parlanchina podria rozarlo).
// Silencio inicial: Aura-2 antepone ~0.5-0.7 s de silencio a cada sintesis; `recorte.ts` lo descarta y quita una posible cabecera WAV.
import type { ConfigCascadaV2 } from "../../config-plataforma.ts";
import { VozProveedorError } from "../../provider.ts";
import { ColaAsync } from "./puertos.ts";
import type { OpcionesTts, PuertoTtsVoz, SesionTts } from "./puertos.ts";
import { crearRecortadorInicial } from "./recorte.ts";
import { crearLectorMensajes, crearSocketDeepgramGlobal } from "./socket.ts";
import type { CrearSocketDeepgram, SocketDeepgram } from "./socket.ts";

export const DEEPGRAM_SPEAK_URL = "wss://api.deepgram.com/v1/speak";

/** Voces de Aura-2 en espanol del catalogo vigente (https://developers.deepgram.com/docs/tts-models). Las mexicanas (es-mx) son estrella, olivia, javier, luciano, sirio y valerio. */
export const VOCES_AURA2_ES: readonly string[] = [
  "aura-2-agustina-es", "aura-2-alvaro-es", "aura-2-antonia-es", "aura-2-aquila-es", "aura-2-carina-es", "aura-2-celeste-es", "aura-2-diana-es", "aura-2-estrella-es",
  "aura-2-gloria-es", "aura-2-javier-es", "aura-2-luciano-es", "aura-2-nestor-es", "aura-2-olivia-es", "aura-2-selena-es", "aura-2-silvia-es", "aura-2-sirio-es", "aura-2-valerio-es",
];

/** `voiceId` de la sucursal -> voz de Aura-2. Un identificador que no es una voz de Aura-2 en espanol (p. ej. una voz de Gemini como "Kore") cae a la voz por omision. */
export function resolverVozAura2(voiceId: unknown, porDefecto: string): string {
  return typeof voiceId === "string" && VOCES_AURA2_ES.includes(voiceId) ? voiceId : porDefecto;
}

export function urlSpeakDeepgram(voz: string, hzSalida: number): string {
  const q = new URLSearchParams({ model: voz, encoding: "linear16", sample_rate: String(hzSalida) });
  return `${DEEPGRAM_SPEAK_URL}?${q.toString()}`;
}

const MAX_CARACTERES_SPEAK = 2_000;
const FLUSH_MAX_POR_VENTANA = 20;
const VENTANA_FLUSH_MS = 60_000;

export interface DeepgramTtsOpciones {
  readonly apiKey: string;
  readonly config: ConfigCascadaV2["deepgramAura2"];
  readonly crearSocket?: CrearSocketDeepgram;
  readonly aperturaTimeoutMs?: number;
  readonly ahora?: () => number;
  /** Tope de espera por trozo/fin de una frase (por omision `config.fraseTimeoutMs`). */
  readonly fraseTimeoutMs?: number;
  /** Tope de espera de `Cleared` tras un barge-in antes de reconectar. */
  readonly clearTimeoutMs?: number;
  /** Tope de espera a que se libere la ventana de Flush (20 por 60 s) antes de fallar con `tts_flush_limite`. */
  readonly flushEsperaMaxMs?: number;
}

type Entrante = { readonly audio: Uint8Array } | { readonly fin: true };

/** Parte `texto` en trozos de a lo sumo `max` caracteres, preferentemente en un espacio. */
export function partirTexto(texto: string, max = MAX_CARACTERES_SPEAK): string[] {
  const partes: string[] = [];
  let resto = texto.trim();
  while (resto.length > max) {
    const corte = resto.lastIndexOf(" ", max);
    const i = corte > 0 ? corte : max;
    partes.push(resto.slice(0, i).trim());
    resto = resto.slice(i).trim();
  }
  if (resto !== "") partes.push(resto);
  return partes;
}

class SesionDeepgramTts implements SesionTts {
  private socket: SocketDeepgram | null = null;
  private cerrada = false;
  /** Cola de la frase en curso (null en reposo). */
  private entrante: ColaAsync<Entrante> | null = null;
  private turnoAnterior: Promise<void> = Promise.resolve();
  private readonly flushes: number[] = [];
  /** Hay un `Clear` en vuelo: el audio que llegue hasta el `Cleared` es de la frase cancelada y se descarta. */
  private limpiando: { readonly promesa: Promise<void>; resolver: () => void } | null = null;

  constructor(
    private readonly voz: string,
    private readonly hzSalida: number,
    private readonly o: DeepgramTtsOpciones,
  ) {}

  private ahora(): number {
    return (this.o.ahora ?? Date.now)();
  }

  /** Abre un socket nuevo y resuelve cuando esta listo. */
  conectar(): Promise<void> {
    const crear = this.o.crearSocket ?? crearSocketDeepgramGlobal;
    const socket = crear(urlSpeakDeepgram(this.voz, this.hzSalida), { headers: { Authorization: `Token ${this.o.apiKey}` } });
    return new Promise<void>((resolve, reject) => {
      let abierto = false;
      const t = setTimeout(() => {
        if (!abierto) {
          try {
            socket.close(1000, "apertura_timeout");
          } catch {
            /* ya cerrado */
          }
          reject(new VozProveedorError("Deepgram (TTS) no respondio al abrir (tiempo agotado)."));
        }
      }, this.o.aperturaTimeoutMs ?? 10_000);
      try {
        socket.binaryType = "arraybuffer";
      } catch {
        /* un doble o socket sin binaryType: se ignora */
      }
      socket.onopen = () => {
        abierto = true;
        clearTimeout(t);
        this.socket = socket;
        resolve();
      };
      socket.onerror = () => {
        if (!abierto) {
          clearTimeout(t);
          reject(new VozProveedorError("No se pudo abrir la conexion con Deepgram (TTS)."));
        }
      };
      socket.onclose = (ev) => {
        if (!abierto) {
          clearTimeout(t);
          reject(new VozProveedorError(`Deepgram (TTS) cerro la conexion al abrir (codigo ${ev.code ?? "?"}).`, ev.code));
          return;
        }
        if (this.socket === socket) this.socket = null;
        this.limpiando?.resolver();
        this.limpiando = null;
        // Cerrada en reposo: la siguiente frase reconecta. Cerrada a media frase: esa frase falla.
        if (!this.cerrada) this.entrante?.fallar(new Error(`tts_ws_${ev.code ?? "cerrado"}`));
      };
      socket.onmessage = crearLectorMensajes((m) => {
        if (this.socket !== socket) return; // un socket descartado: su audio ya no importa
        if (m.tipo === "binario") {
          if (!this.limpiando) this.entrante?.push({ audio: m.bytes });
          return;
        }
        let msg: { type?: string } | null;
        try {
          msg = JSON.parse(m.texto) as { type?: string } | null;
        } catch {
          return;
        }
        if (msg === null || typeof msg !== "object") return;
        if (msg.type === "Cleared") {
          this.limpiando?.resolver();
          this.limpiando = null;
          return;
        }
        if (this.limpiando) return; // todavia llega lo de la frase cancelada
        if (msg.type === "Flushed") this.entrante?.push({ fin: true });
        // `Warning` NO es fatal (p. ej. un aviso de Flush): si la frase no termina, el tope de espera la corta. `Metadata` no cambia la frase en curso.
      });
    });
  }

  /** Cierra la conexion (estado desconocido: fallo o tope de espera). La siguiente frase reconecta. */
  private descartarSocket(): void {
    const s = this.socket;
    this.socket = null;
    this.limpiando?.resolver();
    this.limpiando = null;
    if (!s) return;
    try {
      s.send(JSON.stringify({ type: "Clear" }));
      s.close(1000, "descartado");
    } catch {
      /* ya cerrado */
    }
  }

  /** Barge-in: `Clear` en la misma conexion; el audio rezagado se descarta hasta que llegue `Cleared`. */
  private cancelarFrase(): void {
    const s = this.socket;
    if (!s) return;
    let resolver!: () => void;
    const promesa = new Promise<void>((r) => {
      resolver = r;
    });
    this.limpiando = { promesa, resolver };
    try {
      s.send(JSON.stringify({ type: "Clear" }));
    } catch {
      this.descartarSocket();
    }
  }

  flushesDisponibles(): number {
    const t = this.ahora();
    while (this.flushes.length > 0 && t - (this.flushes[0] as number) >= VENTANA_FLUSH_MS) this.flushes.shift();
    return Math.max(0, FLUSH_MAX_POR_VENTANA - 1 - this.flushes.length);
  }

  /** Reserva un Flush. Sin disponibles (margen de 1 bajo el limite duro de Deepgram) ESPERA a que se libere la ventana de 60 s; si no se libera dentro del tope, falla con `tts_flush_limite`. */
  private async esperarFlush(senal: AbortSignal): Promise<void> {
    const tope = this.o.flushEsperaMaxMs ?? 10_000;
    const limite = this.ahora() + tope;
    while (this.flushesDisponibles() <= 0) {
      const libera = (this.flushes[0] as number) + VENTANA_FLUSH_MS;
      if (libera > limite) throw new Error("tts_flush_limite");
      await new Promise<void>((resolver) => {
        const t = setTimeout(resolver, Math.max(1, libera - this.ahora()));
        senal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolver();
          },
          { once: true },
        );
      });
      if (senal.aborted || this.cerrada) return;
    }
    this.flushes.push(this.ahora());
  }

  /** Espera `p` con un tope; el temporizador siempre se limpia. */
  private conTope<T>(p: Promise<T>, ms: number, codigo: string): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const tope = new Promise<never>((_, rechazar) => {
      t = setTimeout(() => rechazar(new Error(codigo)), ms);
    });
    return Promise.race([p, tope]).finally(() => clearTimeout(t));
  }

  sintetizar(texto: string, senal: AbortSignal): AsyncIterable<Uint8Array> {
    return this.frase(texto, senal);
  }

  private async *frase(texto: string, senal: AbortSignal): AsyncGenerator<Uint8Array> {
    // Una frase a la vez: espera a que termine (o se cancele) la anterior.
    const previo = this.turnoAnterior;
    let liberar!: () => void;
    this.turnoAnterior = new Promise<void>((r) => {
      liberar = r;
    });
    await previo;
    let fin: "completa" | "cancelada" | "error" = "cancelada";
    try {
      if (this.cerrada) throw new Error("tts_cerrado");
      if (senal.aborted) return;
      // Tras un barge-in se espera el `Cleared` de la MISMA conexion; si no llega, se reconecta.
      if (this.limpiando) {
        await this.conTope(this.limpiando.promesa, this.o.clearTimeoutMs ?? 2_000, "tts_clear_timeout").catch(() => this.descartarSocket());
        // La espera pudo terminar PORQUE se cerro la sesion (cerrar() cierra el socket): no se reconecta ni se manda nada (colgar no deja sockets ni cobra caracteres).
        if (this.cerrada || senal.aborted) return;
      }
      if (!this.socket) await this.conectar().catch(() => Promise.reject(new Error("tts_ws_apertura")));
      if (this.cerrada || senal.aborted) {
        // Se colgo mientras se abria el socket nuevo: se cierra de inmediato.
        this.descartarSocket();
        return;
      }
      const socket = this.socket as SocketDeepgram | null;
      if (!socket) throw new Error("tts_ws_cerrado");
      const cola = new ColaAsync<Entrante>();
      this.entrante = cola;
      const alAbortar = (): void => cola.cerrar();
      senal.addEventListener("abort", alAbortar, { once: true });
      const tope = this.o.fraseTimeoutMs ?? this.o.config.fraseTimeoutMs;
      const recorte = crearRecortadorInicial(this.o.config.silencioInicial, this.hzSalida);
      try {
        await this.esperarFlush(senal);
        if (this.cerrada || senal.aborted) return;
        for (const parte of partirTexto(texto)) socket.send(JSON.stringify({ type: "Speak", text: parte }));
        socket.send(JSON.stringify({ type: "Flush" }));
        let sobrante: number | null = null;
        for (;;) {
          if (senal.aborted) return;
          const item = await this.conTope(cola.siguiente(), tope, "tts_timeout");
          if (item === null) return; // abortada
          if ("fin" in item) {
            fin = "completa";
            const cola = recorte.terminar();
            if (cola !== null) yield cola;
            return;
          }
          // Las tramas pueden partir una muestra de 16 bits: se conserva el byte suelto para que cada trozo entregado sea de longitud par.
          let bytes = item.audio;
          if (sobrante !== null) {
            const junto = new Uint8Array(bytes.byteLength + 1);
            junto[0] = sobrante;
            junto.set(bytes, 1);
            bytes = junto;
            sobrante = null;
          }
          if (bytes.byteLength % 2 === 1) {
            sobrante = bytes[bytes.byteLength - 1] as number;
            bytes = bytes.subarray(0, bytes.byteLength - 1);
          }
          const util = recorte.procesar(bytes);
          if (util !== null && util.byteLength > 0) yield util;
        }
      } finally {
        senal.removeEventListener("abort", alAbortar);
        this.entrante = null;
      }
    } catch (err) {
      fin = "error";
      throw err;
    } finally {
      // Fallo o tope de espera: estado desconocido, se descarta la conexion. Cancelada a media frase (barge-in o el consumidor dejo de iterar): `Clear` en la misma conexion.
      if (fin === "error") this.descartarSocket();
      else if (fin === "cancelada") this.cancelarFrase();
      liberar();
    }
  }

  async cerrar(): Promise<void> {
    if (this.cerrada) return;
    this.cerrada = true;
    const s = this.socket;
    this.socket = null;
    this.entrante?.cerrar();
    try {
      s?.send(JSON.stringify({ type: "Close" }));
      s?.close(1000, "fin_de_llamada");
    } catch {
      /* ya cerrado */
    }
  }
}

/** Puerto de TTS sobre Deepgram Aura-2. La llave va en la cabecera `Authorization: Token`. */
export function crearTtsDeepgram(opts: DeepgramTtsOpciones): PuertoTtsVoz {
  return {
    async abrir(opciones: OpcionesTts) {
      const sesion = new SesionDeepgramTts(opciones.voz, opciones.hzSalida, opts);
      await sesion.conectar();
      return sesion;
    },
  };
}
