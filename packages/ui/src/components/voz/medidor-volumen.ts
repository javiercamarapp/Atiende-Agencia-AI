// Medidor de volumen: AnalyserNode -> número 0..1 suavizado. Es independiente del
// proveedor: sirve igual para el micrófono (MediaStream local) que para el audio
// remoto o el PCM que el adaptador reproduzca, así el orbe no depende de que el
// proveedor exponga niveles. Mismo patrón (getByteTimeDomainData/frecuencia) que
// usan los visualizadores de Web Audio.

export function limitar01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * RMS de una ventana de muestras de dominio del tiempo en bytes (128 = silencio,
 * como entrega `AnalyserNode.getByteTimeDomainData`), normalizado a 0..1. Se aplica
 * una ganancia porque la voz hablada rara vez pasa de ~0.3 de amplitud.
 */
export function nivelDesdeMuestras(muestras: ArrayLike<number>, ganancia = 3): number {
  const n = muestras.length;
  if (n === 0) return 0;
  let suma = 0;
  for (let i = 0; i < n; i++) {
    const v = ((muestras[i] ?? 128) - 128) / 128;
    suma += v * v;
  }
  return limitar01(Math.sqrt(suma / n) * ganancia);
}

/** Media móvil exponencial: `alfa` es el peso de la muestra nueva (0..1). */
export function suavizarVolumen(previo: number, nuevo: number, alfa = 0.2): number {
  const a = limitar01(alfa);
  return limitar01(previo + (limitar01(nuevo) - limitar01(previo)) * a);
}

/**
 * Suavizado asimétrico: sube rápido (ataque) para que el orbe responda a la voz y
 * baja despacio (relajación) para que no parpadee entre sílabas.
 */
export function suavizarConAtaque(previo: number, nuevo: number, ataque = 0.35, relajacion = 0.12): number {
  return suavizarVolumen(previo, nuevo, nuevo > previo ? ataque : relajacion);
}

/** Subconjunto de `AnalyserNode` que usa el medidor (facilita probar sin Web Audio). */
export interface AnalizadorMinimo {
  readonly fftSize: number;
  getByteTimeDomainData(arreglo: Uint8Array): void;
}

export interface MedidorVolumen {
  /** Lee el analizador y devuelve el nivel suavizado actual (0..1). */
  leer(): number;
  reiniciar(): void;
}

export function crearMedidorVolumen(analizador: AnalizadorMinimo, opts: { readonly ataque?: number; readonly relajacion?: number; readonly ganancia?: number } = {}): MedidorVolumen {
  const buffer = new Uint8Array(analizador.fftSize);
  let nivel = 0;
  return {
    leer() {
      analizador.getByteTimeDomainData(buffer);
      nivel = suavizarConAtaque(nivel, nivelDesdeMuestras(buffer, opts.ganancia), opts.ataque, opts.relajacion);
      return nivel;
    },
    reiniciar() {
      nivel = 0;
    },
  };
}

export interface MedidorDeStream {
  readonly medidor: MedidorVolumen;
  /** Libera el nodo de audio y el contexto. */
  detener(): void;
}

/**
 * Conecta un `MediaStream` (micrófono o audio remoto) a un `AnalyserNode` y
 * devuelve un medidor. Crea su propio `AudioContext`; `detener()` lo cierra.
 * Lanza si el navegador no soporta Web Audio (el llamador decide el respaldo).
 */
export function medirStream(stream: MediaStream, fftSize = 256): MedidorDeStream {
  const Ctor: typeof AudioContext | undefined = typeof AudioContext === "undefined" ? undefined : AudioContext;
  if (!Ctor) throw new Error("Este navegador no soporta Web Audio.");
  const contexto = new Ctor();
  const fuente = contexto.createMediaStreamSource(stream);
  const analizador = contexto.createAnalyser();
  analizador.fftSize = fftSize;
  fuente.connect(analizador);
  return {
    medidor: crearMedidorVolumen(analizador),
    detener() {
      try {
        fuente.disconnect();
      } catch {
        // ya desconectado
      }
      void contexto.close().catch(() => undefined);
    },
  };
}
