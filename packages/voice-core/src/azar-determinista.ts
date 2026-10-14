// Generador pseudoaleatorio determinista (mulberry32) compartido por los sintetizadores de audio de la llamada (ambiente y tecleo): misma
// semilla, mismas muestras, y por eso las pruebas son exactas.
export function crearAzar(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Entero en [min, max] (ambos incluidos) con el azar dado. */
export function enteroEntre(azar: () => number, min: number, max: number): number {
  return Math.floor(min + azar() * (max - min + 1));
}

/** Real en [min, max). */
export function realEntre(azar: () => number, min: number, max: number): number {
  return min + azar() * (max - min);
}
