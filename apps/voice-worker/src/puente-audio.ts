// Puente de audio de UNA llamada: lleva el audio del llamante (cualquier tasa: 8, 16 o 48 kHz) a PCM16 de 16 kHz para el escalon de voz, reproduce
// el audio del agente (24 kHz) y los pregrabados hacia la linea, y le cuenta al controlador lo que oye en la linea: habla del cliente (barge-in),
// silencio, DTMF y el reloj de la llamada. Tambien mide la LATENCIA DE VOZ A VOZ (B-36): del ultimo audio con voz del cliente al primer audio del
// agente en cada turno.
//
// No crea temporizadores ni lee el reloj por su cuenta: `ahora` y `tickSegundo()` los pone quien la conduce (la orquestacion, con un solo intervalo
// que siempre se limpia, o las pruebas con tiempo manual).
import type { AudioWav } from "./audio/pcm.ts";
import { bytesAMuestras, energiaMuestras, muestrasABytes } from "./audio/pcm.ts";
import { Remuestreador } from "./audio/remuestreo.ts";
import type { LlamadaTelefonica } from "./telefonia/puerto.ts";

export const HZ_ENTRADA_ESCALON = 16_000;
export const HZ_SALIDA_ESCALON = 24_000;

/** Lo que el puente le pide al controlador (los metodos de `ControladorLlamada`). */
export interface DestinoEventosLlamada {
  usuarioHabla(): Promise<void>;
  silencio(ms: number): Promise<void>;
  dtmf(digito: string): Promise<void>;
  tick(segundos: number): Promise<void>;
}

export interface OpcionesPuente {
  readonly tel: LlamadaTelefonica;
  readonly eventos: DestinoEventosLlamada;
  /** Entrega audio PCM16 LE de 16 kHz a la sesion del escalon que atiende (o lo descarta si no hay). */
  readonly enviarASesion: (pcm16: Uint8Array) => void;
  readonly ahora: () => number;
  /** RMS (0..1) desde el cual un trozo cuenta como voz. */
  readonly umbralVoz?: number;
  /** Silencio (ms) que da por terminado el turno del cliente. */
  readonly finVozMs?: number;
  /** Voz continua (ms) necesaria para considerar que el cliente empezo a hablar (descarta chasquidos). */
  readonly inicioVozMs?: number;
}

export class PuenteAudio {
  private readonly umbral: number;
  private readonly finVozMs: number;
  private readonly inicioVozMs: number;
  private remuestreoEntrada: Remuestreador | null = null;
  private hzEntradaActual = 0;

  private clienteHablando = false;
  private vozAcumuladaMs = 0;
  private silencioAcumuladoMs = 0;
  private ultimaVozEn: number;
  private esperandoRespuesta = false;
  private finVozEn = 0;

  private generacion = 0;
  private cola: Promise<void> = Promise.resolve();
  private enCola = 0;
  private ultimoAudioAgenteFin: number;
  private segundos = 0;
  private cerrado = false;

  /** Latencia de voz a voz (ms) de cada respuesta del agente que siguio a una voz del cliente, en orden. El saludo inicial no tiene (nadie hablo antes). */
  readonly latenciasMs: number[] = [];

  constructor(private readonly o: OpcionesPuente) {
    this.umbral = o.umbralVoz ?? 0.015;
    this.finVozMs = o.finVozMs ?? 500;
    this.inicioVozMs = o.inicioVozMs ?? 80;
    this.ultimaVozEn = o.ahora();
    this.ultimoAudioAgenteFin = o.ahora();
    o.tel.alAudio((pcm, hz) => this.entrada(pcm, hz));
    o.tel.alDtmf((d) => void o.eventos.dtmf(d));
  }

  /** Audio del llamante. */
  entrada(pcm: Int16Array, hz: number): void {
    if (this.cerrado || pcm.length === 0) return;
    const ms = (pcm.length / hz) * 1000;
    const hayVoz = energiaMuestras(pcm) >= this.umbral;
    const t = this.o.ahora();
    if (hayVoz) {
      this.vozAcumuladaMs += ms;
      this.silencioAcumuladoMs = 0;
      this.ultimaVozEn = t;
      if (!this.clienteHablando && this.vozAcumuladaMs >= this.inicioVozMs) {
        this.clienteHablando = true;
        this.esperandoRespuesta = false;
        void this.o.eventos.usuarioHabla();
      }
    } else {
      this.silencioAcumuladoMs += ms;
      if (!this.clienteHablando) this.vozAcumuladaMs = 0;
      else if (this.silencioAcumuladoMs >= this.finVozMs) {
        this.clienteHablando = false;
        this.vozAcumuladaMs = 0;
        this.esperandoRespuesta = true;
        this.finVozEn = this.ultimaVozEn;
      }
    }
    if (this.hzEntradaActual !== hz || !this.remuestreoEntrada) {
      this.remuestreoEntrada = new Remuestreador(hz, HZ_ENTRADA_ESCALON);
      this.hzEntradaActual = hz;
    }
    const convertido = this.remuestreoEntrada.procesar(pcm);
    if (convertido.length > 0) this.o.enviarASesion(muestrasABytes(convertido));
  }

  /** Audio PCM16 LE de 24 kHz del agente: se reproduce en orden. La primera pieza tras la voz del cliente fija la latencia del turno. */
  audioAgente(pcm16: Uint8Array): void {
    if (this.cerrado) return;
    if (this.esperandoRespuesta) {
      this.esperandoRespuesta = false;
      this.latenciasMs.push(Math.max(0, this.o.ahora() - this.finVozEn));
    }
    const muestras = bytesAMuestras(pcm16);
    this.encolar(muestras, HZ_SALIDA_ESCALON);
  }

  /** Reproduce un pregrabado y resuelve cuando termino de sonar. */
  async reproducirPregrabado(audio: AudioWav): Promise<void> {
    if (this.cerrado) return;
    this.esperandoRespuesta = false;
    await this.encolar(audio.muestras, audio.hz);
  }

  /** Barge-in o corte del controlador: calla lo que suena y lo encolado. */
  cortarAudio(): void {
    this.generacion += 1;
    this.o.tel.detenerReproduccion();
  }

  /** Espera a que termine lo que esta encolado (la despedida antes de colgar). */
  async vaciar(): Promise<void> {
    await this.cola;
  }

  cerrar(): void {
    this.cerrado = true;
    this.generacion += 1;
  }

  /** Se llama una vez por segundo: reloj de la llamada y silencio del cliente (solo cuando nadie esta hablando). */
  tickSegundo(): void {
    if (this.cerrado) return;
    this.segundos += 1;
    void this.o.eventos.tick(this.segundos);
    if (this.clienteHablando || this.enCola > 0) return;
    const desde = Math.max(this.ultimaVozEn, this.ultimoAudioAgenteFin);
    const ms = this.o.ahora() - desde;
    if (ms > 0) void this.o.eventos.silencio(ms);
  }

  /** Despues de un re-pregunta o un pregrabado el silencio vuelve a contar desde ahi: lo hace `encolar` al drenar. */
  private encolar(muestras: Int16Array, hz: number): Promise<void> {
    const gen = this.generacion;
    this.enCola += 1;
    const p = this.cola.then(async () => {
      try {
        if (gen === this.generacion && !this.cerrado) await this.o.tel.reproducir(muestras, hz);
      } finally {
        this.enCola -= 1;
        if (this.enCola === 0) this.ultimoAudioAgenteFin = this.o.ahora();
      }
    });
    this.cola = p.catch(() => undefined);
    return p;
  }
}
