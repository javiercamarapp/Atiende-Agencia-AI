// Utilidades de audio PCM16 para la llamada de prueba (funciones puras, probadas sin navegador).
// Gemini Live recibe PCM16 mono a 16 kHz y entrega PCM16 mono a 24 kHz, ambos little-endian en base64.

export const TASA_ENTRADA_HZ = 16_000;
export const TASA_SALIDA_HZ = 24_000;

/** Baja (o sube) la tasa de muestreo por interpolacion lineal. Suficiente para voz; sin dependencias. */
export function remuestrear(entrada: Float32Array, desdeHz: number, haciaHz: number): Float32Array {
  if (desdeHz === haciaHz || entrada.length === 0) return entrada;
  const razon = desdeHz / haciaHz;
  const largo = Math.max(1, Math.floor(entrada.length / razon));
  const salida = new Float32Array(largo);
  for (let i = 0; i < largo; i++) {
    const pos = i * razon;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, entrada.length - 1);
    const frac = pos - i0;
    salida[i] = entrada[i0]! * (1 - frac) + entrada[i1]! * frac;
  }
  return salida;
}

export function aPcm16Base64(muestras: Float32Array): string {
  const bytes = new Uint8Array(muestras.length * 2);
  const vista = new DataView(bytes.buffer);
  for (let i = 0; i < muestras.length; i++) {
    const s = Math.max(-1, Math.min(1, muestras[i]!));
    vista.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  let binario = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}

export function dePcm16Base64(b64: string): Float32Array {
  const binario = atob(b64);
  const largo = Math.floor(binario.length / 2);
  const bytes = new Uint8Array(largo * 2);
  for (let i = 0; i < largo * 2; i++) bytes[i] = binario.charCodeAt(i);
  const vista = new DataView(bytes.buffer);
  const salida = new Float32Array(largo);
  for (let i = 0; i < largo; i++) salida[i] = vista.getInt16(i * 2, true) / 0x8000;
  return salida;
}

/** Nivel 0..1 (RMS con un poco de ganancia) de un bloque de audio, para el orbe. */
export function nivelRms(muestras: Float32Array): number {
  if (muestras.length === 0) return 0;
  let suma = 0;
  for (let i = 0; i < muestras.length; i++) suma += muestras[i]! * muestras[i]!;
  return Math.min(1, Math.sqrt(suma / muestras.length) * 4);
}
