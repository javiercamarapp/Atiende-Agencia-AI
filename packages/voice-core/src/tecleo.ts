// SONIDO DE TECLEO de la llamada: cuando el agente "teclea" (ejecuta una herramienta: cotizar, confirmar, crear pedido, buscar cliente) y espera el resultado
// sin hablar, se oye un tecleo corto de teclado/POS. SINTETIZADO (sin assets con licencia), determinista por semilla y puro.
//
// Dos piezas:
//   * `crearClic`: UN golpe de tecla (ataque de ruido + cuerpo resonante amortiguado + golpe grave + soltado), con variantes (tecla, barra, enter).
//   * `OrquestadorTecleo`: maquina de estados dirigida por el RELOJ DE MUESTRAS (no usa temporizadores ni la hora: `siguiente(n)` avanza n muestras), asi la prueba
//     es exacta y el worker solo lo conecta a los eventos de herramienta de la llamada:
//       - `herramientaInicia(id)` / `herramientaTermina(id, ok)`: el tecleo suena SOLO mientras hay una herramienta en vuelo; sin herramienta, silencio;
//       - rafagas de 0.9-2.5 s con pausas de 0.35-1.1 s mientras dure la herramienta (una herramienta rapida da una sola rafaga de al menos `minRafagaMs`);
//       - fade-in/out; el agente hablando lo silencia (fade) y vuelve a sonar cuando calla si la herramienta sigue;
//       - `clienteHabla()` (barge-in) lo CORTA en ~25 ms y no vuelve hasta la siguiente herramienta;
//       - topes: `topeEpisodioMs` por espera de herramienta y `topeLlamadaMs` en toda la llamada, para que nunca suene de mas;
//       - un "pip" de confirmacion de POS (opcional) al terminar bien una rafaga.
// Los clics viven en 700-3300 Hz con un golpe de ~350 Hz: caben en la banda telefonica (G.711, 300-3400 Hz).
import { crearAzar, realEntre } from "./azar-determinista.ts";

export const TECLEO_VOLUMEN_MIN = 0;
/** Porcentaje maximo del tecleo respecto a plena escala (pico). */
export const TECLEO_VOLUMEN_MAX = 25;
/** Un poco por encima del fondo por omision (8 %) para oirse "sobre el fondo", muy por debajo de la voz del agente. */
export const TECLEO_VOLUMEN_POR_DEFECTO = 12;

export function esVolumenTecleo(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= TECLEO_VOLUMEN_MIN && v <= TECLEO_VOLUMEN_MAX;
}

export type TipoTecla = "tecla" | "barra" | "enter";

/** Forma de onda de UN golpe de tecla, normalizada a pico <= 1. Determinista por la semilla. */
export function crearClic(tipo: TipoTecla, azar: () => number, hz: number): Float64Array {
  const largo = Math.floor((tipo === "tecla" ? 0.075 : 0.11) * hz);
  const s = new Float64Array(largo);
  const fCuerpo = tipo === "tecla" ? realEntre(azar, 1300, 2700) : tipo === "barra" ? realEntre(azar, 700, 1100) : realEntre(azar, 900, 1500);
  const tauCuerpo = (tipo === "tecla" ? realEntre(azar, 0.004, 0.008) : realEntre(azar, 0.01, 0.018)) * hz;
  const fGolpe = realEntre(azar, 300, 440);
  const gGolpe = tipo === "tecla" ? 0.35 : 0.6;
  const faseC = azar() * 2 * Math.PI;
  let previo = 0;
  for (let i = 0; i < largo; i++) {
    const n = azar() * 2 - 1;
    const alto = n - previo; // pasa-altos de una muestra: el "chasquido" del ataque
    previo = n;
    const ataque = alto * Math.exp(-i / (0.0007 * hz)) * 0.9;
    const cuerpo = Math.sin(faseC + (2 * Math.PI * fCuerpo * i) / hz) * Math.exp(-i / tauCuerpo) * 0.8;
    const golpe = Math.sin((2 * Math.PI * fGolpe * i) / hz) * Math.exp(-i / (0.012 * hz)) * gGolpe;
    s[i] = ataque + cuerpo + golpe;
  }
  // Soltado de la tecla: clic pequeno ~70 ms despues (la mayoria de las veces).
  if (azar() < 0.7) {
    const desde = Math.floor(realEntre(azar, 0.055, 0.07) * hz);
    for (let i = 0; desde + i < largo && i < 0.01 * hz; i++) s[desde + i]! += (azar() * 2 - 1) * Math.exp(-i / (0.0015 * hz)) * 0.22;
  }
  let p = 0;
  for (let i = 0; i < largo; i++) p = Math.max(p, Math.abs(s[i]!));
  if (p > 0) for (let i = 0; i < largo; i++) s[i] = s[i]! / p;
  return s;
}

/** "Pip" de confirmacion de un POS: seno de ~2 kHz de 28 ms con envolvente suave. */
export function crearPip(hz: number): Float64Array {
  const largo = Math.floor(0.028 * hz);
  const s = new Float64Array(largo);
  for (let i = 0; i < largo; i++) s[i] = Math.sin((2 * Math.PI * 2000 * i) / hz) * Math.sin((Math.PI * i) / largo);
  return s;
}

export interface OpcionesTecleo {
  /** Porcentaje de plena escala (0..TECLEO_VOLUMEN_MAX): el pico maximo del tecleo. 0 = apagado. */
  readonly volumen: number;
  readonly semilla?: number;
  readonly hz?: number;
  /** Una herramienta rapida suena al menos esto (ms). Por omision 500. */
  readonly minRafagaMs?: number;
  /** Largo maximo de una rafaga (ms). Por omision 2500. */
  readonly maxRafagaMs?: number;
  /** Tope de tecleo por cada espera de herramienta (ms). Por omision 8000. */
  readonly topeEpisodioMs?: number;
  /** Tope de tecleo en toda la llamada (ms). Por omision 30000. */
  readonly topeLlamadaMs?: number;
  /** Pip de POS al terminar bien. Por omision true. */
  readonly pip?: boolean;
}

type Fase = "inactivo" | "teclea" | "pausa";

interface Reproduccion {
  buf: Float64Array;
  pos: number;
  gan: number;
  /** El pip de POS no pasa por el fade de la rafaga (suena justo cuando esta termina). */
  fijo?: boolean;
}

const FADE_IN_MS = 40;
const FADE_OUT_MS = 120;
const FADE_CORTE_MS = 25;
const FADE_AGENTE_MS = 60;

export class OrquestadorTecleo {
  readonly volumen: number;
  private readonly hz: number;
  private readonly azar: () => number;
  private readonly minRafaga: number;
  private readonly maxRafaga: number;
  private readonly topeEpisodio: number;
  private readonly topeLlamada: number;
  private readonly conPip: boolean;
  private readonly enVuelo = new Set<string>();
  private fase: Fase = "inactivo";
  private restanteFase = 0;
  private enEpisodio = 0;
  private usadoLlamada = 0;
  private suprimido = false;
  private agenteHabla = false;
  private cortado = false;
  private finOk = true;
  private pipPendiente = false;
  private ganancia = 0;
  private proxTecla = 0;
  private sonidos: Reproduccion[] = [];
  private teclasTotales = 0;

  constructor(o: OpcionesTecleo) {
    if (!esVolumenTecleo(o.volumen)) throw new RangeError(`volumen del tecleo: entero entre ${TECLEO_VOLUMEN_MIN} y ${TECLEO_VOLUMEN_MAX}`);
    this.volumen = o.volumen;
    this.hz = o.hz ?? 24_000;
    this.azar = crearAzar(o.semilla ?? 1);
    this.minRafaga = Math.floor(((o.minRafagaMs ?? 500) / 1000) * this.hz);
    this.maxRafaga = Math.floor(((o.maxRafagaMs ?? 2500) / 1000) * this.hz);
    this.topeEpisodio = Math.floor(((o.topeEpisodioMs ?? 8000) / 1000) * this.hz);
    this.topeLlamada = Math.floor(((o.topeLlamadaMs ?? 30_000) / 1000) * this.hz);
    this.conPip = o.pip ?? true;
  }

  get activo(): boolean {
    return this.volumen > 0;
  }

  /** Hay una herramienta en vuelo. */
  get herramientasEnVuelo(): number {
    return this.enVuelo.size;
  }

  /** El tecleo esta sonando o apagandose ahora mismo. */
  get sonando(): boolean {
    return this.ganancia > 0.001 || this.sonidos.length > 0;
  }

  /** Teclas disparadas desde el inicio (para pruebas y metricas sin PII). */
  get teclas(): number {
    return this.teclasTotales;
  }

  /** Milisegundos de tecleo ya gastados del tope de la llamada. */
  get gastadoMs(): number {
    return Math.round((this.usadoLlamada / this.hz) * 1000);
  }

  herramientaInicia(id: string): void {
    if (!this.activo) return;
    const eraVacio = this.enVuelo.size === 0;
    this.enVuelo.add(id);
    if (!eraVacio) return;
    this.suprimido = false;
    this.cortado = false;
    this.pipPendiente = false;
    this.enEpisodio = 0;
    this.finOk = true;
    this.empezarRafaga();
  }

  herramientaTermina(id: string, ok = true): void {
    if (!this.enVuelo.delete(id)) return;
    if (!ok) this.finOk = false;
    if (this.enVuelo.size > 0) return;
    // La rafaga en curso termina cuando cumple el minimo; en pausa, no hay nada que apagar.
    if (this.fase === "teclea") {
      this.restanteFase = Math.max(0, Math.min(this.restanteFase, this.minRafaga - this.enEpisodio));
      if (this.finOk && this.conPip) this.pipPendiente = true;
    } else {
      this.fase = "inactivo";
    }
  }

  /** Barge-in: el cliente habla. Corta el tecleo (fade de ~25 ms) y no vuelve hasta la siguiente herramienta. */
  clienteHabla(): void {
    this.suprimido = true;
    this.cortado = true;
    this.pipPendiente = false;
    this.fase = "inactivo";
    this.sonidos = this.sonidos.filter((r) => !r.fijo);
  }

  /** El agente esta hablando: el tecleo se calla (fade) y vuelve cuando calla si la herramienta sigue. */
  fijarAgenteHablando(habla: boolean): void {
    this.agenteHabla = habla;
  }

  private empezarRafaga(): void {
    this.fase = "teclea";
    this.restanteFase = Math.floor(realEntre(this.azar, 0.9 * this.hz, this.maxRafaga));
    this.proxTecla = Math.floor(0.03 * this.hz);
  }

  private lanzarTecla(): void {
    const u = this.azar();
    const tipo: TipoTecla = u < 0.1 ? "barra" : "tecla";
    this.sonidos.push({ buf: crearClic(tipo, this.azar, this.hz), pos: 0, gan: realEntre(this.azar, 0.65, 1) });
    this.teclasTotales++;
    // Ritmo humano: 70-200 ms entre teclas y alguna duda de 250-450 ms.
    const dudar = this.azar() < 0.08;
    const ms = dudar ? realEntre(this.azar, 250, 450) : 70 + 130 * Math.pow(this.azar(), 1.6);
    this.proxTecla = Math.floor((ms / 1000) * this.hz);
  }

  /** Siguientes `n` muestras del tecleo (Float64, ya a su volumen, |x| < volumen/100). Silencio si no hay herramienta, si esta apagado o cortado. */
  siguiente(n: number, destino?: Float64Array): Float64Array {
    const salida = destino && destino.length >= n ? destino.subarray(0, n) : new Float64Array(n);
    salida.fill(0);
    if (!this.activo) return salida;
    const tope = this.volumen / 100;
    const pasoIn = 1 / ((FADE_IN_MS / 1000) * this.hz);
    const pasoOut = 1 / ((FADE_OUT_MS / 1000) * this.hz);
    const pasoCorte = 1 / ((FADE_CORTE_MS / 1000) * this.hz);
    const pasoAgente = 1 / ((FADE_AGENTE_MS / 1000) * this.hz);
    for (let i = 0; i < n; i++) {
      const teclea = this.fase === "teclea" && !this.suprimido;
      const permitido = teclea && !this.agenteHabla && this.usadoLlamada < this.topeLlamada && this.enEpisodio < this.topeEpisodio;
      // Reloj de las fases (solo avanza mientras hay rafaga o pausa)
      if (this.fase === "teclea" && !this.suprimido) {
        if (permitido) {
          this.enEpisodio++;
          this.usadoLlamada++;
          if (--this.proxTecla <= 0) this.lanzarTecla();
        }
        if (--this.restanteFase <= 0) {
          if (this.pipPendiente) {
            this.pipPendiente = false;
            this.sonidos.push({ buf: crearPip(this.hz), pos: 0, gan: 0.45, fijo: true });
          }
          if (this.enVuelo.size > 0 && this.enEpisodio < this.topeEpisodio) {
            this.fase = "pausa";
            this.restanteFase = Math.floor(realEntre(this.azar, 0.35, 1.1) * this.hz);
          } else this.fase = "inactivo";
        }
      } else if (this.fase === "pausa") {
        if (--this.restanteFase <= 0) {
          if (this.enVuelo.size > 0 && this.enEpisodio < this.topeEpisodio && this.usadoLlamada < this.topeLlamada) this.empezarRafaga();
          else this.fase = "inactivo";
        }
      }
      // Ganancia (fade) de la rafaga: sube si se permite teclear; baja rapido si corto el cliente, mas suave si habla el agente y normal al terminar
      if (this.cortado) this.ganancia = Math.max(0, this.ganancia - pasoCorte);
      else if (permitido) this.ganancia = Math.min(1, this.ganancia + pasoIn);
      else if (this.agenteHabla && this.fase !== "inactivo") this.ganancia = Math.max(0, this.ganancia - pasoAgente);
      else this.ganancia = Math.max(0, this.ganancia - pasoOut);
      let x = 0;
      if (this.sonidos.length > 0) {
        for (const r of this.sonidos) {
          x += r.buf[r.pos]! * r.gan * (r.fijo ? 1 : this.ganancia);
          r.pos++;
        }
        if (this.sonidos.some((r) => r.pos >= r.buf.length)) this.sonidos = this.sonidos.filter((r) => r.pos < r.buf.length);
      }
      salida[i] = Math.tanh(x * 0.8) * tope;
    }
    return salida;
  }
}
