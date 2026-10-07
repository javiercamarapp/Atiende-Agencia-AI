// Telefonia FALSA: inyecta audio PCM (de archivos o de los guiones del simulador) y captura lo que el agente reproduce. Sin red ni reloj propio:
// `reproducir` resuelve de inmediato, asi una prueba controla el tiempo con los relojes falsos de vitest sin colgarse.
import type { LlamadaTelefonica, TelefoniaPort } from "./puerto.ts";

export interface OpcionesLlamadaFalsa {
  readonly id?: string;
  readonly dnis?: string | null;
  /** Telefono del llamante en cualquier forma habitual; `null` = llamante anonimo (sin caller ID). */
  readonly desde?: string | null;
  readonly desviadaDesde?: string | null;
}

export interface TrozoSalida {
  readonly pcm: Int16Array;
  readonly hz: number;
  /** Cuantos cortes de reproduccion (barge-in) habia hasta ese momento. */
  readonly cortesPrevios: number;
}

export class LlamadaFalsa implements LlamadaTelefonica {
  readonly id: string;
  readonly dnis: string | null;
  readonly sipFrom: string | null;
  readonly desviadaDesde: string | null;
  /** Todo lo que el agente reproduce, en orden. */
  readonly salida: TrozoSalida[] = [];
  cortes = 0;
  colgadaPorSistema = false;
  private cbAudio: ((pcm: Int16Array, hz: number) => void) | null = null;
  private cbDtmf: ((d: string) => void) | null = null;
  private cbColgar: (() => void) | null = null;
  private colgo = false;

  constructor(opts: OpcionesLlamadaFalsa = {}, contador = 0) {
    this.id = opts.id ?? `llamada-sim-${contador}`;
    this.dnis = opts.dnis === undefined ? null : opts.dnis;
    this.sipFrom = opts.desde === undefined || opts.desde === null ? (opts.desde === null ? "<sip:anonymous@anonymous.invalid>" : null) : `<sip:${opts.desde}@trunk.sim.invalid;user=phone>`;
    this.desviadaDesde = opts.desviadaDesde ?? null;
  }

  alAudio(cb: (pcm: Int16Array, hz: number) => void): void {
    this.cbAudio = cb;
  }
  alDtmf(cb: (digito: string) => void): void {
    this.cbDtmf = cb;
  }
  alColgar(cb: () => void): void {
    this.cbColgar = cb;
    if (this.colgo) cb();
  }
  async reproducir(pcm: Int16Array, hz: number): Promise<void> {
    if (this.colgo) return;
    this.salida.push({ pcm, hz, cortesPrevios: this.cortes });
  }
  detenerReproduccion(): void {
    this.cortes += 1;
  }
  async colgar(): Promise<void> {
    this.colgadaPorSistema = true;
    this.terminar();
  }

  // ---- lado del "cliente" (pruebas) ----
  /** El cliente habla: entrega audio a quien lo suscribio. */
  hablar(pcm: Int16Array, hz: number): void {
    if (!this.colgo) this.cbAudio?.(pcm, hz);
  }
  teclear(digito: string): void {
    if (!this.colgo) this.cbDtmf?.(digito);
  }
  clienteCuelga(): void {
    this.terminar();
  }
  get terminada(): boolean {
    return this.colgo;
  }
  private terminar(): void {
    if (this.colgo) return;
    this.colgo = true;
    this.cbColgar?.();
  }
}

export class TelefoniaFalsa implements TelefoniaPort {
  private alLlegar: ((l: LlamadaTelefonica) => void) | null = null;
  private contador = 0;
  readonly llamadas: LlamadaFalsa[] = [];
  detenida = false;

  async escuchar(alLlegar: (llamada: LlamadaTelefonica) => void): Promise<void> {
    this.alLlegar = alLlegar;
  }
  async detener(): Promise<void> {
    this.detenida = true;
    this.alLlegar = null;
  }

  /** Simula una llamada entrante. Lanza si nadie esta escuchando (la prueba esta mal armada). */
  llamar(opts: OpcionesLlamadaFalsa = {}): LlamadaFalsa {
    if (!this.alLlegar) throw new Error("TelefoniaFalsa: nadie escucha llamadas (falta `escuchar`).");
    const llamada = new LlamadaFalsa(opts, this.contador++);
    this.llamadas.push(llamada);
    this.alLlegar(llamada);
    return llamada;
  }
}
