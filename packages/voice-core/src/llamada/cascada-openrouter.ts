// Escalon 2 de la escalera de voz: CASCADA sobre OpenRouter, con la MISMA llave `OPENROUTER_API_KEY` que ya usa el texto.
//   audio del cliente -> STT   POST {base}/audio/transcriptions
//                     -> LLM   por el PUERTO `PuertoLlmVoz` (en produccion el gateway de agent-core, con su presupuesto, kill-switch y registro de uso)
//                     -> TTS   POST {base}/audio/speech
// Es el respaldo automatico cuando Gemini Live falla o no hay `GEMINI_API_KEY` (config unica en `config-plataforma.ts`).
//
// ESTADO DE VERIFICACION (honesto): las formas de las peticiones de STT/TTS siguen la documentacion publica de OpenRouter y se prueban aqui
// contra un `fetch` FALSO; NO se probaron contra la API real (no hay credencial en este entorno). Los modelos se fijan en `VOZ_PLATAFORMA`.
//
// Corte de turno: la cascada no tiene el VAD del proveedor, asi que decide por energia (RMS del PCM16 de 16 kHz): cuando hay voz y despues
// `cascadaSilencioFinTurnoMs` de silencio, se cierra el turno y se transcribe. Si el cliente habla mientras el agente contesta, se corta
// (barge-in) y se descarta la respuesta pendiente. Nada de esto se loguea con texto: los errores suben como codigos cortos.
import { VOZ_PLATAFORMA } from "../config-plataforma.ts";
import type { ConfigPlataformaVoz } from "../config-plataforma.ts";
import { VozNoConfiguradaError } from "../provider.ts";
import type { ToolDefinicion } from "./ejecutor-tools.ts";
import type { AbrirSesionLlamada, AperturaLlamada, ManejadoresSesion, VozSesionLlamada } from "./sesion.ts";

// ---- Puerto del LLM de texto (lo implementa el gateway de agent-core en la app; el core no depende de el) ----
export interface ToolCallLlmVoz {
  readonly id: string;
  readonly nombre: string;
  readonly argsJson: string;
}
export type MensajeLlmVoz =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCallLlmVoz[] }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };
export interface PeticionLlmVoz {
  readonly system: string;
  readonly mensajes: readonly MensajeLlmVoz[];
  readonly herramientas: readonly ToolDefinicion[];
  /** Modelo de texto elegido por la organizacion (de la lista permitida); el puerto lo manda al gateway como modelo preferido. */
  readonly modeloPreferido?: string;
  readonly senal?: AbortSignal;
  /** Temperatura que debe usar el puerto (`VOZ_PLATAFORMA.cascada.temperatura`). */
  readonly temperatura?: number;
}
export interface RespuestaLlmVoz {
  readonly texto: string;
  readonly toolCalls: readonly ToolCallLlmVoz[];
  /** Costo real del turno segun el gateway (micro-USD, entero). */
  readonly costoMicroUsd: number;
}
export interface PuertoLlmVoz {
  completar(peticion: PeticionLlmVoz): Promise<RespuestaLlmVoz>;
}

export interface CascadaOpenRouterOpciones {
  readonly apiKey: string | null;
  readonly llm: PuertoLlmVoz;
  readonly fetchFn?: typeof fetch;
  readonly config?: ConfigPlataformaVoz;
  /** Umbral de energia (RMS normalizada 0..1) por encima del cual un trozo cuenta como voz. */
  readonly umbralVoz?: number;
  /** Habla minima (ms) para que un turno se transcriba (descarta chasquidos). */
  readonly hablaMinimaMs?: number;
  /** Tope de vueltas modelo -> herramienta -> modelo dentro de un turno. */
  readonly vueltasToolMax?: number;
}

const HZ_ENTRADA = 16_000;

export function energiaRms(pcm16: Uint8Array): number {
  const n = Math.floor(pcm16.byteLength / 2);
  if (n === 0) return 0;
  const vista = new DataView(pcm16.buffer, pcm16.byteOffset, n * 2);
  let suma = 0;
  for (let i = 0; i < n; i++) {
    const m = vista.getInt16(i * 2, true) / 32768;
    suma += m * m;
  }
  return Math.sqrt(suma / n);
}

/** PCM16 mono -> WAV (cabecera de 44 bytes), el contenedor que el STT acepta. */
export function pcm16AWav(pcm16: Uint8Array, hz: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm16.byteLength);
  const v = new DataView(wav.buffer);
  const texto = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  texto(0, "RIFF");
  v.setUint32(4, 36 + pcm16.byteLength, true);
  texto(8, "WAVE");
  texto(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, hz, true);
  v.setUint32(28, hz * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  texto(36, "data");
  v.setUint32(40, pcm16.byteLength, true);
  wav.set(pcm16, 44);
  return wav;
}

/** Pista de vocabulario para el STT (nombres y apodos del menu): terminos unicos, sin vacios, hasta `max`. Sin terminos no agrega nada. */
export function pistaVocabulario(vocabulario: readonly string[] | undefined, max: number): { prompt?: string } {
  const terminos = new Map<string, string>();
  for (const t of vocabulario ?? []) {
    if (terminos.size >= max) break;
    const limpio = t.replace(/\s+/g, " ").trim();
    if (limpio !== "" && !terminos.has(limpio.toLowerCase())) terminos.set(limpio.toLowerCase(), limpio);
  }
  return terminos.size === 0 ? {} : { prompt: `Vocabulario del menu: ${[...terminos.values()].join(", ")}.` };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

class ErrorEtapa extends Error {
  constructor(readonly etapa: "stt" | "llm" | "tts", readonly estado?: number) {
    super(`cascada_${etapa}${estado ? `_${estado}` : ""}`);
  }
}

class SesionCascada implements VozSesionLlamada {
  private readonly mensajes: MensajeLlmVoz[] = [];
  private pcm: Uint8Array[] = [];
  private hablaMs = 0;
  private silencioMs = 0;
  private hayVoz = false;
  private cerrada = false;
  private ocupada = false;
  private generacion = 0;
  private control: AbortController | null = null;
  private cadena: Promise<void> = Promise.resolve();

  constructor(
    private readonly apertura: AperturaLlamada,
    private readonly h: ManejadoresSesion,
    private readonly o: Required<Pick<CascadaOpenRouterOpciones, "llm" | "umbralVoz" | "hablaMinimaMs" | "vueltasToolMax">> & { apiKey: string; fetchFn: typeof fetch; config: ConfigPlataformaVoz },
  ) {}

  enviarTexto(texto: string): void {
    if (this.cerrada) return;
    this.encolar(() => this.turno(texto, null));
  }

  enviarAudio(pcm16: Uint8Array): void {
    if (this.cerrada || pcm16.byteLength === 0) return;
    const ms = (pcm16.byteLength / 2 / HZ_ENTRADA) * 1000;
    const esVoz = energiaRms(pcm16) >= this.o.umbralVoz;
    if (esVoz) {
      // Barge-in: el cliente habla mientras el agente contesta.
      if (this.ocupada) this.interrumpir();
      this.hayVoz = true;
      this.hablaMs += ms;
      this.silencioMs = 0;
      this.pcm.push(pcm16);
    } else if (this.hayVoz) {
      this.silencioMs += ms;
      this.pcm.push(pcm16);
      if (this.silencioMs >= this.o.config.cascadaSilencioFinTurnoMs) this.cerrarTurnoDeAudio();
    }
  }

  interrumpir(): void {
    if (this.cerrada) return;
    this.generacion += 1;
    this.control?.abort();
    if (this.ocupada) this.h.interrumpido();
  }

  async cerrar(): Promise<void> {
    this.cerrada = true;
    this.generacion += 1;
    this.control?.abort();
    this.pcm = [];
  }

  /** Espera a que termine lo que esta en curso (pruebas y simulador). */
  inactivo(): Promise<void> {
    return this.cadena;
  }

  private cerrarTurnoDeAudio(): void {
    const trozos = this.pcm;
    const habla = this.hablaMs;
    this.pcm = [];
    this.hayVoz = false;
    this.hablaMs = 0;
    this.silencioMs = 0;
    if (habla < this.o.hablaMinimaMs) return;
    const total = trozos.reduce((s, t) => s + t.byteLength, 0);
    const audio = new Uint8Array(total);
    let off = 0;
    for (const t of trozos) {
      audio.set(t, off);
      off += t.byteLength;
    }
    this.encolar(() => this.turno(null, audio));
  }

  private encolar(fn: () => Promise<void>): void {
    this.cadena = this.cadena.then(fn).catch(() => undefined);
  }

  private falla(err: unknown): void {
    const codigo = err instanceof ErrorEtapa ? err.message : "cascada_error";
    this.cerrada = true;
    this.h.caido(codigo, null);
  }

  /** Un turno completo: (STT) -> LLM con herramientas -> TTS. `entrada` = texto ya transcrito, o audio a transcribir. */
  private async turno(texto: string | null, audio: Uint8Array | null): Promise<void> {
    if (this.cerrada) return;
    const mia = ++this.generacion;
    const vigente = () => !this.cerrada && this.generacion === mia;
    this.control = new AbortController();
    const senal = this.control.signal;
    this.ocupada = true;
    try {
      let dicho = texto;
      if (dicho === null && audio !== null) {
        dicho = await this.transcribir(audio, senal);
        if (!vigente()) return;
        if (dicho.trim() === "") return; // silencio o ruido: no hay turno que contestar
        this.h.usuarioDijo?.(dicho);
      }
      if (dicho === null) return;
      this.mensajes.push({ role: "user", content: dicho });

      let respuesta = "";
      for (let vuelta = 0; vuelta <= this.o.vueltasToolMax; vuelta++) {
        const r = await this.completar(senal);
        if (!vigente()) return;
        this.h.costo?.(r.costoMicroUsd);
        this.mensajes.push({ role: "assistant", content: r.texto, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}) });
        if (r.toolCalls.length === 0) {
          respuesta = r.texto;
          break;
        }
        for (const tc of r.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            const p = JSON.parse(tc.argsJson || "{}") as unknown;
            if (p && typeof p === "object" && !Array.isArray(p)) args = p as Record<string, unknown>;
          } catch {
            /* argumentos ilegibles: la herramienta los rechazara con su propio error */
          }
          let salida: unknown;
          try {
            salida = await this.h.ejecutarTool({ id: tc.id, nombre: tc.nombre, args });
          } catch {
            salida = { error: "herramienta_fallo" };
          }
          if (!vigente()) return;
          this.mensajes.push({ role: "tool", toolCallId: tc.id, content: JSON.stringify(salida ?? null) });
        }
        if (vuelta === this.o.vueltasToolMax) respuesta = r.texto;
      }
      if (respuesta.trim() === "") {
        this.h.agenteTermino();
        return;
      }
      this.h.agenteDijo(respuesta);
      const pcm = await this.sintetizar(respuesta, senal);
      if (!vigente()) return;
      this.h.costo?.(Math.ceil((respuesta.length / 1000) * this.o.config.cascada.ttsMicroUsdPorMilCaracteres));
      this.h.audioAgente?.(pcm);
      this.h.agenteTermino();
    } catch (err) {
      if (senal.aborted || !vigente()) return; // cortado por barge-in o cierre: no es una falla
      this.falla(err);
    } finally {
      if (this.generacion === mia) this.ocupada = false;
    }
  }

  private async completar(senal: AbortSignal): Promise<RespuestaLlmVoz> {
    try {
      return await this.o.llm.completar({
        system: this.apertura.instruccion,
        mensajes: this.mensajes,
        herramientas: this.apertura.herramientas,
        ...(this.apertura.modeloLlm ? { modeloPreferido: this.apertura.modeloLlm } : {}),
        // Temperatura de la organizacion (ajustes del agente); sin ajuste, la de la plataforma.
        temperatura: typeof this.apertura.temperatura === "number" ? this.apertura.temperatura : this.o.config.cascada.temperatura,
        senal,
      });
    } catch {
      throw new ErrorEtapa("llm");
    }
  }

  private async transcribir(pcm16: Uint8Array, senal: AbortSignal): Promise<string> {
    const { config } = this.o;
    let res: Response;
    try {
      res = await this.o.fetchFn(`${config.cascada.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({ model: config.cascada.modeloStt, language: "es", ...pistaVocabulario(this.apertura.vocabulario, config.cascada.vocabularioMax), input_audio: { data: base64(pcm16AWav(pcm16, HZ_ENTRADA)), format: "wav" } }),
        signal: senal,
      });
    } catch {
      throw new ErrorEtapa("stt");
    }
    if (!res.ok) throw new ErrorEtapa("stt", res.status);
    this.h.costo?.(Math.ceil((pcm16.byteLength / 2 / HZ_ENTRADA) * config.cascada.sttMicroUsdPorSegundoAudio));
    try {
      const cuerpo = (await res.json()) as { text?: unknown };
      return typeof cuerpo.text === "string" ? cuerpo.text : "";
    } catch {
      throw new ErrorEtapa("stt", res.status);
    }
  }

  private async sintetizar(texto: string, senal: AbortSignal): Promise<Uint8Array> {
    const { config } = this.o;
    let res: Response;
    try {
      res = await this.o.fetchFn(`${config.cascada.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({ model: config.cascada.modeloTts, input: texto, voice: this.apertura.voiceId, response_format: "pcm" }),
        signal: senal,
      });
    } catch {
      throw new ErrorEtapa("tts");
    }
    if (!res.ok) throw new ErrorEtapa("tts", res.status);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new ErrorEtapa("tts", res.status);
    }
  }
}

export interface ProveedorCascadaLlamada {
  readonly abrirSesion: AbrirSesionLlamada;
  inactivo(): Promise<void>;
}

/** Fabrica de sesiones de la cascada. Sin `apiKey` lanza `VozNoConfiguradaError` (el escalon se salta, nunca finge). */
export function crearProveedorCascadaLlamada(opts: CascadaOpenRouterOpciones): ProveedorCascadaLlamada {
  let ultima: SesionCascada | null = null;
  const abrirSesion: AbrirSesionLlamada = async (apertura, manejadores) => {
    if (!opts.apiKey || opts.apiKey.trim() === "") throw new VozNoConfiguradaError("Voz no configurada: falta OPENROUTER_API_KEY para la cascada de respaldo.");
    ultima = new SesionCascada(apertura, manejadores, {
      llm: opts.llm,
      apiKey: opts.apiKey,
      fetchFn: opts.fetchFn ?? fetch,
      config: opts.config ?? VOZ_PLATAFORMA,
      umbralVoz: opts.umbralVoz ?? 0.02,
      hablaMinimaMs: opts.hablaMinimaMs ?? 250,
      vueltasToolMax: opts.vueltasToolMax ?? 4,
    });
    return ultima;
  };
  return { abrirSesion, inactivo: () => ultima?.inactivo() ?? Promise.resolve() };
}
