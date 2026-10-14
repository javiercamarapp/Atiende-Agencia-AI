// Ambiente de RESTAURANTE para la llamada, SINTETIZADO (sin archivos de audio con licencia), determinista por semilla y puro (PCM16 little-endian mono; el
// formato del agente a 24 kHz). Apagado por omision. No hay bucle: todo se genera muestra a muestra con azar determinista y variacion lenta, asi que
// ningun trozo se repite.
//
// Capas (cada preset las mezcla con otro peso):
//   * MURMULLO de sala: varias voces lejanas, cada una un tren glotal (sierra con vibrato) filtrado por tres resonadores de formantes que se deslizan
//     con las silabas (vocales a/e/i/o/u), con frases y pausas al azar, pasadas por un filtro de lejania y dos ecos cortos de sala. No dicen palabras:
//     es el "rumor de gente hablando" en la banda de voz (300-3400 Hz).
//   * CUBIERTOS, platos y vasos esporadicos: sumas de modos amortiguados (no armonicos) que caen en intervalos al azar (Poisson).
//   * COCINA lejana: chisporroteo de sarten (ruido en banda media con chasquidos), extractor (ruido en 350-900 Hz con deriva lenta) y ollas que chocan.
//   * CALLE: rumor de trafico y autos que pasan (barrido de banda), solo en 'calle-ocupada'.
//   * Tono de sala (ruido rosa suave).
// PENSADO PARA EL TELEFONO: la llamada llega por SIP (G.711, 300-3400 Hz). Por eso los modos de cubiertos/platos/vasos y el chisporroteo viven por debajo de
// ~3.3 kHz y el extractor/trafico en 350-1200 Hz: lo grave (<300 Hz) o agudo (>3.4 kHz) lo recortaria la linea y no se oiria.
//
// SEGURIDAD de la llamada: el volumen (0..FONDO_VOLUMEN_MAX, % de plena escala) es el PICO maximo (saturacion suave tanh: el pico nunca lo excede y no hay
// recorte duro), y bajo la voz del agente y la del cliente el ambiente BAJA (ducking suave), asi nunca tapa lo que se dice.
import { crearAzar, realEntre } from "./azar-determinista.ts";

export const FONDO_VOLUMEN_MIN = 0;
/** Porcentaje maximo del fondo respecto a plena escala. */
export const FONDO_VOLUMEN_MAX = 20;
export const FONDO_VOLUMEN_POR_DEFECTO = 8;
export const HZ_AUDIO_AGENTE = 24_000;

export function esVolumenFondo(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= FONDO_VOLUMEN_MIN && v <= FONDO_VOLUMEN_MAX;
}

export const PRESETS_AMBIENTE = ["cocina-taqueria", "sala-tranquila", "calle-ocupada"] as const;
export type PresetAmbiente = (typeof PRESETS_AMBIENTE)[number];
export const PRESET_AMBIENTE_POR_DEFECTO: PresetAmbiente = "cocina-taqueria";

export function esPresetAmbiente(v: unknown): v is PresetAmbiente {
  return typeof v === "string" && (PRESETS_AMBIENTE as readonly string[]).includes(v);
}

interface PerfilAmbiente {
  readonly descripcion: string;
  readonly voces: number;
  /** Fraccion del tiempo que cada voz lejana esta hablando. */
  readonly actividadVoces: number;
  readonly ganVoces: number;
  readonly ganSala: number;
  readonly cubiertosPorMin: number;
  readonly ganCubiertos: number;
  readonly ollasPorMin: number;
  readonly ganSarten: number;
  readonly ganExtractor: number;
  readonly ganCalle: number;
  readonly autosPorMin: number;
}

export const PERFILES_AMBIENTE: Readonly<Record<PresetAmbiente, PerfilAmbiente>> = Object.freeze({
  "cocina-taqueria": Object.freeze({ descripcion: "Taqueria con la cocina a la vista: sarten y extractor presentes, platos y ollas, murmullo animado.", voces: 8, actividadVoces: 0.55, ganVoces: 1, ganSala: 0.35, cubiertosPorMin: 16, ganCubiertos: 0.5, ollasPorMin: 5, ganSarten: 0.55, ganExtractor: 0.45, ganCalle: 0.05, autosPorMin: 0 }),
  "sala-tranquila": Object.freeze({ descripcion: "Comedor tranquilo: pocas voces lejanas, algun cubierto o vaso, cocina casi inaudible.", voces: 4, actividadVoces: 0.4, ganVoces: 0.8, ganSala: 0.3, cubiertosPorMin: 7, ganCubiertos: 0.45, ollasPorMin: 0.5, ganSarten: 0.08, ganExtractor: 0.14, ganCalle: 0, autosPorMin: 0 }),
  "calle-ocupada": Object.freeze({ descripcion: "Restaurante abierto a la calle: trafico y autos que pasan, pocas voces, cocina lejana.", voces: 5, actividadVoces: 0.45, ganVoces: 0.55, ganSala: 0.2, cubiertosPorMin: 6, ganCubiertos: 0.35, ollasPorMin: 2, ganSarten: 0.14, ganExtractor: 0.12, ganCalle: 1, autosPorMin: 7 }),
});

/** Nivel RMS (relativo, antes de la saturacion) al que se lleva la suma de capas: el pico acotado por tanh deja el RMS final en ~0.2-0.3 del tope. */
const RMS_OBJETIVO = 0.28;

class Biquad {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private readonly hz: number) {}
  /** Pasa-banda de ganancia pico 0 dB (receta RBJ). */
  banda(f: number, q: number): void {
    const w0 = (2 * Math.PI * Math.min(f, this.hz * 0.45)) / this.hz;
    const alfa = Math.sin(w0) / (2 * q);
    const a0 = 1 + alfa;
    this.b0 = alfa / a0;
    this.b1 = 0;
    this.b2 = -alfa / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alfa) / a0;
  }
  p(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class UnPolo {
  private y = 0;
  private readonly a: number;
  constructor(corteHz: number, hz: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * corteHz) / hz);
  }
  p(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

/** Proceso de Ornstein-Uhlenbeck de varianza unitaria: variacion lenta (`tauSeg`) sin saltos. */
class DerivaLenta {
  private v = 0;
  private readonly a: number;
  private readonly b: number;
  constructor(private readonly azar: () => number, hz: number, tauSeg: number) {
    this.a = Math.exp(-1 / (tauSeg * hz));
    this.b = Math.sqrt(1 - this.a * this.a) * Math.sqrt(3);
  }
  p(): number {
    this.v = this.v * this.a + (this.azar() * 2 - 1) * this.b;
    return this.v;
  }
}

const VOCALES: ReadonlyArray<readonly [number, number, number]> = [
  [800, 1200, 2500], // a
  [500, 1900, 2600], // e
  [300, 2200, 3000], // i
  [500, 900, 2500], // o
  [320, 800, 2300], // u
];

/** Una voz lejana: tren glotal + 3 formantes que se deslizan por silaba, con frases y pausas. */
class VozLejana {
  private fase = 0;
  private vib = 0;
  private readonly f0: number;
  private hablando = false;
  private restante: number;
  private compuerta = 0;
  private silabaRestante = 0;
  private silabaLargo = 1;
  private nivelSilaba = 1;
  private form: [number, number, number];
  private obj: [number, number, number];
  private readonly filtros: Biquad[];
  private cuenta = 0;
  private readonly nivel: number;
  constructor(private readonly azar: () => number, private readonly hz: number, private readonly actividad: number) {
    const aguda = azar() < 0.5;
    this.f0 = aguda ? realEntre(azar, 175, 235) : realEntre(azar, 95, 145);
    this.nivel = realEntre(azar, 0.55, 1);
    this.restante = Math.floor(realEntre(azar, 0, 2.5) * hz);
    this.hablando = azar() < actividad;
    const v = VOCALES[Math.floor(azar() * VOCALES.length)]!;
    this.form = [...v];
    this.obj = [...v];
    this.filtros = [new Biquad(hz), new Biquad(hz), new Biquad(hz)];
    this.actualizarFiltros();
  }
  private actualizarFiltros(): void {
    this.filtros[0]!.banda(this.form[0], 5);
    this.filtros[1]!.banda(this.form[1], 7);
    this.filtros[2]!.banda(this.form[2], 9);
  }
  p(): number {
    const { azar, hz } = this;
    if (--this.restante <= 0) {
      this.hablando = !this.hablando;
      // Frase de 0.6-2.8 s; pausa cuyo largo sale de la actividad (mas actividad = pausas mas cortas).
      this.restante = Math.floor((this.hablando ? realEntre(azar, 0.6, 2.8) : realEntre(azar, 0.4, 3.6) * (1.2 - this.actividad)) * hz);
    }
    this.compuerta += ((this.hablando ? 1 : 0) - this.compuerta) * (1 / (0.04 * hz));
    if (--this.silabaRestante <= 0) {
      this.silabaLargo = Math.floor(realEntre(azar, 0.11, 0.25) * hz);
      this.silabaRestante = this.silabaLargo;
      const v = VOCALES[Math.floor(azar() * VOCALES.length)]!;
      this.obj = [v[0] * realEntre(azar, 0.93, 1.07), v[1] * realEntre(azar, 0.93, 1.07), v[2] * realEntre(azar, 0.95, 1.05)];
      this.nivelSilaba = realEntre(azar, 0.5, 1);
    }
    if (++this.cuenta % 32 === 0) {
      for (let i = 0; i < 3; i++) this.form[i] = this.form[i]! + (this.obj[i]! - this.form[i]!) * 0.18;
      this.actualizarFiltros();
    }
    this.vib += (2 * Math.PI * 5.2) / hz;
    const f0 = this.f0 * (1 + 0.012 * Math.sin(this.vib));
    this.fase += f0 / hz;
    if (this.fase >= 1) this.fase -= 1;
    const fuente = (2 * this.fase - 1) * 0.7 + (azar() * 2 - 1) * 0.35;
    const y = this.filtros[0]!.p(fuente) * 1 + this.filtros[1]!.p(fuente) * 0.55 + this.filtros[2]!.p(fuente) * 0.25;
    const prog = 1 - this.silabaRestante / this.silabaLargo;
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, prog))), 0.7) * this.nivelSilaba;
    return y * env * this.compuerta * this.nivel;
  }
}

interface ModoSonoro {
  fase: number;
  paso: number;
  amp: number;
  caida: number;
}

/** Evento sonoro corto (plato, vaso, cubierto, olla): suma de modos amortiguados mas un golpe de ruido. */
class EventoGolpe {
  private readonly modos: ModoSonoro[] = [];
  private ruido: number;
  private readonly caidaRuido: number;
  private espera: number;
  vivo = true;
  constructor(tipo: "plato" | "vaso" | "cubierto" | "olla", azar: () => number, hz: number, amplitud: number, retardoMs: number) {
    const amp = amplitud * realEntre(azar, 0.55, 1);
    const modo = (f: number, a: number, decaeSeg: number): void => {
      this.modos.push({ fase: azar() * 2 * Math.PI, paso: (2 * Math.PI * f) / hz, amp: a * amp, caida: Math.exp(-1 / (decaeSeg * hz)) });
    };
    if (tipo === "plato") {
      const f = realEntre(azar, 1700, 2900);
      modo(f, 1, realEntre(azar, 0.03, 0.07));
      modo(f * 1.59, 0.55, 0.04);
      modo(f * 1.13, 0.4, 0.05);
      this.ruido = 0.5 * amp;
      this.caidaRuido = Math.exp(-1 / (0.004 * hz));
    } else if (tipo === "vaso") {
      const f = realEntre(azar, 2300, 3200);
      modo(f, 1, realEntre(azar, 0.18, 0.35));
      modo(f * 1.31, 0.35, 0.12);
      this.ruido = 0.2 * amp;
      this.caidaRuido = Math.exp(-1 / (0.002 * hz));
    } else if (tipo === "cubierto") {
      modo(realEntre(azar, 2500, 3300), 0.8, realEntre(azar, 0.012, 0.03));
      modo(realEntre(azar, 1200, 1900), 0.5, 0.02);
      this.ruido = 0.9 * amp;
      this.caidaRuido = Math.exp(-1 / (0.005 * hz));
    } else {
      modo(realEntre(azar, 500, 1100), 1, realEntre(azar, 0.07, 0.14));
      modo(realEntre(azar, 1400, 2100), 0.4, 0.05);
      this.ruido = 0.4 * amp;
      this.caidaRuido = Math.exp(-1 / (0.01 * hz));
    }
    this.espera = Math.floor((retardoMs / 1000) * hz);
    this.azar = azar;
  }
  private readonly azar: () => number;
  p(): number {
    if (this.espera > 0) {
      this.espera--;
      return 0;
    }
    let s = 0;
    let energia = 0;
    for (const m of this.modos) {
      s += Math.sin(m.fase) * m.amp;
      m.fase += m.paso;
      m.amp *= m.caida;
      energia += m.amp;
    }
    s += (this.azar() * 2 - 1) * this.ruido;
    this.ruido *= this.caidaRuido;
    if (energia + this.ruido < 1e-4) this.vivo = false;
    return s;
  }
}

/** Proceso de Poisson: cada `siguiente()` da cuantas muestras faltan hasta el proximo evento (minimo `huecoMin` s). */
function esperaPoisson(azar: () => number, porMin: number, hz: number, huecoMin = 0.25): number {
  if (porMin <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((huecoMin + -Math.log(1 - azar()) / (porMin / 60)) * hz);
}

export interface OpcionesAmbiente {
  /** Porcentaje de plena escala (0..FONDO_VOLUMEN_MAX): el PICO maximo del ambiente. 0 = apagado. */
  readonly volumen: number;
  readonly preset?: PresetAmbiente;
  readonly semilla?: number;
  readonly hz?: number;
}

export interface OpcionesDucking {
  readonly atenuacionDb?: number;
  readonly ataqueMs?: number;
  readonly liberacionMs?: number;
}

/** Ganancia suave que baja el ambiente mientras alguien habla y vuelve despues. */
export class Ducking {
  private g = 1;
  private readonly objetivo: number;
  private readonly ataque: number;
  private readonly liberacion: number;
  constructor(hz: number, o: OpcionesDucking = {}) {
    this.objetivo = Math.pow(10, (o.atenuacionDb ?? -9) / 20);
    this.ataque = 1 - Math.exp(-1 / (((o.ataqueMs ?? 25) / 1000) * hz));
    this.liberacion = 1 - Math.exp(-1 / (((o.liberacionMs ?? 350) / 1000) * hz));
  }
  /** Siguiente ganancia (1 = sin bajar). */
  p(activo: boolean): number {
    const meta = activo ? this.objetivo : 1;
    this.g += (meta - this.g) * (activo ? this.ataque : this.liberacion);
    return this.g;
  }
}

const UMBRAL_VOZ = 0.012;
const COLA_VOZ_MS = 140;

/** Ambiente continuo de restaurante. `siguiente`/`mezclar` mantienen estado: llamarlos en orden. */
export class AmbienteRestaurante {
  readonly volumen: number;
  readonly preset: PresetAmbiente;
  protected readonly azar: () => number;
  protected readonly hz: number;
  private readonly perfil: PerfilAmbiente;
  private readonly voces: VozLejana[] = [];
  private readonly lejania1: UnPolo;
  private readonly lejania2: UnPolo;
  private readonly eco1: Float64Array;
  private readonly eco2: Float64Array;
  private ie1 = 0;
  private ie2 = 0;
  private readonly rosaB = [0, 0, 0];
  private readonly salaFiltro: UnPolo;
  private readonly sartenBanda: Biquad;
  private readonly sartenPrev = { v: 0 };
  private pop = 0;
  private readonly extractorA: Biquad;
  private readonly extractorB: Biquad;
  private faseMotor = 0;
  private readonly calleBaja1: UnPolo;
  private readonly calleBaja2: UnPolo;
  private readonly calleBanda: Biquad;
  private autoRestante = 0;
  private autoLargo = 0;
  private autoPos = 0;
  private autoF0 = 400;
  private autoF1 = 1000;
  private cuentaCalle = 0;
  private readonly derivas: DerivaLenta[];
  private activos: EventoGolpe[] = [];
  private proxCubierto: number;
  private proxOlla: number;
  private readonly ducking: Ducking;
  private envVoz = 0;
  private colaVoz = 0;
  private cliente = false;
  private readonly escala: number;
  private readonly altosFinal: UnPolo;
  private readonly altosFinal2: UnPolo;
  private readonly bajosFinal1: UnPolo;
  private readonly bajosFinal2: UnPolo;

  constructor(opciones: OpcionesAmbiente) {
    if (!esVolumenFondo(opciones.volumen)) throw new RangeError(`volumen del fondo: entero entre ${FONDO_VOLUMEN_MIN} y ${FONDO_VOLUMEN_MAX}`);
    const preset = opciones.preset === undefined ? PRESET_AMBIENTE_POR_DEFECTO : opciones.preset;
    if (!esPresetAmbiente(preset)) throw new RangeError(`preset de ambiente desconocido: ${String(preset)}`);
    this.volumen = opciones.volumen;
    this.preset = preset;
    this.hz = opciones.hz ?? HZ_AUDIO_AGENTE;
    const azar = crearAzar(opciones.semilla ?? 1);
    this.azar = azar;
    const hz = this.hz;
    this.perfil = PERFILES_AMBIENTE[preset];
    for (let i = 0; i < this.perfil.voces; i++) this.voces.push(new VozLejana(azar, hz, this.perfil.actividadVoces));
    this.lejania1 = new UnPolo(3300, hz);
    this.lejania2 = new UnPolo(2600, hz);
    this.eco1 = new Float64Array(Math.floor(0.037 * hz));
    this.eco2 = new Float64Array(Math.floor(0.061 * hz));
    this.salaFiltro = new UnPolo(1800, hz);
    this.sartenBanda = new Biquad(hz);
    this.sartenBanda.banda(2100, 0.8);
    this.extractorA = new Biquad(hz);
    this.extractorA.banda(520, 0.9);
    this.extractorB = new Biquad(hz);
    this.extractorB.banda(860, 1.1);
    this.calleBaja1 = new UnPolo(900, hz);
    this.calleBaja2 = new UnPolo(700, hz);
    this.calleBanda = new Biquad(hz);
    this.calleBanda.banda(700, 1.2);
    this.derivas = [12, 20, 15, 25].map((tau) => new DerivaLenta(azar, hz, tau));
    this.proxCubierto = esperaPoisson(azar, this.perfil.cubiertosPorMin, hz);
    this.proxOlla = esperaPoisson(azar, this.perfil.ollasPorMin, hz);
    this.autoRestante = esperaPoisson(azar, this.perfil.autosPorMin, hz, 2);
    this.ducking = new Ducking(hz);
    // Banda final de la linea telefonica: nada por debajo de ~260 Hz (2 polos) ni por encima de ~3.8 kHz (G.711 lo recortaria de todos modos).
    this.altosFinal = new UnPolo(260, hz);
    this.altosFinal2 = new UnPolo(260, hz);
    this.bajosFinal1 = new UnPolo(3800, hz);
    this.bajosFinal2 = new UnPolo(3800, hz);
    this.escala = this.calibracion();
  }

  /** Escala fija por preset que lleva la suma de capas a `RMS_OBJETIVO` (medida offline; ver la prueba de nivel). */
  private calibracion(): number {
    return ESCALA_POR_PRESET[this.preset] ?? 1;
  }

  get activo(): boolean {
    return this.volumen > 0;
  }

  /** El cliente esta hablando: el ambiente baja. Lo fija quien oye la linea (el puente de audio del worker). */
  fijarClienteHablando(habla: boolean): void {
    this.cliente = habla;
  }

  private ruidoRosa(b: number[]): number {
    const w = this.azar() * 2 - 1;
    b[0] = 0.99765 * b[0]! + w * 0.099046;
    b[1] = 0.963 * b[1]! + w * 0.2965164;
    b[2] = 0.57 * b[2]! + w * 1.0526913;
    return (b[0]! + b[1]! + b[2]! + w * 0.1848) * 0.3;
  }

  /** Una muestra de la suma de capas, sin escala ni ducking. */
  private capas(): number {
    const { azar, hz, perfil } = this;
    // Murmullo
    let mur = 0;
    for (const v of this.voces) mur += v.p();
    mur = this.lejania2.p(this.lejania1.p(mur)) * 1.4;
    const e1 = this.eco1[this.ie1]!;
    const e2 = this.eco2[this.ie2]!;
    const conEco = mur + 0.3 * e1 + 0.22 * e2;
    this.eco1[this.ie1] = conEco * 0.5;
    this.eco2[this.ie2] = conEco * 0.4;
    this.ie1 = (this.ie1 + 1) % this.eco1.length;
    this.ie2 = (this.ie2 + 1) % this.eco2.length;
    const dVoces = 1 + 0.22 * this.derivas[0]!.p();
    let s = conEco * perfil.ganVoces * 0.5 * dVoces;
    // Tono de sala
    s += this.salaFiltro.p(this.ruidoRosa(this.rosaB)) * perfil.ganSala * 0.5;
    // Sarten: ruido en banda media + chasquidos
    if (perfil.ganSarten > 0) {
      const n = azar() * 2 - 1;
      const dif = n - this.sartenPrev.v;
      this.sartenPrev.v = n;
      if (azar() < 22 / hz) this.pop = realEntre(azar, 0.4, 1);
      this.pop *= 0.9985;
      const nivel = Math.max(0, 0.65 + 0.3 * this.derivas[1]!.p());
      s += (this.sartenBanda.p(dif * 0.5) * 0.9 * nivel + dif * this.pop * 0.35) * perfil.ganSarten;
    }
    // Extractor
    if (perfil.ganExtractor > 0) {
      const n = azar() * 2 - 1;
      this.faseMotor += (2 * Math.PI * 372) / hz;
      const nivel = Math.max(0, 0.85 + 0.2 * this.derivas[2]!.p());
      s += (this.extractorA.p(n) * 0.8 + this.extractorB.p(n) * 0.5 + Math.sin(this.faseMotor) * 0.03) * nivel * perfil.ganExtractor * 1.4;
    }
    // Calle
    if (perfil.ganCalle > 0) {
      const n = azar() * 2 - 1;
      const nivel = Math.max(0, 0.7 + 0.3 * this.derivas[3]!.p());
      let c = this.calleBaja2.p(this.calleBaja1.p(n)) * 1.9 * nivel;
      if (this.autoRestante > 0) this.autoRestante--;
      else if (this.autoLargo === 0) {
        this.autoLargo = Math.floor(realEntre(azar, 3, 6) * hz);
        this.autoPos = 0;
        this.autoF0 = realEntre(azar, 300, 500);
        this.autoF1 = realEntre(azar, 900, 1400);
        if (azar() < 0.5) [this.autoF0, this.autoF1] = [this.autoF1, this.autoF0];
      }
      if (this.autoLargo > 0) {
        const prog = this.autoPos / this.autoLargo;
        if (++this.cuentaCalle % 64 === 0) this.calleBanda.banda(this.autoF0 + (this.autoF1 - this.autoF0) * prog, 1.2);
        c += this.calleBanda.p(n) * Math.pow(Math.sin(Math.PI * prog), 2) * 1.6;
        if (++this.autoPos >= this.autoLargo) {
          this.autoLargo = 0;
          this.autoRestante = esperaPoisson(azar, perfil.autosPorMin, hz, 2);
        }
      }
      s += c * perfil.ganCalle * 0.6;
    }
    // Eventos
    if (--this.proxCubierto <= 0) {
      const u = azar();
      const tipo = u < 0.45 ? "cubierto" : u < 0.8 ? "plato" : "vaso";
      this.activos.push(new EventoGolpe(tipo, azar, hz, 1, 0));
      if (tipo === "vaso" && azar() < 0.4) this.activos.push(new EventoGolpe("vaso", azar, hz, 0.7, 90));
      if (this.activos.length > 24) this.activos.shift();
      this.proxCubierto = esperaPoisson(azar, perfil.cubiertosPorMin, hz);
    }
    if (--this.proxOlla <= 0) {
      this.activos.push(new EventoGolpe("olla", azar, hz, 1, 0));
      this.proxOlla = esperaPoisson(azar, perfil.ollasPorMin, hz);
    }
    let ev = 0;
    let hayMuertos = false;
    for (const a of this.activos) {
      ev += a.p();
      if (!a.vivo) hayMuertos = true;
    }
    if (hayMuertos) this.activos = this.activos.filter((a) => a.vivo);
    s += ev * perfil.ganCubiertos * 0.9;
    s -= this.altosFinal.p(s);
    s -= this.altosFinal2.p(s);
    return this.bajosFinal2.p(this.bajosFinal1.p(s));
  }

  /** Sigue a la voz del agente: `true` mientras suena (con una cola corta para no "respirar" entre palabras). */
  private vozActiva(x: number): boolean {
    const a = Math.abs(x);
    this.envVoz = a > this.envVoz ? a : this.envVoz * 0.9995;
    if (this.envVoz > UMBRAL_VOZ) this.colaVoz = Math.floor((COLA_VOZ_MS / 1000) * this.hz);
    else if (this.colaVoz > 0) this.colaVoz--;
    return this.colaVoz > 0;
  }

  /** Ambiente de `n` muestras PCM16 (sin voz). `agente` (misma longitud, opcional) baja el ambiente mientras suena; el cliente tambien lo baja (`fijarClienteHablando`). */
  siguienteMuestras(n: number, agente?: Int16Array): Int16Array {
    const salida = new Int16Array(n);
    if (!this.activo) return salida;
    const tope = (this.volumen / 100) * 32767;
    for (let i = 0; i < n; i++) {
      const ocupado = (agente !== undefined && i < agente.length ? this.vozActiva(agente[i]! / 32768) : this.colaVoz > 0 ? (this.colaVoz--, true) : false) || this.cliente;
      const g = this.ducking.p(ocupado);
      salida[i] = Math.round(Math.tanh(this.capas() * this.escala) * tope * g);
    }
    return salida;
  }

  /** Siguientes `muestras` del ambiente (solo fondo, sin voz), PCM16 little-endian. Con volumen 0 es silencio. */
  siguiente(muestras: number): Uint8Array {
    const m = this.siguienteMuestras(muestras);
    const bytes = new Uint8Array(muestras * 2);
    const vista = new DataView(bytes.buffer);
    for (let i = 0; i < m.length; i++) vista.setInt16(i * 2, m[i]!, true);
    return bytes;
  }

  /** Mezcla el ambiente bajo un trozo de audio del agente (PCM16 LE), con ducking. Satura, nunca desborda; con el ambiente apagado devuelve el mismo trozo. */
  mezclar(agente: Uint8Array): Uint8Array {
    if (!this.activo) return agente;
    const n = Math.floor(agente.byteLength / 2);
    const a = new DataView(agente.buffer, agente.byteOffset, n * 2);
    const voz = new Int16Array(n);
    for (let i = 0; i < n; i++) voz[i] = a.getInt16(i * 2, true);
    const amb = this.siguienteMuestras(n, voz);
    const salida = new Uint8Array(agente.byteLength);
    const s = new DataView(salida.buffer);
    for (let i = 0; i < n; i++) {
      const suma = voz[i]! + amb[i]!;
      s.setInt16(i * 2, suma > 32767 ? 32767 : suma < -32768 ? -32768 : suma, true);
    }
    if (agente.byteLength % 2 === 1) salida[agente.byteLength - 1] = agente[agente.byteLength - 1]!;
    return salida;
  }
}

/** Escala fija por preset (suma de capas -> RMS_OBJETIVO). Se mide con `scripts/voz-muestras-ambiente` y la prueba de nivel la vigila. */
export const ESCALA_POR_PRESET: Readonly<Record<PresetAmbiente, number>> = Object.freeze({
  "cocina-taqueria": 2.6,
  "sala-tranquila": 4.5,
  "calle-ocupada": 3,
});

export { RMS_OBJETIVO };
