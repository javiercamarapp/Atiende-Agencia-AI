// Adaptador REAL de la vista previa de llamada: habla con Gemini Live desde el navegador usando el TOKEN EFIMERO que emite la API
// propia (`POST .../admin/voz/preview/sesion`). La API key de la plataforma nunca llega al navegador. Sin credencial en el
// servidor, la API responde 503 y este adaptador lanza el motivo honesto: no hay nada simulado.
//
// La vista previa NO llama herramientas ni registra pedidos (el token fija voz y comportamiento, sin tools): sirve para oir la
// voz, el saludo y el tono del agente configurado. El protocolo de mensajes sigue la documentacion publica de la Live API y se
// prueba aqui contra un WebSocket falso; la primera prueba con credencial real lo confirma (docs/VOZ-PM.md).
import type { LineaTranscripcion, OpcionesIniciarSesionVoz } from "@atiende/ui";
import type { SesionPreviewVoz } from "../lib/voz-client.ts";
import type { AdaptadorVoz, CallbacksAdaptador, FabricaAdaptador } from "./adaptador.ts";
import { aPcm16Base64, dePcm16Base64, nivelRms, remuestrear, TASA_ENTRADA_HZ, TASA_SALIDA_HZ } from "./audio-pcm.ts";

export interface SocketPreview {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface CapturaMicrofono {
  detener(): void;
}

export interface ReproductorAudio {
  /** Encola un bloque (PCM float, mono) a la tasa indicada. */
  encolar(muestras: Float32Array, tasaHz: number): void;
  /** Corta lo que se este reproduciendo (barge-in). */
  cortar(): void;
  /** Nivel 0..1 de lo que suena ahora. */
  nivel(): number;
  cerrar(): void;
}

/** Todo lo que toca el navegador (permiso de microfono, WebSocket, WebAudio) queda detras de esta interfaz. */
export interface EntornoVoz {
  abrirSocket(url: string): SocketPreview;
  /** Pide el microfono y entrega bloques de audio con su tasa de muestreo real. */
  capturarMicrofono(onBloque: (muestras: Float32Array, tasaHz: number) => void): Promise<CapturaMicrofono>;
  crearReproductor(): ReproductorAudio;
  /** Una sola vez; devuelve la funcion que lo cancela. */
  esperar(fn: () => void, ms: number): () => void;
  /** Cada `ms`; devuelve la funcion que lo detiene. */
  repetir(fn: () => void, ms: number): () => void;
  ahora(): number;
}

export interface OpcionesGeminiLive {
  readonly crearSesion: (opts: OpcionesIniciarSesionVoz | undefined) => Promise<SesionPreviewVoz>;
  readonly entorno: EntornoVoz;
}

const INTERVALO_NIVEL_MS = 60;
const SETUP_TIMEOUT_MS = 10_000;

export function crearFabricaGeminiLive(opciones: OpcionesGeminiLive): FabricaAdaptador {
  return (cb) => new AdaptadorGeminiLive(cb, opciones);
}

class AdaptadorGeminiLive implements AdaptadorVoz {
  private socket: SocketPreview | null = null;
  private mic: CapturaMicrofono | null = null;
  private reproductor: ReproductorAudio | null = null;
  private detenerNivel: (() => void) | null = null;
  private silenciado = false;
  private viva = false;
  private n = 0;
  private lineaAgente: { id: string; texto: string } | null = null;
  private lineaUsuario: { id: string; texto: string } | null = null;
  private nivelEntrada = 0;

  constructor(
    private readonly cb: CallbacksAdaptador,
    private readonly o: OpcionesGeminiLive,
  ) {}

  async iniciar(opts?: OpcionesIniciarSesionVoz): Promise<void> {
    try {
      await this.arrancar(opts);
    } catch (err) {
      // Un inicio fallido (sin credencial, micrófono denegado, socket que no abre) no deja nada abierto.
      await this.terminar();
      throw err;
    }
  }

  private async arrancar(opts?: OpcionesIniciarSesionVoz): Promise<void> {
    this.viva = true;
    this.cb.cambiar({ modo: "conectando" });
    // 1) Sesion efimera de la API propia. Un 503 ("falta GEMINI_API_KEY") sube tal cual como error de inicio.
    const sesion = await this.o.crearSesion(opts);
    if (!this.viva) return;
    this.cb.cambiar({ sessionId: sesion.sesionId });

    // 2) Socket con el token efimero.
    const socket = this.o.entorno.abrirSocket(`${sesion.websocketUrl}?access_token=${encodeURIComponent(sesion.tokenProveedor)}`);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const cancelar = this.o.entorno.esperar(() => reject(new Error("Gemini no respondió al abrir la llamada de prueba.")), SETUP_TIMEOUT_MS);
      let listo = false;
      socket.onopen = () => socket.send(JSON.stringify({ setup: { model: `models/${sesion.modelo}`, generationConfig: { responseModalities: ["AUDIO"] }, inputAudioTranscription: {}, outputAudioTranscription: {} } }));
      socket.onerror = () => {
        if (!listo) {
          cancelar();
          reject(new Error("No se pudo conectar con el servicio de voz."));
        }
      };
      socket.onclose = (ev) => {
        if (!listo) {
          cancelar();
          reject(new Error(`El servicio de voz cerró la conexión (código ${ev.code ?? "?"}).`));
          return;
        }
        this.alCerrarSocket();
      };
      socket.onmessage = (ev) => {
        const msg = parsear(ev.data);
        if (!msg) return;
        if (!listo) {
          if (msg.setupComplete !== undefined) {
            listo = true;
            cancelar();
            resolve();
          }
          return;
        }
        this.recibir(msg);
      };
    });
    if (!this.viva) return;

    // 3) Audio: reproductor y microfono (el permiso lo pide el navegador aqui).
    this.reproductor = this.o.entorno.crearReproductor();
    this.mic = await this.o.entorno.capturarMicrofono((muestras, tasa) => this.alBloqueMicrofono(muestras, tasa));
    if (!this.viva) {
      this.mic.detener();
      return;
    }
    this.detenerNivel = this.o.entorno.repetir(() => this.sondearNivel(), INTERVALO_NIVEL_MS);
    this.cb.cambiar({ modo: "escuchando" });
  }

  private alBloqueMicrofono(muestras: Float32Array, tasa: number): void {
    if (!this.viva || !this.socket) return;
    this.nivelEntrada = this.silenciado ? 0 : nivelRms(muestras);
    if (this.silenciado) return;
    const pcm = remuestrear(muestras, tasa, TASA_ENTRADA_HZ);
    this.socket.send(JSON.stringify({ realtimeInput: { audio: { data: aPcm16Base64(pcm), mimeType: `audio/pcm;rate=${TASA_ENTRADA_HZ}` } } }));
  }

  private sondearNivel(): void {
    if (!this.viva) return;
    this.cb.cambiar({ volumenEntrada: this.nivelEntrada, volumenSalida: this.reproductor?.nivel() ?? 0 });
  }

  private recibir(msg: Record<string, unknown>): void {
    const c = msg.serverContent as
      | { modelTurn?: { parts?: { inlineData?: { data?: string } }[] }; interrupted?: boolean; turnComplete?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string } }
      | undefined;
    if (!c) return;
    for (const parte of c.modelTurn?.parts ?? []) {
      const data = parte.inlineData?.data;
      if (typeof data === "string" && data) {
        this.reproductor?.encolar(dePcm16Base64(data), TASA_SALIDA_HZ);
        this.cb.cambiar({ modo: "hablando" });
      }
    }
    if (c.inputTranscription?.text) this.fragmento("usuario", c.inputTranscription.text);
    if (c.outputTranscription?.text) this.fragmento("agente", c.outputTranscription.text);
    if (c.interrupted) {
      this.reproductor?.cortar();
      this.cerrarLineas();
      this.cb.cambiar({ modo: "escuchando" });
    }
    if (c.turnComplete) {
      this.cerrarLineas();
      this.cb.cambiar({ modo: "escuchando" });
    }
  }

  private fragmento(rol: "agente" | "usuario", texto: string): void {
    const ref = rol === "agente" ? this.lineaAgente : this.lineaUsuario;
    const actual = ref ?? { id: `${rol}-${++this.n}`, texto: "" };
    actual.texto += texto;
    if (rol === "agente") this.lineaAgente = actual;
    else this.lineaUsuario = actual;
    const linea: LineaTranscripcion = { id: actual.id, rol, texto: actual.texto, parcial: true, ts: this.o.entorno.ahora() };
    this.cb.linea(linea);
  }

  private cerrarLineas(): void {
    for (const [rol, ref] of [["agente", this.lineaAgente], ["usuario", this.lineaUsuario]] as const) {
      if (ref) this.cb.linea({ id: ref.id, rol, texto: ref.texto, parcial: false, ts: this.o.entorno.ahora() });
    }
    this.lineaAgente = null;
    this.lineaUsuario = null;
  }

  private alCerrarSocket(): void {
    if (!this.viva) return;
    this.liberar();
    this.cb.cambiar({ modo: "error", error: { codigo: "conexion", mensaje: "Se perdió la conexión con el servicio de voz.", recuperable: true } });
  }

  private liberar(): void {
    this.viva = false;
    this.detenerNivel?.();
    this.detenerNivel = null;
    this.mic?.detener();
    this.mic = null;
    this.reproductor?.cerrar();
    this.reproductor = null;
  }

  async terminar(): Promise<void> {
    this.viva = false;
    const socket = this.socket;
    this.socket = null;
    this.liberar();
    try {
      socket?.close();
    } catch {
      /* ya cerrado */
    }
  }

  silenciar(silenciar: boolean): void {
    this.silenciado = silenciar;
    if (silenciar) this.nivelEntrada = 0;
  }
}

function parsear(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}
