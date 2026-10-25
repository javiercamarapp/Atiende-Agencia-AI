// Modelo de LATENCIA por turno de la llamada, para medir en simulacion (sin llamadas pagadas) si un turno cabe en el objetivo (p95 <= 18 s de fin de habla del
// cliente a primer audio del agente). Un turno = el modelo responde (1 paso), y por cada OLA de herramientas el servidor trabaja y el modelo vuelve a responder (otro paso):
// latencia = sum(pasos del modelo) + sum(por ola: viaje de red + tiempo de servidor MEDIDO). Las herramientas de solo lectura que el modelo pide seguidas corren en
// paralelo en una sola ola (`HERRAMIENTAS_VOZ_SOLO_LECTURA`, solo el escalon de Gemini Live; la cascada las corre en serie).
//
// LO QUE ES MEDIDO y LO QUE ES SUPUESTO: el tiempo de servidor sale de correr el motor real de pedidos en proceso (medido). La latencia de un paso del modelo (STT + LLM +
// TTS) es un SUPUESTO calibrado con medidas previas del loop (fuera del repo): Gemini Live mediana 1.3 s y p95 3.3 s por respuesta (ronda 9); cascada Deepgram + LLM + TTS
// mediana 3.6 s por respuesta y p95 de ~16 s en un turno con una herramienta (ronda 11, sigma fijada para reproducirlo). Con una llamada real hay que reemplazarlo por la medicion.

/** Generador pseudoaleatorio determinista (mulberry32): misma semilla, mismos numeros. */
function crearAzar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PerfilLatencia {
  readonly id: "gemini-live" | "cascada";
  /** Mediana de un paso del modelo (ms). */
  readonly medianaPasoMs: number;
  /** Desviacion estandar del logaritmo del paso (cola de la distribucion log-normal). */
  readonly sigma: number;
  /** Las herramientas de solo lectura seguidas corren en paralelo (una sola ola). */
  readonly paralelizaLectura: boolean;
}

export const PERFIL_GEMINI_LIVE: PerfilLatencia = { id: "gemini-live", medianaPasoMs: 1_300, sigma: 0.566, paralelizaLectura: true };
export const PERFIL_CASCADA: PerfilLatencia = { id: "cascada", medianaPasoMs: 3_600, sigma: 0.58, paralelizaLectura: false };
/** Viaje de red worker -> API por herramienta (el mismo supuesto de las pruebas de arranque del worker). */
export const VIAJE_RED_MS = 150;
/** Objetivo: p95 por turno, de fin de habla a primer audio. */
export const OBJETIVO_P95_TURNO_MS = 18_000;

export interface TurnoParaLatencia {
  readonly nombres: readonly string[];
  readonly servidorMs: number;
}

/** Olas de herramientas de un turno: las de solo lectura consecutivas forman una ola si el perfil las paraleliza. */
export function olasDeHerramientas(nombres: readonly string[], lectura: ReadonlySet<string>, paraleliza: boolean): number {
  let olas = 0;
  let previoLectura = false;
  for (const n of nombres) {
    const esLectura = lectura.has(n);
    if (!(paraleliza && esLectura && previoLectura)) olas += 1;
    previoLectura = esLectura;
  }
  return olas;
}

function normal(azar: () => number): number {
  let u = 0;
  while (u === 0) u = azar();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * azar());
}

/** Latencias simuladas (ms) de los turnos, con `muestras` repeticiones de cada uno y semilla fija (reproducible). */
export function simularLatencias(turnos: readonly TurnoParaLatencia[], perfil: PerfilLatencia, lectura: ReadonlySet<string>, opciones: { readonly muestras?: number; readonly semilla?: number } = {}): number[] {
  const azar = crearAzar(opciones.semilla ?? 20261024);
  const muestras = opciones.muestras ?? 200;
  const salida: number[] = [];
  for (const t of turnos) {
    const olas = olasDeHerramientas(t.nombres, lectura, perfil.paralelizaLectura);
    for (let i = 0; i < muestras; i++) {
      let ms = 0;
      for (let paso = 0; paso <= olas; paso++) ms += perfil.medianaPasoMs * Math.exp(perfil.sigma * normal(azar));
      salida.push(ms + olas * VIAJE_RED_MS + t.servidorMs);
    }
  }
  return salida;
}

export function percentil(valores: readonly number[], p: number): number {
  if (valores.length === 0) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.max(0, Math.ceil(p * orden.length) - 1))]!;
}

/** Peor caso por TOPE de timeouts (sin azar): `olas` herramientas lentas que agotan el timeout cada una, mas los pasos del modelo en su mediana. */
export function peorCasoPorTimeouts(olas: number, perfil: PerfilLatencia, toolTimeoutMs: number): number {
  return (olas + 1) * perfil.medianaPasoMs + olas * toolTimeoutMs;
}
